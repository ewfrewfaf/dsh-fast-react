/**
 * 快速反应 · 独立全页控制台（/fr）
 *
 * 设计约束（来自项目经验总结）：
 *  - Electron 桌面端没有 F5：所有资源**内联**在一个 HTML 里，避免分支文件被缓存
 *  - 不做字节级拼装：这里就是完整 HTML 字符串，改的是源头
 *  - 页面自包含：不依赖 DSH 的 CSS 变量（独立路由，可能拿不到）
 *  - 轮询而非 SSE：1s 一次 /fr/api/status，简单可靠、断线自恢复
 */
export const PANEL_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>快速反应控制台</title>
<style>
  :root{
    --bg:#0d1117; --bg2:#161b22; --bg3:#1c2128; --line:#30363d;
    --fg:#e6edf3; --fg2:#8b949e; --accent:#58a6ff; --ok:#3fb950; --warn:#d29922; --err:#f85149;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;height:100%}
  body{background:var(--bg);color:var(--fg);font:13px/1.55 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden}
  #app{display:flex;flex-direction:column;height:100vh}

  /* 顶栏 */
  header{display:flex;align-items:center;gap:14px;padding:12px 18px;background:var(--bg2);border-bottom:1px solid var(--line);flex:0 0 auto}
  .brand{display:flex;align-items:center;gap:9px;font-weight:600;font-size:14px;letter-spacing:.3px}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--fg2);box-shadow:0 0 0 3px rgba(255,255,255,.04)}
  .dot.on{background:var(--ok);box-shadow:0 0 8px var(--ok)}
  .dot.busy{background:var(--warn);box-shadow:0 0 8px var(--warn);animation:pulse 1.2s infinite}
  @keyframes pulse{50%{opacity:.35}}
  .chips{display:flex;gap:8px;flex-wrap:wrap}
  .chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px solid var(--line);border-radius:999px;background:var(--bg3);font-size:12px;color:var(--fg2)}
  .chip b{color:var(--fg);font-weight:600}
  .grow{flex:1}
  button{cursor:pointer;border:1px solid var(--line);background:var(--bg3);color:var(--fg);padding:6px 13px;border-radius:7px;font-size:12.5px;transition:.15s;font-family:inherit}
  button:hover:not(:disabled){border-color:#4b5563;background:#242a33}
  button:disabled{opacity:.45;cursor:not-allowed}
  button.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}
  button.primary:hover:not(:disabled){background:#2f81f7}
  button.danger{background:#8b1a1a;border-color:#a02424;color:#ffdada}
  button.danger:hover:not(:disabled){background:#a52424}
  button.ghost{background:transparent}

  /* 主体三栏 */
  main{display:grid;grid-template-columns:minmax(320px,1fr) minmax(340px,1.05fr) 320px;gap:1px;background:var(--line);flex:1 1 auto;min-height:0}
  .col{background:var(--bg);padding:14px 16px;overflow:auto;min-height:0}
  /* 对话气泡 */
  .msg{display:flex;flex-direction:column;gap:3px;margin-bottom:10px;padding:8px 11px;border-radius:9px;border:1px solid var(--line);background:var(--bg2);max-width:97%}
  .msg .who{font-size:10.5px;letter-spacing:.6px;color:#6e7681;display:flex;gap:7px;align-items:center}
  .msg .txt{white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.55}
  .msg.me{margin-left:auto;border-color:rgba(31,111,235,.4);background:rgba(31,111,235,.10)}
  .msg.me .who{color:#79b8ff}
  .msg.back{border-color:rgba(110,64,201,.4);background:rgba(110,64,201,.10)}
  .msg.back .who{color:#b392f0}
  .col::-webkit-scrollbar{width:9px}
  .col::-webkit-scrollbar-thumb{background:#2d333b;border-radius:5px}
  h3{margin:0 0 10px;font-size:11.5px;text-transform:uppercase;letter-spacing:1.1px;color:var(--fg2);font-weight:600}
  h3 .sub{text-transform:none;letter-spacing:0;font-weight:400;color:#6e7681;font-size:11px;margin-left:6px}

  /* 任务输入 */
  textarea{width:100%;min-height:96px;resize:vertical;background:var(--bg2);color:var(--fg);border:1px solid var(--line);border-radius:9px;padding:11px 12px;font:13px/1.6 inherit;outline:none}
  textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(88,166,255,.12)}
  .row{display:flex;gap:8px;margin-top:9px;flex-wrap:wrap}

  /* 进度 */
  .bar{height:7px;background:var(--bg3);border-radius:99px;overflow:hidden;margin:10px 0 6px}
  .bar > i{display:block;height:100%;background:linear-gradient(90deg,#1f6feb,#58a6ff);transition:width .4s}
  .steps{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
  .st{padding:3px 9px;border-radius:7px;border:1px solid var(--line);background:var(--bg2);font:12px var(--mono);color:var(--fg2)}
  .st.done{border-color:#238636;background:rgba(35,134,54,.16);color:#7ee787}
  .st.cur{border-color:#9e6a03;background:rgba(158,106,3,.18);color:#e3b341}
  .st.todo{opacity:.55}

  /* 指标 */
  .kv{display:grid;grid-template-columns:1fr auto;gap:4px 10px;font-size:12.5px}
  .kv .k{color:var(--fg2)}
  .kv .v{font-family:var(--mono);color:var(--fg)}
  .v.ok{color:var(--ok)} .v.warn{color:var(--warn)} .v.err{color:var(--err)}
  .sep{height:1px;background:var(--line);margin:13px 0}

  /* 事件流 */
  .ev{font:11.5px/1.5 var(--mono);color:var(--fg2);border-left:2px solid var(--line);padding:2px 0 2px 9px;margin-bottom:5px;word-break:break-all}
  .ev b{color:var(--fg);font-weight:600}
  .ev .t{color:#6e7681}
  .ev.hot{border-left-color:var(--accent)}

  /* 配置 */
  footer{flex:0 0 auto;background:var(--bg2);border-top:1px solid var(--line);padding:11px 18px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
  footer label{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--fg2)}
  footer input[type=number],footer select{width:96px;background:var(--bg3);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:5px 8px;font:12px var(--mono);outline:none}
  footer select{width:auto;min-width:150px}
  .toast{position:fixed;right:18px;bottom:64px;background:var(--bg3);border:1px solid var(--line);border-radius:9px;padding:10px 14px;font-size:12.5px;opacity:0;transform:translateY(8px);transition:.22s;pointer-events:none;max-width:420px}
  .toast.show{opacity:1;transform:none}
  .toast.err{border-color:#8b1a1a;color:#ffb4b4}
  .muted{color:#6e7681;font-size:11.5px}
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="brand"><span id="live" class="dot"></span>快速反应控制台</div>
    <div class="chips">
      <span class="chip">前台 <b id="fphase">—</b></span>
      <span class="chip">后台 <b id="bphase">—</b></span>
      <span class="chip">任务 <b id="tstate">—</b></span>
    </div>
    <div class="grow"></div>
    <button id="btnStart" class="primary">一键启动</button>
    <button id="btnRebuild">重建会话</button>
    <button id="btnStop" class="danger">停止</button>
  </header>

  <main>
    <!-- 左：任务 -->
    <section class="col">
      <h3>输入任务 <span class="sub">直接投给前台</span></h3>
      <textarea id="task" placeholder="例：把 C:\\work 下所有 .py 文件补上类型标注并逐个 py_compile 验证，最后写 REPORT.md"></textarea>
      <div class="row">
        <button id="btnSend" class="primary">提交任务</button>
        <button id="btnFire" class="ghost">消防打断</button>
        <button id="btnClear" class="ghost">清空</button>
      </div>

      <div class="sep"></div>
      <h3>当前任务 <span class="sub" id="taskAt"></span></h3>
      <div class="muted" id="stateLine">—</div>
      <div class="bar"><i id="prog" style="width:0%"></i></div>
      <div class="muted" id="progText">—</div>
      <div class="steps" id="steps"></div>

      <div class="sep"></div>
      <h3>路线检查 <span class="sub">里程碑 / 步骤 一致性</span></h3>
      <div class="kv" id="loopBox"></div>
    </section>

    <!-- 中：对话（前台 / 后台）-->
    <section class="col">
      <h3>对话 <span class="sub">前台 / 后台 最近输出</span></h3>
      <div id="chat"><span class="muted">还没有对话 —— 在左侧输入任务并提交</span></div>
    </section>

    <!-- 右：指标 + 事件 -->
    <section class="col">
      <h3>效率指标</h3>
      <div class="kv" id="metrics"></div>
      <div class="sep"></div>
      <h3>唤醒分布</h3>
      <div class="kv" id="wakes"></div>
      <div class="sep"></div>
      <h3>计数</h3>
      <div class="kv" id="counters"></div>
      <div class="sep"></div>
      <h3>事件流 <span class="sub">最近 30 条</span></h3>
      <div id="events"><span class="muted">加载中…</span></div>
    </section>
  </main>

  <footer>
    <label>投递批量 <input id="cBatch" type="number" min="1" max="10" /></label>
    <label>前台上限 <input id="cFront" type="number" min="1000" step="1000" /></label>
    <label>后台上限 <input id="cBack" type="number" min="1000" step="1000" /></label>
    <label>前台档位 <select id="cFrontEffort"><option value="">默认</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label>
    <button id="btnSaveCfg">保存配置</button>
    <div class="grow"></div>
    <span class="muted" id="stamp">—</span>
  </footer>
</div>
<div id="toast" class="toast"></div>

<script>
(function(){
  var $ = function(id){ return document.getElementById(id) }
  var last = null
  function toast(msg, isErr){
    var t = $('toast'); t.textContent = msg; t.className = 'toast show' + (isErr ? ' err' : '')
    clearTimeout(toast._t); toast._t = setTimeout(function(){ t.className = 'toast' }, 2600)
  }
  function api(path, opts){
    return fetch('/fr/api' + path, Object.assign({ headers:{ 'content-type':'application/json' }, credentials:'same-origin' }, opts||{}))
      .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error || ('HTTP '+r.status)); return j }) })
  }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c] }) }
  function fmtMs(ms){ return ms==null ? '—' : (ms<1000 ? ms+'ms' : (ms/1000).toFixed(1)+'s') }
  function fmtK(n){ return n==null ? '—' : (n>=1000 ? (n/1000).toFixed(1)+'k' : String(n)) }
  function phaseDot(el, ph){
    el.className = 'dot' + (ph==='running' ? ' busy' : (ph && ph!=='closed' ? ' on' : ''))
  }

  function render(d){
    last = d
    phaseDot($('live'), (d.back && d.back.phase==='running') || (d.front && d.front.phase==='running') ? 'running' : 'on')
    $('fphase').textContent = d.front ? d.front.phase : '未接线'
    $('bphase').textContent = d.back ? d.back.phase : '未接线'
    $('tstate').textContent = (d.state && d.state.status) || '—'

    // 任务进度
    var done = (d.state && d.state.done) || 'S0'
    var total = (d.steps && d.steps.length) || 0
    var doneNo = parseInt(String(done).replace(/\\D/g,''),10) || 0
    var pct = total ? Math.min(100, Math.round(doneNo / total * 100)) : 0
    $('prog').style.width = pct + '%'
    $('progText').textContent = total ? ('已完成 ' + doneNo + ' / ' + total + ' 步（' + pct + '%）') : '暂无步骤'
    $('taskAt').textContent = (d.at||'').slice(11,19)
    var sl = []
    ;(d.steps||[]).forEach(function(f){
      var n = parseInt(String(f).replace(/\\D/g,''),10)
      var cls = n <= doneNo ? 'done' : (n === doneNo+1 ? 'cur' : 'todo')
      sl.push('<span class="st '+cls+'">'+esc(String(f).replace('.md',''))+'</span>')
    })
    $('steps').innerHTML = sl.join('') || '<span class="muted">无</span>'

    // 路线检查
    var ms = d.milestones || 0
    var okLoop = ms>0 && ms===total
    $('loopBox').innerHTML =
      '<span class="k">里程碑</span><span class="v">'+ms+'</span>' +
      '<span class="k">步骤文件</span><span class="v">'+total+'</span>' +
      '<span class="k">一致性</span><span class="v '+(okLoop?'ok':(ms?'warn':''))+'">'+(okLoop?'✓ 对齐':(ms?'⚠ 不一致':'—'))+'</span>' +
      '<span class="k">route 来源</span><span class="v">'+(d.routeRendered?'fr_route':'手写')+' · '+fmtK(d.routeSize)+'字</span>' +
      '<span class="k">哨兵</span><span class="v">'+(d.renderedSn==null?'—':d.renderedSn)+'</span>'

    // 指标
    var ff = d.firstFrameMs
    $('metrics').innerHTML =
      '<span class="k">首帧</span><span class="v '+(ff!=null && ff<15000?'ok':(ff?'warn':''))+'">'+fmtMs(ff)+'</span>' +
      '<span class="k">实时投递</span><span class="v ok">'+fmtMs(d.lastWatchMs)+'</span>' +
      '<span class="k">前台上下文</span><span class="v">'+fmtK(d.ctx && d.ctx.front)+' / '+fmtK(d.limits && d.limits.front)+'</span>' +
      '<span class="k">后台上下文</span><span class="v">'+fmtK(d.ctx && d.ctx.back)+' / '+fmtK(d.limits && d.limits.back)+'</span>' +
      '<span class="k">最近压缩</span><span class="v">'+(d.lastCompact ? (fmtK(d.lastCompact.before)+'→'+fmtK(d.lastCompact.after)) : '—')+'</span>'

    var wb = d.wakeBy || {}, wl = []
    Object.keys(wb).forEach(function(k){ wl.push('<span class="k">'+esc(k)+'</span><span class="v">'+wb[k]+'</span>') })
    $('wakes').innerHTML = wl.join('') || '<span class="k">—</span><span class="v">0</span>'

    var t = d.tools || {}
    $('counters').innerHTML =
      '<span class="k">工具调用</span><span class="v">'+(t.total||0)+'</span>' +
      '<span class="k">失败</span><span class="v '+(t.failTotal?'warn':'')+'">'+(t.failTotal||0)+'</span>' +
      '<span class="k">T3 拦截</span><span class="v">'+(d.t3Blocked||0)+'</span>' +
      '<span class="k">心跳</span><span class="v">'+(d.heartbeats||0)+'</span>'

    // 对话（前台 + 后台，按时间合并）
    var chat = d.chat || {}
    var rows = []
    ;(chat.front || []).forEach(function(m){ rows.push({ m: m, who: m.role === 'user' ? '你' : '前台', cls: m.role === 'user' ? 'me' : 'agent' }) })
    ;(chat.back || []).forEach(function(m){ rows.push({ m: m, who: '后台', cls: 'back' }) })
    rows.sort(function(a, b){ return String(a.m.at).localeCompare(String(b.m.at)) })
    var ch = rows.slice(-40).map(function(r){
      var t = String(r.m.at || '')
      t = t.length > 19 ? t.slice(11, 19) : t
      return '<div class="msg '+r.cls+'"><span class="who">'+esc(r.who)+' · '+esc(t)+'</span><div class="txt">'+esc(r.m.text)+'</div></div>'
    })
    var chBox = $('chat')
    var atBottom = chBox.scrollHeight - chBox.scrollTop - chBox.clientHeight < 40
    chBox.innerHTML = ch.join('') || '<span class="muted">还没有对话 —— 在左侧输入任务并提交</span>'
    if (atBottom) chBox.scrollTop = chBox.scrollHeight

    // 事件
    var ev = []
    ;(d.recent||[]).slice().reverse().forEach(function(x){
      var det = ''
      try { det = x.detail ? JSON.stringify(x.detail) : '' } catch(e){}
      if (det.length > 90) det = det.slice(0,90) + '…'
      var hot = /freeze|route-rendered|escalate|interrupt|step-delivered|watcher-fire/.test(x.kind||'')
      ev.push('<div class="ev'+(hot?' hot':'')+'"><span class="t">'+esc((x.at||'').slice(11,19))+'</span> <b>'+esc(x.kind)+'</b> '+esc(det)+'</div>')
    })
    $('events').innerHTML = ev.join('') || '<span class="muted">暂无事件</span>'

    $('stamp').textContent = '更新 ' + (d.at||'').slice(11,19)

    // 配置回填（只在首次或未聚焦时）
    if (!render._cfg){
      render._cfg = true
      $('cBatch').value = d.cfg && d.cfg.batchSteps || 3
      $('cFront').value = (d.limits && d.limits.front) || 60000
      $('cBack').value = (d.limits && d.limits.back) || 60000
    }
  }

  function load(){
    api('/status').then(render).catch(function(e){
      $('live').className = 'dot'
      $('stamp').textContent = '连接失败: ' + e.message
    })
  }

  // ── 操作 ────────────────────────────────────────────────────────────────
  function post(path, body, okMsg){
    return api(path, { method:'POST', body: JSON.stringify(body||{}) })
      .then(function(r){ toast(okMsg + (r && r.note ? '：' + r.note : '')); render._cfg = true; load() })
      .catch(function(e){ toast('失败：' + e.message, true) })
  }
  $('btnStart').onclick = function(){ post('/start', {}, '已启动') }
  $('btnStop').onclick = function(){ if(confirm('确认停止快速反应（前后台会话会被取消）？')) post('/stop', {}, '已停止') }
  $('btnRebuild').onclick = function(){ post('/rebuild', {}, '已重建会话') }
  $('btnSend').onclick = function(){
    var v = $('task').value.trim()
    if (!v) { toast('请先输入任务', true); return }
    post('/task', { text: v }, '任务已提交')
  }
  $('btnFire').onclick = function(){
    var v = $('task').value.trim() || '用户手动打断'
    post('/fire', { reason: v }, '已打断前台')
  }
  $('btnClear').onclick = function(){ $('task').value = '' }
  $('btnSaveCfg').onclick = function(){
    post('/config', {
      batchSteps: Number($('cBatch').value),
      frontContextLimit: Number($('cFront').value),
      backContextLimit: Number($('cBack').value),
    }, '配置已保存')
  }

  load()
  setInterval(load, 1000)
})();
</script>
</body>
</html>`
