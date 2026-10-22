#!/usr/bin/env node
/**
 * Unit tests for the transport-independent layer: tab labelling, backend
 * selection, and output formatting.
 *
 * These run with no Chrome and no DSH, so a regression here shows up before an
 * agent ever sees a confusing tool result.
 */

import assert from 'node:assert/strict'

import { TabRegistry } from '../lib/tabs.js'
import { ChromeBridge, createPairingToken } from '../lib/bridge.js'
import { ChromeRuntime } from '../lib/runtime.js'
import {
  PAGE_CONTENT_NOTICE,
  bound,
  boundLines,
  formatAction,
  formatConsole,
  formatEvaluation,
  formatNetwork,
  formatSnapshot,
  formatTabList,
} from '../lib/format.js'

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

await test('tab labels survive a re-listing and disappear with the tab', async () => {
  const registry = new TabRegistry()
  const first = registry.sync([
    { id: 'a', title: 'A', url: 'https://a.test', active: true },
    { id: 'b', title: 'B', url: 'https://b.test' },
  ])
  assert.deepEqual(first.map((tab) => tab.label), ['t1', 't2'])
  const second = registry.sync([
    { id: 'b', title: 'B2', url: 'https://b2.test', active: true },
    { id: 'c', title: 'C', url: 'https://c.test' },
  ])
  assert.equal(second.find((tab) => tab.id === 'b').label, 't2', 'a surviving tab keeps its label')
  assert.equal(second.find((tab) => tab.id === 'c').label, 't3', 'a new tab gets the next free label')
})

await test('an unknown tab label names the tabs that do exist', async () => {
  const registry = new TabRegistry()
  const tabs = registry.sync([{ id: 'a', title: 'A', url: 'https://a.test', active: true }])
  assert.throws(() => registry.resolve('t99', tabs), /可选的是：t1/)
})

await test('resolve falls back to the frontmost tab and binds it', async () => {
  const registry = new TabRegistry()
  const tabs = registry.sync([
    { id: 'a', title: 'A', url: 'https://a.test' },
    { id: 'b', title: 'B', url: 'https://b.test', active: true },
  ])
  assert.equal(registry.resolve(undefined, tabs), 'b')
  assert.equal(registry.bound, 'b', 'resolving must bind so later calls are stable')
  assert.equal(registry.resolve('t1', tabs), 'a')
})

await test('resolve refuses when no tab exists at all', async () => {
  const registry = new TabRegistry()
  assert.throws(() => registry.resolve(undefined, []), /没有可用的 Chrome 标签页/)
})

await test('auto selection prefers the extension and names the fallback', async () => {
  const runtime = new ChromeRuntime({
    config: { backend: 'auto', bridgeHost: '127.0.0.1', bridgePort: 0, extensionPath: 'x' },
    homeDir: 'unused',
    log: () => {},
  })
  assert.throws(
    () => runtime.select('auto'),
    /没有可用的 Chrome 通路/,
    'with nothing connected, auto must explain both options',
  )
  const launched = runtime.select('auto', { forLaunch: true })
  assert.equal(launched.kind, 'cdp')
  assert.equal(launched.fallback, true, 'auto must mark a launch-time CDP pick as a fallback')
})

await test('an explicit extension selection explains how to pair', async () => {
  const runtime = new ChromeRuntime({
    config: { backend: 'extension', bridgeHost: '127.0.0.1', bridgePort: 0, extensionPath: 'C:/x/extension' },
    homeDir: 'unused',
    log: () => {},
  })
  assert.throws(() => runtime.select('extension'), /chrome:\/\/extensions/)
  assert.throws(() => runtime.select('extension'), /加载已解压的扩展程序/)
})

await test('an explicit cdp selection before connecting explains the launch step', async () => {
  const runtime = new ChromeRuntime({
    config: { backend: 'cdp', bridgeHost: '127.0.0.1', bridgePort: 0 },
    homeDir: 'unused',
    log: () => {},
  })
  assert.throws(() => runtime.select('cdp'), /chrome_status action=launch/)
})

await test('every page-derived output carries the untrusted-content notice', async () => {
  const snapshot = formatSnapshot({ url: 'https://x.test', title: 'T', scrollY: 0, maxScrollY: 0, viewport: { width: 1, height: 1 }, elementCount: 1, truncated: false, frameCount: 0, lines: ['e1 button "Go"'] })
  assert.ok(snapshot.startsWith(PAGE_CONTENT_NOTICE))
  const consoleText = formatConsole([{ time: 't', level: 'error', text: 'boom' }], 1)
  assert.ok(consoleText.startsWith(PAGE_CONTENT_NOTICE))
  const network = formatNetwork([{ method: 'GET', url: 'https://x', status: 200 }], 1)
  assert.ok(network.startsWith(PAGE_CONTENT_NOTICE))
})

await test('the snapshot header flags iframes and truncation', async () => {
  const text = formatSnapshot(
    { url: 'https://x.test', title: '', scrollY: 100, maxScrollY: 900, viewport: { width: 800, height: 600 }, elementCount: 12, truncated: true, frameCount: 2, lines: ['e1 link "a"'] },
    't3',
  )
  assert.match(text, /标签页 t3/)
  assert.match(text, /（无标题）/)
  assert.match(text, /滚动：100 \/ 900/)
  assert.match(text, /按 limit 截断了列表/)
  assert.match(text, /2 个 iframe/)
})

await test('an empty snapshot suggests the text action', async () => {
  const text = formatSnapshot({ url: 'https://x.test', title: 'T', scrollY: 0, maxScrollY: 0, viewport: { width: 1, height: 1 }, elementCount: 0, truncated: false, frameCount: 0, lines: [] })
  assert.match(text, /action=text/)
})

await test('tab listing marks the bound tab and the frontmost one', async () => {
  const text = formatTabList(
    [
      { label: 't1', title: 'One', url: 'https://1.test', active: false },
      { label: 't2', title: 'Two', url: 'https://2.test', active: true },
    ],
    't1',
  )
  assert.match(text, /\* t1/)
  assert.match(text, /t2 .*（最前）/)
})

await test('the legend appears only when something is actually bound', async () => {
  const tabs = [{ label: 't1', title: 'One', url: 'https://1.test', active: true }]
  assert.match(formatTabList(tabs, 't1'), /\* 为当前绑定目标/)
  assert.doesNotMatch(formatTabList(tabs, null), /当前绑定目标/, '没有绑定时不该出现这行图例')
  assert.doesNotMatch(formatTabList(tabs, null), /^\* /m)
})

await test('an implicit press names where the key actually went', async () => {
  const text = formatAction('press', {
    key: 'Enter',
    modifiers: [],
    implicitTarget: true,
    target: { role: 'textbox', name: 'Search', rect: { x: 0, y: 0, width: 1, height: 1 } },
    targetTag: 'input',
  })
  assert.match(text, /按键 Enter 已发给当前焦点元素（textbox "Search"）/)
  assert.match(text, /要指定目标请传 ref 或 selector/)

  const explicit = formatAction('press', { key: 'Tab', modifiers: [], implicitTarget: false, targetTag: 'body' })
  assert.match(explicit, /已发送按键 Tab/)
  assert.doesNotMatch(explicit, /当前焦点元素/)
})

await test('an action reports a covering element as a warning', async () => {
  const text = formatAction('click', {
    element: { role: 'button', name: 'Go', rect: { x: 1, y: 2, width: 3, height: 4 }, disabled: false },
    covered: true,
    hitTarget: { role: 'div', name: 'Overlay' },
  })
  assert.match(text, /click button "Go"/)
  assert.match(text, /警告：该坐标被 div "Overlay" 遮住/)
})

await test('action output reports the new value, checked state, and scroll position', async () => {
  assert.match(formatAction('type', { element: { role: 'textbox', name: 'q', rect: { x: 0, y: 0, width: 1, height: 1 } }, value: 'hello' }), /值现在是 "hello"/)
  assert.match(formatAction('check', { element: { role: 'checkbox', name: 'c', rect: { x: 0, y: 0, width: 1, height: 1 } }, checked: true }), /勾选状态现在是 true/)
  assert.match(formatAction('scroll', { scrollY: 400, maxScrollY: 1200 }), /scrollY 现在是 400 \/ 1200/)
  assert.match(formatAction('press', { key: 'Enter', modifiers: ['Ctrl'] }), /已发送按键 Ctrl\+Enter/)
})

await test('evaluation output distinguishes each serialized kind', () => {
  assert.match(formatEvaluation({ kind: 'undefined' }), /undefined/)
  assert.match(formatEvaluation({ kind: 'null' }), /null/)
  assert.match(formatEvaluation({ kind: 'number', value: 2 }), /number：2/)
  assert.match(formatEvaluation({ kind: 'json', text: '{"a":1}' }), /"a":1/)
  assert.match(formatEvaluation({ kind: 'function', text: 'function f(){}' }), /function/)
  assert.match(formatEvaluation({ kind: 'element', text: { tag: 'div', role: 'generic', name: '', rect: { x: 0, y: 0, width: 1, height: 1 } } }), /返回了一个元素/)
})

await test('bounding marks exactly what it hid', () => {
  const long = 'x'.repeat(200)
  const limited = bound(long, 50)
  assert.match(limited, /已截断：显示 50 字符，共 200 字符/)
  assert.equal(bound('short', 50), 'short')
  const lines = boundLines(['a', 'b', 'c', 'd'], 1000, 2)
  assert.match(lines, /另有 2 行未显示/)
})

await test('empty capture explains why, instead of looking broken', () => {
  assert.match(formatConsole([], 0), /页面内钩子只在装好之后/)
  assert.match(formatNetwork([], 0), /只覆盖 fetch 与 XMLHttpRequest/)
  // 调试器采集的空结果必须给出不同解释：历史本来就抓不到，不是钩子没装好。
  assert.match(formatConsole([], 0, true), /Chrome 不保留开启之前的记录/)
  assert.match(formatNetwork([], 0, true), /Chrome 不保留开启之前的请求/)
})

await test('a bridge token is long enough to be a real secret', () => {
  const token = createPairingToken()
  assert.ok(token.length >= 32, `token was only ${token.length} characters`)
  assert.notEqual(token, createPairingToken())
  assert.throws(() => new ChromeBridge({ token: 'too-short' }), /至少需要 16 个字符/)
})

console.log(`\n${failures === 0 ? 'all unit tests passed' : `${failures} unit test(s) failed`}`)
if (failures > 0) process.exitCode = 1
