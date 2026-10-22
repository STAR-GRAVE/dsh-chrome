#!/usr/bin/env node
/**
 * Regression test for the pairing page's recovery path.
 *
 * The page exists so that a bridge which could not bind its port can be fixed
 * from the UI. That only works when the token and the attempted port survive a
 * failed start and `pairingSetPort` can bring the listener up afterwards. Both
 * halves used to be missing: the state reported `null` for everything and the
 * setters threw whenever the bridge was absent, which is exactly when a user
 * needs them.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChromeRuntime } from '../lib/runtime.js'

let failures = 0

/** Run one named assertion group. */
async function test(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error.message}`)
  }
}

/** Occupy a port so a bind there fails, and hand back its number. */
async function occupy() {
  const server = createServer((socket) => socket.destroy())
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    release: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Ask the OS for a port nothing is listening on, then give it back. */
async function freePort() {
  const server = createServer((socket) => socket.destroy())
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** A runtime wired the way `apply` wires it, without a browser. */
function makeRuntime(homeDir, bridgePort) {
  return new ChromeRuntime({
    config: {
      bridgeHost: '127.0.0.1',
      bridgePort,
      extensionPath: join(homeDir, 'extension'),
    },
    homeDir,
    log: () => {},
  })
}

/** Fresh data directory per case. */
async function withRuntime(bridgePort, fn) {
  const homeDir = await mkdtemp(join(tmpdir(), 'dsh-chrome-pairing-'))
  const runtime = makeRuntime(homeDir, bridgePort)
  try {
    await fn(runtime, homeDir)
  } finally {
    await runtime.dispose()
    await rm(homeDir, { recursive: true, force: true })
  }
}

await test('a start that cannot bind still reports the token, the port, and why', async () => {
  const busy = await occupy()
  try {
    await withRuntime(busy.port, async (runtime, homeDir) => {
      await assert.rejects(runtime.start())
      const state = runtime.pairingState()
      assert.equal(state.listening, false, 'nothing is listening')
      assert.equal(state.port, busy.port, 'the attempted port is still shown')
      assert.match(String(state.token), /^\S{16,}$/, 'the token is readable without a bridge')
      assert.match(String(state.error), /占用/, 'the failure names the reason')
      assert.equal(state.extensionPath, join(homeDir, 'extension'), 'the folder to load is reported too')
    })
  } finally {
    await busy.release()
  }
})

await test('choosing the port again brings a bridge that never started back up', async () => {
  const busy = await occupy()
  try {
    await withRuntime(busy.port, async (runtime) => {
      await assert.rejects(runtime.start())
      // The user frees the port, then presses 应用 without restarting DSH.
      await busy.release()
      const outcome = await runtime.pairingSetPort(busy.port)
      assert.equal(outcome.listening, true, 'the bridge came up')
      assert.equal(outcome.port, busy.port, 'on the chosen port')
      assert.equal(runtime.pairingState().listening, true)
      assert.equal(runtime.pairingState().error, null)
    })
  } finally {
    await busy.release()
  }
})

await test('a port that is still taken is reported, not thrown', async () => {
  const busy = await occupy()
  try {
    await withRuntime(busy.port, async (runtime) => {
      await assert.rejects(runtime.start())
      const outcome = await runtime.pairingSetPort(busy.port)
      assert.equal(outcome.listening, false, 'the page can show the failure')
      assert.match(String(outcome.error), /占用/, 'and it says why')
      assert.equal(runtime.pairingState().port, busy.port)
    })
  } finally {
    await busy.release()
  }
})

await test('the token can be replaced while the bridge is down', async () => {
  const busy = await occupy()
  try {
    await withRuntime(busy.port, async (runtime, homeDir) => {
      await assert.rejects(runtime.start())
      const next = 'a'.repeat(40)
      const outcome = await runtime.pairingSetToken(next)
      assert.equal(outcome.token, next)
      assert.equal(outcome.applied, false, 'nothing is live to apply it to')
      assert.equal(runtime.pairingState().token, next, 'but the page still reads it')
      const onDisk = (await readFile(join(homeDir, 'pairing-token'), 'utf8')).trim()
      assert.equal(onDisk, next, 'and the next start will use it')
    })
  } finally {
    await busy.release()
  }
})

await test('a token the bridge would refuse is refused here too', async () => {
  await withRuntime(8731, async (runtime) => {
    await assert.rejects(runtime.pairingSetToken('short'), /16/)
    await assert.rejects(runtime.pairingSetToken('has space in it and is long'), /空白/)
  })
})

await test('a port outside 1-65535 is refused before anything is written', async () => {
  const busy = await occupy()
  try {
    await withRuntime(busy.port, async (runtime) => {
      await assert.rejects(runtime.start())
      await assert.rejects(runtime.pairingSetPort(70000), /65535/)
      assert.equal(runtime.pairingState().port, busy.port, 'the attempted port is unchanged')
    })
  } finally {
    await busy.release()
  }
})

await test('a live bridge moves to the chosen port and stops answering on the old one', async () => {
  await withRuntime(0, async (runtime, homeDir) => {
    await runtime.start()
    const before = runtime.pairingState()
    assert.equal(before.listening, true, 'the ephemeral port bound')

    const target = await freePort()
    const outcome = await runtime.pairingSetPort(target)
    assert.equal(outcome.listening, true)
    assert.equal(outcome.port, target)
    assert.equal(runtime.pairingState().port, target)

    const health = await fetch(`http://127.0.0.1:${target}/health`).then((response) => response.json())
    assert.equal(health.app, 'dsh-chrome', 'the new port answers')
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${before.port}/health`),
      /fetch failed|ECONNREFUSED|other side closed/,
      'the old port is released',
    )
    assert.equal((await readFile(join(homeDir, 'bridge-port'), 'utf8')).trim(), String(target))
  })
})

if (failures > 0) {
  console.log(`\n${failures} pairing test(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall pairing tests passed')
}
