/**
 * Bubble Ask —— Host 半。
 *
 * 职责：把当前会话的「精简轨迹」取出来，和用户选中的文字一起拼成一段带上下文的提问，
 * 再交给网页版（默认 DeepSeek，气泡里可切换千问/豆包/ChatGPT/Gemini/Grok）。
 * Client 半只负责选词和气泡，通过本进程的 HTTP 路由拿结果。
 *
 * 投递方式只有一条（外加一个纯手动兜底）：
 *   app      —— 经本地命名管道交给 Bubble Ask 托盘应用注入并发送（同步回读校验）
 *   clipboard —— 只组上下文、不发送，把完整提问复制到剪贴板供手动粘贴
 *
 * 不在右侧栏渲染任何东西。内嵌浏览器（ctrl+T Browser）不可用：那套 Electron guest
 * 环境的存储分区由主进程按进程生命周期生成（无 persist: 前缀），每次重启都要重新登录，
 * 且网页版会把 guest 环境判定为「使用环境异常」；而原生窗口是独立 OS 窗口，无法内嵌。
 *
 * 也不自己驱动 CDP：托盘应用持有唯一一份持久化登录 profile，是网页版窗口的唯一权威，
 * 插件只当薄客户端（见 lib/ask-client.mjs）。
 */
/**
 * 托盘应用通信模块（lib/ask-client.mjs）按需加载：缺文件时「复制提问」照样能用，
 * 只是「发送到 DeepSeek」这条自动路径会明确报未就绪，而不是整个插件挂掉。
 */
let appModule
async function loadApp() {
  if (appModule) return appModule
  try {
    appModule = await import('./lib/ask-client.mjs')
  } catch (error) {
    // 不缓存失败：文件后补到位时，下一次请求还能重新尝试加载。
    try {
      console.log('[bubble-ask] 托盘通信模块加载失败：' + String(error?.message ?? error))
    } catch {
      /* 忽略 */
    }
    return null
  }
  return appModule
}

const DEFAULTS = {
  /** DeepSeek 网页版地址（provider=deepseek 时的入口；其余服务方用内置注册表里的地址） */
  chatUrl: 'https://chat.deepseek.com/',
  /**
   * 默认网页版服务方：deepseek / qwen / doubao / chatgpt / gemini / grok。
   * 气泡里的下拉选择会随每次请求覆盖它，并记在浏览器 localStorage。
   */
  provider: 'deepseek',
  /** 轨迹里最多带几轮消息（user/assistant 各算一条） */
  maxMessages: 12,
  /** 每条消息截断到多少字 */
  maxCharsPerMessage: 240,
  /** 整段轨迹的字数上限 */
  maxTraceChars: 2600,
  /**
   * 轨迹挑选策略：
   *   relevance（默认）—— 首条用户请求 + 命中选区的消息及邻居 + 最后 recentTail 条固定保留，
   *                       其余按与选区的相关性挑
   *   recent —— 老行为，只取最后 maxMessages 条
   */
  traceMode: 'relevance',
  /**
   * relevance 模式下固定保留的末尾条数。
   *
   * 默认 1（原为 3）：有了「命中锚点」之后，"最近的一定最相关"不再成立 ——
   * 实测最近几条常是工具操作的元叙述，反而挤掉真信息。
   */
  recentTail: 1,
  /** 命中消息前后各带几条邻居消息进轨迹 */
  hitNeighbors: 1,
  /** 「围绕命中位置的上下文」最多取几处命中 */
  maxHits: 3,
  /** 每处命中窗口取多少行 */
  hitWindowLines: 14,
  /** 每处命中窗口的字符上限 */
  hitWindowChars: 1200,
  /** 工具结果最多进几条（作为「证据」，只在真的覆盖选区时进） */
  maxToolEntries: 2,
  /** 工具结果进轨迹所需的最小覆盖率 */
  toolMinCoverage: 0.12,
  /**
   * 助手正文的最短保留长度。低于这个长度且不含路径/错误/决策的句子
   * 属于「过程性叙述」（Now let me…／正在…），不进轨迹。
   */
  minAssistantChars: 60,
  /** 浏览器/端口/profile 等归托盘应用自己管，插件不再重复配置，避免两处漂移。 */
  /**
   * 托盘应用 exe 路径。留空时依次用「发现文件里记录的路径」，
   * 两者都没有就报「未找到 Bubble Ask 托盘应用」。
   */
  appPath: '',
}

/**
 * 网页版服务方注册表。
 *
 * 与桌面端 `src/shared/WebProviders.cs` 的 6 家预设保持一致（id 是跨进程契约，不能改）。
 * 插件只当客户端：选择器、导航、登录态、发送都在桌面端；这里只需要 id/名称/入口地址
 * 用于气泡里的下拉框与「复制提问」的兜底地址。custom 不在插件里提供（桌面端设置里可配）。
 *
 * `prefillParam` 仅 DeepSeek 有：其余站点不支持 `?q=` 预填，直接走「复制提问」。
 */
const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', prefillParam: 'q' },
  { id: 'qwen', name: '千问 Qwen', url: 'https://www.qianwen.com/' },
  { id: 'doubao', name: '豆包 Doubao', url: 'https://www.doubao.com/chat/' },
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app' },
  { id: 'grok', name: 'Grok', url: 'https://grok.com/' },
]
const PROVIDER_IDS = PROVIDERS.map((provider) => provider.id)

/** 按 id 找服务方；未知 id 返回 null。 */
function findProvider(id) {
  return PROVIDERS.find((provider) => provider.id === id) || null
}

/**
 * 解析一次请求要用哪家服务方：
 *   1. 请求里带了 provider（气泡里的选择）—— 只认注册表里的 id，未知 id 明确报错；
 *   2. 没带 —— 用插件配置的 `provider`；
 *   3. 配置也不认识（手写 config 出错）—— 回退 DeepSeek，保证老用户行为不变。
 */
function resolveProvider(requested, settings) {
  const raw = typeof requested === 'string' ? requested.trim().toLowerCase() : ''
  if (raw) {
    const provider = findProvider(raw)
    if (!provider) return { error: raw }
    return { provider }
  }
  const configured = typeof settings.provider === 'string' ? settings.provider.trim().toLowerCase() : ''
  return { provider: findProvider(configured) || findProvider('deepseek') }
}

/** 解析版本号 "2.1.0" → [2,1,0]（允许省略后两段，如 "2.1"）；解析失败返回 null（无法判断时按不支持处理）。 */
function parseVersion(text) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(text || '').trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)]
}

/** 版本比较：a >= b。 */
function versionAtLeast(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return false
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true
    if (left[index] < right[index]) return false
  }
  return true
}

/**
 * 桌面端是否支持「按请求指定服务方」（AppVersion >= 2.1.0）。
 *
 * 旧桌面端会忽略 send 里的 provider 字段、按本机配置的入口发送 —— 切了服务方时
 * 必须先确认版本再发，不能发错站点。
 *
 * 刻意不做进程级缓存：用户升级桌面端后无需重启 DSH 即可生效；桌面端被降级/换回
 * 旧版时也能立刻重新拦截。一次 health 只是毫秒级管道往返，值得。
 */
async function checkProviderSupport(app, settings, log) {
  try {
    const health = await app.health({ appPath: settings.appPath, log })
    if (!health || health.ok !== true) {
      return { ok: false, error: 'provider-check', detail: (health && health.detail) || '无法连接托盘应用' }
    }
    const version = health.app
    if (versionAtLeast(version, '2.1.0')) {
      return { ok: true, version }
    }
    return {
      ok: false,
      error: 'old-app',
      detail: `托盘应用版本 ${version || '未知'} 过旧，切换服务方需要 2.1.0 或更高版本`,
    }
  } catch (error) {
    return { ok: false, error: 'provider-check', detail: String(error?.message ?? error) }
  }
}

const ROUTE_PROMPT = '/bubble-ask/prompt'
const ROUTE_SEND = '/bubble-ask/send'
const ROUTE_HEALTH = '/bubble-ask/health'
const ROUTE_DIAG = '/bubble-ask/diag'
const MAX_BODY_BYTES = 128 * 1024

/** Client 半上报的记录（最近若干条，用于无人值守自检）。 */
const diagLog = []
const DIAG_LIMIT = 40

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

/**
 * 这些是 Harness 注入的运行时上下文，不是用户真的说的话，拼轨迹时丢掉。
 *
 * 正常路径已改用消息自带的 `source.kind`（见 `isUserSpeech`）判别，这份清单只在
 * 拿不到 `source` 的旧会话里兜底，不要再往里加新文案。
 */
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

/** 无论来源如何都不进轨迹的：本插件自检时发出去的探针消息。 */
const ALWAYS_NOISE = [/^\[BubbleAsk 自检\]/]

/**
 * 一条 user 角色消息是不是「用户真的说的话」。
 *
 * DSH 给每条注入消息都写了 `source.kind`：真实用户消息是 `user`，注入的是
 * `time-context` / `runtime-context` / `skill-catalog` / `agent-message` /
 * `agent-instructions` / `compact-checkpoint` 等。这个字段比 Harness 的文案稳定得多
 * （实测本机 895 条 user 消息里 580 条是注入），所以优先用它；拿不到再退回文案黑名单。
 */
function isUserSpeech(message, text) {
  if (ALWAYS_NOISE.some((pattern) => pattern.test(text))) return false
  const kind = message && message.source ? message.source.kind : ''
  if (typeof kind === 'string' && kind) return kind === 'user'
  return !RUNTIME_NOISE.some((pattern) => pattern.test(text))
}

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
      if (!isUserSpeech(message, text)) continue
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
function condenseMessages(messages, options, selection, pinnedWindow) {
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

    // 命中选区的那条消息及其邻居：这是最可靠的锚点，优先占位。
    let hitPinned = 0
    if (pinnedWindow && pinnedWindow.size > 0) {
      for (const entry of entries) {
        if (!pinnedWindow.has(entry.index)) continue
        // 工具结果也允许被锚定，但受 toolBudget 限制，下面单独处理。
        if (entry.kind === 'tool') continue
        if (pinned.has(entry.index)) continue
        pinned.add(entry.index)
        hitPinned += 1
      }
    }

    // 尾部只保留最后 1 条：有了命中锚点之后，"最近的一定最相关"不再成立，
    // 实测里最近几条常常是工具操作的元叙述，反而挤掉真信息。
    const tailCount = Math.max(1, Math.min(options.recentTail ?? 1, prosePool.length))
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
    /** 被选中的条目（含完整原文），供另一种格式重渲染 / 对照。 */
    chosen,
  }
}

/**
 * 匹配用的归一化：去掉所有空白与统一大小写。
 *
 * 选区是从**渲染后的 DOM** 里抄出来的，原文可能带 markdown 包裹、软换行、
 * 缩进差异；只要去空白后仍是子串，就足以认定"这条消息就是选区出处"。
 */
function normalizeForMatch(text) {
  return String(text || '').replace(/\s+/g, '').toLowerCase()
}

/** 归一化后的选区至少要这么长才敢做精确子串判定，太短容易到处命中。 */
const HIT_MIN_CHARS = 8

/**
 * 找出选区出自哪几条消息。
 *
 * 这是整个轨迹质量的关键：知道"用户问的是第几条消息里的那句话"，就不用再靠
 * 话题相似度去猜，可以直接把这±邻居无条件带进上下文。
 *
 * @returns {{hits: number[], window: Set<number>, exact: boolean}}
 *   hits   —— 归一化后确实包含选区的消息下标
 *   window —— hit 及其前后各 neighbors 条（要一并纳入轨迹）
 *   exact  —— 是否靠精确子串命中（false 表示退化为覆盖率最高的那条）
 */
function locateSelection(messages, selection, neighbors = 1) {
  const needle = normalizeForMatch(selection)
  const hits = []
  if (needle.length >= HIT_MIN_CHARS) {
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      if (!message) continue
      const blocks = Array.isArray(message.content) ? message.content : []
      const haystack = normalizeForMatch(blocksText(blocks, ['text']))
      if (haystack && haystack.includes(needle)) hits.push(index)
    }
  }

  if (hits.length === 0) {
    // 精确匹配失败：退化成"覆盖率最高的那条"，只取一条，避免又变成噪声源。
    const grams = bigramsOf(selection)
    let best = null
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      if (!message) continue
      const blocks = Array.isArray(message.content) ? message.content : []
      const text = blocksText(blocks, ['text'])
      if (!text) continue
      const score = coverageOf(text, grams)
      if (best === null || score > best.score) best = { index, score }
    }
    if (best && best.score >= 0.3) {
      return { hits: [best.index], window: spanOf([best.index], messages.length, neighbors), exact: false }
    }
    return { hits: [], window: new Set(), exact: false }
  }

  return { hits, window: spanOf(hits, messages.length, neighbors), exact: true }
}

/** 把若干下标扩成"前后各 neighbors 条"的窗口。 */
function spanOf(indexes, total, neighbors) {
  const window = new Set()
  for (const index of indexes) {
    for (let offset = -neighbors; offset <= neighbors; offset += 1) {
      const target = index + offset
      if (target >= 0 && target < total) window.add(target)
    }
  }
  return window
}

/**
 * 字符窗口：以命中位置为圆心取一段，并对齐到行边界。
 *
 * 行窗口处理不了"整个文件被压成一行"这类工具输出（实测 main.js 的 grep 结果
 * 就是一个巨型单行），那时按行裁剪完全失效 —— 这里按字符兜底。
 */
function charWindowAround(text, selection, maxChars) {
  const value = String(text || '')
  const needle = normalizeForMatch(selection)
  if (!needle) return ''

  // 建立 归一化下标 → 原文下标 的映射，才能精确回指。
  const normalizedChars = []
  const mapping = []
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (/\s/.test(char)) continue
    normalizedChars.push(char.toLowerCase())
    mapping.push(index)
  }
  const haystack = normalizedChars.join('')
  const at = haystack.indexOf(needle)
  if (at < 0) return ''

  const rawStart = mapping[at]
  const rawEnd = mapping[Math.min(at + needle.length - 1, mapping.length - 1)]
  const budget = Math.max(120, maxChars)
  const half = Math.floor(budget / 2)
  let from = Math.max(0, rawStart - half)
  let to = Math.min(value.length, rawEnd + (budget - (rawEnd - from)))

  // 尽量对齐到行边界，读起来自然一些。
  const lineStart = value.lastIndexOf('\n', from)
  if (lineStart >= 0 && from - lineStart < 120) from = lineStart + 1
  const lineEnd = value.indexOf('\n', to)
  if (lineEnd >= 0 && lineEnd - to < 120) to = lineEnd

  const head = from > 0 ? `…（前面还有 ${from} 字符）` : ''
  const tail = to < value.length ? `（后面还有 ${value.length - to} 字符）…` : ''
  return `${head}${value.slice(from, to)}${tail}`
}

/**
 * 围绕命中位置取一段上下文（而不是"留头留尾"）。
 *
 * 之前的做法是 `clipBothEnds`：长工具结果只留头尾 —— 而"在长文件里找某一行"
 * 恰恰是最典型的场景，命中行正好被截掉。
 */
function hitWindow(text, selection, options = {}) {
  const value = String(text || '')
  const needle = normalizeForMatch(selection)
  const maxLines = options.maxLines ?? 14
  const maxChars = options.maxChars ?? 1200
  if (!value) return ''

  const lines = value.split(/\r?\n/)
  let hitLine = -1
  if (needle.length >= HIT_MIN_CHARS) {
    for (let index = 0; index < lines.length; index += 1) {
      if (normalizeForMatch(lines[index]).includes(needle)) {
        hitLine = index
        break
      }
    }
    // 选区跨行时，用前若干字符再试一次。
    if (hitLine < 0 && needle.length > 24) {
      const probe = needle.slice(0, Math.min(40, Math.floor(needle.length / 2)))
      for (let index = 0; index < lines.length; index += 1) {
        if (normalizeForMatch(lines[index]).includes(probe)) {
          hitLine = index
          break
        }
      }
    }
  }
  if (hitLine < 0) return ''

  const half = Math.floor(maxLines / 2)
  let from = Math.max(0, hitLine - half)
  let to = Math.min(lines.length - 1, hitLine + half)
  let picked = lines.slice(from, to + 1)

  // 超出字符预算就从两端往中间收，保证命中行留下。
  while (picked.join('\n').length > maxChars && (from < hitLine || to > hitLine)) {
    if (to - hitLine >= hitLine - from && to > hitLine) to -= 1
    else if (from < hitLine) from += 1
    else break
    picked = lines.slice(from, to + 1)
  }

  const joined = picked.join('\n')
  // 单行就超预算（被压平的工具输出）：退化为字符窗口。
  if (joined.length > maxChars) {
    const windowed = charWindowAround(value, selection, maxChars)
    if (windowed) return windowed
    return `${joined.slice(0, maxChars)}…`
  }

  const head = from > 0 ? `…（前面还有 ${from} 行）\n` : ''
  const tail = to < lines.length - 1 ? `\n…（后面还有 ${lines.length - 1 - to} 行）` : ''
  return `${head}${joined}${tail}`
}

/**
 * 组装"围绕命中位置的上下文"：命中消息本身 + 其它包含选区的工具结果。
 *
 * 与【会话精简轨迹】的区别：轨迹是按相关性挑选的**背景**，这里是选区所在的
 * **原文现场**，必须完整到能看懂上下文，所以按行取窗口而不是摘句。
 */
/**
 * 命中指纹：从命中位置往后取一段归一化文本。
 *
 * 用来识别"同一段原文被多处引用"（例如先 grep 出来、后来又被重新读了一遍），
 * 那种情况下两条消息的窗口前缀不同，但命中处的原文是一样的。
 */
function matchFingerprint(text, selection, size = 240) {
  const needle = normalizeForMatch(selection)
  const haystack = normalizeForMatch(text)
  if (!needle || !haystack) return ''
  const at = haystack.indexOf(needle)
  if (at < 0) return ''
  return haystack.slice(at, at + size)
}

function buildHitContext(messages, selection, options = {}) {
  const located = locateSelection(messages, selection, 0)
  const budget = options.totalChars ?? 2400

  // 同一段文字常被多处引用（例如我自己在回复里引用过它），
  // 工具结果/用户原话是"原文出处"，助手的转述只是二手，所以按这个顺序优先。
  const rank = (index) => {
    const role = messages[index] && messages[index].role
    if (role === 'tool') return 0
    if (role === 'user') return 1
    return 2
  }
  const ordered = located.hits.slice().sort((a, b) => rank(a) - rank(b) || a - b)

  const sections = []
  const seen = new Set()
  let used = 0
  for (const index of ordered) {
    if (sections.length >= (options.maxHits ?? 2)) break
    const message = messages[index]
    if (!message) continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const text = blocksText(blocks, ['text'])
    const remaining = budget - used
    if (remaining < 200) break
    const window = hitWindow(text, selection, {
      maxLines: options.maxLines ?? 14,
      maxChars: Math.min(options.maxCharsPerHit ?? 1400, remaining),
    })
    if (!window) continue
    // 同一段原文被多处引用时只留第一处（工具结果的排序已保证优先取原文出处）。
    const fingerprint = matchFingerprint(text, selection)
    if (fingerprint && seen.has(fingerprint)) continue
    if (fingerprint) seen.add(fingerprint)
    const role = message.role === 'user' ? '我' : (message.role === 'tool' ? '工具结果' : '助手')
    sections.push(`[m${index}] ${role}（包含选中文字）\n${window}`)
    used += window.length
  }
  return { text: sections.join('\n\n'), hits: located.hits, exact: located.exact }
}

/** 组一段「带上下文的提问」。
 *
 * 结构固定为三段，顺序对应阅读顺序：
 *   1. 背景上下文（精简轨迹）
 *   2. 围绕命中位置的上下文（选区所在的原文现场，按行取窗口）
 *   3. 选中的文字 + 我的问题
 */
function buildPrompt({ trace, hit, selection, question, cwd }) {
  const typed = (question && question.trim()) || ''
  const hasHit = Boolean(hit && hit.trim())
  const level = { trace: '一', hit: hasHit ? '二' : '' }
  const selectionLabel = hasHit ? '三' : '二'
  const questionLabel = hasHit ? '四' : '三'

  const parts = [
    '下面是我和一个 AI 编码助手刚才那段会话的「精简轨迹」，请把它当作背景上下文。',
  ]
  if (cwd) parts.push(`（会话的工作目录：${cwd}）`)

  parts.push(
    '',
    `【${level.trace}、会话精简轨迹（背景）】`,
    '（标注：`[mNN]` 是消息引用号；我＝用户原话，助手＝AI 回复，括号里是它这一轮调用的工具；工具结果只保留骨架）',
    trace || '（这次会话还没有可用的消息）',
  )

  if (hasHit) {
    parts.push(
      '',
      `【${level.hit}、围绕命中位置的上下文】`,
      '（选中的文字就是从下面这段原文里来的；这里取了它前后的内容，用来判断它到底指代什么）',
      hit,
    )
  }

  parts.push(
    '',
    `【${selectionLabel}、我在会话里选中的文字】`,
    '"""',
    selection,
    '"""',
  )

  // 用户没填问题时不再单独重复一句默认问句，交给下面的指令说清楚即可。
  if (typed) {
    parts.push('', `【${questionLabel}、我的问题】`, typed)
  }

  parts.push(
    '',
    typed
      ? '请结合上面的轨迹与命中位置上下文回答我的问题：先给一句结论，再列 2 到 4 条依据，' +
        '依据请带上消息引用号（例如「见 m23」）；优先以命中位置的原文为准，轨迹只作背景；' +
        '如果信息不足以判断，直接说明缺什么，不要编造。'
      : '请解释这段选中文字在当前上下文中的含义：它指代什么、为什么这样表述、' +
        '和上下文里的哪一步相关。先给一句结论，再列 2 到 4 条依据，' +
        '依据请带上消息引用号（例如「见 m23」）；' +
        '优先以命中位置的原文为准，轨迹只作背景；' +
        '如果信息不足以判断，直接说明缺什么，不要编造。',
    '',
    '（阅读轨迹时的取舍规则：带行号的文件路径、函数签名、错误原文、决策及其理由、精确数值与版本' +
      '比叙述性文字重要得多；冗长日志、重复读取、失败的尝试只看结论。据此判断哪些细节值得引用。）',
  )
  return parts.join('\n')
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

/** 从会话日志里取轨迹（把选区传进去，用于命中定位与相关性选段）。 */
function traceOfSession(sessions, sessionId, options, selection) {
  const session = sessions?.get(sessionId)
  if (!session) return undefined
  let messages = []
  try {
    messages = session.deriveMessages()
  } catch {
    messages = []
  }

  // 先定位选区出处：命中的消息及其邻居要无条件进轨迹（这是质量的支点）。
  const located = locateSelection(messages, selection, options.hitNeighbors ?? 1)
  const condensed = condenseMessages(messages, options, selection, located.window)
  const hit = buildHitContext(messages, selection, {
    maxHits: options.maxHits ?? 3,
    maxLines: options.hitWindowLines ?? 14,
    maxCharsPerHit: options.hitWindowChars ?? 1200,
  })

  let cwd = ''
  try {
    cwd = session.header?.cwd ?? ''
  } catch {
    cwd = ''
  }
  return {
    ...condensed,
    cwd,
    hit: hit.text,
    hitMessages: hit.hits,
    hitExact: hit.exact,
  }
}

/**
 * 组装一次提问：精简轨迹 + 选中文字 + 问题。
 *
 * 服务方只影响「兜底入口地址与预填」：真正的导航、登录检测、注入与发送由桌面端按同一个
 * provider id 完成。两条投递模式（都不压缩上下文，prompt 永远是完整版）：
 *   prefill   —— 仅当该站点支持 URL 预填（目前只有 DeepSeek 的 `?q=`）且 prompt 够短；
 *   clipboard —— 其余情况：给出该服务方入口地址 + 完整 prompt，由用户手动粘贴兜底。
 */
function prepareAsk(sessions, settings, input) {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
  const selection = typeof input.selection === 'string' ? input.selection.trim() : ''
  if (!selection) return { ok: false, error: '没有选中文字' }

  const resolved = resolveProvider(input.provider, settings)
  if (resolved.error) {
    return {
      ok: false,
      stage: 'provider',
      error: `未知的网页版服务方: ${resolved.error}`,
      providers: PROVIDER_IDS,
    }
  }
  const provider = resolved.provider

  const condensed = sessionId ? traceOfSession(sessions, sessionId, settings, selection) : undefined
  const prompt = buildPrompt({
    trace: condensed?.trace ?? '',
    hit: condensed?.hit ?? '',
    selection,
    question: input.question,
    cwd: condensed?.cwd,
  })

  // DeepSeek 保留 chatUrl 覆盖（镜像/自定义入口的老配置）；其余服务方用注册表地址。
  const chatUrl = provider.id === 'deepseek' ? (settings.chatUrl || provider.url) : provider.url
  const base = provider.prefillParam ? prefillBase(chatUrl) : chatUrl
  const encodedChars = encodedLength(prompt)
  const usePrefill = Boolean(provider.prefillParam) && base.length + encodedChars <= PREFILL_URL_SHORT_MAX
  return {
    ok: true,
    providerId: provider.id,
    providerName: provider.name,
    /** 'prefill' = 直接带 ?q= 打开；'clipboard' = 给出站点地址 + 复制完整提问 */
    mode: usePrefill ? 'prefill' : 'clipboard',
    prompt,
    url: usePrefill ? base + encodeURIComponent(prompt) : chatUrl,
    stats: {
      sessionId,
      provider: provider.id,
      providerName: provider.name,
      traceMessages: condensed?.messages ?? 0,
      traceChars: condensed?.chars ?? 0,
      traceMode: condensed?.mode ?? settings.traceMode,
      traceCounts: condensed?.counts ?? { user: 0, assistant: 0, tool: 0 },
      traceRelevant: condensed?.relevantEntries ?? 0,
      traceTotalEntries: condensed?.totalEntries ?? 0,
      /** 选区命中的消息下标（空数组表示没定位到，退化成了相关性近似） */
      hitMessages: condensed?.hitMessages ?? [],
      hitExact: condensed?.hitExact ?? false,
      hitChars: condensed?.hit ? condensed.hit.length : 0,
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
  // 配置里的 provider 写错时回退 DeepSeek：不因为一行手写配置让插件整体报错。
  const configuredProvider = typeof settings.provider === 'string' ? settings.provider.trim().toLowerCase() : ''
  if (!findProvider(configuredProvider)) {
    settings.provider = DEFAULTS.provider
    log(`配置的 provider 不合法（${String(config.provider)}），已回退 ${DEFAULTS.provider}`)
  } else {
    settings.provider = configuredProvider
  }
  const sessions = () => ctx.get('sessions')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_HEALTH,
    async handler(_req, res) {
      const app = await loadApp()
      let pipe = { ok: false, stage: 'module', detail: '托盘通信模块未就绪' }
      if (app) {
        try {
          pipe = await app.health({ appPath: settings.appPath, log: (line) => log(line) })
        } catch (error) {
          pipe = { ok: false, stage: 'error', detail: String(error?.message ?? error) }
        }
      }
      sendJson(res, 200, {
        // 保留旧字段名，README 里的自检命令仍然有效。
        ok: true,
        cdpReady: Boolean(pipe && pipe.ok),
        app: {
          connected: Boolean(pipe && pipe.ok),
          version: pipe?.version ?? null,
          app: pipe?.app ?? null,
          stage: pipe?.stage ?? null,
          detail: pipe?.detail ?? null,
          running: pipe?.running ?? null,
          profileDir: pipe?.profileDir ?? null,
          autoSend: pipe?.autoSend ?? null,
          // 桌面端当前生效/配置的服务方，以及它支持的 provider id 列表（旧桌面端为 null）。
          currentProvider: pipe?.currentProvider ?? null,
          currentProviderName: pipe?.currentProviderName ?? null,
          webProvider: pipe?.webProvider ?? null,
          providers: pipe?.providers ?? null,
          // 旧桌面端（< 2.1.0）会忽略 send 里的 provider 字段，气泡里只能提供 DeepSeek。
          providerSwitchable: versionAtLeast(pipe?.app, '2.1.0'),
        },
        // 插件自己的服务方注册表：Client 半据此渲染下拉框，不依赖桌面端版本。
        providers: PROVIDERS,
        provider: settings.provider,
        diag: diagLog,
        settings: { chatUrl: settings.chatUrl, appPath: settings.appPath, provider: settings.provider },
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
        sendJson(res, result.ok ? 200 : 400, result)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'bubble-ask: prompt route')

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
        const providerId = prepared.providerId || DEFAULTS.provider
        log(`注入网页版（${prepared.providerName}）：${fullPrompt.length} 字（轨迹 ${prepared.stats.traceMessages} 条）`)
        const app = await loadApp()
        if (!app || typeof app.sendPrompt !== 'function') {
          // 用 200 + ok:false：Client 端对非 2xx 是抛错的，那样就看不到这里的 prompt，
          // 气泡里的「复制全文」逃生口就废了。状态交给 body 表达，别用 HTTP 码。
          return sendJson(res, 200, {
            ok: false,
            stage: 'module',
            error: '托盘通信模块未就绪',
            detail: '可改用气泡里的「复制提问」或「复制全文」手动粘贴',
            prompt: fullPrompt,
            url: prepared.url,
            stats: prepared.stats,
          })
        }
        // 旧版桌面端会忽略 send 里的 provider 字段、静默发到 DeepSeek：切了服务方时
        // 必须先确认版本再发，而不是把内容发错站点。
        if (providerId !== 'deepseek') {
          const support = await checkProviderSupport(app, settings, log)
          if (!support.ok) {
            return sendJson(res, 200, {
              ok: false,
              stage: support.error || 'provider-check',
              error: support.error === 'old-app' ? '桌面端版本过旧，暂不支持切换服务方' : '无法确认桌面端是否支持切换服务方',
              detail: support.detail || '请把 Bubble Ask 桌面端升级到 2.1.0 或更高版本，或改用「复制提问」',
              provider: providerId,
              providerName: prepared.providerName,
              prompt: fullPrompt,
              url: prepared.url,
              stats: prepared.stats,
            })
          }
        }
        const sent = await app.sendPrompt({
          prompt: fullPrompt,
          // 总是显式带 provider：桌面端配置过其它默认服务方时，用户在这里明确选 DeepSeek
          // 不能因为「省略就跟随配置」而发到别家。旧桌面端（< 2.1.0）会忽略这个增量字段，
          // 仍按本机配置的入口发送（与升级前行为一致）；插件对旧桌面端只提供 DeepSeek。
          provider: providerId,
          appPath: settings.appPath,
          log: (line) => log(line),
        })
        const body = {
          ...sent,
          provider: sent.provider || providerId,
          providerName: prepared.providerName,
          prompt: fullPrompt,
          stats: prepared.stats,
          prefillUrl: prepared.url,
        }
        // 发送成功时网页版会停在会话页；插件这边没有直达地址，留预填地址做参考。
        if (!body.url) body.url = prepared.url
        sendJson(res, 200, body)
      } catch (error) {
        sendJson(res, 500, { ok: false, stage: 'error', detail: String(error?.message ?? error) })
      }
    },
  }), 'bubble-ask: send route')

  /**
   * 插件存活期间向后台服务登记一条租约。
   *
   * 服务靠「还有没有租约」决定是否退出：DSH 运行期间插件一直挂着这条连接，
   * DSH 退出时 Host 进程消失、连接自动断开，服务进入宽限期后退出。
   * 启动失败只记一条日志，首次发送时会再尝试拉起。
   */
  ctx.effect(() => {
    let lease = null
    let disposed = false
    void (async () => {
      try {
        const app = await loadApp()
        if (!app || typeof app.attachLease !== 'function') return
        const attached = await app.attachLease({ appPath: settings.appPath, log: (line) => log(line) })
        if (disposed) {
          attached.close()
          return
        }
        if (!attached.ok) {
          log(`未能向服务登记租约：${attached.detail || '未知原因'}`)
          return
        }
        lease = attached
        log('已登记服务租约')
      } catch (error) {
        log(`登记服务租约失败：${String(error?.message ?? error)}`)
      }
    })()
    return () => {
      disposed = true
      // 断开租约就是全部清理动作：服务看到没有租约了自然会退出。
      if (lease && typeof lease.close === 'function') lease.close()
      lease = null
    }
  }, 'bubble-ask: service lease')

  log(`已就绪（provider=${settings.provider}，chatUrl=${settings.chatUrl}）`)
}

/**
 * 供离线分析与对照工具使用的内部导出。
 *
 * DSH 只认 apply / inject / name，多导出这些不改变插件行为，
 * 但能让 `npm test` 之外的脚本用**真实实现**跑对照，而不是另写一份近似版本。
 */
export {
  DEFAULTS,
  PROVIDERS,
  buildPrompt,
  collectTraceEntries,
  condenseMessages,
  salientExcerpt,
  describeToolResult,
  prepareAsk,
  resolveProvider,
  versionAtLeast,
}
