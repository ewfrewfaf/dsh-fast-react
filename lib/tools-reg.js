/**
 * tools-reg.js —— 全部工具注册（全局入口 fr_task/fr_status/fr_brake + 内部角色 fr_mode/fr_worker/fr_poke/fr_route/fr_escalate + scope 注册）
 * 从 lib/index.js 抽出的第 3 阶段模块（行为不变 refactor）。
 *
 * 依赖（D 依赖袋，字段调用时读取）：
 *   稳定字段（工厂顶部解构）：K cfg ctx log vlog event TAG BASE_PATH boardRoot boardDir P BB
 *   惰性字段：GR MA RT TN apiApp cfgFile currentMode cwdOf getFire idOf listSteps presetName presetOf readIf readState resolveAgents routeFor saveOverrides toolStats unwire wire writeAtomic
 *   K 共享状态：见 index.js 的 K 袋。
 *
 * 区块地图：
 *   frOnlyGate（历史 when 方案遗留）/FR_TOOL_DEFS/scopeRegistered
 *   safeRegister（收集定义）/registerFrToolsTo（注册进 agent scope）/globalRegister（全局注册）
 *   全局入口：fr_task/fr_status/fr_brake；内部角色：fr_status/fr_mode/fr_worker/fr_poke/fr_route/fr_escalate
 *   注：K.scopePatched/K.globalRegistered 初始化留 index 且先于工厂调用（factoryAtEnd）；B10/B11 留 index
 */

import { MODE_KEYS, allowListFor, modeInfo } from './modes.js'
import { tailLines } from './api.js'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { msg } from './messages.js'
import { DEFAULTS } from './defaults.js'

export function makeToolsReg (D) {
  const { cfg, ctx, log, vlog, event, TAG, BASE_PATH, boardRoot, boardDir, P, BB, K } = D

  // ── 给模型/面板用的只读自检工具 ────────────────────────────────────────
  // ★ 幂等注册：注入器热重载时，新实例可能在旧实例还没释放时执行 apply，
  //   直接 ctx.tools.register 会抛 "tool xxx is already registered" 并**中断 apply**
  //   （导致后续注册/监听 silently 不生效）。这里已存在就跳过。
  /** ★★ 2026-11-08 作用域门：fr_* 工具只对快速反应会话可见。
   *
   *  问题：原来 safeRegister 无条件把 6 个 fr_* 工具注册到全局，
   *  于是每个普通会话（用户的日常对话、别的 Agent）都多出 6 个用不上的工具：
   *    · 注意力税：6 份 schema 挤占工具描述
   *    · 误用风险：普通会话调 fr_route 会生成 route.md、调 fr_escalate 会写 handoff
   *
   *  修法：用 DSH 原生的 ToolRegistrationOptions.when —— 这是"按步骤激活条件"，
   *  不满足时工具**根本不出现在该会话的 schema 里**（不像 restrict 那样先给再藏）。
   *  判据用现成的 isFrSession(agent)，它已经处理了多实例隔离和 worker 排除。
   */
  const frOnlyGate = (context) => {
    try {
      const a = context && context.agent
      if (!a) return false                 // 拿不到 agent ⇒ 保守：不给
      return isFrSession(a)
    } catch { return false }
  }

  /** ★★ 2026-11-08 工具作用域门：fr_* 只对快速反应会话可见。
   *
   *  问题：原来 safeRegister 无条件注册到全局 ⇒ 每个普通会话都多出 6 个 fr_* 工具
   *  （注意力税 + 误用风险：普通会话调 fr_route 会生成 route.md）。
   *
   *  修法：DSH 原生 ToolRegistrationOptions.when —— 条件不满足时工具**不进入该会话 schema**。
   *  判据用现成的 isFrSession(agent)（已含多实例隔离 + worker 排除）。
   *
   *  ⚠️ 重载兼容：ctx.tools.get(name) 查的是全局视图，热重载后旧注册仍在。
   *  这里用 scopePatched 集合记录"本进程内是否已打过补丁"，
   *  跨重载用 ctx 上的标记避免重复注册失败。
   */

  /** ★★ 2026-11-08 方案 B（治本）：fr_* 工具**注册到 agent 自己的 scope**，不进全局。
   *
   *  DSH 契约：register(definition, options) —— "Register globally **or in the calling agent scope**"。
   *  即：用 ag.ctx.get('tools').register() 注册 ⇒ 只有那个 agent 看得到。
   *
   *  为什么放弃 when 方案：
   *    实测 tools.schemas(agent) 在普通会话里仍有 6 个 fr_*（工具数 71）。
   *    契约里 when 是 "step-time activation condition"，只在 resolve(step) 时求值；
   *    schemas() 不带 toolSet 看到的是**注册视图**，when 形同虚设。
   *
   *  为什么不能注册到全局再 restrict 掉：
   *    restrict 只能"藏"，全局注册仍在；且普通会话不归我们管，没法给它挂 restrict。
   *
   *  本方案：工具定义先攒进 FR_TOOL_DEFS，等前面台/后台会话建好，
   *  再逐个注册进它们各自的 ctx。普通会话从始至终看不到。
   */
  const FR_TOOL_DEFS = []
  const scopeRegistered = new WeakSet()   // 已注册过的 agent ctx

  /** 收集工具定义（apply 阶段调用，此时还没有 agent） */
  function safeRegister (def) {
    FR_TOOL_DEFS.push(def)
  }

  /** 把收集到的 fr 工具注册进某个 agent 的 scope（建会话后调用）。
   *  幂等：同一 agent.ctx 只注册一次。 */
  function registerFrToolsTo (ag, role) {
    if (!ag) return { skipped: 'no-agent' }
    try {
      const sctx = ag.ctx
      if (!sctx || typeof sctx.get !== 'function') return { skipped: 'no-ctx' }
      if (scopeRegistered.has(sctx)) return { skipped: 'already' }
      const tools = sctx.get('tools')
      if (!tools || typeof tools.register !== 'function') return { skipped: 'no-tools' }
      const want = new Set(allowListFor(D.currentMode(), role).map((n) => (String(n).startsWith('fr_') ? D.TN(n) : n)))
      let n = 0
      for (const def of FR_TOOL_DEFS) {
        const nm = def.name
        // ★ fr_status 已改为全局工具（所有会话都能查状态），这里跳过避免重复注册
        if (nm === D.TN('fr_status')) continue
        // 只注册该角色白名单里的 fr_* 工具（前台拿 fr_escalate、后台拿 fr_route）
        if (!want.has(nm)) continue
        try {
          tools.register(def)
          n++
        } catch (e) {
          if (!/already registered/i.test(String(e && e.message || ''))) {
            log(`注册 ${nm} 到 ${role} scope 失败: ${e.message}`)
          }
        }
      }
      scopeRegistered.add(sctx)
      if (n) log(`fr 工具已注册到 ${role} 会话 scope（${n} 个，不进全局）`)
      return { registered: n, role }
    } catch (e) {
      log(`registerFrToolsTo(${role}) fail: ` + (e && e.message || e))
      return { error: String(e && e.message || e).slice(0, 100) }
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  全局入口工具（2026-11-08 新增）
  //
  //  与 fr_escalate / fr_route 的区别：
  //    · 那几个是「快速反应内部角色」的工具（仅 fr 会话可见，走 scope 注册）
  //    · 这三个是「外部调用入口」——**任何会话都能用**，所以注册到全局
  //
  //  为什么需要：HTTP API 有致命短板——**端口每次重启都变**（实测见过
  //  3557/10304/9148/7408/2204），且失败时拿不到原因（余额不足会静默卡住）。
  //  固化成工具后：不依赖端口、错误结构化返回、一次 tool call 即可调起。
  // ═══════════════════════════════════════════════════════════════════════

  /** 全局注册（不走 FR_TOOL_DEFS 的 scope 逻辑） */
  function globalRegister (def) {
    try {
      const exists = (() => { try { return !!ctx.tools.get(def.name) } catch { return false } })()
      if (exists && K.globalRegistered.has(def.name)) return
      ctx.tools.register(def)
      K.globalRegistered.add(def.name)
      log(`全局工具 ${def.name} 已注册（所有会话可用）`)
    } catch (e) {
      log(`注册全局工具 ${def.name} 失败: ${e.message}`)
    }
  }

  globalRegister({
    name: D.TN('fr_task'),
    description: '把一个任务交给「快速反应」编排执行（前台+后台双会话）。支持精确寻址到某个会话组。'
      + ' 相比 HTTP /api/task：不依赖端口、错误结构化返回。'
      + ' 不传 group/sessionId 则投给当前接线的前台。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '任务描述（必填）。写清目标、路径、验收标准，越具体越好。' },
        mode: {
          type: 'string',
          enum: ['auto', 'quick', 'consult', 'retrieval', 'review', 'coding'],
          description: '执行模式。auto=按任务文本自动判型（默认）；指定则跳过判型，直接按此模式跑。',
        },
        mode_strict: {
          type: 'boolean',
          description: 'true=严格按 mode 跑，连灰区分诊和兜底升级都不做。配合 mode 使用。',
        },
        group: { type: 'string', description: '精确投递到某个会话组（如 FR-123）。不传则用当前接线。' },
        sessionId: { type: 'string', description: '精确投递到某个会话 id（优先级高于 group）。' },
        role: { type: 'string', enum: ['front', 'back'], description: '组内角色：front（默认）/ back。' },
        interrupt: { type: 'boolean', description: 'true=打断正在跑的任务强行投递；false=排队（默认）。' },
        wait: {
          type: 'boolean',
          description: 'true=等任务结束再返回摘要（会长时间占用，慎用）；false=投完立即返回（默认）。',
        },
      },
      required: ['text'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    execute: async (args) => {
      try {
        D.resolveAgents()
        const text = String((args && args.text) || '').trim()
        if (!text) return { ok: false, error: 'text 不能为空' }
        const opts = { external: true }
        if (args.group) opts.group = String(args.group)
        if (args.sessionId) opts.sessionId = String(args.sessionId)
        if (args.role) opts.role = String(args.role)
        if (args.mode && args.mode !== 'auto') opts.mode = String(args.mode)
        if (args.mode_strict) opts.mode_strict = true
        const r = await D.apiApp.deliver(opts, text, !!(args && args.interrupt))
        if (r && r.error) return { ok: false, error: r.error }
        event('tool-task', { group: opts.group || '', mode: opts.mode || 'auto', chars: text.length })
        return { ok: true, target: r.session || 'front', mode: opts.mode || 'auto', strict: !!opts.mode_strict }
      } catch (e) { return { ok: false, error: String(e && e.message || e) } }
    },
  })

  globalRegister({
    name: D.TN('fr_status'),
    description: '快速反应状态：接线、模式、当前任务、黑板、最近事件。用于判断"现在在干什么/卡在哪"。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        detail: { type: 'boolean', description: 'true=附带最近 15 条事件；false=只看概览（默认）' },
        group: { type: 'string', description: '只看某个会话组（不传=当前接线）' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    execute: async (args) => {
      try {
        D.resolveAgents()
        const out = {
          enabled: cfg.enabled,
          mode: D.currentMode(),
          modeBy: K.modeBy,
          orchestration: cfg.orchestration || 'auto',
          enablePhases: !!cfg.enablePhases,
          phase: K.phaseStrategy || null,
          strategy: K.activeStrategy || null,
          wiring: { front: K.front ? D.idOf(K.front) : null, back: K.back ? D.idOf(K.back) : null },
          running: {
            front: !!(K.front && K.front.phase && K.front.phase.kind === 'running'),
            back: !!(K.back && K.back.phase && K.back.phase.kind === 'running'),
          },
          board: boardDir,
          task: { chars: String(K.lastTaskText || '').length },
          lastTriage: K.lastTriage ? { tend: K.lastTriage.tend, score: K.lastTriage.score } : null,
          tools: { total: D.toolStats.total, failStreak: D.toolStats.failStreak },
        }
        if (args && args.group) {
          const g = D.GR.loadGroups().find((x) => x.key === String(args.group))
          out.group = g ? { key: g.key, front: g.frontId, back: g.backId } : { error: '组不存在' }
        }
        if (args && args.detail) {
          try {
            out.events = tailLines(P.events, 15).map((l) => { try { const o = JSON.parse(l); return { at: String(o.at || '').slice(11, 19), kind: o.kind } } catch { return null } }).filter(Boolean)
          } catch { /* 忽略 */ }
        }
        return out
      } catch (e) { return { ok: false, error: String(e && e.message || e) } }
    },
  })

  globalRegister({
    name: D.TN('fr_brake'),
    description: '刹车：立即中止快速反应当前任务（前后台），但**不关闭插件**，可随时再发任务。'
      + ' 区别于「停止」：停止会关掉整个插件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['front', 'back', 'all'], description: '停哪一侧，默认 all' },
        reason: { type: 'string', description: '原因（写进事件日志，便于回溯）' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    execute: async (args) => {
      try {
        D.resolveAgents()
        return D.apiApp.brake(String((args && args.scope) || 'all'), String((args && args.reason) || 'tool'))
      } catch (e) { return { ok: false, error: String(e && e.message || e) } }
    },
  })

  // ── 以下为「快速反应内部角色」工具，仅 fr 会话可见（走 scope 注册）──
  safeRegister({
    name: D.TN('fr_status'),
    description: '快速反应插件自检：前台/后台接线、黑板文件、计数与最近事件。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }],
    },
    execute: async () => {
      D.resolveAgents()
      return {
        board: boardDir,
        enabled: cfg.enabled,
        front: K.front ? { id: D.idOf(K.front), preset: D.presetOf(K.front), phase: K.front.phase?.kind } : null,
        back: K.back ? { id: D.idOf(K.back), preset: D.presetOf(K.back), phase: K.back.phase?.kind } : null,
        state: D.readState(),
        steps: D.listSteps(),
        heartbeats: D.readIf(P.heartbeat).trim().split('\n').filter(Boolean).length,
        tools: { total: D.toolStats.total, failStreak: D.toolStats.failStreak, failTotal: D.toolStats.failTotal },
        t3Blocked: K.t3Blocked,
        wakes: D.RT.wakeCount,
        recent: tailLines(P.events, 8),
      }
    },
  })

  safeRegister({
    name: D.TN('fr_mode'),
    description: '声明本任务的执行模式（第一个动作调用一次即可；不调用则按机械规则自动判型）。'
      + 'quick=速答(不编排、直接答) / consult=咨询(后台只做分析、不写步骤) / '
      + 'review=审查(读代码找问题、不改代码、产报告) / '
      + 'retrieval=检索(前台自己并行查、不惊动后台) / coding=编码(标准编排、后台写步骤)。'
      + ' ⚠️ 发现任务超出 quick 预期时（要改 3+ 文件 / 要自己设计 / 连续失败 3 次）→ 立刻切 coding 再上交。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: MODE_KEYS, description: '模式 key' },
        reason: { type: 'string', description: '一句话理由（可选，便于排障）' },
        pin: { type: 'boolean', description: 'true=本任务强制此模式，跳过后续自动判型与灰区分诊（默认 false）' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    execute: async (args) => {
      const key = String((args && args.mode) || '').trim()
      const pin = !!(args && args.pin)
      if (!MODE_KEYS.includes(key)) return { ok: false, error: `未知模式 ${key}；可选：${MODE_KEYS.join(', ')}` }
      const r = D.MA.applyMode(key, pin ? 'user' : 'agent', String((args && args.reason) || '模型声明'))
      if (pin) {
        K.modePinned = true
        event('mode-pinned', { mode: key })
        log(`模式被 pin 锁定 → ${key}（本任务不再自动判型/分诊）`)
      }
      return r
    },
  })

  safeRegister({
    name: D.TN('fr_worker'),
    description: '派生只读检索 worker（独立会话，只给 read/glob/grep/web/write），结果写 .board/workers/<id>.md。用于大范围搜索/并行查资料；并发上限 2；默认关闭（workersEnabled=true 才可用）。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要 worker 查什么（越具体越好）' },
        name: { type: 'string', description: '可选短名' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    execute: async (args) => {
      try {
        let fanoutMode = false
        try { fanoutMode = !!modeInfo(D.currentMode()).fanout } catch { /* 忽略 */ }
        if (!cfg.workersEnabled && !fanoutMode) return { ok: false, error: '只读 worker 未启用：配置 workersEnabled=true，或在 retrieval 模式下使用' }
        const task = String((args && args.task) || '').trim()
        if (!task) return { ok: false, error: 'task 不能为空' }
        if (!K.svcAgentLoop) return { ok: false, error: 'AgentLoop 不可用' }
        const wmax = Math.max(1, Math.min(8, Number(cfg.workerMax) || 2))
        if (K.workers.size >= wmax) return { ok: false, error: `并发 worker 已达上限（${wmax}）` }
        const id = (TAG === 'a' ? 'session-fr-worker-' : 'session-fr-' + TAG + '-worker-') + Date.now().toString(36)
        try { mkdirSync(join(boardDir, 'workers'), { recursive: true }) } catch { /* 忽略 */ }
        const outFile = join(boardDir, 'workers', id + '.md')
        const route = D.routeFor('front')
        const ag = await K.svcAgentLoop.create(id, { provider: route.provider, model: route.model, reasoningEffort: 'low' }, { cwd: boardRoot })
        try { if (K.svcPresets) await K.svcPresets.mount(ag.ctx, D.presetName()) } catch { /* 忽略 */ }
        try {
          const tools = ag.ctx && typeof ag.ctx.get === 'function' ? ag.ctx.get('tools') : undefined
          if (tools && typeof tools.restrict === 'function') {
            const visible = (tools.schemas(ag) || []).map(x => x && x.name)
            // ★ 2026-11-07：worker 是只读检索会话，**绝不**给任何能驱动编排的工具。
            //   原白名单 ['read','glob','grep','read_image','web_fetch','web_search','present','write']
            //   本身是对的，但 restrict 会丢（会话重建后白名单失效 ⇒ 又变回 68 个工具，
            //   含 fr_escalate ⇒ worker 能唤醒后台，递归环 2 的另一半）。
            //   这里同时把 fr_* 全部排除，并把 deny 名单显式化，做双保险。
            const allow = ['read', 'glob', 'grep', 'read_image', 'web_fetch', 'web_search', 'present', 'write']
              .filter(n => visible.includes(n))
              .filter(n => !/^fr_/.test(n))          // 任何 fr_* 都不给 worker
            const d = tools.restrict({ allow })
            if (typeof d === 'function') ag.__frWorkerDispose = d
            try {
              event('worker-policy', { id, allow: allow.length, before: visible.length })
            } catch { /* 忽略 */ }
          }
        } catch (e) { log('worker 工具限制失败: ' + e.message) }
        K.workers.set(id, { ag, at: Date.now(), out: outFile, done: outFile + '.done', task: task.slice(0, 80) })
        const prompt = [
          '你是只读检索 worker（不参与编排）。',
          '任务：' + task,
          '',
          '规则：',
          '1) 只读/搜索（read/glob/grep/web）+ 写结果文件；禁改仓库代码、禁执行命令、禁调 fr_* 运维工具。',
          '2) 结论写进 .board/workers/' + id + '.md（≤2000 字，带来源）。',
          '3) 完成后写空文件 .board/workers/' + id + '.md.done。',
          '4) 不要询问、不要等许可，直接查完就写。',
        ].join(String.fromCharCode(10))
        // ★ 关键：入队 + 唤醒驱动（kick / wakeDriver），否则新会话不起回合
        if (typeof ag.inject === 'function') { try { ag.inject(msg(prompt, '只读 worker：' + task.slice(0, 60))) } catch { /* 忽略 */ } }
        if (typeof ag.followup === 'function') { try { ag.followup(msg('开始执行上面的只读检索任务。', '开始')) } catch { /* 忽略 */ } }
        for (const fn of ['kick', 'wakeDriver']) {
          try { if (typeof ag[fn] === 'function') { ag[fn](); log('worker 驱动唤醒：' + fn) } } catch (e) { log('worker ' + fn + ' 失败: ' + e.message) }
        }
        event('worker-spawned', { id, task: task.slice(0, 80) })
        log('只读 worker 已派：' + id)
        return { ok: true, id, out: 'workers/' + id + '.md' }
      } catch (e) { return { ok: false, error: String(e && e.message || e) } }
    },
  })

  safeRegister({
    name: D.TN('fr_poke'),
    description: '手动驱动快速反应插件：wake=唤醒后台 / steer=插话前台 / resolve=<步号> 写 T3 放行令牌。用于联调测试。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['wake', 'steer', 'resolve', 'reload', 'pin', 'cancel', 'config', 'route', 'fire'] },
        text: { type: 'string', description: 'wake / steer 的文本内容' },
        step: { type: 'string', description: 'resolve 的步号' },
        front: { type: 'string', description: 'pin：前台 sessionId（留空=自动发现）' },
        back: { type: 'string', description: 'pin：后台 sessionId（留空=自动发现）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }],
    },
    execute: async (args) => {
      D.resolveAgents()
      const a = String(args.action)
      if (a === 'wake') {
        K.lastWakeAt = 0    // 手动不受冷却限制
        return { woke: D.RT.wakeBack('manual', String(args.text || '【手动唤醒】请读 .board/state.md 与 heartbeat.log，继续。')) }
      }
      if (a === 'steer') {
        return { steered: D.RT.steerFront(String(args.text || '【手动插话】请查看 .board/。'), 'manual') }
      }
      if (a === 'resolve') {
        // 归一化步号：守卫查的是 S<k>.ok（实测坑：传 4 会写成 4.ok，永远匹配不上）
        let id = String(args.step || '1').trim()
        if (/^\d+$/.test(id)) id = 'S' + id
        if (!/^S/i.test(id)) id = 'S' + id
        const ok = D.writeAtomic(join(P.confirmDir, `${id}.ok`), new Date().toISOString())
        event('t3-resolve', { step: id })
        return { resolved: ok, file: join(P.confirmDir, `${id}.ok`) }
      }
      if (a === 'pin') {
        // 手动指定前台/后台（写进 config.json 持久化；留空则该侧回到自动发现）
        const f = String(args.front || '').trim()
        const b = String(args.back || '').trim()
        cfg.frontSessionId = f
        cfg.backSessionId = b
        if (f && b) D.wire(f, b); else if (!f && !b) D.unwire(); else D.wire(f || undefined, b || undefined)
        K.briefed.clear()                       // 允许重新发简报
        const saved = D.saveOverrides()
        D.resolveAgents()
        event('pin', { front: f, back: b })
        return {
          saved,
          configFile: D.cfgFile,
          front: K.front ? { id: D.idOf(K.front), cwd: D.cwdOf(K.front), preset: D.presetOf(K.front) } : null,
          back: K.back ? { id: D.idOf(K.back), cwd: D.cwdOf(K.back), preset: D.presetOf(K.back) } : null,
          visibleAgents: (() => { try { return ctx.agents.list().map(x => ({ id: D.idOf(x).slice(0, 20), cwd: D.cwdOf(x) })) } catch { return [] } })(),
        }
      }
      if (a === 'config') {
        // 重读 .board/config.json（插件在 apply 时只读一次；改配置后不用重载插件）
        const before = JSON.parse(JSON.stringify(cfg))
        try {
          const fresh = JSON.parse(D.readIf(D.cfgFile)) || {}
          // ★ 必须同时更新 overrides（2026-10-17 实测坑）：
          //   只更新 cfg 而不更新 overrides ⇒ 之后任何 saveOverrides()（pin / autoHeal 写 sessionId）
          //   都会把内存里那份**旧的 overrides** 写回文件，把手工改的配置覆盖掉。
          K.overrides = Object.assign({}, K.overrides, fresh)
          Object.assign(cfg, fresh)
          D.resolveAgents()
          event('config-reload', { keys: Object.keys(cfg).length })
          return { reloaded: true, before, after: cfg, front: D.idOf(K.front), back: D.idOf(K.back) }
        } catch (e) { return { error: String(e && e.message || e) } }
      }
      if (a === 'route') {
        // 手动把前台/后台的 model 路由钉到 provider/model（text="provider/model"）
        const spec = String(args.text || '').trim()
        const i = spec.indexOf('/')
        if (i <= 0) return { error: '用法: text="provider/model"' }
        const provider = spec.slice(0, i)
        const model = spec.slice(i + 1)
        const done = []
        for (const pair of [[K.front, 'front'], [K.back, 'back']]) {
          const ag = pair[0]; const role = pair[1]
          if (!ag) { done.push({ role, skipped: 'not wired' }); continue }
          try {
            if (ag.options) { ag.options.provider = provider; ag.options.model = model } else { ag.options = { provider, model } }
            done.push({ role, to: provider + '/' + model })
            event('route-set', { role, to: provider + '/' + model })
            log('手动改路由 ' + role + ' -> ' + provider + '/' + model)
          } catch (e) { done.push({ role, err: String(e && e.message || e) }) }
        }
        return { done }
      }
      if (a === 'fire') {
        // 消防通道（手动/紧急）：打断前台当前生成 + 附说明；text 为说明内容
        const FIRE = D.getFire(TAG)
        if (typeof FIRE !== 'function') return { error: '消防通道未就绪（插件正在重载）' }
        D.resolveAgents()
        return FIRE(K.front, 'manual', String(args.text || '紧急插入：立刻响应最新指令。').slice(0, 600))
      }
      if (a === 'cancel') {
        // 取消某个 agent 当前回合（消防通道实测用）；text='front' 取消前台，否则取消后台
        const which = String(args.text || 'back').toLowerCase() === 'front' ? 'front' : 'back'
        const target = which === 'front' ? K.front : K.back
        if (!target) return { error: 'target not wired: ' + which }
        try {
          target.cancel(new Error('manual cancel via fr_poke'))
          event('cancel', { which, id: D.idOf(target) })
          return { cancelled: which, id: D.idOf(target), phase: target.phase && target.phase.kind }
        } catch (e) { return { error: String(e && e.message || e) } }
      }
      if (a === 'reload') {
        K.seenSteps.clear()
        D.resolveAgents()
        return { reloaded: true, front: D.idOf(K.front), back: D.idOf(K.back) }
      }
      return { error: 'unknown action' }
    },
  })

  // ── 前台上交（T8）：写结构化 handoff 包 + 唤醒后台 ─────────────────────
  // ── 后台专用：结构化提交路线（参数 schema 由框架校验 ⇒ 格式不可能跑偏）────────
  safeRegister({
    name: D.TN('fr_route'),
    description: '提交路线（结构化）。调用后插件自动生成 route.md —— **不要自己 write route.md**。仅后台可调用。'
      + ' mode="plan"=首次规划（覆写路线+写全部步骤）；mode="append"=只补新步骤（不改路线、不动已有步骤）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['plan', 'append'],
          description: '★ 首次规划用 plan（默认）；收到补步唤醒时用 append（只写新增步骤，不覆写路线、不碰已有步骤）。'
            + ' 需要**修改**已写出的步骤时，仍用 plan（编号不变、内容更新；已完成的步骤不会被重写）。',
        },
        goal: { type: 'string', description: '一句话目标（≤100 字）。append 模式可省略。' },
        acceptance: {
          type: 'array',
          description: '终态判定判据（1-2 条，可机器验证的最好）',
          items: { type: 'string' },
        },
        milestones: {
          type: 'array',
          description: '里程碑清单：**每个里程碑都要对应一个 steps 里的步骤**',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: '如 M1' },
              desc: { type: 'string', description: '一句话' },
              step: { type: 'string', description: '对应步号，如 S1' },
            },
            required: ['id', 'desc'],
          },
        },
        steps: {
          type: 'array',
          description: '步骤清单：**在这里一次给全**，插件会自动写出 steps/S<k>.md（不需要再单独 write）',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: '如 S1' },
              action: { type: 'string', description: '一句话，含确切路径/命令' },
              accept: { type: 'string', description: '可机器判定的验收条件' },
              assumes: { type: 'string', description: '上一步产出什么；首步写 无' },
              needs: { type: 'string', enum: ['judge'], description: '可选：该步依赖现场判断（测试过不过/实测值/路径取舍）时填 judge。插件投出该步后停牌等你判断（judge.ok），**依赖其结果的后续步骤不要写**，等判断后再 append' },
            },
            required: ['id', 'action', 'accept'],
          },
        },
        sentinels: {
          type: 'array',
          description: '机械哨兵（可选）：条件成立即路线作废，插件会打断后台并冻结前台',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: '如 C1' },
              kind: { type: 'string', enum: ['file-exists', 'file-absent', 'field-cmp', 'grep-match'] },
              target: { type: 'string', description: 'file-*: 绝对路径；field-cmp: "done | >= | S3"；grep-match: "路径 | 子串"' },
            },
            required: ['id', 'kind', 'target'],
          },
        },
      },
      // ★ 2026-11-07：required 从 ['goal','milestones'] 改为 []。
      //   原因：append 模式（补步）**不需要** goal/milestones —— 它只补新步骤，
      //   路由文件保持原样。若强制要求这两个字段，后台补步时必须重发整条路线，
      //   等于把「降低单次补步成本」的目标又推翻。
      //   plan 模式的字段要求改由 description + renderRoute 内部校验（见下）。
      required: [],
    },
    output: {
      schema: { type: 'object' },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
    },
    execute: async (args) => D.RT.renderRoute(args || {}),
  })

  safeRegister({
    name: D.TN('fr_escalate'),
    description: '前台上交给后台：请求路线规划。会写 .board/handoff.md 并唤醒后台。'
      + ' 后台会直接读 .board/task.md（任务原文），所以你**不需要**复述任务内容。'
      + ' 你只需要给出：①你认为最关键的文件 ②你的判断。',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '一句话：为什么上交（缺规划 / 卡住 / 路线不对）。可选，仅日志用。' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '你认为最关键的 1-3 个文件路径（后台会重点读它们）。**不需要解释文件内容**，后台自己会读。',
        },
        hint: { type: 'string', description: '你的判断（可选，≤80字）：问题在哪 / 该动什么。没有想法就留空，不要写废话。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    execute: async (args) => {
      D.resolveAgents()
      // ★★★ 2026-11-08 允许 quick 升级（前台主动上交 ⇒ 自动升 coding）→ lib/mode-auto.js
      D.MA.upgradeByFrontRequest()
      // ★★ 2026-11-07 改动 3：交接包瘦身
      //   原字段 reason/goal/known/tried/stuck 里，实测 known 写的是
      //   「任务目录已知，需要我先读 TASK.md」—— 纯废话（后台自己会读）。
      //   goal 也不需要了：任务原文已落盘在 .board/task.md。
      //   现在只保留：前台**独有**的判断（files 路径 + hint 想法），这两样后台拿不到。
      const filesList = Array.isArray(args.files) ? args.files.filter(Boolean).map(String).slice(0, 3) : []
      const doc = [
        `# handoff ${new Date().toISOString()}`,
        '## 为什么上交', String(args.reason || '(未提供)'),
        '## 关键文件（后台请优先读这些）', filesList.length ? filesList.join('\n') : '(前台未标注)',
        '## 前台的判断', String(args.hint || '(无)').slice(0, 200),
        '## 任务原文', '见 .board/task.md（完整原文，不用在这里复述）',
        '## state.md 快照', D.readIf(P.state).slice(0, 800),
      ].join('\n\n')
      const ok = D.writeAtomic(join(boardDir, 'handoff.md'), doc)
      event('escalate', { reason: String(args.reason || '').slice(0, 140) })
      // ★ 2026-11-08：记录上交时刻（执行层强制敦促用它判断"是否已上交"）
      try { K.lastEscalateAt = Date.now(); K.codingNotEscalated = false } catch { /* 忽略 */ }
      // ★ 新任务开始 ⇒ 重置本任务计数（否则 H5「步数超阈」会永久误报 —— 后台自己诊断出来的 bug：
      //   stepsThisTask 原来跨 v1/ab2/ab3/吞吐测试一直累加，从不清零）
      K.stepsThisTask = 0
      K.alertedSentinels.clear()
      K.finalAuditRetry = 0
      K.lastAuditedDeliverKey = ''
      K.taskWakes = 0
      K.taskFreezes = 0
      K.budgetAlerted = false
      K.changedFiles.clear()
      K.diffReviewCount = 0
      K.lastDiffReviewAt = 0
      K.lastTodoKey = ''
      K.finalAsked = false
      cfg.batchSteps = DEFAULTS.batchSteps   // O2 自适应：新任务回到默认批量
      K.lastWakeAt = 0   // 显式上交不受冷却限制
      K.testFailStreak = 0
      // ★ 首帧优化（2026-10-17）：把 handoff 内容**直接内联**进唤醒消息，省掉后台再 read 一次。
      //   ★ 2026-11-07：内联长度 1800 → 600。交接包瘦身后内容本身就短了（原文在 task.md）。
      let handoffBody = ''
      try { handoffBody = String(D.readIf(join(boardDir, 'handoff.md')) || '').slice(0, 600) } catch { /* 忽略 */ }
      const woke = D.RT.wakeBack('escalate',
        `【前台上交】${String(args.reason || '')}\n\n` +
        `===== 交接包（已内联）=====\n${handoffBody}\n===== 交接包结束 =====\n\n` +
        '## 只做 1 件事，做完就停（禁止调研）\n' +
        '**先 read `.board/task.md`**（任务完整原文，这是唯一真相源，不要靠交接包里的摘要猜）。\n' +
        '若交接包列了「关键文件」，**优先读那几个**（前台已替你筛过，别再全目录乱搜）。\n' +
        '**然后调用一次 ' + D.TN('fr_route') + ' 工具**，一次给出：goal / acceptance / milestones / steps。\n' +
        '**steps 里先只写 2 个**（首帧要快），但 milestones 要写全 —— 插件会自动催你补剩余步骤。\n' +
        '**补步时用 mode="append"**（只写新增步骤，不覆写路线、不碰已有步骤）。\n' +
        '插件会自动生成 route.md **并**写出 steps/S<k>.md —— 不需要你再 write 任何文件。\n' +
        '**禁止**：跑 pwsh/bash、读 heartbeat、探索目录、调 fr_status。\n' +
        // ★ 2026-11-08 治本（B）：允许后台只读代码来判断进度，不再依赖前台写记录文件。
        //   实测依据：read 一次 0.6 秒，而让前台写 3KB 记录要 9 秒（write 平均 8.9s/次）。
        //   后台看不到代码时只能要求前台"写报告"，那是 50-60 秒的纯浪费（验收根本不读那些文件）。
        '**可以（且鼓励）只读看代码**：`read` 你关心的文件来判断进度和正确性；'
          + '要验证就跑 `pwsh -c "node check.mjs"` 看退出码。**不要要求前台写记录类文件**'
          + '（notes.md / checklist.md / impl-notes.md / verify.log 等），那些对验收零贡献。\n' +
        '若任务明显是「≤3 步无依赖」，只写 verdict.md 一行「short: <理由>」然后停。')
      // ★ M2：上交后**不要空等** —— 把这条指令随工具结果一起回给前台（比只写简报更可靠，
      //   因为免费/弱模型经常"上交完就停下"。这是首帧 162s 浪费（占 AB1 总时长 27%）的对策。
      return {
        handoff: join(boardDir, 'handoff.md'),
        written: ok,
        wokeBack: woke,
        next: '不要停下！现在立刻做**无损前置工作**（最多 2-3 个动作）：只读侦察环境/路径/依赖/输入、建能提前建的空目录、能提前跑通的基线命令。禁止猜任务、禁止写最终交付物、禁止不可逆操作。做完后若步骤还没到，回一句「前置工作已完成，等待步骤」再停。',
      }
    },
  })

  return { frOnlyGate, FR_TOOL_DEFS, scopeRegistered, safeRegister, registerFrToolsTo, globalRegister }
}
