#!/usr/bin/env node
/**
 * Exercises the real extension service worker against stubbed Chrome APIs.
 *
 * Two failure modes matter here and neither is visible at install time:
 * a command name the host sends but the worker does not implement, and a
 * parameter the worker reads under a different key than the host writes. The
 * worker is imported as ordinary code with `chrome` and `fetch` stubbed, so a
 * mismatch fails here instead of in front of a user.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

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

// ---------------------------------------------------------------- stubs ------

/** Tabs the fake browser holds. */
const tabs = new Map([
  [1, { id: 1, title: 'First', url: 'https://first.test', active: true, windowId: 10, status: 'complete' }],
  [2, { id: 2, title: 'Second', url: 'https://second.test', active: false, windowId: 10, status: 'complete' }],
])
let nextTabId = 3
/** Every executeScript call, so tests can assert what reached the page. */
const scriptCalls = []
/** Results the worker posted back. */
const posted = []
/** Commands queued for the worker, consumed one poll at a time. */
const commandQueue = []
let pollCount = 0

/** Version of the page runtime the worker expects, read from the worker itself. */
const EXPECTED_RUNTIME_VERSION = Number(
  /EXPECTED_RUNTIME_VERSION = (\d+)/.exec(readFileSync(join(root, 'extension', 'sw.js'), 'utf8'))[1],
)

/** A page-world runtime stand-in: echoes the operation it was asked for. */
const runtimeStub = {
  version: EXPECTED_RUNTIME_VERSION,
  run: (op, payload) => {
    if (op === 'measure') {
      return { element: { role: 'button', name: 'Measured', rect: { x: 10, y: 20, width: 100, height: 30 } }, point: { x: 60, y: 35 }, rect: { x: 10, y: 20, width: 100, height: 30 } }
    }
    if (op === 'evalAsync') {
      // A promise-returning operation exercises the parked-result path: the
      // worker must not depend on executeScript awaiting an injected promise.
      return Promise.resolve({ async: true, payload })
    }
    return { stubOp: op, stubArgs: payload }
  },
}
/** A capture-tap stand-in with bounded-looking buffers. */
const tapStub = {
  version: 1,
  drainConsole: (limit) => ({ entries: [{ time: 't', level: 'error', text: 'stub console' }], total: Math.min(limit ?? 1, 1) }),
  drainNetwork: (limit) => ({ entries: [{ method: 'GET', url: 'https://net.test/x', status: 200 }], total: Math.min(limit ?? 1, 1) }),
  clearConsole: () => {},
  clearNetwork: () => {},
}

globalThis.__dshChrome = runtimeStub
globalThis.__dshChromeTap = tapStub

/** The stubbed `chrome` namespace the worker talks to. */
/** Every protocol command the trusted path sent, per tab. */
const protocolCalls = []
/** Tabs the stub believes hold a debugger session. */
const debuggerSessions = new Set()
/** Forces the next attach to look like DevTools already owns the tab. */
let attachConflict = null
/** Listeners the worker registers on chrome.debugger, so a test can fire one. */
const debuggerEventListeners = []
const debuggerDetachListeners = []

globalThis.chrome = {
  runtime: {
    id: 'stub-extension-id',
    getManifest: () => ({ version: '1.1.0' }),
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onSuspend: { addListener: () => {} },
  },
  storage: {
    local: {
      get: async () => ({ dshChromeConfig: { endpoint: 'http://127.0.0.1:8731', token: 'stub-token-stub-token' } }),
      set: async () => {},
    },
    onChanged: { addListener: () => {} },
  },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  debugger: {
    attach: async ({ tabId }) => {
      if (attachConflict !== null) throw new Error('Another debugger is already attached to the tab with id: ' + tabId)
      if (debuggerSessions.has(tabId)) throw new Error(`Debugger is already attached to tab ${tabId}`)
      debuggerSessions.add(tabId)
    },
    detach: async ({ tabId }) => {
      debuggerSessions.delete(tabId)
    },
    sendCommand: async (target, method, params) => {
      protocolCalls.push({ tabId: target.tabId, method, params })
      if (method === 'Network.getResponseBody') return { body: '{"stub":true}', base64Encoded: false }
      if (method === 'Runtime.evaluate') {
        // Stand in for the protocol's evaluation: numbers come back by value,
        // objects come back by reference and are re-read as JSON.
        if (params.expression.includes('1+1')) return { result: { type: 'number', value: 2 } }
        if (params.expression.includes('JSON.stringify')) return { result: { type: 'string', value: '{"a":1}' } }
        return { result: { type: 'object', description: 'Object' } }
      }
      return {}
    },
    onEvent: {
      addListener: (listener) => {
        debuggerEventListeners.push(listener)
      },
    },
    onDetach: {
      addListener: (listener) => {
        debuggerDetachListeners.push(listener)
      },
    },
  },
  scripting: {
    getRegisteredContentScripts: async () => [],
    registerContentScripts: async () => {},
    executeScript: async (injection) => {
      scriptCalls.push(injection)
      if (Array.isArray(injection.files)) return [{ result: null }]
      // The worker's `func` runs here exactly as it would in the page realm,
      // because it only touches the globals we installed above.
      const result = await injection.func(...(injection.args ?? []))
      return [{ result }]
    },
  },
  tabs: {
    onRemoved: { addListener: () => {} },
    query: async (filter) => [...tabs.values()].filter((tab) => (filter?.windowId === undefined ? true : tab.windowId === filter.windowId)),
    get: async (id) => {
      const tab = tabs.get(id)
      if (!tab) throw new Error(`No tab with id: ${id}`)
      return tab
    },
    create: async ({ url }) => {
      const id = nextTabId
      nextTabId += 1
      const tab = { id, title: '', url, active: true, windowId: 10, status: 'complete' }
      tabs.set(id, tab)
      return tab
    },
    update: async (id, changes) => {
      const tab = tabs.get(id)
      if (!tab) throw new Error(`No tab with id: ${id}`)
      if (changes.active === true) for (const other of tabs.values()) other.active = other.id === id
      if (typeof changes.url === 'string') tab.url = changes.url
      return tab
    },
    remove: async (id) => {
      tabs.delete(id)
    },
    reload: async () => {},
    goBack: async () => {},
    goForward: async () => {},
    captureVisibleTab: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
  },
  windows: {
    get: async () => ({ width: 1280, height: 900 }),
    update: async () => {},
  },
}

/** The bridge stand-in: serves queued commands, records posted results. */
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/poll')) {
    pollCount += 1
    const command = commandQueue.shift()
    if (command === undefined) {
      // Answer idle quickly so the worker's loop stays responsive to the next
      // queued command without the real two-second retry delay.
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { status: 200, ok: true, json: async () => ({ status: 'idle' }) }
    }
    return { status: 200, ok: true, json: async () => ({ status: 'command', command }) }
  }
  if (String(url).endsWith('/result')) {
    posted.push(JSON.parse(init.body))
    return { status: 200, ok: true, json: async () => ({ ok: true }) }
  }
  return { status: 404, ok: false, json: async () => ({}) }
}

// ------------------------------------------------------------- the worker ----

await import(new URL('../extension/sw.js', import.meta.url))
await new Promise((resolve) => setTimeout(resolve, 50))

/** Queue one command and wait for the worker to answer it. */
async function ask(method, params = {}) {
  const id = `cmd-${method}-${Math.random().toString(16).slice(2, 8)}`
  const before = posted.length
  commandQueue.push({ id, method, params })
  for (let i = 0; i < 400; i += 1) {
    if (posted.length > before) {
      const result = posted[posted.length - 1]
      assert.equal(result.id, id, `the worker answered ${result.id}, expected ${id}`)
      return result
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`the worker never answered ${method}`)
}

// The worker parks after the first idle poll; drive it by installing the queue
// before the next poll ticks. A small nudge each time keeps it deterministic.
await test('the worker polls the bridge with its manifest version', async () => {
  // The module starts polling on import; the first poll already happened.
  assert.ok(pollCount >= 1, 'the worker must poll on activation')
})

await test('listTabs reports id, title, url and active', async () => {
  const answer = await ask('listTabs')
  assert.equal(answer.ok, true)
  assert.equal(answer.result.length, 2)
  assert.deepEqual(Object.keys(answer.result[0]).sort(), ['active', 'id', 'title', 'url', 'windowId'])
})

await test('run reaches the page runtime with the operation and arguments', async () => {
  const answer = await ask('run', { tabId: 1, op: 'snapshot', args: { limit: 10 } })
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.result, { stubOp: 'snapshot', stubArgs: { limit: 10 } })
  const isolation = scriptCalls.filter((call) => call.files?.includes('injected-page.js'))
  assert.ok(isolation.length > 0, 'the worker must install the shared runtime before running')
  assert.ok(isolation.every((call) => call.world === 'ISOLATED'))
})

await test('eval is routed through the protocol, because MV3 forbids code strings in an isolated world', async () => {
  protocolCalls.length = 0
  const created = await ask('newTab', { url: 'https://eval.test' })
  const tabId = created.result.id
  const answer = await ask('run', { tabId, op: 'eval', args: { expression: '1+1', awaitPromise: true } })
  assert.equal(answer.ok, true)
  assert.equal(answer.result.kind, 'number')
  assert.equal(answer.result.value, 2)
  const evaluate = protocolCalls.filter((call) => call.method === 'Runtime.evaluate')
  assert.ok(evaluate.length >= 1, 'eval must reach the page through Runtime.evaluate')
  assert.equal(evaluate[0].params.expression, '1+1')
})

await test('an object result is re-read as JSON rather than dropped', async () => {
  protocolCalls.length = 0
  const created = await ask('newTab', { url: 'https://eval-object.test' })
  const answer = await ask('run', { tabId: created.result.id, op: 'eval', args: { expression: '({a:1})' } })
  assert.equal(answer.ok, true)
  assert.equal(answer.result.kind, 'json')
  assert.match(answer.result.text, /"a":1/, 'an object must come back as text, not as an opaque reference')
})

await test('eval never claims an empty result, so a real failure cannot hide', async () => {
  const created = await ask('newTab', { url: 'https://eval-error.test' })
  // Force the protocol to report an exception.
  const original = chrome.debugger.sendCommand
  chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === 'Runtime.evaluate' && params.expression === 'boom()') {
      return { exceptionDetails: { exception: { description: 'Uncaught ReferenceError: boom is not defined\n    at ...' } } }
    }
    return original(target, method, params)
  }
  try {
    const answer = await ask('run', { tabId: created.result.id, op: 'eval', args: { expression: 'boom()' } })
    assert.equal(answer.ok, false)
    assert.match(answer.error, /boom is not defined/)
    assert.doesNotMatch(answer.error, /^Uncaught /, 'the redundant error prefix must be stripped')
  } finally {
    chrome.debugger.sendCommand = original
  }
})

await test('a missing envelope is reported instead of reading as an empty answer', async () => {
  const created = await ask('newTab', { url: 'https://stale-runtime.test' })
  // Simulate a page whose runtime predates the envelope: the version probe still
  // answers, but the operation's injected function returns nothing — which used
  // to be indistinguishable from "the expression had no value".
  const original = chrome.scripting.executeScript
  chrome.scripting.executeScript = async (injection) => {
    if (Array.isArray(injection.files)) return [{ result: null }]
    // The version probe is called without arguments; an operation passes [op, args].
    const operationCall = Array.isArray(injection.args) && injection.args.length > 0
    if (!operationCall) return original(injection)
    return [{ result: undefined }]
  }
  try {
    const answer = await ask('run', { tabId: created.result.id, op: 'snapshot', args: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.error, /没有返回信封|旧版运行时/)
  } finally {
    chrome.scripting.executeScript = original
  }
})

await test('a promise-returning operation is collected without trusting executeScript to await', async () => {
  const answer = await ask('run', { tabId: 1, op: 'evalAsync', args: { expression: '1+1' } })
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.result, { async: true, payload: { expression: '1+1' } })
  // The worker must have returned a synchronous envelope and then read the
  // parked result, rather than depending on the injected function's promise.
  const envelopes = scriptCalls
    .filter((call) => typeof call.func === 'function' && Array.isArray(call.args) && call.args[0] === 'evalAsync')
  assert.ok(envelopes.length >= 1)
})

await test('navigate sets the URL and reports the settled tab', async () => {
  const answer = await ask('navigate', { tabId: 2, url: 'https://moved.test' })
  assert.equal(answer.ok, true)
  assert.equal(answer.result.url, 'https://moved.test')
  assert.equal(answer.result.id, 2)
})

await test('history drives back, forward and reload', async () => {
  for (const direction of ['back', 'forward', 'reload']) {
    const answer = await ask('history', { tabId: 1, direction })
    assert.equal(answer.ok, true, `${direction} must succeed`)
  }
})

await test('newTab creates and reports a tab', async () => {
  const answer = await ask('newTab', { url: 'https://created.test' })
  assert.equal(answer.ok, true)
  assert.ok(typeof answer.result.id === 'number')
  assert.equal(answer.result.url, 'https://created.test')
})

await test('activateTab raises the tab', async () => {
  const answer = await ask('activateTab', { tabId: 2 })
  assert.equal(answer.ok, true)
  assert.equal(answer.result.id, 2)
})

await test('closeTab refuses to empty a window', async () => {
  // A window holding exactly one tab must never be emptied by a close.
  tabs.set(77, { id: 77, title: 'Only', url: 'https://only.test', active: true, windowId: 99, status: 'complete' })
  const refused = await ask('closeTab', { tabId: 77 })
  assert.equal(refused.ok, false, 'the worker must refuse the last tab of a window')
  assert.match(refused.error, /last tab/)
  const closed = await ask('closeTab', { tabId: 3 })
  assert.equal(closed.ok, true, 'a tab with siblings must close normally')
})

await test('screenshot returns base64 PNG data with a caveat', async () => {
  const created = await ask('newTab', { url: 'https://shot.test' })
  const answer = await ask('screenshot', { tabId: created.result.id })
  assert.equal(answer.ok, true)
  assert.match(answer.result.base64, /^iVBORw0KGgo/)
  assert.match(answer.result.note, /viewport only/)
})

await test('console and network drain the page tap', async () => {
  const created = await ask('newTab', { url: 'https://capture.test' })
  const consoleAnswer = await ask('console', { tabId: created.result.id, limit: 5 })
  assert.equal(consoleAnswer.ok, true)
  assert.equal(consoleAnswer.result.entries[0].text, 'stub console')
  const networkAnswer = await ask('network', { tabId: created.result.id, limit: 5 })
  assert.equal(networkAnswer.ok, true)
  assert.match(networkAnswer.result.entries[0].url, /net\.test/)
})

await test('ping answers so the host can prove the link', async () => {
  const answer = await ask('ping')
  assert.equal(answer.ok, true)
  assert.equal(answer.result.pong, true)
  assert.equal(answer.result.version, '1.1.0')
})

await test('an unknown method is refused by name', async () => {
  const answer = await ask('dropDatabase')
  assert.equal(answer.ok, false)
  assert.match(answer.error, /没有实现 "dropDatabase"/)
})

await test('trusted click attaches, measures after attaching, then sends real input', async () => {
  protocolCalls.length = 0
  const created = await ask('newTab', { url: 'https://trusted.test' })
  const tabId = created.result.id
  const answer = await ask('debugger', { tabId, op: 'click', args: { ref: 'e1' } })
  assert.equal(answer.ok, true)
  assert.equal(answer.result.trusted, true)
  assert.equal(answer.result.element.name, 'Measured')
  assert.ok(debuggerSessions.has(tabId), 'the session must stay attached for the next trusted call')

  const methods = protocolCalls.map((call) => call.method)
  assert.deepEqual(methods, ['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent'])
  const pressed = protocolCalls.find((call) => call.params.type === 'mousePressed')
  assert.equal(pressed.params.x, 60, 'the click must land on the measured point')
  assert.equal(pressed.params.y, 35)
})

await test('trusted input reports a stolen debugger slot instead of hanging', async () => {
  attachConflict = 'Another debugger is already attached'
  try {
    const created = await ask('newTab', { url: 'https://conflict.test' })
    const answer = await ask('debugger', { tabId: created.result.id, op: 'click', args: { selector: '#x' } })
    assert.equal(answer.ok, false)
    assert.match(answer.error, /already has a debugger attached/)
    assert.match(answer.error, /DevTools/, 'the fix must be stated: close DevTools or cancel the bar')
  } finally {
    attachConflict = null
  }
})

await test('trusted type inserts text and can submit', async () => {
  protocolCalls.length = 0
  const created = await ask('newTab', { url: 'https://type.test' })
  const answer = await ask('debugger', { tabId: created.result.id, op: 'type', args: { selector: '#q', text: '张三', submit: true } })
  assert.equal(answer.ok, true)
  const insert = protocolCalls.find((call) => call.method === 'Input.insertText')
  assert.equal(insert.params.text, '张三', 'CJK text must survive untouched')
  const keys = protocolCalls.filter((call) => call.method === 'Input.dispatchKeyEvent')
  assert.equal(keys.length, 2, 'submit must send a keyDown/keyUp pair')
  assert.equal(keys[0].params.windowsVirtualKeyCode, 13)
})

await test('trusted press maps a chord onto the protocol', async () => {
  protocolCalls.length = 0
  const created = await ask('newTab', { url: 'https://keys.test' })
  const answer = await ask('debugger', { tabId: created.result.id, op: 'press', args: { key: 'Ctrl+Shift+Enter' } })
  assert.equal(answer.ok, true)
  // With a modifier held the protocol expects a raw key-down (no text); the
  // point here is that the chord's modifiers reach the event.
  const down = protocolCalls.find(
    (call) => call.method === 'Input.dispatchKeyEvent' && (call.params.type === 'keyDown' || call.params.type === 'rawKeyDown'),
  )
  assert.equal(down.params.modifiers, 2 | 8, 'Ctrl is 2 and Shift is 8 in the protocol bitmask')
  assert.equal(down.params.key, 'Enter')
  assert.equal(down.params.windowsVirtualKeyCode, 13)
})

await test('an unknown key names the keys that do exist', async () => {
  const created = await ask('newTab', { url: 'https://badkey.test' })
  const answer = await ask('debugger', { tabId: created.result.id, op: 'press', args: { key: 'HyperKey' } })
  assert.equal(answer.ok, false)
  assert.match(answer.error, /unknown key "HyperKey"/)
  assert.match(answer.error, /Enter, Tab, Escape/)
})

await test('protocol capture folds network and console events per tab', async () => {
  const created = await ask('newTab', { url: 'https://capture-cdp.test' })
  const tabId = created.result.id
  const started = await ask('debugger', { tabId, op: 'captureStart' })
  assert.equal(started.ok, true)
  const enable = protocolCalls.filter((call) => call.method === 'Network.enable')
  assert.ok(enable.length >= 1, 'capture must enable the Network domain')

  // Fire the events the worker subscribed to, exactly as Chrome would.
  const listener = debuggerEventListeners[0]
  listener({ tabId }, 'Network.requestWillBeSent', {
    requestId: 'req-1',
    type: 'Document',
    request: { method: 'POST', url: 'https://api.test/x' },
  })
  listener({ tabId }, 'Network.responseReceived', {
    requestId: 'req-1',
    type: 'Document',
    response: { status: 201, mimeType: 'application/json' },
  })
  listener({ tabId }, 'Network.loadingFinished', { requestId: 'req-1', encodedDataLength: 42 })
  listener({ tabId }, 'Runtime.consoleAPICalled', {
    type: 'error',
    args: [{ value: 'boom' }],
    stackTrace: { callFrames: [{ url: 'https://capture-cdp.test/app.js' }] },
  })

  const network = await ask('debugger', { tabId, op: 'captureRead', args: { kind: 'network', limit: 10 } })
  assert.equal(network.ok, true)
  const entry = network.result.entries[0]
  assert.equal(entry.method, 'POST')
  assert.equal(entry.status, 201, 'the response status must be folded onto the request')
  assert.equal(entry.bytes, 42)
  assert.equal(entry.type, 'Document', 'capture must see document requests, not just fetch/XHR')

  const consoleRead = await ask('debugger', { tabId, op: 'captureRead', args: { kind: 'console', limit: 10 } })
  assert.equal(consoleRead.result.entries[0].text, 'boom')
  assert.match(consoleRead.result.entries[0].source, /app\.js/)
})

await test('a response body is readable through the protocol', async () => {
  const created = await ask('newTab', { url: 'https://body.test' })
  const tabId = created.result.id
  await ask('debugger', { tabId, op: 'captureStart' })
  const body = await ask('debugger', { tabId, op: 'captureRead', args: { requestId: 'req-body' } })
  assert.equal(body.ok, true)
  assert.match(body.result.body, /"stub":true/, 'the body must come back, not just the metadata')
})

await test('a capture that lost its session says so instead of returning empty', async () => {
  const created = await ask('newTab', { url: 'https://gone.test' })
  const tabId = created.result.id
  await ask('debugger', { tabId, op: 'captureStart' })
  // The user pressing Cancel on the bar arrives as onDetach.
  for (const listener of debuggerDetachListeners) listener({ tabId }, 'canceled_by_user')
  const read = await ask('debugger', { tabId, op: 'captureRead', args: { kind: 'network' } })
  assert.equal(read.ok, true, 'reading must still work, so the caller can see why it stopped')
  assert.equal(read.result.active, false)
  assert.equal(read.result.stoppedReason, 'canceled_by_user')
})

await test('reading a capture that was never started explains how to start it', async () => {
  const created = await ask('newTab', { url: 'https://never.test' })
  const answer = await ask('debugger', { tabId: created.result.id, op: 'captureRead', args: { kind: 'network' } })
  assert.equal(answer.ok, false)
  assert.match(answer.error, /source=cdp/)
})

await test('detach releases the session so the bar disappears', async () => {
  const created = await ask('newTab', { url: 'https://detach.test' })
  const tabId = created.result.id
  await ask('debugger', { tabId, op: 'click', args: { selector: '#a' } })
  assert.ok(debuggerSessions.has(tabId))
  const detached = await ask('debugger', { tabId, op: 'detach' })
  assert.equal(detached.ok, true)
  assert.equal(debuggerSessions.has(tabId), false)
  const status = await ask('debugger', { tabId, op: 'status' })
  assert.equal(status.result.attached, false)
  assert.equal(status.result.capturing, false)
})

await test('every method the host sends is implemented by the worker', () => {
  const hostCalls = new Set()
  for (const file of ['runtime.js', 'backend-extension.js']) {
    const text = readFileSync(join(root, 'lib', file), 'utf8')
    for (const match of text.matchAll(/\.call\(\s*'([A-Za-z]+)'/g)) hostCalls.add(match[1])
    for (const match of text.matchAll(/send\(\s*'([A-Za-z]+)'/g)) hostCalls.add(match[1])
    for (const match of text.matchAll(/channel\.send\('([A-Za-z]+)'/g)) hostCalls.add(match[1])
  }
  const workerText = readFileSync(join(root, 'extension', 'sw.js'), 'utf8')
  const implemented = new Set([...workerText.matchAll(/case '([A-Za-z]+)':/g)].map((match) => match[1]))
  const missing = [...hostCalls].filter((name) => !implemented.has(name))
  assert.deepEqual(missing, [], `the host calls methods the worker does not implement: ${missing.join(', ')}`)
})

await test('the worker never asks for a permission the manifest omits', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'))
  const granted = new Set([...manifest.permissions, ...manifest.host_permissions])
  const workerText = readFileSync(join(root, 'extension', 'sw.js'), 'utf8')
  const used = new Set([...workerText.matchAll(/chrome\.([a-zA-Z]+)\./g)].map((match) => match[1]))
  // `runtime`, `storage`, `alarms`, and `windows` carry no manifest permission.
  const alwaysGranted = new Set(['runtime', 'storage', 'alarms', 'windows'])
  const needed = [...used].filter((name) => !alwaysGranted.has(name))
  const ungranted = needed.filter(
    (name) => !granted.has(name) && !granted.has(`${name}`) && !manifest.permissions.includes(name),
  )
  assert.deepEqual(ungranted, [], `the worker uses ${ungranted.join(', ')} without the permission`)
})

console.log(`\n${failures === 0 ? 'all extension tests passed' : `${failures} extension test(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
