# Bubble Ask

<img src="assets/brand-256.png" width="96" align="right" alt="Bubble Ask">

Windows 桌面上的划词问答助手：**在任何程序里选中文字（或框选一块屏幕），按一个热键，就在鼠标旁弹出一个小窗口，把问题直接问给 DeepSeek。**

两种模式，装好就能在设置里切换：

| 模式 | 怎么回答 | 适合 |
| --- | --- | --- |
| **网页版**（默认） | 驱动 Edge 打开 chat.deepseek.com，用你的登录态 | 不想花 API 额度；要网页版的能力 |
| **API** | 直连 OpenAI 兼容接口，回答流式显示在自绘气泡里 | 非浏览器场景；想用别的模型；要追问 |

## 现在能做什么

- 托盘常驻（右下角通知区域，新图标可能被收进「^」里，拖出来固定即可），**双击托盘图标打开设置**，右键菜单里也有设置 / 提问 / 日志 / 退出。
- 三个全局热键（都能改）：
  - `Ctrl+Alt+D` 唤起/收起：窗口在前台时再按一次就关掉（微信、QQ 那种手感）；否则拉到前台或启动
  - `Ctrl+Alt+Q` 抓词提问：模拟 `Ctrl+C` 取当前选区 → 套模板 → 发送
  - `Ctrl+Alt+A` 截图提问：全屏拖框选区 → 连图带问题一起发
- **抓词**：备份剪贴板里的内容，取完自动还原，不会弄丢你复制的东西；超长文本中间省略。
- **截图**：全屏遮罩拖框，松开即截；`Esc`、右键或单击都能取消（Esc 是全局注册的，遮罩没抢到焦点也能关）。
- **网页版链路**：Edge `--app` 无地址栏小窗 + 独立 profile（登录一次长期有效）；走 CDP 注入输入框、派发事件、点发送，不依赖网页 CSP，也不装任何扩展。
  - 截图走 **文件上传通道**：用 CDP 把 PNG 直接塞进页面的 `input[type=file]`，**不用剪贴板、不要求窗口有焦点**；找不到上传入口才退回剪贴板粘贴。
- **API 链路**：气泡窗口贴在鼠标旁，回答逐字流式出现；可以继续追问，整段对话都带给模型；支持推理模型（先灰字显示思考，正文到了再切换）。
- **多 provider**：内置 DeepSeek 官方 / OpenAI / 硅基流动 / 本地 Ollama / 自定义，选预设自动填地址和模型。
- **开机自启**（可选）：只写当前用户的 `Run` 键，不需要管理员权限。
- 设置窗口：左侧导航 + 右侧表单，含模板、运行模式、截图提示词、自动发送、字数上限、窗口/气泡尺寸、置顶、热键、Edge 与 profile、调试端口、API 全套参数。

## 运行

```powershell
# 编译（不需要装 .NET SDK，用的是系统自带的 .NET Framework 编译器）
powershell -ExecutionPolicy Bypass -File .\build.ps1

# 编译并跑自测（会生成 dist\selftest\*.png 截图）
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test

# 启动
.\dist\BubbleAsk.exe
```

第一次启动后：

1. 托盘出现蓝色「问」图标。
2. **网页版**：按 `Ctrl+Alt+D`，会拉起一个 Edge 窗口打开 chat.deepseek.com，在里面**登录一次**，之后一直有效。
3. **API**：托盘菜单 →「设置…」→ API 标签，选服务方、填 Key、确认模型名。
4. 随便打开一个网页或 Word，选中一段文字，按 `Ctrl+Alt+Q`；或者按 `Ctrl+Alt+A` 框一块屏幕。

## 配置

`%AppData%\BubbleAsk\config.json`，也可以在托盘菜单 →「设置…」里改。常用项：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `Mode` | `web` | `web` 网页版 / `api` 直连接口 |
| `PromptTemplate` | `什么是%s` | `%s` 是选中的文字 |
| `ShotPrompt` | 这张截图里是什么？请解释一下。 | 截图提问时带的问句，不需要 `%s` |
| `AutoSend` | `true` | 关掉后只填入不发送（网页版）/ 只贴图不发送 |
| `MaxChars` | `2000` | 超长内容中间省略 |
| `HotkeySummon` / `HotkeyAsk` / `HotkeyShot` | Ctrl+Alt+D / Q / A | 格式如 `Ctrl+Shift+F2` |
| `ChatUrl` | chat.deepseek.com | 网页版打开的地址 |
| `WindowWidth` / `WindowHeight` | 480×720 | 网页版小窗尺寸 |
| `TopMost` | `true` | 网页版窗口置顶 |
| `ProfileDir` | `%AppData%\BubbleAsk\edge-profile` | Edge 登录数据 |
| `CdpPort` | `9333` | 本机调试端口，冲突就换 |
| `ApiProvider` | `deepseek` | `deepseek` / `openai` / `siliconflow` / `ollama` / `custom` |
| `ApiBaseUrl` | `https://api.deepseek.com` | OpenAI 兼容地址，自动补 `/v1/chat/completions` |
| `ApiKey` | 空 | 只保存在本机这个文件里 |
| `ApiModel` | `deepseek-chat` | 模型名 |
| `ApiMaxTokens` | `2048` | 单次回答上限 |
| `ApiSystemPrompt` | 见默认值 | 每轮对话开头的系统提示词 |
| `BubbleWidth` / `BubbleMaxHeight` | 460 / 560 | 气泡宽度与最大高度（内容变长会自己长高） |
| `ShowBubble` | `true` | 气泡贴鼠标出现；不勾选则屏幕居中 |
| `StartWithWindows` | `false` | 开机自启（写当前用户 Run 键，设置页可勾选） |

## 原理

```
                      ┌─ 网页版 ─────────────────────────────┐
热键 → 抓词 / 截图 ───┤                                      │
                      │ Edge --app（独立 profile，已登录）    │
                      │   └ CDP：填输入框 → 点发送           │
                      │      截图：剪贴板放图 → Ctrl+V        │
                      │      失败退回 ?q= 链接                │
                      └──────────────────────────────────────┘
                      ┌─ API ────────────────────────────────┐
                      │ POST {base}/v1/chat/completions      │
                      │   stream=true → 逐段 SSE             │
                      │   └ 自绘气泡：流式显示 + 多轮追问     │
                      │      截图：转 data URL 一起发         │
                      └──────────────────────────────────────┘
```

几个刻意的选择：

- **不内嵌 Chromium**：Electron 的二进制在这台机器上下不下来，直接驱动系统里的 Edge 更省事，登录态也复用得上。
- **用 CDP 而不是页面脚本**：不受页面 CSP / Trusted Types 影响，不依赖油猴脚本，也不用装扩展。
- **应用窗口是隔离的**：独立 profile，并且启动时带 `--disable-sync --disable-extensions`。否则 Edge 账号会自动同步，把你日常装的扩展（比如各种“搜索小助手”）一起灌进这个窗口，还会在页面上注入脚本干扰输入框注入。
- **截图不经过剪贴板**：直接 `DOM.setFileInputFiles` 把文件交给页面的 file input，既不需要窗口焦点，也不会覆盖你剪贴板里的东西。
- **两种模式各走各的**：网页版不吃额度但只能在浏览器里；API 模式跨应用可用、能追问，代价是要有自己的 key。
- **追问复用同一条对话**：气泡里追加的每句话都按 `user/assistant` 顺序带给模型，不会每次从零开始。

## 排错

- 日志：`%AppData%\BubbleAsk\app.log`，托盘菜单可直达。
- **热键没反应**：多半被别的程序占用，日志里有「热键被占用」，去设置换一个组合。
- **网页版窗口起来但没自动发**：看日志里的「注入输入框结果」「发送结果」；`none` 表示页面结构变了，会自动退回 `?q=`。
- **抓不到选中文字**：目标程序不支持 `Ctrl+C`（某些 PDF 阅读器、部分游戏），改用 `Ctrl+Alt+A` 截图。
- **截图没发出去**：网页版先看日志里的「打开上传入口」「截图已交进文件输入框」，`none` 表示页面结构变了或该页面不支持上传；这时会退回剪贴板粘贴，需要窗口在前台。
- **托盘图标找不到**：点通知区域的「^」展开，把图标拖到常显位置；确认进程在跑（任务管理器看 BubbleAsk）。
- **API 报 401**：key 不对或没权限，见气泡里的红字提示。
- **API 报 404**：地址或模型名不对；预设之外自己填的地址要确认是不是 OpenAI 兼容。
- **连不上**：气泡会写 `连不上 http://...`，先确认地址能从这台机器直连（公司网络可能挡）。
- **端口冲突**：设置里改 `CdpPort`，菜单「重启 Edge 会话」。
- **气泡太长**：拖标题栏挪走，或调小 `BubbleMaxHeight`。

## 开发

```
src/
  Program.cs          入口、单实例、异常兜底、启动清理
  TrayContext.cs      托盘、菜单、热键分发、模式路由
  SettingsForm.cs     设置窗口
  AppConfig.cs        配置读写（容错缺字段）
  HotkeyManager.cs    RegisterHotKey 封装
  ClipboardCapture.cs 抓词、剪贴板、Ctrl+C/V
  ScreenCapture.cs    全屏遮罩拖框截图、临时文件清理
  EdgeHost.cs         启动/定位/置顶 Edge 应用窗口
  CdpClient.cs        WebSocket + CDP
  ChatDriver.cs       网页版：注入、发送、图文、退路
  ApiClient.cs        API：请求体拼装、SSE 流式、错误翻译
  ApiProviders.cs     服务方预设
  ApiChat.cs          API 会话：气泡生命周期 + 多轮对话
  AnswerBubble.cs     自绘气泡窗口（圆角、流式显示、追问、复制）
  AutoStart.cs        开机自启（当前用户 Run 键）
  PromptBuilder.cs    模板拼装（纯函数）
  Json.cs / Logger.cs / IconFactory.cs
  TestProgram.cs      无界面自测（含本地 HTTP 桩服务）
build.ps1             编译脚本（csc，无需 SDK）
```

自测覆盖（`build.ps1 -Test`，全绿才返回 0）：

- JSON 解析、模板拼装（含截图模板）、热键解析、配置往返（含新增字段）
- provider 预设解析、接口地址补全、请求体结构（文本 / 图片 data URL）、图片等比缩小
- SSE 增量解析、推理字段、`[DONE]`、非流式兜底、HTTP 错误翻译
- 对着本地桩服务跑真实流式请求（含 401 分支）
- **端到端**：`ApiChat` → 气泡 → 桩服务 → 流式落字 → 追问第二轮
- 设置窗口四个页面离屏渲染、气泡流式渲染与自适应高度、托盘图标

另外有一个开发用的截图自检模式，不碰剪贴板也不发请求，只跑「遮罩 → 拖框 → 出图」：

```powershell
.\dist\BubbleAsk.Tests.exe --capture   # 框选后输出 SAVED <png>，Esc/单击取消输出 CANCELLED
```

## 已知限制

- 仅 Windows（依赖 Win32 热键、剪贴板、Edge）。
- 网页版依赖 Edge 的 `--app` 与 CDP，Edge 大版本更新后可能需要微调选择器。
- 网页版抓词依赖目标程序支持 `Ctrl+C`；截图上传依赖页面有 `input[type=file]` 或可识别的上传按钮。
- API 模式的图片按 PNG 重编码、长边压到 1400px，超长截图会损失一些细节。
- 沙箱/远程桌面里可能拦住 Edge 的调试端口；纯 API 模式不受影响。
