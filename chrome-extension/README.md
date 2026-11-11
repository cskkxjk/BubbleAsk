# Bubble Ask — Chrome 扩展（网页问答，多服务方）

把当前网页当作上下文，在右侧独立窗口里用 6 家 AI 网页版提问。回答直接出现在对应站点的页面里，不需要 API Key，也不依赖桌面端。

服务方数据在 `shared/providers.json`（唯一真源），生成到本目录的 `lib/providers.data.js`：

| id | 名称 | 网页入口 | 说明 |
| --- | --- | --- | --- |
| `deepseek` | DeepSeek | https://chat.deepseek.com/ | 默认服务方；`textarea` 输入框；`deepseek.com` 也在归属域名内；唯一做过实机验证的站点 |
| `qwen` | 千问 Qwen | https://www.qianwen.com/ | 也覆盖 `qianwen.aliyun.com` / `chat.qwen.ai` / `tongyi.aliyun.com` / `tongyi.com` |
| `doubao` | 豆包 Doubao | https://www.doubao.com/chat/ | 富文本（ProseMirror 类）输入框 |
| `chatgpt` | ChatGPT | https://chatgpt.com/ | 富文本；另有 `chat.openai.com` 域名 |
| `gemini` | Gemini | https://gemini.google.com/app | 富文本（Quill 类）输入框 |
| `grok` | Grok | https://grok.com/ | `textarea` 输入框；`x.com` 是它的登录域名之一 |

> 真实站点未在本仓库的开发环境里登录实测：输入框与发送键按「已知特征 + 通用选择器」匹配，站点改版后可能需要调整（见「如何新增 / 调整服务方」）。国际服务方需要本机网络能访问对应站点。

## 窗口形态与站点限制

站点限制决定了窗口形态：

```text
Content-Security-Policy: frame-ancestors 'none'
Set-Cookie: ds_session_id=…; HttpOnly; Secure; SameSite=Strict
```

1. `frame-ancestors 'none'` 让所有页面（包括扩展）都无法把服务方站点放进 iframe。
2. `SameSite=Strict` 让跨站 iframe 无法携带登录 cookie，嵌进去必然是未登录状态。

所以窗口是真实的站点标签页（`chrome.windows.create` 建的无地址栏弹窗），登录态直接来自浏览器已登录的账号。每个服务方一个独立窗口，窗口 id 记录在扩展存储里。

## 安装

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`），开启「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本目录（`chrome-extension/`）。
3. 首次使用某个服务方时，右侧窗口会打开对应站点并需要登录一次，之后长期有效。

## 用法

- **划词提问（主用法）**：在任意网页上选中一段文字，选区旁直接浮出鲸鱼提问卡片，页面上的选中状态保持不变。直接按 `回车` 用默认问题发送；要写自己的问题就点一下输入框（也可以直接敲字，第一个字符会自动进输入框）；`Esc` 取消。发出去的内容是「页面上下文 + 选中处的上下文 + 这段文字 + 你的问题」，送到当前默认服务方的右侧窗口。
- **点击工具栏图标**：配置入口。弹窗顶部切换服务方（选择立即记住，之后划词和快捷键都用它），页面信息区标注「将发送到 服务方名」，也可以填问题直接「发送到选中的服务方」。
- **快捷键** `Ctrl+Shift+Y`：用默认问题提问，发送到当前默认服务方，不弹窗。
- **「复制提问」**：把完整提问（含页面上下文）复制到剪贴板。
- **「打开该服务方窗口」**：手动唤起当前选中服务方的窗口（关窗后想再开时用）。

卡片的行为细节：少于 2 个字不出现（只挡单字误触）；输入框和富文本编辑区里的选择不触发卡片；卡片出现时不抢焦点，选中状态保持可见，第一次按键或点击输入框才把焦点交给输入框；点别处、滚动、改窗口大小、按 `Esc` 都会收起；在卡片里打字不会触发页面自己的选词快捷键；发送失败时卡片和问题都留着，改一改可以重发。

窗口策略：

- 只复用扩展自己创建、且仍存活的窗口（windowId 记录在 `chrome.storage.local`）。用户自己打开的站点标签页不参与填充和发送。
- 关掉窗口后再发送（或点「打开该服务方窗口」）会重新打开；每个服务方各自一个窗口，互不影响。
- 复用同一标签页，所以对同一服务方的连续追问落在同一段对话里，上下文连续。

## 采集内容

页面常有一万以上节点，全量放进提问没有意义，所以按预算分层提取：

| 层 | 内容 | 上限 |
| --- | --- | --- |
| 页面背景 | 标题、地址、`meta description`、语言、规模统计 | — |
| 结构 | `h1`–`h6` 层级（带缩进） | 40 条 |
| 文字 | `body.innerText`（不可见内容已排除） | 4500 字，超出按头尾截断 |
| 可交互 | 链接、按钮、输入框、下拉框、`role=button` 等，取可见标签 | 80 条 |
| 表单 | 字段类型、绑定 `<label>`、`name`、占位符、是否必填 | 40 条 |
| 选中文字 | 选区文本 + 它所在的 DOM 路径（如 `p#target（正文段落）`、`main`、`article`） | — |
| 选中处上下文 | 最近的块容器全文（`article`/`li`/`.RichText` 之类）、最近的小标题、前后各一块、再往外两层 | 块 2500 字，其余各 320–400 字 |

「选中处上下文」单独一层，解决整页文本覆盖不到的位置：feed 类页面（知乎首页、微博、贴吧）里选中处常落在被头尾截断丢掉的中段，虚拟列表里未渲染的卡片也不在 `body.innerText` 里。气泡在卡片出现的那一刻同时抓下选区周围的文字和选区的 DOM 路径（那时选区还在），随消息交给后台；后台再读 DOM 时选区已经收起。

## 兼容性（老内核 / Windows 7）

目标下限是 **Chromium 88**——Windows 7 上能装的最后一版 Chrome 是 109，不少老机器停在 88 上下。

- `manifest.json` 的 `minimum_chrome_version` 是 `88`；MV3 自 88 起支持。
- service worker 打成 classic 单文件（`background.bundle.js`，由 `node tools/gen-background.mjs` 从 `lib/providers.data.js` + `lib/providers.js` + `lib/prompt.js` + `background.js` 生成），因此不依赖模块 service worker 这项较新能力。改完后台代码要重跑生成脚本，`tools/check-providers.mjs` 会校验产物与源一致。
- 消息往返与 `chrome.*` 调用统一走回调：`content/compat.js` 提供 `__baSendMessage`，background 与 popup 各自封装了带超时的回调调用。`runtime.sendMessage` 的 Promise 形式要到 Chromium 99 才有。内容脚本和 popup 共用一份实现。
- 用到的 API（`chrome.action` / `chrome.storage` / `chrome.windows` / `chrome.tabs` / `chrome.scripting` / MV3 的 `web_accessible_resources`）在 88 都已存在；代码里没有 `??`、`.at()`、`replaceAll`、`structuredClone` 这类更新的语法和 API。

AI 服务方站点不注入采集气泡（`manifest.json` 的 `exclude_matches` 排除了全部服务方域名），对话页里选中文字不弹卡片。

## 多服务方与登录

- **默认服务方**存在 `chrome.storage.local`，键是 `bubble-ask.provider`，缺省 `deepseek`。工具栏弹窗里切换后立即保存，划词气泡与快捷键都跟随它。
- **登录状态**：扩展运行在用户浏览器的默认 profile 里，cookie 直接共享。某个服务方在浏览器里登录过，扩展就能用；首次使用某家时若未登录，返回 `stage=login`，提示在窗口里登录一次。
- **国际服务方**（ChatGPT / Gemini / Grok）需要本机网络可访问对应站点；千问、豆包大陆直连可访问。
- 桌面端与 DSH 插件是两个独立交付物：桌面端同样支持 6 家（独立浏览器 profile，每家首次需在应用窗口登录）；DSH 插件同样支持 6 家（默认 DeepSeek，气泡「发到」下拉切换，切换服务方需要桌面端 2.1.0+）。

## 发送确认

1. **填入**：`textarea`/`input` 走原型链上的原生 setter，再派发 `input`/`change`（受控组件才认）；`contenteditable` 富文本编辑器先选中已有内容，再用 `document.execCommand('insertText')` 走浏览器真实输入通道，失败回退 `insertHTML`。ProseMirror、Quill 这类编辑器只认自己的模型，直接改 `textContent` 会被覆盖，也触发不了页面自己的输入处理。
2. **找发送键**：`provider.sendSelectors` → 服务方 class 组合（DeepSeek 是 `ds-button--primary` + `ds-button--circle`）→ 服务方的 `aria-label`/文案 → 通用文案（发送 / send / submit）→ 输入框附近最后一个纯图标按钮 → svg 语义词 → class 语义词 → 服务方的 svg path 前缀。
3. **点击**：点发送按钮。找不到按钮或按钮不可点击时如实报 `no-button`，由用户在窗口里手动发送；扩展不合成回车键。
4. **回读确认**：重新查输入框是否被清空（首页发送会新建会话并替换节点，不能盯死节点）；或者 URL 相对发送前发生变化、且命中 `provider.verifyUrlRegex`。正则这一路要配合「URL 已变化」使用：Gemini 初始页本身就命中 `gemini.google.com` 这类站点正则，只看正则会误判成功。
5. **阶段**：`sent`（确认发出）/ `login`（未登录）/ `no-composer`（找不到输入框）/ `no-button`（找不到发送键）/ `unverified`（已点击但未确认）/ `fill`（文字没写进去）/ `window`（窗口没就绪）。气泡显示短标签，阶段名和原始细节放在悬停提示里。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `scripting` | 页面里没有内容脚本时注入采集器；向扩展安装前就打开的服务方页面注入执行器 |
| `<all_urls>`（主机权限） | 划词气泡要在任意网页上出现，必须预先在所有站点注入内容脚本 |
| `tabs` | 查询扩展自己窗口里的标签页、确认窗口是否还活着、读当前标签页的地址与标题 |
| `windows` | 创建位于右侧的独立窗口、聚焦、关闭窗口 |
| `storage` | 默认服务方、各服务方窗口 id |
| `host_permissions` 里的各服务方域名 | 在对应站点注入执行器并收发消息；`<all_urls>` 已覆盖这些域名，这里仍显式列出，便于审查和按服务方维护 |

> `<all_urls>` 是 1.1 新增的权限，升级时 Chrome 会禁用扩展并要求确认，到 `chrome://extensions` 重新启用即可。2.3.1 移除了冗余的 `activeTab`（作用域已被 `<all_urls>` 覆盖），权限范围缩小，升级时无需重新确认。

扩展不向任何第三方服务器发送数据：页面内容只进入你自己浏览器里的服务方网页版页面。卡片出现时读取选区附近的文字和 DOM 路径，点发送之后才读取整页。

## 如何新增 / 调整服务方

1. 在 `shared/providers.json` 的 `providers` 里加一条。字段：`id` / `name` / `url` / `origins` / `composerSelectors` / `sendSelectors` / `sendClassHints` / `sendSvgPaths` / `sendAriaLabels` / `enterSends` / `loginMarkers` / `verifyUrlRegex` / `prefillParam` / `upload`。桌面端读同一份 JSON（内嵌资源）。
2. 跑 `node tools/gen-providers.mjs`，重新生成 `lib/providers.data.js` 和 `content/driver.js`。
3. 同步 `manifest.json`：`host_permissions`、chat-bridge 那个 `content_scripts` 条目的 `matches`、气泡条目的 `exclude_matches` 都要覆盖新域名（按 `PROVIDER_MATCH_PATTERNS` 的推导规则补：两级域名用 `https://*.example.com/*`，更具体的写准确主机）。
4. 跑静态校验：`node chrome-extension/tools/check-providers.mjs`。
5. 实机验证：工具栏选该服务方 → 打开窗口 → 登录一次 → 找页面划词发送；失败时按阶段（`no-composer` / `no-button` / `unverified`）对照页面调整选择器和 `verifyUrlRegex`。
6. 更新本文档的服务方表格。

`enterSends` 保留在真源里，扩展端当前不使用：找不到发送键时如实报 `no-button`。

> 内容脚本不能 import `lib/providers.js`（MV3 内容脚本不支持 ESM）。服务方定义由 background 随 `BA_PING` / `BA_ASK` 消息整条传给 `content/chat-bridge.js`；新增服务方不需要改内容脚本。

## 服务方窗口的任务栏图标

侧边窗口是真实的站点页面，窗口图标由该站点的 favicon 决定。服务方站点普遍只给 SVG（DeepSeek 还把 `rel` 的 `type` 写成 `image/x-icon`，文件是 SVG），格式声明与实际不符时 Chromium 在窗口/任务栏这一层常常不认，退回系统默认的空白文档图标。

处理方式：`content/chat-bridge.js` 在服务方页面加载后，把页面的 `<link rel="icon">` 换成扩展自己的 `icons/icon48.png`（`web_accessible_resources` 已放行）。Chromium 在 favicon 变化后更新窗口图标。拿不到扩展资源时保持站点原样。

> 这只影响扩展打开的服务方页面的图标；浏览器标签栏和任务栏的其余行为由浏览器决定，某个内核分支可能仍显示默认图标。

扩展图标是一条小鲸鱼：`icons/icon16.png`、`icon32.png`、`icon48.png`、`icon128.png` 是实际使用的四张图。母图 `tools/art/whale.png`（细节版，渲染 32/48/128）与 `tools/art/whale-small.png`（16px 专用简化版）是 `chrome-extension/tools/make-icons-from-png.py --save-masters` 从生成模型出的原图裁出的透明底版本；同一脚本完成四角泛洪去白底 → 裁到内容外接框 → 合成浅色圆角底板 → 导出 16/32/48/128，其中 16px 用简化版母图且不铺底板。`tools/` 是构建素材，不进用户分发包。

16px 单独出一张简化版：细节多的图缩小后会丢失，小尺寸需要更粗的轮廓。

![各尺寸一览](https://github.com/cskkxjk/BubbleAsk/raw/main/assets/brand-sizes.png)

上图由仓库根的 `tools/make-brand.py` 生成（`python tools/make-brand.py`，母图同上），浅灰行和深色行分别是工具栏与深色主题下的观感。仓库根 `assets/brand-256.png`（README 页头 logo）也出自同一脚本。这里用绝对链接：本文件会被打进扩展包，相对路径在包里会断。

## 与另外两个交付物的关系

| | 桌面端 `BubbleAsk.exe` | DSH 插件 | 本扩展 |
| --- | --- | --- | --- |
| 上下文 | 选中的文字 / 截图 | 会话轨迹 | 当前网页 |
| 触发 | 全局热键 | 会话内气泡 | 工具栏图标 / 快捷键 / 划词气泡 |
| 需要装什么 | 无（自带 CDP 驱动浏览器） | 需先装桌面端 | 无 |
| 登录 | 独立 profile，每家登一次 | 复用桌面端 profile | 复用浏览器现有登录 |
| 服务方 | 6 家网页版 + API 模式 | 6 家网页版（默认 DeepSeek，气泡内切换） | 6 家网页版 |

## 已知限制

- 只支持 Chromium 内核浏览器（Chrome / Edge 等）；Firefox 未适配（`chrome.windows` / `chrome.scripting` 与 MV3 行为差异）。
- 浏览器内置页面（`chrome://`、`edge://`、扩展页）不允许读取，扩展会明确提示。
- PDF 预览页与 iframe 内的内容读不到（浏览器限制；内容脚本只在顶层 frame 运行）。
- 真实服务方站点未在开发环境登录实测：首轮选择器可能需要按「如何新增 / 调整服务方」校准；站点改版后可能需要调整。
- 国际服务方受网络与站点风控（Cloudflare 等）影响，可能返回 `unverified`，属预期失败，扩展不会重复发送。
- 网页版用户协议普遍限制自动化访问，账号存在被限制的风险。本扩展由用户人工触发，一次发送一条提问，不抓取回答，不高频调用；批量或高频的调用请用 API 模式（桌面端）。
- 免费额度政策变化频繁，本文档不承诺长期免费。
