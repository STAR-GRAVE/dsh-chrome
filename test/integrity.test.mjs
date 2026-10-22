#!/usr/bin/env node
/**
 * Static integrity checks that a running Harness would otherwise report as a
 * single opaque "entry did not activate" line.
 *
 * Every relative import must resolve, every manifest export must exist, and the
 * extension manifest must match the files on disk. These are the failures that
 * are cheap to catch here and slow to diagnose inside the profile.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** Every relative specifier in one file's import statements. */
function relativeImports(file) {
  const text = readFileSync(file, 'utf8')
  const specifiers = []
  for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"](\.[^'"]+)['"]/g)) {
    specifiers.push(match[1])
  }
  for (const match of text.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    specifiers.push(match[1])
  }
  return specifiers
}

const libFiles = readdirSync(join(root, 'lib')).filter((name) => name.endsWith('.js'))

await test('every relative import inside lib/ resolves', () => {
  const missing = []
  for (const name of libFiles) {
    const file = join(root, 'lib', name)
    for (const specifier of relativeImports(file)) {
      const target = resolve(dirname(file), specifier)
      if (!existsSync(target)) missing.push(`${name} → ${specifier}`)
    }
  }
  assert.deepEqual(missing, [], `unresolvable imports: ${missing.join(', ')}`)
})

await test('the manifest points only at files that exist', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const referenced = [manifest.main, ...Object.values(manifest.exports ?? {}), manifest.dsh?.bundle?.patch]
  const missing = referenced.filter(
    (entry) =>
      typeof entry === 'string' &&
      // A subpath export may be a glob (`./locale/*.json`); require at least one
      // matching file rather than a literal path.
      (entry.includes('*')
        ? readdirSync(dirname(join(root, entry))).filter((name) => name.endsWith(entry.slice(entry.lastIndexOf('.')))).length === 0
        : !existsSync(join(root, entry))),
  )
  assert.deepEqual(missing, [], `manifest references missing files: ${missing.join(', ')}`)
})

await test('the manifest declares the peers the Harness must route', () => {
  // The profile resolver only routes a bare import into the Harness runtime when
  // the importing package lists it under peerDependencies; forgetting one shows
  // up as ERR_MODULE_NOT_FOUND at activation.
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const bare = new Set()
  for (const name of libFiles) {
    const text = readFileSync(join(root, 'lib', name), 'utf8')
    for (const match of text.matchAll(/from\s+['"](@deepseek-ai\/[^'"]+|react|react-dom)['"]/g)) bare.add(match[1])
  }
  const declared = new Set(Object.keys(manifest.peerDependencies ?? {}))
  const undeclared = [...bare].filter((name) => !declared.has(name))
  assert.deepEqual(undeclared, [], `bare imports missing from peerDependencies: ${undeclared.join(', ')}`)
  assert.ok(manifest.engines?.dsh, 'engines.dsh must be declared so the compatibility gate has an explicit range')
})

await test('the extension manifest matches the files on disk', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'))
  assert.equal(manifest.manifest_version, 3)
  const referenced = [manifest.background?.service_worker, manifest.options_page, ...Object.values(manifest.icons ?? {})]
  const missing = referenced.filter((entry) => typeof entry === 'string' && !existsSync(join(root, 'extension', entry)))
  assert.deepEqual(missing, [])
  assert.ok(manifest.permissions.includes('scripting'))
  assert.ok(manifest.permissions.includes('alarms'), 'the watchdog alarm keeps the poll loop alive after eviction')
})

await test('the debugger permission exists only for the opt-in trusted path', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'))
  assert.ok(
    manifest.permissions.includes('debugger'),
    'the trusted path needs the debugger permission; without it no real input event can be produced',
  )
  // The permission must not be reachable without an explicit request: the worker
  // only touches it through trusted.js, and every entry point is a named op the
  // host sends deliberately.
  const worker = readFileSync(join(root, 'extension', 'sw.js'), 'utf8')
  assert.match(worker, /from '\.\/trusted\.js'/)
  const debuggerCalls = [...worker.matchAll(/chrome\.debugger\./g)]
  assert.ok(debuggerCalls.length >= 1, 'the worker must fold onDetach/onEvent into the trusted state')
  const trusted = readFileSync(join(root, 'extension', 'trusted.js'), 'utf8')
  assert.match(trusted, /async function ensureAttached/, 'attaching must go through one guarded helper')
  assert.match(trusted, /another debugger is already attached/iu, 'a stolen debugger slot must be explained')
  assert.match(trusted, /INFOBAR_SETTLE_MS/, 'the infobar reflow must be allowed to settle before measuring')
})

await test('the trusted path is opt-in on the model-facing surface', () => {
  const tools = readFileSync(join(root, 'lib', 'tools.js'), 'utf8')
  assert.match(tools, /trusted: \{/, 'chrome_act must expose a trusted parameter')
  assert.match(tools, /wantsTrusted = args\.trusted === true/, 'trusted must be an explicit true, never the default')
  assert.match(tools, /source: \{/, 'chrome_observe must let a caller choose the capture source')
})

await test('the injected payloads exist and carry the generated banner', () => {
  for (const name of ['injected-page.js', 'injected-tap.js']) {
    const text = readFileSync(join(root, 'extension', name), 'utf8')
    assert.match(text, /^\/\* GENERATED by scripts\/sync-extension\.mjs/, `${name} must be generated, not hand-edited`)
  }
})

await test('the extension never references a missing runtime file', () => {
  const sw = readFileSync(join(root, 'extension', 'sw.js'), 'utf8')
  const referenced = [...sw.matchAll(/files:\s*\[([^\]]+)\]/g)].flatMap((match) =>
    [...match[1].matchAll(/'([^']+)'/g)].map((inner) => inner[1]),
  )
  const missing = referenced.filter((name) => !existsSync(join(root, 'extension', name)))
  assert.deepEqual(missing, [], `sw.js references missing files: ${missing.join(', ')}`)
})

await test('locale metadata names the capability in both languages', () => {
  const en = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'))
  assert.ok(en.meta.title.length > 0 && en.meta.description.length > 40)
  assert.ok(zh.meta.title.length > 0 && zh.meta.description.length > 20)
  assert.notEqual(en.meta.title, zh.meta.title)
})

await test('the icon is a well-formed SVG inside the size limit', () => {
  const svg = readFileSync(join(root, 'icon.svg'))
  assert.ok(svg.length < 256 * 1024)
  const text = svg.toString('utf8')
  assert.match(text, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(text, /<\/svg>\s*$/)
})

console.log(`\n${failures === 0 ? 'all integrity checks passed' : `${failures} integrity check(s) failed`}`)
if (failures > 0) process.exitCode = 1
