/**
 * Host half of the dsh-chrome bundle.
 *
 * Wires one `ChromeRuntime` for the profile and registers the six chrome_*
 * tools on it. Every resource is owned by an effect so disabling or unloading
 * the plugin closes the bridge listener and stops the Chrome process this plugin
 * launched — a debug-port browser must never outlive the plugin that opened it.
 *
 * @module @star-grave/dsh-chrome
 */

import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ChromeRuntime } from './runtime.js'
import { ChromePairingRemote } from './remote.js'
import { createTools } from './tools.js'

export const name = 'dsh-chrome'
export const inject = ['tools']

export const Config = Schema.object({
  backend: Schema.union(['auto', 'extension', 'cdp']).default('auto').description(
    'Which transport the chrome_* tools prefer. auto drives your signed-in Chrome through the paired extension and falls back to a self-launched browser only when the extension has never paired.',
  ),
  bridgePort: Schema.number().default(8731).description(
    '扩展轮询的本地端口。在「Chrome 连接」页改会写进 <DSH_HOME>/data/dsh-chrome/bridge-port 并立即重绑；被占用时桥启动报错，不自动换端口。',
  ),
  bridgeHost: Schema.string().default('127.0.0.1').description('扩展桥的绑定地址。'),
  chromePath: Schema.string().description('cdp 通路用的 Chrome 可执行文件。省略时按常见安装位置或 CHROME_PATH 查找。'),
  headless: Schema.boolean().default(true).description('cdp 通路的浏览器是否无窗口运行。'),
  userDataDir: Schema.string().description('cdp 通路浏览器的 profile 目录。默认 <DSH_HOME>/data/dsh-chrome/profile；绝不使用你日常的 Chrome profile。'),
  viewportWidth: Schema.number().default(1280).description('cdp 通路浏览器的视口宽度（会被钉死，快照与截图都以此为准）。'),
  viewportHeight: Schema.number().default(900).description('cdp 通路浏览器的视口高度。'),
  defaultTimeoutMs: Schema.number().default(15_000).description('chrome_wait 与页面加载的默认时限。'),
  maxSnapshotElements: Schema.number().default(300).description('单次快照最多列出的元素数。'),
  maxOutputChars: Schema.number().default(6000).description('每个工具结果的字符预算。'),
  maxBufferedEvents: Schema.number().default(500).description('每个标签页保留的控制台与网络条目数。'),
  captureConsole: Schema.boolean().default(true).description('是否捕获控制台输出与未捕获异常。'),
  captureNetwork: Schema.boolean().default(true).description('是否捕获 fetch 与 XMLHttpRequest 活动。'),
  trustedIdleDetachMs: Schema.number().default(120_000).description('调试器会话（trusted 输入 / source=cdp 采集）空闲多久后自动释放，关掉 Chrome 顶部的调试提示条。'),
  extensionPath: Schema.string().description('要装进 Chrome 的本包扩展目录。默认是本包内的 extension 目录。'),
})

/** The package directory, used to point the user at the extension folder. */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Resolve the Harness home so the extension pairing token and the fallback
 * browser profile land beside other profile-scoped data.
 * @returns the directory that owns plugin data.
 */
function resolveHomeDir() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return join(fromEnv, 'data', 'dsh-chrome')
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.length > 0) return join(profileDir, 'dsh-chrome')
  return join(homedir(), '.dsh', 'data', 'dsh-chrome')
}

export function apply(ctx, config) {
  const homeDir = resolveHomeDir()
  const runtime = new ChromeRuntime({
    config: {
      ...config,
      dshHome: process.env.DSH_HOME,
      extensionPath: config.extensionPath ?? join(PACKAGE_DIR, 'extension'),
    },
    homeDir,
    log: (message) => ctx.logger?.debug?.(`[chrome] ${message}`),
  })

  ctx.effect(() => {
    runtime.start().catch((error) => {
      ctx.logger?.warn?.(`[chrome] bridge did not start: ${error.message}`)
    })
    return () => {
      runtime.dispose().catch((error) => {
        ctx.logger?.warn?.(`[chrome] teardown reported: ${error.message}`)
      })
    }
  })

  // The Remote the pairing page talks to: its only channel, and the only one
  // that keeps working when the bridge failed to bind. Registration is
  // best-effort so a deployment without the typert gateway still loads.
  ctx.effect(() => {
    let service = null
    try {
      service = new ChromePairingRemote(ctx, runtime)
    } catch (error) {
      ctx.logger?.warn?.(`[chrome] pairing Remote is unavailable: ${error.message}`)
    }
    return () => {
      try {
        service?.dispose?.()
      } catch {
        /* already gone */
      }
    }
  })

  // Images become durable attachments only when the deployment mounts the
  // attachment store; otherwise the screenshot tool still writes a file and
  // reports its path.
  const saveImage = async ({ data, mediaType, name }) => {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) return undefined
    return attachments.saveImage({ data, mediaType, name })
  }

  for (const tool of createTools(runtime, config, { saveImage })) {
    ctx.effect(() => ctx.tools.register(tool))
  }
}
