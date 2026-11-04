/**
 * 划词气泡：选中一段文字后，在选区旁浮出「问这段」。
 *
 * 设计要点：
 * 1. 影子 DOM 承载 UI，页面 CSS 进不来，我们的样式也漏不出去。
 * 2. 按下按钮时 preventDefault，否则 mousedown 会清掉页面选区，点完就取不到文字了。
 * 3. 只在真正有正文选区时出现：不打断输入框里的选择、不打断富文本编辑。
 * 4. 一切「消失」都有对应事件（点别处、滚动、改窗口、Esc），不留僵尸气泡。
 */
;(() => {
  if (globalThis.__bubbleAskSelectionBubble) return
  globalThis.__bubbleAskSelectionBubble = true

  /** 少于这么多字不弹：点一下、选个词不该打扰。 */
  const MIN_CHARS = 8
  /** 气泡与选区的间距。 */
  const GAP = 8

  const SVG_NS = 'http://www.w3.org/2000/svg'

  const host = document.createElement('div')
  host.setAttribute('data-bubble-ask', 'bubble')
  host.style.cssText = [
    'position: fixed',
    'left: 0',
    'top: 0',
    'width: 0',
    'height: 0',
    'z-index: 2147483647',
    'pointer-events: none',
  ].join(';')

  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    .pill {
      position: fixed;
      display: none;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      border: none;
      border-radius: 999px;
      background: linear-gradient(180deg, #5b78ff, #4d6bfe);
      color: #fff;
      font: 500 13px/1.2 "Microsoft YaHei UI", system-ui, -apple-system, sans-serif;
      box-shadow: 0 6px 20px rgba(24, 32, 74, 0.28), 0 1px 2px rgba(0, 0, 0, 0.18);
      cursor: pointer;
      pointer-events: auto;
      white-space: nowrap;
      transition: transform 90ms ease, box-shadow 120ms ease, opacity 120ms ease;
      opacity: 0;
    }
    .pill[data-state="shown"] { display: inline-flex; opacity: 1; }
    .pill:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(24, 32, 74, 0.34), 0 1px 2px rgba(0, 0, 0, 0.18); }
    .pill:active { transform: translateY(0); }
    .pill[data-busy="true"] { cursor: default; opacity: 0.85; }
    .pill[data-tone="error"] { background: linear-gradient(180deg, #e5605a, #d64a44); }
    .pill[data-tone="ok"] { background: linear-gradient(180deg, #3f9a5b, #338451); }
    .pill svg { width: 14px; height: 14px; flex: none; }
  `

  const pill = document.createElement('button')
  pill.type = 'button'
  pill.className = 'pill'
  pill.dataset.state = 'hidden'

  const icon = document.createElementNS(SVG_NS, 'svg')
  icon.setAttribute('viewBox', '0 0 24 24')
  icon.setAttribute('fill', 'none')
  icon.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-4 3.5v-3.5A2.5 2.5 0 0 1 4 12.5v-7Z')
  path.setAttribute('fill', 'currentColor')
  icon.appendChild(path)

  const label = document.createElement('span')
  label.textContent = '问这段'

  pill.append(icon, label)
  shadow.append(style, pill)

  /** 当前气泡对应的选区文本。 */
  let pendingText = ''
  /** 隐藏时的收尾（清定时器）。 */
  let hideTimer = null

  function isEditable(node) {
    let element = node && node.nodeType === 1 ? node : node && node.parentElement
    for (let depth = 0; depth < 6 && element; depth += 1) {
      const tag = (element.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
      if (element.isContentEditable) return true
      element = element.parentElement
    }
    return false
  }

  /** 取当前选区：文本、矩形、以及是否可用。 */
  function readSelection() {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return { ok: false }
    }
    const text = String(selection.toString() || '').trim()
    if (text.length < MIN_CHARS) return { ok: false }
    if (isEditable(selection.anchorNode)) return { ok: false }
    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    if (!rect || (rect.width === 0 && rect.height === 0)) return { ok: false }
    // 选区在可视区域外时不打扰
    if (rect.bottom < 0 || rect.top > window.innerHeight) return { ok: false }
    return { ok: true, text, rect }
  }

  function place(rect) {
    pill.dataset.state = 'shown'
    pill.style.left = '0px'
    pill.style.top = '0px'
    const box = pill.getBoundingClientRect()
    let left = rect.left + rect.width / 2 - box.width / 2
    let top = rect.top - box.height - GAP
    if (top < 4) top = rect.bottom + GAP
    left = Math.min(Math.max(4, left), Math.max(4, window.innerWidth - box.width - 4))
    top = Math.min(Math.max(4, top), Math.max(4, window.innerHeight - box.height - 4))
    pill.style.left = `${Math.round(left)}px`
    pill.style.top = `${Math.round(top)}px`
  }

  function show() {
    const found = readSelection()
    if (!found.ok) {
      hide()
      return
    }
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    pendingText = found.text
    pill.dataset.tone = ''
    pill.dataset.busy = 'false'
    label.textContent = '问这段'
    place(found.rect)
  }

  function hide() {
    pendingText = ''
    pill.dataset.state = 'hidden'
    pill.dataset.busy = 'false'
  }

  function hideSoon(delayMs) {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      hideTimer = null
      hide()
    }, delayMs)
  }

  // 选区变了就重新判断（延迟一拍，等浏览器把选区稳定下来）
  let selectionTimer = null
  document.addEventListener(
    'selectionchange',
    () => {
      if (pill.dataset.busy === 'true') return
      if (selectionTimer) clearTimeout(selectionTimer)
      selectionTimer = setTimeout(show, 120)
    },
    true,
  )

  // 鼠标松开后定位更准（双击选词、拖选都走这里）
  document.addEventListener(
    'mouseup',
    (event) => {
      if (event.button !== 0) return
      if (event.composedPath && event.composedPath().includes(host)) return
      setTimeout(show, 10)
    },
    true,
  )

  document.addEventListener(
    'keyup',
    (event) => {
      if (event.key === 'Escape') {
        hide()
        return
      }
      if (event.shiftKey || event.key === 'a' || event.key === 'A') setTimeout(show, 10)
    },
    true,
  )

  // 点别处 / 滚动 / 改窗口大小 → 收起
  const hideOnOutside = (event) => {
    if (event.composedPath && event.composedPath().includes(host)) return
    hide()
  }
  document.addEventListener('mousedown', hideOnOutside, true)
  // 有些脚本或无障碍工具只派发 click（没有 mousedown），一并处理
  document.addEventListener('click', hideOnOutside, true)
  window.addEventListener('scroll', () => hide(), { capture: true, passive: true })
  window.addEventListener('resize', () => hide(), { passive: true })

  // 按下时保住选区：否则 mousedown 一到，页面就把 selection 清了
  pill.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })

  /**
   * 把后台返回的 stage 翻成人话。
   *
   * 只显示「失败」等于没说 —— 用户既不知道断在哪，我也没法远程判断。
   * 短标签放在气泡上，完整原因放进 title（悬停可读）。
   */
  function describeFailure(result) {
    const stage = result && result.stage ? String(result.stage) : ''
    const detail = result && result.detail ? String(result.detail) : ''
    const labels = {
      login: '未登录',
      collect: '读不到页面',
      window: '窗口没起来',
      'no-composer': '找不到输入框',
      'no-button': '找不到发送键',
      unverified: '发送未确认',
      busy: '忙',
      version: '版本不符',
      ipc: '服务不通',
      module: '模块未就绪',
      fill: '没填进去',
      error: '失败',
    }
    const label = labels[stage] || '失败'
    return { label, detail: detail ? `${stage || 'error'}：${detail}` : stage || '未知原因' }
  }

  pill.addEventListener('click', async (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (pill.dataset.busy === 'true') return
    const text = pendingText
    if (!text) {
      hide()
      return
    }
    pill.dataset.busy = 'true'
    label.textContent = '发送中…'
    try {
      const result = await chrome.runtime.sendMessage({ type: 'BA_ASK_SELECTION', selection: text })
      if (result && result.ok) {
        pill.dataset.tone = 'ok'
        label.textContent = '已发送'
      } else {
        pill.dataset.tone = 'error'
        const failure = describeFailure(result)
        pill.dataset.tone = 'error'
        label.textContent = failure.label
        pill.title = failure.detail
        console.warn('[BubbleAsk] 发送失败', result)
      }
    } catch (error) {
      const detail = String(error && error.message ? error.message : error)
      pill.dataset.tone = 'error'
      label.textContent = '失败'
      pill.title = detail
      console.warn('[BubbleAsk] 发送异常', error)
    } finally {
      pill.dataset.busy = 'false'
      // 出错时多留一会儿，让人能看清 / 悬停读原因
      hideSoon(pill.dataset.tone === 'error' ? 6000 : 1200)
    }
  })

  /**
   * 采集请求的处理者。
   *
   * 为什么不让后台注入：Maxthon 这类 Chromium 分支**没有实现 `chrome.scripting`**
   * （连老的 `chrome.tabs.executeScript` 也没有），点的时候再注入必然失败。
   * 而内容脚本本身是正常运行的 —— 所以改成「后台问一句，页面自己把上下文交出来」。
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'BA_COLLECT') return false
    const collect = globalThis.__bubbleAskCollect
    if (typeof collect !== 'function') {
      sendResponse({ ok: false, detail: '页面里的采集器没加载（collect.js）' })
      return true
    }
    try {
      sendResponse({ ok: true, context: collect(message.limits || {}) })
    } catch (error) {
      sendResponse({ ok: false, detail: String(error && error.message ? error.message : error) })
    }
    // 始终回 true：有些 Chromium 分支（如 Maxthon）会按返回值判断「是否会有响应」，
    // 返回 false 时同步 sendResponse 可能被丢弃。
    return true
  })

  function mount() {
    if (!document.documentElement) return
    document.documentElement.appendChild(host)
  }
  if (document.documentElement) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })
})()
