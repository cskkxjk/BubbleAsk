# 网页版多服务方（Web Providers）

> 状态：2026-11-09 起支持。桌面端（`BubbleAsk.exe`）、Chrome 扩展与 DSH 插件均支持 6 家：
> DeepSeek、千问/Qwen、豆包/Doubao、ChatGPT、Gemini、Grok。
> DSH 插件默认 DeepSeek，提问卡片里的「发到」下拉可切换到其余 5 家；切换时把同一个 provider id 传给执行者：默认由桌面端执行，DeepSeek 可走插件内嵌面板。桌面端低于 2.1.0 时不识别该字段，此时插件下拉只提供 DeepSeek，因此内容不会发到非 DeepSeek 站点。`custom` 只在桌面端设置里配置，插件与扩展不提供。

## 1. 服务方矩阵

| id | 名称 | 网页入口 | 登录方式 | 免费状态（2026-11 调研） | 输入框形态 | 自动化难度 |
| --- | --- | --- | --- | --- | --- | --- |
| `deepseek` | DeepSeek | https://chat.deepseek.com/ | 手机号/邮箱 | 网页版免费 | `textarea` | 低（已实机验证） |
| `qwen` | 千问 Qwen | https://www.qianwen.com/ | 阿里账号/手机号 | 旗舰模型免费（官方 2026-06 表态） | 富文本/`textarea` 混合 | 中高 |
| `doubao` | 豆包 Doubao | https://www.doubao.com/chat/ | 手机号/抖音 | 免费版与付费专业版 | 富文本（ProseMirror） | 高（风控 + 重 DOM） |
| `chatgpt` | ChatGPT | https://chatgpt.com/ | 邮箱/Google；有游客模式 | 有免费额度，配额以官方页面为准 | 富文本（ProseMirror） | 中高（Cloudflare/账号风险） |
| `gemini` | Gemini | https://gemini.google.com/app | Google 账号 | 有免费档 | 富文本（Quill 类） | 中高 |
| `grok` | Grok | https://grok.com/ | 邮箱/Google/X | 有免费额度，配额未公布 | 富文本/`textarea` | 中高 |

说明：

- 免费状态来自 2026-11-09 的第三方调研（官方定价页、媒体与站点实测），会变化，以各官方页面为准。
- 登录态：Chrome 扩展运行在用户浏览器的默认 profile 里，cookie 与浏览器共享，服务方在浏览器里登录过即可使用。桌面端使用独立 profile（Edge 为 `%APPDATA%\BubbleAsk\edge-profile`，其余浏览器为 `profile-<id>`），每家首次使用需在应用窗口里登录一次，之后长期有效。
- 国际服务方（ChatGPT / Gemini / Grok）需要本机网络能访问对应站点（大陆直连通常需要代理）；千问、豆包大陆直连可访问。
- 本仓库当前无法在开发环境里登录其它 5 家真实站点做端到端验证，选择器按已知特征加通用规则编写；实机验证清单见 §4。

## 2. 实现结构

### 2.0 唯一真源（2026-11-10 起）

服务方数据只有一份：仓库根的 `shared/providers.json`。

**版本号**：三件产物统一为同一个版本号（当前 `2.3.2`），此前三者各自演进。一致性由 `chrome-extension/tools/check-providers.mjs` 断言：比对 `manifest.json`、插件 `package.json` 与桌面端 `IpcContract.AppVersion`，不一致直接失败。
插件里的 `versionAtLeast(app, '2.1.0')` 是历史能力边界（2.1.0 引入按请求切换服务方），不随统一版本号变动。

```text
shared/providers.json                 ← 唯一真源：6 家定义 + 通用规则 + per-host 覆写
tools/gen-providers.mjs               ← 生成器（--check 只校验不写）
chrome-extension/lib/providers.data.js  ← 生成物（ESM，已应用 overrides.extension）
dsh-plugin/lib/providers.data.js        ← 生成物（ESM，含完整字段：内嵌面板要驱动页面）
src/shared/ProviderData.cs            ← 桌面端读取器：JSON 以内嵌资源打进 exe
```

三条规则：

1. 改服务方只改真源，再跑 `node tools/gen-providers.mjs`。生成物顶部有「不要手改」的横幅。
2. 桌面端不生成 C# 代码：`shared/providers.json` 编译时用 `csc /resource:` 内嵌，运行时由 `ProviderData` 用项目自带的 `Json` 封装解析，仍然是单 exe，不额外落文件。
3. 漂移有守卫：`node tools/gen-providers.mjs --check` 与扩展的 `tools/check-providers.mjs` 都比对生成物与真源，不一致直接失败；桌面端自测断言注册表来自真源（`provider source loads/order`、通用规则来自真源）。

**per-host 覆写**：真源里每家可带 `overrides.<desktop|extension|plugin>`，只覆盖它列出的字段。生成器按宿主合并，桌面端读基础定义。当前没有任何一家使用覆写；桌面端自测保留 `provider overrides merge per host` 断言，供将来使用。

**回车发送已全部关闭（2026-11-10）**：`enterSends` 全部为 `false`。

此前只在扩展端对 DeepSeek 关闭，其余 5 家在扩展端开启。两端发出 Enter 的方式不同：

- 桌面端走 CDP `Input.dispatchKeyEvent`（`isTrusted=true`，等同真人按键，并且有「点完未确认再补发一次」）；扩展端只能 `new KeyboardEvent()`（`isTrusted=false`），站点若检查该字段或要求可信输入就不会提交。同一个 `true` 在两端含义不同。
- 其余 5 家在扩展端开启，原因是这几个站点的选择器本身是推测值，不开回车几乎必然失败。结果是选择器越不确定的站点越依赖回车，风险更高。

因此统一关闭：找不到发送按钮就如实返回失败，由用户自己按回车或点按钮。工具定位是人工触发、单次注入，两端行为也随之统一。`enterSends` 字段保留，将来若出现「只能回车提交」的站点，可用它显式开启。

### 2.1 统一 provider 定义

6 家使用同一组字段。真源为 `shared/providers.json`；桌面端由 `src/shared/ProviderData.cs` 读入，扩展与插件使用生成的数据模块（`lib/providers.data.js`），查询函数分别在 `chrome-extension/lib/providers.js` 与 `dsh-plugin/index.js`。

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定标识，IPC/存储/消息里使用 |
| `name` | 展示名 |
| `url` | 聊天页地址（桌面端 `--app=` 打开、扩展新建窗口打开） |
| `origins` | 归属域名（扩展找标签页、桌面端判断当前页是否需导航） |
| `composerSelectors` | 输入框候选 CSS 选择器（按优先级） |
| `sendSelectors` | 发送按钮候选 CSS 选择器（6 家当前都为空，靠后面的规则匹配） |
| `sendAriaLabels` | 发送按钮 aria/label 文案关键字（`发送`/`send`/`submit` 等） |
| `sendClassHints` | 发送按钮 class 片段（DeepSeek 为 `ds-button--primary` + `ds-button--circle`，要求同时具备） |
| `sendSvgPaths` | 发送按钮 svg path 前缀（DeepSeek 为 `M8.3125`），仅作最后手段 |
| `enterSends` | 找不到发送按钮时是否允许回车提交。当前 6 家全为 `false`，`shared/driver.js` 已不再合成键盘事件 |
| `loginMarkers` | 登录页 URL 片段（`login` / `signin` / `accounts.google.com` 等）。扩展命中即返回 `stage=login`；桌面端的 `--probe` 输出 `loginLikely` 与逐条命中结果 |
| `verifyUrlRegex` | 站点地址正则。扩展端要求「URL 相对发送前发生变化且命中该正则」才算发送成功；桌面端只用于导航后的地址校验日志与诊断 |
| `prefillParam` | URL 预填参数。当前只有 DeepSeek 使用 `q`，其余为空，不走预填路径 |
| `upload` | 桌面端是否尝试文件输入（截图提问），失败回退剪贴板；6 家当前都为 `true`。扩展没有截图功能，不读取该字段 |
| `notes` | 维护备注，生成物中不包含 |

通用规则也在真源里（`generic`）：输入框候选为 `textarea`、`textarea[placeholder]`、`[contenteditable="true"]`（含 `div` / `p` 形式）与 `[role=textbox]`；发送按钮文案为 `发送`、`send`、`submit`、`提交`。`shared/driver.js` 的匹配顺序：provider 专属 CSS → provider class 特征 → provider 文案 → 通用文案 → 输入框附近最后一个仅图标按钮 → svg 语义 → class 语义 → `sendSvgPaths`。

### 2.2 桌面端

```text
shared/providers.json        注册表真源（6 家 + 通用规则）；编译时内嵌
shared/driver.js             页面驱动真源（找输入框/填充/找发送键/点击/回读/诊断）；编译时内嵌
src/shared/ProviderData.cs   读取内嵌 providers.json（应用 overrides.desktop）
src/shared/DriverScript.cs   读取内嵌 driver.js
src/engine/PageScripts.cs    拼装：driver 源码 + cfg JSON + 一次调用表达式
src/engine/ChatDriver.cs     窗口/导航/发送编排；所有 URL 与选择器从 provider 取
src/engine/EdgeHost.cs       --app=<provider.url>，单窗口单 profile
src/service/PipeServer.cs    send/send-image/toggle 接受可选 provider（不带时按本机配置的当前服务方）
src/service/PipeHost.cs      按 provider 解析后调用 ChatDriver
src/shared/EngineClient.cs   客户端方法带 providerId / providerUrl
src/shared/AppConfig.cs      WebProvider 字段（默认 deepseek；custom 时用 ChatUrl）
src/ui/SettingsForm.cs       「网页版服务方」下拉
src/ui/TrayContext.cs        热键与托盘操作传入当前 WebProvider
src/tests/TestProgram.cs     provider 注册表/解析/脚本拼装自测；--probe 诊断
```

窗口策略：同一 profile、同一个 app 窗口。切换服务方时通过 CDP 导航到目标 URL，登录 cookie 保留在 profile 中，每家只需首次登录一次。当前不支持同一时刻并行打开多家窗口。

IPC 兼容：请求里 `provider` 为可选字段；不带时服务端按本机配置的当前服务方解析（旧版插件不传该字段，升级桌面端后行为与升级前一致）；`IpcContract.ProtocolVersion` 保持 2。DSH 插件在服务方选定后显式带 provider（包括 DeepSeek，避免被桌面端配置带偏），服务方未定时不带该字段；发非 DeepSeek 前用 `health` 校验桌面端 `AppVersion >= 2.1.0`（每次发送前重查，升级桌面端无需重启 DSH）；旧桌面端忽略该字段，按本机配置入口发送。

诊断：`dist\BubbleAsk.Tests.exe --probe <providerId>` 会打开对应站点并输出候选输入框/发送按钮信息，用于选择器失效后的校准。

### 2.3 Chrome 扩展

```text
shared/driver.js                    页面驱动真源（与桌面端同一份）
tools/gen-providers.mjs             生成注册表数据，并把 driver.js 同步进扩展
chrome-extension/lib/providers.js   注册表查询函数（数据见 providers.data.js）
chrome-extension/content/driver.js  生成物：driver.js 的副本（content script，先于 chat-bridge 加载）
chrome-extension/content/chat-bridge.js  适配层：消息收发 + 等待重试 + 阶段判定
chrome-extension/background.js      按 provider 管理窗口/标签页、拼 prompt、发消息
chrome-extension/background.bundle.js  生成物：classic service worker（tools/gen-background.mjs）
chrome-extension/content/compat.js  消息往返的回调封装（兼容 Chromium 88）
chrome-extension/popup/*            服务方下拉 + 默认服务方
```

页面动作只有一份实现：`shared/driver.js`。桌面端用 CDP 注入它，扩展把它当 content script；`chat-bridge.js` 负责「等输入框 → 调 driver → 把结果翻成 stage」。合并前这段逻辑有两份实现：扩展手写一份，C# 用字符串拼一份。

窗口策略：每个服务方一个扩展自己创建的右侧弹窗，窗口 id 记录在扩展存储里。扩展只复用自己创建的窗口，不使用用户自己打开的标签页。首次使用某服务方且未登录时，处于服务方页面的执行器返回 `stage=login`，提示在该窗口内登录一次；登录态来自用户浏览器 profile，登录一次后长期有效。

权限说明：扩展已有 `<all_urls>` 主机权限，新增服务方不需要新的授权弹窗；`manifest.json` 里仍会为每家声明 content script，便于在页面里直接注入执行器。

### 2.4 DSH 插件

```text
dsh-plugin/index.js          Host 端：provider 解析（resolveProvider）、prompt/send/health 路由、
                             checkProviderSupport（每次发送前比对桌面端版本）
dsh-plugin/client.js         Client 端提问卡片的「发到」下拉、设置页、内嵌网页版面板
dsh-plugin/lib/providers.data.js  服务方定义（生成物，含完整字段）
dsh-plugin/lib/driver.source.mjs  页面驱动源码（生成物，经 Host 下发给内嵌面板）
dsh-plugin/lib/ask-client.mjs send 请求带 provider（Host 把当前选择显式传给桌面端）
```

- 数据流：卡片选择 provider → HTTP 请求带 `provider` → Host `prepareAsk` 按注册表解析（未知 id 返回 `stage:"provider"`）→ 非 DeepSeek 时先 `health` 校验桌面端版本（旧版返回 `old-app`，保留 prompt 供复制）→ 经命名管道 `sendPrompt({prompt, provider})` → 桌面端按 provider 导航/注入/发送。
- 导航与登录态由桌面端的单窗口单 profile 负责；插件不打开自己的浏览器，也不复制 CDP 实现。例外是插件自己的内嵌网页版面板：选 DeepSeek 且在 DSH 桌面端主框架里运行时，面板进程内加载页面，页面驱动仍用 `shared/driver.js`。
- 兼容：插件 `provider` 配置默认 `deepseek`。桌面端 `/health` 返回 `app.providerSwitchable` 与 `app.providers`（注册表 id），插件下拉只用这些 id；旧桌面端（< 2.1.0）没有该字段时只保留 DeepSeek，并把浏览器里记忆的非 DeepSeek 选择纠正回 DeepSeek。服务方未定时，卡片标题显示「问网页版（可在设置里选）」，发送时也不带 provider 字段，由桌面端按本机配置发送。

## 3. 新增/调整服务方

1. 在 `shared/providers.json` 里加或改一条（id/name/url/origins/选择器），需要按宿主区分时用 `overrides`。
2. 跑 `node tools/gen-providers.mjs` 生成扩展与插件的数据模块（同时同步 `shared/driver.js`，并改写插件 Client 半的首帧兜底名单 `dsh-plugin/client.js` 里的 `PROVIDERS`），再跑 `--check` 确认无漂移。
3. 入口域名变化时，同步修改扩展 `manifest.json` 的 `host_permissions` 与 content script `matches`（`check-providers.mjs` 会断言二者覆盖注册表）。
4. 跑桌面端 `--probe <id>` 与 §4.1 清单，按输出补选择器。
5. 更新本文档的矩阵与「验证日期」。

某个站点的页面结构特殊到通用驱动处理不了时，改 `shared/driver.js`：改一处，桌面端与扩展同时生效。

站点入口与选择器变动频繁（改名、合并入口、上线付费版都会发生），按真源维护，不要把地址与选择器写死在代码里。

## 4. 验证状态（2026-11-11）

| 项 | 结果 |
| --- | --- |
| 桌面端构建 | `build.ps1` 通过（32 个源文件 → `BubbleAsk.exe`，33 个 → `BubbleAsk.Tests.exe`） |
| 桌面端自测 | 163 项通过、0 失败（`TestProgram.cs` 中 168 处 `Check`，5 处按环境跳过） |
| 扩展静态校验 | `node chrome-extension/tools/check-providers.mjs` PASS；比对 manifest、插件版本、真源与生成物，并检查加载文件齐全 |
| 生成物漂移 | `node tools/gen-providers.mjs --check` PASS（6 家服务方 + 页面驱动，生成物无漂移） |
| 打包 | `pack.ps1` 从三处版本源（`IpcContract.cs`、插件 `package.json`、扩展 `manifest.json`）读取版本号，产物名形如 `BubbleAsk-desktop-2.3.2.zip`、`BubbleAsk-dsh-plugin-2.3.2.zip`、`BubbleAsk-chrome-extension-2.3.2.zip` |
| 真实站点 | DeepSeek 已实机验证（注入、点击、回读、回复均通过，见 `HANDOVER.md` §5.1）；其余 5 家未验证，选择器需按 §4.1 清单实机校准 |
| DSH 插件 | `node --check` 通过（`index.js` / `client.js` / `lib/ask-client.mjs`）；真实站点未实测 |
| 旧桌面端兼容 | 插件只支持桌面端 2.1.0+ 切服务方：旧桌面端 `/health` 无 `providerSwitchable` / `providers`，下拉只保留 DeepSeek（记忆的非 DeepSeek 选择会被纠正）；发非 DeepSeek 前还会查 `health.app` 版本，低于 2.1.0 返回 `stage:"old-app"` 并保留完整 prompt 供「复制全文」 |

### 4.1 实机验证清单（需能登录对应站点）

对每家服务方依次执行。桌面端日志在 `%APPDATA%\BubbleAsk\app.log`，扩展在 `chrome://extensions` 的 Service Worker 控制台：

1. 选中服务方并打开对话窗口：窗口应打开或导航到正确站点，页面可正常登录。
2. 首次登录一次，关闭后再打开：应保持登录。
3. 在任意程序选中文字 → `Ctrl+Alt+Q`：文字应填入网页输入框并被发送；日志出现 `注入输入框结果: textarea|editable` → `发送按钮回读: clicked:...` → `发送校验结果: sent`。
4. 发送校验失败时（`pending-*` / `unverified`），记录页面 URL 以及 DOM 中 composer 与发送按钮的结构，更新 provider 配置后用 `--probe` 复核。整个过程不得重复发送。
5. 截图提问 `Ctrl+Alt+A`：页面存在 `input[type=file]` 时应走文件上传，否则回退剪贴板粘贴。
6. Chrome 扩展：选中文字 → 选区旁出现提问卡片 → 回车发送 → 应在所选服务方窗口里发送；失败时卡片显示具体阶段（`login` / `no-composer` / `no-button` / `unverified`）。
7. DSH 插件：在设置页或鲸鱼按钮右键面板里切到某家 → 选中文字 → 发送；桌面端日志应出现对应 provider 名称与导航目标。桌面端 < 2.1.0 时下拉应只剩 DeepSeek（并纠正此前记忆的非 DeepSeek 选择）；此时若构造出非 DeepSeek 请求，应看到 `old-app` 提示且「复制全文」可用。
8. 记录每家「验证日期 + 浏览器版本」，更新 §1 表格。

## 5. 已知限制与风险

- **不做自动回车（2026-11-10 起）**：全站 `enterSends=false`。找不到发送按钮时如实返回失败，由用户自己回车或点按钮，原因见 §2.0。有意接受的代价是选择器失效时无法自动发送，优先保证不猜、不重复发送。桌面端原有「点完未确认再补发一次 Enter」的路径也随之不再触发，至此两端行为一致。
- 除 DeepSeek 外的 5 家未在本仓库开发环境实测，首轮选择器可能需按 §4 校准。
- 消费级网页版的用户协议普遍禁止自动化访问，账号存在被限制的风险；本功能定位是用户人工触发、单次注入的辅助工具，不抓取回答、不高频调用。高频或复杂用法请用 API 模式（桌面端已支持 DeepSeek / OpenAI / 硅基流动 / 本地 Ollama / 自定义）。
- 国际站点需要可用的网络出口；Cloudflare 与登录风控可能导致 `unverified`，属于预期失败，工具会报告具体阶段。
- 免费额度政策变化频繁，选型与文案不对额度做长期承诺。
- 桌面端单窗口 + 单 profile：切换服务方会导航当前窗口，不影响登录态，页面对话状态以各站点服务端为准。
- DSH 插件与桌面端的服务方列表可能短暂不一致：插件 Client 半带一份兜底名单，只用于 `/health` 返回前的首帧渲染，内容由 `node tools/gen-providers.mjs` 与真源对齐、由 `--check` 拦住漂移。实际可用性以桌面端 `health.app.providers` 为准。桌面端低于 2.1.0 时插件只提供 DeepSeek，旧桌面端忽略 `provider` 字段、按本机配置入口发送（若配置了自定义 `ChatUrl`，卡片显示 DeepSeek 但实际走那个入口，需升级桌面端才能按服务方切换）。
