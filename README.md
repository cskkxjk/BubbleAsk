# Bubble Ask

<img src="assets/brand-256.png" width="96" align="right" alt="Bubble Ask">

Windows 平台的划词问答工具。在任意程序中选中文本（或框选屏幕区域）并触发全局热键，程序在鼠标位置显示问答窗口，将内容直接提交给所选网页版 AI（默认 DeepSeek，也支持千问、豆包、ChatGPT、Gemini、Grok），或经 API 模式直连模型。

支持两种运行模式，安装后可在设置中切换：

| 模式 | 实现方式 | 适用场景 |
| --- | --- | --- |
| **网页版**（默认） | 驱动本机 Chromium 内核浏览器打开所选服务方（DeepSeek / 千问 / 豆包 / ChatGPT / Gemini / Grok），复用登录状态 | 不希望消耗 API 额度；需要网页版能力 |
| **API** | 直连 OpenAI 兼容接口，回答以流式方式显示在自绘窗口 | 非浏览器场景；需要更换模型；需要多轮追问 |

## 项目组成

本仓库包含三个相互独立的交付物，三者可以只用其中一个。

| | 桌面端 | DSH 插件 | Chrome 扩展 |
| --- | --- | --- | --- |
| 产物 | `dist\BubbleAsk.exe`（一个可执行文件，托盘界面 + 可选的后台服务身份），C# 5 / WinForms / .NET Framework | [`dsh-plugin/`](dsh-plugin/README.md)（Node 包，分 Host 与 Client 两部分） | [`chrome-extension/`](chrome-extension/README.md)（MV3 扩展） |
| 运行环境 | Windows 桌面，任意程序 | DeepSeek Harness 会话 | Chrome / Edge 浏览器 |
| 触发方式 | 全局热键与托盘常驻 | 选中文本后弹出的「💬 问这段」气泡 | 任意网页划词弹出的「问这段」气泡；或工具栏图标、`Ctrl+Shift+Y` |
| 上下文 | 选中的文字 / 截图 | 精简会话轨迹 | 当前网页的结构与文字 |
| 依赖条件 | Chromium 内核浏览器（网页版）或 API Key | 已安装 DSH，且已安装并启动桌面端（切到非 DeepSeek 需桌面端 2.1.0+） | 无（复用浏览器自身的网页版登录） |

桌面端是本仓库唯一的 CDP 实现（`ChatDriver.cs` / `CdpClient.cs`）。插件不再移植一份，而是通过本地命名管道调用桌面端，两边共用同一份持久化登录 profile —— 装一次、登一次即可。

因此使用插件需要先装桌面端：**先构建并启动 `BubbleAsk.exe`，再安装插件。** 仅使用桌面端时无需安装插件；插件在桌面端未运行时仍可整理上下文与复制全文，只是无法自动发送。

Chrome 扩展是唯一的例外：它不依赖桌面端，也不依赖任何本地服务 —— 它在自己的沙箱里采集页面，再把提问交给一个真实打开的所选服务方标签页（默认 DeepSeek，也可选千问 / 豆包 / ChatGPT / Gemini / Grok；所以直接用你浏览器里已登录的账号）。为什么不能像普通侧边栏那样用 iframe 内嵌，见 [chrome-extension/README.md](chrome-extension/README.md#为什么要单开窗口而不是在页面里嵌一个-iframe)。

## 功能

桌面端能力按通用、网页版、API 与设置四部分说明；插件形态见后文安装章节与 [dsh-plugin/README.md](dsh-plugin/README.md)。

### 通用

- 托盘常驻；双击托盘图标打开设置，右键菜单提供设置、提问、日志与退出。图标可能被折叠到通知区域的「^」中，拖出后固定即可。
- 三个可配置的全局热键：
  - `Ctrl+Alt+D` 唤起/收起：窗口位于前台时再次触发将其关闭，否则前置或启动。
  - `Ctrl+Alt+Q` 取词提问：模拟 `Ctrl+C` 获取当前选区，套用模板后发送。
  - `Ctrl+Alt+A` 截图提问：全屏拖框选区，将截图与问题一并发送。
- 取词前备份剪贴板内容，取词后还原；超长文本从中部省略。
- 截图：全屏遮罩拖框，松开即截；`Esc`、右键或单击均可取消（`Esc` 为全局注册，遮罩未获得焦点时同样有效）。
- 开机自启（可选）：仅写入当前用户的 `Run` 键，无需管理员权限。

### 网页版

- 支持 6 家网页版服务方：DeepSeek、千问（Qwen）、豆包（Doubao）、ChatGPT、Gemini、Grok；在设置中切换，默认 DeepSeek。
- 以 `--app` 模式启动无地址栏窗口，使用独立 profile；每家服务方首次使用登录一次，之后长期有效。
- 通过 CDP 写入输入框、派发事件并点击发送，不依赖页面 CSP，也无需安装扩展；普通 `textarea` 与富文本编辑器（contenteditable）都支持。
- 国际服务方（ChatGPT / Gemini / Grok）需要本机网络能访问对应站点；千问、豆包大陆可直连。
- 截图通过文件上传通道处理：使用 CDP 将 PNG 直接写入页面的 `input[type=file]`，不经过剪贴板，且不要求窗口具有焦点；未找到上传入口时回退为剪贴板粘贴。
- 浏览器按 Edge → Chrome → Brave → Vivaldi → Opera → Chromium 的顺序自动检测，也可在设置中指定。

### API

- 回答以流式方式逐字显示在鼠标附近的气泡中，支持多轮追问，历史按 `user/assistant` 顺序提交。
- 支持推理模型：先以灰色文本显示思考内容，正文到达后切换。
- 内置 DeepSeek 官方、OpenAI、硅基流动、本地 Ollama 与自定义五类服务方预设，选择预设后自动填充地址与模型名。

### 设置

- 设置窗口由左侧导航与右侧表单组成，覆盖模板、运行模式、网页版服务方、截图提示词、自动发送、字数上限、窗口与气泡尺寸、置顶、热键、浏览器与 profile、调试端口及 API 参数。

## 构建与运行

构建不依赖 .NET SDK，使用系统自带的 .NET Framework 编译器：

```powershell
# 构建（产出一个可执行文件 + 一个自测程序）
powershell -ExecutionPolicy Bypass -File .\build.ps1

# 构建并运行自测（生成 dist\selftest\*.png 截图）
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test

# 启动托盘界面
.\dist\BubbleAsk.exe
```

构建产物：

| 文件 | 作用 |
| --- | --- |
| `dist\BubbleAsk.exe` | 无参运行 = 托盘界面（热键、设置、气泡、截图）；`--service` 运行 = 无界面后台服务（独占 CDP 引擎与浏览器窗口） |
| `dist\BubbleAsk.Tests.exe` | 无界面自测 |

> **一个文件，两种身份。** 后台服务不是第二个 exe，而是同一个 `BubbleAsk.exe` 带 `--service` 参数运行（单实例靠互斥锁，不是靠文件名）。服务不需要手动启动 —— 托盘或 DSH 插件需要时会自动拉起它；`--service` 进程会静默退出而不是弹窗，正常使用中你只需双击 `BubbleAsk.exe`。

首次启动后的配置步骤：

1. 托盘区域出现「问」图标。
2. **网页版**：在设置 →「窗口与网页」选择服务方（默认 DeepSeek），按 `Ctrl+Alt+D` 启动浏览器窗口并完成一次登录，此后长期有效；切换服务方后各自登录一次即可。
3. **API**：托盘菜单 →「设置…」→ API 页签，选择服务方、填写 Key 并确认模型名。
4. 在任意程序中选中文本后按 `Ctrl+Alt+Q`，或按 `Ctrl+Alt+A` 框选屏幕区域。

服务的启动与退出（引用计数式）：

| 场景 | 服务 |
| --- | --- |
| 只开 DSH（插件未装或未启用） | 不启动 |
| DSH + 插件 / 托盘 / 两者都开 | 启动并常驻（各持一条租约） |
| 退出其中一个入口 | 不退出（还有别的入口） |
| 最后一个入口退出 | 等 8 秒宽限期，期间有新入口则取消退出 |
| 服务退出时浏览器窗口还开着 | 窗口保留，下次启动自动接回 |

服务目前**没有**注册开机自启；它由第一个需要它的客户端拉起。

## DSH 插件：安装与验证

插件将划词提问能力引入 DeepSeek Harness：在会话中选中文本并点击「💬 问这段」后，插件将「精简会话轨迹 + 选中文本 + 问题」注入所选网页版（气泡里的「发到」下拉可选 DeepSeek / 千问 / 豆包 / ChatGPT / Gemini / Grok，默认 DeepSeek，并记忆上次选择）。服务方的导航、注入与发送仍由桌面端按同一个 provider 完成；选择非 DeepSeek 需要桌面端 2.1.0 或更高版本，旧桌面端下下拉只提供 DeepSeek。注入内容、与桌面端的差异及限制见 [dsh-plugin/README.md](dsh-plugin/README.md)。

`dsh-plugin/` 为标准 DSH 组合包，`package.json` 同时声明：

- `dsh.bundle.patch`：自带 `cordis.patch.yml`，安装后增加 `bubble-ask` 条目；
- `dsh.client`：浏览器侧实现，平台为 `web`。

因此安装过程无需修改源码，也无需构建。

### 前置条件

- 已安装 DSH，且其 Web 界面可正常打开（侧栏存在「插件」入口）。
- 「发送到 <服务方>」路径要求：本机已安装 Chromium 内核浏览器（Edge / Chrome / Brave / Vivaldi / Opera / Chromium），并已在对应服务方网页版登录（默认 DeepSeek，可在气泡「发到」下拉切换到千问 / 豆包 / ChatGPT / Gemini / Grok）。选择非 DeepSeek 需要桌面端为 2.1.0+；旧桌面端会忽略 `provider` 字段，插件下拉只提供 DeepSeek（不会把内容发到非 DeepSeek 站点）。仅使用「复制提问」时无此要求。

### 方式一：界面安装（桌面版推荐）

1. 在侧栏选择「插件」。
2. 点击右上角「添加插件」，或展开箭头菜单选择「安装第三方插件」。两个入口打开同一对话框。
3. 在输入框中填写安装来源（spec），支持以下形式：
   - **本地目录（推荐）**：填写本仓库中 `dsh-plugin` 目录的绝对路径，例如 `<仓库路径>\dsh-plugin`。
   - **压缩包**：执行 `Compress-Archive -Path .\dsh-plugin -DestinationPath .\dsh-plugin.zip`，填写生成的 zip 文件绝对路径。
   - **包名**：仅在发布至 npm 后可用。当前 `package.json` 标记为 `private: true`，尚未发布，填写包名会失败。
   - **Git 子目录**：见方式二。
4. 点击「安装」，等待 pnpm 执行结束。安装完成后按提示重启 DSH。
5. 按下方「验证」一节确认结果。

### 方式二：从远程仓库安装（本机尚无仓库副本）

插件位于仓库的 `dsh-plugin/` 子目录，因此 Git 安装必须带上子目录片段 `#path:/dsh-plugin`：

```text
github:<owner>/<repo>#path:/dsh-plugin
```

把它填进「添加插件」对话框即可（完整的 `git+https://…` 形式同样接受）。pnpm 会下载整个仓库、只安装该子目录，并在 profile 的 `package.json` 中记为 `github:<owner>/<repo>#path:/dsh-plugin`，`pnpm-lock.yaml` 里锁到当时的 commit。

> **不要直接填仓库根地址**（例如 `https://github.com/<owner>/<repo>.git`）。插件不在仓库根目录，pnpm 会把根目录当成一个包，装出名为 `<repo>.git@0.0.0` 的空壳，插件页无法识别。

两种来源的差异：

| 来源 | profile 中的记录 | 更新方式 | 仓库目录可否移动 |
| --- | --- | --- | --- |
| 本地目录（方式一） | `link:<本机路径>` | `git pull` 后立即生效 | 移动即失效，需重新安装 |
| Git 子目录（本节） | `github:<owner>/<repo>#path:/dsh-plugin` | 卸载后重新安装（已锁定 commit） | 与本机目录无关 |

若希望保留「改代码即生效」的语义，先 `git clone` 仓库，再按方式一填写本地目录。

### 方式三：命令行安装（非 desktop profile）

```powershell
dsh plugin --profile <profile 名> add "<仓库路径>\dsh-plugin"
dsh plugin --profile <profile 名> add "github:<owner>/<repo>#path:/dsh-plugin"
```

`dsh plugin` 将参数原样转发给 profile 目录中的 pnpm，因此两种来源都可用。`desktop` profile 的启动类命令（如 `--dump-config`）由桌面应用独占：

```text
error: profile "desktop" is managed exclusively by the Electron application
```

但 `plugin` 子命令不受此限制，可直接写入 `desktop` profile；安装后由桌面应用热加载。

### 验证

**插件页**：「已安装」列表中应出现「划词提问（Bubble Ask）」。

**服务端自检**，将 `<DSH 端口>` 替换为界面地址栏中的实际端口：

```powershell
curl.exe -s http://127.0.0.1:<DSH 端口>/bubble-ask/health
```

安装成功时返回 `{"ok":true,"cdpReady":true,"app":{"connected":true,"app":"2.3.0","providers":["deepseek","qwen",...],"providerSwitchable":true,...},...}`；未安装时该路径返回 404（本机实测）。`cdpReady` 表示托盘应用已连通且协议版本一致；`providerSwitchable` 为 `true` 时气泡「发到」下拉可切换 6 家，桌面端低于 2.1.0 时只提供 DeepSeek。

**功能验证**：在会话中选中一段回答，选区下方出现「💬 问这段」气泡；点击「复制提问」后，完整提问应已复制到剪贴板，气泡里显示「已复制 N 字」。桌面端 2.1.0+ 时，气泡「发到」下拉应列出 DeepSeek / 千问 / 豆包 / ChatGPT / Gemini / Grok；选一家发送后桌面端日志应出现对应 provider 名称与导航目标。

### 安装排查

- 插件页存在条目但未生效：检查 profile 的 `cordis.patch.yml`，该条目的启用状态记录于此（插件页开关写入该文件）。
- `health` 返回 `cdpReady:false`：托盘应用未连通。检查它是否在运行（托盘是否有图标）、`%APPDATA%\BubbleAsk\ipc.json` 是否存在，以及插件与桌面端的协议版本是否一致（版本不一致时 `app.stage` 为 `version`）。
- `app.providers` 缺失/为 `null` 或 `providerSwitchable:false`：桌面端仍是 2.0.x（或未启动）。升级到 2.1.0+ 后无需重启 DSH，下一次发送前会自动重新校验；旧桌面端下气泡下拉只显示 DeepSeek。

### 卸载与更新

- 卸载：插件页 → 对应组合包 → 卸载（需确认）；或 `dsh plugin --profile <profile 名> remove dsh-plugin-bubble-ask`。
- 更新：
  - 本地目录（`link:`）安装：`git pull` 后即生效，无需重装。
  - Git 子目录安装：已锁定 commit，需卸载后按方式二重新安装。
  - 第三方插件不提供版本选择器，插件页的「更新」只对官方按需插件提供。

### 使用 agent 安装（prompt 示例）

以下文本可整体提交给 agent，提交前把尖括号占位符替换为本机的实际路径：

```text
将 BubbleAsk 的 DSH 插件安装到本机的 DeepSeek Harness，并验证安装结果。

仓库：<本仓库在本地的工作目录>
插件目录：<该仓库中 dsh-plugin 目录的绝对路径>
该目录是标准 DSH 组合包（package.json 中声明了 dsh.bundle.patch 与 dsh.client），无需构建。

步骤：
1. 定位 DSH：$env:DSH_HOME（默认 %USERPROFILE%\.dsh）、$env:DSH_PROFILE_DIR，
   以及 dsh CLI（通常位于 <DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd）。
2. 首先尝试命令行安装：dsh plugin --profile <profile 名> add "<插件目录绝对路径>"
   仓库尚未克隆时改用 Git 子目录形式：add "github:<owner>/<repo>#path:/dsh-plugin"
   —— 必须带 #path:/dsh-plugin；直接用仓库根地址会装出 <repo>.git@0.0.0 的空壳，插件页识别不了。
   若两条命令都报 "profile ... is managed exclusively by the Electron application"：
   不要绕过该限制，也不要通过手改 profile 的 cordis.patch.yml 伪造安装；
   改为告知我界面操作步骤（侧栏「插件」→「添加插件」→ 填上面的 spec → 安装 → 重启 DSH），
   待我确认后继续验证。
3. 验证：
   - curl.exe -s http://127.0.0.1:<DSH 界面端口>/bubble-ask/health 返回 {"ok":true,...}（未安装时 404）；
   - 插件页「已安装」中出现「划词提问（Bubble Ask）」；
   - 说明验证方式：会话中选中一段文本，点击「💬 问这段」。
4. 任一步骤失败：回退所执行的改动（卸载该插件、恢复 package.json 与 cordis.patch.yml），
   并原样给出报错信息，不要推测原因。
5. 安装来源是本地目录时，报告最终写入 profile 的 dependency spec（link: 或 github:）及其更新语义。
6. 不要修改仓库源码，不要改动 dist\ 下的桌面端产物，不要修改 DSH 中与本插件无关的配置。
```

## Chrome 扩展：安装与使用

把**当前网页**当作上下文，在右侧独立窗口里用所选服务方网页版提问（DeepSeek / 千问 / 豆包 / ChatGPT / Gemini / Grok，默认 DeepSeek），复用浏览器已有的登录态，不需要 API Key，也不依赖桌面端。

### 安装

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本仓库的 `chrome-extension/` 目录（或解压后的分发包目录）。
3. 首次使用时右侧窗口会打开所选服务方（默认 DeepSeek），登录一次即可长期有效；浏览器里已登录的服务方无需再次登录。

### 使用

- **选择服务方**：在工具栏弹窗里选 DeepSeek / 千问 / 豆包 / ChatGPT / Gemini / Grok，记住选择并作为气泡的默认服务方。
- **划词提问**（主用法）：任意网页选中一段文字 → 选区旁浮出「问这段」气泡 → 点它即把「页面上下文 + 这段文字 + 默认问题」发到当前所选服务方的右侧窗口。
- 点工具栏图标：弹窗显示页面规模与选中文字，填问题后「发送到服务方」。
- 快捷键 `Ctrl+Shift+Y`：直接以默认问题提问。
- 「复制提问」把含完整上下文的提问复制到剪贴板。

> 1.0 → 1.1 新增了划词气泡，因此多了 `<all_urls>` 主机权限：Chrome 出于安全会自动禁用扩展并要求确认，在 `chrome://extensions` 重新启用即可。气泡只在选中文字后出现，点它才读页面，不点不读。1.2 起支持多服务方，未新增主机权限。

### 为什么不是页内 iframe 侧栏

`chat.deepseek.com` 返回 `Content-Security-Policy: frame-ancestors 'none'`，且登录 cookie 是 `SameSite=Strict` —— 跨站 iframe 既渲染不出来、也带不上登录态。所以侧边窗口是真实的所选服务方标签页（无地址栏弹窗，贴屏幕右侧；以 DeepSeek 为例，其他服务方同理），这也正是它能"免登录"的原因。细节与采集范围见 [chrome-extension/README.md](chrome-extension/README.md)。

## 打包分发包

```powershell
powershell -ExecutionPolicy Bypass -File .\pack.ps1
powershell -ExecutionPolicy Bypass -File .\pack.ps1 -SkipBuild   # 复用已有 dist
```

产物落在 `packages\`，三个交付物各一个 zip：

| 包 | 内容 | 用法 |
| --- | --- | --- |
| `BubbleAsk-desktop-<ver>.zip` | `BubbleAsk.exe` + 用法说明 | 解压后双击运行（单文件，无需其他文件） |
| `BubbleAsk-dsh-plugin-<ver>.zip` | 插件完整目录 | 作为 DSH 插件的安装来源（本地目录或解压后的路径） |
| `BubbleAsk-chrome-extension-<ver>.zip` | 扩展完整目录 | 解压后「加载已解压的扩展程序」 |

版本号由脚本从各交付物的真实来源读取（`IpcContract.cs` 的 `AppVersion`、`package.json`、`manifest.json`），不手写。

## 配置

配置文件位于 `%AppData%\BubbleAsk\config.json`，也可在托盘菜单 →「设置…」中修改。常用项：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `Mode` | `web` | `web` 网页版 / `api` 直连接口 |
| `WebProvider` | `deepseek` | 网页版服务方：`deepseek` / `qwen` / `doubao` / `chatgpt` / `gemini` / `grok` / `custom` |
| `PromptTemplate` | `什么是%s` | `%s` 为选中的文本 |
| `ShotPrompt` | 这张截图里是什么？请解释一下。 | 截图提问时附带的问题，不使用 `%s` |
| `AutoSend` | `true` | 关闭后仅填入不发送（网页版）/ 仅粘贴截图不发送 |
| `MaxChars` | `2000` | 超长内容从中部省略 |
| `HotkeySummon` / `HotkeyAsk` / `HotkeyShot` | Ctrl+Alt+D / Q / A | 格式如 `Ctrl+Shift+F2` |
| `ChatUrl` | chat.deepseek.com | 自定义服务方（`WebProvider=custom`）时打开的地址；预设服务方忽略此项 |
| `WindowWidth` / `WindowHeight` | 480×720 | 网页版窗口尺寸 |
| `TopMost` | `true` | 网页版窗口置顶 |
| `BrowserPath` | 空 | 浏览器可执行文件路径；留空则自动检测（Edge → Chrome → Brave → Vivaldi → Opera → Chromium） |
| `ProfileDir` | 空 | 登录数据目录；留空则按浏览器分别存储（Edge 使用 `edge-profile`，其余使用 `profile-<名称>`） |
| `CdpPort` | `9333` | 本机调试端口；冲突时可修改 |
| `ApiProvider` | `deepseek` | `deepseek` / `openai` / `siliconflow` / `ollama` / `custom` |
| `ApiBaseUrl` | `https://api.deepseek.com` | OpenAI 兼容地址，自动补全 `/v1/chat/completions` |
| `ApiKey` | 空 | 仅保存在本机该文件中 |
| `ApiModel` | `deepseek-chat` | 模型名 |
| `ApiMaxTokens` | `2048` | 单次回答上限 |
| `ApiSystemPrompt` | 见默认值 | 每轮对话开头的系统提示词 |
| `BubbleWidth` / `BubbleMaxHeight` | 460 / 560 | 气泡宽度与最大高度，内容增多时自动增高 |
| `ShowBubble` | `true` | 气泡跟随鼠标出现；取消勾选则屏幕居中 |
| `StartWithWindows` | `false` | 开机自启（写入当前用户 `Run` 键，设置页可勾选） |

## 实现原理

```text
热键 → 取词 / 截图
  ├─ 网页版（DeepSeek / 千问 / 豆包 / ChatGPT / Gemini / Grok，设置中切换）
  │    浏览器 --app（独立 profile，每家首次登录一次）
  │    └ CDP：写入输入框 → 按服务方规则点击发送 / 回车兜底
  │          截图：setFileInputFiles 写入 file input（无上传入口时回退剪贴板粘贴）
  │          发送未获确认 → 回退为 ?q= 预填链接（仅填入不发送；仅当填入/点击本身失败才回退）
  └─ API
       POST {base}/v1/chat/completions，stream=true → 逐段 SSE
       └ 自绘气泡：流式显示 + 多轮追问
             截图：转为 data URL 一并提交
```

主要设计取舍：

- **不内嵌 Chromium**：直接驱动本机已有的浏览器，避免分发浏览器运行时，并复用现有登录状态。Edge、Chrome 等 Chromium 内核浏览器共用同一套 `--app` 与 CDP 逻辑，因此均可支持。
- **使用 CDP 而非页面脚本**：不受页面 CSP 与 Trusted Types 限制，无需注入用户脚本或安装扩展。
- **应用窗口隔离**：使用独立 profile，并在启动参数中加入 `--disable-sync --disable-extensions`，避免浏览器账号同步日常扩展、或在页面中注入脚本干扰输入框写入。
- **截图不经过剪贴板**：通过 `DOM.setFileInputFiles` 直接提交文件，既不需要窗口焦点，也不会覆盖剪贴板内容。
- **两种模式独立实现**：网页版不消耗 API 额度但受限于浏览器；API 模式跨应用可用并支持追问，但需要自有 Key。
- **追问复用同一会话**：气泡中追加的每条消息按 `user/assistant` 顺序提交，保持上下文连续。

## 故障排查

- 日志位于 `%AppData%\BubbleAsk\app.log`，可从托盘菜单直接打开。
- **热键无响应**：通常为其他程序占用，日志中记录「热键被占用」，可在设置中更换组合。
- **网页版窗口已启动但未自动发送**：检查日志中的「注入输入框结果」「发送按钮回读」「发送校验结果」。仅当回读确认输入框被清空时判定发送成功，否则记录「没能自动发送」并提示手动回车。回退为 `?q=` 预填只在**填入或点击本身失败**时发生（状态为 `null` / `noaction` / `filllost` / `nobox`）；`pending-*`、`unverified` 这类「已点击但未确认」不回退，以免把同一句话发两遍。
- **无法获取选中文本**：目标程序不支持 `Ctrl+C`（部分 PDF 阅读器与游戏），改用 `Ctrl+Alt+A` 截图。
- **截图未发送**：检查日志中的「打开上传入口」「截图已交进文件输入框」。`none` 表示页面结构变更或该页面不支持上传，此时回退为剪贴板粘贴，并要求窗口位于前台。
- **托盘图标不可见**：展开通知区域的「^」，将图标拖至常显位置；并确认进程正在运行（任务管理器中查看 BubbleAsk）。
- **API 返回 401**：Key 无效或缺少权限，气泡中以红色文本提示。
- **API 返回 404**：地址或模型名错误；预设之外自行填写的地址需确认兼容 OpenAI 协议。
- **无法连接**：气泡显示 `连不上 http://...`，先确认该地址可从本机直连（企业网络可能拦截）。
- **端口冲突**：在设置中修改 `CdpPort`，并使用菜单「重启浏览器会话」。
- **气泡过长**：拖动标题栏移动，或调小 `BubbleMaxHeight`。
- **气泡显示「读取响应超时」**：服务端已接收请求但未发送正文。该超时由本项目实现（.NET Framework 的 `HttpClient.Timeout` 在响应头到达后失效），超时后气泡恢复可用，不会滞留在「回答中」状态。
- **未检测到浏览器或需更换浏览器**：设置 →「窗口与网页」→ 浏览器下拉框。自动检测顺序为 Edge → Chrome → Brave → Vivaldi → Opera → Chromium；登录数据按浏览器分别存储，更换后需各自登录一次。

## 项目结构

```text
src/
  shared/             两边共用的基础件（ui 与 service 都引用）
    AppConfig.cs      配置读写（容忍缺失字段）
    BrowserLocator.cs 检测本机已安装的 Chromium 内核浏览器
    ClipboardCapture.cs 取词、剪贴板、Ctrl+C/V
    PromptBuilder.cs  模板拼装（纯函数）
    Logger.cs / Json.cs
    IpcContract.cs    命名管道契约：协议版本、管道名、发现文件、连接与存活判断
    EngineClient.cs   客户端侧：按需拉起服务、发命令、持有租约
    WebProviders.cs   网页版服务方注册表（数据模型 + 查询/解析；**数据来自 shared/providers.json**）
    ProviderData.cs   读取内嵌的 shared/providers.json（唯一真源，编译时 /resource 打入）
    DriverScript.cs   读取内嵌的 shared/driver.js（页面驱动真源，同样 /resource 打入）
  engine/             网页版驱动（只编译进服务身份，ui 不得引用）
    PageScripts.cs    拼装注入脚本：driver 源码 + 服务方配置 JSON + 一次调用表达式
    EdgeHost.cs       启动、定位与置顶浏览器窗口（Edge / Chrome / Brave 等）
    CdpClient.cs      WebSocket 与 CDP
    ChatDriver.cs     网页版：按服务方注入、发送、图文、回退路径
  service/            --service 身份：唯一持有引擎的进程
    Program.cs        静默单实例、租约驱动退出、宽限期
    PipeServer.cs     管道协议：命令分发、并发闸门、进程内鉴权
    PipeHost.cs       命令实现：把管道请求翻译成 ChatDriver 调用
  ui/                 托盘身份
    Program.cs        入口与模式分派（无参=托盘，--service=服务）、异常兜底
    TrayContext.cs    托盘、菜单、热键分发、模式路由
    SettingsForm.cs   设置窗口
    HotkeyManager.cs  RegisterHotKey 封装
    ScreenCapture.cs  全屏遮罩拖框截图、临时文件清理
    ApiClient.cs      API：请求体拼装、SSE 流式解析、错误翻译
    ApiProviders.cs   服务方预设
    ApiChat.cs        API 会话：气泡生命周期与多轮对话
    AnswerBubble.cs   自绘气泡窗口（圆角、流式显示、追问、复制）
    AutoStart.cs      开机自启（当前用户 Run 键）
    IconFactory.cs / MenuStyle.cs
  tests/TestProgram.cs 无界面自测（含本地 HTTP 桩服务）
  app.manifest        DPI 感知与管理员权限声明
build.ps1             构建脚本（csc，无需 SDK）
pack.ps1              打包脚本（三个交付物各一个 zip）
docs/web-providers.md 网页版多服务方矩阵、架构与实机验证清单

dsh-plugin/           DSH 插件（Node 包）
  index.js            Host 端：轨迹精简、prompt 拼装、HTTP 路由、服务方注册表
  client.js           Client 端：选区气泡（「发到」下拉）与会话探针
  lib/ask-client.mjs  与桌面端服务的命名管道通信（可带 provider）

chrome-extension/     Chrome / Edge 扩展（MV3）
  manifest.json       权限与入口声明
  background.js       调度：采集 → 拼提问 → 交给所选服务方侧边窗口
  lib/providers.js    服务方注册表的查询函数（数据见 lib/providers.data.js，由真源生成）
  lib/prompt.js       页面上下文 → 提问文本（纯函数）
  content/collect.js  页面结构与文字采集（隔离世界执行）
  content/driver.js   生成物：shared/driver.js 的副本（页面动作由它与桌面端共用）
  content/chat-bridge.js  适配层：消息收发 + 等待重试 + 阶段判定
  popup/              工具栏弹窗（服务方选择 + 预览 + 提问 + 复制）
```

## 测试

`build.ps1 -Test` 返回 0 表示全部通过。覆盖范围：

- JSON 解析、模板拼装（含截图模板）、热键解析（含「无修饰键必须拒绝」）、配置往返（含 `BrowserPath` 与旧 `EdgePath` 迁移）
- 网页版服务方注册表：6 家 provider 完整性、默认/自定义解析、未知回退、配置往返（含 `WebProvider`）、脚本生成含服务方选择器
- 浏览器自动检测：本机识别、可执行文件名反查 id、显式路径 / 空路径的解析、按浏览器隔离 profile 目录（「不存在的路径」断言仅在未检测到任何浏览器时执行）
- 服务方预设解析、接口地址补全、请求体结构（文本 / 图片 data URL）、图片等比缩小
- SSE 增量解析、推理字段、`[DONE]`、非流式回退、HTTP 错误翻译（401 / 404 有断言，400 / 402 / 403 / 413 / 422 / 429 的分支实现存在但未被测试覆盖）
- 流中 `error` 帧抛异常、`finish_reason=length` 的截断提示、空回答报错、非流式回退被截断报错
- 针对本地桩服务执行真实流式请求（含 401 分支）
- **端到端**：`ApiChat` → 气泡 → 桩服务 → 流式落字 → 追问第二轮；服务端不发送正文时气泡显示超时并恢复可用
- 设置窗口四个页面离屏渲染、气泡流式渲染与自适应高度、托盘图标

另有面向开发的截图自检模式，不访问剪贴板也不发送请求，仅执行「遮罩 → 拖框 → 出图」：

```powershell
.\dist\BubbleAsk.Tests.exe --capture   # 框选后输出 SAVED <png>；Esc 或单击取消输出 CANCELLED
```

网页版选择器实机校准（会打开对应服务方页面，需要已登录）：

```powershell
.\dist\BubbleAsk.Tests.exe --probe qwen   # 输出候选输入框/发送按钮信息；providerId 见 docs/web-providers.md
```

## 已知限制

- 桌面端仅支持 Windows，依赖 Win32 热键、剪贴板与 Chromium 内核浏览器。
- 网页版依赖 Chromium 的 `--app` 与 CDP；浏览器大版本更新或各服务方页面改版后可能需要调整选择器。
- 网页版 6 家服务方中，除 DeepSeek 外均未在本仓库开发环境实机登录验证：选择器按公开页面特征 + 通用兜底实现，改版/风控失败时会如实报告阶段（不会谎报成功），可按 [docs/web-providers.md](docs/web-providers.md) 的清单校准。
- ChatGPT / Gemini / Grok 需本机网络可达对应站点；消费级网页版自动化可能违反服务条款、账号有被限制风险，建议仅人工触发、单次使用，重活走 API。
- 网页版取词依赖目标程序支持 `Ctrl+C`；截图上传依赖页面存在 `input[type=file]` 或可识别的上传按钮。
- Chrome 扩展只支持 Chromium 内核浏览器；`chrome://` 等内置页面、PDF 预览页与跨域 iframe 内的内容读不到。
- 三个交付物都要面对各服务方改版：DeepSeek 发送按钮按 `ds-button--primary` + `ds-button--circle` 结构化匹配，其它服务方按 provider 配置的按钮/文案规则匹配，改版后可能需要调整；失败时会如实报告阶段，不会谎报成功。
- 旧桌面端（< 2.1.0）不识别 IPC 的 `provider` 字段：DSH 插件在旧桌面端下只提供 DeepSeek；若旧桌面端配置了自定义 `ChatUrl`，气泡显示 DeepSeek 但实际仍按那个自定义入口发送（升级桌面端到 2.1.0+ 即可按服务方切换）。
- API 模式将图片重新编码为 PNG 并将长边压缩至 1400px，超长截图会损失细节。
- 沙箱或远程桌面环境可能拦截浏览器调试端口；纯 API 模式不受影响。
