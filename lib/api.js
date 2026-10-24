/**
 * 快速反应 · 便捷 API
 *
 * 设计原则：
 *  - 所有端点只做"转发 + 聚合"，业务逻辑仍在主插件里（app.* 提供）
 *  - 每个端点独立注册（kind:'exact'），不依赖前缀匹配（已验证可靠）
 *  - 统一 JSON 返回：成功 { ok:true, ... }，失败 { error:'...' } + 4xx/5xx
 *  - 无外部依赖
 */
import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, fstatSync, closeSync } from 'node:fs'
import { join, dirname, basename, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

// ★ UI 资源外置（2026-10-17）：页面与注入脚本放在 lib/ui/ 下，路由**每次实时读取**。
//   这样改 UI 只要改磁盘文件 + 重新打开面板，**不用重启插件**（bundle 装配没有热重载）。
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui')
function readUI (name) {
  try { return readFileSync(join(UI_DIR, name), 'utf8') } catch { return '' }
}

const json = (res, code, obj) => {
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  } catch { /* 连接已断 */ }
}

const ok = (res, obj) => json(res, 200, Object.assign({ ok: true }, obj || {}))
const fail = (res, code, msg) => json(res, code, { ok: false, error: String(msg) })
/** ★ 修复（2026-10-24）：组动作（create/delete/switch/repair）此前一律包 ok(res,…)，
 *  于是「组不存在」这类失败会返回 { ok:true, error:'…' } —— 调用方按 ok 判断就会误判成功。
 *  这里统一：结果里带 error ⇒ 4xx。 */
const okOrFail = (res, r) => (r && r.error) ? fail(res, 404, r.error) : ok(res, r || {})

/** 读取原始请求体（限制大小，防误用）
 *  ★ 修复（2026-10-24）：原实现在超限时直接 `req.destroy()`，客户端拿到的是
 *    「fetch failed」这种网络错误而不是明确的状态码；JSON 解析失败则静默返回 {}，
 *    于是 /fr/api/config 收到畸形 JSON 会回 200 {ok:true}（误判成功）。
 *    现在把失败原因放在 req.__bodyError 上，handler 用它返 413 / 400。 */
function readBody (req) {
  return new Promise((resolve) => {
    let size = 0
    let done = false
    const chunks = []
    const finish = (value, code) => {
      if (done) return
      done = true
      if (code) req.__bodyError = code
      resolve(value)
    }
    req.on('data', (c) => {
      if (done) return
      size += c.length
      if (size > 256 * 1024) {
        // 不销毁连接：把剩余字节 drain 掉，让 handler 能正常回 413
        chunks.length = 0
        try { req.resume() } catch { /* 忽略 */ }
        finish(null, 413)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'), 0) } catch { finish(null, 400) }
    })
    req.on('error', () => finish(null, 400))
  })
}

/** 尾部定向读：只读文件最后 maxBytes 字节，避免「整文件读 + split」在长任务下拖慢宿主。
 *  ★ 修复（2026-10-24）：面板每秒轮询 /status，原先每次都整读 events.jsonl（实测 5.7MB 时
 *    25ms/次、且是同步阻塞）。改为尾部读后 0.85ms/次（29×），末 300 行逐字节一致。 */
export function tailLines (file, limit, maxBytes = 256 * 1024) {
  let fd
  try {
    fd = openSync(file, 'r')
    const { size } = fstatSync(fd)
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    if (buf.length > 0) readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    if (start > 0 && lines.length > 0) lines.shift()   // 首行可能被截断
    return lines.slice(-limit)
  } catch {
    return []
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}

/** 读最近 N 条事件（尾部定向读，成本与文件总大小无关） */
function readEvents (boardDir, limit) {
  return tailLines(join(boardDir, 'events.jsonl'), limit)
    .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

/** 解析 route.md 里的里程碑数（容错：允许 `## 3. 里程碑（...）` 这种写法） */
function routeMilestones (boardDir) {
  try {
    const p = join(boardDir, 'route.md')
    if (!existsSync(p)) return 0
    const t = readFileSync(p, 'utf8')
    const m = t.match(/^##[^\n]*里程碑[^\n]*$/m)
    if (!m) return 0
    const seg = t.slice(m.index + m[0].length).split(/\n##\s/)[0]
    return (seg.match(/^\s*[-*]\s*\*?\*?M\d+/gmi) || []).length
  } catch { return 0 }
}

/** heartbeat 行数：按 (size, mtime) 缓存 —— 面板每秒轮询时避免整读 + split 大文件 */
const heartbeatCache = { key: "", count: 0 }
function heartbeatLineCount (boardDir) {
  const p = join(boardDir, "heartbeat.log")
  try {
    const st = statSync(p)
    const key = st.size + ":" + st.mtimeMs
    if (heartbeatCache.key === key) return heartbeatCache.count
    const text = readFileSync(p, "utf8")
    let count = 0
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++
    if (text.length && text.charCodeAt(text.length - 1) !== 10) count++
    heartbeatCache.key = key
    heartbeatCache.count = count
    return count
  } catch { return 0 }
}

function routeSize (boardDir) {
  try {
    const p = join(boardDir, 'route.md')
    return existsSync(p) ? readFileSync(p, 'utf8').length : 0
  } catch { return 0 }
}

/**
 * 从会话事件里抽取最近的对话消息（助手回复 + 用户输入）。
 * ★ 页面之前只显示步骤/指标/事件，用户发完任务**看不到 Agent 说了什么** —— 这是实用性缺陷。
 */
/** 对话解析缓存：按 (agent.id, 事件数, 首尾 seq) 指纹复用，避免每秒重解析 */
const chatCache = new Map()
function recentChat (agent, limit) {
  if (!agent) return []
  // 指纹：事件数 + 首尾 seq（compaction 会替换事件，所以不能只看长度）
  const fp = (() => {
    try {
      const evs = agent.session && agent.session.snapshotEvents ? agent.session.snapshotEvents() : []
      if (!evs.length) return "0"
      const first = evs[0] && (evs[0].event || evs[0])
      const last = evs[evs.length - 1] && (evs[evs.length - 1].event || evs[evs.length - 1])
      return evs.length + ":" + (first && first.seq) + ":" + (last && last.seq)
    } catch { return "" }
  })()
  const ck = (() => { try { return String(agent.id) + ":" + limit } catch { return "" } })()
  const hit = fp ? chatCache.get(ck) : null
  if (hit && hit.fp === fp) return hit.out   // chatCacheHit
  // ★ 隐藏系统提示词（用户要求）：DSH 会把 brief / runtime context / system-reminder
  //   等注入成 user/message，全部是"系统话"，不该出现在人看的对话里。
  const SYS_MARK = /^(【快速反应|<system-reminder|Current runtime context|Time sampled while|本环境装有|You are an AI agent|This is an automatically generated)/
  try {
    const all = (agent.session && agent.session.snapshotEvents && agent.session.snapshotEvents()) || []
    // ★ 修复（2026-10-24）：原实现从头遍历**整段会话历史**（含每条消息的 content 解析、
    //   思考合并），而面板每秒调一次、前后台各一次。长会话（数千事件）时这是同步 CPU 尖峰，
    //   也正是「长任务时 DSH 变得很卡」的候选原因之一。这里只取尾部窗口即可——
    //   最终结果本来就只保留最后 limit 条。
    const windowSize = Math.max(200, limit * 8)
    const evs = all.length > windowSize ? all.slice(-windowSize) : all
    const out = []
    for (const e of evs) {
      const ev = e.event || e
      if (!ev || !ev.type) continue
      const isAsst = ev.type === 'assistant/message'
      const isUser = ev.type === 'user/message'
      if (!isAsst && !isUser) continue
      let txt = ''
      let think = ''
      try {
        const d = ev.data || {}
        const parts = d.content || (d.message && d.message.content) || []
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (!p) continue
            const pt = String(p.type || '')
            if (pt === 'text' && p.text) txt += p.text
            else if (/reason|think/i.test(pt)) think += String(p.text || p.reasoning || p.content || '')
          }
        }
        if (!txt && typeof d.text === 'string') txt = d.text
        if (!think && typeof d.reasoning === 'string') think = d.reasoning
      } catch { /* 忽略 */ }
      txt = String(txt || '').trim()
      think = String(think || '').trim()
      if (!txt && !think) continue
      // ★ 可操作的通知类消息（T3 待确认 / 哨兵 / 上交 / 冻结 / 超时）**不能静默丢弃** ——
      //   它们正是"卡住等用户决定"的唯一信号，藏起来用户就永远看不到卡点（实测事故）。
      if (isUser && /^【(T3 待确认|哨兵|前台上交|冻结|等待超时|后台分诊|消防通道)/.test(txt)) {
        out.push({ at: String(ev.at || e.at || e.timestamp || ''), role: 'notice', text: txt.slice(0, 600) })
        continue
      }
      // 其余系统注入话术一律不展示：① 已知前缀标记 ② 以【 开头 ③ XML 式注入块
      if (isUser && (SYS_MARK.test(txt) || txt.charAt(0) === '【' || txt.charAt(0) === '<' || /<system-reminder>/.test(txt))) continue
      const row = { at: String(ev.at || e.at || e.timestamp || ''), role: isAsst ? 'agent' : 'user', text: txt.slice(0, 800) }
      if (think) row.think = think.slice(0, 6000)
      out.push(row)
    }
    // ★ 合并"只有思考没有正文"的中途消息：把它们的 reasoning 挂到下一条有正文的 Agent 回复上，
    //   否则一长串纯思考会刷屏（用户要的是「思考过程折叠」，不是几十条空消息）。
    const merged = []
    let carry = ''
    for (const r of out) {
      if (r.role === 'agent' && !r.text) { carry = (carry + (r.think || '') + '\n\n').slice(-24000); continue }
      if (r.role === 'user') { carry = ''; merged.push(r); continue }
      if (carry) { r.think = (carry + (r.think || '')).slice(-12000); carry = '' }
      if (r.think) r.think = r.think.slice(-12000)          // 单条思考上限 12k 字（超出保留尾部）
      merged.push(r)
    }
    const finalOut = merged.slice(-limit)
  try { if (fp) chatCache.set(ck, { fp, out: finalOut }) } catch { /* 忽略 */ }
  return finalOut
  } catch { return [] }
}

/** 组装完整状态（页面一次轮询拿全） */
export function buildStatus (app) {
  // ★ 性能探针（2026-10-24）：/status 每秒轮询，需知道耗时分布；开销可忽略（几个 performance.now）
  const PERF = { marks: {} }
  let perfLast = performance.now()
  const lap = (k) => { const n = performance.now(); PERF.marks[k] = +(n - perfLast).toFixed(2); perfLast = n }
  const { cfg } = app
  const boardDir = app.boardDir
  let cfgFile = {}
  try { cfgFile = JSON.parse(readFileSync(join(boardDir, 'config.json'), 'utf8')) || {} } catch { /* 无配置 */ }
  let metrics = {}
  try { metrics = JSON.parse(readFileSync(join(boardDir, 'metrics.json'), 'utf8')) || {} } catch { /* 无度量 */ }
  lap('files')

  app.resolveAgents()
  const front = app.getFront()
  const back = app.getBack()
  const pick = (a) => a ? { id: app.idOf(a), phase: (a.phase && a.phase.kind) || '?' } : null

  let steps = []
  try { steps = readdirSync(join(boardDir, 'steps')).filter((f) => /^S\d+\.md$/.test(f)).sort((x, y) => parseInt(x.slice(1)) - parseInt(y.slice(1))) } catch { /* 无 steps */ }

  lap('steps')
  const evs = readEvents(boardDir, 300)
  const rev = evs.slice().reverse()
  const lastEsc = rev.find((e) => e.kind === 'escalate')
  let firstFrameMs = null
  if (lastEsc) {
    const d = evs.find((e) => e.kind === 'step-delivered' && Date.parse(e.at) >= Date.parse(lastEsc.at))
    if (d) firstFrameMs = Date.parse(d.at) - Date.parse(lastEsc.at)
  }
  const lastWatch = rev.find((e) => e.kind === 'watcher-fire')
  const lastCompact = rev.find((e) => e.kind === 'ctx-compact')
  const lastRendered = rev.find((e) => e.kind === 'route-rendered')
  lap('events')

  // 上下文 token（拿不到就 null，页面显示 —）
  let ctx = { front: null, back: null }
  try {
    const meter = app.getMeter()
    if (meter) {
      if (front) { try { ctx.front = meter.measure(front.session).surfaceTokens } catch { /* 忽略 */ } }
      if (back) { try { ctx.back = meter.measure(back.session).surfaceTokens } catch { /* 忽略 */ } }
    }
  } catch { /* 忽略 */ }
  lap('ctx')

  const chatData = { front: recentChat(front, 30), back: recentChat(back, 15) }
  lap('chat')
  const stateNow = app.readState()
  lap('state')

  return {
    at: new Date().toISOString(),
    perf: PERF.marks,
    enabled: !!cfg.enabled,
    front: pick(front),
    back: pick(back),
    // ★ 接线健康度（2026-10-18）：面板据此区分"未接线 / 正在自愈 / 正常"
    wiring: (() => {
      // 以"会话对象是否真的在职且与 cfg 记录一致"为准
      const fMatched = !!(front && String(app.idOf(front)) === String(cfg.frontSessionId || ''))
      const bMatched = !!(back && String(app.idOf(back)) === String(cfg.backSessionId || ''))
      const healedAt = app.getLastAutoHealAt ? app.getLastAutoHealAt() : 0
      let state = 'wired'
      if (!front || !back) {
        state = !cfg.enabled ? 'disabled' : (Date.now() - healedAt < 30000 ? 'healing' : 'unwired')
      }
      return {
        state,
        frontId: cfg.frontSessionId || '',
        backId: cfg.backSessionId || '',
        frontMatched: fMatched,
        backMatched: bMatched,
        lastAutoHealAt: healedAt,
      }
    })(),
    state: stateNow,
    steps,
    milestones: routeMilestones(boardDir),
    routeSize: routeSize(boardDir),
    routeRendered: !!lastRendered,
    renderedSn: lastRendered && lastRendered.detail ? lastRendered.detail.sentinels : null,
    firstFrameMs,
    lastWatchMs: lastWatch && lastWatch.detail ? lastWatch.detail.ms : null,
    lastCompact: lastCompact && lastCompact.detail ? { role: lastCompact.detail.role, before: lastCompact.detail.before, after: lastCompact.detail.after } : null,
    ctx,
    limits: { front: cfg.frontContextLimit || 0, back: cfg.backContextLimit || 0 },
    cfg: { batchSteps: cfg.batchSteps, pullSteps: cfg.pullSteps, contextGuard: cfg.contextGuard },
    heartbeats: heartbeatLineCount(boardDir),
    tools: metrics.toolStats || { total: 0, failStreak: 0, failTotal: 0 },
    t3Blocked: typeof metrics.t3Blocked === 'number' ? metrics.t3Blocked : 0,
    wakeBy: (metrics.wakeCount && metrics.wakeCount.byReason) || {},
    wakeTotal: (metrics.wakeCount && metrics.wakeCount.total) || 0,
    recent: evs.slice(-30),
    // 对话内容（页面「对话」栏用）—— 之前缺失导致"发了任务看不到回复"
    chat: chatData,
    models: {
      // 已接线会话**实际生效**的模型（优先于配置，面板高亮以它为准）
      actual: (typeof app.getActualModels === 'function') ? app.getActualModels() : null,
      provider: cfg.provider || '',
      model: cfg.model || '',
      // ★ Phase 6：角色级覆盖（未设置时回落到全局值）
      front: { provider: cfg.frontProvider || cfg.provider || '', model: cfg.frontModel || cfg.model || '' },
      back: { provider: cfg.backProvider || cfg.provider || '', model: cfg.backModel || cfg.model || '' },
      frontModel: cfg.frontModel || '',
      backModel: cfg.backModel || '',
    },
    // 最近一次模型/回合错误（余额不足、401、限流等）——页面顶部报错条会显示
    lastError: (typeof app.getLastError === 'function') ? app.getLastError() : null,
    // 当前任务模式（Phase 1）：mode/label/by/locked/auto/presets
    mode: (typeof app.getMode === 'function') ? app.getMode() : null,
    // 步长自适应（Phase 2 收尾）与只读 worker（受控）
    adaptive: (typeof app.getAdaptive === 'function') ? app.getAdaptive() : null,
    workers: (typeof app.getWorkers === 'function') ? app.getWorkers() : [],
    // 实际生效的权限预设（沙箱 + 审批）
    permissions: (typeof app.currentPermissions === 'function') ? app.currentPermissions() : null,
    // 看门狗配置外露，便于面板/排障知道"多久没动就算僵死"
    stall: { watchdog: !!cfg.stallWatchdog, timeoutMs: cfg.stallTimeoutMs || 0 },
  }
}

/**
 * 构造全部路由。app 需提供（见 index.js 装配处）：
 *   cfg / boardDir / event / log / idOf / readState / listSteps
 *   resolveAgents / ensureWiring / wakeBack / steerFront / saveOverrides / overrides
 *   getFront / getBack / getMeter / rebuildSessions / fireInterrupt / applyConfig / stopAll
 */
export function makeRoutes (app) {
  const routes = []

  // ── 页面本体 ──────────────────────────────────────────────────────────────
  routes.push({
    kind: 'exact',
    path: '/fr',
    handler: async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(readUI('page.html') || '<h1>page.html 缺失</h1>')
    },
  })

  // ── 侧边栏注入脚本（实时读磁盘 ⇒ 改 UI 不用重启插件）───────────────────────
  routes.push({
    kind: 'exact',
    path: '/fr/sidebar.js',
    handler: async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(readUI('sidebar.js') || '/* sidebar.js 缺失 */')
    },
  })

  // ── 状态 ──────────────────────────────────────────────────────────────────
  routes.push({
    kind: 'exact',
    path: '/fr/api/status',
    handler: async (req, res) => {
      try {
        // 服务器端总耗时探针：区分「插件计算」与「框架/序列化」开销
        const srvT0 = performance.now()
        const data = buildStatus(app)
        data.perfSrv = +(performance.now() - srvT0).toFixed(2)
        ok(res, data)
      } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })

  // ── 启动（接线 + 简报 + 自动修复会话）──────────────────────────────────────
  routes.push({
    kind: 'exact',
    path: '/fr/api/start',
    handler: async (req, res) => {
      try {
        app.cfg.enabled = true
        app.overrides.enabled = true
        app.saveOverrides()
        await app.ensureWiring()
        app.resolveAgents()
        app.event('api-start', { front: app.getFront() ? app.idOf(app.getFront()) : null, back: app.getBack() ? app.idOf(app.getBack()) : null })
        ok(res, { front: !!app.getFront(), back: !!app.getBack() })
      } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })

  // ── 停止（取消前后台 + 关闭开关）──────────────────────────────────────────
  routes.push({
    kind: 'exact',
    path: '/fr/api/stop',
    handler: async (req, res) => {
      try {
        const r = app.stopAll()
        app.cfg.enabled = false
        app.overrides.enabled = false
        app.saveOverrides()
        app.event('api-stop', r || {})
        ok(res, r || {})
      } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })

  // ── 重建会话（create + mount + pin），可带 {provider, model} 指定模型 ─────────
  routes.push({
    kind: 'exact',
    path: '/fr/api/rebuild',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const r = await app.rebuildSessions(body && body.provider && body.model ? body : null)
        app.event('api-rebuild', r || {})
        ok(res, r || {})
      } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })

  // ── 提交任务（支持会话寻址：sessionId / group / role，缺省=当前前台）──────
  routes.push({
    kind: 'exact',
    path: '/fr/api/task',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        if (!body) return fail(res, req.__bodyError || 400, req.__bodyError === 413 ? '请求体超过 256KB' : '请求体无法解析')
        if (!body.text || !String(body.text).trim()) return fail(res, 400, '缺少 text')
        const text = String(body.text).trim().slice(0, 20000)
        app.resolveAgents()
        // ★ 会话寻址：sessionId 优先，其次 group(+role)，最后当前接线（默认前台）
        const target = { sessionId: body.sessionId, group: body.group, role: body.role }
        if (!target.sessionId && !target.group && !target.role) target.role = 'front'
        if (!app.getFront() && !target.sessionId && !target.group) return fail(res, 409, '前台未接线（先点「一键启动」）')
        const r = await app.deliver(target, text, !!body.interrupt)
        if (r && r.error) return fail(res, 409, r.error)
        app.event('api-task', { chars: text.length, mode: r.mode, interrupt: !!body.interrupt, cancelled: !!r.cancelled, target: r.session })
        // ★ 直接对话：当前接线若还没有归属会话组，自动收编一个（便于在「会话组管理」里找到）
        let autoGroup = null
        try { if (typeof app.ensureCurrentGroup === 'function') autoGroup = await app.ensureCurrentGroup() } catch { /* 忽略 */ }
        ok(res, Object.assign({}, r, autoGroup && autoGroup.created ? { autoGroup: autoGroup.group && autoGroup.group.key } : {}))
      } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })

  // ── 会话清单 / 单会话信息（会话级寻址的基础）──────────────────────────────
  routes.push({
    kind: 'exact',
    path: '/fr/api/sessions',
    handler: async (req, res) => {
      try { ok(res, app.listSessions()) } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })
  routes.push({
    kind: 'path',
    path: '/fr/api/session',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const opts = { sessionId: url.searchParams.get('id') || undefined, group: url.searchParams.get('group') || undefined, role: url.searchParams.get('role') || undefined }
        const r = app.sessionInfo(opts)
        if (r && r.error) return fail(res, 404, r.error)
        ok(res, r)
      } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })

  // ── 消防打断 ──────────────────────────────────────────────────────────────
  routes.push({
    kind: 'exact',
    path: '/fr/api/fire',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const reason = (body && body.reason) ? String(body.reason).slice(0, 300) : 'API 手动打断'
        // 指定会话时直接 cancel（不走全局消防冷却）
        if (body && (body.sessionId || body.group || body.role)) {
          const a = app.resolveSessionTarget({ sessionId: body.sessionId, group: body.group, role: body.role })
          if (!a) return fail(res, 404, '目标会话不存在')
          const wasRunning = !!(a.phase && a.phase.kind === 'running')
          try { a.cancel(new Error('api-fire: ' + reason)) } catch (e) { return fail(res, 500, e && e.message || e) }
          app.event('api-fire', { reason, target: body.sessionId || body.group || body.role, wasRunning })
          return ok(res, { ok: true, target: body.sessionId || body.group || body.role, wasRunning })
        }
        const r = app.fireInterrupt(reason)
        app.event('api-fire', { reason })
        ok(res, r || {})
      } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })

  // ── 读/改配置 ─────────────────────────────────────────────────────────────
  routes.push({
    kind: 'exact',
    path: '/fr/api/config',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') return ok(res, { cfg: app.cfg })
        const body = await readBody(req)
        if (!body) return fail(res, req.__bodyError || 400, '请求体无法解析')
        const r = app.applyConfig(body)
        ok(res, r)
      } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })

  // ── 会话组管理（FR-01/FR-02…）：列/建/删/切/自愈 ─────────────────────────
  routes.push({
    kind: 'exact',
    path: '/fr/api/groups',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') return ok(res, app.listGroups())
        const body = await readBody(req)
        if (!body) return fail(res, req.__bodyError || 400, '请求体无法解析')
        const action = String(body.action || '')
        if (action === 'create') return okOrFail(res, await app.createGroup(body.title, !!body.adopt))
        if (action === 'delete') return okOrFail(res, await app.deleteGroup(String(body.key || ''), !!body.force))
        if (action === 'switch') return okOrFail(res, await app.switchGroup(String(body.key || '')))
        if (action === 'repair') return okOrFail(res, await app.repairGroups())
        if (action === 'policy') {
          const r = await app.setGroupPolicy(String(body.key || ''), String(body.preset || ''))
          // ★ 语义修正（2026-10-18）：组不存在时应返回 ok:false，否则调用方会误判成功
          if (r && r.error) return fail(res, 404, r.error)
          return ok(res, r)
        }
        if (action === 'permissions') return ok(res, app.permissionCatalog())
        return fail(res, 400, '未知 action: ' + action)
      } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })

  // ── 模型清单 / 切换模型（面板输入栏的下拉用）──────────────────────────────
  routes.push({
    kind: 'exact',
    path: '/fr/api/models',
    handler: async (req, res) => {
      try { ok(res, await app.listModels()) } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })
  routes.push({
    kind: 'exact',
    path: '/fr/api/model',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        if (!body) return fail(res, req.__bodyError || 400, '请求体无法解析')
        const r = await app.setModel(body.provider, body.model, body.role)
        if (r && r.error) return fail(res, 400, r.error)
        ok(res, r)
      } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })

  // ── 任务模式（Phase 1）：GET 读当前模式与预设目录，POST 切换 ───────────────
  routes.push({
    kind: 'exact',
    path: '/fr/api/mode',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET' || (!req.method && !req.url.includes('?'))) {
          if (typeof app.getMode === 'function') return ok(res, app.getMode())
          return fail(res, 501, '模式 API 未就绪')
        }
        const body = await readBody(req)
        if (!body) return fail(res, req.__bodyError || 400, '请求体无法解析')
        const key = String(body.mode || '')
        if (body.locked !== undefined) app.cfg.modeLocked = !!body.locked
        if (!key) return ok(res, typeof app.getMode === 'function' ? app.getMode() : {})
        const r = app.setMode(key, body.by || 'user')
        if (r && r.error) return fail(res, 400, r.error)
        ok(res, r)
      } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })

  // ── 解析文件路径：拖入时可能只拿到文件名，这里在常见目录里找真实绝对路径 ──
  routes.push({
    kind: 'exact',
    path: '/fr/api/resolve-path',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        if (!body) return fail(res, req.__bodyError || 400, '请求体无法解析')
        const raw = String(body.path || '').trim()
        if (!raw) return fail(res, 400, '缺少 path')
        // ① 已经是存在的绝对路径 ⇒ 直接用
        try { if (isAbsolute(raw) && existsSync(raw)) return ok(res, { path: raw, resolved: false }) } catch { /* 忽略 */ }
        const name = basename(raw.replace(/\\/g, '/'))
        const cands = [
          join(homedir(), 'Desktop'), join(homedir(), 'Downloads'), join(homedir(), 'Documents'),
          join(homedir(), 'OneDrive', 'Desktop'), join(homedir(), 'OneDrive', '桌面'),
          homedir(), app.boardDir, join(app.boardDir, '..'),
        ]
        // ② 常见目录里找同名文件（含一层子目录）
        for (const d of cands) {
          try {
            const hit = join(d, name)
            if (existsSync(hit)) return ok(res, { path: hit, resolved: true, from: raw })
            for (const sub of readdirSync(d, { withFileTypes: true })) {
              if (!sub.isDirectory()) continue
              try {
                const p2 = join(d, sub.name, name)
                if (existsSync(p2)) return ok(res, { path: p2, resolved: true, from: raw })
              } catch { /* 忽略 */ }
            }
          } catch { /* 目录不存在 */ }
        }
        return fail(res, 404, '文件未找到：' + raw)
      } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })

  // ── T3 破坏性操作审批（用户可见可点）──────────────────────────────
  routes.push({
    kind: 'exact',
    path: '/fr/api/confirm',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          const list = (typeof app.listPendingConfirms === 'function') ? app.listPendingConfirms() : []
          return ok(res, { pending: list })
        }
        const body = await readBody(req)
        if (!body) return fail(res, req.__bodyError || 400, '请求体无法解析')
        const act = String(body.action || '')
        if (act === 'approve') {
          const r = app.approveConfirm(String(body.step || ''))
          if (r && r.error) return fail(res, 400, r.error)
          return ok(res, r)
        }
        if (act === 'reject') {
          const r = app.rejectConfirm(String(body.step || ''))
          if (r && r.error) return fail(res, 400, r.error)
          return ok(res, r)
        }
        return fail(res, 400, '未知 action（approve/reject）')
      } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })

  // ── 页面版本（page.html 指纹）：侧边栏轮询它，页面改动后自动 reload iframe ──
  routes.push({
    kind: 'exact',
    path: '/fr/api/pagever',
    handler: async (req, res) => {
      try {
        let ver = '0'
        try {
          const st = statSync(join(UI_DIR, 'page.html'))
          ver = st.size + ':' + Math.round(st.mtimeMs)
        } catch { /* 忽略 */ }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, ver }))
      } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })

  // ── 事件增量（?since=ISO 时间）────────────────────────────────────────────
  routes.push({
    kind: 'exact',
    path: '/fr/api/events',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const since = url.searchParams.get('since')
        const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50)
        let evs = readEvents(app.boardDir, 500)
        if (since) evs = evs.filter((e) => Date.parse(e.at) > Date.parse(since))
        ok(res, { events: evs.slice(-limit) })
      } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })

  // ── 通用中继：把页面/脚本动作转发给插件（fr_poke 的 HTTP 版）───────────────
  routes.push({
    kind: 'exact',
    path: '/fr/api/relay',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const r = await app.poke(body && body.action, body || {})
        ok(res, { result: r })
      } catch (e) { fail(res, 500, e && e.message || e) }
    },
  })

  return routes
}
