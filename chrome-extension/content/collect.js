/**
 * 页面上下文采集器。
 *
 * 作为声明式内容脚本随普通页面加载（也在 background 的兜底路径里被
 * chrome.scripting 注入），运行在扩展的隔离世界（isolated world）中，
 * 因此既能自由读取 DOM，又不受页面自身 CSP 限制。
 *
 * 设计取舍：一个页面轻松上万节点，**不可能全量塞进提问**。这里按「结构 → 文字 →
 * 交互元素 → 表单 → 选中文字」分层提取，再各自限流；调用方（lib/prompt.js）负责
 * 最终字符预算与版式。AI 服务方页面不在本脚本的注入范围内（见 manifest）。
 */
;(() => {
  /** 元素是否实际可见（display/visibility/尺寸都算）。 */
  function isVisible(element) {
    if (!element || !element.getBoundingClientRect) return false
    const rect = element.getBoundingClientRect()
    if (rect.width <= 1 || rect.height <= 1) return false
    const style = window.getComputedStyle(element)
    if (!style) return false
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    return true
  }

  /** 文本一行化并压掉多余空白。 */
  function tidy(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  /** 元素的可读名字：关联 label → aria-label → 文本 → title。 */
  function labelOf(element) {
    // 表单控件优先用真正绑定的 <label>，它在页面上是用户看到的那行字。
    if (element.labels && element.labels[0]) {
      const bound = tidy(element.labels[0].innerText || element.labels[0].textContent || '')
      if (bound) return bound
    }
    const aria = element.getAttribute && element.getAttribute('aria-label')
    if (aria && aria.trim()) return tidy(aria)
    // select 的 textContent 是所有选项拼在一起，没有可读意义，跳过
    if ((element.tagName || '').toLowerCase() !== 'select') {
      const text = element.innerText || element.textContent || ''
      if (tidy(text)) return tidy(text)
    }
    const title = element.getAttribute && element.getAttribute('title')
    if (title && title.trim()) return tidy(title)
    return ''
  }

  /** 收集标题层级。 */
  function collectHeadings(limit) {
    const nodes = document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')
    const headings = []
    for (const node of nodes) {
      if (headings.length >= limit) break
      if (!isVisible(node)) continue
      const text = tidy(node.innerText || node.textContent || '')
      if (!text) continue
      let level = Number(node.tagName && node.tagName.slice(1))
      if (!(level >= 1 && level <= 6)) {
        const ariaLevel = Number(node.getAttribute && node.getAttribute('aria-level'))
        level = ariaLevel >= 1 && ariaLevel <= 6 ? ariaLevel : 2
      }
      headings.push({ level, text: text.slice(0, 160) })
    }
    return headings
  }

  /** 统计标签分布，用来表达「页面都有哪些元素」。 */
  function collectTagCounts(limit) {
    const counts = new Map()
    for (const element of document.getElementsByTagName('*')) {
      const tag = (element.tagName || '').toLowerCase()
      if (!tag) continue
      counts.set(tag, (counts.get(tag) || 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([tag, count]) => ({ tag, count }))
  }

  /** 统计语义区块数量。 */
  function collectLandmarks() {
    const names = ['header', 'nav', 'main', 'aside', 'footer', 'section', 'article', 'form', 'table', 'iframe']
    const result = {}
    for (const name of names) {
      const count = document.getElementsByTagName(name).length
      if (count > 0) result[name] = count
    }
    return result
  }

  /** 收集可交互元素（按钮 / 链接 / 各角色控件）。 */
  function collectInteractive(limit) {
    const selector = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      'summary',
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[contenteditable="true"]',
    ].join(', ')
    const nodes = document.querySelectorAll(selector)
    const items = []
    const seenLabels = new Set()
    for (const node of nodes) {
      if (items.length >= limit) break
      if (!isVisible(node)) continue
      const tag = (node.tagName || '').toLowerCase()
      const role = (node.getAttribute('role') || '').trim() || (tag === 'a' ? '链接' : tag === 'button' ? '按钮' : tag === 'select' ? '下拉框' : tag === 'textarea' ? '多行输入' : tag === 'input' ? '输入框' : '可交互')
      let label = labelOf(node)
      if (!label) {
        const type = (node.getAttribute('type') || '').trim()
        const name = (node.getAttribute('name') || '').trim()
        const placeholder = (node.getAttribute('placeholder') || '').trim()
        label = placeholder || name || type || '（无文字）'
      }
      const key = `${role}|${label}`
      if (seenLabels.has(key)) continue
      seenLabels.add(key)
      const item = { role, label: label.slice(0, 120) }
      const href = node.getAttribute('href')
      if (href && !href.startsWith('javascript:')) item.href = href.slice(0, 200)
      if (tag === 'input') {
        const type = (node.getAttribute('type') || 'text').trim()
        if (type !== 'text') item.type = type
      }
      if (node.getAttribute('aria-expanded') === 'true') item.expanded = true
      items.push(item)
    }
    return items
  }

  /** 收集表单字段（含标签解析）。 */
  function collectForms(limit) {
    const nodes = document.querySelectorAll('input:not([type="hidden"]), select, textarea')
    const fields = []
    for (const node of nodes) {
      if (fields.length >= limit) break
      if (!isVisible(node)) continue
      const tag = (node.tagName || '').toLowerCase()
      const field = { type: tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : (node.getAttribute('type') || 'text') }
      const label = node.labels && node.labels[0] ? tidy(node.labels[0].innerText || '') : ''
      if (label) field.label = label.slice(0, 80)
      const aria = node.getAttribute('aria-label')
      if (!field.label && aria) field.label = tidy(aria).slice(0, 80)
      const name = node.getAttribute('name')
      if (name) field.name = name.slice(0, 60)
      const placeholder = node.getAttribute('placeholder')
      if (placeholder) field.placeholder = tidy(placeholder).slice(0, 80)
      if (node.required) field.required = true
      const value = typeof node.value === 'string' ? node.value.trim() : ''
      if (value && field.type !== 'password') field.value = value.slice(0, 60)
      fields.push(field)
    }
    return fields
  }

  /** 选区及其所在的 DOM 路径。 */
  function collectSelection(ancestorDepth) {
    const selection = window.getSelection()
    const text = selection ? tidy(selection.toString()) : ''
    if (!text) return { text: '', ancestors: [] }
    const ancestors = []
    let node = selection.anchorNode
    let element = node && node.nodeType === 1 ? node : node && node.parentElement
    let depth = 0
    while (element && element !== document.body && depth < ancestorDepth) {
      const tag = (element.tagName || '').toLowerCase()
      if (tag && tag !== 'html' && tag !== 'body') {
        const parts = [tag]
        if (element.id) parts.push(`#${element.id}`)
        const role = element.getAttribute && element.getAttribute('role')
        if (role) parts.push(`[role=${role}]`)
        const className = typeof element.className === 'string' ? element.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
        if (className) parts.push(`.${className}`)
        const heading = /^h[1-6]$/.test(tag) ? '（标题）' : tag === 'p' ? '（正文段落）' : tag === 'li' ? '（列表项）' : tag === 'td' || tag === 'th' ? '（表格单元格）' : tag === 'button' || role === 'button' ? '（按钮）' : tag === 'pre' || tag === 'code' ? '（代码）' : ''
        ancestors.push(`${parts.join('')}${heading}`)
      }
      element = element.parentElement
      depth += 1
    }
    return { text, ancestors }
  }

  /**
   * 采集入口。返回结构化、可 JSON 序列化的对象。
   * @param limits 各部分的条数上限
   */
  globalThis.__bubbleAskCollect = function __bubbleAskCollect(limits) {
    const budget = limits || {}
    const selection = collectSelection(budget.selectionAncestors || 4)
    const bodyText = tidy(document.body ? document.body.innerText : '')
    const description = (() => {
      const meta = document.querySelector('meta[name="description"], meta[property="og:description"]')
      return meta ? tidy(meta.getAttribute('content') || '') : ''
    })()
    return {
      url: location.href,
      title: tidy(document.title || ''),
      lang: document.documentElement ? document.documentElement.lang || '' : '',
      description,
      headings: collectHeadings(budget.headings || 40),
      tagCounts: collectTagCounts(12),
      landmarks: collectLandmarks(),
      interactive: collectInteractive(budget.interactive || 80),
      forms: collectForms(budget.forms || 40),
      selection,
      text: bodyText,
      stats: {
        textChars: bodyText.length,
        elements: document.getElementsByTagName('*').length,
      },
    }
  }
})()
