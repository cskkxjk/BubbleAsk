/**
 * 页面上下文 → 提问文本。
 *
 * 放在单独文件里，供 background 直接 import（popup 通过 BA_PREVIEW 拿到后台拼好的
 * 完整提问，不重复实现）。服务方只影响「发到哪个窗口」，不改变 prompt 的版式。
 */

/** 上下文预算：太大对网页版是负担，太小又丢掉结构。 */
export const CONTEXT_BUDGET = {
  // 整页文本从 9000 降到 4500：真正有用的是「选中处所在的那一块」（见 localBlock），
  // 整页文本在 feed 类页面里大半是导航和页脚。
  text: 4500,
  headings: 40,
  interactive: 80,
  forms: 40,
  selectionAncestors: 4,
  localBlock: 2500,
  localParent: 320,
  localSibling: 400,
}

export const DEFAULT_QUESTION = '请解释这段选中文字在这个页面的上下文中的含义：它指代什么、为什么这样写、和页面上哪一块内容相关。'

export const DEFAULT_QUESTION_NO_SELECTION = '请概括这个页面的用途和关键信息，并指出我在这里最可能想做的事。'

/** 超长文本按头尾截断，保留两端。 */
function clipMiddle(text, limit) {
  const value = String(text || '')
  if (value.length <= limit) return value
  const head = Math.floor(limit * 0.65)
  const tail = limit - head - 20
  return `${value.slice(0, head)}\n…（原文 ${value.length} 字，此处省略 ${value.length - head - tail} 字）…\n${value.slice(-tail)}`
}

/** 一行化，避免把换行带进列表。 */
function oneLine(text, limit) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

/** 把页面结构渲染成缩进列表。 */
function renderHeadings(headings) {
  if (!headings || headings.length === 0) return '（页面没有标题元素）'
  return headings.map((item) => `${'  '.repeat(Math.max(0, item.level - 1))}- H${item.level} ${oneLine(item.text, 90)}`).join('\n')
}

/** 把交互元素渲染成分组清单。 */
function renderInteractive(items) {
  if (!items || items.length === 0) return '（没有可交互元素）'
  const groups = new Map()
  for (const item of items) {
    const key = item.role
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  const lines = []
  for (const [role, list] of groups) {
    lines.push(`${role}（${list.length}）：`)
    for (const item of list.slice(0, 24)) {
      const extra = item.href ? ` → ${oneLine(item.href, 80)}` : item.type ? ` [${item.type}]` : ''
      lines.push(`  - ${oneLine(item.label, 70)}${extra}`)
    }
    if (list.length > 24) lines.push(`  - …另有 ${list.length - 24} 个`)
  }
  return lines.join('\n')
}

/** 把表单字段渲染成清单。 */
function renderForms(fields) {
  if (!fields || fields.length === 0) return '（没有表单字段）'
  return fields
    .map((field) => {
      const bits = [`${field.type || 'input'}`]
      if (field.label) bits.push(`标签「${oneLine(field.label, 40)}」`)
      if (field.name) bits.push(`name=${field.name}`)
      if (field.placeholder) bits.push(`占位「${oneLine(field.placeholder, 40)}」`)
      if (field.required) bits.push('必填')
      return `- ${bits.join(' ')}`
    })
    .join('\n')
}

/** 把「选中处所在的那一块」渲染出来。 */
function renderLocal(local) {
  if (!local) return '（没有取到局部上下文）'
  const lines = []
  if (local.where) lines.push(`所在区块：${local.where}${local.chars ? `（这块共约 ${local.chars} 字）` : ''}`)
  if (local.heading) lines.push(`最近的小标题：${oneLine(local.heading, 140)}`)
  if (local.block) {
    lines.push('这一块的完整文字：')
    lines.push('```')
    lines.push(local.block)
    lines.push('```')
  }
  if (local.above) lines.push(`它上面那一块：${oneLine(local.above, 400)}`)
  if (local.below) lines.push(`它下面那一块：${oneLine(local.below, 400)}`)
  if (local.parents && local.parents.length > 0) {
    lines.push('再往外（由近到远）：')
    for (const parent of local.parents) lines.push(`- ${parent.where}：${oneLine(parent.text, 320)}`)
  }
  return lines.join('\n')
}

/**
 * 组装最终提问。
 *
 * 版式与 DSH 插件保持一致：编号章节 + 明确引用号规则，模型更容易照做。
 */
export function buildPrompt(context, question) {
  const page = context || {}
  const selection = (page.selection && page.selection.text) || ''
  const local = page.selection && page.selection.local
  const asked = String(question || '').trim()
  const askedOrDefault = asked || (selection ? DEFAULT_QUESTION : DEFAULT_QUESTION_NO_SELECTION)
  const lines = []
  // 章节号按需递增：加了/少了某一节都不会串号
  let section = 0
  const head = (title) => `【${'一二三四五六七八九'[section++] || String(section)}、${title}】`

  lines.push('下面是一个网页的上下文，请把它当作背景。')
  lines.push('')
  lines.push(head('页面背景'))
  lines.push(`标题：${oneLine(page.title, 160) || '（无）'}`)
  lines.push(`地址：${page.url || '（未知）'}`)
  if (page.description) lines.push(`描述：${oneLine(page.description, 220)}`)
  if (page.lang) lines.push(`语言：${page.lang}`)
  if (page.stats) {
    lines.push(`规模：可见文本约 ${page.stats.textChars} 字，元素约 ${page.stats.elements} 个，标题 ${page.headings?.length || 0} 个，可交互 ${page.interactive?.length || 0} 个`)
  }
  lines.push('')
  lines.push(head('页面结构（标题层级）'))
  lines.push(renderHeadings(page.headings))
  lines.push('')
  lines.push(head('页面文字内容'))
  lines.push(clipMiddle(page.text, CONTEXT_BUDGET.text) || '（没有可读文本）')
  lines.push('')
  lines.push(head('可交互元素与表单'))
  lines.push(renderInteractive(page.interactive))
  lines.push('')
  lines.push(renderForms(page.forms))

  if (local) {
    lines.push('')
    lines.push(head('选中文字所在的上下文'))
    lines.push(renderLocal(local))
  }

  if (selection) {
    lines.push('')
    lines.push(head('我选中的文字'))
    lines.push('```')
    lines.push(oneLine(selection, 2000))
    lines.push('```')
    const ancestors = (page.selection && page.selection.ancestors) || []
    if (ancestors.length > 0) {
      lines.push('这段文字所在的位置：')
      for (const item of ancestors) lines.push(`- ${item}`)
    }
  }

  lines.push('')
  lines.push(head('我的问题'))
  lines.push(askedOrDefault)
  lines.push('')
  lines.push('回答时请遵守：')
  lines.push('1. 优先依据上面的页面上下文回答，不要凭空猜测页面没写的内容；信息不足时直接说明缺什么。')
  lines.push('2. 如果问题针对我选中的文字，请先说明它在页面上属于哪一块（标题 / 正文 / 按钮 / 表单 / 表格 / 代码等），再解释含义。')
  lines.push('3. 「选中文字所在的上下文」那一节是这段文字前后真正的内容，解释时优先用它，不要拿页面顶部的导航或底部的页脚去硬套。')
  lines.push('4. 中文作答，句子短一些；涉及页面上的具体控件时，用它的可见文字指代。')

  return lines.join('\n')
}

/** 供 popup 预览用：不拼完整 prompt，只给个规模感。 */
export function describeContext(context) {
  if (!context) return '尚未读取页面'
  const parts = []
  parts.push(`${context.stats?.textChars || 0} 字`)
  parts.push(`${context.headings?.length || 0} 个标题`)
  parts.push(`${context.interactive?.length || 0} 个可交互元素`)
  parts.push(`${context.forms?.length || 0} 个表单字段`)
  if (context.selection?.text) parts.push(`选中 ${context.selection.text.length} 字`)
  const local = context.selection?.local
  if (local && local.block) parts.push(`局部上下文 ${local.block.length} 字`)
  return parts.join(' · ')
}
