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
/** 客户端半的兜底名单：它拿不到生成物，只能手写在源码里，由这里对齐。 */
const clientSourcePath = join(root, 'dsh-plugin', 'client.js')
const CLIENT_FALLBACK_BLOCK = /^([ \t]*)const PROVIDERS = \[\r?\n([\s\S]*?)^\1\]/m

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

/**
 * 统一换行后再比较。
 *
 * 为什么需要：`core.autocrlf=true` 的 Windows 检出让磁盘上是 CRLF，而这里生成的是 LF。
 * 只比内容时若逐字节比，干净检出会永远报「漂移」，校验就废了。
 */
export const normalizeEol = (text) => String(text).replace(/\r\n/g, '\n')

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

/**
 * 生成插件用的数据模块。
 *
 * 与扩展不同，插件的「发送」默认交给桌面端托盘应用，所以过去只下发 id/名称/入口地址。
 * 但内嵌 webview 这条路径下**执行者在插件自己这边**，需要完整的选择器配置才能驱动页面，
 * 因此这里下发合并后的全量定义。多出来的字段对桌面端路径无副作用（那边只读 id）。
 */
function buildPluginModule(data) {
  const providers = data.providers.map((provider) => applyOverrides(provider, 'plugin'))
  return `${BANNER('DSH 插件')}

export const DEFAULT_PROVIDER_ID = ${JSON.stringify(data.defaultId)}

export const GENERIC_COMPOSER_SELECTORS = ${JSON.stringify(data.generic.composerSelectors, null, 2)}

export const GENERIC_SEND_ARIA_LABELS = ${JSON.stringify(data.generic.sendAriaLabels, null, 2)}

export const PROVIDERS = ${JSON.stringify(providers, null, 2)}
`
}

/**
 * 把插件 Client 半的兜底名单与真源对齐。
 *
 * 为什么要单独处理：Client 半是被 `window.__ModuleLoader__.load({ factory(require) })` 装载的
 * 浏览器侧模块，`require` 只提供宿主注入的包，读不到 `lib/providers.data.js`。这份名单只用于
 * 首帧渲染与 `/health` 返回前的下拉、以及校验存储里的服务方 id，但漏改会让「新增服务方后
 * 记忆被当成非法值清掉」这类问题静默发生，所以由生成器统一改写、由 --check 拦住漂移。
 *
 * 返回 'same' / 'rewritten' / 'drift' / 'absent'（源码里没有这段就视为不使用兜底）。
 */
function syncClientFallback(data, checkOnly) {
  if (!existsSync(clientSourcePath)) return 'absent'
  const source = readFileSync(clientSourcePath, 'utf8')
  const match = CLIENT_FALLBACK_BLOCK.exec(source)
  if (!match) return 'absent'

  const indent = `${match[1]}  `
  const body = data.providers
    .map((provider) => `${indent}{ id: ${quoteJs(provider.id)}, name: ${quoteJs(provider.name)} },`)
    .join('\n')
  const expected = `${match[1]}const PROVIDERS = [\n${body}\n${match[1]}]`
  const actual = match[0]

  if (normalizeEol(actual) === normalizeEol(expected)) return 'same'
  if (checkOnly) return 'drift'

  writeFileSync(clientSourcePath, source.replace(actual, expected), 'utf8')
  return 'rewritten'
}

/** 单引号 JS 字符串字面量（与 client.js 里现有的写法一致）。 */
function quoteJs(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
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

  // 页面驱动也是共享真源：桌面端走 CDP 内嵌注入，扩展需要它在自己包内当 content script。
  const driverPath = join(root, 'shared', 'driver.js')
  if (!existsSync(driverPath)) {
    console.error(`找不到页面驱动真源：${driverPath}`)
    process.exit(2)
  }
  // 统一成 LF 再嵌：驱动本体是一段 JS，换行风格对执行无影响，但若不归一，
  // 生成物里的转义字节会随检出平台的 autocrlf 变化 —— 产物就不确定了。
  const driverSource = normalizeEol(readFileSync(driverPath, 'utf8'))
  targets.push({
    path: join(root, 'chrome-extension', 'content', 'driver.js'),
    content: `${BANNER('Chrome 扩展')}\n\n${driverSource}`,
  })

  // 插件的内嵌 webview 路径下，驱动要由 Client 半注入 guest 页面（executeJavaScript），
  // 所以把原文包成一个 ESM 字符串常量带进插件；Host 通过路由交给 Client，仍只有一份实现。
  targets.push({
    path: join(root, 'dsh-plugin', 'lib', 'driver.source.mjs'),
    content: `${BANNER('DSH 插件')}

/** 页面驱动源码：真源 shared/driver.js 的原文（换行已统一为 LF），供 Host 分发给 Client 注入 guest。 */
export const DRIVER_SOURCE = ${JSON.stringify(driverSource)}
`,
  })

  let drifted = 0
  for (const target of targets) {
    const relative = target.path.slice(root.length + 1)
    const current = existsSync(target.path) ? readFileSync(target.path, 'utf8') : null
    // 比换行不敏感：Windows 上 core.autocrlf=true 会把检出的文件转成 CRLF，
    // 而这里生成的是 LF。逐字节比会把「内容一致、只是换行风格不同」误报成漂移，
    // 让校验在干净检出上直接失效。
    if (current !== null && normalizeEol(current) === normalizeEol(target.content)) {
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

  // 客户端半的兜底名单：与生成物同一份真源，单独对齐（它不是生成物，是手写源码里的一段）。
  const clientState = syncClientFallback(raw, checkOnly)
  if (checkOnly) {
    if (clientState === 'drift') {
      console.error('  ! dsh-plugin/client.js 的 PROVIDERS 兜底名单与真源不一致，请运行 node tools/gen-providers.mjs')
      drifted += 1
    }
  } else if (clientState === 'rewritten') {
    console.log('  ~ dsh-plugin/client.js（PROVIDERS 兜底名单）')
  } else if (clientState === 'same') {
    console.log('  = dsh-plugin/client.js（PROVIDERS 兜底名单）')
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
