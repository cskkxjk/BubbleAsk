/**
 * 扩展侧适配层：只做「消息收发 + 等待/重试 + 阶段判定」。
 *
 * 页面里的具体动作（找输入框、填充、找发送键、回读）全部在 `driver.js` 里 ——
 * 那是与桌面端共用的唯一实现（真源 `shared/driver.js`，由 tools/gen-providers.mjs 同步）。
 * 这里以前有 390 行自己的一套 DOM 逻辑，与 C# 里的另一套并行维护，现已删除。
 *
 * 加载顺序：manifest 的 content_scripts 保证 driver.js 在本文件之前加载。
 */

/** 内容脚本没有 ESM，直接取全局；driver 没加载时给出可诊断的失败而不是静默报错。 */
function getDriver() {
  return globalThis.__bubbleAskDriver || null
}

/** 补齐缺失字段，避免脏数据把 driver 打挂（driver 自身对字段缺失是宽容的）。 */
function normalizeProvider(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : [])
  return {
    id: typeof source.id === 'string' && source.id ? source.id : 'deepseek',
    name: typeof source.name === 'string' && source.name ? source.name : 'DeepSeek',
    url: typeof source.url === 'string' ? source.url : '',
    origins: list(source.origins),
    composerSelectors: list(source.composerSelectors),
    sendSelectors: list(source.sendSelectors),
    sendClassHints: list(source.sendClassHints),
    sendSvgPaths: list(source.sendSvgPaths),
    sendAriaLabels: list(source.sendAriaLabels),
    enterSends: source.enterSends === true,
    loginMarkers: list(source.loginMarkers),
    verifyUrlRegex: typeof source.verifyUrlRegex === 'string' ? source.verifyUrlRegex : '',
    genericComposerSelectors: list(source.genericComposerSelectors),
    genericSendAriaLabels: list(source.genericSendAriaLabels),
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 把本页的 favicon 换成扩展自己的 PNG。
 *
 * 为什么要做：服务方站点普遍只提供 SVG favicon，DeepSeek 甚至把 rel 的 type 写成
 * `image/x-icon` 而文件其实是 SVG —— 格式声明与实际不符，Chromium 在**窗口/任务栏**
 * 这一层常常不认，于是退回系统默认的空白文档图标，用户看到的就是「一个文件图标」。
 *
 * 页面可以改自己的 `<link rel="icon">`，指向 web_accessible_resources 里的 PNG 即可；
 * Chromium 会在 favicon 变化后更新窗口图标。拿不到扩展资源时静默保持站点原样。
 */
function applyFavicon() {
  try {
    const href = chrome.runtime.getURL('icons/icon48.png')
    let link = document.querySelector('link[rel~="icon"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      const head = document.head || document.documentElement
      if (!head) return
      head.appendChild(link)
    }
    if (link.href === href && link.type === 'image/png') return
    link.type = 'image/png'
    link.href = href
  } catch (error) {
    /* 扩展上下文失效或无权限时保持原样，不影响主流程 */
  }
}

applyFavicon()
// 单页应用路由切换时可能重建 <head>，隔一会儿再补一次；只补一次，避免持续占用
setTimeout(applyFavicon, 2000)

/** 等输入框出现（页面可能在加载或跳转）。 */
async function waitForComposer(driver, cfg, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const composer = driver.findComposer(cfg)
    if (composer) return composer
    await sleep(200)
  }
  return null
}

function loginResult(provider) {
  return {
    ok: false,
    stage: 'login',
    detail: `这个窗口里的 ${provider.name} 还没登录，请先登录一次（之后会记住）`,
  }
}

/** 完整流程：登录检查 → 等输入框 → 填入 → 等发送键 → 点击 → 回读确认。 */
async function ask(driver, cfg, prompt) {
  if (driver.isLoginUrl(cfg)) return loginResult(cfg)

  const composer = await waitForComposer(driver, cfg, 25000)
  if (!composer) {
    // 等待期间可能被重定向到登录页
    if (driver.isLoginUrl(cfg)) return loginResult(cfg)
    return {
      ok: false,
      stage: 'no-composer',
      detail: `25 秒内没找到 ${cfg.name} 的输入框（${document.readyState}，${location.href}），页面可能还在加载或已改版`,
    }
  }

  const filled = driver.fill(cfg, prompt)
  await sleep(150)
  if (!driver.composerText(driver.findComposer(cfg) || composer).trim() || filled.indexOf('failed') === 0) {
    return { ok: false, stage: 'fill', detail: `文字没能写进输入框（${filled}），页面结构可能已改版` }
  }

  // 按钮可能比输入框晚就绪（发送键常按内容启用）
  let action = 'nobutton'
  for (let attempt = 0; attempt < 20; attempt += 1) {
    action = driver.send(cfg)
    if (action.indexOf('clicked:') === 0 || action.indexOf('disabled:') === 0 || action === 'failed:click') break
    await sleep(150)
  }

  if (action.indexOf('clicked:') === 0) {
    const startedUrl = location.href
    if (await waitSent(driver, cfg, startedUrl, 8000)) {
      return { ok: true, stage: 'sent', detail: `已发送到 ${cfg.name}` }
    }
    return { ok: false, stage: 'unverified', detail: '已点击发送但没能确认输入框被清空，请在窗口里核对' }
  }

  if (action.indexOf('disabled:') === 0) {
    return { ok: false, stage: 'no-button', detail: '发送按钮当前不可点击；文字已填入，请在窗口里手动发送' }
  }

  return {
    ok: false,
    stage: 'no-button',
    detail: '找不到发送按钮；文字已填入，请在窗口里手动回车或点按钮发送',
  }
}

/** 点击后轮询：输入框清空或跳转到会话页即视为成功。 */
async function waitSent(driver, cfg, startedUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (driver.verifySent(cfg, startedUrl)) return true
    await sleep(120)
  }
  return false
}

/** 把消息里的 provider 与通用兜底组合成 driver 需要的 cfg。 */
function buildProvider(message) {
  const raw = message.provider && typeof message.provider === 'object' ? message.provider : {}
  const generic = message.generic && typeof message.generic === 'object' ? message.generic : {}
  return normalizeProvider({
    ...raw,
    // 注意不要把 generic 直接展开进 provider —— 它的键名是 composerSelectors/sendAriaLabels，
    // 会覆盖掉 provider 自己的专属选择器。这里显式改名。
    genericComposerSelectors: Array.isArray(generic.composerSelectors)
      ? generic.composerSelectors
      : raw.genericComposerSelectors,
    genericSendAriaLabels: Array.isArray(generic.sendAriaLabels) ? generic.sendAriaLabels : raw.genericSendAriaLabels,
  })
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false
  const driver = getDriver()
  const provider = buildProvider(message)

  if (message.type === 'BA_PING') {
    if (!driver) {
      sendResponse({ ok: false, ready: false, detail: 'driver.js 未加载', providerId: provider.id })
      return true
    }
    sendResponse({
      ok: true,
      ready: Boolean(driver.findComposer(provider)),
      url: location.href,
      providerId: provider.id,
      driver: driver.version,
    })
    // 始终回 true：有些 Chromium 分支（如 Maxthon）会按返回值判断「是否会有响应」
    return true
  }

  if (message.type === 'BA_ASK') {
    if (!driver) {
      sendResponse({ ok: false, stage: 'error', detail: '页面驱动没加载（driver.js），请刷新页面后重试' })
      return true
    }
    ask(driver, provider, String(message.prompt || ''))
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ ok: false, stage: 'error', detail: String(error && error.message ? error.message : error) }),
      )
    return true
  }

  return false
})
