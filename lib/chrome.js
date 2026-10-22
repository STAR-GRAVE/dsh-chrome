/**
 * Locate, launch, and own a Chrome process for the CDP fallback backend.
 *
 * This backend exists for the case the extension cannot serve: a machine where
 * the user has not loaded the extension, or an agent that must work with no
 * user interaction at all. It always uses its own profile directory — Chrome
 * ignores `--remote-debugging-port` for the default data directory, so attaching
 * to the everyday browser is impossible by design.
 *
 * @module @star-grave/dsh-chrome/chrome
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Well-known install locations, most specific first. */
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
]

/** Flags that keep an automation profile quiet and predictable. */
const BASE_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,MediaRouter',
  '--disable-background-networking',
  '--disable-sync',
  '--metrics-recording-only',
  '--password-store=basic',
  '--use-mock-keychain',
  // Pin the scale factor. On a display with OS scaling, `--window-size` is in
  // device pixels while `window.innerWidth` is in CSS pixels, so a snapshot
  // would report a viewport 1.5–2x smaller than the window that was requested.
  '--force-device-scale-factor=1',
]

/**
 * Resolve the Chrome executable.
 * @param {object} options - resolution inputs.
 * @param {string} [options.chromePath] - explicit override from Config.
 * @param {NodeJS.ProcessEnv} [options.env] - environment carrying `CHROME_PATH`.
 * @returns {{ path: string, source: string }} the executable and how it was found.
 * @throws when nothing usable is found; the message lists every attempt.
 */
export function resolveChromePath({ chromePath, env = process.env } = {}) {
  const attempts = []
  const accept = (candidate, source) => {
    if (!candidate) return null
    attempts.push(`${source}: ${candidate}`)
    return existsSync(candidate) ? { path: candidate, source } : null
  }
  if (chromePath) {
    const found = accept(chromePath, 'config.chromePath')
    if (found) return found
    throw new Error(`config.chromePath 指向的 "${chromePath}" 不存在。已尝试：\n${attempts.join('\n')}`)
  }
  const fromEnv = accept(env.CHROME_PATH, 'CHROME_PATH')
  if (fromEnv) return fromEnv
  for (const candidate of CANDIDATES) {
    const found = accept(candidate, 'installed')
    if (found) return found
  }
  const located = locateOnPath()
  if (located) return { path: located, source: 'PATH' }
  attempts.push('PATH：chrome、google-chrome、chrome.exe —— 都没找到')
  throw new Error(
    `找不到 Google Chrome。请把 config.chromePath（或 CHROME_PATH 环境变量）指向可执行文件。已尝试：\n${attempts.join('\n')}`,
  )
}

/** Ask the shell's PATH for a Chrome executable, silently tolerating absence. */
function locateOnPath() {
  const commands = process.platform === 'win32' ? ['chrome.exe'] : ['google-chrome', 'chrome', 'google-chrome-stable']
  for (const command of commands) {
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8' })
    if (result.status === 0 && typeof result.stdout === 'string') {
      const first = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      if (first && existsSync(first)) return first
    }
  }
  return null
}

/**
 * A launched Chrome the plugin owns end to end.
 *
 * `dispose()` is the single teardown path: the plugin registers it as an effect,
 * so unloading or disabling the plugin never leaves a debug-port Chrome behind.
 */
export class ManagedChrome {
  #child = null
  #endpoint = null
  #exitPromise = null
  #stderr = ''
  #userDataDir = null
  #log

  /** @param {{ log?: (message: string) => void }} [options] - diagnostic sink. */
  constructor({ log } = {}) {
    this.#log = log ?? (() => {})
  }

  /** Whether a managed process is currently alive. */
  get running() {
    return this.#child !== null && this.#child.exitCode === null && !this.#child.killed
  }

  /** The managed process id, for status output and precise cleanup. */
  get pid() {
    return this.#child?.pid ?? null
  }

  /** The DevTools endpoint of the managed process, when one is running. */
  get endpoint() {
    return this.#endpoint
  }

  /**
   * Launch Chrome with a private profile and a DevTools endpoint.
   * @param {object} options - launch settings.
   * @param {string} options.executable - resolved Chrome path.
   * @param {string} options.userDataDir - the private profile directory.
   * @param {boolean} [options.headless] - run without a visible window.
   * @param {string} [options.url] - first page.
   * @param {string} [options.viewport] - `WIDTHxHEIGHT` window size.
   * @param {number} [options.readyTimeoutMs] - how long to wait for the endpoint.
   * @returns {Promise<{ endpoint: string, pid: number }>} the ready process.
   */
  async launch({ executable, userDataDir, headless = true, url = 'about:blank', viewport, readyTimeoutMs = 20_000 }) {
    if (this.running) throw new Error(`插件托管的 Chrome 已在运行（pid ${this.pid}），端点 ${this.#endpoint}`)
    mkdirSync(userDataDir, { recursive: true })
    this.#userDataDir = userDataDir
    const args = [
      ...BASE_FLAGS,
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      ...(headless ? ['--headless=new', '--hide-scrollbars', '--mute-audio'] : []),
      ...(viewport ? [`--window-size=${viewport}`] : []),
      url,
    ]
    this.#log(`launching ${executable} with a private profile at ${userDataDir}`)
    this.#stderr = ''
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: headless })
    this.#child = child
    this.#endpoint = null
    this.#exitPromise = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.#log(`managed Chrome exited (code ${code}, signal ${signal ?? 'none'})`)
        if (this.#child === child) {
          this.#child = null
          this.#endpoint = null
        }
        resolve()
      })
    })
    child.stderr.setEncoding('utf8')
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#kill()
        reject(
          new Error(
            `Chrome did not report a DevTools endpoint within ${readyTimeoutMs}ms. Its stderr ended with:\n${this.#stderrTail()}`,
          ),
        )
      }, readyTimeoutMs)
      const onData = (chunk) => {
        this.#stderr += chunk
        if (this.#stderr.length > 64_000) this.#stderr = this.#stderr.slice(-32_000)
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(this.#stderr)
        if (!match) return
        clearTimeout(timer)
        child.stderr.off('data', onData)
        const wsUrl = match[1]
        resolve(wsUrl.replace(/^ws:\/\//, 'http://').replace(/\/devtools\/browser\/.*$/, ''))
      }
      child.stderr.on('data', onData)
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`Chrome exited before it was ready (code ${code}). Stderr:\n${this.#stderrTail()}`))
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`could not start ${executable}: ${error.message}`))
      })
    })
    this.#endpoint = endpoint
    return { endpoint, pid: child.pid }
  }

  /** The tail of Chrome's stderr, bounded for a tool message. */
  #stderrTail() {
    const lines = this.#stderr.split(/\r?\n/).filter((line) => line.trim().length > 0)
    return lines.slice(-8).join('\n') || '(Chrome wrote nothing to stderr)'
  }

  /**
   * Terminate the managed process and prove it is gone.
   *
   * Telling a caller "closed" while the process still runs was a real defect:
   * a stuck Chrome kept its profile lock and its debug port. So this escalates —
   * polite signal, then a process-tree kill — and throws if the pid survives,
   * because a caller that cannot trust the answer cannot clean up either.
   * @param {{ timeoutMs?: number }} [options] - how long to wait before escalating.
   * @throws when the process is still alive after both attempts.
   */
  async dispose({ timeoutMs = 5_000 } = {}) {
    const child = this.#child
    if (!child) return
    const pid = child.pid
    const waitForExit = () => Promise.race([this.#exitPromise, new Promise((resolve) => setTimeout(resolve, timeoutMs))])
    this.#kill()
    await waitForExit()
    if (!this.#exited(pid)) {
      this.#log(`managed Chrome ${pid} ignored the first signal; forcing the process tree down`)
      this.#forceKill(pid)
      await waitForExit()
    }
    const stillAlive = !this.#exited(pid)
    this.#child = null
    this.#endpoint = null
    if (stillAlive) {
      throw new Error(
        `Chrome（pid ${pid}）被要求停止两次之后仍在运行。` +
          `请按这个 pid 结束该进程（它的 profile 在 ${this.#profileHint}），然后重试。`,
      )
    }
  }

  /** Whether a pid has exited, without signalling it. */
  #exited(pid) {
    if (typeof pid !== 'number') return true
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }

  /** Force a whole process tree down, scoped to this exact pid. */
  #forceKill(pid) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      return
    }
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        this.#log(`could not force-kill ${pid}: ${error.message}`)
      }
    }
  }

  /** A human hint for cleanup messages, naming the profile this browser used. */
  get #profileHint() {
    return this.#userDataDir ?? '(unknown)'
  }

  /** Send a kill to this exact pid; never a name-based sweep. */
  #kill() {
    const child = this.#child
    if (!child || child.exitCode !== null) return
    try {
      child.kill()
    } catch (error) {
      this.#log(`could not signal managed Chrome: ${error.message}`)
    }
  }
}

/** The default private profile location, kept out of any user Chrome profile. */
export function defaultUserDataDir(dshHome) {
  const home = dshHome && dshHome.length > 0 ? dshHome : join(homedir(), '.dsh')
  return join(home, 'data', 'dsh-chrome', 'profile')
}
