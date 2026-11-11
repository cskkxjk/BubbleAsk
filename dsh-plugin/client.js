/**
 * Bubble Ask —— Client 半。
 *
 * 两件事：
 *   1. 在会话里盯住文字选区（鼠标松开 / 键盘选择都算）；
 *   2. 在选区旁边浮出一个小气泡，点下去把「精简会话轨迹 + 选中文字 + 你的问题」
 *      交给 Host 拼好，再由托盘应用按所选服务方（默认 DeepSeek，可选千问/豆包/
 *      ChatGPT/Gemini/Grok）注入网页版并发送。
 *
 * 刻意**不**在右侧栏渲染任何东西：
 *   - 装 DeepSeek 页面做不到（Electron guest 的分区不持久，每次重启要重新登录，
 *     且网页版会把 guest 判定为「使用环境异常」；原生窗口是独立 OS 窗口，无法内嵌）。
 *   - 所以再包一层「控制面板」也只是中间层。成功时它多余，失败时的价值
 *     用一个「复制全文」按钮就够了。
 *
 * 结果直接显示在气泡里：成功即收起，失败则留在原地并给出复制提问全文的入口。
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
    /** 上次在气泡里选的服务方，跨页面刷新记住。 */
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

    /** 会话作用域的探针：只登记 id，不渲染任何东西。 */
    function SessionProbe(props) {
      const id = props && (props.sessionId || (props.session && props.session.id))
      useEffect(() => retainSession(id), [id])
      return null
    }

    const CSS = [
      '.dba-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483000}',
      '.dba-pill{position:fixed;pointer-events:auto;display:inline-flex;align-items:center;gap:5px;',
      'height:28px;padding:0 11px;border-radius:14px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));',
      'background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);',
      'font:var(--dsw-font-xxs-12,12px/1.4 system-ui);box-shadow:0 4px 14px rgba(0,0,0,.14);cursor:pointer;',
      'transform:translate(-50%,0);white-space:nowrap}',
      '.dba-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
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
      '.dba-input{box-sizing:border-box;width:100%;height:30px;border-radius:8px;padding:0 9px;',
      'border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);',
      'color:var(--dsw-alias-label-primary,#111);font:inherit;outline:none}',
      '.dba-input:focus{border-color:var(--dsw-alias-label-accent,#247bbf)}',
      '.dba-pick{display:flex;align-items:center;gap:6px}',
      '.dba-pick-label{color:var(--dsw-alias-label-tertiary,#888);white-space:nowrap}',
      '.dba-select{flex:auto;min-width:0;height:28px;border-radius:8px;padding:0 6px;',
      'border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);',
      'color:var(--dsw-alias-label-primary,#111);font:inherit;outline:none}',
      '.dba-select:disabled{opacity:.55;cursor:default}',
      '.dba-foot{display:flex;align-items:center;gap:8px;padding:0 10px 10px;flex-wrap:wrap}',
      '.dba-btn{pointer-events:auto;height:30px;padding:0 12px;border-radius:8px;cursor:pointer;font:inherit;',
      'border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent;',
      'color:var(--dsw-alias-label-primary,#111)}',
      '.dba-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dba-btn.dba-primary{border-color:transparent;background:var(--dsw-alias-label-accent,#247bbf);color:#fff}',
      '.dba-btn.dba-primary:hover{filter:brightness(1.06)}',
      '.dba-btn:disabled{opacity:.55;cursor:default}',
      '.dba-status{padding:0 10px 9px;color:var(--dsw-alias-label-tertiary,#888);min-height:14px;word-break:break-word}',
      // ---- webview 内嵌验证（spike）----
      '.dba-wv{position:fixed;right:12px;bottom:12px;width:520px;height:calc(100vh - 96px);pointer-events:auto;',
      'display:flex;flex-direction:column;border-radius:12px;overflow:hidden;',
      'border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));',
      'background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);',
      'box-shadow:0 16px 40px rgba(0,0,0,.22);font:var(--dsw-font-xxs-12,12px/1.5 system-ui)}',
      '.dba-wv-head{display:flex;align-items:center;gap:6px;padding:7px 9px;flex:none;',
      'border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}',
      '.dba-wv-title{font-weight:600;flex:none}',
      '.dba-wv-status{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'color:var(--dsw-alias-label-tertiary,#888)}',
      '.dba-wv-tools{display:flex;gap:6px;padding:6px 9px;flex:none;flex-wrap:wrap;',
      'border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}',
      '.dba-wv-btn{height:24px;padding:0 9px;border-radius:6px;cursor:pointer;font:inherit;',
      'border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent;',
      'color:var(--dsw-alias-label-primary,#111)}',
      '.dba-wv-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dba-wv-btn:disabled{opacity:.5;cursor:default}',
      '.dba-wv-host{flex:auto;min-height:0;display:flex;background:#fff}',
      '.dba-wv-host webview{flex:auto;width:100%;height:100%;border:0}',
      '.dba-wv-pre{margin:0;padding:7px 9px;flex:none;max-height:88px;overflow:auto;white-space:pre-wrap;',
      'word-break:break-word;font:11px/1.45 ui-monospace,Consolas,monospace;',
      'color:var(--dsw-alias-label-secondary,#555);background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));',
      'border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}',
      '.dba-spike{position:fixed;left:12px;bottom:12px;pointer-events:auto;height:26px;padding:0 10px;',
      'border-radius:13px;cursor:pointer;font:var(--dsw-font-xxs-12,12px/1.4 system-ui);',
      'border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));',
      'background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#555);',
      'box-shadow:0 2px 8px rgba(0,0,0,.1)}',
      '.dba-spike:hover{color:var(--dsw-alias-label-primary,#111)}',
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

    /** POST 一个 JSON 请求；HTTP 非 2xx 才抛错（`ok:false` 的语义留给调用方判断）。 */
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
        throw new Error(payload.error || payload.detail || `请求失败（HTTP ${response.status}）`)
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

    /** 气泡本体。 */
    function BubbleAsk() {
      const [bubble, setBubble] = useState({ visible: false, expanded: false, text: '', x: 0, y: 0 })
      const [question, setQuestion] = useState('')
      const [status, setStatus] = useState('')
      const [busy, setBusy] = useState(false)
      /** 失败时留着完整提问，给「复制全文」兜底。 */
      const [failedPrompt, setFailedPrompt] = useState('')
      /** 当前要发到的网页版服务方；默认沿用上次选择，其次是插件默认（DeepSeek）。 */
      const [provider, setProvider] = useState(() => readStoredProvider() || 'deepseek')
      const [providers, setProviders] = useState(PROVIDERS)
      /** 抑制选区重算的截止时间戳：点了气泡按钮后，同一次手势的 mouseup 不该把卡片打回去。 */
      const suppressRef = useRef(0)
      const bubbleRef = useRef(bubble)
      bubbleRef.current = bubble
      const providerInfo = providers.find((item) => item.id === provider) || providers[0] || PROVIDERS[0]

      useEffect(() => {
        /** 最近一次显示气泡的时间：拖选文字常伴随滚动，刚弹出时不要被滚动藏掉。 */
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
              setBubble((prev) => ({ ...prev, visible: false, expanded: false }))
            }
            return
          }
          const anchor = selection.anchorNode
          const anchorElement = anchor && anchor.nodeType === 1 ? anchor : (anchor && anchor.parentElement) || null
          if (anchorElement && anchorElement.closest && anchorElement.closest('input, textarea, [contenteditable="true"]')) return
          // 卡片已经展开：不要用同一个选区把状态覆盖回去（这是「点了没反应」的真正原因）。
          if (bubbleRef.current.visible && bubbleRef.current.expanded) {
            report('selection-ignored-expanded', { chars: text.length })
            return
          }
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
          setBubble({ visible: true, expanded: false, text: text.slice(0, 4000), x, y })
          setStatus('')
          setFailedPrompt('')
          report('selection-shown', { chars: text.length, x: Math.round(x), y: Math.round(y) })
        }
        const onMouseUp = (event) => window.setTimeout(() => readSelection(event), 0)
        const onKeyUp = (event) => {
          if (event.shiftKey || event.key === 'Shift') readSelection(event)
        }
        // 只有「用户自己滚动」且已经展开卡片时才收起；刚弹出的 800ms 内一律不动。
        const onScroll = () => {
          if (Date.now() - shownAt < 800) return
          setBubble((prev) => (prev.visible && prev.expanded ? { ...prev, visible: false, expanded: false } : prev))
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

      /**
       * 与 Host 同步服务方列表/默认值（只同步一次，失败不影响使用）：
       *   - 桌面端 < 2.1.0（health.app.providerSwitchable=false）会忽略 provider 字段，
       *     下拉框只保留 DeepSeek，避免选了别家到发送时才被拒；
       *   - 新桌面端按它支持的 id 列表取交集；
       *   - 没手动选过服务方时，沿用 Host 配置的默认值。
       */
      useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const response = await fetch('/bubble-ask/health')
            if (!response.ok) return
            const payload = await response.json()
            if (cancelled || !payload || payload.ok !== true) return
            const app = payload.app || {}
            const switchable = app.providerSwitchable === true
            const ids = switchable && Array.isArray(app.providers) ? app.providers : []
            const known = switchable
              ? (ids.length > 0 ? PROVIDERS.filter((item) => ids.includes(item.id)) : PROVIDERS)
              : PROVIDERS.filter((item) => item.id === 'deepseek')
            if (known.length > 0) setProviders(known)
            const configured = payload.settings && typeof payload.settings.provider === 'string'
              ? payload.settings.provider
              : ''
            if (!readStoredProvider() && known.some((item) => item.id === configured)) setProvider(configured)
          } catch {
            /* health 不可用：保留内置列表与本地选择 */
          }
        })()
        return () => { cancelled = true }
      }, [])

      // 桌面端不支持当前选择时（例如从新版本回退），自动落到第一项，避免下拉框显示空白。
      useEffect(() => {
        if (providers.length > 0 && !providers.some((item) => item.id === provider)) {
          const fallback = providers[0].id
          setProvider(fallback)
          storeProvider(fallback)
        }
      }, [providers, provider])

      function closeBubble() {
        setBubble({ visible: false, expanded: false, text: '', x: 0, y: 0 })
        setFailedPrompt('')
        setStatus('')
      }

      /**
       * 走一次完整流程：Host 组上下文 → 托盘应用注入并发送。
       * @param send true 直接发送；false 只整理并把完整提问复制到剪贴板（手动粘贴用）
       */
      async function runAsk(send) {
        const selection = bubbleRef.current.text
        // 本次请求用哪家服务方：用点击时的选择，避免异步期间下拉被改。
        const providerId = provider
        const providerName = providerInfo.name
        setBusy(true)
        setStatus(send ? `正在整理轨迹并发送到 ${providerName}…` : `正在整理会话轨迹（发到 ${providerName}）…`)
        setFailedPrompt('')
        report(send ? 'action-send-start' : 'action-copy-start', {
          sessionId: currentSessionId,
          selectionChars: selection.length,
          provider: providerId,
        })
        try {
          const payload = await postJson(send ? '/bubble-ask/send' : '/bubble-ask/prompt', {
            sessionId: currentSessionId,
            selection,
            question,
            provider: providerId,
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
            setStatus(`没能发送到 ${actualName}（${payload.stage || '失败'}）：${payload.detail || ''} 可复制全文后到窗口里粘贴。`)
            return
          }

          const copied = await copyText(prompt)
          report('action-copy-done', { copied, promptChars: prompt.length, provider: providerId })
          if (copied) {
            setStatus(`已复制 ${prompt.length} 字，去 ${actualName} 窗口按 Ctrl+V 粘贴。`)
            return
          }
          setFailedPrompt(prompt)
          setStatus(`复制失败（共 ${prompt.length} 字），可点「复制全文」重试。`)
        } catch (error) {
          report('action-error', { send, message: errorText(error), provider: providerId })
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

      if (!bubble.expanded) {
        return h('div', { className: 'dba-layer', 'data-dba-root': '1' },
          style,
          h('button', {
            key: 'pill',
            className: 'dba-pill',
            style: { left: bubble.x + 'px', top: bubble.y + 'px' },
            title: `把这段文字和会话轨迹一起问 ${providerInfo.name} 网页版`,
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => {
              // 先立起抑制窗口，再展开：同一次点击的 mouseup 会把 expanded 覆盖回 false。
              suppressRef.current = Date.now() + 600
              report('pill-click', { selectionChars: bubble.text.length })
              setBubble((prev) => ({ ...prev, expanded: true }))
            },
          }, h('span', { 'aria-hidden': true }, '💬'), h('span', null, '问这段')))
      }

      const cardLeft = Math.min(Math.max(bubble.x - 180, 12), Math.max(window.innerWidth - 372, 12))
      const cardTop = Math.min(Math.max(bubble.y + 6, 12), Math.max(window.innerHeight - 200, 12))

      return h('div', { className: 'dba-layer', 'data-dba-root': '1' },
        style,
        h('div', {
          key: 'card',
          className: 'dba-card',
          style: { left: cardLeft + 'px', top: cardTop + 'px' },
          // 卡片里任何一次按下都算「正在操作气泡」，别再让选区重算把卡片打回去。
          onMouseDown: () => { suppressRef.current = Date.now() + 600 },
        },
          h('div', { className: 'dba-head' },
            h('span', { className: 'dba-title' }, `Bubble Ask · 带上会话上下文问 ${providerInfo.name}`),
            h('button', { className: 'dba-x', title: '关闭', onClick: closeBubble }, '✕')),
          h('div', { className: 'dba-body' },
            h('div', { className: 'dba-quote' }, quote),
            h('div', { className: 'dba-pick' },
              h('span', { className: 'dba-pick-label' }, '发到'),
              h('select', {
                className: 'dba-select',
                value: provider,
                disabled: busy,
                title: '选择要发送到的网页版服务方（由桌面端窗口打开并发送）',
                onChange: (event) => {
                  const next = event.currentTarget.value
                  setProvider(next)
                  storeProvider(next)
                  report('provider-change', { provider: next })
                },
              }, providers.map((item) => h('option', { key: item.id, value: item.id }, item.name)))),
            h('input', {
              className: 'dba-input',
              placeholder: '想问什么？（留空＝解释它在当前上下文中是什么意思）',
              value: question,
              onChange: (event) => setQuestion(event.currentTarget.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.nativeEvent?.isComposing) {
                  event.preventDefault()
                  if (!busy) void runAsk(true)
                }
              },
            })),
          h('div', { className: 'dba-foot' },
            h('button', {
              className: 'dba-btn dba-primary',
              disabled: busy,
              title: `原生窗口注入并自动发送到 ${providerInfo.name}（带完整上下文）`,
              onClick: () => { void runAsk(true) },
            }, busy ? '处理中…' : `发送到 ${providerInfo.name}`),
            h('button', {
              className: 'dba-btn',
              disabled: busy,
              title: `只整理上下文并复制完整提问，自己去 ${providerInfo.name} 窗口里粘贴`,
              onClick: () => { void runAsk(false) },
            }, '复制提问'),
            failedPrompt
              ? h('button', {
                className: 'dba-btn',
                title: '再次复制上一次整理好的完整提问',
                onClick: () => { void copyFailedPrompt() },
              }, '复制全文')
              : null),
          h('div', { className: 'dba-status' }, status)))
    }

    //#region webview 内嵌验证（spike，验完即删）
    /**
     * 目的：验证「插件自己开一个 Electron guest 打开 chat.deepseek.com，并注入唯一驱动」
     * 这条路径是否真的可行 —— 走得通，插件就能脱离桌面端 exe。
     *
     * 主进程在 `will-attach-webview` 里设了门禁：src 必须是 `about:blank#<lease>`、
     * partition 必须等于该 lease 的 partition、lease 只能从 `dshDesktop.browser.acquire()` 拿。
     * 所以这里严格照 `@deepseek-ai/dsh-client-ui-sidebar-browser` 的顺序建元素：
     * 先设属性再挂 DOM，且只有 `dsh-app://app` 主框架拿得到那座桥。
     */
    const SPIKE_WORKSPACE = 'bubble-ask-spike'
    const SPIKE_HOME = 'https://chat.deepseek.com/'

    /** 取主进程发放 lease 的桌面桥；非 dsh-app://app 主框架下不存在。 */
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

    /** 内嵌 webview 验证面板：默认展开，自检跑完再收。 */
    function WebviewSpike() {
      // 默认展开：guest 在 0 尺寸容器里可能不初始化，自检要的是真实布局。
      const [open, setOpen] = useState(true)
      const [status, setStatus] = useState('未连接')
      const [log, setLog] = useState('')
      const [busy, setBusy] = useState(false)
      const hostRef = useRef(null)
      const guestRef = useRef(null)
      /** 自检只自动跑一次，避免每次重渲染都开一个 guest。 */
      const autoRanRef = useRef(false)

      function push(line) {
        setLog((prev) => (prev ? `${prev}\n${line}` : line))
      }

      /**
       * 自动跑一次自检并上报。
       *
       * 目的：把「能不能用」这个问题变成可读的结论，而不是靠人看面板。
       * 只跑一次（autoRanRef），失败也不重试 —— 重试会把 diag 刷满。
       */
      useEffect(() => {
        if (autoRanRef.current) return
        autoRanRef.current = true
        const timer = setTimeout(() => {
          void run('自检', async () => {
            const ok = await selftest()
            // 自检只证明「能读写 DOM」，不证明「能对话」。
            // 已经登录（输入框在）时顺便真发一条，把最后这个未知项也消掉。
            if (ok && guestRef.current) await sendProbe()
          })
        }, 1200)
        return () => clearTimeout(timer)
      }, [])

      /** 退出时释放 lease 并摘掉元素，避免留下悬挂的 guest。 */
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

      /**
       * 一条龙自检：每一步的结果都打成一行上报。
       *
       * 为什么要这样：执行结果只有页面里的这个面板能看到，而我只能读 Host 的 /diag。
       * 把它做成一个按钮，用户点一次，我就能从 diag 里拿到整条链路的结论，
       * 不用靠截图或口述。
       */
      async function selftest() {        const steps = []
        const step = async (name, task) => {
          try {
            const value = await task()
            steps.push({ step: name, ok: true, value: asText(value).slice(0, 600) })
            push(`✓ ${name} → ${asText(value).slice(0, 200)}`)
            return { ok: true, value }
          } catch (error) {
            const message = errorText(error)
            steps.push({ step: name, ok: false, value: message.slice(0, 600) })
            push(`✗ ${name} → ${message}`)
            report('wv-selftest', { steps })
            throw error
          }
        }

        setStatus('自检中…')
        setLog('')
        report('wv-selftest-start', { href: window.location.href })

        const bridge = takeDesktopBrowser()
        if (!bridge) {
          report('wv-selftest', {
            steps: [{ step: 'bridge', ok: false, value: '没有 dshDesktop.browser' }],
          })
          throw new Error('宿主没有 dshDesktop.browser')
        }
        await step('bridge', () => `acquire=${typeof bridge.acquire} release=${typeof bridge.release}`)

        await step('连接 guest', async () => {
          if (guestRef.current) return '已连接，复用'
          await connect()
          return '已新建'
        })
        await step('lease', () => guestRef.current && guestRef.current.lease)
        // partition 多次加载之间是否一致 —— 决定「刷新页面后要不要重登」。
        await step('partition', () => (guestRef.current && guestRef.current.partition) || '(未知)')
        const element = held().element
        await step('executeJavaScript 可用', () => `${typeof element.executeJavaScript}`)
        // guest 有没有真实尺寸：0 尺寸的话网页渲染了用户也看不见。
        await step('guest 尺寸', () => {
          const rect = element.getBoundingClientRect()
          return `${Math.round(rect.width)}x${Math.round(rect.height)}`
        })
        await step('页面信息', () => element.executeJavaScript(
          'JSON.stringify({href:location.href,title:document.title,ua:navigator.userAgent,ready:document.readyState})',
          true,
        ))

        // 注入驱动（幂等：driver 自己在已存在时直接 return）
        const { payload, cfg } = await fetchDriver()
        await step('取驱动配置', () => `driver=${String(payload.driver || '').length}B provider=${cfg.id}`)
        await step('注入驱动', () => element.executeJavaScript(String(payload.driver || ''), true))
        await step('驱动存在', () => element.executeJavaScript('String(!!globalThis.__bubbleAskDriver)', true))
        guestRef.current.cfg = cfg

        const json = JSON.stringify(cfg)
        await step('findComposer', () => element.executeJavaScript(
          `String(globalThis.__bubbleAskDriver.findComposer(${json}) ? 'found' : 'null')`,
          true,
        ))
        await step('state', () => element.executeJavaScript(
          `globalThis.__bubbleAskDriver.state(${json})`,
          true,
        ))
        await step('登录态', () => element.executeJavaScript(
          `String(globalThis.__bubbleAskDriver.isLoginUrl(${json}))`,
          true,
        ))
        // 填入但不发送：验证「能驱动」即可，不要在真实站点上乱发消息。
        await step('fill', () => element.executeJavaScript(
          `globalThis.__bubbleAskDriver.fill(${json}, 'Bubble Ask 内嵌自检')`,
          true,
        ))
        await step('composerState', () => element.executeJavaScript(
          `globalThis.__bubbleAskDriver.composerState(${json})`,
          true,
        ))

        // 登录页能不能真的操作：站点可能判定环境异常，把交互静默拦掉。
        // 这里只读，不点任何按钮。
        await step('登录页可操作性', () => element.executeJavaScript(
          `(() => {
             const inputs = [...document.querySelectorAll('input')]
             const buttons = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null)
             const text = document.body.innerText || ''
             const hit = (text.match(/环境异常|verify|captcha|安全验证/gi) || [])
             return JSON.stringify({
               inputs: inputs.map(i => ({ type: i.type, visible: i.offsetParent !== null, disabled: i.disabled, editable: !i.readOnly && !i.disabled })),
               visibleButtons: buttons.length,
               bodyChars: text.length,
               hitWords: [...new Set(hit.map(s => s.toLowerCase()))],
               bodyHead: text.slice(0, 240).replace(/\\s+/g, ' '),
               title: document.title,
             })
           })()`,
          true,
        ))

        // 提示条：站点判定 === UA 含 "electron" || window.process.type==="renderer"，
        // 命中后弹一个「使用环境异常」Modal；关闭后写 localStorage 记住。
        //
        // 关键：先清掉 dismissFlag 再重载，才能分辨是「UA 脱敏生效」还是
        // 「关过的弹窗不再弹」。只清自己写的那个键。
        await step('提示条诊断', () => element.executeJavaScript(
          `(() => {
             const text = document.body.innerText || ''
             let flag = null
             try { flag = localStorage.getItem('closeUnsafeEnvWarn') } catch {}
             return JSON.stringify({
               modalVisible: /使用环境异常|Abnormal usage environment/.test(text),
               dismissFlag: flag,
               uaHasElectron: navigator.userAgent.toLowerCase().includes('electron'),
               hasProcess: 'process' in window,
             })
           })()`,
          true,
        ))

        // 登录页只在「没登录」时出现。记下来，登录完成后自动再跑一次，
        // 这样我不用问「登进去了吗」——结果自己会出现在 diag 里。
        const url = await element.executeJavaScript('location.href', true)
        const needLogin = /sign_in|\/login/i.test(String(url))
        report('wv-selftest', { steps, needLogin, url })

        if (needLogin) {
          setStatus('等待登录…（登录后自动复检）')
          waitForChat(element, cfg, json)
          return false
        }
        setStatus('自检完成')
        return true
      }

      /**
       * 登录页 → 主界面：轮询到输入框出现为止，然后自动复检一次并上报。
       *
       * 轮询放在 guest 里执行，不在渲染进程里堆定时器：
       * 一次 executeJavaScript 就能等到「输入框出现」，跨页面跳转也不会失效。
       */
      async function waitForChat(element, cfg, json) {
        guestRef.current.waiting = true
        let done = false
        // 最多等 10 分钟；用户可能慢慢登录。
        for (let attempt = 0; attempt < 120 && !done; attempt += 1) {
          const current = guestRef.current
          if (!current || current.element !== element) return
          let href = ''
          try {
            href = await element.executeJavaScript('location.href', true)
          } catch {
            return // guest 被拆了
          }
          if (!/sign_in|\/login/i.test(String(href))) {
            // 已经离开登录页，看看输入框在不在
            try {
              const found = await element.executeJavaScript(
                `String(!!globalThis.__bubbleAskDriver && !!globalThis.__bubbleAskDriver.findComposer(${json}))`,
                true,
              )
              if (found === 'true') {
                done = true
                break
              }
            } catch {
              return
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 5000))
        }
        const current = guestRef.current
        if (!done || !current || current.element !== element) {
          setStatus('等登录超时')
          return
        }
        push('检测到已登录，开始复检')
        report('wv-login-detected', {})
        try {
          const state = await element.executeJavaScript(`globalThis.__bubbleAskDriver.state(${json})`, true)
          const filled = await element.executeJavaScript(
            `globalThis.__bubbleAskDriver.fill(${json}, 'Bubble Ask 内嵌自检')`,
            true,
          )
          const after = await element.executeJavaScript(
            `globalThis.__bubbleAskDriver.composerState(${json})`,
            true,
          )
          // 登录态到底存在哪 —— 决定「重启后要不要重登」这个核心未知项。
          // 只列 key 名和 cookie 名，不取任何值。
          const storage = await element.executeJavaScript(
            `(() => {
               const keys = []
               try { for (let i = 0; i < localStorage.length; i += 1) keys.push(localStorage.key(i)) } catch {}
               let cookies = []
               try { cookies = document.cookie.split(';').map(s => s.split('=')[0].trim()).filter(Boolean) } catch {}
               return JSON.stringify({ localStorageKeys: keys, cookieNames: cookies, host: location.host })
             })()`,
            true,
          )
          report('wv-login-selftest', { steps: [
            { step: 'state', ok: true, value: asText(state) },
            { step: 'fill', ok: true, value: asText(filled) },
            { step: 'composerState', ok: true, value: asText(after) },
            { step: '存储（仅键名）', ok: true, value: asText(storage) },
          ] })
          setStatus('登录后复检完成')
        } catch (error) {
          report('wv-login-selftest', {
            steps: [{ step: '复检', ok: false, value: errorText(error) }],
          })
          setStatus('复检失败')
        }
      }

      async function run(label, task) {
        if (busy) return
        setBusy(true)
        setStatus(`${label}…`)
        try {
          await task()
        } catch (error) {
          const message = errorText(error)
          setStatus(`失败：${message}`)
          push(`✗ ${message}`)
          report('wv-fail', { step: label, message })
        } finally {
          setBusy(false)
        }
      }

      /** 已持有的 guest；没有就明确报错，而不是抛 TypeError。 */
      function held() {
        const value = guestRef.current
        if (!value) throw new Error('还没连接（先点「连接」）')
        return value
      }

      /** 建 guest：设属性 → 挂 DOM → 等 dom-ready → 导航到服务方首页。 */
      async function connect() {
        if (guestRef.current) {
          push('已经连接过了')
          return
        }
        const bridge = takeDesktopBrowser()
        if (!bridge) throw new Error('宿主没有 dshDesktop.browser（当前不是桌面端主框架）')
        push(`acquire workspace=${SPIKE_WORKSPACE}`)
        const reservation = await bridge.acquire(SPIKE_WORKSPACE)
        push(`lease=${reservation.lease}`)
        push(`partition=${reservation.partition}`)
        const host = hostRef.current
        if (!host) throw new Error('面板还没挂载')

        const element = document.createElement('webview')
        element.setAttribute('name', reservation.lease)
        element.setAttribute('partition', reservation.partition)
        element.setAttribute('allowpopups', '')
        element.setAttribute('src', `about:blank#${reservation.lease}`)
        element.style.width = '100%'
        element.style.height = '100%'
        element.style.border = '0'

        // 先挂监听再入 DOM：dom-ready 是异步的，但这样最稳。
        const blankReady = waitGuest(element, 'dom-ready', 15000)
        host.appendChild(element)
        guestRef.current = { element, bridge, lease: reservation.lease, partition: reservation.partition, cfg: null }
        await blankReady
        push('about:blank dom-ready ✓')

        // 主进程在 did-attach-webview 里等同一个 dom-ready，再读 URL 认领 lease
        // （必须是 about:blank#<lease>）。这里多等一拍，确保它先认领完，
        // 否则我立刻 loadURL 会让它读到的 URL 对不上 lease，直接把 guest 关掉。
        await new Promise((resolve) => setTimeout(resolve, 400))
        push(`认领前 URL=${typeof element.getURL === 'function' ? element.getURL() : '(无 getURL)'}`)

        // UA 脱敏：站点判定「环境异常」只看 UA 含 electron 或 window.process.type。
        // setUserAgent 是 webview 的运行时方法（不是 attach preferences 的键），
        // 主进程只会删 preferences 里那些键，所以这条路可能没被堵。
        // 必须在 loadURL 之前设，否则首个文档已经用旧 UA 建立了 navigator。
        if (typeof element.setUserAgent === 'function') {
          try {
            const ua = await element.executeJavaScript('navigator.userAgent', true)
            const clean = String(ua)
              .replace(/\s*Electron\/[\d.]+/gi, '')
              .replace(/\s*@deepseek-ai\/[\w.-]+\/[\w.-]+/gi, '')
            element.setUserAgent(clean)
            push(`UA 已脱敏 → ${clean.slice(0, 160)}`)
          } catch (error) {
            push(`UA 脱敏失败：${errorText(error)}`)
          }
        } else {
          push('guest 没有 setUserAgent')
        }

        const loaded = waitGuest(element, 'dom-ready', 60000)
        element.loadURL(SPIKE_HOME)
        await loaded
        const url = typeof element.getURL === 'function' ? element.getURL() : '(无 getURL)'
        push(`已加载 ${url}`)

        try {
          const ua = await element.executeJavaScript('navigator.userAgent', true)
          push(`实际 UA=${String(ua).slice(0, 200)}`)
        } catch (error) {
          push(`读 UA 失败：${errorText(error)}`)
        }
        setStatus('已连接')
      }

      async function check() {
        const { element } = held()
        push(`guest API: executeJavaScript=${typeof element.executeJavaScript} loadURL=${typeof element.loadURL} getURL=${typeof element.getURL}`)
        if (typeof element.executeJavaScript !== 'function') throw new Error('guest 没有 executeJavaScript')
        const page = await element.executeJavaScript(
          'JSON.stringify({href:location.href,title:document.title,ua:navigator.userAgent,cookie:navigator.cookieEnabled,ready:document.readyState})',
          true,
        )
        push(`页面 ${asText(page)}`)
        setStatus('可执行 JS ✓')
      }

      /** 从 Host 取驱动源码与配置（都来自唯一真源，插件里没有第二份实现）。 */
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

      async function inject() {
        const guest = held()
        const { payload, cfg } = await fetchDriver()
        const driver = String(payload.driver || '')
        if (!driver) throw new Error('驱动源码为空')
        await guest.element.executeJavaScript(driver, true)
        guest.cfg = cfg
        push(`注入驱动 ${driver.length} 字节，服务方 ${cfg.id}`)
        const present = await guest.element.executeJavaScript('String(!!globalThis.__bubbleAskDriver)', true)
        push(`__bubbleAskDriver = ${asText(present)}`)
        setStatus('驱动已注入')
      }

      /** 在 guest 里求值：统一走驱动的只读接口，不在这里重写逻辑。 */
      async function callDriver(expression) {
        const guest = held()
        if (!guest.cfg) throw new Error('先注入驱动')
        return guest.element.executeJavaScript(expression(JSON.stringify(guest.cfg)), true)
      }

      async function probe() {
        const out = await callDriver((cfg) => `globalThis.__bubbleAskDriver.probe(${cfg})`)
        push(`probe ${asText(out)}`)
        setStatus('已读页面状态')
      }

      /**
       * 对照实验：清掉「已关闭提示条」标记后重载，看提示条是否还会出现。
       *
       * 不做这一步就分不清「UA 脱敏生效」和「弹窗关过就不再弹」——
       * 前者是可复用的方案，后者只是这次碰巧关掉了。
       */
      async function recheckEnv() {
        const { element } = held()
        await element.executeJavaScript("localStorage.removeItem('closeUnsafeEnvWarn')", true)
        push('已清 closeUnsafeEnvWarn（只清这个键）')
        const loaded = waitGuest(element, 'dom-ready', 60000)
        element.reload()
        await loaded
        await new Promise((resolve) => setTimeout(resolve, 2500))
        const verdict = await element.executeJavaScript(
          `(() => {
             const text = document.body.innerText || ''
             let flag = null
             try { flag = localStorage.getItem('closeUnsafeEnvWarn') } catch {}
             return JSON.stringify({
               modalVisible: /使用环境异常|Abnormal usage environment/.test(text),
               dismissFlag: flag,
               ua: navigator.userAgent.slice(0, 160),
               uaHasElectron: navigator.userAgent.toLowerCase().includes('electron'),
               title: document.title,
               href: location.href,
             })
           })()`,
          true,
        )
        push(`重载后 ${asText(verdict)}`)
        report('wv-env-recheck', { verdict: asText(verdict) })
        setStatus('对照实验完成')
      }

      async function fill() {
        const text = 'Bubble Ask 内嵌验证：请只回复 ok'
        const result = await callDriver(
          (cfg) => `globalThis.__bubbleAskDriver.fill(${cfg}, ${JSON.stringify(text)})`,
        )
        push(`fill → ${asText(result)}`)
        await new Promise((resolve) => setTimeout(resolve, 400))
        const state = await callDriver((cfg) => `globalThis.__bubbleAskDriver.composerState(${cfg})`)
        push(`composerState → ${asText(state)}`)
        setStatus('已填入（未发送）')
      }

      async function send() {
        const result = await callDriver((cfg) => `globalThis.__bubbleAskDriver.send(${cfg})`)
        push(`send → ${asText(result)}`)
        setStatus('已点发送')
      }

      /**
       * 登录后发一条真消息，验证整条链路（不只是「找得到输入框」）。
       *
       * 只有点发送并确认消息真的发出去了，才算这条路走通 —— 前面 17 步
       * 全是「能读写 DOM」，而用户要的是「能对话」。
       */
      async function sendProbe() {
        const guest = held()
        const { cfg } = guest.cfg ? { cfg: guest.cfg } : await fetchDriver()
        if (!guest.cfg) guest.cfg = cfg
        const json = JSON.stringify(cfg)
        const element = guest.element

        const before = await element.executeJavaScript('location.href', true)
        push(`发送前 href=${asText(before)}`)

        const filled = await element.executeJavaScript(
          `globalThis.__bubbleAskDriver.fill(${json}, 'Bubble Ask 内嵌验证：请只回复 ok')`,
          true,
        )
        push(`fill → ${asText(filled)}`)
        await new Promise((resolve) => setTimeout(resolve, 500))

        const clicked = await element.executeJavaScript(
          `globalThis.__bubbleAskDriver.send(${json})`,
          true,
        )
        push(`send → ${asText(clicked)}`)
        setStatus('已点发送，等回复…')

        // 等页面发生变化（URL 变成 /a/chat/… 或输入框被清空）—— 用轮询而不是
        // 一次读取，因为发请求和渲染都要时间。
        let verdict = 'unknown'
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          const after = await element.executeJavaScript(
            `(() => {
               const box = globalThis.__bubbleAskDriver.findComposer(${json})
               return JSON.stringify({
                 href: location.href,
                 len: box ? (globalThis.__bubbleAskDriver.composerText(${json}) || '').length : -1,
                 hasBox: !!box,
               })
             })()`,
            true,
          )
          const info = JSON.parse(asText(after) || '{}')
          if (info.href !== String(before) || info.len === 0) {
            verdict = JSON.stringify(info)
            break
          }
          verdict = JSON.stringify(info)
        }
        push(`发送后 ${verdict}`)
        report('wv-send-probe', { verdict, clicked: asText(clicked) })
        setStatus('发送验证完成')
      }

      function teardown() {
        const heldValue = guestRef.current
        guestRef.current = null
        setLog('')
        setStatus('已断开')
        if (!heldValue) return
        try {
          heldValue.element.remove()
        } catch {
          /* 忽略 */
        }
        try {
          Promise.resolve(heldValue.bridge.release(heldValue.lease)).catch(() => {})
        } catch {
          /* 忽略 */
        }
      }

      const button = (label, task) =>
        h('button', { className: 'dba-wv-btn', disabled: busy, onClick: () => { void run(label, task) } }, label)

      return h(React.Fragment, null,
        h('button', {
          className: 'dba-spike',
          onClick: () => setOpen((value) => !value),
          title: '验证插件内嵌 webview 是否可行（spike 分支）',
        }, open ? '收起内嵌验证' : '内嵌验证'),
        // 常驻挂载：收起只隐藏，guest 仍然活着（登录态留着，下次少走一遍）。
        h('div', { className: 'dba-wv', style: open ? undefined : { display: 'none' } },
          h('div', { className: 'dba-wv-head' },
            h('span', { className: 'dba-wv-title' }, 'webview'),
            h('span', { className: 'dba-wv-status', title: status }, status),
            h('button', { className: 'dba-wv-btn', onClick: () => setOpen(false) }, '×')),
          h('div', { className: 'dba-wv-tools' },
            h('button', {
              className: 'dba-wv-btn',
              disabled: busy,
              title: '自动跑完「建 guest → 注入驱动 → 读状态 → 填入」，每步结果上报给 Host',
              onClick: () => { void run('自检', selftest) },
            }, '一键自检'),
            button('连接', connect),
            button('检查 API', check),
            button('注入驱动', inject),
            button('页面状态', probe),
            button('填入测试', fill),
            button('点发送', send),
            h('button', {
              className: 'dba-wv-btn',
              disabled: busy,
              title: '清掉「已关闭提示条」标记后重载，看「使用环境异常」是否还会出现',
              onClick: () => { void run('环境复检', recheckEnv) },
            }, '环境复检'),
            h('button', { className: 'dba-wv-btn', disabled: busy, onClick: teardown }, '断开')),
          log ? h('pre', { className: 'dba-wv-pre' }, log) : null,
          h('div', { className: 'dba-wv-host', ref: hostRef })))
    }
    //#endregion

    return {
      inject: ['slots'],
      apply(context) {
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
        // spike：验证插件自己开 guest 打开网页版是否可行（走 lease 通道）。
        context.slots.inject('shell.overlay', () => context.slots.register({
          name: 'shell.overlay',
          id: 'bubble-ask-webview-spike',
          order: 901,
        }, WebviewSpike))
        report('loaded', { href: window.location.href })
      },
    }
  },
})
