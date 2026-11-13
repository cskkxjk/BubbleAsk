# 接手说明（Handover）

> 面向新维护者：项目定位、构建与自测、编码约定、架构地图、已核实的实现事实、仍影响维护的修复记录、遗留事项。
> 基线：`main` 位于发布标签 `v2.3.2`，桌面端自测 163 项通过、0 失败。
> 桌面端、DSH 插件与 Chrome 扩展均支持 6 家网页版服务方，三件产物统一版本号 2.3.2。

---

## 1. 项目定位

Windows 平台的划词问答助手：选中文本（或框选屏幕区域）→ 触发全局热键 → 在鼠标处弹出提问卡片 → 把内容提交给所选网页版 AI（默认 DeepSeek）。

仓库包含三个独立交付物：

| 交付物 | 位置 | 说明 |
| --- | --- | --- |
| 桌面端 | `src/`、`build.ps1`、`dist/` | 本文档主要描述的对象 |
| DSH 插件 | `dsh-plugin/` | 独立 Node 包；文档见 `dsh-plugin/README.md` |
| Chrome 扩展 | `chrome-extension/` | 独立 MV3 扩展，不依赖桌面端；文档见 `chrome-extension/README.md` |

桌面端支持两种运行模式：

| 模式 | 实现 | 代价 |
| --- | --- | --- |
| `web`（默认） | 驱动本机 Chromium 内核浏览器（Edge / Chrome / Brave / Vivaldi / Opera / Chromium），`--app` + 独立 profile + CDP | 复用网页登录状态，不消耗 API 额度；依赖页面结构 |
| `api` | 直连 OpenAI 兼容 `/chat/completions`，SSE 流式，气泡由 WebView2 承载 `src/web/answer.html`，支持追问 | 需要 Key；跨应用可用，不依赖浏览器 |

**技术栈**：C# 5 / WinForms / .NET Framework 4.8.1，由 `csc.exe` 直接编译。仓库中没有 `.sln` 与 `.csproj`。

---

## 2. 构建与自测

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1          # 编译一个 exe + 一个自测程序
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test    # 编译并自测，全部通过返回 0
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Clean   # 先清理 dist
```

- 编译器：`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，选项为 `/langversion:5 /warn:4 /codepage:65001`。
- 构建前置条件：`third_party/webview2/` 下需要 `Microsoft.Web.WebView2.Core.dll`、`Microsoft.Web.WebView2.WinForms.dll`、`WebView2Loader.dll`，缺一个 `build.ps1` 就报错退出；构建完成后三个 DLL 被拷到 `dist/`，必须与 exe 同目录。
- 产物：`dist\BubbleAsk.exe`（32 个源文件：shared 12 + engine 4 + service 3 + ui 13 一起编译）、`dist\BubbleAsk.Tests.exe`（33 个源文件：再加 `tests/TestProgram.cs`）、`dist\selftest\*.png`。
- 内嵌资源：`shared/providers.json`、`shared/driver.js`、`assets/brand-256.png`、`chrome-extension/tools/art/whale.png`、`src/web/answer.html`，全部用 `csc /resource:` 打进 exe，运行时不落文件。
- 一个 `BubbleAsk.exe` 承担两种身份：无参启动是托盘界面，`--service` 启动是无界面后台服务。托盘用互斥锁 `BubbleAsk.SingleInstance.9F3A`，服务用互斥锁 `BubbleAsk.Service.SingleInstance.4C81`。
- `build.ps1` 末尾有一道 Lint：若 `src/ui/*.cs` 出现 `ChatDriver` / `CdpClient` / `EdgeHost` 字样即失败。一个 exe 之后编译器不再天然阻止 ui 直接 new 引擎对象，改用这条静态检查拦住。

### 2.1 环境注意事项：`%TEMP%` 不可写导致自测中断

自测会在 `%TEMP%` 下创建 `bubbleask-test-<guid>` 目录存放临时配置。若该进程无法在 `%TEMP%` 创建目录，自测会以未捕获异常终止，表现为：

- 进程退出码 `-532462766`（`0xE0434352`，未处理的托管异常），控制台打印「由于 Exception.ToString() 失败，因此无法打印异常字符串」；
- 事件日志「应用程序错误」中异常代码为 `0xe0434352`，WER 记录 `CLR20r3`、`P9: System.UnauthorizedAccess`；
- 输出停在 `PASS profile override wins` 之后。

已验证的规避方式：把 `TEMP` / `TMP` 指向工作区内可写目录后运行自测。

```powershell
$env:TEMP = Join-Path (Get-Location) '.tmp-selftest\temp'   # .tmp-*/ 已被 .gitignore 忽略
$env:TMP  = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test    # 全部通过，输出 ALL PASS
```

该现象属于运行环境差异（同一可执行文件放在 `%TEMP%` 内运行时可正常创建目录），与源码无关；排查时先排除这一点，避免误判为配置读写缺陷。

### 2.2 自测桩服务与注意事项

`TestProgram.cs` 末尾的 `StubServer` 是最小 TCP HTTP 服务，支持第 4 个参数 `stallMs`：先返回响应头，随后等待，最后写入正文，用于构造「服务端已接收请求但不发送正文」的场景。这是验证读超时看门狗的唯一手段。

三个易错点：

1. **测试用原生界面**：自测置 `AnswerBubble.ForceNativeUi = true`，正文由 WinForms 渲染并回显「你： <问题>」。断言气泡文案时，提问中不得包含待匹配的关键字，否则 `WaitUntil` 会立即判定通过。此前曾因此误判一次。
2. **位置写回**：自测置 `AnswerBubble.PersistPosition = false`，避免离屏测试窗口的坐标写入用户配置。新增窗口或气泡测试时保持这一设置。
3. 渲染自检使用 `EM_FORMATRANGE` 单独绘制 RichTextBox（无边框窗口下 `DrawToBitmap` 无法绘制正文）。移除该实现后截图为空白。

手动验证截图遮罩（不访问剪贴板、不发送请求）：

```powershell
.\dist\BubbleAsk.Tests.exe --capture   # 输出 SAVED <png>；取消时输出 CANCELLED（退出码 2）
```

---

## 3. 编码约定

- **C# 5**：不可使用 `$""`、`?.`、`nameof`、表达式体成员、自动属性初始化器、`out var`。
- 界面文案与注释统一使用中文，一句一个意思；私有字段以下划线 `_` 为前缀；显式声明类型；匿名方法使用 `delegate {}`；异常捕获后写入 `Log`。
- 新增配置字段需同步修改：`AppConfig.LoadFrom`、`SaveTo`、`SettingsForm.LoadValues` / `SaveAndClose`、`TestConfigRoundTrip`。删除字段时同步清理 `SettingsForm` 中对应的控件与测试断言。
- 线程模型：界面为单线程；网络与浏览器操作在 `Task.Run` 中执行；返回界面线程统一通过 `AnswerBubble.Post`（内部使用 `BeginInvoke`）。
- 编译选项为 `/warn:4`，未启用 `/warnaserror`，但应保持零警告。

---

## 4. 架构地图

源码按职责分组在 `src/<group>/`，分组只影响构建与阅读，不影响运行期行为：

```text
src/shared/    纯工具，界面与引擎都要
  Json.cs                JavaScriptSerializer 薄封装
  Logger.cs              日志（%AppData%\BubbleAsk\app.log，超过 1MB 时删除重建）
  AppConfig.cs           配置读写（%AppData%\BubbleAsk\config.json）
  BrowserLocator.cs      检测本机已安装的 Chromium 内核浏览器（注册表与常见路径）
  ClipboardCapture.cs    Ctrl+C 取词（含剪贴板备份与还原）、Ctrl+V 粘贴、图片入剪贴板
  PromptBuilder.cs       模板拼装（纯函数）
  WindowPlacement.cs     窗口摆放规则：默认位置、越界夹回工作区、读取保存的位置
  ProviderData.cs        读取内嵌的 shared/providers.json
  DriverScript.cs        读取内嵌的 shared/driver.js
  WebProviders.cs        服务方数据模型与解析（id 归一化、URL 匹配、预填链接）
  IpcContract.cs         命名管道契约（协议版本、管道名、发现文件、连接与存活判断）
  EngineClient.cs        客户端侧：按需拉起服务、发命令、持有租约

src/engine/    CDP 与浏览器窗口 —— 全仓库只有这一份实现
  ChatDriver.cs          连接 → 等待输入框 → 注入 → 点击 / Enter → 回读校验；LastStatus 回传阶段
  EdgeHost.cs            启动、定位与置顶浏览器窗口（已通用化，类名沿用 EdgeHost）
  CdpClient.cs           WebSocket 与 CDP（超时、加锁、串行发送、整段解码）
  PageScripts.cs         拼装注入脚本：driver 源码 + 服务方配置 JSON + 一次调用表达式

src/service/   后台服务身份（`--service`，无界面，独占引擎）
  Program.cs             ServiceProgram.Run：静默单实例、租约驱动退出、宽限期
  PipeHost.cs            IIpcHost 实现：持有唯一一份 ChatDriver
  PipeServer.cs          命名管道：ping / health / attach / toggle / send / send-image / topmost / restart

src/ui/        托盘界面，不直接碰 CDP
  Program.cs             入口、模式分派、单实例、异常处理、启动清理
  TrayContext.cs         托盘、菜单、热键分发、模式路由（本地 _busy 看门狗）
   ├─ web  → EngineClient（经管道调服务）
   └─ api  → ApiChat.cs  气泡生命周期、多轮对话、取消与超时
                ├─ ApiClient.cs     请求体、SSE 解析、读超时看门狗、错误翻译、图片 data URL
                ├─ AnswerBubble.cs  气泡窗口：WebView2 承载 answer.html，无运行时时退回原生界面
                └─ ApiProviders.cs  服务方预设
  QuestionForm.cs        取词后的提问卡片（鲸鱼造型，回车发送、Esc 取消）
  SettingsForm.cs        设置窗口（纯代码布局，4 页：基本 / 窗口与网页 / 热键 / API（可选））
  HotkeyManager.cs       RegisterHotKey 与隐藏窗口接收 WM_HOTKEY
  ScreenCapture.cs       全屏遮罩拖框截图（单窗口覆盖多显示器的虚拟屏）
  IconFactory.cs / MenuStyle.cs / AutoStart.cs

src/web/
  answer.html            气泡 UI 资产（Markdown、代码块、表格、流式、追问、拖动），编译时内嵌

src/tests/
  TestProgram.cs         无界面自测（含 StubServer 与 stall 模式）
```

`build.ps1` 按分组取源文件，把两种身份编进同一个 exe：

| 目标 | 源文件 | 说明 |
| --- | --- | --- |
| `dist\BubbleAsk.exe` | shared + engine + service + ui（32 个） | 无参启动 = 托盘界面；`--service` 启动 = 无界面后台服务 |
| `dist\BubbleAsk.Tests.exe` | 以上全部 + tests（33 个） | 自测 |

**engine 只有一份实现，且只有服务身份会实例化它**。`build.ps1` 的 Lint 保证 `src/ui/*.cs` 不引用 `ChatDriver` / `CdpClient` / `EdgeHost`。两个所有者抢同一份 profile / CDP 端口的问题因此从结构上消除。

关键路径：配置 `%AppData%\BubbleAsk\config.json`；日志 `app.log`；profile 按浏览器分别存储（Edge 使用 `edge-profile`，其余为 `profile-<id>`）；临时截图 `%TEMP%\BubbleAsk\shot-*.png`（启动时清理一天前的文件）；IPC 发现文件 `%AppData%\BubbleAsk\ipc.json`。

### 4.1 后台服务与管道协议（`src/service/` + `src/shared/IpcContract.cs`）

网页版 CDP 驱动只有一份实现，跑在 `BubbleAsk.exe --service` 里。托盘与 DSH 插件都是客户端。

- **它以每用户后台进程运行**：Windows 服务（SCM）受 Session 0 隔离，无法创建或聚焦用户桌面上的浏览器窗口，而它的职责正是驱动那个窗口。因此它由任意客户端按需拉起。
- 管道名：`BubbleAsk.Ipc.v2.<用户名清洗后>`；ACL 只允许当前登录用户，并显式拒绝 `NetworkSid`（见 `src/service/PipeServer.cs` 的 `PipeSecurity` 构造）。
- 发现文件：`{version, app, pipe, pid, exe}`。服务启动时写入；退出时只把 `pid` 置 0，文件保留，它同时是「服务装在哪」的记录，客户端靠 `exe` 字段在服务未运行时自动拉起。
- 帧格式：默认一连接 = 一行 JSON 请求 → 一行 JSON 响应后关闭；发 `attach` 后该连接转为长期租约，服务一直挂着直到对端断开。
- 命令：`ping` / `health` / `attach` / `toggle` / `send` / `send-image` / `topmost` / `restart`。
- 版本：`IpcContract.ProtocolVersion = 2`。不一致直接返回 `stage:"version"`，不做兼容降级。
- 并发：`send` / `send-image` / `toggle` / `restart` 统一走 `PipeServer.RunExclusive`（`PipeHost.TryBegin` 的 `_gate` 加锁 + 90 秒看门狗 `BusyTimeoutSeconds`）；占用中返回 `stage:"busy"`。托盘侧的 `TrayContext` 用同样的 90 秒看门狗。
- 阶段回传：`ChatDriver.LastStatus` 在 `AskAsync` 每条返回路径赋值（`idle` / `fill` / `filled` / `sent` / `error`，或页面回读的原始状态串），`health` 与 `send` 都带回。

**生命周期（引用计数式，已实测）**

| 场景 | 行为 |
| --- | --- |
| 只开 DSH（插件未装/未启用） | 服务不启动 |
| DSH + 插件 / 仅托盘 / 两者都开 | 服务启动并常驻（各持一条租约） |
| 退出其中一个入口 | 服务不退出（还有租约） |
| 最后一个租约断开 | 等 8 秒宽限期，期间有新租约则取消退出，否则退出 |
| 从未有过租约（手工启动服务） | 不自行退出 |
| 服务退出时浏览器窗口还开着 | 窗口保留；下次服务启动见窗口即复用 |

客户端崩溃或被杀不需要注销：连接断开即租约消失。

### 4.2 网页版多服务方（provider 注册表）

网页版支持 DeepSeek / 千问 Qwen / 豆包 Doubao / ChatGPT / Gemini / Grok 与自定义入口。站点差异全部写在数据里，新增站点或校准选择器只改 `shared/providers.json`，再跑 `node tools/gen-providers.mjs` 生成扩展与插件的数据模块。

| 文件 | 职责 |
| --- | --- |
| `shared/providers.json` | 唯一真源：`schemaVersion: 1`、`defaultId: deepseek`、`customId: custom`、6 家定义、`generic` 通用规则 |
| `shared/driver.js` | 唯一页面驱动：找输入框 / 填充 / 找发送键 / 点击 / 回读 / 诊断。桌面端用 CDP 注入，扩展当 content script |
| `tools/gen-providers.mjs` | 由真源生成 `chrome-extension/lib/providers.data.js`、`dsh-plugin/lib/providers.data.js`，并同步 `content/driver.js`、`lib/driver.source.mjs`；`--check` 只校验漂移 |
| `src/shared/ProviderData.cs` | 读取内嵌真源（`Json` 封装解析），应用 `overrides.desktop` |
| `src/shared/DriverScript.cs` | 读取内嵌 `driver.js` |
| `src/shared/WebProviders.cs` | 数据模型与用法：`Resolve(id, chatUrl)`、`IsKnown`、`NormalizeId`、`InferLegacyProvider`、`MatchesUrl`、`IsLoginUrl`、`BuildAskUrl` |
| `src/engine/PageScripts.cs` | 拼装注入脚本：driver 源码 + 服务方配置 JSON + 一次调用表达式 |
| `src/engine/ChatDriver.cs` | 窗口单实例（同一 profile、同一个 `--app` 窗口）；换服务方时用 CDP 导航到 `provider.Url`，登录 cookie 保留；所有 URL/选择器/预填从 provider 取 |
| `src/shared/AppConfig.cs` | `WebProvider`（默认 `deepseek`）；`ChatUrl` 仅 custom 使用；老配置没有该字段时按 ChatUrl 推断（能对上预设域名算那家，否则 custom） |
| `src/ui/SettingsForm.cs` | 「窗口与网页」页的「网页版服务方」下拉；选预设回填并锁住地址框，选自定义可编辑 |
| `src/tests/TestProgram.cs` | provider 注册表/解析/迁移/脚本生成断言；`--probe <id>` 实机诊断 |

- **overrides**：每家可带 `overrides.<desktop|extension|plugin>`，只覆盖列出的字段。当前 6 家都没有使用覆写，桌面端读基础定义；`provider overrides merge per host` 断言仍保留，供将来使用。
- **回车发送已全部关闭**：`enterSends` 全为 `false`。桌面端过去走 CDP 可信 Enter、扩展只能发 `isTrusted=false` 的合成事件，同一开关在两端含义不同；现在 `shared/driver.js` 不再伪造 KeyboardEvent，找不到发送按钮就返回 `nobutton`。字段保留，供将来「只能回车提交」的站点显式开启。
- **IPC 增量（协议 v2 不变）**：`send` / `send-image` / `toggle` 带可选 `provider` 字段；不带时服务端按本机配置的当前服务方解析；custom 可再带 `providerUrl`。未知 provider 返回 `stage:"provider"`；`health` 带 `currentProvider` / `currentProviderName` / `webProvider` / `providers` / `lastProvider`（见 `src/service/PipeHost.cs` 的 `Health`）。
- **登录检测**：`loginMarkers` 是 URL 片段（`login` / `signin` / `accounts.google.com` 等），`shared/driver.js` 的 `isLoginUrl` 与 `probe` 都按此判断，不做 DOM 登录态判断。
- **实机校准**：`dist\BubbleAsk.Tests.exe --probe qwen` 会真实打开该站点并输出候选 composer / 发送按钮 JSON（`loginLikely`、`composerCandidates`、`sendCandidates`、`buttons`），照着输出改 `shared/providers.json`（再跑生成器）。

### 4.3 DSH 插件（2.3.2）

插件在会话选区下方直接显示鲸鱼提问卡片，可切换 6 家服务方（默认 DeepSeek）。发送有两条路径：选 DeepSeek 且在 DSH 桌面端主框架里运行时，插件自己开内嵌网页版面板（`dshDesktop.browser` 的 lease + guest webview），并用 `shared/driver.js` 在 guest 里完成注入与点击；其余情况经本地命名管道交给桌面端。桌面端那条路径的导航、登录检测、注入与发送由桌面端完成。

| 文件 | 职责 |
| --- | --- |
| `dsh-plugin/index.js` | Host 端：HTTP 路由（prompt / send / driver / session / session-data / health / diag）、轨迹精简、prompt 拼装、`resolveProvider`、`checkProviderSupport`（每次发送前查 `health.app` 版本 >= 2.1.0，不缓存）、`versionAtLeast` |
| `dsh-plugin/client.js` | Client 端：选区提问卡片、设置页（`settings.section`）与右键面板（服务方下拉 + localStorage 记忆）、内嵌网页版面板、会话 id 探针。顶部手写的 `PROVIDERS` 兜底名单由 `gen-providers.mjs` 改写并由 `--check` 拦漂移 |
| `dsh-plugin/lib/ask-client.mjs` | 与桌面端服务的命名管道通信（惰性加载，可带 `provider` / `providerUrl`） |
| `dsh-plugin/lib/providers.data.js` | 服务方定义，由真源生成；下发全量字段（内嵌面板驱动页面需要完整选择器） |
| `dsh-plugin/lib/driver.source.mjs` | 页面驱动源码，由 `shared/driver.js` 生成，经 Host 下发给内嵌面板 |
| `dsh-plugin/cordis.patch.yml` | 插入 `bubble-ask` 条目 |

- 插件 2.3.2 与桌面端 2.1.x 配合正常。桌面端低于 2.1.0 时插件下拉只提供 DeepSeek；若仍构造出非 DeepSeek 请求，`old-app` 拒绝并保留完整 prompt 供「复制全文」。
- Client 半拿不到 `lib/providers.data.js`（`__ModuleLoader__` 的 `require` 只提供宿主包），因此源码里保留一份首帧兜底名单；它是唯一一处真源之外的服务方名单，靠生成器与 `--check` 维持一致，不要手改。
- `versionAtLeast(app, '2.1.0')` 是能力边界（2.1.0 引入按请求切换服务方），不随统一版本号变动。
- 验证：`node --check` 检查 `index.js` / `client.js` / `lib/ask-client.mjs`；`node chrome-extension/tools/check-providers.mjs` 断言三端版本号一致与生成物无漂移。真实站点仍未实测。
- 内嵌面板只接了 DeepSeek：登录态迁移、UA 脱敏与环境判定都是对 `chat.deepseek.com` 实测出来的，其它 5 家没有逐个验证。

### 4.4 API 气泡（`src/web/answer.html` + WebView2）

答案的显示层是独立 HTML/CSS/JS 资产，`build.ps1` 以 `/resource:BubbleAsk.answer.html` 内嵌进 exe。

- 宿主判定：`AnswerBubble.WebUiAvailable()` 调 `CoreWebView2Environment.GetAvailableBrowserVersionString()`，取到版本才启用 HTML 界面；否则整个窗口使用原来的 WinForms 原生界面。
- 原生界面保留两处用途：HTML 界面起不来时的回退界面，以及自测的渲染断言来源（`AnswerBubble.ForceNativeUi`）。
- 宿主接口：C# 调页面 `ds.setTitle / ds.beginTurn / ds.appendReasoning / ds.appendAnswer / ds.endTurn / ds.failTurn / ds.note / ds.focusInput`；页面回宿主 `followup:… / copy:… / close:… / drag:…` 四类字符串消息。
- 尺寸与位置：`WindowWidth` / `WindowHeight` 是两种模式的唯一尺寸来源；`AppConfig.WindowX` / `WindowY` 是共用位置。摆放规则集中在 `src/shared/WindowPlacement.cs`（`Default` 右侧居中、`Fit` 夹回工作区、`Resolve` 读保存值）。`EdgeHost.ComputePosition` 与 `AnswerBubble.ShowForAsk` 都调它。
- 位置写回：只有 `AnswerBubble.RememberPosition`（关窗时）写 `WindowX` / `WindowY`。网页版小窗在启动参数 `--window-position` 里使用同一坐标，在浏览器窗口里的拖动不会写回配置。

---

## 5. 已核实的实现事实

1. **chat.deepseek.com 原生支持 `?q=` 预填**（bundle 中存在 `chat_url_prefill`，识别 `q` / `prompt` / `mode` / `search` / `thinking`，先存入 `sessionStorage` 再应用）。`autosend=1` 无效，已移除；回退路径只能「填入不发送」，`FallbackNavigateAsync` 返回 `false`。
2. **.NET Framework 的 `HttpClient.Timeout` 仅覆盖到响应头到达**。响应头到达后正文阻塞没有超时，`ReadLineAsync` 也不接受取消标记。因此读循环中按行加入看门狗（`ApiClient.ObserveQuietly` + `Task.WhenAny`），超时抛出「读取响应超时」。该逻辑不应移除，否则气泡会永久停留在流式状态。
3. **`ClientWebSocket` 同一时刻只允许一个 `SendAsync`**，并发调用会抛 `InvalidOperationException`；因此 `CdpClient` 内实现了串行发送队列。
4. **CDP 的 WebSocket 消息必须按整条解码**。按 16KB 分片各自 `GetString` 会截断汉字（实测出现 8 个 U+FFFD）。当前实现使用 `MemoryStream` 累积字节，在 `EndOfMessage` 时一次性解码。
5. 非提权进程的 `keybd_event` 无法作用于提权窗口（UIPI 限制），因此管理员程序中取词必然失败。这是设计限制。

### 5.1 网页版实机验证结果（2026-11-02，Edge 156，已登录，DeepSeek）

通过本机 CDP 端口，将编译产物中真实生成的 JS 在真实页面上执行：

| 步骤 | 实测结果 |
| --- | --- |
| 定位输入框 | `textarea`，placeholder 为 `给 DeepSeek 发送消息 `；`textarea[name="search"]` 与没有 name 属性的 `textarea` 均可命中 |
| 注入文本 | 返回 `textarea`，回读 `len=9 / text=true / send=true`，通过 |
| 查找发送按钮 | 结构化规则命中 `ds-button ds-button--primary ds-button--filled ds-button--circle`，通过 |
| 点击发送 | 返回 `clicked:` 上述 class，通过 |
| 回读校验 | 输入框被清空，判定 `sent`，通过 |
| DeepSeek 侧 | 确认收到并回复（页面上可见问答），通过 |

**由真实 DOM 得到、已写入真源的事实：**

1. 发送按钮没有 `aria-label` / `title` / `data-testid`；按标签文字匹配的规则在真实页面上无法命中。
2. 该按钮具有 `ds-button--primary` + `ds-button--circle`，且在输入框附近唯一。这是 `findSend()` 的首选规则，不依赖图标形状。
   不要放宽为 `class*=primary`：旁边的上传按钮 class 为 `ds-button--iconLabelPrimary`，模糊匹配会误命中。
3. 图标路径前缀 `M8.3125` 目前仍一致，仅作最后手段，会随版本变化。
4. 输入框为空时页面直接不渲染发送按钮，按钮没有 disabled 状态。因此必须先填入再查找发送按钮；`hasSend=false` 属于该页面的正常状态。
5. 上传通道可用：页面存在 `input[type="file"]`（multiple，接受 png/jpg/pdf 等），`DOM.setFileInputFiles` 路径可用。
6. 图标容器为 `ds-button__background` / `ds-button__icon` 等不带 `role=button` 的子节点，按 `[role="button"]` 查询比按 `div` 查询更准确。

**冷启动**：首次启动浏览器（尤其是刚完成登录）时，SPA 需要十几秒才能绘制输入框，原 10 秒等待会直接超时。`WaitForComposerAsync` 当前超时为 25 秒，超时时打印 `document.readyState` / `url` / `title` / 正文字数，用于区分「加载慢」与「页面改版」；注入失败后另有 1.5 秒后的重试。

---

## 6. 修复记录（仅保留仍影响维护判断的条目）

### 6.1 网页版

| 问题 | 处理 |
| --- | --- |
| 发送成功与否无法判定（点击后即视为成功） | `ChatDriver.SendAndVerifyAsync`：发送后每 120ms 回读输入框，仅当确实被清空才判定 `sent`；失败按 `nobox` / `filllost` / `noaction` / `pending-*` / `unverified` 分类，除「未触发」外不再导航，以免中断进行中的会话 |
| `?q=` 回退路径错误地报告成功 | 改为返回 `false` 并记录明确日志；移除无效的 `autosend=1` |
| 选择器过窄 | composer 支持 12 个候选选择器；发送按钮改为结构化优先（`role=button` 且 class 同时含 `ds-button--primary` 与 `ds-button--circle`，取最深节点），再依次回退 label → svg 语义 → class 语义 → `M8.3125` 图标 |
| 冷启动等不到输入框 | 等待时间 10s → 25s；超时打印页面状态；注入失败后 1.5s 再重试一次 |
| CDP 连接无超时导致热键全部失效 | `ConnectAsync` 增加总预算与握手 `Task.WhenAny` 硬超时；`SendWithDeadlineAsync` 给发送本身加截止时间，超时后 `AbortSocket` |
| `_pending` 跨线程无锁、并发时 id 冲突 | 统一使用 `_pendingGate` 锁，id 递增在同一锁内 |
| 并发调用 `SendAsync` | 由 `SendSerializedAsync` 队列串行化 |
| 接收循环退出后调用方无限等待 | `FailAllPending`：循环退出或 `Dispose` 时立即失败所有未决调用 |
| 窗口 15 秒未启动却报告「端口找不到」 | `EnsureStarted` 超时直接抛出明确异常 |

### 6.2 API

| 问题 | 处理 |
| --- | --- |
| 超时被当作「用户取消」，气泡永久停留在流式状态 | 在 `catch (OperationCanceledException)` 中以 `token.IsCancellationRequested` 区分；超时走 `PostFail` 并确保退出流式状态 |
| 失败轮次的历史与界面不一致 | 将半截正文以 assistant 身份补入 `_history` |
| 空回答被当作成功 | 抛出 `ApiException`，气泡显示「模型返回了空内容」 |
| 流中的 `error` 帧被丢弃 | 识别并抛出 `ApiException`（携带 message / code） |
| `finish_reason=length` 静默截断 | 经 `onNotice` 在气泡追加灰字「（回答被 max_tokens 截断）」 |
| 非流式回退路径静默截断（40 万字符） | 检测截断并报错 |
| 400 / 403 / 413 / 422 仅提示「请求被拒绝」 | 补齐可读的提示文案 |

### 6.3 外壳与配置

| 问题 | 处理 |
| --- | --- |
| 仅支持 Edge，缺少其他浏览器 | 新增 `BrowserLocator`：读取注册表 App Paths 与常见路径，识别 Edge / Chrome / Brave / Vivaldi / Opera / Chromium；设置页增加「浏览器」下拉框 |
| 更换浏览器时共用 profile | `EffectiveProfileDirFor(id)`：Edge 保持 `edge-profile`（老用户无需重新登录），其余为 `profile-<id>` |
| 无修饰键的热键会全局抢占按键 | `TryParse` 拒绝无修饰键（F1–F24 例外）；设置页另行查重 |
| 保存设置时静默改写配置 | `SetNumber` / `ReadNumber`：用户未改动的数值原样保留，不再被控件上下限夹取 |
| 保存后误报「全部生效」 | 改为「热键立即生效；网页版服务方在下次打开网页窗口时切换；窗口尺寸、调试端口与浏览器在下次启动浏览器时生效」 |

### 6.4 本轮改动（`64690a2` 至 `f1eb471`）

| 提交 | 改动 |
| --- | --- |
| `d11b10b` | API 气泡换成 `src/web/answer.html`，由 WebView2 承载；`build.ps1` 内嵌该资源并加入 `third_party/webview2/` 的三个 DLL；`pack.ps1` 把 DLL 一起打进桌面端分发包 |
| `74b6132` | API 气泡与网页版小窗共用 `WindowWidth` / `WindowHeight`；设置页删掉单独的气泡尺寸行 |
| `b69129c` | 新增 `WindowPlacement`，两种窗口共用位置（`WindowX` / `WindowY`）；气泡不再贴鼠标出现，删掉 `PlaceNearCursor` 与「气泡位置」设置项；自测新增 `bubble uses saved position` 断言 |
| `64690a2` | API 原生气泡按提问卡片的外观重画（白底圆角、鲸鱼与标题、浅蓝输入框配「追问」按钮）；插件卡片在服务方未定时显示「问网页版（可在设置里选）」，发送时不带 `provider` 字段，交由桌面端按本机配置发送 |
| `f1eb471` | 扩展最低内核降到 Chromium 88：`minimum_chrome_version: 88`、service worker 打成 classic 单文件（`background.bundle.js`，由 `tools/gen-background.mjs` 生成）、消息往返改用回调封装（`content/compat.js`） |

本轮同时删除了 `AppConfig` 中的三个失效字段：`ShowBubble`（气泡跟随鼠标的开关，`PlaceNearCursor` 删除后不再参与逻辑）、`BubbleWidth` / `BubbleMaxHeight`（尺寸统一到 `WindowWidth` / `WindowHeight`）。配置表、设置页与测试断言已同步。

---

## 7. 遗留事项（按优先级）

1. **截图上传通道未实机验证**：代码路径已确认存在（`DOM.setFileInputFiles`），但没有在真实页面完成一次截图发送。建议在真实场景中执行 `Ctrl+Alt+A`，确认日志出现「截图已交进文件输入框」。
2. **`PasteImageAsync` 不做回读校验**（`src/engine/ChatDriver.cs`）：只有剪贴板写入失败才返回 `false`，粘贴本身失败时仍报成功，会退化为纯文本发送。建议采用与发送路径一致的校验方式。
3. **历史无限增长**：`ApiChat._history` 从不裁剪（`src/ui/ApiChat.cs`），图片每轮重新编码并重传，长对话会逐渐变慢，最终触发 400。
4. **多行 `data:` 未拼接**（SSE 规范允许），`ApiClient` 目前每条 data 行独立解析。
5. **原生回退界面的高 DPI 排版**：`src/app.manifest` 声明 PerMonitorV2，原生界面用 `EM_FORMATRANGE` 绘制正文，本机 96 DPI 下渲染正常，高 DPI 下需要在实机确认最后一行是否被遮挡。
6. **网页版小窗的拖动不写回位置**：只有 API 气泡关闭时写 `WindowX` / `WindowY`；在浏览器窗口里拖动后，下次启动仍按保存值（或默认右侧居中）摆放。若需要双向记忆，可在服务停用浏览器窗口时读取窗口矩形并写回。
7. **DSH 插件多服务方与内嵌面板未实机验证**：真实站点选择器与旧桌面端拦截路径只在离线断言层面覆盖；需在装有桌面端 2.1.0+ 的环境里按 `docs/web-providers.md` §4.1 逐家实测。

---

## 8. 验证环境

> 下列版本只说明基线验证条件，安装不要求这些版本。

| 项 | 值 |
| --- | --- |
| OS | Windows NT 10.0.26300 |
| .NET Framework | 4.8.1（Release 534296） |
| csc.exe | 14.8.10001.0 |
| 浏览器 | Edge 156.0.4314.58（`Program Files (x86)`）、Chrome 156.0.8078.48（`Program Files`） |
| git | `main` 跟踪 `origin`（地址以 `git remote -v` 为准），基线 commit `f1eb471` |
| 源码规模 | 桌面端 33 个 `.cs`（shared 12 / engine 4 / service 3 / ui 13 / tests 1），另有 `src/web/answer.html`；DSH 插件 3 个 JS 模块（`index.js`、`client.js`、`lib/ask-client.mjs`）加 2 个生成模块（`lib/providers.data.js`、`lib/driver.source.mjs`）；Chrome 扩展 18 个加载文件（含生成的 `background.bundle.js` 与 `content/driver.js`） |

**此前基线验证的事实**：`BubbleAsk.exe` 可启动，三个热键注册成功，自动检测到 Edge；将 `BrowserPath` 指向 Chrome 会改用 Chrome 并使用 `profile-chrome`；指向不存在的路径会回退自动检测。（测试过程中产生的 `%AppData%\BubbleAsk` 已清空，首次运行是全新状态。）
