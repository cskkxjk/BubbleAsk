# 网页版多服务方（Web Providers）

> 状态：2026-11-09 起支持。桌面端（`BubbleAsk.exe`）、Chrome 扩展与 DSH 插件均支持 6 家：
> DeepSeek、千问/Qwen、豆包/Doubao、ChatGPT、Gemini、Grok。
> DSH 插件默认 DeepSeek，气泡里的「发到」下拉可切换其余 5 家；切换时把同一个 provider id 交给桌面端执行。桌面端低于 2.1.0 时不识别该字段，此时插件下拉只提供 DeepSeek（不会把内容发到非 DeepSeek 站点）。`custom` 只在桌面端设置里配置，插件与扩展不提供。

## 1. 服务方矩阵

| id | 名称 | 网页入口 | 登录方式 | 免费状态（2026-11 调研） | 输入框形态 | 自动化难度 |
| --- | --- | --- | --- | --- | --- | --- |
| `deepseek` | DeepSeek | https://chat.deepseek.com/ | 手机号/邮箱 | 网页版免费 | `textarea` | 低（已实机验证） |
| `qwen` | 千问 Qwen | https://www.qianwen.com/ | 阿里账号/手机号 | 旗舰模型免费（官方 2026-06 表态） | 富文本/`textarea` 混合 | 中高 |
| `doubao` | 豆包 Doubao | https://www.doubao.com/chat/ | 手机号/抖音 | 免费版 + 付费专业版（2026-06 起） | 富文本（ProseMirror） | 高（风控 + 重 DOM） |
| `chatgpt` | ChatGPT | https://chatgpt.com/ | 邮箱/Google；有游客模式 | 免费额度（约 10 条/5h 级） | 富文本（ProseMirror） | 中高（Cloudflare/账号风险） |
| `gemini` | Gemini | https://gemini.google.com/app | Google 账号 | 免费档（2026-10 起仅 Flash-Lite） | 富文本（Quill 类） | 中高 |
| `grok` | Grok | https://grok.com/ | 邮箱/Google/X | 免费额度（非旗舰模型，无公布配额） | 富文本/`textarea` | 中高 |

说明：

- 免费状态来自 2026-11-09 的第三方调研（证券时报、官方定价页、第三方评测与站点实测），**会变**；以各官方页面为准。
- 登录态：**Chrome 扩展**直接用用户浏览器 profile，cookie 天然共享——某服务方在浏览器里登录过，扩展即可免登录使用；**桌面端**使用独立浏览器 profile（`%APPDATA%\BubbleAsk\profile-*`），每家首次使用需在应用窗口里登录一次，之后长期有效。
- 国际服务方（ChatGPT / Gemini / Grok）需要本机网络能访问对应站点（大陆直连通常需要代理）；千问/豆包大陆直连可访问。
- 本仓库当前**无法在开发环境里登录真实站点做端到端验证**，选择器是「已知特征 + 通用兜底」；实机验证清单见 §4。

## 2. 实现结构

### 2.0 唯一真源（2026-11-10 起）

服务方数据**只有一份**：仓库根的 `shared/providers.json`。

```text
shared/providers.json                 ← 唯一真源：6 家定义 + 通用兜底 + per-host 覆写
tools/gen-providers.mjs               ← 生成器（--check 只校验不写）
chrome-extension/lib/providers.data.js  ← 生成物（ESM，已应用 overrides.extension）
dsh-plugin/lib/providers.data.js        ← 生成物（ESM，只含下拉需要的字段）
src/shared/ProviderData.cs            ← 桌面端读取器：JSON 以**内嵌资源**打进 exe
```

三条约束：

1. **改服务方只改真源**，再跑 `node tools/gen-providers.mjs`。生成物顶部有「不要手改」的横幅。
2. **桌面端不生成 C# 代码**：`shared/providers.json` 编译时用 `csc /resource:` 内嵌，
   运行时由 `ProviderData` 用项目自带的 `Json` 封装解析 —— 仍然是单 exe，不额外落文件。
3. **漂移有守卫**：`node tools/gen-providers.mjs --check` 与扩展的
   `tools/check-providers.mjs` 都会比对生成物与真源，不一致直接失败；
   桌面端自测断言「注册表确实来自真源」（`provider source loads/order`、通用兜底来自真源）。

**per-host 覆写**：真源里每家可带 `overrides.<desktop|extension|plugin>`，只覆盖它列出的字段。
生成器按宿主合并，桌面端读基础定义。**当前没有任何一家使用覆写** —— 见下面的决定。

**Enter 兜底已全站关闭（2026-11-10）**：`enterSends` 全部为 `false`。

原来只对 DeepSeek 在扩展端关闭，其余 5 家在扩展端开启。这个安排经不起推敲：

- 两端发出 Enter 的「可信度」根本不同。桌面端走 CDP `Input.dispatchKeyEvent`
  （`isTrusted=true`，等同真人按键，还带「点完未确认再补发一次」）；扩展端只能
  `new KeyboardEvent()`（`isTrusted=false`），站点若检查该字段或要求可信输入就不会提交。
  同一个 `true` 在两端含义不同。
- 其余 5 家在扩展端开着，不是因为它们更可靠，而是选择器本身是推测值、不给兜底几乎必然失败。
  结果是「越不确定的站点越激进」，逻辑是反的。

所以统一关掉：**找不到发送按钮就如实返回失败，由用户自己按回车或点按钮**。
这符合本工具的定位（人工触发、单次注入、不猜），也消除了两端语义差异。
`enterSends` 字段保留，将来若真出现「只能回车提交」的站点，可用它显式开启。


### 2.1 统一 provider 定义

两形态使用同一组字段（桌面端 `src/shared/WebProviders.cs`，扩展 `chrome-extension/lib/providers.js`）：

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定标识，IPC/存储/消息里使用 |
| `name` | 展示名 |
| `url` | 聊天页地址（桌面端 `--app=` 打开、扩展新建窗口打开） |
| `origins` | 归属域名（扩展找标签页、桌面端判断当前页是否需导航） |
| `composerSelectors` | 输入框候选 CSS 选择器（按优先级） |
| `sendSelectors` | 发送按钮候选 CSS 选择器 |
| `sendAriaLabels` | 发送按钮 aria/label 文案关键字（`发送`/`send`/`submit` 等） |
| `sendClassHints` | 发送按钮 class 片段（DeepSeek 的 `ds-button--primary` + `ds-button--circle`，要求**同时**具备） |
| `enterSends` | 找不到发送按钮时是否允许回车兜底（桌面端走 CDP 可信按键；扩展走页内 KeyboardEvent） |
| `loginMarkers` | 登录/诊断标记。扩展端 = URL 片段（命中返回 `stage=login`）；桌面端 = `--probe` 诊断用的 DOM 候选选择器（桌面端登录态由「找不到输入框」判定，不单独返回 login 阶段） |
| `verifyUrlRegex` | 站点地址正则。扩展端用于「URL 变化后命中即视为发送成功」；桌面端仅用于导航后的地址校验日志/诊断，不作为发送成功唯一依据 |
| `prefillParam` | URL 预填参数（目前仅 DeepSeek 使用 `q`；其他站点为空，不走预填退路） |
| `upload` | 桌面端：是否尝试文件输入（截图提问），失败回退剪贴板；扩展端无截图功能，固定 false |

通用兜底（两家都实现了）：输入框 = 可见的 `textarea` / `[contenteditable=true]` / `[role=textbox]`；发送按钮 = provider 规则 → aria/label 文案 → 输入框附近 4 层内最后一个仅图标按钮。

### 2.2 桌面端

```text
src/shared/WebProviders.cs   注册表（6 家 + custom）；字段解析、旧配置迁移
src/engine/PageScripts.cs    把 provider 选择器拼成注入页面的 JS（查找/填充/发送/诊断）
src/engine/ChatDriver.cs     所有 URL/选择器/发送/校验/prefill 从 provider 取
src/engine/EdgeHost.cs       --app=<provider.url>，单窗口单 profile
src/service/PipeServer.cs    send/send-image/toggle 接受可选 provider（不带时按本机配置的当前服务方）
src/service/PipeHost.cs      按 provider 解析后调用 ChatDriver
src/shared/EngineClient.cs   客户端方法带 providerId / providerUrl
src/shared/AppConfig.cs      WebProvider 字段（默认 deepseek；custom 时用 ChatUrl）
src/ui/SettingsForm.cs       「网页版服务方」下拉
src/ui/TrayContext.cs        热键/托盘操作传入当前 WebProvider
src/tests/TestProgram.cs     provider 注册表/解析/脚本生成自测；--probe 诊断
```

窗口策略：**同一 profile、同一 app 窗口**。切换服务方时通过 CDP 导航到目标 URL；登录 cookie 保留在 profile 中，所以每家只需首次登录一次。不支持同一时刻并行打开多家窗口（后续如需要再扩展）。

IPC 兼容：请求里 `provider` 为可选字段；不带时服务端按本机配置的当前服务方解析（旧版插件 2.1.1 不传字段，升级桌面端后行为与升级前一致）；`IpcContract.ProtocolVersion` 保持 2。DSH 插件 2.2.0 起总是显式带 provider（包括 DeepSeek，避免被桌面端配置带偏），并在发非 DeepSeek 前用 `health` 校验桌面端 `AppVersion >= 2.1.0`（每次发送前重查，升级桌面端无需重启 DSH）；旧桌面端忽略该字段，按本机配置入口发送。

诊断：`dist\BubbleAsk.Tests.exe --probe <providerId>` 会打开对应站点并输出候选输入框/发送按钮信息，用于选择器失效后的快速校准。

### 2.3 Chrome 扩展

```text
chrome-extension/lib/providers.js   注册表（ES module）
chrome-extension/content/chat-bridge.js  通用执行器（按消息里的 provider 配置工作）
chrome-extension/background.js      按 provider 管理窗口/标签页、拼 prompt、发消息
chrome-extension/popup/*            服务方下拉 + 默认服务方
```

窗口策略：**每个服务方一个扩展自己创建的右侧弹窗**，窗口 id 记录在扩展存储里；只复用自己创建的窗口，**不会劫持用户自己打开的标签页**。首次使用某服务方时若未登录，气泡/弹窗会提示在该窗口内登录一次；登录态来自用户浏览器 profile，登录一次后长期有效。

权限说明：扩展已有 `<all_urls>` 主机权限，新增服务方不需要新的授权弹窗；`manifest.json` 里仍会为每家声明 content script，便于页面里直接注入执行器。

### 2.4 DSH 插件

```text
dsh-plugin/index.js          Host 端 PROVIDERS 注册表（id/name/url，deepseek 带 prefillParam）、
                             resolveProvider、prompt/send/health 路由按请求 provider 解析
dsh-plugin/client.js         Client 端气泡「发到」下拉；内置 id 列表仅用于展示，
                             挂载时从 /bubble-ask/health 的 app.providers 取交集
dsh-plugin/lib/ask-client.mjs send 请求带 provider（Host 总是把当前选择显式传给桌面端）
```

- 数据流：气泡选择 provider → HTTP 请求带 `provider` → Host `prepareAsk` 按注册表解析（未知 id 返回 `stage:"provider"`）→ 非 DeepSeek 先 `health` 校验桌面端版本（旧版返回 `old-app` 并保留 prompt 供复制）→ `app.sendPrompt({prompt, provider})` 走命名管道 → 桌面端按 provider 导航/注入/发送。
- 导航与登录态仍由桌面端的单窗口单 profile 负责；插件不打开自己的浏览器，也不复制 CDP 实现。
- 兼容：插件 `provider` 配置默认 `deepseek`。新桌面端会在 `/health` 返回 `app.providerSwitchable` 与 `app.providers`（注册表 id）；插件下拉只用这些 id，旧桌面端（< 2.1.0）没有该字段时只保留 DeepSeek，并把浏览器里记忆的非 DeepSeek 选择纠正回 DeepSeek。插件总是显式带 provider：旧桌面端会忽略该字段、按本机配置入口发送；发非 DeepSeek 前插件还会再查一次版本，旧版返回 `old-app` 并保留完整 prompt 供「复制全文」，不会静默发到 DeepSeek。

## 3. 新增/调整服务方

1. 在 `shared/providers.json` 里加/改一条（id/name/url/origins/选择器），需要按宿主差异时用 `overrides`。
2. 跑 `node tools/gen-providers.mjs` 生成扩展与插件的数据模块，再跑 `--check` 确认无漂移。
3. 若入口域名变化，同步改扩展 `manifest.json` 的 `host_permissions` / content script `matches`
   （`check-providers.mjs` 会断言二者覆盖注册表）。
4. 跑桌面端 `--probe <id>` 与实机验证清单，按输出补选择器。
5. 更新本文档矩阵与「验证日期」。

> 2026 年改版很频繁：通义千问→千问（3 月）、百度文心三入口合并（6 月）、豆包上线付费版（6 月）、海螺转视频、跃问→阶跃 AI；入口与选择器要按数据驱动方式维护，不要写死在代码里。

## 4. 验证状态（2026-11-10）

| 项 | 结果 |
| --- | --- |
| 桌面端构建 | `build.ps1` 通过（28 源 → `BubbleAsk.exe`，29 源 → `BubbleAsk.Tests.exe`，零警告） |
| 桌面端自测 | `build.ps1 -Test` ALL PASS（146 项断言，含新增 provider 注册表/解析/脚本生成断言） |
| 扩展静态校验 | `node chrome-extension/tools/check-providers.mjs` PASS；manifest JSON、全部 JS 语法检查通过 |
| 打包 | `pack.ps1` 通过：`BubbleAsk-desktop-2.1.0.zip` / `BubbleAsk-dsh-plugin-2.2.0.zip` / `BubbleAsk-chrome-extension-1.2.0.zip` |
| 真实站点 | **未验证**：开发环境没有各服务方的登录账号，也没有登录态；选择器需按 §4.1 清单实机校准 |
| DSH 插件多服务方 | `node --check` 通过（index.js / client.js / ask-client.mjs）；离线断言 ALL PASS（`.tmp-selftest/provider-test.mjs`，覆盖默认/chatUrl 覆盖/请求优先/settings 生效/未知 id/空选区/非法配置回退/版本比较/注册表与 `WebProviders.cs` id 一致）；真实站点未实测 |
| 旧桌面端兼容 | 插件只支持桌面端 2.1.0+ 切服务方：旧桌面端 `/health` 无 `providerSwitchable`/`providers`，下拉只保留 DeepSeek（记忆的非 DeepSeek 选择会被纠正）；发非 DeepSeek 前还会查 `health.app` 版本，低于 2.1.0 返回 `stage:"old-app"` 并保留完整 prompt 供「复制全文」，不会静默发到 DeepSeek |

### 4.1 实机验证清单（需能登录对应站点）

对每家服务方依次执行，日志在 `%APPDATA%\BubbleAsk\app.log`，扩展在 `chrome://extensions` 的 Service Worker 控制台：

1. 选中服务方，打开对话窗口：窗口应打开/导航到正确站点，页面可正常登录。
2. 首次登录一次，关闭后再打开：应保持登录。
3. 在任意程序选中文字 → `Ctrl+Alt+Q`：文字应填入网页输入框并被发送；日志出现 `注入输入框结果: textarea|editable` → `发送按钮回读: clicked:...` → `发送校验结果: sent`。
4. 若发送校验失败（`pending-*` / `unverified`），记录页面 URL、DOM 中 composer 与发送按钮的结构，更新 provider 配置后用 `--probe` 复核；**不会重复发送**是底线。
5. 截图提问 `Ctrl+Alt+A`：页面存在 `input[type=file]` 时应走文件上传；否则回退剪贴板粘贴。
6. Chrome 扩展：选中文字 → 气泡「问这段」→ 应在所选服务方窗口里发送；失败时气泡显示具体阶段（`login`/`no-composer`/`no-button`/`unverified`）。
7. DSH 插件：选中文字 → 气泡「发到」切到某家 → 发送；桌面端日志应出现对应 provider 名称与导航目标。桌面端 < 2.1.0 时下拉应只剩 DeepSeek（并纠正此前记忆的非 DeepSeek 选择）；若构造出非 DeepSeek 请求，应看到 `old-app` 提示且「复制全文」可用，不应静默发到 DeepSeek。
8. 记录每家「验证日期 + 浏览器版本」，更新 §1 表格。

## 5. 已知限制与风险

- **不做自动回车（2026-11-10 起）**：全站 `enterSends=false`。找不到发送按钮时如实失败，
  由用户自己回车或点按钮。原因见 §2.0：桌面端能发可信按键、扩展端只能发不可信合成事件，
  同一开关两端含义不同；且「越不确定的站点越激进」的逻辑是反的。代价是选择器失效时
  成功率下降——这是有意接受 tradeoff，优先「不猜、不重复发送」。
  另外桌面端原有「点完未确认再补发一次 Enter」的路径也随之不再触发，扩展端本来就没有该路径，
  至此两端行为一致。
- 真实站点未在本仓库开发环境实测；首轮选择器可能需按 §4 校准。
- 消费级网页版用户协议普遍禁止自动化访问，账号存在被限制风险；本功能定位是**用户人工触发、单次注入**的辅助工具，不抓取回答、不高频调用。重活请用 API 模式（已支持 DeepSeek/OpenAI/SiliconFlow/Ollama/自定义）。
- 国际站点需要可用的网络出口；Cloudflare/登录风控可能导致 `unverified`，属预期失败，工具会如实报告阶段。
- 免费额度政策变化频繁（2026 年 Gemini 免费档降级、豆包上线付费版、Poe 免费额度大幅缩减），选型与文案不要承诺「永久免费」。
- 桌面端单窗口 + 单 profile：切换服务方会导航当前窗口；不影响登录态，但页面对话状态以各站点服务端为准。
- DSH 插件与桌面端的服务方列表可能短暂不一致（插件内置列表只用于展示与兜底）：实际可用性以桌面端 `health.app.providers` 为准；桌面端低于 2.1.0 时插件只提供 DeepSeek，且旧桌面端忽略 `provider` 字段、按本机配置入口发送（若配置了自定义 `ChatUrl`，气泡显示 DeepSeek 但实际走那个入口，需升级桌面端才能按服务方切换）。
