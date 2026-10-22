/**
 * Host half of the Remote: the pairing page's only channel to the plugin.
 *
 * The page cannot read files, so every value it shows (the token) or changes
 * (the token, the port) travels through this service. That is deliberate: it
 * works whether or not the local bridge is listening, which is exactly the case
 * where the user must change the port to get anywhere.
 *
 * ## Why there is no `@Remote` syntax here
 *
 * Official packages write `@Remote` in TypeScript and compile it; the compiler
 * turns the decorator into an initializer that appends one *marker* per method
 * to a versioned descriptor on the service prototype. That descriptor lives
 * under a **stable string key** on purpose — the protocol package documents it
 * as the thing another installed copy (or, here, a plugin without a build step)
 * can read and write:
 *
 *     '@deepseek-ai/dsh-typert-protocol/remote-methods' → { version: 1, methods: [...] }
 *
 * So this file installs the same marks directly instead of vendoring TypeScript's
 * decorator helpers. That is the normal authoring path for a third-party plugin:
 * the generator that would emit them is not distributed, and the protocol keeps
 * the marks in a readable format precisely so a plugin can write them itself.
 * `test/typert.test.mjs` keeps them in step with the browser contribution.
 *
 * @module @local/dsh-chrome/remote
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import { PAIRING_METHODS, PAIRING_SERVICE } from './pairing-methods.js'

/** Prototype slot the protocol reads its method marks from. */
const REMOTE_METHODS_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * The pairing service: three methods, all plain JSON.
 *
 * Every method returns the value itself; the gateway wraps it into the
 * `{ ok, value }` envelope the browser proxy hands back.
 */
export class ChromePairingRemote extends TypertRemoteService {
  /**
   * @param {object} ctx - the plugin context this service registers on.
   * @param {object} runtime - the ChromeRuntime that owns the bridge.
   */
  constructor(ctx, runtime) {
    super(ctx, PAIRING_SERVICE)
    this.runtime = runtime
  }

  /** Current pairing facts: port, token, bridge error, extension liveness. */
  async read() {
    return this.runtime.pairingState()
  }

  /** Replace the pairing token; the extension has to be re-pointed by hand. */
  async setToken(token) {
    return this.runtime.pairingSetToken(token)
  }

  /** Move the bridge to another port and remember it. */
  async setPort(port) {
    return this.runtime.pairingSetPort(port)
  }
}

// The mark the `@Remote` decorator would have written, in the protocol's own
// storage format. One record per method, invocations frozen like the real ones.
Object.defineProperty(ChromePairingRemote.prototype, REMOTE_METHODS_KEY, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze(
      PAIRING_METHODS.map(({ method }) =>
        Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }),
      ),
    ),
  }),
})
