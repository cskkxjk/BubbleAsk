/**
 * 扩展的后台调度（多网页服务方，1.2.0 起）。
 *
 * 三步：① 从当前标签页采集页面上下文 → ② 拼成提问 → ③ 交给当前服务方的右侧独立窗口
 * 填入并发送。窗口是真实站点标签页，登录态来自浏览器已有的 cookie。
 *
 * 窗口形态：服务方站点用 CSP `frame-ancestors 'none'` 禁止被 iframe 嵌入，登录 cookie
 * 又是 `SameSite=Strict`，跨站 iframe 既渲染不出来也取不到登录态，所以用
 * `chrome.windows.create` 建弹窗（见 README「窗口形态与站点限制」）。
 *
 * 窗口策略：每家服务方一个弹窗，窗口 id 记录在存储里；只复用记录在案、且窗口仍存活的
 * 弹窗，用户自己打开的标签页不参与填充和发送。
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
 * 内容脚本不 import 任何模块（MV3 限制），通用选择器要随消息一起发过去。
 * 数据同样来自真源 shared/providers.json（经 providers.data.js）。
 */
const GENERIC_CONFIG = {
  composerSelectors: GENERIC_COMPOSER_SELECTORS,
  sendAriaLabels: GENERIC_SEND_ARIA_LABELS,
}

/** 各服务方窗口的记录：{ [providerId]: { windowId, tabId } }。 */
const WINDOWS_KEY = 'bubble-ask.windows'

/** 侧边窗口的目标宽度；太窄看不清对话，太宽挤掉原页面。 */
const PANEL_WIDTH = 560
const PANEL_GAP = 12

const log = (...args) => console.log('[BubbleAsk]', ...args)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 串行执行窗口相关任务。
 *
 * 窗口记录的读—改—写和「没有记录就新建窗口」都没有原子性：两个发送请求并发时会各建
 * 一个窗口，后写的记录覆盖先写的，先建的那个窗口就没人认领了。
 */
let windowQueue = Promise.resolve()
function serializeWindowTask(task) {
  const run = windowQueue.then(task, task)
  windowQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * 向标签页里的内容脚本发消息。
 *
 * 不用 `await chrome.tabs.sendMessage(...)`：部分 Chromium 分支没有实现它的 Promise
 * 形式（Maxthon 直接返回 undefined），回调形式还可能报 "The message port closed before
 * a response was received"。这里统一用回调 + 超时，并读掉 `runtime.lastError`。
 *
 * 本函数永远 resolve（拿不到回复就是 null），调用方要按返回值判断，不能靠 catch。
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
      // 有些实现不发回调却返回 Promise，两种返回方式都要兼容
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

/** 用回调形式按条件查标签页（Promise 形式在 Chromium 88 上拿不到结果）。 */
function queryTabs(filter, timeoutMs = 3000) {
  return withTimeout(
    (done) => {
      chrome.tabs.query(filter, (tabs) => {
        void chrome.runtime.lastError
        done(Array.isArray(tabs) ? tabs : [])
      })
    },
    [],
    timeoutMs,
  )
}

/** 读该窗口里某个标签页的当前地址（拿不到就是空串）。 */
async function tabUrlOf(windowId, tabId) {
  const tabs = await queryTabsInWindow(windowId)
  const tab = tabs.find((item) => item && item.id === tabId)
  return tab ? String(tab.url || tab.pendingUrl || '') : ''
}

/** 用回调形式注入脚本，返回执行结果数组（失败返回 null）。 */
function injectScript(tabId, injection, timeoutMs = 8000) {
  return withTimeout(
    (done) => {
      chrome.scripting.executeScript({ target: { tabId }, ...injection }, (results) => {
        void chrome.runtime.lastError
        done(Array.isArray(results) ? results : null)
      })
    },
    null,
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

/** 把侧边窗口放到当前窗口的右侧。 */
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
  if (current && current.width && current.height) {
    width = Math.min(PANEL_WIDTH, Math.max(360, Math.floor(current.width / 2)))
    height = Math.max(480, current.height - PANEL_GAP * 2)
    left = current.left + current.width - width - PANEL_GAP
    top = current.top + PANEL_GAP
  }
  // 坐标原样使用：负坐标是副屏在主屏左侧时的正常值，夹到主屏会把窗口拉走
  return { width, height, left, top }
}

/** 当前默认服务方 id（存储值非法/读取失败时回落到 deepseek）。 */
async function loadProviderId() {
  const data = await storageGet(PROVIDER_STORAGE_KEY)
  const stored = data && typeof data === 'object' ? data[PROVIDER_STORAGE_KEY] : undefined
  return resolveProvider(stored).id
}

/**
 * 解析消息里的服务方参数：消息带 provider id（popup 与气泡都这样传），
 * 没带就读取存储里的默认服务方。
 */
async function resolveProviderParam(value) {
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
  // 窗口已被用户关掉，或这个编号已经被别的窗口复用（部分分支的 tabs.query 仍会返回
  // 死标签，所以查窗口本身）
  if (!win || (win.type && win.type !== 'popup')) {
    await saveWindowRecord(provider.id, null)
    return null
  }

  const tabs = await queryTabsInWindow(record.windowId)
  // 记录里的标签页优先；用户在这个窗口里换过标签时，只接受仍属于该服务方的地址
  let tab = tabs.find((item) => item && item.id !== undefined && item.id === record.tabId)
  if (!tab) tab = tabs.find((item) => item && item.id !== undefined && isProviderUrl(provider, item.url || item.pendingUrl || ''))
  if (!tab) {
    await saveWindowRecord(provider.id, null)
    return null
  }
  if (tab.id !== record.tabId) {
    await saveWindowRecord(provider.id, { ...record, tabId: tab.id })
  }
  return { windowId: record.windowId, tabId: tab.id }
}

/** 创建超时也可能已经建成：认领「不在记录里、URL 属于该服务方」的新弹窗。 */
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
  await saveWindowRecord(provider.id, { windowId: win.id, tabId: tab.id })
  return { windowId: win.id, tabId: tab.id }
}

/** 找到（或创建）该服务方的窗口；forceNew=true 时先关掉记录里的旧窗口。 */
function ensureProviderWindow(provider, options) {
  const forceNew = Boolean(options && options.forceNew)
  return serializeWindowTask(async () => {
    if (!forceNew) {
      const live = await findRecordedWindow(provider)
      if (live) {
        await focusWindow(live.windowId)
        return live
      }
    } else {
      const records = await loadWindowRecords()
      const record = records[provider.id]
      if (record && typeof record.windowId === 'number') await removeWindow(record.windowId)
      await saveWindowRecord(provider.id, null)
    }
    const created = await createProviderWindow(provider)
    await focusWindow(created.windowId)
    return created
  })
}

/**
 * 确保服务方页面里有可用的执行器。
 *
 * 第一次 ping 拿不到回复就注入 content/driver.js + content/chat-bridge.js，再继续重试
 * （sendToTab 永远 resolve，所以按 ping 的返回值判断，不用 try/catch）。
 *
 * 重试 12 次（约 3 秒）就重建窗口：页面缺执行器只有两种情况 —— 页面还没加载完，
 * 或标签页在扩展更新前就开着（内容脚本已失效，等再久也不会自己出现）。
 */
async function ensureBridge(tabId, provider, attempts = 12) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pong = await sendToTab(tabId, { type: 'BA_PING', provider, generic: GENERIC_CONFIG }, 3000)
    if (pong && pong.ok) return true
    if (attempt === 0) {
      if (typeof chrome.scripting === 'undefined') {
        log('当前浏览器不支持脚本注入（如 Maxthon），只能等页面自然加载内容脚本')
      } else {
        // 必须连 driver.js 一起注入：chat-bridge.js 依赖它提供的 __bubbleAskDriver，
        // 只注 chat-bridge 会得到「有执行器但没驱动」的状态，ping 永远不就绪
        const injected = await injectScript(tabId, { files: ['content/driver.js', 'content/chat-bridge.js'] })
        log(injected ? '已注入执行器（driver + chat-bridge）' : '注入执行器失败', provider.id, tabId)
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
 * 而 Maxthon 这类分支没有实现 `chrome.scripting`（连 MV2 的 `chrome.tabs.executeScript`
 * 也没有），点的时候再注入必然失败。
 *
 * 只有页面里没有内容脚本时（比如扩展装上之前就打开的标签页）才退回注入；
 * 注入也不可用时给出能看懂的提示。
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
    throw new Error('这个页面里没有内容脚本，当前浏览器也不支持脚本注入（如 Maxthon）。请刷新页面后重试。')
  }

  // 先注入采集器，再在同一个隔离世界里调用它
  const injected = await injectScript(tabId, { files: ['content/collect.js'] })
  if (!injected) throw new Error('注入采集器失败，这个页面可能不允许注入脚本')
  const results = await injectScript(tabId, {
    func: (limits) => globalThis.__bubbleAskCollect(limits),
    args: [CONTEXT_BUDGET],
  })
  const context = results && results[0] ? results[0].result : null
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
    providerName: provider.name,
    selection: context.selection ? context.selection.text : '',
    summary: describeContext(context),
    defaultQuestion: context.selection && context.selection.text ? DEFAULT_QUESTION : DEFAULT_QUESTION_NO_SELECTION,
    prompt,
  }
}

/**
 * 采集 + 拼 prompt + 交给指定服务方的窗口发送。
 *
 * @param selectionOverride 划词气泡带来的选区文本。卡片出现时页面选区可能已经被收起，
 *        所以以气泡记住的那份为准。
 * @param providerParam 服务方 id（popup 与气泡传），缺省时用存储里的默认服务方。
 * @param localOverride 气泡在卡片出现那一刻抓下的「选区周围的文字」。等这里再去读 DOM 时
 *        选区早就没了，局部上下文会是空的，所以只能由气泡带过来。
 * @param ancestorsOverride 气泡在同一时刻抓下的选区 DOM 路径，理由同上。
 */
async function ask(tabId, question, selectionOverride, providerParam, localOverride, ancestorsOverride) {
  const provider = await resolveProviderParam(providerParam)
  const context = await collectFromTab(tabId)
  const selectionText = String(selectionOverride || '').trim()
  if (selectionText) {
    const collected = context.selection || {}
    const ancestors = Array.isArray(ancestorsOverride) && ancestorsOverride.length > 0
      ? ancestorsOverride
      : collected.ancestors || []
    const local = localOverride || collected.local || null
    context.selection = { text: selectionText, ancestors }
    if (local) context.selection.local = local
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
    // 窗口里如果不是该服务方页面（例如停在第三方登录页），重建只会打断登录
    const url = await tabUrlOf(target.windowId, target.tabId)
    if (url && !isProviderUrl(provider, url)) {
      return {
        ok: false,
        stage: 'login',
        detail: `窗口当前打开的不是 ${provider.name} 页面（可能停在登录页），请完成登录后重试`,
      }
    }
    log('执行器始终没就绪，重建窗口', provider.id)
    target = await ensureProviderWindow(provider, { forceNew: true })
    ready = await ensureBridge(target.tabId, provider)
  }
  if (!ready) {
    return {
      ok: false,
      stage: 'window',
      detail: `${provider.name} 窗口没能就绪，请稍后重试，也可以点扩展图标里的「打开该服务方窗口」`,
    }
  }

  // 内容脚本侧最长约 40 秒（等输入框 25 秒 + 点发送 + 回读 8 秒），留 50 秒足够；
  // 这个上限要小于调用方（compat.js 的 120 秒）的等待时间，否则两边同时超时
  const reply = await sendToTab(target.tabId, { type: 'BA_ASK', prompt, provider, generic: GENERIC_CONFIG }, 50000)
  const result = reply || {
    ok: false,
    stage: 'unverified',
    detail: `${provider.name} 页面没有回报结果（可能还在加载）`,
  }
  const record = {
    ...result,
    providerId: provider.id,
    providerName: provider.name,
  }
  if (chrome.action && chrome.action.setBadgeText) {
    chrome.action.setBadgeText({ text: result && result.ok ? '✓' : '!' })
    chrome.action.setBadgeBackgroundColor({ color: result && result.ok ? '#2f7d32' : '#b3261e' })
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000)
  }
  return record
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
    ask(tabId, String(message.question || ''), selection, message.provider, message.local || null, message.ancestors || null)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ ok: false, stage: 'error', detail: String(error && error.message ? error.message : error) }),
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

/** 快捷键直接问（用默认问题与当前默认服务方）。 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'ask-page') return
  try {
    const tabs = await queryTabs({ active: true, currentWindow: true })
    const tab = tabs[0]
    if (!tab || tab.id === undefined) return
    await ask(tab.id, '')
  } catch (error) {
    log('快捷键流程失败', error)
  }
})

log('后台已就绪', DEFAULT_PROVIDER_ID)
