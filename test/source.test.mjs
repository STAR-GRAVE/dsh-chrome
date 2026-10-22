#!/usr/bin/env node
/**
 * Guard the two injected source strings against the failure modes that only
 * appear after they reach a browser.
 *
 * `String.raw` templates cannot contain a backtick or `${`, because either one
 * ends the literal early — and the resulting file still looks like valid source
 * to a reader. The strings must also parse as plain JavaScript, since a browser
 * evaluates them as text in another realm where a syntax error surfaces only as
 * a blank page.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PAGE_RUNTIME_SOURCE, REF_ATTR, RUNTIME_GLOBAL } from '../lib/page-script.js'
import { TAP_GLOBAL, TAP_SOURCE } from '../lib/tap-script.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

let failures = 0
/** Run one named check. */
function test(name, fn) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}\n     ${error.message}`)
  }
}

for (const { label, source, globalName } of [
  { label: 'page runtime', source: PAGE_RUNTIME_SOURCE, globalName: RUNTIME_GLOBAL },
  { label: 'capture tap', source: TAP_SOURCE, globalName: TAP_GLOBAL },
]) {
  await test(`${label} source parses as plain JavaScript`, () => {
    assert.doesNotThrow(() => new Function(source))
  })

  await test(`${label} source carries no template interpolation`, () => {
    assert.ok(!source.includes('${'), 'a `${` sequence would have ended the raw template early')
  })

  await test(`${label} source installs exactly one namespaced global`, () => {
    assert.ok(source.includes(globalName), `expected ${globalName} to be installed`)
    const assignments = [...source.matchAll(/globalThis\[GLOBAL\]\s*=/g)]
    assert.equal(assignments.length, 1, 'the global must be assigned once, behind an idempotence guard')
    assert.match(source, /if \(globalThis\[GLOBAL\]/, 're-installation must be a no-op')
  })
}

await test('the runtime names its ref attribute unambiguously', () => {
  assert.ok(PAGE_RUNTIME_SOURCE.includes(REF_ATTR))
  assert.match(PAGE_RUNTIME_SOURCE, /data-dsh-ref/, 'the attribute must be a namespaced data attribute')
})

await test('the runtime refuses Chrome internal pages instead of reporting an empty page', () => {
  assert.match(PAGE_RUNTIME_SOURCE, /assertInspectable\(\)/)
  assert.match(PAGE_RUNTIME_SOURCE, /chrome-untrusted:/)
})

await test('a stale ref and an unknown ref are reported differently', () => {
  assert.match(PAGE_RUNTIME_SOURCE, /未知编号/)
  assert.match(PAGE_RUNTIME_SOURCE, /已过期/)
})

await test('the runtime derives text-entry setters from its own realm', () => {
  assert.match(PAGE_RUNTIME_SOURCE, /globalThis\.HTMLInputElement\.prototype/)
  assert.ok(!PAGE_RUNTIME_SOURCE.includes('ownerDocument.defaultView.Event'), 'another world\'s constructors throw on dispatch')
})

await test('the runtime version is one number that the worker also knows', () => {
  // The version is the only thing that makes a refreshed extension replace an
  // already-injected runtime, so the two declarations must never drift apart.
  const declared = /version:\s*(\d+),/.exec(PAGE_RUNTIME_SOURCE)
  assert.ok(declared, 'the runtime must declare a numeric version')
  const guard = /version === (\d+)\) return/.exec(PAGE_RUNTIME_SOURCE)
  assert.ok(guard, 'the idempotence guard must compare that same version')
  assert.equal(guard[1], declared[1], 'the install guard and the declared version must agree, or an update is skipped')

  const worker = readFileSync(join(root, 'extension', 'sw.js'), 'utf8')
  const expected = /EXPECTED_RUNTIME_VERSION = (\d+)/.exec(worker)
  assert.ok(expected, 'the worker must declare the version it expects')
  assert.equal(
    expected[1],
    declared[1],
    'the worker expects a different runtime version than lib/page-script.js declares; an updated extension would keep injecting stale code',
  )
})

await test('the extension re-registers content scripts when the runtime version changes', () => {
  const worker = readFileSync(join(root, 'extension', 'sw.js'), 'utf8')
  assert.match(worker, /RUNTIME_STAMP_KEY/, 'registrations must record which version built them')
  assert.match(worker, /unregisterContentScripts/, 'a stale registration must be replaced, never skipped')
})

await test('eval cannot rely on code strings in an isolated world', () => {
  // MV3's CSP forbids `new Function` in a content-script world, so the worker
  // routes eval through the debugger while the shared runtime keeps the string
  // path for the CDP transport. Either half missing means eval silently dies.
  assert.match(PAGE_RUNTIME_SOURCE, /new globalThis\.Function/)
  const worker = readFileSync(join(root, 'extension', 'sw.js'), 'utf8')
  assert.match(worker, /if \(op === 'eval'\)/, 'the worker must special-case eval')
  assert.match(worker, /runtimeEvaluate/, 'eval must go through the protocol')
  const trusted = readFileSync(join(root, 'extension', 'trusted.js'), 'utf8')
  assert.match(trusted, /export async function runtimeEvaluate/)
})

await test('a missing envelope is an error, not an empty answer', () => {
  const worker = readFileSync(join(root, 'extension', 'sw.js'), 'utf8')
  assert.match(worker, /没有返回信封/, 'an undefined injection result must be reported, not read as "no value"')
})

await test('every operation the caller can ask for is actually registered', () => {
  // A handler function that exists but was never wired into HANDLERS fails at
  // runtime as "未知的页面操作" — which is exactly how `measure` broke trusted
  // input while the rest of the surface kept working.
  const worker = readFileSync(join(root, 'extension', 'sw.js'), 'utf8')
  const trusted = readFileSync(join(root, 'extension', 'trusted.js'), 'utf8')
  const tools = readFileSync(join(root, 'lib', 'tools.js'), 'utf8')

  const wanted = new Set()
  // Operations the worker dispatches to the page runtime.
  for (const match of worker.matchAll(/runPageOperation\([^,]+,\s*'([A-Za-z]+)'/g)) wanted.add(match[1])
  // Operations the trusted path asks the page runtime for.
  for (const match of trusted.matchAll(/page\([^,]+,\s*'([A-Za-z]+)'/g)) wanted.add(match[1])
  // Operations the tools ask the transport for.
  for (const match of tools.matchAll(/runtime\.run\([^,]+,\s*'([A-Za-z]+)'/g)) wanted.add(match[1])
  assert.ok(wanted.size >= 8, `expected to collect the operation names, got ${[...wanted].join(', ')}`)

  const registered = new Set(
    [...PAGE_RUNTIME_SOURCE.matchAll(/^\s{4}([A-Za-z]+):\s*function/gm)].map((match) => match[1]),
  )
  const missing = [...wanted].filter((op) => !registered.has(op))
  assert.deepEqual(missing, [], `these operations are called but not registered in HANDLERS: ${missing.join(', ')}`)
})

console.log(`\n${failures === 0 ? 'all injected-source checks passed' : `${failures} injected-source check(s) failed`}`)
if (failures > 0) process.exitCode = 1
