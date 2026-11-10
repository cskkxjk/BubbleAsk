#!/usr/bin/env node
/**
 * 由唯一真源 shared/providers.json 生成各端的数据文件。
 *
 *   node tools/gen-providers.mjs           写入生成物
 *   node tools/gen-providers.mjs --check   只校验生成物是否与真源一致（CI / 自测用）
 *
 * 为什么用「生成」而不是运行时读取：
 *   - 扩展的 content_scripts 不支持 ESM，manifest 也要求静态匹配模式，运行时 fetch 会把
 *     manifest 搞复杂；生成物是普通 ESM 文件，pack 之后零运行时开销。
 *   - 插件用 npm 语义打包，多一个 JSON 依赖不如直接生成同构模块。
 *   - 桌面端（C#）走另一条路：JSON 作为内嵌资源，运行时用 System.Web.Extensions 解析，
 *     因此**不需要**生成 C# 文件，单 exe 不变。
 *
 * overrides 语义：真源里每家可以带 `overrides.<host>`，**只覆盖列出的字段**。
 * 目前只有 extension 用到（DeepSeek 的 enterSends），桌面端读基础定义（相当于 host=desktop）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sourcePath = join(root, 'shared', 'providers.json')

/** 生成物：路径 → 内容 */
const targets = []

const BANNER = (host) => `/**
 * 自动生成，请勿手改。
 *
 * 真源：shared/providers.json
 * 生成：node tools/gen-providers.mjs（校验：node tools/gen-providers.mjs --check）
 * 宿主：${host}
 */`

/** 深拷贝（真源只含 JSON 可表达的类型）。 */
const clone = (value) => JSON.parse(JSON.stringify(value))

/** 把 overrides[host] 覆盖到基础定义上；返回新对象，不改原数据。 */
function applyOverrides(provider, host) {
  const { overrides, notes, ...base } = clone(provider)
  if (!overrides || !overrides[host]) return base
  return { ...base, ...clone(overrides[host]) }
}

/** 校验真源；返回错误信息数组（空数组 = 通过）。 */
export function validate(data) {
  const errors = []
  const required = [
    'id',
    'name',
    'url',
    'origins',
    'composerSelectors',
    'sendSelectors',
    'sendClassHints',
    'sendAriaLabels',
    'loginMarkers',
    'verifyUrlRegex',
  ]
  const stringArrays = [
    'origins',
    'composerSelectors',
    'sendSelectors',
    'sendClassHints',
    'sendSvgPaths',
    'sendAriaLabels',
    'loginMarkers',
  ]

  if (!data || typeof data !== 'object') return ['真源不是对象']
  if (data.schemaVersion !== 1) errors.push(`schemaVersion 应为 1，实际 ${data.schemaVersion}`)
  if (!Array.isArray(data.providers) || data.providers.length === 0) errors.push('providers 必须是非空数组')
  if (!data.generic || !Array.isArray(data.generic.composerSelectors)) errors.push('generic.composerSelectors 必须是数组')
  if (!data.generic || !Array.isArray(data.generic.sendAriaLabels)) errors.push('generic.sendAriaLabels 必须是数组')

  const seen = new Set()
  for (const provider of data.providers || []) {
    const label = provider && provider.id ? provider.id : JSON.stringify(provider).slice(0, 40)
    for (const field of required) {
      if (provider[field] === undefined) errors.push(`${label}: 缺字段 ${field}`)
    }
    if (typeof provider.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(provider.id)) {
      errors.push(`${label}: id 必须是小写字母开头的 slug`)
    }
    if (seen.has(provider.id)) errors.push(`${label}: id 重复`)
    seen.add(provider.id)
    for (const field of stringArrays) {
      const value = provider[field]
      if (value === undefined) continue
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        errors.push(`${label}: ${field} 必须是字符串数组`)
      }
    }
    for (const field of ['enterSends', 'upload']) {
      if (provider[field] !== undefined && typeof provider[field] !== 'boolean') {
        errors.push(`${label}: ${field} 必须是布尔值`)
      }
    }
    if (provider.overrides) {
      for (const host of Object.keys(provider.overrides)) {
        if (!['desktop', 'extension', 'plugin'].includes(host)) {
          errors.push(`${label}: 未知 overrides 宿主 ${host}`)
        }
        const patch = provider.overrides[host]
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          errors.push(`${label}: overrides.${host} 必须是对象`)
          continue
        }
        for (const field of Object.keys(patch)) {
          if (!required.includes(field) && !['sendSvgPaths', 'enterSends', 'prefillParam', 'upload'].includes(field)) {
            errors.push(`${label}: overrides.${host}.${field} 不是已知字段`)
          }
        }
      }
    }
  }

  if (data.defaultId && !seen.has(data.defaultId)) errors.push(`defaultId ${data.defaultId} 不在 providers 里`)
  return errors
}

/** 生成扩展用的数据模块（已应用 extension overrides）。 */
function buildExtensionModule(data) {
  const providers = data.providers.map((provider) => applyOverrides(provider, 'extension'))
  return `${BANNER('Chrome 扩展')}

export const DEFAULT_PROVIDER_ID = ${JSON.stringify(data.defaultId)}

export const GENERIC_COMPOSER_SELECTORS = ${JSON.stringify(data.generic.composerSelectors, null, 2)}

export const GENERIC_SEND_ARIA_LABELS = ${JSON.stringify(data.generic.sendAriaLabels, null, 2)}

export const PROVIDERS = ${JSON.stringify(providers, null, 2)}
`
}

/** 生成插件用的数据模块（只含下拉展示与兜底地址需要的字段）。 */
function buildPluginModule(data) {
  const providers = data.providers.map((provider) => {
    const merged = applyOverrides(provider, 'plugin')
    const item = { id: merged.id, name: merged.name, url: merged.url }
    if (merged.prefillParam) item.prefillParam = merged.prefillParam
    return item
  })
  return `${BANNER('DSH 插件')}

export const PROVIDERS = ${JSON.stringify(providers, null, 2)}
`
}

function main() {
  const checkOnly = process.argv.includes('--check')

  if (!existsSync(sourcePath)) {
    console.error(`找不到真源：${sourcePath}`)
    process.exit(2)
  }

  let raw
  try {
    raw = JSON.parse(readFileSync(sourcePath, 'utf8'))
  } catch (error) {
    console.error(`真源不是合法 JSON：${error.message}`)
    process.exit(2)
  }

  const errors = validate(raw)
  if (errors.length) {
    console.error('真源校验失败：')
    for (const error of errors) console.error(`  - ${error}`)
    process.exit(1)
  }

  targets.push({
    path: join(root, 'chrome-extension', 'lib', 'providers.data.js'),
    content: buildExtensionModule(raw),
  })
  targets.push({
    path: join(root, 'dsh-plugin', 'lib', 'providers.data.js'),
    content: buildPluginModule(raw),
  })

  let drifted = 0
  for (const target of targets) {
    const relative = target.path.slice(root.length + 1)
    const current = existsSync(target.path) ? readFileSync(target.path, 'utf8') : null
    if (current === target.content) {
      if (!checkOnly) console.log(`  = ${relative}`)
      continue
    }
    if (checkOnly) {
      console.error(`  ! ${relative} 与真源不一致，请运行 node tools/gen-providers.mjs`)
      drifted += 1
    } else {
      writeFileSync(target.path, target.content, 'utf8')
      console.log(`  ${current === null ? '+' : '~'} ${relative}`)
    }
  }

  if (checkOnly) {
    if (drifted) {
      console.error(`生成物有 ${drifted} 处漂移`)
      process.exit(1)
    }
    console.log(`PASS 生成物与真源一致（${raw.providers.length} 家服务方）`)
  }
}

if (process.argv[1] && process.argv[1].endsWith('gen-providers.mjs')) {
  main()
}

export { applyOverrides, buildExtensionModule, buildPluginModule }
