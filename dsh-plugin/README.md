# Bubble Ask（DSH 插件）

将 [Bubble Ask](../README.md) 的划词提问能力移植到 DeepSeek Harness：在会话中选中文本并点击气泡后，插件将「精简会话轨迹 + 选中文本 + 问题」注入所选网页版（默认 DeepSeek，也可在气泡里切到千问 / 豆包 / ChatGPT / Gemini / Grok），由其解释该文本在当前会话上下文中的含义。导航、登录检测、注入与发送仍由桌面端完成，插件只负责整理上下文与选择服务方。

与桌面端的主要差异：

| | 桌面端（`BubbleAsk.exe`） | 本插件（DSH） |
| --- | --- | --- |
| 使用范围 | 任意程序、任意时刻 | 仅限会话过程中，且上下文即当前会话 |
| 提问内容 | 模板中的问题文本（默认「什么是 %s」） | 每次附带精简会话轨迹，因此始终具备上下文 |
| 窗口 | 自行启动 `--app` 浏览器窗口 | 复用同一个原生 `--app` 窗口（持久登录，由桌面端持有）；DSH 里只画一个划词气泡 |

## 前置条件：先装托盘应用

**顺序是先装 `BubbleAsk.exe`，再装本插件。** 插件不含 CDP 驱动，它通过本地命名管道调用托盘应用来注入并发送；两边共用同一份持久化登录 profile，登录一次长期有效。

1. 构建并安装托盘应用（见[根目录 README](../README.md)），启动一次，确认托盘出现图标。
   - 启动后它会写 `%APPDATA%\BubbleAsk\ipc.json`，其中记录了管道名与 exe 路径，插件据此找到它。
2. 再安装本插件并重启 DSH。

托盘应用没安装或没启动时，插件仍可整理上下文、复制全文，但「发送到 <服务方>」会明确报错而不会静默失败。插件发现对端不在跑时会尝试用 `ipc.json` 里记录的路径自动拉起一次（最多等 25 秒）。

## 安装

界面安装最为直接：DSH 侧栏「插件」→「添加插件」→ 填写本目录的绝对路径 → 安装 → 重启。

本机尚无仓库副本时，使用 Git 子目录形式。插件不在仓库根目录，必须带 `#path:/dsh-plugin`：

```text
github:<owner>/<repo>#path:/dsh-plugin
```

直接填仓库根地址会被 pnpm 当成一个包，装出 `<repo>.git@0.0.0` 的空壳，插件页无法识别。

命令行 profile 使用 `dsh plugin --profile <profile 名> add "<spec>"`，spec 可以是本地目录绝对路径，也可以是上面的 Git 子目录形式。`desktop` profile 的启动类命令由桌面应用独占（`profile "desktop" is managed exclusively by the Electron application`），但 `plugin` 子命令不受此限制。

安装来源决定更新语义：本地目录记为 `link:<本机路径>`，`git pull` 后即生效；Git 子目录记为 `github:…#path:/dsh-plugin` 并锁定 commit，更新需卸载后重装。

完整的安装方式、验证命令、卸载与更新，以及可直接提交给 agent 的安装 prompt，见根目录 [README 的「DSH 插件：安装与验证」](../README.md#dsh-插件安装与验证)。

安装后的服务端自检（将 `<DSH 端口>` 替换为界面地址栏中的实际端口）：

```powershell
curl.exe -s http://127.0.0.1:<DSH 端口>/bubble-ask/health
# {"ok":true,"cdpReady":true,"providers":[...],"app":{"connected":true,"app":"2.1.0",
#  "providers":["deepseek","qwen",...],"providerSwitchable":true,...},...}   未安装时返回 404
```

`cdpReady` 表示「托盘应用已连通且协议版本一致」；`app.providerSwitchable` 为 `true` 时气泡「发到」下拉可切换 6 家，否则（桌面端 < 2.1.0）只提供 DeepSeek。真实站点是否已登录仍需按 `docs/web-providers.md` §4.1 逐家验证。

## 用法

1. 在会话中选中任意一段文本（回答、工具输出或自行输入的内容均可）。
2. 选区下方出现「💬 问这段」气泡。
3. 气泡内可填写自定义问题；留空时注入的默认问题为「请解释这段文字在当前会话上下文中的含义。」（输入框占位符的措辞为「解释它在当前上下文中是什么意思」，与注入内容含义一致）。
4. **「发到」下拉框**选择服务方：默认沿用上次选择（本机 localStorage 记忆），首次使用取插件 `provider` 配置（默认 DeepSeek）；下拉只列当前桌面端真能发送的服务方（新桌面端从 `/bubble-ask/health` 的 `app.providers` 读取；桌面端低于 2.1.0 会忽略 `provider` 字段，因此只保留 DeepSeek）。
5. 点击气泡中的按钮：
   - **发送到 <服务方>**（回车同效）：Host 经本地管道让托盘应用按同一个 provider 导航、注入完整提问并点击发送；是否自动点发送由托盘应用的 `AutoSend` 配置决定，仅当回读确认输入框被清空时判定发送成功。成功即收起气泡，失败则在气泡内显示原因。
   - **复制提问**：只整理上下文、不发送，把完整提问复制到剪贴板，你自己到窗口里按 `Ctrl+V` 粘贴。

发送失败时气泡会留在原地，并多出一个「复制全文」按钮 —— 那是唯一的兜底出口，不必重新划词。切换服务方不需要重开气泡：改下拉后直接再点发送即可。

## 注入内容

提问固定为三段：**背景轨迹 → 命中位置上下文 → 选中文字 + 问题**。

先做一次**命中定位**：把选区归一化（去空白、统一大小写）后在全部消息里找子串，找出选区究竟出自哪条消息；命中的那条及其前后各 `hitNeighbors` 条无条件进入轨迹，命中消息本身再按行（或超长单行时按字符）截出「围绕命中位置的上下文」。找不到精确命中时，退化为覆盖率最高的那条（`stats.hitExact` 会标出是哪种）。

```text
下面是我和一个 AI 编码助手刚才那段会话的「精简轨迹」，请把它当作背景上下文。
（会话的工作目录：<工作目录>）

【一、会话精简轨迹（背景）】
（标注：`[mNN]` 是消息引用号；我＝用户原话，助手＝AI 回复，括号里是它这一轮调用的工具；工具结果只保留骨架）
[m3] 我：……
[m7] 助手：……（调用：Read、Bash）
[m9] 工具结果：……

【二、围绕命中位置的上下文】
（选中的文字就是从下面这段原文里来的；这里取了它前后的内容，用来判断它到底指代什么）
[m11] 工具结果（包含选中文字）
…（前面还有 494 字符）… 10498: if (partition === void 0) { 10499: partition = `dsh-sidebar-browser-…
10495: acquire(owner, workspace) { … 10519: …（后面还有 741 字符）…

【三、我在会话里选中的文字】
"""
<选中的文字>
"""

【四、我的问题】        ← 只在真的填了问题时才出现
<问题>

请解释这段选中文字在当前上下文中的含义：它指代什么、为什么这样表述、
和上下文里的哪一步相关。先给一句结论，再列 2 到 4 条依据，依据请带上消息引用号（例如「见 m23」）；
优先以命中位置的原文为准，轨迹只作背景；
如果信息不足以判断，直接说明缺什么，不要编造。

（阅读轨迹时的取舍规则：带行号的文件路径、函数签名、错误原文、决策及其理由、精确数值与版本
比叙述性文字重要得多；冗长日志、重复读取、失败的尝试只看结论。据此判断哪些细节值得引用。）
```

同一段原文被多处引用时（例如先 grep 出来、后来又被重新读一遍），命中指纹会识别出来，只保留原文出处那一处。

轨迹在每次提问时重新生成，因此连续追问时上下文始终跟随会话。Harness 注入的运行时上下文（时间戳、`Current runtime context`、技能目录、子代理通知等）按消息自带的 `source.kind` 判别并排除：只有 `source.kind === 'user'` 的才是用户真的说的话，其余都视为注入。拿不到 `source` 的旧会话退回文案黑名单。

## 结构

```text
index.js               Host 端：HTTP 路由、轨迹精简、prompt 拼装、服务方注册表
client.js              Client 端：选区气泡（shell.overlay，含「发到」下拉）、内嵌网页版面板
                       （shell.overlay）、会话 id 探针（conversation.input.dock）
lib/ask-client.mjs     与托盘应用的通信（Windows 命名管道客户端 + 自动拉起 + 可选 provider，惰性加载）
lib/driver.source.mjs  页面驱动源码（由 shared/driver.js 生成，经 Host 下发给内嵌面板）
lib/providers.data.js  服务方定义（由 shared/providers.json 生成）
cordis.patch.yml       插入 bubble-ask 条目
```

插件在 DSH 里画一个气泡，并可选地开一个**内嵌网页版面板**（DeepSeek 走这条）；托盘应用仍是其它服务方与内嵌失败时的执行者。两者的边界见[两条发送路径](#两条发送路径)。

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

- 发现：服务启动时把 `{version, app, pipe, pid, exe}` 写入 `%APPDATA%\BubbleAsk\ipc.json`。插件读它得到管道名与程序路径；把它当作「装在哪」的长期记录，是否在跑由 pid 存活 + `ping` 探活判断。
- 自动拉起：插件第一次需要时若发现服务不在跑，会用 `exe` 字段加 `--service` 参数启动它并等待就绪（最多 25 秒）。
- 租约：插件在 Host 加载时发 `attach` 持有一条长期连接，DSH 运行期间一直挂着。服务靠租约数量判断「还有没有入口」，最后一个断开后等 8 秒宽限期再退出。DSH 退出时进程消失，连接自动断开，无需任何注销。
- 协议 `v2`：命令 `ping` / `health` / `attach` / `toggle` / `send` / `send-image` / `topmost` / `restart`。版本字段必须与 `IpcContract.ProtocolVersion` 一致，不一致直接报「版本过旧」而不是静默失败。
  插件目前只用到 `ping` / `health` / `send` / `attach`；其余命令保留在契约里供托盘与将来的客户端（CLI、其他 IDE 插件）使用。
- 服务方：`send` 新增可选 `provider`（`deepseek` / `qwen` / `doubao` / `chatgpt` / `gemini` / `grok`）。插件总是显式带上当前选择（包括 DeepSeek），保证用户明确选了 DeepSeek 时不会因为桌面端配置了别家默认值而发错站点；桌面端低于 2.1.0 会忽略该字段、按本机配置的入口发送，插件对旧桌面端只提供 DeepSeek，选择非 DeepSeek 时也会提前拦截（不会静默发错站点）。
- 登录态：所有客户端共用同一份持久化 profile（默认 `%APPDATA%\BubbleAsk\edge-profile`），登录一次长期有效。

## 两条发送路径

气泡点「发送到 DeepSeek」时有两套执行者，按顺序择一：

| 路径 | 执行者 | 何时走 | 登录态 |
| --- | --- | --- | --- |
| 内嵌网页版面板 | 插件**自己**经桌面端 lease 通道开的 Electron guest | 当前是 DeepSeek，且运行在 DSH 桌面端主框架里（有 `dshDesktop.browser`） | 存在 DSH 凭证存储，跨重启保留 |
| 托盘应用 | `BubbleAsk.exe --service` 通过 CDP 驱动 Edge | 非 DeepSeek；或无桌面桥（浏览器打开 GUI）；或内嵌这条路发送失败 | 存在 `%APPDATA%\BubbleAsk\edge-profile` |

内嵌这条路失败不会直接判死：面板返回 `{ok:false, stage, detail}` 后气泡自动回退到托盘应用，两者都不行才提示「复制全文」手动粘贴。面板里点了「发送」的同时，DeepSeek 窗口会在屏幕右侧展开，看得见消息发出去。

### 入口：输入框右侧那颗常驻按钮

不选文字也想开 DeepSeek 时，用**输入框右侧的 `● DeepSeek` 小按钮**（`conversation.input.right`，就在发送键前面）。点一下展开面板，再点一下收起；按钮变蓝、圆点亮起表示面板正开着。

- 第一次点会建 guest 并加载页面；之后收起只是 `display:none`，网页与登录态都留在内存里，再打开是瞬时的。
- 没有桌面桥时（在浏览器里打开 GUI）这颗按钮**根本不渲染** —— 那种环境下内嵌窗口不可用，放个按钮只会误导。
- 它和气泡的「发送」共用同一个 guest 与同一份初始化（`ensureReady` 幂等），先手动开面板再发消息不会重复加载页面。

### 内嵌面板怎么绕开宿主的三道门

这三条都是实测出来的，代码注释里也有：

1. **准入**：主进程在 `will-attach-webview` 里校验 `src` 必须是 `about:blank#<lease>`、`partition` 必须等于该 lease 的 partition，否则 `preventDefault()`。lease 只能由 `dshDesktop.browser.acquire(workspace)` 签发，所以插件必须走 lease 而不是裸 `createElement('webview')`。
2. **认领时序**：主进程在 `did-attach-webview` 里等同一个 `dom-ready` 后读 URL 认领 lease。立刻 `loadURL` 会让它读到的 URL 对不上 lease，guest 直接被关掉 —— 所以 `dom-ready` 之后要多等一拍（400ms）再导航。
3. **环境判定**：站点按 UA 判定「使用环境异常」（UA 含 `electron`，或 `window.process.type === 'renderer'`）。lease 的 UA 带 `Electron/44.7.0`，必须在首个文档建立之前 `element.setUserAgent()` 脱敏。`setUserAgent` 是运行时方法，不受 `will-attach-webview` 清除 preferences 的影响。

### 登录态怎么跨重启

lease 的 partition 由主进程生成（`dsh-sidebar-browser-<uuid>`，无 `persist:` 前缀、不落盘），所以 **DSH 一重启就是全新分区**，这个限制插件绕不过。

绕过办法是搬登录态而不是搬分区：实测网页版的登录态**完全在 localStorage、不依赖 cookie**，其中真正需要的只有 7 个键、不到 1KB（`userToken` / `settingsJwt` / `smidV2` / `deepseek-device-id:chat` / `__appKit_userInfo` / `__ds_remote_feature_did` / `hif_leim_cached`），全量 29 个键里 37KB 大部分是可再生的 feature store 缓存。把 7 个键灌进一个全新分区再 reload，就能直接进主界面并正常对话。

于是流程是：登录一次 → 自动抓这 7 个键存进 **DSH 自己的凭证存储**（`ctx.credentials`，落盘在 `~/.dsh/.credentials.yaml`）→ 下次建好 guest 后写回 localStorage 再 reload 一次即可免登录。面板右上角的「清除登录」删掉存档。

## HTTP 路由

路由同源，且仅监听本机：

| 路由 | 作用 |
| --- | --- |
| `POST /bubble-ask/prompt` | `{sessionId, selection, question, provider?}` → `{ok, provider, providerName, mode, prompt, url, stats}`；只整理不发送，内嵌面板与「复制提问」都用它 |
| `POST /bubble-ask/send` | 同上，但会经管道让托盘应用实际注入网页版并发送；非 DeepSeek 时先校验桌面端版本，旧版返回可复制的错误 |
| `GET /bubble-ask/driver` | 内嵌面板取驱动源码与服务方配置：`{ok, driver, generic:{composerSelectors, sendAriaLabels}, providers, defaultId}`；内容全部来自唯一真源 |
| `GET/POST/DELETE /bubble-ask/session` | 内嵌面板的登录态存档：`GET` 只报键名、`POST` 存（走 `ctx.credentials`）、`DELETE` 清除 |
| `POST /bubble-ask/session-data` | 取回完整登录态（内嵌面板写回 guest 的 localStorage 用） |
| 任意方法 `/bubble-ask/health` | 自检：托盘应用是否连通（`cdpReady`）、协议版本、profile 目录、最近的自检记录、当前/可选服务方（`provider`、`providers`、`app.*Provider*`）（该路由不校验方法） |
| `POST /bubble-ask/diag` | Client 端上报自检记录（最多保留 40 条），可通过 `/health` 的 `diag` 字段读取 |

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖该条目的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | `deepseek` | 默认服务方：`deepseek` / `qwen` / `doubao` / `chatgpt` / `gemini` / `grok`。气泡里的下拉框会覆盖它并按本机记忆保持 |
| `chatUrl` | `https://chat.deepseek.com/` | 仅 DeepSeek 的入口地址覆盖（镜像/自定义入口的老配置）；其余服务方用内置注册表地址。实际导航仍由托盘应用按 provider 决定 |
| `maxMessages` | `12` | 轨迹包含的消息条数上限 |
| `maxCharsPerMessage` | `240` | 单条消息的截断长度 |
| `maxTraceChars` | `2600` | 整段轨迹的字数上限 |
| `traceMode` | `relevance` | 轨迹挑选策略：`relevance` 优先锚定选区出处，再按相关性补足；`recent` 仅取最后若干条 |
| `recentTail` | `1` | `relevance` 模式下固定保留的末尾消息条数（有命中锚点后，最近几条未必相关，故降为 1） |
| `hitNeighbors` | `1` | 命中选区的那条消息前后各带几条邻居进入轨迹 |
| `maxHits` | `3` | 「围绕命中位置的上下文」最多取几处命中 |
| `hitWindowLines` | `14` | 每处命中窗口取多少行 |
| `hitWindowChars` | `1200` | 每处命中窗口的字符上限；单行超长（被压平的工具输出）时自动退化为字符窗口 |
| `maxToolEntries` | `2` | 进入轨迹的工具结果条数上限（作为证据，仅在其覆盖选区时纳入） |
| `toolMinCoverage` | `0.12` | 工具结果覆盖选区的最低比例，达到该比例才进入轨迹 |
| `minAssistantChars` | `60` | 助手正文短于该长度且不含路径、错误或决策时，视为过程性叙述，不进入轨迹 |
| `appPath` | 空 | 托盘应用 exe 路径；留空时用 `%APPDATA%\BubbleAsk\ipc.json` 里记录的路径 |

浏览器、CDP 端口、登录 profile、是否自动发送这些设置归属托盘应用的 `config.json`，插件不再重复配置 —— 一处配置、一处生效，避免两边漂移。插件只决定「默认发到哪家 / 本次发到哪家」，不会改动桌面端的服务方设置；新桌面端（2.1.0+）下两边的可用服务方以桌面端注册表为准（插件从 `/health` 读 id 列表），旧桌面端下插件只提供 DeepSeek。

## 已知限制

### 内嵌面板只支持 DeepSeek

「自己开 guest 打开网页版」这条路目前只接了 DeepSeek：登录态迁移的 7 个键、UA 脱敏、环境判定都是对 `chat.deepseek.com` 实测出来的，其它 5 家没有逐个验证（各自的登录存储、环境判定、页面结构都不同）。选非 DeepSeek 时气泡直接走托盘应用，不会尝试内嵌。

### 内嵌面板依赖 DSH 桌面端

`dshDesktop.browser` 只在 `dsh-app://app` **主框架**里暴露（`preload-app.cjs` 的判断是 `location.protocol === 'dsh-app:' && location.hostname === 'app' && process.isMainFrame`）。在浏览器里打开 GUI（`http://127.0.0.1:60922`）时只有 `{protocolVersion: 1}`，拿不到 `browser`，内嵌这条路自动降级为托盘应用。

### 无法把原生窗口"嵌"进 GUI

以下三条是本版 DSH 桌面壳的硬约束：

- 自建 `<webview>` 需要 lease（见上），不能裸建。
- Host 插件拿不到 Electron API：DSH Host 是独立 node 子进程（`spawn(node, dsh-desktop-host/lib/index.js)`），不是 Electron 主进程，因此无法使用 `WebContentsView` 之类的主进程嵌入能力。
- `chat.deepseek.com` 返回 `Content-Security-Policy: frame-ancestors 'none'`，任何 iframe 都无法嵌入 —— 所以走的是 `<webview>` 而不是 `<iframe>`。

### 其他

- **托盘应用不再是无条件必需**。DeepSeek 且运行在 DSH 桌面端时，发送走内嵌面板，`BubbleAsk.exe` 没装也能发；非 DeepSeek、或在浏览器里打开 GUI、或内嵌失败时才需要它。「复制提问」始终不依赖任何执行者。
- **切换服务方需要桌面端 2.1.0+**。更旧的桌面端会忽略 `send` 里的 `provider` 字段、按本机配置的入口发送（旧版插件的行为，不会静默换成 DeepSeek）；插件的下拉在旧桌面端下只显示 DeepSeek，选不到非 DeepSeek。升级桌面端后无需重启 DSH：下一次发送前会重新校验版本。
- **旧桌面端 + 自定义入口**：桌面端 2.0.0 配置过自定义 `ChatUrl` 时，气泡标着 DeepSeek 但实际仍会发到那个自定义入口（旧行为）。需要按服务方切换时请把桌面端升级到 2.1.0+。
- **`custom`（自定义服务方）不在插件提供**。需要自定义入口时在桌面端「设置 → 窗口与网页 → 网页版服务方」里配置，插件侧没有对应下拉项。
- **平台限定 Windows**。通信走 Windows 命名管道，托盘应用是 WinForms 程序。macOS/Linux 上的 DSH 可以装本插件，但自动发送不可用。
- 原生窗口是独立 OS 窗口，不会嵌入 DSH 窗口内部；它需要与 DSH 并排摆放。
- `?q=` 传参不可靠（实测）：请求行超过 8KB 时返回 `414`（纯 ASCII 8029 字节通过，8329 字节失败）；长 prompt 生成的约 7K URL 还会稳定返回 `429`。插件因此不依赖 URL 传参（预填退路由托盘应用内部处理）。目前只有 DeepSeek 提供 `prefillParam`，且中文 prompt 百分号编码后通常超过 3000 的预算，所以 `prepareAsk` 实际几乎总是走 `clipboard` 兜底；真正的自动发送走管道注入，不受此影响。
- 选区取自 DSH 页面；插件无法读取外部窗口内的选区（跨进程）。
- 若 `lib/ask-client.mjs` 缺失，「发送到 <服务方>」会明确报模块未就绪，「复制提问」仍然可用。
- 同一时刻只允许一个操作：插件的发送与托盘自身的全局热键共用同一把 `TryBeginOperation` 锁，并发请求会被拒绝并提示稍后重试。
