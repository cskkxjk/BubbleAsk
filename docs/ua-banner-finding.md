# 「使用环境异常」横幅归因：UA 触发（已验证）

## 结论

`chat.deepseek.com` 在内嵌环境里弹出的

> 使用环境异常 当前页面的使用环境可能存在数据和隐私泄露风险，为保障安全，建议您使用我们的官方产品。

**由 User-Agent 字符串里的 `Electron` 标记触发**。UA 改成普通浏览器形态后横幅消失，改回去又出现。

判据来自站点自己的 minified 包，两处关键代码（`https://fe-static.deepseek.com/chat/static/main.26d4d4c4fd.js`）—— 不是靠猜：

```js
// 环境判定，只看两条：UA 含 electron（不区分大小写），或 window.process.type === 'renderer'
IC = typeof navigator !== 'undefined' &&
     (navigator.userAgent.toLowerCase().includes('electron') ||
      (typeof window !== 'undefined' && 'process' in window && window.process.type === 'renderer'))
```

横幅是 Modal，`onClose` 会把 `closeUnsafeEnvWarn` 写进 localStorage（关一次就不再弹）；该键可被清除，所以「关过了」会污染观察——这一点在做对照实验时必须处理。

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

结论：判据落在 UA 字符串本身，具体是 `Electron/<version>` 这一段的出现（已由 minified 包源码确认）。

## 在内嵌面板里的落地（已验证）

插件自己开的 guest（lease 通道）拿到的主进程 UA 是：

```text
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
  @deepseek-ai/dsh-desktop/0.2.2-rc.1 Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36
```

脱敏位置在 `dsh-plugin/client.js` 的 `connect()`，**必须在首个文档建立之前**（`loadURL` 之前）：

```js
const ua = await element.executeJavaScript('navigator.userAgent', true)
element.setUserAgent(String(ua)
  .replace(/\s*Electron\/[\d.]+/gi, '')
  .replace(/\s*@deepseek-ai\/[\w.-]+\/[\w.-]+/gi, ''))
```

`setUserAgent` 是 webview 的**运行时方法**，不受 `will-attach-webview` 里逐键删除 preferences 的影响，所以这条路可行（早先文档里写的「侧边栏 webview 的 UA 由宿主控制、插件不便插手」是错的）。

对照实验（清掉 `closeUnsafeEnvWarn` 后 reload，排除「关过就不再弹」的污染）实测：

```json
{ "modalVisible": false,
  "dismissFlag": "{\"value\":false,\"__version\":\"0\"}",
  "ua": "…Chrome/152.0.7977.130 Safari/537.36",
  "uaHasElectron": false,
  "title": "DeepSeek - 探索未至之境" }
```

清掉的标记被写回 `value:false` 且弹窗不出现 ⇒ 脱敏是真因。

## 关于「每次重启需重新登录」

这个限制**绕不过分区**，但可以绕过去「登录」这件事本身：实测把网页版 localStorage 里 7 个认证键（不到 1KB）灌进全新分区再 reload 就能免登录并正常对话。插件因此把登录态存进 DSH 自己的凭证存储，下次换分区后写回。详见 [`dsh-plugin/README.md`](../dsh-plugin/README.md#登录态怎么跨重启)。

## 相关代码位置

- 环境判定与横幅：站点 minified 包 `main.26d4d4c4fd.js`（判定 `IC` 在字符偏移 989176，存储键 `closeUnsafeEnvWarn` 的 `create` 在 1405558）
- 侧边栏浏览器分区（不可持久化的根因）：DSH `lib/main.js:10499`，`partition = \`dsh-sidebar-browser-${randomUUID()}\``
- guest 准入校验：DSH `lib/main.js:10543`，`will-attach-webview` 要求 `src` 为 `about:blank#<lease>` 且分区匹配，否则 `preventDefault()`
- 脱敏与登录态迁移：`dsh-plugin/client.js`（`connect()` / `ensureReady()`）
