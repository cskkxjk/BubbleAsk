/**
 * 扩展的后台调度（多网页服务方，1.2.0 起）。
 *
 * 三步：① 从当前标签页采集页面上下文 → ② 拼成提问 → ③ 交给**当前服务方**的
 * 右侧独立窗口（真实标签页，所以复用浏览器已有登录态）填入并发送。
 *
 * 为什么侧边窗口必须是独立窗口而不是 iframe：各服务方站点都禁止被 iframe 嵌入
 * （如 chat.deepseek.com 返回 `Content-Security-Policy: frame-ancestors 'none'`），
 * 且登录 cookie 为 `SameSite=Strict` —— 跨站 iframe 里既渲染不出来、也带不上登录态。
 *
 * 窗口策略：每家服务方一个由扩展自己 `chrome.windows.create` 出来的弹窗，窗口 id
 * 记录在存储里；只复用记录在案、且窗口仍存活的弹窗，**不会复用/劫持用户自己打开
 * 的标签页**（1.1.x 会复用任意 chat.deepseek.com 标签，1.2.0 起不再这样做）。
 */
import { buildPrompt, DEFAULT_QUESTION, DEFAULT_QUESTION_NO_SELECTION, CONTEXT_BUDGET, describeContext } from './lib/prompt.js'
import {
  DEFAULT_PROVIDER_ID,
  GENERIC_COMPOSER_SELECTORS,
  GENERIC_SEND_ARIA_LABELS,
  PROVIDER_STORAGE_KEY,
  isProviderUrl,
  resolveProvider,
} from './lib/providers.js'

/**
 * 内容脚本不 import 任何模块（MV3 限制），通用兜底要随消息一起发过去。
 * 数据同样来自真源 shared/providers.json（经 providers.data.js）。
 */
const GENERIC_CONFIG = {
  composerSelectors: GENERIC_COMPOSER_SELECTORS,
  sendAriaLabels: GENERIC_SEND_ARIA_LABELS,
}

const RESULT_KEY = 'lastResult'
/** 各服务方窗口的记录：{ [providerId]: { windowId, tabId, at } }。 */
const WINDOWS_KEY = 'bubble-ask.windows'

/** 侧边窗口的目标宽度；太窄看不清对话，太宽挤掉原页面。 */
const PANEL_WIDTH = 560
const PANEL_GAP = 12

const log = (...args) => console.log('[BubbleAsk]', ...args)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 向标签页里的内容脚本发消息。
 *
 * 为什么不用 `await chrome.tabs.sendMessage(...)`：并非所有 Chromium 分支都实现了
 * 它的 Promise 形式 —— Maxthon 下直接返回 `undefined`，回调形式则可能报
 * "The message port closed before a response was received"。这里统一用回调 + 超时，
 * 并把 `runtime.lastError` 读掉（不读会污染控制台），对两边都能用。
 *
 * 注意：本函数**永远 resolve**（拿不到回复就是 null），不会 reject —— 调用方不能靠
 * catch 判断「没回复」，必须自己检查返回值（ensureBridge 的注入兜底曾经因此变成死代码）。
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

/**
 * 给任何 chrome.* 调用套上超时，拿不到结果就当失败。
 *
 * Maxthon 里这些 API 的 Promise 形式并不总能兑现：有的直接返回 undefined，
 * 有的干脆不 resolve。一旦不 resolve，整个 await 链就永远停在那里，
 * 消息端口随之关闭（"The message port closed before a response was received"）。
 * 所以这里一律「回调 + 超时」，超时按失败处理 —— 宁可多开一个窗口，也不能没反应。
 */
function withTimeout(call, fallback, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(fallback), timeoutMs)
    try {
      const returned = call(finish)
      // 有些实现不发回调却给 Promise，两边都兜住
      if (returned && typeof returned.then === 'function') {
        returned.then((value) => finish(value === undefined ? fallback : value), () => finish(fallback))
      }
    } catch (error) {
      finish(fallback)
    }
  })
}

/** 用回调形式读存储，避免依赖 Promise 形式。 */
function storageGet(keys, fallback = null, timeoutMs = 3000) {
  return withTimeout(
    (done) => {
      chrome.storage.local.get(keys, (data) => {
        void chrome.runtime.lastError
        done(data || fallback)
      })
    },
    fallback,
    timeoutMs,
  )
}

/** 用回调形式写存储。 */
function storageSet(items, timeoutMs = 3000) {
  return withTimeout(
    (done) => {
      chrome.storage.local.set(items, () => {
        void chrome.runtime.lastError
        done(true)
      })
    },
    false,
    timeoutMs,
  )
}

/** 用回调形式查询窗口。 */
function getWindow(windowId, timeoutMs = 3000) {
  return withTimeout(
    (done) => {
      chrome.windows.get(windowId, (win) => {
        void chrome.runtime.lastError
        done(win && win.id !== undefined ? win : null)
      })
    },
    null,
    timeoutMs,
  )
}

/** 用回调形式列出某窗口内的标签页。 */
function queryTabsInWindow(windowId, timeoutMs = 3000) {
  return withTimeout(
    (done) => {
      chrome.tabs.query({ windowId }, (tabs) => {
        void chrome.runtime.lastError
        done(Array.isArray(tabs) ? tabs : [])
      })
    },
    [],
    timeoutMs,
  )
}

/** 用回调形式列出所有窗口（带 tabs，用于认领「创建超时但实际已建成」的窗口）。 */
function getAllWindows(timeoutMs = 5000) {
  return withTimeout(
    (done) => {
      chrome.windows.getAll({ populate: true }, (windows) => {
        void chrome.runtime.lastError
        done(Array.isArray(windows) ? windows : [])
      })
    },
    [],
    timeoutMs,
  )
}

/** 聚焦窗口（失败不阻塞流程）。 */
function focusWindow(windowId) {
  return withTimeout(
    (done) => {
      chrome.windows.update(windowId, { focused: true }, () => {
        void chrome.runtime.lastError
        done(true)
      })
    },
    false,
    2500,
  )
}

/** 关掉窗口（失败不阻塞流程）。 */
function removeWindow(windowId) {
  return withTimeout(
    (done) => {
      chrome.windows.remove(windowId, () => {
        void chrome.runtime.lastError
        done(true)
      })
    },
    false,
    3000,
  )
}

/** 把侧边窗口贴到当前窗口的右侧。 */
async function panelBounds() {
  let width = PANEL_WIDTH
  let height = 900
  let left = 0
  let top = 40
  // 走回调 + 超时：Promise 形式在部分分支上不兑现，卡住会让整个发送流程无响应
  const current = await withTimeout(
    (done) => {
      chrome.windows.getLastFocused((win) => {
        void chrome.runtime.lastError
        done(win || null)
      })
    },
    null,
    2500,
  )
  if (current && current.width) {
    width = Math.min(PANEL_WIDTH, Math.max(360, Math.floor(current.width / 2)))
    height = Math.max(480, current.height - PANEL_GAP * 2)
    left = current.left + current.width - width - PANEL_GAP
    top = current.top + PANEL_GAP
  }
  // 只在主屏坐标范围内夹取：负坐标（副屏在主屏左侧）保留，否则窗口会被拉回主屏
  return { width, height, left, top }
}

/** 当前默认服务方 id（存储值非法/读取失败时回落到 deepseek）。 */
async function loadProviderId() {
  const data = await storageGet(PROVIDER_STORAGE_KEY)
  const stored = data && typeof data === 'object' ? data[PROVIDER_STORAGE_KEY] : undefined
  return resolveProvider(stored).id
}

/**
 * 解析消息里的服务方参数：既接受 provider id 字符串（popup 用），
 * 也接受完整 provider 对象（少见的内部调用）；都没有时读存储里的默认服务方。
 */
async function resolveProviderParam(value) {
  if (value && typeof value === 'object') {
    const provider = resolveProvider(value.id)
    if (provider) return provider
  }
  if (typeof value === 'string' && value) return resolveProvider(value)
  return resolveProvider(await loadProviderId())
}

async function loadWindowRecords() {
  const data = await storageGet(WINDOWS_KEY)
  const raw = data && typeof data === 'object' ? data[WINDOWS_KEY] : null
  return raw && typeof raw === 'object' ? raw : {}
}

async function saveWindowRecord(providerId, record) {
  const records = await loadWindowRecords()
  if (record) records[providerId] = record
  else delete records[providerId]
  await storageSet({ [WINDOWS_KEY]: records })
}

/**
 * 找该服务方「扩展自己创建、且还活着」的窗口。
 *
 * 只认 WINDOWS_KEY 里记录过的 windowId —— 用户自己打开的 chat.deepseek.com /
 * chatgpt.com 标签页不在记录里，因此永远不会被拿来填词发送。
 */
async function findRecordedWindow(provider) {
  const records = await loadWindowRecords()
  const record = records[provider.id]
  if (!record || typeof record.windowId !== 'number') return null

  const win = await getWindow(record.windowId)
  if (!win) {
    // 窗口已被用户关掉（部分分支如 Maxthon 的 tabs.query 仍会返回死标签，所以查窗口）
    await saveWindowRecord(provider.id, null)
    return null
  }

  const tabs = await queryTabsInWindow(record.windowId)
  let tab = tabs.find((item) => item && item.id !== undefined && item.id === record.tabId)
  // 用户在窗口里换了标签页也认：窗口是扩展开的，里面哪个标签都算这个服务方的入口
  if (!tab) tab = tabs.find((item) => item && item.id !== undefined && isProviderUrl(provider, item.url || item.pendingUrl || ''))
  if (!tab) tab = tabs.find((item) => item && item.id !== undefined)
  if (!tab) {
    await saveWindowRecord(provider.id, null)
    return null
  }
  if (tab.id !== record.tabId) {
    await saveWindowRecord(provider.id, { ...record, tabId: tab.id })
  }
  return { windowId: record.windowId, tabId: tab.id }
}

/** 创建超时也可能其实建成功了：认领「不在记录里、URL 属于该服务方」的新弹窗。 */
async function findAdoptableWindow(provider) {
  const records = await loadWindowRecords()
  const known = new Set(
    Object.values(records)
      .map((record) => (record && typeof record.windowId === 'number' ? record.windowId : null))
      .filter((windowId) => windowId !== null),
  )
  const windows = await getAllWindows()
  for (const win of windows) {
    if (!win || typeof win.id !== 'number' || known.has(win.id)) continue
    // 只认「扩展开的那种单标签弹窗」：避免创建超时时误认领用户自己的普通窗口/标签页。
    if (win.type !== 'popup') continue
    const tabs = Array.isArray(win.tabs) ? win.tabs : []
    if (tabs.length !== 1) continue
    if (tabs.some((tab) => tab && isProviderUrl(provider, tab.url || tab.pendingUrl || ''))) return win
  }
  return null
}

/** 新建该服务方的右侧弹窗，返回 { windowId, tabId }。 */
async function createProviderWindow(provider) {
  const bounds = await panelBounds()
  const payload = {
    url: provider.url,
    type: 'popup',
    width: bounds.width,
    height: bounds.height,
    left: bounds.left,
    top: bounds.top,
    focused: true,
  }
  const created = await withTimeout(
    (done) => {
      chrome.windows.create(payload, (win) => {
        void chrome.runtime.lastError
        done(win || null)
      })
    },
    null,
    15000,
  )
  let win = created
  // 创建成功但没回 tabs、或创建超时但实际建成了：回头按 URL 认领一次
  if (!win || !Array.isArray(win.tabs) || win.tabs.length === 0) {
    win = (await findAdoptableWindow(provider)) || win
  }
  const tab = win && win.tabs && win.tabs[0]
  if (!win || typeof win.id !== 'number' || !tab || tab.id === undefined) {
    throw new Error(`没能创建 ${provider.name} 窗口`)
  }
  await saveWindowRecord(provider.id, { windowId: win.id, tabId: tab.id, at: Date.now() })
  return { windowId: win.id, tabId: tab.id }
}

/** 找到（或创建）该服务方的窗口；forceNew=true 时忽略已记录窗口强制重建。 */
async function ensureProviderWindow(provider, options) {
  const forceNew = Boolean(options && options.forceNew)
  if (!forceNew) {
    const live = await findRecordedWindow(provider)
    if (live) {
      await focusWindow(live.windowId)
      return live
    }
  }
  const created = await createProviderWindow(provider)
  await focusWindow(created.windowId)
  return created
}

/**
 * 确保服务方页面里的执行器就绪（冷启动时内容脚本可能还没注入）。
 *
 * 1.1.x 这里写成 `try { await sendToTab(...) } catch { 注入 }`，但 sendToTab 永不
 * reject，catch 从未执行 —— 注入兜底是死代码。现在改为**显式判断 pong 为空**：
 * 第一次拿不到回复就注入 content/chat-bridge.js 再继续重试。
 */
/**
 * 确保服务方页面里有可用的执行器。
 *
 * 重试节奏（2026-11-10 调整）：以前是 60×250ms ≈ 15s + 再 24 次 ≈ 6s 才去重建窗口，
 * 用户侧表现为「点了没反应、卡一会儿」后才好。现在 12 次（≈3s）就重建，
 * 因为「页面缺执行器」几乎只有两种情况：页面还没加载完（3s 足够）、或标签页是
 * 扩展更新前就开着的（内容脚本已失效，等再久也不会自己出现）。
 */
async function ensureBridge(tabId, provider, attempts = 12) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pong = await sendToTab(tabId, { type: 'BA_PING', provider, generic: GENERIC_CONFIG }, 3000)
    if (pong && pong.ok) return true
    if (attempt === 0) {
      if (typeof chrome.scripting === 'undefined') {
        log('当前浏览器不支持脚本注入（如 Maxthon），只能等页面自然加载内容脚本')
      } else {
        try {
          // 必须连 driver.js 一起注入：chat-bridge 依赖它提供的 __bubbleAskDriver。
          // 只注 chat-bridge 会得到「有执行器但没驱动」的僵尸状态，ping 永远不就绪。
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content/driver.js', 'content/chat-bridge.js'],
          })
          log('已注入执行器（driver + chat-bridge）', provider.id, tabId)
        } catch (error) {
          log('注入执行器失败', error && error.message ? error.message : error)
        }
      }
    }
    await sleep(250)
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
async function preview(tabId, question, providerParam) {
  const provider = await resolveProviderParam(providerParam)
  const context = await collectFromTab(tabId)
  const prompt = buildPrompt(context, question)
  return {
    ok: true,
    providerId: provider.id,
    providerName: provider.name,
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
 * 采集 + 拼 prompt + 交给指定服务方的窗口发送。
 *
 * @param selectionOverride 划词气泡带来的选区文本。点气泡时页面选区可能已经被
 *        收起，所以以气泡记住的那份为准。
 * @param providerParam 服务方 id（popup 传），缺省时用存储里的默认服务方。
 */
async function ask(tabId, question, selectionOverride, providerParam) {
  const provider = await resolveProviderParam(providerParam)
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

  let target = await ensureProviderWindow(provider)
  let ready = await ensureBridge(target.tabId, provider)
  if (!ready) {
    // 失败重试一次（页面可能还在加载），仍不行才重建窗口。
    log('执行器没就绪，重试一次', provider.id, target.tabId)
    ready = await ensureBridge(target.tabId, provider, 8)
  }
  if (!ready) {
    log('执行器始终没就绪，重建窗口', provider.id)
    await removeWindow(target.windowId)
    await saveWindowRecord(provider.id, null)
    target = await ensureProviderWindow(provider, { forceNew: true })
    ready = await ensureBridge(target.tabId, provider)
  }
  if (!ready) {
    return {
      ok: false,
      stage: 'window',
      detail: `${provider.name} 窗口没能就绪，请稍后重试（也可以点扩展图标里的「打开窗口」）`,
    }
  }

  const reply = await sendToTab(target.tabId, { type: 'BA_ASK', prompt, provider, generic: GENERIC_CONFIG }, 120000)
  const result = reply || {
    ok: false,
    stage: 'unverified',
    detail: `${provider.name} 页面没有回报结果（可能还在加载）`,
  }
  const record = {
    ...result,
    providerId: provider.id,
    providerName: provider.name,
    at: Date.now(),
    pageTitle: context.title,
    pageUrl: context.url,
    promptChars: prompt.length,
  }
  await storageSet({ [RESULT_KEY]: record })
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
    preview(message.tabId, message.question, message.provider)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ ok: false, stage: 'collect', detail: String(error && error.message ? error.message : error) }),
      )
    return true
  }

  if (message.type === 'BA_ASK') {
    ask(message.tabId, message.question, undefined, message.provider)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ ok: false, stage: 'error', detail: String(error && error.message ? error.message : error) }),
      )
    return true
  }

  // 划词气泡：sender.tab 就是气泡所在页面，不用再问一次「当前标签页」；
  // 服务方取消息里的（可选）或存储里的默认服务方。
  if (message.type === 'BA_ASK_SELECTION') {
    const tabId = sender && sender.tab ? sender.tab.id : undefined
    const selection = typeof message.selection === 'string' ? message.selection : ''
    if (tabId === undefined || !selection.trim()) {
      sendResponse({ ok: false, stage: 'collect', detail: '没有拿到选区' })
      return false
    }
    ask(tabId, '', selection, message.provider)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ ok: false, stage: 'error', detail: String(error && error.message ? error.message : error) }),
      )
    return true
  }

  if (message.type === 'BA_LAST') {
    storageGet(RESULT_KEY).then((data) =>
      sendResponse({ ok: true, record: (data && data[RESULT_KEY]) || null }),
    )
    return true
  }

  // 手动打开/唤起某个服务方的窗口（popup 里的按钮用）
  if (message.type === 'BA_OPEN_WINDOW') {
    ;(async () => {
      const provider = await resolveProviderParam(message.provider)
      const target = await ensureProviderWindow(provider, { forceNew: Boolean(message.forceNew) })
      sendResponse({ ok: true, providerId: provider.id, providerName: provider.name, ...target })
    })().catch((error) =>
      sendResponse({ ok: false, stage: 'window', detail: String(error && error.message ? error.message : error) }),
    )
    return true
  }

  return false
})

/** 快捷键直接问（不问问题，用默认问题与当前默认服务方）。 */
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

log('后台已就绪', DEFAULT_PROVIDER_ID)
