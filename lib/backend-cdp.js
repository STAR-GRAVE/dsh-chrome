/**
 * The CDP backend: a Chrome the plugin launched itself.
 *
 * Mirrors the extension backend's surface so the tools never branch on
 * transport. Page work goes through the same `PAGE_RUNTIME_SOURCE`, evaluated
 * in a named isolated world per tab, which is why snapshot refs, click geometry,
 * and formatting stay identical across both backends.
 *
 * @module @star-grave/dsh-chrome/backend-cdp
 */

import { CdpConnection, listPageTargets, readVersion } from './cdp.js'
import { ManagedChrome, defaultUserDataDir, resolveChromePath } from './chrome.js'
import { PAGE_RUNTIME_SOURCE, RUNTIME_GLOBAL, RUNTIME_VERSION } from './page-script.js'

/** Isolated world name that carries the shared runtime. */
const WORLD_NAME = 'dsh-chrome'

/**
 * Reduce one `exceptionDetails` payload to the single line a model should see.
 *
 * Chrome's `description` already starts with `Error: `/`Uncaught Error: `, so
 * passing it through verbatim produced the doubled `Error: Error:` prefix a
 * caller had to read past.
 * @param {object} details - the protocol's exceptionDetails.
 * @returns the message without a redundant error-type prefix or stack.
 */
function pageErrorMessage(details) {
  const raw = details?.exception?.description ?? details?.text ?? 'the page raised an error'
  const firstLine = String(raw).split('\n')[0].trim()
  return firstLine.replace(/^(?:Uncaught\s+)?[A-Za-z]*Error:\s*/u, '')
}

/**
 * One page session over the browser connection, with its own isolated world.
 */
class PageSession {
  #connection
  #targetId
  #sessionId
  #worldId = null
  #timeouts
  #captureNetwork
  #viewport
  #viewportApplied = false

  constructor({ connection, targetId, sessionId, timeouts, captureNetwork, viewport }) {
    this.#connection = connection
    this.#targetId = targetId
    this.#sessionId = sessionId
    this.#timeouts = timeouts
    this.#captureNetwork = captureNetwork === true
    this.#viewport = viewport ?? null
  }

  get targetId() {
    return this.#targetId
  }

  get sessionId() {
    return this.#sessionId
  }

  /** Enable the domains the runtime depends on, once. */
  async prepare(options = {}) {
    await this.#connection.send('Page.enable', {}, { sessionId: this.#sessionId, ...options })
    await this.#connection.send('Runtime.enable', {}, { sessionId: this.#sessionId, ...options })
    if (this.#captureNetwork) {
      await this.#connection.send('Network.enable', {}, { sessionId: this.#sessionId, ...options }).catch(() => {})
    }
  }

  /**
   * Pin the CSS viewport to the configured size.
   *
   * `--window-size` sizes the window frame, so `innerWidth`/`innerHeight` come
   * out ~17px narrower and ~95px shorter, and both a snapshot and a screenshot
   * would disagree with the configured viewport. Emulation makes the two agree
   * exactly, which is what click coordinates and image dimensions rely on.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bounds.
   */
  async applyViewport(options = {}) {
    if (this.#viewport === null || this.#viewportApplied) return
    this.#viewportApplied = true
    await this.#connection
      .send(
        'Emulation.setDeviceMetricsOverride',
        {
          width: this.#viewport.width,
          height: this.#viewport.height,
          deviceScaleFactor: 1,
          mobile: false,
        },
        { sessionId: this.#sessionId, ...options },
      )
      .catch((error) => {
        this.#viewportApplied = false
        throw new Error(`无法把视口固定为 ${this.#viewport.width}x${this.#viewport.height}：${error.message}`)
      })
  }

  /**
   * Step one entry through the session history.
   * @param {'back' | 'forward'} direction - which way to move.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bounds.
   */
  async historyStep(direction, options = {}) {
    const { currentIndex, entries } = await this.#connection.send(
      'Page.getNavigationHistory',
      {},
      { sessionId: this.#sessionId, ...options },
    )
    const index = direction === 'back' ? currentIndex - 1 : currentIndex + 1
    const entry = entries?.[index]
    if (!entry) {
      throw new Error(`这个标签页没有可用的${direction === 'back' ? '后退' : '前进'}历史记录`)
    }
    await this.#connection.send(
      'Page.navigateToHistoryEntry',
      { entryId: entry.id },
      { sessionId: this.#sessionId, ...options },
    )
    this.invalidateWorld()
    await this.#waitForLoad({ timeoutMs: this.#timeouts.navigation, ...options })
    return { url: entry.url ?? '', title: entry.title ?? '' }
  }

  /** Create (or reuse) the isolated world that holds the runtime. */
  async #world(options = {}) {
    if (this.#worldId !== null) return this.#worldId
    const { frameTree } = await this.#connection.send('Page.getFrameTree', {}, { sessionId: this.#sessionId, ...options })
    const frameId = frameTree?.frame?.id
    if (frameId === undefined) throw new Error('页面还没有主框架')
    const { executionContextId } = await this.#connection.send(
      'Page.createIsolatedWorld',
      { frameId, worldName: WORLD_NAME, grantUniveralAccess: false },
      { sessionId: this.#sessionId, ...options },
    )
    this.#worldId = executionContextId
    return this.#worldId
  }

  /** Drop the runtime's world, so a navigation-bound ref table is never reused. */
  invalidateWorld() {
    this.#worldId = null
  }

  /**
   * Evaluate the runtime installation, installing it if absent.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bounds.
   */
  async ensureRuntime(options = {}) {
    const contextId = await this.#world(options)
    const installed = await this.#connection.send(
      'Runtime.evaluate',
      {
        expression: `(function(){var r=globalThis.${RUNTIME_GLOBAL};return !!(r&&r.version===${RUNTIME_VERSION})})()`,
        contextId,
        returnByValue: true,
      },
      { sessionId: this.#sessionId, ...options },
    )
    if (installed?.result?.value === true) return
    await this.#connection.send(
      'Runtime.evaluate',
      { expression: PAGE_RUNTIME_SOURCE, contextId, returnByValue: false },
      { sessionId: this.#sessionId, ...options },
    )
  }

  /**
   * Run one page operation through the installed runtime.
   * @param {string} op - operation name.
   * @param {object} args - arguments.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bounds.
   * @returns the runtime's JSON reply.
   */
  async run(op, args, options = {}) {
    const contextId = await this.#world(options)
    const expression = `(function(){var r=globalThis.${RUNTIME_GLOBAL};if(!r)throw new Error('页面运行时没有装上');return r.run(${JSON.stringify(op)},${JSON.stringify(args ?? {})})})()`
    const reply = await this.#connection.send(
      'Runtime.evaluate',
      { expression, contextId, awaitPromise: true, returnByValue: true },
      { sessionId: this.#sessionId, ...options },
    )
    if (reply?.exceptionDetails) {
      throw new Error(pageErrorMessage(reply.exceptionDetails))
    }
    return reply?.result?.value
  }

  /** Navigate this page and wait for the load lifecycle. */
  async navigate(url, options = {}) {
    const result = await this.#connection.send('Page.navigate', { url }, { sessionId: this.#sessionId, ...options })
    if (result.errorText) throw new Error(`导航到 ${url} 失败：${result.errorText}`)
    this.invalidateWorld()
    await this.#waitForLoad(options)
    return result
  }

  /** Wait for `document.readyState === 'complete'`, bounded. */
  async #waitForLoad(options = {}) {
    const deadline = Date.now() + (options.timeoutMs ?? this.#timeouts.navigation)
    for (;;) {
      const state = await this.#connection
        .send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, { sessionId: this.#sessionId, timeoutMs: 5_000, signal: options.signal })
        .then((reply) => reply?.result?.value)
        .catch(() => null)
      if (state === 'complete') return
      if (Date.now() > deadline) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  /** Capture a PNG of the viewport, or of one element when a clip is given. */
  async screenshot({ clip, fullPage } = {}, options = {}) {
    const params = { format: 'png' }
    if (clip) params.clip = { ...clip, scale: 1 }
    if (fullPage === true) {
      const metrics = await this.#connection.send('Page.getLayoutMetrics', {}, { sessionId: this.#sessionId, ...options })
      const size = metrics.cssContentSize ?? metrics.contentSize
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
      params.captureBeyondViewport = true
    }
    const reply = await this.#connection.send('Page.captureScreenshot', params, { sessionId: this.#sessionId, ...options })
    const dimensions = pngSize(Buffer.from(reply.data, 'base64'))
    return { base64: reply.data, width: dimensions?.width ?? 0, height: dimensions?.height ?? 0 }
  }

  /** Detach and close the page. */
  async close(options = {}) {
    await this.#connection.send('Target.closeTarget', { targetId: this.#targetId }, options).catch(() => {})
  }
}

/**
 * Read the intrinsic size out of a PNG's IHDR chunk.
 *
 * The screenshot protocol returns bytes with no dimensions, and a report of
 * "?x?px" is useless to anyone positioning a click from the image.
 * @param {Buffer} buffer - PNG bytes.
 * @returns {{ width: number, height: number } | null} the size, or null when the bytes are not a PNG.
 */
function pngSize(buffer) {
  if (buffer.length < 24) return null
  const signature = buffer.subarray(0, 8)
  if (signature.toString('hex') !== '89504e470d0a1a0a') return null
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * Format a timestamp in the user's own zone with an explicit offset.
 *
 * Protocol events arrive as epoch milliseconds; printing raw UTC made a local
 * 13:04 message read as 05:04 with nothing saying so.
 * @param {number} epochMs - the event time.
 * @returns a local timestamp with its offset, for example `2026-10-22 13:04:13.597 +08:00`.
 */
function localStamp(epochMs) {
  const date = new Date(epochMs)
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const hours = pad(Math.floor(Math.abs(offsetMinutes) / 60))
  const minutes = pad(Math.abs(offsetMinutes) % 60)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)} ` +
    `${sign}${hours}:${minutes}`
  )
}

/**
 * The CDP-backed browser.
 */
export class CdpBackend {
  #connection = null
  #managed = null
  #sessions = new Map()
  #endpoint = null
  #timeouts
  #config
  #log
  #console = new Map()
  #network = new Map()
  #requests = new Map()
  #eventsBound = false
  #viewport

  /**
   * @param {object} options - wiring.
   * @param {object} options.config - resolved plugin config.
   * @param {(message: string) => void} [options.log] - diagnostic sink.
   */
  constructor({ config, log }) {
    this.#config = config
    this.#log = log ?? (() => {})
    this.#timeouts = {
      navigation: config.defaultTimeoutMs,
    }
    this.#viewport = {
      width: config.viewportWidth > 0 ? config.viewportWidth : 1280,
      height: config.viewportHeight > 0 ? config.viewportHeight : 900,
    }
  }

  /** Backend identity reported by `chrome_status`. */
  get name() {
    return 'cdp'
  }

  /** Whether a browser endpoint is reachable. */
  get available() {
    return this.#connection?.open === true
  }

  /** Liveness facts for status output. */
  get status() {
    return {
      // Report an endpoint only while a connection is actually open; a dead
      // browser must not look reachable.
      endpoint: this.#connection?.open === true ? this.#endpoint : null,
      managed: this.#managed?.running === true,
      pid: this.#managed?.pid ?? null,
      pages: this.#sessions.size,
    }
  }

  /**
   * Launch a private Chrome and connect to it.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bounds.
   */
  async launch(options = {}) {
    if (this.#connection?.open === true) return this.status
    const { path } = resolveChromePath({ chromePath: this.#config.chromePath })
    const userDataDir = this.#config.userDataDir || defaultUserDataDir(this.#config.dshHome)
    const managed = new ManagedChrome({ log: this.#log })
    const { endpoint } = await managed.launch({
      executable: path,
      userDataDir,
      headless: this.#config.headless !== false,
      // Chrome parses `--window-size` with a COMMA; `1280x900` is ignored and
      // falls back to the 800x600 default window.
      viewport: `${this.#config.viewportWidth},${this.#config.viewportHeight}`,
      readyTimeoutMs: options.timeoutMs ?? 20_000,
    })
    this.#managed = managed
    await this.#connect(endpoint, options)
    return this.status
  }

  /**
   * Attach to an already-running DevTools endpoint.
   * @param {string} endpoint - a `http://host:port` DevTools base.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bounds.
   */
  async attach(endpoint, options = {}) {
    if (this.#connection?.open === true) return this.status
    await this.#connect(endpoint, options)
    return this.status
  }

  /** Open the browser WebSocket and bind event handling. */
  async #connect(endpoint, options) {
    const version = await readVersion(endpoint, { timeoutMs: options.timeoutMs ?? 10_000 })
    const connection = await CdpConnection.open(version.ws, { timeoutMs: options.timeoutMs ?? 15_000 })
    this.#connection = connection
    this.#endpoint = version.endpoint
    this.#log(`connected to ${version.endpoint} (${version.browser})`)
    if (!this.#eventsBound) {
      this.#eventsBound = true
      connection.onEvent((event) => this.#onEvent(event))
    }
    return version
  }

  /** Track navigation and console traffic per page session. */
  #onEvent(event) {
    const sessionId = event.sessionId
    if (sessionId === undefined) return
    const session = this.#sessions.get(sessionId)
    if (!session) return
    if (event.method === 'Page.frameNavigated' && event.params?.frame?.parentId === undefined) {
      session.invalidateWorld()
      return
    }
    if (event.method === 'Runtime.consoleAPICalled') {
      const params = event.params ?? {}
      const entry = {
        level: params.type ?? 'log',
        text: (params.args ?? [])
          .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description ?? arg.type ?? ''))
          .join(' '),
        time: localStamp(Date.now()),
        source: params.stackTrace?.callFrames?.[0]?.url ?? null,
      }
      this.#pushConsole(session.targetId, entry)
      return
    }
    if (event.method === 'Runtime.exceptionThrown') {
      const details = event.params?.exceptionDetails ?? {}
      this.#pushConsole(session.targetId, {
        level: 'exception',
        text: details.exception?.description ?? details.text ?? 'uncaught exception',
        time: localStamp(Date.now()),
        source: details.url ?? null,
      })
      return
    }
    if (event.method === 'Network.requestWillBeSent') {
      const params = event.params ?? {}
      const record = {
        requestId: params.requestId,
        method: params.request?.method ?? 'GET',
        url: params.request?.url ?? '',
        type: params.type ?? 'Other',
        startedAt: Date.now(),
        time: localStamp(Date.now()),
        status: null,
        bytes: null,
        ms: null,
        failed: false,
      }
      this.#requests.set(params.requestId, record)
      this.#pushNetwork(session.targetId, record)
      return
    }
    if (event.method === 'Network.responseReceived') {
      const record = this.#requests.get(event.params?.requestId)
      if (!record) return
      record.status = event.params?.response?.status ?? null
      record.type = event.params?.type ?? record.type
      record.mimeType = event.params?.response?.mimeType ?? null
      record.ms = Date.now() - record.startedAt
      return
    }
    if (event.method === 'Network.loadingFinished') {
      const record = this.#requests.get(event.params?.requestId)
      if (!record) return
      record.bytes = event.params?.encodedDataLength ?? null
      record.ms = Date.now() - record.startedAt
      this.#requests.delete(event.params.requestId)
      return
    }
    if (event.method === 'Network.loadingFailed') {
      const record = this.#requests.get(event.params?.requestId)
      if (!record) return
      record.failed = true
      record.errorText = event.params?.errorText ?? null
      record.ms = Date.now() - record.startedAt
      this.#requests.delete(event.params.requestId)
    }
  }

  /** Keep a bounded network ring per target. */
  #pushNetwork(targetId, record) {
    const buffer = this.#network.get(targetId) ?? []
    buffer.push(record)
    if (buffer.length > this.#config.maxBufferedEvents) buffer.splice(0, buffer.length - this.#config.maxBufferedEvents)
    this.#network.set(targetId, buffer)
  }

  /** Keep a bounded console ring per target. */
  #pushConsole(targetId, entry) {
    const buffer = this.#console.get(targetId) ?? []
    buffer.push(entry)
    if (buffer.length > this.#config.maxBufferedEvents) buffer.splice(0, buffer.length - this.#config.maxBufferedEvents)
    this.#console.set(targetId, buffer)
  }

  /** The connection, asserting it is usable. */
  #requireConnection() {
    if (this.#connection?.open !== true) {
      throw new Error('还没有通过 CDP 连上 Chrome；先执行 chrome_status action=launch')
    }
    return this.#connection
  }

  /** A page session by target id, asserting it still exists. */
  #requireSession(targetId) {
    for (const session of this.#sessions.values()) {
      if (session.targetId === targetId) return session
    }
    throw new Error(`页面 ${targetId} 已不再附着；重新执行 chrome_tabs action=list`)
  }

  /** List page targets, attaching a session to any new one. */
  async listTabs(options = {}) {
    const connection = this.#requireConnection()
    const connectionEndpoints = await listPageTargets(this.#endpoint, { timeoutMs: 5_000 })
    const tabs = []
    for (const target of connectionEndpoints) {
      let session = [...this.#sessions.values()].find((candidate) => candidate.targetId === target.id)
      if (!session) {
        const sessionId = await connection.attach(target.id, options)
        session = new PageSession({
          connection,
          targetId: target.id,
          sessionId,
          timeouts: this.#timeouts,
          captureNetwork: this.#config.captureNetwork === true,
          viewport: this.#viewport,
        })
        this.#sessions.set(sessionId, session)
        await session.prepare(options)
        await session.applyViewport(options)
      }
      tabs.push({ id: target.id, title: target.title, url: target.url, active: false })
    }
    return tabs
  }

  /** Create a page and return its target id. */
  async newTab(url = 'about:blank', options = {}) {
    const connection = this.#requireConnection()
    const { targetId, sessionId } = await connection.createPage(url, options)
    const session = new PageSession({
      connection,
      targetId,
      sessionId,
      timeouts: this.#timeouts,
      captureNetwork: this.#config.captureNetwork === true,
      viewport: this.#viewport,
    })
    this.#sessions.set(sessionId, session)
    await session.prepare(options)
    await session.applyViewport(options)
    return targetId
  }

  /** Bring a target to the foreground. */
  async activateTab(targetId, options = {}) {
    await this.#requireConnection().send('Target.activateTarget', { targetId }, options)
  }

  /** Close a target. */
  async closeTab(targetId, options = {}) {
    const connection = this.#requireConnection()
    await connection.send('Target.closeTarget', { targetId }, options)
    for (const [sessionId, session] of [...this.#sessions]) {
      if (session.targetId === targetId) this.#sessions.delete(sessionId)
    }
    this.#console.delete(targetId)
    this.#network.delete(targetId)
  }

  /**
   * Step one page through its history, or reload it.
   * @param {string} targetId - the page target.
   * @param {'back' | 'forward' | 'reload'} direction - which way to move.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bounds.
   */
  async historyStep(targetId, direction, options = {}) {
    const session = this.#requireSession(targetId)
    if (direction === 'reload') return this.reload(targetId, options)
    const moved = await session.historyStep(direction, options)
    await session.ensureRuntime(options)
    const described = await this.#describeTarget(targetId)
    return { url: described.url || moved.url, title: described.title || moved.title }
  }

  /** Read (and optionally clear) buffered network entries for one target. */
  network(targetId, { limit, filter } = {}) {
    const buffer = this.#network.get(targetId) ?? []
    const slice = buffer.slice(Math.max(0, buffer.length - (limit ?? 50)))
    const filtered = filter ? slice.filter((entry) => String(entry.url ?? '').includes(filter)) : slice
    return { entries: filtered, total: buffer.length }
  }

  /** Navigate one page. */
  async navigate(targetId, url, options = {}) {
    const session = this.#requireSession(targetId)
    await session.navigate(url, { timeoutMs: this.#timeouts.navigation, ...options })
    await session.ensureRuntime(options)
    return this.#describeTarget(targetId)
  }

  /** Re-load one page. */
  async reload(targetId, options = {}) {
    const session = this.#requireSession(targetId)
    await this.#requireConnection().send('Page.reload', {}, { sessionId: session.sessionId, ...options })
    session.invalidateWorld()
    await session.ensureRuntime(options)
    return this.#describeTarget(targetId)
  }

  /** Read title/URL for one page. */
  async #describeTarget(targetId) {
    const [tab] = (await listPageTargets(this.#endpoint, { timeoutMs: 5_000 })).filter((entry) => entry.id === targetId)
    return { url: tab?.url ?? '', title: tab?.title ?? '' }
  }

  /** Install the runtime and run one page operation. */
  async run(targetId, op, args, options = {}) {
    const session = this.#requireSession(targetId)
    await session.ensureRuntime(options)
    return session.run(op, args, options)
  }

  /** Capture a screenshot as base64 PNG. */
  async screenshot(targetId, { fullPage, clip } = {}, options = {}) {
    const session = this.#requireSession(targetId)
    return session.screenshot({ fullPage, clip }, options)
  }

  /** Read (and optionally clear) buffered console entries. */
  console(targetId, { limit, clear } = {}) {
    const buffer = this.#console.get(targetId) ?? []
    const slice = buffer.slice(Math.max(0, buffer.length - (limit ?? 50)))
    if (clear === true) buffer.length = 0
    return { entries: slice, total: buffer.length }
  }

  /** Close the browser the plugin owns, and drop every session. */
  async dispose() {
    this.#sessions.clear()
    this.#console.clear()
    this.#network.clear()
    this.#requests.clear()
    const connection = this.#connection
    this.#connection = null
    this.#endpoint = null
    // A later launch opens a NEW socket, so event binding must be re-armed;
    // leaving this set would silently drop every console/network event.
    this.#eventsBound = false
    connection?.close()
    const managed = this.#managed
    this.#managed = null
    // Still release our own reference first: a process that refuses to die must
    // fail the close, but it must not leave the backend believing it owns a
    // browser it can no longer reach.
    await managed?.dispose()
  }
}
