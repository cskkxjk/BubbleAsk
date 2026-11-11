/**
 * 划词鲸鱼气泡：选中一段文字，鲸鱼提问卡片直接浮出来，想好问题回车就发。
 *
 * 设计要点：
 * 1. 选中即出卡片，中间没有第二次点击。换服务方、打开窗口这些配置放在工具栏弹窗里。
 * 2. 影子 DOM 承载 UI，页面 CSS 进不来，我们的样式也漏不出去。
 * 3. 卡片里的 mousedown 只 stopPropagation 不 preventDefault —— 输入框要能聚焦。
 * 4. 每种收起都有对应事件（点别处、滚动、改窗口、Esc），不留残留卡片。
 */
;(() => {
  if (globalThis.__bubbleAskSelectionBubble) return
  globalThis.__bubbleAskSelectionBubble = true

  /**
   * 少于这么多字不弹。
   *
   * 原先是 8，crxsoso 顶部那种「EDGE / CHROME / FIREFOX」短标签选中后永远不弹；
   * 双击选词、短拖选都是明确意图，字数门槛只挡单字这种明显误触。
   */
  const MIN_CHARS = 2
  /** 卡片与选区的间距。 */
  const GAP = 8
  /** 卡片空闲时的提示。 */
  const HINT_IDLE = '回车发送 · 留空用默认问题 · Esc 取消'

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
  input.placeholder = '想问什么？留空用默认问题'
  input.autocomplete = 'off'
  input.spellcheck = false
  const go = document.createElement('button')
  go.type = 'submit'
  go.className = 'ask-go'
  go.textContent = '发送'
  row.append(whale, input, go)
  const hint = document.createElement('div')
  hint.className = 'ask-hint'
  hint.textContent = HINT_IDLE
  card.append(row, hint)

  shadow.append(style, card)

  /** 当前卡片对应的选区文本。 */
  let pendingText = ''
  /** 选区周围的文字与 DOM 路径（卡片出现那一刻的快照；等后台去读时就没了）。 */
  let pendingLocal = null
  let pendingAncestors = []
  /** idle：没有卡片；open：卡片可输入；sending：已提交，等结果；done：已发出，等收起。 */
  let mode = 'idle'
  /** 收起时的定时器（成功提示留一会儿再收）。 */
  let hideTimer = null
  /** 每次弹出或收起都加一，用来丢掉上一轮发送的回复，避免写到新卡片上。 */
  let session = 0

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

  /**
   * 抓一份「选区周围的文字 + 选区 DOM 路径」。
   * 采集器没加载时返回空值，后端退回整页文本。
   */
  function snapshotSelection() {
    const local = globalThis.__bubbleAskSelectionContext
    const ancestors = globalThis.__bubbleAskSelectionAncestors
    const snapshot = { local: null, ancestors: [] }
    try {
      if (typeof local === 'function') snapshot.local = local({})
      if (typeof ancestors === 'function') snapshot.ancestors = ancestors(4) || []
    } catch (error) {
      console.warn('[BubbleAsk] 局部上下文采集失败', error)
    }
    return snapshot
  }

  function setHint(text, tone, detail) {
    hint.textContent = text
    hint.dataset.tone = tone || ''
    hint.title = detail || ''
  }

  /** 选中就弹卡片。 */
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
    const snapshot = snapshotSelection()
    session += 1
    pendingText = found.text
    pendingLocal = snapshot.local
    pendingAncestors = snapshot.ancestors
    mode = 'open'
    input.value = ''
    input.disabled = false
    go.disabled = false
    setHint(HINT_IDLE, '')
    placeAt(card, found.rect)
    input.focus()
  }

  function hide() {
    session += 1
    pendingText = ''
    pendingLocal = null
    pendingAncestors = []
    mode = 'idle'
    card.dataset.state = 'hidden'
    input.value = ''
    input.disabled = false
    go.disabled = false
    setHint(HINT_IDLE, '')
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
   * 把后台返回的 stage 翻成短标签，阶段名与细节放到悬停提示里。
   */
  function describeFailure(result) {
    const stage = result && result.stage ? String(result.stage) : ''
    const detail = result && result.detail ? String(result.detail) : ''
    const labels = {
      login: '请先在窗口里登录',
      collect: '读不到这个页面',
      window: '服务方窗口没打开',
      'no-composer': '页面里找不到输入框',
      'no-button': '找不到发送按钮',
      unverified: '发送结果未确认',
      fill: '文字没填进输入框',
      error: '发送失败',
    }
    const label = labels[stage] || (stage ? `发送失败（${stage}）` : '发送失败')
    return { label, detail: detail ? `${stage || 'error'}：${detail}` : stage || '没有返回原因' }
  }

  /**
   * 真正发出去。question 为空 → 后台按「有没有选区」套默认问题；
   * 有内容 → 用户自己写的问题会被放进 prompt 的「我的问题」一节。
   */
  async function send(question) {
    const text = pendingText
    if (!text) {
      hide()
      return
    }
    const mine = session
    mode = 'sending'
    input.disabled = true
    go.disabled = true
    setHint('发送中…', '')
    try {
      // 走兼容层：Chromium 99 以前 runtime.sendMessage 不返回 Promise（老机器常见）
      const post = globalThis.__baSendMessage || ((message) => chrome.runtime.sendMessage(message))
      const result = await post({
        type: 'BA_ASK_SELECTION',
        selection: text,
        question: String(question || ''),
        local: pendingLocal,
        ancestors: pendingAncestors,
      })
      // 等回复期间卡片被收起或换成了新选区：这一轮结果已经没有对应卡片了
      if (mine !== session) return
      if (result && result.ok) {
        // 成功提示期间保持不可提交，避免回车把同一段选区再发一次
        mode = 'done'
        setHint('已发送到网页版窗口', 'ok')
        hideSoon(1200)
        return
      }
      if (!result) {
        // 兼容层等到超时也没拿到回复：后台可能还在发，按未确认处理
        setHint('还没收到结果，请到右侧窗口核对', 'error')
        console.warn('[BubbleAsk] 等回复超时')
      } else {
        const failure = describeFailure(result)
        setHint(failure.label, 'error', failure.detail)
        console.warn('[BubbleAsk] 发送失败', result)
      }
    } catch (error) {
      if (mine !== session) return
      setHint('发送失败，请重试', 'error', String(error && error.message ? error.message : error))
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
   * Maxthon 这类 Chromium 分支没有实现 `chrome.scripting`（连老的 `chrome.tabs.executeScript`
   * 也没有），需要时再注入必然失败；内容脚本本身正常运行，所以由后台问一句、页面把上下文交出来。
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
