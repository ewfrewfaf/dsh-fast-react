/**
 * 快速反应 · 侧边栏入口注入（/fr/sidebar.js 实时加载，支持热更新）
 *
 * 核心思路（v3，2026-10-17 重写）：
 *   不再"覆盖"会话区 —— 而是**把 DSH 的原生会话列整个隐藏**，让我们的面板
 *   **占据它的父容器**。这样：
 *     · 输入栏跟着列一起隐藏 ⇒ 绝对不会露出来
 *     · 面板尺寸 = 父容器尺寸 ⇒ 天然严丝合缝
 *     · 关闭时 `display:''` 恢复 ⇒ 会话立刻回来，不需要点别的会话
 *
 * 定位锚点（不再依赖 textarea —— DSH 的输入框可能是 contenteditable）：
 *   侧边栏菜单文本 → 窄容器右边界；右侧最大容器 = 会话列候选；
 *   面板直接挂到「列父容器」并用 inset:0 占满。
 *
 * 可重入：loader 每 4 秒比对内容，变化就重新执行（先 __frCleanup 清理）。
 */
(function () {
  if (window.__frCleanup) { try { window.__frCleanup() } catch (e) { /* 忽略 */ } }

  var PANEL_ID = 'fr-panel-host'
  var BTN_ID = 'fr-sidebar-btn'
  var ACCENT = '#58a6ff'
  var timer = null
  var mo = null
  var state = null      // { col, parent, savedParentPos, savedColDisplay }

  /* ── 1. 定位 ───────────────────────────────────────────────── */
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
      if (r.width >= 150 && r.width <= 400 && r.height > 200) return r.right
      el = el.parentElement
    }
    return 0
  }

  /** 输入控件（textarea / contenteditable / role=textbox 都算） */
  function findInput () {
    return document.querySelector('textarea') ||
      document.querySelector('[contenteditable="true"]') ||
      document.querySelector('[role="textbox"]')
  }

  /**
   * 右侧会话列（**含输入栏**）：
   *   优先用输入控件当锚点向上找"不含侧边栏的最大容器"；
   *   取不到就用「右侧最大容器」兜底。
   */
  function findColumn (left) {
    var vw = window.innerWidth, vh = window.innerHeight
    var input = findInput()
    if (input) {
      var el = input, best = null
      while (el && el !== document.body) {
        var r = el.getBoundingClientRect()
        if (left > 0 && r.left < left - 10) break        // 再往上就会把侧边栏算进来
        if (r.width >= vw * 0.40 && r.height >= vh * 0.45 && isValidColumn(el, left)) best = el
        el = el.parentElement
      }
      if (best) return best
    }
    var nodes = document.querySelectorAll('div,main,section')
    var bestEl = null, bestArea = 0
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      var rr = n.getBoundingClientRect()
      if (left > 0 && rr.left < left - 10) continue
      if (rr.width < vw * 0.40 || rr.height < vh * 0.45) continue
      if (!isValidColumn(n, left)) continue
      var area = rr.width * rr.height
      if (area > bestArea) { bestArea = area; bestEl = n }
    }
    return bestEl
  }

  /**
   * 校验"这真的是一根会话列"，避免在「插件页 / 自动化任务页」这类全屏视图里误判。
   * ★ 实测 bug：在插件页点「快速反应」时会话列不存在 ⇒ 兜底选到 body ⇒ 面板盖住整窗无法操作。
   *   所以这里强校验：不能是 body/html、不能包含侧边栏、不能超过视口、尺寸要像会话列。
   */
  function isValidColumn (el, left) {
    if (!el || el === document.body || el === document.documentElement) return false
    var vw = window.innerWidth, vh = window.innerHeight
    var r
    try { r = el.getBoundingClientRect() } catch (e) { return false }
    if (r.width <= 0 || r.height <= 0) return false
    if (left > 0 && r.left < left - 10) return false              // 包含了侧边栏
    if (r.right > vw + 2) return false                            // 超出视口
    if (r.width > vw * 0.97) return false                         // 太宽（多半是根容器）
    if (r.width < vw * 0.35 || r.height < vh * 0.40) return false // 太小（多半是局部块）
    return true
  }

  /** 圆角（取会话区最上层圆角卡片的 border-radius） */
  function topRadius (left) {
    var vw = window.innerWidth, vh = window.innerHeight
    var nodes = document.querySelectorAll('div,main,section')
    var best = null, bestArea = 0, radius = '0px'
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      var r = el.getBoundingClientRect()
      if (r.width < vw * 0.5 || r.height < vh * 0.3) continue
      if (left > 0 && r.left < left - 10) continue
      var cs
      try { cs = window.getComputedStyle(el) } catch (e) { continue }
      var rad = parseFloat(cs.borderTopLeftRadius) || 0
      if (rad <= 0) continue
      var area = r.width * r.height
      if (area > bestArea) { bestArea = area; best = el; radius = cs.borderTopLeftRadius }
    }
    return radius
  }

  /* ── 2. 面板 ───────────────────────────────────────────────── */
  function buildPanel () {
    var host = document.createElement('div')
    host.id = PANEL_ID
    host.style.cssText = [
      'position:absolute;inset:0',
      'z-index:30',
      'background:#0d1117',
      // ★ 不设圆角：定位到的会话列本身是直角，加圆角会在四角露出底色
      'border-radius:0',
      'overflow:hidden',
      'display:flex;flex-direction:column',
    ].join(';')

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
    // 诊断小字：显示定位到的列尺寸（截图即可据此排查）
    var diag = document.createElement('span')
    diag.id = 'fr-diag'
    diag.style.cssText = 'font-size:11px;color:#6e7681;font-family:ui-monospace,monospace'
    bar.appendChild(diag)
    var sp = document.createElement('span')
    sp.style.flex = '1'
    bar.appendChild(sp)
    var close = document.createElement('button')
    close.textContent = '返回会话'
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

  /* ── 3. 打开 / 关闭 ────────────────────────────────────────── */
  /**
   * 两种模式：
   *   A. **会话视图**（能找到合法会话列）→ 隐藏原生列，面板占其父容器（严丝合缝）
   *   B. **非会话视图**（插件页 / 自动化任务页 / 找不到列）→ 不隐藏任何东西，
   *      用 fixed 浮层只覆盖「侧边栏右侧」的主区 ⇒ 绝不遮挡侧边栏，永远可操作
   */
  function openPanel () {
    var existing = document.getElementById(PANEL_ID)
    if (existing) {
      existing.style.display = 'flex'
      setActive(true)
      attachSidebarWatcher()
      var f = existing.querySelector('iframe')
      if (f && f.contentWindow) { try { f.contentWindow.location.reload() } catch (e) {} }
      return
    }
    var left = sidebarRight()
    var col = findColumn(left)
    var host, diag

    if (col) {
      /* ── 模式 A：会话视图 ── */
      var parent = col.parentElement || document.body
      var colRect = null
      try { colRect = col.getBoundingClientRect() } catch (e) { /* 忽略 */ }
      state = {
        mode: 'inline',
        col: col,
        colDisplay: col.style.display,
        parent: parent,
        parentPos: parent.style.position,
        parentOverflow: parent.style.overflow,
      }
      col.style.display = 'none'
      try {
        if (window.getComputedStyle(parent).position === 'static') parent.style.position = 'relative'
        if (window.getComputedStyle(parent).overflow === 'visible') parent.style.overflow = 'hidden'
      } catch (e) { /* 忽略 */ }
      host = buildPanel()
      parent.appendChild(host)
      if (colRect) diag = 'col ' + Math.round(colRect.width) + '×' + Math.round(colRect.height) + ' @x' + Math.round(colRect.left)
    } else {
      /* ── 模式 B：非会话视图（插件页等）→ fixed 浮层，只占侧边栏右侧 ── */
      state = { mode: 'fixed' }
      host = buildPanel()
      host.style.cssText += ';position:fixed;top:0;right:0;bottom:0;left:' + Math.max(0, Math.round(left)) + 'px'
      document.body.appendChild(host)
      diag = 'fixed 模式（未找到会话列）'
    }

    setActive(true)
    attachSidebarWatcher()
    try {
      var d = host.querySelector('#fr-diag')
      if (d && diag) d.textContent = diag
    } catch (e) { /* 忽略 */ }
  }

  function closePanel () {
    var host = document.getElementById(PANEL_ID)
    if (host) {
      if (state && state.mode === 'fixed') {
        try { host.remove() } catch (e) { host.style.display = 'none' }
      } else {
        host.style.display = 'none'
      }
    }
    // ★ 恢复原生列（会话立刻回来，无需点别的会话）
    if (state && state.mode === 'inline') {
      try { state.col.style.display = state.colDisplay || '' } catch (e) {}
      try { state.parent.style.position = state.parentPos || '' } catch (e) {}
      try { state.parent.style.overflow = state.parentOverflow || '' } catch (e) {}
    }
    setActive(false)
    detachSidebarWatcher()
  }

  /* ── 3.5 单选语义：点侧边栏任意一项（含原来的会话）就自动关闭面板 ──────── */
  var sidebarWatcher = null

  function inSidebar (el) {
    var left = sidebarRight()
    if (!left || !el) return false
    try {
      var r = el.getBoundingClientRect()
      return r.width > 0 && r.left < left
    } catch (e) { return false }
  }

  function attachSidebarWatcher () {
    if (sidebarWatcher) return
    sidebarWatcher = function (e) {
      // 点「快速反应」入口本身：交给它自己的 click 处理
      try { if (e.target && e.target.closest && e.target.closest('#' + BTN_ID)) return } catch (err) {}
      // 点侧边栏里的任何东西（会话项 / 插件 / 自动化任务…）=> 视为"切换到别处"，关面板
      if (inSidebar(e.target)) {
        // 不阻止冒泡、不 preventDefault —— 让 DSH 正常处理切换
        setTimeout(closePanel, 0)
      }
    }
    document.addEventListener('mousedown', sidebarWatcher, true)
  }

  function detachSidebarWatcher () {
    if (!sidebarWatcher) return
    try { document.removeEventListener('mousedown', sidebarWatcher, true) } catch (e) {}
    sidebarWatcher = null
  }

  /** 入口按钮的"选中"视觉（和 DSH 会话项的选中态一个语义） */
  function setActive (on) {
    var btn = document.getElementById(BTN_ID)
    if (!btn) return
    try {
      if (on) {
        btn.style.background = 'rgba(88,166,255,.14)'
        btn.style.boxShadow = 'inset 2px 0 0 #58a6ff'
      } else {
        btn.style.background = ''
        btn.style.boxShadow = ''
      }
    } catch (e) { /* 忽略 */ }
  }

  /** 彻底移除（卸载/重载时用） */
  function destroyPanel () {
    var host = document.getElementById(PANEL_ID)
    if (host) host.remove()
    if (state) {
      try { state.col.style.display = state.colDisplay || '' } catch (e) {}
      try { state.parent.style.position = state.parentPos || '' } catch (e) {}
      try { state.parent.style.overflow = state.parentOverflow || '' } catch (e) {}
    }
    state = null
  }
  window.__frOpenPanel = openPanel
  window.__frClosePanel = closePanel

  /* ── 4. 注入入口按钮 ───────────────────────────────────────── */
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

  /* ── 5. 启动 + 清理钩子 ────────────────────────────────────── */
  var tries = 0
  timer = setInterval(function () {
    tries++
    inject()
    if (tries > 900) { clearInterval(timer); timer = null }
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
    try { destroyPanel() } catch (e) {}
  }
})()
