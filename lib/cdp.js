/**
 * A dependency-free Chrome DevTools Protocol client.
 *
 * The Harness Host runs on Electron's Node 24, which carries a global
 * `WebSocket` and `fetch`, so the fallback transport needs no package at all —
 * which matters because a profile bundle must not pull native or third-party
 * modules into the Host process.
 *
 * Only the verbs this plugin needs are modelled; everything else goes through
 * `send()`.
 *
 * @module @local/dsh-chrome/cdp
 */

/** Raised when the browser or a page session has gone away mid-call. */
export class CdpDisconnectedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CdpDisconnectedError'
  }
}

/**
 * One WebSocket connection to a browser or page endpoint, multiplexing
 * flattened target sessions over it.
 */
export class CdpConnection {
  #ws
  #nextId = 1
  #pending = new Map()
  #listeners = new Set()
  #closed = false
  #url

  /**
   * @param {WebSocket} ws - an already-open socket.
   * @param {string} url - the endpoint, for diagnostics.
   */
  constructor(ws, url) {
    this.#ws = ws
    this.#url = url
    ws.addEventListener('message', (event) => this.#onMessage(event))
    ws.addEventListener('close', () => this.#onClose('DevTools 连接已断开'))
    ws.addEventListener('error', () => this.#onClose('DevTools 连接失败'))
  }

  /** The endpoint this connection talks to. */
  get url() {
    return this.#url
  }

  /** Whether the socket is still usable. */
  get open() {
    return !this.#closed
  }

  /**
   * Open a connection to a browser-level or page-level WebSocket URL.
   * @param {string} url - a `ws://` DevTools endpoint.
   * @param {{ timeoutMs?: number }} [options] - connect bound.
   * @returns {Promise<CdpConnection>} the open connection.
   */
  static async open(url, { timeoutMs = 15_000 } = {}) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        try {
          ws.close()
        } catch {
          /* the socket may not have opened */
        }
        reject(new CdpDisconnectedError(`timed out connecting to ${url}`))
      }, timeoutMs)
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new CdpDisconnectedError(`could not connect to ${url}`))
      }
      const cleanup = () => {
        clearTimeout(timer)
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
      }
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onError)
    })
    return new CdpConnection(ws, url)
  }

  /**
   * Send one protocol command and await its result.
   * @param {string} method - protocol method, such as `Page.navigate`.
   * @param {object} [params] - method parameters.
   * @param {{ sessionId?: string, timeoutMs?: number, signal?: AbortSignal }} [options] - routing and bounds.
   * @returns {Promise<any>} the method result.
   */
  send(method, params = {}, { sessionId, timeoutMs = 30_000, signal } = {}) {
    if (this.#closed) {
      return Promise.reject(new CdpDisconnectedError(`cannot send ${method}: ${this.#url} is closed`))
    }
    if (signal?.aborted) return Promise.reject(new Error(`cancelled before ${method} was sent`))
    const id = this.#nextId++
    const message = { id, method, params }
    if (sessionId !== undefined) message.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${method} did not answer within ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      const onAbort = () => {
        cleanup()
        reject(new Error(`${method} was cancelled`))
      }
      const cleanup = () => {
        clearTimeout(timer)
        if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      this.#pending.set(id, {
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
        method,
      })
      try {
        this.#ws.send(JSON.stringify(message))
      } catch (error) {
        this.#pending.delete(id)
        cleanup()
        reject(new CdpDisconnectedError(`could not send ${method}: ${error.message}`))
      }
    })
  }

  /**
   * Subscribe to protocol events.
   * @param {(event: { method: string, params: any, sessionId?: string }) => void} listener - event sink.
   * @returns {() => void} unsubscribe.
   */
  onEvent(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Create a new page target and attach a flattened session to it.
   * @param {string} [url] - initial URL.
   * @param {{ timeoutMs?: number }} [options] - bound.
   * @returns {Promise<{ targetId: string, sessionId: string }>} the new target.
   */
  async createPage(url = 'about:blank', options = {}) {
    const { targetId } = await this.send('Target.createTarget', { url }, options)
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, options)
    return { targetId, sessionId }
  }

  /**
   * Attach a flattened session to an existing target.
   * @param {string} targetId - an existing page target.
   * @param {{ timeoutMs?: number }} [options] - bound.
   * @returns {Promise<string>} the session id.
   */
  async attach(targetId, options = {}) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, options)
    return sessionId
  }

  /** Close the socket and fail everything waiting on it. */
  close() {
    this.#onClose('DevTools 连接被关闭')
    try {
      this.#ws.close()
    } catch {
      /* already gone */
    }
  }

  /** Fan one inbound frame out to command replies or event listeners. */
  #onMessage(event) {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    if (message.id !== undefined && this.#pending.has(message.id)) {
      const pending = this.#pending.get(message.id)
      this.#pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message ?? 'protocol error'}`))
      } else {
        pending.resolve(message.result ?? {})
      }
      return
    }
    if (message.method !== undefined) {
      for (const listener of this.#listeners) {
        try {
          listener(message)
        } catch {
          /* an event listener must never break the socket */
        }
      }
    }
  }

  /** Fail every pending command once, whichever way the socket ended. */
  #onClose(reason) {
    if (this.#closed) return
    this.#closed = true
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of pending) entry.reject(new CdpDisconnectedError(reason))
  }
}

/**
 * Ask a DevTools HTTP endpoint for its browser WebSocket URL.
 * @param {string} endpoint - base URL such as `http://127.0.0.1:9222`.
 * @param {{ timeoutMs?: number }} [options] - bound.
 * @returns {Promise<{ browser: string, version: string, userAgent?: string }>} endpoint facts.
 */
export async function readVersion(endpoint, { timeoutMs = 5_000 } = {}) {
  const base = endpoint.replace(/\/+$/, '')
  let response
  try {
    response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new Error(`连不上 ${base}/json/version（${error.message}）`)
  }
  if (!response.ok) {
    throw new Error(
      `${base}/json/version 返回了 HTTP ${response.status}。这个端口不是 Chrome 的 DevTools 端点：Chrome 对自己默认数据目录不启用 --remote-debugging-port，所以用你日常 profile 启动的 Chrome 无法被附着。要么用一个独立的 --user-data-dir 另起一个 Chrome，要么改用扩展通路去操作你日常那个 Chrome。`,
    )
  }
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${base}/json/version 返回的不是 JSON；这个端口可能被别的程序占着`)
  }
  if (typeof body.webSocketDebuggerUrl !== 'string') {
    throw new Error(`${base}/json/version 里没有 webSocketDebuggerUrl；这个目标不是浏览器端点`)
  }
  return {
    browser: body.Browser ?? 'unknown',
    version: body.Browser ?? 'unknown',
    userAgent: body['User-Agent'],
    browser_ws: body.webSocketDebuggerUrl,
    ws: body.webSocketDebuggerUrl,
    endpoint: base,
  }
}

/**
 * List the browser's page targets.
 * @param {string} endpoint - base URL such as `http://127.0.0.1:9222`.
 * @param {{ timeoutMs?: number }} [options] - bound.
 * @returns {Promise<Array<{ id: string, type: string, title: string, url: string }>>} page targets.
 */
export async function listPageTargets(endpoint, { timeoutMs = 5_000 } = {}) {
  const base = endpoint.replace(/\/+$/, '')
  const response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`${base}/json/list 返回了 HTTP ${response.status}`)
  const list = await response.json()
  if (!Array.isArray(list)) throw new Error(`${base}/json/list 返回的不是数组`)
  return list
    .filter((target) => target.type === 'page' && typeof target.id === 'string')
    .map((target) => ({
      id: target.id,
      type: target.type,
      title: target.title ?? '',
      url: target.url ?? '',
      ws: target.webSocketDebuggerUrl,
    }))
}
