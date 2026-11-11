/**
 * 页面上下文采集器。
 *
 * 作为声明式内容脚本随普通页面加载（background 在内容脚本缺失时也会注入它），
 * 运行在扩展的隔离世界（isolated world）中：既能自由读取 DOM，又不受页面自身 CSP 限制。
 *
 * 设计取舍：一个页面轻松上万节点，全量放进提问没有意义。这里按「结构 → 文字 →
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

  /** 头尾保留、中间省略（局部上下文不用精确定位到某个字，保住两端信息量最大）。 */
  function clip(text, limit) {
    const value = String(text || '')
    if (value.length <= limit) return value
    const head = Math.floor(limit * 0.7)
    const tail = limit - head - 12
    return `${value.slice(0, head)}…（省略 ${value.length - head - tail} 字）…${value.slice(-tail)}`
  }

  /** 元素的可读位置：标签 + #id + .前两个类名。 */
  function whereOf(element) {
    if (!element || !element.tagName) return ''
    const tag = element.tagName.toLowerCase()
    const parts = [tag]
    if (element.id) parts.push(`#${element.id}`)
    const className = typeof element.className === 'string' ? element.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
    if (className) parts.push(`.${className}`)
    return parts.join('')
  }

  /**
   * 选区**周围**的文字（局部上下文）。
   *
   * 为什么需要它：整页 `document.body.innerText` 在 feed 类页面（知乎首页、微博、
   * 贴吧）几乎没用 —— 选中处通常落在被头尾截断丢掉的中段，虚拟列表里没渲染的卡片
   * 更是压根不在文本里。真正有用的是「选中处自己那一块」：最近的够长的块容器全文，
   * 加上最近的小标题、前后一块、以及再往外两层的文字。
   */
  function collectLocal(selection, limits) {
    const budget = limits || {}
    if (!selection || !selection.rangeCount) return null
    const range = selection.getRangeAt(0)
    if (!range || !range.commonAncestorContainer) return null

    /** 块容器的"够长"门槛：太短的容器（span/按钮）不算，继续往上找。 */
    const MIN_BLOCK = 160

    let node = range.commonAncestorContainer
    let element = node && node.nodeType === 1 ? node : node && node.parentElement
    let block = null
    let fallback = null
    for (let depth = 0; element && element !== document.body && depth < 12; depth += 1) {
      const text = tidy(element.innerText || '')
      if (text.length >= MIN_BLOCK) {
        block = element
        break
      }
      if (text.length > 0) fallback = element
      element = element.parentElement
    }
    if (!block) block = fallback
    if (!block) return null

    const blockText = tidy(block.innerText || '')
    const result = {
      where: whereOf(block),
      chars: blockText.length,
      block: clip(blockText, budget.localBlock || 2500),
    }

    // 最近的小标题：选区之前、文档序上最近的一个标题（知乎 feed 里就是那张卡的问题标题）
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')
    let nearestHeading = ''
    for (const heading of headings) {
      const position = heading.compareDocumentPosition(range.startContainer)
      if ((position & Node.DOCUMENT_POSITION_FOLLOWING) === 0) continue
      const text = tidy(heading.innerText || '')
      if (text) nearestHeading = text
    }
    if (nearestHeading) result.heading = clip(nearestHeading, 140)

    // 前后各一块：列表/卡片流里最直接的邻居
    const siblingText = (sibling) => {
      if (!sibling || !sibling.tagName) return ''
      const text = tidy(sibling.innerText || '')
      return text.length >= 20 ? clip(text, budget.localSibling || 400) : ''
    }
    const above = siblingText(block.previousElementSibling)
    const below = siblingText(block.nextElementSibling)
    if (above) result.above = above
    if (below) result.below = below

    // 再往外两层：告诉模型这块在页面里的位置
    const parents = []
    let parent = block.parentElement
    for (let depth = 0; parent && parent !== document.body && depth < 2; depth += 1) {
      const text = tidy(parent.innerText || '')
      if (text) parents.push({ where: whereOf(parent), text: clip(text, budget.localParent || 320) })
      parent = parent.parentElement
    }
    if (parents.length > 0) result.parents = parents

    return result
  }

  /** 选区 Anchor 所在元素的 DOM 路径（由近到远，带语义标注）。 */
  function collectAncestors(selection, ancestorDepth) {
    const ancestors = []
    if (!selection) return ancestors
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
    return ancestors
  }

  /** 选区文本、DOM 路径与周围的文字。 */
  function collectSelection(ancestorDepth, limits) {
    const selection = window.getSelection()
    const text = selection ? tidy(selection.toString()) : ''
    if (!text) return { text: '', ancestors: [] }
    const ancestors = collectAncestors(selection, ancestorDepth)
    const local = collectLocal(selection, limits)
    return local ? { text, ancestors, local } : { text, ancestors }
  }

  /**
   * 只取「选区周围的文字」。气泡在卡片出现那一刻调用它 —— 那时选区一定还在；
   * 等后台发 BA_COLLECT 回来时选区多半已经收起，局部上下文会是空的。
   */
  globalThis.__bubbleAskSelectionContext = function __bubbleAskSelectionContext(limits) {
    try {
      return collectLocal(window.getSelection(), limits || {})
    } catch (error) {
      return null
    }
  }

  /** 只取选区的 DOM 路径，调用时机与 __bubbleAskSelectionContext 相同。 */
  globalThis.__bubbleAskSelectionAncestors = function __bubbleAskSelectionAncestors(ancestorDepth) {
    try {
      return collectAncestors(window.getSelection(), ancestorDepth || 4)
    } catch (error) {
      return []
    }
  }

  /**
   * 采集入口。返回结构化、可 JSON 序列化的对象。
   * @param limits 各部分的条数上限
   */
  globalThis.__bubbleAskCollect = function __bubbleAskCollect(limits) {
    const budget = limits || {}
    const selection = collectSelection(budget.selectionAncestors || 4, budget)
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
