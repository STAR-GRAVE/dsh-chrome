/**
 * The one place that lists what the pairing page may ask the Host to do.
 *
 * Two artifacts have to agree on these names or a call becomes a 404: the Host
 * service's `@Remote` marks and the browser half's mounted contribution.
 * `test/typert.test.mjs` compares both, so this table is the single source they
 * are checked against.
 *
 * @module @star-grave/dsh-chrome/pairing-methods
 */

/** Wire namespace of the pairing service. */
export const PAIRING_SERVICE = 'chromePairing'

/**
 * The service surface, in declaration order.
 * @type {Array<{ method: string, parameters: Array<{ name: string, type: 'string' | 'number' }> }>}
 */
export const PAIRING_METHODS = [
  { method: 'read', parameters: [] },
  { method: 'setToken', parameters: [{ name: 'token', type: 'string' }] },
  { method: 'setPort', parameters: [{ name: 'port', type: 'number' }] },
]
