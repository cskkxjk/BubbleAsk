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

import {
  DEFAULT_PROVIDER_ID,
  GENERIC_COMPOSER_SELECTORS,
  GENERIC_SEND_ARIA_LABELS,
  PROVIDERS,
} from './providers.data.js'

export {
  DEFAULT_PROVIDER_ID,
  GENERIC_COMPOSER_SELECTORS,
  GENERIC_SEND_ARIA_LABELS,
  PROVIDERS,
}

/** 默认服务方的存储键（chrome.storage.local）。 */
export const PROVIDER_STORAGE_KEY = 'bubble-ask.provider'

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
