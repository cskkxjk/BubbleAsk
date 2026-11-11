/**
 * 扩展弹窗：预览页面上下文 → 选服务方 → 填问题 → 发送。
 *
 * 采集与发送都在后台做（popup 关掉不影响任务继续）。服务方列表来自 lib/providers.js，
 * 当前选择存在 chrome.storage.local（PROVIDER_STORAGE_KEY），后台发送时读同一份存储，
 * 因此划词气泡与快捷键也跟随这里的默认服务方。
 */
/** 兼容层：老的 Chromium 里 runtime.sendMessage 没有 Promise（见 content/compat.js）。 */
const sendMessage = globalThis.__baSendMessage || ((message) => chrome.runtime.sendMessage(message))

import {
  PROVIDERS,
  DEFAULT_PROVIDER_ID,
  PROVIDER_STORAGE_KEY,
  getProvider,
} from '../lib/providers.js'

const els = {
  provider: document.getElementById('provider'),
  title: document.getElementById('page-title'),
  summaryRow: document.getElementById('summary-row'),
  summary: document.getElementById('summary'),
  selectionBox: document.getElementById('selection-box'),
  selection: document.getElementById('selection'),
  question: document.getElementById('question'),
  send: document.getElementById('send'),
  copy: document.getElementById('copy'),
  openWindow: document.getElementById('open-window'),
  status: document.getElementById('status'),
}

let activeTabId = null
let lastPrompt = ''
/** 当前选中的服务方 id（持久化到 chrome.storage.local）。 */
let providerId = DEFAULT_PROVIDER_ID
/** 页面规模摘要（不含服务方前缀，渲染时再拼）。 */
let pageSummary = ''

/**
 * 回调形式的 chrome.* 调用。
 *
 * Chromium 88 这类老内核上 tabs/storage 的 Promise 形式取不到结果，所以统一用回调 + 超时，
 * 拿不到结果时返回 fallback，调用方按返回值判断。
 */
function callApi(invoke, fallback, timeoutMs = 4000) {
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
      const returned = invoke(finish)
      if (returned && typeof returned.then === 'function') {
        returned.then((value) => finish(value === undefined ? fallback : value), () => finish(fallback))
      }
    } catch (error) {
      finish(fallback)
    }
  })
}

function storageGet(keys, timeoutMs = 3000) {
  return callApi(
    (done) => {
      chrome.storage.local.get(keys, (data) => {
        void chrome.runtime.lastError
        done(data || null)
      })
    },
    null,
    timeoutMs,
  )
}

function storageSet(items, timeoutMs = 3000) {
  return callApi(
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

function currentProvider() {
  return getProvider(providerId) || getProvider(DEFAULT_PROVIDER_ID)
}

function setStatus(text, isError) {
  els.status.textContent = text || ''
  els.status.classList.toggle('error', Boolean(isError))
}

function setBusy(busy) {
  els.send.disabled = busy
  els.copy.disabled = busy || !lastPrompt
  els.provider.disabled = busy
  if (els.openWindow) els.openWindow.disabled = busy
}

/** 页面信息区标注「将发送到哪个服务方」。 */
function renderSummary() {
  const provider = currentProvider()
  if (!pageSummary) return
  els.summary.textContent = `${provider.name} · ${pageSummary}`
}

async function currentTab() {
  const tabs = await callApi(
    (done) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (found) => {
        void chrome.runtime.lastError
        done(Array.isArray(found) ? found : [])
      })
    },
    [],
    3000,
  )
  return tabs[0] || null
}

/** 读记住的默认服务方；存储值非法/读取失败时回落到 deepseek。 */
async function loadStoredProvider() {
  const data = await storageGet(PROVIDER_STORAGE_KEY)
  const stored = data ? data[PROVIDER_STORAGE_KEY] : undefined
  providerId = getProvider(stored) ? stored : DEFAULT_PROVIDER_ID
}

function fillProviderOptions() {
  els.provider.replaceChildren(
    ...PROVIDERS.map((provider) => {
      const option = document.createElement('option')
      option.value = provider.id
      option.textContent = provider.name
      return option
    }),
  )
  els.provider.value = currentProvider().id
}

/** 首屏：加载默认服务方 → 采集当前页面，展示规模与选区。 */
async function init() {
  await loadStoredProvider()
  fillProviderOptions()

  const tab = await currentTab()
  if (!tab || tab.id === undefined) {
    setStatus('找不到当前标签页', true)
    return
  }
  if (/^(chrome|edge|about|devtools|chrome-extension):/i.test(tab.url || '')) {
    els.title.textContent = tab.url || ''
    setStatus('浏览器内置页面不允许读取，请切换到普通网页再试', true)
    return
  }
  activeTabId = tab.id
  els.title.textContent = tab.title || tab.url || ''
  try {
    const preview = await sendMessage({ type: 'BA_PREVIEW', tabId: tab.id, provider: providerId })
    if (!preview || !preview.ok) {
      setStatus((preview && preview.detail) || '读取页面失败', true)
      return
    }
    lastPrompt = preview.prompt
    pageSummary = preview.summary || ''
    els.summaryRow.hidden = false
    renderSummary()
    if (preview.selection) {
      els.selectionBox.hidden = false
      els.selection.textContent = preview.selection
    }
    els.question.placeholder = preview.defaultQuestion
    setBusy(false)
    setStatus(`将发送到 ${preview.providerName || currentProvider().name}`)
  } catch (error) {
    setStatus(`读取页面失败：${error && error.message ? error.message : error}`, true)
  }
}

/** 切换服务方：立即记住，后续发送/开窗都用它。 */
els.provider.addEventListener('change', async () => {
  const next = els.provider.value
  providerId = getProvider(next) ? next : DEFAULT_PROVIDER_ID
  renderSummary()
  const provider = currentProvider()
  setStatus(`将发送到 ${provider.name}`)
  const saved = await storageSet({ [PROVIDER_STORAGE_KEY]: provider.id })
  if (!saved) setStatus('没能保存服务方选择，下次打开弹窗可能回到默认值', true)
})

els.send.addEventListener('click', async () => {
  if (activeTabId === null) {
    setStatus('当前页面不能读取，请切换到普通网页再试', true)
    return
  }
  const provider = currentProvider()
  setBusy(true)
  setStatus(`正在发送到 ${provider.name} 窗口…`)
  try {
    const result = await sendMessage({
      type: 'BA_ASK',
      tabId: activeTabId,
      question: els.question.value,
      provider: provider.id,
    })
    if (!result) {
      setStatus('还没收到结果，请到右侧服务方窗口核对', true)
    } else if (result.ok) {
      setStatus(`已发送到 ${result.providerName || provider.name}，去右侧窗口看回答`)
    } else if (result.stage === 'unverified') {
      setStatus(result.detail || '已点击发送但没能确认，请在窗口里核对', true)
    } else {
      setStatus(result.detail || '发送失败', true)
    }
  } catch (error) {
    setStatus(`发送失败：${error && error.message ? error.message : error}`, true)
  } finally {
    setBusy(false)
  }
})

els.copy.addEventListener('click', async () => {
  if (!lastPrompt) return
  try {
    await navigator.clipboard.writeText(lastPrompt)
    setStatus(`已复制 ${lastPrompt.length} 字`)
  } catch (error) {
    setStatus(`复制失败：${error && error.message ? error.message : error}`, true)
  }
})

init()

// 手动打开 / 唤起当前服务方的窗口（关掉窗口后想再开）
els.openWindow?.addEventListener('click', async () => {
  const provider = currentProvider()
  setBusy(true)
  setStatus(`正在打开 ${provider.name} 窗口…`)
  try {
    const result = await sendMessage({ type: 'BA_OPEN_WINDOW', provider: provider.id })
    if (result && result.ok) {
      setStatus(`已打开 ${result.providerName || provider.name} 窗口`)
    } else {
      setStatus((result && result.detail) || '打开失败', true)
    }
  } catch (error) {
    setStatus(`打开失败：${error && error.message ? error.message : error}`, true)
  } finally {
    setBusy(false)
  }
})
