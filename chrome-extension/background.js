/**
 * 扩展的后台调度。
 *
 * 三步：① 从当前标签页采集页面上下文 → ② 拼成提问 → ③ 交给自己开出来的
 * DeepSeek 侧边窗口（真实标签页，所以复用浏览器已有登录态）填入并发送。
 *
 * 为什么侧边窗口必须是独立窗口而不是 iframe：chat.deepseek.com 返回
 * `Content-Security-Policy: frame-ancestors 'none'`，且登录 cookie 是
 * `SameSite=Strict` —— 跨站 iframe 里既渲染不出来、也带不上登录态。
 */
import { buildPrompt, DEFAULT_QUESTION, DEFAULT_QUESTION_NO_SELECTION, CONTEXT_BUDGET, describeContext } from './lib/prompt.js'

const DEEPSEEK_URL = 'https://chat.deepseek.com/'
const DEEPSEEK_MATCH = 'https://chat.deepseek.com/*'
const RESULT_KEY = 'lastResult'

/** 侧边窗口的目标宽度；太窄看不清对话，太宽挤掉原页面。 */
const PANEL_WIDTH = 560
const PANEL_GAP = 12

const log = (...args) => console.log('[BubbleAsk]', ...args)

/**
 * 向标签页里的内容脚本发消息。
 *
 * 为什么不用 `await chrome.tabs.sendMessage(...)`：并非所有 Chromium 分支都实现了
 * 它的 Promise 形式 —— Maxthon 下直接返回 `undefined`，回调形式则可能报
 * "The message port closed before a response was received"。这里统一用回调 + 超时，
 * 并把 `runtime.lastError` 读掉（不读会污染控制台），对两边都能用。
 */
function sendToTab(tabId, message, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    try {
      chrome.tabs.sendMessage(tabId, message, (reply) => {
        // 读掉 lastError：对端没响应时它会有值，但对我们只是「拿不到回复」
        void chrome.runtime.lastError
        finish(reply === undefined ? null : reply)
      })
    } catch (error) {
      finish(null)
    }
  })
}


/** 把侧边窗口贴到当前窗口的右侧。 */
async function panelBounds() {
  let width = PANEL_WIDTH
  let height = 900
  let left = 0
  let top = 40
  try {
    const current = await chrome.windows.getLastFocused()
    if (current && current.width) {
      width = Math.min(PANEL_WIDTH, Math.max(360, Math.floor(current.width / 2)))
      height = Math.max(480, current.height - PANEL_GAP * 2)
      left = current.left + current.width - width - PANEL_GAP
      top = current.top + PANEL_GAP
    }
  } catch (error) {
    log('读取当前窗口失败，用默认尺寸', error)
  }
  return { width, height, left: Math.max(0, left), top: Math.max(0, top) }
}

/**
 * 找到（或创建）DeepSeek 侧边窗口，返回它的标签页 id。
 *
 * 复用而不是每次新开：反复点击不该堆一堆窗口，且同一个标签页能保持对话上下文。
 */
async function ensureDeepSeekTab() {
  const existing = await chrome.tabs.query({ url: DEEPSEEK_MATCH })
  if (existing && existing.length > 0) {
    const tab = existing[0]
    try {
      await chrome.windows.update(tab.windowId, { focused: true })
    } catch (error) {
      log('聚焦已有窗口失败', error)
    }
    return tab.id
  }
  const bounds = await panelBounds()
  const created = await chrome.windows.create({
    url: DEEPSEEK_URL,
    type: 'popup',
    width: bounds.width,
    height: bounds.height,
    left: bounds.left,
    top: bounds.top,
    focused: true,
  })
  const tab = created.tabs && created.tabs[0]
  if (!tab || tab.id === undefined) throw new Error('没能创建 DeepSeek 窗口')
  return tab.id
}

/** 确保 DeepSeek 页面里的执行器就绪（冷启动时内容脚本可能还没注入）。 */
async function ensureBridge(tabId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const pong = await sendToTab(tabId, { type: 'BA_PING' }, 3000)
      if (pong && pong.ok) return true
    } catch (error) {
      // 首次通常就走到这里：内容脚本还没就绪，注入一份再试。
      if (attempt === 0) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content/deepseek-bridge.js'] })
        } catch (injectError) {
          log('注入执行器失败', injectError)
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

/**
 * 从标签页采集上下文。
 *
 * 首选「问页面里的内容脚本」：`chrome.tabs.sendMessage` 在所有 Chromium 分支上都可用，
 * 而 `chrome.scripting` 并非如此 —— Maxthon 就没实现它（连 MV2 的
 * `chrome.tabs.executeScript` 也没有），点的时候再注入必然失败。
 *
 * 只有页面里没有内容脚本时（比如扩展装上之前就打开的标签页）才退回注入；
 * 注入也不可用时给出能看懂的提示，而不是一句「失败」。
 */
async function collectFromTab(tabId) {
  try {
    const reply = await sendToTab(tabId, { type: 'BA_COLLECT', limits: CONTEXT_BUDGET }, 8000)
    if (reply && reply.ok && reply.context) return reply.context
    if (reply && reply.ok === false) throw new Error(reply.detail || '页面采集失败')
  } catch (error) {
    log('内容脚本没响应，尝试注入采集器', error && error.message ? error.message : error)
  }

  if (typeof chrome.scripting === 'undefined') {
    throw new Error('这个页面里没有内容脚本，而当前浏览器不支持脚本注入（如 Maxthon）。请刷新页面后重试。')
  }

  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/collect.js'] })
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (limits) => globalThis.__bubbleAskCollect(limits),
    args: [CONTEXT_BUDGET],
  })
  const context = result && result.result
  if (!context) throw new Error('页面没有返回上下文（可能是浏览器内置页面或 PDF）')
  return context
}

/** 采集 + 拼 prompt（不发送），给 popup 做预览。 */
async function preview(tabId, question) {
  const context = await collectFromTab(tabId)
  const prompt = buildPrompt(context, question)
  return {
    ok: true,
    title: context.title,
    url: context.url,
    selection: context.selection ? context.selection.text : '',
    summary: describeContext(context),
    defaultQuestion: context.selection && context.selection.text ? DEFAULT_QUESTION : DEFAULT_QUESTION_NO_SELECTION,
    promptChars: prompt.length,
    prompt,
  }
}

/**
 * 采集 + 拼 prompt + 交给 DeepSeek 窗口发送。
 *
 * @param selectionOverride 划词气泡带来的选区文本。点气泡时页面选区可能已经被
 *        收起，所以以气泡记住的那份为准。
 */
async function ask(tabId, question, selectionOverride) {
  const context = await collectFromTab(tabId)
  const selectionText = String(selectionOverride || '').trim()
  if (selectionText) {
    context.selection = {
      text: selectionText,
      ancestors: (context.selection && context.selection.ancestors) || [],
    }
  }
  // question 为空时 buildPrompt 会按「有没有选区」自动选默认问题。
  const prompt = buildPrompt(context, question)
  const deepseekTabId = await ensureDeepSeekTab()
  const ready = await ensureBridge(deepseekTabId)
  if (!ready) {
    return { ok: false, stage: 'window', detail: 'DeepSeek 窗口没能就绪，请稍后重试' }
  }
  const reply = await sendToTab(deepseekTabId, { type: 'BA_ASK', prompt }, 120000)
  const result = reply || { ok: false, stage: 'unverified', detail: 'DeepSeek 页面没有回报结果（可能还在加载）' }
  const record = {
    ...result,
    at: Date.now(),
    pageTitle: context.title,
    pageUrl: context.url,
    promptChars: prompt.length,
  }
  await chrome.storage.local.set({ [RESULT_KEY]: record })
  if (chrome.action && chrome.action.setBadgeText) {
    chrome.action.setBadgeText({ text: result && result.ok ? '✓' : '!' })
    chrome.action.setBadgeBackgroundColor({ color: result && result.ok ? '#2f7d32' : '#b3261e' })
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000)
  }
  return { ...record, prompt }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false

  if (message.type === 'BA_PREVIEW') {
    preview(message.tabId, message.question)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, stage: 'collect', detail: String(error && error.message ? error.message : error) }))
    return true
  }

  if (message.type === 'BA_ASK') {
    ask(message.tabId, message.question)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, stage: 'error', detail: String(error && error.message ? error.message : error) }))
    return true
  }

  // 划词气泡：sender.tab 就是气泡所在页面，不用再问一次「当前标签页」
  if (message.type === 'BA_ASK_SELECTION') {
    const tabId = sender && sender.tab ? sender.tab.id : undefined
    const selection = typeof message.selection === 'string' ? message.selection : ''
    if (tabId === undefined || !selection.trim()) {
      sendResponse({ ok: false, stage: 'collect', detail: '没有拿到选区' })
      return false
    }
    ask(tabId, '', selection)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, stage: 'error', detail: String(error && error.message ? error.message : error) }))
    return true
  }

  if (message.type === 'BA_LAST') {
    chrome.storage.local.get(RESULT_KEY).then((data) => sendResponse({ ok: true, record: data[RESULT_KEY] || null }))
    return true
  }

  return false
})

/** 快捷键直接问（不问问题，用默认问题）。 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'ask-page') return
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab || tab.id === undefined) return
    await ask(tab.id, '')
  } catch (error) {
    log('快捷键流程失败', error)
  }
})

log('后台已就绪')
