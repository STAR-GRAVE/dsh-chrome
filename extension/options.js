/**
 * 弹窗/选项页：读写配对配置，并报告桥是否可达，让用户不用经过 agent 也能
 * 自己改掉一个输错的端口。
 *
 * 只暴露端口：主机永远是 127.0.0.1，让用户填一整条 URL 只会多一个出错的地方。
 * 存储仍然是 endpoint 字符串，所以扩展的轮询代码不用知道这里的界面变化。
 */

const CONFIG_KEY = 'dshChromeConfig'
const DEFAULT_PORT = '8731'
const HOST = '127.0.0.1'

const portInput = document.getElementById('port')
const tokenInput = document.getElementById('token')
const stateBox = document.getElementById('state')
const extId = document.getElementById('extid')

/** 渲染一行状态，带严重程度。 */
function showState(text, tone) {
  stateBox.textContent = text
  stateBox.className = tone ?? ''
}

/** 从存下来的 endpoint 里读出端口；认不出来就用默认值。 */
function portOf(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) return DEFAULT_PORT
  try {
    const url = new URL(endpoint)
    if (url.port.length > 0) return url.port
    return url.protocol === 'https:' ? '443' : '80'
  } catch {
    const match = /:(\d{1,5})\/?$/.exec(endpoint.trim())
    return match === null ? DEFAULT_PORT : match[1]
  }
}

/** 把端口拼回扩展轮询用的地址。 */
function endpointOf(port) {
  return `http://${HOST}:${port}`
}

/** 校验并读出端口，非法时返回 null。 */
function readPort() {
  const raw = portInput.value.trim()
  if (!/^\d{1,5}$/.test(raw)) return null
  const port = Number(raw)
  return port >= 1 && port <= 65535 ? String(port) : null
}

/** 保存表单当前的值。 */
async function save() {
  const port = readPort()
  if (port === null) {
    showState('端口要填 1–65535 之间的整数。', 'bad')
    return null
  }
  const token = tokenInput.value.trim()
  if (token.length === 0) {
    showState('要填配对令牌。「Chrome 连接」页可以复制。', 'bad')
    return null
  }
  const endpoint = endpointOf(port)
  await chrome.storage.local.set({ [CONFIG_KEY]: { endpoint, token } })
  showState(`已保存，正在连接…`, 'ok')
  return { endpoint, token }
}

/** 走一次健康检查，证明端口可达。 */
async function testConnection() {
  const saved = await save()
  if (!saved) return
  try {
    const response = await fetch(`${saved.endpoint.replace(/\/+$/, '')}/health`, { cache: 'no-store' })
    if (!response.ok) {
      showState(`端口 ${portOf(saved.endpoint)} 返回了 HTTP ${response.status}。`, 'bad')
      return
    }
    const body = await response.json()
    showState(
      body.connected
        ? '桥可达，且 Harness 已经看到本扩展在轮询。'
        : '桥可达，但 Harness 还没登记到一次轮询。稍等一下再测一次。',
      body.connected ? 'ok' : '',
    )
  } catch (error) {
    showState(
      `连不上 127.0.0.1:${portOf(saved.endpoint)}（${error?.message ?? error}）。确认 Harness 在运行，且端口与「Chrome 连接」页一致。`,
      'bad',
    )
  }
}

/** 把已保存的配置读进表单。 */
async function load() {
  const stored = await chrome.storage.local.get(CONFIG_KEY)
  const value = stored?.[CONFIG_KEY] ?? {}
  portInput.value = portOf(value.endpoint)
  tokenInput.value = typeof value.token === 'string' ? value.token : ''
  extId.textContent = chrome.runtime.id
  if (typeof value.token === 'string' && value.token.length > 0) {
    showState('已配置。只要 Chrome 在运行，扩展就会轮询桥。', 'ok')
  }
}

document.getElementById('save').addEventListener('click', () => {
  save().catch((error) => showState(`保存失败：${error?.message ?? error}`, 'bad'))
})
document.getElementById('test').addEventListener('click', () => {
  testConnection().catch((error) => showState(`测试失败：${error?.message ?? error}`, 'bad'))
})

load().catch((error) => showState(`读取配置失败：${error?.message ?? error}`, 'bad'))
