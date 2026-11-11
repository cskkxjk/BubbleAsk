# Bubble Ask（DSH 插件）

Bubble Ask 的划词提问能力在 DeepSeek Harness 中的实现。在会话中选中文字后，插件把「精简会话轨迹 + 选中文字 + 问题」填入所选网页版（默认 DeepSeek，可在设置里切换到千问、豆包、ChatGPT、Gemini、Grok），由它解释这段文字在当前上下文中的含义。

发送执行者有两类：

- DeepSeek：插件自己的内嵌窗口（经桌面端 lease 通道开的 Electron guest），首次使用需在面板里登录一次。
- 其余服务方：本机 `BubbleAsk.exe --service` 经命名管道驱动浏览器发送。

两条路径注入的是同一份 prompt，差别只在执行者。

与桌面端的差异：

| | 桌面端（`BubbleAsk.exe`） | 本插件（DSH） |
| --- | --- | --- |
| 使用范围 | 任意程序、任意时刻 | 会话过程中，上下文即当前会话 |
| 提问内容 | 模板中的问题文本（默认「什么是 %s」） | 每次附带精简会话轨迹 |
| 窗口 | 自行启动 `--app` 浏览器窗口 | DeepSeek 用插件内嵌窗口；其余服务方复用桌面端的 `--app` 窗口，登录态由桌面端持有 |

## 前置条件

按发送目标区分：

| 发送目标 | 运行环境 | 需要的组件 |
| --- | --- | --- |
| DeepSeek | DSH 桌面端主框架（页面里有 `dshDesktop.browser`） | 仅插件；首次在面板里登录一次 DeepSeek |
| DeepSeek | 页面里没有 `dshDesktop.browser` | `BubbleAsk.exe`；2.1.0 起保证发到 DeepSeek，更旧版本按本机配置的入口发送 |
| 千问 / 豆包 / ChatGPT / Gemini / Grok | 任意 | `BubbleAsk.exe` 2.1.0 或更高版本 |
| 只复制完整提问 | 任意 | 仅插件 |

补充两条回退规则：内嵌窗口发送失败时，卡片自动改用桌面端管道重试一次；provider 为空（本机没有选择，也没有读到宿主配置）时同样走管道，由桌面端按自己的配置决定服务方。

托盘应用的安装与启动步骤：

1. 构建并安装托盘应用（见[根目录 README](../README.md)），启动一次，确认托盘出现图标。
   - 启动后它会写 `%APPDATA%\BubbleAsk\ipc.json`，其中记录管道名与 exe 路径，插件据此找到它。
2. 再安装本插件并重启 DSH。

托盘应用缺少或未运行时，插件仍可整理上下文并复制完整提问；需要它执行的发送会返回明确的错误阶段与说明。

## 安装

界面安装：DSH 侧栏「插件」→「添加插件」→ 填写本目录的绝对路径 → 安装 → 重启。

本机尚无仓库副本时，使用 Git 子目录形式。插件不在仓库根目录，必须带 `#path:/dsh-plugin`：

```text
github:<owner>/<repo>#path:/dsh-plugin
```

直接填仓库根地址会被 pnpm 当成一个包，装出 `<repo>.git@0.0.0` 这种无效包，插件页无法识别。

命令行 profile 使用 `dsh plugin --profile <profile 名> add "<spec>"`，spec 可以是本地目录绝对路径，也可以是上面的 Git 子目录形式。`desktop` profile 的启动类命令由桌面应用独占（`profile "desktop" is managed exclusively by the Electron application`），`plugin` 子命令不受此限制。

安装来源决定更新语义：本地目录记为 `link:<本机路径>`，`git pull` 后即生效；Git 子目录记为 `github:…#path:/dsh-plugin` 并锁定 commit，更新需卸载后重装。

完整的安装方式、验证命令、卸载与更新，以及可直接交给 agent 的安装 prompt，见根目录 [README 的「DSH 插件：安装与验证」](../README.md#dsh-插件安装与验证)。

安装后的服务端自检（将 `<DSH 端口>` 替换为界面地址栏中的实际端口）：

```powershell
curl.exe -s http://127.0.0.1:<DSH 端口>/bubble-ask/health
# {"ok":true,"cdpReady":true,"app":{"connected":true,"version":2,"app":"2.3.1",
#  "currentProvider":"deepseek","providers":["deepseek","qwen",...,"custom"],
#  "providerSwitchable":true,...},"providers":[...],"provider":"deepseek",...}
# 插件未启用时该地址返回 404
```

字段含义：

- `ok`：路由本身可用，恒为 `true`。
- `cdpReady`：托盘应用已连通且协议版本一致。
- `app.connected`：管道可用；`app.app` 是桌面端版本，`app.version` 是协议版本（2）。
- `app.providerSwitchable`：为 `true` 时按桌面端支持的列表填充服务方下拉；为 `false` 且已连接（桌面端低于 2.1.0）时只提供 DeepSeek；未连接时保留 6 家完整列表，并在设置页提示需要桌面端 2.1.0 或更高版本。
- `app.providers`：桌面端支持的 id 列表，可能包含插件不提供的 `custom`。
- `providers`：插件自带的服务方注册表，含 id、名称、入口地址与选择器。
- `provider`：插件配置的默认服务方；`diag`：Client 半最近上报的自检记录（最多 40 条）。

真实站点是否已登录仍需按 `docs/web-providers.md` §4.1 逐家验证。

## 用法

1. 在会话中选中一段文本（回答、工具输出或自行输入的内容均可）。
2. 选区旁直接出现鲸鱼提问卡片，没有中间点击层。
3. 在卡片里填写问题。留空时注入的默认请求是「请解释这段选中文字在当前上下文中的含义」，完整文本见「注入内容」。
4. 按回车或点「发送」：
   - DeepSeek 由内嵌窗口填入并点击发送；
   - 其余服务方经本地管道交给托盘应用，是否自动点击发送由托盘应用的 `AutoSend` 配置决定，仅在回读确认输入框被清空时判定成功。
   - 成功即收起卡片；失败时卡片留在原地，显示失败阶段与原因，并给出「复制完整提问」按钮。
5. 按 Esc 或卡片右上角 ✕ 关闭卡片。

配置入口有两个，都不在卡片里：DSH 设置面板的「Bubble Ask」页，或会话标题栏鲸鱼按钮的右键菜单。改完下一句立即生效。提示词模板、API Key、热键在桌面端托盘图标的「设置」里。

## 注入内容

提问固定为三段：背景轨迹 → 命中位置上下文 → 选中文字 + 问题。

先做命中定位：把选区归一化（去空白、统一大小写）后在全部消息里查找子串，确定选区出自哪条消息；命中的那条及其前后各 `hitNeighbors` 条无条件进入轨迹，命中消息本身再按行（超长单行时按字符）截出「围绕命中位置的上下文」。没有精确命中时，退化为覆盖率最高的那条，`stats.hitExact` 会标出是哪一种。

```text
下面是我和一个 AI 编码助手刚才那段会话的「精简轨迹」，请把它当作背景上下文。
（会话的工作目录：<工作目录>）

【一、会话精简轨迹（背景）】
（标注：`[mNN]` 是消息引用号；我＝用户原话，助手＝AI 回复，括号里是它这一轮调用的工具；工具结果只保留骨架）
[m3] 我：……
[m7] 助手：……（调用：Read、Bash）
[m9] 工具结果：……

【二、围绕命中位置的上下文】
（选中的文字来自下面这段原文；这里取了它前后的内容，用来判断它指代什么）
[m11] 工具结果（包含选中文字）
…（前面还有 494 字符）… 10498: if (partition === void 0) { 10499: partition = `dsh-sidebar-browser-…
10495: acquire(owner, workspace) { … 10519: …（后面还有 741 字符）…

【三、我在会话里选中的文字】
"""
<选中的文字>
"""

【四、我的问题】        ← 仅在填写了问题时出现
<问题>

请解释这段选中文字在当前上下文中的含义：它指代什么、为什么这样表述、
和上下文里的哪一步相关。先给一句结论，再列 2 到 4 条依据，依据请带上消息引用号（例如「见 m23」）；
优先以命中位置的原文为准，轨迹只作背景；
如果信息不足以判断，直接说明缺什么，不要编造。

（阅读轨迹时的取舍规则：带行号的文件路径、函数签名、错误原文、决策及其理由、精确数值与版本
比叙述性文字重要得多；冗长日志、重复读取、失败的尝试只看结论。据此判断哪些细节值得引用。）
```

同一段原文被多处引用时（先 grep 出来、后来又被重新读一遍），命中指纹会识别出来，只保留原文出处那一处。

轨迹在每次提问时重新生成，连续追问时上下文跟随会话。Harness 注入的运行时上下文（时间戳、`Current runtime context`、技能目录、子代理通知等）按消息自带的 `source.kind` 判别并排除：只有 `source.kind === 'user'` 的消息算用户原话。拿不到 `source` 的旧会话改用文案清单。

`maxMessages` 是正文名额预算，命中锚点及其邻居优先占位，因此实际条数可能超过该值。

## 结构

```text
index.js               Host 端：HTTP 路由、轨迹精简、prompt 拼装、服务方注册表
client.js              Client 端：提问卡片、设置页、右键设置面板、内嵌网页版面板、会话 id 探针
lib/ask-client.mjs     托盘应用通信（Windows 命名管道客户端 + 自动拉起 + provider 字段，按需加载）
lib/driver.source.mjs  页面驱动源码（由 shared/driver.js 生成，经 Host 下发给内嵌面板）
lib/providers.data.js  服务方定义（由 shared/providers.json 生成）
cordis.patch.yml       插入 bubble-ask 条目
locale/zh.json         插件标题与描述（中文）
locale/en.json         插件标题与描述（英文）
icon.png               插件图标
package.json           包清单（exports / files / dsh 段）
```

界面挂载点：

| slot | id | order | 内容 |
| --- | --- | --- | --- |
| `settings.section` | `bubble-ask` | 25 | 设置页「Bubble Ask」 |
| `conversation.input.dock` | `bubble-ask-session` | 900 | 会话 id 探针（不渲染） |
| `shell.overlay` | `bubble-ask` | 900 | 划词提问卡片 |
| `shell.overlay` | `bubble-ask-webview` | 901 | 内嵌网页版面板 |
| `shell.overlay` | `bubble-ask-settings` | 902 | 右键设置面板 |
| `conversation.session.header.utilities` | `bubble-ask-pane-toggle` | 10 | 标题栏鲸鱼按钮 |

托盘应用仍是全部服务方的执行者之一，也是内嵌窗口失败时的回退执行者。两者边界见[两条发送路径](#两条发送路径)。

## 与后台服务的协作

CDP 驱动只有一份实现，跑在无界面身份的 `BubbleAsk.exe --service` 里（`ChatDriver.cs` / `CdpClient.cs`）。托盘界面与 DSH 插件都是它的客户端：

```text
插件 index.js                      BubbleAsk.exe（托盘 UI）
  └─ lib/ask-client.mjs                └─ EngineClient
        │                                    │
        └──────── 本地命名管道 ──────────────┘
                            │
                  BubbleAsk.exe --service
                      ├─ PipeServer（协议 + 租约）
                      └─ ChatDriver ──CDP──▶ Edge
```

- 发现：服务启动时把 `{version, app, pipe, pid, exe}` 写入 `%APPDATA%\BubbleAsk\ipc.json`。插件读它得到管道名与程序路径；是否在运行由 pid 存活与 `ping` 探活判断。
- 自动拉起：需要时若服务不在运行，插件用 `exe` 字段加 `--service` 参数启动它并等待就绪（最多 25 秒）。并发调用共享同一次拉起，不会重复启动进程。
- 租约：插件在 Host 加载时发 `attach` 持有一条长期连接，DSH 运行期间一直保持。服务按租约数量判断是否还有入口，最后一条断开后等 8 秒再退出。DSH 退出时进程消失，连接自动断开，无需注销。
- 协议 `v2`：命令 `ping` / `health` / `attach` / `toggle` / `send` / `send-image` / `topmost` / `restart`。版本字段必须与 `IpcContract.ProtocolVersion` 一致，不一致时返回「版本过旧」。
  插件使用 `ping` / `health` / `send` / `attach`；其余命令留给托盘与将来的客户端。
- 服务方：`send` 带可选 `provider`（`deepseek` / `qwen` / `doubao` / `chatgpt` / `gemini` / `grok`）。插件总是显式带上当前选择（包括 DeepSeek），避免桌面端配置的默认值影响本次发送；桌面端低于 2.1.0 时忽略该字段、按本机配置的入口发送，插件对旧桌面端只提供 DeepSeek，选择其它服务方时会提前拦截。
- 登录态：托盘应用与 Chrome 扩展共用 `%APPDATA%\BubbleAsk\edge-profile`，登录一次长期有效。插件的内嵌窗口使用独立分区，登录态另存，见[登录态与重启](#登录态与重启)。

## 两条发送路径

卡片点「发送」时按顺序择一：

| 路径 | 执行者 | 何时使用 | 登录态 |
| --- | --- | --- | --- |
| 内嵌网页版面板 | 插件经桌面端 lease 通道开的 Electron guest | 服务方为 DeepSeek，且页面里有 `dshDesktop.browser` | 存在 DSH 凭证存储，跨重启保留 |
| 托盘应用 | `BubbleAsk.exe --service` 通过 CDP 驱动 Edge | 非 DeepSeek；或页面里没有桌面桥；或内嵌路径失败 | 存在 `%APPDATA%\BubbleAsk\edge-profile` |

内嵌路径失败时，面板返回 `{ok:false, stage, detail}`，卡片改用托盘应用重试；两条都失败才提示复制完整提问。内嵌路径始终点击发送按钮；托盘应用是否自动点击由桌面端的 `AutoSend` 决定。

### 入口：标题栏鲸鱼按钮

不开内嵌面板也能用：点会话标题栏右上角的鲸鱼图标按钮（`conversation.session.header.utilities`，28×28，与「打开方式」「定时任务」「下载会话日志」并排）。点一下展开面板，再点一下收起；展开时图标外有一圈强调色描边。右键该按钮弹出设置面板，可就地切换服务方。

- 第一次点会创建 guest 并加载页面；之后收起只是 `display:none`，网页与登录态保留在内存中。
- 页面里没有桌面桥时该按钮不渲染，因为这种环境下内嵌窗口不可用。
- 按钮与卡片的「发送」共用同一个 guest 与同一份初始化（`ensureReady` 幂等），先手动开面板再发消息不会重复加载页面。

### 内嵌窗口的三项宿主约束

三条都来自实测，代码注释中有对应说明：

1. 准入：主进程在 `will-attach-webview` 里校验 `src` 必须是 `about:blank#<lease>`、`partition` 必须等于该 lease 的 partition，否则 `preventDefault()`。lease 只能由 `dshDesktop.browser.acquire(workspace)` 签发，插件必须走 lease。
2. 认领时序：主进程在 `did-attach-webview` 里等同一个 `dom-ready` 后读 URL 认领 lease（URL 必须仍是 `about:blank#<lease>`）。立即 `loadURL` 会让它读到的 URL 与 lease 不匹配，guest 会被关闭，因此 `dom-ready` 之后要再等一拍（400ms）。
3. 环境判定：站点按 UA 判定「使用环境异常」（UA 含 `electron`，或 `window.process.type === 'renderer'`）。lease 的 UA 带 `Electron/44.7.0`，必须在首个文档建立之前调用 `element.setUserAgent()` 脱敏。`setUserAgent` 是运行时方法，不受 `will-attach-webview` 清除 preferences 的影响。

### 登录态与重启

lease 的 partition 由主进程生成（`dsh-sidebar-browser-<uuid>`，无 `persist:` 前缀、不落盘），DSH 重启后是全新分区，这一点插件无法改变。

处理方式是把登录态写入新分区：网页版的登录态完全在 localStorage、不依赖 cookie，其中必要的是 7 个键、不到 1KB（`userToken` / `settingsJwt` / `smidV2` / `deepseek-device-id:chat` / `__appKit_userInfo` / `__ds_remote_feature_did` / `hif_leim_cached`）；全量 29 个键共 37KB，大部分是可再生的 feature store 缓存。把 7 个键写入全新分区再 reload，即可直接进入主界面并正常对话。

流程：登录一次 → 插件抓取这 7 个键存入 DSH 凭证存储（`ctx.credentials`，落盘在 `~/.dsh/.credentials.yaml`）→ 下次建好 guest 后写回 localStorage 并 reload。面板右上角的「清除登录」删除该存档。

## HTTP 路由

路由同源，且仅监听本机。插件未启用时，这些地址返回 404。

| 路由 | 作用 |
| --- | --- |
| `POST /bubble-ask/prompt` | 入参 `{sessionId, selection, question, provider?}` → `{ok, providerId, providerName, mode, prompt, url, stats}`；只整理不发送 |
| `POST /bubble-ask/send` | 入参同上，实际注入并发往所选服务方；非 DeepSeek 时先校验桌面端版本，旧版返回可复制的错误 |
| `GET /bubble-ask/driver` | 内嵌面板取驱动源码与服务方配置：`{ok, driver, generic:{composerSelectors, sendAriaLabels}, providers, defaultId}` |
| `GET/POST/DELETE /bubble-ask/session` | 内嵌面板的登录态存档：`GET` 只报键名、`POST` 写入（走 `ctx.credentials`）、`DELETE` 清除 |
| `POST /bubble-ask/session-data` | 取回完整登录态，供内嵌面板写回 guest 的 localStorage |
| 任意方法 `/bubble-ask/health` | 自检：托盘应用连通状态、协议版本、profile 目录、最近自检记录、当前与可选服务方 |
| `POST /bubble-ask/diag` | Client 半上报自检记录（最多保留 40 条），可从 `/health` 的 `diag` 字段读取 |

`mode` 为 `prefill`（URL 带 `?q=`）或 `clipboard`（返回入口地址与完整提问）。`url` 是入口地址或预填地址，供外部调用者参考；卡片的发送与复制都不使用它。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖该条目的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | `deepseek` | 默认服务方：`deepseek` / `qwen` / `doubao` / `chatgpt` / `gemini` / `grok`。设置页或右键面板的选择覆盖它，并按本机 localStorage（键 `bubble-ask.provider`）记忆 |
| `chatUrl` | `https://chat.deepseek.com/` | 仅 DeepSeek 的入口地址覆盖（镜像或自定义入口的旧配置），影响 `/prompt`、`/send` 返回的地址；内嵌窗口固定打开 `https://chat.deepseek.com/`，托盘应用按 provider 决定入口 |
| `maxMessages` | `12` | 正文名额预算；命中锚点及其邻居优先占位，实际条数可能超出 |
| `maxCharsPerMessage` | `240` | 单条消息的截断长度 |
| `maxTraceChars` | `2600` | 整段轨迹的字数上限 |
| `traceMode` | `relevance` | 轨迹挑选策略：`relevance` 锚定选区出处后按相关性补足；`recent` 仅取最后若干条 |
| `recentTail` | `1` | `relevance` 模式下固定保留的末尾消息条数 |
| `hitNeighbors` | `1` | 命中选区的那条消息前后各带几条邻居进入轨迹 |
| `maxHits` | `3` | 「围绕命中位置的上下文」最多取几处命中 |
| `hitWindowLines` | `14` | 每处命中窗口取多少行 |
| `hitWindowChars` | `1200` | 每处命中窗口的字符上限；超长单行时改用字符窗口 |
| `maxToolEntries` | `2` | 进入轨迹的工具结果条数上限（仅在其覆盖选区时纳入） |
| `toolMinCoverage` | `0.12` | 工具结果覆盖选区的最低比例 |
| `minAssistantChars` | `60` | 助手正文短于该长度且不含路径、错误或决策时，按过程性叙述丢弃 |
| `appPath` | 空 | 托盘应用 exe 路径；留空时用 `%APPDATA%\BubbleAsk\ipc.json` 里记录的路径 |

浏览器、CDP 端口、登录 profile、是否自动发送归属托盘应用的 `config.json`，插件不重复声明这些字段。插件只决定「默认发到哪家 / 本次发到哪家」，不改动桌面端的服务方设置；新桌面端（2.1.0+）下可用服务方以桌面端注册表为准（插件从 `/health` 读取 id 列表并取交集），旧桌面端下插件只提供 DeepSeek。

## 已知限制

### 内嵌窗口只支持 DeepSeek

登录态迁移的 7 个键、UA 脱敏、环境判定都是对 `chat.deepseek.com` 实测的结果，其它 5 家没有逐家验证（各自的登录存储、环境判定、页面结构不同）。选非 DeepSeek 时卡片直接走托盘应用。

### 内嵌窗口依赖 DSH 桌面端

`dshDesktop.browser` 由桌面端 preload 注入，是否可用取决于页面的加载方式。页面里没有该桥时（例如用普通浏览器直接打开本地端口），鲸鱼按钮不渲染，内嵌路径回退为托盘应用。本机当前会话里该桥可用（`/health` 的 diag 有 `pane-toggle-mount supported:true`），因此 DeepSeek 走内嵌窗口。

### 原生窗口无法嵌入 GUI

以下是本版 DSH 桌面壳的约束：

- 自建 `<webview>` 需要 lease，不能直接创建。
- Host 插件拿不到 Electron API：DSH Host 是独立 node 子进程（`spawn(node, dsh-desktop-host/lib/index.js)`），不是 Electron 主进程，因此无法使用 `WebContentsView` 之类的主进程嵌入能力。
- `chat.deepseek.com` 返回 `Content-Security-Policy: frame-ancestors 'none'`，iframe 无法嵌入，因此使用 `<webview>`。

### 其他

- 托盘应用的必要性按[前置条件](#前置条件)中的矩阵决定。DeepSeek 且页面有桌面桥时，发送走内嵌窗口，不需要 `BubbleAsk.exe`；非 DeepSeek、页面没有桌面桥、内嵌失败时需要它。复制完整提问不依赖任何执行者。
- 切换服务方需要桌面端 2.1.0+。更旧的桌面端忽略 `send` 里的 `provider` 字段，按本机配置的入口发送；插件的下拉在旧桌面端下只显示 DeepSeek。升级桌面端后无需重启 DSH，下一次发送前会重新校验版本。
- 旧桌面端加自定义入口：桌面端 2.0.0 配置过自定义 `ChatUrl` 时，卡片标着 DeepSeek，实际仍会发到那个自定义入口。需要按服务方切换时请把桌面端升级到 2.1.0+。
- `custom`（自定义服务方）不在插件提供。需要自定义入口时在桌面端「设置 → 窗口与网页 → 网页版服务方」里配置。
- 平台限定 Windows。通信走 Windows 命名管道，托盘应用是 WinForms 程序。macOS/Linux 上的 DSH 可以装本插件，自动发送不可用。
- 原生窗口是独立 OS 窗口，不会嵌入 DSH 窗口内部，需要与 DSH 并排摆放。
- `?q=` 传参不可靠：请求行超过 8KB 时返回 `414`（纯 ASCII 8029 字节通过，8329 字节失败）；长 prompt 生成的约 7K URL 稳定返回 `429`。插件不依赖 URL 传参，自动发送走页面注入。目前只有 DeepSeek 提供 `prefillParam`，中文 prompt 编码后通常超过 3000 的预算，因此 `prepareAsk` 大多返回 `clipboard` 模式。
- 选区取自 DSH 页面；插件无法读取外部窗口内的选区（跨进程）。
- 若 `lib/ask-client.mjs` 缺失，发送会返回「模块未就绪」，复制完整提问仍可用。
- 内嵌窗口需要登录时最长等待 10 分钟，期间卡片保持「正在整理会话轨迹并发送」状态且发送按钮不可用；面板里会提示在窗口内登录。超时后按失败处理并回退到托盘应用。
- 同一时刻只允许一个操作：插件的发送与托盘自身的全局热键共用同一把 `TryBeginOperation` 锁，并发请求会被拒绝并提示稍后重试。
