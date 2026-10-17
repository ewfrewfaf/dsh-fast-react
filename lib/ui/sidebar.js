/**
 * 快速反应 · 侧边栏入口（/fr/sidebar.js，loader 每 4 秒比对内容自动更新）
 *
 * ══ v6 设计（2026-10-17 最终版，彻底放弃 DOM 手术）══
 *
 * 失败的教训：
 *   v1~v5 都在做「隐藏 DSH 的会话列 + 面板占它的父容器」——依赖对 DSH DOM 的精确推断。
 *   结果：会话视图能对上，但一到插件页/自动化任务页就找不到列，兜底选到 body，
 *   面板盖住整个窗口（连侧边栏都没了），无法操作。
 *
 * 现在的做法（不可出错）：
 *   面板就是一个 **fixed 浮层**，只占「侧边栏右侧」：
 *     top:6px  bottom:6px  right:6px  left:<侧边栏宽度，最小 240>
 *   · 从不隐藏/移动任何 DSH 元素 ⇒ 不可能破坏它的布局
 *   · 侧边栏永远可见可点 ⇒ 永远有退路
 *   · 关闭 = 移除自己的 div ⇒ DSH 原样恢复
 *   · 只有一种模式，没有分支 ⇒ 没有分支就没有漏判
 */
(function () {
  if (window.__frCleanup) { try { window.__frCleanup() } catch (e) { /* 忽略 */ } }

  var PANEL_ID = 'fr-panel-host'
  var BTN_ID = 'fr-sidebar-btn'
  var VERSION = 'v6'
  var ACCENT = '#58a6ff'
  var timer = null
  var mo = null
  var sidebarWatcher = null

  /* ── 1. 侧边栏锚点 / 宽度 ──────────────────────────────────── */
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

  /** 侧边栏宽度（px）。**下限 240**：算不出来也不会变成 0（那会盖住侧边栏） */
  function sidebarWidth () {
    var a = findAnchor()
    if (a) {
      var el = a
      while (el && el !== document.body) {
        var r = el.getBoundingClientRect()
        if (r.width >= 150 && r.width <= 420 && r.height > 180) return Math.round(r.width)
        el = el.parentElement
      }
    }
    return 240
  }

  /* ── 2. 面板：纯 fixed 浮层 ────────────────────────────────── */
  function buildPanel () {
    var host = document.createElement('div')
    host.id = PANEL_ID
    var left = Math.max(240, sidebarWidth() + 8)
    host.style.cssText = [
      'position:fixed',
      'top:6px',
      'bottom:6px',
      'right:6px',
      'left:' + left + 'px',
      'z-index:2147483000',
      'background:#0d1117',
      'border:1px solid #30363d',
      'border-radius:12px',
      'overflow:hidden',
      'display:flex',
      'flex-direction:column',
      'box-shadow:0 18px 60px rgba(0,0,0,.6)',
    ].join(';')

    // 顶部强调线
    var accent = document.createElement('div')
    accent.style.cssText = 'height:2px;flex:0 0 auto;background:linear-gradient(90deg,' + ACCENT + ',rgba(88,166,255,0))'
    host.appendChild(accent)

    var bar = document.createElement('div')
    bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 14px;background:#161b22;border-bottom:1px solid #30363d;flex:0 0 auto;font:13px -apple-system,"Segoe UI","PingFang SC",sans-serif;color:#e6edf3'
    var dot = document.createElement('span')
    dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:' + ACCENT + ';flex:0 0 auto'
    bar.appendChild(dot)
    var t = document.createElement('b')
    t.textContent = '快速反应'
    t.style.cssText = 'font-size:13.5px;letter-spacing:.3px'
    bar.appendChild(t)
    var ver = document.createElement('span')
    ver.textContent = VERSION
    ver.style.cssText = 'font-size:10.5px;color:#6e7681;font-family:ui-monospace,monospace'
    bar.appendChild(ver)
    var sp = document.createElement('span')
    sp.style.flex = '1'
    bar.appendChild(sp)
    var close = document.createElement('button')
    close.textContent = '返回会话  ✕'
    close.style.cssText = 'cursor:pointer;background:#21262d;border:1px solid #30363d;color:#e6edf3;border-radius:7px;padding:5px 13px;font:12.5px inherit;font-weight:600'
    close.onclick = function (e) { e.stopPropagation(); closePanel() }
    bar.appendChild(close)
    host.appendChild(bar)

    var frame = document.createElement('iframe')
    frame.src = '/fr?embed=1'
    frame.style.cssText = 'flex:1 1 auto;border:0;width:100%;background:#0d1117'
    host.appendChild(frame)
    return host
  }

  function openPanel () {
    var host = document.getElementById(PANEL_ID)
    if (host) {
      host.style.display = 'flex'
      setActive(true)
      attachSidebarWatcher()
      return
    }
    host = buildPanel()
    document.body.appendChild(host)
    setActive(true)
    attachSidebarWatcher()
  }

  function closePanel () {
    var host = document.getElementById(PANEL_ID)
    if (host) { try { host.remove() } catch (e) { host.style.display = 'none' } }
    setActive(false)
    detachSidebarWatcher()
  }
  window.__frOpenPanel = openPanel
  window.__frClosePanel = closePanel
  window.__frVersion = VERSION

  /* ── 3. 点侧边栏任意一项 → 自动关闭面板（单选语义）────────────── */
  var savedWidth = 240

  function inSidebar (el) {
    if (!el) return false
    try {
      var r = el.getBoundingClientRect()
      return r.width > 0 && r.left < savedWidth
    } catch (e) { return false }
  }

  function attachSidebarWatcher () {
    if (sidebarWatcher) return
    savedWidth = Math.max(240, sidebarWidth() + 8)
    sidebarWatcher = function (e) {
      try { if (e.target && e.target.closest && e.target.closest('#' + BTN_ID)) return } catch (err) {}
      if (inSidebar(e.target)) setTimeout(closePanel, 0)   // 不阻止冒泡，DSH 正常切
    }
    document.addEventListener('mousedown', sidebarWatcher, true)
  }

  function detachSidebarWatcher () {
    if (!sidebarWatcher) return
    try { document.removeEventListener('mousedown', sidebarWatcher, true) } catch (e) {}
    sidebarWatcher = null
  }

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

  /* ── 4. 入口按钮 ───────────────────────────────────────────── */
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

  /* ── 5. 启动 / 键盘 / 消息 / 清理 ──────────────────────────── */
  var tries = 0
  timer = setInterval(function () {
    tries++
    inject()
    if (tries > 1800) { clearInterval(timer); timer = null }
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
  window.addEventListener('message', function (ev) {
    try { if (ev && ev.data && ev.data.fr === 'close') closePanel() } catch (e) { /* 忽略 */ }
  })

  window.__frCleanup = function () {
    try { if (timer) clearInterval(timer) } catch (e) {}
    try { if (mo) mo.disconnect() } catch (e) {}
    try { document.removeEventListener('keydown', onKey) } catch (e) {}
    try { detachSidebarWatcher() } catch (e) {}
    try { var b = document.getElementById(BTN_ID); if (b) b.remove() } catch (e) {}
    try { var h = document.getElementById(PANEL_ID); if (h) h.remove() } catch (e) {}
  }
})()
