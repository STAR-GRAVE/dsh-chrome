/**
 * The local bridge between the Host plugin and the paired Chrome extension.
 *
 * The extension cannot know which port the Harness listens on, and it must not
 * need a debug port, so the direction is inverted: the extension long-polls this
 * listener, and each poll carries one queued command plus its reply channel.
 *
 * Deliberately free of DSH imports so `test/bridge.test.mjs` can exercise the
 * whole protocol against a real HTTP listener with a simulated extension.
 *
 * @module @local/dsh-chrome/bridge
 */

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

/** Header the extension uses to present its pairing token. */
export const TOKEN_HEADER = 'x-dsh-chrome-token'

/** How long a poll is held open before answering "no work". */
export const DEFAULT_POLL_HOLD_MS = 25_000

/** App tag advertised by `/health`, so a diagnostic can tell this listener apart. */
export const APP_TAG = 'dsh-chrome'

/** Shortest token the bridge accepts; matches the generator's output length. */
const MIN_TOKEN_LENGTH = 16


/**
 * Reject a token that could not have come from this bridge.
 * @param {unknown} token - candidate value.
 * @returns {string} the same value, typed.
 * @throws when the value is not a usable bearer secret.
 */
export function checkToken(token) {
  if (typeof token !== 'string') throw new Error('配对令牌必须是字符串')
  if (token.length < MIN_TOKEN_LENGTH) throw new Error(`配对令牌至少需要 ${MIN_TOKEN_LENGTH} 个字符`)
  if (token.length > 512) throw new Error('配对令牌过长（超过 512 个字符）')
  if (/[\s\u0000-\u001f\u007f]/.test(token)) throw new Error('配对令牌不能包含空白或控制字符')
  return token
}

/** A poll answered with no command, so the extension re-polls immediately. */
const NO_COMMAND = { status: 'idle' }

/**
 * Constant-time token comparison that never throws on length mismatch.
 * @param {string} expected - the token this bridge issued.
 * @param {string} actual - the token presented by the client.
 * @returns whether the two are equal.
 */
function tokenMatches(expected, actual) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'))
}

/**
 * Owns the HTTP listener, the command queue, and extension liveness.
 *
 * One command is in flight at a time. Every command settles exactly once:
 * through the extension's own reply, through its timeout, or through
 * cancellation of the tool call that issued it.
 */
export class ChromeBridge {
  #token
  #host
  #port
  #holdMs
  #server
  #boundPort = 0
  #lastPollAt = 0
  #lastExtensionVersion = null
  #queue = []
  #inFlight = null
  #disposed = false
  #log
  #onPortChange

  /**
   * @param {object} options - listener and liveness settings.
   * @param {string} options.token - pairing token the extension must present.
   * @param {string} [options.host] - bind address; loopback by default.
   * @param {number} [options.port] - preferred port; 0 asks for an ephemeral one.
   * @param {number} [options.holdMs] - how long an idle poll is held open.
   * @param {(port: number) => void | Promise<void>} [options.onPortChange] - persist a new port.
   * @param {(message: string) => void} [options.log] - diagnostic sink.
   */
  constructor({
    token,
    host = '127.0.0.1',
    port = 8731,
    holdMs = DEFAULT_POLL_HOLD_MS,
    onPortChange,
    log,
  }) {
    this.#token = checkToken(token)
    this.#host = host
    this.#port = port
    this.#holdMs = holdMs
    this.#onPortChange = onPortChange
    this.#log = log ?? (() => {})
  }

  /** The token the extension must present; surfaced through `chrome_status`. */
  get token() {
    return this.#token
  }

  /**
   * Replace the live token, as the settings page does.
   * @param {string} next - the new token.
   * @returns {string} the accepted token.
   */
  setToken(next) {
    this.#token = checkToken(next)
    return this.#token
  }

  /** The port actually bound; equals the preferred port unless it was taken. */
  get port() {
    return this.#boundPort
  }

  /** Whether the listener is currently bound and accepting polls. */
  get listening() {
    return this.#server !== null && this.#boundPort !== 0
  }

  /** The loopback URL the extension should be configured with. */
  get endpoint() {
    return `http://${this.#host}:${this.#boundPort}`
  }

  /** Whether an extension polled recently enough to be considered connected. */
  get connected() {
    if (this.#lastPollAt === 0) return false
    return Date.now() - this.#lastPollAt < this.#holdMs * 2 + 10_000
  }

  /** Liveness and queue state for `chrome_status`. */
  get status() {
    return {
      endpoint: this.listening ? this.endpoint : null,
      listening: this.listening,
      connected: this.connected,
      lastPollAt: this.#lastPollAt === 0 ? null : new Date(this.#lastPollAt).toISOString(),
      extensionVersion: this.#lastExtensionVersion,
      queued: this.#queue.length,
      inFlight: this.#inFlight?.command.method ?? null,
    }
  }

  /**
   * Bind the listener.
   *
   * The port is fixed: one number, chosen by the user. A taken port fails the
   * start with a readable error instead of drifting somewhere the extension
   * would have to hunt for.
   * @returns the endpoint the extension should use.
   */
  async start() {
    if (this.#server) return this.endpoint
    const server = createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        this.#log(`bridge request failed: ${error.message}`)
        if (!res.headersSent) this.#write(res, 500, { error: error.message })
        else res.end()
      })
    })
    server.keepAliveTimeout = this.#holdMs + 20_000
    server.headersTimeout = this.#holdMs + 30_000
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening)
        if (error.code === 'EADDRINUSE') {
          reject(new Error(`端口 ${this.#port} 已被占用；在「Chrome 连接」页或 profile 的 bridgePort 里换一个端口`))
          return
        }
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.#port, this.#host)
    })
    this.#server = server
    this.#boundPort = server.address().port
    this.#log(`bridge listening on ${this.endpoint}`)
    return this.endpoint
  }

  /**
   * Move the listener to another port.
   *
   * The new port is bound before the old listener is dropped, so a taken port
   * leaves the bridge exactly where it was instead of deaf.
   * @param {number} port - the port to bind (1-65535).
   * @returns {Promise<number>} the port actually bound.
   */
  async rebind(port) {
    const old = await this.#bindOn(port)
    const bound = this.#boundPort
    await this.#onPortChange?.(bound)
    if (old.server !== null && old.server !== undefined) {
      old.server.closeAllConnections?.()
      old.server.close(() => {})
    }
    return bound
  }

  /**
   * Bind `port` while the current listener keeps serving.
   * @param {number} port - the port to bind.
   * @returns {Promise<{ server: import('node:http').Server | null, port: number, preferred: number }>} the listener being replaced.
   */
  async #bindOn(port) {
    const next = Number(port)
    if (!Number.isInteger(next) || next < 1 || next > 65535) throw new Error('端口要填 1–65535 之间的整数')
    if (this.#disposed) throw new Error('桥已关闭')
    const old = { server: this.#server, port: this.#boundPort, preferred: this.#port }
    this.#server = null
    this.#boundPort = 0
    this.#port = next
    try {
      await this.start()
      return old
    } catch (error) {
      this.#server = old.server
      this.#boundPort = old.port
      this.#port = old.preferred
      throw error
    }
  }

  /**
   * Queue one command and wait for the extension's answer.
   * @param {string} method - operation name the extension's dispatcher knows.
   * @param {unknown} params - JSON-safe parameters.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bounds.
   * @returns the extension's reply payload.
   */
  async call(method, params, { timeoutMs = 30_000, signal } = {}) {
    if (this.#disposed) throw new Error('扩展桥已关闭；重新执行 chrome_status action=pair 即可重启')
    if (!this.connected) {
      throw new Error('扩展还没连上。请打开 Chrome，确认 DSH Chrome 扩展在运行（chrome_status action=pair 会给出地址与令牌）。')
    }
    if (signal?.aborted) throw new Error('这次调用在到达 Chrome 之前就被取消了')
    const command = {
      id: randomBytes(8).toString('hex'),
      method,
      params: params ?? {},
      deadline: Date.now() + timeoutMs,
    }
    return new Promise((resolve, reject) => {
      const entry = { command, resolve, reject, timer: null, onAbort: null, signal, settled: false }
      entry.timer = setTimeout(() => {
        this.#settle(entry, { error: `the Chrome extension did not answer ${method} within ${timeoutMs}ms` })
      }, timeoutMs)
      entry.timer.unref?.()
      if (signal) {
        entry.onAbort = () => this.#settle(entry, { error: '这次调用已被取消' })
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      this.#queue.push(entry)
      this.#wakePoller()
    })
  }

  /** Bind one page's operations to a send/receive pair used by both backends. */
  get extensionChannel() {
    return {
      send: (method, params, options) => this.call(method, params, options),
      status: () => this.status,
    }
  }

  /** Register the extension's presence: it is polling, so it is alive. */
  #notePoll(version) {
    this.#lastPollAt = Date.now()
    if (typeof version === 'string' && version.length > 0) this.#lastExtensionVersion = version
  }

  /** Wake a held poll because new work arrived. */
  #wakePoller() {
    if (this.#heldPoll === null || this.#heldPoll === undefined) return
    const held = this.#heldPoll
    this.#heldPoll = null
    clearTimeout(held.timer)
    held.release()
  }

  /** Held idle poll; at most one, because the extension polls serially. */
  #heldPoll = null

  /**
   * Settle one queued command exactly once, from whichever source wins.
   * @param {object} entry - the queued command record.
   * @param {{ value?: unknown, error?: string }} outcome - the settlement.
   */
  #settle(entry, outcome) {
    if (entry.settled) return
    entry.settled = true
    clearTimeout(entry.timer)
    if (entry.onAbort && entry.signal) entry.signal.removeEventListener('abort', entry.onAbort)
    const index = this.#queue.indexOf(entry)
    if (index >= 0) this.#queue.splice(index, 1)
    if (this.#inFlight === entry) this.#inFlight = null
    if (outcome.error !== undefined) entry.reject(new Error(outcome.error))
    else entry.resolve(outcome.value)
  }

  /**
   * Route one HTTP request.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   */
  async #handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://bridge')
    if (req.method === 'OPTIONS') {
      this.#preflight(req, res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      this.#write(res, 200, { ok: true, app: APP_TAG, connected: this.connected })
      return
    }
    if (req.method === 'POST' && url.pathname === '/poll') {
      const body = await this.#readJson(req)
      if (!this.#authorize(req, body, res)) return
      this.#notePoll(body?.version)
      const entry = this.#nextCommand()
      if (entry) {
        this.#write(res, 200, { status: 'command', command: this.#publicCommand(entry.command) })
        return
      }
      await this.#holdUntilWork(res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/result') {
      const body = await this.#readJson(req)
      if (!this.#authorize(req, body, res)) return
      this.#notePoll(body?.version)
      this.#acceptResult(body)
      this.#write(res, 200, { ok: true })
      return
    }
    this.#write(res, 404, { error: `unknown bridge route ${req.method} ${url.pathname}` })
  }

  /**
   * Verify the pairing token without leaking whether the route exists.
   * @returns whether the request may proceed.
   */
  #authorize(req, body, res) {
    const headerToken = req.headers[TOKEN_HEADER]
    const presented = typeof headerToken === 'string' ? headerToken : body?.token
    if (tokenMatches(this.#token, presented)) return true
    this.#write(res, 401, { error: '配对令牌被拒绝；在左侧导航的「Chrome 连接」页或 chrome_status action=pair 里取出当前令牌，重新填进扩展选项页' })
    return false
  }

  /**
   * Answer the extension's CORS preflight.
   *
   * The service worker preflights every poll because it sends a custom token
   * header. Only a real extension can present a `chrome-extension://` origin, so
   * granting that scheme is all the listener needs; the token still authorizes
   * the call itself.
   *
   * @param {import('node:http').IncomingMessage} req - the preflight request.
   * @param {import('node:http').ServerResponse} res - the response.
   */
  #preflight(req, res) {
    const origin = String(req.headers.origin ?? '')
    if (!origin.startsWith('chrome-extension://')) {
      this.#log(`rejected a preflight from ${origin || '（无 Origin 头）'}`)
      res.writeHead(403, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    res.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': `${TOKEN_HEADER}, content-type`,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-private-network': 'true',
      'access-control-max-age': '600',
      vary: 'origin',
      'cache-control': 'no-store',
    })
    res.end()
  }

  /** The next command to hand the polling extension, or undefined when idle. */
  #nextCommand() {
    if (this.#inFlight) return undefined
    const entry = this.#queue.shift()
    if (entry === undefined) return undefined
    if (entry.command.deadline <= Date.now()) {
      this.#settle(entry, { error: '扩展回复得太晚，这条命令在队列里已经过期' })
      return this.#nextCommand()
    }
    this.#inFlight = entry
    return entry
  }

  /** The wire form of one command. */
  #publicCommand(command) {
    return { id: command.id, method: command.method, params: command.params }
  }

  /**
   * Hold a poll open until work arrives, the hold expires, or the client leaves.
   * A released poll answers `idle` so the extension simply polls again.
   */
  async #holdUntilWork(res) {
    if (this.#disposed) {
      this.#write(res, 200, NO_COMMAND)
      return
    }
    await new Promise((resolve) => {
      let done = false
      /** Release the wait exactly once: answer, then let the handler return. */
      const settle = (payload) => {
        if (done) return
        done = true
        this.#heldPoll = null
        if (!res.writableEnded) this.#write(res, 200, payload)
        resolve()
      }
      const entry = {
        release: () => {
          const next = this.#nextCommand()
          settle(next ? { status: 'command', command: this.#publicCommand(next.command) } : NO_COMMAND)
        },
      }
      const timer = setTimeout(() => settle(NO_COMMAND), this.#holdMs)
      timer.unref?.()
      entry.timer = timer
      this.#heldPoll = entry
      res.on('close', () => {
        if (done) return
        done = true
        this.#heldPoll = null
        resolve()
      })
      res.on('error', () => {
        if (done) return
        done = true
        this.#heldPoll = null
        resolve()
      })
    })
  }

  /** Apply one reply from the extension to the command in flight. */
  #acceptResult(body) {
    const entry = this.#inFlight
    if (entry === null || entry === undefined) return
    const id = body?.id
    if (typeof id === 'string' && id !== entry.command.id) return
    if (body?.ok === false) {
      this.#settle(entry, { error: typeof body.error === 'string' ? body.error : '扩展报告失败但没有给出原因' })
      return
    }
    this.#settle(entry, { value: body?.result })
  }

  /** Read and parse a JSON body with a hard size bound. */
  async #readJson(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 4 * 1024 * 1024) throw new Error('桥的请求体超过 4 MiB')
      chunks.push(chunk)
    }
    if (size === 0) return {}
    const text = Buffer.concat(chunks).toString('utf8')
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('桥的请求体不是合法 JSON')
    }
  }

  /** Write one JSON response, allowing the extension's origin. */
  #write(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'access-control-allow-origin': '*',
      'access-control-allow-headers': `${TOKEN_HEADER}, content-type`,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  /** Close the listener and fail everything still waiting. */
  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    for (const entry of [...this.#queue]) this.#settle(entry, { error: '扩展桥在这条命令执行之前就关闭了' })
    if (this.#inFlight) this.#settle(this.#inFlight, { error: '扩展桥在这条命令执行途中关闭了' })
    this.#wakePoller()
    const server = this.#server
    this.#server = null
    this.#boundPort = 0
    if (!server) return
    await new Promise((resolve) => server.close(resolve))
  }
}

/** Generate a pairing token with enough entropy for a local bearer secret. */
export function createPairingToken() {
  return randomBytes(24).toString('base64url')
}
