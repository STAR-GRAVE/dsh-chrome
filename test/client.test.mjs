#!/usr/bin/env node
/**
 * Smoke test for the hand-written browser half (`lib/client.js`).
 *
 * That file is not a plain module: the shell's loader hands it a `factory` whose
 * only dependency is `require('react')`. So the test runs the bundle in a `vm`
 * sandbox with a fake React, grabs the factory, and renders each state by
 * feeding the hook queue. It catches what `node --check` cannot: a page
 * registered under the wrong panel id, a navigation row that would not select
 * that page, or a state that throws while rendering.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SOURCE = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

/**
 * A React stand-in: elements are plain objects, and `useState` pops its answer
 * from a queue so a test can render any state without running effects.
 * @param {unknown[]} queue - values returned by successive `useState` calls.
 */
function makeReact(queue) {
  return {
    createElement: (type, props, ...children) => {
      // React folds the children arguments into `props.children`; the helper
      // components here read it, so the stand-in has to behave the same way.
      const flat = children.flat(Infinity)
      const nextProps = { ...(props ?? {}) }
      if (flat.length === 1) nextProps.children = flat[0]
      else if (flat.length > 1) nextProps.children = flat
      return { type, props: nextProps, children: flat }
    },
    useState: (initial) => [queue.length > 0 ? queue.shift() : initial, () => {}],
    useEffect: () => {},
  }
}

/**
 * Load the bundle and materialize its module body.
 * @param {{ queue?: unknown[], language?: string }} [options] - rendering setup.
 */
function loadBundle({ queue = [], language = 'zh-CN' } = {}) {
  let registration = null
  const styleTags = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (entry) => {
          registration = entry
        },
      },
    },
    document: {
      head: { appendChild: (tag) => styleTags.push(tag) },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: '', setAttribute() {}, remove() {} }),
      body: { appendChild() {}, removeChild() {} },
      execCommand: () => true,
    },
    navigator: { language, clipboard: { writeText: async () => {} } },
    URL,
    crypto: { getRandomValues: (bytes) => bytes.fill(7) },
    btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    fetch: async () => {
      throw new Error('rendering must not touch the bridge')
    },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'lib/client.js' })
  assert.ok(registration !== null, 'the bundle must call __ModuleLoader__.load')

  const react = makeReact(queue)
  const require = (specifier) => {
    if (specifier === 'react') return react
    throw new Error(`unexpected require: ${specifier}`)
  }
  const module = registration.factory(require)

  const entries = []
  const ctx = {
    slots: {
      inject: (_name, register) => register(),
      register: (options, component) => {
        entries.push({ options, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)
  return { registration, module, entries, styleTags }
}

/** Every string in a rendered tree, in order. */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(textOf)
  return textOf(node.children)
}

/** Types of every element in a rendered tree. */
function typesOf(node) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(typesOf)
  return [node.type, ...typesOf(node.children)]
}

/**
 * Resolve function components the way React would.
 *
 * The fake `createElement` leaves components as element types; only expanding
 * them proves the helper components (row, action, header) actually render.
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, children: node.children.map(expand) }
}

/** Every element in a rendered tree, flattened. */
function elementsOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, out)
    return out
  }
  out.push(node)
  elementsOf(node.children, out)
  return out
}

/** Find the registration that answers a slot name. */
function entryOf(loaded, name) {
  const found = loaded.entries.filter((entry) => entry.options.name === name)
  assert.equal(found.length, 1, `expected exactly one "${name}" registration`)
  return found[0]
}

/** Render the page with a preset state. */
function render(options) {
  const loaded = loadBundle(options)
  const page = entryOf(loaded, 'main')
  const tree = expand(page.component({}))
  return { ...loaded, page, tree, text: textOf(tree), types: typesOf(tree) }
}

const tests = []
/** Register one named test and run them in order. */
function test(name, fn) {
  tests.push({ name, fn })
}

test('registers the page and the navigation row under the same panel id', () => {
  const zh = render()
  const page = entryOf(zh, 'main')
  const row = entryOf(zh, 'sidebar.panellist')
  assert.equal(typeof page.options.key, 'string')
  assert.ok(page.options.key.length > 0, 'a main entry is addressed by key')
  assert.equal(row.options.id, page.options.key, 'the row must select the page it names')
  assert.equal(typeof row.options.order, 'number')
  assert.equal(page.options.label(), 'Chrome 连接')
  assert.equal(row.options.label(), 'Chrome 连接')
  const en = render({ language: 'en-US' })
  assert.equal(entryOf(en, 'sidebar.panellist').options.label(), 'Chrome connection')
})

test('registers nothing besides the page and its row', () => {
  const loaded = loadBundle()
  assert.deepEqual(
    loaded.entries.map((entry) => entry.options.name).sort(),
    ['main', 'sidebar.panellist'],
    'an extra registration would put the page somewhere the navigation does not point at',
  )
})

test('injects its stylesheet once, tagged so the loader can reclaim it', () => {
  const loaded = loadBundle()
  assert.equal(loaded.styleTags.length, 1)
  assert.equal(loaded.styleTags[0].dataset.plugin, '@star-grave/dsh-chrome')
  assert.match(loaded.styleTags[0].textContent, /\.dc-input/)
})

test('draws the navigation glyph at the size the sidebar asks for', () => {
  const row = entryOf(loadBundle(), 'sidebar.panellist')
  const glyph = expand(row.component({ size: 16, active: true }))
  assert.equal(glyph.type, 'svg')
  assert.equal(glyph.props.width, 16)
  assert.equal(glyph.props.height, 16)
  assert.equal(glyph.props['aria-hidden'], 'true')
})

test('renders the loading state before the host answers', () => {
  const view = render({ queue: ['loading'] })
  assert.ok(view.text.includes('正在读取…'), view.text.join(' | '))
})

test('renders the unreachable state with a retry control', () => {
  const view = render({ queue: ['unreachable', null, '', '', null, false] })
  const joined = view.text.join(' | ')
  assert.ok(joined.includes('读不到主机端的状态'), joined)
  assert.ok(joined.includes('重试'), joined)
})

test('renders the live token, the port and the save controls', () => {
  const live = {
    endpoint: 'http://127.0.0.1:8731',
    token: 'K7of0shzK-04IDLMwxs-N0ZbuvPaffKS',
    connected: true,
    extensionVersion: '1.1.0',
    lastPollAt: '2026-10-22T06:56:55.363Z',
  }
  const view = render({ queue: ['ready', live, '8731', live.token, null, false] })
  const joined = view.text.join(' | ')
  assert.ok(joined.includes(live.token), 'the current token must be visible')
  assert.ok(joined.includes('端口'), 'the row must be labelled as a port')
  assert.ok(!joined.includes('http://127.0.0.1:8731'), 'the full URL must not be exposed')
  assert.ok(joined.includes('已连接'), joined)
  assert.ok(joined.includes('保存'), joined)
  const fields = elementsOf(view.tree).filter((node) => node.type === 'input')
  assert.equal(fields.length, 2, 'one field for the port, one for the token')
  assert.equal(fields[0].props.value, '8731', 'the port field must show the live port')
  assert.equal(fields[0].props.type, 'number')
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
console.log(`\n${tests.length - failures}/${tests.length} client tests passed`)
if (failures > 0) process.exitCode = 1
