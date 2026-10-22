/**
 * The extension backend: page operations delegated to the paired MV3 extension.
 *
 * Every method here is one `chrome.*` call the extension's service worker makes
 * on our behalf. The wire contract is deliberately dumb — a method name, a
 * JSON-safe parameter bag, a JSON-safe reply — so the extension stays a thin
 * adapter and this file holds all of the positioning and formatting logic.
 *
 * @module @star-grave/dsh-chrome/backend-extension
 */

/**
 * A backend backed by the extension bridge.
 *
 * The bridge owns the transport; this class owns the method vocabulary.
 */
export class ExtensionBackend {
  #channel

  /**
   * @param {object} options - wiring.
   * @param {{ send: (method: string, params: object, options?: object) => Promise<any>, status: () => object }} options.channel - bridge channel.
   */
  constructor({ channel }) {
    this.#channel = channel
  }

  /** Backend identity reported by `chrome_status`. */
  get name() {
    return 'extension'
  }

  /** Whether the extension has polled recently enough to accept work. */
  get available() {
    return this.#channel.status().connected === true
  }

  /** The bridge's liveness facts. */
  get status() {
    return this.#channel.status()
  }

  /**
   * Call one extension method.
   * @param {string} method - the extension's dispatcher name.
   * @param {object} [params] - parameters.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bounds.
   * @returns the extension's reply.
   */
  call(method, params, options) {
    return this.#channel.send(method, params, options)
  }

  /**
   * Install or replace the page runtime in one tab, then confirm it answers.
   *
   * The extension injects the shared source as a file, so this is a no-op when
   * the content script is already registered; it is re-run after navigation
   * because a fresh document starts without the runtime.
   * @param {number} tabId - the tab to prepare.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bounds.
   */
  async ensureRuntime(tabId, options) {
    await this.call('injectRuntime', { tabId, ensure: true }, options)
  }

  /**
   * Run one page-runtime operation in a tab.
   * @param {number} tabId - the tab.
   * @param {string} op - the runtime operation name.
   * @param {object} args - operation arguments.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bounds.
   * @returns the runtime's reply.
   */
  async run(tabId, op, args, options) {
    return this.call('run', { tabId, op, args }, options)
  }

  /**
   * Capture the visible area of one tab as a PNG.
   * @param {number} tabId - the tab to focus and capture.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bounds.
   * @returns {{ base64: string, note: string }} the PNG and a caveat.
   */
  async screenshot(tabId, options) {
    return this.call('screenshot', { tabId }, options)
  }

  /**
   * Run one operation on the trusted (debugger) path.
   *
   * This is the only way an extension can produce input the browser considers
   * real, and the only way to see requests the page never reports. It costs a
   * visible debugging bar for the session's lifetime, so it never runs unless a
   * caller asked for it.
   * @param {number} tabId - the tab to act on.
   * @param {string} op - the trusted operation name.
   * @param {object} [args] - operation arguments.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bounds.
   * @returns the operation's reply.
   */
  async debugger(tabId, op, args, options) {
    return this.call('debugger', { tabId, op, args }, options)
  }

  /** Which tabs currently hold a debugger session. */
  async debuggerTabs(options) {
    return this.call('debuggerStatus', {}, options)
  }
}
