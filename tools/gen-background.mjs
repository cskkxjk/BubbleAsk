/**
 * 把 background 及其依赖打成一个 **classic** service worker。
 *
 * 为什么需要这个生成步骤：manifest 里的 `"type": "module"` 依赖较新的内核支持
 * （MV3 的模块 service worker 在早期 88 上并不可靠），而这些插件要能跑在
 * Windows 7 那批停留在 Chromium 88 的机器上。打成单文件后 service worker 不依赖
 * 任何模块能力，源码仍然保持分文件。
 *
 *   node tools/gen-background.mjs           # 生成 chrome-extension/background.bundle.js
 *   node tools/gen-background.mjs --check   # 只校验生成物是否与源一致
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const extensionDir = join(root, 'chrome-extension')
const outPath = join(extensionDir, 'background.bundle.js')

/** 按依赖顺序拼：数据 → 使用数据的纯函数 → 提示词 → 后台本体。 */
const SOURCES = [
  'lib/providers.data.js',
  'lib/providers.js',
  'lib/prompt.js',
  'background.js',
]

/** 与其它生成物保持一致：Windows 上 core.autocrlf 会让源文件变成 CRLF。 */
export const normalizeEol = (text) => String(text).replace(/\r\n/g, '\n')

/**
 * 去掉 import / export 语法，得到一个可直接当 classic 脚本跑的片段。
 * @param {string} source 源码
 * @param {string} file 文件名（报错用）
 */
function stripModuleSyntax(source, file) {
  const lines = normalizeEol(source).split('\n')
  const out = []
  let inImport = false
  let inExportBlock = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (inImport) {
      if (/from\s+['"][^'"]+['"]/.test(trimmed)) inImport = false
      continue
    }
    if (inExportBlock) {
      if (trimmed.startsWith('}')) inExportBlock = false
      continue
    }
    // 多行 import：import { ... } from '...'
    if (/^import\s/.test(trimmed)) {
      if (!/from\s+['"][^'"]+['"]/.test(trimmed)) inImport = true
      continue
    }
    // import 'side-effect.js'
    if (/^import\s+['"]/.test(trimmed)) continue
    // export { ... } 块：内容已经在上面的声明里，整块删掉
    if (/^export\s*\{/.test(trimmed)) {
      if (!trimmed.includes('}')) inExportBlock = true
      continue
    }
    if (/^export\s+default\b/.test(trimmed)) {
      throw new Error(`${file}: 不支持 export default（后台包里没有默认导出）`)
    }
    out.push(line.replace(/^(\s*)export\s+/, '$1'))
  }

  return out.join('\n')
}

/** 拼出完整的 background.bundle.js 内容。 */
export function buildBundle() {
  const parts = []
  parts.push('/* eslint-disable */')
  parts.push('/**')
  parts.push(' * 由 tools/gen-background.mjs 生成，**不要手改**。')
  parts.push(' * 源：lib/providers.data.js + lib/providers.js + lib/prompt.js + background.js')
  parts.push(' * 生成成单文件是为了让 service worker 跑在 classic 模式，兼容 Chromium 88 这样的老内核。')
  parts.push(' */')
  parts.push(';(() => {')
  parts.push("'use strict'")

  const declared = new Map()
  for (const file of SOURCES) {
    const source = readFileSync(join(extensionDir, file), 'utf8')
    const body = stripModuleSyntax(source, file)
    // 顶层重名会在拼接后变成「重复声明」，编译期就该失败而不是运行时踩雷
    const names = body.match(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm) || []
    for (const line of names) {
      const name = line.replace(/^(?:const|let|var|function|class)\s+/, '')
      if (declared.has(name)) {
        throw new Error(`顶层重复声明 ${name}：${declared.get(name)} 与 ${file}`)
      }
      declared.set(name, file)
    }
    parts.push('')
    parts.push(`// ---------- ${file} ----------`)
    parts.push(body.trim())
  }

  parts.push('})()')
  parts.push('')
  return parts.join('\n')
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])
if (isMain) {
  const bundle = buildBundle()
  if (process.argv.includes('--check')) {
    let current = ''
    try {
      current = readFileSync(outPath, 'utf8')
    } catch {
      console.error('FAIL 缺少生成物 chrome-extension/background.bundle.js')
      process.exit(1)
    }
    if (normalizeEol(current) !== normalizeEol(bundle)) {
      console.error('FAIL background.bundle.js 与源不一致，请跑 node tools/gen-background.mjs')
      process.exit(1)
    }
    console.log('PASS background.bundle.js 与源一致')
  } else {
    writeFileSync(outPath, bundle, 'utf8')
    console.log(`WROTE ${outPath}（${bundle.length} 字符）`)
  }
}
