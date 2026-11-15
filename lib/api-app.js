/**
 * api-app.js —— apiApp 剩余 glue（status/task intake/config/models/mode/events/HTTP 中继）
 * 从 lib/index.js 抽出的第 3 阶段模块（行为不变 refactor）。
 *
 * 依赖（D 依赖袋，字段调用时读取）：
 *   稳定字段（工厂顶部解构）：K cfg ctx log vlog event TAG BASE_PATH boardRoot boardDir P BB
 *   惰性字段：BUILD_TAG CONFIG_KEYS GR MA RT applyToolPolicy attachToolPolicyFor cfgFile currentMode cwdOf effectiveBatch effortFor ensureWiring getFire idOf listSteps norm parseStepMeta presetName readState resetTaskScheduler resolveAgents routeFor saveOverrides stepNo wire writeAtomic
 *   K 共享状态：见 index.js 的 K 袋。
 *
 * 区块地图：
 *   apiApp 对象字面量整体抽出为 api；...GD.api / ...GR.api 两行留在 index 重组
 *   index：const AA = makeApiApp(D); const apiApp = { ...AA, ...GR.api, ...GD.api }
 *   注：presetName/BUILD_TAG/CONFIG_KEYS 仍在 index，经 D 调用
 */

import { MODE_KEYS, modeInfo, setCustomModes } from './modes.js'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { msg } from './messages.js'

export function makeApiApp (D) {
  const { cfg, ctx, log, vlog, event, TAG, BASE_PATH, boardRoot, boardDir, P, BB, K } = D

  // ── apiApp 剩余方法（index 用 { ...AA, ...GR.api, ...GD.api } 重组）──
  const api = {
    basePath: BASE_PATH,
    cfg, boardDir, event, log,
    idOf: D.idOf,
    readState: D.readState,
    listSteps: D.listSteps,
    resolveAgents: D.resolveAgents,
    ensureWiring: D.ensureWiring,
    wakeBack: D.RT.wakeBack,
    steerFront: D.RT.steerFront,
    saveOverrides: D.saveOverrides,
    get overrides () { return K.overrides },
    getFront: () => K.front,
    getBack: () => K.back,
    getMeter: () => K.svcMeter,
    // 干扰预算（每任务唤醒/冻结次数，超阈值已记事件）
    getBudget: () => ({ wakes: K.taskWakes, freezes: K.taskFreezes, limit: Number(cfg.budgetWakes) || 12, exceeded: K.budgetAlerted }),
    getLastAutoHealAt: () => K.autoHealAt,   // 面板判断"正在自愈"窗口
    // ── 任务模式（Phase 1）──
    getActualModels: () => {
      const pick = (a) => { try { return a && a.options ? { provider: a.options.provider || '', model: a.options.model || '' } : null } catch { return null } }
      return { front: pick(K.front), back: pick(K.back) }
    },
    /** 当前接线若不属于任何会话组 ⇒ 自动收编成一个新组（直接对话场景） */
    async ensureCurrentGroup () {
      try {
        if (!cfg.frontSessionId || !cfg.backSessionId) return null
        const list = D.GR.loadGroups()
        const fId = String(cfg.frontSessionId), bId = String(cfg.backSessionId)
        const hit = list.find((g) => String(g.frontId) === fId && String(g.backId) === bId)
        if (hit) return { group: hit, created: false }
        const r = await apiApp.createGroup('', true)   // adopt 当前前后台
        if (r && r.ok) { event('group-auto-adopt', { key: r.group && r.group.key }); log('直接对话 ⇒ 自动收编为会话组 ' + (r.group && r.group.key)) }
        return r && r.ok ? { group: r.group, created: true } : null
      } catch (e) { log('ensureCurrentGroup 失败: ' + e.message); return null }
    },
    // [重构①] T3 审批方法（listPendingConfirms/approveConfirm/rejectConfirm） → lib/guards.js
    getLastError: () => K.lastAgentError,
    getMode: () => ({
      mode: D.currentMode(),
      label: modeInfo(D.currentMode()).label,
      by: K.modeBy,
      locked: !!cfg.modeLocked,
      auto: cfg.modeAuto !== false,
      presets: MODE_KEYS,
      // 每个预设的一句话简介（面板悬停提示用，唯一来源 lib/modes.js）
      presetsInfo: MODE_KEYS.map((k) => ({ key: k, label: modeInfo(k).label, summary: modeInfo(k).summary })),
    }),
    getWorkers: () => [...K.workers.entries()].map(([id, w]) => ({ id, task: w.task, ageMs: Date.now() - w.at })),
    getAdaptive: () => ({ batch: K.adaptiveBatch, gaps: K.recentGaps.slice(-3), enabled: cfg.batchAdapt !== false, effective: D.effectiveBatch() }),
    getPhase: () => ({ phase: K.phaseStrategy || null, strategy: K.activeStrategy || null, orchestration: cfg.orchestration || 'auto', enablePhases: !!cfg.enablePhases }),
    // ★ 2026-11-15 生效指示：判断停牌状态 + 前后台实际 preset
    getJudge: () => K.judgeWaiting,
    // ★ 热重载探针：每次 apply 生成新时间戳，status 带回 ⇒ 可验证 reload 是否换掉了路由闭包
    getBuildTag: () => D.BUILD_TAG,
    getPresets: () => {
      const p = (a) => { try { return (a && a.session && K.svcPresets) ? K.svcPresets.presetForSession(a.session) : null } catch { return null } }
      return { front: p(K.front), back: p(K.back) }
    },
    setMode: (key, by) => D.MA.applyMode(key, by || 'user', 'api'),
    applyToolPolicy: D.applyToolPolicy,

    /** ★ 2026-11-08 刹车：按范围停止（front/back/all），**不禁用插件**、不销毁会话。
     *  与 stopAll 的区别：stopAll 关掉整个插件；brake 只踩当前任务，插件继续待命。
     *  同时设 pauseAt，否则下一个 tick 插件又会自动唤醒后台（等于没刹住）。 */
    brake (scope = 'all', reason = 'manual') {
      const out = { scope, stopped: [], kept: [] }
      const setPauseNow = () => { K.pauseAt = Date.now(); K.userStopAt = K.pauseAt }
      const kill = (ag, label) => {
        if (!ag) { out.kept.push(label + ':未接线'); return }
        try {
          const running = !!(ag.phase && ag.phase.kind === 'running')
          if (running) { ag.cancel(new Error('brake: ' + reason)); out.stopped.push(label) }
          else out.kept.push(label + ':空闲')
        } catch (e) { out.kept.push(label + ':停止失败(' + (e && e.message || e) + ')') }
      }
      if (scope === 'front' || scope === 'all') kill(K.front, 'front')
      if (scope === 'back' || scope === 'all') kill(K.back, 'back')
      // 只有全停才进入暂停态；只停一边时另一边的流程还得继续
      if (scope === 'all') setPauseNow()
      event('brake', out)
      log('刹车：' + JSON.stringify(out))
      return out
    },

    /** 解除刹车（恢复自动推进） */
    unbrake () {
      K.pauseAt = 0
      K.userStopAt = 0
      event('unbrake', {})
      log('刹车已解除，恢复自动推进')
      return { ok: true, paused: false }
    },

    /** 停止：取消正在跑的前后台（不销毁会话） */
    stopAll () {
      K.pauseAt = Date.now()         // ★ 真·用户暂停：优先级最高，连消防说明的 force 也不放行
      K.userStopAt = K.pauseAt         // ★ 用户点了停止 ⇒ 尊重意图，15s 内不再内联追加      const r = { front: false, back: false }
      try { if (K.front && K.front.phase && K.front.phase.kind === 'running') { K.front.cancel(new Error('api stop')); r.front = true } } catch { /* 忽略 */ }
      try { if (K.back && K.back.phase && K.back.phase.kind === 'running') { K.back.cancel(new Error('api stop')); r.back = true } } catch { /* 忽略 */ }
      return r
    },

    /** 重建：优先 cfg.provider/model（或显式传入），兜底全局默认模型；cwd 用 boardRoot */
    async rebuildSessions (explicit) {
      if (!K.svcAgentLoop || !K.svcPresets) return { error: 'agentLoop / agentPresets 服务未就绪' }
      // ★★ 2026-11-07 修复（route 污染）：
      //   原实现先 resolveRoute() 拿 base（= cfg.provider/cfg.model，可能是 buddy/glm），
      //   把 base **写回** cfg.provider/model 并持久化，返回值也用 base。
      //   但会话真正用的是 routeFor(tag)，它**优先** cfg.frontProvider/frontModel（deepseek）。
      //   后果三个：
      //     ① 返回值谎报（API 说 buddy，实际跑 deepseek ⇒ 排障被带偏）；
      //     ② 持久化把 buddy 焊进 cfg.provider/model，之后任何走 resolveRoute 的路径
      //        （组会话、worker、ensureWiring 的 base）都会拿到 buddy ⇒ 悄悄换模型；
      //     ③ 全局默认若被用户切到免费模型，会被固化成前后台的 base。
      //   正确做法：**不拿 base 当结果**。显式传参优先；否则按角色取 routeFor(tag)，
      //   并把"显式指定"与"角色覆盖"分别记在自己的键上，绝不覆盖 cfg.provider/model。
      const explicitRoute = (explicit && explicit.provider && explicit.model) ? explicit : null
      const effRoute = (tag) => {
        if (explicitRoute) return explicitRoute
        return D.routeFor(tag)          // 已包含 frontProvider/backProvider 优先逻辑
      }
      const mk = async (tag) => {
        const r = effRoute(tag) || {}
        if (!r.provider || !r.model) return null
        const ag = await K.svcAgentLoop.create((TAG === 'a' ? 'session-fr-' : 'session-fr-' + TAG + '-') + tag + '-' + Date.now().toString(36),
          { provider: r.provider, model: r.model, reasoningEffort: D.effortFor(tag) }, { cwd: boardRoot })
        try { await K.svcPresets.mount(ag.ctx, D.presetName()) } catch (e) { log('挂预设失败: ' + e.message) }
        // ★★ 2026-11-07：会话一创建就立刻挂工具面（窗口 = 0，不等 resolveAgents）
        try { D.attachToolPolicyFor(tag, ag) } catch (e) { log('重建即时挂工具面失败: ' + e.message) }
        return ag
      }
      try { if (K.front) K.front.cancel(new Error('rebuild')) } catch { /* 忽略 */ }
      try { if (K.back) K.back.cancel(new Error('rebuild')) } catch { /* 忽略 */ }
      const f = await mk('front')
      const b = await mk('back')
      if (!f || !b) return { error: '拿不到模型路由（请设置 frontProvider/frontModel 或全局 provider/model）' }
      D.wire(D.idOf(f), D.idOf(b))
      // ★ 只在**显式传入**时才持久化（那是用户本轮的明确意图）。
      //   绝不把 resolveRoute 的 base 写回 cfg（那会污染角色覆盖）。
      if (explicitRoute) {
        K.overrides.provider = explicitRoute.provider
        K.overrides.model = explicitRoute.model
        cfg.provider = explicitRoute.provider
        cfg.model = explicitRoute.model
        D.saveOverrides()
      }
      K.briefed.clear()
      D.resolveAgents()          // ★ 立刻按新接线解析，避免后续逻辑仍拿旧的 front/back
      const fr = effRoute('front') || {}
      const bk = effRoute('back') || {}
      return {
        front: D.idOf(f), back: D.idOf(b),
        provider: fr.provider, model: fr.model,                       // 真实生效（前台）
        frontProvider: fr.provider, frontModel: fr.model,
        backProvider: bk.provider, backModel: bk.model,
      }
    },

    /** 消防打断（走模块级 FIRE 句柄） */
    fireInterrupt (reason) {
      try {
        // ★ 签名修复（2026-10-17 实测）：FIRE = fireInterrupt(agent, why, note)，
        //   之前这里 FIRE(reason) 把 reason 当 agent 传进去 ⇒ "target.cancel is not a function"。
        const FIRE = D.getFire(TAG)
        if (typeof FIRE === 'function') {
          D.resolveAgents()
          const r = FIRE(K.front, 'api', String(reason || 'API 手动打断'))
          return { fired: !!(r && r.ok), result: r }
        }
        // 退路：直接 cancel 前台
        const f = K.front
        if (f && f.phase && f.phase.kind === 'running') { f.cancel(new Error(String(reason || 'fire'))); return { fired: true, mode: 'cancel' } }
        return { fired: false, why: '前台空闲，无需打断' }
      } catch (e) { return { fired: false, error: String(e && e.message || e) } }
    },

    /** 模型清单：走 ctx.llm 的 provider/model 发现，供面板「模型切换」下拉使用 */
    async listModels () {
      // ★ ctx.llm 需要 inject 声明；本插件不依赖它，用可选访问器 ctx.get() 取
      const svc = (name) => { try { return (ctx && typeof ctx.get === 'function') ? ctx.get(name) : undefined } catch { return undefined } }
      const providers = []
      try {
        const llm = svc('llm')
        if (llm && typeof llm.listProviders === 'function') {
          for (const p of llm.listProviders() || []) {
            const id = (typeof p === 'string') ? p : (p.id || p.provider || p.name || '')
            if (!id) continue
            let models = []
            try {
              const list = (await llm.listModels(id)) || []
              models = list.map((m) => (typeof m === 'string') ? m : ((m && (m.id || m.model || m.name)) || '')).filter(Boolean)
            } catch { /* 该 provider 不支持发现 */ }
            providers.push({ provider: id, models })
          }
        }
      } catch (e) { log('listModels fail: ' + (e && e.message)) }
      return { providers, current: { provider: cfg.provider || '', model: cfg.model || '' } }
    },

    /** 切换模型：写 cfg/overrides + 已接线会话的 options + DSH 全局默认选择 */
    async setModel (provider, model, role) {
      try {
        if (!provider || !model) return { error: 'provider 和 model 都必需' }
        const only = (role === 'front' || role === 'back') ? role : 'both'
        if (only === 'both') {
          cfg.provider = provider; cfg.model = model
          K.overrides.provider = provider; K.overrides.model = model
          // ★ both = 前后台都跟随全局 ⇒ 必须清掉角色级覆盖，否则状态里 front/back 仍是旧模型（面板高亮会错）
          cfg.frontProvider = ''; cfg.frontModel = ''; cfg.backProvider = ''; cfg.backModel = ''
          for (const k of ['frontProvider', 'frontModel', 'backProvider', 'backModel']) {
            delete K.overrides[k]
            K.droppedOnce.add(k)
          }
        } else if (only === 'front') {
          cfg.frontProvider = provider; cfg.frontModel = model
          K.overrides.frontProvider = provider; K.overrides.frontModel = model
        } else {
          cfg.backProvider = provider; cfg.backModel = model
          K.overrides.backProvider = provider; K.overrides.backModel = model
        }
        D.saveOverrides()
        const targets = only === 'both' ? [K.front, K.back] : (only === 'front' ? [K.front] : [K.back])
        for (const ag of targets) {
          if (!ag) continue
          try {
            if (ag.options) { ag.options.provider = provider; ag.options.model = model }
            else ag.options = { provider, model }
          } catch { /* 忽略 */ }
        }
        try {
          const dm = (typeof ctx.get === 'function') ? ctx.get('agentDefaultModel') : undefined
          if (dm && typeof dm.saveSelection === 'function') await dm.saveSelection({ provider, model })
        } catch { /* 全局默认写不进去不影响面板显示 */ }
        event('route-set', { role: only, to: provider + '/' + model })
        log('模型切换 -> ' + provider + '/' + model)
        return { ok: true, provider, model, applied: true }
      } catch (e) { return { error: String(e && e.message || e) } }
    },

    // [重构①] 会话组管理方法（listGroups/setGroupPolicy/createGroup/deleteGroup/restoreGroup/switchGroup/repairGroups） → lib/groups.js

    /** 权限预设目录（前端下拉用） */
    permissionCatalog () { return D.GR.permissionCatalog() },

    /** 当前前后台实际生效的权限预设（面板显示/排障用） */
    currentPermissions () {
      return {
        front: K.front ? D.GR.currentPreset(D.idOf(K.front)) : '',
        back: K.back ? D.GR.currentPreset(D.idOf(K.back)) : '',
        default: cfg.permissionPreset || '',
      }
    },

    // ══ 会话寻址（per-session API）════════════════════════════════════════
    // 目标解析优先级：sessionId > group(+role) > 当前接线
    resolveSessionTarget (opts = {}) {
      const byId = (id) => { try { return id ? (ctx.agents.get(String(id)) || null) : null } catch { return null } }
      if (opts.sessionId) return byId(opts.sessionId)
      if (opts.group) {
        const g = D.GR.loadGroups().find((x) => x.key === String(opts.group))
        if (!g) return null
        return byId(opts.role === 'back' ? g.backId : g.frontId)
      }
      return opts.role === 'back' ? K.back : K.front
    },

    /** 列出所有活会话（含角色/所属组/phase/preset） */
    listSessions () {
      const groups = D.GR.loadGroups()
      const groupOf = (id) => {
        const g = groups.find((x) => String(x.frontId) === String(id) || String(x.backId) === String(id))
        if (!g) return ''
        return g.key + (String(g.frontId) === String(id) ? '·F' : '·B')
      }
      try {
        return {
          sessions: ctx.agents.list().map((a) => {
            const id = D.idOf(a)
            return {
              id,
              role: a === K.front ? 'front' : (a === K.back ? 'back' : 'other'),
              phase: (a.phase && a.phase.kind) || '?',
              cwd: D.cwdOf(a),
              preset: D.GR.currentPreset(id),
              group: groupOf(id),
              wired: String(id) === String(cfg.frontSessionId) || String(id) === String(cfg.backSessionId),
            }
          }),
        }
      } catch (e) { return { error: String(e && e.message || e) } }
    },

    /** 单个会话信息（不含对话正文，正文用 /fr/api/status 的 chat） */
    sessionInfo (opts = {}) {
      const a = apiApp.resolveSessionTarget(opts)
      if (!a) return { error: '目标会话不存在（检查 sessionId / group / 接线）' }
      const id = D.idOf(a)
      return {
        id,
        role: a === K.front ? 'front' : (a === K.back ? 'back' : 'other'),
        phase: (a.phase && a.phase.kind) || '?',
        cwd: D.cwdOf(a),
        preset: D.GR.currentPreset(id),
        wired: id === String(cfg.frontSessionId) || id === String(cfg.backSessionId),
      }
    },

    /** 把消息投递给任意会话（interrupt=true 先 cancel 再投递） */
    async deliver (opts = {}, text, interrupt) {
      const a = apiApp.resolveSessionTarget(opts)
      if (!a) return { error: '目标会话不存在（检查 sessionId / group / 接线）' }
      const id = D.idOf(a)
      const body = String(text || '').trim()
      if (!body) return { error: 'text 不能为空' }
      if (a === K.front) K.lastTaskText = body.slice(0, 4000)
      // ── 新任务到达 ⇒ 无条件重置任务级状态（★ 2026-11-07 修复） ─────────────
      //
      // 原实现把 resetTaskScheduler / taskBatchOverride / lastAgentError 三件事
      // 塞进了 `if (cfg.modeAuto !== false && !cfg.modeLocked)` 块里，
      // 于是 benchmark 设 modeLocked:true 时**它们全都不执行**：
      //   · judgeWaiting / review 计数 / 分析投递时间戳 跨任务残留
      //   · 上一个任务的批量覆盖继续污染新任务
      //   · 旧错误提示不清
      // 这是「模式锁定」意外产生的副作用 —— 锁定模式只该禁"自动判型"，不该禁"任务重置"。
      // 下面把两者拆开：重置无条件执行，判型仍受 modeAuto/modeLocked 控制。
      if (a === K.front) {
        try { D.resetTaskScheduler() } catch (e) { log('任务状态重置失败: ' + e.message) }
        K.taskBatchOverride = 0
        K.lastAgentError = null
      }
      // ── 模式自动判型（Phase 1）→ lib/mode-auto.js
      D.MA.detectAndApplyTask(body, opts, a)
      // ★ §22 优化①：检测编号列举步骤数 ⇒ 本任务一次投全批（前台一个回合做完，省 5 次往返）
      try {
        const numbered = body.match(/[①-⑳]|^\s*\d+[.、）)]/gm) || []
        const cnSteps = body.match(/第[一二三四五六七八九十]+步/g) || []
        const count = Math.max(numbered.length, cnSteps.length)
        K.taskBatchOverride = count >= 3 ? Math.min(count, 8) : 0
        if (K.taskBatchOverride) log(`编号步骤任务：批量覆盖 = ${K.taskBatchOverride}`)
      } catch { /* 判定失败不影响投递 */ }
      const running = !!(a.phase && a.phase.kind === 'running')
      let cancelled = false
      if (interrupt && running) {
        try { a.cancel(new Error('send-interrupt')); cancelled = true } catch { /* 忽略 */ }
        if (cancelled) await new Promise((r) => setTimeout(r, 400))
      }
      K.lastBeatAt = Date.now()   // ★ §31 修复：新任务/插话起点 = 心跳基线重置（防 H3 把空闲期计入停滞误杀新任务）
      // ★★ 2026-11-07 新任务 ⇒ 无条件清理上一轮的交付产物（关键修复）
      //
      // 事故链：deliver.v1.md 是「任务已交付」的唯一判据，被 hasDeliver() 用于三处短路：
      //   ① checkLookahead 第 1894 行 `if (hasDeliver()) return` —— 结果**缺口催补永远跑不到**
      //   ② checkFinalAudit `if (!hasDeliver()) return`
      //   ③ archiveBoardIfDone `if (!B.hasDeliver()) return false`
      // 但**没有任何代码清理它**：resetTaskScheduler 只清 judge/review 计数，
      // 而且它还被 `cfg.modeAuto !== false && !cfg.modeLocked` 这个条件包着，
      // benchmark 设了 modeLocked:true ⇒ 连它都不跑。
      // 于是上一轮的 deliver 一直躺在盘上 ⇒ 新任务的缺口检查从第一步就被短路。
      // 实测：黑板里同时躺着 deliver.v1/v2/invalid-* 三个文件，steps 只有 S1/S2。
      //
      // 修法：每次**投递新任务**时把旧产物移到 stale/。
      //
      // ★★ 2026-11-08 二次修正：**通过 API 投递的任务一律算新任务**（不管前台是否在跑）。
      //   实测事故：bench-forced 的第二轮，前台还在跑上一轮 ⇒ deliver 走 steer 分支 ⇒
      //   `running && !interrupt` 为真 ⇒ 判定为"插话" ⇒ **黑板没清场** ⇒
      //   第二轮拿到了第一轮残留的 steps/route（route-append-mode existing:3）⇒ 串味。
      //   语义澄清：
      //     · steer 是"用户在对话里插一句话"——那是同一任务的补充，不该清场
      //     · API 投递（/api/task）是"外部发起一个新任务"——**一律清场**
      //   区分方式：API 投递会带 opts.external === true（见 api.js 的 /api/task）。
      const isApiTask = !!(opts && opts.external)
      const isSteerInsert = (running && !interrupt && !isApiTask)
      if (a === K.front && !isSteerInsert) {
        // ★ 2026-11-07：催补计数无条件随任务重置。
        //   原实现只在"缺口补齐"时归零，会跨任务累积：上一任务催 3 次未响应，
        //   新任务的缺口就一次也催不出来（`milestoneGapCount < 3` 恒假）。
        K.milestoneGapCount = 0
        try {
          const moved = []
          for (const f of readdirSync(boardDir)) {
            if (!/^deliver(\.v\d+)?\.md$/i.test(f) && !/^deliver\.invalid-/.test(f)) continue
            try {
              mkdirSync(join(boardDir, 'stale'), { recursive: true })
              renameSync(join(boardDir, f), join(boardDir, 'stale', f))
              moved.push(f)
            } catch { /* 单个失败不影响投递 */ }
          }
          if (moved.length) {
            K.lastAuditedDeliverKey = ''
            K.finalAuditRetry = 0
            K.finalAsked = false
            event('deliver-cleared', { files: moved })
            log(`新任务 ⇒ 清理上一轮交付文件 ${moved.join(',')}（避免堵死缺口检查）`)
          }
        } catch (e) { log('清理旧 deliver 失败: ' + e.message) }
        // ★★ 2026-11-07 新任务 ⇒ 清理旧 steps / route / state（防跨任务串味）
        //
        // 实测事故：11:44:13 出现 `steps-pruned moved:7 keepMax:2` ——
        //   上一轮遗留 7 个步骤文件，只有靠 renderRoute 里"删 >maxK"的规则才被动清掉。
        //   但在**后台写出新 route 之前**，那 7 个旧步骤仍留在盘上：
        //   ① checkNewSteps 可能把它们投给前台（前台按旧任务执行 ⇒ 串味）
        //   ② checkLookahead 的缺口检测读到旧 steps 数，判断失真
        //   ③ route.md 还是旧任务的，里程碑数按旧的算
        //   旧代码只在 renderRoute 里被动清理，而 renderRoute 要等后台响应（7-10s）。
        //   这 7-10 秒就是串味窗口。
        //   修法：新任务一进来就主动清场 —— steps / route / state 全部移到 stale/。
        //   代价：后台需要重新规划（本来也要），收益是彻底消除串味窗口。
        try {
          const staleDir = join(boardDir, 'stale')
          mkdirSync(staleDir, { recursive: true })
          let pruned = 0
          // ① steps/ 全部移走
          try {
            for (const f of readdirSync(P.stepsDir)) {
              if (!/^S\d+\.md$/.test(f)) continue
              try { renameSync(join(P.stepsDir, f), join(staleDir, `S.${Date.now()}.${f}`)); pruned++ } catch { /* 忽略 */ }
            }
          } catch { /* steps 目录不存在 */ }
          // ② route.md 移走（否则里程碑数按旧任务算）
          try {
            if (existsSync(P.route)) renameSync(P.route, join(staleDir, `route.${Date.now()}.md`))
          } catch { /* 忽略 */ }
          // ③ state.md 复位（done 归零，避免新任务从 S4 开始找步骤）
          try {
            D.writeAtomic(P.state, 'planVersion: 0\nstatus: working\ndone: S0\nassumesMatch: yes\nrouteOk: yes\n')
          } catch { /* 忽略 */ }
          try { K.seenSteps.clear() } catch { /* 忽略 */ }
          K.milestoneGapCount = 0
          // ★★ 2026-11-07 改动 2：任务原文落盘（后台规划的唯一真相源）
          //   原来 api-task 只记 chars（字符数），原文根本没落盘 ⇒
          //   后台只能靠交接包里被压缩过的 goal 字段猜任务是什么。
          //   现在原文写进 .board/task.md，后台醒来直接 read，不用猜。
          try {
            D.writeAtomic(join(boardDir, 'task.md'), body)
            event('task-saved', { chars: body.length })
            log(`新任务 ⇒ 原文已落盘 .board/task.md（${body.length} 字符）`)
          } catch (e) { log('任务落盘失败: ' + e.message) }
          if (pruned) {
            event('task-cleared', { steps: pruned })
            log(`新任务 ⇒ 清场：移走 ${pruned} 个旧步骤 + 旧 route，state 复位（消除串味窗口）`)
          } else {
            event('task-cleared', { steps: 0 })
          }
        } catch (e) { log('新任务清场失败: ' + e.message) }
        // ★★ 2026-11-07 新任务 ⇒ 打断仍在跑的后台（防它继续给旧任务写步骤）
        //
        // 场景：后台正在为旧任务产 step（可能要 7-10 秒），前台已经接到新任务。
        //   若不打断，后台会把旧任务的 S3/S4 写进 steps/ ⇒ 前台读到后按旧任务执行 ⇒ 串味。
        //   实测同类事故：上一轮 S1..S8 / 本轮 S1..S3 时，前台跑完 S3 会拿到上一轮的 S4。
        //   注：renderRoute 已有"清理编号 > 本轮最大步号"的残留保护，但那只在同一任务内生效；
        //   跨任务必须由这里主动打断，否则新任务的 route 还没写出来，旧步骤已经投给前台了。
        try {
          if (K.back && K.back.phase && K.back.phase.kind === 'running') {
            K.back.cancel(new Error('new-task-supersedes'))
            event('back-cancelled', { reason: 'new-task' })
            log('新任务到达 ⇒ 打断正在产出的后台（避免继续写旧任务的步骤）')
          }
        } catch (e) { log('打断后台失败: ' + e.message) }
      }
      const message = msg(body)
      let mode = cancelled ? 'interrupt' : (running ? 'steer' : 'wake')
      try {
        if (running && !cancelled) a.steer(message)
        else a.followup(message)
      } catch (e) {
        log('deliver fail: ' + (e && e.message) + ' → followup')
        try { a.followup(message); mode = 'followup-fallback' } catch (e2) { return { error: String(e2 && e2.message || e2) } }
      }
      event('deliver', { session: id, mode, interrupt: !!interrupt, cancelled })
      return { ok: true, session: id, mode, interrupt: !!interrupt, cancelled }
    },




    /** ★ 2026-11-15 清理历史未分组：FR 产生(cwd=boardRoot)、不在任何工作区/组/台账、
     *  非当前前后台的会话 ⇒ 宿主级归档（可恢复）。治"删组后大量未分组"的历史存量。 */
    async archiveUngrouped () {
      const wr = await D.GR.wsRegistry()
      if (!wr) return { error: 'workspaceRegistry 未就绪' }
      // ★ 2026-11-15 修正：ctx.sessions 是内存 store（重启后旧会话不在）⇒ 改用持久化 store；
      //   快照字段名不确定 ⇒ cwd 多路径取 + FR 会话 id 前缀兜底识别
      const sp = await new Promise((res) => { try { ctx.inject(['sessionPersistence'], (c) => res(c.sessionPersistence)) } catch { res(null) } })
      if (!sp) return { error: 'sessionPersistence 服务未就绪' }
      const snaps = await sp.list()
      const attached = new Set()
      for (const w of (wr.list() || [])) for (const id of (w.sessionIds || [])) attached.add(String(id))
      const groupIds = new Set()
      for (const g of D.GR.loadGroups()) { groupIds.add(String(g.frontId)); groupIds.add(String(g.backId)) }
      for (const g of D.GR.loadArchived()) { groupIds.add(String(g.frontId)); groupIds.add(String(g.backId)) }
      const keep = new Set([String(cfg.frontSessionId), String(cfg.backSessionId)])
      const targets = []
      for (const s of snaps) {
        const id = String(s.id || (s.header && s.header.id) || '')
        const cwd = D.norm(s.cwd || (s.header && s.header.cwd) || (s.meta && s.meta.cwd) || '')
        const isFr = /^session-fr[-_]/.test(id) || cwd === D.norm(boardRoot)
        if (!isFr) continue
        if (attached.has(id) || groupIds.has(id) || keep.has(id)) continue
        if (s.archived || (s.header && s.header.archived) || (s.meta && s.meta.archived)) continue
        targets.push(id)
      }
      let done = 0
      for (const id of targets) {
        try { await wr.archiveSession(id); done++ } catch (e) { log('archiveUngrouped fail ' + id + ': ' + (e && e.message)) }
      }
      event('ungrouped-archived', { count: done, scanned: targets.length })
      log('清理未分组：归档 ' + done + '/' + targets.length + ' 个 FR 历史会话')
      return { ok: true, archived: done, scanned: targets.length }
    },




    /** 应用配置（白名单字段，写回 config.json 并立即生效） */
    applyConfig (body) {
      const allowed = D.CONFIG_KEYS
      const applied = {}
      for (const k of allowed) {
        if (body[k] === undefined) continue
        const v = body[k]
        if (typeof v === 'number' && !Number.isFinite(v)) continue
        cfg[k] = v
        K.overrides[k] = v
        applied[k] = v
      }
      D.saveOverrides()
      try { setCustomModes(cfg.customModes) } catch { /* 忽略 */ }
      return { applied }
    },

    /** HTTP 版 fr_poke：只覆盖常用动作，避免为 API 复制整段工具实现 */
    async poke (action, args) {
      const a = String(action || '')
      if (a === 'wake') { K.lastWakeAt = 0; return { woke: D.RT.wakeBack('manual', String(args.text || '【手动唤醒】请读 .board/ 继续。')) } }
      if (a === 'steer') { return { steered: D.RT.steerFront(String(args.text || '【手动插话】'), 'manual') } }
      if (a === 'fire') { return apiApp.fireInterrupt(String(args.text || args.reason || '手动打断')) }
      if (a === 'config') {
        try { Object.assign(cfg, JSON.parse(readFileSync(D.cfgFile, 'utf8')) || {}); D.resolveAgents(); return { reloaded: true } } catch (e) { return { error: String(e && e.message || e) } }
      }
      if (a === 'probe-tools') {
        // ★ Phase 0 门禁（2026-10-24）：验证 tools.restrict 能否作用于**已存在的**前/后台会话，
        //   并且能从 tools.schemas(agent) 观察到可见工具数变化。这决定「按模式分配工具」的可行性。
        const out = { at: new Date().toISOString(), agents: [] }
        for (const [role, ag] of [['front', K.front], ['back', K.back]]) {
          const rec = { role, hasAgent: !!ag }
          if (!ag) { out.agents.push(rec); continue }
          try {
            // 必须在 agent 自己的 ctx 上调：在插件 ctx 上调会变成全局限制（会波及用户会话）
            const sctx = ag.ctx || null
            const tools = sctx && typeof sctx.get === 'function' ? sctx.get('tools') : undefined
            rec.hasAgentCtx = !!sctx
            rec.hasTools = !!tools
            if (!tools) { out.agents.push(rec); continue }
            const names = () => {
              try { return (typeof tools.schemas === 'function' ? tools.schemas(ag) : []).map(t => t && t.name).filter(Boolean) } catch { return [] }
            }
            rec.before = names().length
            rec.beforeNames = names().slice(0, 40)

          } catch (e) { rec.error = String(e && e.message || e) }
          out.agents.push(rec)
        }
        return out
      }
      if (a === 'probe-any') {
        // ★ 2026-11-08 自证用：按 sessionId 查**该会话实际可见**的工具（tools.schemas(agent)）
        //   这是模型面（不是 inspect 的注册视图），能证明 when 作用域门是否生效。
        const out = { targets: [] }
        let ids = []
        try {
          // relay 的请求体变量名是 action/body，不是 args
          const bodyObj = (() => { try { return typeof body !== 'undefined' ? body : null } catch { return null } })()
          const argIds = Array.isArray(bodyObj && bodyObj.ids) ? bodyObj.ids
            : (Array.isArray(action && action.ids) ? action.ids : [])
          if (argIds.length) ids = argIds.map(String)
          else {
            // 不传就枚举当前所有 agent
            const all = (() => { try { return ctx.agents.list() || [] } catch { return [] } })()
            ids = all.map((x) => String(x.id || x && x.id || '')).filter(Boolean)
          }
        } catch { /* 忽略 */ }
        for (const id of ids) {
          const rec = { id, count: 0, names: [], frTools: [] }
          try {
            const ag = (() => { try { return ctx.agents.get(id) } catch { return null } })()
            if (!ag) { rec.error = 'agent not found'; out.targets.push(rec); continue }
            const tt = ag.ctx && typeof ag.ctx.get === 'function' ? ag.ctx.get('tools') : undefined
            if (tt && typeof tt.schemas === 'function') {
              const arr = (tt.schemas(ag) || []).map((t) => t && t.name).filter(Boolean)
              rec.count = arr.length
              rec.names = arr
              rec.frTools = arr.filter((n) => /^fr_/.test(n))
            }
          } catch (e) { rec.error = String(e && e.message || e) }
          out.targets.push(rec)
        }
        return out
      }
      if (a === 'probe-tools2') {
        // 返回前/后台**实际可见**的工具名数组（tools.schemas(agent)）
        const out = {}
        for (const [role, ag] of [['front', K.front], ['back', K.back]]) {
          if (!ag) { out[role] = null; continue }
          try {
            const tools = ag.ctx && typeof ag.ctx.get === 'function' ? ag.ctx.get('tools') : undefined
            out[role] = { count: 0, names: [] }
            if (tools && typeof tools.schemas === 'function') {
              const arr = (tools.schemas(ag) || []).map((t) => t && t.name).filter(Boolean)
              out[role] = { count: arr.length, names: arr }
            }
          } catch (e) { out[role] = { error: String(e && e.message || e) } }
        }
        return out
      }
      if (a === 'probe-scheduler') {
        // 只读：报告当前调度决策（不投递、不唤醒），用于安全验证依赖/停牌/步长
        const st = D.readState()
        const doneNo = D.stepNo(st.done || '')
        let files = []
        try { files = readdirSync(P.stepsDir).filter(f => /^S\d+\.md$/.test(f)).sort((x, y) => D.stepNo(x) - D.stepNo(y)) } catch { /* 忽略 */ }
        const out = {
          at: new Date().toISOString(),
          mode: D.currentMode(),
          modeLabel: modeInfo(D.currentMode()).label,
          effectiveBatch: D.effectiveBatch(),
          done: doneNo,
          judgeWaiting: K.judgeWaiting,
          steps: [],
          decision: [],
        }
        for (const f of files) {
          let body = ''
          try { body = readFileSync(join(P.stepsDir, f), 'utf8') } catch { continue }
          const meta = D.parseStepMeta(body)
          out.steps.push({ file: f, len: body.trim().length, depends: meta.depends, judge: meta.judge, group: meta.group, strategy: meta.strategy, body: body.slice(0, 200), seen: !!K.seenSteps.get(f) })
        }
        for (let n = doneNo + 1; n <= doneNo + out.effectiveBatch; n++) {
          const f = `S${n}.md`
          const rec = out.steps.find(x => x.file === f)
          if (!rec) { out.decision.push({ file: f, verdict: 'missing' }); break }
          if (rec.len < D.RT.MIN_STEP_CHARS) { out.decision.push({ file: f, verdict: 'too-short' }); break }
          if (rec.seen) { out.decision.push({ file: f, verdict: 'already-seen' }); break }
          const missing = rec.depends.filter(d => d > doneNo)
          if (missing.length) { out.decision.push({ file: f, verdict: 'dep-blocked', missing }); break }
          out.decision.push({ file: f, verdict: 'would-deliver' })
          if (rec.judge) { out.decision.push({ file: f, verdict: 'judge-stop' }); break }
        }
        return out
      }
      if (a === 'probe-agent') {
        // 读运行时 Agent 的方法表（判断"如何启动第一回合"）
        const dump = (ag) => {
          if (!ag) return null
          const names = new Set()
          try { for (const k of Object.keys(ag)) names.add(k) } catch { /* 忽略 */ }
          try {
            let p = Object.getPrototypeOf(ag)
            while (p && p !== Object.prototype) { for (const k of Object.getOwnPropertyNames(p)) names.add(k); p = Object.getPrototypeOf(p) }
          } catch { /* 忽略 */ }
          const out = {}
          for (const n of names) {
            try {
              const t = typeof ag[n]
              if (t === 'function') out[n] = 'fn'
              else if (t === 'object') out[n] = ag[n] === null ? 'null' : 'obj'
              else if (['string', 'number', 'boolean'].includes(t)) out[n] = t
            } catch { out[n] = 'err' }
          }
          return out
        }
        return { front: dump(K.front), back: dump(K.back) }
      }
      return { error: 'HTTP 中继不支持该动作: ' + a }
    },
  }

  return api
}
