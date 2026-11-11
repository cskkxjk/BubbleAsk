/**
 * 老内核兼容层：`chrome.runtime.sendMessage` 的 Promise 形式。
 *
 * Chromium 99 之前，扩展里的 `await chrome.runtime.sendMessage(...)` 拿不到 Promise
 * （最早要到 Chrome 99 才支持）；Maxthon 这类分支甚至直接返回 `undefined`。
 * 而 Windows 7 上能装的最后一个 Chrome 就是 109，实际很多老机器停在 88 附近，
 * 所以这里统一走「回调 + 超时」，并顺手兼容仍然返回 Promise 的新内核。
 *
 * 约定：**永远 resolve**（拿不到回复就是 null），调用方靠返回值判断，不靠 catch。
 *
 * 这是一个普通脚本（不是模块）：内容脚本不支持 ESM，popup.html 也在模块脚本前
 * 用 <script src> 引入它 —— 一份实现，两处复用。
 */
;(() => {
  if (globalThis.__baSendMessage) return

  /**
   * @param {object} message 发给后台的消息
   * @param {number} [timeoutMs] 超时（默认 120 秒，等网页版发送结果够用）
   * @returns {Promise<object|null>}
   */
  globalThis.__baSendMessage = function __baSendMessage(message, timeoutMs) {
    const limit = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 120000
    return new Promise((resolve) => {
      let settled = false
      let timer = null
      const finish = (value) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(value === undefined ? null : value)
      }
      timer = setTimeout(() => finish(null), limit)
      try {
        // 同时挂回调：新内核会既返回 Promise 又回调，finish 保证只结算一次
        const maybe = chrome.runtime.sendMessage(message, (reply) => {
          // 读掉 lastError：对端没响应时它会有值，但对我们只是「拿不到回复」
          void chrome.runtime.lastError
          finish(reply)
        })
        if (maybe && typeof maybe.then === 'function') {
          maybe.then(finish, () => finish(null))
        }
      } catch (error) {
        finish(null)
      }
    })
  }
})()
