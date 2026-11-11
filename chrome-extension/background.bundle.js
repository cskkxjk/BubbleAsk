/* eslint-disable */
/**
 * 由 tools/gen-background.mjs 生成，**不要手改**。
 * 源：lib/providers.data.js + lib/providers.js + lib/prompt.js + background.js
 * 生成成单文件是为了让 service worker 跑在 classic 模式，兼容 Chromium 88 这样的老内核。
 */
;(() => {
'use strict'

// ---------- lib/providers.data.js ----------
/**
 * 自动生成，请勿手改。
 *
 * 真源：shared/providers.json
 * 生成：node tools/gen-providers.mjs（校验：node tools/gen-providers.mjs --check）
 * 宿主：Chrome 扩展
 */

const DEFAULT_PROVIDER_ID = "deepseek"

const GENERIC_COMPOSER_SELECTORS = [
  "textarea",
  "textarea[placeholder]",
  "div[contenteditable=\"true\"]",
  "p[contenteditable=\"true\"]",
  "[contenteditable=\"true\"]",
  "[role=\"textbox\"]"
]

const GENERIC_SEND_ARIA_LABELS = [
  "发送",
  "send",
  "submit",
  "提交"
]

const PROVIDERS = [
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "url": "https://chat.deepseek.com/",
    "origins": [
      "chat.deepseek.com",
      "deepseek.com"
    ],
    "composerSelectors": [
      "textarea[name=\"search\"]",
      "textarea",
      "div[contenteditable=\"true\"]",
      "p[contenteditable=\"true\"]",
      "[contenteditable=\"true\"]",
      "[role=\"textbox\"]",
      "[data-testid=\"chat-input\"] textarea",
      "[data-testid=\"chat-input\"] [contenteditable=\"true\"]",
      "textarea[data-testid]",
      "[data-testid*=\"input\"] textarea",
      "[data-testid*=\"input\"] [contenteditable=\"true\"]",
      "[data-testid=\"chat-input\"]"
    ],
    "sendSelectors": [],
    "sendClassHints": [
      "ds-button--primary",
      "ds-button--circle"
    ],
    "sendSvgPaths": [
      "M8.3125"
    ],
    "sendAriaLabels": [],
    "enterSends": false,
    "loginMarkers": [
      "sign_in",
      "signin",
      "login"
    ],
    "verifyUrlRegex": "^https?://chat\\.deepseek\\.com/",
    "prefillParam": "q",
    "upload": true
  },
  {
    "id": "qwen",
    "name": "千问 Qwen",
    "url": "https://www.qianwen.com/",
    "origins": [
      "qianwen.com",
      "qianwen.aliyun.com",
      "chat.qwen.ai",
      "tongyi.aliyun.com",
      "tongyi.com"
    ],
    "composerSelectors": [
      "textarea[placeholder]",
      "textarea",
      "[contenteditable=\"true\"][role=\"textbox\"]",
      "[contenteditable=\"true\"]",
      "[role=\"textbox\"]"
    ],
    "sendSelectors": [],
    "sendClassHints": [],
    "sendSvgPaths": [],
    "sendAriaLabels": [
      "发送",
      "Send",
      "Submit"
    ],
    "enterSends": false,
    "loginMarkers": [
      "login",
      "signin",
      "passport",
      "sso"
    ],
    "verifyUrlRegex": "^https?://((www\\.)?qianwen\\.com|qianwen\\.aliyun\\.com|chat\\.qwen\\.ai|tongyi\\.aliyun\\.com|(www\\.)?tongyi\\.com)/",
    "prefillParam": "",
    "upload": true
  },
  {
    "id": "doubao",
    "name": "豆包 Doubao",
    "url": "https://www.doubao.com/chat/",
    "origins": [
      "doubao.com"
    ],
    "composerSelectors": [
      "[data-testid=\"chat_input_input\"]",
      "textarea[placeholder]",
      "textarea",
      "[contenteditable=\"true\"][role=\"textbox\"]",
      "[contenteditable=\"true\"]",
      "[role=\"textbox\"]"
    ],
    "sendSelectors": [],
    "sendClassHints": [],
    "sendSvgPaths": [],
    "sendAriaLabels": [
      "发送",
      "Send",
      "Submit"
    ],
    "enterSends": false,
    "loginMarkers": [
      "login",
      "signin",
      "passport",
      "sso"
    ],
    "verifyUrlRegex": "^https?://(www\\.)?doubao\\.com/",
    "prefillParam": "",
    "upload": true
  },
  {
    "id": "chatgpt",
    "name": "ChatGPT",
    "url": "https://chatgpt.com/",
    "origins": [
      "chatgpt.com",
      "chat.openai.com"
    ],
    "composerSelectors": [
      "#prompt-textarea",
      "textarea#prompt-textarea",
      "div#prompt-textarea[contenteditable=\"true\"]"
    ],
    "sendSelectors": [
      "button[data-testid=\"send-button\"]",
      "button#composer-submit-button"
    ],
    "sendClassHints": [],
    "sendSvgPaths": [],
    "sendAriaLabels": [
      "Send prompt",
      "Send message",
      "发送"
    ],
    "enterSends": false,
    "loginMarkers": [
      "/auth/",
      "auth0",
      "login",
      "signin"
    ],
    "verifyUrlRegex": "^https?://(chatgpt\\.com|chat\\.openai\\.com)/",
    "prefillParam": "",
    "upload": true
  },
  {
    "id": "gemini",
    "name": "Gemini",
    "url": "https://gemini.google.com/app",
    "origins": [
      "gemini.google.com"
    ],
    "composerSelectors": [
      "rich-textarea .ql-editor",
      ".ql-editor[contenteditable=\"true\"]",
      "rich-textarea [contenteditable=\"true\"]"
    ],
    "sendSelectors": [
      "button[aria-label*=\"Send\"]",
      "button.send-button",
      "[class*=\"send-button\"]"
    ],
    "sendClassHints": [],
    "sendSvgPaths": [],
    "sendAriaLabels": [
      "Send message",
      "Send",
      "发送"
    ],
    "enterSends": false,
    "loginMarkers": [
      "accounts.google.com",
      "servicelogin",
      "signin",
      "login"
    ],
    "verifyUrlRegex": "^https?://gemini\\.google\\.com/",
    "prefillParam": "",
    "upload": true
  },
  {
    "id": "grok",
    "name": "Grok",
    "url": "https://grok.com/",
    "origins": [
      "grok.com",
      "x.com"
    ],
    "composerSelectors": [
      "textarea[aria-label]",
      "textarea"
    ],
    "sendSelectors": [
      "button[aria-label=\"Submit\"]",
      "button[type=\"submit\"]",
      "[aria-label=\"Submit\"]"
    ],
    "sendClassHints": [],
    "sendSvgPaths": [],
    "sendAriaLabels": [
      "Submit",
      "发送"
    ],
    "enterSends": false,
    "loginMarkers": [
      "login",
      "signin",
      "i/flow"
    ],
    "verifyUrlRegex": "^https?://(grok\\.com|x\\.com)/",
    "prefillParam": "",
    "upload": true
  }
]

// ---------- lib/providers.js ----------
/**
 * 网页版服务方注册表（多服务方支持，1.2.0 起）。
 *
 * **数据不在本文件**：`PROVIDERS` 等来自 `providers.data.js`，那是 `shared/providers.json`
 * 的生成物（唯一真源）。本文件只放「怎么用」的纯函数，改服务方请改真源再跑
 * `node tools/gen-providers.mjs`，不要手改 `providers.data.js`。
 *
 * 扩展侧的差异（如 DeepSeek 不用合成 Enter 兜底）写在真源的 `overrides.extension` 里，
 * 生成时已合并，这里不需要再分支。
 *
 * 内容脚本不 import 本模块（MV3 内容脚本不支持 ESM），由 background 在消息里把
 * 整条 provider 定义（普通可结构化克隆对象）传给 chat-bridge.js。
 */



/** 默认服务方的存储键（chrome.storage.local）。 */
const PROVIDER_STORAGE_KEY = 'bubble-ask.provider'

/** 按 id 取服务方；未知/非字符串返回 undefined。 */
function getProvider(id) {
  if (typeof id !== 'string' || !id) return undefined
  return PROVIDERS.find((provider) => provider.id === id)
}

/** 按 id 取服务方，未知时回落到默认服务方（永不返回空）。 */
function resolveProvider(id) {
  return getProvider(id) || getProvider(DEFAULT_PROVIDER_ID)
}

/**
 * URL 是否属于该服务方（用于识别扩展自己窗口里的标签页）。
 * origins 可以写完整主机名（chat.deepseek.com）或可注册域名（deepseek.com）。
 */
function isProviderUrl(providerOrId, url) {
  const provider = typeof providerOrId === 'string' ? resolveProvider(providerOrId) : providerOrId
  if (!provider || !url) return false
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch (error) {
    return false
  }
  return (provider.origins || []).some((origin) => {
    const value = String(origin || '').toLowerCase().replace(/^\./, '')
    if (!value) return false
    return host === value || host.endsWith(`.${value}`)
  })
}

/** 把 origins 变成 manifest 匹配模式：两级域名用通配子域，更具体的写准确主机。 */
function originToMatchPattern(origin) {
  const host = String(origin || '').toLowerCase().trim().replace(/^\./, '')
  if (!host) return ''
  const labels = host.split('.').filter(Boolean)
  return `https://${labels.length <= 2 ? '*.' : ''}${host}/*`
}

/**
 * 由注册表推导出的 manifest 匹配模式（顺序稳定、已去重）。
 * manifest.json 里的 host_permissions / chat-bridge.matches / 排除列表都要覆盖它；
 * `tools/check-providers.mjs` 会做一致性断言。
 */
const PROVIDER_MATCH_PATTERNS = [
  ...new Set(
    PROVIDERS.flatMap((provider) => (provider.origins || []).map(originToMatchPattern)).filter(Boolean),
  ),
]

// ---------- lib/prompt.js ----------
/**
 * 页面上下文 → 提问文本。
 *
 * 放在单独文件里，供 background 直接 import（popup 通过 BA_PREVIEW 拿到后台拼好的
 * 完整提问，不重复实现）。服务方只影响「发到哪个窗口」，不改变 prompt 的版式。
 */

/** 上下文预算：太大对网页版是负担，太小又丢掉结构。 */
const CONTEXT_BUDGET = {
  // 整页文本从 9000 降到 4500：真正有用的是「选中处所在的那一块」（见 localBlock），
  // 整页文本在 feed 类页面里大半是导航和页脚。
  text: 4500,
  headings: 40,
  interactive: 80,
  forms: 40,
  selectionAncestors: 4,
  localBlock: 2500,
  localParent: 320,
  localSibling: 400,
}

const DEFAULT_QUESTION = '请解释这段选中文字在这个页面的上下文中的含义：它指代什么、为什么这样写、和页面上哪一块内容相关。'

const DEFAULT_QUESTION_NO_SELECTION = '请概括这个页面的用途和关键信息，并指出我在这里最可能想做的事。'

/** 超长文本按头尾截断，保留两端。 */
function clipMiddle(text, limit) {
  const value = String(text || '')
  if (value.length <= limit) return value
  const head = Math.floor(limit * 0.65)
  const tail = limit - head - 20
  return `${value.slice(0, head)}\n…（原文 ${value.length} 字，此处省略 ${value.length - head - tail} 字）…\n${value.slice(-tail)}`
}

/** 一行化，避免把换行带进列表。 */
function oneLine(text, limit) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

/** 把页面结构渲染成缩进列表。 */
function renderHeadings(headings) {
  if (!headings || headings.length === 0) return '（页面没有标题元素）'
  return headings.map((item) => `${'  '.repeat(Math.max(0, item.level - 1))}- H${item.level} ${oneLine(item.text, 90)}`).join('\n')
}

/** 把交互元素渲染成分组清单。 */
function renderInteractive(items) {
  if (!items || items.length === 0) return '（没有可交互元素）'
  const groups = new Map()
  for (const item of items) {
    const key = item.role
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  const lines = []
  for (const [role, list] of groups) {
    lines.push(`${role}（${list.length}）：`)
    for (const item of list.slice(0, 24)) {
      const extra = item.href ? ` → ${oneLine(item.href, 80)}` : item.type ? ` [${item.type}]` : ''
      lines.push(`  - ${oneLine(item.label, 70)}${extra}`)
    }
    if (list.length > 24) lines.push(`  - …另有 ${list.length - 24} 个`)
  }
  return lines.join('\n')
}

/** 把表单字段渲染成清单。 */
function renderForms(fields) {
  if (!fields || fields.length === 0) return '（没有表单字段）'
  return fields
    .map((field) => {
      const bits = [`${field.type || 'input'}`]
      if (field.label) bits.push(`标签「${oneLine(field.label, 40)}」`)
      if (field.name) bits.push(`name=${field.name}`)
      if (field.placeholder) bits.push(`占位「${oneLine(field.placeholder, 40)}」`)
      if (field.required) bits.push('必填')
      return `- ${bits.join(' ')}`
    })
    .join('\n')
}

/** 把「选中处所在的那一块」渲染出来。 */
function renderLocal(local) {
  if (!local) return '（没有取到局部上下文）'
  const lines = []
  if (local.where) lines.push(`所在区块：${local.where}${local.chars ? `（这块共约 ${local.chars} 字）` : ''}`)
  if (local.heading) lines.push(`最近的小标题：${oneLine(local.heading, 140)}`)
  if (local.block) {
    lines.push('这一块的完整文字：')
    lines.push('```')
    lines.push(local.block)
    lines.push('```')
  }
  if (local.above) lines.push(`它上面那一块：${oneLine(local.above, 400)}`)
  if (local.below) lines.push(`它下面那一块：${oneLine(local.below, 400)}`)
  if (local.parents && local.parents.length > 0) {
    lines.push('再往外（由近到远）：')
    for (const parent of local.parents) lines.push(`- ${parent.where}：${oneLine(parent.text, 320)}`)
  }
  return lines.join('\n')
}

/**
 * 组装最终提问。
 *
 * 版式与 DSH 插件保持一致：编号章节 + 明确引用号规则，模型更容易照做。
 */
function buildPrompt(context, question) {
  const page = context || {}
  const selection = (page.selection && page.selection.text) || ''
  const local = page.selection && page.selection.local
  const asked = String(question || '').trim()
  const askedOrDefault = asked || (selection ? DEFAULT_QUESTION : DEFAULT_QUESTION_NO_SELECTION)
  const lines = []
  // 章节号按需递增：加了/少了某一节都不会串号
  let section = 0
  const head = (title) => `【${'一二三四五六七八九'[section++] || String(section)}、${title}】`

  lines.push('下面是一个网页的上下文，请把它当作背景。')
  lines.push('')
  lines.push(head('页面背景'))
  lines.push(`标题：${oneLine(page.title, 160) || '（无）'}`)
  lines.push(`地址：${page.url || '（未知）'}`)
  if (page.description) lines.push(`描述：${oneLine(page.description, 220)}`)
  if (page.lang) lines.push(`语言：${page.lang}`)
  if (page.stats) {
    lines.push(`规模：可见文本约 ${page.stats.textChars} 字，元素约 ${page.stats.elements} 个，标题 ${page.headings?.length || 0} 个，可交互 ${page.interactive?.length || 0} 个`)
  }
  lines.push('')
  lines.push(head('页面结构（标题层级）'))
  lines.push(renderHeadings(page.headings))
  lines.push('')
  lines.push(head('页面文字内容'))
  lines.push(clipMiddle(page.text, CONTEXT_BUDGET.text) || '（没有可读文本）')
  lines.push('')
  lines.push(head('可交互元素与表单'))
  lines.push(renderInteractive(page.interactive))
  lines.push('')
  lines.push(renderForms(page.forms))

  if (local) {
    lines.push('')
    lines.push(head('选中文字所在的上下文'))
    lines.push(renderLocal(local))
  }

  if (selection) {
    lines.push('')
    lines.push(head('我选中的文字'))
    lines.push('```')
    lines.push(oneLine(selection, 2000))
    lines.push('```')
    const ancestors = (page.selection && page.selection.ancestors) || []
    if (ancestors.length > 0) {
      lines.push('这段文字所在的位置：')
      for (const item of ancestors) lines.push(`- ${item}`)
    }
  }

  lines.push('')
  lines.push(head('我的问题'))
  lines.push(askedOrDefault)
  lines.push('')
  lines.push('回答时请遵守：')
  lines.push('1. 优先依据上面的页面上下文回答，不要凭空猜测页面没写的内容；信息不足时直接说明缺什么。')
  lines.push('2. 如果问题针对我选中的文字，请先说明它在页面上属于哪一块（标题 / 正文 / 按钮 / 表单 / 表格 / 代码等），再解释含义。')
  lines.push('3. 「选中文字所在的上下文」那一节是这段文字前后真正的内容，解释时优先用它，不要拿页面顶部的导航或底部的页脚去硬套。')
  lines.push('4. 中文作答，句子短一些；涉及页面上的具体控件时，用它的可见文字指代。')

  return lines.join('\n')
}

/** 供 popup 预览用：不拼完整 prompt，只给个规模感。 */
function describeContext(context) {
  if (!context) return '尚未读取页面'
  const parts = []
  parts.push(`${context.stats?.textChars || 0} 字`)
  parts.push(`${context.headings?.length || 0} 个标题`)
  parts.push(`${context.interactive?.length || 0} 个可交互元素`)
  parts.push(`${context.forms?.length || 0} 个表单字段`)
  if (context.selection?.text) parts.push(`选中 ${context.selection.text.length} 字`)
  const local = context.selection?.local
  if (local && local.block) parts.push(`局部上下文 ${local.block.length} 字`)
  return parts.join(' · ')
}

// ---------- background.js ----------
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
 * @param localOverride 气泡在**弹出那一刻**抓下的「选区周围的文字」。等这里再去读
 *        DOM 时选区早就没了，祖先链和局部上下文都会是空的 —— 所以只能由气泡带过来。
 */
async function ask(tabId, question, selectionOverride, providerParam, localOverride) {
  const provider = await resolveProviderParam(providerParam)
  const context = await collectFromTab(tabId)
  const selectionText = String(selectionOverride || '').trim()
  if (selectionText) {
    const local = localOverride || (context.selection && context.selection.local) || null
    context.selection = {
      text: selectionText,
      ancestors: (context.selection && context.selection.ancestors) || [],
    }
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
    ask(tabId, String(message.question || ''), selection, message.provider, message.local || null)
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
})()
