/**
 * 网页版服务方注册表（多服务方支持，1.2.0 起）。
 *
 * 唯一一份扩展内的服务方定义：background 与 popup 直接 import；
 * **内容脚本不 import**（MV3 内容脚本不支持 ESM），由 background 在消息里把
 * 整条 provider 定义（普通可结构化克隆对象）传给 chat-bridge.js。
 *
 * 字段与桌面端 `src/shared/WebProviders.cs` 对齐（见 docs/web-providers.md §2.1）：
 *   id / name / url / origins / composerSelectors / sendSelectors / sendClassHints /
 *   sendAriaLabels / enterSends / loginMarkers / verifyUrlRegex / prefillParam / upload
 *
 * 与桌面端的刻意差异（扩展形态自身限制，见 README「已知限制」）：
 *   - loginMarkers：桌面端是「登录态标记 CSS 选择器」（仅 --probe 诊断用）；扩展用它
 *     判断当前页是否登录页（URL 特征），命中即返回 stage=login；
 *   - upload：扩展没有截图提问，统一 false；
 *   - enterSends：DeepSeek 保持 1.1.x 的「只点按钮、不回车」行为，桌面端则把回车
 *     作为点不到按钮时的兜底；
 *   - 桌面端的 SendSvgPaths 与 custom（自定义服务方）本扩展不需要。
 */

export const DEFAULT_PROVIDER_ID = 'deepseek'

/** 默认服务方的存储键（chrome.storage.local）。 */
export const PROVIDER_STORAGE_KEY = 'bubble-ask.provider'

/** 通用输入框兜底：provider 自己的选择器都落空时依次尝试（与内容脚本保持一致）。 */
export const GENERIC_COMPOSER_SELECTORS = [
  'textarea',
  'textarea[placeholder]',
  'div[contenteditable="true"]',
  'p[contenteditable="true"]',
  '[contenteditable="true"]',
  '[role="textbox"]',
]

/** 通用发送按钮文案兜底（aria-label / title / 可见文字，忽略大小写）。 */
export const GENERIC_SEND_ARIA_LABELS = ['发送', 'send', 'submit', '提交']

/**
 * 6 家服务方。新增服务方：在此加一条 + 同步 manifest.json 的
 * host_permissions / content_scripts.matches / exclude_matches，
 * 再跑 `node chrome-extension/tools/check-providers.mjs` 与实机验证。
 */
export const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    origins: ['chat.deepseek.com', 'deepseek.com'],
    composerSelectors: [
      'textarea[name="search"]',
      'textarea',
      'div[contenteditable="true"]',
      'p[contenteditable="true"]',
      '[contenteditable="true"]',
      '[role="textbox"]',
      '[data-testid="chat-input"] textarea',
      '[data-testid="chat-input"] [contenteditable="true"]',
      'textarea[data-testid]',
      '[data-testid*="input"] textarea',
      '[data-testid*="input"] [contenteditable="true"]',
      '[data-testid="chat-input"]',
    ],
    sendSelectors: [],
    // DeepSeek 的发送键靠 class 组合识别（primary + circle），保持 1.1.x 的判定
    sendClassHints: ['ds-button--primary', 'ds-button--circle'],
    sendAriaLabels: [],
    enterSends: false,
    loginMarkers: ['sign_in', 'signin', '/login'],
    verifyUrlRegex: '^https?://chat\\.deepseek\\.com/',
    prefillParam: 'q',
    upload: false,
  },
  {
    id: 'qwen',
    name: '千问 Qwen',
    url: 'https://www.qianwen.com/',
    origins: ['qianwen.com', 'qianwen.aliyun.com', 'chat.qwen.ai', 'tongyi.aliyun.com', 'tongyi.com'],
    // 显式列出通用选择器（虽然内容脚本也有兜底，但显式更好排查/按页面校准）
    composerSelectors: [
      'textarea[placeholder]',
      'textarea',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ],
    sendSelectors: [],
    sendClassHints: [],
    sendAriaLabels: ['发送', 'Send', 'Submit'],
    enterSends: true,
    loginMarkers: ['login', 'signin', 'passport', 'account'],
    verifyUrlRegex:
      '^https?://((www\\.)?qianwen\\.com|qianwen\\.aliyun\\.com|chat\\.qwen\\.ai|tongyi\\.aliyun\\.com|(www\\.)?tongyi\\.com)/',
    prefillParam: '',
    upload: false,
  },
  {
    id: 'doubao',
    name: '豆包 Doubao',
    url: 'https://www.doubao.com/chat/',
    origins: ['doubao.com'],
    composerSelectors: [
      '[data-testid="chat_input_input"]',
      'textarea[placeholder]',
      'textarea',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ],
    sendSelectors: [],
    sendClassHints: [],
    sendAriaLabels: ['发送', 'Send', 'Submit'],
    enterSends: true,
    loginMarkers: ['login', 'signin', 'passport'],
    verifyUrlRegex: '^https?://(www\\.)?doubao\\.com/',
    prefillParam: '',
    upload: false,
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    origins: ['chatgpt.com', 'chat.openai.com'],
    composerSelectors: ['#prompt-textarea', 'textarea#prompt-textarea', 'div#prompt-textarea[contenteditable="true"]'],
    sendSelectors: ['button[data-testid="send-button"]', 'button#composer-submit-button'],
    sendClassHints: [],
    sendAriaLabels: ['Send prompt', 'Send message', '发送'],
    enterSends: true,
    loginMarkers: ['/auth/', 'login', 'signin'],
    verifyUrlRegex: '^https?://(chatgpt\\.com|chat\\.openai\\.com)/',
    prefillParam: '',
    upload: false,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com/app',
    origins: ['gemini.google.com'],
    composerSelectors: ['rich-textarea .ql-editor', '.ql-editor[contenteditable="true"]', 'rich-textarea [contenteditable="true"]'],
    sendSelectors: ['button[aria-label*="Send"]', 'button.send-button', '[class*="send-button"]'],
    sendClassHints: [],
    sendAriaLabels: ['Send message', 'Send', '发送'],
    enterSends: true,
    loginMarkers: ['accounts.google.com', 'servicelogin', '/login'],
    verifyUrlRegex: '^https?://gemini\\.google\\.com/',
    prefillParam: '',
    upload: false,
  },
  {
    id: 'grok',
    name: 'Grok',
    url: 'https://grok.com/',
    origins: ['grok.com', 'x.com'],
    composerSelectors: ['textarea[aria-label]', 'textarea'],
    sendSelectors: ['button[aria-label="Submit"]', 'button[type="submit"]', '[aria-label="Submit"]'],
    sendClassHints: [],
    sendAriaLabels: ['Submit', '发送'],
    enterSends: true,
    loginMarkers: ['login', 'signin', '/i/flow'],
    verifyUrlRegex: '^https?://(grok\\.com|x\\.com)/',
    prefillParam: '',
    upload: false,
  },
]

/** 按 id 取服务方；未知/非字符串返回 undefined。 */
export function getProvider(id) {
  if (typeof id !== 'string' || !id) return undefined
  return PROVIDERS.find((provider) => provider.id === id)
}

/** 按 id 取服务方，未知时回落到默认服务方（永不返回空）。 */
export function resolveProvider(id) {
  return getProvider(id) || getProvider(DEFAULT_PROVIDER_ID)
}

/**
 * URL 是否属于该服务方（用于识别扩展自己窗口里的标签页）。
 * origins 可以写完整主机名（chat.deepseek.com）或可注册域名（deepseek.com）。
 */
export function isProviderUrl(providerOrId, url) {
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
export const PROVIDER_MATCH_PATTERNS = [
  ...new Set(
    PROVIDERS.flatMap((provider) => (provider.origins || []).map(originToMatchPattern)).filter(Boolean),
  ),
]
