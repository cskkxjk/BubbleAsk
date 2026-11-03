# Bubble Ask（DSH 插件）

将 [Bubble Ask](../README.md) 的划词提问能力移植到 DeepSeek Harness：在会话中选中文本并点击气泡后，插件将「精简会话轨迹 + 选中文本 + 问题」注入 DeepSeek 网页版，由其解释该文本在当前会话上下文中的含义。

与桌面端的主要差异：

| | 桌面端（`BubbleAsk.exe`） | 本插件（DSH） |
| --- | --- | --- |
| 使用范围 | 任意程序、任意时刻 | 仅限会话过程中，且上下文即当前会话 |
| 提问内容 | 模板中的问题文本（默认「什么是 %s」） | 每次附带精简会话轨迹，因此始终具备上下文 |
| 窗口 | 自行启动 `--app` 浏览器窗口 | 同一个原生 `--app` 窗口（持久登录）；DSH 右侧栏放一个专属控制面板，不再占用 `Ctrl+T` 浏览器 |

## 前置条件：先装托盘应用

**顺序是先装 `BubbleAsk.exe`，再装本插件。** 插件不含 CDP 驱动，它通过本地命名管道调用托盘应用来注入并发送；两边共用同一份持久化登录 profile，登录一次长期有效。

1. 构建并安装托盘应用（见[根目录 README](../README.md)），启动一次，确认托盘出现图标。
   - 启动后它会写 `%APPDATA%\BubbleAsk\ipc.json`，其中记录了管道名与 exe 路径，插件据此找到它。
2. 再安装本插件并重启 DSH。

托盘应用没安装或没启动时，插件仍可整理上下文、复制全文，但「发送到 DeepSeek」会明确报错而不会静默失败。插件发现对端不在跑时会尝试用 `ipc.json` 里记录的路径自动拉起一次（最多等 25 秒）。

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
# {"ok":true,"cdpReady":true,"app":{"connected":true,...},...}   未安装时返回 404
```

`cdpReady` 现在表示「托盘应用已连通且协议版本一致」。

## 用法

1. 在会话中选中任意一段文本（回答、工具输出或自行输入的内容均可）。
2. 选区下方出现「💬 问这段」气泡。
3. 气泡内可填写自定义问题；留空时注入的默认问题为「请解释这段文字在当前会话上下文中的含义。」（输入框占位符的措辞为「解释它在当前上下文中是什么意思」，与注入内容含义一致）。
4. 点击气泡中的按钮，并在右侧栏的 **Bubble Ask 专属面板** 中查看结果：
   - **发送到 DeepSeek**（默认，回车同效）：Host 经本地管道让托盘应用注入完整提问并点击发送；是否自动点发送由托盘应用的 `AutoSend` 配置决定，仅当回读确认输入框被清空时判定发送成功。发送后面板会显示轨迹条数、字数和发送阶段。
   - **只准备**：只整理上下文并在面板里打开，不发送。面板中可「发送到 DeepSeek」「只打开窗口」「复制全文」「重新整理」。

专属面板同时出现在右侧栏的引导页（指南针图标 → Bubble Ask 卡片），也可以从中直接打开。面板显示的是**上一次**组好的提问：页面重载后由 Host 的 `GET /bubble-ask/state` 恢复，不必重新划词。

## 注入内容

Host 端从会话日志（`session.deriveMessages()`）读取最近的 user/assistant 消息，按字数和条数截断为「精简轨迹」，再由 `buildPrompt()` 拼装为下列结构（轨迹与问题为实际内容，此处以占位符表示）：

```text
下面是我和一个 AI 编码助手刚才那段会话的「精简轨迹」，请把它当作背景上下文。
（会话的工作目录：<工作目录>）

【会话精简轨迹】
（标注：`[mNN]` 是消息引用号；我＝用户原话，助手＝AI 回复，括号里是它这一轮调用的工具；工具结果只保留骨架）
[m3] 我：……
[m7] 助手：……（调用：Read、Bash）
[m9] 工具结果：……

【我在会话里选中的文字】
"""
<选中的文字>
"""

【我的问题】
<问题；留空时为「请解释这段文字在当前会话上下文中的含义。」>

请结合【会话精简轨迹】解释这段选中文字在当前上下文中的含义：它指代什么、为什么这样表述、
和上下文里的哪一步相关。先给一句结论，再列 2 到 4 条依据，依据请带上消息引用号（例如「见 m23」）；
如果轨迹里的信息不足以判断，直接说明缺什么，不要编造。

（阅读轨迹时的取舍规则：带行号的文件路径、函数签名、错误原文、决策及其理由、精确数值与版本
比叙述性文字重要得多；冗长日志、重复读取、失败的尝试只看结论。据此判断哪些细节值得引用。）
```

轨迹在每次提问时重新生成，因此连续追问时上下文始终跟随会话。Harness 注入的运行时上下文（时间戳、`Current runtime context` 等）会被过滤，不计入会话内容。

## 结构

```text
index.js               Host 端：HTTP 路由、轨迹精简、prompt 拼装
client.js              Client 端：选区气泡（shell.overlay）、会话 id 探针（conversation.input.dock）、
                       专属 tab 类型注册（ctx.sidebarRightTabs）与面板正文（sidebar.right.pane.tab）
lib/ask-client.mjs     与托盘应用的通信（Windows 命名管道客户端 + 自动拉起，惰性加载）
cordis.patch.yml       插入 bubble-ask 条目
```

专属 tab 走的是右侧栏的公开扩展点，与内置 Document Preview 用的是同一条路径：

1. `ctx.sidebarRightTabs.register({ id, kind, title, guide })` 声明类型（`kind: 'bubble-ask'`）；
2. `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body)` 提供正文；
3. `ctx.sidebarRight.openTab('bubble-ask')` 打开它。

## 与托盘应用的协作

CDP 驱动只有一份实现，在托盘应用里（`ChatDriver.cs` / `CdpClient.cs`）。插件是薄客户端，通过本地命名管道调用它：

```text
插件 index.js
  └─ lib/ask-client.mjs  ──命名管道──▶  BubbleAsk.exe (PipeServer.cs)
                                            └─ ChatDriver.AskAsync()
                                                 └─ EdgeHost + CdpClient ──CDP──▶ Edge
```

- 发现：托盘应用启动时把 `{version, app, pipe, pid, exe}` 写入 `%APPDATA%\BubbleAsk\ipc.json`。插件读它得到管道名与 exe 路径；把它当作「装在哪」的长期记录，是否在跑由 pid 存活 + `ping` 探活判断。
- 自动拉起：插件发现对端不在跑时，会用该文件里的 exe 路径启动一次托盘应用，并等待就绪（最多 25 秒）。
- 协议：一连接 = 一行 JSON 请求 → 一行 JSON 响应，命令 `ping` / `health` / `open` / `send`。`version` 字段必须与 `PipeServer.ProtocolVersion` 一致，不一致直接报「版本过旧」而不是静默失败。
- 登录态：两边共用同一份持久化 profile（默认 `%APPDATA%\BubbleAsk\edge-profile`），登录一次长期有效。

## HTTP 路由

路由同源，且仅监听本机：

| 路由 | 作用 |
| --- | --- |
| `POST /bubble-ask/prompt` | `{sessionId, selection, question}` → `{prompt, url, stats}` |
| `POST /bubble-ask/send` | 同上，但会经管道让托盘应用实际注入网页版并发送 |
| `POST /bubble-ask/open` | 只启动或复用原生窗口，不注入、不发送 |
| `GET /bubble-ask/state` | 面板重载后恢复上一次的提问与发送结果 |
| `GET /bubble-ask/health` | 自检：托盘应用是否连通（`cdpReady`）、协议版本、profile 目录、最近的自检记录 |
| `POST /bubble-ask/diag` | Client 端上报自检记录（最多保留 40 条），可通过 `/health` 的 `diag` 字段读取 |

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖该条目的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `chatUrl` | `https://chat.deepseek.com/` | 网页版地址（仅用于展示与 `?q=` 参考；实际导航由托盘应用自己的配置决定） |
| `maxMessages` | `12` | 轨迹包含的消息条数上限 |
| `maxCharsPerMessage` | `240` | 单条消息的截断长度 |
| `maxTraceChars` | `2600` | 整段轨迹的字数上限 |
| `traceMode` | `relevance` | 轨迹挑选策略：`relevance` 按与选区的相关性挑选，`recent` 仅取最后若干条 |
| `recentTail` | `3` | `relevance` 模式下固定保留的末尾消息条数 |
| `maxToolEntries` | `2` | 进入轨迹的工具结果条数上限（作为证据，仅在其覆盖选区时纳入） |
| `toolMinCoverage` | `0.12` | 工具结果覆盖选区的最低比例，达到该比例才进入轨迹 |
| `minAssistantChars` | `60` | 助手正文短于该长度且不含路径、错误或决策时，视为过程性叙述，不进入轨迹 |
| `appPath` | 空 | 托盘应用 exe 路径；留空时用 `%APPDATA%\BubbleAsk\ipc.json` 里记录的路径 |

浏览器、CDP 端口、登录 profile、是否自动发送这些设置归属托盘应用的 `config.json`，插件不再重复配置 —— 一处配置、一处生效，避免两边漂移。

## 已知限制

### 为什么不用右侧栏的内嵌浏览器

DSH 桌面端右侧栏的 Browser（`Ctrl+T`）看起来是更省事的位置，但它有两处由宿主决定、插件无法绕开的限制：

- **登录不跨重启**。WebView 的存储分区由主进程生成：`dsh-sidebar-browser-${randomUUID()}`，没有 `persist:` 前缀，因此只存在于进程内存。应用重启后 Cookie 与 Web Storage 一并消失，需要重新登录；同时同一工作目录的多个标签页共享该分区。
- **网页版会判定环境异常**。该 guest 运行在 Electron 内核中，`chat.deepseek.com` 会弹出「使用环境异常 / 可能存在数据和隐私泄露风险」的横幅。

插件的原生窗口链路用独立持久化 profile（默认 `%APPDATA%\BubbleAsk\edge-profile`），登录一次长期有效，也没有上述横幅。

### 无法把原生窗口"嵌"进 GUI

以下三条是本版 DSH 桌面壳的硬约束，决定了原生窗口只能作为独立窗口存在：

- 自建 `<webview>` 会被拒绝：主进程在 `will-attach-webview` 中校验 `src` 必须为 `about:blank#<lease>`、且 `partition` 与签发时一致，否则 `preventDefault()`。lease 只能由主进程的 `dsh-desktop:browser-acquire` 签发。
- Host 插件拿不到 Electron API：DSH Host 是独立 node 子进程（`spawn(node, dsh-desktop-host/lib/index.js)`），不是 Electron 主进程，因此无法使用 `WebContentsView` 之类的主进程嵌入能力。
- `chat.deepseek.com` 返回 `Content-Security-Policy: frame-ancestors 'none'`，任何 iframe 都无法嵌入。

### 其他

- **必须同时安装托盘应用**。插件自身不驱动浏览器；`BubbleAsk.exe` 未安装或未启动时，「发送到 DeepSeek」会失败并说明原因，「只准备」与「复制全文」仍然可用。
- **平台限定 Windows**。通信走 Windows 命名管道，托盘应用是 WinForms 程序。macOS/Linux 上的 DSH 可以装本插件，但自动发送不可用。
- 原生窗口是独立 OS 窗口，不会嵌入 DSH 窗口内部；它需要与 DSH 并排摆放。
- `?q=` 传参不可靠（实测）：请求行超过 8KB 时返回 `414`（纯 ASCII 8029 字节通过，8329 字节失败）；长 prompt 生成的约 7K URL 还会稳定返回 `429`。插件因此不依赖 URL 传参（预填退路由托盘应用内部处理）。
- 选区取自 DSH 页面；插件无法读取外部窗口内的选区（跨进程）。
- 若 `lib/ask-client.mjs` 缺失，「发送到 DeepSeek」会明确报模块未就绪，面板与复制链路仍然可用。
- 同一时刻只允许一个操作：插件的发送与托盘自身的全局热键共用同一把 `TryBeginOperation` 锁，并发请求会被拒绝并提示稍后重试。
