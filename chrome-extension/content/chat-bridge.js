/**
 * 通用网页执行器：在服务方页面里填入提问并发送。
 *
 * 由 manifest 的 content_scripts 注入到 6 家服务方页面（chat.deepseek.com、千问、
 * 豆包、ChatGPT、Gemini、Grok）。内容脚本不能 import ESM，所以**服务方定义不写在
 * 本文件里**：background 在 BA_PING / BA_ASK 消息里把 `provider` 对象整条传过来
 * （见 lib/providers.js）。
 *
 * DeepSeek 仍是默认服务方，判定标准与 1.1.x 一致：填进去 → 找发送键 → 点击 →
 * 回读输入框是否被清空；只有确认清空（或 URL 变成会话页）才报告 sent，
 * 否则如实报告 unverified / filled，不谎报成功。
 */
;(() => {
  if (globalThis.__bubbleAskChatBridge) return
  globalThis.__bubbleAskChatBridge = true

  /** 消息里没带 provider（旧调用/手工注入）时的兜底：按 DeepSeek 1.1.x 的行为工作。 */
  const FALLBACK_PROVIDER = {
    id: 'deepseek',
    name: 'DeepSeek',
    composerSelectors: ['textarea[placeholder]', 'textarea', 'div[contenteditable="true"]'],
    sendSelectors: [],
    sendClassHints: ['ds-button--primary', 'ds-button--circle'],
    sendAriaLabels: ['发送', 'send'],
    enterSends: false,
    loginMarkers: ['sign_in', 'signin', '/login'],
    verifyUrlRegex: '/a/chat/s/',
  }

  /** 通用兜底（与 lib/providers.js 的 GENERIC_* 保持一致，内容脚本不 import）。 */
  const GENERIC_COMPOSER_SELECTORS = [
    'textarea[placeholder]',
    'textarea',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    '[role="textbox"]',
  ]
  const GENERIC_SEND_ARIA_LABELS = ['发送', 'send', 'submit', '提交']

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /** provider 消息参数归一化：字段缺失时用兜底，避免一条坏消息把执行器打挂。 */
  function normalizeProvider(raw) {
    const source = raw && typeof raw === 'object' ? raw : {}
    const pickList = (value, fallback) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : fallback)
    return {
      id: typeof source.id === 'string' && source.id ? source.id : FALLBACK_PROVIDER.id,
      name: typeof source.name === 'string' && source.name ? source.name : FALLBACK_PROVIDER.name,
      composerSelectors: pickList(source.composerSelectors, FALLBACK_PROVIDER.composerSelectors),
      sendSelectors: pickList(source.sendSelectors, FALLBACK_PROVIDER.sendSelectors),
      sendClassHints: pickList(source.sendClassHints, FALLBACK_PROVIDER.sendClassHints),
      sendAriaLabels: pickList(source.sendAriaLabels, FALLBACK_PROVIDER.sendAriaLabels),
      enterSends: source.enterSends === true,
      loginMarkers: pickList(source.loginMarkers, FALLBACK_PROVIDER.loginMarkers),
      verifyUrlRegex: typeof source.verifyUrlRegex === 'string' ? source.verifyUrlRegex : '',
    }
  }

  function queryAll(root, selector) {
    if (!root || typeof selector !== 'string' || !selector) return []
    try {
      return [...root.querySelectorAll(selector)]
    } catch (error) {
      // 非法选择器（含部分分支不支持的语法）只跳过这一条，不影响其它兜底
      return []
    }
  }

  function visible(element) {
    if (!element || !element.getBoundingClientRect) return false
    const rect = element.getBoundingClientRect()
    if (rect.width <= 1 || rect.height <= 1) return false
    const style = window.getComputedStyle(element)
    return Boolean(style) && style.display !== 'none' && style.visibility !== 'hidden'
  }

  function isEnabled(element) {
    if (!element) return false
    if (element.disabled) return false
    if (element.getAttribute && element.getAttribute('aria-disabled') === 'true') return false
    return true
  }

  /** 从元素向上取若干层祖先（含自身），用于把查找范围限制在输入框附近。 */
  function ancestors(element, depth) {
    const result = []
    let current = element
    for (let index = 0; index < depth && current; index += 1) {
      result.push(current)
      current = current.parentElement
    }
    return result
  }

  /** 找到输入框：provider 规则优先，通用兜底其次；找不到返回 null。 */
  function findComposer(provider) {
    const selectors = [...new Set([...provider.composerSelectors, ...GENERIC_COMPOSER_SELECTORS])]
    for (const selector of selectors) {
      for (const node of queryAll(document, selector)) {
        if (visible(node) && isEnabled(node) && !node.readOnly) return node
      }
    }
    return null
  }

  /** 等输入框出现（SPA 冷启动要十几秒）。 */
  async function waitForComposer(provider, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const composer = findComposer(provider)
      if (composer) return composer
      await sleep(200)
    }
    return null
  }

  function isTextControl(composer) {
    const tag = (composer && composer.tagName) || ''
    return tag === 'TEXTAREA' || tag === 'INPUT'
  }

  function composerText(composer) {
    if (!composer) return ''
    if (isTextControl(composer)) return String(composer.value || '')
    return String(composer.innerText || composer.textContent || '')
  }

  function dispatchInputEvents(composer) {
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    composer.dispatchEvent(new Event('change', { bubbles: true }))
  }

  /**
   * textarea / input 写入。
   * 受控组件直接改 value 不触发 React 的 onChange，必须走原型链上的原生 setter
   * 再派发 input 事件，页面才会把这段文字当成用户输入。
   */
  function fillTextControl(composer, text) {
    composer.focus()
    const proto = composer.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
    if (descriptor && descriptor.set) descriptor.set.call(composer, text)
    else composer.value = text
    dispatchInputEvents(composer)
  }

  /**
   * 富文本（contenteditable）写入。
   *
   * 不能直接改 textContent —— ProseMirror / Quill 这类编辑器只看自己维护的模型，
   * 直接改 DOM 会被下一次渲染覆盖，而且不会触发页面自己的 input 处理。
   * 这里先选中编辑器现有内容，再用 `document.execCommand('insertText')` 走浏览器的
   * 真实输入通道（页面会收到 beforeinput/input）；失败时退 `insertHTML` 保留换行。
   */
  function fillRichText(composer, text) {
    composer.focus()
    const selection = window.getSelection()
    if (selection) {
      try {
        const range = document.createRange()
        range.selectNodeContents(composer)
        selection.removeAllRanges()
        selection.addRange(range)
      } catch (error) {
        /* 选不中也继续，insertText 会插到光标处 */
      }
    }
    let filled = false
    try {
      filled = document.execCommand('insertText', false, text)
    } catch (error) {
      filled = false
    }
    if (!filled) {
      const escaped = String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>')
      try {
        filled = document.execCommand('insertHTML', false, escaped)
      } catch (error) {
        filled = false
      }
    }
    dispatchInputEvents(composer)
    return filled
  }

  function fillComposer(composer, text) {
    if (isTextControl(composer)) {
      fillTextControl(composer, text)
      return true
    }
    return fillRichText(composer, text)
  }

  /** 按 provider 规则找发送按钮：显式选择器 → class 组合 → aria 文案 → 通用图标按钮。 */
  function findSendButton(composer, provider) {
    for (const selector of provider.sendSelectors) {
      for (const node of queryAll(document, selector)) {
        if (visible(node) && isEnabled(node)) return node
      }
    }

    if (provider.sendClassHints.length > 0) {
      let partial = null
      for (const scope of ancestors(composer, 5)) {
        for (const node of queryAll(scope, 'button, [role="button"]')) {
          if (!visible(node) || !isEnabled(node)) continue
          const className = typeof node.className === 'string' ? node.className : ''
          if (provider.sendClassHints.every((hint) => className.includes(hint))) return node
          if (!partial && provider.sendClassHints.some((hint) => className.includes(hint))) partial = node
        }
        if (partial) return partial
      }
    }

    const ariaHints = [...new Set([...provider.sendAriaLabels, ...GENERIC_SEND_ARIA_LABELS])].map((hint) =>
      hint.toLowerCase(),
    )
    for (const scope of [...ancestors(composer, 5), document]) {
      for (const node of queryAll(scope, 'button, [role="button"], input[type="submit"]')) {
        if (!visible(node) || !isEnabled(node)) continue
        const label = String(
          (node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('title'))) || node.innerText || '',
        )
          .trim()
          .toLowerCase()
        if (!label) continue
        if (ariaHints.some((hint) => label.includes(hint))) return node
      }
    }

    // 兜底：输入框所在容器里最后一个可见的、无文字的图标按钮（通常是发送键）
    for (const container of ancestors(composer.parentElement, 3)) {
      const buttons = queryAll(container, 'button, [role="button"]').filter(
        (node) => visible(node) && isEnabled(node),
      )
      for (let index = buttons.length - 1; index >= 0; index -= 1) {
        const button = buttons[index]
        const text = String(button.innerText || '').trim()
        if (!text && button.querySelector('svg')) return button
      }
    }
    return null
  }

  /** 按回车提交（provider.enterSends 为 true 时用作发送兜底）。 */
  function pressEnter(composer) {
    composer.focus()
    const options = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
    for (const type of ['keydown', 'keypress', 'keyup']) {
      try {
        composer.dispatchEvent(new KeyboardEvent(type, options))
      } catch (error) {
        /* 某些分支的 KeyboardEvent 构造受限，忽略 */
      }
    }
  }

  function compileVerifyRegex(provider) {
    const source = String(provider.verifyUrlRegex || '').trim()
    if (!source) return null
    try {
      return new RegExp(source)
    } catch (error) {
      return null
    }
  }

  function urlMatchedSince(startedUrl, provider) {
    const regex = compileVerifyRegex(provider)
    if (!regex) return false
    // 必须先发生 URL 变化才认「会话页」：否则同一会话里第二次发送会被 URL 规则直接判成功
    return location.href !== startedUrl && regex.test(location.href)
  }

  /**
   * 点击/回车后回读：输入框被清空才算成功；URL 变成会话页也算成功（见上）。
   *
   * 注意不能盯着点击前拿到的那个节点：在首页发送会新建会话并跳转，旧 composer
   * 会被整体替换，永远读不到「已清空」。所以每次轮询都重新查一次输入框。
   */
  async function verifySent(startedUrl, provider, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const current = findComposer(provider)
      const text = current ? composerText(current).trim() : ''
      if (!text) return true
      if (urlMatchedSince(startedUrl, provider)) return true
      await sleep(120)
    }
    return false
  }

  function isLoginUrl(provider) {
    const href = location.href.toLowerCase()
    return provider.loginMarkers.some((marker) => {
      const value = String(marker || '').toLowerCase()
      return Boolean(value) && href.includes(value)
    })
  }

  function loginResult(provider) {
    return {
      ok: false,
      stage: 'login',
      detail: `这个窗口里的 ${provider.name} 还没登录，请先登录一次（之后会记住）`,
    }
  }

  /** 完整流程：检查登录 → 等输入框 → 填入 → 找发送键/回车 → 回读确认。 */
  async function ask(provider, prompt) {
    if (isLoginUrl(provider)) return loginResult(provider)

    const composer = await waitForComposer(provider, 25000)
    if (!composer) {
      // 等待期间可能被重定向到登录页
      if (isLoginUrl(provider)) return loginResult(provider)
      return {
        ok: false,
        stage: 'no-composer',
        detail: `25 秒内没找到 ${provider.name} 的输入框（${document.readyState}，${location.href}），页面可能还在加载或已改版`,
      }
    }

    fillComposer(composer, prompt)
    await sleep(150)
    const currentComposer = findComposer(provider) || composer
    if (!composerText(currentComposer).trim()) {
      return { ok: false, stage: 'fill', detail: '文字没能写进输入框，页面结构可能已改版' }
    }

    const startedUrl = location.href
    let button = null
    for (let attempt = 0; attempt < 20 && !button; attempt += 1) {
      button = findSendButton(currentComposer, provider)
      if (!button) await sleep(150)
    }

    if (button) {
      button.click()
      if (await verifySent(startedUrl, provider, 8000)) {
        return { ok: true, stage: 'sent', detail: `已发送到 ${provider.name}` }
      }
      return { ok: false, stage: 'unverified', detail: '已点击发送但没能确认输入框被清空，请在窗口里核对' }
    }

    if (provider.enterSends) {
      pressEnter(currentComposer)
      if (await verifySent(startedUrl, provider, 8000)) {
        return { ok: true, stage: 'sent', detail: `已按回车发送到 ${provider.name}` }
      }
      return {
        ok: false,
        stage: 'filled',
        detail: '文字已填入并按下回车，但没能确认发送成功，请在窗口里核对',
      }
    }

    return {
      ok: false,
      stage: 'no-button',
      detail: '找不到发送按钮；文字已填入，请在窗口里手动发送',
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false
    const provider = normalizeProvider(message.provider)

    if (message.type === 'BA_PING') {
      sendResponse({ ok: true, ready: Boolean(findComposer(provider)), url: location.href, providerId: provider.id })
      // 始终回 true：有些 Chromium 分支（如 Maxthon）会按返回值判断「是否会有响应」
      return true
    }

    if (message.type === 'BA_ASK') {
      ask(provider, String(message.prompt || ''))
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({ ok: false, stage: 'error', detail: String(error && error.message ? error.message : error) }),
        )
      return true
    }

    return false
  })
})()
