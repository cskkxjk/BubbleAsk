# Bubble Ask（DSH 插件）

把 [Bubble Ask](../README.md) 的「划词提问」搬进 DeepSeek Harness：**在会话里选中一段文字 → 点气泡 → 插件把「精简的会话轨迹 + 你选中的文字 + 你的问题」一起注入 DeepSeek 网页版，让它解释这段文字在当前上下文中的含义。**

和原桌面版的关键区别：

| | 原 Bubble Ask（桌面 exe） | 本插件（DSH） |
| --- | --- | --- |
| 什么时候用 | 任何程序的任何时候 | **只在会话过程中**，且上下文就是当前会话 |
| 问什么 | 裸问题（默认「什么是 %s」） | 每次都带上**精简会话轨迹**，所以每一问都有上下文 |
| 开什么窗口 | 自己拉一个 `--app` 浏览器小窗 | 优先用 **DSH 右侧栏内嵌浏览器**（Ctrl+T 那个），不用另开窗口 |

## 用法

1. 在会话里**选中任意一段文字**（回答、工具输出、你自己写的话都行）。
2. 选区下方浮出 **「💬 问这段」** 气泡 —— 就是原版 Bubble Ask 的手感。
3. 点开气泡：
   - **在侧边栏打开**（默认）：在右侧栏浏览器打开 DeepSeek，**并自动把完整提问写进输入框** —— 你只需要改改文字、按回车。写入走 `<webview>.executeJavaScript()`（原生 setter + input 事件），不依赖 URL 传参。
   - **自动发送**：由 Host 拉起独立 Chromium（`--app` + CDP）注入并点发送，**回读确认输入框被清空**才算成功。
4. 气泡里可以填自己的问题（留空＝「解释它在当前上下文中是什么意思」）。

## 注入的到底是什么

Host 半从会话日志（`session.deriveMessages()`）取最近若干条 user/assistant 消息，按字数和条数截断成「精简轨迹」，再拼成：

```
下面是我和一个 AI 编码助手刚才那段会话的「精简轨迹」，请把它当作背景上下文。

【会话精简轨迹】
我：……
助手：……

【我在会话里选中的文字】
"""你选中的那段"""

【我的问题】
（你的问题，或默认的「请解释这段文字在当前会话上下文中的含义」）

请结合【会话精简轨迹】解释……先给一句结论，再列 2 到 4 条依据；
如果轨迹里的信息不足以判断，直接说明缺什么，不要编造。
```

**每一问都重新生成轨迹**，所以连续追问时上下文始终跟着会话走。Harness 注入的运行时上下文（时间戳、"Current runtime context" 之类）会被过滤掉，不算"你说的话"。

## 结构

```
index.js              Host 半：三条 HTTP 路由 + 轨迹精简 + prompt 拼装
client.js             Client 半：选区气泡（shell.overlay）+ 会话 id 探针（conversation.input.dock）
lib/deepseek-web.mjs  CDP 驱动（从原版 ChatDriver/CdpClient 移植，惰性加载）
cordis.patch.yml      插入 bubble-ask 这一行
```

路由（同源，仅本机）：

| 路由 | 作用 |
| --- | --- |
| `POST /bubble-ask/prompt` | `{sessionId, selection, question}` → `{prompt, url, stats}` |
| `POST /bubble-ask/send` | 同上，但真的注入网页版并发送 |
| `GET /bubble-ask/health` | 自检：CDP 模块是否就绪、检测到哪些浏览器 |

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖这一行的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `chatUrl` | `https://chat.deepseek.com/` | 网页版地址 |
| `maxMessages` | `12` | 轨迹最多几条消息 |
| `maxCharsPerMessage` | `240` | 每条截断长度 |
| `maxTraceChars` | `2600` | 整段轨迹字数上限 |
| `browserPath` | 空 | 自动发送用的浏览器 exe，留空自动检测 |
| `cdpPort` | `9333` | CDP 端口 |
| `profileDir` | 空 | 登录态目录，留空用 `%APPDATA%\BubbleAsk\edge-profile` |
| `autoSend` | `true` | 是否自动点发送 |

## 已知限制

- 侧边栏浏览器的写入**依赖 Electron `<webview>` 元素的 `executeJavaScript()`**（元素与本插件同在一个渲染进程）。这是浏览器侧（web 版 DSH）没有的能力：那时侧边栏退化成 iframe，只能靠剪贴板兜底。
- `chat.deepseek.com` 返回 `Content-Security-Policy: frame-ancestors 'none'`，任何 iframe 都嵌不了它 —— 侧边栏之所以能显示，是因为 Electron 用的是独立 guest 进程而不是 iframe。
- **`?q=` 传参不可靠**（实测）：请求行超 8KB 报 `414`（纯 ASCII 8029 通过 / 8329 失败）；更关键的是长 prompt 换出的 ~7K URL 会**稳定报 429**，等 3 分钟、单次请求、去掉换行都一样，而 `?q=test` 一直 200。所以 `?q=` 只在 prompt 编码后 ≤ 3000 字符时使用，长提问改走「打开网页 + 直接写入输入框」。
- 网页版 `?q=` 只预填、不自动发送（`autosend=1` 不是它支持的参数）。
- 选区来自 DSH 页面；插件读不到侧边栏 webview 内部的选区（跨进程）。
- 自动写入后若页面尚未渲染完，插件会轮询最多 40 秒；仍失败则退回「完整提问放剪贴板 + 显示全文」。
