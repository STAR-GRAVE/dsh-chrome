/**
 * The trusted path: a `chrome.debugger` session that produces real browser
 * input and sees the whole network stack.
 *
 * Why this module exists at all: an isolated world can dispatch DOM events, but
 * those carry `isTrusted === false`, so a site that checks the flag, or that
 * only reacts to real pointer input, cannot be driven. The sole way for an
 * extension to produce trusted input is to attach the DevTools protocol, and
 * Chrome deliberately makes that visible — an "… is debugging this browser" bar
 * appears for as long as the session lives.
 *
 * Three consequences this module has to honour, all of them real:
 *  1. The bar pushes page content down by roughly 20px, so geometry must be
 *     measured AFTER the attach, never before.
 *  2. One tab has one debugger slot: an open DevTools window takes it first.
 *  3. The user can reclaim the tab with "Cancel" on that bar, so every operation
 *     must tolerate the session disappearing mid-flight.
 *
 * Kept free of imports from `sw.js`: the service worker injects the page helpers
 * it already owns, which avoids a circular import between the two.
 */

/** Tabs this module currently holds a debugger session on. */
const ATTACHED = new Set()

/** Per-tab capture buffers, keyed by tab id. */
const CAPTURE = new Map()

/** Per-tab promise chain, so two commands never interleave on one session. */
const QUEUES = new Map()

/** How long to let the infobar's layout shift settle before measuring. */
const INFOBAR_SETTLE_MS = 150

/** Entries kept per stream before the oldest are dropped. */
const BUFFER_LIMIT = 500

/** Modifier bitmask the protocol expects. */
const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 }

/** Keys whose names differ from their printable form. */
const NAMED_KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { code: 'Space', keyCode: 32, key: ' ', text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Insert: { code: 'Insert', keyCode: 45 },
}

/** Sleep, used only to let the infobar's reflow settle. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Whether this module holds a session on a tab. */
export function isAttached(tabId) {
  return ATTACHED.has(tabId)
}

/** Every tab holding a session, for status reporting. */
export function attachedTabs() {
  return [...ATTACHED]
}

/** Send one protocol command through the extension's debugger handle. */
function send(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params ?? {})
}

/** Serialise work per tab, because one session has one command stream. */
function serialize(tabId, task) {
  const previous = QUEUES.get(tabId) ?? Promise.resolve()
  const next = previous.then(task, task)
  // Keep the chain alive on failure without leaking an unhandled rejection.
  QUEUES.set(
    tabId,
    next.then(
      () => {},
      () => {},
    ),
  )
  return next
}

/**
 * Attach a session to one tab, if it is not already ours.
 *
 * The attach is followed by a settle delay because the resulting bar reflows the
 * page: a rect measured in the same tick as the attach is off by the bar's
 * height, which is exactly the kind of miss that makes a click look broken.
 * @param {number} tabId - the tab to take over.
 * @returns {{ attached: true, already: boolean }} session facts.
 * @throws when another debugger (usually DevTools) owns the tab.
 */
async function ensureAttached(tabId) {
  if (ATTACHED.has(tabId)) return { attached: true, already: true }
  try {
    await chrome.debugger.attach({ tabId }, '1.3')
  } catch (error) {
    const message = String(error?.message ?? error)
    if (/another debugger is already attached/iu.test(message)) {
      throw new Error(
        `tab ${tabId} already has a debugger attached, so trusted input cannot start. Close DevTools (F12) on that tab, or click "Cancel" on the "is debugging this browser" bar, then retry.`,
      )
    }
    throw new Error(`could not attach the Chrome debugger to tab ${tabId}: ${message}`)
  }
  ATTACHED.add(tabId)
  await sleep(INFOBAR_SETTLE_MS)
  return { attached: true, already: false }
}

/** Release a session and drop its buffers. Safe to call when none exists. */
export async function detach(tabId) {
  CAPTURE.delete(tabId)
  if (!ATTACHED.has(tabId)) return { attached: false, wasAttached: false }
  ATTACHED.delete(tabId)
  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    /* the user or a navigation may have released it first */
  }
  return { attached: false, wasAttached: true }
}

/** Release every session; used when the worker is going away or config changes. */
export async function detachAll() {
  await Promise.all([...ATTACHED].map((tabId) => detach(tabId)))
}

/**
 * Record that a session ended outside our control.
 *
 * The user pressing "Cancel", a tab closing, or DevTools taking the tab all
 * arrive here, and the buffer must not pretend to still be recording.
 */
export function handleDetach(tabId, reason) {
  ATTACHED.delete(tabId)
  const capture = CAPTURE.get(tabId)
  if (capture !== undefined) {
    capture.stoppedReason = reason
    capture.active = false
  }
}

/** Resolve the point to click: measure after attach, then report it. */
async function measure(page, tabId, args) {
  const measured = await page(tabId, 'measure', { ref: args.ref, selector: args.selector, focus: args.focus === true })
  if (!measured || !measured.point) throw new Error('the element could not be measured; take a new snapshot and retry')
  return measured
}

/** Dispatch one real click at a point. */
async function dispatchClick(tabId, point, { button = 'left', clickCount = 1 } = {}) {
  const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 })
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, buttons, clickCount })
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount })
}

/** Translate a key or chord such as `Ctrl+Shift+Enter` into a protocol event. */
function keyEvent(chord) {
  const parts = String(chord).split('+').map((part) => part.trim()).filter(Boolean)
  const name = parts.length > 1 ? parts[parts.length - 1] : parts[0]
  const mods = parts.slice(0, Math.max(0, parts.length - 1))
  const named = NAMED_KEYS[name]
  let modifiers = 0
  for (const mod of mods) {
    const bit = MODIFIERS[mod.toLowerCase() === 'control' ? 'ctrl' : mod.toLowerCase() === 'cmd' ? 'meta' : mod.toLowerCase()]
    if (bit === undefined) throw new Error(`unknown modifier "${mod}" in "${chord}"; use Ctrl, Alt, Shift, or Meta`)
    modifiers |= bit
  }
  if (named !== undefined) {
    return {
      modifiers,
      key: named.key ?? name,
      code: named.code,
      windowsVirtualKeyCode: named.keyCode,
      text: mods.length === 0 ? named.text : undefined,
    }
  }
  if (name.length !== 1) {
    throw new Error(`unknown key "${name}"; use a single character, or one of: ${Object.keys(NAMED_KEYS).join(', ')}`)
  }
  const upper = name.toUpperCase()
  const keyCode = upper.charCodeAt(0)
  const isLetter = /[A-Z]/.test(upper)
  const isDigit = /[0-9]/.test(upper)
  return {
    modifiers,
    key: name,
    code: isLetter ? `Key${upper}` : isDigit ? `Digit${upper}` : '',
    windowsVirtualKeyCode: keyCode,
    text: mods.length === 0 ? name : undefined,
  }
}

/** Dispatch one real key press. */
async function dispatchKey(tabId, chord) {
  const spec = keyEvent(chord)
  const base = {
    modifiers: spec.modifiers,
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
  }
  await send(tabId, 'Input.dispatchKeyEvent', {
    type: spec.text === undefined ? 'rawKeyDown' : 'keyDown',
    ...base,
    ...(spec.text === undefined ? {} : { text: spec.text }),
  })
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/**
 * Evaluate one expression through the protocol instead of the page runtime.
 *
 * An MV3 isolated world inherits the extension's CSP, which forbids executing a
 * string as code, so `new Function` throws there and eval cannot be implemented
 * in the page at all. `Runtime.evaluate` has no such limit, which makes the
 * debugger the only way eval can work on the extension transport.
 *
 * @param {number} tabId - the tab to evaluate in.
 * @param {string} expression - a JavaScript expression.
 * @param {boolean} awaitPromise - whether to await a returned promise.
 * @returns {Promise<object>} the same `{ kind, value, text }` envelope the page runtime produces.
 */
export async function runtimeEvaluate(tabId, expression, awaitPromise) {
  await ensureAttached(tabId)
  const reply = await send(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: false,
    awaitPromise: awaitPromise !== false,
  })
  const details = reply?.exceptionDetails
  if (details !== undefined) {
    const raw = String(details.exception?.description ?? details.text ?? '页面报了错')
    throw new Error(raw.split('\n')[0].replace(/^(?:Uncaught\s+)?[A-Za-z]*Error:\s*/u, ''))
  }
  const result = reply?.result ?? {}
  if (result.type === 'undefined') return { kind: 'undefined' }
  if (result.type === 'object' && result.subtype === 'null') return { kind: 'null' }
  if (result.type === 'function') return { kind: 'function', text: String(result.description ?? '') }
  if (result.type === 'bigint') return { kind: 'bigint', text: String(result.unserializableValue ?? '') }
  if (result.type === 'object' || result.type === 'array') {
    // Objects come back by reference, so read them again as JSON.
    const serialized = await send(tabId, 'Runtime.evaluate', {
      expression: `(function(){try{return JSON.stringify(${expression})}catch(e){return String(${expression})}})()`,
      returnByValue: true,
    })
    const text = serialized?.result?.value
    return typeof text === 'string' ? { kind: 'json', text } : { kind: 'object', text: String(result.description ?? '') }
  }
  return { kind: result.type ?? 'unknown', value: result.value ?? result.description ?? null }
}

/** Start capturing network and console traffic through the protocol. */
async function startCapture(tabId) {
  const existing = CAPTURE.get(tabId)
  if (existing?.active === true) return { active: true, already: true }
  await send(tabId, 'Network.enable').catch(() => {})
  await send(tabId, 'Runtime.enable').catch(() => {})
  await send(tabId, 'Log.enable').catch(() => {})
  CAPTURE.set(tabId, {
    active: true,
    console: [],
    network: [],
    requests: new Map(),
    startedAt: Date.now(),
    stoppedReason: null,
  })
  return { active: true, already: false }
}

/** Append to a bounded ring. */
function push(list, entry) {
  list.push(entry)
  if (list.length > BUFFER_LIMIT) list.splice(0, list.length - BUFFER_LIMIT)
}

/**
 * Fold one protocol event into the tab's buffers.
 *
 * Called by the service worker's `chrome.debugger.onEvent` listener, so it must
 * never throw: an uncaught error here would tear down the capture silently.
 */
export function captureEvent(tabId, method, params) {
  const capture = CAPTURE.get(tabId)
  if (capture === undefined || capture.active !== true) return
  try {
    if (method === 'Network.requestWillBeSent') {
      const record = {
        id: params.requestId,
        method: params.request?.method ?? 'GET',
        url: params.request?.url ?? '',
        type: params.type ?? 'Other',
        status: null,
        bytes: null,
        ms: null,
        failed: false,
        startedAt: Date.now(),
      }
      capture.requests.set(params.requestId, record)
      push(capture.network, record)
      return
    }
    if (method === 'Network.responseReceived') {
      const record = capture.requests.get(params.requestId)
      if (record === undefined) return
      record.status = params.response?.status ?? null
      record.type = params.type ?? record.type
      record.mimeType = params.response?.mimeType ?? null
      record.ms = Date.now() - record.startedAt
      return
    }
    if (method === 'Network.loadingFinished') {
      const record = capture.requests.get(params.requestId)
      if (record === undefined) return
      record.bytes = params.encodedDataLength ?? null
      record.ms = Date.now() - record.startedAt
      return
    }
    if (method === 'Network.loadingFailed') {
      const record = capture.requests.get(params.requestId)
      if (record === undefined) return
      record.failed = true
      record.errorText = params.errorText ?? null
      record.ms = Date.now() - record.startedAt
      return
    }
    if (method === 'Runtime.consoleAPICalled') {
      push(capture.console, {
        level: params.type ?? 'log',
        text: (params.args ?? [])
          .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description ?? arg.type ?? ''))
          .join(' '),
        time: Date.now(),
        source: params.stackTrace?.callFrames?.[0]?.url ?? null,
      })
      return
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails ?? {}
      push(capture.console, {
        level: 'exception',
        text: details.exception?.description ?? details.text ?? 'uncaught exception',
        time: Date.now(),
        source: details.url ?? null,
      })
      return
    }
    if (method === 'Log.entryAdded') {
      const entry = params.entry ?? {}
      push(capture.console, {
        level: entry.level ?? 'log',
        text: entry.text ?? '',
        time: Date.now(),
        source: entry.url ?? null,
      })
    }
  } catch {
    /* a malformed event must not stop the capture */
  }
}

/** Read captured traffic, optionally fetching one response body. */
async function readCapture(tabId, args) {
  const capture = CAPTURE.get(tabId)
  if (capture === undefined) {
    throw new Error(
      `no protocol capture is running for tab ${tabId}. Start one with chrome_observe action=network source=cdp (it attaches the debugger, and shows the "is debugging this browser" bar).`,
    )
  }
  if (typeof args.requestId === 'string' && args.requestId.length > 0) {
    if (capture.active !== true) {
      throw new Error(`the capture for tab ${tabId} stopped (${capture.stoppedReason ?? 'unknown reason'}), so this response body is gone. Start it again before the request repeats.`)
    }
    try {
      const body = await send(tabId, 'Network.getResponseBody', { requestId: args.requestId })
      return { body: body.body ?? '', base64: body.base64Encoded === true }
    } catch (error) {
      throw new Error(`could not read the response body for ${args.requestId}: ${error?.message ?? error}. Bodies are only available while the capture is live and the entry is still in the network cache.`)
    }
  }
  const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 50
  const source = args.kind === 'network' ? capture.network : capture.console
  const filtered =
    typeof args.filter === 'string' && args.filter.length > 0 && args.kind === 'network'
      ? source.filter((entry) => String(entry.url ?? '').includes(args.filter))
      : source
  const entries = filtered.slice(Math.max(0, filtered.length - limit))
  if (args.clear === true) {
    if (args.kind === 'network') capture.network.length = 0
    else capture.console.length = 0
  }
  return {
    entries,
    total: filtered.length,
    active: capture.active === true,
    stoppedReason: capture.stoppedReason,
    startedAt: capture.startedAt,
  }
}

/**
 * Run one trusted operation.
 *
 * @param {number} tabId - the tab to act on.
 * @param {string} op - the operation name.
 * @param {object} args - operation arguments.
 * @param {{ page: (tabId: number, op: string, args: object) => Promise<any> }} helpers - the worker's page-runtime bridge.
 * @returns the operation's reply.
 */
export function debuggerOp(tabId, op, args, helpers) {
  return serialize(tabId, async () => {
    const payload = args ?? {}
    if (op === 'attach') {
      const attached = await ensureAttached(tabId)
      return { ...attached, banner: 'Chrome shows an "is debugging this browser" bar until the session is released.' }
    }
    if (op === 'detach') return detach(tabId)
    if (op === 'status') {
      const capture = CAPTURE.get(tabId)
      return {
        attached: ATTACHED.has(tabId),
        capturing: capture?.active === true,
        consoleEntries: capture?.console.length ?? 0,
        networkEntries: capture?.network.length ?? 0,
        stoppedReason: capture?.stoppedReason ?? null,
      }
    }
    if (op === 'captureStart') {
      const attached = await ensureAttached(tabId)
      const capture = await startCapture(tabId)
      return { ...capture, attached: attached.attached, banner: true }
    }
    if (op === 'captureRead') return readCapture(tabId, payload)
    if (op === 'captureStop') return detach(tabId)

    if (op === 'click' || op === 'rightClick' || op === 'doubleClick' || op === 'hover') {
      await ensureAttached(tabId)
      // Measure only after the attach: the infobar reflow moves the page.
      const measured = await measure(helpers.page, tabId, { ref: payload.ref, selector: payload.selector })
      if (op === 'hover') {
        await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: measured.point.x, y: measured.point.y })
      } else if (op === 'rightClick') {
        await dispatchClick(tabId, measured.point, { button: 'right' })
      } else {
        await dispatchClick(tabId, measured.point, { clickCount: op === 'doubleClick' ? 2 : 1 })
      }
      return { element: measured.element, point: measured.point, rect: measured.rect, trusted: true }
    }
    if (op === 'type') {
      await ensureAttached(tabId)
      const measured = await measure(helpers.page, tabId, { ref: payload.ref, selector: payload.selector, focus: true })
      await send(tabId, 'Input.insertText', { text: String(payload.text ?? '') })
      if (payload.submit === true) await dispatchKey(tabId, 'Enter')
      return { element: measured.element, text: String(payload.text ?? ''), trusted: true }
    }
    if (op === 'press') {
      await ensureAttached(tabId)
      let measured = null
      if (payload.ref !== undefined || payload.selector !== undefined) {
        measured = await measure(helpers.page, tabId, { ref: payload.ref, selector: payload.selector, focus: true })
      }
      await dispatchKey(tabId, payload.key ?? 'Enter')
      return { element: measured?.element ?? null, key: payload.key ?? 'Enter', trusted: true }
    }
    if (op === 'scroll') {
      await ensureAttached(tabId)
      const measured = payload.ref !== undefined || payload.selector !== undefined ? await measure(helpers.page, tabId, payload) : null
      const point = measured?.point ?? null
      await send(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: point?.x ?? 1,
        y: point?.y ?? 1,
        deltaX: Number(payload.deltaX ?? 0),
        deltaY: Number(payload.deltaY ?? 600),
      })
      return { element: measured?.element ?? null, trusted: true }
    }
    throw new Error(`unknown trusted operation "${op}"`)
  })
}
