#!/usr/bin/env node
/**
 * Protocol test for the extension bridge, with no Chrome and no DSH involved.
 *
 * A simulated extension long-polls a real HTTP listener, so this covers the
 * parts that are impossible to debug once an agent is in the loop: token
 * rejection, one-command-in-flight ordering, timeout settlement, and
 * cancellation of an in-flight tool call.
 */

import assert from 'node:assert/strict'
import { ChromeBridge, createPairingToken } from '../lib/bridge.js'

const TOKEN = createPairingToken()

/** Start a bridge on an ephemeral port. */
async function startBridge(options = {}) {
  const bridge = new ChromeBridge({
    token: TOKEN,
    port: 0,
    holdMs: 400,
    log: () => {},
    ...options,
  })
  await bridge.start()
  return bridge
}

/** One poll request against a bridge. */
async function poll(bridge, token = TOKEN, body = {}) {
  const response = await fetch(`${bridge.endpoint}/poll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-chrome-token': token },
    body: JSON.stringify({ version: 'test', ...body }),
  })
  return { status: response.status, body: await response.json() }
}

/** Post one command result. */
async function postResult(bridge, id, payload, token = TOKEN) {
  const response = await fetch(`${bridge.endpoint}/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-chrome-token': token },
    body: JSON.stringify({ id, version: 'test', ...payload }),
  })
  return response.status
}

/** Assert one rejection, and that the message explains the fix. */
async function expectRejection(promise, pattern) {
  try {
    await promise
  } catch (error) {
    assert.match(error.message, pattern, `expected ${pattern}, got: ${error.message}`)
    return error
  }
  assert.fail(`expected a rejection matching ${pattern}`)
}

const tests = []
/** Register one named test and run them in order. */
function test(name, fn) {
  tests.push({ name, fn })
}

test('rejects a bad pairing token on poll and result', async () => {
  const bridge = await startBridge()
  try {
    const bad = await poll(bridge, 'x'.repeat(TOKEN.length))
    assert.equal(bad.status, 401)
    assert.match(bad.body.error, /配对令牌/)
    const short = await poll(bridge, 'short')
    assert.equal(short.status, 401, 'a token of the wrong length must not throw, only fail')
    assert.equal(await postResult(bridge, 'anything', { ok: true }, 'wrong'), 401)
  } finally {
    await bridge.dispose()
  }
})

test('reports idle when nothing is queued, and connects on first poll', async () => {
  const bridge = await startBridge()
  try {
    assert.equal(bridge.connected, false, 'a fresh bridge has no extension')
    const first = await poll(bridge)
    assert.equal(first.status, 200)
    assert.equal(first.body.status, 'idle')
    assert.equal(bridge.connected, true)
    assert.equal(bridge.status.extensionVersion, 'test')
  } finally {
    await bridge.dispose()
  }
})

test('delivers one command and resolves it with the extension reply', async () => {
  const bridge = await startBridge()
  try {
    await poll(bridge)
    const pending = bridge.call('snapshot', { tabId: 7 }, { timeoutMs: 5000 })
    const delivery = await poll(bridge)
    assert.equal(delivery.body.status, 'command')
    assert.equal(delivery.body.command.method, 'snapshot')
    assert.deepEqual(delivery.body.command.params, { tabId: 7 })
    await postResult(bridge, delivery.body.command.id, { ok: true, result: { lines: ['e1 button'] } })
    assert.deepEqual(await pending, { lines: ['e1 button'] })
  } finally {
    await bridge.dispose()
  }
})

test('wakes a held poll as soon as work arrives', async () => {
  const bridge = await startBridge({ holdMs: 10_000 })
  try {
    await poll(bridge)
    const held = poll(bridge)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const started = Date.now()
    const pending = bridge.call('listTabs', {}, { timeoutMs: 8000 })
    const delivery = await held
    const elapsed = Date.now() - started
    assert.equal(delivery.body.status, 'command', 'the held poll must return the new command')
    assert.ok(elapsed < 2000, `a held poll should wake promptly, took ${elapsed}ms`)
    await postResult(bridge, delivery.body.command.id, { ok: true, result: [] })
    assert.deepEqual(await pending, [])
  } finally {
    await bridge.dispose()
  }
})

test('keeps one command in flight so replies cannot cross', async () => {
  const bridge = await startBridge()
  try {
    await poll(bridge)
    const first = bridge.call('first', {}, { timeoutMs: 5000 })
    const firstDelivery = await poll(bridge)
    const second = bridge.call('second', {}, { timeoutMs: 5000 })
    const secondDelivery = await poll(bridge)
    assert.equal(secondDelivery.body.status, 'idle', 'a second command must wait until the first settles')
    await postResult(bridge, firstDelivery.body.command.id, { ok: true, result: 'one' })
    assert.equal(await first, 'one')
    const thirdDelivery = await poll(bridge)
    assert.equal(thirdDelivery.body.command.method, 'second')
    await postResult(bridge, thirdDelivery.body.command.id, { ok: true, result: 'two' })
    assert.equal(await second, 'two')
  } finally {
    await bridge.dispose()
  }
})

test('surfaces an extension-reported failure', async () => {
  const bridge = await startBridge()
  try {
    await poll(bridge)
    const pending = bridge.call('run', {}, { timeoutMs: 5000 })
    const expectation = expectRejection(pending, /chrome:\/\/ pages cannot be scripted/)
    const delivery = await poll(bridge)
    await postResult(bridge, delivery.body.command.id, { ok: false, error: 'chrome:// pages cannot be scripted' })
    await expectation
  } finally {
    await bridge.dispose()
  }
})

test('times out a command the extension never answers', async () => {
  const bridge = await startBridge()
  try {
    await poll(bridge)
    const pending = bridge.call('slow', {}, { timeoutMs: 300 })
    const expectation = expectRejection(pending, /没有回答 slow|did not answer slow|300ms/)
    await poll(bridge)
    await expectation
    assert.equal(bridge.status.inFlight, null, 'a timed-out command must not stay in flight')
  } finally {
    await bridge.dispose()
  }
})

test('fails fast when no extension ever polls', async () => {
  const bridge = await startBridge()
  try {
    await expectRejection(bridge.call('snapshot', {}, { timeoutMs: 500 }), /扩展还没连上/)
  } finally {
    await bridge.dispose()
  }
})

test('honours cancellation of an in-flight call', async () => {
  const bridge = await startBridge()
  try {
    await poll(bridge)
    const controller = new AbortController()
    const pending = bridge.call('hover', {}, { timeoutMs: 8000, signal: controller.signal })
    const expectation = expectRejection(pending, /取消/)
    const delivery = await poll(bridge)
    assert.equal(delivery.body.status, 'command')
    controller.abort()
    await expectation
    assert.equal(bridge.status.inFlight, null, 'an aborted call must not keep the slot')
  } finally {
    await bridge.dispose()
  }
})

test('rejects a pre-aborted call without queueing it', async () => {
  const bridge = await startBridge()
  try {
    await poll(bridge)
    const controller = new AbortController()
    controller.abort()
    const expectation = expectRejection(bridge.call('click', {}, { signal: controller.signal }), /到达 Chrome 之前就被取消/)
    await expectation
    assert.equal(bridge.status.queued, 0)
  } finally {
    await bridge.dispose()
  }
})

test('shuts down cleanly, failing anything still waiting', async () => {
  const bridge = await startBridge()
  await poll(bridge)
  const pending = bridge.call('pending', {}, { timeoutMs: 8000 })
  const expectation = expectRejection(pending, /扩展桥.*关闭了/)
  await poll(bridge)
  await bridge.dispose()
  await expectation
  await expectRejection(bridge.call('after', {}, { timeoutMs: 500 }), /关闭/)
})

test('a taken port fails loudly instead of drifting', async () => {
  // One port, chosen by the user: if it is busy the start must say so, because
  // nothing else is going to guess where the bridge went.
  const first = await startBridge()
  const second = new ChromeBridge({ token: TOKEN, port: first.port, holdMs: 200, log: () => {} })
  try {
    await assert.rejects(() => second.start(), /已被占用/)
    assert.equal(second.listening, false, 'a failed start must not claim to be listening')
  } finally {
    await first.dispose()
  }
})

test('answers /health without a token but reports connection state', async () => {
  const bridge = await startBridge()
  try {
    const before = await fetch(`${bridge.endpoint}/health`).then((response) => response.json())
    assert.equal(before.ok, true)
    assert.equal(before.connected, false)
    await poll(bridge)
    const after = await fetch(`${bridge.endpoint}/health`).then((response) => response.json())
    assert.equal(after.connected, true)
  } finally {
    await bridge.dispose()
  }
})

test('ignores a result whose id does not match the command in flight', async () => {
  const bridge = await startBridge()
  try {
    await poll(bridge)
    const pending = bridge.call('click', {}, { timeoutMs: 3000 })
    const delivery = await poll(bridge)
    await postResult(bridge, 'not-the-command-id', { ok: true, result: 'wrong reply' })
    assert.equal(bridge.status.inFlight, 'click', 'a mismatched id must not settle the command')
    await postResult(bridge, delivery.body.command.id, { ok: true, result: 'right reply' })
    assert.equal(await pending, 'right reply')
  } finally {
    await bridge.dispose()
  }
})

let failures = 0

for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}\n     ${error.message}`)
  }
}
console.log(`\n${tests.length - failures}/${tests.length} bridge tests passed`)
if (failures > 0) process.exitCode = 1
