#!/usr/bin/env node
/**
 * Drift test for the pairing Remote.
 *
 * A Remote method lives in two places here: the Host service's `@Remote` marks
 * and the browser half's mounted contribution. If they disagree the call is a
 * silent 404, so the plugin keeps one table (`lib/pairing-methods.js`) and this
 * test asserts the hand-written copies still match it.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PAIRING_METHODS, PAIRING_SERVICE } from '../lib/pairing-methods.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (relative) => readFileSync(`${root}${relative}`, 'utf8')

/** Method names the browser contribution declares, in order. */
function contributedMethods(source) {
  const start = source.indexOf('const PAIRING_CONTRIBUTION')
  assert.ok(start >= 0, 'client.js must define PAIRING_CONTRIBUTION')
  const end = source.indexOf('let pairingProxy', start)
  assert.ok(end > start, 'PAIRING_CONTRIBUTION must be a closed literal')
  const block = source.slice(start, end)
  return [...block.matchAll(/method: '([^']+)'/g)].map((match) => match[1])
}

let failures = 0
/** Register one named test and run them in order. */
function test(name, fn) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}\n     ${error.message}`)
  }
}

test('the browser half declares exactly the service table, in order', () => {
  const declared = contributedMethods(read('lib/client.js'))
  assert.deepEqual(declared, PAIRING_METHODS.map((entry) => entry.method))
})

test('both halves name the same wire service', () => {
  const client = read('lib/client.js')
  assert.match(client, new RegExp(`PAIRING_SERVICE = '${PAIRING_SERVICE}'`), 'client.js must use the shared service name')
  assert.match(read('lib/remote.js'), /super\(ctx, PAIRING_SERVICE\)/, 'the Host service must register under it')
})

test('the service class derives its marks from the table', () => {
  const remote = read('lib/remote.js')
  assert.match(remote, /PAIRING_METHODS/, 'remote.js must derive its @Remote marks from the table')
})

test('the contribution carries one codec per declared parameter', () => {
  const client = read('lib/client.js')
  const block = client.slice(client.indexOf('const PAIRING_CONTRIBUTION'), client.indexOf('let pairingProxy'))
  for (const entry of PAIRING_METHODS) {
    const parameters = entry.parameters.map((parameter) => `param('${parameter.name}')`).join(', ')
    const expected = `parameters: [${parameters}]`
    assert.ok(block.includes(expected), `expected ${entry.method} to declare ${expected}`)
  }
})

test('the marks land in the protocol\'s documented storage format', () => {
  const remote = read('lib/remote.js')
  assert.ok(
    remote.includes("'@deepseek-ai/dsh-typert-protocol/remote-methods'"),
    'the marks must sit under the stable string key the protocol reads',
  )
  assert.match(remote, /version: 1/, 'the descriptor version the protocol accepts')
  assert.match(remote, /kind: 'direct'/, 'every method here is a direct invocation')
})

console.log(`\n${4 - failures}/4 typert tests passed`)
if (failures > 0) process.exitCode = 1
