/**
 * 划词鲸鱼气泡：选中一段文字，鲸鱼提问卡片直接浮出来，想好问题回车就发。
 *
 * 设计要点：
 * 1. **没有「问这段」这一步**。以前的流程是「选中 → 点气泡 → 再弹大卡片」，
 *    多一次点击、还多一层配置（换服务方、复制提问）挡在提问前面；现在选中即提问，
 *    换服务方 / 打开窗口这些配置全部交给工具栏弹窗（浏览器右上角那块）。
 * 2. 影子 DOM 承载 UI，页面 CSS 进不来，我们的样式也漏不出去。
 * 3. 卡片里的 mousedown 只 stopPropagation 不 preventDefault —— 输入框要能聚焦。
 * 4. 一切「消失」都有对应事件（点别处、滚动、改窗口、Esc），不留僵尸卡片。
 */
;(() => {
  if (globalThis.__bubbleAskSelectionBubble) return
  globalThis.__bubbleAskSelectionBubble = true

  /**
   * 少于这么多字不弹。
   *
   * 原先是 8，结果像 crxsoso 顶部那种「EDGE / CHROME / FIREFOX」的短标签选中后
   * 永远不弹 —— 而双击选词、短拖选本身就是明确的意图，不该被字数卡住。
   * 现在只挡「单字」这种明显误触。
   */
  const MIN_CHARS = 2
  /** 卡片与选区的间距。 */
  const GAP = 8

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
    .card {
      position: fixed;
      display: none;
      flex-direction: column;
      gap: 6px;
      width: min(360px, 90vw);
      padding: 9px 10px;
      border-radius: 12px;
      background: #fff;
      box-shadow: 0 10px 30px rgba(24, 32, 74, 0.26), 0 1px 2px rgba(0, 0, 0, 0.16);
      pointer-events: auto;
      font: 500 13px/1.3 "Microsoft YaHei UI", system-ui, -apple-system, sans-serif;
    }
    .card[data-state="shown"] { display: flex; }
    .ask-row { display: flex; align-items: center; gap: 7px; }
    .ask-whale { flex: none; width: 26px; height: auto; opacity: 0.9; pointer-events: none; user-select: none; }
    .ask-input {
      flex: 1 1 auto;
      min-width: 0;
      height: 30px;
      padding: 0 10px;
      border-radius: 9px;
      border: 1px solid #d6defc;
      background: #eff3ff;
      color: #1b2130;
      font: 500 13px/1.2 "Microsoft YaHei UI", system-ui, -apple-system, sans-serif;
      outline: none;
    }
    .ask-input::placeholder { color: #8a90a2; }
    .ask-input:focus { border-color: #4d6bfe; background: #fff; box-shadow: 0 0 0 3px rgba(77, 107, 254, 0.16); }
    .ask-go {
      flex: none;
      height: 30px;
      padding: 0 12px;
      border: none;
      border-radius: 9px;
      cursor: pointer;
      background: linear-gradient(180deg, #5b78ff, #4d6bfe);
      color: #fff;
      font: 600 12.5px/1 "Microsoft YaHei UI", system-ui, -apple-system, sans-serif;
    }
    .ask-go:disabled { opacity: 0.55; cursor: default; }
    .ask-hint { color: #8a90a2; font: 400 11px/1.3 "Microsoft YaHei UI", system-ui, -apple-system, sans-serif; }
    .ask-hint[data-tone="error"] { color: #d64a44; }
    .ask-hint[data-tone="ok"] { color: #3f9a5b; }
  `

  // 选中即出现的提问卡片：小鲸鱼 + 鱼肚输入框 + 发送
  const card = document.createElement('form')
  card.className = 'card'
  card.dataset.state = 'hidden'
  const row = document.createElement('div')
  row.className = 'ask-row'
  // 小鲸鱼：和桌面端、DSH 插件那张卡片同一个形象
  const whale = document.createElement('img')
  whale.className = 'ask-whale'
  whale.alt = ''
  whale.draggable = false
  try {
    whale.src = chrome.runtime.getURL('icons/whale.png')
  } catch (error) {
    whale.style.display = 'none'
  }
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'ask-input'
  input.placeholder = '想问什么？（留空就用默认问题）'
  input.autocomplete = 'off'
  input.spellcheck = false
  const go = document.createElement('button')
  go.type = 'submit'
  go.className = 'ask-go'
  go.textContent = '发送'
  row.append(whale, input, go)
  const hint = document.createElement('div')
  hint.className = 'ask-hint'
  hint.textContent = '回车发送 · 留空用默认问题 · Esc 取消'
  card.append(row, hint)

  shadow.append(style, card)

  /** 当前卡片对应的选区文本。 */
  let pendingText = ''
  /** 选区周围的文字（卡片弹出那一刻的快照；等后台去读时就没了）。 */
  let pendingLocal = null
  /** 卡片对齐的选区矩形。 */
  let anchorRect = null
  /** idle：没有卡片；open：卡片可输入；sending：已提交，等结果。 */
  let mode = 'idle'
  /** 收起时的定时器（成功提示留一会儿再收）。 */
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

  /** 把卡片摆到选区旁边（优先上方，放不下就下方，再夹进视口）。 */
  function placeAt(element, rect) {
    element.dataset.state = 'shown'
    element.style.left = '0px'
    element.style.top = '0px'
    const box = element.getBoundingClientRect()
    let left = rect.left + rect.width / 2 - box.width / 2
    let top = rect.top - box.height - GAP
    if (top < 4) top = rect.bottom + GAP
    left = Math.min(Math.max(4, left), Math.max(4, window.innerWidth - box.width - 4))
    top = Math.min(Math.max(4, top), Math.max(4, window.innerHeight - box.height - 4))
    element.style.left = `${Math.round(left)}px`
    element.style.top = `${Math.round(top)}px`
  }

  /** 抓一份「选区周围的文字」。采集器没加载就返回 null，后端会退回整页文本。 */
  function snapshotLocal() {
    const collect = globalThis.__bubbleAskSelectionContext
    if (typeof collect !== 'function') return null
    try {
      return collect({})
    } catch (error) {
      console.warn('[BubbleAsk] 局部上下文采集失败', error)
      return null
    }
  }

  function setHint(text, tone) {
    hint.textContent = text
    hint.dataset.tone = tone || ''
  }

  /** 选中就弹卡片：不再有「问这段」这一层。 */
  function show() {
    if (mode !== 'idle') return
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
    anchorRect = found.rect
    pendingLocal = snapshotLocal()
    mode = 'open'
    input.value = ''
    input.disabled = false
    go.disabled = false
    setHint('回车发送 · 留空用默认问题 · Esc 取消', '')
    placeAt(card, found.rect)
    input.focus()
  }

  function hide() {
    pendingText = ''
    pendingLocal = null
    anchorRect = null
    mode = 'idle'
    card.dataset.state = 'hidden'
    input.value = ''
    input.disabled = false
    go.disabled = false
    setHint('回车发送 · 留空用默认问题 · Esc 取消', '')
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
      if (mode !== 'idle') return
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
      // 在我们自己的输入框里打字，不要触发页面的选词逻辑
      if (event.composedPath && event.composedPath().includes(host)) return
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

  // 卡片里的按下不要冒泡给页面（否则页面自己的选择/拖拽逻辑会来抢）
  card.addEventListener('mousedown', (event) => {
    event.stopPropagation()
  })

  /**
   * 把后台返回的 stage 翻成人话。
   *
   * 只显示「失败」等于没说 —— 用户既不知道断在哪，我也没法远程判断。
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
      filled: '已填入未确认',
      fill: '没填进去',
      error: '失败',
    }
    const label = labels[stage] || (stage ? `失败(${stage})` : '失败')
    return { label, detail: detail ? `${stage || 'error'}：${detail}` : stage || '未知原因' }
  }

  /**
   * 真正发出去。question 为空 → 后端按「有没有选区」套默认问题；
   * 有内容 → 用户自己写的问题会被放进 prompt 的「我的问题」一节。
   */
  async function send(question) {
    const text = pendingText
    if (!text) {
      hide()
      return
    }
    mode = 'sending'
    input.disabled = true
    go.disabled = true
    setHint('发送中…', '')
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'BA_ASK_SELECTION',
        selection: text,
        question: String(question || ''),
        local: pendingLocal,
      })
      if (result && result.ok) {
        mode = 'open'
        setHint('已发送到网页版', 'ok')
        input.disabled = false
        go.disabled = false
        hideSoon(1200)
        return
      }
      const failure = describeFailure(result)
      setHint(failure.label + '：' + failure.detail, 'error')
      console.warn('[BubbleAsk] 发送失败', result)
    } catch (error) {
      const detail = String(error && error.message ? error.message : error)
      setHint('失败：' + detail, 'error')
      console.warn('[BubbleAsk] 发送异常', error)
    }
    // 失败：卡片留着，问题也留着，改一改可以重发
    mode = 'open'
    input.disabled = false
    go.disabled = false
    input.focus()
  }

  card.addEventListener('submit', (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (mode !== 'open') return
    send(input.value.trim())
  })

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    hide()
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
