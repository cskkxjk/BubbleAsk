/**
 * 与本机 Bubble Ask 的通信层。
 *
 * 为什么不再自己驱动 CDP：
 *   CDP 驱动原本在 `lib/deepseek-web.mjs` 里有一份 C# 的移植副本，与 `ChatDriver.cs` /
 *   `CdpClient.cs` 维护同一套选择器与校验逻辑。两边都装的前提下，托盘应用才是
 *   「谁是网页版窗口」的唯一权威：它持有唯一一份持久化登录 profile（默认
 *   %APPDATA%\BubbleAsk\edge-profile），登录一次长期有效。插件只当薄客户端。
 *
 * 协议：Windows 命名管道，一连接 = 一行 JSON 请求 → 一行 JSON 响应。
 * 发现：%APPDATA%\BubbleAsk\ipc.json 记录 { version, app, pipe, pid, exe }。
 *
 * 一个 exe 两种身份：带 `--service` 启动的是无界面后台服务（插件要拉起的就是它），
 * 不带参数启动的是托盘界面。插件只在服务没在跑时才拉起，且只拉起服务模式。
 *
 * 这个文件不依赖第三方包，除平台判断外不含别的逻辑；Linux/macOS 上会明确报告
 * 「未找到 Bubble Ask」。
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 必须与 src/shared/IpcContract.cs 的 ProtocolVersion 一致。 */
export const PROTOCOL_VERSION = 2

/** 必须与 src/shared/IpcContract.cs 的 ServiceSwitch 一致。 */
const SERVICE_SWITCH = '--service'

/** 发送要等页面渲染 + 注入 + 校验，冷启动还会拉浏览器，给足预算。 */
const SEND_TIMEOUT_MS = 180000
/** 健康检查要快，不该卡住任何调用方。 */
const HEALTH_TIMEOUT_MS = 10000

/** 发现文件路径。 */
export function discoveryPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'BubbleAsk', 'ipc.json')
}

/** 读发现文件；不存在或损坏都返回 null。 */
export function readDiscovery() {
  try {
    const parsed = JSON.parse(fs.readFileSync(discoveryPath(), 'utf8'))
    if (!parsed || typeof parsed.pipe !== 'string' || !parsed.pipe) return null
    return parsed
  } catch {
    return null
  }
}

/** pid 是否还活着（权限不足也算活着）。 */
function processAlive(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try {
    process.kill(value, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 发现文件里记的管道名，且持有它的进程还活着；否则 null。 */
function livePipe() {
  const discovery = readDiscovery()
  if (!discovery || !processAlive(discovery.pid)) return null
  return discovery.pipe
}

/**
 * 连上管道、写一行、读回一行。读到的连接不主动关闭，交给调用方决定
 * ——普通命令读完就 close，租约要一直攥着。
 *
 * @returns {Promise<{response: object, close: () => void}>}
 */
function exchange(pipeName, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(`\\\\.\\pipe\\${pipeName}`)
    let buffer = ''
    let settled = false
    const close = () => {
      try {
        socket.destroy()
      } catch {
        /* 关闭失败无所谓 */
      }
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      close()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error('等待 Bubble Ask 响应超时')), timeoutMs)

    socket.setEncoding('utf8')
    socket.on('connect', () => {
      try {
        socket.write(`${JSON.stringify(payload)}\n`)
      } catch (error) {
        fail(error)
      }
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index < 0 || settled) return
      settled = true
      clearTimeout(timer)
      const line = buffer.slice(0, index)
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        close()
        reject(new Error(`Bubble Ask 返回了无法解析的内容：${line.slice(0, 120)}`))
        return
      }
      resolve({ response: parsed, close })
    })
    socket.on('error', fail)
    // 没收到完整响应就断开：当成失败，别让调用方一直等。
    socket.on('close', () => fail(new Error('Bubble Ask 提前关闭了连接')))
  })
}

/** 一条命令 = 一问一答，读完立刻断开。 */
async function request(pipeName, payload, timeoutMs) {
  const { response, close } = await exchange(pipeName, payload, timeoutMs)
  close()
  return response
}

/**
 * 并发去重的包装：Host 启动时会同时收到多条 /health（Client 半有三个组件各请求
 * 一次），没有这层去重会并发拉起多个服务进程。进行中的调用共享同一个结果。
 */
let starting = null

export function ensureApp(options = {}) {
  if (starting) return starting
  starting = ensureAppOnce(options)
  starting.then(
    () => { starting = null },
    () => { starting = null },
  )
  return starting
}

/**
 * 确保服务在线；不在线就拉起（`--service` 模式）。
 *
 * @param options.appPath 显式指定的 exe 路径（插件配置），优先级最高
 * @param options.log 记录日志的回调
 * @returns {{ok: boolean, discovery?: object, error?: string, detail?: string}}
 */
async function ensureAppOnce(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const explicit = typeof options.appPath === 'string' ? options.appPath.trim() : ''

  // 已经在跑：pid 活着且 ping 有回应。
  let discovery = readDiscovery()
  if (discovery && processAlive(discovery.pid)) {
    try {
      const pong = await request(discovery.pipe, { v: PROTOCOL_VERSION, cmd: 'ping' }, 3000)
      if (pong && pong.ok === true) return { ok: true, discovery }
      if (pong && pong.stage === 'version') {
        return {
          ok: false,
          error: 'version',
          detail: `Bubble Ask 版本过旧（本机 ${pong.app || '未知'}），请升级后重试`,
        }
      }
    } catch (error) {
      log(`探测到 pid ${discovery.pid}，但管道连不上：${String(error?.message ?? error)}`)
    }
  }

  // 需要拉起：优先显式配置，其次发现文件里记的 exe 路径。
  const candidate = explicit || (discovery && discovery.exe ? discovery.exe : '')
  if (!candidate) {
    return {
      ok: false,
      error: 'missing-app',
      detail: '未找到 Bubble Ask。请先安装并启动它（托盘出现图标即可），或在本插件配置里填写 appPath。',
    }
  }
  if (!fs.existsSync(candidate)) {
    return { ok: false, error: 'missing-exe', detail: `找不到 Bubble Ask 可执行文件：${candidate}` }
  }

  log(`正在拉起 Bubble Ask 服务：${candidate} ${SERVICE_SWITCH}`)
  try {
    // 只拉起服务模式：拉起托盘界面并不会带来可用的管道服务。
    const child = spawn(candidate, [SERVICE_SWITCH], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch (error) {
    return { ok: false, error: 'spawn-failed', detail: `拉起 Bubble Ask 失败：${String(error?.message ?? error)}` }
  }

  // 等它把管道和发现文件准备好。
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    await sleep(500)
    const fresh = readDiscovery()
    if (!fresh || !processAlive(fresh.pid)) continue
    try {
      const pong = await request(fresh.pipe, { v: PROTOCOL_VERSION, cmd: 'ping' }, 3000)
      if (pong && pong.ok === true) return { ok: true, discovery: fresh }
    } catch {
      // 还在启动，继续等。
    }
  }
  return { ok: false, error: 'start-timeout', detail: '已拉起 Bubble Ask，但它在 25 秒内没有就绪' }
}

/** 版本不匹配时补一句人话。 */
function normalize(response) {
  if (response && response.stage === 'version') {
    return { ...response, detail: response.detail || 'Bubble Ask 版本过旧，请升级后重试' }
  }
  return response
}

/**
 * 发一条命令。
 *
 * 先按发现文件直接发送（一次往返）；只有连不上时才执行「探测 + 拉起 + 重试」。
 * 每次操作前先 ping 一次是常见的多余延迟。
 */
async function call(command, payload, options = {}) {
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : HEALTH_TIMEOUT_MS
  const body = { v: PROTOCOL_VERSION, cmd: command, ...(payload || {}) }

  const cached = livePipe()
  if (cached) {
    try {
      return normalize(await request(cached, body, timeoutMs))
    } catch {
      // 发现文件过期或服务刚好退出：落到下面的拉起流程。
    }
  }

  const ready = await ensureApp(options)
  if (!ready.ok) return { ok: false, stage: ready.error, detail: ready.detail }
  try {
    return normalize(await request(ready.discovery.pipe, body, timeoutMs))
  } catch (error) {
    return { ok: false, stage: 'ipc', detail: `与 Bubble Ask 通信失败：${String(error?.message ?? error)}` }
  }
}

/**
 * 健康检查：服务是否在线、协议版本、运行中的浏览器 profile 等。
 * 永不抛错——/health 与自检都靠它判断状态。
 */
export async function health(options = {}) {
  return call('health', {}, { ...options, timeoutMs: HEALTH_TIMEOUT_MS })
}

/**
 * 注入完整提问并发送（是否自动点发送由服务侧的配置决定）。
 *
 * provider 可选（deepseek/qwen/doubao/chatgpt/gemini/grok）：不传时由服务端按默认
 * DeepSeek 处理，旧桌面端会忽略该字段。providerUrl 只有 custom 需要，插件不传。
 */
export async function sendPrompt(options = {}) {
  const prompt = typeof options.prompt === 'string' ? options.prompt : ''
  if (!prompt.trim()) {
    return { ok: false, stage: 'fill', detail: 'prompt 为空，没有可发送的内容' }
  }
  const payload = { prompt }
  const provider = typeof options.provider === 'string' ? options.provider.trim() : ''
  if (provider) payload.provider = provider
  const providerUrl = typeof options.providerUrl === 'string' ? options.providerUrl.trim() : ''
  if (providerUrl) payload.providerUrl = providerUrl
  return call('send', payload, { ...options, timeoutMs: SEND_TIMEOUT_MS })
}

/**
 * 登记一条长期租约：让服务知道「DSH 插件还活着」，直到返回的 close() 被调用
 * 或本进程消失（对端断开，服务不需要额外清理）。
 *
 * 服务在「最后一条租约断开」后再等一段时间才退出，所以插件在 DSH 运行期间
 * 一直挂着这条连接，DSH 退出时进程消失、连接自动断开。
 *
 * @returns {Promise<{ok: boolean, close: () => void, detail?: string}>}
 */
export async function attachLease(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const idle = () => ({ ok: false, close: () => {} })

  // 服务在跑就直接登记，省掉一次 ping 往返。
  let pipe = livePipe()
  if (!pipe) {
    const ready = await ensureApp({ ...options, log })
    if (!ready.ok) return { ...idle(), detail: ready.detail || '服务未就绪' }
    pipe = ready.discovery.pipe
  }

  try {
    const { response, close } = await exchange(pipe, { v: PROTOCOL_VERSION, cmd: 'attach' }, 8000)
    if (response.ok !== true) {
      close()
      return { ...idle(), detail: response.detail || '服务拒绝租约' }
    }
    log(`已向服务登记租约（当前 ${response.leases ?? '?'} 条）`)
    return { ok: true, close }
  } catch (error) {
    return { ...idle(), detail: String(error?.message ?? error) }
  }
}
