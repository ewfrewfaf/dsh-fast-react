/**
 * @dsh-external/dsh-fast-react —— 快速反应插件（宿主半边，零构建 ESM）
 *
 * 目标：效率。前台（LOW）快答快做，后台（HIGH）逐条规划，两者只通过黑板交换信息。
 *
 * 设计真源：桌面《快速反应插件-实现逻辑-v2.md》《快速反应插件-代码实现总案-v1.md》
 *
 * 本文件实现 P2 核心：
 *   B1 黑板 IO（原子写 / 只增不改 / 追加日志）
 *   B2 接线：按 agent preset 或显式 sessionId 识别前台/后台
 *   B3 heartbeat 合成（E1：不让前台写）
 *   B4 T3 拦截：破坏性命令 → 拒绝 + 唤醒后台（tools.guard，比 pre-execute 更轻）
 *   B5 催单 T9：done=S<k> 且 steps/S<k+1> 不存在 → 唤醒后台
 *   B6 新步骤到达 → steer 前台并把指令全文内联（E1：不让前台读文件）
 *   B7 机械哨兵 H3/H4/H5/H7（30s 轮询，零 LLM）
 *   B8 轮末终局：前台清单耗尽 → 唤醒后台终局复核
 *   B9 审计 events.jsonl
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, renameSync, statSync, watch, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { makeRoutes, tailLines } from './api.js'
import { DEFAULT_MODE, MODE_KEYS, modeInfo, detectMode, allowListFor, modeNotice, briefFragment, adaptBatch, extractPaths, isDeniedTool } from './modes.js'
import { FRONT_BRIEF, BACK_BRIEF } from './briefs.js'
import { DEFAULTS } from './defaults.js'
import { msg } from './messages.js'
import { makeScheduler } from './scheduler.js'
import { makeBoard } from './board.js'
import { DESTRUCTIVE, CRITICAL_REASONS } from './policies.js'

export const name = 'dsh-fast-react'
export const inject = ['agents', 'sessions', 'tools', 'timer', 'agentDefaultModel']

/** 默认配置（可被 <board>/config.json 覆盖） */

/**
 * 破坏性命令模式（「破坏性 且 目标已存在」中的"破坏性"一半）。
 * 目标存在性无法机械判定时按"拦"处理，但只对真正改不回来的动作。
 */

/** 前台角色简报（接线时注入一次；DSH 预设里没有档位行，角色只能靠简报下发） */

/** 后台角色简报 */

/** 插件实例代际计数（模块级，ESM 模块被缓存 ⇒ 多次 apply 共享）。
 *  用途：DSH 注入器热重载时**不会 dispose 旧实例的监听器/定时器**，
 *  导致新旧两套逻辑叠加运行（实测：代码里已删掉的 H7 哨兵仍在触发、freeze 执行两次）。
 *  这里用代际守卫让旧实例的回调自动失效。 */
let ACTIVE_GEN = 0

/** 消防通道入口：在 apply() 内赋值。放模块级是为了让 fr_poke 的工具作用域也能访问
 *  （工具注册与 ctx.effect 生成器不在同一层作用域，直接引用会 "is not defined"）。 */
let FIRE = null

export function apply(ctx, userConfig = {}) {
  const MY_GEN = ++ACTIVE_GEN
  const alive = () => MY_GEN === ACTIVE_GEN
  // ── 配置：<board>/config.json 覆盖默认值 ────────────────────────────────
  const cfg = { ...DEFAULTS, ...(userConfig || {}) }
  const boardRoot = cfg.boardRoot

  /** 角色档位：前台低档求快、后台最高档求质量。
   *  ★ DSH 0.2.1 起不再把全局 reasoningEffort 自动带给新会话（实测前台变 high、后台未设），
   *    所以创建会话时必须显式传，否则"思考强度"会乱。 */
  /** 这些渠道/模型不接受 reasoningEffort 参数（传了会 400：does not support reasoning effort） */
const NO_EFFORT_RE = /^(hy\d|glm|kimi|minimax|step-|space-bunny|mimo|jin|dots-|nemotron|liquid\/|cohere\/|poolside\/|reflection\/|recursive\/|xingchen)/i
const effortFor = (tag) => {
  // ★ 注意：本函数定义在 routeFor 之前（TDZ），不能调 routeFor；直接读 cfg 判断模型
  const mo = String((tag === 'back' ? (cfg.backModel || cfg.model) : (cfg.frontModel || cfg.model)) || '')
  if (NO_EFFORT_RE.test(mo)) return undefined   // 该模型不支持 reasoningEffort ⇒ 不传
  return tag === 'back' ? (cfg.backEffort || 'max') : (cfg.frontEffort || 'low')
}
  /** ★ 前后台分开模型：角色级覆盖 > 全局 provider/model > 全局默认选择 */
  const routeFor = (tag) => {
    const base = resolveRoute() || {}
    if (tag === 'front' && (cfg.frontProvider || cfg.frontModel)) {
      return { provider: cfg.frontProvider || base.provider, model: cfg.frontModel || base.model }
    }
    if (tag === 'back' && (cfg.backProvider || cfg.backModel)) {
      return { provider: cfg.backProvider || base.provider, model: cfg.backModel || base.model }
    }
    return { provider: base.provider, model: base.model }
  }
  /** 每次调用实时读取的当前路由（供 agent/request 强制用，避免闭包快照过期） */
  const currentRouteFor = (tag) => {
    try {
      const base = resolveRoute() || {}
      if (tag === 'front') return { provider: cfg.frontProvider || cfg.provider || base.provider, model: cfg.frontModel || cfg.model || base.model }
      if (tag === 'back') return { provider: cfg.backProvider || cfg.provider || base.provider, model: cfg.backModel || cfg.model || base.model }
      return base
    } catch { return null }
  }
  const boardDir = join(boardRoot, '.board')
  const cfgFile = join(boardDir, 'config.json')
  // ★ 只把「用户显式写过的键」持久化（原实现把展开后的全量 cfg 写回 ⇒ 旧默认值被固化，
  //   以后改默认值会被旧 config 覆盖；实测踩过一次：effortDrift 复活并把全局 effort 压低）。
  let overrides = {}
  const droppedOnce = new Set()   // 本次保存要从盘上显式删除的键（解绑用；见 saveOverrides）
  try {
    if (existsSync(cfgFile)) {
      overrides = JSON.parse(readFileSync(cfgFile, 'utf8')) || {}
      Object.assign(cfg, overrides)
    }
  } catch { /* 配置坏了用默认 */ }
  // ★ 合并写回：先读文件再覆盖 overrides 的键，避免把别人（或手工）加进去的字段写丢。
  //   实测坑（2026-10-17）：纯写 overrides ⇒ provider/model 这类"后来才加的键"会被抹掉。
  const saveOverrides = () => {
    try {
      let disk = {}
      try { if (existsSync(cfgFile)) disk = JSON.parse(readFileSync(cfgFile, 'utf8')) || {} } catch { /* 文件坏了按空处理 */ }
      // ★ 修复（2026-10-24）：`delete overrides.x` 只是内存里删，随后这里用盘上旧值铺底又把它写回，
      //   导致「解绑」在下次保存时复活（旧 sessionId 重新生效）。显式记录的删除键必须先从盘上抹掉。
      for (const k of droppedOnce) delete disk[k]
      droppedOnce.clear()
      const merged = Object.assign({}, disk, overrides)
      writeFileSync(cfgFile, JSON.stringify(merged, null, 2), 'utf8')
      overrides = merged
      return true
    } catch { return false }
  }

  const logFile = join(cfg.boardRoot === DEFAULTS.boardRoot
    ? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'super-injector')
    : boardDir, 'fast-react.log')

  /** ★ 统一的接线写入口（2026-10-17 实测事故）：
   *  rebuildSessions / repairGroups / createGroup 建了新会话后，只写 overrides 而不写 cfg，
   *  而 resolveAgents() 读的是 cfg.* ⇒ 新会话永远解析不回来；随后 resolveAgents 还会把
   *  "发现到的旧会话"焊死回写，形成永久锁定（表现为：新建会话收到消息却永不 running，
   *  因为投递的 followup 落在一个没被接管的对象上）。
   *  所以任何改接线的地方都必须同时写 cfg + overrides + 落盘。 */
  const wire = (frontId, backId) => {
    if (frontId !== undefined) {
      if (frontId) { cfg.frontSessionId = frontId; overrides.frontSessionId = frontId }
      else { cfg.frontSessionId = ''; delete overrides.frontSessionId; droppedOnce.add('frontSessionId') }
    }
    if (backId !== undefined) {
      if (backId) { cfg.backSessionId = backId; overrides.backSessionId = backId }
      else { cfg.backSessionId = ''; delete overrides.backSessionId; droppedOnce.add('backSessionId') }
    }
    saveOverrides()
  }
  const unwire = () => {
    cfg.frontSessionId = ''; cfg.backSessionId = ''
    delete overrides.frontSessionId; delete overrides.backSessionId
    droppedOnce.add('frontSessionId'); droppedOnce.add('backSessionId')
    saveOverrides()
  }

  const log = (msg) => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`)
    } catch { /* 静默 */ }
  }

  // ── B1 黑板 IO ─────────────────────────────────────────────────────────
  const P = {
    state: join(boardDir, 'state.md'),
    heartbeat: join(boardDir, 'heartbeat.log'),
    events: join(boardDir, 'events.jsonl'),
    route: join(boardDir, 'route.md'),
    stepsDir: join(boardDir, 'steps'),
    confirmDir: join(boardDir, 'confirm'),
  }

    // ── 黑板 IO 单份实现（board.js）：本地函数改为代理，消除双实现 ──
  const BB = makeBoard(boardDir, log)

const ensure = () => {
    for (const d of [boardDir, P.stepsDir, P.confirmDir]) {
      try { mkdirSync(d, { recursive: true }) } catch { /* 已存在 */ }
    }
  }
  const readIf = (f) => BB.readIf(f) /* 代理 board.js */
  const writeAtomic = (f, text) => BB.writeAtomic(f, text) /* 代理 board.js */

  // ── 日志轮转（2026-10-24）─────────────────────────────────────────────────
  // 真问题：events.jsonl / heartbeat.log 只增不减。长任务连续跑几天能涨到几百 MB，
  // 而 /status 每秒轮询、fr_status/tick 也要读它们（已改成尾部读，但磁盘仍会无限长大）。
  // 策略：超过阈值就整份改名为 *.1.*（只保留 1 代），旧代仍可人工审计。
  const LOG_ROTATE_BYTES = Number(process.env.FAST_REACT_LOG_ROTATE_BYTES || 8 * 1024 * 1024)
  const HEARTBEAT_ROTATE_BYTES = Number(process.env.FAST_REACT_HEARTBEAT_ROTATE_BYTES || 4 * 1024 * 1024)
  /* rotateIfLarge 已迁至 board.js（由 ensureLogsBounded 代理）*/
  /** 读 state.md 的 `key: value` 受控字段（前台写的结构化进度） */
  const readState = () => BB.readState() /* 代理 board.js */
  const appendLine = (f, line) => BB.appendLine(f, line) /* 代理 board.js */
  const event = (kind, detail) => BB.event(kind, detail) /* 代理 board.js */
  const listSteps = () => BB.listSteps() /* 代理 board.js */
  const stepNo = (f) => BB.stepNo(f) /* 代理 board.js */

  // ── B2 接线：识别前台 / 后台 ───────────────────────────────────────────
  let front = null
  let back = null
  const presetOf = (a) => { try { return a?.session?.header?.agentPreset || '' } catch { return '' } }
  const idOf = (a) => { try { return String(a.id) } catch { return '' } }

  /** 给会话设置可读标题（否则 DSH 侧边栏显示"未命名"）。
   *  role: front/back，groupKey: 所属会话组（可选） */
  async function nameSession (agent, role, groupKey) {
    try {
      if (!agent || !agent.session) return false
      const st = (typeof ctx.get === 'function') ? ctx.get('sessionTitle') : undefined
      if (!st || typeof st.rename !== 'function') return false
      const rn = role === 'back' ? '后台' : '前台'
      const title = groupKey ? ('快速反应 ' + groupKey + ' · ' + rn) : ('快速反应 · ' + rn)
      st.rename(agent.session, title)
      event('session-named', { id: idOf(agent), title })
      return true
    } catch (e) { log('命名会话失败: ' + e.message); return false }
  }

  const cwdOf = (a) => { try { return a?.session?.header?.cwd || '' } catch { return '' } }
  const bornOf = (a) => { try { return String(a?.session?.header?.createdAt || '') } catch { return '' } }
  const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
  // 简报标记落盘：插件重载后不再重发（否则每次重载都往 inbox 塞一份，越积越多）
  const BRIEF_MARK = join(boardDir, 'briefed.json')
  const briefed = new Set((() => { try { return JSON.parse(readIf(BRIEF_MARK)) || [] } catch { return [] } })())

  function resolveAgents () {
    let list = []
    try { list = ctx.agents.list() } catch (e) { log('agents.list fail: ' + e.message); return }
    const byId = (id) => list.find(a => idOf(a) === id)
    const byPreset = (p) => (p ? list.find(a => presetOf(a) === p) : null)
    // ★★ 2026-10-18 严重 bug 修复：自动发现必须只认"插件自己创建的会话"
    //   事故：某次 rebuild 后 resolveAgents 跑在会话就绪之前 ⇒ 走自动发现分支，
    //   把黑板书目录下**任意两个会话**（UUID 的普通会话/子智能体）当成了前后台，
    //   还把错误接线"焊死"写进 config.json ⇒ 步骤全投给冒名会话，
    //   真正的前后台永远空闲（用户观测："后台没在跑" + "怎么建了那么多子智能体"）。
    const isFrSession = (a) => {
      try { return /^session-fr-/.test(String(idOf(a))) } catch { return false }
    }
    // ① 显式 sessionId（但必须仍是 fr 会话；否则视为脏数据丢弃）
    const wantedF = cfg.frontSessionId
    const wantedB = cfg.backSessionId
    front = (wantedF && byId(wantedF) && isFrSession(byId(wantedF))) ? byId(wantedF) : null
    back = (wantedB && byId(wantedB) && isFrSession(byId(wantedB))) ? byId(wantedB) : null
    if (wantedF && !front) {
      event('wire-dirty-drop', { role: 'front', id: wantedF })
      log('接线脏数据：cfg.frontSessionId 不是 fr 会话或不存在 ⇒ 丢弃并重新发现')
    }
    if (wantedB && !back) {
      event('wire-dirty-drop', { role: 'back', id: wantedB })
      log('接线脏数据：cfg.backSessionId 不是 fr 会话或不存在 ⇒ 丢弃并重新发现')
    }
    // ② preset 兜底（同样只认 fr 会话）
    if (!front) { const p = byPreset(cfg.frontPreset); if (p && isFrSession(p)) front = p }
    if (!back) { const p = byPreset(cfg.backPreset); if (p && isFrSession(p)) back = p }
    // ③ 自动发现：**只从 fr 会话里挑**，按创建时间排序取最早两个
    if (!front || !back) {
      const frList = list
        .filter(a => isFrSession(a))
        .filter(a => norm(cwdOf(a)) === norm(boardRoot))
        .sort((a, b) => bornOf(a).localeCompare(bornOf(b)))
      if (!front) front = frList.find(a => a !== back) || null
      if (!back) back = frList.find(a => a !== front) || null
    }
    if (front && back && idOf(front) === idOf(back)) back = null
    // ④ 最终守卫：任何一个不是 fr 会话 ⇒ 一律置空，交给 ensureWiring 重建
    if (front && !isFrSession(front)) { event('wire-reject', { role: 'front', id: idOf(front) }); front = null }
    if (back && !isFrSession(back)) { event('wire-reject', { role: 'back', id: idOf(back) }); back = null }
    // B14 路由跟随（省钱）：先把两会话的 model 路由同步到全局默认，再考虑简报
    if (front) syncRoute(front, 'front')
    if (back) syncRoute(back, 'back')
    // ★ 接线焊死：把自动发现的结果写回 config.json，避免同目录出现第三个会话时接线被抢
    //   ⚠️ 只焊死"两者都是 fr 会话"的合法接线（2026-10-18 加固）
    if (front && back && isFrSession(front) && isFrSession(back)) {
      const f = idOf(front); const b = idOf(back)
      if (cfg.frontSessionId !== f || cfg.backSessionId !== b) {
        wire(f, b)
        event('wire-latched', { front: f, back: b })
        log(`接线已焊死: front=${f.slice(0, 14)} back=${b.slice(0, 14)}`)
      }
    } else if ((cfg.frontSessionId || cfg.backSessionId) && (!front || !back)) {
      // 接线不完整/不合法 ⇒ 清掉脏记录，让 ensureWiring 干净重建
      if (cfg.frontSessionId && !front) wire('', cfg.backSessionId || '')
      if (cfg.backSessionId && !back) wire(cfg.frontSessionId || '', '')
      event('wire-cleared', { reason: 'invalid-or-missing' })
    }
    // 接线（或切换）时补发角色简报：每个 (角色, agent) 只发一次；标记落盘，重载不重发
    for (const pair of [[front, 'front'], [back, 'back']]) {
      const a = pair[0]; const role = pair[1]
      if (!a) continue
      const key = role + ':' + idOf(a)
      if (briefed.has(key)) continue
      briefed.add(key)
      brief(a, role)
      try { writeAtomic(BRIEF_MARK, JSON.stringify([...briefed], null, 1)) } catch { /* 静默 */ }
    }
  }

  /** B14 路由跟随（省钱）：把会话的 provider/model 同步到全局默认。
   *  实测（2026-10-17）：Agent.options 在会话创建时钉死，用户切到免费模型后旧会话仍在烧付费 API；
   *  且 options **可写** ⇒ 这里每次解析接线时同步一次。 */
  function syncRoute (agent, role) {
    if (!cfg.followGlobalRoute || !agent) return
    try {
      const dm = ctx.agentDefaultModel
      if (!dm) return
      const sel = dm.currentSelection()
      if (!sel || !sel.provider || !sel.model) return
      const o = agent.options
      if (o && o.provider === sel.provider && o.model === sel.model) return
      const from = o ? (o.provider + '/' + o.model) : '(none)'
      if (o) { o.provider = sel.provider; o.model = sel.model } else { agent.options = { provider: sel.provider, model: sel.model } }
      event('route-sync', { role, from, to: sel.provider + '/' + sel.model })
      log('路由同步 ' + role + ': ' + from + ' -> ' + sel.provider + '/' + sel.model)
    } catch (e) { log('syncRoute fail: ' + e.message) }
  }

  function brief (agent, role) {
    // ★ Phase 1：简报里带上当前模式片段（模式在中途变化时由 applyMode 的 inject 补发）
    const text = (role === 'front' ? FRONT_BRIEF : BACK_BRIEF).replace('{{BOARD}}', boardDir)
      + (typeof briefFragment === 'function' ? briefFragment(currentMode(), role) : '')
    try {
      // ★ 用 inject（**不唤醒**）：简报只进 inbox，等该 agent 下一次真正运行时自然读到。
      //   若用 followup/steer，每次插件重载都会把两个 agent 叫醒空跑一轮 —— 实测烧了 9+ 步。
      agent.inject(msg(text, `快速反应角色简报：${role}`))
      event('brief', { role, id: idOf(agent), mode: 'inject' })
      log(`角色简报已注入（不唤醒）→ ${role} ${idOf(agent).slice(0, 14)}`)
    } catch (e) { log('brief fail ' + role + ': ' + e.message) }
  }

  const isFront = (agent) => !!front && !!agent && idOf(agent) === idOf(front)
  const isBack = (agent) => !!back && !!agent && idOf(agent) === idOf(back)

  // ── 通道：唤醒后台（不打断） / steer 前台 ───────────────────────────────
  let lastWakeAt = 0
  const wakeCount = { total: 0, byReason: {} }

  /** 关键唤醒：终局 / 上交 / T3 —— **不受冷却限制**（#5 修复：实测冷却把"终局"吞了） */
  let lastPrefetchAt = 0   // 流水线预规划冷却（避免每 tick 唤醒后台）
  function wakeBack (reason, text) {
    const now = Date.now()
    if (!back) { log(`wake(${reason}) 跳过：后台未接线`); return false }
    // ★ 模式守卫（Phase 1）：速答/检索模式不需要后台 ⇒ 任何自动唤醒都跳过（手动除外）
    try {
      const mi = modeNow()
      if (!mi.backend && reason !== 'manual') {
        log(`wake(${reason}) 跳过：模式 ${mi.key} 不需要后台`)
        event('wake-skip-mode', { reason, mode: mi.key })
        return false
      }
    } catch { /* 模式层异常不影响唤醒 */ }
    // ★ 用户停止/暂停后 15s 内不唤醒（2026-10-18 修复：否则用户点了暂停，
    //   插件又把后台拉起来继续跑，表现为"暂停按不住"）
    if (now - userStopAt < 15000) { log(`wake(${reason}) 跳过：用户刚停止`); return false }
    void setEffort('back')   // B10 档位漂移：先把全局档位切到后台该有的值
    if (!CRITICAL_REASONS.has(reason) && now - lastWakeAt < cfg.wakeCooldownMs) { log(`wake(${reason}) 跳过：冷却中`); return false }
    if (back.phase && back.phase.kind === 'running') {
      // 正在深想：用 steer 排队到它下一步，不打断（内容在黑板，信号可晚到）
      try {
        back.steer(msg(text))
        lastWakeAt = now; wakeCount.total++; wakeCount.byReason[reason] = (wakeCount.byReason[reason] || 0) + 1
        event('wake', { reason, mode: 'steer' }); log(`wake(${reason}) → steer（后台在跑）`); return true
      } catch (e) {
        // ★ 实测（2026-10-17）：后台刚被唤醒、处于中间态时 steer 会抛 "unreachable variant: {}"。
        //   此时必须**回退到 followup**，否则这次唤醒彻底丢失（哨兵/终局信号会丢）。
        log('wake steer fail: ' + e.message + ' → 回退 followup')
        try {
          back.followup(msg(text))
          lastWakeAt = now; wakeCount.total++; wakeCount.byReason[reason] = (wakeCount.byReason[reason] || 0) + 1
          event('wake', { reason, mode: 'followup-fallback' }); return true
        } catch (e2) { log('wake followup-fallback fail: ' + e2.message); return false }
      }
    }
    try {
      back.followup(msg(text))          // 空闲 → 唤醒起一轮
      lastWakeAt = now; wakeCount.total++; wakeCount.byReason[reason] = (wakeCount.byReason[reason] || 0) + 1
      event('wake', { reason, mode: 'followup' }); log(`wake(${reason}) → followup（后台空闲）`); return true
    } catch (e) { log('wake followup fail: ' + e.message); return false }
  }

  function steerFront (text, reason, opts) {
    if (!front) return false
    // ★ 用户刚停止/暂停 ⇒ 不再向台前投递（2026-10-18：这是"暂停按不住"的主因之一）
    // ★ 例外（2026-10-24）：消防通道的说明必须发得出去 —— 它发生在 cancel 之后、且本身就是
    //   用户/后台的显式打断。用 opts.force 绕过本通道自己刚写的 userStopAt，
    //   但**真·用户暂停**（pauseAt）仍然优先：暂停后 15s 内任何 force 也不放行。
    const forced = !!(opts && opts.force)
    if (Date.now() - pauseAt < 15000) { log(`steer 前台(${reason}) 跳过：用户刚暂停`); return false }
    if (!forced && Date.now() - userStopAt < 15000) { log(`steer 前台(${reason}) 跳过：用户刚停止`); return false }
    void setEffort('front')   // B10 档位漂移：先把全局档位切到前台该有的值
    const running = !!(front.phase && front.phase.kind === 'running')
    try {
      // ★ 关键修复（2026-10-17）：空闲时 steer() 只把消息排进队列、**不会起一轮**，
      //   消息会一直悬空 —— 用户从面板发的消息于是"消失"（实测：api-task 记录成功，
      //   但前台会话事件里根本没有这条 user 消息）。空闲必须 followup() 起一轮。
      if (running) front.steer(msg(text))
      else front.followup(msg(text))
      event('steer-front', { reason, mode: running ? 'steer' : 'followup' })
      log(`steer 前台(${reason}, ${running ? 'steer' : 'followup'})`)
      return true
    } catch (e) {
      log('steerFront fail: ' + e.message + ' → 回退 followup')
      try {
        front.followup(msg(text))
        event('steer-front', { reason, mode: 'followup-fallback' })
        return true
      } catch (e2) { log('steerFront followup fallback fail: ' + e2.message); return false }
    }
  }

  /**
   * 构造一条**格式完整**的 user 消息。
   * #1 修复（2026-10-17 实测）：只给 {role,content} 会让 loop 读 `source.kind` 时抛
   * `Cannot read properties of undefined (reading 'kind')`，把被唤醒的那一轮直接打挂。
   * 权威形状取自官方 dsh-repeat-tool-reminder：{role:'user', id, source:{kind,form,summary}, content}。
   * source.kind 用插件自己的名字，**绝不写 'user'**（'user' 是真人消息的标记）。
   */

  // ── 任务模式（Phase 1）：预设表在 lib/modes.js，这里只负责「生效 / 通知 / 工具白名单」──
  const modeFile = join(boardDir, 'mode.md')
  let activeMode = ''            // 已生效的预设 key
  let modeBy = ''                // auto / agent / user / startup
  const modeDisposers = { front: null, back: null }

  function readModeFile () {
    try {
      const m = /^\s*mode\s*:\s*([a-z]+)\s*$/mi.exec(readIf(modeFile))
      return m ? m[1] : ''
    } catch { return '' }
  }
  const currentMode = () => (activeMode || readModeFile() || DEFAULT_MODE)


  /** 工具白名单（三层里的第一层）：restrict 砍全局工具；scoped 工具由 guard 兜。
   *  ★ 修复（2026-10-24）：求交集的"已知工具"必须用**该 agent 自己的可见集**
   *  `tools.schemas(agent)`（含 preset 带入的工具），不能用 `ctx.tools.schemas()`——
   *  后者只返回插件注册的全局工具（fr_*），会把 read/write/pwsh 判成"未知"从而砍掉，
   *  前台直接失去执行能力（实测：allow 只剩 fr_status/fr_escalate）。 */
  function applyToolPolicy (modeKey) {
    const out = {}
    for (const [role, ag] of [['front', front], ['back', back]]) {
      const prev = modeDisposers[role]
      if (typeof prev === 'function') { try { prev() } catch { /* 忽略 */ } modeDisposers[role] = null }
      if (!ag) { out[role] = { skipped: 'no-agent' }; continue }
      const want = allowListFor(modeKey, role)
      try {
        const sctx = ag.ctx
        const tools = sctx && typeof sctx.get === 'function' ? sctx.get('tools') : undefined
        if (!tools || typeof tools.restrict !== 'function') { out[role] = { error: 'tools 不可用' }; continue }
        const names = () => { try { return (tools.schemas(ag) || []).map(t => t && t.name).filter(Boolean) } catch { return [] } }
        const before = names()
        if (want.length === 0) { out[role] = { skipped: 'empty-allow', before: before.length }; continue }
        const visible = new Set(before)
        const allow = want.filter(n => visible.has(n))
        const unknown = want.filter(n => !visible.has(n))
        if (allow.length === 0) { out[role] = { skipped: 'none-visible', unknown, before: before.length }; continue }
        const dispose = tools.restrict({ allow })
        if (typeof dispose === 'function') modeDisposers[role] = dispose
        const after = names().length
        out[role] = { before: before.length, after, allow, ...(unknown.length ? { unknown } : {}) }
        event('tool-policy', { role, mode: modeKey, before: before.length, after })
      } catch (e) { out[role] = { error: String(e && e.message || e).slice(0, 140) } }
    }
    return out
  }

  /** 生效一个模式：写 mode.md + 事件 + 工具白名单 + 给两会话注入说明（inject 不唤醒） */
  function applyMode (key, by, reason) {
    const p = modeInfo(key)
    if (cfg.modeLocked && by !== 'user' && by !== 'startup') {
      log(`模式已锁定（${activeMode || '?'}），忽略 ${by} 的切换请求`)
      return { ok: false, error: 'mode-locked', mode: currentMode() }
    }
    // ★ §22 优化③：同模式重复生效去重（auto 判型后又 user 锁定同模式 ⇒ 只更新 by/reason，不重刷 tool-policy/inject）
    if (activeMode === p.key && by !== 'startup') {
      modeBy = by || modeBy
      try {
        writeAtomic(modeFile, [
          `mode: ${p.key}`,
          `label: ${p.label}`,
          `by: ${modeBy}`,
          `reason: ${String(reason || '').replace(/\s+/g, ' ').slice(0, 200)}`,
          `at: ${new Date().toISOString()}`,
          '',
        ].join('\n'))
      } catch { /* 忽略 */ }
      return { ok: true, dedup: true, mode: p.key }
    }
    activeMode = p.key
    modeBy = by || 'auto'
    writeAtomic(modeFile, [
      `mode: ${p.key}`,
      `label: ${p.label}`,
      `by: ${modeBy}`,
      `reason: ${String(reason || '').replace(/\s+/g, ' ').slice(0, 200)}`,
      `at: ${new Date().toISOString()}`,
      '',
    ].join('\n'))
    event('mode-set', { mode: p.key, by: modeBy, reason: String(reason || '').slice(0, 120) })
    log(`模式 → ${p.label}（${p.key}，by ${modeBy}）`)
    // 模式变了 ⇒ 步长基线变了，自适应重新开始（避免沿用上个模式的批量）
    try { adaptiveBatch = 0; recentGaps = []; lastDeliverAt = 0 } catch { /* 初始化早期忽略 */ }
    const policy = applyToolPolicy(p.key)
    for (const [, ag] of [['front', front], ['back', back]]) {
      if (!ag) continue
      try { ag.inject(msg(modeNotice(p.key), `模式：${p.label}`)) } catch { /* 忽略 */ }
    }
    return { ok: true, mode: p.key, label: p.label, by: modeBy, policy }
  }

  // ── Phase 2 调度器：步长 / 依赖 / 停牌 / 分析交付 / 归档 ─────────────────────
  const modeNow = () => modeInfo(currentMode())
  const judgeFile = join(boardDir, 'judge.ok')
  const workers = new Map()          // 只读 worker 池（id → { ag, at, out, done, task }）
  let judgeWaiting = false          // 停牌中：等后台写 judge.ok（或 fr_poke resolve）
  let lastAnalysisMtime = 0         // 咨询模式：analysis.md 的已投递 mtime
  let lastReviewAt = 0              // 里程碑复核节流
  let reviewCount = 0               // 每任务复核次数
  let lastReviewStepNo = 0          // 上次复核时的 done 步号
  // Phase 2 收尾：步长自适应的观测窗口
  let recentGaps = []               // 最近几步的投递间隔（近似每步耗时，ms）
  let adaptiveBatch = 0             // 自适应得到的批量（0 = 未启用/未定）
  let lastDeliverAt = 0             // 上次投递时间
  let lastT3Seen = 0                // 上次观测到的 T3 拦截数

  /** #1 速度自适应预取水位：前台跑得快 ⇒ 加深缓冲；跑得慢 ⇒ 收缩（2..4，避震荡） */


  /** 一次投递几条：模式基线 → 自适应覆盖（可关）；夹在 1..8 */


  /** 观测一次投递，更新步长自适应（保守 + 滞回，避免震荡） */


  /** 解析步骤里的调度元数据：depends: S1,S2 / needs: judge / 并行组: g1 */


  /** 咨询/速答模式：.board/analysis.md 一出现就投给前台（由前台转述给用户） */


  /** 里程碑复核：前后台都空闲、距上次 ≥10 分钟、本任务 ≤3 次、且新完成 ≥reviewEvery 步 */


  /** 任务已交付 ⇒ 把步骤文件归档（state/route 复制一份），黑板保持小而可查 */


  /** 只读 worker 清理：完成（.done 出现）或超 10 分钟 ⇒ 取消会话并释放工具限制 */


  /** 新任务起点：重置本任务的调度/复核/分析状态 */


  // ── B3 heartbeat 合成（E1）＋ 失败计数（H4） ────────────────────────────
  const toolStats = { total: 0, failStreak: 0, failTotal: 0, sameName: {}, lastSame: '', sameCount: 0, lastFailName: '' }
  let stepsThisTask = 0
  // H3 基线：插件启动时设为当下；之后每合成一条 heartbeat 就刷新。
  // 用它而不是文件里最后一行 —— 否则会把"上一轮任务遗留的旧心跳"误判成"当前停滞"（实测误报 11730s）。
  let lastBeatAt = Date.now()

  const synthHeartbeat = (toolName, ok) => {
    const line = `${new Date().toISOString()} | tool=${toolName} | ${ok ? 'ok' : 'FAIL'} | task_steps=${stepsThisTask}`
    appendLine(P.heartbeat, line)
    lastBeatAt = Date.now()   // ★ H3 基线：只用本次会话/本轮产生的心跳
    lastToolAt = Date.now()   // ★ 看门狗：有工具执行就算"还活着"
  }

  // ── 僵死看门狗（2026-10-17 实测事故：running 但 4 分钟零产出，用户干等）──
  let lastToolAt = 0
  let turnStartAt = 0
  let prevFrontPhase = ''

  /** 取该会话最后一条**真人**消息（跳过【系统】/<注入> 话术） */
  function lastUserText (agent) {
    try {
      const evs = (agent.session && agent.session.snapshotEvents && agent.session.snapshotEvents()) || []
      for (let i = evs.length - 1; i >= 0; i--) {
        const e = evs[i], ev = e.event || e
        if (!ev || ev.type !== 'user/message') continue
        const d = ev.data || {}
        const parts = d.content || (d.message && d.message.content) || []
        let t = ''
        if (Array.isArray(parts)) for (const p of parts) { if (p && p.type === 'text' && p.text) t += p.text }
        t = String(t || '').trim()
        if (!t) continue
        if (t.charAt(0) === '【' || t.charAt(0) === '<') continue
        return t
      }
    } catch { /* 忽略 */ }
    return ''
  }

  /** 取该会话最后一条 assistant 回复的正文（用于判断"终局有没有真的交付"） */
  function lastAssistantText (agent) {
    try {
      const evs = (agent.session && agent.session.snapshotEvents && agent.session.snapshotEvents()) || []
      for (let i = evs.length - 1; i >= 0; i--) {
        const e = evs[i], ev = e.event || e
        if (!ev || ev.type !== 'assistant/message') continue
        const d = ev.data || {}
        const parts = d.content || []
        let t = ''
        if (Array.isArray(parts)) for (const x of parts) { if (x && x.type === 'text' && x.text) t += x.text }
        if (!t && typeof d.text === 'string') t = d.text
        return String(t || '').trim()
      }
    } catch { /* 忽略 */ }
    return ''
  }

  function checkStall () {
    if (!cfg.stallWatchdog || !front) return
    try {
      const phase = (front.phase && front.phase.kind) || ''
      if (phase !== 'running') { prevFrontPhase = phase; return }
      if (prevFrontPhase !== 'running') {          // 新一轮开始：重置基线
        prevFrontPhase = 'running'
        turnStartAt = Date.now()
        lastToolAt = 0
        return
      }
      const idleMs = Date.now() - Math.max(turnStartAt, lastToolAt)
      if (idleMs < cfg.stallTimeoutMs) return
      const hadTool = lastToolAt > 0
      event('stall-kill', { role: 'front', idleMs, hadTool })
      log(`看门狗：前台僵死 ${Math.round(idleMs / 1000)}s（hadTool=${hadTool}）→ cancel`)
      try { front.cancel(new Error('stall watchdog')) } catch (e) { log('看门狗 cancel 失败: ' + e.message) }
      prevFrontPhase = ''
      if (cfg.stallSafeRetry && !hadTool) {
        const txt = lastUserText(front)
        if (txt) {
          setTimeout(() => {
            try { steerFront(txt, 'stall-retry'); event('stall-retry', { chars: txt.length }); log('看门狗：本轮未动手，已安全重投') } catch (e) { log('看门狗重投失败: ' + e.message) }
          }, 1500)
        }
      }
    } catch (e) { log('checkStall fail: ' + e.message) }
  }
  try {
    const stallTimer = setInterval(checkStall, 15000)
    if (typeof ctx.effect === 'function') ctx.effect(() => () => { try { clearInterval(stallTimer) } catch { /* 忽略 */ } })
  } catch { /* 忽略 */ }

  // ── B4 T3 拦截：破坏性命令 → 拒绝 + 唤醒后台 ────────────────────────────
  let t3Blocked = 0

  function isDestructive (name, args) {
    if (!/^(pwsh|bash)$/i.test(String(name))) return null
    const cmd = String((args && (args.command || args.cmd)) || '')
    for (const re of DESTRUCTIVE) if (re.test(cmd)) return cmd.slice(0, 300)
    return null
  }

  function hasConfirm (stepId) { return BB.hasConfirm(stepId) } /* 单份实现：board.js */
  // ── B7 机械哨兵（零 LLM） ───────────────────────────────────────────────
  const sentinelState = { lastHeartbeatLen: -1, lastHeartbeatAt: Date.now(), lastSteps: 0, alerts: {} }
  /** 已唤醒过的哨兵 id（同一条只唤醒一次，防 30s 重复点火） */
  const alertedSentinels = new Set()
  // ★ §22 优化①：编号步骤任务的任务级批量覆盖（≥3 个编号 ⇒ 一次投全批）
  let taskBatchOverride = 0


  // ── 哨兵命中 ⇒ 冻结前台 + 作废未执行步骤 ───────────────────────────────
  // 背景（2026-10-17 发现的缺口）：预取 N 步时，哨兵命中只会打断后台重估，
  // 但**前台会继续把剩下的过时步骤跑完** ⇒ 预取越深、跑错越远，而 DSH 没有回滚。
  // 做法：把 k > done 的 steps 移进 .board/stale/（不删，留审计），前台在跑时通知它停手。
  // 恢复：后台写出新步骤后，checkNewSteps 会自动让前台继续。
  function freezeFront (why) {
    let moved = 0
    try {
      const st = readState()
      const doneNo = stepNo(st.done || '')
      const staleDir = join(boardDir, 'stale')
      try { mkdirSync(staleDir, { recursive: true }) } catch { /* 已存在 */ }
      let names = []
      try { names = readdirSync(P.stepsDir).filter(f => /^S\d+\.md$/.test(f)) } catch { names = [] }
      for (const f of names) {
        if (stepNo(f) <= doneNo) continue
        try {
          renameSync(join(P.stepsDir, f), join(staleDir, f))
          seenSteps.delete(f)
          moved++
        } catch { /* 单个失败忽略 */ }
      }
      const running = !!(front && front.phase && front.phase.kind === 'running')
      if (running) {
        steerFront(`【冻结】哨兵命中：${String(why).slice(0, 140)}\n立刻停手，**不要再执行任何步骤**；后台给出新路线后会自动恢复。`, 'freeze')
      }
      try {
        const t = readIf(P.state)
        if (t && !/routeOk\s*:\s*no/i.test(t)) writeAtomic(P.state, t.replace(/\s*$/, '') + '\nrouteOk: no\n')
      } catch { /* 忽略 */ }
      event('freeze', { why: String(why).slice(0, 160), staleMoved: moved, frontRunning: running })
      log(`哨兵冻结：作废 ${moved} 个未执行步骤${running ? '，已通知前台停手' : ''}`)
    } catch (e) { log('freezeFront fail: ' + e.message) }
    return moved
  }

  function runSentinels () {
    if (cfg.sentinelEnabled === false) return []   // 总开关
    const alerts = []
    const frontRunning = front && front.phase && front.phase.kind === 'running'
    // ★ 无任务时不跑哨兵（2026-10-18 实测事故：用户只发了一句「你好」，
    //   但上一轮任务残留的 failStreak / 心跳基线 / 产物文件让 H3/H4/C1 连续命中，
    //   直接冻结前台并作废步骤 —— 纯对话根本不该触发编排水位哨兵）。
    const st0 = readState()
    const steps0 = listSteps()
    const hasActiveTask = steps0.length > 0 && stepNo(st0.done || '') < (steps0.length ? Math.max(...steps0.map(stepNo)) : 0)
    const busy = frontRunning || (back && back.phase && back.phase.kind === 'running')
    if (!hasActiveTask && !busy) {
      // 空闲对话场景：只清空历史告警标记，不产生任何 alert
      alertedSentinels.clear()
      return []
    }
    // H3 心跳停滞：前台在跑但 5 分钟没有新 heartbeat（基线是内存 lastBeatAt，不看文件旧行）
    const staleMs = Date.now() - lastBeatAt
    if (frontRunning && staleMs > (cfg.heartbeatStaleMs || 300000)) {
      alerts.push({ id: 'H3', why: `心跳停滞 ${Math.round(staleMs / 1000)}s` })
    }
    // H4 失败堆积：只在前台**真的在跑**时判定；
    //   任务结束后残留的 failStreak 不算（实测残留 5 次导致一句「你好」就被冻结）
    if (frontRunning && toolStats.failStreak >= cfg.failStreakMax) {
      alerts.push({ id: 'H4', why: `连续失败 ${toolStats.failStreak} 次` })
    }
    // H5 膨胀：步数超阈（★ 2026-10-18 实测事故：70 步的调研任务被 H5 判定"膨胀"并冻结，
    //   直接作废 6 步。步数多 ≠ 任务失控 —— 只应该在**同时伴随大量失败**时才算异常）
    if (stepsThisTask > cfg.taskStepMax && toolStats.failStreak >= 2) {
      alerts.push({ id: 'H5', why: `本任务步数 ${stepsThisTask} 超阈 ${cfg.taskStepMax}（且连续失败 ${toolStats.failStreak} 次）` })
    }
    // H7 已删除（2026-10-17 实测）：原逻辑拿 state.planVersion（路线版本号，如 1、2）
    // 和"步骤数量"（如 6、12）比大小 ⇒ 两者无可比性，任务一长必然误报，
    // 误报会触发 freezeFront 把**全部未执行步骤移到 stale**（实测一次误删 6 步）。
    // 真正的"路线版本撕裂"应由后台在 route.md 里自己维护，不靠机械哨兵猜。
    // ★ 去重：同一条哨兵只唤醒后台一次（实测 H5 会在步数超阈后**每 30s 唤醒一次**，白烧 token）
    const fresh = alerts.filter(a => !alertedSentinels.has(a.id))
    for (const a of fresh) {
      alertedSentinels.add(a.id)
      event('sentinel', a)
      log(`哨兵命中 ${a.id}: ${a.why}`)
    }
    if (fresh.length) {
      wakeBack('sentinel', `【哨兵】${fresh.map(a => a.id + ' ' + a.why).join('；')}。请读 .board/ 最新状态后决定是否调整计划。`)
      freezeFront(fresh.map(a => a.id + ' ' + a.why).join('；'))
    }
    return fresh
  }

  // ── B5 催单 T9（lookahead） ─────────────────────────────────────────────
  /** 已交付？交付后停止一切催单（否则"清单跑完"会被误判成"缺料"，变成 30s 一次的死循环） */
  const hasDeliver = () => BB.hasDeliver() /* 代理 board.js */
  let finalAnswerAsked = false   // 终局正文交付守卫（只催一次）
  let milestoneGapCount = 0     // 规划闭环催单计数（同一缺口最多催 3 次，防无限唤醒）
  let deliverRetry = 0
  let userStopAt = 0              // 用户按暂停/停止的时刻（15s 内禁止一切内联追加）
  let pauseAt = 0                 // 真·用户暂停时刻（stopAll）；优先级高于 userStopAt，force 也绕不过它
  let pendingDeliver = false        // 投递被前台忙挡住、重试预算耗尽 ⇒ 转 tick 兜底
  let pendingDeliverLogged = false          // 投递被"前台忙"挡住时的延迟重试计数（防竞态卡死）
  let stepsThisTaskBase = 0     // 任务起始时的总步数基线（用于判断 H5 是否本任务造成）
  // ── P1 慢模型兜底：首帧超时 ────────────────────────────────────────────
  // 免费/慢模型下，后台出第一个 step 可能要几分钟，前台会干等。
  // 用事件日志判断（不引入新状态）：最后一次 escalate 之后没有任何 step-delivered，且已超时
  // ⇒ 让前台先做**只读侦察**（不猜任务、不写交付物），侦察结果写进 state.md 当后台的输入。
  let firstFrameNudgedAt = 0
  function checkFirstFrame () {
    // ★ 尾部定向读（2026-10-24）：原来整读 events.jsonl，长任务下每次 tick 都是一次同步全量解析
    const ev = tailLines(P.events, 300)
    let escAt = 0
    let delivAt = 0
    for (const l of ev) {
      try {
        const o = JSON.parse(l)
        const t = Date.parse(o.at) || 0
        if (o.kind === 'escalate') escAt = Math.max(escAt, t)
        if (o.kind === 'step-delivered') delivAt = Math.max(delivAt, t)
      } catch { /* 坏行跳过 */ }
    }
    if (!escAt || delivAt >= escAt) return
    const waitMs = Date.now() - escAt
    if (waitMs < (cfg.firstFrameTimeoutMs || 180000)) return
    if (firstFrameNudgedAt === escAt) return        // 同一次上交只提醒一次
    firstFrameNudgedAt = escAt
    steerFront('【等待超时】后台还没给出步骤（可能模型较慢）。你**先做只读侦察**（读文件/看目录/确认环境），不要猜任务、不要写交付物；把侦察结果写进 state.md 的「已知事实」，然后停下等步骤。', 'first-frame-timeout')
    event('first-frame-timeout', { waitedMs: waitMs })
    log('首帧超时（' + Math.round(waitMs / 1000) + 's），已让前台先做只读侦察')
  }

  // ── 接线自愈：重启后自动建的会话（内存态）会消失 ⇒ 插件自动重建 ──────────────
  let svcAgentLoop = null
  let svcPresets = null
  let autoHealAt = 0
  let autoHealDone = false
  try {
    ctx.inject(['agentLoop', 'agentPresets'], (c2) => {
      svcAgentLoop = c2.agentLoop
      svcPresets = c2.agentPresets
      log('接线自愈：agentLoop/agentPresets 服务已就绪')
    })
  } catch (e) { log('接线自愈服务注入失败: ' + e.message) }

  /** 决定前后台用哪个模型：cfg.provider/model 优先 → 全局默认模型兜底。
   *  ★ 2026-10-17 实测坑：直接读全局默认会拿到"当前选中的模型"（可能是不适合编排的免费模型），
   *  所以显式配置优先。 */
  function resolveRoute (explicit) {
    if (explicit && explicit.provider && explicit.model) return { provider: explicit.provider, model: explicit.model }
    if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
    try {
      const sel = ctx.agentDefaultModel.currentSelection()
      if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
    } catch { /* 忽略 */ }
    return null
  }

  async function ensureWiring () {
    if (!cfg.autoHeal || autoHealDone) return
    if (!svcAgentLoop || !svcPresets) return
    if (front && back) { autoHealDone = true; return }
    if (Date.now() - autoHealAt < 20000) return     // 20s 内不重复尝试
    autoHealAt = Date.now()
    try {
      const route = resolveRoute()
      if (!route) return
      const mk = async (tag) => {
        const ag = await svcAgentLoop.create('session-fr-' + tag + '-' + Date.now().toString(36),
          { provider: routeFor(tag).provider, model: routeFor(tag).model, reasoningEffort: effortFor(tag) }, { cwd: boardRoot })
        try { await svcPresets.mount(ag.ctx, cfg.agentPreset || 'standard') } catch (e) { log('自愈挂预设失败: ' + e.message) }
        return ag
      }
      if (!front) { const ag = await mk('front'); front = ag; wire(idOf(ag), undefined); await nameSession(ag, 'front') }
      if (!back) { const ag = await mk('back'); back = ag; wire(undefined, idOf(ag)); await nameSession(ag, 'back') }
      saveOverrides()
      briefed.clear()
      event('autoheal', { front: idOf(front), back: idOf(back) })
      log(`接线自愈：已重建会话 front=${idOf(front).slice(0, 16)} back=${idOf(back).slice(0, 16)}`)
      // 新会话没有继承工具白名单 ⇒ 自愈后重挂一次
      try { applyMode(currentMode(), 'auto', 'autoheal') } catch (e) { log('自愈后重挂模式失败: ' + e.message) }
      autoHealDone = true
    } catch (e) { log('接线自愈失败: ' + e.message) }
  }

  // ── 会话 → Workspace 挂载（2026-10-17）：插件创建的会话是内存会话，DSH 侧边栏
  //   看不到 ⇒ 用户无法打开原生会话页。attach + pin 到黑板所在目录的 Workspace 后，
  //   它会作为普通会话出现在侧边栏，点开即原生页面（可看原始对话/工具调用）。
  const linkedSessions = new Set()
  async function wsRegistry () {
    try { return (ctx && typeof ctx.get === 'function') ? ctx.get('workspaceRegistry') : undefined } catch { return undefined }
  }
  async function ensureWorkspace () {
    const wr = await wsRegistry()
    if (!wr) return null
    let ws = null
    try { ws = await wr.resolveByPath(boardRoot) } catch { /* 目录不存等 */ }
    if (!ws) ws = await wr.create(boardRoot, '快速反应')
    return ws
  }
  /** 把任意会话挂进工作区；pin=true 时置顶 */
  async function linkSession (sid, pin) {
    if (!cfg.linkWorkspaceSession || !sid) return false
    try {
      const wr = await wsRegistry()
      if (!wr) return false
      const ws = await ensureWorkspace()
      if (!ws) return false
      const ids = (ws.sessionIds || []).map(String)
      if (!ids.includes(String(sid))) await ws.attachSession(sid)
      if (pin && typeof wr.pinSession === 'function') { try { await wr.pinSession(sid) } catch { /* 忽略 */ } }
      linkedSessions.add(String(sid))
      return true
    } catch (e) { log('linkSession fail: ' + (e && e.message)); return false }
  }
  async function detachSession (sid) {
    try {
      const ws = await ensureWorkspace()
      if (ws && typeof ws.detachSession === 'function') await ws.detachSession(sid)
    } catch (e) { log('detachSession fail: ' + (e && e.message)) }
  }
  async function linkFrontWorkspace () {
    if (!cfg.linkWorkspaceSession || !front) return
    const sid = idOf(front)
    if (!sid || linkedSessions.has(sid)) return
    const ok = await linkSession(sid, true)
    if (ok) {
      event('workspace-link', { session: sid })
      log('前台会话已挂到工作区（侧边栏可见）')
    }
  }
  try {
    const linkTimer = setInterval(() => {
      linkFrontWorkspace().catch(() => {})
      // 默认权限兜底：只有在「当前接线不属于任何有 preset 的会话组」时，才把前后台
      // 校正到全局 permissionPreset。
      // ★ 修复（2026-10-24）：此前无条件按 cfg.permissionPreset 校正，于是组权限
      //   （g.preset，用户在面板「组权限」下拉里设的）最多 20s 就被全局默认覆盖掉 ——
      //   表现为「设了 read-only，过一会儿又变回 danger-full-access」。
      try {
        const g = loadGroups().find(x => String(x.frontId) === String(cfg.frontSessionId) || String(x.backId) === String(cfg.backSessionId))
        const want = (g && g.preset) ? g.preset : cfg.permissionPreset
        if (want) {
          for (const ag of [front, back]) {
            if (!ag) continue
            const sid = idOf(ag)
            if (currentPreset(sid) !== want) applyPreset(sid, want)
          }
        }
      } catch { /* 忽略 */ }
    }, 20000)
    if (typeof ctx.effect === 'function') ctx.effect(() => () => { try { clearInterval(linkTimer) } catch { /* 忽略 */ } })
    setTimeout(() => { linkFrontWorkspace().catch(() => {}) }, 3000)
  } catch { /* 忽略 */ }

  // ── 会话组注册表（FR-01 / FR-02 …）：编号由服务端生成、客户端不可改 ────────
  const GROUPS_FILE = join(boardDir, 'groups.json')
  function loadGroups () {
    try { const a = JSON.parse(readIf(GROUPS_FILE) || '[]'); return Array.isArray(a) ? a : [] } catch { return [] }
  }
  function saveGroups (list) {
    try { writeAtomic(GROUPS_FILE, JSON.stringify(list, null, 1)) } catch (e) { log('saveGroups fail: ' + (e && e.message)) }
  }
  function nextGroupKey (list) {
    let max = 0
    for (const g of list) {
      const m = String((g && g.key) || '').match(/^FR-(\d+)$/)
      if (m) max = Math.max(max, Number(m[1]))
    }
    return 'FR-' + String(max + 1).padStart(2, '0')
  }

  // ── 权限预设（沙箱模式 + 审批策略的捆绑）────────────────────────────────
  // 直接复用 DSH 的 permissionPresets 服务：set(session, preset) 同时写
  // sandbox/mode 与 approval/policy ⇒ 面板里选的权限与 DSH 原生「权限」下拉完全等价，
  // 且不需要人盯着会话点「允许」。
  function svcPermissionPresets () {
    try { return (ctx && typeof ctx.get === 'function') ? ctx.get('permissionPresets') : undefined } catch { return undefined }
  }
  function permissionCatalog () {
    const p = svcPermissionPresets()
    if (!p || typeof p.catalog !== 'function') return { options: [], defaultPreset: '' }
    try {
      const c = p.catalog() || {}
      return { options: c.options || [], defaultOptions: c.defaultOptions || [], defaultPreset: c.defaultPreset || '' }
    } catch (e) { log('permissionCatalog fail: ' + (e && e.message)); return { options: [], defaultPreset: '' } }
  }
  function applyPreset (sessionId, preset) {
    if (!sessionId || !preset) return false
    const p = svcPermissionPresets()
    if (!p || typeof p.set !== 'function') return false
    try {
      const a = ctx.agents.get(sessionId)
      if (!a) return false
      p.set(a.session, preset)
      return true
    } catch (e) { log('applyPreset(' + preset + ') fail: ' + (e && e.message)); return false }
  }
  function currentPreset (sessionId) {
    try {
      const p = svcPermissionPresets()
      const a = sessionId ? ctx.agents.get(sessionId) : null
      if (!p || !a) return ''
      return p.current(a.session) || ''
    } catch { return '' }
  }
  function applyGroupPreset (g) {
    if (!g) return
    const preset = g.preset || cfg.permissionPreset
    if (!preset) return
    applyPreset(g.frontId, preset)
    applyPreset(g.backId, preset)
  }

  // ── 按角色的上下文守护：前台到 frontContextLimit 就压，后台几乎不压 ──────────
  // ⚠️ cordis 里直接 ctx.tokenMeter / ctx.compaction 属性访问可能抛 "cannot get property without inject"，
  //    所以通过 ctx.inject 拿服务（回调在服务就绪后执行）。
  let svcMeter = null
  let svcCompaction = null
  try {
    ctx.inject(['tokenMeter', 'compaction'], (c2) => {
      svcMeter = c2.tokenMeter
      svcCompaction = c2.compaction
      log('上下文守护：tokenMeter/compaction 服务已就绪')
    })
  } catch (e) { log('上下文守护服务注入失败: ' + e.message) }

  let lastCompactAt = { front: 0, back: 0 }
  async function checkContextBudget () {
    if (!cfg.contextGuard) return
    if (!svcMeter || !svcCompaction) return
    const pairs = [[front, 'front', cfg.frontContextLimit], [back, 'back', cfg.backContextLimit]]
    for (const [agent, role, limit] of pairs) {
      if (!agent || !limit) continue
      // 只在空闲时压（compactNow 要求 idle agent 且无排队唤醒）
      if (!(agent.phase && agent.phase.kind === 'idle')) continue
      if (Date.now() - lastCompactAt[role] < 30000) continue
      let surface = null
      try { surface = svcMeter.measure(agent.session).surfaceTokens } catch { /* 测量不可用 */ }
      if (surface == null || surface < limit) continue
      lastCompactAt[role] = Date.now()
      try {
        // ★ 实测：compactNow 要传 **agent**（不是 session）——传 session 会报
        //   "manual compaction requires an idle agent with no waking queued work"
        const r = svcCompaction.compactNow(agent, new AbortController().signal)
        const v = (r && typeof r.then === 'function') ? await r : r
        let after = null
        try { after = svcMeter.measure(agent.session).surfaceTokens } catch { /* 忽略 */ }
        event('ctx-compact', { role, before: surface, after, result: v ? String(JSON.stringify(v)).slice(0, 160) : null })
        log(`按角色压缩 ${role}: ${surface} → ${after}（预算 ${limit}）`)
      } catch (e) {
        event('ctx-compact-fail', { role, before: surface, err: String(e && e.message || e).slice(0, 160) })
        log(`按角色压缩失败 ${role}: ${e.message}`)
      }
    }
  }

  // ── 实时投递（首帧杀手）：fs.watch 监听 steps 目录，文件落盘立即投递 ────────────
  // 背景（2026-10-17 实测）：首帧 20.8s 里最大一块是"插件 30s 轮询"——
  // 后台把步骤写进 steps/ 后，前台平均要等 15s、最坏 30s 才收到。
  // 这里用 fs.watch 把这段延迟压到毫秒级。
  function startStepsWatcher () {
    try {
      let timer = null
      const w = watch(P.stepsDir, { persistent: false }, (evt, fname) => {
        if (!alive()) return
        const fn = String(fname || '')
        // ★ 过滤：writeAtomic 会先写 .tmpdir 再 rename ⇒ 每次写步骤会触发 2 次事件。
        //   只对正式步骤文件 / BATCH 清单响应，避免无谓的重复处理。
        if (fn && !/^S\d+\.md$/i.test(fn) && !/^BATCH.*\.md$/i.test(fn)) return
        if (timer) return                       // 合并短时间内的多次写入
        timer = setTimeout(() => {
          timer = null
          try {
            if (!alive()) return
            const t0 = Date.now()
            splitBatchFile()
            checkNewSteps()
            event('watcher-fire', { file: String(fname || ''), ms: Date.now() - t0 })
            log(`实时投递触发（${fname || '?'}，处理 ${Date.now() - t0}ms）`)
          } catch (e) { log('steps watcher err: ' + e.message) }
        }, 120)
      })
      w.on('error', (e) => log('steps watcher error: ' + (e && e.message || e)))
      log('实时投递：steps 目录已监听（首帧轮询延迟 ~30s → ~0.1s）')
      return w
    } catch (e) {
      log('steps watcher 启动失败（退回 30s tick）: ' + e.message)
      return null
    }
  }

  /** 规划闭环检测：统计 route.md「## 里程碑」段里列出的里程碑条数 */
  function routeMilestoneCount () {
    try {
      const t = readIf(join(boardDir, 'route.md'))
      if (!t) return 0
      // ★ 放宽标题匹配：模型会写 `## 3. 里程碑（3 节 = 3 步，均已写出）` ——带序号和括号说明。
      //   原来用 /##\s*里程碑\s*\n/ 会匹配失败 ⇒ 里程碑计数恒为 0 ⇒ 闭环检测静默失效（实测踩过）。
      const m = t.match(/^##[^\n]*里程碑[^\n]*$/m)
      if (!m) return 0
      const seg = t.slice(m.index + m[0].length).split(/\n##\s/)[0]
      return seg.split('\n').filter(l => /^\s*[-*]\s*\*?\*?M\d+/i.test(l)).length
    } catch { return 0 }
  }

  // ── fr_route：结构化提交路线（LLM 想乱写格式也写不出来）───────────────────────
  /** 把结构化路线渲染成 route.md（格式由插件 100% 控制）；
   *  若带 steps 参数，**同时**写出 steps/S<k>.md ⇒ 后台一次响应即可完成"路线 + 全部步骤"。 */
  function renderRoute (args) {
    const lines = ['# route.md（由 fr_route 工具生成，勿手改写）', '']
    lines.push('## 目标', String(args.goal || '').trim() || '（未提供）', '')
    const acc = Array.isArray(args.acceptance) ? args.acceptance.filter(Boolean) : []
    if (acc.length) { lines.push('## 终态判定'); for (const a of acc) lines.push('- ' + String(a).trim()); lines.push('') }
    const ms = Array.isArray(args.milestones) ? args.milestones.filter(m => m && m.id && m.desc) : []
    lines.push('## 里程碑')
    for (const m of ms) lines.push(`- **${String(m.id).trim()}${m.step ? '（' + String(m.step).trim() + '）' : ''}**：${String(m.desc).trim()}`)
    lines.push('')
    const sn = Array.isArray(args.sentinels) ? args.sentinels.filter(s => s && s.id && s.kind && s.target) : []
    if (sn.length) {
      lines.push('## 哨兵条件')
      for (const s of sn) lines.push(`- ${String(s.id).trim()} | ${String(s.kind).trim()} | ${String(s.target).trim()}`)
      lines.push('')
    }
    const body = lines.join('\n')
    writeAtomic(P.route, body)
    event('route-rendered', { chars: body.length, milestones: ms.length, sentinels: sn.length })
    log(`fr_route：route.md 已生成（${body.length} 字符，里程碑 ${ms.length}，哨兵 ${sn.length}）`)

    // ★ 同批写出步骤文件（省掉后台单独写 steps 的那一次响应）
    let wrote = 0
    const st = Array.isArray(args.steps) ? args.steps.filter(s => s && s.id && s.action) : []
    for (const s of st) {
      const k = stepNo(String(s.id))
      if (!k) continue
      const sl = [`# S${k}`, `动作: ${String(s.action).trim()}`, `验收: ${String(s.accept || '按动作完成').trim()}`, `assumes: ${String(s.assumes || '无').trim()}`]
      if (s.group) sl.push(`并行组: ${String(s.group).trim()}`)
      try {
        writeAtomic(join(P.stepsDir, `S${k}.md`), sl.join('\n') + '\n')
        try { seenSteps.delete(`S${k}.md`) } catch { /* 忽略 */ }   // 让投递逻辑重新认领
        wrote++
      } catch { /* 单步失败不影响其它 */ }
    }
    if (wrote) {
      event('route-steps', { steps: wrote })
      log(`fr_route：同时写出 ${wrote} 个步骤文件（省掉一次响应）`)
      // ★ 清理上一轮遗留步骤（2026-10-24 实测事故）：renderRoute 只覆写本次列出的步骤，
      //   上一轮多出来的 S<maxK+1>… 会留在盘上。上一轮 S1..S8 / 本轮 S1..S3 时，
      //   前台跑完 S3 会被投递**上一轮的 S4**，等于跨任务串味（做错事、白烧 token）。
      //   规则：只清理编号 > 本轮最大步号的尾部残留（不动本轮之前的已执行步骤，避免
      //   后台"只重发剩余步骤"的重规划被误删）。
      try {
        const maxK2 = st.reduce((max, x) => Math.max(max, stepNo(String(x.id)) || 0), 0)
        const staleDir = join(boardDir, 'stale')
        let moved = 0
        for (const f of readdirSync(P.stepsDir)) {
          if (!/^S\d+\.md$/.test(f)) continue
          const k = stepNo(f)
          if (!k || k <= maxK2) continue
          try {
            if (!existsSync(staleDir)) mkdirSync(staleDir, { recursive: true })
            renameSync(join(P.stepsDir, f), join(staleDir, `S${k}.${Date.now()}.md`))
            moved++
          } catch { /* 单文件失败忽略 */ }
          try { seenSteps.delete(f) } catch { /* 忽略 */ }
        }
        if (moved) {
          event('steps-pruned', { moved, keepMax: maxK2 })
          log(`fr_route：清理上一轮遗留步骤 ${moved} 个（>S${maxK2}，已移入 stale/）`)
        }
      } catch { /* 清理失败不影响本轮 */ }
      // ★ 新路线到达 ⇒ 重置进度（防呆）
      //   实测事故：上一轮 state.md 残留 done: S4 / status: done，后台本轮写了 S1-S4，
      //   插件按 "S<done+1>" 找 S5 ⇒ 永远没有可投步骤 ⇒ 前台空等「等待步骤」。
      try {
        const stNow = readState()
        const doneNo = stepNo(stNow.done || '')
        const maxK = Math.max(...st.map((x) => stepNo(String(x.id)) || 0), wrote, 0)
        if (doneNo >= maxK || String(stNow.status || '') === 'done') {
          writeAtomic(P.state, `planVersion: 0
status: working
done: S0
assumesMatch: yes
routeOk: yes
`)
          event('state-reset', { from: String(stNow.done || ''), reason: 'new-route' })
          log('新路线到达 ⇒ 进度重置（done ' + String(stNow.done || '-') + ' -> S0）')
        }
      } catch (e) { log('state reset fail: ' + e.message) }
    }
    return { ok: true, chars: body.length, milestones: ms.length, sentinels: sn.length, stepsWritten: wrote }
  }

  /** ⑤ 自动补全：后台没写「## 里程碑」段时，插件按 steps 数量自动补上（不依赖 LLM 遵守） */
  function ensureRouteMilestones () {
    try {
      if (!existsSync(P.route)) return
      const t = readIf(P.route)
      if (!t) return
      if (/^##[^\n]*里程碑/m.test(t)) return          // 已有 → 不动
      let names = []
      try { names = readdirSync(P.stepsDir).filter(f => /^S\d+\.md$/.test(f)) } catch { names = [] }
      if (!names.length) return
      names.sort((a, b) => stepNo(a) - stepNo(b))
      const add = ['', '## 里程碑（插件自动补全）', ...names.map((f, i) => `- M${i + 1}（S${stepNo(f)}）：见 steps/${f}`)]
      writeAtomic(P.route, t.replace(/\s*$/, '') + '\n' + add.join('\n') + '\n')
      event('route-autofill', { milestones: names.length })
      log(`route 自动补全：补了 ${names.length} 个里程碑（后台没写）`)
    } catch { /* 忽略 */ }
  }

  function checkLookahead () {
    const st = readState()
    const doneNo = stepNo(st.done || '')
    const steps = listSteps().map(stepNo)
    if (!steps.length) return            // 还没有路线，不催
    if (hasDeliver()) return             // 已交付 → 停
    // ★ 规划闭环：route 列了 N 个里程碑，但只写出 M 个步骤（N > M）⇒ 后台漏写步骤，
    //   立即催补。必须放在 "doneNo >= maxNo 就返回" **之前**，否则前台跑完现有步骤后
    //   会直接进终局、漏掉的步骤永远补不上（实测 REPORT.md 两次都没生成）。
    const ms = routeMilestoneCount()
    if (ms > steps.length) {
      if (milestoneGapCount < 3) {          // 同一缺口最多催 3 次，防后台不响应时无限唤醒
        milestoneGapCount++
        wakeBack('need-next', `【补步】route.md 列了 ${ms} 个里程碑，但 steps 只有 ${steps.length} 个（[${steps.map(n => 'S' + n).join(',')}]，done=S${doneNo}）。请补写缺失的步骤文件 —— **每个里程碑必须对应一个步骤**，写完即停。`)
        event('milestone-gap', { milestones: ms, steps: steps.length, done: doneNo, attempt: milestoneGapCount })
        log(`规划闭环：里程碑 ${ms} > 步骤 ${steps.length}，已催后台补步（第 ${milestoneGapCount} 次）`)
      }
      return
    }
    milestoneGapCount = 0                  // 缺口补齐 → 计数归零
    const maxNo = Math.max(...steps)
    // ══ 流水线预规划（2026-10-18）══════════════════════════════════════════
    // ★ 必须在 "doneNo >= maxNo 就返回" 之前执行：
    //   实测后台常只给 2-3 步（fr_route 一次产出有限），前台几十秒就跑完，
    //   若放在 return 之后则永远不会预取下一批（用户观测到"后台不提前生成"）。
    const remain = steps.filter(n => n > doneNo).length
    const frontBusy = !!(front && front.phase && front.phase.kind === 'running')
    const backBusy = !!(back && back.phase && back.phase.kind === 'running')
    const watermark = prefetchWatermark()
    if (frontBusy && !backBusy && remain <= watermark) {
      const now = Date.now()
      if (now - lastPrefetchAt >= (cfg.prefetchCooldownMs || 45000)) {
        lastPrefetchAt = now
        wakeBack('prefetch', `【预规划·流水线】前台正在跑（done=S${doneNo}，前方仅剩 ${remain} 个未执行步骤）。` +
          `请在后台**提前规划后续步骤**（从 .board/steps/S${maxNo + 1}.md 起，至少补到 ${watermark} 步缓冲），` +
          `已存在的步骤不要重写。若任务确实已接近完成，写 .board/deliver.v1.md 收口。写完即停。`)
        event('prefetch', { done: doneNo, remain, maxNo, watermark })
        log(`流水线预规划：前台剩余 ${remain} 步 <= 水位 ${watermark}，已提前唤醒后台（maxNo=S${maxNo}）`)
      }
    }
    if (doneNo >= maxNo) return          // 清单已跑完 → 交给"终局"逻辑，**不再催单**（#2 修复）
    // 兜底：真的断粮了（前方一条都没有）→ 用原来的强力催单
    const haveFromNext = remain
    if (haveFromNext >= 1) return
    let missing = doneNo + 1
    while (steps.includes(missing)) missing++
    wakeBack('need-next', `【催单】前台 done=S${doneNo}，steps 现有 [${steps.join(',')}]，**缺 S${missing}**。请写入 .board/steps/S${missing}.md（必须自包含、≥120 字、含可独立验收的判据）。`)
  }

  // ── B6 新步骤到达 → steer 前台并把指令内联（E1） ────────────────────────
  // #3 修复（2026-10-17 实测竞态）：后台是"先写占位、再补内容"的，原实现只要**文件名出现**
  // 就投递，结果把 11 字节的 "placeholder" 当成步骤指令投给了前台。
  // 现在三条件：① 内容够长（非占位）② 文件已稳定（mtime 距今 > SETTLE_MS）③ 内容指纹变化才重投。
  const MIN_STEP_CHARS = 120
  const SETTLE_MS = 5000
  const seenSteps = new Map()   // file -> 内容指纹

  // ── M19 批量步骤清单：后台写一个 BATCH 文件，插件拆成 steps/S<k>.md ─────────
  // 背景：后台逐个写 steps/S<k>.md 要 N 次响应（每次 10-30s）。改成**一次响应**写一个
  // BATCH.md（含多条 `## S<k>` 段），插件拆开 ⇒ 后台产出速度提升到 N 倍。
  function splitBatchFile () {
    let files = []
    try { files = readdirSync(P.stepsDir).filter(f => /^BATCH.*\.md$/i.test(f)) } catch { return 0 }
    if (!files.length) return 0
    let created = 0
    for (const f of files) {
      const full = join(P.stepsDir, f)
      let body = ''
      try {
        body = readFileSync(full, 'utf8')
        if (Date.now() - statSync(full).mtimeMs < 3000) continue   // 还在写，下一轮再拆
      } catch { continue }
      const parts = body.split(/^[ \t]*##[ \t]*S(\d+)[ \t]*$/m)
      for (let i = 1; i + 1 < parts.length; i += 2) {
        const k = Number(parts[i])
        const content = String(parts[i + 1] || '').trim()
        if (!k || content.length < 40) continue
        const target = join(P.stepsDir, `S${k}.md`)
        if (existsSync(target)) continue                          // 不覆盖已存在的步骤
        if (writeAtomic(target, `# S${k}\n${content}\n`)) {
          created++
          // ★ 重要：新生产出来的步骤必须清掉 seenSteps 指纹，否则内容与上一批相同的步骤
          //   会被"已投递过"去重逻辑拦住，永远不投给前台（实测踩过）。
          try { seenSteps.delete(`S${k}.md`) } catch { /* 忽略 */ }
          event('batch-split', { batch: f, step: `S${k}`, chars: content.length })
        }
      }
      // 标记已处理（移到 stale/ 保留审计，避免重复拆分）
      try { mkdirSync(join(boardDir, 'stale'), { recursive: true }) } catch { /* 已存在 */ }
      try { renameSync(full, join(boardDir, 'stale', f + '.' + Date.now())) } catch { /* 忽略 */ }
    }
    if (created) log(`M19 批量清单拆分：新增 ${created} 个步骤`)
    return created
  }

  /** 后台分诊否决：verdict.md 里写「short: 理由」= 这任务不值得编排，让前台自己做 */
  let lastAgentError = null   // 最近一次模型/回合错误（余额不足等）
  let verdictSeen = ''
  function checkVerdict () {
    const vFile = join(boardDir, 'verdict.md')
    const raw = readIf(vFile).trim()
    if (!raw || raw === verdictSeen) return
    // ★ 修复（2026-10-24）：verdict 可能是**上一个任务**遗留的文件（实测本机 board 里有
    //   10-17 的旧 verdict；route 已到 10-18）。这种旧分诊在重启后会被重新应用，
    //   直接告诉前台「这任务不值得编排，你自己干」—— 等于废掉双会话。
    //   判据：verdict 的 mtime 必须晚于**本任务起点**（最近一次 api-task / deliver / escalate）。
    let vMtime = 0
    try { vMtime = statSync(vFile).mtimeMs } catch { /* 文件刚被删 */ }
    let taskStart = 0
    for (const line of tailLines(P.events, 300)) {
      try {
        const o = JSON.parse(line)
        if (o.kind !== 'api-task' && o.kind !== 'deliver' && o.kind !== 'escalate') continue
        const at = Date.parse(o.at) || 0
        if (at > taskStart) taskStart = at
      } catch { /* 坏行跳过 */ }
    }
    if (vMtime <= taskStart) {
      verdictSeen = raw            // 记下内容，避免每次 tick 重复判定
      event('verdict-stale', { verdictMtime: vMtime, taskStart, why: '旧任务遗留的 verdict，忽略' })
      log('判定：verdict.md 早于本任务起点 ⇒ 视为陈旧分诊，忽略')
      return
    }
    verdictSeen = raw
    const m = raw.match(/^short\s*[:：]\s*(.+)$/im)
    if (!m) return
    const why = m[1].slice(0, 160)
    // ★ 尊重用户显式要求（2026-10-18 实测）：用户说「调度后台 / 走编排 / 多步」时
    //   不接受后台的「短任务」分诊 —— 否则后台一旦判短就不再规划，
    //   用户看到的就是"疑似没拉起后台"。
    try {
      const handoff = readIf(join(boardDir, 'handoff.md'))
      const userWant = /(调度后台|走后台|走编排|必须调度|需要后台|多步|规划路线)/.test(handoff)
      if (userWant) {
        event('verdict-short-overruled', { why: why.slice(0, 80) })
        log('后台判短任务，但用户显式要求走编排 ⇒ 忽略分诊，继续等路线')
        return
      }
    } catch { /* 忽略 */ }
    // ★ O2 自适应批量：后台判为短任务 ⇒ 一次多给几条步骤（简单任务不必逐条验证）
    cfg.batchSteps = Math.max(cfg.batchSteps || 2, 5)
    event('batch-adapt', { batchSteps: cfg.batchSteps, why: 'verdict-short' })
    steerFront(`【后台分诊：短任务】${why}\n判定：这个任务不值得走编排。**你自己直接做完并交付**，不要等步骤；做完把 state.md 的 status 写成 done。`, 'verdict-short')
    event('verdict-short', { why })
    log('后台判为短任务，已让前台自己做: ' + why)
  }

    // ── S4：调度核心（实现在 lib/scheduler.js；SB/B 门面注入依赖）──
  const SB = {
    get cfg(){ return cfg },
    get recentGaps(){ return recentGaps }, set recentGaps(v){ recentGaps = v },
    modeNow,
    get adaptiveBatch(){ return adaptiveBatch }, set adaptiveBatch(v){ adaptiveBatch = v },
    get lastDeliverAt(){ return lastDeliverAt }, set lastDeliverAt(v){ lastDeliverAt = v },
    get toolStats(){ return toolStats },
    get t3Blocked(){ return t3Blocked },
    get lastT3Seen(){ return lastT3Seen }, set lastT3Seen(v){ lastT3Seen = v },
    get boardDir(){ return boardDir },
    get lastAnalysisMtime(){ return lastAnalysisMtime }, set lastAnalysisMtime(v){ lastAnalysisMtime = v },
    get front(){ return front },
    get back(){ return back },
    get lastReviewAt(){ return lastReviewAt }, set lastReviewAt(v){ lastReviewAt = v },
    get reviewCount(){ return reviewCount }, set reviewCount(v){ reviewCount = v },
    get lastReviewStepNo(){ return lastReviewStepNo }, set lastReviewStepNo(v){ lastReviewStepNo = v },
    get workers(){ return workers },
    get judgeWaiting(){ return judgeWaiting }, set judgeWaiting(v){ judgeWaiting = v },
    get judgeFile(){ return judgeFile },
  }
  const B = {
    stepNo,
    readIf,
    readState,
    hasDeliver,
    get P(){ return P },
  }
  const Sched = makeScheduler({ S: SB, B, log, event, steerFront, wakeBack, lastAssistantText })
  const { prefetchWatermark, effectiveBatch, observeDeliveryForAdapt, parseStepMeta, checkAnalysisDelivery, checkMilestoneReview, archiveBoardIfDone, cleanupWorkers, resetTaskScheduler } = Sched
function checkNewSteps () {
    let files = []
    try { files = readdirSync(P.stepsDir).filter(f => /^S\d+\.md$/.test(f)) } catch { return }
    // ★ Phase 3 停牌：等后台判断（judge.ok 出现才继续，'fr_poke resolve' / 后台写文件均可解除）
    if (judgeWaiting) {
      if (existsSync(judgeFile)) {
        judgeWaiting = false
        event('judge-resolved', {})
        log('停牌解除：judge.ok 已就绪，继续投递')
      } else return
    }
    const doneNo = stepNo(readState().done || '')
    // ★ §22 优化①：任务级批量覆盖优先（编号步骤任务一次投全批）
    const batch = Math.max(effectiveBatch(), taskBatchOverride || 0)
    const picked = []
    // 只从 S(done+1) 起、连续取 batch 条（跳号一律不投，避免"路线断裂"）
    for (let n = doneNo + 1; n <= doneNo + batch; n++) {
      const f = `S${n}.md`
      if (!files.includes(f)) break
      const full = join(P.stepsDir, f)
      let body = ''
      let mtime = 0
      try { body = readFileSync(full, 'utf8'); mtime = statSync(full).mtimeMs } catch { break }
      if (body.trim().length < MIN_STEP_CHARS) break       // ① 占位/未写完
      if (Date.now() - mtime < SETTLE_MS) break            // ② 还在写
      const h = `${body.length}:${body.slice(0, 60)}:${body.slice(-60)}`
      if (seenSteps.get(f) === h) break                    // ③ 已投过
      const meta = parseStepMeta(body)
      // ★ Phase 2 依赖：depends 里的步号还没完成 ⇒ 降级串行（等它完成，不跳号、不卡死）
      if (meta.depends.length) {
        const missing = meta.depends.filter(d => d > doneNo)
        if (missing.length) {
          event('dep-blocked', { file: f, missing })
          break
        }
      }
      picked.push({ f, body, h, meta })
      // ★ Phase 3 停牌步骤：只投它自己，后续等 judge.ok
      if (meta.judge) break
    }
    if (!picked.length) return
    // ★ M1（拉取模式）：前台**正在跑**时不推送 —— 它干完会自己读 steps/S<k+1>.md。
    //   只有前台**空闲**且下一步已就绪时才推（防 stall，守住"及时响应"这个 KPI）。
    if (cfg.pullSteps) {
      const busy = front && front.phase && front.phase.kind === 'running'
      if (busy) {
        // ★ 实测竞态（2026-10-17）：新步骤落盘时前台正好在收尾（相差 31ms），
        //   这里一 return 就再也没有文件事件了，下一步要等 30s tick 才可能投递 ⇒ 任务卡住。
        // ★★ 2026-10-18 修复（严重）：原来只安排 6 次 ×1.2s = 7.2s 的延迟重试，
        //   而前台跑一步通常 20-60s ⇒ 重试耗尽后**永远不再投递**，
        //   实测表现为 watcher-fire 三次但 step-delivered 为 0、前台一直 running 空转。
        //   现在：重试窗口内快速重试；窗口耗尽后交给 nextDeliverRetryAt 由 30s tick 继续兜底，
        //   直到前台空闲或步骤被投递，绝不永久放弃。
        if (deliverRetry < 6) {
          deliverRetry++
          setTimeout(() => {
            deliverRetry--
            try { if (alive()) checkNewSteps() } catch { /* 忽略 */ }
          }, 1200)
        } else {
          // 重试预算用尽：标记一个"待投递"，由 tick 在下一轮继续尝试（不丢）
          pendingDeliver = true
          if (!pendingDeliverLogged) {
            pendingDeliverLogged = true
            log('投递等待中：前台仍在运行，已转入 tick 兜底（不会丢失）')
            event('deliver-deferred', { files: picked.map(p => p.f) })
          }
        }
        return
      }
      deliverRetry = 0
      pendingDeliver = false
      pendingDeliverLogged = false
    }
    for (const p of picked) seenSteps.set(p.f, p.h)
    // ★ 投递 S1（= 新任务起点）时重置本任务计数，避免 H5 跨任务累计永久误报
    if (picked.some(p => p.f === 'S1.md')) {
      stepsThisTask = 0
      alertedSentinels.clear()
      resetTaskScheduler()
      // ★ §25 优化A：override 不在 S1 清零——任务级保持（整个任务期间大 batch）
      //   清零时机移到"新任务文本到达"（api-task 的 resetTaskScheduler 前）
    }
    // ★ Phase 3 停牌：本批最后一步要求人工/后台判断 ⇒ 投出后等待 judge.ok
    const judgeStep = picked.find(p => p.meta && p.meta.judge)
    if (judgeStep) {
      judgeWaiting = true
      try { if (existsSync(judgeFile)) unlinkSync(judgeFile) } catch { /* 忽略 */ }
      wakeBack('judge', `【需要判断】步骤 ${judgeStep.f.replace('.md', '')} 需要先判断再继续。请读该步骤与 state.md，把结论写进 .board/verdict.md（格式 \`judge: 允许|不允许 <理由>\`），并在通过时写一个空文件 .board/judge.ok（不允许就别写，直接说明原因）。`)
      event('judge-wait', { step: judgeStep.f.replace('.md', '') })
      log(`停牌：${judgeStep.f} 等后台判断（judge.ok）`)
    }
    const names = picked.map(p => p.f.replace('.md', ''))
    const parts = picked.map(p => `=== ${p.f.replace('.md', '')} ===\n${p.body.slice(0, 1200)}`)
    const head = cfg.pullSteps
      ? `【步骤就绪：${names.join(' / ')}】执行后**立刻自己读 .board/steps/ 下的下一步**接着干，不要等推送。`
      : `【计划就绪：${names.join(' → ')}】按顺序执行，**每完成一步就把 state.md 的 done 更新成该步号**。`
    // M20：后台在步骤里标了「并行组」⇒ 组内步骤互不依赖，提示前台一次并发做完（利用 M13 并行工具调用）
    let parHint = ''
    try {
      const groups = {}
      for (const p of picked) {
        const m = p.body.match(/并行组\s*[:：]\s*([A-Za-z0-9_-]+)/)
        if (m) (groups[m[1]] = groups[m[1]] || []).push(p.f.replace('.md', ''))
      }
      const multi = Object.entries(groups).filter(([, v]) => v.length > 1)
      if (multi.length) parHint = '\n\n' + multi.map(([g, v]) => `⚡ 并行组 ${g}：${v.join('、')} 互不依赖 → **在同一个回复里一起做完**（多个工具调用并发）`).join('\n')
    } catch { /* 忽略 */ }
    steerFront(`${head}${parHint}\n\n${parts.join('\n\n')}`, 'new-step')
    finalAsked = false   // ★ 新步骤到达 ⇒ 重置终局守卫（否则第二次清单耗尽时不会再触发终局询问）
    finalAnswerAsked = false   // 新步骤到达 ⇒ 重置终局正文守卫
    event('step-delivered', { files: names, chars: picked.reduce((s, p) => s + p.body.length, 0) })
    try { observeDeliveryForAdapt() } catch { /* 自适应失败不影响投递 */ }
    // ★ 事件驱动预规划（2026-10-18 修复）：
    //   实测问题：后台一次只给 4 步、前台 40s 跑完，而预取检查只挂在 30s tick 上，
    //   两者撞不上 ⇒ 用户观测到"后台不提前生成"。
    //   现在每次投递后**立刻**算一次缓冲，不够就马上唤醒后台补下一批（自带冷却）。
    try {
      if (cfg.pipelinePrefetch !== 0) {
        const stNow = readState()
        const doneNow = stepNo(stNow.done || '')
        const allNow = listSteps().map(stepNo)
        const maxNow = allNow.length ? Math.max(...allNow) : 0
        const remainNow = allNow.filter((n) => n > doneNow).length
        const watermark = prefetchWatermark()
        const backBusyNow = !!(back && back.phase && back.phase.kind === 'running')
        const now2 = Date.now()
        if (!backBusyNow && remainNow <= watermark && now2 - lastPrefetchAt >= (cfg.prefetchCooldownMs || 45000) && !hasDeliver()) {
          lastPrefetchAt = now2
          // ★ Phase 2 收尾：预读提示（纯提示，不实际读；从剩余步骤正文里抠路径）
          let prereadHint = ''
          if (cfg.preread !== false) {
            try {
              const remainFiles = readdirSync(P.stepsDir).filter(f => /^S\d+\.md$/.test(f) && stepNo(f) > doneNow).slice(0, 2)
              const paths = []
              for (const f of remainFiles) {
                try { paths.push(...extractPaths(readFileSync(join(P.stepsDir, f), 'utf8'), 3)) } catch { /* 忽略 */ }
              }
              const uniq = [...new Set(paths)].slice(0, 5)
              if (uniq.length) {
                // [#5 预读落地] 把候选路径写进 .board/preread.md，供前台/后续步骤直接引用（preread-cache）
                try { writeAtomic(join(boardDir, 'preread.md'), '# 预读候选（只读提示）\n\n' + uniq.join('\n') + '\n') } catch { /* 忽略 */ }
                prereadHint = '\n【可选·预读】先把这些可能用到的文件**只读**看一遍（别改），清单也已写进 .board/preread.md：' + uniq.join('、')
              }
            } catch { /* 忽略 */ }
          }
          wakeBack('prefetch', `【预规划·流水线】刚投递 ${names.join(',')}（done=S${doneNow}，前方仅剩 ${remainNow} 步）。` +
            `请在后台**提前规划后续步骤**（从 .board/steps/S${maxNow + 1}.md 起，补到至少 ${watermark} 步缓冲）；` +
            `若任务已接近完成，写 .board/deliver.v1.md 收口。不要重写已有步骤，写完即停。` + prereadHint)
          event('prefetch', { done: doneNow, remain: remainNow, maxNo: maxNow, trigger: 'step-delivered' })
          log(`流水线预规划（投递后即时）：剩余 ${remainNow} 步 <= 水位 ${watermark}，已唤醒后台补步`)
        }
      }
    } catch (e) { log('post-deliver prefetch fail: ' + e.message) }
  }

  // ══ 对外 API 装配（/fr 页面 + 外部脚本共用）═════════════════════════════════
  // 这里把插件的内部能力收敛成一个 app 对象，交给 lib/api.js 注册成 HTTP 端点。
  // 好处：页面/脚本/以后的其他工具都能用同一套接口，不必依赖 fr_poke 工具。
  const apiApp = {
    cfg, boardDir, event, log,
    idOf,
    readState,
    listSteps,
    resolveAgents,
    ensureWiring,
    wakeBack,
    steerFront,
    saveOverrides,
    get overrides () { return overrides },
    getFront: () => front,
    getBack: () => back,
    getMeter: () => svcMeter,
    getLastAutoHealAt: () => autoHealAt,   // 面板判断"正在自愈"窗口
    // ── 任务模式（Phase 1）──
    getActualModels: () => {
      const pick = (a) => { try { return a && a.options ? { provider: a.options.provider || '', model: a.options.model || '' } : null } catch { return null } }
      return { front: pick(front), back: pick(back) }
    },
    /** 当前接线若不属于任何会话组 ⇒ 自动收编成一个新组（直接对话场景） */
    async ensureCurrentGroup () {
      try {
        if (!cfg.frontSessionId || !cfg.backSessionId) return null
        const list = loadGroups()
        const fId = String(cfg.frontSessionId), bId = String(cfg.backSessionId)
        const hit = list.find((g) => String(g.frontId) === fId && String(g.backId) === bId)
        if (hit) return { group: hit, created: false }
        const r = await apiApp.createGroup('', true)   // adopt 当前前后台
        if (r && r.ok) { event('group-auto-adopt', { key: r.group && r.group.key }); log('直接对话 ⇒ 自动收编为会话组 ' + (r.group && r.group.key)) }
        return r && r.ok ? { group: r.group, created: true } : null
      } catch (e) { log('ensureCurrentGroup 失败: ' + e.message); return null }
    },
    /** T3 待批准列表（供面板展示） */
    listPendingConfirms () {
      try {
        const out = []
        const dir = P.confirmDir
        let files = []
        try { files = readdirSync(dir).filter((f) => /^S\d+\.pending$/.test(f)) } catch { /* 无目录 */ }
        for (const f of files) {
          let body = ''
          try { body = readFileSync(join(dir, f), 'utf8') } catch { /* 忽略 */ }
          out.push({ id: f.replace(/\.pending$/, ''), step: f, cmd: body.slice(0, 500), at: (() => { try { return statSync(join(dir, f)).mtime.toISOString() } catch { return '' } })() })
        }
        return out
      } catch { return [] }
    },
    /** 批准：写 S<k>.ok 并删除 pending */
    approveConfirm (step) {
      try {
        const s = String(step || '').replace(/[^A-Za-z0-9]/g, '')
        if (!s) return { error: '缺少 step' }
        writeAtomic(join(P.confirmDir, s + '.ok'), new Date().toISOString())
        try { unlinkSync(join(P.confirmDir, s + '.pending')) } catch { /* 忽略 */ }
        event('t3-approved-by-user', { step: s })
        log('T3 用户批准: ' + s)
        // ★ 批准后必须主动唤醒前台：它可能已停在"等待审批"状态，不会自己回来
        let woke = false
        try {
          woke = steerFront('【已批准】危险操作已获用户批准（' + s + '），请**继续执行刚才那条命令**，不要重试其它方式。', 't3-approved', { force: true })
        } catch (e) { log('T3 批准唤醒失败: ' + e.message) }
        // 若前台没跑（steer 失败/空闲未起），用 followup 兜底再叫一次
        if (!woke) {
          try {
            if (front) { front.followup(msg('【已批准】' + s + ' 已获用户批准，请继续执行之前那条命令。')); woke = true }
          } catch (e) { log('T3 批准 followup 兜底失败: ' + e.message) }
        }
        return { ok: true, step: s, woke }
      } catch (e) { return { error: String(e && e.message || e) } }
    },
    /** 拒绝：删除 pending，并告知前台不要重试 */
    rejectConfirm (step) {
      try {
        const s = String(step || '').replace(/[^A-Za-z0-9]/g, '')
        if (!s) return { error: '缺少 step' }
        try { unlinkSync(join(P.confirmDir, s + '.pending')) } catch { /* 忽略 */ }
        try { writeAtomic(join(P.confirmDir, s + '.denied'), new Date().toISOString()) } catch { /* 忽略 */ }
        event('t3-rejected-by-user', { step: s })
        log('T3 用户拒绝: ' + s)
        try { steerFront('【已拒绝】用户拒绝了这个危险操作，请放弃该命令并说明原因或另想办法。', 't3-rejected', { force: true }) } catch { /* 忽略 */ }
        try { steerFront('用户已拒绝该删除/破坏性操作，请勿重试；如需换方式请说明原因。', 't3-denied') } catch { /* 忽略 */ }
        return { ok: true, step: s, denied: true }
      } catch (e) { return { error: String(e && e.message || e) } }
    },
    getLastError: () => lastAgentError,
    getMode: () => ({
      mode: currentMode(),
      label: modeInfo(currentMode()).label,
      by: modeBy,
      locked: !!cfg.modeLocked,
      auto: cfg.modeAuto !== false,
      presets: MODE_KEYS,
      // 每个预设的一句话简介（面板悬停提示用，唯一来源 lib/modes.js）
      presetsInfo: MODE_KEYS.map((k) => ({ key: k, label: modeInfo(k).label, summary: modeInfo(k).summary })),
    }),
    getWorkers: () => [...workers.entries()].map(([id, w]) => ({ id, task: w.task, ageMs: Date.now() - w.at })),
    getAdaptive: () => ({ batch: adaptiveBatch, gaps: recentGaps.slice(-3), enabled: cfg.batchAdapt !== false, effective: effectiveBatch() }),
    setMode: (key, by) => applyMode(key, by || 'user', 'api'),
    applyToolPolicy,

    /** 停止：取消正在跑的前后台（不销毁会话） */
    stopAll () {
      pauseAt = Date.now()         // ★ 真·用户暂停：优先级最高，连消防说明的 force 也不放行
      userStopAt = pauseAt         // ★ 用户点了停止 ⇒ 尊重意图，15s 内不再内联追加
      const r = { front: false, back: false }
      try { if (front && front.phase && front.phase.kind === 'running') { front.cancel(new Error('api stop')); r.front = true } } catch { /* 忽略 */ }
      try { if (back && back.phase && back.phase.kind === 'running') { back.cancel(new Error('api stop')); r.back = true } } catch { /* 忽略 */ }
      return r
    },

    /** 重建：优先 cfg.provider/model（或显式传入），兜底全局默认模型；cwd 用 boardRoot */
    async rebuildSessions (explicit) {
      if (!svcAgentLoop || !svcPresets) return { error: 'agentLoop / agentPresets 服务未就绪' }
      const route = resolveRoute(explicit)
      if (!route) return { error: '拿不到模型路由（可在配置里设 provider/model）' }
      const mk = async (tag) => {
        const ag = await svcAgentLoop.create('session-fr-' + tag + '-' + Date.now().toString(36),
          { provider: routeFor(tag).provider, model: routeFor(tag).model, reasoningEffort: effortFor(tag) }, { cwd: boardRoot })
        try { await svcPresets.mount(ag.ctx, cfg.agentPreset || 'standard') } catch (e) { log('挂预设失败: ' + e.message) }
        return ag
      }
      try { if (front) front.cancel(new Error('rebuild')) } catch { /* 忽略 */ }
      try { if (back) back.cancel(new Error('rebuild')) } catch { /* 忽略 */ }
      const f = await mk('front')
      const b = await mk('back')
      // ★ 接线必须同时写 cfg + overrides（只写 overrides 会被 resolveAgents 忽略 ⇒ 新会话永不接管）
      wire(idOf(f), idOf(b))
      // 把实际用到的模型持久化，下次重建/自愈不再靠"全局默认"猜
      overrides.provider = route.provider
      overrides.model = route.model
      cfg.provider = route.provider
      cfg.model = route.model
      saveOverrides()
      briefed.clear()
      resolveAgents()          // ★ 立刻按新接线解析，避免后续逻辑仍拿旧的 front/back
      return { front: idOf(f), back: idOf(b), provider: route.provider, model: route.model }
    },

    /** 消防打断（走模块级 FIRE 句柄） */
    fireInterrupt (reason) {
      try {
        // ★ 签名修复（2026-10-17 实测）：FIRE = fireInterrupt(agent, why, note)，
        //   之前这里 FIRE(reason) 把 reason 当 agent 传进去 ⇒ "target.cancel is not a function"。
        if (typeof FIRE === 'function') {
          resolveAgents()
          const r = FIRE(front, 'api', String(reason || 'API 手动打断'))
          return { fired: !!(r && r.ok), result: r }
        }
        // 退路：直接 cancel 前台
        const f = front
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
          overrides.provider = provider; overrides.model = model
          // ★ both = 前后台都跟随全局 ⇒ 必须清掉角色级覆盖，否则状态里 front/back 仍是旧模型（面板高亮会错）
          cfg.frontProvider = ''; cfg.frontModel = ''; cfg.backProvider = ''; cfg.backModel = ''
          for (const k of ['frontProvider', 'frontModel', 'backProvider', 'backModel']) {
            delete overrides[k]
            droppedOnce.add(k)
          }
        } else if (only === 'front') {
          cfg.frontProvider = provider; cfg.frontModel = model
          overrides.frontProvider = provider; overrides.frontModel = model
        } else {
          cfg.backProvider = provider; cfg.backModel = model
          overrides.backProvider = provider; overrides.backModel = model
        }
        saveOverrides()
        const targets = only === 'both' ? [front, back] : (only === 'front' ? [front] : [back])
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

    // ══ 会话组管理（FR-01 / FR-02 …）══════════════════════════════════════
    // 编号由服务端生成、客户端不可指定（防改号）；每组 = 前台 + 后台 两个会话，
    // 全部 attach 到「快速反应」工作区；删除需 force 且运行中默认拒绝。
    listGroups () {
      const list = loadGroups()
      const phaseOf = (id) => {
        try { const a = ctx.agents.get(id); return a ? ((a.phase && a.phase.kind) || '?') : 'missing' } catch { return 'missing' }
      }
      const active = (list.find((g) => String(g.frontId) === String(cfg.frontSessionId)) || {})
      return {
        groups: list.map((g) => ({
          key: g.key, title: g.title, frontId: g.frontId, backId: g.backId, createdAt: g.createdAt,
          frontPhase: phaseOf(g.frontId), backPhase: phaseOf(g.backId),
          active: String(g.frontId) === String(cfg.frontSessionId),
          attached: true,
          preset: g.preset || '',
          frontPreset: currentPreset(g.frontId),
          backPreset: currentPreset(g.backId),
        })),
        activeKey: active.key || '',
        permission: permissionCatalog(),
        defaultPreset: cfg.permissionPreset || '',
      }
    },

    /** 权限预设目录（前端下拉用） */
    permissionCatalog () { return permissionCatalog() },

    /** 当前前后台实际生效的权限预设（面板显示/排障用） */
    currentPermissions () {
      return {
        front: front ? currentPreset(idOf(front)) : '',
        back: back ? currentPreset(idOf(back)) : '',
        default: cfg.permissionPreset || '',
      }
    },

    // ══ 会话寻址（per-session API）════════════════════════════════════════
    // 目标解析优先级：sessionId > group(+role) > 当前接线
    resolveSessionTarget (opts = {}) {
      const byId = (id) => { try { return id ? (ctx.agents.get(String(id)) || null) : null } catch { return null } }
      if (opts.sessionId) return byId(opts.sessionId)
      if (opts.group) {
        const g = loadGroups().find((x) => x.key === String(opts.group))
        if (!g) return null
        return byId(opts.role === 'back' ? g.backId : g.frontId)
      }
      return opts.role === 'back' ? back : front
    },

    /** 列出所有活会话（含角色/所属组/phase/preset） */
    listSessions () {
      const groups = loadGroups()
      const groupOf = (id) => {
        const g = groups.find((x) => String(x.frontId) === String(id) || String(x.backId) === String(id))
        if (!g) return ''
        return g.key + (String(g.frontId) === String(id) ? '·F' : '·B')
      }
      try {
        return {
          sessions: ctx.agents.list().map((a) => {
            const id = idOf(a)
            return {
              id,
              role: a === front ? 'front' : (a === back ? 'back' : 'other'),
              phase: (a.phase && a.phase.kind) || '?',
              cwd: cwdOf(a),
              preset: currentPreset(id),
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
      const id = idOf(a)
      return {
        id,
        role: a === front ? 'front' : (a === back ? 'back' : 'other'),
        phase: (a.phase && a.phase.kind) || '?',
        cwd: cwdOf(a),
        preset: currentPreset(id),
        wired: id === String(cfg.frontSessionId) || id === String(cfg.backSessionId),
      }
    },

    /** 把消息投递给任意会话（interrupt=true 先 cancel 再投递） */
    async deliver (opts = {}, text, interrupt) {
      const a = apiApp.resolveSessionTarget(opts)
      if (!a) return { error: '目标会话不存在（检查 sessionId / group / 接线）' }
      const id = idOf(a)
      const body = String(text || '').trim()
      if (!body) return { error: 'text 不能为空' }
      // ── 模式自动判型（Phase 1）：用户发来新任务、且目标就是前台、且没被锁定时，
      //    按文本判一次；判型失败无害（默认 coding，与旧行为一致）。
      if (cfg.modeAuto !== false && !cfg.modeLocked && a === front) {
        try {
          resetTaskScheduler()          // 新任务 ⇒ 清停牌/复核/分析投递状态
          taskBatchOverride = 0   // ★ §25 优化A：新任务文本到达 ⇒ 上一个任务的批量覆盖失效
          lastAgentError = null   // 新任务开始 ⇒ 清掉上次的错误提示
          const detected = detectMode(body)
          if (detected !== currentMode()) {
            const r = applyMode(detected, 'auto', body.slice(0, 60))
      // ★ §22 优化①：检测编号列举步骤数 ⇒ 本任务一次投全批（前台一个回合做完，省 5 次往返）
      try {
        const numbered = body.match(/[①-⑳]|^\s*\d+[.、）)]/gm) || []
        const cnSteps = body.match(/第[一二三四五六七八九十]+步/g) || []
        const count = Math.max(numbered.length, cnSteps.length)
        taskBatchOverride = count >= 3 ? Math.min(count, 8) : 0
        if (taskBatchOverride) log(`编号步骤任务：批量覆盖 = ${taskBatchOverride}`)
      } catch { /* 判定失败不影响投递 */ }
            if (r && r.ok) log(`按任务文本判型 → ${r.label}`)
          }
        } catch (e) { log('模式判型失败: ' + e.message) }
      }
      const running = !!(a.phase && a.phase.kind === 'running')
      let cancelled = false
      if (interrupt && running) {
        try { a.cancel(new Error('send-interrupt')); cancelled = true } catch { /* 忽略 */ }
        if (cancelled) await new Promise((r) => setTimeout(r, 400))
      }
      lastBeatAt = Date.now()   // ★ §31 修复：新任务/插话起点 = 心跳基线重置（防 H3 把空闲期计入停滞误杀新任务）
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

    /** 设置某组权限预设：写注册表 + 立即应用到前后台会话（会话缺失时先自愈） */
    async setGroupPolicy (key, preset) {
      const list = loadGroups()
      const g = list.find((x) => x.key === key)
      if (!g) return { error: '找不到会话组 ' + key }
      g.preset = String(preset || '')
      saveGroups(list)
      const alive = (id) => { try { return !!(ctx.agents && ctx.agents.get(id)) } catch { return false } }
      if (!alive(g.frontId) || !alive(g.backId)) {
        await apiApp.repairGroups()          // 防呆：会话丢了先重建，否则权限设不上
        const fresh = loadGroups().find((x) => x.key === key)
        if (fresh) { g.frontId = fresh.frontId; g.backId = fresh.backId }
      }
      applyGroupPreset(g)
      event('group-policy', { key, preset: g.preset })
      log('会话组 ' + key + ' 权限 -> ' + (g.preset || '(跟随默认)'))
      return { ok: true, key, preset: g.preset, frontPreset: currentPreset(g.frontId), backPreset: currentPreset(g.backId) }
    },

    async createGroup (title, adoptCurrent) {
      if (!svcAgentLoop || !svcPresets) return { error: 'agentLoop / agentPresets 服务未就绪' }
      const route = resolveRoute()
      if (!route) return { error: '拿不到模型路由（先配置或启动一次）' }
      const list = loadGroups()
      const key = nextGroupKey(list)
      // ★ adopt：把当前已接线的前后台直接收编成本组（不新建会话）
      if (adoptCurrent) {
        const live = (id) => { try { return !!(id && ctx.agents && ctx.agents.get(id)) } catch { return false } }
        if (!live(cfg.frontSessionId) || !live(cfg.backSessionId)) {
          return { error: '当前前后台未接线（先点「启动」）' }
        }
        const fId = String(cfg.frontSessionId), bId = String(cfg.backSessionId)
        for (const g of list) {
          if (String(g.frontId) === fId || String(g.backId) === bId) return { error: '当前前后台已属于会话组 ' + g.key }
        }
        const g = {
          key, title: String(title || ('快速反应 ' + key)).slice(0, 60), frontId: fId, backId: bId,
          createdAt: new Date().toISOString(), preset: cfg.permissionPreset || '', adopted: true,
        }
        applyGroupPreset(g)
        list.push(g)
        saveGroups(list)
        await linkSession(fId, true); await linkSession(bId, false)
        // ★ 收编后刷新两个会话的标题（带上组号，否则还是「快速反应 · 前台」无后缀）
        try {
          const fa = ctx.agents.get(fId); if (fa) await nameSession(fa, 'front', key)
          const ba = ctx.agents.get(bId); if (ba) await nameSession(ba, 'back', key)
        } catch { /* 忽略 */ }
        event('group-adopt', { key, front: fId, back: bId })
        log('收编当前前后台为会话组 ' + key)
        return { ok: true, group: g, groups: list, adopted: true }
      }
      const mk = async (tag) => {
        const id = 'session-' + key.toLowerCase() + '-' + tag + '-' + Date.now().toString(36)
        const ag = await svcAgentLoop.create(id, { provider: routeFor(tag).provider, model: routeFor(tag).model, reasoningEffort: effortFor(tag) }, { cwd: boardRoot })
        await nameSession(ag, tag, key)
        try { await svcPresets.mount(ag.ctx, cfg.agentPreset || 'standard') } catch (e) { log('组挂预设失败: ' + e.message) }
        await linkSession(idOf(ag), tag === 'front')
        return idOf(ag)
      }
      try {
        const frontId = await mk('front')
        const backId = await mk('back')
        const g = {
          key, title: String(title || ('快速反应 ' + key)).slice(0, 60), frontId, backId,
          createdAt: new Date().toISOString(), preset: cfg.permissionPreset || '',
        }
        applyGroupPreset(g)
        list.push(g)
        saveGroups(list)
        event('group-create', { key, front: frontId, back: backId, preset: g.preset })
        log('新建会话组 ' + key + '（front=' + frontId.slice(0, 22) + '，权限=' + (g.preset || '默认') + '）')
        return { ok: true, group: g, groups: list }
      } catch (e) { return { error: String(e && e.message || e) } }
    },

    async deleteGroup (key, force) {
      const list = loadGroups()
      const i = list.findIndex((g) => g.key === key)
      if (i < 0) return { error: '找不到会话组 ' + key }
      const g = list[i]
      const ids = [g.frontId, g.backId].filter(Boolean)
      const agents = []
      for (const id of ids) { try { const a = ctx.agents.get(id); if (a) agents.push(a) } catch { /* 忽略 */ } }
      const running = agents.some((a) => a.phase && a.phase.kind === 'running')
      if (running && !force) return { error: '该组正在运行，需确认强制删除', needForce: true }
      for (const a of agents) { try { a.cancel(new Error('delete group')) } catch { /* 忽略 */ } }
      await new Promise((r) => setTimeout(r, 300))
      for (const id of ids) await detachSession(id)
      list.splice(i, 1)
      saveGroups(list)
      event('group-delete', { key, ids, force: !!force })
      log('删除会话组 ' + key + '（' + ids.join(',') + '）')
      if (ids.includes(String(cfg.frontSessionId)) || ids.includes(String(cfg.backSessionId))) {
        unwire(); resolveAgents()
      }
      return { ok: true, key, deleted: ids, groups: list }
    },

    async switchGroup (key) {
      const list = loadGroups()
      const g = list.find((x) => x.key === key)
      if (!g) return { error: '找不到会话组 ' + key }
      const alive = (id) => { try { return !!(ctx.agents && ctx.agents.get(id)) } catch { return false } }
      if (!alive(g.frontId) || !alive(g.backId)) {
        const r = await apiApp.repairGroups()      // 防呆：会话丢了先自愈再切
        if (r && r.error) return r
      }
      wire(g.frontId, g.backId)
      briefed.clear()                               // 新组需要重新注入角色简报
      resolveAgents()
      applyGroupPreset(g)                           // 切换后按该组权限预设重设前后台
      // ★ 切组后刷新两个会话的标题（带上新组号，否则侧边栏还是旧组的名字）
      try {
        const fa = ctx.agents.get(g.frontId); if (fa) await nameSession(fa, 'front', key)
        const ba = ctx.agents.get(g.backId); if (ba) await nameSession(ba, 'back', key)
      } catch { /* 忽略 */ }
      event('group-switch', { key, front: g.frontId, back: g.backId, preset: g.preset || '' })
      log('切换到会话组 ' + key)
      return { ok: true, key, front: idOf(front), back: idOf(back) }
    },

    /** 自愈：编号连续性 / 缺失会话重建 / 工作区重新挂载 */
    async repairGroups () {
      if (!svcAgentLoop || !svcPresets) return { error: 'agentLoop / agentPresets 服务未就绪' }
      const list = loadGroups()
      const report = { renumbered: [], recreated: [], attached: [], ok: true }
      const alive = (id) => { try { return !!(ctx.agents && ctx.agents.get(id)) } catch { return false } }
      const mk = async (g, tag) => {
        const id = 'session-' + g.key.toLowerCase() + '-' + tag + '-' + Date.now().toString(36)
        const route = resolveRoute() || {}
        const ag = await svcAgentLoop.create(id, { provider: routeFor(tag).provider, model: routeFor(tag).model, reasoningEffort: effortFor(tag) }, { cwd: boardRoot })
        try { await svcPresets.mount(ag.ctx, cfg.agentPreset || 'standard') } catch { /* 忽略 */ }
        return idOf(ag)
      }
      for (let n = 0; n < list.length; n++) {
        const g = list[n]
        const want = 'FR-' + String(n + 1).padStart(2, '0')
        if (g.key !== want) { report.renumbered.push({ from: g.key, to: want }); g.key = want }
        if (!alive(g.frontId)) {
          try { g.frontId = await mk(g, 'front'); report.recreated.push({ key: g.key, role: 'front' }) } catch (e) { report.ok = false; log('自愈重建前台失败: ' + e.message) }
        }
        if (!alive(g.backId)) {
          try { g.backId = await mk(g, 'back'); report.recreated.push({ key: g.key, role: 'back' }) } catch (e) { report.ok = false; log('自愈重建后台失败: ' + e.message) }
        }
        for (const id of [g.frontId, g.backId]) {
          if (!id) continue
          const done = await linkSession(id, id === g.frontId)
          if (done) report.attached.push(id)
        }
        applyGroupPreset(g)                          // 自愈后重设权限（可能刚重建会话）
      }
      saveGroups(list)
      event('group-repair', report)
      log('会话组自愈：' + JSON.stringify(report).slice(0, 300))
      return report
    },

    /** 应用配置（白名单字段，写回 config.json 并立即生效） */
    applyConfig (body) {
      const allowed = ['batchSteps', 'frontContextLimit', 'backContextLimit', 'pullSteps', 'contextGuard',
        'enabled', 'interruptCooldownMs', 'interruptMaxPerTask', 'sentinelIntervalMs',
        'stallWatchdog', 'stallTimeoutMs', 'stallSafeRetry', 'linkWorkspaceSession', 'permissionPreset',
        'pipelinePrefetch', 'prefetchCooldownMs', 'sentinelEnabled', 'heartbeatStaleMs', 'modeLocked', 'modeAuto',
        'frontProvider', 'frontModel', 'backProvider', 'backModel', 'batchAdapt', 'preread', 'workersEnabled']
      const applied = {}
      for (const k of allowed) {
        if (body[k] === undefined) continue
        const v = body[k]
        if (typeof v === 'number' && !Number.isFinite(v)) continue
        cfg[k] = v
        overrides[k] = v
        applied[k] = v
      }
      saveOverrides()
      return { applied }
    },

    /** HTTP 版 fr_poke：只覆盖常用动作，避免为 API 复制整段工具实现 */
    async poke (action, args) {
      const a = String(action || '')
      if (a === 'wake') { lastWakeAt = 0; return { woke: wakeBack('manual', String(args.text || '【手动唤醒】请读 .board/ 继续。')) } }
      if (a === 'steer') { return { steered: steerFront(String(args.text || '【手动插话】'), 'manual') } }
      if (a === 'fire') { return apiApp.fireInterrupt(String(args.text || args.reason || '手动打断')) }
      if (a === 'config') {
        try { Object.assign(cfg, JSON.parse(readFileSync(cfgFile, 'utf8')) || {}); resolveAgents(); return { reloaded: true } } catch (e) { return { error: String(e && e.message || e) } }
      }
      if (a === 'probe-tools') {
        // ★ Phase 0 门禁（2026-10-24）：验证 tools.restrict 能否作用于**已存在的**前/后台会话，
        //   并且能从 tools.schemas(agent) 观察到可见工具数变化。这决定「按模式分配工具」的可行性。
        const out = { at: new Date().toISOString(), agents: [] }
        for (const [role, ag] of [['front', front], ['back', back]]) {
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
      if (a === 'probe-tools2') {
        // 返回前/后台**实际可见**的工具名数组（tools.schemas(agent)）
        const out = {}
        for (const [role, ag] of [['front', front], ['back', back]]) {
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
        const st = readState()
        const doneNo = stepNo(st.done || '')
        let files = []
        try { files = readdirSync(P.stepsDir).filter(f => /^S\d+\.md$/.test(f)).sort((x, y) => stepNo(x) - stepNo(y)) } catch { /* 忽略 */ }
        const out = {
          at: new Date().toISOString(),
          mode: currentMode(),
          modeLabel: modeInfo(currentMode()).label,
          effectiveBatch: effectiveBatch(),
          done: doneNo,
          judgeWaiting,
          steps: [],
          decision: [],
        }
        for (const f of files) {
          let body = ''
          try { body = readFileSync(join(P.stepsDir, f), 'utf8') } catch { continue }
          const meta = parseStepMeta(body)
          out.steps.push({ file: f, len: body.trim().length, depends: meta.depends, judge: meta.judge, group: meta.group, seen: !!seenSteps.get(f) })
        }
        for (let n = doneNo + 1; n <= doneNo + out.effectiveBatch; n++) {
          const f = `S${n}.md`
          const rec = out.steps.find(x => x.file === f)
          if (!rec) { out.decision.push({ file: f, verdict: 'missing' }); break }
          if (rec.len < MIN_STEP_CHARS) { out.decision.push({ file: f, verdict: 'too-short' }); break }
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
        return { front: dump(front), back: dump(back) }
      }
      return { error: 'HTTP 中继不支持该动作: ' + a }
    },
  }

  // ── 侧边栏 loader（**稳定不变**）：拉取 /fr/sidebar.js 并**每 4 秒检查更新**。
  //   实际注入逻辑在 lib/ui/sidebar.js（路由实时读磁盘）⇒ 改那个文件几秒内自动生效，
  //   **改 UI 永远不用重启 DSH**（bundle 装配没有热重载，这是唯一可行的热更新通道）。
  //
  //   ★ 关键教训（2026-10-17）：最初用 `(0,eval)(txt)` 执行，被 DSH 页面的 CSP
  //     （无 unsafe-eval）**静默拦掉** ⇒ 更新永远不生效，还以为"轮询没工作"。
  //     现在改为注入带版本号的 <script src>（同源脚本 CSP 允许，不需要 eval）。
  const SIDEBAR_LOADER = `(function(){
if(window.__frLoader)return;window.__frLoader=1;
var lastVer='';
function load(){
  fetch('/fr/sidebar.js?t='+Date.now(),{cache:'no-store'}).then(function(r){return r.text()}).then(function(txt){
    // 内容指纹：长度 + 首尾片段（比只比长度可靠）
    var ver=txt.length+':'+txt.slice(0,80)+':'+txt.slice(-120);
    if(ver===lastVer)return;
    lastVer=ver;
    var s=document.createElement('script');
    s.src='/fr/sidebar.js?v='+Date.now();
    s.async=true;
    s.onerror=function(){try{console.error('[fast-react] sidebar.js 加载失败')}catch(_){}};
    (document.body||document.documentElement).appendChild(s);
  }).catch(function(){});
}
if(document.body){load()}else{document.addEventListener('DOMContentLoaded',load)}
setInterval(load,3000);
})()`
  try {
    ctx.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        if (table.some(r => r && typeof r.text === 'string' && r.text.indexOf('__frLoader') >= 0)) return
        table.push({ kind: 'script', placement: 'body', text: SIDEBAR_LOADER })
      } catch { /* 注入失败不影响插件其它部分 */ }
    })
  } catch (e) { log('侧边栏 loader 注册失败: ' + (e && e.message || e)) }

  // ── 注册独立页面 + 便捷 API（webServer 服务就绪后自动挂上）────────────────────
  try {
    ctx.inject(['webServer'], (c2) => {
      try {
        const routes = makeRoutes(apiApp)
        let n = 0
        for (const r of routes) {
          try {
            c2.effect(() => c2.webServer.register(r), 'fast-react: ' + r.path)
            n++
          } catch (e) { log('注册路由失败 ' + r.path + ': ' + e.message) }
        }
        log(`Web 控制台已注册：/fr（${n - 1} 个 API 端点）`)
      } catch (e) { log('注册 Web 控制台失败: ' + e.message) }
    })
  } catch (e) { log('webServer 注入失败（控制台不可用，插件其它功能正常）: ' + e.message) }

  // ── 装配：effect + 监听器 ──────────────────────────────────────────────
  ctx.effect(function* () {
    ensure()
    if (!existsSync(cfgFile)) writeAtomic(cfgFile, JSON.stringify(DEFAULTS, null, 2))
    resolveAgents()
    event('plugin-start', { front: idOf(front), back: idOf(back), board: boardDir })
    // 模式初始化：显式配置 > 上次落盘的 mode.md > 默认 coding
    try { applyMode(activeMode || readModeFile() || (cfg.mode || DEFAULT_MODE), 'startup', 'plugin start') } catch (e) { log('模式初始化失败: ' + e.message) }
    log(`启动 board=${boardDir} front=${idOf(front) || '(未接线)'} back=${idOf(back) || '(未接线)'}`)

    // ① T3 守卫（同步、轻量；返回字符串即拒绝）
  /** 破坏性命令的目标是否都在工作区内（workspace-write 下可放行） */
  function isInsideWorkspace (cmd) {
    try {
      const root = String(boardRoot || '').toLowerCase().replace(/[\\/]+$/, '')
      if (!root) return false
      const paths = String(cmd || '').match(/[A-Za-z]:[\\/][^\s'"`,|)！；，。]+/g) || []
      if (!paths.length) return false
      return paths.every((p) => String(p).toLowerCase().replace(/[\\/]+$/, '').startsWith(root))
    } catch { return false }
  }

    yield ctx.tools.guard((exec) => {
      try {
        if (!alive()) return undefined     // 旧实例的守卫失效，避免双重拦截
        // ★ Phase 1 工具层第二道：restrict 只砍全局工具，会话级 scoped 工具（团队/运维类）
        //   仍会出现在工具表里 ⇒ 这里硬拒绝，双保险。
        if ((isFront(exec.agent) || isBack(exec.agent)) && isDeniedTool(exec.name)) {
          event('block-scoped', { tool: String(exec.name), who: isFront(exec.agent) ? 'front' : 'back' })
          return `快速反应的前台/后台禁止使用 ${exec.name}（团队/运维/跨会话类工具会绕过编排或抢占接线）`
        }
        // ★ 运维通道保护（2026-10-17）：插件注册的工具对**所有** agent 可见；若不拦，
        //   前台/后台能自己调 fr_poke 自我唤醒 / 绕过编排（实测观察到过不明 manual steer）。
        if (exec.name === 'fr_poke' && (isFront(exec.agent) || isBack(exec.agent))) {
          event('block-opstool', { who: isFront(exec.agent) ? 'front' : 'back' })
          return 'fr_poke 是运维通道，前台/后台禁止调用；请走规定通道（前台用 fr_escalate，后台写黑板）'
        }
        if (exec.name === 'fr_route' && !isBack(exec.agent)) {
          event('block-opstool', { tool: 'fr_route', who: isFront(exec.agent) ? 'front' : 'other' })
          return 'fr_route 只能由后台调用（前台请等步骤/写黑板）'
        }
        // ★ 禁止前后台派生子智能体（2026-10-18 实测事故：误接线的前台 spawn 出 6 个子会话，
        //   父会话全是 UUID，真正的后台空闲、任务失控）。
        //   光靠简报约束不够，这里在工具层硬拦。
        if (/^(subagent|subagent_fork|spawn_teammate|agent|workflow)$/.test(String(exec.name || ''))
          && (isFront(exec.agent) || isBack(exec.agent))) {
          event('block-subagent', { tool: exec.name, who: isFront(exec.agent) ? 'front' : 'back' })
          return '快速反应的前台/后台禁止派生子智能体（会造成层级失控）。需要并行请在同一个回复里发多个工具调用；需要分派请上交后台（fr_escalate）。'
        }
        if (!cfg.enabled) return undefined
        if (!isFront(exec.agent)) return undefined
        const cmd = isDestructive(exec.name, exec.arguments)
        if (!cmd) return undefined
        // ★★ 按「权限预设」判定（2026-10-24 用户明确规则）：
        //   danger-full-access ⇒ 完全权限，直接干（不拦）
        //   read-only         ⇒ 只读，任何写/执行/删除都要审批
        //   workspace-write   ⇒ 工作区内可写，出界要审批
        //   auto              ⇒ 交给 DSH 自身策略
        let permNow = ''
        try {
          // 直接读：前台实际生效的权限预设（currentPreset 已在上面定义）
          if (front) permNow = String(currentPreset(idOf(front)) || '')
          if (!permNow) permNow = String(cfg.permissionPreset || '')
        } catch { /* 忽略 */ }

        if (permNow === 'danger-full-access') {
          event('t3-pass-fullaccess', { tool: exec.name, cmd: cmd.slice(0, 120) })
          return undefined      // 完全权限：直接执行
        }
        // read-only / workspace-write：破坏性操作一律走审批
        if (permNow === 'read-only' || permNow === 'workspace-write') {
          // workspace-write 下，若目标确实在工作区内，可放行
          if (permNow === 'workspace-write' && isInsideWorkspace(cmd)) {
            event('t3-pass-inworkspace', { cmd: cmd.slice(0, 120) })
            return undefined
          }
          // 落到下面统一的审批流程
        }

        // ★ 临时目录放行（A/B 实测：前台在 tempfile 里 os.remove 测试文件被误拦，白烧 2.6 分钟）
        const isTempTarget = /(tempfile|\/tmp\/|AppData\\Local\\Temp|\$env:TEMP|GetTempPath|\bTEMP\b|\bTMP\b)/i.test(cmd)
        if (isTempTarget) {
          event('t3-pass-temp', { cmd: cmd.slice(0, 120) })
          log('T3 放行（临时目录）: ' + cmd.slice(0, 80))
          return undefined
        }
        // ★ 放行路径（2026-10-17 修）：后台写了 confirm/S<当前步>.ok 就放行。
        //   原实现漏了这一步 ⇒ 一旦拦截就永远拦，T3 的"确认放行"完全是断的。
        const st = readState()
        const curStep = 'S' + (stepNo(st.done || '') + 1)
        if (hasConfirm(curStep)) {
          event('t3-pass', { tool: exec.name, step: curStep })
          log(`T3 放行（确认戳 ${curStep}）: ${cmd.slice(0, 80)}`)
          return undefined
        }
        t3Blocked++
        // ★ 写 .pending 让面板能看到并批准（原来只唤醒后台，用户无从得知）
        try { writeAtomic(join(P.confirmDir, curStep + '.pending'), cmd) } catch { /* 忽略 */ }
        event('t3-block', { tool: exec.name, cmd, step: curStep })
        log(`T3 拦截: ${cmd.slice(0, 120)}`)
        wakeBack('t3', `【T3 待确认】前台要执行破坏性动作，已被拦截（等 .board/confirm/${curStep}.ok）：\n${cmd}\n请判断：允许则写 .board/confirm/${curStep}.ok；不允许则给出替代方案。`)
        return '【等待用户批准】这是破坏性操作，已在控制台生成待批准条目；请用户在面板上点「允许」后再继续。不是失败，请勿换方式重试。'
      } catch (e) { log('guard err: ' + e.message); return undefined }
    })

    // ★ M1+（及时性增强，2026-10-17）：前台**即将停下**的瞬间，若下一步已就绪，直接塞进当前回合。
    //   原理：agent/turn-stopping 在边界前被 await，此处 steer() 会给**当前回合再加一步**
    //   ⇒ 零延迟、零额外唤醒。这是"绝对及时 + 高处理频率"最直接的保障（也是 M1 的兜底）。
    yield ctx.on('agent/turn-stopping', (payload) => {
      try {
        const agent = payload && payload.agent
        if (!cfg.enabled || !isFront(agent)) return
        // M14 测量用：记录前台每次轮末的精确时刻（对比"纯文本响应"vs"带工具响应"的延迟）
        event('front-turn-end', {})
        // ★★ 2026-10-18 修复（用户反馈"右下角暂停点不动"）：
        //   这里用 agent.steer() 往**当前回合**追加一步，等价于在用户按暂停的位置继续延展回合，
        //   DSH 的 pause/cancel 因此看起来"没反应"。所以：
        //   ① 用户刚按过暂停/取消 ⇒ 一段时间内禁止内联追加（尊重用户意图）
        //   ② 只有"前台确实是在正常跑任务"时才内联；空闲态一律不内联
        if (Date.now() - userStopAt < 15000) {
          event('inline-skip', { why: 'user-stop' })
          return
        }
        const phaseNow = agent.phase && agent.phase.kind
        if (phaseNow !== 'running') return      // 已在收尾/空闲 ⇒ 不再追加
        const doneNo = stepNo(readState().done || '')
        const f = `S${doneNo + 1}.md`
        const full = join(P.stepsDir, f)
        if (!existsSync(full)) return
        const body = readFileSync(full, 'utf8')
        if (body.trim().length < MIN_STEP_CHARS) return
        const h = `${body.length}:${body.slice(0, 60)}:${body.slice(-60)}`
        if (seenSteps.get(f) === h) return
        seenSteps.set(f, h)
        agent.steer(msg(`【步骤就绪：${f.replace('.md', '')}】继续干，做完**自己读**下一步，不要停。\n\n${body.slice(0, 1200)}`))
        event('step-inline', { file: f })
        log(`turn-stopping 内联投递 ${f}（零延迟，省一次唤醒）`)
      } catch (e) { log('turn-stopping 内联失败: ' + e.message) }
      // ★ §22 优化②：内联不成立（下一步未就绪）时催后台——利用前台空闲窗口提前写步骤
      try {
        const stNow = readState()
        const doneNow = stepNo(stNow.done || '')
        const allNow = listSteps().map(stepNo)
        const maxNow = allNow.length ? Math.max(...allNow) : 0
        const remainNow = allNow.filter((x) => x > doneNow).length
        const wm = prefetchWatermark()
        const backBusy = !!(back && back.phase && back.phase.kind === 'running')
        if (!backBusy && remainNow <= wm && Date.now() - lastPrefetchAt >= (cfg.prefetchCooldownMs || 45000) && !hasDeliver()) {
          lastPrefetchAt = Date.now()
          wakeBack('prefetch-urgent', `【空闲期预规划】前台刚好空闲、剩余步骤（${remainNow}）不足缓冲（${wm}）。请从 .board/steps/S${maxNow + 1}.md 起补到至少 ${wm + 1} 步；若任务已收口则写 deliver。`)
          event('prefetch', { done: doneNow, remain: remainNow, maxNo: maxNow, trigger: 'turn-stopping-idle' })
          log('turn-stopping 空闲催后台（消除空转窗口）')
        }
      } catch { /* 催促失败不影响前台 */ }
    })

    // ══ 消防通道（Fire Channel）═══════════════════════════════════════════
    // 设计依据：<实现逻辑 v2> §5.5 —— 全架构唯一允许"打断"的通道，只有 3 类触发：
    //   ① 用户插话（消息里带标记【消防】）  ② 环境危险事件（写 .board/fire.md）
    //   ③ 后台发现"正在做错事"（也写 .board/fire.md，仅此一种后台可打断前台的情形）
    // 硬约束：冷却 + 每任务上限 + 记账（打断 = 白扔一次生成，必须知道代价）。
    const fire = { lastAt: 0, countThisTask: 0, by: {}, wasted: 0 }
    function fireInterrupt (agent, why, note) {
      userStopAt = Date.now()      // ★ 打断 = 用户意图，短期内不再内联追加
      const target = agent || front
      if (!target) return { ok: false, err: 'no front' }
      const now = Date.now()
      if (now - fire.lastAt < (cfg.interruptCooldownMs || 60000)) {
        event('fire-skip', { why, reason: 'cooldown' })
        return { ok: false, err: 'cooldown', remainMs: (cfg.interruptCooldownMs || 60000) - (now - fire.lastAt) }
      }
      if (fire.countThisTask >= (cfg.interruptMaxPerTask || 5)) {
        event('fire-skip', { why, reason: 'max-per-task' })
        return { ok: false, err: 'max-per-task' }
      }
      const wasRunning = !!(target.phase && target.phase.kind === 'running')
      try { target.cancel(new Error('消防通道: ' + why)) } catch (e) {
        log('fire cancel fail: ' + e.message)
        return { ok: false, err: String(e && e.message || e) }
      }
      fire.lastAt = now
      fire.countThisTask++
      fire.by[why] = (fire.by[why] || 0) + 1
      if (wasRunning) fire.wasted++
      event('fire', { why, wasRunning, note: String(note || '').slice(0, 160) })
      // ★ Phase 4 干扰登记：把"被打断"的事实写进 state.md，前台恢复时能知道刚才为什么被打断
      try { appendLine(P.state, `interrupt: ${String(why || 'fire').slice(0, 60)}@${new Date().toISOString()}`) } catch { /* 忽略 */ }
      log(`🔥 消防通道打断（${why}）${wasRunning ? '（正在生成→已丢弃）' : '（空闲）'}`)
      // §13.6：打断后必须附说明，否则会被旧思路锚定 —— 取消只是截断，续写要靠这条说明
      // ★ 修复（2026-10-24）：这条说明此前必被自己的 userStopAt（上一行刚写）吞掉，
      //   消防通道等于"只断不说"。用 force 绕过本通道自写的静默窗；真·用户暂停仍由 pauseAt 拦住。
      if (note) steerFront(`【消防通道·极简模式】只做下面这一件事，做完**只回一句话（≤20 字）**，然后**立刻回到原任务继续**（不要停等新指令）。\n禁止：解释、总结、复述、额外验证、读无关文件、更新 state.md、顺手做任务外的事。\n**如果这件事不需要工具（只是确认/回答），就直接回一句话，不要调用任何工具** —— 实测带工具的响应要 27s，纯文本只要 12s。\n\n${String(note).slice(0, 600)}`, 'fire', { force: true })
      return { ok: true, wasRunning }
    }
    FIRE = fireInterrupt   // 暴露给 fr_poke 的工具作用域

    /** 触发 ②③：外部/后台写 .board/fire.md（一行说明）⇒ tick 内打断前台，然后**必须消费掉**
     *  ★ 修复（2026-10-24）：此前用 unlinkSync 但未 import ⇒ ReferenceError 被空 catch 吞掉，
     *    fire.md 永远留在盘上 ⇒ 同一个文件每 60s 冷却后反复打断（每任务上限 5 次，下个任务又重来）。
     *    现在改为「移到 stale/ 归档」：既能保证只消费一次，又留下审计痕迹；移动失败再退回删除。 */
    function checkFireFile () {
      const p = join(boardDir, 'fire.md')
      if (!existsSync(p)) return false
      let note = ''
      try { note = readFileSync(p, 'utf8').trim() } catch { /* 读失败按空处理 */ }
      try {
        const staleDir = join(boardDir, 'stale')
        mkdirSync(staleDir, { recursive: true })
        renameSync(p, join(staleDir, `fire-${Date.now()}.md`))
      } catch {
        try { unlinkSync(p) } catch { /* 删不掉也不重试（下次 tick 再试） */ }
      }
      if (!note) return false
      resolveAgents()
      const r = fireInterrupt(front, 'fire-file', note)
      if (!r.ok) log('消防通道未执行: ' + r.err)
      return r.ok
    }

    // 触发 ①：用户插话 —— 监听前台收件箱，消息里带【消防】标记就打断
    // ③ 模型/回合错误（余额不足、401、限流、超时…）—— 必须让用户看见，否则表现为"毫无反应"
    // ③-1 模型请求级失败（余额不足/401/限流最常见入口；重试耗尽前就能捕获）
    yield ctx.on('agent/request-error', (payload) => {
      try {
        const agent = payload && payload.agent
        const who = isFront(agent) ? 'front' : (isBack(agent) ? 'back' : '')
        const f = (payload && payload.failure) || {}
        const msg = [f.code, f.message || f.reason || ''].filter(Boolean).join(' · ').slice(0, 500) || '模型请求失败'
        const status = f.status ? ('HTTP ' + f.status) : ''
        lastAgentError = {
          at: new Date().toISOString(), role: who || 'other',
          turn: payload && payload.turn, step: payload && payload.step,
          provider: (payload && payload.provider) || '', status, message: msg,
        }
        event('agent-request-error', { role: lastAgentError.role, provider: lastAgentError.provider, status, message: msg.slice(0, 200) })
        log('模型请求失败（' + (who || 'other') + (status ? ' ' + status : '') + '）：' + msg)
      } catch (e) { log('agent/request-error 处理失败: ' + e.message) }
    })

    // ③-0 强制按"接线角色"的路由发请求（会话 options 对已存在会话无效，这是最终防线）
    yield ctx.on('agent/request', async (payload, next) => {
      try {
        const agent = payload && payload.agent
        const tag = isFront(agent) ? 'front' : (isBack(agent) ? 'back' : '')
        if (!tag) return next()
        const r = currentRouteFor(tag)
        if (!r || !r.provider || !r.model) return next()
        const cfg2 = await next()
        if (cfg2 && (cfg2.provider !== r.provider || cfg2.model !== r.model)) {
          event('route-enforced', { role: tag, from: cfg2.provider + '/' + cfg2.model, to: r.provider + '/' + r.model })
          log('路由强制 ' + tag + ': ' + cfg2.provider + '/' + cfg2.model + ' -> ' + r.provider + '/' + r.model)
          return { ...cfg2, provider: r.provider, model: r.model }
        }
        return cfg2
      } catch (e) { log('agent/request 拦截失败: ' + e.message); return next() }
    })

    yield ctx.on('agent/error', (payload) => {
      try {
        const agent = payload && payload.agent
        const who = isFront(agent) ? 'front' : (isBack(agent) ? 'back' : '')
        const err = payload && payload.error
        let msg = ''
        try {
          msg = typeof err === 'string' ? err : (err && (err.message || err.failure && err.failure.message)) || String(err || '')
        } catch { msg = '未知错误' }
        msg = String(msg || '').slice(0, 500)
        lastAgentError = { at: new Date().toISOString(), role: who || 'other', turn: payload && payload.turn, step: payload && payload.step, message: msg }
        event('agent-error', { role: lastAgentError.role, message: msg.slice(0, 200) })
        log('模型/回合错误（' + (who || 'other') + '）：' + msg)
      } catch (e) { log('agent/error 处理失败: ' + e.message) }
    })

    yield ctx.on('agent/inbox/spliced', (payload) => {
      try {
        const agent = payload && (payload.agent || payload.target || payload.self || payload.session)
        if (!isFront(agent)) return
        let s = ''
        try { s = JSON.stringify(payload) } catch { return }
        if (!s || s.indexOf('【消防】') < 0) return
        fireInterrupt(agent, 'user')
      } catch (e) { log('fire inbox err: ' + e.message) }
    })

    // ② 工具后置：合成 heartbeat + 统计 + 新步骤检查
    yield ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        if (!alive()) return next()      // 旧实例失效
        if (isFront(exec.agent)) {
          const ok = !(result && result.isError)
          toolStats.total++
          stepsThisTask++
          if (ok) toolStats.failStreak = 0
          else {
            // ★ 按"失败的名字"聚合（2026-10-18 实测）：
            //   旧逻辑把跨不同工具、跨不同任务的失败也累加成 failStreak，
            //   导致上一轮任务的 web_fetch 失败残留到下一轮，一句「你好」就触发 H4 冻结。
            //   现在：连续失败必须**同一工具**才算堆积；换工具即重置。
            const nm = String(exec.name || '?')
            toolStats.failStreak = (toolStats.lastFailName === nm) ? (toolStats.failStreak + 1) : 1
            toolStats.lastFailName = nm
            toolStats.failTotal++
          }
          synthHeartbeat(exec.name, ok)
          // ★ M1 补充（2026-10-17 实测）：前台自己 read 了某个 steps/S<k>.md ⇒ 视为已投递，
          //   记进 seenSteps，避免插件在它做完后再"补推"一遍（实测发生过冗余推送）。
          if (exec.name === 'read' && ok) {
            try {
              const a = exec.arguments || {}
              const p = String(a.file_path || a.path || a.filePath || '')
              const m = p.match(/[\\/]steps[\\/](S\d+)\.md$/i)
              if (m) {
                const f = m[1] + '.md'
                const body = readFileSync(join(P.stepsDir, f), 'utf8')
                seenSteps.set(f, `${body.length}:${body.slice(0, 60)}:${body.slice(-60)}`)
                event('step-pulled', { file: f })
                // ★ O1 插件代写进度：前台读 S<k> ⇒ 说明 S<k-1> 已做完 ⇒ 插件自动推进 done。
                //   ⇒ 前台**每步省掉一次 write 工具调用**（实测每次工具调用 = 一次模型响应 3-9s）。
                const k = Number(m[1].slice(1))
                const prev = k - 1
                const st = readState()
                if (prev > stepNo(st.done || '')) {
                  const t = readIf(P.state)
                  const next = /^\s*done\s*:/m.test(t)
                    ? t.replace(/^\s*done\s*:.*$/m, 'done: S' + prev)
                    : (t.trimEnd() + '\ndone: S' + prev + '\n')
                  if (writeAtomic(P.state, next)) {
                    event('state-autoset', { done: 'S' + prev, by: f })
                    log(`自动推进 done -> S${prev}（前台已读 ${f}）`)
                  }
                }
              }
            } catch { /* 推断失败不影响主流程 */ }
          }
          if (!ok && toolStats.failStreak === 1) {
            wakeBack('tool-fail', `【T2】前台工具 ${exec.name} 失败。请读 .board/state.md 与 heartbeat.log，判断是否需要调整计划。`)
          }
          // 重复动作（近似 H1；官方 repeat-tool-reminder 只管精确重复且只提醒）
          const key = exec.name + ':' + JSON.stringify(exec.arguments || {}).slice(0, 120)
          if (key === toolStats.lastSame) toolStats.sameCount++
          else { toolStats.lastSame = key; toolStats.sameCount = 1 }
          if (toolStats.sameCount === 4) wakeBack('stuck', `【H1】前台连续 4 次相同调用（${exec.name}），疑似打转。请给出脱困指令或改计划。`)
        } else if (isBack(exec.agent)) {
          // ★ M16 tick 事件化：后台一写完 steps 就立刻检查投递（原来只靠 30s 轮询）
          try { checkNewSteps() } catch { /* 忽略 */ }
        }
      } catch (e) { log('post-execute err: ' + e.message) }
      return next()
    })

    // ③ 轮末：前台清单耗尽 / 后台写了交付 → 终局
    yield ctx.on('agent/turn-stopping', async (payload) => {
      try {
        const { agent } = payload || {}
        if (!cfg.enabled) return
        if (isFront(agent)) {
          const st = readState()
          const steps = listSteps()
          const doneNo = stepNo(st.done || '')
          const maxNo = steps.length ? Math.max(...steps.map(stepNo)) : 0
          // 终局只问一次（#2 修复：无守卫会与催单互相点火）
          if (maxNo > 0 && doneNo >= maxNo && !hasDeliver() && !finalAsked) {
            finalAsked = true
            wakeBack('final', '【终局】前台已跑完清单最后一步，请做终局复核：若完成，写 .board/deliver.v1.md；若未完成，写下一批 .board/steps/S*.md。')
          }
          // ★ 终局正文兜底（实测事故：只写文件、回复一片废话、用户拿不到交付）
          if (maxNo > 0 && doneNo >= maxNo && !finalAnswerAsked) {
            const txt = lastAssistantText(agent)
            if (txt.replace(/\s/g, '').length < 60) {
              finalAnswerAsked = true
              event('final-answer-ask', { chars: txt.length })
              log('终局正文缺失（' + txt.length + ' 字）→ 要求前台补交付')
              setTimeout(() => {
                try {
                  front.followup(msg('【终局交付】你已跑完最后一步，但用户看不到结果。现在**用 ≤400 字直接回答**：①结论是什么 ②产出文件绝对路径 ③注意事项。不要调用任何工具，只写正文。'))
                } catch (e2) { log('final-answer ask fail: ' + e2.message) }
              }, 400)
            }
          }
        }
      } catch (e) { log('turn-stopping err: ' + e.message) }
    })

    // ④ 30s 轮询：机械哨兵 + 催单 + 新步骤投递 + 重新解析接线（兜底；实时投递见 fs.watch）
    const stepsWatcher = startStepsWatcher()
    yield () => { try { stepsWatcher && stepsWatcher.close() } catch { /* 忽略 */ } }
    yield ctx.setInterval(() => {
      const tickT0 = Date.now()
      try {
        if (!alive()) return        // ★ 旧实例（被热重载替换掉的）立即停摆，避免双实例叠加
        if (!cfg.enabled) return
        try { ensureLogsBounded() } catch { /* 轮转失败不影响主循环 */ }   // 日志无界增长治本
        resolveAgents()
        splitBatchFile()         // M19：后台的批量清单 → 拆成 steps/S<k>.md
        ensureRouteMilestones()  // ⑤ 自动补全：后台没写「## 里程碑」段时插件按 steps 补齐
        checkVerdict()           // B13 后台分诊否决：判为短任务则让前台自己做
        checkFireFile()          // 消防通道 ②③：外部/后台写 fire.md ⇒ 打断前台
        checkContextBudget().catch(() => {})   // 按角色的上下文守护（异步，不阻塞 tick）
        ensureWiring().catch(() => {})         // 接线自愈：重启后自动重建前后台
        checkFirstFrame()        // P1 慢模型兜底：首帧超时 → 让前台先做只读侦察
        // ★ pendingDeliver 兜底（2026-10-18）：投递曾因前台长时间 running + 重试预算耗尽
        //   而永久放弃（实测 watcher-fire 3 次但 step-delivered 为 0）。
        //   这里每 tick 只要还有"待投递"标记、且前台已空闲，就再试一次。
        if (pendingDeliver || deliverRetry > 0) {
          const frontBusyNow = front && front.phase && front.phase.kind === 'running'
          if (!frontBusyNow) {
            deliverRetry = 0
            pendingDeliver = false
            pendingDeliverLogged = false
          }
        }
        checkNewSteps()
        checkLookahead()
        // ★ Phase 2/3/4：咨询分析投递、里程碑复核、黑板归档（各自内部有守卫与节流）
        try { checkAnalysisDelivery() } catch { /* 忽略 */ }
        try { checkMilestoneReview() } catch { /* 忽略 */ }
        try { archiveBoardIfDone() } catch { /* 忽略 */ }
        try { cleanupWorkers() } catch { /* 忽略 */ }
        runSentinels()
        runBusinessSentinels()   // B12 业务哨兵（route.md 的机械条件）+ 命中则打断后台
        saveMetrics()            // B11 度量落盘
        const tickMs = Date.now() - tickT0
        if (tickMs > 50) event('tick-slow', { ms: tickMs })
      } catch (e) { log('interval err: ' + e.message) }
    }, cfg.sentinelIntervalMs)

    log('接线完成，监听器已挂')
  }, 'dsh-fast-react: core')

  // ── 给模型/面板用的只读自检工具 ────────────────────────────────────────
  // ★ 幂等注册：注入器热重载时，新实例可能在旧实例还没释放时执行 apply，
  //   直接 ctx.tools.register 会抛 "tool xxx is already registered" 并**中断 apply**
  //   （导致后续注册/监听 silently 不生效）。这里已存在就跳过。
  function safeRegister (def) {
    try {
      let exists = false
      try { exists = !!ctx.tools.get(def.name) } catch { /* get 不可用就继续试注册 */ }
      if (exists) { log(`工具 ${def.name} 已存在，跳过重复注册`); return }
      ctx.tools.register(def)
    } catch (e) {
      log(`注册工具 ${def.name} 失败: ${e.message}`)
    }
  }

  safeRegister({
    name: 'fr_status',
    description: '快速反应插件自检：前台/后台接线、黑板文件、计数与最近事件。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }],
    },
    execute: async () => {
      resolveAgents()
      return {
        board: boardDir,
        enabled: cfg.enabled,
        front: front ? { id: idOf(front), preset: presetOf(front), phase: front.phase?.kind } : null,
        back: back ? { id: idOf(back), preset: presetOf(back), phase: back.phase?.kind } : null,
        state: readState(),
        steps: listSteps(),
        heartbeats: readIf(P.heartbeat).trim().split('\n').filter(Boolean).length,
        tools: { total: toolStats.total, failStreak: toolStats.failStreak, failTotal: toolStats.failTotal },
        t3Blocked,
        wakes: wakeCount,
        recent: tailLines(P.events, 8),
      }
    },
  })

  safeRegister({
    name: 'fr_mode',
    description: '声明本任务的执行模式（第一个动作调用一次即可；不调用则按机械规则自动判型）。'
      + 'quick=速答(不编排、直接答) / consult=咨询(后台只做分析、不写步骤) / '
      + 'retrieval=检索(前台自己并行查、不惊动后台) / coding=编码(标准编排、后台写步骤)。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: MODE_KEYS, description: '模式 key' },
        reason: { type: 'string', description: '一句话理由（可选，便于排障）' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    execute: async (args) => {
      const key = String((args && args.mode) || '').trim()
      if (!MODE_KEYS.includes(key)) return { ok: false, error: `未知模式 ${key}；可选：${MODE_KEYS.join(', ')}` }
      return applyMode(key, 'agent', String((args && args.reason) || '模型声明'))
    },
  })

  safeRegister({
    name: 'fr_worker',
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
        if (!cfg.workersEnabled) return { ok: false, error: '只读 worker 未启用：配置 workersEnabled=true 后可用' }
        const task = String((args && args.task) || '').trim()
        if (!task) return { ok: false, error: 'task 不能为空' }
        if (!svcAgentLoop) return { ok: false, error: 'AgentLoop 不可用' }
        if (workers.size >= 2) return { ok: false, error: '并发 worker 已达上限（2）' }
        const id = 'session-fr-worker-' + Date.now().toString(36)
        try { mkdirSync(join(boardDir, 'workers'), { recursive: true }) } catch { /* 忽略 */ }
        const outFile = join(boardDir, 'workers', id + '.md')
        const route = routeFor('front')
        const ag = await svcAgentLoop.create(id, { provider: route.provider, model: route.model, reasoningEffort: 'low' }, { cwd: boardRoot })
        try { if (svcPresets) await svcPresets.mount(ag.ctx, cfg.agentPreset || 'standard') } catch { /* 忽略 */ }
        try {
          const tools = ag.ctx && typeof ag.ctx.get === 'function' ? ag.ctx.get('tools') : undefined
          if (tools && typeof tools.restrict === 'function') {
            const visible = (tools.schemas(ag) || []).map(x => x && x.name)
            const allow = ['read', 'glob', 'grep', 'read_image', 'web_fetch', 'web_search', 'present', 'write'].filter(n => visible.includes(n))
            const d = tools.restrict({ allow })
            if (typeof d === 'function') ag.__frWorkerDispose = d
          }
        } catch (e) { log('worker 工具限制失败: ' + e.message) }
        workers.set(id, { ag, at: Date.now(), out: outFile, done: outFile + '.done', task: task.slice(0, 80) })
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
    name: 'fr_poke',
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
      resolveAgents()
      const a = String(args.action)
      if (a === 'wake') {
        lastWakeAt = 0    // 手动不受冷却限制
        return { woke: wakeBack('manual', String(args.text || '【手动唤醒】请读 .board/state.md 与 heartbeat.log，继续。')) }
      }
      if (a === 'steer') {
        return { steered: steerFront(String(args.text || '【手动插话】请查看 .board/。'), 'manual') }
      }
      if (a === 'resolve') {
        // 归一化步号：守卫查的是 S<k>.ok（实测坑：传 4 会写成 4.ok，永远匹配不上）
        let id = String(args.step || '1').trim()
        if (/^\d+$/.test(id)) id = 'S' + id
        if (!/^S/i.test(id)) id = 'S' + id
        const ok = writeAtomic(join(P.confirmDir, `${id}.ok`), new Date().toISOString())
        event('t3-resolve', { step: id })
        return { resolved: ok, file: join(P.confirmDir, `${id}.ok`) }
      }
      if (a === 'pin') {
        // 手动指定前台/后台（写进 config.json 持久化；留空则该侧回到自动发现）
        const f = String(args.front || '').trim()
        const b = String(args.back || '').trim()
        cfg.frontSessionId = f
        cfg.backSessionId = b
        if (f && b) wire(f, b); else if (!f && !b) unwire(); else wire(f || undefined, b || undefined)
        briefed.clear()                       // 允许重新发简报
        const saved = saveOverrides()
        resolveAgents()
        event('pin', { front: f, back: b })
        return {
          saved,
          configFile: cfgFile,
          front: front ? { id: idOf(front), cwd: cwdOf(front), preset: presetOf(front) } : null,
          back: back ? { id: idOf(back), cwd: cwdOf(back), preset: presetOf(back) } : null,
          visibleAgents: (() => { try { return ctx.agents.list().map(x => ({ id: idOf(x).slice(0, 20), cwd: cwdOf(x) })) } catch { return [] } })(),
        }
      }
      if (a === 'config') {
        // 重读 .board/config.json（插件在 apply 时只读一次；改配置后不用重载插件）
        const before = JSON.parse(JSON.stringify(cfg))
        try {
          const fresh = JSON.parse(readIf(cfgFile)) || {}
          // ★ 必须同时更新 overrides（2026-10-17 实测坑）：
          //   只更新 cfg 而不更新 overrides ⇒ 之后任何 saveOverrides()（pin / autoHeal 写 sessionId）
          //   都会把内存里那份**旧的 overrides** 写回文件，把手工改的配置覆盖掉。
          overrides = Object.assign({}, overrides, fresh)
          Object.assign(cfg, fresh)
          resolveAgents()
          event('config-reload', { keys: Object.keys(cfg).length })
          return { reloaded: true, before, after: cfg, front: idOf(front), back: idOf(back) }
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
        for (const pair of [[front, 'front'], [back, 'back']]) {
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
        if (typeof FIRE !== 'function') return { error: '消防通道未就绪（插件正在重载）' }
        resolveAgents()
        return FIRE(front, 'manual', String(args.text || '紧急插入：立刻响应最新指令。').slice(0, 600))
      }
      if (a === 'cancel') {
        // 取消某个 agent 当前回合（消防通道实测用）；text='front' 取消前台，否则取消后台
        const which = String(args.text || 'back').toLowerCase() === 'front' ? 'front' : 'back'
        const target = which === 'front' ? front : back
        if (!target) return { error: 'target not wired: ' + which }
        try {
          target.cancel(new Error('manual cancel via fr_poke'))
          event('cancel', { which, id: idOf(target) })
          return { cancelled: which, id: idOf(target), phase: target.phase && target.phase.kind }
        } catch (e) { return { error: String(e && e.message || e) } }
      }
      if (a === 'reload') {
        seenSteps.clear()
        resolveAgents()
        return { reloaded: true, front: idOf(front), back: idOf(back) }
      }
      return { error: 'unknown action' }
    },
  })

  // ── 前台上交（T8）：写结构化 handoff 包 + 唤醒后台 ─────────────────────
  // ── 后台专用：结构化提交路线（参数 schema 由框架校验 ⇒ 格式不可能跑偏）────────
  safeRegister({
    name: 'fr_route',
    description: '提交路线（结构化）。调用后插件自动生成 route.md —— **不要自己 write route.md**。仅后台可调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'string', description: '一句话目标（≤100 字）' },
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
              group: { type: 'string', description: '可选：并行组名（同组表示互不依赖）' },
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
      required: ['goal', 'milestones'],
    },
    output: {
      schema: { type: 'object' },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
    },
    execute: async (args) => renderRoute(args || {}),
  })

  safeRegister({
    name: 'fr_escalate',
    description: '前台上交给后台：说清卡点、或对复杂任务请求路线规划。会写 .board/handoff.md 并唤醒后台。前台说不出下一个具体动作 / 连续失败 / 发现路线不对时调用。',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '一句话：为什么上交（缺规划 / 卡住 / 路线不对）' },
        goal: { type: 'string', description: '目标原文' },
        known: { type: 'string', description: '已知事实（路径 / 命令结果）' },
        tried: { type: 'string', description: '已尝试与结果' },
        stuck: { type: 'string', description: '当前卡点 / 不确定点' },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
    execute: async (args) => {
      resolveAgents()
      // ★ Phase 1 模式守卫：速答/检索模式不需要后台 ⇒ 拒绝上交，让前台自己完成
      const mi = modeNow()
      if (!mi.backend) {
        event('escalate-blocked-by-mode', { mode: mi.key, reason: String(args.reason || '').slice(0, 120) })
        return {
          ok: false,
          error: `当前模式「${mi.label}」不需要后台：请自己完成并交付（若确实需要编排，先把任务模式切到 coding：调用 fr_mode({mode:'coding'})）。`,
        }
      }
      const doc = [
        `# handoff ${new Date().toISOString()}`,
        '## 为什么上交', String(args.reason || ''),
        '## 目标', String(args.goal || '(未提供)'),
        '## 已知事实', String(args.known || '(未提供)'),
        '## 已尝试', String(args.tried || '(未提供)'),
        '## 卡点 / 不确定', String(args.stuck || '(未提供)'),
        '## state.md 快照', readIf(P.state).slice(0, 2000),
      ].join('\n\n')
      const ok = writeAtomic(join(boardDir, 'handoff.md'), doc)
      event('escalate', { reason: String(args.reason || '').slice(0, 140) })
      // ★ 新任务开始 ⇒ 重置本任务计数（否则 H5「步数超阈」会永久误报 —— 后台自己诊断出来的 bug：
      //   stepsThisTask 原来跨 v1/ab2/ab3/吞吐测试一直累加，从不清零）
      stepsThisTask = 0
      alertedSentinels.clear()
      cfg.batchSteps = DEFAULTS.batchSteps   // O2 自适应：新任务回到默认批量
      lastWakeAt = 0   // 显式上交不受冷却限制
      // ★ 首帧优化（2026-10-17）：把 handoff 内容**直接内联**进唤醒消息，
      //   后台不必再 read 一次 handoff.md ⇒ 省掉一整次响应（实测 ~3-5s）。
      let handoffBody = ''
      try { handoffBody = String(readIf(join(boardDir, 'handoff.md')) || '').slice(0, 1800) } catch { /* 忽略 */ }
      const woke = wakeBack('escalate',
        `【前台上交】${String(args.reason || '')}\n\n` +
        `===== 交接包（已内联，**不要再 read handoff.md**）=====\n${handoffBody}\n===== 交接包结束 =====\n\n` +
        '## 只做 1 件事，做完就停（禁止调研）\n' +
        '**调用一次 fr_route 工具**，一次给出：goal / acceptance / milestones / steps（+ 可选 sentinels）。\n' +
        '**steps 里先只写 2 个**（首帧要快），但 milestones 要写全 —— 插件会自动催你补剩余步骤。\n' +
        '插件会自动生成 route.md **并**写出 steps/S<k>.md —— 不需要你再 write 任何文件。\n' +
        '**上面已给你交接包**，不需要 read 任何文件。\n' +
        '**禁止**：跑 pwsh/bash、读 heartbeat、读源码、探索目录、调 fr_status、read handoff、单独 write 文件。\n' +
        '**你是规划者**：只写清「做什么」，不需要知道文件内容（留给前台执行）。\n' +
        '若交接包明显是「≤3 步无依赖」，只写 verdict.md 一行「short: <理由>」然后停。')
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

  // ══ B10 档位漂移 ═══════════════════════════════════════════════════════
  // DSH 的 agentDefaultModel 是**全局单例**（无 per-session 档位），无法给两个会话分别设 effort。
  // 折中：**在唤醒谁之前**把全局档位切到该角色应有的值。前提：同一时刻基本只有一个角色在跑。
  let curEffort = null
  async function setEffort (role) {
    if (!cfg.effortDrift) return
    try {
      const want = role === 'back' ? cfg.backEffort : cfg.frontEffort
      if (!want || want === curEffort) return
      const dm = ctx.agentDefaultModel
      if (!dm) return
      const sel = dm.currentSelection()
      if (!sel) return
      if (sel.reasoningEffort === want) { curEffort = want; return }
      await dm.saveSelection({ provider: sel.provider, model: sel.model, reasoningEffort: want })
      curEffort = want
      event('effort-switch', { role, effort: want })
      log('全局档位 -> ' + want + '（为 ' + role + '）')
    } catch (e) { log('setEffort fail: ' + e.message) }
  }

  // ══ B11 度量落盘 ═══════════════════════════════════════════════════════
  // 计数器是内存态，插件重载会归零；落盘后重载可续（补齐「状态可从黑板重建」）。
  const METRICS_FILE = join(boardDir, 'metrics.json')
  function saveMetrics () {
    try {
      writeAtomic(METRICS_FILE, JSON.stringify({
        toolStats, wakeCount, t3Blocked, finalAsked, stepsThisTask, at: new Date().toISOString(),
      }, null, 1))
    } catch { /* 静默 */ }
  }
  try {
    const m = JSON.parse(readIf(METRICS_FILE))
    if (m) {
      if (m.toolStats) Object.assign(toolStats, m.toolStats)
      if (m.wakeCount) { wakeCount.total = m.wakeCount.total || 0; wakeCount.byReason = m.wakeCount.byReason || {} }
      if (typeof m.t3Blocked === 'number') t3Blocked = m.t3Blocked
      if (typeof m.finalAsked === 'boolean') finalAsked = m.finalAsked
      // ★ 不恢复 stepsThisTask：它是「本任务」计数，插件重启 ⇒ 新运行时 ⇒ 必须归零。
      //   实测：重启后从 metrics 恢复成 245 ⇒ H5「步数超阈」立刻误报并白唤醒后台。
      stepsThisTask = 0
      log('度量已恢复 tools=' + toolStats.total + ' wakes=' + wakeCount.total + ' t3=' + t3Blocked + '（步数已归零）')
    }
  } catch { /* 首次运行 */ }
  saveMetrics()

  // ══ B12 业务哨兵（route.md 的机械条件）═════════════════════════════════
  // 契约（已写进 BACK_BRIEF）：route.md 的「## 哨兵条件」段，一行一条：
  //   - C1 | file-exists | <绝对路径>            （条件成立 ⇒ 路线作废）
  //   - C2 | file-absent | <绝对路径>
  //   - C3 | field-cmp   | <state字段> | >= | S<k>
  //   - C4 | grep-match  | <文件路径> | <子串>
  function readSentinels () {
    const t = readIf(P.route)
    // ★ 放宽标题匹配（2026-10-17 实测）：模型很自然地会写 `## 5. 哨兵条件（成立即路线作废）`
    //   ——带序号、带括号说明。原来只认 `## 哨兵条件` 会静默失效。
    const m0 = t.match(/^##[^\n]*哨兵条件[^\n]*$/m)
    if (!m0) return []
    const start = m0.index + m0[0].length
    const seg = t.slice(start).split(/\n##\s/)[0]
    const out = []
    for (const line of seg.split('\n')) {
      const m = line.match(/^\s*-\s*([A-Za-z0-9_-]+)\s*\|\s*([a-z-]+)\s*\|\s*(.+?)\s*$/)
      if (m) out.push({ id: m[1], kind: m[2], rest: m[3] })
    }
    return out
  }

  function evalSentinel (s) {
    try {
      const parts = s.rest.split('|').map(x => x.trim())
      if (s.kind === 'file-exists') return existsSync(parts[0]) ? ('文件存在 ' + parts[0]) : null
      if (s.kind === 'file-absent') return existsSync(parts[0]) ? null : ('文件缺失 ' + parts[0])
      if (s.kind === 'field-cmp') {
        const st = readState()
        const field = parts[0]; const op = parts[1]; const val = parts[2]
        const cur = String(st[field] === undefined ? '' : st[field])
        if (op === '>=') return stepNo(cur) >= stepNo(val) ? (field + '=' + cur + ' >=' + val) : null
        if (op === '==') return cur === val ? (field + ' ==' + val) : null
        if (op === '!=') return cur !== val ? (field + ' !=' + val) : null
        return null
      }
      if (s.kind === 'grep-match') {
        const file = parts[0]; const pat = parts[1]
        return (pat && readIf(file).indexOf(pat) >= 0) ? ('匹配 ' + pat) : null
      }
      return null
    } catch { return null }
  }

  let lastBizAlertKey = ''
  function runBusinessSentinels () {
    if (cfg.sentinelEnabled === false) return   // 总开关
    const list = readSentinels()
    if (!list.length) return
    // ★ 无任务时不跑业务哨兵（2026-10-18 实测事故：用户只发「你好」，
    //   上一轮任务遗留的 REPORT.md 让 C1「文件存在」反复命中 ⇒ 冻结前台。
    //   业务哨兵只该在**有活任务**时生效。
    try {
      const st0 = readState()
      const steps0 = listSteps()
      const doneNo0 = stepNo(st0.done || '')
      const maxNo0 = steps0.length ? Math.max(...steps0.map(stepNo)) : 0
      const busy = (front && front.phase && front.phase.kind === 'running') ||
                   (back && back.phase && back.phase.kind === 'running')
      if (!busy && !(maxNo0 > 0 && doneNo0 < maxNo0)) {
        lastBizAlertKey = ''
        return
      }
    } catch { /* 忽略 */ }
    const hits = []
    for (const s of list) { const why = evalSentinel(s); if (why) hits.push({ id: s.id, why }) }
    if (!hits.length) { lastBizAlertKey = ''; return }
    const key = hits.map(h => h.id).join(',')
    if (key === lastBizAlertKey) return       // 同一条只报一次，避免刷屏
    lastBizAlertKey = key
    for (const h of hits) { event('sentinel-biz', h); log('业务哨兵命中 ' + h.id + ': ' + h.why) }
    // 命中 ⇒ 后台正在想的那份计划已作废 → **打断它**（全架构唯一"打断收益为正"的场景）
    let cancelled = false
    if (back && back.phase && back.phase.kind === 'running') {
      try {
        back.cancel(new Error('route sentinel invalidated the in-flight plan'))
        cancelled = true
        event('interrupt-back', { why: key })
        log('已打断后台（业务哨兵 ' + key + '）')
      } catch (e) { log('interrupt back fail: ' + e.message) }
    }
    const wakeMsg = '【业务哨兵】' + hits.map(h => h.id + ' ' + h.why).join('；') +
      '。路线已作废，请读 .board/state.md 与 heartbeat.log 后重估 route.md。'
    // ★ 实测（2026-10-17）：cancel() 之后**立即** steer/followup 会抛
    //   "unreachable variant: {}"（状态机还没复位）⇒ 这次唤醒彻底丢失。所以延迟 ~1s 再唤醒。
    if (cancelled) {
      setTimeout(() => {
        try { if (!alive()) return; lastWakeAt = 0; wakeBack('sentinel', wakeMsg) } catch (e) { log('delayed wake fail: ' + e.message) }
      }, 1000)
    } else {
      lastWakeAt = 0
      wakeBack('sentinel', wakeMsg)
    }
    // ★ 同时冻结前台 + 作废未执行步骤（否则前台会把过时步骤继续跑完）
    //   注意：这里只能调用一次（2026-10-18 修：历史上重复写了两次，
    //   导致日志里 freeze 事件成对出现、步骤被连续作废两轮）
    freezeFront(hits.map(h => h.id + ' ' + h.why).join('；'))
  }

  log('插件已加载（apply 完成）')
}
