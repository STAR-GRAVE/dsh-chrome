#!/usr/bin/env node
/**
 * Regression tests for the runtime lifecycle, driven through the real
 * `ChromeRuntime` against a real headless Chrome.
 *
 * These cover the defects an end-to-end run surfaced: a `close` that reported
 * success without stopping the browser, a `close` that took the extension bridge
 * down with it, a status page that reported configuration instead of liveness,
 * and tab labels that survived a relaunch.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChromeRuntime } from '../lib/runtime.js'
import { resolveChromePath } from '../lib/chrome.js'

let failures = 0
/** Run one named test. */
async function test(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}\n     ${error.message}`)
  }
}

/** Whether a pid is still alive, without signalling it. */
function alive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Wait until a predicate holds, bounded. */
async function eventually(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const home = await mkdtemp(join(tmpdir(), 'dsh-chrome-life-'))
const profile = join(home, 'profile')
const { path: chromePath } = resolveChromePath({})

const runtime = new ChromeRuntime({
  config: {
    backend: 'auto',
    bridgeHost: '127.0.0.1',
    bridgePort: 0,
    headless: true,
    chromePath,
    userDataDir: profile,
    viewportWidth: 1024,
    viewportHeight: 768,
    defaultTimeoutMs: 15000,
    maxSnapshotElements: 300,
    maxOutputChars: 6000,
    maxBufferedEvents: 200,
    captureConsole: true,
    captureNetwork: true,
    extensionPath: join(home, 'extension'),
  },
  homeDir: home,
  log: () => {},
})

let firstPid = null
try {
  await test('the bridge starts and reports a real endpoint', async () => {
    const { endpoint, token } = await runtime.start()
    assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.ok(token.length >= 32)
    assert.equal(runtime.status.bridgeListening, true)
    assert.equal(runtime.pairing.endpoint, endpoint)
  })

  await test('status reports no browser before anything is launched', () => {
    const status = runtime.status
    assert.equal(status.cdpAvailable, false)
    assert.equal(status.cdp.endpoint, null)
    assert.equal(status.cdp.managed, false)
    assert.equal(status.cdp.pid, null)
  })

  await test('launch starts a real browser and status reports it live', async () => {
    const launched = await runtime.launch({ timeoutMs: 30_000 })
    assert.match(launched.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(launched.managed, true)
    firstPid = launched.pid
    assert.ok(alive(firstPid), `launched pid ${firstPid} should be alive`)
    const status = runtime.status
    assert.equal(status.cdpAvailable, true)
    assert.equal(status.cdp.endpoint, launched.endpoint)
    assert.equal(status.cdp.pid, firstPid)
  })

  await test('tab labels start at t1 for a fresh browser', async () => {
    const listed = await runtime.listTabs('cdp')
    assert.equal(listed.kind, 'cdp')
    assert.ok(listed.tabs.length >= 1)
    assert.equal(listed.tabs[0].label, 't1')
  })

  await test('the viewport matches the configured size exactly', async () => {
    const target = await runtime.selectTab('cdp')
    const viewport = await runtime.run(target, 'eval', { expression: '({w: innerWidth, h: innerHeight})' })
    const size = JSON.parse(viewport.text)
    assert.equal(size.w, 1024, `innerWidth should be the configured 1024, got ${size.w}`)
    assert.equal(size.h, 768, `innerHeight should be the configured 768, got ${size.h}`)
  })

  await test('the page runtime can measure an element for trusted input', async () => {
    // The trusted path depends on this exact operation, so prove the runtime half
    // works independently of the extension's plumbing.
    const target = await runtime.selectTab('cdp')
    await runtime.run(target, 'eval', {
      expression:
        "(function(){var b=document.createElement('button');b.id='probe';b.textContent='Probe';b.style.cssText='position:absolute;top:40px;left:60px;width:120px;height:40px';document.body.appendChild(b);return 'ok'})()",
    })
    const measured = await runtime.run(target, 'measure', { selector: '#probe' })
    assert.ok(measured, 'measure must return a result')
    assert.equal(measured.element.tag, 'button')
    assert.ok(
      typeof measured.point?.x === 'number' && typeof measured.point?.y === 'number',
      'measure must report a click point',
    )
    assert.ok(measured.point.x > 60 && measured.point.x < 200, `the point must land inside the element, got ${measured.point.x}`)
    assert.ok(measured.rect.width >= 120)
  })

  await test('measure accepts a ref as well as a selector', async () => {
    const target = await runtime.selectTab('cdp')
    const snapshot = await runtime.run(target, 'snapshot', {})
    const line = snapshot.lines.find((entry) => entry.includes('"Probe"'))
    assert.ok(line, 'the probe button must appear in the snapshot')
    const ref = line.split(' ')[0]
    const measured = await runtime.run(target, 'measure', { ref })
    assert.equal(measured.element.ref, ref)
  })

  await test('a screenshot reports real pixel dimensions', async () => {
    const target = await runtime.selectTab('cdp')
    const shot = await runtime.screenshot(target, {})
    assert.ok(shot.base64.length > 100)
    assert.ok(shot.width > 0 && shot.height > 0, `expected real dimensions, got ${shot.width}x${shot.height}`)
    assert.equal(shot.width, 1024, 'the screenshot must match the pinned viewport width')
    assert.equal(shot.height, 768, 'the screenshot must match the pinned viewport height')
    const bytes = Buffer.from(shot.base64, 'base64')
    assert.equal(bytes.readUInt32BE(16), shot.width, 'the reported width must match the PNG header')
    assert.equal(bytes.readUInt32BE(20), shot.height)
  })

  await test('a Chrome internal page is refused instead of reading as empty', async () => {
    const target = await runtime.selectTab('cdp')
    await runtime.navigate(target, 'chrome://settings/')
    await assert.rejects(
      runtime.run(target, 'snapshot', {}),
      /无法检查 chrome:\/\/settings/,
      'a WebUI page must explain that it cannot be inspected',
    )
  })

  await test('close stops the browser it started and says so truthfully', async () => {
    const closed = await runtime.closeBrowser({ timeoutMs: 10_000 })
    assert.equal(closed.pid, firstPid)
    assert.ok(await eventually(() => !alive(firstPid)), `pid ${firstPid} must exit`)
    const status = runtime.status
    assert.equal(status.cdpAvailable, false)
    assert.equal(status.cdp.managed, false)
    assert.equal(status.cdp.endpoint, null, 'a closed browser must not report an endpoint')
    assert.equal(status.cdp.pages, 0)
  })

  await test('close leaves the extension bridge listening', () => {
    const status = runtime.status
    assert.equal(status.bridgeListening, true, 'closing a browser must not take the bridge down')
    assert.match(runtime.pairing.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/)
  })

  await test('close is idempotent once nothing is running', async () => {
    const again = await runtime.closeBrowser()
    assert.equal(again.managed, false)
    assert.equal(runtime.status.bridgeListening, true)
  })

  await test('a second launch works and gets fresh t1 labels', async () => {
    const launched = await runtime.launch({ timeoutMs: 30_000 })
    assert.equal(launched.managed, true)
    assert.notEqual(launched.pid, firstPid, 'a relaunch must be a new process')
    assert.ok(alive(launched.pid))
    const listed = await runtime.listTabs('cdp')
    assert.equal(listed.tabs[0].label, 't1', 'labels must restart, so t3 does not point at a stranger')
    const closed = await runtime.closeBrowser({ timeoutMs: 10_000 })
    assert.equal(closed.pid, launched.pid)
    assert.ok(await eventually(() => !alive(launched.pid)), `pid ${launched.pid} must exit after the second close`)
  })

  await test('auto selection reports the real reason when nothing is connected', () => {
    assert.throws(() => runtime.select('auto'), /没有可用的 Chrome 通路/)
  })
} finally {
  await runtime.dispose()
  await rm(home, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${failures === 0 ? 'all lifecycle tests passed' : `${failures} lifecycle test(s) failed`}`)
if (failures > 0) process.exitCode = 1
