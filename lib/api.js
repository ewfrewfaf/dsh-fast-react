/**
 * 快速反应 · 便捷 API
 *
 * 设计原则：
 *  - 所有端点只做"转发 + 聚合"，业务逻辑仍在主插件里（app.* 提供）
 *  - 每个端点独立注册（kind:'exact'），不依赖前缀匹配（已验证可靠）
 *  - 统一 JSON 返回：成功 { ok:true, ... }，失败 { error:'...' } + 4xx/5xx
 *  - 无外部依赖
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
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

/** 读取原始请求体（限制大小，防误用） */
function readBody (req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 256 * 1024) { try { req.destroy() } catch { /* 忽略 */ } resolve(null); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve(null))
  })
}

/** 读最近 N 条事件 */
function readEvents (boardDir, limit) {
  try {
    const txt = readFileSync(join(boardDir, 'events.jsonl'), 'utf8')
    return txt.trim().split('\n').filter(Boolean).slice(-limit)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
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
function recentChat (agent, limit) {
  if (!agent) return []
  // ★ 隐藏系统提示词（用户要求）：DSH 会把 brief / runtime context / system-reminder
  //   等注入成 user/message，全部是"系统话"，不该出现在人看的对话里。
  const SYS_MARK = /^(【快速反应|<system-reminder|Current runtime context|Time sampled while|本环境装有|You are an AI agent|This is an automatically generated)/
  try {
    const evs = (agent.session && agent.session.snapshotEvents && agent.session.snapshotEvents()) || []
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
    return merged.slice(-limit)
  } catch { return [] }
}

/** 组装完整状态（页面一次轮询拿全） */
export function buildStatus (app) {
  const { cfg } = app
  const boardDir = app.boardDir
  let cfgFile = {}
  try { cfgFile = JSON.parse(readFileSync(join(boardDir, 'config.json'), 'utf8')) || {} } catch { /* 无配置 */ }
  let metrics = {}
  try { metrics = JSON.parse(readFileSync(join(boardDir, 'metrics.json'), 'utf8')) || {} } catch { /* 无度量 */ }

  app.resolveAgents()
  const front = app.getFront()
  const back = app.getBack()
  const pick = (a) => a ? { id: app.idOf(a), phase: (a.phase && a.phase.kind) || '?' } : null

  let steps = []
  try { steps = readdirSync(join(boardDir, 'steps')).filter((f) => /^S\d+\.md$/.test(f)).sort((x, y) => parseInt(x.slice(1)) - parseInt(y.slice(1))) } catch { /* 无 steps */ }

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

  // 上下文 token（拿不到就 null，页面显示 —）
  let ctx = { front: null, back: null }
  try {
    const meter = app.getMeter()
    if (meter) {
      if (front) { try { ctx.front = meter.measure(front.session).surfaceTokens } catch { /* 忽略 */ } }
      if (back) { try { ctx.back = meter.measure(back.session).surfaceTokens } catch { /* 忽略 */ } }
    }
  } catch { /* 忽略 */ }

  return {
    at: new Date().toISOString(),
    enabled: !!cfg.enabled,
    front: pick(front),
    back: pick(back),
    state: app.readState(),
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
    heartbeats: (() => { try { return readFileSync(join(boardDir, 'heartbeat.log'), 'utf8').trim().split('\n').length } catch { return 0 } })(),
    tools: metrics.toolStats || { total: 0, failStreak: 0, failTotal: 0 },
    t3Blocked: typeof metrics.t3Blocked === 'number' ? metrics.t3Blocked : 0,
    wakeBy: (metrics.wakeCount && metrics.wakeCount.byReason) || {},
    wakeTotal: (metrics.wakeCount && metrics.wakeCount.total) || 0,
    recent: evs.slice(-30),
    // 对话内容（页面「对话」栏用）—— 之前缺失导致"发了任务看不到回复"
    chat: {
      front: recentChat(front, 30),
      back: recentChat(back, 15),
    },
    models: { provider: cfg.provider || '', model: cfg.model || '' },
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
      try { ok(res, buildStatus(app)) } catch (e) { fail(res, 500, e && e.message || e) }
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
        if (!body || !body.text || !String(body.text).trim()) return fail(res, 400, '缺少 text')
        const text = String(body.text).trim().slice(0, 20000)
        app.resolveAgents()
        // ★ 会话寻址：sessionId 优先，其次 group(+role)，最后当前接线（默认前台）
        const target = { sessionId: body.sessionId, group: body.group, role: body.role }
        if (!target.sessionId && !target.group && !target.role) target.role = 'front'
        if (!app.getFront() && !target.sessionId && !target.group) return fail(res, 409, '前台未接线（先点「一键启动」）')
        const r = await app.deliver(target, text, !!body.interrupt)
        if (r && r.error) return fail(res, 409, r.error)
        app.event('api-task', { chars: text.length, mode: r.mode, interrupt: !!body.interrupt, cancelled: !!r.cancelled, target: r.session })
        ok(res, r)
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
        if (!body) return fail(res, 400, '请求体无法解析')
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
        if (!body) return fail(res, 400, '请求体无法解析')
        const action = String(body.action || '')
        if (action === 'create') return ok(res, await app.createGroup(body.title, !!body.adopt))
        if (action === 'delete') return ok(res, await app.deleteGroup(String(body.key || ''), !!body.force))
        if (action === 'switch') return ok(res, await app.switchGroup(String(body.key || '')))
        if (action === 'repair') return ok(res, await app.repairGroups())
        if (action === 'policy') return ok(res, await app.setGroupPolicy(String(body.key || ''), String(body.preset || '')))
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
        if (!body) return fail(res, 400, '请求体无法解析')
        const r = await app.setModel(body.provider, body.model)
        if (r && r.error) return fail(res, 400, r.error)
        ok(res, r)
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
