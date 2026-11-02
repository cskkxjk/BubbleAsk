# 接手说明（Handover）

> 新维护者的接手记录：架构地图、构建/自测流程、代码约定、本轮修了什么、还剩什么。
> 更新：2026-11-02。基线：`build.ps1 -Clean` 零警告，自测 **103 项全绿**，`main` 工作区有未提交改动（本轮成果）。

---

## 1. 这是个什么项目

Windows 桌面划词问答助手。选中文字（或框选屏幕）→ 按热键 → 在鼠标旁弹出小窗口 → 问 DeepSeek。

| 模式 | 实现 | 代价 |
| --- | --- | --- |
| `web`（默认） | 驱动系统里的 Chromium 浏览器（Edge / Chrome / Brave / Vivaldi / Opera / Chromium），`--app` 独立 profile + CDP | 复用网页登录态，不吃 API 额度；依赖页面结构 |
| `api` | 直连 OpenAI 兼容 `/chat/completions`，SSE 流式，自绘气泡，支持追问 | 需要 key；跨应用、不依赖浏览器 |

**技术栈**：C# 5 / WinForms / .NET Framework 4.8.1 / `csc.exe` 直接编译。**没有 .sln、没有 .csproj**。

---

## 2. 构建与自测

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1          # 编译两个 exe
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test    # 编译 + 自测，全绿返回 0
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Clean   # 先清 dist
```

- 编译器：`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，选项 `/langversion:5 /warn:4 /codepage:65001`。
- 产物：`dist\BubbleAsk.exe`、`dist\BubbleAsk.Tests.exe`（同一份源码，`/main:` 区分入口）、`dist\selftest\*.png`。
- 自测当前 **103 项 PASS**。

### 自测的桩服务与坑

`TestProgram.cs` 末尾的 `StubServer` 是最小 TCP HTTP 服务。现在支持第 4 个参数 `stallMs`：**先回响应头、再干等、最后才写正文**，用来制造"服务端卡住不发正文"——这是唯一能测出读超时看门狗的手段。

注意两个容易踩的坑：

1. **气泡会回显提问内容**（`你： <问题>`）。断言气泡文案时，提问里不能出现要匹配的关键字，否则 WaitUntil 会立刻"通过"。我被这个坑过一次。
2. 渲染自检用 `EM_FORMATRANGE` 单独画 RichTextBox（无边框窗口里 `DrawToBitmap` 画不出正文）——别"优化"掉，否则截图又空白。

手动验截图遮罩（不碰剪贴板、不发请求）：

```powershell
.\dist\BubbleAsk.Tests.exe --capture   # 输出 SAVED <png> 或 CANCELLED（退出码 2）
```

---

## 3. 写代码前必须知道的约定

- **C# 5**：不能用 `$""`、`?.`、`nameof`、表达式体成员、自动属性初始化器、`out var`。
- **全中文 UI 文案与注释**；私有字段 `_` 前缀，显式类型，`delegate {}` 匿名方法，异常兜住写 `Log`。
- 加配置字段要同步改：`AppConfig.LoadFrom`、`SaveTo`、`SettingsForm.LoadValues`/`SaveAndClose`、`TestConfigRoundTrip`。
- 线程模型：UI 单线程；网络/浏览器在 `Task.Run`；回 UI 走 `AnswerBubble.Post`（内部 `BeginInvoke`）。
- **注意 `/warn:4` 没有 `/warnaserror`，但请保持零警告**（本轮改完是零警告）。

---

## 4. 架构地图

```
Program.cs            入口、单实例、异常兜底、启动清理
TrayContext.cs        托盘 + 菜单 + 热键分发 + 模式路由（_busy 看门狗）
 ├─ web  → ChatDriver.cs      连接 → 等输入框 → 注入 → 点击/Enter → **回读校验**
 │          ├─ BrowserLocator.cs 检测本机装了哪些 Chromium 浏览器（注册表 + 常见路径）
 │          ├─ EdgeHost.cs     启动/定位/置顶浏览器窗口（通用化，名字沿用 EdgeHost）
 │          ├─ CdpClient.cs    WebSocket + CDP（超时/加锁/串行发送/整段解码）
 │          └─ ClipboardCapture.cs  Ctrl+C 抓词、Ctrl+V 粘贴
 └─ api  → ApiChat.cs         气泡生命周期 + 多轮对话 + 取消/超时
            ├─ ApiClient.cs     请求体、SSE 解析、读超时看门狗、错误翻译、图片 data URL
            ├─ AnswerBubble.cs  自绘气泡（流式、追问、复制、贴鼠标）
            └─ ApiProviders.cs  服务方预设
SettingsForm.cs       设置窗口（纯代码布局，4 页；含浏览器下拉框）
AppConfig.cs          配置读写（%AppData%\BubbleAsk\config.json）
HotkeyManager.cs      RegisterHotKey + 隐藏窗口收 WM_HOTKEY
ScreenCapture.cs      全屏遮罩拖框截图（虚拟屏一个窗口覆盖多显示器）
PromptBuilder.cs      模板拼装（纯函数）
Json.cs / Logger.cs / IconFactory.cs / MenuStyle.cs / AutoStart.cs
TestProgram.cs        无界面自测（含 StubServer 与 stall 模式）
```

关键路径：配置 `%AppData%\BubbleAsk\config.json`；日志 `app.log`（超 1MB 删了重建）；profile 按浏览器分开；临时截图 `%TEMP%\BubbleAsk\shot-*.png`（启动清 1 天前）。

---

## 5. 与实现有关的几条硬事实（别再踩）

1. **chat.deepseek.com 原生支持 `?q=` 预填**（bundle 里有 `chat_url_prefill`，认 `q`/`prompt`/`mode`/`search`/`thinking`，存 `sessionStorage` 后套用）。
   但 **`autosend=1` 不是它的参数**，纯属无效——已删。所以退路只**填不发**，代码里 `FallbackNavigateAsync` 现在老实返回 `false`。
2. **.NET Framework 的 `HttpClient.Timeout` 只管到"响应头到达"**。头到了之后正文卡住是**没有超时**的，`ReadLineAsync` 也不接受 token。
   所以我们在读循环里加了每行看门狗（`ApiClient.ObserveQuietly` + `Task.WhenAny`），超时抛"读取响应超时"。**不要把这层删掉**，否则气泡会永久停在流式态。
3. **`ClientWebSocket` 同时只允许一个 `SendAsync`**，并发会抛 `InvalidOperationException`；所以 `CdpClient` 里有串行发送队列。
4. **CDP 的 WebSocket 消息必须按整条解码**，按 16KB 分片各自 `GetString` 会把汉字切坏（实测 8 个 U+FFFD）。现在是 `MemoryStream` 攒字节、`EndOfMessage` 一次性解码。
5. 非提权进程的 `keybd_event` 发不进提权窗口（UIPI）——管理员程序里抓词必然失败，是设计限制不是 bug。

### 5.1 网页版实机验证结果（2026-11-02，Edge 156 + 已登录）

用本机 CDP 端口，把**编译产物里真实生成的 JS**（反射取出 `BuildFillScript` / `BuildComposerStateScript` / `BuildSendScript`）打到真实页面上跑：

| 步骤 | 真实结果 |
| --- | --- |
| 定位输入框 | `textarea`，placeholder `给 DeepSeek 发送消息 `；`textarea[name="search"]` 与裸 `textarea` 都命中 |
| 注入文本 | 返回 `textarea`，回读 `len=9 / text=true / send=true` ✅ |
| 找到发送按钮 | 结构化规则命中 `ds-button ds-button--primary ds-button--filled ds-button--circle` ✅ |
| 点击发送 | 返回 `clicked:` 上述 class ✅ |
| 回读校验 | 输入框被清空 → 判定 `sent` ✅ |
| DeepSeek 侧 | 确实收到并回复（页面上可见问答）✅ |

**从真实 DOM 学到、已写进代码的事实：**

1. 发送按钮**没有** `aria-label` / `title` / `data-testid`——原来按标签文字匹配的规则在真页面上一条都命中不了。
2. 它有 **`ds-button--primary` + `ds-button--circle`**，且在输入框往上 4 层范围内**唯一**。这是现在 `findSend()` 的第一优先规则，不依赖图标形状。
   ⚠ 别放宽成 `class*=primary`：旁边的上传按钮 class 是 `ds-button--iconLabelPrimary`，粗匹配会误命中。
3. 图标路径前缀 `M8.3125` **目前仍然一致**，但只当最后兜底——它会随版本变。
4. **空输入框时发送按钮根本不存在**（不是 disabled）。所以「先填再找发送按钮」的顺序是必须的；`hasSend=false` 不代表页面坏了。
5. 上传通道可用：页面有 `input[type="file"]`（multiple，收 png/jpg/pdf 等），`DOM.setFileInputFiles` 这条路是通的。
6. 图标容器是 `ds-button__background` / `ds-button__icon` 这类**不带 `role=button`** 的子节点，所以按 `[role="button"]` 查比按 `div` 查准。

**冷启动坑**：第一次拉起浏览器（尤其刚登录完）SPA 要十几秒才画出输入框，原来的 10 秒等待会直接超时（本次就是这样踩到的）。
现在 `WaitForComposerAsync` 给 25 秒，超时会打印 `document.readyState` / `url` / `title` / 正文字数，便于区分"慢"还是"改版"；注入还有一次 1.5 秒后的重试。

---

## 6. 本轮修了什么（已核实）

### 网页版（web）

| 问题 | 处理 |
| --- | --- |
| 发送成功与否靠猜（点完就当成功） | `ChatDriver.SendAndVerifyAsync`：发送后每 120ms 回读输入框，**只有真的被清空才算 sent**；失败按 `nobox`/`filllost`/`noaction`/`pending-*`/`unverified` 分类，除"根本没触发"外**不再导航**（避免毁掉正在进行的会话） |
| `?q=` 退路假装成功 | 改为返回 `false` + 明确日志；删掉无效的 `autosend=1` |
| Enter 用合成事件（`isTrusted:false`） | 改用 CDP `Input.dispatchKeyEvent`（新增 `CdpClient.DispatchEnterAsync`） |
| 选择器过窄 | composer 7 类候选；发送按钮改为**结构化优先**（`role=button` + class 同时含 `ds-button--primary` 与 `ds-button--circle`，取最深节点），再依次退 label → svg 语义 → class 语义 → 旧 `M8.3125` 图标兜底 |
| 冷启动等不到输入框 | 等待 10s → **25s**；超时打印页面 `readyState`/`url`/`title`/正文长度；注入失败再等 1.5s 重试一次 |
| CDP 连接无超时 → 热键全哑 | `ConnectAsync` 加总预算 + 握手 `Task.WhenAny` 硬超时 |
| `_pending` 跨线程无锁 / 并发撞 id | 统一 `_pendingGate` 锁，id 递增同锁 |
| 并发 `SendAsync` | `SendSerializedAsync` 队列串行化 |
| UTF-8 分片解码乱码 | 整条消息字节累积后一次性解码 |
| 接收循环死了调用方干等 | `FailAllPending`：循环退出 / Dispose 时立刻失败未决调用 |
| WMI 每轮泄漏句柄 | `ManagementObjectCollection` 用 `using` |
| 窗口 15 秒没起来却报"端口找不到" | `EnsureStarted` 超时直接抛明确异常 |

### API

| 问题 | 处理 |
| --- | --- |
| 超时被当成"用户取消"→ 气泡永久卡流式态 | `catch (OperationCanceledException)` 里用 `token.IsCancellationRequested` 区分；超时走 `PostFail` 并确保退出流式态 |
| **正文卡住没有任何超时** | 读循环每行看门狗（本次实测发现 .NET FX 的 `HttpClient.Timeout` 不管正文） |
| 失败轮次历史与界面不一致 | 半截正文补进 `_history` as assistant |
| 空回答当成功 | 抛 `ApiException`，气泡显示"模型返回了空内容" |
| 流中 `error` 帧被丢弃 | 识别并抛 `ApiException`（带 message/code） |
| `finish_reason=length` 静默截断 | 经 `onNotice` 在气泡加灰字"（回答被 max_tokens 截断）" |
| 非流式兜底静默截断（40 万字符） | 检测截断并报错 |
| 400/403/413/422 只说"请求被拒绝" | 补齐人话提示 |

### 外壳 / 配置

| 问题 | 处理 |
| --- | --- |
| 只有 Edge，没有别的浏览器 | 新增 `BrowserLocator`：注册表 App Paths + 常见路径，认 Edge/Chrome/Brave/Vivaldi/Opera/Chromium；设置页加"浏览器"下拉框（自动检测 / 具体浏览器 / 自定义路径） |
| 换浏览器共用 profile | `EffectiveProfileDirFor(id)`：Edge 保持 `edge-profile`（老用户不用重登），其它 `profile-<id>` |
| `_busy` 可能永久卡死 | `TryBeginOperation` + 90 秒看门狗强制解除；**托盘菜单也走同一个占用判断** |
| 设置窗口从不 Dispose | `using` |
| 保存设置会静默改写配置 | `SetNumber`/`ReadNumber`：用户没动过的数值原样保留，不再被控件上下限夹掉 |
| 无修饰键热键会全局抢键 | `TryParse` 拒绝无修饰键（F1–F24 例外）；设置页再查重 |
| 保存后谎称"全部生效" | 改为"热键立即生效；窗口尺寸/调试端口/浏览器下次生效" |

---

## 7. 还剩什么（按优先级）

1. ~~真实页面验证~~ —— **已完成**（见 §5.1）。网页版在真实登录态下跑通：注入 → 找到发送按钮 → 点击 → 回读确认 `sent` → DeepSeek 回复。
   仍建议你在真实场景多跑几次（`Ctrl+Alt+Q` 抓词、`Ctrl+Alt+A` 截图），确认改版后仍好使。截图那条上传通道**代码路径确认存在，但没实机发过**。
2. **`PasteImageAsync` 仍盲目返回 true**（`ChatDriver`）：剪贴板粘贴这条路没做回读校验，失败时会变成纯文本发送并报成功。建议用同样的方式校验。
3. **CDP 发送侧没有超时**：`SendSerializedAsync` 里若 TCP 窗口卡死，会绕过 `CallAsync` 的 `timeoutMs`（`Dispose` 才释放）。建议给发送叠 deadline，超时主动 `AbortSocket()`。
4. **历史无限增长**：`_history` 从不裁剪，图片每轮重新编码重传。长对话会越来越慢，最终撞 400。
5. **多行 `data:` 未拼接**（SSE 规范允许），目前每条 data 行独立解析。
6. **气泡高度按 100% DPI 估算**，manifest 声明 PerMonitorV2，高 DPI 下可能压住最后一行。本机 96 DPI 渲染正常。
7. **`EdgeHost.Hide()`、`IsRunning`、`Handle` 无调用方**（留着当 API，不影响）。
8. **`ChatDriver` 里有几段 JS 是字符串拼出来的**，改的时候容易写出语法错。建议改完用反射取出来在真实页面跑一遍（本次就是这么验证的，脚本思路见 §5.1）。

---

## 8. 环境事实（本机）

| 项 | 值 |
| --- | --- |
| OS | Windows NT 10.0.26300 |
| .NET Framework | 4.8.1（Release 534296） |
| csc.exe | 14.8.10001.0 |
| 浏览器 | Edge 156.0.4314.58（`Program Files (x86)`）、Chrome 156.0.8078.48（`Program Files`） |
| git | `main` ← `origin` `git@github.com:cskkxjk/BubbleAsk.git`，基线 commit `5147d99` |
| 源码规模 | 22 个 `.cs`（新增 `BrowserLocator.cs`） |

**验证过的事实**：`BubbleAsk.exe` 能启动、三个热键注册成功、自动检测到 Edge；把 `BrowserPath` 指到 Chrome 会改用 Chrome 并落到 `profile-chrome`；指到不存在的路径会回退自动检测。（测试过程中产生的 `%AppData%\BubbleAsk` 已清空，首次运行是全新状态。）
