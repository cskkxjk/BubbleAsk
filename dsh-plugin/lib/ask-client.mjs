/**
 * 与本机 Bubble Ask 托盘应用的通信层。
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
 * 这个文件不依赖任何第三方包，也不做平台判断以外的魔法；Linux/macOS 上会
 * 明确报告「未找到托盘应用」，而不是静默失败。
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 必须与 src/PipeServer.cs 的 ProtocolVersion 一致。 */
export const PROTOCOL_VERSION = 1

/** 发送要等页面渲染 + 注入 + 校验，冷启动还会拉浏览器，给足预算。 */
const SEND_TIMEOUT_MS = 180000
/** 只开窗口：连接 + 等 composer。 */
const OPEN_TIMEOUT_MS = 60000
/** 健康检查要快，不该卡住面板。 */
const HEALTH_TIMEOUT_MS = 10000

/** 发现文件路径。 */
export function discoveryPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'BubbleAsk', 'ipc.json')
}

/** 读发现文件；不存在或损坏都返回 null。 */
export function readDiscovery() {
  try {
    const raw = fs.readFileSync(discoveryPath(), 'utf8')
    const parsed = JSON.parse(raw)
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

/**
 * 发一条请求并读回一条响应。
 * @param pipeName 管道名（不含 \\.\pipe\ 前缀）
 */
function request(pipeName, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(`\\\\.\\pipe\\${pipeName}`)
    let buffer = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        /* 关闭失败无所谓 */
      }
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, new Error('等待 Bubble Ask 响应超时')), timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      try {
        socket.write(`${JSON.stringify(payload)}\n`)
      } catch (error) {
        finish(reject, error)
      }
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index < 0) return
      const line = buffer.slice(0, index)
      try {
        finish(resolve, JSON.parse(line))
      } catch {
        finish(reject, new Error(`Bubble Ask 返回了无法解析的内容：${line.slice(0, 120)}`))
      }
    })
    socket.on('error', (error) => finish(reject, error))
    socket.on('close', () => {
      // 没收到完整响应就断开：当成失败，别让调用方一直等。
      finish(reject, new Error('Bubble Ask 提前关闭了连接'))
    })
  })
}

/**
 * 确保托盘应用在线；不在线就尝试拉起它。
 *
 * @param options.appPath 显式指定的 exe 路径（插件配置），优先级最高
 * @param options.log 记录日志的回调
 * @returns {{ok: boolean, discovery?: object, error?: string, detail?: string}}
 */
export async function ensureApp(options = {}) {
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
      detail: '未找到 Bubble Ask 托盘应用。请先安装并启动它（托盘出现图标即可），或在本插件配置里填写 appPath。',
    }
  }
  if (!fs.existsSync(candidate)) {
    return { ok: false, error: 'missing-exe', detail: `找不到 Bubble Ask 可执行文件：${candidate}` }
  }

  log(`正在拉起 Bubble Ask：${candidate}`)
  try {
    const child = spawn(candidate, [], { detached: true, stdio: 'ignore' })
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

/** 发一条命令，自动处理「应用没在跑」的情况。 */
async function call(command, payload, options = {}) {
  const ready = await ensureApp(options)
  if (!ready.ok) return { ok: false, stage: ready.error, detail: ready.detail }
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : HEALTH_TIMEOUT_MS
  try {
    const response = await request(
      ready.discovery.pipe,
      { v: PROTOCOL_VERSION, cmd: command, ...(payload || {}) },
      timeoutMs,
    )
    if (response && response.stage === 'version') {
      return { ...response, detail: response.detail || 'Bubble Ask 版本过旧，请升级后重试' }
    }
    return response
  } catch (error) {
    return { ok: false, stage: 'ipc', detail: `与 Bubble Ask 通信失败：${String(error?.message ?? error)}` }
  }
}

/**
 * 健康检查：应用是否在线、协议版本、运行中的浏览器 profile 等。
 * 永不抛错——面板和自检都靠它判断状态。
 */
export async function health(options = {}) {
  const result = await call('health', {}, { ...options, timeoutMs: HEALTH_TIMEOUT_MS })
  return result
}

/** 只打开 / 复用网页版窗口，不注入任何内容。 */
export async function openWindow(options = {}) {
  return call('open', {}, { ...options, timeoutMs: OPEN_TIMEOUT_MS })
}

/** 注入完整提问并发送（是否自动点发送由托盘应用自己的配置决定）。 */
export async function sendPrompt(options = {}) {
  const prompt = typeof options.prompt === 'string' ? options.prompt : ''
  if (!prompt.trim()) {
    return { ok: false, stage: 'fill', detail: 'prompt 为空，没有可发送的内容' }
  }
  return call('send', { prompt }, { ...options, timeoutMs: SEND_TIMEOUT_MS })
}

/**
 * 兼容旧调用点：以前这里关的是本模块持有的 CDP websocket。
 * 现在每次请求都是一条独立管道连接，没有常驻资源要释放。
 */
export async function shutdown() {}
