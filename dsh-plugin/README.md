# Bubble Ask（DSH 插件）

将 [Bubble Ask](../README.md) 的划词提问能力移植到 DeepSeek Harness：在会话中选中文本并点击气泡后，插件将「精简会话轨迹 + 选中文本 + 问题」注入 DeepSeek 网页版，由其解释该文本在当前会话上下文中的含义。

与桌面端的主要差异：

| | 桌面端（`BubbleAsk.exe`） | 本插件（DSH） |
| --- | --- | --- |
| 使用范围 | 任意程序、任意时刻 | 仅限会话过程中，且上下文即当前会话 |
| 提问内容 | 模板中的问题文本（默认「什么是 %s」） | 每次附带精简会话轨迹，因此始终具备上下文 |
| 窗口 | 自行启动 `--app` 浏览器窗口 | 优先使用 DSH 右侧栏内嵌浏览器（`Ctrl+T`），不额外开窗 |

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
# {"ok":true,"cdpReady":true,"browsers":["..."],...}   未安装时返回 404
```

## 用法

1. 在会话中选中任意一段文本（回答、工具输出或自行输入的内容均可）。
2. 选区下方出现「💬 问这段」气泡。
3. 点击气泡后选择一种处理方式：
   - **在侧边栏打开**（默认）：在右侧栏浏览器中打开 DeepSeek，并将完整提问写入输入框，确认或修改后按回车提交。写入通过 `<webview>.executeJavaScript()` 完成（原生 setter + `input` 事件），不依赖 URL 传参。
   - **自动发送**：由 Host 启动独立 Chromium 实例（`--app` + CDP），注入提问并点击发送；仅当回读确认输入框被清空时判定发送成功。
4. 气泡内可填写自定义问题；留空时注入的默认问题为「请解释这段文字在当前会话上下文中的含义。」（输入框占位符的措辞为「解释它在当前上下文中是什么意思」，与注入内容含义一致）。

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
index.js              Host 端：HTTP 路由、轨迹精简、prompt 拼装
client.js             Client 端：选区气泡（shell.overlay）、会话 id 探针（conversation.input.dock）
lib/deepseek-web.mjs  CDP 驱动（移植自桌面端 ChatDriver / CdpClient，惰性加载）
cordis.patch.yml      插入 bubble-ask 条目
```

## HTTP 路由

路由同源，且仅监听本机：

| 路由 | 作用 |
| --- | --- |
| `POST /bubble-ask/prompt` | `{sessionId, selection, question}` → `{prompt, url, stats}` |
| `POST /bubble-ask/send` | 同上，但会实际注入网页版并发送 |
| `GET /bubble-ask/health` | 自检：CDP 模块是否就绪、检测到的浏览器、最近的自检记录 |
| `POST /bubble-ask/diag` | Client 端上报自检记录（最多保留 40 条），可通过 `/health` 的 `diag` 字段读取 |

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖该条目的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `chatUrl` | `https://chat.deepseek.com/` | 网页版地址 |
| `maxMessages` | `12` | 轨迹包含的消息条数上限 |
| `maxCharsPerMessage` | `240` | 单条消息的截断长度 |
| `maxTraceChars` | `2600` | 整段轨迹的字数上限 |
| `traceMode` | `relevance` | 轨迹挑选策略：`relevance` 按与选区的相关性挑选，`recent` 仅取最后若干条 |
| `recentTail` | `3` | `relevance` 模式下固定保留的末尾消息条数 |
| `maxToolEntries` | `2` | 进入轨迹的工具结果条数上限（作为证据，仅在其覆盖选区时纳入） |
| `toolMinCoverage` | `0.12` | 工具结果覆盖选区的最低比例，达到该比例才进入轨迹 |
| `minAssistantChars` | `60` | 助手正文短于该长度且不含路径、错误或决策时，视为过程性叙述，不进入轨迹 |
| `browserPath` | 空 | 自动发送所用的浏览器可执行文件；留空则自动检测 |
| `cdpPort` | `9333` | CDP 端口 |
| `profileDir` | 空 | 登录状态目录；留空使用 `%APPDATA%\BubbleAsk\edge-profile` |
| `autoSend` | `true` | 是否自动点击发送 |
| `readyTimeoutMs` | `60000` | 等待网页版输入框的时间预算；冷启动（新 profile 或刚完成登录）实测超过 25 秒，故设为 60 秒 |

## 已知限制

- 侧边栏写入依赖 Electron `<webview>` 元素的 `executeJavaScript()`，要求该元素与本插件位于同一渲染进程。浏览器侧（Web 版 DSH）不具备该能力：侧边栏退化为 iframe，只能通过剪贴板回退。
- `chat.deepseek.com` 返回 `Content-Security-Policy: frame-ancestors 'none'`，任何 iframe 均无法嵌入。侧边栏之所以可以显示，是因为 Electron 使用独立的 guest 进程而非 iframe。
- `?q=` 传参不可靠（实测）：请求行超过 8KB 时返回 `414`（纯 ASCII 8029 字节通过，8329 字节失败）；更重要的是，长 prompt 生成的约 7K URL 会稳定返回 `429`，等待 3 分钟、单次请求、去除换行均无改善，而 `?q=test` 始终返回 200。因此 `?q=` 仅在 prompt 编码后不超过 3000 字符时使用，更长的提问改为「打开网页并直接写入输入框」。
- 网页版 `?q=` 仅预填，不自动发送（`autosend=1` 不受支持）。
- 选区取自 DSH 页面；插件无法读取侧边栏 webview 内部的选区（跨进程）。
- 自动写入后若页面尚未渲染完成，插件最多轮询 40 秒；仍失败时回退为「完整提问写入剪贴板并显示全文」。
