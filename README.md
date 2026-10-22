# dsh-chrome

让 DeepSeek Harness 的 agent **调用、查看、操控 Chrome**。

两条通路，一套工具：

| 通路 | 操控哪一份 Chrome | 需要你做什么 | 有登录态吗 |
|---|---|---|---|
| **extension**（主） | 你日常那个 Chrome | 手动加载一次扩展，填一次端口与令牌 | ✅ 有 |
| **cdp**（兜底） | 插件自己拉起的独立 profile Chrome | 无，用 `chrome_status action=launch` 启动 | ❌ 没有 |

默认 `backend=auto`：优先走 extension，扩展从未连上时才回落到 cdp，结果里会注明本次用的是哪条。

---

## 功能

| 工具 | 用途 |
|---|---|
| `chrome_status` | `status` 看两条通路 / `pair` 打印配对信息 / `launch` 启动兜底 Chrome / `attach` 接已有 DevTools 端点 / `close` 关掉兜底 Chrome / `release` 释放调试器会话 |
| `chrome_tabs` | `list` `new` `select` `activate` `close` |
| `chrome_navigate` | `goto` `back` `forward` `reload`，等加载完成并回报最终 URL 与标题 |
| `chrome_observe` | `snapshot`（带 ref 的可交互元素清单）`text` `html` `screenshot` `console` `network` `eval` `body` |
| `chrome_act` | `click` `double_click` `right_click` `hover` `type` `press` `scroll` `check` `uncheck` `select_option` |
| `chrome_wait` | `selector` `text` `url` `load` `timeout` |

- 标签用 `t1`、`t2`… 寻址，同一会话内编号稳定，重新 launch 后从 `t1` 重来。
- 快照给可交互元素编号（ref）；取新快照或页面导航后旧 ref 失效，结果会区分“从未有过这个编号”和“来自更早的快照”。
- 页面文本一律按不可信数据处理，输出里带声明。
- 每个结果有字符上限（默认 6000），被截断时写明截了多少。

### 真实输入与完整采集（按需开启）

```text
chrome_act     action=click ref=e12 trusted=true     # 真实鼠标事件，isTrusted=true
chrome_observe action=network source=cdp             # 全部请求类型 + 可读响应体
chrome_observe action=body requestId=<#后面的 id>     # 读某条请求的响应体
chrome_status  action=release                        # 立刻释放调试器
```

不传这两个参数时走页面内合成事件与 `fetch`/XHR 钩子：不打扰页面、不出现调试条，但 `isTrusted=false`，且只覆盖 fetch/XHR。cdp 通路本身产生真实输入，`trusted` 在它上面是空操作。

---

## 安装

### 1. 装插件

```powershell
dsh plugin --profile desktop add <本地目录或 GitHub 地址>
```

例：

```powershell
dsh plugin --profile desktop add G:\Tools\dsh-chrome
dsh plugin --profile desktop add github:STAR-GRAVE/dsh-chrome
```

仓库地址后面可以带 `#<tag>` 或 `#<commit>` 固定版本；不带就用默认分支的最新提交。也可以在插件页点「添加插件」填路径或仓库地址。装完重启 DSH。

### 2. 加载扩展（一次性）

1. 打开 `chrome://extensions`，开启右上角**开发者模式**，点**加载已解压的扩展程序**。
2. 目录路径不用自己找：打开 DSH 左侧导航的 **Chrome 连接** 页面，页面上显示当前扩展目录，点「复制路径」后粘进选择框。
3. 加载完成后，点工具栏上的扩展图标打开选项页。

### 3. 配对

在 **Chrome 连接** 页面上能看到端口与令牌：

- 把端口（默认 `8731`）和令牌填进扩展选项页，点「保存并连接」。主机固定 `127.0.0.1`，扩展里只填端口。
- 令牌也可以让 agent 运行 `chrome_status action=pair` 打印，两处读的是同一个值。

之后只要 Chrome 在运行，扩展就会自己轮询，不需要重启，也不需要调试端口。

### 4. 或者直接用兜底通路

```text
chrome_status action=launch backend=cdp
```

启动一个 headless 的独立 profile Chrome，零配置，代价是没有你的登录态。

---

## Chrome 连接 页面

左侧导航的 **Chrome 连接** 是关于配对状态的唯一界面：

- **扩展目录**：当前扩展所在目录，可选中，可点「复制路径」，下方一行写着加载步骤。
- **端口**：输入框 + 「应用」。桥在跑就原地换端口；桥没起来就先记住端口再试着起来，起不来会显示原因。改完要把扩展选项页的端口改成同一个数字，两边不自动同步。
- **当前令牌 / 新令牌**：显示生效中的值，可「复制」，也可「随机生成」后保存。保存立即生效，旧令牌同时失效。
- **扩展状态**：已连接 / 未连接；桥没监听时显示原因。

页面本身不依赖本地桥：桥因为端口被占用起不来时，页面照样能打开、能改端口。

---

## 配置

在 profile 的 patch 层按行 id `chrome` 覆盖：

```yaml
- id: chrome
  name: "@star-grave/dsh-chrome"
  config:
    backend: auto            # auto | extension | cdp
    bridgePort: 8731         # 扩展轮询端口；在「Chrome 连接」页改过则以 bridge-port 文件为准
    bridgeHost: 127.0.0.1
    chromePath: ''           # cdp 通路的可执行文件；省略则探测常见安装位置 / CHROME_PATH
    headless: true           # cdp 通路是否无窗口
    userDataDir: ''          # cdp 通路的 profile；默认 <DSH_HOME>/data/dsh-chrome/profile
    viewportWidth: 1280
    viewportHeight: 900
    defaultTimeoutMs: 15000
    maxSnapshotElements: 300
    maxOutputChars: 6000
    maxBufferedEvents: 500
    captureConsole: true
    captureNetwork: true
    trustedIdleDetachMs: 120000  # 调试器会话空闲多久后自动释放
    extensionPath: ''        # 扩展目录；默认本包下的 extension/
```

端口被占用时桥直接报错，不换端口、不重试；腾出端口后重载插件，或在页面上改端口。

数据文件都在 `<DSH_HOME>/data/dsh-chrome/`：

- `pairing-token`（权限 0600）：配对令牌，不进配置文件。
- `bridge-port`：在页面上改过端口才有，优先级高于配置里的 `bridgePort`。
- `profile/`：兜底通路的浏览器 profile。

---

## 限制

- **真实输入与完整网络采集要显式开启**（`trusted` / `source=cdp`），代价是 Chrome 顶部出现「正在调试此浏览器」提示条；空闲 `trustedIdleDetachMs`（默认 2 分钟）后自动释放，也可以 `chrome_status action=release` 立刻释放。
- **一个标签同时只有一个调试器**：打开 DevTools（F12）会把它抢走，工具会报错；点调试条上的「取消」可以夺回，采集随即停止并如实报告。
- **开启调试器会让页面下移约 20px**（提示条占位），布局会变一下。
- **扩展通路的 `eval` 会显示调试条**：MV3 的限制使其只能走调试器；cdp 通路的 eval 没有这个副作用。
- **console 历史抓不到**：只从开启那一刻开始，两种通路都一样。
- **扩展通路的截图只截可见视口**，且会先把该标签切到前台（抢焦点）。整页截图与元素局部截图用 cdp 通路。
- **`chrome://`、扩展商店、PDF 阅读器等受保护页面无法操作**，会给出明确报错。
- **`data:` 与 `about:blank` 在扩展通路上无法脚本化**，临时页请用 `http://127.0.0.1:<端口>` 这类普通地址。
- **不穿透 iframe**：快照只覆盖主框架，页面里有 iframe 时会在输出里标注数量。
- **原生 `<select>` 的下拉列表无法被合成事件驱动**：`select_option` 直接设值并派发事件；依赖真实下拉交互的自定义控件可能需要 `click` 加后续点击。
- **不做文件上传**（往 `input[type=file]` 塞文件）。
- **兜底通路的 profile 没有你的登录态**，也不与日常 Chrome 共享历史。
- **扩展需要手动加载一次**：Chrome 不接受命令行装载扩展，也不允许网页触发安装。

---

## 排错

| 现象 | 原因与处理 |
|---|---|
| 插件激活失败，日志 `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery` | `package.json` 的 `peerDependencies` 没有声明该包。 |
| `chrome_status` 显示 `bridge: not listening` | 桥没有在监听，`chrome_status action=status` 会给原因；腾出端口后重载插件，或在「Chrome 连接」页换端口。 |
| 本地桥起不来（端口被占用） | 状态里写明哪个端口被占用。腾出端口后重载插件，或改 `bridgePort` / 在页面上改端口后重启 DSH。 |
| 扩展选项页测连接失败 | 核对端口与令牌：「Chrome 连接」页显示的就是当前生效的值，两边必须是同一个数字。 |
| 扩展显示已连接但工具报 no transport | 该会话的工具体在插件重载前构建。重载插件后新开一个会话，或在新一轮请求里调用。 |
| CDP 通路启动报没有 DevTools endpoint | 检查 `chromePath`；Chrome 的 stderr 尾部会附在错误里。 |
| 附着到 9222 报 HTTP 404 | 那个端口的 Chrome 使用默认数据目录，Chrome 136+ 对它不启用 CDP。改用扩展通路，或使用带独立 `--user-data-dir` 的 Chrome。 |

---

## 卸载

```powershell
dsh plugin --profile desktop remove @star-grave/dsh-chrome
```

扩展在 `chrome://extensions` 里点移除即可。

---

## License

MIT
