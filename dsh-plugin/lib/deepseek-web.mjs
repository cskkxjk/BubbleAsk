/**
 * deepseek-web.mjs — 零依赖的 DeepSeek 网页版驱动器（Node 24+ / 纯 ESM）。
 *
 * 这是仓库里 C# 实现的直译（src/CdpClient.cs + src/ChatDriver.cs +
 * src/BrowserLocator.cs + src/EdgeHost.cs），刻意保留了真机踩出来的细节：
 *
 *   1. CDP 的 WebSocket 消息必须按「整条」解码 —— C# 那边按 16KB 分片各自解码，
 *      把汉字切坏过（实测 8 个 U+FFFD）。这里 Node 的 WebSocket 交出来的已经是
 *      一条完整消息，所以只解码一次，永远不去碰原始分片。
 *   2. 发送必须串行化（ClientWebSocket 同时只允许一个 SendAsync），既保证顺序，
 *      也保证一条卡住时后面的不会乱序插进去。
 *   3. 输入框为空时 DeepSeek 的发送按钮「根本不存在」（不是 disabled），
 *      所以「先填再找按钮」的顺序是必须的；找不到按钮不代表页面改版。
 *   4. 点完按钮不等于发出去 —— 只有回读「输入框被清空」才算 sent。
 *   5. `?q=` 只预填、不自动发送：`autosend=1` 不是 DeepSeek 认的参数。
 *
 * 没有任何 npm 依赖：只用 globalThis.WebSocket / fetch 和 node: 内建模块。
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 单次 CDP 调用的默认超时（毫秒）。 */
const DEFAULT_CALL_TIMEOUT_MS = 15000;
/** WebSocket 握手的整体预算。 */
const CDP_CONNECT_TIMEOUT_MS = 15000;
/** 拉起浏览器后等 CDP 端口起来的预算（C# 里是 15 秒）。 */
const PORT_WAIT_MS = 15000;
/** 查 /json/list 的单次请求上限，避免一次卡住就把整个预算吞掉。 */
const TARGET_HTTP_TIMEOUT_MS = 3000;
/** 轮询目标的间隔。 */
const TARGET_POLL_INTERVAL_MS = 300;
/** 发送后回读输入框的轮询间隔。 */
const SEND_POLL_INTERVAL_MS = 120;
/** 补发 Enter 之后再等多久（不超过 sendTimeoutMs）。 */
const SECOND_VERIFY_MS = 8000;

const DEFAULT_CDP_PORT = 9333;
const DEFAULT_CHAT_URL = 'https://chat.deepseek.com/';
const DEFAULT_READY_TIMEOUT_MS = 25000;
const DEFAULT_SEND_TIMEOUT_MS = 12000;

/**
 * 认的浏览器顺序：先 Edge，再 Chrome，然后其它。这个顺序同时决定「自动检测」挑哪个。
 * exe 名与安装子目录照抄 src/BrowserLocator.cs。
 */
const KNOWN_BROWSERS = [
  { id: 'edge', name: 'Microsoft Edge', exeName: 'msedge.exe', subDirs: ['Microsoft\\Edge\\Application\\'] },
  { id: 'chrome', name: 'Google Chrome', exeName: 'chrome.exe', subDirs: ['Google\\Chrome\\Application\\'] },
  { id: 'brave', name: 'Brave', exeName: 'brave.exe', subDirs: ['BraveSoftware\\Brave-Browser\\Application\\'] },
  { id: 'vivaldi', name: 'Vivaldi', exeName: 'vivaldi.exe', subDirs: ['Vivaldi\\Application\\'] },
  { id: 'opera', name: 'Opera', exeName: 'opera.exe', subDirs: ['Opera\\', 'Programs\\Opera\\'] },
  { id: 'chromium', name: 'Chromium', exeName: 'chrome.exe', subDirs: ['Chromium\\Application\\'] },
];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error) {
  if (!error) {
    return '未知错误';
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error.message) {
    return String(error.message);
  }
  return String(error);
}

function numberOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function defaultProfileDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'BubbleAsk', 'edge-profile');
}

/** 聊天页的 origin，用来判断「窗口是不是已经停在聊天页」。 */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (error) {
    return 'https://chat.deepseek.com';
  }
}

/** 只取 q：DeepSeek 的 chat_url_prefill 认 q/prompt/mode/search/thinking。 */
function buildAskUrl(chatUrl, prompt) {
  const separator = chatUrl.indexOf('?') >= 0 ? '&' : '?';
  return chatUrl + separator + 'q=' + encodeURIComponent(prompt);
}

// ---------------------------------------------------------------------------
// 浏览器检测（注册表 App Paths 优先，再扫常见安装路径）
// ---------------------------------------------------------------------------

/** 注册表查询结果缓存：一次进程生命周期里没必要反复起 reg.exe。 */
const registryCache = new Map();

function findInRegistry(exeName) {
  if (registryCache.has(exeName)) {
    return registryCache.get(exeName);
  }
  const keys = [
    `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
    `HKCU\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
  ];
  let resolved = null;
  for (const key of keys) {
    try {
      const output = execFileSync('reg', ['query', key, '/ve'], {
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = /REG_SZ\s+(.+?)\s*$/m.exec(output || '');
      if (!match) {
        continue;
      }
      const value = match[1].trim().replace(/^"(.*)"$/, '$1');
      if (value && fs.existsSync(value)) {
        resolved = value;
        break;
      }
    } catch (error) {
      // 键不存在，或者 reg.exe 用不了（非 Windows / 受限环境）——都继续往下扫路径。
    }
  }
  registryCache.set(exeName, resolved);
  return resolved;
}

function candidatePathsFor(browser) {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    for (const subDir of browser.subDirs) {
      candidates.push(path.join(root, subDir + browser.exeName));
    }
  }
  return candidates;
}

function detectOne(browser) {
  const fromRegistry = findInRegistry(browser.exeName);
  if (fromRegistry) {
    return fromRegistry;
  }
  for (const candidate of candidatePathsFor(browser)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function describeBrowserPath(exePath) {
  const fileName = path.basename(exePath).toLowerCase();
  const known = KNOWN_BROWSERS.find((item) => item.exeName.toLowerCase() === fileName);
  if (known) {
    return { id: known.id, name: known.name, path: exePath };
  }
  return { id: 'custom', name: path.basename(exePath, path.extname(exePath)), path: exePath };
}

/**
 * 检测本机装了哪些 Chromium 内核浏览器。
 * @returns {{ id: string, name: string, path: string }[]}
 */
export function detectBrowsers() {
  const found = [];
  const seen = new Set();
  for (const browser of KNOWN_BROWSERS) {
    const exePath = detectOne(browser);
    if (!exePath) {
      continue;
    }
    // 同一个路径只出一遍（Edge 和 Chrome 都可能注册了 App Paths）。
    const key = exePath.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    found.push({ id: browser.id, name: browser.name, path: exePath });
  }
  return found;
}

function resolveBrowser(configuredPath, log) {
  if (configuredPath) {
    if (fs.existsSync(configuredPath)) {
      return describeBrowserPath(configuredPath);
    }
    log(`配置里的浏览器路径不可用（${configuredPath}），改用自动检测`);
  }
  const detected = detectBrowsers();
  return detected.length > 0 ? detected[0] : null;
}

// ---------------------------------------------------------------------------
// CDP 客户端
// ---------------------------------------------------------------------------

class CdpConnection {
  constructor(wsUrl, options = {}) {
    this.wsUrl = wsUrl;
    this._log = typeof options.log === 'function' ? options.log : () => {};
    this._onClosed = typeof options.onClosed === 'function' ? options.onClosed : () => {};
    this._socket = null;
    this._pending = new Map();
    this._nextId = 0;
    this._sendTail = Promise.resolve();
    this._closedReason = null;
  }

  get isOpen() {
    return Boolean(this._socket) && this._socket.readyState === 1 && this._closedReason === null;
  }

  /** 连接 + 握手，整体受 timeoutMs 预算约束（C# 那边握手卡住会让热键全哑）。 */
  async connect(timeoutMs = CDP_CONNECT_TIMEOUT_MS) {
    const socket = new WebSocket(this.wsUrl);
    this._socket = socket;

    // 文本帧在 Node 的 WebSocket 里已经是「一整条消息」。
    // 绝不要学 C# 那样自己按 16KB 分片逐段解码——那会把多字节汉字从中间切断。
    socket.addEventListener('message', (event) => {
      void this._handleFrame(event.data);
    });
    socket.addEventListener('close', () => {
      this._handleClose(new Error(`CDP WebSocket 已关闭：${this.wsUrl}`));
    });
    socket.addEventListener('error', () => {
      // 真正的错误原因由 close 事件统一兜住，这里只防止未处理的 error 事件。
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        action(value);
      };
      const onOpen = () => {
        finish(resolve);
      };
      const onError = (event) => {
        const detail = event && event.message ? event.message : (event && event.error && event.error.message) || '握手失败';
        finish(reject, new Error(`CDP WebSocket 连接失败：${detail}（${this.wsUrl}）`));
      };
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        try {
          socket.close();
        } catch (error) {
          // 已经死了就算了。
        }
        reject(new Error(`连接 CDP 超时（${timeoutMs} 毫秒）：${this.wsUrl}`));
      }, timeoutMs);
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
    });
  }

  async _handleFrame(data) {
    let text = null;
    try {
      if (typeof data === 'string') {
        text = data;
      } else if (data instanceof ArrayBuffer) {
        text = new TextDecoder('utf-8').decode(data);
      } else if (ArrayBuffer.isView(data)) {
        text = new TextDecoder('utf-8').decode(data.buffer, data.byteOffset, data.byteLength);
      } else if (data && typeof data.text === 'function') {
        text = await data.text();
      } else {
        return;
      }
    } catch (error) {
      return;
    }

    let message = null;
    try {
      message = JSON.parse(text);
    } catch (error) {
      return;
    }
    if (!message || typeof message.id !== 'number') {
      // 没有 id 的是 CDP 的事件推送，这里不订阅任何事件，直接忽略。
      return;
    }
    const entry = this._pending.get(message.id);
    if (!entry) {
      return;
    }
    this._pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new Error(`CDP 方法出错（${entry.method}）：${JSON.stringify(message.error)}`));
      return;
    }
    entry.resolve(message);
  }

  /** 连接不可用时立刻结束所有未决调用，别让调用方干等到超时。 */
  _handleClose(reason) {
    const first = this._closedReason === null;
    if (first) {
      this._closedReason = reason;
    }
    const orphans = [...this._pending.entries()];
    this._pending.clear();
    for (const [, entry] of orphans) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    if (first) {
      this._onClosed(this);
    }
  }

  /**
   * 发一条 CDP 命令。注意顺序：先登记 pending（同一个 id 由自增号保证唯一），
   * 再串行发送，最后等回包 —— 这样回包永远不会早于登记。
   */
  async call(method, params = {}, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    if (!this.isOpen) {
      throw new Error(`CDP 未连接（${method}）`);
    }
    const effectiveTimeout = numberOption(timeoutMs, DEFAULT_CALL_TIMEOUT_MS);
    const id = this._nextId + 1;
    this._nextId = id;

    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP 调用超时（${effectiveTimeout} 毫秒）：${method}`));
      }, effectiveTimeout);
      this._pending.set(id, { resolve, reject, timer, method });
    });

    try {
      await this._sendSerialized(JSON.stringify({ id, method, params }));
    } catch (error) {
      const entry = this._pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        this._pending.delete(id);
        entry.reject(error);
      }
    }
    return await responsePromise;
  }

  /**
   * 串行发送：每个调用排队等前一个发完。
   * Node 的 WebSocket 没有 ClientWebSocket 那种「同时只能一个 SendAsync」的硬限制，
   * 但仍然串行化：顺序稳定，且一条卡住时后面的不会乱序挤进去。
   */
  _sendSerialized(text) {
    const task = this._sendTail.then(() => new Promise((resolve, reject) => {
      const socket = this._socket;
      if (!socket || socket.readyState !== 1) {
        reject(new Error('CDP 未连接'));
        return;
      }
      try {
        socket.send(text);
        resolve();
      } catch (error) {
        reject(error);
      }
    }));
    // 队列尾永远不带着失败往下传，否则一次发送失败会堵死后面所有调用。
    this._sendTail = task.then(() => {}, () => {});
    return task;
  }

  /** 在页面里求值并取回值；页面脚本抛错时抛出，由调用方决定怎么兜。 */
  async evaluate(expression, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    const response = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, timeoutMs);

    const result = response && response.result;
    if (!result) {
      return null;
    }
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const message = (details.exception && details.exception.description) || details.text || '未知错误';
      throw new Error(`页面脚本抛错：${message}`);
    }
    const payload = result.result;
    if (!payload) {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'value')) {
      return payload.value;
    }
    if (typeof payload.description === 'string') {
      return payload.description;
    }
    return null;
  }

  /** 导航：Page.navigate 优先，不可用就退回页面里改 location.href。 */
  async navigate(url, timeoutMs = 8000) {
    try {
      await this.call('Page.navigate', { url }, timeoutMs);
      return true;
    } catch (error) {
      this._log(`Page.navigate 不可用（${describeError(error)}），改用 location.href`);
    }
    try {
      const literal = JSON.stringify(url);
      const verdict = await this.evaluate(`(function () { location.href = ${literal}; return 'nav'; })()`, timeoutMs);
      return verdict === 'nav';
    } catch (error) {
      this._log(`location.href 导航也失败：${describeError(error)}`);
      return false;
    }
  }

  /** CDP 的可信 Enter（页面里 new KeyboardEvent 的 isTrusted 是 false，React 会忽略）。 */
  async pressEnter(timeoutMs = 4000) {
    const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.call('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...base }, timeoutMs);
    // keyUp 不带 text，否则某些页面会当成两次输入（C# 侧同样处理）。
    await this.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, timeoutMs);
    return true;
  }

  async close() {
    const socket = this._socket;
    this._socket = null;
    if (socket) {
      try {
        if (socket.readyState === 0 || socket.readyState === 1) {
          socket.close(1000, 'shutdown');
        }
      } catch (error) {
        // 关不掉就算了，反正下面会把未决调用全部失败掉。
      }
    }
    this._handleClose(new Error('CDP 连接已由 shutdown() 关闭'));
  }
}

/** 本模块持有的 CDP 连接（wsUrl → 连接），shutdown() 统一关闭。 */
const CONNECTIONS = new Map();

async function connectToTarget(wsUrl, log) {
  const cached = CONNECTIONS.get(wsUrl);
  if (cached && cached.isOpen) {
    log('复用已经建立的 CDP 连接');
    return cached;
  }
  if (cached) {
    CONNECTIONS.delete(wsUrl);
  }
  const client = new CdpConnection(wsUrl, {
    log,
    onClosed: () => {
      if (CONNECTIONS.get(wsUrl) === client) {
        CONNECTIONS.delete(wsUrl);
      }
    },
  });
  await client.connect(CDP_CONNECT_TIMEOUT_MS);
  CONNECTIONS.set(wsUrl, client);
  log('CDP 已连接');
  return client;
}

// ---------------------------------------------------------------------------
// 页面脚本（多行模板串，保持可读；注意模板里反斜杠要写两次才到得了页面）
// ---------------------------------------------------------------------------

/**
 * composer（输入框）查找表达式，越靠前优先级越高：
 * textarea[name="search"] → 任意 textarea → contenteditable（最后手段）。
 */
const COMPOSER_EXPR = `
      (document.querySelector('textarea[name="search"]')
       || document.querySelector('textarea')
       || document.querySelector('div[contenteditable="true"]')
       || document.querySelector('[contenteditable="true"]')
       || document.querySelector('[role="textbox"]'))`;

/** 页面里共用的发送按钮工具：结构化优先，再依次退 label → svg path → class 语义。 */
const PAGE_HELPERS = `
  // 注意：这里刻意写成「先赋值再 return」。
  // COMPOSER_EXPR 是以换行开头的多行串，写成 return 加一个换行再跟表达式的形式会触发
  // 自动分号插入（ASI），表达式被整段丢掉，函数永远返回 undefined。
  // 这个坑真机踩过一次：状态脚本读不到输入框，诊断脚本（用 const 赋值那版）却读得到。
  function composerEl() {
    const el = ${COMPOSER_EXPR};
    return el;
  }

  function attrLabel(node) {
    if (!node || !node.getAttribute) {
      return '';
    }
    return [
      node.getAttribute('aria-label') || '',
      node.getAttribute('title') || '',
      node.getAttribute('data-testid') || '',
    ].join(' ');
  }

  function labelOf(node) {
    return (attrLabel(node) + ' ' + String((node && node.className) || '')).slice(0, 160);
  }

  function isVisible(node) {
    if (!node) {
      return false;
    }
    return Boolean(node.offsetWidth || node.offsetHeight || (node.getClientRects && node.getClientRects().length));
  }

  function isEnabled(node) {
    if (!node) {
      return false;
    }
    if (node.disabled) {
      return false;
    }
    if (node.getAttribute && node.getAttribute('aria-disabled') === 'true') {
      return false;
    }
    if (/disabled/i.test(String(node.className || ''))) {
      return false;
    }
    return true;
  }

  function depthOf(node) {
    let depth = 0;
    let cursor = node;
    while (cursor && cursor.parentElement) {
      depth += 1;
      cursor = cursor.parentElement;
    }
    return depth;
  }

  function deepest(nodes, test) {
    let best = null;
    let bestDepth = -1;
    for (const node of nodes) {
      if (!isVisible(node)) {
        continue;
      }
      if (!test(node)) {
        continue;
      }
      const depth = depthOf(node);
      if (depth > bestDepth) {
        best = node;
        bestDepth = depth;
      }
    }
    return best;
  }

  function findSendButton() {
    // 第一优先：结构化规则。输入框往上 4 层之内、role=button 且 class 同时含
    // ds-button--primary 与 ds-button--circle 的节点（真机上唯一，且不依赖图标形状）。
    // 注意别放宽成 class*=primary：旁边的上传按钮是 ds-button--iconLabelPrimary，会误命中。
    const box = composerEl();
    if (box) {
      let scope = box;
      for (let up = 0; up < 4 && scope; up += 1) {
        scope = scope.parentElement;
      }
      if (scope) {
        const structural = deepest(scope.querySelectorAll('[role="button"]'), (node) => {
          const cls = String(node.className || '');
          return cls.indexOf('ds-button--primary') >= 0 && cls.indexOf('ds-button--circle') >= 0;
        });
        if (structural) {
          return structural;
        }
      }
    }
    // 退路一：aria-label / title / data-testid 的语义匹配。
    const all = document.querySelectorAll('button, [role="button"], [data-testid], div, span');
    const byLabel = deepest(all, (node) => /发送|send|submit/i.test(attrLabel(node)));
    if (byLabel) {
      return byLabel;
    }
    // 退路二：图标 path 前缀（会随版本漂移，只当兜底）。
    const byIcon = deepest(all, (node) => Boolean(node.querySelector && node.querySelector('svg path[d^="M8.3125"]')));
    if (byIcon) {
      return byIcon;
    }
    // 退路三：className 语义。
    const byClass = deepest(all, (node) => /发送|send|submit/i.test(String(node.className || '')));
    if (byClass) {
      return byClass;
    }
    return null;
  }`;

/** 输入框快照：长度、是否可写、发送按钮在不在/可不可用、当前地址。 */
const COMPOSER_STATE_SCRIPT = `
(function () {
${PAGE_HELPERS}

  function textOf(el) {
    const tag = String(el.tagName || '').toUpperCase();
    const raw = (tag === 'TEXTAREA' || tag === 'INPUT') ? (el.value || '') : (el.innerText || el.textContent || '');
    return String(raw).replace(/[\\s\\u200b\\u00a0\\ufeff]/g, '');
  }

  const el = composerEl();
  if (!el) {
    return JSON.stringify({
      found: false, writable: false, box: 'none', len: 0, hasImage: false,
      hasSendButton: false, sendEnabled: false, url: location.href, title: document.title,
    });
  }
  const tag = String(el.tagName || '').toUpperCase();
  const box = (tag === 'TEXTAREA' || tag === 'INPUT') ? 'textarea' : 'editable';
  const plain = textOf(el);
  const writable = (box === 'textarea') ? !(el.disabled || el.readOnly) : (el.isContentEditable !== false);
  const button = findSendButton();
  return JSON.stringify({
    found: true,
    writable: writable,
    box: box,
    len: plain.length,
    hasImage: Boolean(el.querySelector && el.querySelector('img, image')),
    hasSendButton: Boolean(button),
    sendEnabled: Boolean(button && isEnabled(button)),
    url: location.href,
    title: document.title,
  });
})()
`;

/** 等不到输入框时的现场快照：readyState / url / title / 正文字数，用来区分「慢」和「改版」。 */
const DIAGNOSTICS_SCRIPT = `
(function () {
  const el = ${COMPOSER_EXPR};
  let writable = false;
  if (el) {
    const tag = String(el.tagName || '').toUpperCase();
    writable = (tag === 'TEXTAREA' || tag === 'INPUT') ? !(el.disabled || el.readOnly) : (el.isContentEditable !== false);
  }
  return JSON.stringify({
    readyState: document.readyState,
    url: location.href,
    title: document.title,
    bodyTextLength: document.body ? String(document.body.innerText || '').length : -1,
    composerFound: Boolean(el),
    composerWritable: writable,
    textareaCount: document.querySelectorAll('textarea').length,
    editableCount: document.querySelectorAll('[contenteditable="true"]').length,
    roleButtonCount: document.querySelectorAll('[role="button"]').length,
  });
})()
`;

/** 把文本注入输入框，并回读长度。返回 JSON：{ ok, kind, len, reason, url }。 */
function buildFillScript(prompt) {
  const literal = JSON.stringify(prompt);
  return `
(function () {
${PAGE_HELPERS}

  const text = ${literal};

  function fire(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\\r?\\n/g, '<br>');
  }

  function done(ok, kind, len, reason) {
    return JSON.stringify({ ok: ok, kind: kind, len: len, reason: reason || '', url: location.href });
  }

  const el = composerEl();
  if (!el) {
    return done(false, '', 0, 'none');
  }

  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'INPUT') {
    // React 受控输入框会忽略普通的 el.value = ...：
    // 必须走原型上的原生 setter，再补一个冒泡的 input 事件。
    const proto = (tag === 'INPUT') ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    const setter = descriptor && descriptor.set;
    if (!setter) {
      return done(false, 'textarea', 0, 'failed:nosetter');
    }
    try {
      setter.call(el, text);
    } catch (error) {
      return done(false, 'textarea', 0, 'failed:setter');
    }
    fire(el);
    try {
      el.focus();
    } catch (error) {
      // 聚焦失败不影响注入结果，继续回读。
    }
    const value = String(el.value || '');
    if (value !== text) {
      return done(false, 'textarea', value.length, 'failed:readback');
    }
    return done(value.length > 0, 'textarea', value.length, value.length > 0 ? '' : 'failed:empty');
  }

  // contenteditable（最后手段）：execCommand 路线，React 认它。
  try {
    el.focus();
  } catch (error) {
    // 同上。
  }
  try {
    document.execCommand('selectAll', false, null);
  } catch (error) {
    // 选中失败就按插入处理。
  }
  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, text);
  } catch (error) {
    inserted = false;
  }
  if (!inserted) {
    try {
      inserted = document.execCommand('insertHTML', false, escapeHtml(text));
    } catch (error) {
      inserted = false;
    }
  }
  if (!inserted) {
    return done(false, 'editable', 0, 'failed:execCommand');
  }
  fire(el);
  const plain = String(el.innerText || el.textContent || '').replace(/[\\s\\u200b\\u00a0]/g, '');
  return done(plain.length > 0, 'editable', plain.length, plain.length > 0 ? '' : 'failed:empty');
})()
`;
}

/** 只负责「点」发送按钮（Enter 退路走 CDP 的 Input.dispatchKeyEvent）。 */
const SEND_CLICK_SCRIPT = `
(function () {
${PAGE_HELPERS}

  const target = findSendButton();
  if (!target) {
    return JSON.stringify({ clicked: false, reason: 'not-found', label: '' });
  }
  const label = labelOf(target);
  if (!isEnabled(target)) {
    return JSON.stringify({ clicked: false, reason: 'disabled', label: label });
  }
  try {
    target.click();
  } catch (error) {
    const detail = (error && error.message) ? error.message : 'click';
    return JSON.stringify({ clicked: false, reason: 'failed:' + detail, label: label });
  }
  return JSON.stringify({ clicked: true, reason: '', label: label });
})()
`;

const COMPOSER_FOCUS_SCRIPT = `
(function () {
  const el = ${COMPOSER_EXPR};
  if (!el) {
    return 'none';
  }
  try {
    el.focus();
  } catch (error) {
    return 'failed:focus';
  }
  return 'ok';
})()
`;

// ---------------------------------------------------------------------------
// 页面动作（等待 / 注入 / 点击 / 回读）
// ---------------------------------------------------------------------------

async function readComposer(cdp) {
  const raw = await cdp.evaluate(COMPOSER_STATE_SCRIPT, 4000);
  if (typeof raw !== 'string') {
    return null;
  }
  try {
    const state = JSON.parse(raw);
    return state && typeof state === 'object' ? state : null;
  } catch (error) {
    return null;
  }
}

async function readPageDiagnostics(cdp) {
  try {
    const raw = await cdp.evaluate(DIAGNOSTICS_SCRIPT, 5000);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch (error) {
    // 页面可能在导航中，读不到就用兜底值，别把超时诊断也搞崩。
  }
  return {
    readyState: '(读不到)',
    url: '(读不到)',
    title: '(读不到)',
    bodyTextLength: -1,
    composerFound: false,
    composerWritable: false,
  };
}

/** 等输入框出现；冷启动（第一次拉起浏览器、刚登录完）SPA 要十几秒，所以给 readyTimeoutMs。 */
async function waitForComposer(cdp, timeoutMs, log) {
  const startedAt = Date.now();
  let firstError = null;
  let sawUnwritable = false;

  while (Date.now() - startedAt < timeoutMs) {
    let state = null;
    try {
      state = await readComposer(cdp);
    } catch (error) {
      if (!firstError) {
        firstError = error;
        log(`读取输入框状态失败：${describeError(error)}`);
      }
    }
    if (state && state.found) {
      if (state.writable) {
        const waited = Date.now() - startedAt;
        if (waited > 3000) {
          log(`输入框在 ${waited} 毫秒后才出现（页面加载偏慢）`);
        }
        return { ok: true, waited, kind: state.box || 'textarea', url: state.url };
      }
      sawUnwritable = true;
    }
    await sleep(TARGET_POLL_INTERVAL_MS);
  }

  const diagnostics = await readPageDiagnostics(cdp);
  // 停在登录页是「没登录」而不是「页面改版」——这一点值得单独点明，
  // 否则调用方只看到「找不到输入框」，会误判成选择器失效。
  const loginHint = /sign[_-]?in|log[_-]?in|\/login/i.test(String(diagnostics.url))
    ? '；页面停在登录页，需要先在这个浏览器窗口里登录 DeepSeek'
    : '';
  const detail =
    `等待输入框超时（${timeoutMs} 毫秒）：` +
    `document.readyState=${diagnostics.readyState}，` +
    `location.href=${diagnostics.url}，` +
    `document.title=${diagnostics.title}，` +
    `正文字数=${diagnostics.bodyTextLength}，` +
    `composerFound=${diagnostics.composerFound}，composerWritable=${diagnostics.composerWritable}，` +
    `textarea=${diagnostics.textareaCount} 个，contenteditable=${diagnostics.editableCount} 个，` +
    `role=button=${diagnostics.roleButtonCount} 个` +
    (sawUnwritable ? '；输入框存在但不可写（disabled/readOnly）' : '') +
    (firstError ? `；首次读取错误：${describeError(firstError)}` : '') +
    loginHint;
  return { ok: false, detail, url: diagnostics.url };
}

async function tryFillOnce(cdp, prompt) {
  const raw = await cdp.evaluate(buildFillScript(prompt), 8000);
  if (typeof raw !== 'string') {
    return { ok: false, kind: '', len: 0, reason: 'no-result', url: undefined };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, kind: '', len: 0, reason: 'bad-result:' + raw.slice(0, 120), url: undefined };
  }
  return {
    ok: Boolean(parsed.ok),
    kind: typeof parsed.kind === 'string' ? parsed.kind : '',
    len: Number(parsed.len) || 0,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    url: typeof parsed.url === 'string' ? parsed.url : undefined,
  };
}

/** 注入文本；回读为空时等 1.5 秒重试一次（页面可能刚渲染完）。 */
async function fillComposer(cdp, prompt, log) {
  let result = await tryFillOnce(cdp, prompt);
  if (result.ok) {
    return result;
  }
  log(`第一次注入没成功（${result.reason || '未知原因'}），等 1.5 秒重试`);
  await sleep(1500);
  result = await tryFillOnce(cdp, prompt);
  return result;
}

async function clickSendButton(cdp) {
  const attempt = async () => {
    const raw = await cdp.evaluate(SEND_CLICK_SCRIPT, 5000);
    if (typeof raw !== 'string') {
      return { clicked: false, reason: 'no-result', label: '' };
    }
    try {
      const parsed = JSON.parse(raw);
      return {
        clicked: Boolean(parsed.clicked),
        reason: typeof parsed.reason === 'string' ? parsed.reason : '',
        label: typeof parsed.label === 'string' ? parsed.label : '',
      };
    } catch (error) {
      return { clicked: false, reason: 'bad-result', label: raw.slice(0, 120) };
    }
  };

  let result = await attempt();
  if (!result.clicked && result.reason === 'not-found') {
    // 空输入框时按钮本来就不存在；刚注入完页面可能还要一拍才画出按钮，再给一次机会。
    await sleep(400);
    result = await attempt();
  }
  return result;
}

/** 轮询回读：只有输入框真的空了才算发出去。 */
async function waitForComposerCleared(cdp, timeoutMs) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = await readComposer(cdp);
    } catch (error) {
      // 读不到就继续轮询；读不到**绝不能**当成成功。
      last = null;
    }
    if (last && last.found && last.len === 0) {
      return { cleared: true, waited: Date.now() - startedAt, last };
    }
    await sleep(SEND_POLL_INTERVAL_MS);
  }
  return { cleared: false, waited: Date.now() - startedAt, last };
}

async function focusComposer(cdp) {
  try {
    await cdp.evaluate(COMPOSER_FOCUS_SCRIPT, 4000);
  } catch (error) {
    // 聚焦失败不致命，Enter 照样可能进页面。
  }
  await sleep(120);
}

function describeLen(snapshot) {
  if (!snapshot) {
    return '读不到（页面上可能找不到输入框）';
  }
  if (!snapshot.found) {
    return '读不到（页面上找不到输入框）';
  }
  return `${snapshot.len} 个字符`;
}

// ---------------------------------------------------------------------------
// 启动 / 挂接浏览器
// ---------------------------------------------------------------------------

async function portIsAnswering(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch (error) {
    return false;
  }
}

async function waitForPort(port) {
  const deadline = Date.now() + PORT_WAIT_MS;
  while (Date.now() < deadline) {
    if (await portIsAnswering(port)) {
      return true;
    }
    await sleep(TARGET_POLL_INTERVAL_MS);
  }
  return false;
}

/** 拉起应用窗口。用 detached + stdio:'ignore'：既不阻塞在子进程 stdio 上，也不让它跟着我们退出。 */
function launchBrowser(browser, config, log) {
  // --app：独立应用窗口；--disable-sync / --disable-extensions：独立的「只用来跑 DeepSeek」
  // 的 profile，不能被账号同步拉进来的第三方扩展干扰注入；
  // --remote-allow-origins=*：非浏览器客户端（Node 的 WebSocket 可能带 Origin）握手不被 403 拒掉。
  const args = [
    `--app=${config.appUrl}`,
    `--remote-debugging-port=${config.cdpPort}`,
    `--user-data-dir=${config.profileDir}`,
    '--disable-sync',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=480,760',
    '--remote-allow-origins=*',
  ];
  if (browser.id === 'edge') {
    // Edge 专有的首次运行引导，别的浏览器不认识这个 feature 名，别传。
    args.push('--disable-features=msEdgeFirstRunExperience');
  }

  try {
    fs.mkdirSync(config.profileDir, { recursive: true });
  } catch (error) {
    return { ok: false, detail: `创建 profile 目录失败（${config.profileDir}）：${describeError(error)}` };
  }

  const errorBox = { error: null };
  try {
    const child = spawn(browser.path, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', (error) => {
      errorBox.error = error;
    });
    child.unref();
    log(`已启动 ${browser.name}：--app=${config.appUrl}，CDP 端口 ${config.cdpPort}`);
    return { ok: true, errorBox };
  } catch (error) {
    return { ok: false, detail: `启动浏览器失败（${browser.path}）：${describeError(error)}` };
  }
}

/**
 * 等一个可调试的页面目标：优先 url 以聊天页 origin 开头的 page；
 * 如果有页面但不在聊天页，也先挂上去（由调用方导航过去），这样复用一个窗口就够了。
 */
async function waitForPageTarget(port, chatUrl, timeoutMs) {
  const origin = originOf(chatUrl).toLowerCase();
  const deadline = Date.now() + Math.max(3000, timeoutMs);
  let lastError = '';
  let lastSeen = '';

  while (Date.now() < deadline) {
    let items = null;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(TARGET_HTTP_TIMEOUT_MS) });
      items = await response.json();
    } catch (error) {
      lastError = describeError(error);
    }

    if (Array.isArray(items)) {
      const pages = items.filter((item) => item && item.type === 'page' && typeof item.webSocketDebuggerUrl === 'string' && item.webSocketDebuggerUrl);
      const chatPage = pages.find((item) => typeof item.url === 'string' && item.url.toLowerCase().startsWith(origin));
      if (chatPage) {
        return { ok: true, wsUrl: chatPage.webSocketDebuggerUrl, targetUrl: chatPage.url };
      }
      if (pages.length > 0) {
        return { ok: true, wsUrl: pages[0].webSocketDebuggerUrl, targetUrl: pages[0].url || '' };
      }
      if (items.length > 0) {
        const types = [...new Set(items.map((item) => (item && item.type) || '未知'))].join('/');
        lastSeen = `${items.length} 个目标里没有可调试的页面（类型：${types}）`;
      }
    }

    await sleep(TARGET_POLL_INTERVAL_MS);
  }

  const detail = `在 ${Math.round(Math.max(3000, timeoutMs) / 1000)} 秒内没找到可调试的页面目标` +
    `（端口 ${port}${lastSeen ? '；' + lastSeen : ''}${lastError ? '；最后一次请求错误：' + lastError : ''}）`;
  return { ok: false, detail };
}

/**
 * 复用或启动浏览器并挂上页面目标。
 * @returns {Promise<{ ok: boolean, stage: string, detail: string, browserPath?: string, wsUrl?: string, targetUrl?: string }>}
 */
async function ensureBrowserCore({ config, log }) {
  const browser = resolveBrowser(config.browserPath, log);
  if (!browser) {
    return {
      ok: false,
      stage: 'launch',
      detail: '没有找到可用的 Chromium 浏览器（Edge/Chrome/Brave/Vivaldi/Opera/Chromium）。' +
        '请安装一个，或者在 config.browserPath 里指定 exe 的绝对路径。',
    };
  }

  const port = config.cdpPort;
  if (await portIsAnswering(port)) {
    // 窗口已经开着（上一次调用留下的）：直接复用，绝不再开第二个，也不碰它的会话。
    log(`CDP 端口 ${port} 已在响应，复用已打开的浏览器窗口`);
  } else {
    const launched = launchBrowser(browser, config, log);
    if (!launched.ok) {
      return { ok: false, stage: 'launch', detail: launched.detail, browserPath: browser.path };
    }
    if (!(await waitForPort(port))) {
      const reason = launched.errorBox && launched.errorBox.error
        ? describeError(launched.errorBox.error)
        : '端口一直没有响应';
      return {
        ok: false,
        stage: 'launch',
        detail: `${browser.name} 启动后 ${Math.round(PORT_WAIT_MS / 1000)} 秒内 CDP 端口 ${port} 仍没响应` +
          `（${reason}；常见原因：profile 被别的进程占用、浏览器正在更新、被安全软件拦住）。`,
        browserPath: browser.path,
      };
    }
    log(`${browser.name} 窗口已就绪，CDP 端口 ${port} 可以访问了`);
  }

  const target = await waitForPageTarget(port, config.chatUrl, config.readyTimeoutMs);
  if (!target.ok) {
    return { ok: false, stage: 'cdp', detail: target.detail, browserPath: browser.path };
  }
  return {
    ok: true,
    stage: 'cdp',
    detail: `已挂上 ${browser.name} 的页面目标：${target.targetUrl}`,
    browserPath: browser.path,
    wsUrl: target.wsUrl,
    targetUrl: target.targetUrl,
  };
}

/**
 * 失败退路：把窗口导航到 ${chatUrl}?q=...（只预填、不发送）。
 *
 * 注意 `autosend=1` 不是 DeepSeek 支持的参数（bundle 里的 chat_url_prefill 只认
 * q/prompt/mode/search/thinking），所以这里绝不假装发成功 —— 一律 ok:false。
 */
async function prefillFallback({ cdp, config, prompt, log, stage, detail }) {
  const url = buildAskUrl(config.chatUrl, prompt);
  if (!cdp || !cdp.isOpen) {
    return {
      ok: false,
      stage,
      detail: `${detail}（CDP 已断开，?q= 预填退路也没法用）`,
    };
  }

  log(`退路：导航到 ?q= 预填链接（只填不发）`);
  let navigated = false;
  try {
    navigated = await cdp.navigate(url, 8000);
  } catch (error) {
    log(`?q= 预填链接没打开成功：${describeError(error)}`);
    navigated = false;
  }

  const explanation = navigated
    ? '已用 ?q= 预填链接把问题填进输入框，需要手动按 Enter 才会发出'
    : '?q= 预填链接的导航也没成功';
  return {
    ok: false,
    stage: 'prefilled',
    detail: `[失败阶段 ${stage}] ${detail}；${explanation}。` +
      '注意 autosend=1 不是 DeepSeek 支持的参数，所以退路只能预填、不会自动发送。',
    url,
  };
}

// ---------------------------------------------------------------------------
// 对外的四个 API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DeepSeekWebConfig
 * @property {string} [browserPath]   absolute path to a Chromium exe; omit to auto-detect
 * @property {number} [cdpPort]       default 9333
 * @property {string} [profileDir]    user-data-dir; default %APPDATA%\BubbleAsk\edge-profile
 * @property {string} [chatUrl]       default 'https://chat.deepseek.com/'
 * @property {string} [appUrl]        URL the app window opens; default chatUrl
 * @property {number} [readyTimeoutMs] default 25000 (cold start SPA needs this)
 * @property {number} [sendTimeoutMs]  default 12000
 * @property {boolean} [autoSend]      default true; when false only fill, never click
 */

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const chatUrl = typeof source.chatUrl === 'string' && source.chatUrl.trim() ? source.chatUrl.trim() : DEFAULT_CHAT_URL;
  return {
    browserPath: typeof source.browserPath === 'string' ? source.browserPath.trim() : '',
    cdpPort: numberOption(source.cdpPort, DEFAULT_CDP_PORT),
    profileDir: typeof source.profileDir === 'string' && source.profileDir.trim() ? source.profileDir.trim() : defaultProfileDir(),
    chatUrl,
    appUrl: typeof source.appUrl === 'string' && source.appUrl.trim() ? source.appUrl.trim() : chatUrl,
    readyTimeoutMs: numberOption(source.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS),
    sendTimeoutMs: numberOption(source.sendTimeoutMs, DEFAULT_SEND_TIMEOUT_MS),
    autoSend: source.autoSend !== false,
  };
}

/**
 * 发送成功的旁证：DeepSeek 收下消息后会跳到会话页 /a/chat/s/<uuid>，
 * 这是"服务端确实收到了"的带外信号（消息列表是虚拟化的，正文不足以当证据）。
 * @param url 当前页面地址
 * @returns 一段可拼进 detail 的后缀，取不到就是空串
 */
function describeConversationUrl(url) {
  const text = typeof url === 'string' ? url : '';
  const match = /\/a\/chat\/s\/([0-9a-z-]{8,})/i.exec(text);
  if (!match) {
    return '';
  }
  return `；页面已进入会话 ${match[1].slice(0, 8)}`;
}

/** 复用或启动浏览器并返回页面目标信息，不发送任何内容。 */
export async function ensureBrowser(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const log = typeof source.log === 'function' ? source.log : () => {};
  // 既支持 ensureBrowser({ config, log })，也支持直接传一个 config 对象。
  const config = normalizeConfig(source.config !== undefined ? source.config : source);
  try {
    const core = await ensureBrowserCore({ config, log });
    return {
      ok: core.ok,
      detail: core.detail,
      browserPath: core.browserPath,
      wsUrl: core.wsUrl,
    };
  } catch (error) {
    return { ok: false, detail: `准备浏览器时出错：${describeError(error)}` };
  }
}

/** 关闭本模块持有的 CDP websocket（不杀浏览器窗口）。 */
export async function shutdown() {
  const clients = [...CONNECTIONS.values()];
  CONNECTIONS.clear();
  for (const client of clients) {
    try {
      await client.close();
    } catch (error) {
      // shutdown 不应该因为某条连接已经死掉而抛错。
    }
  }
}

/**
 * 启动或复用浏览器，把 prompt 注入 DeepSeek 网页版的输入框；默认自动点发送并回读校验。
 * 任何失败路径都尝试 `${chatUrl}?q=` 预填退路（只填不发）。
 *
 * @param {{ prompt: string, config?: DeepSeekWebConfig, log?: (msg: string) => void }} options
 * @returns {Promise<{ ok: boolean, stage: 'sent'|'prefilled'|'filled'|'launch'|'cdp'|'composer'|'fill'|'send-button'|'unverified', detail: string, url?: string }>}
 */
export async function sendToDeepSeekWeb(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const prompt = typeof source.prompt === 'string' ? source.prompt : '';
  const log = typeof source.log === 'function' ? source.log : () => {};
  const config = normalizeConfig(source.config);

  if (prompt.trim().length === 0) {
    return { ok: false, stage: 'fill', detail: 'prompt 为空，没有可发送的内容' };
  }

  let cdp = null;
  const fail = async (stage, detail, url) => {
    log(`失败（阶段 ${stage}）：${detail}`);
    return await prefillFallback({ cdp, config, prompt, log, stage, detail, url });
  };

  // ---- 1) 复用或启动浏览器 -------------------------------------------------
  let core = null;
  try {
    core = await ensureBrowserCore({ config, log });
  } catch (error) {
    return { ok: false, stage: 'cdp', detail: `准备浏览器时出错：${describeError(error)}` };
  }
  if (!core.ok) {
    // 连页面都没挂上，也就没有可以导航的页面，?q= 退路同样没法用 —— 直接报原始阶段。
    log(`失败（阶段 ${core.stage}）：${core.detail}`);
    return { ok: false, stage: core.stage, detail: core.detail };
  }

  // ---- 2) 连上页面目标 -----------------------------------------------------
  try {
    cdp = await connectToTarget(core.wsUrl, log);
  } catch (error) {
    return { ok: false, stage: 'cdp', detail: `连接 CDP 页面失败：${describeError(error)}` };
  }

  try {
    // 10) 上次留下的窗口可能停在别的地址：复用同一个窗口，导航回聊天页（不重启浏览器）。
    if (typeof core.targetUrl === 'string' && core.targetUrl.toLowerCase().startsWith(originOf(config.chatUrl).toLowerCase())) {
      log('复用已打开的聊天页面，不动当前会话');
    } else {
      log(`当前页面不在聊天页（${core.targetUrl || '未知'}），导航到 ${config.chatUrl}`);
      await cdp.navigate(config.chatUrl, 10000);
      await sleep(1200);
    }

    // ---- 4) 等输入框 ------------------------------------------------------
    log('正在等待 DeepSeek 输入框（composer）…');
    const composer = await waitForComposer(cdp, config.readyTimeoutMs, log);
    if (!composer.ok) {
      return await fail('composer', composer.detail, composer.url);
    }
    log(`输入框已就绪（${composer.kind}，等了 ${composer.waited} 毫秒）`);

    // ---- 5) 注入文本 ------------------------------------------------------
    const filled = await fillComposer(cdp, prompt, log);
    if (!filled.ok) {
      return await fail('fill', `文本没能写进输入框（${filled.reason || '回读为空'}）`, filled.url);
    }
    log(`已注入 ${filled.len} 个字符（${filled.kind}）`);

    if (!config.autoSend) {
      log('autoSend=false，只填入不发送');
      return {
        ok: true,
        stage: 'filled',
        detail: `已把 ${filled.len} 个字符填入输入框；autoSend=false 所以没有点发送`,
        url: filled.url,
      };
    }

    // ---- 6) 找发送按钮（必须在填完之后：空输入框时按钮根本不存在）---------
    await sleep(250);
    const clicked = await clickSendButton(cdp);
    if (!clicked.clicked) {
      return await fail(
        'send-button',
        `发送按钮不可用（${clicked.reason}${clicked.label ? '；最接近的候选：' + clicked.label : ''}）。` +
          '注意空输入框时发送按钮本来就不存在，所以 not found 不等于页面改版。',
        filled.url,
      );
    }
    log(`已点击发送按钮（${clicked.label || '无标签'}），正在回读输入框…`);

    // ---- 7) 回读校验：只有输入框真的空了才算 sent ------------------------
    const first = await waitForComposerCleared(cdp, config.sendTimeoutMs);
    if (first.cleared) {
      log('输入框已清空，判定发送成功');
      // 发送成功后 SPA 会跳到 /a/chat/s/<uuid>；等一下再读地址，作为「服务端收到」的旁证。
      let evidenceUrl = first.last && first.last.url;
      try {
        await sleep(800);
        const after = await readComposer(cdp);
        if (after && after.url) {
          evidenceUrl = after.url;
        }
      } catch (error) {
        // 读不到就用刚才那次回读的地址，不影响 sent 判定。
      }
      return {
        ok: true,
        stage: 'sent',
        detail: `已发送并回读确认：输入框在 ${first.waited} 毫秒内被清空` +
          describeConversationUrl(evidenceUrl),
        url: evidenceUrl,
      };
    }

    log(`点击后输入框没清空（${describeLen(first.last)}），补一次 CDP 可信 Enter`);
    await focusComposer(cdp);
    let pressed = false;
    try {
      pressed = await cdp.pressEnter(4000);
    } catch (error) {
      log(`可信 Enter 没发出去：${describeError(error)}`);
      pressed = false;
    }

    if (pressed) {
      const second = await waitForComposerCleared(cdp, Math.min(config.sendTimeoutMs, SECOND_VERIFY_MS));
      if (second.cleared) {
        log('可信 Enter 之后输入框已清空，判定发送成功');
        return {
          ok: true,
          stage: 'sent',
          detail: `已发送并回读确认：点击未清空，补发可信 Enter 后输入框被清空（共等 ${first.waited + second.waited} 毫秒）` +
            describeConversationUrl(second.last && second.last.url),
          url: second.last && second.last.url,
        };
      }
      return await fail(
        'unverified',
        `已点击发送并补发可信 Enter，但输入框里仍有 ${describeLen(second.last)}，无法确认发出`,
        second.last && second.last.url,
      );
    }

    return await fail(
      'unverified',
      `已点击发送但输入框仍有 ${describeLen(first.last)}，可信 Enter 也没发出去，无法确认发出`,
      first.last && first.last.url,
    );
  } catch (error) {
    return await fail('cdp', `CDP 交互出错：${describeError(error)}`, undefined);
  }
}
