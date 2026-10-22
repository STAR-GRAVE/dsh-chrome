/**
 * The runtime coordinator: one object the tools talk to, which owns both
 * backends, the tab-label registry, and the rule for choosing a transport.
 *
 * Selection is deliberately explicit in its output. A tool never silently
 * switches browser: `auto` prefers the extension and only falls back to a
 * self-launched Chrome when the extension has never polled, and every result
 * line names the backend that actually served the call.
 *
 * @module @star-grave/dsh-chrome/runtime
 */

import { checkToken, ChromeBridge, createPairingToken } from './bridge.js'
import { ExtensionBackend } from './backend-extension.js'
import { CdpBackend } from './backend-cdp.js'
import { TabRegistry } from './tabs.js'

/** Read the persisted pairing token, creating one on first run. */
async function loadOrCreateToken(homeDir, deps) {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises')
  const { dirname, join } = await import('node:path')
  const path = join(homeDir, 'pairing-token')
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (existing.length >= 16) return existing
  } catch {
    /* first run */
  }
  const token = createPairingToken()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${token}\n`, { mode: 0o600 })
  deps.log?.(`wrote a new pairing token to ${path}`)
  return token
}

/** Persist a token the user chose in the settings page. */
async function persistToken(homeDir, token, deps) {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { dirname, join } = await import('node:path')
  const path = join(homeDir, 'pairing-token')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${token}\n`, { mode: 0o600 })
  deps.log?.(`pairing token updated in ${path}`)
}

/**
 * Read the port chosen on the pairing page, if the user ever chose one.
 *
 * The settings document cannot carry this: a row injected by the bundle patch
 * is not addressable from the profile, so every write through a config form is
 * refused. A file this plugin owns is the honest place for a value only this
 * plugin reads, and `bridgePort` stays the default for a fresh install.
 */
async function readPort(homeDir, deps) {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const path = join(homeDir, 'bridge-port')
  try {
    const value = Number((await readFile(path, 'utf8')).trim())
    if (Number.isInteger(value) && value >= 1 && value <= 65535) return value
    deps.log?.(`ignoring ${path}: not a port`)
  } catch {
    /* never chosen */
  }
  return null
}

/** Persist the port the bridge actually bound. */
async function persistPort(homeDir, port, deps) {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { dirname, join } = await import('node:path')
  const path = join(homeDir, 'bridge-port')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${port}\n`, { mode: 0o600 })
  deps.log?.(`bridge port updated in ${path}`)
}

/** Turn an extension's numeric tab id into the registry's opaque string id. */
function tabKey(id) {
  return String(id)
}

/** Convert a numeric tab id back for extension calls. */
function extensionTabId(key) {
  const value = Number(key)
  if (!Number.isInteger(value)) throw new Error(`内部错误：标签页键 "${key}" 不是扩展用的数字 id`)
  return value
}

/**
 * Owns both transports for the plugin's lifetime.
 */
export class ChromeRuntime {
  #config
  #log
  #bridge = null
  #extension = null
  #cdp = null
  #tabs = new TabRegistry()
  #disposed = false
  /** Directory that owns the pairing token and the chosen port. */
  #homeDir
  /** The live pairing token, known even when the bridge never bound. */
  #token = null
  /** The port this runtime wants: the config default until the page picks one. */
  #port = null
  #trustedTouchedAt = new Map()
  /** Why the bridge never came up, when it did not. */
  #startError = null
  #trustedTimer = null

  /**
   * @param {object} options - wiring.
   * @param {object} options.config - resolved plugin config.
   * @param {string} options.homeDir - directory for the pairing token.
   * @param {(message: string) => void} [options.log] - diagnostic sink.
   */
  constructor({ config, homeDir, log }) {
    this.#config = config
    this.#log = log ?? (() => {})
    this.#homeDir = homeDir
    this.#cdp = new CdpBackend({ config, log: this.#log })
  }

  /** The tab registry, shared by every tool. */
  get tabs() {
    return this.#tabs
  }

  /** Start the bridge so the extension can pair as soon as the plugin loads. */
  async start() {
    // Both values are recorded before the listener is attempted: the pairing
    // page has to show them (and let the user fix them) exactly when the bind
    // fails, so they cannot live inside the bridge object.
    const token = await loadOrCreateToken(this.#homeDir, { log: this.#log })
    this.#token = token
    const chosenPort = await readPort(this.#homeDir, { log: this.#log })
    this.#port = chosenPort ?? this.#config.bridgePort
    const bridge = new ChromeBridge({
      token,
      host: this.#config.bridgeHost,
      // A port chosen on the pairing page outlives a restart; `bridgePort` is the
      // default a fresh install starts from. The settings form cannot hold this
      // (bundle-injected rows are not addressable from the profile patch).
      port: this.#port,
      // A new port chosen on the 「Chrome 连接」 page survives a restart.
      onPortChange: (port) => persistPort(this.#homeDir, port, { log: this.#log }),
      log: this.#log,
    })
    let endpoint
    try {
      endpoint = await bridge.start()
    } catch (error) {
      // The port is fixed by design, so a busy one is a configuration error the
      // user has to see — not something to paper over with another port.
      this.#startError = `本地桥起不来：${error.message ?? error}`
      throw error
    }
    this.#startError = null
    this.#port = bridge.port
    this.#bridge = bridge
    this.#extension = new ExtensionBackend({
      channel: {
        send: (method, params, options) => bridge.call(method, params, options),
        status: () => bridge.status,
      },
    })
    return { endpoint, token }
  }

  /** The pairing facts shown by `chrome_status action=pair`. */
  get pairing() {
    return {
      // Only report a URL while the listener is actually bound: a stale address
      // would send a user to a port nothing is listening on.
      endpoint: this.#bridge !== null && this.#bridge.listening ? this.#bridge.endpoint : null,
      port: this.#bridge?.listening === true ? this.#bridge.port : this.#port,
      token: this.#token,
      extensionPath: this.#config.extensionPath,
      error: this.#startError,
    }
  }

  /**
   * Everything the pairing page shows, in one call.
   *
   * This is the page's read path over the Remote, so it must work when the
   * bridge is down: the port, the token, and the start error are exactly what
   * let the user fix a port the bridge could not bind.
   */
  pairingState() {
    const bridge = this.#bridge
    const listening = bridge?.listening === true
    const status = bridge?.status ?? {}
    return {
      endpoint: listening ? bridge.endpoint : null,
      port: listening ? bridge.port : this.#port,
      token: this.#token,
      listening,
      connected: listening && bridge.connected === true,
      extensionVersion: listening ? (status.extensionVersion ?? null) : null,
      lastPollAt: listening ? (status.lastPollAt ?? null) : null,
      error: this.#startError,
      // Where Chrome's "load unpacked" picker should point; the page turns this
      // into one copy button so the user does not have to find the folder.
      extensionPath: this.#config.extensionPath ?? null,
    }
  }

  /**
   * Replace the pairing token from the page.
   *
   * Stored whether or not the bridge is up: a token chosen while the listener is
   * down has to be the one the next bind presents, otherwise the page could only
   * ever edit a bridge that already works.
   * @param {string} next - the new token.
   * @returns {Promise<{ token: string, applied: boolean }>} the accepted token.
   */
  async pairingSetToken(next) {
    const token = checkToken(next)
    this.#token = token
    await persistToken(this.#homeDir, token, { log: this.#log })
    const bridge = this.#bridge
    if (bridge !== null) bridge.setToken(token)
    return { token, applied: bridge !== null }
  }

  /**
   * Move the bridge to another port from the page.
   *
   * Two different jobs behind one call. With a live listener this is a rebind,
   * and a port already in use keeps the bridge exactly where it was. Without a
   * listener — the case the page exists for — the choice is recorded and the
   * bridge is started on it; a port that is still unavailable comes back as
   * data, because "saved, but not listening yet" is a real outcome the user has
   * to see rather than an exception the page can only print.
   * @param {number} port - the port to bind.
   * @returns {Promise<{ port: number, listening: boolean, error: string | null }>} the outcome.
   */
  async pairingSetPort(port) {
    const next = Number(port)
    if (!Number.isInteger(next) || next < 1 || next > 65535) {
      throw new Error('端口要填 1–65535 之间的整数')
    }
    const bridge = this.#bridge
    if (bridge !== null) {
      const bound = await bridge.rebind(next)
      this.#port = bound
      this.#startError = null
      return { port: bound, listening: true, error: null }
    }
    this.#port = next
    await persistPort(this.#homeDir, next, { log: this.#log })
    try {
      await this.start()
      return { port: this.#port, listening: true, error: null }
    } catch (error) {
      return {
        port: this.#port,
        listening: false,
        error: this.#startError ?? String(error?.message ?? error),
      }
    }
  }

  /** Status for both backends, for `chrome_status`. */
  get status() {
    return {
      bridgeListening: this.#bridge?.listening === true,
      bridgeError: this.#startError,
      extension: this.#extension?.status ?? { connected: false, endpoint: null },
      extensionAvailable: this.#extension?.available === true,
      cdp: this.#cdp?.status ?? { endpoint: null, managed: false, pid: null, pages: 0 },
      cdpAvailable: this.#cdp?.available === true,
      pairing: this.pairing,
    }
  }

  /**
   * Choose a backend for one call.
   *
   * @param {'auto' | 'extension' | 'cdp'} requested - the caller's preference.
   * @param {{ forLaunch?: boolean }} [options] - `forLaunch` allows `auto` to pick CDP without a live extension.
   * @returns {{ kind: 'extension', backend: ExtensionBackend } | { kind: 'cdp', backend: CdpBackend, fallback: boolean }} the choice.
   * @throws when the requested transport cannot serve the call.
   */
  select(requested, { forLaunch = false } = {}) {
    const mode = requested ?? this.#config.backend ?? 'auto'
    if (mode === 'extension') {
      if (this.#extension?.available !== true) {
        throw new Error(
          `选的是扩展通路，但没有任何扩展在轮询本地桥。\n${this.#pairingHint()}`,
        )
      }
      return { kind: 'extension', backend: this.#extension }
    }
    if (mode === 'cdp') {
      if (this.#cdp?.available !== true && !forLaunch) {
        throw new Error('选了 cdp 通路但还没有连上 Chrome；先执行 chrome_status action=launch backend=cdp')
      }
      return { kind: 'cdp', backend: this.#cdp, fallback: false }
    }
    // auto: prefer the user's own browser, fall back only when it never paired.
    if (this.#extension?.available === true) return { kind: 'extension', backend: this.#extension }
    if (this.#cdp?.available === true) return { kind: 'cdp', backend: this.#cdp, fallback: true }
    if (forLaunch) return { kind: 'cdp', backend: this.#cdp, fallback: true }
    throw new Error(
      `没有可用的 Chrome 通路。要么配对扩展（推荐，用的是你已登录的浏览器），要么启动兜底浏览器：\n${this.#pairingHint()}`,
    )
  }

  /** 「怎么修」的可执行提示，用于扩展未配对时。 */
  #pairingHint() {
    const endpoint = this.#bridge?.endpoint ?? 'http://127.0.0.1:<端口>'
    return [
      '要操作你日常那个 Chrome：',
      '1. 打开 chrome://extensions，开启开发者模式，点「加载已解压的扩展程序」，选择：',
      `   ${this.#config.extensionPath}`,
      '2. 打开 DSH Chrome 扩展的选项页，填入：',
      `   桥地址：${endpoint}`,
      '   配对令牌：执行 chrome_status action=pair 会打印出来',
      '',
      '也可以改用兜底浏览器（不用装扩展，但没有登录态）：chrome_status action=launch backend=cdp',
    ].join('\n')
  }

  /**
   * List tabs through the selected backend and label them.
   * @param {'auto' | 'extension' | 'cdp'} requested - transport preference.
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options] - bounds.
   * @returns {Promise<{ kind: string, tabs: Array<object>, backend: object }>} labelled tabs.
   */
  async listTabs(requested, options = {}) {
    const choice = this.select(requested)
    let raw
    if (choice.kind === 'extension') {
      const tabs = await choice.backend.call('listTabs', {}, options)
      raw = (tabs ?? []).map((tab) => ({ id: tabKey(tab.id), title: tab.title, url: tab.url, active: tab.active }))
    } else {
      raw = await choice.backend.listTabs(options)
    }
    return { kind: choice.kind, backend: choice.backend, tabs: this.#tabs.sync(raw), choice }
  }

  /**
   * Resolve the tab a tool call targets, listing first when the registry is cold.
   * @param {'auto' | 'extension' | 'cdp'} requested - transport preference.
   * @param {string} [tab] - a `tN` label from the caller.
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options] - bounds.
   * @returns {Promise<{ kind: string, backend: object, tabId: string, label: string, tabs: Array<object>, choice: object }>} the target.
   */
  async selectTab(requested, tab, options = {}) {
    const listed = await this.listTabs(requested, options)
    const tabId = this.#tabs.resolve(tab, listed.tabs)
    return {
      kind: listed.kind,
      backend: listed.backend,
      tabId,
      label: this.#tabs.labelOf(tabId) ?? tabId,
      tabs: listed.tabs,
      choice: listed.choice,
    }
  }

  /**
   * Run one page-runtime operation on the selected tab.
   * @param {object} target - the result of `selectTab`.
   * @param {string} op - runtime operation name.
   * @param {object} args - operation arguments.
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options] - bounds.
   * @returns the runtime's reply.
   */
  async run(target, op, args, options = {}) {
    if (target.kind === 'extension') {
      return target.backend.run(extensionTabId(target.tabId), op, args, options)
    }
    return target.backend.run(target.tabId, op, args, options)
  }

  /**
   * Run one trusted (debugger) operation.
   *
   * Only the extension needs this: the CDP transport already produces real input
   * and already sees the whole network stack. Asking for it here is what makes
   * the extension's debugging bar appear, so it stays opt-in per call.
   * @param {object} target - the selected tab.
   * @param {string} op - trusted operation name.
   * @param {object} args - operation arguments.
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options] - bounds.
   * @returns the operation's reply.
   */
  async trusted(target, op, args, options = {}) {
    if (target.kind !== 'extension') {
      throw new Error(
        '这条通路不需要 trusted：cdp 通路本来就用真实输入事件，也本来就能拿到完整网络与响应体。去掉 trusted 参数即可。',
      )
    }
    const result = await target.backend.debugger(extensionTabId(target.tabId), op, args, options)
    this.#trustedTouchedAt.set(target.tabId, Date.now())
    this.#armTrustedSweep()
    return result
  }

  /**
   * Watch for debugger sessions that have gone idle.
   *
   * The debugging bar is user-visible, so it must never outlive the work that
   * justified it. A sweep keeps it honest even when the caller forgets to
   * release the session.
   */
  #armTrustedSweep() {
    if (this.#trustedTimer !== null) return
    const idleMs = this.#config.trustedIdleDetachMs ?? 120_000
    this.#trustedTimer = setInterval(() => {
      const now = Date.now()
      for (const [tabId, touchedAt] of [...this.#trustedTouchedAt]) {
        if (now - touchedAt < idleMs) continue
        this.#trustedTouchedAt.delete(tabId)
        this.#detachTrustedTab(tabId)
      }
      if (this.#trustedTouchedAt.size === 0) {
        clearInterval(this.#trustedTimer)
        this.#trustedTimer = null
      }
    }, 15_000)
    this.#trustedTimer.unref?.()
  }

  /** Detach one tab's debugger session, tolerating an already-gone extension. */
  #detachTrustedTab(tabKey) {
    const numeric = Number(tabKey)
    if (!Number.isInteger(numeric) || this.#extension?.available !== true) return Promise.resolve()
    return this.#extension.debugger(numeric, 'detach', {}, { timeoutMs: 5_000 }).catch(() => {})
  }

  /**
   * Release every debugger session this plugin opened.
   * @returns {Promise<void>}
   */
  async releaseTrusted() {
    if (this.#trustedTimer !== null) {
      clearInterval(this.#trustedTimer)
      this.#trustedTimer = null
    }
    const tabs = [...this.#trustedTouchedAt.keys()]
    this.#trustedTouchedAt.clear()
    await Promise.all(tabs.map((tabKey) => this.#detachTrustedTab(tabKey)))
  }

  /** Capture a screenshot of the selected tab. */
  async screenshot(target, { fullPage, clip } = {}, options = {}) {
    if (target.kind === 'extension') {
      if (clip) {
        throw new Error(
          '截单个元素只能用 cdp 通路：chrome.tabs.captureVisibleTab 只能截整块可见区域，无法裁到某个元素',
        )
      }
      if (fullPage === true) {
        throw new Error(
          '整页截图只能用 cdp 通路：chrome.tabs.captureVisibleTab 只能截可见视口，而滚动拼接会在截图过程中改变页面状态',
        )
      }
      return target.backend.screenshot(extensionTabId(target.tabId), options)
    }
    return target.backend.screenshot(target.tabId, { fullPage, clip }, options)
  }

  /** Create a tab through the selected backend. */
  async newTab(target, url, options = {}) {
    if (target.kind === 'extension') {
      const created = await target.backend.call('newTab', { url }, options)
      return { id: tabKey(created.id), title: created.title ?? '', url: created.url ?? '' }
    }
    const id = await target.backend.newTab(url || 'about:blank', options)
    return { id, title: '', url: url ?? 'about:blank' }
  }

  /** Activate a tab. */
  async activateTab(target, options = {}) {
    if (target.kind === 'extension') {
      return target.backend.call('activateTab', { tabId: extensionTabId(target.tabId) }, options)
    }
    await target.backend.activateTab(target.tabId, options)
    return { id: target.tabId }
  }

  /** Close a tab. */
  async closeTab(target, options = {}) {
    if (target.kind === 'extension') {
      return target.backend.call('closeTab', { tabId: extensionTabId(target.tabId) }, options)
    }
    await target.backend.closeTab(target.tabId, options)
    return { closed: target.tabId }
  }

  /** Navigate the selected tab to a URL. */
  async navigate(target, url, options = {}) {
    if (target.kind === 'extension') {
      return target.backend.call('navigate', { tabId: extensionTabId(target.tabId), url, timeoutMs: options.timeoutMs }, options)
    }
    return target.backend.navigate(target.tabId, url, options)
  }

  /** Walk one tab's history, or reload it. */
  async history(target, direction, options = {}) {
    if (target.kind === 'extension') {
      return target.backend.call('history', { tabId: extensionTabId(target.tabId), direction }, options)
    }
    if (direction === 'reload') return target.backend.reload(target.tabId, options)
    // The CDP fallback navigates by history step; Chrome exposes this as
    // Page.navigateToHistoryEntry, which needs the index, so use the shortcut.
    return target.backend.historyStep(target.tabId, direction, options)
  }

  /** Read buffered console entries for the selected tab. */
  async console(target, { limit, clear } = {}, options = {}) {
    if (target.kind === 'extension') {
      const drained = await target.backend.call(
        'console',
        { tabId: extensionTabId(target.tabId), limit, clear },
        options,
      )
      return drained ?? { entries: [], total: 0, unavailable: true }
    }
    return target.backend.console(target.tabId, { limit, clear })
  }

  /** Read buffered network entries for the selected tab. */
  async network(target, { limit, clear, filter } = {}, options = {}) {
    if (target.kind === 'extension') {
      const drained = await target.backend.call(
        'network',
        { tabId: extensionTabId(target.tabId), limit, clear },
        options,
      )
      const entries = drained?.entries ?? []
      const filtered = filter ? entries.filter((entry) => String(entry.url ?? '').includes(filter)) : entries
      return { entries: filtered, total: drained?.total ?? 0, unavailable: drained === null }
    }
    return target.backend.network(target.tabId, { limit, filter })
  }

  /** Launch or attach the fallback browser. */
  async launch(options = {}) {
    // A fresh browser gets fresh tab identifiers, so stale labels cannot be
    // carried over from a previous browser.
    this.#tabs.reset()
    return this.#cdp.launch(options)
  }

  /** Attach the fallback browser to an existing endpoint. */
  async attach(endpoint, options = {}) {
    this.#tabs.reset()
    return this.#cdp.attach(endpoint, options)
  }

  /**
   * Close only the fallback browser.
   *
   * Deliberately separate from `dispose()`: closing a browser is an ordinary,
   * repeatable action, and it must not take the extension bridge down with it —
   * the extension should keep working, and a later `launch` must behave exactly
   * like the first one.
   * @param {{ timeoutMs?: number }} [options] - bound on the teardown.
   */
  async closeBrowser(options = {}) {
    const status = this.#cdp.status
    this.#tabs.reset()
    await this.#cdp.dispose()
    return status
  }

  /** Shut both transports down. Registered as the plugin's effect cleanup. */
  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    // Release the debugging bar first: it is the one piece of state the user can
    // see, and it must not survive the plugin that opened it.
    await this.releaseTrusted().catch(() => {})
    await this.#bridge?.dispose()
    await this.#cdp?.dispose()
  }
}
