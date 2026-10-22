# dsh-chrome

让 DeepSeek Harness 的 agent 操作 Chrome。

默认操作你日常在用的那个 Chrome，保留登录态。它没连上时会启动一个独立的 Chrome，那个没有你的登录态，可以用 `chrome_status action=close` 关掉。

## 功能

| 工具 | 用途 |
|---|---|
| `chrome_status` | 看连接状态、打印配对信息、启动/关闭浏览器、释放调试会话 |
| `chrome_tabs` | 列出、打开、切换、置前、关闭标签页 |
| `chrome_navigate` | 打开地址、前进后退、重载，等加载完成并回报最终地址与标题 |
| `chrome_observe` | 元素快照、正文、HTML、截图、控制台、网络、求值、读响应体 |
| `chrome_act` | 点击、双击、右键、悬停、输入、按键、滚动、勾选、选下拉 |
| `chrome_wait` | 等元素、等文字、等地址、等加载完成或等一段时间 |

- 标签用 `t1`、`t2`… 寻址，同一会话内编号稳定。
- 元素快照给出 `e1`、`e2`… 编号；重新取快照或页面导航后旧编号失效，结果会说明原因。
- 真实输入与完整网络采集按需开启，不传参数时不会打扰页面：

```text
chrome_act     action=click ref=e12 trusted=true   # 真实输入事件
chrome_observe action=network source=cdp           # 全部请求类型
chrome_observe action=body requestId=<#后面的 id>   # 读响应体
chrome_status  action=release                      # 立刻释放调试器
```

开启期间 Chrome 顶部会显示调试提示条，空闲 2 分钟后自动释放。

## 安装与配置

### 安装

```powershell
dsh plugin --profile desktop add github:STAR-GRAVE/dsh-chrome#v1.1.0
```

也可以在插件页点「添加插件」填同一地址。装完重启 DSH。

### 加载扩展（一次性）

1. 打开 `chrome://extensions`，开启**开发者模式**，点**加载已解压的扩展程序**。
2. 扩展目录在 DSH 左侧导航的 **Chrome 连接** 页面，点「复制路径」后粘进选择框。
3. 在 **Chrome 连接** 页面上复制端口与令牌，填进扩展选项页，点「保存并连接」。

之后只要 Chrome 在运行就会自动连上，不需要重启，也不需要调试端口。

### 配置

在 profile 的 patch 层按行 id `chrome` 覆盖：

```yaml
- id: chrome
  name: "@star-grave/dsh-chrome"
  config:
    backend: auto            # auto | extension | cdp
    bridgePort: 8731         # 扩展连接端口；在「Chrome 连接」页改过则以页面上的为准
    chromePath: ''           # 独立浏览器的路径；省略则自动探测
    headless: true           # 独立浏览器是否无窗口
    viewportWidth: 1280      # 独立浏览器的视口
    viewportHeight: 900
    defaultTimeoutMs: 15000  # 等页面加载的默认时限
    maxSnapshotElements: 300 # 单次快照最多列出的元素数
    maxOutputChars: 6000     # 单个工具结果的字符上限
    trustedIdleDetachMs: 120000  # 调试器空闲多久后自动释放
```

其余字段（`bridgeHost`、`userDataDir`、`maxBufferedEvents`、`captureConsole`、`captureNetwork`、`extensionPath`）一般不用改。

## 排障

| 现象 | 处理 |
|---|---|
| 工具提示连不上浏览器 | 先 `chrome_status action=status` 看连接状态；扩展未连接就按上面第 2、3 步加载并填端口令牌。 |
| 扩展显示已连接但工具仍报错 | 插件重载前建立的会话不会自动更新工具，重启 DSH 后新开一个会话。 |
| 端口被占用 | 状态里会写明哪个端口；在「Chrome 连接」页改一个空闲端口，再把扩展选项页的端口改成同一个数字。 |
| 扩展选项页「测试连接」失败 | 端口或令牌不对。「Chrome 连接」页显示的就是当前生效值，两边必须一致。 |
| 点击没反应 | 该站点可能只认真实指针：让 agent 用 `trusted=true` 再试。 |
| 看不到接口返回 | 用 `chrome_observe action=network source=cdp`，再 `action=body` 读响应体。 |
| 插件激活失败，日志 `ERR_MODULE_NOT_FOUND` | 缺 `peerDependencies` 声明，装的是损坏的包，重新安装。 |

## License

MIT
