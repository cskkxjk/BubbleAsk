/**
 * Bubble Ask 页面驱动（唯一真源）。
 *
 * 这个文件是「怎么在聊天网页里找到输入框、把话填进去、点发送、回读确认」的**唯一实现**。
 * 桌面端与 Chrome 扩展都跑这一份：
 *
 *   桌面端：C# 把本文件作为内嵌资源，用 CDP Runtime.evaluate 注入后调用
 *           `__bubbleAskDriver.xxx(cfg, ...)`（见 src/engine/PageScripts.cs）
 *   扩展：  tools/gen-providers.mjs 把它复制成 chrome-extension/content/driver.js，
 *           作为 content script 先于 chat-bridge.js 加载，后者只做消息收发适配
 *
 * 为什么合并：以前这段逻辑写了两遍 —— C# 用字符串拼 JS（PageScripts.cs 399 行），
 * 扩展手写 JS（chat-bridge.js 390 行）。两边实现的其实是同一批操作，改一处忘了另一处
 * 就会「桌面端能发、扩展端不能」。现在只有一份。
 *
 * 约定：
 *   - 不依赖任何扩展 API（content script 与 CDP 注入环境都能跑）
 *   - 不依赖 provider 注册表：配置由调用方以 cfg 传入（数据仍然来自 shared/providers.json）
 *   - 返回值沿用原有契约（桌面端 ChatDriver 按这些字符串分支），改动会破坏调用方
 *   - 幂等：重复注入时直接复用已有实例
 *
 * cfg 需要的字段：
 *   id name url origins composerSelectors sendSelectors sendClassHints sendSvgPaths
 *   sendAriaLabels enterSends loginMarkers verifyUrlRegex
 *   genericComposerSelectors genericSendAriaLabels   ← 通用兜底（同样来自真源）
 *
 * 已废弃：enterSends 目前全站为 false，本文件不再伪造 KeyboardEvent
 * （isTrusted=false 的按键站点可以不认），找不到按钮就如实返回 nobutton。
 * 字段保留在 cfg 里只为将来「只能回车提交」的站点留逃生口。
 */
;(function () {
  'use strict'

  var root = typeof globalThis !== 'undefined' ? globalThis : this
  if (root.__bubbleAskDriver) return

  var VERSION = 1

  // ---------- 基础工具 ----------

  function visible(node) {
    if (!node) return false
    return !!(node.offsetWidth || node.offsetHeight || (node.getClientRects && node.getClientRects().length))
  }

  function enabled(node) {
    if (!node) return false
    if (node.disabled) return false
    if (node.getAttribute && node.getAttribute('aria-disabled') === 'true') return false
    if (/disabled/i.test(String(node.className || ''))) return false
    return true
  }

  function depthOf(node) {
    var depth = 0
    while (node && node.parentElement) {
      depth += 1
      node = node.parentElement
    }
    return depth
  }

  /** 在候选里挑 DOM 最深的那个：避免点到包着真按钮的容器（点了不冒泡到按钮）。 */
  function pick(nodes, test) {
    var best = null
    var bestDepth = -1
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i]
      if (!visible(node)) continue
      if (!test(node)) continue
      var depth = depthOf(node)
      if (depth > bestDepth) {
        best = node
        bestDepth = depth
      }
    }
    return best
  }

  function selectorNodes(selectors) {
    var out = []
    for (var i = 0; i < selectors.length; i += 1) {
      var found
      try {
        found = document.querySelectorAll(selectors[i])
      } catch (error) {
        continue
      }
      for (var j = 0; j < found.length; j += 1) out.push(found[j])
    }
    return out
  }

  /** 先按「可见」找；全都不可见时退回第一个（隐藏的模板/旧节点也算存在）。 */
  function firstVisible(selectors) {
    for (var i = 0; i < selectors.length; i += 1) {
      var found
      try {
        found = document.querySelectorAll(selectors[i])
      } catch (error) {
        continue
      }
      for (var j = 0; j < found.length; j += 1) {
        if (visible(found[j])) return found[j]
      }
    }
    for (var k = 0; k < selectors.length; k += 1) {
      try {
        var first = document.querySelector(selectors[k])
        if (first) return first
      } catch (error2) {
        continue
      }
    }
    return null
  }

  function unique(list) {
    var out = []
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && out.indexOf(list[i]) < 0) out.push(list[i])
    }
    return out
  }

  function listOf(value) {
    return Array.isArray(value) ? value.filter(function (item) {
      return typeof item === 'string' && item.length > 0
    }) : []
  }

  // ---------- 输入框 ----------

  /** provider 专属选择器优先，再补通用兜底（两段都来自真源）。 */
  function composerSelectors(cfg) {
    return unique(listOf(cfg.composerSelectors).concat(listOf(cfg.genericComposerSelectors)))
  }

  function findComposer(cfg) {
    return firstVisible(composerSelectors(cfg))
  }

  function isTextControl(el) {
    var tag = String((el && el.tagName) || '').toUpperCase()
    return tag === 'TEXTAREA' || tag === 'INPUT'
  }

  /** 归一化后的文本（去掉空白、零宽字符、BOM），用于判断「输入框是否已清空」。 */
  function composerText(el) {
    if (!el) return ''
    var raw = isTextControl(el) ? el.value || '' : el.innerText || el.textContent || ''
    return String(raw).replace(/[\s\u200b\u00a0\ufeff]/g, '')
  }

  function fireInput(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  /**
   * 写入文字，返回与旧实现一致的代码：
   *   'none' | 'textarea' | 'editable' | 'failed:nosetter' | 'failed:setter'
   *   | 'failed:readback' | 'failed:reverted' | 'failed:execCommand' | 'failed:empty'
   *
   * textarea：直接改 value 不触发 React 的 onChange，必须走原型链上的原生 setter 再派发 input。
   * 富文本：不能改 textContent（ProseMirror/Quill 只看自己的模型），用 execCommand 走真实输入通道，
   *        失败退 insertHTML 以保留换行。
   */
  function fill(cfg, text) {
    var value = text == null ? '' : String(text)
    var el = findComposer(cfg)
    if (!el) return 'none'

    if (isTextControl(el)) {
      var tag = String(el.tagName).toUpperCase()
      var proto = tag === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
      var descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
      var setter = descriptor ? descriptor.set : null
      if (!setter) return 'failed:nosetter'
      try {
        setter.call(el, value)
      } catch (error) {
        return 'failed:setter'
      }
      if (el.value !== value) return 'failed:readback'
      fireInput(el)
      try {
        el.focus()
      } catch (error2) {
        /* 聚焦失败不影响写入结果 */
      }
      if (el.value !== value) return 'failed:reverted'
      return 'textarea'
    }

    try {
      el.focus()
    } catch (error3) {
      /* 继续，insertText 会插到光标处 */
    }
    try {
      document.execCommand('selectAll', false, null)
    } catch (error4) {
      /* 选不中也继续 */
    }
    var ok = false
    try {
      ok = document.execCommand('insertText', false, value)
    } catch (error5) {
      ok = false
    }
    if (!ok) {
      var escaped = value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\r?\n/g, '<br>')
      try {
        ok = document.execCommand('insertHTML', false, escaped)
      } catch (error6) {
        ok = false
      }
    }
    if (!ok) return 'failed:execCommand'
    fireInput(el)
    if (!composerText(el)) return 'failed:empty'
    return 'editable'
  }

  function focus(cfg) {
    var el = findComposer(cfg)
    if (!el) return 'none'
    try {
      el.focus()
    } catch (error) {
      return 'failed:focus'
    }
    return 'ok'
  }

  // ---------- 发送按钮 ----------

  function attrLabel(node) {
    if (!node || !node.getAttribute) return ''
    var aria = node.getAttribute('aria-label') || ''
    var title = node.getAttribute('title') || ''
    var testId = node.getAttribute('data-testid') || ''
    return aria + ' ' + title + ' ' + testId
  }

  function labelOf(node) {
    return attrLabel(node) + ' ' + String((node && node.className) || '')
  }

  function buttonText(node) {
    return String(node.innerText || node.textContent || '').replace(/[\s\u200b\u00a0]/g, '')
  }

  function iconOnly(node) {
    return !buttonText(node) && !!(node.querySelector && node.querySelector('svg'))
  }

  function nearComposer(composer, depth) {
    var scope = composer
    for (var up = 0; up < depth && scope; up += 1) scope = scope.parentElement
    return scope
  }

  function classHasAllHints(node, hints) {
    var className = String(node.className || '')
    for (var i = 0; i < hints.length; i += 1) {
      if (className.indexOf(hints[i]) < 0) return false
    }
    return true
  }

  function classHasAnyHint(node, hints) {
    var className = String(node.className || '')
    for (var i = 0; i < hints.length; i += 1) {
      if (className.indexOf(hints[i]) >= 0) return true
    }
    return false
  }

  /**
   * 找发送按钮。顺序（与合并前 C# 实现的顺序一致）：
   *   1) provider 专属 CSS
   *   2) provider class 特征（要求同时具备；全部落空时允许「部分具备」兜底）
   *   3) provider 显式文案
   *   4) 通用文案（真源 generic.sendAriaLabels）
   *   5) 输入框附近最后一个「只有图标没有文字」的按钮
   *   6) 带 svg 且语义 class 像发送
   *   7) className 语义
   *   8) provider 的 svg path 前缀（历史兜底）
   *
   * requireEnabled=true 时只接受可点击的按钮（扩展在等待按钮就绪时用）。
   */
  function findSendInternal(cfg, composer, options) {
    var requireEnabled = Boolean(options && options.requireEnabled)
    var accept = function (node) {
      return requireEnabled ? enabled(node) : true
    }

    var bySelector = pick(selectorNodes(listOf(cfg.sendSelectors)), accept)
    if (bySelector) return bySelector

    var hints = listOf(cfg.sendClassHints)
    if (hints.length && composer) {
      var scope = nearComposer(composer, 5)
      if (scope) {
        var buttons = scope.querySelectorAll('button,[role="button"]')
        var withAll = pick(buttons, function (node) {
          return accept(node) && classHasAllHints(node, hints)
        })
        if (withAll) return withAll
        var withAny = pick(buttons, function (node) {
          return accept(node) && classHasAnyHint(node, hints)
        })
        if (withAny) return withAny
      }
    }

    var nodes = document.querySelectorAll('button,[role="button"],[data-testid],div,span')

    var labels = listOf(cfg.sendAriaLabels)
    if (labels.length) {
      var byProviderLabel = pick(nodes, function (node) {
        if (!accept(node)) return false
        var text = attrLabel(node).toLowerCase()
        for (var i = 0; i < labels.length; i += 1) {
          if (text.indexOf(String(labels[i]).toLowerCase()) >= 0) return true
        }
        return false
      })
      if (byProviderLabel) return byProviderLabel
    }

    var genericLabels = listOf(cfg.genericSendAriaLabels)
    if (genericLabels.length) {
      var byGenericLabel = pick(nodes, function (node) {
        if (!accept(node)) return false
        var text = attrLabel(node).toLowerCase()
        for (var i = 0; i < genericLabels.length; i += 1) {
          if (text.indexOf(String(genericLabels[i]).toLowerCase()) >= 0) return true
        }
        return false
      })
      if (byGenericLabel) return byGenericLabel
    }

    if (composer) {
      var near = nearComposer(composer, 4)
      if (near) {
        var nearby = near.querySelectorAll('button,[role="button"]')
        var lastIcon = null
        for (var k = 0; k < nearby.length; k += 1) {
          if (visible(nearby[k]) && accept(nearby[k]) && iconOnly(nearby[k])) lastIcon = nearby[k]
        }
        if (lastIcon) return lastIcon
      }
    }

    var bySvgSemantic = pick(nodes, function (node) {
      return (
        accept(node) &&
        !!(node.querySelector && node.querySelector('svg')) &&
        /send|submit|arrow|paper|plane/i.test(labelOf(node))
      )
    })
    if (bySvgSemantic) return bySvgSemantic

    var byClassSemantic = pick(nodes, function (node) {
      return accept(node) && /send|submit/i.test(String(node.className || ''))
    })
    if (byClassSemantic) return byClassSemantic

    var paths = listOf(cfg.sendSvgPaths)
    if (paths.length) {
      var byPath = pick(nodes, function (node) {
        if (!accept(node)) return false
        if (!(node.querySelector && node.querySelector('svg path'))) return false
        var found = node.querySelectorAll('svg path')
        for (var p = 0; p < found.length; p += 1) {
          var d = String(found[p].getAttribute('d') || '')
          for (var z = 0; z < paths.length; z += 1) {
            if (d.indexOf(paths[z]) === 0) return true
          }
        }
        return false
      })
      if (byPath) return byPath
    }

    return null
  }

  /** 对外：自己解析一次输入框，保证「附近按钮」的判定有锚点。 */
  function findSend(cfg, options) {
    return findSendInternal(cfg, findComposer(cfg), options)
  }

  /** 点发送。返回 'nobutton' | 'disabled:<label>' | 'failed:click' | 'clicked:<label>'。 */
  function send(cfg) {
    var target = findSend(cfg)
    if (!target) return 'nobutton'
    var label = labelOf(target)
    if (!enabled(target)) return 'disabled:' + label
    try {
      target.click()
    } catch (error) {
      return 'failed:click'
    }
    return 'clicked:' + label
  }

  // ---------- 状态回读 ----------

  /** 输入框状态（桌面端 GetComposerState 按这些字段分支）。 */
  function composerState(cfg) {
    var el = findComposer(cfg)
    if (!el) {
      return JSON.stringify({ box: 'none', len: 0, text: false, img: false, send: false, url: location.href })
    }
    var plain = composerText(el)
    var hasImage = !!(el.querySelector && el.querySelector('img,image'))
    var button = findSend(cfg)
    return JSON.stringify({
      box: isTextControl(el) ? 'textarea' : 'editable',
      len: plain.length,
      text: plain.length > 0,
      img: hasImage,
      send: !!(button && enabled(button)),
      url: location.href,
    })
  }

  /** 概览（桌面端 GetStateAsync 直接展示）。 */
  function state(cfg) {
    var el = findComposer(cfg)
    var button = findSend(cfg)
    var tag = el ? String(el.tagName || '').toUpperCase() : ''
    return JSON.stringify({
      hasBox: !!el,
      boxType: tag === 'TEXTAREA' || tag === 'INPUT' ? 'textarea' : el ? 'editable' : 'none',
      hasSend: !!button,
      sendEnabled: !!(button && enabled(button)),
      url: location.href,
      title: document.title,
      provider: cfg && cfg.id ? cfg.id : '',
    })
  }

  // ---------- 上传（桌面端截图提问用） ----------

  function fileInput() {
    var inputs = document.querySelectorAll('input[type="file"]')
    for (var i = 0; i < inputs.length; i += 1) return inputs[i]
    return null
  }

  function openUpload() {
    var nodes = document.querySelectorAll('button,div[role="button"],span[role="button"],label')
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i]
      var label =
        (node.getAttribute('aria-label') || '') +
        ' ' +
        (node.getAttribute('title') || '') +
        ' ' +
        (node.getAttribute('data-testid') || '')
      if (/上传|附件|图片|文件|attach|upload|image|photo|file/i.test(label)) {
        try {
          node.click()
        } catch (error) {
          continue
        }
        return 'clicked:' + label
      }
    }
    return 'none'
  }

  // ---------- 登录 / 地址校验 ----------

  function isLoginUrl(cfg) {
    var markers = listOf(cfg.loginMarkers)
    var href = String(location.href || '').toLowerCase()
    var hit = false
    for (var i = 0; i < markers.length; i += 1) {
      var marker = String(markers[i]).toLowerCase()
      if (marker && href.indexOf(marker) >= 0) hit = true
    }
    return hit
  }

  function urlMatches(cfg) {
    var source = String((cfg && cfg.verifyUrlRegex) || '').trim()
    if (!source) return false
    try {
      return new RegExp(source).test(location.href)
    } catch (error) {
      return false
    }
  }

  function urlMatchedSince(cfg, startedUrl) {
    // 必须先发生 URL 变化才认「会话页」，否则同一会话里第二次发送会被规则直接判成功
    if (location.href === startedUrl) return false
    return urlMatches(cfg)
  }

  /** 发送是否成功：输入框被清空，或 URL 变成会话页。 */
  function verifySent(cfg, startedUrl) {
    var current = findComposer(cfg)
    if (!current) return urlMatchedSince(cfg, startedUrl)
    if (!composerText(current)) return true
    return urlMatchedSince(cfg, startedUrl)
  }

  // ---------- 诊断（--probe） ----------

  function describe(node) {
    if (!node) return null
    var rect = node.getBoundingClientRect()
    return {
      tag: node.tagName,
      cls: String(node.className || ''),
      label: attrLabel(node).trim(),
      text: buttonText(node).slice(0, 40),
      enabled: enabled(node),
      placeholder: (node.getAttribute && node.getAttribute('placeholder')) || '',
      visible: visible(node),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    }
  }

  function listSelectors(selectors) {
    var out = []
    for (var i = 0; i < selectors.length; i += 1) {
      var found
      try {
        found = document.querySelectorAll(selectors[i])
      } catch (error) {
        out.push({ selector: selectors[i], error: String((error && error.message) || error) })
        continue
      }
      for (var j = 0; j < found.length && j < 5; j += 1) {
        out.push({ selector: selectors[i], match: describe(found[j]) })
      }
    }
    return out
  }

  function probe(cfg) {
    var loginHits = []
    var loginLikely = false
    var href = String(location.href || '').toLowerCase()
    var markers = listOf(cfg.loginMarkers)
    for (var i = 0; i < markers.length; i += 1) {
      var marker = String(markers[i] || '').toLowerCase()
      var matched = marker.length > 0 && href.indexOf(marker) >= 0
      if (matched) loginLikely = true
      loginHits.push({ marker: markers[i], matched: matched })
    }

    var all = document.querySelectorAll('button,[role="button"]')
    var candidates = []
    for (var b = 0; b < all.length && candidates.length < 20; b += 1) {
      if (!visible(all[b])) continue
      candidates.push(describe(all[b]))
    }

    return JSON.stringify({
      provider: cfg && cfg.id ? cfg.id : '',
      name: (cfg && cfg.name) || '',
      entryUrl: (cfg && cfg.url) || '',
      url: location.href,
      title: document.title,
      ready: document.readyState,
      verifyUrl: urlMatches(cfg),
      loginLikely: loginLikely,
      loginMarkers: loginHits,
      composerSelectors: composerSelectors(cfg),
      composer: describe(findComposer(cfg)),
      composerCandidates: listSelectors(composerSelectors(cfg)),
      send: describe(findSend(cfg)),
      sendCandidates: listSelectors(listOf(cfg.sendSelectors)),
      buttons: candidates,
    })
  }

  // ---------- 导出 ----------

  root.__bubbleAskDriver = {
    version: VERSION,

    // 基础查询
    visible: visible,
    enabled: enabled,
    findComposer: findComposer,
    findSend: findSend,
    composerText: composerText,
    isLoginUrl: isLoginUrl,
    urlMatches: urlMatches,
    urlMatchedSince: urlMatchedSince,
    verifySent: verifySent,

    // 动作（返回值沿用旧契约，调用方按字符串分支）
    fill: fill,
    focus: focus,
    send: send,

    // 回读
    composerState: composerState,
    state: state,
    probe: probe,

    // 上传
    fileInput: fileInput,
    openUpload: openUpload,
  }
})()
