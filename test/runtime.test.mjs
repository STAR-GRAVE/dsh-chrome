#!/usr/bin/env node
/**
 * End-to-end test of the page runtime in a real headless Chrome.
 *
 * The runtime is the shared contract between both transports, so this drives it
 * the way the CDP backend does — real `Runtime.evaluate` in a real isolated
 * world — over a page built to exercise the awkward cases: invisible controls,
 * covered elements, checkboxes, selects, contenteditable, and console output.
 *
 * It also asserts the extension's generated copies still match their sources,
 * which is the drift check that keeps both backends identical.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CdpConnection, readVersion } from '../lib/cdp.js'
import { ManagedChrome, resolveChromePath } from '../lib/chrome.js'
import { PAGE_RUNTIME_SOURCE } from '../lib/page-script.js'
import { TAP_SOURCE } from '../lib/tap-script.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** The page under test, with deliberately tricky structure. */
const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Runtime Fixture</title></head>
<body style="margin:0;font:14px sans-serif">
  <h1 id="heading">Harness chrome runtime</h1>
  <button id="add" onclick="document.getElementById('count').textContent=String(Number(document.getElementById('count').textContent)+1)">Add one</button>
  <span id="count">0</span>
  <button id="hidden" style="display:none">Should not appear</button>
  <button id="offscreen" style="position:absolute;left:-9999px">Also invisible</button>
  <div style="position:relative;margin-top:8px">
    <button id="covered" style="width:160px;height:34px">Covered button</button>
    <div id="overlay" style="position:absolute;top:0;left:0;width:160px;height:34px;background:rgba(0,0,0,.1)"></div>
  </div>
  <label for="name">Full name</label>
  <input id="name" placeholder="type here">
  <textarea id="notes"></textarea>
  <input id="agree" type="checkbox" aria-label="I agree">
  <select id="pick" aria-label="Pick a fruit">
    <option value="a">Apple</option>
    <option value="b">Banana</option>
    <option value="c">Cherry</option>
  </select>
  <div id="editable" contenteditable="true" role="textbox" aria-label="Rich text" style="border:1px solid #ccc;min-height:24px"></div>
  <button id="submit-button">Submit form</button>
  <div style="height:2000px">tall page</div>
</body></html>`

let failures = 0
/** Run one named assertion group. */
async function test(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}\n     ${error.message}`)
  }
}

const results = []
// ---- source/copy drift: both transports must see the same runtime ----
await test('the extension copies match their sources byte for byte', async () => {
  const page = readFileSync(join(root, 'extension', 'injected-page.js'), 'utf8')
  const tap = readFileSync(join(root, 'extension', 'injected-tap.js'), 'utf8')
  assert.ok(page.includes(PAGE_RUNTIME_SOURCE), 'extension/injected-page.js drifted from lib/page-script.js; run node scripts/sync-extension.mjs')
  assert.ok(tap.includes(TAP_SOURCE), 'extension/injected-tap.js drifted from lib/tap-script.js; run node scripts/sync-extension.mjs')
})

await test('the page runtime source is inert in a non-browser realm', async () => {
  // A syntax error here would surface only as a blank page at runtime.
  assert.doesNotThrow(() => new Function(PAGE_RUNTIME_SOURCE), 'the runtime must parse as plain JavaScript')
  assert.doesNotThrow(() => new Function(TAP_SOURCE), 'the tap must parse as plain JavaScript')
  assert.ok(!PAGE_RUNTIME_SOURCE.includes('${'), 'the runtime must not contain template interpolation')
})

const { path: executable } = resolveChromePath({})
const profileDir = await mkdtemp(join(tmpdir(), 'dsh-chrome-runtime-'))
const managed = new ManagedChrome({ log: () => {} })
let connection = null
let sessionId = null
let contextId = null

/** Install the runtime and run one operation, exactly as the CDP backend does. */
async function run(op, args = {}) {
  const expression = `(function(){var r=globalThis.__dshChrome;if(!r)throw new Error('runtime missing');return r.run(${JSON.stringify(op)},${JSON.stringify(args)})})()`
  const reply = await connection.send(
    'Runtime.evaluate',
    { expression, contextId, awaitPromise: true, returnByValue: true },
    { sessionId, timeoutMs: 15000 },
  )
  if (reply.exceptionDetails) {
    throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text)
  }
  return reply.result?.value
}

/** Run an arbitrary expression in the isolated world. */
async function evaluate(expression) {
  const reply = await connection.send(
    'Runtime.evaluate',
    { expression, contextId, awaitPromise: true, returnByValue: true },
    { sessionId, timeoutMs: 15000 },
  )
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text)
  return reply.result?.value
}

try {
  const { endpoint } = await managed.launch({
    executable,
    userDataDir: profileDir,
    headless: true,
    viewport: '1000x800',
    readyTimeoutMs: 25_000,
  })
  const version = await readVersion(endpoint)
  connection = await CdpConnection.open(version.ws)
  const created = await connection.createPage('about:blank')
  sessionId = created.sessionId
  await connection.send('Page.enable', {}, { sessionId })
  await connection.send('Runtime.enable', {}, { sessionId })

  // Load the fixture through a data: URL so no network is involved. The
  // isolated world must be created after the navigation: navigating destroys it.
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(FIXTURE)}`
  const navigation = await connection.send('Page.navigate', { url }, { sessionId })
  assert.ok(!navigation.errorText, `fixture navigation failed: ${navigation.errorText}`)
  for (let i = 0; i < 100; i += 1) {
    const state = await connection
      .send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, { sessionId })
      .then((reply) => reply.result?.value)
      .catch(() => null)
    if (state === 'complete') break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const { frameTree } = await connection.send('Page.getFrameTree', {}, { sessionId })
  const world = await connection.send(
    'Page.createIsolatedWorld',
    { frameId: frameTree.frame.id, worldName: 'dsh-chrome' },
    { sessionId },
  )
  contextId = world.executionContextId
  await connection.send('Runtime.evaluate', { expression: PAGE_RUNTIME_SOURCE, contextId }, { sessionId })

  await test('installs an idempotent runtime global', async () => {
    // Read the version the source declares instead of pinning a literal, so a
    // version bump does not have to be mirrored into this assertion.
    const declared = Number(/version:\s*(\d+),/.exec(PAGE_RUNTIME_SOURCE)[1])
    const first = await evaluate('globalThis.__dshChrome.version')
    assert.equal(first, declared)
    await connection.send('Runtime.evaluate', { expression: PAGE_RUNTIME_SOURCE, contextId }, { sessionId })
    const second = await evaluate('globalThis.__dshChrome.version')
    assert.equal(second, declared, 'reinstalling must not reset the ref table')
  })

  let snapshot = null
  await test('snapshot lists visible interactive elements with stable refs', async () => {
    snapshot = await run('snapshot', { limit: 300 })
    assert.equal(snapshot.title, 'Runtime Fixture')
    assert.ok(snapshot.lines.length >= 7, `expected the fixture controls, got ${snapshot.lines.length}`)
    const joined = snapshot.lines.join('\n')
    assert.match(joined, /button "Add one"/)
    assert.match(joined, /textbox/)
    assert.match(joined, /checkbox "I agree"/)
    assert.match(joined, /combobox "Pick a fruit"/)
    assert.doesNotMatch(joined, /Should not appear/, 'a display:none button must be filtered out')
    assert.doesNotMatch(joined, /Also invisible/, 'an off-screen button must be filtered out')
    assert.ok(snapshot.elementCount >= 7)
    assert.ok(snapshot.viewport.width > 0)
  })

  await test('refs are unique and re-resolve to the same element', async () => {
    const refs = snapshot.lines.map((line) => line.split(' ')[0])
    assert.equal(new Set(refs).size, refs.length, 'refs must be unique')
    const described = await run('describe', { ref: refs[0] })
    assert.equal(described.ref, refs[0])
    assert.equal(described.tag, 'button')
  })

  await test('clicking by ref changes the page', async () => {
    const addLine = snapshot.lines.find((line) => line.includes('"Add one"'))
    assert.ok(addLine, 'the Add one button must be in the snapshot')
    const ref = addLine.split(' ')[0]
    const outcome = await run('click', { ref })
    assert.equal(outcome.element.role, 'button')
    const count = await evaluate("document.getElementById('count').textContent")
    assert.equal(count, '1', 'an onclick handler must run on a synthesized click')
    const again = await run('click', { ref })
    assert.ok(again.element)
    assert.equal(await evaluate("document.getElementById('count').textContent"), '2')
  })

  await test('reports when the clicked point is covered by another element', async () => {
    const covered = snapshot.lines.find((line) => line.includes('"Covered button"'))
    assert.ok(covered, 'the covered button must be in the snapshot')
    const outcome = await run('click', { ref: covered.split(' ')[0] })
    assert.equal(outcome.covered, true, 'an overlay over the point must be reported')
    assert.ok(outcome.hitTarget, 'the covering element must be described')
  })

  await test('typing sets the value a framework would read back', async () => {
    const line = snapshot.lines.find((entry) => entry.includes('"Full name"'))
    assert.ok(line, 'the <label for> must name the input')
    const outcome = await run('type', { ref: line.split(' ')[0], text: 'Zhang San' })
    assert.equal(outcome.value, 'Zhang San')
    assert.equal(await evaluate("document.getElementById('name').value"), 'Zhang San')
  })

  await test('typing into contenteditable uses text content', async () => {
    const outcome = await run('type', { selector: '#editable', text: 'rich text 中文' })
    assert.equal(outcome.value, 'rich text 中文')
  })

  await test('checkbox, select, and press work by selector', async () => {
    const checked = await run('check', { selector: '#agree' })
    assert.equal(checked.checked, true)
    assert.equal(await evaluate("document.getElementById('agree').checked"), true)
    const unchecked = await run('uncheck', { selector: '#agree' })
    assert.equal(unchecked.checked, false)
    const picked = await run('selectOption', { selector: '#pick', option: 'Cherry' })
    assert.equal(picked.value, 'c')
    const byValue = await run('selectOption', { selector: '#pick', option: 'b' })
    assert.equal(byValue.value, 'b')
    await assert.rejects(run('selectOption', { selector: '#pick', option: 'Durian' }), /可用的 value/)
  })

  await test('scroll reports position and clamps at the end', async () => {
    const scrolled = await run('scroll', { deltaY: 500 })
    assert.ok(scrolled.scrollY > 0, 'the page must scroll')
    assert.ok(scrolled.maxScrollY > 0, 'the fixture is taller than the viewport')
    const bottom = await run('scroll', { deltaY: 100000 })
    assert.ok(bottom.scrollY <= bottom.maxScrollY + 1, 'scrollY must not exceed maxScrollY')
  })

  await test('text and html read the document', async () => {
    const text = await run('text', {})
    assert.match(text, /Harness chrome runtime/)
    const html = await run('html', { selector: '#heading' })
    assert.match(html, /<h1 id="heading">/)
  })

  await test('eval serializes values without losing JSON safety', async () => {
    const number = await run('eval', { expression: '1 + 1' })
    assert.equal(number.kind, 'number')
    assert.equal(number.value, 2, 'a number survives as a number')
    const object = await run('eval', { expression: '({a:1,b:"two"})' })
    assert.equal(object.kind, 'json')
    assert.match(object.text, /"a": 1/)
    const fn = await run('eval', { expression: '(function named(){})' })
    assert.equal(fn.kind, 'function')
    const element = await run('eval', { expression: 'document.getElementById("heading")' })
    assert.equal(element.kind, 'element')
    const undefinedValue = await run('eval', { expression: 'undefined' })
    assert.equal(undefinedValue.kind, 'undefined')
    const big = await run('eval', { expression: '9007199254740993n' })
    assert.equal(big.kind, 'bigint')
    const circular = await run('eval', { expression: '(function(){var o={};o.self=o;return o})()' })
    assert.equal(circular.kind, 'object', 'an unserializable value must degrade, not throw')
  })

  await test('a stale ref fails with a re-snapshot instruction', async () => {
    const first = await run('snapshot', {})
    const firstRef = first.lines[0].split(' ')[0]
    await run('snapshot', {})
    await assert.rejects(run('click', { ref: firstRef }), /已过期|没有匹配到|重新执行 chrome_observe action=snapshot/i)
  })

  await test('waitCheck answers each mode', async () => {
    assert.equal((await run('waitCheck', { mode: 'selector', value: '#heading' })).matched, true)
    assert.equal((await run('waitCheck', { mode: 'selector', value: '#nope' })).matched, false)
    assert.equal((await run('waitCheck', { mode: 'text', value: 'Harness chrome runtime' })).matched, true)
    assert.equal((await run('waitCheck', { mode: 'text', value: 'absent phrase' })).matched, false)
    assert.equal((await run('waitCheck', { mode: 'url', value: 'data:text/html' })).matched, true)
    assert.equal((await run('waitCheck', { mode: 'load' })).matched, true)
  })

  await test('an unknown operation is refused rather than silently ignored', async () => {
    await assert.rejects(run('dropDatabase', {}), /未知的页面操作/)
  })

  await test('the capture tap records console and network activity', async () => {
    await connection.send('Runtime.evaluate', { expression: TAP_SOURCE, contextId }, { sessionId })
    await connection.send(
      'Runtime.evaluate',
      {
        expression: `(function(){
          console.error('tap check', {a:1});
          return fetch('data:application/json,{"ok":true}').then(function(r){return r.text()}).then(function(){return 'done'});
        })()`,
        contextId,
        awaitPromise: true,
        returnByValue: true,
      },
      { sessionId },
    ).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 300))
    const drained = await evaluate('JSON.stringify(globalThis.__dshChromeTap.drainConsole(20))')
    const parsed = JSON.parse(drained)
    assert.ok(parsed.entries.some((entry) => entry.level === 'error' && entry.text.includes('tap check')), 'console.error must be captured')
    const network = JSON.parse(await evaluate('JSON.stringify(globalThis.__dshChromeTap.drainNetwork(20))'))
    assert.ok(network.entries.some((entry) => String(entry.url).includes('data:application/json')), 'fetch must be captured')
  })

  await test('the tap keeps bounded buffers', async () => {
    await evaluate('(function(){for(var i=0;i<600;i+=1)console.log("noise", i);return 1})()')
    const drained = JSON.parse(await evaluate('JSON.stringify(globalThis.__dshChromeTap.drainConsole(1))'))
    assert.ok(drained.total <= 400, `the ring must stay bounded, saw ${drained.total}`)
  })

  results.push('runtime suite complete')
} finally {
  connection?.close()
  await managed.dispose()
  await rm(profileDir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${results.length > 0 ? '' : ''}${failures === 0 ? 'all runtime tests passed' : `${failures} runtime test(s) failed`}`)
if (failures > 0) process.exitCode = 1
