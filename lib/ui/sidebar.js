/**
 * 快速反应 · 侧边栏入口注入（/fr/sidebar.js 实时加载，支持热更新）
 *
 * 设计目标：
 *  1. 在「自动化任务」下方加「快速反应」入口（cloneNode 复制现有菜单项，样式一致）
 *  2. 点开后面板**严丝合缝覆盖整个右侧会话列**（含底部原生输入栏），
 *     上方圆角跟随 DSH 会话卡片，下方贴到窗口底
 *  3. 不影响左侧边栏、不遮挡右下角挂件（z-index 30）
 *  4. **关闭时完整还原宿主样式** —— 否则 DSH 布局被破坏，会出现"必须点别的会话才能刷新"
 *  5. 可重入：重复执行会先清理上一次留下的按钮/面板/定时器（loader 热更新用）
 */
(function () {
  /* ── 0. 清理上一次执行留下的东西（热更新支持）───────────────── */
  if (window.__frCleanup) { try { window.__frCleanup() } catch (e) { /* 忽略 */ } }

  var PANEL_ID = 'fr-panel-host'
  var BTN_ID = 'fr-sidebar-btn'
  var ACCENT = '#58a6ff'
  var timer = null
  var mo = null

  /* ── 1. 定位：侧边栏边界 / 圆角卡片 / 含输入栏的整列 ─────────── */
  function findAnchor () {
    var nodes = document.querySelectorAll('a,button,li,div,span')
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      if (el.children && el.children.length > 3) continue
      var tx = (el.textContent || '').trim()
      if (tx === '自动化任务' || tx === '插件') {
        var p = el
        for (var d = 0; d < 4 && p.parentElement; d++) {
          if (p.tagName === 'A' || p.tagName === 'BUTTON' || p.tagName === 'LI' || p.getAttribute('role') === 'button') return p
          p = p.parentElement
        }
        return el.parentElement || el
      }
    }
    return null
  }

  /** 侧边栏右边界（px）；找不到返回 0 */
  function sidebarRight () {
    var a = findAnchor()
    if (!a) return 0
    var el = a
    while (el && el !== document.body) {
      var r = el.getBoundingClientRect()
      if (r.width >= 160 && r.width <= 380 && r.height > 200) return r.right
      el = el.parentElement
    }
    return 0
  }

  /** 圆角会话卡片（只为取圆角值） */
  function findCard (left) {
    var vw = window.innerWidth, vh = window.innerHeight
    var nodes = document.querySelectorAll('div,main,section')
    var best = null, bestScore = -1
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      var r = el.getBoundingClientRect()
      if (r.width < vw * 0.5 || r.height < vh * 0.3) continue
      if (r.left < left - 8) continue
      var cs
      try { cs = window.getComputedStyle(el) } catch (e) { continue }
      var radius = parseFloat(cs.borderTopLeftRadius) || 0
      if (radius <= 0) continue
      var score = r.width * r.height + radius * 20000
      if (score > bestScore) { bestScore = score; best = el }
    }
    return best
  }

  /**
   * 整个右侧会话列（含底部原生输入栏）。
   * 用 textarea 当锚点向上找：一直找到"再往上就会包含侧边栏"之前的最大容器。
   */
  function findColumn (left) {
    var vw = window.innerWidth, vh = window.innerHeight
    var ta = document.querySelector('textarea')
    if (ta) {
      var el = ta, best = null
      while (el && el !== document.body) {
        var r = el.getBoundingClientRect()
        if (left > 0 && r.left < left - 8) break      // 再往上会包含侧边栏，停
        if (r.width >= vw * 0.45 && r.height >= vh * 0.5) best = el
        el = el.parentElement
      }
      if (best) return best
    }
    // 兜底：右侧最大容器
    var nodes = document.querySelectorAll('div,main,section')
    var bestEl = null, bestArea = 0
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      var rr = n.getBoundingClientRect()
      if (left > 0 && rr.left < left - 8) continue
      if (rr.width < vw * 0.45 || rr.height < vh * 0.5) continue
      var area = rr.width * rr.height
      if (area > bestArea) { bestArea = area; bestEl = n }
    }
    return bestEl
  }

  /* ── 2. 面板 ───────────────────────────────────────────────── */
  function buildPanel (radiusTop) {
    var host = document.createElement('div')
    host.id = PANEL_ID
    host.style.cssText = [
      'position:absolute;inset:0',                       // 尺寸完全由宿主容器决定
      'z-index:30',                                      // 低于挂件层，鲸鱼仍在上面
      'background:#0d1117',
      'border-radius:' + (radiusTop || '0') + ' ' + (radiusTop || '0') + ' 0 0',
      'overflow:hidden',
      'display:flex;flex-direction:column',
    ].join(';')

    // 顶部细强调线：与 DSH 呼应，但带一点自己的标识
    var accent = document.createElement('div')
    accent.style.cssText = 'height:2px;flex:0 0 auto;background:linear-gradient(90deg,' + ACCENT + ',rgba(88,166,255,0))'
    host.appendChild(accent)

    var bar = document.createElement('div')
    bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:9px 16px;background:#161b22;border-bottom:1px solid #30363d;flex:0 0 auto;font:13px -apple-system,"Segoe UI","PingFang SC",sans-serif;color:#e6edf3'
    var dot = document.createElement('span')
    dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:' + ACCENT + ';flex:0 0 auto'
    bar.appendChild(dot)
    var t = document.createElement('b')
    t.textContent = '快速反应'
    t.style.cssText = 'font-size:13.5px;letter-spacing:.3px'
    bar.appendChild(t)
    var sp = document.createElement('span')
    sp.style.flex = '1'
    bar.appendChild(sp)
    var close = document.createElement('button')
    close.textContent = '返回会话'
    close.setAttribute('data-fr-close', '1')
    close.style.cssText = 'cursor:pointer;background:#21262d;border:1px solid #30363d;color:#e6edf3;border-radius:7px;padding:4px 12px;font:12.5px inherit'
    close.onclick = function (e) { e.stopPropagation(); closePanel() }
    bar.appendChild(close)
    host.appendChild(bar)

    var frame = document.createElement('iframe')
    frame.src = '/fr?embed=1'
    frame.style.cssText = 'flex:1 1 auto;border:0;width:100%;background:#0d1117'
    host.appendChild(frame)
    return host
  }

  /* ── 3. 宿主样式保存/还原（关键：不还原会破坏 DSH 布局）───────── */
  var saved = null

  function applyHostStyle (target) {
    saved = { el: target, position: target.style.position, overflow: target.style.overflow }
    try {
      if (window.getComputedStyle(target).position === 'static') target.style.position = 'relative'
      if (window.getComputedStyle(target).overflow === 'visible') target.style.overflow = 'hidden'
    } catch (e) { /* 忽略 */ }
  }

  function restoreHostStyle () {
    if (!saved) return
    try {
      saved.el.style.position = saved.position || ''
      saved.el.style.overflow = saved.overflow || ''
    } catch (e) { /* 忽略 */ }
    saved = null
  }

  /* ── 4. 打开 / 关闭 ────────────────────────────────────────── */
  function openPanel () {
    var host = document.getElementById(PANEL_ID)
    if (host) {
      host.style.display = 'flex'
      var f = host.querySelector('iframe')
      if (f && f.contentWindow) { try { f.contentWindow.location.reload() } catch (e) {} }
      return
    }
    var left = sidebarRight()
    var card = findCard(left)
    var col = findColumn(left)
    var target = col || card || document.body
    var radiusTop = '0px'
    try {
      if (card) {
        var rad = window.getComputedStyle(card).borderTopLeftRadius
        if (rad && rad !== '0px') radiusTop = rad
      }
    } catch (e) { /* 忽略 */ }

    if (target !== document.body) applyHostStyle(target)
    host = buildPanel(radiusTop)
    ;(target === document.body ? document.body : target).appendChild(host)
  }

  function closePanel () {
    var host = document.getElementById(PANEL_ID)
    if (host) host.style.display = 'none'
    restoreHostStyle()   // ★ 还原宿主样式，避免"必须点别的会话才能刷新"
  }
  window.__frOpenPanel = openPanel
  window.__frClosePanel = closePanel

  /* ── 5. 注入入口按钮 ───────────────────────────────────────── */
  function inject () {
    if (document.getElementById(BTN_ID)) return true
    var anchor = findAnchor()
    if (!anchor || !anchor.parentElement) return false
    var btn = anchor.cloneNode(true)
    btn.id = BTN_ID
    btn.removeAttribute('href')
    var label = btn.querySelector('span,div')
    if (label && label.children.length === 0) label.textContent = '快速反应'
    else btn.textContent = '快速反应'
    btn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation()
      openPanel()
    })
    btn.style.cursor = 'pointer'
    anchor.parentElement.insertBefore(btn, anchor.nextSibling)
    return true
  }

  /* ── 6. 启动 + 清理钩子 ────────────────────────────────────── */
  var tries = 0
  timer = setInterval(function () {
    tries++
    if (inject()) { /* 成功后继续保留定时器（DOM 重建时补回） */ }
    if (tries > 600) { clearInterval(timer); timer = null }
  }, 400)
  try {
    mo = new MutationObserver(function () {
      if (!document.getElementById(BTN_ID)) inject()
    })
    mo.observe(document.body, { childList: true, subtree: true })
  } catch (e) { /* 忽略 */ }

  function onKey (e) {
    if (e.key === 'Escape') closePanel()
  }
  document.addEventListener('keydown', onKey)

  window.__frCleanup = function () {
    try { if (timer) clearInterval(timer) } catch (e) {}
    try { if (mo) mo.disconnect() } catch (e) {}
    try { document.removeEventListener('keydown', onKey) } catch (e) {}
    try { var b = document.getElementById(BTN_ID); if (b) b.remove() } catch (e) {}
    try { var h = document.getElementById(PANEL_ID); if (h) h.remove() } catch (e) {}
    try { restoreHostStyle() } catch (e) {}
  }
})()
