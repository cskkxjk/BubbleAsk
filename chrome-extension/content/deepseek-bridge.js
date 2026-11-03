/**
 * chat.deepseek.com 侧的执行器。
 *
 * 为什么必须在这一页里执行：DeepSeek 的登录 cookie 是 `SameSite=Strict`，
 * 只有顶层访问 chat.deepseek.com 时才带得出去。任何 iframe 方案都拿不到登录态，
 * 所以侧边窗口必须是**真实标签页**，由本脚本在页面内注入并点发送。
 *
 * 与桌面端 ChatDriver 同一套判定标准：填进去、点发送、回读输入框是否被清空，
 * 只有确认清空才报告 sent；否则如实报告 unverified，不谎报成功。
 */
;(() => {
  const COMPOSER_SELECTORS = [
    'textarea[name="search"]',
    'textarea[placeholder]',
    'textarea',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
  ]

  const SEND_CLASS_HINTS = ['ds-button--primary', 'ds-button--circle']

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function visible(element) {
    if (!element || !element.getBoundingClientRect) return false
    const rect = element.getBoundingClientRect()
    if (rect.width <= 1 || rect.height <= 1) return false
    const style = window.getComputedStyle(element)
    return Boolean(style) && style.display !== 'none' && style.visibility !== 'hidden'
  }

  /** 找到输入框；找不到返回 null。 */
  function findComposer() {
    for (const selector of COMPOSER_SELECTORS) {
      for (const node of document.querySelectorAll(selector)) {
        if (visible(node) && !node.disabled && !node.readOnly) return node
      }
    }
    return null
  }

  /** 等输入框出现（SPA 冷启动要十几秒）。 */
  async function waitForComposer(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const composer = findComposer()
      if (composer) return composer
      await sleep(200)
    }
    return null
  }

  /**
   * 写入文本。
   *
   * 受控组件直接改 value 不触发 React 的 onChange，必须走原型链上的原生 setter
   * 再派发 input 事件，页面才会把这段文字当成用户输入。
   */
  function setComposerValue(composer, text) {
    composer.focus()
    if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      const proto = composer.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
      if (descriptor && descriptor.set) descriptor.set.call(composer, text)
      else composer.value = text
    } else {
      composer.textContent = text
    }
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    composer.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function composerText(composer) {
    if (!composer) return ''
    if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') return String(composer.value || '')
    return String(composer.innerText || composer.textContent || '')
  }

  /** 在输入框附近找发送按钮。 */
  function findSendButton(composer) {
    let scope = composer
    for (let up = 0; up < 5 && scope; up += 1) {
      const candidates = scope.querySelectorAll('button, [role="button"]')
      let best = null
      for (const candidate of candidates) {
        if (!visible(candidate)) continue
        const className = typeof candidate.className === 'string' ? candidate.className : ''
        const primary = SEND_CLASS_HINTS.some((hint) => className.includes(hint))
        const round = SEND_CLASS_HINTS.every((hint) => className.includes(hint))
        if (primary && round) return candidate
        if (!best && primary) best = candidate
      }
      if (best) return best
      scope = scope.parentElement
    }
    // 兜底：输入框所在容器里最后一个可见的、无文字的按钮（通常是图标按钮）
    let container = composer.parentElement
    for (let up = 0; up < 3 && container; up += 1) {
      const buttons = [...container.querySelectorAll('button, [role="button"]')].filter(visible)
      for (let index = buttons.length - 1; index >= 0; index -= 1) {
        const button = buttons[index]
        const text = String(button.innerText || '').trim()
        if (!text && button.querySelector('svg')) return button
      }
      container = container.parentElement
    }
    return null
  }

  /**
   * 点击发送后回读：输入框被清空才算成功。
   *
   * 注意不能盯着点击前拿到的那个节点：在首页发送会**新建会话并跳转**到
   * `/a/chat/s/<id>`，旧 textarea 被整体替换，永远读不到「已清空」。
   * 所以每次轮询都重新查一次输入框，并把「URL 已经变成会话页」也当作成功信号。
   */
  async function verifySent(composer, timeoutMs) {
    const startedPath = location.pathname
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const current = findComposer()
      const text = current ? composerText(current).trim() : ''
      if (!text) return true
      const navigated = location.pathname !== startedPath && /\/a\/chat\/s\//.test(location.pathname)
      if (navigated && composerText(composer).trim() === '') return true
      await sleep(120)
    }
    return false
  }

  /** 完整流程：等输入框 → 填入 → 找按钮 → 点击 → 回读。 */
  async function ask(prompt) {
    if (location.pathname.includes('sign_in')) {
      return { ok: false, stage: 'login', detail: '这个窗口里的 DeepSeek 还没登录，请先登录一次（之后会记住）' }
    }
    const composer = await waitForComposer(25000)
    if (!composer) {
      return {
        ok: false,
        stage: 'no-composer',
        detail: `25 秒内没找到输入框（${document.readyState}，${location.href}），页面可能还在加载或已改版`,
      }
    }

    setComposerValue(composer, prompt)
    await sleep(150)
    if (!composerText(composer).trim()) {
      return { ok: false, stage: 'fill', detail: '文字没能写进输入框，页面结构可能已改版' }
    }

    let button = null
    for (let attempt = 0; attempt < 20 && !button; attempt += 1) {
      button = findSendButton(composer)
      if (!button) await sleep(150)
    }
    if (!button) {
      return { ok: false, stage: 'no-button', detail: '找不到发送按钮；文字已填入，请在窗口里手动回车' }
    }

    button.click()
    if (await verifySent(composer, 8000)) {
      return { ok: true, stage: 'sent', detail: '已发送到 DeepSeek' }
    }
    return { ok: false, stage: 'unverified', detail: '已点击发送但没能确认输入框被清空，请在窗口里核对' }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false
    if (message.type === 'BA_PING') {
      sendResponse({ ok: true, ready: Boolean(findComposer()), url: location.href })
      return false
    }
    if (message.type === 'BA_ASK') {
      ask(String(message.prompt || ''))
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, stage: 'error', detail: String(error && error.message ? error.message : error) }))
      return true
    }
    return false
  })
})()
