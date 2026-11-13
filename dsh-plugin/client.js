/**
 * Bubble Ask —— Client 半。
 *
 * 三件事：
 *   1. 盯住会话里的文字选区（鼠标松开、Shift+方向键都算）；
 *   2. 在选区旁浮出提问卡片：写问题、发送，失败时可复制完整提问；
 *   3. 维护设置页、右键设置面板与内嵌网页版面板。
 *
 * 发送执行者有两个：DeepSeek 优先交给插件自己的内嵌窗口（经桌面端 lease 通道开的
 * Electron guest 打开网页版），其余服务方交给托盘应用的命名管道。内嵌这条失败时
 * 回退到托盘应用。结果显示在卡片里：成功即收起，失败留在原地并给出「复制完整提问」。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-bubble-ask',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef

    /**
     * 网页版服务方列表：与 Host（index.js 的 PROVIDERS）和桌面端注册表保持一致。
     * Host 的 /health 若返回桌面端实际支持的 id 列表，会与这里取交集。
     */
    const PROVIDERS = [
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'qwen', name: '千问 Qwen' },
      { id: 'doubao', name: '豆包 Doubao' },
      { id: 'chatgpt', name: 'ChatGPT' },
      { id: 'gemini', name: 'Gemini' },
      { id: 'grok', name: 'Grok' },
    ]
    /** 上次在设置里选的服务方，跨页面刷新记住。 */
    const PROVIDER_STORAGE_KEY = 'bubble-ask.provider'
    function readStoredProvider() {
      try {
        const value = window.localStorage.getItem(PROVIDER_STORAGE_KEY) || ''
        return PROVIDERS.some((provider) => provider.id === value) ? value : ''
      } catch {
        return ''
      }
    }
    function storeProvider(id) {
      try {
        window.localStorage.setItem(PROVIDER_STORAGE_KEY, id)
      } catch {
        /* 隐身模式等写不进去，忽略 */
      }
    }

    /**
     * 右上角鲸鱼按钮的右键面板总线。
     *
     * 左键保持原样（开/关内嵌面板），右键弹出一个小设置面板。面板本身画在
     * `shell.overlay` 里 —— 标题栏那行 overflow 会裁，就地弹会被切掉，所以按钮
     * 只负责把锚点坐标发出来，由 overlay 里的 SettingsPopover 负责渲染。
     */
    const settingsBus = {
      open: false,
      x: 0,
      y: 0,
      subscribers: new Set(),
      snapshot() {
        return { open: this.open, x: this.x, y: this.y }
      },
      subscribe(fn) {
        this.subscribers.add(fn)
        return () => { this.subscribers.delete(fn) }
      },
      publish() {
        const snap = this.snapshot()
        for (const fn of this.subscribers) fn(snap)
      },
      show(x, y) {
        this.open = true
        this.x = x
        this.y = y
        this.publish()
      },
      hide() {
        if (!this.open) return
        this.open = false
        this.publish()
      },
      toggle(x, y) {
        if (this.open) this.hide()
        else this.show(x, y)
      },
    }

    /**
     * 服务方选择：设置页、右键面板与提问卡片共用一份状态。
     *
     * 存储里的选择优先，其次是 /health 报的宿主配置默认值。provider 每次渲染都从
     * 存储现读，三个入口改完立即一致；桌面端不支持的 id 会改回可用值并写回存储。
     */
    function useProviderChoice() {
      const [configured, setConfigured] = useState('')
      const [providers, setProviders] = useState(PROVIDERS)
      const [note, setNote] = useState('')
      // 写入存储后强制重渲染：provider 由存储派生，不另存一份状态。
      const [, setRevision] = useState(0)

      useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const response = await fetch('/bubble-ask/health')
            if (!response.ok) return
            const payload = await response.json()
            if (cancelled || !payload || payload.ok !== true) return
            const app = payload.app || {}
            const connected = app.connected === true
            const switchable = app.providerSwitchable === true
            const ids = switchable && Array.isArray(app.providers) ? app.providers : []
            const known = switchable
              ? (ids.length > 0 ? PROVIDERS.filter((item) => ids.includes(item.id)) : PROVIDERS)
              : PROVIDERS.filter((item) => item.id === 'deepseek')
            // 只有连上托盘应用时才知道它支持哪些服务方；连接不上时保留完整列表，
            // 不按「只支持 DeepSeek」处理，也不改动存储里的选择。
            if (connected && known.length > 0) setProviders(known)
            if (connected) {
              const configuredId = payload.settings && typeof payload.settings.provider === 'string'
                ? payload.settings.provider
                : ''
              const fallbackId = known.some((item) => item.id === configuredId)
                ? configuredId
                : (known[0] ? known[0].id : '')
              const stored = readStoredProvider()
              if (stored && !known.some((item) => item.id === stored)) {
                // 记忆里的服务方本机不支持（旧桌面端或注册表变化）：改回可用值并写回，
                // 避免卡片标题与实际发送目标不一致。
                if (fallbackId) storeProvider(fallbackId)
                setRevision((value) => value + 1)
                report('provider-corrected', { from: stored, to: fallbackId })
              } else if (!stored && fallbackId) {
                setConfigured(fallbackId)
              }
            }
            if (switchable) setNote('')
            else if (connected) setNote('桌面端版本低于 2.1.0，服务方只能为 DeepSeek。')
            else if (paneBus.available()) setNote('未连接托盘应用：DeepSeek 由内嵌窗口发送，其它服务方需要桌面端 2.1.0 或更高版本。')
            else setNote('未连接托盘应用，内嵌窗口也不可用：请先启动 BubbleAsk.exe。')
          } catch {
            setNote('读不到插件状态：/bubble-ask/health 请求失败。')
          }
        })()
        return () => { cancelled = true }
      }, [])

      const provider = readStoredProvider() || configured

      function choose(id) {
        storeProvider(id)
        setRevision((value) => value + 1)
        report('settings-provider', { provider: id })
      }

      return { provider, providers, note, choose }
    }

    /** 服务方下拉（设置页与右键面板共用）。 */
    function ProviderSelect({ provider, providers, onChange }) {
      // provider 为空表示还没有可用值：下拉先显示第一个，未选择时不写回存储。
      const value = provider || (providers[0] ? providers[0].id : '')
      return h('select', {
        className: 'dba-select',
        value,
        onChange: (event) => onChange(event.currentTarget.value),
      }, providers.map((item) => h('option', { key: item.id, value: item.id }, item.name)))
    }

    /** 当前会话 id：由会话作用域的探针登记，浮层再读它。 */
    const sessionCounts = new Map()
    let lastSessionId = ''
    let currentSessionId = ''
    const sessionListeners = new Set()
    function emitSession() {
      const next = sessionCounts.size > 0 ? lastSessionId : ''
      if (next === currentSessionId) return
      currentSessionId = next
      for (const listener of sessionListeners) listener(next)
    }
    function retainSession(id) {
      const key = typeof id === 'string' ? id : ''
      if (!key) return () => {}
      sessionCounts.set(key, (sessionCounts.get(key) || 0) + 1)
      lastSessionId = key
      emitSession()
      return () => {
        const left = (sessionCounts.get(key) || 0) - 1
        if (left > 0) sessionCounts.set(key, left)
        else {
          sessionCounts.delete(key)
          if (lastSessionId === key) {
            const remaining = Array.from(sessionCounts.keys())
            lastSessionId = remaining.length > 0 ? remaining[remaining.length - 1] : ''
          }
        }
        emitSession()
      }
    }

    /** 会话作用域的探针：只登记 id，不渲染内容。 */
    function SessionProbe(props) {
      const id = props && (props.sessionId || (props.session && props.session.id))
      useEffect(() => retainSession(id), [id])
      return null
    }

    const CSS = [
      '.dba-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483000}',
      '.dba-card{position:fixed;pointer-events:auto;width:360px;max-width:calc(100vw - 24px);',
      'border-radius:12px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));',
      'background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);',
      'box-shadow:0 12px 32px rgba(0,0,0,.18);font:var(--dsw-font-xxs-12,12px/1.5 system-ui);overflow:hidden}',
      '.dba-head{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}',
      '.dba-title{font-weight:600;flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dba-x{pointer-events:auto;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#888);',
      'cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;border-radius:4px}',
      '.dba-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dba-body{padding:8px 10px;display:flex;flex-direction:column;gap:8px}',
      '.dba-quote{max-height:96px;overflow:auto;white-space:pre-wrap;word-break:break-word;',
      'color:var(--dsw-alias-label-secondary,#555);background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));',
      'border-radius:8px;padding:7px 8px}',
      '.dba-ask{display:flex;align-items:center;gap:7px}',
      '.dba-whale{flex:none;width:26px;height:auto;opacity:.9;pointer-events:none;',
      '-webkit-user-drag:none;user-select:none}',
      '.dba-head .dba-whale{width:18px}',
      '.dba-send{flex:none;height:30px;padding:0 14px;border:0;border-radius:8px;cursor:pointer;',
      'background:var(--dsw-alias-label-accent,#247bbf);color:#fff;font:inherit;font-weight:600}',
      '.dba-send:disabled{opacity:.55;cursor:default}',
      '.dba-settings{display:flex;flex-direction:column;gap:10px;padding:14px 16px;max-width:560px}',
      '.dba-pop{position:fixed;z-index:2147483001;pointer-events:auto;display:flex;flex-direction:column;gap:8px;',
      'padding:12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));',
      'background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);',
      'box-shadow:0 14px 36px rgba(0,0,0,.2);font:var(--dsw-font-xxs-12,12px/1.5 system-ui)}',
      '.dba-pop-title{font-weight:600}',
      '.dba-set-title{font-weight:600;color:var(--dsw-alias-label-primary,#111)}',
      '.dba-set-row{display:flex;align-items:center;gap:8px}',
      '.dba-set-label{color:var(--dsw-alias-label-tertiary,#888);white-space:nowrap}',
      '.dba-set-hint{color:var(--dsw-alias-label-tertiary,#888);line-height:1.6}',
      '.dba-input{box-sizing:border-box;flex:auto;min-width:0;height:30px;border-radius:8px;padding:0 9px;',
      'border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);',
      'color:var(--dsw-alias-label-primary,#111);font:inherit;outline:none}',
      '.dba-input:focus{border-color:var(--dsw-alias-label-accent,#247bbf)}',
      '.dba-select{flex:auto;min-width:0;height:28px;border-radius:8px;padding:0 6px;',
      'border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);',
      'color:var(--dsw-alias-label-primary,#111);font:inherit;outline:none}',
      '.dba-foot{display:flex;align-items:center;gap:8px;padding:0 10px 10px;flex-wrap:wrap}',
      '.dba-btn{pointer-events:auto;height:30px;padding:0 12px;border-radius:8px;cursor:pointer;font:inherit;',
      'border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent;',
      'color:var(--dsw-alias-label-primary,#111)}',
      '.dba-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dba-status{padding:0 10px 9px;color:var(--dsw-alias-label-tertiary,#888);min-height:14px;word-break:break-word}',
      // ---- 内嵌网页版面板 ----
      '.dba-pane{position:fixed;right:12px;bottom:12px;width:520px;height:calc(100vh - 96px);pointer-events:auto;',
      'flex-direction:column;border-radius:12px;overflow:hidden;',
      'border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));',
      'background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);',
      'box-shadow:0 16px 40px rgba(0,0,0,.22);font:var(--dsw-font-xxs-12,12px/1.5 system-ui)}',
      '.dba-pane-head{display:flex;align-items:center;gap:6px;padding:7px 9px;flex:none;',
      'border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}',
      '.dba-pane-title{font-weight:600;flex:none}',
      '.dba-pane-status{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'color:var(--dsw-alias-label-tertiary,#888)}',
      '.dba-pane-btn{height:24px;padding:0 9px;border-radius:6px;cursor:pointer;font:inherit;',
      'border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent;',
      'color:var(--dsw-alias-label-primary,#111)}',
      '.dba-pane-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dba-pane-btn:disabled{opacity:.5;cursor:default}',
      '.dba-pane-host{flex:auto;min-height:0;display:flex;background:#fff}',
      '.dba-pane-host webview{flex:auto;width:100%;height:100%;border:0}',
      // 标题栏右上角的常驻开关：28×28，和 DSH 自己的工具图标同尺寸；开着时描一圈强调色。
      '.dba-toggle{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;',
      'padding:0;border:0;border-radius:8px;background:transparent;cursor:pointer;',
      'transition:background-color .12s ease,box-shadow .12s ease}',
      '.dba-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dba-toggle-on{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));',
      'box-shadow:inset 0 0 0 1px var(--dsw-alias-label-accent,#247bbf)}',
      '.dba-toggle-whale{display:block;width:22px;height:auto;pointer-events:none;',
      '-webkit-user-drag:none;user-select:none}',
    ].join('')

    //#region 工具函数
    /** 把错误压成一行，方便上报。 */
    function errorText(error) {
      if (!error) return ''
      if (typeof error === 'string') return error
      return String(error.message || error)
    }

    /** 无人值守自检：把 Client 半的关键动作报给 Host（页面里看不到控制台）。 */
    function report(event, data) {
      try {
        fetch('/bubble-ask/diag', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client: 'event', event, ...(data || {}) }),
        }).catch(() => {})
      } catch {
        /* 上报失败不影响功能 */
      }
    }

    /**
     * POST 一个 JSON 请求。HTTP 非 2xx 抛错，并把响应体挂在 error.payload 上，
     * 调用方仍可拿到 Host 返回的 prompt 等字段。
     */
    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      let payload = {}
      try {
        payload = await response.json()
      } catch {
        payload = { ok: false, error: 'Host 返回了无法解析的内容' }
      }
      if (!response.ok) {
        const error = new Error(payload.error || payload.detail || `请求失败（HTTP ${response.status}）`)
        error.payload = payload
        throw error
      }
      return payload
    }

    /** 复制文本：优先 clipboard API，退回到临时 textarea + execCommand。 */
    async function copyText(text) {
      const value = String(text || '')
      if (!value) return false
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value)
          return true
        }
      } catch (error) {
        report('clipboard-api-failed', { message: errorText(error) })
      }
      try {
        const node = document.createElement('textarea')
        node.value = value
        node.style.position = 'fixed'
        node.style.top = '-1000px'
        node.style.opacity = '0'
        document.body.appendChild(node)
        node.focus()
        node.select()
        const ok = document.execCommand && document.execCommand('copy')
        node.remove()
        return Boolean(ok)
      } catch (error) {
        report('clipboard-exec-failed', { message: errorText(error) })
      }
      return false
    }
    //#endregion

    /** 划词提问卡片。 */
    function BubbleAsk() {
      const [bubble, setBubble] = useState({ visible: false, text: '', x: 0, y: 0 })
      const [question, setQuestion] = useState('')
      const [status, setStatus] = useState('')
      const [busy, setBusy] = useState(false)
      /** 失败时保留完整提问，供「复制完整提问」使用。 */
      const [failedPrompt, setFailedPrompt] = useState('')
      /**
       * 发到哪家：存储里的选择 > /health 报的宿主配置 > 还没有值。
       * 设置页、右键面板与这张卡片共用同一个 hook。
       */
      const { provider, providers } = useProviderChoice()
      /** 抑制选区重算的截止时间戳：点了卡片里的按钮后，同一次手势的 mouseup 不重算选区。 */
      const suppressRef = useRef(0)
      const bubbleRef = useRef(bubble)
      bubbleRef.current = bubble
      // provider 为空表示还没有可用值：标题不写死 DeepSeek，请求也不钉死 provider。
      const providerInfo = provider
        ? providers.find((item) => item.id === provider) || null
        : null

      useEffect(() => {
        /** 最近一次显示卡片的时间：拖选文字常伴随滚动，刚弹出时不被滚动收起。 */
        let shownAt = 0
        /** 从一次用户手势里读选区。 */
        function readSelection(event) {
          if (Date.now() < suppressRef.current) {
            report('selection-suppressed', {})
            return
          }
          const target = event && event.target
          if (target && target.nodeType === 1 && target.closest && target.closest('[data-dba-root]')) return
          const selection = window.getSelection && window.getSelection()
          const text = selection ? String(selection).trim() : ''
          if (!text) {
            if (bubbleRef.current.visible) {
              setBubble((prev) => ({ ...prev, visible: false }))
            }
            return
          }
          const anchor = selection.anchorNode
          const anchorElement = anchor && anchor.nodeType === 1 ? anchor : (anchor && anchor.parentElement) || null
          if (anchorElement && anchorElement.closest && anchorElement.closest('input, textarea, [contenteditable="true"]')) return
          let rect
          try {
            rect = selection.getRangeAt(0).getBoundingClientRect()
          } catch (error) {
            return
          }
          if (!rect || (rect.width === 0 && rect.height === 0)) return
          const margin = 80
          const x = Math.min(Math.max(rect.left + rect.width / 2, margin), window.innerWidth - margin)
          const y = Math.min(Math.max(rect.bottom + 8, 8), window.innerHeight - 60)
          shownAt = Date.now()
          // 选中即出提问卡片，只有一个渲染分支。
          setBubble({ visible: true, text: text.slice(0, 4000), x, y })
          setStatus('')
          setFailedPrompt('')
          report('selection-shown', { chars: text.length, x: Math.round(x), y: Math.round(y) })
        }
        const onMouseUp = (event) => window.setTimeout(() => readSelection(event), 0)
        const onKeyUp = (event) => {
          if (event.shiftKey || event.key === 'Shift') readSelection(event)
        }
        // 只有用户自己滚动且卡片已显示时才收起；刚弹出的 800ms 内不处理滚动。
        // scroll 不冒泡，但会走捕获阶段：window 上的捕获监听同样会收到卡片内部的滚动
        // （单行输入框里文字超出可视宽度时会自己横向滚动，引用区也可能可滚动）。
        // 这类内部滚动不能当成"用户滚动了页面"，否则问题稍微长一点卡片就自己消失。
        const onScroll = (event) => {
          if (Date.now() - shownAt < 800) return
          const target = event && event.target
          if (target && target.nodeType === 1 && target.closest && target.closest('[data-dba-root]')) return
          setBubble((prev) => (prev.visible ? { ...prev, visible: false } : prev))
        }
        document.addEventListener('mouseup', onMouseUp, true)
        document.addEventListener('keyup', onKeyUp, true)
        window.addEventListener('scroll', onScroll, true)
        return () => {
          document.removeEventListener('mouseup', onMouseUp, true)
          document.removeEventListener('keyup', onKeyUp, true)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [])

      function closeBubble() {
        setBubble({ visible: false, text: '', x: 0, y: 0 })
        setFailedPrompt('')
        setStatus('')
      }

      // 卡片显示时按 Esc 取消：与设置页里「Esc 取消」的说明一致。
      useEffect(() => {
        if (!bubble.visible) return
        const onKeyDown = (event) => {
          if (event.key === 'Escape') closeBubble()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [bubble.visible])

      /**
       * 走一次完整流程：Host 组装上下文 → 执行者注入并发送。
       * @param send true 直接发送；false 只整理并把完整提问复制到剪贴板（手动粘贴用）
       */
      async function runAsk(send) {
        const selection = bubbleRef.current.text
        // provider 由存储派生：设置页或右键面板改完，下一句立即生效。
        // 空串表示还没有可用值，此时不钉死 provider，由桌面端按自己的配置发送。
        const providerId = provider
        const providerName = providerId
          ? ((providers.find((item) => item.id === providerId) || providerInfo || { name: providerId }).name)
          : '桌面端配置的网页版'
        const providerField = providerId ? { provider: providerId } : {}
        setBusy(true)
        setStatus(send ? `正在整理会话轨迹并发送到 ${providerName}…` : `正在整理会话轨迹（发到 ${providerName}）…`)
        setFailedPrompt('')
        report(send ? 'action-send-start' : 'action-copy-start', {
          sessionId: currentSessionId,
          selectionChars: selection.length,
          provider: providerId,
        })
        try {
          // 内嵌面板能发 DeepSeek 时，先用 /prompt 组好提问（该路由不触发发送），
          // 再由面板把同一份 prompt 填入自己开的 guest。
          const usePane = send && providerId === 'deepseek' && paneBus.available()
          let payload = null
          if (usePane) {
            try {
              payload = await postJson('/bubble-ask/prompt', {
                sessionId: currentSessionId,
                selection,
                question,
                ...providerField,
              })
              const panePrompt = typeof payload.prompt === 'string' ? payload.prompt : ''
              if (!payload.ok || !panePrompt) throw new Error(payload.detail || payload.error || '整理提问失败')
              setStatus('正在通过内嵌窗口发送…')
              const result = await paneBus.ask({ prompt: panePrompt, providerId })
              if (!result || !result.ok) throw new Error(result && result.detail ? result.detail : '内嵌窗口没能发送')
              report('action-send-done', { stage: 'pane', promptChars: panePrompt.length, provider: providerId })
              closeBubble()
              return
            } catch (paneError) {
              // 内嵌这条失败时回退到桌面端窗口。
              report('action-pane-failed', { detail: errorText(paneError), provider: providerId })
              setStatus('内嵌窗口失败，改用桌面端窗口…')
            }
          }

          payload = await postJson(send ? '/bubble-ask/send' : '/bubble-ask/prompt', {
            sessionId: currentSessionId,
            selection,
            question,
            ...providerField,
          })
          const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
          const actualName = typeof payload.providerName === 'string' && payload.providerName ? payload.providerName : providerName

          if (send) {
            if (payload.ok) {
              report('action-send-done', { stage: payload.stage, promptChars: prompt.length, provider: payload.provider || providerId })
              closeBubble()
              return
            }
            report('action-send-failed', { stage: payload.stage, detail: payload.detail, provider: providerId })
            setFailedPrompt(prompt)
            setStatus(`发送到 ${actualName} 失败（${payload.stage || '失败'}）：${payload.detail || ''} 可复制完整提问后手动粘贴。`)
            return
          }

          const copied = await copyText(prompt)
          report('action-copy-done', { copied, promptChars: prompt.length, provider: providerId })
          if (copied) {
            setStatus(`已复制 ${prompt.length} 字，在 ${actualName} 窗口按 Ctrl+V 粘贴。`)
            return
          }
          setFailedPrompt(prompt)
          setStatus(`复制失败（共 ${prompt.length} 字），可点「复制完整提问」重试。`)
        } catch (error) {
          report('action-error', { send, message: errorText(error), provider: providerId })
          // 请求失败时 Host 可能仍带回 prompt：保留它，卡片照常提供「复制完整提问」。
          const carried = error && error.payload && typeof error.payload.prompt === 'string' ? error.payload.prompt : ''
          if (carried) setFailedPrompt(carried)
          setStatus('失败：' + errorText(error))
        } finally {
          setBusy(false)
        }
      }

      async function copyFailedPrompt() {
        const ok = await copyText(failedPrompt)
        setStatus(ok ? `已复制 ${failedPrompt.length} 字。` : '复制仍然失败，请检查系统剪贴板权限。')
      }

      const style = h('style', { key: 'style' }, CSS)

      if (!bubble.visible) {
        return h('div', { className: 'dba-layer', 'data-dba-root': '1' }, style)
      }

      const quote = bubble.text.length > 220 ? bubble.text.slice(0, 220) + '…' : bubble.text

      const cardLeft = Math.min(Math.max(bubble.x - 180, 12), Math.max(window.innerWidth - 372, 12))
      const cardTop = Math.min(Math.max(bubble.y + 6, 12), Math.max(window.innerHeight - 200, 12))

      // 卡片只有一种形态：选中即出现，写问题 → 发送。服务方在设置页或右键面板里改。
      return h('div', { className: 'dba-layer', 'data-dba-root': '1' },
        style,
        h('div', {
          key: 'card',
          className: 'dba-card',
          style: { left: cardLeft + 'px', top: cardTop + 'px' },
          // 卡片内的按下都算操作卡片，选区重算在 600ms 内跳过。
          onMouseDown: () => { suppressRef.current = Date.now() + 600 },
        },
          h('div', { className: 'dba-head' },
            h('img', { className: 'dba-whale', src: WHALE_ICON, alt: '', draggable: false }),
            h('span', { className: 'dba-title' }, providerInfo ? `问 ${providerInfo.name}` : '问网页版（在设置里选）'),
            h('button', { className: 'dba-x', title: '关闭', onClick: closeBubble }, '✕')),
          h('div', { className: 'dba-body' },
            h('div', { className: 'dba-quote' }, quote),
            h('div', { className: 'dba-ask' },
              h('input', {
                className: 'dba-input',
                placeholder: '问题（留空则解释这段文字在上下文中的含义）',
                value: question,
                onChange: (event) => setQuestion(event.currentTarget.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.nativeEvent?.isComposing) {
                    event.preventDefault()
                    if (!busy) void runAsk(true)
                  }
                },
              }),
              h('button', {
                className: 'dba-send',
                disabled: busy,
                title: providerInfo ? `填入问题并发送到 ${providerInfo.name} 网页版` : '填入问题并发送到桌面端配置的网页版',
                onClick: () => { void runAsk(true) },
              }, busy ? '…' : '发送'))),
          status ? h('div', { className: 'dba-status' }, status) : null,
          failedPrompt
            ? h('div', { className: 'dba-foot' },
              h('button', {
                className: 'dba-btn',
                title: '复制整理好的完整提问，在网页版窗口里手动粘贴',
                onClick: () => { void copyFailedPrompt() },
              }, '复制完整提问'))
            : null))
    }

    //#region 内嵌网页版（插件自己开 guest，无需托盘 exe）
    /**
     * 插件经桌面端 lease 通道开一个 Electron guest，打开网页版并注入唯一驱动
     * （shared/driver.js），DeepSeek 的发送因此不依赖托盘 exe。
     *
     * 三项宿主约束（均来自实测）：
     *   1. 主进程在 `will-attach-webview` 里校验：src 必须是 `about:blank#<lease>`、
     *      partition 必须等于该 lease 的 partition，lease 只能从
     *      `dshDesktop.browser.acquire()` 取得；直接 createElement('webview') 会被 preventDefault。
     *   2. 主进程在 `did-attach-webview` 里等同一个 dom-ready 后读 URL 认领 lease
     *      （URL 必须仍是 `about:blank#<lease>`）。立即 loadURL 会让它读到的 URL 与
     *      lease 不匹配，guest 会被关闭，所以 dom-ready 之后要再等一拍。
     *   3. 站点按 UA 判定「使用环境异常」：UA 含 electron 或 window.process.type==='renderer'。
     *      lease 的 UA 带 Electron，必须用 `setUserAgent` 脱敏，且要在首个文档建立之前设置。
     *
     * 登录态：lease 的 partition 由主进程生成（`dsh-sidebar-browser-<uuid>`，无 `persist:`
     * 前缀、不落盘），DSH 重启后是全新分区。把网页版 localStorage 里 7 个认证键
     * （不到 1KB）写入新分区即可免登录，所以登录一次后存入 DSH 的凭证存储
     * （Host 半 `/bubble-ask/session`），下次建好 guest 再写回。
     */
    const PANE_WORKSPACE = 'bubble-ask-webview'
    const PANE_HOME = 'https://chat.deepseek.com/'
    /**
     * 跨分区够用的最小登录集：全新分区写入这几个键再 reload，能直接进主界面并正常对话。
     * 全量 29 个键共 37KB，大部分是 feature store 缓存，可再生，不保存。
     */
    const SESSION_KEYS = [
      'userToken',
      'settingsJwt',
      'smidV2',
      'deepseek-device-id:chat',
      '__appKit_userInfo',
      '__ds_remote_feature_did',
      'hif_leim_cached',
    ]

    /** 取主进程发放 lease 的桌面桥；非 `dsh-app://app` 主框架下返回 null。 */
    function takeDesktopBrowser() {
      const carrier = globalThis.dshDesktop
      if (!carrier || carrier.protocolVersion !== 1) return null
      return carrier.browser || null
    }

    /** 等 guest 的一个事件；超时抛错，避免整条链无声卡住。 */
    function waitGuest(target, name, timeoutMs) {
      return new Promise((resolve, reject) => {
        let settled = false
        let timer = 0
        const onEvent = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          target.removeEventListener(name, onEvent)
          resolve(true)
        }
        timer = setTimeout(() => {
          if (settled) return
          settled = true
          target.removeEventListener(name, onEvent)
          reject(new Error(`等待 ${name} 超时（${timeoutMs}ms）`))
        }, timeoutMs)
        target.addEventListener(name, onEvent)
      })
    }

    /** executeJavaScript 的结果统一成可读字符串。 */
    function asText(value) {
      if (value === undefined || value === null) return String(value)
      if (typeof value === 'string') return value
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    /** 给 Promise 加超时：guest 导航过程中 executeJavaScript 可能永远不兑现。 */
    function withTimeout(promise, timeoutMs, label) {
      return new Promise((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          reject(new Error(`${label} 超时（${timeoutMs}ms）`))
        }, timeoutMs)
        promise.then(
          (value) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(value)
          },
          (error) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            reject(error)
          },
        )
      })
    }

    /** Electron 在 guest 还没 attach / 刚 reload 时对 executeJavaScript 抛的错。 */
    const NOT_ATTACHED = /must be attached to the DOM|dom-ready event emitted/i

    /**
     * 提问卡片、内嵌面板与常驻开关之间的总线。
     *
     * 三者是三个独立的 slot 条目（`shell.overlay` 两条 + `conversation.session.header.utilities` 一条），
     * 互相拿不到 ref，所以用一个模块级单槽转交：
     *   - 面板挂载时登记 handler（发送）与 setOpen（开关）
     *   - 卡片点「发送」调 ask()；拿不到面板时回退到托盘应用
     *   - 标题栏右上角那颗小按钮调 toggle()，并订阅 open 显示当前状态
     */
    const paneBus = {
      handler: null,
      /** 面板当前是否展开：由面板维护，小按钮订阅它。 */
      open: false,
      setOpen: null,
      subscribers: new Set(),
      available() {
        return typeof this.handler === 'function' && takeDesktopBrowser() !== null
      },
      /** 让面板打开并发送；面板没就绪时抛错，由调用方决定是否降级。 */
      async ask(payload) {
        if (!this.available()) throw new Error('内嵌窗口不可用')
        return this.handler(payload)
      },
      /** 面板登记自己的开关实现。 */
      bind(setOpen) {
        this.setOpen = typeof setOpen === 'function' ? setOpen : null
      },
      /** 小按钮订阅展开状态；返回取消订阅。 */
      subscribe(fn) {
        this.subscribers.add(fn)
        fn(this.open)
        return () => this.subscribers.delete(fn)
      },
      /** 面板状态变化时广播。 */
      publish(open) {
        this.open = open
        for (const fn of this.subscribers) {
          try {
            fn(open)
          } catch {
            /* 订阅者报错不影响面板 */
          }
        }
      },
      /** 小按钮点击：有面板就切换，没面板就先把面板叫起来（它挂载后会登记）。 */
      toggle() {
        if (typeof this.setOpen === 'function') this.setOpen(!this.open)
      },
    }

    /** 从 Host 取驱动源码与服务方配置（都来自唯一真源，插件里没有第二份实现）。 */
    async function fetchDriver() {
      const response = await fetch('/bubble-ask/driver')
      const payload = await response.json()
      if (!payload || payload.ok !== true) throw new Error('拿不到驱动配置')
      const provider =
        (payload.providers || []).find((item) => item.id === payload.defaultId) || (payload.providers || [])[0]
      if (!provider) throw new Error('驱动配置里没有服务方')
      return {
        payload,
        cfg: {
          ...provider,
          genericComposerSelectors: payload.generic.composerSelectors,
          genericSendAriaLabels: payload.generic.sendAriaLabels,
        },
      }
    }

    /** 读出 Host 存的登录态（没有就 null）。 */
    async function readSavedSession() {
      try {
        const response = await fetch('/bubble-ask/session-data', { method: 'POST' })
        const payload = await response.json()
        if (!payload || payload.ok !== true) return null
        const data = payload.data
        if (!data || typeof data !== 'object') return null
        return Object.keys(data).length ? data : null
      } catch {
        return null
      }
    }

    /** 把登录态存进 Host（走 DSH 凭证存储）。 */
    async function saveSession(data) {
      const keys = Object.keys(data || {}).filter((key) => typeof data[key] === 'string' && data[key])
      if (!keys.length) return 0
      const body = { data: {} }
      for (const key of keys) body.data[key] = data[key]
      const response = await fetch('/bubble-ask/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json()
      if (!payload || payload.ok !== true) throw new Error(payload?.error || '保存登录态失败')
      return payload.saved || 0
    }

    /**
     * 内嵌网页版面板。
     *
     * 面板常驻挂载、默认收起：收起只是 `display:none`，guest 仍然活着，登录态留在分区里，
     * 下次发送不用重新加载。因为要先挂载才拿得到宿主容器，所以收起状态也渲染容器。
     */
    function WebPane() {
      const [open, setOpen] = useState(false)
      const [status, setStatus] = useState('未启动')
      const [busy, setBusy] = useState(false)
      const hostRef = useRef(null)
      const guestRef = useRef(null)
      /** 未完成的连接 Promise：连点两次发送时不要建两个 guest。 */
      const connectingRef = useRef(null)

      /** 建 guest 并导航到网页版；已连就直接复用。 */
      async function connect() {
        if (guestRef.current) return guestRef.current
        if (connectingRef.current) return connectingRef.current
        const task = (async () => {
          const bridge = takeDesktopBrowser()
          if (!bridge) throw new Error('宿主没有 dshDesktop.browser（不是桌面端主框架）')
          const host = hostRef.current
          if (!host) throw new Error('面板容器还没挂载')
          setStatus('正在创建内嵌窗口…')
          const reservation = await bridge.acquire(PANE_WORKSPACE)
          const element = document.createElement('webview')
          element.setAttribute('name', reservation.lease)
          element.setAttribute('partition', reservation.partition)
          element.setAttribute('allowpopups', '')
          element.setAttribute('src', `about:blank#${reservation.lease}`)
          const blankReady = waitGuest(element, 'dom-ready', 15000)
          host.appendChild(element)
          const held = {
            element,
            bridge,
            lease: reservation.lease,
            partition: reservation.partition,
            cfg: null,
            driver: '',
            /** 是否已经导航过（「开面板」与「发送」共用同一次导航）。 */
            navigated: false,
            /** 初始化中的 Promise，保证并发调用只跑一次。 */
            readyPromise: null,
          }
          guestRef.current = held
          await blankReady
          // 约束 2：等主进程认领完 lease（它读的是同一时刻的 URL）。
          await sleep(400)
          // 约束 3：UA 脱敏必须在首个文档建立之前。
          try {
            const ua = await element.executeJavaScript('navigator.userAgent', true)
            element.setUserAgent(
              String(ua)
                .replace(/\s*Electron\/[\d.]+/gi, '')
                .replace(/\s*@deepseek-ai\/[\w.-]+\/[\w.-]+/gi, ''),
            )
          } catch {
            /* UA 只影响提示条，失败不阻断发送 */
          }
          report('pane-connected', { partition: reservation.partition })
          return held
        })()
        connectingRef.current = task
        try {
          return await task
        } catch (error) {
          // 建窗口失败时释放 lease 并摘掉元素：留着会让下一次重试拿到一个坏掉的 guest。
          const broken = guestRef.current
          guestRef.current = null
          if (broken) {
            try {
              broken.element.remove()
            } catch {
              /* 元素可能还没挂上 */
            }
            try {
              Promise.resolve(broken.bridge.release(broken.lease)).catch(() => {})
            } catch {
              /* 主进程可能已重启 */
            }
          }
          report('pane-connect-failed', { detail: errorText(error) })
          throw error
        } finally {
          connectingRef.current = null
        }
      }

      /** 导航到网页版并等页面就绪。 */
      async function navigate(held) {
        const ready = waitGuest(held.element, 'dom-ready', 60000)
        held.element.loadURL(PANE_HOME)
        await ready
        await sleep(1800)
      }

      /** 页面当前是否已登录（离开登录页且 localStorage 已有内容）。 */
      async function probeLogin(held) {
        const raw = await evaluate(
          held,
          `JSON.stringify({
             href: location.href,
             needLogin: /sign_in|\\/login/i.test(location.href),
             keys: (() => { try { return localStorage.length } catch { return -1 } })(),
           })`,
        )
        try {
          return JSON.parse(asText(raw))
        } catch {
          return { href: '', needLogin: true, keys: -1 }
        }
      }

      /** 把登录态写进当前分区（必须已在目标站点上，否则 localStorage 是别处的）。 */
      async function writeSession(held, data) {
        const written = await evaluate(
          held,
          `(() => {
             const data = ${JSON.stringify(data || {})}
             let n = 0
             for (const key of Object.keys(data)) {
               try { localStorage.setItem(key, data[key]); n += 1 } catch {}
             }
             return String(n)
           })()`,
        )
        return Number(asText(written)) || 0
      }

      /** 抓取当前分区的登录态（只取认证键），并存进 Host。 */
      async function captureSession(held) {
        const raw = await evaluate(
          held,
          `(() => {
             const keys = ${JSON.stringify(SESSION_KEYS)}
             const data = {}
             for (const key of keys) {
               try { const value = localStorage.getItem(key); if (value) data[key] = value } catch {}
             }
             return JSON.stringify(data)
           })()`,
        )
        let data = {}
        try {
          data = JSON.parse(asText(raw))
        } catch {
          return 0
        }
        const saved = await saveSession(data)
        report('pane-session-saved', { keys: Object.keys(data), saved })
        return saved
      }

      /** 注入驱动（页面导航后注入的会丢，所以每次导航完都要重注）。 */
      async function injectDriver(held) {
        if (!held.driver) {
          const { payload, cfg } = await fetchDriver()
          held.driver = String(payload.driver || '')
          held.cfg = cfg
        }
        await evaluate(held, held.driver)
        return held.cfg
      }

      /**
       * 确保「已登录 + 驱动已注入」。
       *
       * 顺序：先导航（同源才能写 localStorage）→ 判断是否已登录 → 有存档则写入后
       * reload → 仍未登录就把窗口交给用户手动登录，并轮询到登录完成 → 注入驱动、
       * 保存一次登录态。
       *
       * 幂等：已就绪直接返回 cfg，正在执行则复用同一个 Promise。「手动开面板」和
       * 「卡片发送」都调用它，避免并发初始化。
       */
      async function ensureReady(held, onProgress) {
        if (held.cfg) return held.cfg
        if (held.readyPromise) return held.readyPromise
        held.readyPromise = (async () => {
          const step = onProgress || (() => {})
          if (!held.navigated) {
            step('正在打开网页版…')
            await navigate(held)
            held.navigated = true
          }
          let state = await probeLogin(held)
          report('pane-probe', state)
          if (state.needLogin) {
            const saved = await readSavedSession()
            if (saved) {
              step('正在恢复登录态…')
              const count = await writeSession(held, saved)
              report('pane-session-restored', { keys: Object.keys(saved), written: count })
              const ready = waitGuest(held.element, 'dom-ready', 60000)
              held.element.reload()
              await ready
              await sleep(2500)
              state = await probeLogin(held)
              report('pane-probe-after-restore', state)
            }
          }
          if (state.needLogin) {
            // 手动登录：窗口就在面板里，用户登完这里轮询到状态变化再继续。
            step('请在内嵌窗口里登录 DeepSeek')
            setOpen(true)
            const deadline = Date.now() + 10 * 60 * 1000
            while (Date.now() < deadline) {
              await sleep(3000)
              state = await probeLogin(held)
              if (!state.needLogin) break
            }
            if (state.needLogin) throw new Error('等待登录超时')
            await sleep(1500)
          }
          step('正在装载页面驱动…')
          const cfg = await injectDriver(held)
          // 登录成功后再保存一次，换分区后可免登录。
          try {
            const saved = await captureSession(held)
            if (saved) report('pane-session-cached', { saved })
          } catch {
            /* 存档失败不影响本次发送 */
          }
          step('就绪')
          return cfg
        })()
        try {
          return await held.readyPromise
        } catch (error) {
          // 失败要清掉，否则后续一次重试永远拿到同一个失败 Promise。
          held.readyPromise = null
          throw error
        }
      }

      /**
       * 在 guest 里求值，带「未 attach 就等」与超时。
       *
       * Electron 在 guest 刚建、或 reload 后 dom-ready 之前调用 executeJavaScript 会抛
       * `The WebView must be attached to the DOM and the dom-ready event emitted`。
       * 这不是致命错误，等一拍再重试。
       */
      async function evaluate(held, expression, timeoutMs) {
        const deadline = Date.now() + (timeoutMs || 20000)
        for (;;) {
          try {
            return await withTimeout(
              held.element.executeJavaScript(expression, true),
              Math.max(deadline - Date.now(), 1000),
              '页面求值',
            )
          } catch (error) {
            if (!NOT_ATTACHED.test(errorText(error)) || Date.now() >= deadline) throw error
            await sleep(300)
          }
        }
      }

      /** 在 guest 里求值：统一走驱动的只读接口，不在这里重写页面逻辑。 */
      async function callDriver(held, expression) {
        if (!held.cfg) throw new Error('驱动还没注入')
        return evaluate(held, expression(JSON.stringify(held.cfg)))
      }

      /** 填入并发送。返回 { ok, stage, detail }，不抛错，由卡片显示原因。 */
      async function fillAndSend(held, prompt) {
        const filled = await callDriver(
          held,
          (cfg) => `globalThis.__bubbleAskDriver.fill(${cfg}, ${JSON.stringify(prompt)})`,
        )
        const filledText = asText(filled)
        if (filledText === 'none') {
          return { ok: false, stage: 'no-composer', detail: '找不到输入框，页面可能还没加载完或已退出登录' }
        }
        await sleep(600)
        const clicked = await callDriver(held, (cfg) => `globalThis.__bubbleAskDriver.send(${cfg})`)
        const clickedText = asText(clicked)
        if (clickedText.startsWith('clicked')) return { ok: true, stage: 'sent', detail: clickedText }
        if (clickedText.startsWith('disabled')) {
          return { ok: false, stage: 'disabled', detail: '发送按钮处于禁用状态，文字可能没有填入' }
        }
        if (clickedText === 'nobutton') {
          return { ok: false, stage: 'no-button', detail: '找不到发送按钮（文字已填入，可按 Enter 手动发送）' }
        }
        return { ok: false, stage: 'failed', detail: clickedText }
      }

      /** 卡片点「发送」时走这里。 */
      async function handleAsk(payload) {
        setOpen(true)
        // 先让面板可见再建 guest：容器尺寸为 0 时 Electron 可能不建立视图。
        await sleep(120)
        setBusy(true)
        setStatus('正在准备内嵌网页版…')
        try {
          const held = await connect()
          const cfg = await ensureReady(held, setStatus)
          // 内嵌窗口只支持 DeepSeek；其它服务方由托盘应用发送（卡片已先判断）。
          if (payload && payload.providerId && payload.providerId !== cfg.id) {
            return { ok: false, stage: 'provider', detail: `内嵌窗口只支持 ${cfg.name}，其它服务方请用桌面端窗口` }
          }
          setStatus('正在填入并发送…')
          const result = await fillAndSend(held, String((payload && payload.prompt) || ''))
          report('pane-send', { ok: result.ok, stage: result.stage })
          setStatus(result.ok ? '已发送' : `失败：${result.detail}`)
          return result
        } catch (error) {
          const detail = errorText(error)
          report('pane-send-error', { detail })
          setStatus(`失败：${detail}`)
          return { ok: false, stage: 'error', detail }
        } finally {
          setBusy(false)
        }
      }

      // 登记到总线：卡片据此判断走内嵌窗口还是托盘应用；小按钮据此开关面板。
      useEffect(() => {
        paneBus.handler = handleAsk
        paneBus.bind(setOpen)
        // 上报一次可用性：/health 的 diag 可看出「发送会走哪条路」。
        report('pane-bus-ready', { available: paneBus.available() })
        return () => {
          if (paneBus.handler === handleAsk) paneBus.handler = null
          paneBus.bind(null)
        }
      }, [])

      // 展开状态广播给标题栏右上角那颗小按钮（它据此切换图标状态）。
      useEffect(() => {
        paneBus.publish(open)
      }, [open])

      /**
       * 手动展开面板时初始化内嵌窗口。
       *
       * 只显示一个空 div 时 guest 还没建，用户看到的是空白，所以这里走与发送相同的
       * 初始化（connect → ensureReady），只是不填不发。已初始化时直接返回。
       */
      useEffect(() => {
        if (!open) return
        let cancelled = false
        setBusy(true)
        void (async () => {
          try {
            await sleep(120) // 等这一帧渲染完，容器才有尺寸
            if (cancelled) return
            setStatus('正在准备内嵌网页版…')
            const held = await connect()
            if (cancelled) return
            await ensureReady(held, setStatus)
            if (!cancelled) report('pane-opened', {})
          } catch (error) {
            if (!cancelled) {
              const detail = errorText(error)
              setStatus(`失败：${detail}`)
              report('pane-open-error', { detail })
            }
          } finally {
            if (!cancelled) setBusy(false)
          }
        })()
        return () => {
          cancelled = true
        }
      }, [open])

      // 卸载时释放 lease 并摘除元素，避免留下悬挂的 guest。
      useEffect(() => function () {
        const held = guestRef.current
        guestRef.current = null
        if (!held) return
        try {
          held.element.remove()
        } catch {
          /* 元素可能已被 React 摘掉 */
        }
        try {
          Promise.resolve(held.bridge.release(held.lease)).catch(() => {})
        } catch {
          /* 主进程可能已重启 */
        }
      }, [])

      /** 清除 Host 保存的登录态（换账号或凭据失效时使用）。 */
      async function forgetSession() {
        try {
          await fetch('/bubble-ask/session', { method: 'DELETE' })
          setStatus('已清除保存的登录态')
          report('pane-session-forgotten', {})
        } catch (error) {
          setStatus('清除失败：' + errorText(error))
        }
      }

      return h('div', {
        key: 'pane',
        className: 'dba-pane',
        'data-dba-root': '1',
        // 收起只隐藏：guest 保持存活，登录态与页面状态都不丢。
        style: { display: open ? 'flex' : 'none' },
      },
        h('div', { className: 'dba-pane-head' },
          h('span', { className: 'dba-pane-title' }, 'DeepSeek'),
          h('span', { className: 'dba-pane-status', title: status }, status),
          h('button', {
            className: 'dba-pane-btn',
            onClick: () => setOpen(false),
            title: '收起（窗口保持存活）',
          }, '收起'),
          h('button', {
            className: 'dba-pane-btn',
            disabled: busy,
            title: '清掉保存的登录态，下次要重新登录',
            onClick: () => { void forgetSession() },
          }, '清除登录')),
        h('div', { className: 'dba-pane-host', ref: hostRef }))
    }

    /**
     * 鲸鱼图标：`chrome-extension/tools/art/whale.png`（品牌艺术图）等比缩到 44×27 的内嵌副本。
     * 44px 用于 2× 屏下按 22px 显示；内嵌为 data URL，因为 Client 半拿不到包内资源 URL。
     */
    const WHALE_ICON = 'data:image/png;base64,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'

    /**
     * 会话标题栏右上角的常驻小按钮：不选文字也能开关内嵌面板。
     *
     * 位置是 `conversation.session.header.utilities`（右对齐的会话工具位，DSH 把
     * 「打开方式」「定时任务」「下载会话日志」放在这里）。没有桌面桥时（在浏览器里
     * 打开 GUI）不渲染该按钮，因为那种环境下内嵌窗口不可用。
     */
    function PaneToggle() {
      const [open, setOpen] = useState(paneBus.open)
      const [supported, setSupported] = useState(false)

      useEffect(() => {
        // 桌面桥只在 dsh-app://app 主框架里存在；没有就不显示按钮。
        const ok = takeDesktopBrowser() !== null
        setSupported(ok)
        report('pane-toggle-mount', { supported: ok })
        return paneBus.subscribe(setOpen)
      }, [])

      if (!supported) return null
      const label = open ? '收起 DeepSeek 内嵌窗口' : '打开 DeepSeek 内嵌窗口'
      return h('button', {
        type: 'button',
        className: 'dba-toggle' + (open ? ' dba-toggle-on' : ''),
        title: label + '（右键设置）',
        'aria-label': label,
        'aria-pressed': open,
        'data-dba-pane-toggle': '1',
        onClick: () => {
          report('pane-toggle-click', { open: !paneBus.open })
          paneBus.toggle()
        },
        // 右键打开设置面板（切换服务方），左键行为不变
        onContextMenu: (event) => {
          event.preventDefault()
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          report('pane-toggle-context', { open: !settingsBus.open })
          settingsBus.toggle(rect.right, rect.bottom + 8)
        },
      }, h('img', {
        className: 'dba-toggle-whale',
        src: WHALE_ICON,
        alt: '',
        draggable: false,
      }))
    }
    //#endregion

    //#region 设置页（划词卡片不再承载这些配置）
    /**
     * 「设置 › Bubble Ask」。
     *
     * 划词卡片只保留「写问题 + 发送」，服务方等配置放到 DSH 设置面板的
     * 「Bubble Ask」页。改完立即生效（provider 从存储派生）。
     */
    function BubbleSettings() {
      const { provider, providers, note, choose } = useProviderChoice()

      return h('div', { className: 'dba-settings' },
        h('style', { key: 'style' }, CSS),
        h('div', { className: 'dba-set-title' }, '划词提问的发送目标'),
        h('div', { className: 'dba-set-row' },
          h('span', { className: 'dba-set-label' }, '发到'),
          h(ProviderSelect, { provider, providers, onChange: choose })),
        h('div', { className: 'dba-set-hint' },
          'DeepSeek 由插件自己的内嵌窗口发送；其余服务方由桌面端托盘应用发送。'),
        note ? h('div', { className: 'dba-set-hint' }, note) : null,
        h('div', { className: 'dba-set-hint' },
          '划词后直接出现提问卡片：写问题回车发送，按 Esc 取消。'),
        h('div', { className: 'dba-set-hint' },
          'API Key、提示词模板、热键在桌面端托盘图标的「设置」里；本页只设置发送目标。'),
        h('div', { className: 'dba-set-hint' },
          '会话标题栏右上角鲸鱼按钮的右键菜单提供同一组设置。'))
    }

    /**
     * 右键鲸鱼按钮弹出的设置面板。
     *
     * 画在 `shell.overlay` 里：标题栏那行 overflow:clip，就地弹会被裁掉。锚点坐标
     * 由按钮经 settingsBus 传入。
     */
    function SettingsPopover() {
      const [state, setState] = useState(settingsBus.snapshot())
      const { provider, providers, note, choose } = useProviderChoice()

      useEffect(() => settingsBus.subscribe(setState), [])

      useEffect(() => {
        if (!state.open) return
        const onDown = (event) => {
          const target = event.target
          if (target && target.closest && (target.closest('[data-dba-settings]') || target.closest('[data-dba-pane-toggle]'))) return
          settingsBus.hide()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') settingsBus.hide()
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [state.open])

      if (!state.open) return null
      const width = 268
      const left = Math.min(Math.max(8, state.x - width), Math.max(8, window.innerWidth - width - 8))
      const top = Math.min(Math.max(8, state.y), Math.max(8, window.innerHeight - 210))
      return h('div', { className: 'dba-layer', 'data-dba-root': '1' },
        h('style', { key: 'style' }, CSS),
        h('div', {
          className: 'dba-pop',
          'data-dba-settings': '1',
          style: { left: left + 'px', top: top + 'px', width: width + 'px' },
        },
          h('div', { className: 'dba-pop-title' }, 'Bubble Ask'),
          h('div', { className: 'dba-set-row' },
            h('span', { className: 'dba-set-label' }, '发到'),
            h(ProviderSelect, { provider, providers, onChange: choose })),
          note ? h('div', { className: 'dba-set-hint' }, note) : null,
          h('div', { className: 'dba-set-hint' }, 'API Key / 提示词模板 / 热键：桌面端托盘图标的「设置」。'),
          h('div', { className: 'dba-set-hint' }, '左键开关内嵌窗口，右键打开这个面板'))
      )
    }
    //#endregion

    return {
      inject: ['slots'],
      apply(context) {
        // 设置页：服务方等配置从划词卡片里搬到这里
        context.slots.inject('settings.section', () => context.slots.register({
          name: 'settings.section',
          id: 'bubble-ask',
          order: 25,
          label: 'Bubble Ask',
        }, BubbleSettings))
        context.slots.inject('conversation.input.dock', () => context.slots.register({
          name: 'conversation.input.dock',
          id: 'bubble-ask-session',
          order: 900,
        }, SessionProbe))
        context.slots.inject('shell.overlay', () => context.slots.register({
          name: 'shell.overlay',
          id: 'bubble-ask',
          order: 900,
        }, BubbleAsk))
        // 内嵌网页版面板：插件自己经 lease 通道开 guest，发送不再需要托盘 exe。
        context.slots.inject('shell.overlay', () => context.slots.register({
          name: 'shell.overlay',
          id: 'bubble-ask-webview',
          order: 901,
        }, WebPane))
        // 右键鲸鱼按钮弹出的设置面板（画在 overlay 里，避免被标题栏裁掉）
        context.slots.inject('shell.overlay', () => context.slots.register({
          name: 'shell.overlay',
          id: 'bubble-ask-settings',
          order: 902,
        }, SettingsPopover))
        // 会话标题栏右上角的常驻开关：不选文字也能开/关内嵌面板。
        context.slots.inject('conversation.session.header.utilities', () => context.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'bubble-ask-pane-toggle',
          order: 10,
        }, PaneToggle))
        report('loaded', { href: window.location.href })
      },
    }
  },
})
