/**
 * 服务方注册表静态校验（构建/改代码后手动跑，不参与扩展运行）。
 *
 *   node chrome-extension/tools/check-providers.mjs
 *
 * 校验内容：
 * 1. manifest.json 能被 JSON 解析；
 * 2. 6 家服务方齐全、ID 唯一、必填字段完整、origins 非空；
 * 3. manifest 的 host_permissions / chat-bridge matches / 排除列表覆盖所有 provider 域名；
 * 4. 扩展加载所需文件都存在，且不再引用旧的 deepseek-bridge.js。
 *
 * lib/providers.js 是 ESM，而仓库没有 package.json（扩展根目录不能加，避免影响加载），
 * 所以这里把源码读出来用 data: URL 动态 import，不依赖 Node 的模块类型探测。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const extRoot = path.resolve(here, '..')

const EXPECTED_IDS = ['deepseek', 'qwen', 'doubao', 'chatgpt', 'gemini', 'grok']
const REQUIRED_FIELDS = [
  'id',
  'name',
  'url',
  'origins',
  'composerSelectors',
  'sendSelectors',
  'sendAriaLabels',
  'enterSends',
  'loginMarkers',
  'verifyUrlRegex',
]

async function loadProvidersModule() {
  // providers.js 现在 import './providers.data.js'，data: URL 里没法解析相对路径，
  // 所以把数据文件也转成 data: URL 并把 import 改写过去。
  const dataSource = readFileSync(path.join(extRoot, 'lib', 'providers.data.js'), 'utf8')
  const dataUrl = `data:text/javascript;base64,${Buffer.from(dataSource, 'utf8').toString('base64')}`
  const source = readFileSync(path.join(extRoot, 'lib', 'providers.js'), 'utf8')
  const rewritten = source.replace("'./providers.data.js'", `'${dataUrl}'`)
  const url = `data:text/javascript;base64,${Buffer.from(rewritten, 'utf8').toString('base64')}`
  return import(url)
}

/** manifest 匹配模式是否覆盖某个主机名（支持 `*.example.com` 通配）。 */
function patternCoversHost(pattern, hostname) {
  const match = /^https:\/\/(\*\.)?([^/]+)\/\*$/.exec(String(pattern || ''))
  if (!match) return false
  const base = match[2].toLowerCase()
  const wildcard = Boolean(match[1])
  if (!wildcard) return hostname === base
  return hostname === base || hostname.endsWith(`.${base}`)
}

function hostOf(url) {
  return new URL(url).hostname.toLowerCase()
}

const results = []
const record = (label, detail) => results.push(`${label}${detail ? `：${detail}` : ''}`)

const manifestPath = path.join(extRoot, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
record('manifest.json 可解析', `version=${manifest.version}`)
assert.equal(manifest.manifest_version, 3, 'manifest_version 必须是 3')
assert.match(manifest.version, /^\d+\.\d+\.\d+$/, `manifest 版本应是 x.y.z，实际 ${manifest.version}`)
assert.ok(!/deepseek-bridge\.js/.test(readFileSync(manifestPath, 'utf8')), 'manifest 不应再引用 deepseek-bridge.js')

// 三件产物统一版本号：扩展 manifest / 插件 package.json / 桌面端 IpcContract.AppVersion 必须一致。
// 以前三个号各自演进，用户要记三套；统一后由这条断言守住，忘了同步会直接失败。
const repoRootForVersion = path.resolve(extRoot, '..')
const pluginPkg = JSON.parse(readFileSync(path.join(repoRootForVersion, 'dsh-plugin', 'package.json'), 'utf8'))
const ipcSource = readFileSync(path.join(repoRootForVersion, 'src', 'shared', 'IpcContract.cs'), 'utf8')
const appVersionMatch = /AppVersion\s*=\s*"([^"]+)"/.exec(ipcSource)
assert.ok(appVersionMatch, '没找到 IpcContract.AppVersion')
const appVersion = appVersionMatch[1]
assert.equal(manifest.version, pluginPkg.version, `版本不一致：扩展 ${manifest.version} vs 插件 ${pluginPkg.version}`)
assert.equal(manifest.version, appVersion, `版本不一致：扩展 ${manifest.version} vs 桌面端 ${appVersion}`)
record('三端版本一致', `统一为 ${manifest.version}`)

// 0) 生成物必须与唯一真源一致（漂移检查）
const repoRoot = path.resolve(extRoot, '..')
const canonicalPath = path.join(repoRoot, 'shared', 'providers.json')
assert.ok(existsSync(canonicalPath), `缺唯一真源 ${canonicalPath}`)
const canonical = JSON.parse(readFileSync(canonicalPath, 'utf8'))
const { validate, buildExtensionModule, buildPluginModule, normalizeEol } = await import(
  `file:///${path.join(repoRoot, 'tools', 'gen-providers.mjs').replace(/\\/g, '/')}`
)
const sourceProblems = validate(canonical)
assert.equal(sourceProblems.length, 0, `真源校验失败：${sourceProblems.join('；')}`)
const generatedExtension = buildExtensionModule(canonical)
const generatedPlugin = buildPluginModule(canonical)
// 换行不敏感：Windows 检出让磁盘上是 CRLF，生成的是 LF，逐字节比会误报漂移。
assert.equal(
  normalizeEol(readFileSync(path.join(extRoot, 'lib', 'providers.data.js'), 'utf8')),
  normalizeEol(generatedExtension),
  'chrome-extension/lib/providers.data.js 与真源不一致，请运行 node tools/gen-providers.mjs',
)
assert.equal(
  normalizeEol(readFileSync(path.join(repoRoot, 'dsh-plugin', 'lib', 'providers.data.js'), 'utf8')),
  normalizeEol(generatedPlugin),
  'dsh-plugin/lib/providers.data.js 与真源不一致，请运行 node tools/gen-providers.mjs',
)
// 页面驱动同样是共享真源：扩展里的副本必须与 shared/driver.js 一致
const sharedDriver = normalizeEol(readFileSync(path.join(repoRoot, 'shared', 'driver.js'), 'utf8'))
const extDriver = normalizeEol(readFileSync(path.join(extRoot, 'content', 'driver.js'), 'utf8'))
assert.ok(
  extDriver.endsWith(sharedDriver),
  'chrome-extension/content/driver.js 与 shared/driver.js 不一致，请运行 node tools/gen-providers.mjs',
)
// 插件里的驱动源码副本同理（内嵌面板靠它注入 guest）。
// 生成器会先把驱动归一成 LF 再嵌，所以这里也比归一后的内容。
const pluginDriverSource = readFileSync(path.join(repoRoot, 'dsh-plugin', 'lib', 'driver.source.mjs'), 'utf8')
assert.ok(
  pluginDriverSource.includes(JSON.stringify(sharedDriver)),
  'dsh-plugin/lib/driver.source.mjs 与 shared/driver.js 不一致，请运行 node tools/gen-providers.mjs',
)
record('真源一致性', `${canonical.providers.length} 家服务方 + 页面驱动，生成物无漂移`)

const providersModule = await loadProvidersModule()
const { PROVIDERS, DEFAULT_PROVIDER_ID, PROVIDER_MATCH_PATTERNS, PROVIDER_STORAGE_KEY, isProviderUrl, resolveProvider } =
  providersModule

// 1) 注册表本身
assert.equal(PROVIDERS.length, 6, `服务方应为 6 家，实际 ${PROVIDERS.length}`)
assert.ok(EXPECTED_IDS.every((id) => PROVIDERS.some((provider) => provider.id === id)), '应包含 6 个预期 id')
assert.equal(DEFAULT_PROVIDER_ID, 'deepseek', '默认服务方必须是 deepseek')
assert.equal(PROVIDER_STORAGE_KEY, 'bubble-ask.provider', '默认服务方存储键应为 bubble-ask.provider')

const ids = PROVIDERS.map((provider) => provider.id)
assert.equal(new Set(ids).size, ids.length, `服务方 ID 必须唯一：${ids.join(',')}`)

for (const provider of PROVIDERS) {
  for (const field of REQUIRED_FIELDS) {
    assert.ok(field in provider, `${provider.id} 缺字段 ${field}`)
  }
  assert.match(provider.id, /^[a-z][a-z0-9-]*$/, `${provider.id} id 不合法`)
  assert.ok(provider.name && typeof provider.name === 'string', `${provider.id} name 为空`)
  assert.ok(provider.url.startsWith('https://'), `${provider.id} url 必须是 https`)
  assert.ok(Array.isArray(provider.origins) && provider.origins.length > 0, `${provider.id} origins 不能为空`)
  assert.ok(
    provider.origins.every((origin) => typeof origin === 'string' && origin.length > 0 && !origin.includes('/')),
    `${provider.id} origins 应是主机名`,
  )
  assert.ok(Array.isArray(provider.composerSelectors) && provider.composerSelectors.length > 0, `${provider.id} composerSelectors 不能为空`)
  assert.equal(typeof provider.enterSends, 'boolean', `${provider.id} enterSends 必须是布尔`)
  assert.ok(Array.isArray(provider.sendSelectors), `${provider.id} sendSelectors 必须是数组`)
  assert.ok(Array.isArray(provider.sendAriaLabels), `${provider.id} sendAriaLabels 必须是数组`)
  assert.ok(Array.isArray(provider.loginMarkers), `${provider.id} loginMarkers 必须是数组`)
  assert.equal(typeof provider.verifyUrlRegex, 'string', `${provider.id} verifyUrlRegex 必须是字符串`)
  // verifyUrlRegex 应能被 new RegExp 接受（chat-bridge 里会编译它）
  assert.doesNotThrow(() => new RegExp(provider.verifyUrlRegex), `${provider.id} verifyUrlRegex 不是合法正则`)
}
record('providers 注册表', `${PROVIDERS.length} 项、ID 唯一、必填字段完整、origins 非空`)

// 2) 从注册表推导的匹配模式
assert.ok(Array.isArray(PROVIDER_MATCH_PATTERNS) && PROVIDER_MATCH_PATTERNS.length > 0, 'PROVIDER_MATCH_PATTERNS 不能为空')
assert.equal(new Set(PROVIDER_MATCH_PATTERNS).size, PROVIDER_MATCH_PATTERNS.length, 'PROVIDER_MATCH_PATTERNS 有重复')
record('provider 匹配模式', `${PROVIDER_MATCH_PATTERNS.length} 条（来自 origins）`)

// isProviderUrl：每个入口 URL 必须命中自己的 origins；外站不能命中
for (const provider of PROVIDERS) {
  assert.equal(isProviderUrl(provider, provider.url), true, `${provider.id} 的入口 URL 应命中 origins`)
  assert.equal(isProviderUrl(provider, 'https://example.com/'), false, `${provider.id} 不应命中外站`)
}
assert.equal(isProviderUrl('qwen', 'https://www.qianwen.com/chat'), true, 'qianwen.com 子域应命中 qwen')
assert.equal(isProviderUrl('qwen', 'https://chat.qwen.ai/'), true, 'chat.qwen.ai 应命中 qwen')
assert.equal(isProviderUrl('gemini', 'https://gemini.google.com/app'), true, 'gemini 入口应命中')
assert.equal(isProviderUrl('grok', 'https://x.com/i/flow/login'), true, 'x.com 应命中 grok（登录域名）')
assert.equal(resolveProvider('nope').id, 'deepseek', '未知 provider id 应回落到 deepseek')
assert.equal(resolveProvider('chatgpt').id, 'chatgpt', '已知 provider id 应原样返回')
record('isProviderUrl / resolveProvider', '入口命中、外站不命中、未知回落 deepseek')


// 3) manifest 覆盖检查
const hostPermissions = manifest.host_permissions || []
for (const provider of PROVIDERS) {
  const host = hostOf(provider.url)
  assert.ok(
    hostPermissions.some((pattern) => patternCoversHost(pattern, host)),
    `host_permissions 未覆盖 ${provider.id} 的入口 ${host}`,
  )
}
record('host_permissions 覆盖', `${PROVIDERS.length} 家入口域名`)

const bridgeEntry = (manifest.content_scripts || []).find(
  (entry) => Array.isArray(entry.js) && entry.js.includes('content/chat-bridge.js'),
)
assert.ok(bridgeEntry, 'content_scripts 里应有 chat-bridge.js 条目')
assert.ok(!('all_frames' in bridgeEntry) || bridgeEntry.all_frames === false, 'chat-bridge 应只在顶层 frame')
// driver.js 必须排在 chat-bridge.js 之前：后者依赖前者的全局，顺序错了内容脚本会拿不到
const driverIndex = bridgeEntry.js.indexOf('content/driver.js')
const bridgeIndex = bridgeEntry.js.indexOf('content/chat-bridge.js')
assert.ok(driverIndex >= 0, 'content_scripts 应先加载 content/driver.js（共享页面驱动）')
assert.ok(driverIndex < bridgeIndex, 'driver.js 必须排在 chat-bridge.js 之前')
for (const pattern of PROVIDER_MATCH_PATTERNS) {
  assert.ok(bridgeEntry.matches.includes(pattern), `chat-bridge.matches 缺少 ${pattern}`)
}
record('chat-bridge matches', `${bridgeEntry.matches.length} 条`)

const collectEntry = (manifest.content_scripts || []).find(
  (entry) => Array.isArray(entry.js) && entry.js.includes('content/bubble.js'),
)
assert.ok(collectEntry, 'content_scripts 里应有 collect.js + bubble.js 条目')
const excludes = collectEntry.exclude_matches || []
for (const pattern of PROVIDER_MATCH_PATTERNS) {
  assert.ok(excludes.includes(pattern), `气泡排除列表缺少 ${pattern}`)
}
assert.ok(excludes.includes('*://*/bubble-ask/*'), '气泡排除列表缺少 *://*/bubble-ask/*')
record('气泡排除列表', `${excludes.length} 条（覆盖全部 provider 域名）`)

// 4) 加载所需文件齐全
const requiredFiles = [
  'manifest.json',
  'background.js',
  'background.bundle.js',
  'content/compat.js',
  'icons/whale.png',
  'lib/prompt.js',
  'lib/providers.js',
  'content/collect.js',
  'content/bubble.js',
  'content/driver.js',
  'content/chat-bridge.js',
  'popup/popup.html',
  'popup/popup.js',
  'popup/popup.css',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
]
for (const file of requiredFiles) {
  assert.ok(existsSync(path.join(extRoot, file)), `缺少文件 ${file}`)
}
assert.ok(!existsSync(path.join(extRoot, 'content', 'deepseek-bridge.js')), '旧的 deepseek-bridge.js 应已改名')
record('加载文件齐全', `${requiredFiles.length} 个文件存在`)

// 5) background 打包产物必须与源一致（classic service worker，兼容老内核）
assert.equal(
  manifest.background && manifest.background.service_worker,
  'background.bundle.js',
  'manifest 应指向打包后的 background.bundle.js',
)
assert.ok(!(manifest.background && manifest.background.type === 'module'), 'background 不应再声明 type: module')
const { buildBundle } = await import('../../tools/gen-background.mjs')
const expectedBundle = buildBundle()
const actualBundle = readFileSync(path.join(extRoot, 'background.bundle.js'), 'utf8')
assert.equal(
  actualBundle.replace(/\r\n/g, '\n'),
  expectedBundle,
  'background.bundle.js 与源不一致，请跑 node tools/gen-background.mjs',
)
record('background 打包产物', '与源一致（classic service worker）')

console.log('PASS chrome-extension 静态校验')
for (const line of results) console.log(`  ✓ ${line}`)
console.log(`  providers: ${PROVIDERS.map((provider) => `${provider.id}(${provider.name})`).join(', ')}`)
