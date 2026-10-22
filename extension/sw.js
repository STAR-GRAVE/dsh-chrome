/**
 * The extension's service worker: a long-poll client for the local bridge.
 *
 * The extension never listens on a port and never needs to know where the
 * Harness runs. It asks the bridge for work, runs one command, posts the answer
 * back, and immediately asks again — so an idle extension costs one held HTTP
 * request and no CPU.
 *
 * Chatty-free by default: page work happens through `chrome.scripting` in the
 * extension's isolated world, which needs no debugger permission and shows no
 * "started debugging this browser" banner. When a caller explicitly asks for
 * trusted input or full protocol capture, `trusted.js` attaches the debugger and
 * the banner appears for as long as that session lives.
 */

import { attachedTabs, captureEvent, debuggerOp, detachAll, handleDetach, runtimeEvaluate } from './trusted.js'

const CONFIG_KEY = 'dshChromeConfig'
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8731'
const POLL_RETRY_MS = 2000
/**
 * Version of the page runtime this worker expects.
 *
 * It must match `version` in `lib/page-script.js`. The comparison is the only
 * thing that makes a refreshed extension actually replace an already-injected
 * runtime: a content script registered on an earlier load keeps its old code, and
 * a page loaded before the update still holds the old global.
 */
const EXPECTED_RUNTIME_VERSION = 4
/** Storage key recording which runtime version the registrations were built for. */
const RUNTIME_STAMP_KEY = 'dshChromeRuntimeStamp'

/** @type {{ endpoint: string, token: string } | null} */
let config = null
let loopRunning = false

/**
 * Read the pairing configuration from extension storage.
 * @returns {{ endpoint: string, token: string }} the stored configuration, defaults applied.
 */
async function readConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY)
  const value = stored?.[CONFIG_KEY] ?? {}
  return {
    endpoint: typeof value.endpoint === 'string' && value.endpoint.length > 0 ? value.endpoint : DEFAULT_ENDPOINT,
    token: typeof value.token === 'string' ? value.token : '',
  }
}

/** Sleep helper for the retry path. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Post one command result back to the bridge.
 * @param {string} id - the command id.
 * @param {{ ok: boolean, result?: unknown, error?: string }} payload - the outcome.
 */
async function postResult(id, payload) {
  if (config === null || config.token.length === 0) return
  try {
    await fetch(`${config.endpoint.replace(/\/+$/, '')}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-chrome-token': config.token },
      body: JSON.stringify({ id, version: chrome.runtime.getManifest().version, ...payload }),
    })
  } catch (error) {
    console.warn('[dsh] could not post result', error)
  }
}

/** Ensure the runtime and the capture tap are present in an already-open tab. */
async function ensureRuntime(tabId) {
  const [runtime] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    files: ['injected-page.js'],
  })
  const installed = await readRuntimeVersion(tabId)
  if (installed !== EXPECTED_RUNTIME_VERSION) {
    throw new Error(
      `页面里的运行时版本不对（期望 ${EXPECTED_RUNTIME_VERSION}，实际 ${installed ?? '没有'}）${runtime?.error ? `：${runtime.error}` : ''}。` +
        'Chrome 内部页面不允许注入；如果这是普通页面，刷新一次该标签页即可装上当前运行时。',
    )
  }
}

/** Read the installed runtime version in a tab, or null when absent. */
async function readRuntimeVersion(tabId) {
  try {
    const [entry] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => (globalThis.__dshChrome ? globalThis.__dshChrome.version : null),
    })
    return entry?.result ?? null
  } catch {
    return null
  }
}

/** Install the MAIN-world capture tap in an already-open tab. */
async function ensureTap(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['injected-tap.js'] })
  } catch {
    /* capture is best effort on restricted pages */
  }
}

/**
 * Run one page-runtime operation in a tab and return its JSON reply.
 *
 * The injected function deliberately does NOT return a promise. Whether
 * `scripting.executeScript` awaits a promise returned by `func` is the kind of
 * browser detail that silently degrades into `undefined`, and an undefined reply
 * is indistinguishable from "the expression returned nothing" — exactly the sort
 * of bug that looks like the page ignored the call. So the function always
 * returns a small synchronous envelope, and an asynchronous operation parks its
 * result in a world global that a follow-up read collects.
 *
 * @param {number} tabId - the target tab.
 * @param {string} op - runtime operation name.
 * @param {object} args - operation arguments.
 * @returns {Promise<unknown>} the runtime's reply.
 */
async function runPageOperation(tabId, op, args) {
  // `eval` cannot run in an MV3 isolated world: the extension's CSP forbids
  // evaluating a string as code, so `new Function` throws there. The protocol's
  // Runtime.evaluate has no such restriction, so eval goes through the debugger.
  if (op === 'eval') {
    return runtimeEvaluate(tabId, String(args?.expression ?? ''), args?.awaitPromise !== false)
  }
  await ensureRuntime(tabId)
  const env = await inject(tabId, [op, args ?? {}], (operation, payload) => {
    const runtime = globalThis.__dshChrome
    if (!runtime) throw new Error('这个页面里没有装页面运行时')
    const value = runtime.run(operation, payload)
    if (value && typeof value.then === 'function') {
      globalThis.__dshChromePending = undefined
      globalThis.__dshChromePendingError = undefined
      value.then(
        (resolved) => {
          globalThis.__dshChromePending = resolved
        },
        (error) => {
          globalThis.__dshChromePendingError = String((error && error.message) || error)
        },
      )
      return { pending: true }
    }
    return { pending: false, value }
  })
  if (env === undefined || env === null) {
    // Silence here is what made a stale runtime look like "the page ignored the
    // call", so refuse to invent an answer.
    throw new Error(
      `扩展没能从页面取到结果（操作 ${op} 的注入函数没有返回信封）。这通常意味着页面里是旧版运行时——刷新一次该标签页再试。`,
    )
  }
  if (env.pending !== true) return env.value
  // An asynchronous operation: read the parked result, bounded.
  const deadline = Date.now() + 20000
  for (;;) {
    const polled = await inject(tabId, [], () => ({
      done: globalThis.__dshChromePending !== undefined || globalThis.__dshChromePendingError !== undefined,
      value: globalThis.__dshChromePending,
      error: globalThis.__dshChromePendingError,
    }))
    if (polled?.done === true) {
      if (polled.error !== undefined) throw new Error(String(polled.error))
      return polled.value
    }
    if (Date.now() > deadline) throw new Error('页面里的异步操作在 20 秒内没有完成')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * Inject one function into a tab's isolated world and return its envelope.
 * @param {number} tabId - the target tab.
 * @param {unknown[]} args - positional arguments for the function.
 * @param {Function} func - the function to run in the page.
 * @returns {Promise<any>} what the function returned.
 */
async function inject(tabId, args, func) {
  let entry
  try {
    ;[entry] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      args,
      func,
    })
  } catch (error) {
    throw new Error(cleanInjectionError(error, tabId))
  }
  return entry?.result
}

/** Turn a Chrome injection failure into something a model can act on. */
function cleanInjectionError(error, tabId) {
  const message = String(error?.message ?? error)
  if (/Cannot access contents of (the )?url|Extension manifest must request permission/i.test(message)) {
    return `无法访问这个标签页的地址（${message}）。扩展拿不到 data:、file:、以及 chrome:// 这类地址的注入权限——请换成一个普通的 http(s) 页面。`
  }
  if (/cannot be scripted|chrome:\/\/|The extensions gallery|extensions gallery/i.test(message)) {
    return `标签页 ${tabId} 无法注入脚本（${message}）。Chrome 内部页面、扩展商店、PDF 阅读器都不允许注入；请换成普通的 http(s) 页面。`
  }
  return message
}

/** List tabs as `{ id, title, url, active, windowId }`. */
async function listTabs() {
  const tabs = await chrome.tabs.query({})
  return tabs
    .filter((tab) => typeof tab.id === 'number')
    .map((tab) => ({
      id: tab.id,
      title: tab.title ?? '',
      url: tab.url ?? '',
      active: tab.active === true,
      windowId: tab.windowId,
    }))
}

/** Create a tab and return its id. */
async function newTab(url) {
  const tab = await chrome.tabs.create({ url: url && url.length > 0 ? url : 'about:blank' })
  return { id: tab.id, title: tab.title ?? '', url: tab.url ?? '' }
}

/** Activate a tab. */
async function activateTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true })
  if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
  return { id: tabId, title: tab?.title ?? '', url: tab?.url ?? '' }
}

/** Close a tab, refusing to leave a window empty. */
async function closeTab(tabId) {
  const tab = await chrome.tabs.get(tabId)
  const siblings = await chrome.tabs.query({ windowId: tab.windowId })
  if (siblings.length <= 1) {
    throw new Error('refusing to close the last tab of a window; close the window instead')
  }
  await chrome.tabs.remove(tabId)
  return { closed: tabId }
}

/** Navigate a tab and wait for it to report complete. */
async function navigate(tabId, url, timeoutMs) {
  await chrome.tabs.update(tabId, { url })
  await waitForLoad(tabId, timeoutMs ?? 20000)
  const tab = await chrome.tabs.get(tabId)
  await ensureTap(tabId)
  await ensureRuntime(tabId)
  return { id: tabId, title: tab.title ?? '', url: tab.url ?? '' }
}

/** Wait until a tab's document reports `complete`. */
async function waitForLoad(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab) throw new Error(`tab ${tabId} disappeared while loading`)
    if (tab.status === 'complete') return
    if (Date.now() > deadline) return
    await sleep(120)
  }
}

/** Go back / forward / reload one tab. */
async function history(tabId, direction) {
  if (direction === 'reload') {
    await chrome.tabs.reload(tabId)
  } else if (direction === 'back') {
    await chrome.tabs.goBack(tabId)
  } else if (direction === 'forward') {
    await chrome.tabs.goForward(tabId)
  } else {
    throw new Error(`unknown navigation direction "${direction}"`)
  }
  await waitForLoad(tabId, 20000)
  await ensureTap(tabId)
  await ensureRuntime(tabId)
  const tab = await chrome.tabs.get(tabId)
  return { id: tabId, title: tab.title ?? '', url: tab.url ?? '' }
}

/**
 * Capture the visible area of one tab.
 *
 * `captureVisibleTab` only sees the frontmost tab of a window, so this raises
 * the requested tab first — a visible side effect the tool reports honestly.
 */
async function screenshot(tabId) {
  const tab = await chrome.tabs.get(tabId)
  await chrome.tabs.update(tabId, { active: true })
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
  await sleep(120)
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  const base64 = dataUrl.startsWith('data:image/png;base64,') ? dataUrl.slice('data:image/png;base64,'.length) : dataUrl.split(',')[1]
  const { width, height } = await readViewport(tabId)
  return {
    base64,
    width,
    height,
    note: 'Captured the visible viewport only (chrome.tabs.captureVisibleTab cannot capture off-screen content), and the tab was raised to the front to do it.',
  }
}

/** Read a tab's viewport size, falling back to its window's inner bounds. */
async function readViewport(tabId) {
  const window = await chrome.windows.get((await chrome.tabs.get(tabId)).windowId)
  return { width: window?.width ?? 0, height: window?.height ?? 0 }
}

/** Element clip rect for a scoped screenshot, via the page runtime. */
async function elementRect(tabId, target) {
  const described = await runPageOperation(tabId, 'describe', target ?? {})
  return described?.rect ?? null
}

/** Drain the MAIN-world tap buffer. */
async function drain(method, tabId, limit, clear) {
  await ensureTap(tabId)
  let entry
  try {
    ;[entry] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [method, limit ?? 50, clear === true],
      func: (drainMethod, drainLimit, drainClear) => {
        const tap = globalThis.__dshChromeTap
        if (!tap) return null
        const payload = drainMethod === 'network' ? tap.drainNetwork(drainLimit) : tap.drainConsole(drainLimit)
        if (drainClear) drainMethod === 'network' ? tap.clearNetwork() : tap.clearConsole()
        return payload
      },
    })
    if (entry?.result) return entry.result
  } catch (error) {
    /* MAIN-world read can be refused by a strict page CSP; fall through */
  }
  return null
}

/**
 * Execute one command from the bridge.
 * @param {{ id: string, method: string, params: object }} command - the queued command.
 * @returns {Promise<unknown>} its result payload.
 */
async function dispatch(command) {
  const params = command.params ?? {}
  switch (command.method) {
    case 'injectRuntime':
      await ensureRuntime(params.tabId)
      await ensureTap(params.tabId)
      return { ok: true }
    case 'run':
      return runPageOperation(params.tabId, params.op, params.args)
    case 'listTabs':
      return listTabs()
    case 'newTab':
      return newTab(params.url)
    case 'activateTab':
      return activateTab(params.tabId)
    case 'closeTab':
      return closeTab(params.tabId)
    case 'navigate':
      return navigate(params.tabId, params.url, params.timeoutMs)
    case 'history':
      return history(params.tabId, params.direction)
    case 'screenshot':
      return screenshot(params.tabId)
    case 'elementRect':
      return elementRect(params.tabId, params.target)
    case 'console':
      return drain('console', params.tabId, params.limit, params.clear)
    case 'network':
      return drain('network', params.tabId, params.limit, params.clear)
    case 'debugger':
      return debuggerOp(params.tabId, params.op, params.args, {
        page: (tabId, op, args) => runPageOperation(tabId, op, args),
      })
    case 'debuggerStatus':
      return { attached: attachedTabs() }
    case 'ping':
      return { pong: true, version: chrome.runtime.getManifest().version }
    default:
      throw new Error(`扩展没有实现 "${command.method}"`)
  }
}

/** Run one poll cycle, returning the retry delay when the bridge is unreachable. */
async function pollOnce() {
  config = await readConfig()
  if (config.token.length === 0) return POLL_RETRY_MS
  const endpoint = config.endpoint.replace(/\/+$/, '')
  let response
  try {
    response = await fetch(`${endpoint}/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-chrome-token': config.token },
      body: JSON.stringify({ version: chrome.runtime.getManifest().version }),
    })
  } catch {
    return POLL_RETRY_MS
  }
  if (response.status === 401) {
    console.warn('[dsh] pairing token rejected; update it in the extension options page')
    return POLL_RETRY_MS
  }
  if (!response.ok) return POLL_RETRY_MS
  let body
  try {
    body = await response.json()
  } catch {
    return POLL_RETRY_MS
  }
  if (body.status !== 'command' || !body.command) return 0
  const command = body.command
  try {
    const result = await dispatch(command)
    await postResult(command.id, { ok: true, result })
  } catch (error) {
    await postResult(command.id, { ok: false, error: String(error?.message ?? error) })
  }
  return 0
}

/** Keep polling until the loop is told to stop; one loop per worker. */
async function pollLoop() {
  if (loopRunning) return
  loopRunning = true
  try {
    while (true) {
      let delay = POLL_RETRY_MS
      try {
        delay = await pollOnce()
      } catch (error) {
        delay = POLL_RETRY_MS
      }
      if (delay > 0) await sleep(delay)
    }
  } finally {
    loopRunning = false
  }
}

/** Register the document_start scripts so capture starts before page scripts run. */
async function registerInjectedScripts() {
  const wanted = [
    { id: 'dsh-page', js: ['injected-page.js'], world: 'ISOLATED' },
    { id: 'dsh-tap', js: ['injected-tap.js'], world: 'MAIN' },
  ]
  const existing = await chrome.scripting.getRegisteredContentScripts().catch(() => [])
  const byId = new Map(existing.map((script) => [script.id, script]))
  // A registration keeps the code it was created with, so an updated extension
  // that only "skips already-registered ids" keeps injecting the OLD runtime into
  // every new page. Re-register whenever the runtime version changed.
  const stamp = `${chrome.runtime.getManifest().version}:${EXPECTED_RUNTIME_VERSION}`
  const stored = await chrome.storage.local.get(RUNTIME_STAMP_KEY).catch(() => ({}))
  const stale = stored?.[RUNTIME_STAMP_KEY] !== stamp
  for (const script of wanted) {
    const registered = byId.get(script.id)
    if (registered && !stale) continue
    try {
      if (registered) await chrome.scripting.unregisterContentScripts({ ids: [script.id] })
      await chrome.scripting.registerContentScripts([
        { id: script.id, matches: ['<all_urls>'], js: script.js, runAt: 'document_start', allFrames: false, world: script.world },
      ])
    } catch (error) {
      console.warn(`[dsh] 无法注册 ${script.id}：${error?.message ?? error}`)
    }
  }
  if (stale) await chrome.storage.local.set({ [RUNTIME_STAMP_KEY]: stamp }).catch(() => {})
}

chrome.runtime.onInstalled.addListener(() => {
  registerInjectedScripts().catch(() => {})
  pollLoop()
})

chrome.runtime.onStartup.addListener(() => {
  registerInjectedScripts().catch(() => {})
  pollLoop()
})

chrome.alarms.create('dsh-chrome-watchdog', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dsh-chrome-watchdog') pollLoop()
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[CONFIG_KEY]) return
  pollLoop()
})

// The attached debugger session can end without us: the user cancels it from the
// bar, the tab closes, or DevTools takes the slot. Fold that into the same state
// the capture and input paths read, so nothing claims to still be recording.
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== 'number') return
  captureEvent(source.tabId, method, params)
})

chrome.debugger.onDetach.addListener((source, reason) => {
  if (typeof source.tabId !== 'number') return
  handleDetach(source.tabId, String(reason ?? 'detached'))
})

chrome.tabs.onRemoved.addListener((tabId) => {
  handleDetach(tabId, 'tab_closed')
})

// A worker that is going away must not leave a debugger attached: the bar would
// outlive the work that justified it.
chrome.runtime.onSuspend.addListener(() => {
  detachAll().catch(() => {})
})

registerInjectedScripts().catch(() => {})
pollLoop()
