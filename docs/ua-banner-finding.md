# 「使用环境异常」横幅归因：UA 触发（已验证）

## 结论

`chat.deepseek.com` 在内嵌环境里弹出的

> 使用环境异常 当前页面的使用环境可能存在数据和隐私泄露风险，为保障安全，建议您使用我们的官方产品。

**由 User-Agent 字符串里的 `Electron` 标记触发**。UA 改成普通浏览器形态后横幅消失，改回去又出现。因此 Bubble Ask 不使用侧边栏内嵌浏览器，改走原生窗口。

## 实验方法

不依赖 DSH，用独立临时 profile 启动 Edge，通过 CDP 在同一页面内只改 UA 一个变量，三次扫描同一页面的 `document.body.innerText`。

- 临时 profile：`%TEMP%\bubbleask-ua-probe-<时间戳>`（不与用户登录 profile 共用，实验后删除）
- 启动参数：`--app=https://chat.deepseek.com/ --user-data-dir=<临时目录> --remote-debugging-port=<端口> --remote-allow-origins=* --no-first-run --no-default-browser-check --disable-sync --disable-extensions`
- 切换 UA：CDP `Emulation.setUserAgentOverride`
- 重载：CDP `Page.reload`，轮询 `document.readyState === 'complete'` 且正文长度超过阈值后再等 2.5 秒
- 扫描：`Runtime.evaluate` 读 `navigator.userAgent`、`navigator.userAgentData.brands`、`navigator.webdriver`、`navigator.plugins.length`，并在正文里匹配特征词 `使用环境异常` / `数据和隐私泄露` / `隐私泄露风险` / `官方产品` / `环境异常`

## 结果

| 阶段 | UA | `brands` | `webdriver` | 横幅 |
| --- | --- | --- | --- | --- |
| 基线 | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0` | 有值 | false | 无 |
| 实验 | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DeepSeekHarness/0.2.1 Chrome/156.0.4314.58 Electron/38.0.0 Safari/537.36` | 空 | false | **出现** |
| 回退 | 改回基线 UA 并重载 | 空 | false | 无 |

命中正文原文：

```text
… 浙ICP备2023025841号 · 联系我们 使用环境异常 当前页面的使用环境可能存在数据和隐私泄露风险，为保障安全，建议您使用我们的官方产品。
```

### 排除项

- **不是 `userAgentData.brands`**：实验阶段 `brands` 为空且出现横幅，回退阶段 `brands` 同样为空但横幅消失，说明 brands 不是判据。
- **不是 `navigator.webdriver`**：三次均为 `false`。
- **不是插件数量**：三次 `navigator.plugins.length` 均为 5。

结论：判据落在 UA 字符串本身，具体是 `Electron/<version>` 这一段的出现。

## 对设计的含义

| 问题 | 是否可解 | 说明 |
| --- | --- | --- |
| 「使用环境异常」横幅 | 可解 | 把 guest 的 UA 改成普通浏览器形态即可 |
| 每次 DSH 重启需重新登录 | 不可解 | 侧边栏 webview 的存储分区由主进程生成 `dsh-sidebar-browser-${randomUUID()}`，无 `persist:` 前缀，仅存活于进程内存；分区名与生命周期均由宿主决定，插件无法干预 |

因此「DSH GUI 内嵌 DeepSeek 页面」这一形态的现实结果是：**横幅可以消除，但每次重启 DSH 仍需登录一次**。

## 未验证的部分

只验证了「UA 能消除横幅」这一机制，**未验证能否把 UA 改到 DSH 的侧边栏 webview 上**。可行路径是 `<webview>.setUserAgent()`（插件与该元素同处一个渲染进程），但需要等 webview 挂载后再设置并重载，会有一次可见的重新加载。若要走这条路，需单独验证。

## 决策

本仓库当前采用 **原生窗口** 方案：

- 无「环境异常」横幅（UA 里没有 Electron 标记）
- 登录一次长期有效（持久化 profile，默认 `%APPDATA%\BubbleAsk\edge-profile`）
- 代价：DeepSeek 是独立 OS 窗口，不嵌入 DSH 窗口内部

若后续 DSH 改为持久化浏览器分区（或暴露 UA 配置），可重新评估内嵌方案。

## 相关代码位置

- 侧边栏浏览器分区（不可持久化的根因）：DSH `lib/main.js:10499`，`partition = \`dsh-sidebar-browser-${randomUUID()}\``
- guest 准入校验（插件无法自建 webview）：DSH `lib/main.js:10543`，`will-attach-webview` 要求 `src` 为 `about:blank#<lease>` 且分区匹配，否则 `preventDefault()`
- 原生窗口启动参数（UA 不含 Electron）：`src/engine/EdgeHost.cs` 的 `EnsureStarted()`
