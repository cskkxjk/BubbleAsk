# Bubble Ask — Chrome 扩展（网页问答，多服务方）

把**当前网页**当成上下文，在右侧独立窗口里用 6 家 AI 网页版提问。回答直接出现在对应站点的页面里，**不需要 API Key**，也不依赖桌面端。

支持的服务方（`lib/providers.js` 里的注册表）：

| id | 名称 | 网页入口 | 说明 |
| --- | --- | --- | --- |
| `deepseek` | DeepSeek | https://chat.deepseek.com/ | **默认服务方**；`textarea` 输入框；`deepseek.com` 也在归属域名内；1.1.x 已实机验证，1.2.0 行为保持不变 |
| `qwen` | 千问 Qwen | https://www.qianwen.com/ | 也覆盖 `qianwen.aliyun.com` / `chat.qwen.ai` / `tongyi.aliyun.com` / `tongyi.com` |
| `doubao` | 豆包 Doubao | https://www.doubao.com/chat/ | 富文本（ProseMirror 类）输入框 |
| `chatgpt` | ChatGPT | https://chatgpt.com/ | 富文本；另有 `chat.openai.com` 域名 |
| `gemini` | Gemini | https://gemini.google.com/app | 富文本（Quill 类）输入框 |
| `grok` | Grok | https://grok.com/ | 富文本 / `textarea`；`x.com` 是它的登录域名之一 |

> 真实站点未在本仓库开发环境里登录实测：输入框/发送键是「已知特征 + 通用兜底」，站点改版后可能需要按 `lib/providers.js` 调整选择器（见「如何新增/调整服务方」）。国际服务方需要本机网络能访问对应站点。

## 为什么要单开窗口，而不是在页面里嵌一个 iframe

这是硬约束，不是偷懒：

```text
Content-Security-Policy: frame-ancestors 'none'
Set-Cookie: ds_session_id=…; HttpOnly; Secure; SameSite=Strict
```

1. `frame-ancestors 'none'` —— 各服务方站点普遍禁止被任何页面（包括扩展）放进 iframe。
2. 更关键的是 `SameSite=Strict` —— 即使剥离 CSP，跨站 iframe 也**带不上**登录 cookie，嵌进去必然是未登录状态。

所以窗口是**真实的站点标签页**（`chrome.windows.create` 建的无地址栏弹窗），它天然复用浏览器已登录的账号。**每个服务方一个独立窗口**，窗口 id 记录在扩展存储里。

## 安装

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`），开启「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本目录（`chrome-extension/`）。
3. 首次使用某个服务方时，右侧窗口会打开对应站点并需要登录一次 —— 用的是你自己浏览器的登录态，之后长期有效。

## 用法

- **划词提问（主用法）**：在任意网页上选中一段文字，选区旁浮出「问这段」气泡，点它即把「页面上下文 + 这段文字 + 默认问题」发到**当前默认服务方**的右侧窗口。
- **点击工具栏图标**：弹窗顶部可切换服务方（选择立即记住，之后气泡/快捷键都用它）；页面信息区会标注「将发送到 服务方名」。可填问题（留空则用默认问题）→「发送到选中的服务方」。
- **快捷键** `Ctrl+Shift+Y`：直接用默认问题提问，发送到当前默认服务方，不弹窗。
- **「复制提问」**：把完整提问（含页面上下文）复制到剪贴板，可自行粘贴到别处。
- **「打开该服务方窗口」**：手动唤起当前选中服务方的窗口（关窗后想再开时用）。

气泡的行为细节：少于 2 个字不出现（只挡单字误触）；输入框 / 富文本编辑区的选择不打断；点别处、滚动、改窗口大小、按 `Esc` 都会收起。

窗口策略：

- 只复用**扩展自己创建、且仍存活**的窗口（id 记录在 `chrome.storage.local`），**不会拿用户自己打开的站点标签页来填词发送**。
- 关掉窗口后再发送（或点「打开该服务方窗口」）会重新打开；每个服务方各自一个窗口，互不影响。
- 复用同一标签页，所以对同一服务方的连续追问是同一段对话、上下文连续。

## 采集了什么

「读取页面」按预算分层提取，不是无脑全量（一个页面轻松上万节点，全塞进去会淹没问题）：

| 层 | 内容 | 上限 |
| --- | --- | --- |
| 页面背景 | 标题、地址、`meta description`、语言、规模统计 | — |
| 结构 | `h1`–`h6` 层级（带缩进） | 40 条 |
| 文字 | `body.innerText`（已排除不可见内容） | 9000 字，超出按头尾截断 |
| 元素分布 | 标签数量 Top12、语义区块计数（nav/main/aside/form/table…） | — |
| 可交互 | 链接、按钮、输入框、下拉框、`role=button` 等，取可见标签 | 80 条 |
| 表单 | 字段类型、绑定 `<label>`、`name`、占位符、是否必填 | 40 条 |
| 选中文字 | 选区文本 + 它所在 DOM 路径（如 `p#target（正文段落）`、`main`、`article`） | — |

AI 服务方站点本身不注入采集气泡（`manifest.json` 的 `exclude_matches` 排除了全部服务方域名），避免在对话页里选中文字又弹一次气泡。

## 多服务方与登录

- **默认服务方**存在 `chrome.storage.local`，键为 `bubble-ask.provider`，缺省 `deepseek`；工具栏弹窗里切换后立即保存，划词气泡与快捷键都跟随它。
- **免登录**：扩展运行在用户浏览器默认 profile 里，cookie 天然共享。某个服务方在浏览器里登录过，扩展即可直接用；**首次使用某家**若未登录，执行器会返回 `stage=login`，提示「请先在该窗口里登录一次」。
- **国际服务方**（ChatGPT / Gemini / Grok）需要本机网络可访问对应站点；千问、豆包大陆直连可访问。
- 桌面端与 DSH 插件是另外两个独立交付物：桌面端也支持这 6 家（独立浏览器 profile，每家首次需在应用窗口登录）；DSH 插件同样支持 6 家（默认 DeepSeek，气泡「发到」下拉切换；切非 DeepSeek 需桌面端 2.1.0+）。三者互不依赖。

## 发送是怎么确认成功的

1. **填入**：`textarea`/`input` 走原型链原生 setter 再派发 `input`/`change`（受控组件才认）；`contenteditable` 富文本编辑器先选中已有内容，再用 `document.execCommand('insertText')` 走浏览器真实输入通道，失败回退 `insertHTML` —— **不再直接改 `textContent`**（会被 ProseMirror/Quill 之类的编辑器覆盖且不触发页面自己的输入处理）。
2. **找发送键**：`provider.sendSelectors` → 服务方 class 组合（DeepSeek 仍是 `ds-button--primary` + `ds-button--circle`）→ `aria-label`/文案关键字（发送 / send / submit…）→ 输入框附近最后一个仅图标按钮。
3. **发送**：点按钮；找不到按钮时，若该服务方配了 `enterSends` 则模拟回车提交。
4. **回读确认**：每次都重新查输入框是否被清空（首页发送会新建会话并跳转，旧节点会被替换，不能盯死节点）；另外「URL **相对发送前发生变化**、且命中 `provider.verifyUrlRegex`（各服务方站点根地址正则）」也算成功。注意必须同时满足「URL 变化」——Gemini 初始页本身就命中 `gemini.google.com` 这类站点正则，只看正则会误判成功。
5. **如实报阶段**：`sent`（确认发出）/ `filled`（回车已按但未确认）/ `login`（未登录）/ `no-composer`（找不到输入框）/ `no-button`（找不到发送键）/ `unverified`（已点击但未确认）/ `fill`（文字没写进去）/ `window`（窗口没就绪）。气泡按阶段显示短标签，完整原因放在悬停提示里；不会谎报成功。

## 权限说明

| 权限 | 为什么需要 |
| --- | --- |
| `activeTab` + `scripting` | 采集当前页面的兜底路径；向已打开的服务方页面注入执行器（页面在扩展安装前就打开时） |
| `<all_urls>`（主机权限） | **划词气泡要能在任意网页上出现**，必须预先在所有站点注入内容脚本 |
| `tabs` | 查询扩展自己窗口里的标签页、确认窗口是否还活着 |
| `windows` | 创建贴右侧的独立窗口、聚焦/关闭窗口 |
| `storage` | 默认服务方、各服务方窗口 id、最近一次发送结果 |
| `host_permissions` 里的各服务方域名 | 在对应站点注入执行器、发消息；`<all_urls>` 已覆盖它们，这里仍显式列出便于审查与按服务方维护 |

> 从 1.0 升级到 1.1 新增 `<all_urls>` 时 Chrome 会自动禁用扩展并要求确认，在 `chrome://extensions` 重新启用即可。1.1 → 1.2 只增加已在 `<all_urls>` 覆盖范围内的服务方域名，**不会**再触发权限确认；权限列表本身未缩减。

扩展**不向任何第三方服务器发送数据**：页面内容只进你自己浏览器里的服务方网页版页面。气泡本身也不上传任何东西——只有你点它时才读取页面。

## 如何新增 / 调整服务方

1. 在 `lib/providers.js` 的 `PROVIDERS` 里加一条，字段与桌面端 `src/engine/WebProviders.cs` 对齐：`id / name / url / origins / composerSelectors / sendSelectors / sendClassHints / sendAriaLabels / enterSends / loginMarkers / verifyUrlRegex / prefillParam / upload`。
2. 同步 `manifest.json`：`host_permissions`、`content/chat-bridge.js` 的 `matches`、气泡条目的 `exclude_matches` 都要覆盖新域名（按 `PROVIDER_MATCH_PATTERNS` 的推导规则补；两级域名用 `https://*.example.com/*`，更具体的写准确主机）。
3. 跑静态校验：`node chrome-extension/tools/check-providers.mjs`。
4. 实机验证：工具栏选该服务方 → 打开窗口 → 登录一次 → 随便找个页面划词发送；失败时按气泡阶段（`no-composer` / `no-button` / `unverified`）对照页面结构调整选择器、`enterSends`、`verifyUrlRegex`。
5. 更新本文档的服务方表格与验证日期。

> 内容脚本**不能** import `lib/providers.js`（MV3 内容脚本不支持 ESM）。服务方定义由 background 随 `BA_PING` / `BA_ASK` 消息整条传给 `content/chat-bridge.js`；新增服务方不需要改内容脚本。

## 关于任务栏图标

侧边窗口是真实的站点页面，**窗口图标由该站点的 favicon 决定**，扩展无法覆盖。DeepSeek 用的是 SVG favicon；Chrome / Edge 能渲染，部分第三方 Chromium 分支（如遨游）不渲染 SVG，任务栏就会显示系统默认的空白文档图标。这是浏览器差异，不是扩展的问题。

扩展自己的图标（工具栏、扩展管理页）是一条小鲸鱼：`icons/icon16/32/48/128.png` 是实际使用的四张图；母图 `whale.png`（细节版，渲 32/48/128）与 `whale-small.png`（16px 专用简化版）在 `tools/art/`，由图像生成模型产出后用 `tools/make-icons-from-png.py` 处理（四角泛洪去白底 → 裁内容外接框 → 合成浅色圆角底板 → 导出各尺寸；16px 不铺底板、用裸剪影）。`tools/` 是构建素材，不进用户分发包。

16px 单独画一份不是洁癖：把细节多的图直接缩小必然糊成一团，小尺寸要的是**更粗的轮廓**而不是更多细节。

## 与另外两个交付物的关系

| | 桌面端 `BubbleAsk.exe` | DSH 插件 | 本扩展 |
| --- | --- | --- | --- |
| 上下文 | 选中的文字 / 截图 | 会话轨迹 | 当前网页 |
| 触发 | 全局热键 | 会话内气泡 | 工具栏图标 / 快捷键 / 划词气泡 |
| 需要装什么 | 无（自带 CDP 驱动浏览器） | 需先装桌面端 | 无 |
| 登录 | 独立 profile，每家登一次 | 复用桌面端 profile | **复用浏览器现有登录** |
| 服务方 | 6 家网页版 + API 模式 | 6 家网页版（默认 DeepSeek，气泡内切换） | 6 家网页版 |

三者互不依赖，可以只用其中一个。

## 已知限制

- 只支持 Chromium 内核浏览器（Chrome / Edge 等）；Firefox 未适配（MV3 模块 service worker、`chrome.windows` / `chrome.scripting` 差异）。
- 浏览器内置页面（`chrome://`、`edge://`、扩展页）不允许读取，会明确提示。
- PDF 预览页与 iframe 内的内容读不到（浏览器限制；内容脚本只在顶层 frame 运行）。
- 真实服务方站点未在开发环境登录实测：首轮选择器可能需按「如何新增/调整服务方」校准；站点改版后可能需要调整。
- 国际服务方受网络与站点风控（Cloudflare 等）影响，可能返回 `unverified`，属预期失败，不会重复发送。
- 网页版用户协议普遍限制自动化访问，账号存在被限制风险；本扩展定位是**用户人工触发、单次注入**的辅助工具，不抓取回答、不高频调用。重活请用 API 模式（桌面端）。
- 免费额度政策变化频繁，选型与文案不承诺「永久免费」。
