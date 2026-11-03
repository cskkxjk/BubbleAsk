/**
 * Bubble Ask —— Host 半。
 *
 * 职责：把当前会话的「精简轨迹」取出来，和用户选中的文字一起拼成一段带上下文的提问，
 * 再交给 DeepSeek 网页版。Client 半只负责选词和气泡，通过本进程的 HTTP 路由拿结果。
 *
 * 两条链路：
 *   panel —— 组好的提问交给右侧栏的 Bubble Ask 专属面板（可见、可复制、可再发送）
 *   cdp   —— 直接驱动本机 Chromium（--app + CDP）注入并发送，且回读校验
 *
 * 不再使用右侧栏的内嵌浏览器（ctrl+T Browser）：那套 Electron guest 环境的存储分区
 * 由主进程按进程生命周期生成（无 persist: 前缀），每次重启都要重新登录，
 * 且网页版会把 guest 环境判定为「使用环境异常」。
 */
/**
 * CDP 模块（lib/deepseek-web.mjs）按需加载：缺文件时面板与「复制全文」照样能用，
 * 只是「发送到 DeepSeek」这条自动路径会明确报未就绪，而不是整个插件挂掉。
 */
let cdpModule
async function loadCdp() {
  if (cdpModule) return cdpModule
  try {
    cdpModule = await import('./lib/deepseek-web.mjs')
  } catch (error) {
    // 不缓存失败：文件后补到位时，下一次请求还能重新尝试加载。
    try {
      console.log('[bubble-ask] CDP 模块加载失败：' + String(error?.message ?? error))
    } catch {
      /* 忽略 */
    }
    return null
  }
  return cdpModule
}

const DEFAULTS = {
  /** DeepSeek 网页版地址 */
  chatUrl: 'https://chat.deepseek.com/',
  /** 轨迹里最多带几轮消息（user/assistant 各算一条） */
  maxMessages: 12,
  /** 每条消息截断到多少字 */
  maxCharsPerMessage: 240,
  /** 整段轨迹的字数上限 */
  maxTraceChars: 2600,
  /**
   * 轨迹挑选策略：
   *   relevance（默认）—— 首条用户请求 + 最后 recentTail 条固定保留，其余按与选区的相关性挑
   *   recent —— 老行为，只取最后 maxMessages 条
   */
  traceMode: 'relevance',
  /** relevance 模式下固定保留的末尾条数 */
  recentTail: 3,
  /** 工具结果最多进几条（作为「证据」，只在真的覆盖选区时进） */
  maxToolEntries: 2,
  /** 工具结果进轨迹所需的最小覆盖率 */
  toolMinCoverage: 0.12,
  /**
   * 助手正文的最短保留长度。低于这个长度且不含路径/错误/决策的句子
   * 属于「过程性叙述」（Now let me…／正在…），不进轨迹。
   */
  minAssistantChars: 60,
  /** 浏览器 exe；留空自动检测 */
  browserPath: '',
  /** CDP 调试端口 */
  cdpPort: 9333,
  /** 独立登录 profile 目录；留空用 %APPDATA%\BubbleAsk\edge-profile */
  profileDir: '',
  /** true 则注入后自动点发送 */
  autoSend: true,
  /**
   * 等网页版输入框的预算（毫秒）。首次冷启动（新 profile、刚登录）实测会超过 25s：
   * 拉浏览器 + 整页加载 + SPA 渲染都在这个窗口里，给足 60s。
   */
  readyTimeoutMs: 60000,
}

const ROUTE_PROMPT = '/bubble-ask/prompt'
const ROUTE_SEND = '/bubble-ask/send'
const ROUTE_OPEN = '/bubble-ask/open'
const ROUTE_STATE = '/bubble-ask/state'
const ROUTE_HEALTH = '/bubble-ask/health'
const ROUTE_DIAG = '/bubble-ask/diag'
const MAX_BODY_BYTES = 128 * 1024

/** Client 半上报的记录（最近若干条，用于无人值守自检）。 */
const diagLog = []
const DIAG_LIMIT = 40

/**
 * 上一次「组好的提问」和「发送结果」。
 *
 * 侧边栏面板是独立的一棵子树，页面重载后模块内存会清空；面板挂载时读这两个字段
 * 就能把上一次的上下文找回来，不必让用户重新划词。
 */
let lastAsk = null
let lastSend = null

export const name = 'bubble-ask'
export const inject = ['webServer']

/** 读请求体（有大小上限），解析成 JSON 对象。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 回一个 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 这些是 Harness 注入的运行时上下文，不是用户真的说的话，拼轨迹时丢掉。 */
const RUNTIME_NOISE = [
  /^Time sampled while preparing/,
  /^Elapsed since the preceding/,
  /^Browser time zone for this request/,
  /^Current runtime context/,
  /^Current DSH file policy/,
  /^Approval prompts are disabled/,
  /^The approval policy changed from/,
  // 子代理/队友的消息回显与后台通知，不是用户原话
  /^Agent [0-9a-f-]{8,} sent a message:/,
  /^Background subagent [0-9a-f-]{8,} finished/,
  /^\[BubbleAsk 自检\]/,
  /<system-reminder>/,
]

/**
 * 工具结果里这些内容对「解释语义」没帮助，整条跳过：
 * 本插件自己的历史 prompt 回显、纯统计输出。
 */
const TOOL_RESULT_NOISE = [
  /^mode=(prefill|clipboard)/,
  /^\{?"ok":(true|false),"stage"/,
]

/** 取出若干类型块拼成的纯文本。 */
function blocksText(blocks, types) {
  let text = ''
  for (const block of blocks) {
    if (block && types.includes(block.type) && typeof block.text === 'string') text += block.text
  }
  return text.replace(/\s+/g, ' ').trim()
}

/** 工具名归一化：mcp__foo__bar → foo.bar，其余原样。 */
function normalizeToolName(name) {
  const raw = String(name || '').trim()
  if (!raw) return ''
  const mcp = /^mcp__([^_]+)__(.+)$/.exec(raw)
  if (mcp) return `${mcp[1]}.${mcp[2]}`
  return raw
}

/**
 * 过程性叙述（“Now let me…”、“正在…”、纯工具调用行）对「解释语义」没有价值，
 * 只留实质内容：带路径/错误/决策/数值的句子。
 */
const PROCESS_NARRATION = [
  /^(now|next|then|let me|let's|i'll|i will|first|okay|ok|done|stopped)\b/i,
  /^(现在|接下来|然后|我来|让我|先|好的|行|已完成|继续)/,
]

/** 这条文本值不值得进轨迹（assistant 用）。 */
function worthKeeping(entry, minChars) {
  const text = String(entry.text || '').trim()
  if (!text) return false
  // 有实质产物/结论的关键词，一律保留，哪怕很短
  if (/[A-Za-z]:\\|\/[\w.-]+\/[\w./-]+|:\d+/.test(text)) return true
  if (/error|exception|failed|失败|报错|414|429|401|404|ECONNREFUSED/i.test(text)) return true
  if (/因为|所以|原因|决定|选择|instead|because|therefore|结论/i.test(text)) return true
  if (text.length >= minChars) return true
  // 短文本且是过程性叙述 → 丢
  if (PROCESS_NARRATION.some((pattern) => pattern.test(text))) return false
  return text.length >= Math.floor(minChars / 2)
}

/**
 * 把消息数组收集成轨迹条目。
 * 条目类型：
 *   user      —— 用户原话（已滤掉运行时注入）
 *   assistant —— 只留有实质内容的正文 + 它这一轮调用过的工具名
 *   tool      —— 工具结果（只取骨架）
 */
function collectTraceEntries(messages, options = {}) {
  const entries = []
  const seenToolTexts = new Set()
  const minAssistantChars = options.minAssistantChars ?? 60
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message) continue
    const blocks = Array.isArray(message.content) ? message.content : []
    if (message.role === 'user') {
      const text = blocksText(blocks, ['text'])
      if (!text) continue
      if (RUNTIME_NOISE.some((pattern) => pattern.test(text))) continue
      entries.push({ index, kind: 'user', text })
      continue
    }
    if (message.role === 'assistant') {
      const text = blocksText(blocks, ['text'])
      const tools = blocks
        .filter((block) => block && block.type === 'tool-call')
        .map((block) => normalizeToolName(block.name))
        .filter(Boolean)
      // 纯工具调用行（没有正文）不进轨迹 —— 用户明确说过不需要
      if (!text) continue
      if (!worthKeeping({ text }, minAssistantChars)) continue
      entries.push({ index, kind: 'assistant', text, tools })
      continue
    }
    if (message.role === 'tool') {
      const text = blocksText(blocks, ['text'])
      if (!text) continue
      if (TOOL_RESULT_NOISE.some((pattern) => pattern.test(text))) continue
      // 完全重复的工具结果只留第一次（DROP：重复读取）
      const fingerprint = text.slice(0, 500)
      if (seenToolTexts.has(fingerprint)) continue
      seenToolTexts.add(fingerprint)
      entries.push({ index, kind: 'tool', text })
    }
  }
  return entries
}

/** 选区 → 字符二元组集合（中文按字、英文按词压平），用于相关性打分。 */
function bigramsOf(text) {
  const normalized = String(text || '').toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, '')
  const grams = new Set()
  for (let i = 0; i + 1 < normalized.length; i += 1) grams.add(normalized.slice(i, i + 2))
  return grams
}

/** 工具结果渲染：结构化数据只露骨架，普通文本留头尾。 */
function describeToolResult(text) {
  const value = String(text || '').trim()
  if (!value) return ''
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) {
        return `（JSON 数组，${parsed.length} 项）`
      }
      if (parsed && typeof parsed === 'object') {
        const keys = Object.keys(parsed).slice(0, 12)
        return `（JSON 对象，键：${keys.join('、')}${Object.keys(parsed).length > keys.length ? ' 等' : ''}）`
      }
    } catch {
      // 解析不了就按普通文本处理
    }
  }
  return clipBothEnds(value, 90)
}

/** 单条截断。 */
function clip(text, limit) {
  const value = String(text || '')
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/**
 * 「保信号、丢载体」的摘录（借鉴 billion-context 的 KEEP VERBATIM / DROP 契约）：
 * 不是粗暴砍前 N 字，而是按句切分后优先保留承载信息的句子 ——
 * 带行号的路径、错误原文、决策与理由、精确数值、结论句。
 */
function salientExcerpt(text, limit) {
  const value = String(text || '').trim()
  if (value.length <= limit) return value

  // 先把围栏代码块整体占位替换，避免在代码里按句号乱切
  // （否则会切出 `} useEffect = (fn) => { const i = cursor++` 这种残片）。
  const fences = []
  const masked = value.replace(/```[\s\S]*?```/g, (fence) => {
    fences.push(fence)
    return ` \u0000CODE${fences.length - 1}\u0000 `
  })
  const restore = (part) => part.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => fences[Number(i)] || '')

  const sentences = masked
    .split(/(?<=[。！？；\n])|(?<=\.\s)/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (sentences.length <= 1) return clip(value, limit)

  const scored = sentences.map((sentence, order) => {
    let score = 0
    // 带行号的文件路径 / 绝对路径：最不可替代
    if (/[A-Za-z]:\\[^\s]+|\/[\w.-]+\/[\w./-]+/.test(sentence)) score += 4
    if (/:\d+/.test(sentence)) score += 2
    // 错误原文
    if (/error|exception|failed|失败|报错|throw|ENOENT|EACCES|414|429|401|404/i.test(sentence)) score += 3
    // 决策与理由
    if (/因为|所以|原因|决定|选择|instead|because|therefore/i.test(sentence)) score += 2
    // 精确数值 / 版本 / 配置键
    if (/[0-9]+\s*(ms|s|字|行|条|%|KB|MB|x)\b|\bv?\d+\.\d+/.test(sentence)) score += 1
    if (/[a-z_]+\.[a-z]+\(|=>/.test(sentence)) score += 1
    // 列表项通常自带结论
    if (/^[-*•]|^\d+[.)]/.test(sentence)) score += 1
    // 代码块单独占位：保留价值中等，但不许它撑爆预算
    if (sentence.includes('\u0000CODE')) score += 1
    // 长度惩罚：过短的客套句价值低
    if (sentence.length < 8) score -= 2
    return { sentence, order, score }
  })

  const picked = []
  let used = 0
  for (const item of [...scored].sort((a, b) => b.score - a.score || a.order - b.order)) {
    if (item.score <= 0 && picked.length > 0) break
    const expandedLength = restore(item.sentence).length
    if (used + expandedLength + 1 > limit) continue
    picked.push(item)
    used += expandedLength + 1
    if (used >= limit * 0.95) break
  }
  if (picked.length === 0) return clip(value, limit)
  // 按原顺序还原，读起来才是连贯的
  picked.sort((a, b) => a.order - b.order)
  return picked.map((item) => restore(item.sentence)).join(' ').replace(/\s+/g, ' ').trim()
}

/** 工具结果只留头尾（C）。 */
function clipBothEnds(text, side) {
  const value = String(text || '')
  if (value.length <= side * 2 + 1) return value
  return `${value.slice(0, side)}……${value.slice(-side)}`
}

/** 覆盖率：选区里有多少二元组出现在这段文字中（长文本不会因为体量取胜）。 */
function coverageOf(text, grams) {
  if (grams.size === 0) return 0
  const normalized = String(text || '').toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, '')
  if (!normalized) return 0
  let hits = 0
  for (let i = 0; i + 1 < normalized.length; i += 1) {
    if (grams.has(normalized.slice(i, i + 2))) hits += 1
  }
  // 命中的去重比例更稳：同一片段重复出现不会刷高分数
  const uniqueHit = new Set()
  for (let i = 0; i + 1 < normalized.length; i += 1) {
    const gram = normalized.slice(i, i + 2)
    if (grams.has(gram)) uniqueHit.add(gram)
  }
  return uniqueHit.size / grams.size
}

/**
 * 把消息数组压成「精简轨迹」文本。
 *
 * 三个池子，分开处理（早期版本把工具 JSON 当正文一起打分，结果被大段 JSON 淹没）：
 *   1. 正文池（我 / 助手）—— 固定保留首条请求与最后 recentTail 条，其余按覆盖率挑
 *   2. 证据池（工具结果）—— 最多 toolBudget 条，且必须真的覆盖了选区文字；渲染成骨架
 *   3. 兜底 —— 名额没填满就从末尾往前补正文
 */
function condenseMessages(messages, options, selection) {
  const entries = collectTraceEntries(messages, options)
  const grams = bigramsOf(selection)
  const mode = options.traceMode === 'recent' ? 'recent' : 'relevance'

  const prosePool = entries.filter((entry) => entry.kind !== 'tool')
  const toolPool = entries.filter((entry) => entry.kind === 'tool')

  const scored = (entry) => coverageOf(`${entry.text || ''} ${(entry.tools || []).join(' ')}`, grams)

  let chosen
  let toolChosen = []
  if (mode === 'recent') {
    chosen = entries.slice(-options.maxMessages)
  } else {
    const pinned = new Set()
    const firstUser = prosePool.find((entry) => entry.kind === 'user')
    if (firstUser) pinned.add(firstUser.index)
    const tailCount = Math.max(1, Math.min(options.recentTail ?? 3, prosePool.length))
    for (const entry of prosePool.slice(-tailCount)) pinned.add(entry.index)

    const proseBudget = Math.max(1, options.maxMessages - (options.maxToolEntries ?? 2))
    const ranked = prosePool
      .filter((entry) => !pinned.has(entry.index))
      .map((entry) => ({ entry, score: scored(entry) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)

    const chosenIndexes = new Set(pinned)
    for (const item of ranked) {
      if (chosenIndexes.size >= proseBudget) break
      chosenIndexes.add(item.entry.index)
    }
    if (chosenIndexes.size < proseBudget) {
      for (let i = prosePool.length - 1; i >= 0 && chosenIndexes.size < proseBudget; i -= 1) {
        chosenIndexes.add(prosePool[i].index)
      }
    }

    // 证据池：只有真的覆盖选区的工具结果才进，最多 toolBudget 条
    const toolBudget = Math.max(0, options.maxToolEntries ?? 2)
    toolChosen = toolPool
      .map((entry) => ({ entry, score: scored(entry) }))
      .filter((item) => item.score >= (options.toolMinCoverage ?? 0.12))
      .sort((a, b) => b.score - a.score)
      .slice(0, toolBudget)
      .map((item) => item.entry)

    chosen = entries
      .filter((entry) => chosenIndexes.has(entry.index) || toolChosen.includes(entry))
      .sort((a, b) => a.index - b.index)
  }

  const lines = []
  let used = 0
  const counts = { user: 0, assistant: 0, tool: 0 }
  let relevant = 0
  for (const entry of chosen) {
    counts[entry.kind] += 1
    if (scored(entry) > 0) relevant += 1
    // 消息引用号：模型回答时能引用「见 m23」，我们也留着以后回查原文
    const ref = `[m${entry.index}]`
    let line
    if (entry.kind === 'user') {
      line = `${ref} 我：${salientExcerpt(entry.text, options.maxCharsPerMessage)}`
    } else if (entry.kind === 'assistant') {
      const body = salientExcerpt(entry.text, options.maxCharsPerMessage)
      const toolPart = entry.tools && entry.tools.length > 0 ? `（调用：${entry.tools.join('、')}）` : ''
      line = `${ref} 助手：${body}${toolPart}`
    } else {
      line = `${ref} 工具结果：${describeToolResult(clip(entry.text, options.maxCharsPerMessage * 3))}`
    }
    if (used + line.length > options.maxTraceChars) break
    lines.push(line)
    used += line.length + 1
  }
  return {
    trace: lines.join('\n'),
    messages: lines.length,
    chars: used,
    counts,
    relevantEntries: relevant,
    totalEntries: entries.length,
    toolCandidates: toolPool.length,
    mode,
  }
}

/** 组一段「带上下文的提问」。 */
function buildPrompt({ trace, selection, question, cwd }) {
  const ask = (question && question.trim())
    || '请解释这段文字在当前会话上下文中的含义。'
  const parts = [
    '下面是我和一个 AI 编码助手刚才那段会话的「精简轨迹」，请把它当作背景上下文。',
  ]
  if (cwd) parts.push(`（会话的工作目录：${cwd}）`)
  parts.push(
    '',
    '【会话精简轨迹】',
    '（标注：`[mNN]` 是消息引用号；我＝用户原话，助手＝AI 回复，括号里是它这一轮调用的工具；工具结果只保留骨架）',
    trace || '（这次会话还没有可用的消息）',
    '',
    '【我在会话里选中的文字】',
    '"""',
    selection,
    '"""',
    '',
    '【我的问题】',
    ask,
    '',
    '请结合【会话精简轨迹】解释这段选中文字在当前上下文中的含义：它指代什么、为什么这样表述、' +
      '和上下文里的哪一步相关。先给一句结论，再列 2 到 4 条依据，' +
      '依据请带上消息引用号（例如「见 m23」）；' +
      '如果轨迹里的信息不足以判断，直接说明缺什么，不要编造。',
    '',
    '（阅读轨迹时的取舍规则：带行号的文件路径、函数签名、错误原文、决策及其理由、精确数值与版本' +
      '比叙述性文字重要得多；冗长日志、重复读取、失败的尝试只看结论。据此判断哪些细节值得引用。）',
  )
  return parts.join('\n')
}

/** 把 prompt 拼成 DeepSeek 网页版认的 ?q= 预填地址。 */
function buildPrefillUrl(chatUrl, prompt) {
  const base = chatUrl || DEFAULTS.chatUrl
  const separator = base.includes('?') ? '&' : '?'
  const encoded = encodeURIComponent(prompt)
  return `${base}${separator}q=${encoded}`
}

/**
 * `?q=` 预填的可用上限（编码后总长度）。
 *
 * 实测（2026-11-02，chat.deepseek.com 后面的 openresty + WAF）：
 *   - 请求行超 8KB → `414 Request-URI Too Large`（纯 ASCII 8029 通过、8329 就是 414）
 *   - 但更靠前的是限流：真实 prompt 换出来的 ~7.0–7.5K URL **稳定 429**，
 *     等 3 分钟、单次请求、去掉换行都一样；而 `?q=test` 和小 ASCII 一直 200。
 *
 * 结论：`?q=` 只适合短内容。长提问改走「打开网页 + 剪贴板」，既不压缩上下文也不碰阈值。
 * 这里把阈值取到 3000（远低于任何实测边界），超过就走剪贴板。
 */
const PREFILL_URL_SHORT_MAX = 3000

/** 编码后的长度（?q= 里放的就是这个）。 */
function encodedLength(text) {
  return encodeURIComponent(text).length
}

/** ?q= 的固定前缀。 */
function prefillBase(chatUrl) {
  const base = chatUrl || DEFAULTS.chatUrl
  return `${base}${base.includes('?') ? '&' : '?'}q=`
}

/** 从会话日志里取轨迹（把选区传进去，用于相关性选段）。 */
function traceOfSession(sessions, sessionId, options, selection) {
  const session = sessions?.get(sessionId)
  if (!session) return undefined
  let messages = []
  try {
    messages = session.deriveMessages()
  } catch {
    messages = []
  }
  const condensed = condenseMessages(messages, options, selection)
  let cwd = ''
  try {
    cwd = session.header?.cwd ?? ''
  } catch {
    cwd = ''
  }
  return { ...condensed, cwd }
}

/**
 * 组装一次提问：精简轨迹 + 选中文字 + 问题。
 *
 * 两条投递模式（都不压缩上下文，prompt 永远是完整版）：
 *   prefill   —— prompt 很短时才用 `?q=` 预填（省掉粘贴动作）
 *   clipboard —— 长提问的默认方式：打开干净的 chat.deepseek.com，把完整 prompt 交给
 *                剪贴板，用户在输入框按 Ctrl+V 再回车。绕开 8KB 请求行 / WAF 限流。
 */
function prepareAsk(sessions, settings, input) {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
  const selection = typeof input.selection === 'string' ? input.selection.trim() : ''
  if (!selection) return { ok: false, error: '没有选中文字' }

  const condensed = sessionId ? traceOfSession(sessions, sessionId, settings, selection) : undefined
  const prompt = buildPrompt({
    trace: condensed?.trace ?? '',
    selection,
    question: input.question,
    cwd: condensed?.cwd,
  })

  const base = prefillBase(settings.chatUrl)
  const encodedChars = encodedLength(prompt)
  const usePrefill = base.length + encodedChars <= PREFILL_URL_SHORT_MAX
  return {
    ok: true,
    /** 'prefill' = 直接带 ?q= 打开；'clipboard' = 打开网页 + 复制完整提问 */
    mode: usePrefill ? 'prefill' : 'clipboard',
    prompt,
    url: usePrefill ? base + encodeURIComponent(prompt) : (settings.chatUrl || DEFAULTS.chatUrl),
    stats: {
      sessionId,
      traceMessages: condensed?.messages ?? 0,
      traceChars: condensed?.chars ?? 0,
      traceMode: condensed?.mode ?? settings.traceMode,
      traceCounts: condensed?.counts ?? { user: 0, assistant: 0, tool: 0 },
      traceRelevant: condensed?.relevantEntries ?? 0,
      traceTotalEntries: condensed?.totalEntries ?? 0,
      promptChars: prompt.length,
      encodedChars,
      urlChars: usePrefill ? base.length + encodedChars : base.length,
      prefillShortMax: PREFILL_URL_SHORT_MAX,
      sessionFound: condensed !== undefined,
    },
  }
}

/** 插件入口。 */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config }
  const log = (message) => {
    try {
      ctx.logger?.info?.(`[bubble-ask] ${message}`)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
  const sessions = () => ctx.get('sessions')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_HEALTH,
    async handler(_req, res) {
      const cdp = await loadCdp()
      let browsers = []
      try {
        browsers = cdp?.detectBrowsers?.() ?? []
      } catch {
        browsers = []
      }
      sendJson(res, 200, {
        ok: true,
        cdpReady: cdp !== null && cdp !== undefined,
        browsers,
        diag: diagLog,
        settings: { chatUrl: settings.chatUrl, autoSend: settings.autoSend },
      })
    },
  }), 'bubble-ask: health route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_DIAG,
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
      try {
        const input = await readJsonBody(req)
        diagLog.push({ at: Date.now(), ...input })
        if (diagLog.length > DIAG_LIMIT) diagLog.splice(0, diagLog.length - DIAG_LIMIT)
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'bubble-ask: diag route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PROMPT,
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
      try {
        const input = await readJsonBody(req)
        const result = prepareAsk(sessions(), settings, input)
        if (result.ok) {
          lastAsk = {
            at: Date.now(),
            sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
            question: typeof input.question === 'string' ? input.question : '',
            selection: typeof input.selection === 'string' ? input.selection.trim() : '',
            mode: result.mode,
            prompt: result.prompt,
            url: result.url,
            stats: result.stats,
          }
        }
        sendJson(res, result.ok ? 200 : 400, result)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'bubble-ask: prompt route')

  /**
   * 只把原生浏览器窗口拉起来 / 复用，不注入、不发送。
   *
   * 侧边栏面板的「打开窗口」用它：用户想先看看网页版、或者手动粘贴。
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_OPEN,
    async handler(req, res) {
      try {
        const cdp = await loadCdp()
        if (!cdp || typeof cdp.ensureBrowser !== 'function') {
          return sendJson(res, 503, { ok: false, stage: 'cdp', detail: 'CDP 模块未就绪' })
        }
        const opened = await cdp.ensureBrowser({
          config: {
            browserPath: settings.browserPath || undefined,
            cdpPort: settings.cdpPort,
            profileDir: settings.profileDir || undefined,
            chatUrl: settings.chatUrl,
            autoSend: false,
            readyTimeoutMs: settings.readyTimeoutMs,
          },
          log: (line) => log(line),
        })
        sendJson(res, 200, opened)
      } catch (error) {
        sendJson(res, 500, { ok: false, stage: 'error', detail: String(error?.message ?? error) })
      }
    },
  }), 'bubble-ask: open route')

  /** 面板重载后用来恢复上一次的提问与发送结果。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_STATE,
    async handler(_req, res) {
      sendJson(res, 200, { ok: true, lastAsk, lastSend })
    },
  }), 'bubble-ask: state route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_SEND,
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
      try {
        const input = await readJsonBody(req)
        const prepared = prepareAsk(sessions(), settings, input)
        if (!prepared.ok) return sendJson(res, 400, prepared)
        // CDP 注入没有长度限制，prompt 本身就是完整版。
        const fullPrompt = prepared.prompt
        log(`注入网页版：${fullPrompt.length} 字（轨迹 ${prepared.stats.traceMessages} 条）`)
        const cdp = await loadCdp()
        if (!cdp || typeof cdp.sendToDeepSeekWeb !== 'function') {
          return sendJson(res, 503, {
            ok: false,
            stage: 'cdp',
            detail: 'CDP 模块未就绪，可先用面板里的「复制全文」手动粘贴',
            prompt: fullPrompt,
            url: prepared.url,
            stats: prepared.stats,
          })
        }
        const sent = await cdp.sendToDeepSeekWeb({
          prompt: fullPrompt,
          config: {
            browserPath: settings.browserPath || undefined,
            cdpPort: settings.cdpPort,
            profileDir: settings.profileDir || undefined,
            chatUrl: settings.chatUrl,
            autoSend: settings.autoSend,
            readyTimeoutMs: settings.readyTimeoutMs,
          },
          log: (line) => log(line),
        })
        const body = { ...sent, prompt: fullPrompt, stats: prepared.stats, prefillUrl: prepared.url }
        // sent.url 是发送后真实的页面地址（会话页更好），没有才退回预填地址。
        if (!body.url) body.url = prepared.url
        lastAsk = {
          at: Date.now(),
          sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
          question: typeof input.question === 'string' ? input.question : '',
          selection: typeof input.selection === 'string' ? input.selection.trim() : '',
          mode: 'cdp',
          prompt: fullPrompt,
          url: body.url,
          stats: prepared.stats,
        }
        lastSend = {
          at: Date.now(),
          ok: Boolean(sent.ok),
          stage: sent.stage,
          detail: sent.detail ?? '',
          url: body.url,
        }
        sendJson(res, 200, body)
      } catch (error) {
        sendJson(res, 500, { ok: false, stage: 'error', detail: String(error?.message ?? error) })
      }
    },
  }), 'bubble-ask: send route')

  ctx.effect(() => () => {
    void cdpModule?.shutdown?.()
  }, 'bubble-ask: shutdown')

  log(`已就绪（chatUrl=${settings.chatUrl}）`)
}
