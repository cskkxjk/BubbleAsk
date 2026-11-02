/**
 * Bubble Ask —— Client 半。
 *
 * 只做三件事：
 *   1. 在会话里盯住文字选区（鼠标松开 / 键盘选择都算）；
 *   2. 在选区旁边浮出一个小气泡（Bubble Ask 的手感）；
 *   3. 点下去以后，把「精简会话轨迹 + 选中文字 + 你的问题」交给 Host 拼好，
 *      再用右侧栏的内嵌浏览器打开 DeepSeek 网页版（?q= 预填），或者走 CDP 自动发送。
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
      '.dba-foot{display:flex;align-items:center;gap:8px;padding:0 10px 10px}',
      '.dba-btn{pointer-events:auto;height:30px;padding:0 12px;border-radius:8px;cursor:pointer;font:inherit;',
      'border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent;',
      'color:var(--dsw-alias-label-primary,#111)}',
      '.dba-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dba-btn.dba-primary{border-color:transparent;background:var(--dsw-alias-label-accent,#247bbf);color:#fff}',
      '.dba-btn.dba-primary:hover{filter:brightness(1.06)}',
      '.dba-btn:disabled{opacity:.55;cursor:default}',
      '.dba-status{padding:0 10px 9px;color:var(--dsw-alias-label-tertiary,#888);min-height:14px;word-break:break-word}',
      '.dba-url{box-sizing:border-box;width:100%;height:52px;resize:none;margin:0 0 9px;padding:6px 9px;',
      'border:0;border-top:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));',
      'background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));color:var(--dsw-alias-label-tertiary,#888);',
      'font:var(--dsw-font-xxxs-11,11px/1.4 ui-monospace,monospace);outline:none}',
    ].join('')

    /** 气泡本体。 */
    function BubbleAsk() {
      const [bubble, setBubble] = useState({ visible: false, expanded: false, text: '', x: 0, y: 0 })
      const [question, setQuestion] = useState('')
      const [status, setStatus] = useState('')
      const [busy, setBusy] = useState(false)
      const [prefillUrl, setPrefillUrl] = useState('')
      const urlRef = useRef(null)
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

      /** 让 Host 组一次「带上下文的提问」。 */
      async function askHost(path) {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: currentSessionId,
            selection: bubbleRef.current.text,
            question,
          }),
        })
        let payload = {}
        try {
          payload = await response.json()
        } catch (error) {
          payload = { ok: false, error: 'Host 返回了无法解析的内容' }
        }
        if (!response.ok || payload.ok === false) {
          throw new Error(payload.error || `请求失败（HTTP ${response.status}）`)
        }
        return payload
      }

      /** 复制文本：优先 clipboard API，退回到组件内隐藏 textarea + execCommand。 */
      async function copyText(text) {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text)
            return true
          }
        } catch (error) {
          report('clipboard-api-failed', { message: errorText(error) })
        }
        try {
          const node = urlRef.current
          if (node) {
            node.focus()
            node.select()
            const ok = document.execCommand && document.execCommand('copy')
            return Boolean(ok)
          }
        } catch (error) {
          report('clipboard-exec-failed', { message: errorText(error) })
        }
        return false
      }

      /** 用右侧栏内嵌浏览器打开；拿不到接口就把链接交给调用方做复制兜底。 */
      function openUrl(url) {
        const sidebarRight = sidebarRightService
        if (sidebarRight && typeof sidebarRight.openTab === 'function') {
          try {
            sidebarRight.openTab('browser', { params: { url } })
            report('open-sidebar-ok', { urlChars: url.length })
            return 'sidebar'
          } catch (error) {
            report('open-sidebar-failed', { message: errorText(error) })
          }
        } else {
          report('open-sidebar-unavailable', { hasService: Boolean(sidebarRight) })
        }
        return 'fallback'
      }

      /** 干净的网页版地址（去掉 ?q=），用于「打开后再写入」这条路。 */
      function chatUrlOf(payload) {
        const fallback = 'https://chat.deepseek.com/'
        try {
          const parsed = new URL(payload && payload.url ? payload.url : fallback)
          return `${parsed.origin}/`
        } catch (error) {
          return fallback
        }
      }

      /**
       * 把完整提问直接写进侧边栏浏览器里的 DeepSeek 输入框（用户只需改一改再回车）。
       *
       * 原理：侧边栏的 `<webview>` 元素由同一渲染进程创建，Electron 的 webview 自带
       * executeJavaScript()，可以在 guest 的页面里执行脚本 —— 于是能像 CDP 那样
       * 用原生 setter 注入文本并派发 input 事件（React 受控组件只认这个）。
       */
      /**
       * 列出侧边栏里所有显示 chat.deepseek.com 的 webview（可见的排在后面）。
       *
       * 注意 keepMounted：旧标签页的 webview 关闭后仍留在 DOM 里，
       * 所以「最后一个」未必是用户正在看的那个 —— 用可见性 + 新旧差集来定位。
       */
      function listDeepseekWebviews() {
        let nodes = []
        try {
          nodes = Array.from(document.querySelectorAll('webview'))
        } catch (error) {
          return []
        }
        const matches = nodes.filter((node) => {
          try {
            const current = typeof node.getURL === 'function' ? String(node.getURL() || '') : ''
            const declared = String(node.getAttribute && node.getAttribute('src') || '')
            return /chat\.deepseek\.com/.test(current) || /chat\.deepseek\.com/.test(declared)
          } catch (error) {
            return false
          }
        })
        const isVisible = (node) => {
          try {
            return Boolean(node.getClientRects && node.getClientRects().length > 0)
          } catch (error) {
            return false
          }
        }
        // 不可见的（keepMounted 隐藏页）在前，可见的在后，取末尾即“正在看的”
        return [...matches.filter((node) => !isVisible(node)), ...matches.filter(isVisible)]
      }

      /** 取当前最应该被写入的那个 webview。 */
      function findDeepseekWebview() {
        const list = listDeepseekWebviews()
        return list.length > 0 ? list[list.length - 1] : null
      }

      /**
       * 把提问写进 webview。
       * @param exclude 打开新标签前已存在的 webview 集合：优先写“新出现的那个”，
       *                这样每次点击都是新页面，且内容写进新页面（而不是旧标签页）。
       */
      async function autoFillSidebar(prompt, budgetMs = 40000, exclude = null) {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        /** 优先新出现的可见 webview，其次任一可见 webview，最后才退回旧的。 */
        const pick = () => {
          const list = listDeepseekWebviews()
          if (list.length === 0) return null
          if (exclude && exclude.size > 0) {
            const fresh = list.filter((node) => !exclude.has(node))
            if (fresh.length > 0) return fresh[fresh.length - 1]
            // 新 webview 还没挂载：先别写旧的，等它出现（否则就写错页面）
            return null
          }
          return list[list.length - 1]
        }

        const deadline = Date.now() + budgetMs
        let webview = pick()
        let sawWebview = Boolean(webview)
        let lastReason = 'no-webview'
        while (Date.now() < deadline) {
          if (!webview) {
            webview = pick()
            if (webview) sawWebview = true
            if (!webview) {
              await sleep(400)
              continue
            }
          }
          // guest 里的注入脚本：先清空 → 用“替换选区”的方式整体写入 → 严格回读校验。
          // 不能用 inputType:'insertText' + data，编辑器会把 data 当成“插入”
          // 接在原有内容后面（表现为每点一次就叠加一段）。
          const script = `(function () {
            var text = ${JSON.stringify(prompt)};
            var el = document.querySelector('textarea[name="search"]') || document.querySelector('textarea')
              || document.querySelector('[contenteditable="true"]');
            if (!el) return { ok: false, reason: 'no-composer', url: location.href };
            var readOf = function () { return el.isContentEditable ? (el.textContent || '') : (el.value || ''); };
            var fire = function () { el.dispatchEvent(new Event('input', { bubbles: true })); };
            try {
              el.focus();

              // 1) 先清空，避免任何“追加”语义残留
              if (el.isContentEditable) {
                el.textContent = '';
              } else {
                var proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
                var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                setter.call(el, '');
              }
              fire();

              // 2) 全选后插入：execCommand('insertText') 会替换选区，编辑器识别得最好
              var inserted = false;
              try {
                if (typeof el.select === 'function') el.select();
                else {
                  var range = document.createRange();
                  range.selectNodeContents(el);
                  var sel = window.getSelection();
                  sel.removeAllRanges();
                  sel.addRange(range);
                }
                inserted = document.execCommand('insertText', false, text);
              } catch (e) {
                inserted = false;
              }

              // 3) 回退：原生 setter 整体赋值 + 无 data 的 input 事件
              if (!inserted || readOf() !== text) {
                if (el.isContentEditable) el.textContent = text;
                else {
                  var proto2 = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
                  Object.getOwnPropertyDescriptor(proto2, 'value').set.call(el, text);
                }
                fire();
              }

              var read = readOf();
              if (el.setSelectionRange) {
                try { el.setSelectionRange(read.length, read.length); } catch (e) {}
              }
              // exact 才是真的成功：内容必须完全等于目标文本（不是“长度大于 0”）
              return {
                ok: read === text,
                exact: read === text,
                len: read.length,
                expected: text.length,
                url: location.href
              };
            } catch (error) {
              return { ok: false, reason: 'exception:' + String(error && error.message || error) };
            }
          })()`
          try {
            const result = await Promise.race([
              webview.executeJavaScript(script, true),
              sleep(8000).then(() => { throw new Error('executeJavaScript 超时') }),
            ])
            if (result && result.ok && result.exact) {
              return { ok: true, len: result.len, url: result.url }
            }
            // 写入不精确：报出期望/实际，外层会重试或退回剪贴板
            lastReason = result
              ? `mismatch:期望${result.expected ?? '?'}实际${result.len ?? '?'}${result.reason ? ':' + result.reason : ''}`
              : 'no-result'
            await sleep(800)
            webview = pick() || webview
          } catch (error) {
            lastReason = errorText(error)
            await sleep(600)
            webview = pick()
          }
        }
        return { ok: false, reason: sawWebview ? `timeout:${lastReason}` : 'no-webview' }
      }

      async function onOpenInSidebar() {
        setBusy(true)
        setStatus('正在整理会话轨迹…')
        report('action-sidebar-start', { sessionId: currentSessionId, selectionChars: bubbleRef.current.text.length })
        try {
          const payload = await askHost('/bubble-ask/prompt')
          const stats = payload.stats || {}
          const traceLine = stats.traceMessages
            ? `已带上 ${stats.traceMessages} 条轨迹（${stats.traceChars} 字）`
            : '这次会话还没有轨迹，只带选中文字'
          report('action-sidebar-prompt-ok', {
            mode: payload.mode,
            urlChars: payload.url ? payload.url.length : 0,
            promptChars: payload.prompt ? payload.prompt.length : 0,
            traceMessages: stats.traceMessages || 0,
          })

          // 短提问：?q= 直接预填更省事（预填成功就不必再注入）
          if (payload.mode === 'prefill' && openUrl(payload.url) === 'sidebar') {
            setStatus(`已在侧边栏打开并预填，${traceLine}；按回车发送。`)
            return
          }

          // 每次点击都开一个**新的** DeepSeek 标签页（新对话），并把提问写进这个新页面。
          // 关键：先把现有 webview 记下来（keepMounted 的旧页面仍在 DOM 里），
          // 之后只认“新出现的那个”，否则会写进用户看不到的旧标签页。
          const before = new Set(listDeepseekWebviews())
          setStatus('正在打开新的 DeepSeek 标签页并写入提问…')
          const opened = openUrl(chatUrlOf(payload))
          report('open-new-tab', { urlChars: 26, previousCount: before.size, opened })
          const filled = await autoFillSidebar(payload.prompt, 45000, before)
          report('autofill-result', {
            ok: filled.ok,
            reason: filled.reason,
            len: filled.len,
            newTab: true,
            previousCount: before.size,
          })
          if (filled.ok) {
            setPrefillUrl('')
            setStatus(`已在新标签页填好 ${filled.len} 字（${traceLine}）——改完直接回车发送。`)
            return
          }

          // 自动填写失败：退回「复制到剪贴板 + 显示全文」
          const copied = await copyText(payload.prompt || '')
          setPrefillUrl(payload.prompt || '')
          if (copied) {
            setStatus(`没能自动写入（${filled.reason}）。完整提问已复制——在输入框按 Ctrl+V 再回车。`)
          } else {
            setStatus(`没能自动写入（${filled.reason}），也复制不到剪贴板。请手动复制下面的全文。`)
          }
        } catch (error) {
          report('action-sidebar-error', { message: errorText(error) })
          setStatus('失败：' + errorText(error))
        } finally {
          setBusy(false)
        }
      }

      async function onAutoSend() {
        setBusy(true)
        setStatus('正在打开浏览器并注入…')
        report('action-send-start', { sessionId: currentSessionId })
        try {
          const payload = await askHost('/bubble-ask/send')
          report('action-send-result', { ok: Boolean(payload.ok), stage: payload.stage })
          if (payload.ok) {
            setStatus(`已发送（${payload.stage}）：${payload.detail || ''}`)
          } else if (payload.stage === 'prefilled') {
            setStatus(`没能自动发送，已预填到网页版：${payload.detail || ''}`)
          } else {
            setStatus(`失败（${payload.stage || '未知'}）：${payload.detail || ''}`)
          }
        } catch (error) {
          report('action-send-error', { message: errorText(error) })
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
                  if (!busy) void onOpenInSidebar()
                }
              },
            })),
          h('div', { className: 'dba-foot' },
            h('button', {
              className: 'dba-btn dba-primary',
              disabled: busy,
              title: '在右侧栏浏览器打开 DeepSeek，并把完整提问放进剪贴板',
              onClick: () => { void onOpenInSidebar() },
            }, busy ? '处理中…' : '在侧边栏打开'),
            h('button', {
              className: 'dba-btn',
              disabled: busy,
              title: '由 Host 拉起独立浏览器窗口，注入并自动发送（带完整上下文）',
              onClick: () => { void onAutoSend() },
            }, '自动发送'),
            prefillUrl
              ? h('button', {
                className: 'dba-btn',
                title: '再次复制',
                onClick: async () => {
                  const ok = await copyText(prefillUrl)
                  setStatus(ok ? '已复制。在网页版输入框按 Ctrl+V 再回车。' : '复制失败，请手动选中下面的文本。')
                },
              }, '再复制一次')
              : null),
          h('div', { className: 'dba-status' }, status),
          prefillUrl
            ? h('textarea', {
              className: 'dba-url',
              ref: urlRef,
              readOnly: true,
              value: prefillUrl,
              onFocus: (event) => event.currentTarget.select(),
            })
            : null))
    }

    let ctx = null
    /** 右侧栏导航控制器（由 ctx.inject 注入；没装 ui-sidebar-right 就是 undefined）。 */
    let sidebarRightService = null

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
      } catch (error) {
        /* 上报失败不影响功能 */
      }
    }

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

        // 声明可选依赖：只有在右侧栏插件在场时才拿到这个服务。
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
