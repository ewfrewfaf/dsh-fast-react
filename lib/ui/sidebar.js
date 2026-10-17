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

  var VERSION = 'v8'
  // ★ 面板 id 随版本变化：旧实例（v7 等）的僵尸定时器/监听器查不到新 id
  //   ⇒ 自动空转失效，不会再与新实例互相打架（抽搐的根源之一）
  var PANEL_ID = 'fr-panel-' + VERSION
  var BTN_ID = 'fr-sidebar-btn'
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

  /* ── 2. 面板：纯 fixed 浮层（位置/圆角对齐原生会话区，只读测量）────── */

  /**
   * 只读测量 DSH 原生会话区的几何信息（位置 + 四角圆角）。
   * ★ 只读，绝不修改 DSH 元素 —— 安全。
   *
   * 实测（2026-10-17 探针回传的真实数据）：
   *   BynINW_centerCol  x:264 y:40  w:1656 h:992  radius:16px   ← 正确目标
   *   Dc7zOa_viewArea   x:264 y:-10889 w:1649 h:11794           ← 陷阱：负 y + 超高
   * 上一版按"面积最大"选到了 viewArea ⇒ 面板被撑到屏幕外 ⇒ 覆盖不全。
   *
   * 选取策略（按可靠性）：
   *   1) className 含 `_centerCol`（DSH 用 CSS Modules：<hash>_centerCol，后缀稳定）
   *   2) 有圆角 + 完全在视口内 + 又不超出视口
   *   3) 都没有就返回 null（调用方用固定边距兜底）
   */
  function measureNative () {
    var vw = window.innerWidth, vh = window.innerHeight
    var nodes = document.querySelectorAll('div,main,section,article')
    var best = null

    function geoOf (el) {
      var r
      try { r = el.getBoundingClientRect() } catch (e) { return null }
      if (r.width < vw * 0.35 || r.height < vh * 0.45) return null
      if (r.top < 0 || r.top > vh * 0.2) return null       // 必须在视口顶部附近（排除滚动区）
      if (r.height > vh * 1.05) return null                // 不能高于视口（排除超长滚动容器）
      if (r.left < 200) return null                        // 不能包含侧边栏
      var cs
      try { cs = window.getComputedStyle(el) } catch (e) { return null }
      var rad = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].join(' ')
      return {
        top: Math.round(r.top),
        left: Math.round(r.left),
        width: Math.round(r.width),
        height: Math.round(r.height),
        radius: rad,
        hasRadius: (parseFloat(cs.borderTopLeftRadius) || 0) > 0,
      }
    }

    // 1) 优先 DSH 的 centerCol
    for (var i = 0; i < nodes.length; i++) {
      if (/_centerCol/.test(String(nodes[i].className || ''))) {
        var g1 = geoOf(nodes[i])
        if (g1) { best = g1; break }
      }
    }
    // 2) 兜底：有圆角 + 在各约束内，取面积最大的
    if (!best) {
      var bestArea = 0
      for (var j = 0; j < nodes.length; j++) {
        var g = geoOf(nodes[j])
        if (!g || !g.hasRadius) continue
        var area = g.width * g.height
        if (area > bestArea) { bestArea = area; best = g }
      }
    }
    if (!best) return null
    delete best.hasRadius
    return best
  }

  function buildPanel () {
    var host = document.createElement('div')
    host.id = PANEL_ID
    var geo = measureNative()
    var css = [
      'position:fixed',
      'z-index:2147483000',
      'background:#0d1117',
      'overflow:hidden',
      'display:flex',
      'flex-direction:column',
    ]
    if (geo) {
      // ★ 精确套用原生会话区（探针实测数据验证过：centerCol 264,40,1656,992,16px）
      css.push('top:' + geo.top + 'px')
      css.push('left:' + geo.left + 'px')
      css.push('width:' + geo.width + 'px')
      css.push('height:' + geo.height + 'px')
      css.push('border-radius:' + geo.radius)
      css.push('border:0')
      css.push('box-shadow:0 18px 60px rgba(0,0,0,.45)')
    } else {
      // 兜底：固定边距（不遮挡侧边栏）
      css.push('top:6px')
      css.push('bottom:6px')
      css.push('right:6px')
      css.push('left:' + Math.max(240, sidebarWidth() + 8) + 'px')
      css.push('border-radius:12px')
      css.push('border:1px solid #30363d')
      css.push('box-shadow:0 18px 60px rgba(0,0,0,.6)')
    }
    host.style.cssText = css.join(';')
    host.setAttribute('data-fr-geo', geo ? 'native' : 'fallback')

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

  /* ── 2.9 布局同步（v8：纯稳定检测，杜绝震荡）──────────────────────────
     实测教训：
       ① 拖动过程中 DSH 布局连续变化 ⇒ 跟随就会「抽搐」
       ② mouseup 时强制套用瞬间值 ⇒ DSH 还在过渡动画 ⇒「弹回去又弹回来」
       ③ 旧实例的同步定时器/监听器不清理 ⇒ 多实例叠加互相打架
     v8 规则（只有一条）：
       每 120ms 采样一次，**同一几何连续出现 4 次（约 480ms 稳定）才套用一次**。
       拖动中几何每帧都变 ⇒ 永不稳定 ⇒ 面板冻结不跳；
       松手后 DSH 过渡结束稳定下来 ⇒ 自动一次性贴合，无强制、无震荡。
  */
  var stableKey = ''
  var stableCount = 0
  var appliedKey = ''
  var mousePressed = false
  var syncTimer = null
  var boundListeners = []

  function applyGeo (host, geo) {
    try {
      host.style.top = geo.top + 'px'
      host.style.left = geo.left + 'px'
      host.style.width = geo.width + 'px'
      host.style.height = geo.height + 'px'
      host.style.right = 'auto'
      host.style.bottom = 'auto'
      host.style.borderRadius = geo.radius
      host.style.border = '0'
      host.style.boxShadow = '0 18px 60px rgba(0,0,0,.45)'
      host.setAttribute('data-fr-geo', 'native')
    } catch (e) { /* 忽略 */ }
  }

  function syncTick () {
    try {
      var host = document.getElementById(PANEL_ID)
      if (!host) { stableKey = ''; stableCount = 0; appliedKey = ''; return }
      if (mousePressed) { stableCount = 0; return }       // 按下期间冻结，不累计
      var geo = measureNative()
      if (!geo) return
      var key = geo.top + ',' + geo.left + ',' + geo.width + ',' + geo.height + ',' + geo.radius
      if (key === appliedKey) { stableKey = key; stableCount = 0; return }
      if (key === stableKey) stableCount++
      else { stableKey = key; stableCount = 1; return }
      if (stableCount >= 4) {                             // 连续 4 次一致（~480ms）
        appliedKey = key
        stableCount = 0
        applyGeo(host, geo)
      }
    } catch (e) { /* 忽略 */ }
  }

  function onDocMouseDown () { mousePressed = true; stableCount = 0 }
  function onDocMouseUp () { mousePressed = false }        // 不强制套用，交给稳定检测
  function onWinResize () { stableKey = ''; stableCount = 0; appliedKey = '' }

  document.addEventListener('mousedown', onDocMouseDown, true)
  document.addEventListener('mouseup', onDocMouseUp, true)
  window.addEventListener('resize', onWinResize)
  boundListeners.push(
    ['mousedown', onDocMouseDown, true],
    ['mouseup', onDocMouseUp, true],
  )
  syncTimer = setInterval(syncTick, 120)
  window.__frStopSync = function () {
    try { if (syncTimer) clearInterval(syncTimer) } catch (e) {}
    syncTimer = null
    try { boundListeners.forEach(function (L) { document.removeEventListener(L[0], L[1], L[2]) }) } catch (e) {}
    try { window.removeEventListener('resize', onWinResize) } catch (e) {}
    boundListeners = []
  }
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
    if (document.getElementById(BTN_ID)) {
      // 已存在但版本不同 ⇒ 说明是旧脚本留下的，更新文字（避免版本号对不上）
      try {
        var old = document.getElementById(BTN_ID)
        var tag = old.querySelector('#fr-btn-ver')
        if (tag && tag.textContent !== VERSION) tag.textContent = VERSION
        else if (!tag) { old.setAttribute('data-fr-ver', VERSION) }
      } catch (e) { /* 忽略 */ }
      return true
    }
    var anchor = findAnchor()
    if (!anchor || !anchor.parentElement) return false
    var btn = anchor.cloneNode(true)
    btn.id = BTN_ID
    btn.setAttribute('data-fr-ver', VERSION)
    btn.removeAttribute('href')
    var label = btn.querySelector('span,div')
    if (label && label.children.length === 0) label.textContent = '快速反应'
    else btn.textContent = '快速反应'
    // 侧边栏里直接显示版本号（肉眼即可确认浏览器跑的是哪一版）
    var verTag = document.createElement('span')
    verTag.id = 'fr-btn-ver'
    verTag.textContent = VERSION
    verTag.style.cssText = 'opacity:.45;font-size:10px;margin-left:5px;font-family:ui-monospace,monospace'
    btn.appendChild(verTag)
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
    // ★ 必须先停掉旧实例的同步循环与监听（否则新旧多个采样循环叠加打架 = 抽搐根源）
    try { if (typeof window.__frStopSync === 'function') window.__frStopSync() } catch (e) {}
    try { if (timer) clearInterval(timer) } catch (e) {}
    try { if (mo) mo.disconnect() } catch (e) {}
    try { document.removeEventListener('keydown', onKey) } catch (e) {}
    try { detachSidebarWatcher() } catch (e) {}
    try { var b = document.getElementById(BTN_ID); if (b) b.remove() } catch (e) {}
    try { var h = document.getElementById(PANEL_ID); if (h) h.remove() } catch (e) {}
  }
})()
