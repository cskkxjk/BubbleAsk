# 接手说明（Handover）

> 面向新维护者的交接文档：项目定位、构建与自测流程、编码约定、架构地图、已核实的实现事实、上一轮修复记录与遗留事项。
> 更新：2026-11-10。基线：`main` 位于 `e6d0f60`（v2.0.0 后的 5 个修复）；桌面端自测 146 项通过（运行方式见 §2.1）；`build.ps1` 编译零警告。
> 2026-11-09 增补：桌面端、Chrome 扩展与 DSH 插件都支持 6 家网页版服务方（桌面端与扩展见 §4.2；插件默认 DeepSeek、气泡可切换，见 §4.3）。

---

## 1. 项目定位

Windows 平台的划词问答助手：选中文本（或框选屏幕区域）→ 触发全局热键 → 在鼠标位置弹出窗口 → 将内容提交给所选网页版 AI（默认 DeepSeek）。

仓库包含三个相互独立的交付物：

| 交付物 | 位置 | 说明 |
| --- | --- | --- |
| 桌面端 | `src/`、`build.ps1`、`dist/` | 本文档主要描述的对象 |
| DSH 插件 | `dsh-plugin/` | 独立 Node 包，与桌面端代码无共享，文档见 `dsh-plugin/README.md` |
| Chrome 扩展 | `chrome-extension/` | 独立 MV3 扩展，不依赖桌面端，文档见 `chrome-extension/README.md` |

桌面端支持两种运行模式：

| 模式 | 实现 | 代价 |
| --- | --- | --- |
| `web`（默认） | 驱动本机 Chromium 内核浏览器（Edge / Chrome / Brave / Vivaldi / Opera / Chromium），`--app` + 独立 profile + CDP | 复用网页登录状态，不消耗 API 额度；依赖页面结构 |
| `api` | 直连 OpenAI 兼容 `/chat/completions`，SSE 流式，自绘气泡，支持追问 | 需要 Key；跨应用可用，不依赖浏览器 |

**技术栈**：C# 5 / WinForms / .NET Framework 4.8.1，由 `csc.exe` 直接编译。仓库中不存在 `.sln` 与 `.csproj`。

---

## 2. 构建与自测

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1          # 编译一个 exe + 一个自测程序
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test    # 编译并自测，全部通过返回 0
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Clean   # 先清理 dist
```

- 编译器：`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，选项为 `/langversion:5 /warn:4 /codepage:65001`。
- 产物：`dist\BubbleAsk.exe`（28 个源文件：shared + engine + service + ui 一起编译）、`dist\BubbleAsk.Tests.exe`（29 个源文件：再加 tests）、`dist\selftest\*.png`。
- 一个 `BubbleAsk.exe` 承担两种身份：无参启动是托盘界面，`--service` 启动是无界面后台服务。单实例不靠文件名而靠互斥锁 `BubbleAsk.Service.SingleInstance.4C81`。
- `build.ps1` 末尾有一道 Lint：若 `src/ui/*.cs` 出现 `ChatDriver` / `CdpClient` / `EdgeHost` 字样即失败。原因是一个 exe 之后编译器不再天然阻止 ui 直接 new 引擎对象，改用这条静态检查兜底。

### 2.1 环境注意事项：`%TEMP%` 不可写导致自测中断

自测会在 `%TEMP%` 下创建 `bubbleask-test-<guid>` 目录存放临时配置。若该进程无法在 `%TEMP%` 创建目录，自测会以未捕获异常终止，表现为：

- 进程退出码 `-532462766`（`0xE0434352`，未处理的托管异常），控制台打印「由于 Exception.ToString() 失败，因此无法打印异常字符串」；
- 事件日志「应用程序错误」中异常代码为 `0xe0434352`，WER 记录 `CLR20r3`、`P9: System.UnauthorizedAccess`；
- 输出停在 `PASS profile override wins`（第 32 项）之后。

已验证的规避方式：把 `TEMP` / `TMP` 指向工作区内可写目录后运行自测。

```powershell
$env:TEMP = Join-Path (Get-Location) '.tmp-selftest\temp'   # .tmp-*/ 已被 .gitignore 忽略
$env:TMP  = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test    # 全部通过，输出 ALL PASS
```

该现象属于运行环境差异（同一可执行文件放在 `%TEMP%` 内运行时可正常创建目录），与源码无关；排查时优先区分这一点，避免误判为配置读写缺陷。

### 2.2 自测桩服务与注意事项

`TestProgram.cs` 末尾的 `StubServer` 是最小 TCP HTTP 服务，支持第 4 个参数 `stallMs`：先返回响应头，随后等待，最后写入正文，用于构造「服务端已接收请求但不发送正文」的场景。这是验证读超时看门狗的唯一手段。

两个易错点：

1. **气泡会回显提问内容**（`你： <问题>`）。断言气泡文案时，提问中不得包含待匹配的关键字，否则 `WaitUntil` 会立即判定通过。此前曾因此误判一次。
2. 渲染自检使用 `EM_FORMATRANGE` 单独绘制 RichTextBox（无边框窗口下 `DrawToBitmap` 无法绘制正文）。不要移除此实现，否则截图为空白。

手动验证截图遮罩（不访问剪贴板、不发送请求）：

```powershell
.\dist\BubbleAsk.Tests.exe --capture   # 输出 SAVED <png>；取消时输出 CANCELLED（退出码 2）
```

---

## 3. 编码约定

- **C# 5**：不可使用 `$""`、`?.`、`nameof`、表达式体成员、自动属性初始化器、`out var`。
- UI 文案与注释统一使用中文；私有字段以下划线 `_` 为前缀；显式声明类型；匿名方法使用 `delegate {}`；异常捕获后写入 `Log`。
- 新增配置字段需同步修改：`AppConfig.LoadFrom`、`SaveTo`、`SettingsForm.LoadValues` / `SaveAndClose`、`TestConfigRoundTrip`。
- 线程模型：UI 为单线程；网络与浏览器操作在 `Task.Run` 中执行；返回 UI 线程统一通过 `AnswerBubble.Post`（内部使用 `BeginInvoke`）。
- 编译选项为 `/warn:4`，未启用 `/warnaserror`，但应保持零警告。

---

## 4. 架构地图

源码按职责分组在 `src/<group>/`，分组只影响构建与阅读，不影响运行期行为：

```text
src/shared/    纯工具，界面与引擎都要
  Json.cs                JavaScriptSerializer 薄封装
  Logger.cs              日志（%AppData%\BubbleAsk\app.log）
  AppConfig.cs           配置读写（%AppData%\BubbleAsk\config.json）
  BrowserLocator.cs      检测本机已安装的 Chromium 内核浏览器（注册表与常见路径）
  PromptBuilder.cs       模板拼装（纯函数）

src/engine/    CDP 与浏览器窗口 —— 全仓库只有这一份实现
  ChatDriver.cs          连接 → 等待输入框 → 注入 → 点击 / Enter → 回读校验；LastStatus 回传阶段
  EdgeHost.cs            启动、定位与置顶浏览器窗口（已通用化，类名沿用 EdgeHost）
  CdpClient.cs           WebSocket 与 CDP（超时、加锁、串行发送、整段解码）

src/service/   后台服务身份（`--service`，无界面，独占引擎）
  Program.cs             ServiceProgram.Run：静默单实例、租约驱动退出、宽限期
  PipeHost.cs            IIpcHost 实现：持有唯一一份 ChatDriver
  PipeServer.cs          命名管道：ping / health / attach / toggle / send / send-image / topmost / restart

src/ui/        托盘界面，不直接碰 CDP
  Program.cs             入口、单实例、异常兜底、启动清理
  TrayContext.cs         托盘、菜单、热键分发、模式路由（本地 _busy 看门狗）
   ├─ web  → EngineClient（经管道调服务）
   └─ api  → ApiChat.cs  气泡生命周期、多轮对话、取消与超时
                ├─ ApiClient.cs     请求体、SSE 解析、读超时看门狗、错误翻译、图片 data URL
                ├─ AnswerBubble.cs  自绘气泡（流式、追问、复制、跟随鼠标）
                └─ ApiProviders.cs  服务方预设
  SettingsForm.cs        设置窗口（纯代码布局，4 页，含浏览器下拉框）
  HotkeyManager.cs       RegisterHotKey 与隐藏窗口接收 WM_HOTKEY
  ScreenCapture.cs       全屏遮罩拖框截图（单窗口覆盖多显示器的虚拟屏）
  ClipboardCapture.cs    Ctrl+C 取词、Ctrl+V 粘贴
  IconFactory.cs / MenuStyle.cs / AutoStart.cs

src/tests/
  TestProgram.cs         无界面自测（含 StubServer 与 stall 模式）
```

`build.ps1` 按分组取源文件，把两种身份编进同一个 exe：

| 目标 | 源文件 | 说明 |
| --- | --- | --- |
| `dist\BubbleAsk.exe` | shared + engine + service + ui（26 个） | 无参启动 = 托盘界面；`--service` 启动 = 无界面后台服务 |
| `dist\BubbleAsk.Tests.exe` | 以上全部 + tests（27 个） | 自测 |

**engine 只有一份实现、且只有服务身份会实例化它**。一个 exe 之后编译器不再天然拦住 ui 直接 new 引擎对象，因此 `build.ps1` 末尾加了一道 Lint：`src/ui/*.cs` 里出现 `ChatDriver` / `CdpClient` / `EdgeHost` 即构建失败。两个所有者抢同一份 profile / CDP 端口的问题因此仍从结构上消除。

关键路径：配置 `%AppData%\BubbleAsk\config.json`；日志 `app.log`（超过 1MB 时删除重建）；profile 按浏览器分别存储；临时截图 `%TEMP%\BubbleAsk\shot-*.png`（启动时清理一天前的文件）；IPC 发现文件 `%AppData%\BubbleAsk\ipc.json`。

### 4.1 后台服务与管道协议（`src/service/` + `src/shared/IpcContract.cs`）

网页版 CDP 驱动只有一份实现，跑在 `BubbleAsk.exe --service` 里。托盘与 DSH 插件都是客户端。

- **它为什么不是 Windows 服务（SCM）**：Session 0 隔离下无法创建/聚焦用户桌面上的浏览器窗口，而它的职责正是驱动那个窗口。所以它是每用户的后台进程（可由任意客户端按需拉起）。
- 管道名：`BubbleAsk.Ipc.v2.<用户名清洗后>`；ACL 只允许当前登录用户，并显式拒绝 `NetworkSid`。
- 发现文件：`{version, app, pipe, pid, exe}`。服务启动时写入；退出时只把 `pid` 置 0、**不删文件** —— 它同时是「服务装在哪」的记录，客户端靠 `exe` 字段在服务未运行时自动拉起。
- 帧格式：默认一连接 = 一行 JSON 请求 → 一行 JSON 响应后关闭；发 `attach` 后该连接转为**长期租约**，服务一直挂着直到对端断开。
- 命令：`ping` / `health` / `attach` / `toggle` / `send` / `send-image` / `topmost` / `restart`。
- 版本：`IpcContract.ProtocolVersion = 2`。不一致直接返回 `stage:"version"`，不静默兼容。
- 并发：`send` / `send-image` / `toggle` / `restart` 统一走 `PipeServer.RunExclusive`（`PipeHost.TryBegin` 的 `_gate` 加锁 + 90 秒看门狗）；占用中返回 `stage:"busy"`。
- 阶段回传：`ChatDriver.LastStatus` 在 `AskAsync` 每条返回路径赋值（`idle` / `fill` / `filled` / `sent` / `error`，或页面回读的原始状态串），`health` 与 `send` 都会带回。

**生命周期（引用计数式，已实测）**

| 场景 | 行为 |
| --- | --- |
| 只开 DSH（插件未装/未启用） | 服务不启动 |
| DSH + 插件 / 仅托盘 / 两者都开 | 服务启动并常驻（各持一条租约） |
| 退出其中一个入口 | 服务不退出（还有租约） |
| 最后一个租约断开 | 等 **8 秒宽限期**，期间有新租约则取消退出，否则退出 |
| 从未有过租约（手工启动服务） | 不自行退出 |
| 服务退出时 Edge 窗口还开着 | 窗口保留；下次服务启动 `EnsureStarted` 见窗口即复用 |

客户端崩溃/被杀不需要注销：连接断开即租约消失。

### 4.2 网页版多服务方（provider 注册表，2026-11）

网页版从「只能 DeepSeek」扩展为多服务方：DeepSeek / 千问 Qwen / 豆包 Doubao / ChatGPT / Gemini / Grok / 自定义。
**站点差异全部是数据，不是分支**：新增站点或页面改版校准选择器**只改 `shared/providers.json`**，
再跑 `node tools/gen-providers.mjs` 生成扩展与插件的数据模块。

> 2026-11-10 起注册表收敛为唯一真源：以前 `WebProviders.cs` / 扩展 `providers.js` / 插件 `index.js`
> 三处各写一份、靠人工同步（`check-providers.mjs` 只校验扩展自己，另两处是裸奔的）。现在真源一份，
> 生成物有 `--check` 漂移守卫，桌面端把 JSON 内嵌进 exe（`ProviderData.cs` + `csc /resource:`），
> 仍是单 exe。宿主间**真实存在**的差异写在真源的 `overrides.<host>` 里（例：DeepSeek 的
> `enterSends` 桌面端 true、扩展端 false），不再散落在两套实现中。

| 文件 | 职责 |
| --- | --- |
| `shared/providers.json` | **唯一真源**：6 家定义 + 通用兜底 + `overrides.<host>` |
| `tools/gen-providers.mjs` | 由真源生成扩展/插件的数据模块；`--check` 只校验漂移 |
| `src/shared/ProviderData.cs` | 读取内嵌真源（`Json` 封装解析），应用 `overrides.desktop` |
| `src/shared/WebProviders.cs` | 注册表**用法**：`WebProvider` 数据模型 + `custom`；`Resolve(id, chatUrl)`、`IsKnown`、`NormalizeId`、`InferLegacyProvider`、`MatchesUrl`、`IsLoginUrl`、`BuildAskUrl`（URL 预填） |
| `src/engine/PageScripts.cs` | 把 provider 的选择器拼成注入页面的 JS：输入框（provider CSS → 可见通用兜底）、发送按钮（provider CSS → class 特征 → aria/文案 → 输入框附近最后一个纯图标按钮 → 历史兜底）、注入/回读/聚焦、`--probe` 诊断脚本；通用兜底与发送文案也取自真源 |
| `src/engine/ChatDriver.cs` | 窗口单实例（同一 profile、同一个 `--app` 窗口）；换服务方时用 CDP 导航到 `provider.Url`，登录 cookie 保留；所有 URL/选择器/预填/Enter 兜底从 provider 取 |
| `src/shared/AppConfig.cs` | 新增 `WebProvider`（默认 `deepseek`）；`ChatUrl` 仅 custom 使用；老配置没有该字段时按 ChatUrl 推断（能对上预设域名算那家，否则 custom） |
| `src/ui/SettingsForm.cs` | 「窗口与网页」页新增「网页版服务方」下拉；选预设回填并锁住地址框，选自定义可编辑 |
| `src/tests/TestProgram.cs` | provider 注册表/解析/迁移/脚本生成断言；`--probe <id>` 实机诊断 |

- **IPC 增量（协议 v2 不变）**：`send` / `send-image` / `toggle` 新增可选 `provider` 字段；不带时服务端按本机配置的当前服务方解析（旧 DSH 插件 / 旧 CLI 不发该字段，行为与升级前一致）；custom 可再带 `providerUrl`，避免服务端配置滞后。未知 provider 返回 `stage:"provider"`；`health` 增加 `currentProvider` / `currentProviderName` / `webProvider` / `providers` / `lastProvider`。
- **Enter 兜底**：`EnterSends=true` 的服务方在发送按钮不可用时退回 CDP 可信 Enter；`custom` 为 false（未知站点不猜回车语义），DeepSeek 仍是点击为主、Enter 兜底（行为不变）。
- **登录检测**：`LoginMarkers` 是 URL 片段（`login` / `signin` / `accounts.google.com` 等），命中时日志提示「先登录一次」；不做 DOM 登录态判断。
- **实机校准**：`dist\BubbleAsk.Tests.exe --probe qwen` 会真实打开该站点并输出候选 composer/发送按钮 JSON（`loginLikely`、`composerCandidates`、`sendCandidates`、`buttons`），照着输出改 `shared/providers.json`（再跑生成器）即可。

### 4.3 DSH 插件多服务方（2026-11，插件 2.2.0）

插件不再固定 DeepSeek：气泡里新增「发到」下拉，可切换 6 家（默认 DeepSeek）。实现只做**选择与解析**，导航/登录检测/注入/发送仍复用桌面端：

| 文件 | 职责 |
| --- | --- |
| `dsh-plugin/index.js` | `PROVIDERS`（id/name/url，deepseek 带 `prefillParam: 'q'`）、`PROVIDER_IDS`、`resolveProvider(requested, settings)`、`checkProviderSupport`（每次发送前查 `health.app` 版本 >= 2.1.0，不缓存，升级桌面端无需重启 DSH）、`versionAtLeast`；`prepareAsk` 返回 provider/providerName 与兜底 URL；`send` 路由总是显式带 `provider`（含 DeepSeek，避免被桌面端配置带偏），未知 id 回 `stage:"provider"`，旧桌面端回 `stage:"old-app"` 并保留 prompt；`health` 暴露 `providers`/`provider` 与 `app.*Provider*`、`app.providerSwitchable` |
| `dsh-plugin/client.js` | 内置 id/name 列表（展示用）、`bubble-ask.provider` localStorage 记忆、气泡「发到」下拉、按钮/状态文案随服务方名变化；挂载时读 `/health`：`app.providerSwitchable` 为 true 才用 `app.providers` 取交集，否则只保留 DeepSeek 并把记忆的非 DeepSeek 选择纠正回去 |
| `dsh-plugin/lib/ask-client.mjs` | `sendPrompt` 的 payload 带 `provider` / `providerUrl`（Host 总是传当前选择，旧桌面端忽略未知字段） |

- 配置：`provider` 默认 `deepseek`；`chatUrl` 只影响 DeepSeek 的兜底地址，其余服务方用注册表 URL。`custom` 不提供（桌面端设置里配）。
- 兼容：插件 2.2.0 仍兼容桌面端 2.1.x；桌面端 < 2.1.0 时插件下拉只提供 DeepSeek（旧桌面端忽略 `provider` 字段、按本机配置入口发送），若仍构造出非 DeepSeek 请求则 `old-app` 拒绝并给「复制全文」逃生，不会静默发到 DeepSeek。
- 测试：`node --check` 三文件；离线断言 `.tmp-selftest/provider-test.mjs` 10 项 ALL PASS（含与 `WebProviders.cs` id 列表一致性）。真实站点仍未实测。
  注册表已收敛到 `shared/providers.json` 单一真源：漂移由 `node tools/gen-providers.mjs --check` 与
  扩展 `tools/check-providers.mjs` 双处守卫，桌面端自测断言 `provider source loads/order` 与通用兜底来源。

---

## 5. 已核实的实现事实

1. **chat.deepseek.com 原生支持 `?q=` 预填**（bundle 中存在 `chat_url_prefill`，识别 `q` / `prompt` / `mode` / `search` / `thinking`，先存入 `sessionStorage` 再应用）。但 **`autosend=1` 不是它支持的参数**，无效，已移除；因此回退路径只能「填入不发送」，`FallbackNavigateAsync` 现返回 `false`。
2. **.NET Framework 的 `HttpClient.Timeout` 仅覆盖到响应头到达**。响应头到达后正文阻塞没有超时，`ReadLineAsync` 也不接受取消标记。因此读循环中按行加入看门狗（`ApiClient.ObserveQuietly` + `Task.WhenAny`），超时抛出「读取响应超时」。该逻辑不应移除，否则气泡会永久停留在流式状态。
3. **`ClientWebSocket` 同一时刻只允许一个 `SendAsync`**，并发调用会抛 `InvalidOperationException`；因此 `CdpClient` 内实现了串行发送队列。
4. **CDP 的 WebSocket 消息必须按整条解码**。按 16KB 分片各自 `GetString` 会截断汉字（实测出现 8 个 U+FFFD）。当前实现使用 `MemoryStream` 累积字节，在 `EndOfMessage` 时一次性解码。
5. 非提权进程的 `keybd_event` 无法作用于提权窗口（UIPI 限制），因此管理员程序中取词必然失败。这是设计限制，而非缺陷。

### 5.1 网页版实机验证结果（2026-11-02，Edge 156，已登录）

通过本机 CDP 端口，将编译产物中真实生成的 JS（反射取出 `BuildFillScript` / `BuildComposerStateScript` / `BuildSendScript`）在真实页面上执行：

| 步骤 | 实测结果 |
| --- | --- |
| 定位输入框 | `textarea`，placeholder 为 `给 DeepSeek 发送消息 `；`textarea[name="search"]` 与裸 `textarea` 均可命中 |
| 注入文本 | 返回 `textarea`，回读 `len=9 / text=true / send=true`，通过 |
| 查找发送按钮 | 结构化规则命中 `ds-button ds-button--primary ds-button--filled ds-button--circle`，通过 |
| 点击发送 | 返回 `clicked:` 上述 class，通过 |
| 回读校验 | 输入框被清空，判定 `sent`，通过 |
| DeepSeek 侧 | 确认收到并回复（页面上可见问答），通过 |

**由真实 DOM 得到、已写入代码的事实：**

1. 发送按钮**没有** `aria-label` / `title` / `data-testid`；原先按标签文字匹配的规则在真实页面上全部无法命中。
2. 该按钮具有 **`ds-button--primary` + `ds-button--circle`**，且在输入框向上 4 层范围内唯一。这是当前 `findSend()` 的首选规则，不依赖图标形状。
   注意：不要放宽为 `class*=primary`。旁边的上传按钮 class 为 `ds-button--iconLabelPrimary`，模糊匹配会误命中。
3. 图标路径前缀 `M8.3125` 目前仍一致，但仅作最后兜底，会随版本变化。
4. **输入框为空时发送按钮不存在**（并非 disabled）。因此「先填入再查找发送按钮」的顺序是必需的；`hasSend=false` 不代表页面异常。
5. 上传通道可用：页面存在 `input[type="file"]`（multiple，接受 png/jpg/pdf 等），`DOM.setFileInputFiles` 路径可用。
6. 图标容器为 `ds-button__background` / `ds-button__icon` 等不带 `role=button` 的子节点，因此按 `[role="button"]` 查询比按 `div` 查询更准确。

**冷启动问题**：首次启动浏览器（尤其是刚完成登录）时，SPA 需要十几秒才能绘制输入框，原 10 秒等待会直接超时（本轮即由此发现）。当前 `WaitForComposerAsync` 的超时为 25 秒，超时时打印 `document.readyState` / `url` / `title` / 正文字数，用于区分「加载慢」与「页面改版」；注入失败后另有 1.5 秒后的重试。

---

## 6. 上一轮修复内容（已核实）

> 指产出基线 `5147d99` 的那一轮改动（上一轮；当前基线为 `e6d0f60`）。

### 6.1 网页版（web）

| 问题 | 处理 |
| --- | --- |
| 发送成功与否无法判定（点击后即视为成功） | `ChatDriver.SendAndVerifyAsync`：发送后每 120ms 回读输入框，**仅当确实被清空才判定 `sent`**；失败按 `nobox` / `filllost` / `noaction` / `pending-*` / `unverified` 分类，除「未触发」外**不再导航**，以免中断进行中的会话 |
| `?q=` 回退路径错误地报告成功 | 改为返回 `false` 并记录明确日志；移除无效的 `autosend=1` |
| Enter 使用合成事件（`isTrusted:false`） | 改用 CDP `Input.dispatchKeyEvent`（新增 `CdpClient.DispatchEnterAsync`） |
| 选择器过窄 | composer 支持 12 个候选选择器；发送按钮改为**结构化优先**（`role=button` 且 class 同时含 `ds-button--primary` 与 `ds-button--circle`，取最深节点），再依次回退 label → svg 语义 → class 语义 → 旧 `M8.3125` 图标 |
| 冷启动等不到输入框 | 等待时间 10s → **25s**；超时打印页面 `readyState` / `url` / `title` / 正文长度；注入失败后 1.5s 再重试一次 |
| CDP 连接无超时导致热键全部失效 | `ConnectAsync` 增加总预算与握手 `Task.WhenAny` 硬超时 |
| `_pending` 跨线程无锁、并发时 id 冲突 | 统一使用 `_pendingGate` 锁，id 递增在同一锁内 |
| 并发调用 `SendAsync` | 由 `SendSerializedAsync` 队列串行化 |
| UTF-8 分片解码出现乱码 | 整条消息字节累积后一次性解码 |
| 接收循环退出后调用方无限等待 | `FailAllPending`：循环退出或 `Dispose` 时立即失败所有未决调用 |
| WMI 每轮泄漏句柄 | `ManagementObjectCollection` 改用 `using` |
| 窗口 15 秒未启动却报告「端口找不到」 | `EnsureStarted` 超时直接抛出明确异常 |

### 6.2 API

| 问题 | 处理 |
| --- | --- |
| 超时被当作「用户取消」，气泡永久停留在流式状态 | 在 `catch (OperationCanceledException)` 中以 `token.IsCancellationRequested` 区分；超时走 `PostFail` 并确保退出流式状态 |
| **正文阻塞时没有任何超时** | 读循环按行加入看门狗（本轮实测发现 .NET FX 的 `HttpClient.Timeout` 不覆盖正文） |
| 失败轮次的历史与界面不一致 | 将半截正文以 assistant 身份补入 `_history` |
| 空回答被当作成功 | 抛出 `ApiException`，气泡显示「模型返回了空内容」 |
| 流中的 `error` 帧被丢弃 | 识别并抛出 `ApiException`（携带 message / code） |
| `finish_reason=length` 静默截断 | 经 `onNotice` 在气泡追加灰字「（回答被 max_tokens 截断）」 |
| 非流式回退路径静默截断（40 万字符） | 检测截断并报错 |
| 400 / 403 / 413 / 422 仅提示「请求被拒绝」 | 补齐可读的提示文案 |

### 6.3 外壳与配置

| 问题 | 处理 |
| --- | --- |
| 仅支持 Edge，缺少其他浏览器 | 新增 `BrowserLocator`：读取注册表 App Paths 与常见路径，识别 Edge / Chrome / Brave / Vivaldi / Opera / Chromium；设置页增加「浏览器」下拉框（自动检测 / 指定浏览器 / 自定义路径） |
| 更换浏览器时共用 profile | `EffectiveProfileDirFor(id)`：Edge 保持 `edge-profile`（老用户无需重新登录），其余为 `profile-<id>` |
| `_busy` 可能永久卡死 | `TryBeginOperation` 与 90 秒看门狗强制解除；托盘菜单同样走该占用判断 |
| 设置窗口从未 `Dispose` | 改用 `using` |
| 保存设置时静默改写配置 | `SetNumber` / `ReadNumber`：用户未改动的数值原样保留，不再被控件上下限夹取 |
| 无修饰键的热键会全局抢占按键 | `TryParse` 拒绝无修饰键（F1–F24 例外）；设置页另行查重 |
| 保存后误报「全部生效」 | 改为「热键立即生效；窗口尺寸、调试端口与浏览器下次生效」 |

---

## 7. 遗留事项（按优先级）

1. ~~真实页面验证~~ —— **已完成**（见 §5.1）。网页版在真实登录状态下跑通：注入 → 定位发送按钮 → 点击 → 回读确认 `sent` → DeepSeek 回复。
   建议在真实场景中多次执行（`Ctrl+Alt+Q` 取词、`Ctrl+Alt+A` 截图），确认改版后仍然可用。截图的上传通道**代码路径已确认存在，但未实机发送验证**。
2. **`PasteImageAsync` 仍无条件返回 true**（`ChatDriver`）：剪贴板粘贴路径未做回读校验，失败时会退化为纯文本发送并报告成功。建议采用与发送路径一致的校验方式。
3. **CDP 发送侧没有超时**：`SendSerializedAsync` 中若 TCP 窗口阻塞，会绕过 `CallAsync` 的 `timeoutMs`（仅 `Dispose` 时释放）。建议为发送叠加截止时间，超时后主动 `AbortSocket()`。
4. **历史无限增长**：`_history` 从不裁剪，图片每轮重新编码并重传，长对话会逐渐变慢，最终触发 400。
5. **多行 `data:` 未拼接**（SSE 规范允许），目前每条 data 行独立解析。
6. **气泡高度按 100% DPI 估算**：manifest 声明 PerMonitorV2，高 DPI 下可能遮挡最后一行。本机 96 DPI 渲染正常。
7. **`EdgeHost.Hide()`、`Handle` 无调用方**（保留作为 API，不影响功能；`IsRunning` 有调用方，`PipeHost.Health` 用它回传 `running`）。
8. **`ChatDriver` 中部分 JS 由字符串拼接生成**，修改时容易引入语法错误。建议修改后通过反射取出脚本，在真实页面执行一次（本轮验证即采用此方式，思路见 §5.1）。
9. **DSH 插件多服务方未实机验证**：真实站点选择器与旧桌面端拦截路径只在离线断言层面覆盖（§4.3）；需按 `docs/web-providers.md` §4.1 第 7 条在装有桌面端 2.1.0+ 的环境里逐家实测。

---

## 8. 验证环境

> 下列版本用于说明基线验证条件，不是安装要求。

| 项 | 值 |
| --- | --- |
| OS | Windows NT 10.0.26300 |
| .NET Framework | 4.8.1（Release 534296） |
| csc.exe | 14.8.10001.0 |
| 浏览器 | Edge 156.0.4314.58（`Program Files (x86)`）、Chrome 156.0.8078.48（`Program Files`） |
| git | `main` 跟踪 `origin`（地址以 `git remote -v` 为准），基线 commit `e6d0f60` |
| 源码规模 | 桌面端 29 个 `.cs`（shared 9 / engine 4 / service 3 / ui 12 / tests 1），构建为 `BubbleAsk.exe`（托盘 / `--service` 两种身份）与 `BubbleAsk.Tests.exe`；DSH 插件 3 个 JS 模块（`index.js`、`client.js`、`lib/ask-client.mjs`，含 6 家 provider 注册表）；Chrome 扩展 15 个文件（MV3，含 6 家 provider 注册表） |

**已验证的事实**：`BubbleAsk.exe` 可启动，三个热键注册成功，自动检测到 Edge；将 `BrowserPath` 指向 Chrome 会改用 Chrome 并使用 `profile-chrome`；指向不存在的路径会回退自动检测。（测试过程中产生的 `%AppData%\BubbleAsk` 已清空，首次运行是全新状态。）
