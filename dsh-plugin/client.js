/**
 * Bubble Ask —— Client 半。
 *
 * 两件事：
 *   1. 在会话里盯住文字选区（鼠标松开 / 键盘选择都算）；
 *   2. 在选区旁边浮出一个小气泡，点下去把「精简会话轨迹 + 选中文字 + 你的问题」
 *      交给 Host 拼好，再由托盘应用注入 DeepSeek 网页版并发送。
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
      '.dba-foot{display:flex;align-items:center;gap:8px;padding:0 10px 10px;flex-wrap:wrap}',
      '.dba-btn{pointer-events:auto;height:30px;padding:0 12px;border-radius:8px;cursor:pointer;font:inherit;',
      'border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent;',
      'color:var(--dsw-alias-label-primary,#111)}',
      '.dba-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dba-btn.dba-primary{border-color:transparent;background:var(--dsw-alias-label-accent,#247bbf);color:#fff}',
      '.dba-btn.dba-primary:hover{filter:brightness(1.06)}',
      '.dba-btn:disabled{opacity:.55;cursor:default}',
      '.dba-status{padding:0 10px 9px;color:var(--dsw-alias-label-tertiary,#888);min-height:14px;word-break:break-word}',
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
        setBusy(true)
        setStatus(send ? '正在整理轨迹并发送…' : '正在整理会话轨迹…')
        setFailedPrompt('')
        report(send ? 'action-send-start' : 'action-copy-start', {
          sessionId: currentSessionId,
          selectionChars: selection.length,
        })
        try {
          const payload = await postJson(send ? '/bubble-ask/send' : '/bubble-ask/prompt', {
            sessionId: currentSessionId,
            selection,
            question,
          })
          const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''

          if (send) {
            if (payload.ok) {
              report('action-send-done', { stage: payload.stage, promptChars: prompt.length })
              closeBubble()
              return
            }
            report('action-send-failed', { stage: payload.stage, detail: payload.detail })
            setFailedPrompt(prompt)
            setStatus(`没能发送（${payload.stage || '失败'}）：${payload.detail || ''} 可复制全文后到窗口里粘贴。`)
            return
          }

          const copied = await copyText(prompt)
          report('action-copy-done', { copied, promptChars: prompt.length })
          if (copied) {
            setStatus(`已复制 ${prompt.length} 字，去 DeepSeek 窗口按 Ctrl+V 粘贴。`)
            return
          }
          setFailedPrompt(prompt)
          setStatus(`复制失败（共 ${prompt.length} 字），可点「复制全文」重试。`)
        } catch (error) {
          report('action-error', { send, message: errorText(error) })
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
            h('span', { className: 'dba-title' }, 'Bubble Ask · 带上会话上下文问网页版'),
            h('button', { className: 'dba-x', title: '关闭', onClick: closeBubble }, '✕')),
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
              title: '只整理上下文并复制完整提问，自己去窗口里粘贴',
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
        report('loaded', { href: window.location.href })
      },
    }
  },
})
