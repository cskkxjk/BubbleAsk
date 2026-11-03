/**
 * Bubble Ask —— Client 半。
 *
 * 三件事：
 *   1. 在会话里盯住文字选区（鼠标松开 / 键盘选择都算）；
 *   2. 在选区旁边浮出一个小气泡（Bubble Ask 的手感）；
 *   3. 点下去以后，把「精简会话轨迹 + 选中文字 + 你的问题」交给 Host 拼好，
 *      在右侧栏的 **Bubble Ask 专属面板** 里呈现，并交给原生浏览器窗口（CDP）发送。
 *
 * 为什么不用右侧栏的内嵌浏览器（ctrl+T Browser）：
 *   Desktop 的 browser tab guest 存储分区由主进程按进程生命周期生成
 *   （`dsh-sidebar-browser-${randomUUID()}`，没有 `persist:` 前缀），Cookie 不跨重启存活，
 *   每次都要重新登录；而且网页版会把 Electron guest 判定为「使用环境异常」。
 *   原生窗口用独立的持久化 profile，登录一次长期有效，也没有那条横幅。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-bubble-ask',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef

    /** 专属 tab 的实现 id（同时是正文注册的 key）与 kind（openTab 用）。 */
    const TAB_ID = 'dsh-plugin-bubble-ask/panel'
    const TAB_KIND = 'bubble-ask'
    const TAB_LABEL = 'Bubble Ask'

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

    //#region 面板与气泡共用的状态
    /**
     * 极简可订阅状态。
     *
     * 气泡和面板在同一份模块作用域里，共享这个 store 就不必绕 Host 传一遍；
     * 页面重载后模块内存清空，面板挂载时再从 `/bubble-ask/state` 把上一次的提问找回来。
     */
    const panel = {
      state: {
        sessionId: '',
        question: '',
        selection: '',
        prompt: '',
        stats: null,
        mode: '',
        at: 0,
        status: '',
        detail: '',
        url: '',
      },
      listeners: new Set(),
      set(patch) {
        panel.state = { ...panel.state, ...(patch || {}) }
        for (const listener of panel.listeners) {
          try {
            listener()
          } catch {
            /* 单个订阅者出错不影响其他人 */
          }
        }
      },
      subscribe(listener) {
        panel.listeners.add(listener)
        return () => panel.listeners.delete(listener)
      },
    }

    function usePanelState() {
      const [snapshot, setSnapshot] = useState(panel.state)
      useEffect(() => {
        setSnapshot(panel.state)
        return panel.subscribe(() => setSnapshot(panel.state))
      }, [])
      return snapshot
    }
    //#endregion

    const CSS = [
      // —— 气泡 ——
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
      '.dba-foot{display:flex;align-items:center;gap:8px;padding:0 10px 10px;flex-wrap:wrap}',
      '.dba-btn{pointer-events:auto;height:30px;padding:0 12px;border-radius:8px;cursor:pointer;font:inherit;',
      'border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent;',
      'color:var(--dsw-alias-label-primary,#111)}',
      '.dba-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dba-btn.dba-primary{border-color:transparent;background:var(--dsw-alias-label-accent,#247bbf);color:#fff}',
      '.dba-btn.dba-primary:hover{filter:brightness(1.06)}',
      '.dba-btn:disabled{opacity:.55;cursor:default}',
      '.dba-status{padding:0 10px 9px;color:var(--dsw-alias-label-tertiary,#888);min-height:14px;word-break:break-word}',
      // —— 侧边栏面板 ——
      '.dba-panel{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;',
      'font:var(--dsw-font-xxs-12,12px/1.5 system-ui);color:var(--dsw-alias-label-primary,#111)}',
      '.dba-panel-body{display:flex;flex-direction:column;gap:10px;padding:12px;overflow:auto;min-height:0;flex:1}',
      '.dba-panel-foot{display:flex;gap:8px;padding:10px 12px;flex-wrap:wrap;',
      'border-top:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}',
      '.dba-panel .dba-btn{pointer-events:auto}',
      '.dba-label{font-weight:600;color:var(--dsw-alias-label-secondary,#555);margin-bottom:-4px}',
      '.dba-chips{display:flex;gap:6px;flex-wrap:wrap}',
      '.dba-chip{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04));color:var(--dsw-alias-label-secondary,#555);',
      'font:var(--dsw-font-xxxs-11,11px/1.4 ui-monospace,monospace)}',
      '.dba-prompt{box-sizing:border-box;width:100%;min-height:200px;flex:1;resize:vertical;padding:8px 9px;',
      'border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));',
      'background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));color:var(--dsw-alias-label-secondary,#555);',
      'font:var(--dsw-font-xxxs-11,11px/1.5 ui-monospace,monospace);outline:none}',
      '.dba-note{color:var(--dsw-alias-label-tertiary,#888);word-break:break-word}',
      '.dba-empty{color:var(--dsw-alias-label-tertiary,#888);padding:16px 4px;line-height:1.6}',
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

    /** 打开（或聚焦）右侧栏的 Bubble Ask 专属面板。 */
    function openPanelTab() {
      const sidebarRight = sidebarRightService
      if (!sidebarRight || typeof sidebarRight.openTab !== 'function') {
        report('open-panel-unavailable', { hasService: Boolean(sidebarRight) })
        return false
      }
      try {
        sidebarRight.openTab(TAB_KIND)
        report('open-panel-ok', {})
        return true
      } catch (error) {
        report('open-panel-failed', { message: errorText(error) })
        return false
      }
    }

    /** 把一次「组好的提问」写进共享 store（气泡和面板都读它）。 */
    function publishAsk(payload, extra) {
      const stats = (payload && payload.stats) || null
      panel.set({
        sessionId: extra.sessionId,
        question: extra.question,
        selection: extra.selection,
        prompt: (payload && payload.prompt) || '',
        stats,
        mode: (payload && payload.mode) || (extra.send ? 'cdp' : ''),
        url: (payload && payload.url) || '',
        at: Date.now(),
        status: extra.status,
        detail: extra.detail,
      })
      return stats
    }
    //#endregion

    //#region 侧边栏面板
    /** 面板正文：显示上一次组好的提问、轨迹统计和发送结果，并负责发送/复制。 */
    function BubbleAskPanel(props) {
      const state = usePanelState()
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState('')
      const hydratedRef = useRef(false)
      const sessionId = (props && props.sessionId) || ''

      // 页面重载后模块内存清空：挂载时把 Host 记着的上一次提问取回来。
      useEffect(() => {
        if (hydratedRef.current) return
        hydratedRef.current = true
        if (panel.state.prompt) return
        fetch('/bubble-ask/state')
          .then((response) => response.json())
          .then((payload) => {
            if (panel.state.prompt) return
            const ask = payload && payload.lastAsk
            const send = payload && payload.lastSend
            if (ask) {
              panel.set({
                sessionId: ask.sessionId || '',
                question: ask.question || '',
                selection: ask.selection || '',
                prompt: ask.prompt || '',
                stats: ask.stats || null,
                mode: ask.mode || '',
                url: ask.url || '',
                at: ask.at || 0,
                status: '已恢复上一次的提问',
                detail: '',
              })
            }
            if (send) {
              panel.set({
                status: send.ok ? `已发送（${send.stage}）` : `未发送（${send.stage || '失败'}）`,
                detail: send.detail || '',
                url: send.url || (ask && ask.url) || '',
              })
            }
            if (ask || send) report('panel-hydrated', { hasAsk: Boolean(ask), hasSend: Boolean(send) })
          })
          .catch((error) => report('panel-hydrate-failed', { message: errorText(error) }))
      }, [])

      /** 用 store 里的选区与问题重新组一次上下文（不发送）。 */
      async function regenerate() {
        setBusy('regen')
        setNote('')
        try {
          const payload = await postJson('/bubble-ask/prompt', {
            sessionId: state.sessionId || sessionId,
            selection: state.selection,
            question: state.question,
          })
          publishAsk(payload, {
            sessionId: state.sessionId || sessionId,
            question: state.question,
            selection: state.selection,
            status: '已重新整理上下文',
            detail: '',
          })
          setNote('上下文已按当前会话重新整理。')
        } catch (error) {
          setNote('重新整理失败：' + errorText(error))
        } finally {
          setBusy('')
        }
      }

      /** 交给原生窗口发送（CDP 注入 + 回读校验）。 */
      async function send() {
        setBusy('send')
        setNote('')
        try {
          const payload = await postJson('/bubble-ask/send', {
            sessionId: state.sessionId || sessionId,
            selection: state.selection,
            question: state.question,
          })
          const ok = Boolean(payload.ok)
          publishAsk(payload, {
            sessionId: state.sessionId || sessionId,
            question: state.question,
            selection: state.selection,
            send: true,
            status: ok ? `已发送（${payload.stage}）` : `未发送（${payload.stage || '失败'}）`,
            detail: payload.detail || '',
          })
          setNote(ok ? '已在 DeepSeek 窗口里发送。' : '没能自动发送，可以复制全文手动粘贴。')
        } catch (error) {
          setNote('发送失败：' + errorText(error))
        } finally {
          setBusy('')
        }
      }

      /** 只把原生窗口拉起来 / 切到前台，不注入任何内容。 */
      async function openWindow() {
        setBusy('open')
        setNote('')
        try {
          const payload = await postJson('/bubble-ask/open', {})
          setNote(payload.ok ? '窗口已就绪。' : `窗口没起来：${payload.detail || '未知原因'}`)
        } catch (error) {
          setNote('打开窗口失败：' + errorText(error))
        } finally {
          setBusy('')
        }
      }

      async function copyPrompt() {
        const ok = await copyText(state.prompt)
        setNote(ok ? '完整提问已复制。' : '复制失败，请手动选中下面的文本。')
      }

      const stats = state.stats || null
      const hasPrompt = Boolean(state.prompt)

      const head = h('div', { className: 'dba-panel-body' },
        hasPrompt
          ? null
          : h('div', { className: 'dba-empty' },
            '在会话里选中一段文字，点浮出来的「问这段」，',
            h('br'),
            '整理好的提问就会出现在这里。'),
        state.status
          ? h('div', { className: 'dba-note', style: { color: 'var(--dsw-alias-label-secondary,#555)' } }, state.status)
          : null,
        stats
          ? h('div', { className: 'dba-chips' },
            h('span', { className: 'dba-chip' }, `轨迹 ${stats.traceMessages ?? 0} 条`),
            h('span', { className: 'dba-chip' }, `轨迹 ${stats.traceChars ?? 0} 字`),
            h('span', { className: 'dba-chip' }, `提问 ${stats.promptChars ?? (state.prompt ? state.prompt.length : 0)} 字`))
          : null,
        state.selection
          ? h('div', null,
            h('div', { className: 'dba-label' }, '选中的文字'),
            h('div', { className: 'dba-quote' }, state.selection.length > 600 ? state.selection.slice(0, 600) + '…' : state.selection))
          : null,
        state.question
          ? h('div', null,
            h('div', { className: 'dba-label' }, '我的问题'),
            h('div', { className: 'dba-quote' }, state.question))
          : null,
        hasPrompt
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', minHeight: 0, flex: 1 } },
            h('div', { className: 'dba-label' }, '完整提问（发给网页版的内容）'),
            h('textarea', {
              className: 'dba-prompt',
              readOnly: true,
              value: state.prompt,
              onFocus: (event) => event.currentTarget.select(),
            }))
          : null,
        state.detail
          ? h('div', { className: 'dba-note' }, state.detail)
          : null,
        note
          ? h('div', { className: 'dba-note' }, note)
          : null)

      const foot = h('div', { className: 'dba-panel-foot' },
        h('button', {
          className: 'dba-btn dba-primary',
          disabled: !hasPrompt || Boolean(busy),
          title: '在原生浏览器窗口里注入并发送（带完整上下文）',
          onClick: () => { void send() },
        }, busy === 'send' ? '发送中…' : '发送到 DeepSeek'),
        h('button', {
          className: 'dba-btn',
          disabled: Boolean(busy),
          title: '只打开 / 切到 DeepSeek 窗口，不注入内容',
          onClick: () => { void openWindow() },
        }, busy === 'open' ? '打开中…' : '只打开窗口'),
        h('button', {
          className: 'dba-btn',
          disabled: !hasPrompt,
          title: '复制完整提问，自己粘贴发送',
          onClick: () => { void copyPrompt() },
        }, '复制全文'),
        h('button', {
          className: 'dba-btn',
          disabled: !state.selection || Boolean(busy),
          title: '按当前会话重新整理轨迹',
          onClick: () => { void regenerate() },
        }, busy === 'regen' ? '整理中…' : '重新整理'))

      return h('div', { className: 'dba-panel' }, h('style', { key: 'style' }, CSS), head, foot)
    }
    //#endregion

    //#region 选区气泡
    /** 气泡本体。 */
    function BubbleAsk() {
      const [bubble, setBubble] = useState({ visible: false, expanded: false, text: '', x: 0, y: 0 })
      const [question, setQuestion] = useState('')
      const [status, setStatus] = useState('')
      const [busy, setBusy] = useState(false)
      /** 抑制选区重算的截止时间戳：点了气泡按钮后，同一次手势的 mouseup 不该把卡片打回去。 */
      const suppressRef = useRef(0)
      const bubbleRef = useRef(bubble)
      bubbleRef.current = bubble

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
       * 走一次完整流程：Host 组上下文 → 写进共享 store → 打开专属面板 →（可选）发送。
       * @param send true 走 CDP 原生窗口发送；false 只准备、不发送
       */
      async function runAsk(send) {
        const selection = bubbleRef.current.text
        setBusy(true)
        setStatus(send ? '正在整理轨迹并发送…' : '正在整理会话轨迹…')
        report(send ? 'action-send-start' : 'action-prompt-start', {
          sessionId: currentSessionId,
          selectionChars: selection.length,
        })
        try {
          const payload = await postJson(send ? '/bubble-ask/send' : '/bubble-ask/prompt', {
            sessionId: currentSessionId,
            selection,
            question,
          })
          const ok = send ? Boolean(payload.ok) : true
          const stats = publishAsk(payload, {
            sessionId: currentSessionId,
            question,
            selection,
            send,
            status: send
              ? (ok ? `已发送（${payload.stage}）` : `未发送（${payload.stage || '失败'}）`)
              : '已准备好，等待发送',
            detail: send ? (payload.detail || '') : '',
          })
          report('action-done', {
            send,
            ok,
            stage: payload.stage,
            promptChars: payload.prompt ? payload.prompt.length : 0,
            traceMessages: (stats && stats.traceMessages) || 0,
          })
          // 面板要能看见这次的结果；打不开就退回剪贴板（保证用户至少拿得到内容）。
          if (!openPanelTab()) {
            const copied = await copyText(payload.prompt || '')
            setStatus(copied ? '侧边栏面板不可用，提问已复制到剪贴板。' : '侧边栏面板不可用，也没能复制。')
            return
          }
          setBubble({ visible: false, expanded: false, text: '', x: 0, y: 0 })
        } catch (error) {
          report('action-error', { send, message: errorText(error) })
          setStatus('失败：' + errorText(error))
        } finally {
          setBusy(false)
        }
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
            title: '把这段文字和会话轨迹一起问 DeepSeek 网页版',
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
      const cardTop = Math.min(bubble.y + 6, Math.max(window.innerHeight - 260, 12))

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
            h('span', { className: 'dba-title' }, 'Bubble Ask · 带上会话上下文问网页版'),
            h('button', {
              className: 'dba-x',
              title: '关闭',
              onClick: () => setBubble({ visible: false, expanded: false, text: '', x: 0, y: 0 }),
            }, '✕')),
          h('div', { className: 'dba-body' },
            h('div', { className: 'dba-quote' }, quote),
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
              title: '原生窗口注入并自动发送（带完整上下文）',
              onClick: () => { void runAsk(true) },
            }, busy ? '处理中…' : '发送到 DeepSeek'),
            h('button', {
              className: 'dba-btn',
              disabled: busy,
              title: '只整理上下文并在侧边栏面板里打开，先不发',
              onClick: () => { void runAsk(false) },
            }, '只准备')),
          h('div', { className: 'dba-status' }, status)))
    }
    //#endregion

    let ctx = null
    /** 右侧栏导航控制器（由 ctx.inject 注入；没装 ui-sidebar-right 就是 undefined）。 */
    let sidebarRightService = null

    return {
      inject: ['slots'],
      apply(context) {
        ctx = context

        // 能力自检：ctx.get 拿不到未声明的服务，所以这里两条路都探一次，结果报给 Host。
        try {
          const probe = {
            hasGet: typeof context.get === 'function',
            hasInject: typeof context.inject === 'function',
            hasSidebarRight: false,
            hasOpenTab: false,
            href: window.location.href,
          }
          if (typeof context.get === 'function') {
            const viaGet = context.get('sidebarRight')
            probe.hasSidebarRight = Boolean(viaGet)
            probe.hasOpenTab = Boolean(viaGet && typeof viaGet.openTab === 'function')
          }
          report('loaded', probe)
        } catch (error) {
          report('probe-failed', { message: errorText(error) })
        }

        // 声明可选依赖：只有在右侧栏插件在场时才拿到这个导航控制器。
        try {
          context.inject(['sidebarRight'], (sub) => {
            sidebarRightService = sub.sidebarRight
            report('sidebar-right-injected', {
              hasService: Boolean(sidebarRightService),
              keys: sidebarRightService ? Object.keys(sidebarRightService) : [],
            })
          })
        } catch (error) {
          report('sidebar-right-inject-failed', { message: errorText(error) })
        }

        /**
         * 注册专属 tab：类型（可被 guide 发现）+ 正文。
         *
         * 用 ctx.inject 而不是写进 inject 数组：右侧栏插件不在场时，
         * 选区气泡仍然应该能用（面板打不开就退回复制），而不是整个插件不加载。
         */
        try {
          context.inject(['sidebarRightTabs'], (sub) => {
            const tabs = sub.sidebarRightTabs
            const slots = sub.slots || context.slots
            if (!tabs || typeof tabs.register !== 'function') {
              report('panel-register-unavailable', { hasTabs: Boolean(tabs) })
              return
            }
            sub.effect(() => tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              priority: 'extension',
              keepMounted: true,
              title: () => TAB_LABEL,
              guide: [{
                id: 'open',
                order: 60,
                title: () => TAB_LABEL,
                description: () => '把选中文字连同会话轨迹问 DeepSeek 网页版',
              }],
            }), 'bubble-ask: tab type')
            sub.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
              inject: (sessionId) => ({ sessionId }),
            }, BubbleAskPanel)), 'bubble-ask: panel body')
            report('panel-registered', { id: TAB_ID, kind: TAB_KIND })
          })
        } catch (error) {
          report('panel-register-failed', { message: errorText(error) })
        }

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
      },
    }
  },
})
