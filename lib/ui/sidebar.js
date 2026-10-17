/**
 * 快速反应 · 侧边栏入口注入（从 /fr/sidebar.js 实时加载，改这里不用重启插件）
 *
 * 设计目标（用户要求）：
 *  1. 在「自动化任务」下面加一个「快速反应」入口（样式与 DSH 现有菜单一致）
 *  2. 点开后**严丝合缝覆盖右侧会话区**（不动左侧边栏、不盖右下角挂件）
 *  3. 圆角跟随 DSH 会话容器（border-radius: inherit）
 *  4. 视觉与 DSH 设计语言相通，但有一点自己的标识（顶部细强调线）
 *
 * 定位策略（不硬编码选择器，DSH 改版也能用）：
 *  - 用文本锚点找侧边栏菜单项 → 往上找窄容器（160~360px）得到侧边栏边界
 *  - 在「侧边栏右侧 + 宽度 > 视口 50%」的候选里，优先选**有圆角**的最大容器 = 会话卡片
 *  - 找不到就退回 body（全窗覆盖，至少可用）
 */
(function () {
  if (window.__frSidebar) return
  window.__frSidebar = 1

  var PANEL_ID = 'fr-panel-host'
  var ACCENT = '#58a6ff'

  /* ── 找侧边栏菜单项（文本锚点）──────────────────────────────── */
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

  /* ── 找右侧会话区容器 ───────────────────────────────────────── */
  function sidebarRight () {
    var a = findAnchor()
    if (!a) return 0
    var el = a
    while (el && el !== document.body) {
      var r = el.getBoundingClientRect()
      if (r.width >= 160 && r.width <= 360 && r.height > 200) return r.right
      el = el.parentElement
    }
    return 0
  }

  function findMainArea () {
    var vw = window.innerWidth
    var vh = window.innerHeight
    var left = sidebarRight()
    var nodes = document.querySelectorAll('div,main,section')
    var best = null
    var bestScore = -1
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      var r = el.getBoundingClientRect()
      if (r.width < vw * 0.5 || r.height < vh * 0.5) continue
      if (r.left < left - 8) continue
      var cs
      try { cs = window.getComputedStyle(el) } catch (e) { continue }
      var radius = parseFloat(cs.borderTopLeftRadius) || 0
      // 分数：面积为主，圆角加分（DSH 会话区是个圆角卡片）
      var score = r.width * r.height + radius * 20000
      if (score > bestScore) { bestScore = score; best = el }
    }
    return best
  }

  /* ── 面板 ──────────────────────────────────────────────────── */
  function buildPanel (target) {
    var isBody = !target || target === document.body
    var host = document.createElement('div')
    host.id = PANEL_ID
    host.style.cssText = [
      isBody ? 'position:fixed;inset:0' : 'position:absolute;inset:0',
      'z-index:30',
      'background:#0d1117',
      isBody ? 'border-radius:0' : 'border-radius:inherit',
      'overflow:hidden',
      'display:flex',
      'flex-direction:column',
      'box-shadow:inset 0 1px 0 rgba(255,255,255,.04)',
    ].join(';')

    // 顶部细强调线：和 DSH 呼应，但带一点自己的标识
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
    close.style.cssText = 'cursor:pointer;background:#21262d;border:1px solid #30363d;color:#e6edf3;border-radius:7px;padding:4px 12px;font:12.5px inherit'
    close.onclick = function () { host.style.display = 'none' }
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
      var f = host.querySelector('iframe')
      if (f && f.contentWindow) { try { f.contentWindow.location.reload() } catch (e) {} }
      return
    }
    var target = findMainArea()
    if (target) {
      var cs = window.getComputedStyle(target)
      if (cs.position === 'static') target.style.position = 'relative'
      // 容器本身裁切掉溢出，保证圆角严丝合缝
      if (cs.overflow === 'visible') target.style.overflow = 'hidden'
    }
    host = buildPanel(target)
    ;(target || document.body).appendChild(host)
    window.__frPanelTarget = target || document.body
  }
  window.__frOpenPanel = openPanel

  /* ── 注入入口按钮 ──────────────────────────────────────────── */
  function inject () {
    if (document.getElementById('fr-sidebar-btn')) return true
    var anchor = findAnchor()
    if (!anchor || !anchor.parentElement) return false
    var btn = anchor.cloneNode(true)
    btn.id = 'fr-sidebar-btn'
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

  var tries = 0
  var timer = setInterval(function () {
    tries++
    if (inject() || tries > 300) clearInterval(timer)
  }, 400)
  try {
    var mo = new MutationObserver(function () {
      if (!document.getElementById('fr-sidebar-btn')) inject()
    })
    mo.observe(document.body, { childList: true, subtree: true })
  } catch (e) {}

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var h = document.getElementById(PANEL_ID)
      if (h) h.style.display = 'none'
    }
  })
})()
