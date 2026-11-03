/**
 * 扩展弹窗：预览页面上下文 → 填问题 → 发送。
 *
 * 采集与发送都在后台做（popup 关掉也不影响任务继续）。
 */
const els = {
  title: document.getElementById('page-title'),
  summaryRow: document.getElementById('summary-row'),
  summary: document.getElementById('summary'),
  selectionBox: document.getElementById('selection-box'),
  selection: document.getElementById('selection'),
  question: document.getElementById('question'),
  send: document.getElementById('send'),
  copy: document.getElementById('copy'),
  status: document.getElementById('status'),
}

let activeTabId = null
let lastPrompt = ''

function setStatus(text, isError) {
  els.status.textContent = text || ''
  els.status.classList.toggle('error', Boolean(isError))
}

function setBusy(busy) {
  els.send.disabled = busy
  els.copy.disabled = busy || !lastPrompt
}

async function currentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  return tabs && tabs[0] ? tabs[0] : null
}

/** 首屏：采集当前页面，展示规模与选区。 */
async function init() {
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
    const preview = await chrome.runtime.sendMessage({ type: 'BA_PREVIEW', tabId: tab.id })
    if (!preview || !preview.ok) {
      setStatus((preview && preview.detail) || '读取页面失败', true)
      return
    }
    lastPrompt = preview.prompt
    els.summaryRow.hidden = false
    els.summary.textContent = preview.summary
    if (preview.selection) {
      els.selectionBox.hidden = false
      els.selection.textContent = preview.selection
    }
    els.question.placeholder = preview.defaultQuestion
    setBusy(false)
    setStatus('')
  } catch (error) {
    setStatus(`读取页面失败：${error && error.message ? error.message : error}`, true)
  }
}

els.send.addEventListener('click', async () => {
  if (activeTabId === null) return
  setBusy(true)
  setStatus('正在发送到 DeepSeek 侧边窗口…')
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'BA_ASK',
      tabId: activeTabId,
      question: els.question.value,
    })
    if (result && result.ok) {
      setStatus('已发送，去右侧窗口看回答')
    } else if (result && result.stage === 'unverified') {
      setStatus(result.detail || '已点击发送但没能确认，请在窗口里核对', true)
    } else {
      setStatus((result && result.detail) || '发送失败', true)
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
