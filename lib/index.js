/**
 * @dsh-external/dsh-fast-react —— 快速反应插件（宿主半边，零构建 ESM）
 *
 * 目标：效率。前台（LOW）快答快做，后台（HIGH）逐条规划，两者只通过黑板交换信息。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ▍模块划分（v1.5.0）
 * ══════════════════════════════════════════════════════════════════════════
 *  本文件（index.js）是**装配层 + 状态机**：持有 apply() 的全部闭包状态，
 *  负责把下面这些纯逻辑模块串起来。真正的业务算法已经尽量下沉。
 *
 *    lib/board.js       黑板 IO（原子写 / 日志轮转 / state 解析 / steps 列表）
 *    lib/scheduler.js   调度核心（批量自适应 / 预取水位 / 里程碑复核 / 归档守卫）
 *    lib/modes.js       任务模式预设（5 种模式 + 判型引擎 v2 + 工具白名单）
 *    lib/sentinel.js    业务哨兵：route.md 哨兵段解析 + 求值（纯函数，可单测）
 *    lib/route-plan.js  fr_route 纯逻辑：参数校验 / 里程碑截断 / 哨兵预检 / 渲染
 *    lib/briefs.js      前后台角色简报（纯文本模板）
 *    lib/defaults.js    默认配置与黑板根解析（多环境可移植）
 *    lib/policies.js    破坏性命令 / 关键唤醒原因的常量表
 *    lib/api.js         HTTP 路由（控制台 / 便捷 API / 侧边栏注入）
 *    lib/messages.js    消息构造
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ▍apply() 内的区块地图（按出现顺序）
 * ══════════════════════════════════════════════════════════════════════════
 *   L~97   配置加载（boardRoot/config.json 覆盖默认值）
 *   L~101  多实例身份（instanceTag → 前缀 / 路由基路径 / 黑板根 全部参数化）
 *   L~289  B1 黑板 IO 代理（实际实现在 board.js）
 *   L~324  B2 接线：识别前台 / 后台（含接线自愈、健康检查）
 *   L~694  通道：唤醒后台（wakeBack）/ steer 前台 / 干扰预算
 *   L~1040 Phase2 调度器接入
 *   L~1082 B3 heartbeat 合成 + steps→todo 单向镜像
 *   L~1198 僵死看门狗
 *   L~1274 B4 T3 拦截（破坏性命令）
 *   L~1285 B7 机械哨兵（零 LLM）+ 命中即冻结前台
 *   L~1381 B5 催单 lookahead
 *   L~1395 P1 首帧超时兜底
 *   L~1431 接线自愈
 *   L~1529 会话挂载到 Workspace（侧边栏可见）
 *   L~1629 会话组注册表（FR-01…）
 *   L~1653 权限预设
 *   L~1695 上下文守护（按角色限流）
 *   L~1738 **实时投递**（fs.watch，首帧杀手：文件落盘即投递）
 *   L~1860 **fr_route 工具**（结构化路线提交，含 plan/append 双模式）
 *   L~2170 B6 新步骤到达 → steer 前台
 *   L~2178 M19 批量步骤清单拆分
 *   L~2515 对外 API 装配
 *   L~3478 侧边栏 loader
 *   L~3520 独立页面注册
 *   L~3537 装配：effect + 全部监听器
 *   L~4181 自检工具（fr_status 等）
 *   L~4279 **全局入口工具**（fr_task / fr_status / fr_brake —— 任意会话可用）
 *   L~4419 **内部角色工具**（fr_escalate / fr_route 等 —— 仅 fr 会话可见，scope 注册）
 *   L~4859 B10 思考档位漂移
 *   L~4880 B11 度量落盘
 *   L~4905 B12 业务哨兵（route.md 的机械条件）
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ▍关键机制速查
 * ══════════════════════════════════════════════════════════════════════════
 *   判型三档    score>=6 → coding / <=3 → quick / 中间灰区 ⇒ quick + 并行分诊
 *   强制上交    coding 模式下前台必须 fr_escalate（6/12 工具处还会催）
 *   可升级      quick 模式下前台主动上交 ⇒ 自动切 coding
 *   首帧优化    steps 落盘 fs.watch 立即投递，不等 30s tick
 *   缺口闭环    ms > steps ⇒ 催后台补步（最多 3 次/缺口）
 *   归档守卫    milestone 数 > 步骤数时拒绝归档，防"任务没做完就收工"
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, renameSync, statSync, watch, unlinkSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { makeRoutes, tailLines } from './api.js'
import { parseSentinels, evalSentinel as evalSentinelPure } from './sentinel.js'
import { validateRouteArgs, capMilestones, filterSentinels as filterSentinelsPure, buildRouteMarkdown } from './route-plan.js'
import { DEFAULT_MODE, MODE_KEYS, modeInfo, detectMode, shouldOrchestrate, describeTendency, allowListFor, modeNotice, briefFragment, adaptBatch, extractPaths, isDeniedTool } from './modes.js'
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
// ── 多实例（2026-11-07）─────────────────────────────────────────────────
// 同一插件包可以被挂载多次（每个实例一份黑板 + 一份前后台），
// 所以模块级的「代际」「FIRE」都不能是全局单例——否则后启动的实例会把先启动的判死。
// 键 = 实例 tag（config.instanceTag，默认 'a'）；值是各自的代际/句柄。
const GEN_BY_TAG = new Map()
const FIRE_BY_TAG = new Map()

// ── effort 兼容性黑名单（2026-11-07，失败即学）────────────────────────────
// 原来只靠模型名前缀猜（NO_EFFORT_RE），但**同一模型在不同渠道可能行为不同**
//（实测 trae/deepseek-v4.1-flash 报 "does not support reasoning effort low"）。
// 现在：任何一次该错误都记进这个集合，后续不再给该 route 传 effort。
const NO_EFFORT_ROUTES = new Set([
  // 已知：trae 渠道的 deepseek-v4.1-flash 不接受 reasoningEffort（2026-10-23 首次观测）
  'trae/deepseek-v4.1-flash',
])
// 落盘位置：重启后仍记得学过哪些 route 不支持 effort
const EFFORT_LEARNED_FILE = (() => {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    return join(home, 'super-injector', 'effort-learned.json')
  } catch { return '' }
})()
function loadEffortLearned () {
  try {
    if (!EFFORT_LEARNED_FILE || !existsSync(EFFORT_LEARNED_FILE)) return
    const arr = JSON.parse(readFileSync(EFFORT_LEARNED_FILE, 'utf8'))
    if (Array.isArray(arr)) for (const k of arr) if (typeof k === 'string' && k) NO_EFFORT_ROUTES.add(k)
  } catch { /* 忽略 */ }
}
function saveEffortLearned () {
  try {
    if (!EFFORT_LEARNED_FILE) return
    mkdirSync(dirname(EFFORT_LEARNED_FILE), { recursive: true })
    writeFileSync(EFFORT_LEARNED_FILE, JSON.stringify([...NO_EFFORT_ROUTES], null, 1), 'utf8')
  } catch { /* 忽略 */ }
}
loadEffortLearned()

/** 消防通道入口：在 apply() 内按 tag 赋值（fr_poke 的工具作用域通过 getFire 取） */
const getFire = (tag) => FIRE_BY_TAG.get(tag) || null
const setFire = (tag, fn) => { FIRE_BY_TAG.set(tag, fn) }

export function apply(ctx, userConfig = {}) {
  const cfg0 = { ...DEFAULTS, ...(userConfig || {}) }
  const TAG = String(cfg0.instanceTag || 'a')       // ★ 实例身份：a / b / c…
  const MY_GEN = (GEN_BY_TAG.get(TAG) || 0) + 1
  GEN_BY_TAG.set(TAG, MY_GEN)
  const alive = () => GEN_BY_TAG.get(TAG) === MY_GEN
  // ── 配置：<board>/config.json 覆盖默认值（cfg0 已在上方算好，保持单一来源）──
  const cfg = cfg0
  const boardRoot = cfg.boardRoot

  // ── 多实例身份（2026-11-07）──────────────────────────────────────────
  // ★ 必须定义在 apply 作用域（resolveAgents 只是消费者）。
  //   之前误放在 resolveAgents 内部 ⇒ 外层 20+ 处引用直接 ReferenceError ⇒ apply 抛错、路由不注册。
  /** 工具名：实例 a 沿用 fr_xxx；其它实例为 fr_xxx_<tag> */
  const TN = (base) => (TAG === 'a' ? base : base + '_' + TAG)
  /** 路由基路径：a = /fr（旧 URL）；其它 = /fr_<tag> */
  const BASE_PATH = TAG === 'a' ? '/fr' : '/fr_' + TAG
  /** 会话前缀：a = session-fr-；其它 = session-fr-<tag>- */
  const SESSION_PREFIX = TAG === 'a' ? 'session-fr-' : ('session-fr-' + TAG + '-')

  /** 角色档位：前台低档求快、后台最高档求质量。
   *  ★ DSH 0.2.1 起不再把全局 reasoningEffort 自动带给新会话（实测前台变 high、后台未设），
   *    所以创建会话时必须显式传，否则"思考强度"会乱。 */
  /** 这些渠道/模型不接受 reasoningEffort 参数（传了会 400：does not support reasoning effort） */
// ★ DeepSeek 官方支持的 effort 是 off/low/high/max（见 dsh-llm-deepseek 的 schema）；
//   它**支持关闭思考**，对应值 'off'，不是 'minimal'。
//   'minimal' 只在少数 provider 有效 ⇒ 全局不再使用，改用 'off' 表达"极速反射"。
const NO_EFFORT_RE = /^(hy\d|glm|kimi|minimax|step-|space-bunny|mimo|jin|dots-|nemotron|liquid\/|cohere\/|poolside\/|reflection\/|recursive\/|xingchen)/i
const effortFor = (tag) => {
  // ★ 注意：本函数定义在 routeFor 之前（TDZ），不能调 routeFor；直接读 cfg 判断模型
  const mo = String((tag === 'back' ? (cfg.backModel || cfg.model) : (cfg.frontModel || cfg.model)) || '')
  const prov = String((tag === 'back' ? (cfg.backProvider || cfg.provider) : (cfg.frontProvider || cfg.provider)) || '')
  const raw = _effortForRaw(tag, mo, prov)
  return raw === undefined ? undefined : normalizeEffort(raw, prov)
}

function _effortForRaw (tag, mo, prov) {
  // 先查「运行时学到的」不支持清单（优先级高于前缀猜测）
  try {
    if (NO_EFFORT_ROUTES.has(prov + '/' + mo)) {
      try { vlog('effort', { tag, model: mo, provider: prov, effort: 'skipped-learned' }) } catch { /* 忽略 */ }
      return undefined
    }
  } catch { /* 忽略 */ }
  if (NO_EFFORT_RE.test(mo)) {
    // 这些模型不接受 reasoningEffort：不传，但留痕（否则"极速反射"看起来生效、实际是空操作）
    try { vlog('effort', { tag, model: mo, effort: 'skipped-unsupported' }) } catch { /* 忽略 */ }
    return undefined
  }
  // ★ 性能档位（2026-11-07）：tier 优先于各角色 effort
  //   ★ 2026-11-07 修正：'minimal'/'medium' 不是所有 provider 的合法值。
  //   DeepSeek 官方只认 off/low/high/max。用 'off'（关闭思考）表达极速。
  try {
    const tier = String(cfg.tier || 'balanced')
    if (tier === 'speed') return tag === 'back' ? 'low' : 'off'
    if (tier === 'max') return tag === 'back' ? 'max' : 'high'
  } catch { /* 忽略 */ }
  if (tag === 'back') return cfg.backEffort || 'max'
  // ★ 极速反射（2026-11-07）：模式可以覆盖前台档位（quick ⇒ minimal）。
  //   优先级：模式预设 > 全局 frontEffort > 'low'。
  //   activeMode 在此函数被调用时（建会话/重建）早已初始化；try 兜住初始化早期。
  try {
    const m = modeInfo(activeMode)
    if (m && m.frontEffort) return m.frontEffort
  } catch { /* activeMode 未初始化 */ }
  return cfg.frontEffort || 'low'
}

/**
 * effort 归一化（2026-11-07）：把内部档位名映射到该 provider 实际接受的值。
 * - DeepSeek 官方：off / low / high / max（**支持 off = 关闭思考**）
 * - 其它（含未声明的）：low / high / max
 * 规则：'off' 在非 DeepSeek 上降级为 'low'；'minimal' 一律当 'off' 处理。
 */
function normalizeEffort (raw, provider) {
  if (!raw) return raw
  const v = String(raw).toLowerCase()
  const want = v === 'minimal' ? 'off' : v
  const isDeepSeek = /deepseek/i.test(String(provider || ''))
  if (want === 'off') return isDeepSeek ? 'off' : 'low'
  if (want === 'medium') return 'low'
  return want
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
  // ★ 2026-11-07：提在 resolveAgents 之前声明（会话 id 需在判脏前保留，用于 resume 复活）
  const pendingRevive = { front: '', back: '' }   // 待复活（热重载后旧会话从内存消失但磁盘还在）
  // ★ 2026-11-07：提到 resolveAgents 之前声明（否则 reapplyToolPolicyIfNeeded 触发 TDZ，
  //   apply 直接抛 ReferenceError ⇒ 整插件不接线，历史事故同款）。
  const modeDisposers = { front: null, back: null }
  const policyAgentId = { front: '', back: '' }   // 记录白名单挂到哪个 agent 上（重建后需重挂）
  // ★ 只把「用户显式写过的键」持久化（原实现把展开后的全量 cfg 写回 ⇒ 旧默认值被固化，
  //   以后改默认值会被旧 config 覆盖；实测踩过一次：effortDrift 复活并把全局 effort 压低）。
  let overrides = {}
  const droppedOnce = new Set()   // 本次保存要从盘上显式删除的键（解绑用；见 saveOverrides）
  try {
    if (existsSync(cfgFile)) {
      overrides = JSON.parse(readFileSync(cfgFile, 'utf8')) || {}
      // ★ 多实例（2026-11-07）：实例身份/黑板位置**只认本次挂载传入的 config**，
      //   绝不被盘上的旧值覆盖 —— 否则第二个实例会读到第一个实例的 boardRoot，
      //   还会把自己的 instanceTag 写成 'a'（两个实例互相污染）。
      const PINNED = ['instanceTag', 'boardRoot']
      const pinned = {}
      for (const k of PINNED) if (userConfig && userConfig[k] !== undefined) pinned[k] = userConfig[k]
      Object.assign(cfg, overrides, pinned)
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
      // 实例身份与黑板位置不是"运行时设置"，不落盘（避免两实例互相覆盖）
      delete disk.instanceTag
      delete disk.boardRoot
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

  // ── 详细日志（可开关，2026-11-07）──────────────────────────────────────
  // 只写盘、不参与任何判断、不进模型上下文。用途：量化"某个机制到底省了多少"，
  // 以及复现误冻结/误唤醒时能拿到逐条证据。
  // 开启：POST /fr/api/config {"verboseLog": true}（或写进 .board/config.json）
  const vlogFile = join(boardDir, 'detail.jsonl')
  const VLOG_MAX_BYTES = 8 * 1024 * 1024
  const vlog = (kind, data) => {
    if (!cfg.verboseLog) return
    try {
      mkdirSync(dirname(vlogFile), { recursive: true })
      try { if (statSync(vlogFile).size > VLOG_MAX_BYTES) renameSync(vlogFile, vlogFile + '.1') } catch { /* 不存在/轮转失败 */ }
      const row = { at: new Date().toISOString(), kind, ...(data && typeof data === 'object' ? data : { v: data }) }
      appendFileSync(vlogFile, JSON.stringify(row) + '\n')
    } catch { /* 详细日志永不阻断主流程 */ }
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
    // ★ 多实例（2026-11-07）：只认「本实例前缀」的会话，避免两个实例互抢。
    //   实例 a（默认）沿用旧前缀 session-fr-（不破坏历史会话）；b/c… 用 session-fr-<tag>-
    // ★★ 2026-11-07 递归环 2 修复：前缀之后只许 <key>-front- / <key>-back- / front- / back-。
    //   事故原理：worker 会话 id 是 session-fr-worker-<ts>，原实现只判前缀 ⇒ isFrSession 返回 true
    //   ⇒ 自动发现可能把 worker 当成前台/后台接线 ⇒ 只读 worker 反而拿到 fr_escalate，
    //   能写 handoff 并唤醒真正的后台（越权驱动编排 + 无限递归入口）。
    //   ⚠️ 必须同时容纳**会话组**与会话——会话和组会话两种 id 形态：
    //     默认会话：session-fr-front-<ts>        → rest = front-<ts>
    //     组会话  ：session-fr-01-front-<ts>     → rest = 01-front-<ts>
    //   所以不能只写 ^(front|back)-（那会把组会话全排除 ⇒ 会话组整组失联）。
    //   worker 从**最前面**排除，避免 worker-front-x 这种形态被误判。
    const isFrSession = (a) => {
      try {
        const id = String(idOf(a))
        if (!id.startsWith(SESSION_PREFIX)) return false
        const rest = id.slice(SESSION_PREFIX.length)
        if (/^worker-/.test(rest)) return false                       // worker 永远不是编排会话
        // ★ 跨实例隔离：实例 a 的前缀是"最短"的，会把 session-fr-b-front-x 也当成自己的
        //   （b-front-x 恰好符合「组前缀-front」形态）。这里按实例标签显式排除。
        if (TAG === 'a' && /^[b-z]-/.test(rest)) return false
        if (/^(front|back)-/.test(rest)) return true                  // 默认会话
        return /^[a-z0-9]{1,8}-(front|back)-/.test(rest)              // 会话组（01-front-x）
      } catch { return false }
    }
    // ① 显式 sessionId（但必须仍是 fr 会话；否则视为脏数据丢弃）
    const wantedF = cfg.frontSessionId
    const wantedB = cfg.backSessionId
    // ★★ 2026-11-07 重载风暴根因：区分「会话真的没了」和「服务还没就绪」。
    //   事故链：每次插件重载 → agentLoop 刚注入、ctx.agents.list() 还是空（或还没列出旧会话）
    //   → 这里把**仍然存活**的前后台判成"脏数据" → wire-dirty-drop → wire-cleared →
    //   ensureWiring 新建两个会话。
    //   实证：7 次重载产生了 14 个会话，工作区累计 163 条引用（这就是"为什么列表里
    //   显示了这么多快速反应工作区"的真正源头）。
    //   判据：list 为空 / 完全找不到该 id 时，若「服务还没就绪」，不下"脏"结论，只是暂时不接线；
    //         等 agentLoop 就绪后的下一次 resolveAgents 再解析（那时旧会话仍在）。
    const svcReady = !!(svcAgentLoop && svcPresets)
    const listHasAnyone = Array.isArray(list) && list.length > 0
    // 服务未就绪 且 磁盘上本来有接线 ⇒ 本轮整体"暂缓"：不发现、不清空、不重建
    const deferred = (!svcReady || !listHasAnyone) && !!(wantedF || wantedB)
    front = (wantedF && byId(wantedF) && isFrSession(byId(wantedF))) ? byId(wantedF) : null
    back = (wantedB && byId(wantedB) && isFrSession(byId(wantedB))) ? byId(wantedB) : null
    if (wantedF && !front) {
      if (!svcReady || !listHasAnyone) {
        // 服务未就绪 ⇒ 暂缓判定（保留 cfg 里的接线，下次再试）
        event('wire-deferred', { role: 'front', id: wantedF, svcReady, listCount: (list || []).length })
      } else {
        // ★★ 2026-11-07：**判脏之前先登记复活**。
        //   实测：热重载销毁内存会话，但磁盘日志还在，agentLoop.resume(旧id) 能带回来（id 不变）。
        //   若直接判脏 → wire-cleared → cfg 被清空 → 之后想 resume 已拿不到旧 id ⇒ 只能新建。
        pendingRevive.front = wantedF
        event('wire-revive-queued', { role: 'front', id: wantedF })
      }
    }
    if (wantedB && !back) {
      if (!svcReady || !listHasAnyone) {
        event('wire-deferred', { role: 'back', id: wantedB, svcReady, listCount: (list || []).length })
      } else {
        pendingRevive.back = wantedB
        event('wire-revive-queued', { role: 'back', id: wantedB })
      }
    }
    // ② preset 兜底（同样只认 fr 会话）
    if (!front && !deferred) { const p = byPreset(cfg.frontPreset); if (p && isFrSession(p)) front = p }
    if (!back && !deferred) { const p = byPreset(cfg.backPreset); if (p && isFrSession(p)) back = p }
    // ③ 自动发现：**只从 fr 会话里挑**，按创建时间排序取最早两个
    //   ★ 暂缓时**不发现**（否则会凭空捡到别的会话并焊死接线，正是历史事故的形态）
    if ((!front || !back) && !deferred) {
      // ★★ 2026-11-07 自动发现改为**择优**，不再是"最早两个"：
      //   事故：hotfix 之前遗留的会话（工具面被旧实例的 restrict 锁死，只剩 9 个工具）
      //   永远排在最早位置 ⇒ 一旦接线断开，自动发现会把**残废会话**捡回来当前台。
      //   实测 id 排序：session-fr-back-mw650iiw / mw63x2cm 都排在新会话之前。
      //
      //   新策略：
      //     ① 候选仍然只认 fr 会话 + 本黑板 cwd（安全边界不变）
      //     ② **排除明显不健康的**：可见工具数 < 5 的（正常至少 14）
      //     ③ 按创建时间**倒序**取最新的，宁可新建也不用残废的
      const frList = list
        .filter(a => isFrSession(a))
        .filter(a => norm(cwdOf(a)) === norm(boardRoot))
        .filter((a) => {
          try {
            const tools = a.ctx && typeof a.ctx.get === 'function' ? a.ctx.get('tools') : undefined
            const n = (tools && typeof tools.schemas === 'function' ? tools.schemas(a) : []).length
            return n >= 5            // 残废会话（工具面被收窄）不参与自动接线
          } catch { return true }
        })
        .sort((a, b) => bornOf(b).localeCompare(bornOf(a)))   // 倒序：最新优先
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
    } else if (!deferred && (cfg.frontSessionId || cfg.backSessionId) && (!front || !back)) {
      // 接线不完整/不合法 ⇒ 清掉脏记录，让 ensureWiring 干净重建
      // ★ 暂缓时**不清空**：磁盘接线先保留，等 agentLoop 就绪后重试（避免重载风暴）
      if (cfg.frontSessionId && !front) wire('', cfg.backSessionId || '')
      if (cfg.backSessionId && !back) wire(cfg.frontSessionId || '', '')
      event('wire-cleared', { reason: 'invalid-or-missing' })
    } else if (deferred) {
      event('wire-deferred-cleared', { front: wantedF || '', back: wantedB || '' })
    }
    // ★★ 2026-11-07 健康自检：接线的会话可能带着**上一个插件实例**挂的 restrict
    //   （那个 disposer 随旧实例销毁，无法解除）⇒ 工具面永久残缺，重挂也救不回。
    //   实测 mw63x2cm 卡在 9 个工具（正常 17），却是 cfg 里的前台，整天被 resume 捡回来。
    //   策略：接线确定后校验工具数；不达标就解除接线（不 cancel，先留着让用户看日志），
    //   下一次 ensureWiring 会走新建路径换一个健康会话。
    //   ⚠️ 只在**已有接线**且工具数异常时才动手，避免干扰正常流程。
    try {
      const wantF = allowListFor(currentMode(), 'front').length
      const wantB = allowListFor(currentMode(), 'back').length
      for (const [role, ag, wantN] of [['front', front, wantF], ['back', back, wantB]]) {
        if (!ag || !wantN) continue
        let got = 0
        try {
          const tt = ag.ctx && typeof ag.ctx.get === 'function' ? ag.ctx.get('tools') : undefined
          got = (tt && typeof tt.schemas === 'function' ? tt.schemas(ag) : []).length
        } catch { continue }
        if (got > 0 && got < Math.max(5, Math.floor(wantN * 0.8))) {
          event('wire-unhealthy', { role, id: idOf(ag), got, want: wantN })
          log(`接线会话不健康：${role} 仅 ${got}/${wantN} 工具（旧实例 restrict 残留）⇒ 解除接线，下一轮重建`)
          if (role === 'front') front = null; else back = null
          if (role === 'front' && cfg.frontSessionId) wire('', cfg.backSessionId || '')
          if (role === 'back' && cfg.backSessionId) wire(cfg.frontSessionId || '', '')
        }
      }
    } catch { /* 健康自检失败不影响主流程 */ }

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
    // ★★ 2026-11-07 工具面重挂（修 bug：restrict 是**会话级内存态**，
    //   会话被 autoheal/api-rebuild 重建后白名单丢失，探针实测前/后台各可见 68 个工具
    //   —— 即 dev_* / hindsight_* / subagent / workflow 全都可见，与设计严重不符）。
    //   原实现只在 applyMode 里挂一次；applyMode 的"同模式去重"分支会直接 return，
    //   重建后根本不会被再次调用。这里按「当前 agent 尚未挂过」补挂，幂等。
    try { reapplyToolPolicyIfNeeded() } catch (e) { log('工具面重挂失败: ' + e.message) }
  }

  /**
   * 给**单个** agent 挂工具白名单（幂等，不依赖 front/back 全局变量）。
   * ★ 2026-11-07：抽出来的原因 —— 会话一创建就必须立刻挂上。
   *   原来只有 applyToolPolicy（要求 front/back 已经赋值）和 reapplyToolPolicyIfNeeded
   *   （要求 resolveAgents 跑过）两条路，都晚于"会话已经可被调用"的时刻。
   *   autoheal / rebuildSessions 创建完会话后立刻调这个，窗口 = 0。
   */
  function attachToolPolicyFor (role, ag) {
    if (!ag) return { skipped: 'no-agent' }
    const id = idOf(ag)
    // ★★ 2026-11-08 方案 B：先注册 fr 工具到本 agent scope，再挂 restrict。
    //   顺序很重要：restrict 只限制**全局**工具，scope 注册的工具始终可见
    //   （契约："Restrictions intersect; scoped registrations remain visible."）。
    //   所以必须先把 fr_* 注册进 scope，再 restrict 普通工具，两者才都生效。
    try { registerFrToolsTo(ag, role) } catch (e) { log('注册 fr 工具到 scope 失败: ' + (e && e.message || e)) }
    // 同一会话且 disposer 仍在 ⇒ 先不急着跳过，要看**实际状态是否已经正确**。
    // ★ 2026-11-07：原实现只要 (同 id + 有 disposer) 就直接 skip，
    //   于是"上一次挂出了错误结果（如只剩 9 个）"的会话永远得不到纠正。
    //   改为：只有当可见集与目标集合基本一致时才 skip。
    if (policyAgentId[role] === id && modeDisposers[role]) {
      try {
        const tt = ag.ctx && typeof ag.ctx.get === 'function' ? ag.ctx.get('tools') : undefined
        const nowVisible = new Set((tt && typeof tt.schemas === 'function' ? tt.schemas(ag) : []).map(t => t && t.name).filter(Boolean))
        const wantNow = allowListFor(currentMode(), role).map((n) => (String(n).startsWith('fr_') ? TN(n) : n))
        const miss = wantNow.filter(n => !nowVisible.has(n))
        if (miss.length === 0) return { skipped: 'already-ok' }
        // 否则继续往下重挂（状态不对就得纠正）
      } catch { return { skipped: 'already' } }
    }
    const hadRestrict = typeof modeDisposers[role] === 'function' || policyAgentId[role] === id
    if (typeof modeDisposers[role] === 'function') { try { modeDisposers[role]() } catch { /* 忽略 */ } }
    modeDisposers[role] = null
    const want = allowListFor(currentMode(), role).map((n) => (String(n).startsWith('fr_') ? TN(n) : n))
    try {
      const sctx = ag.ctx
      const tools = sctx && typeof sctx.get === 'function' ? sctx.get('tools') : undefined
      if (!tools || typeof tools.restrict !== 'function') { policyAgentId[role] = id; return { skipped: 'no-tools' } }
      const visible = new Set((tools.schemas(ag) || []).map(t => t && t.name).filter(Boolean))
      // ★★ 2026-11-07 自我固化修复（第二版）：
      //   tools.schemas(ag) 在**已挂过 restrict** 的会话上返回的是"被限制后"的投影
      //   ⇒ allow = want ∩ visible 会把上一次的限制当事实，越收越窄。
      //   实测：front 会话 before=9、直授一次仍是 9，永远回不到 17。
      //
      //   ⚠️ 关键：这个 restrict 是**跨插件实例**残留的——
      //   上一版插件实例挂的 restrict，在热重载后本实例的 modeDisposers 是 null，
      //   所以 hadRestrict 无法感知（实测 direct:false）。只能靠"visible 明显偏小"识别。
      //
      //   判据：visible 里**没有**本角色白名单中确定该有的核心工具（如 read/write/bash），
      //   说明当前投影是被收窄过的，不能当全集。此时直授 want。
      //   反向保护：首个挂载时 visible 是真实全集，含 read/write，因此不会误判。
      // 判据：**want 中本该有、但 visible 里没有的项**说明投影被收窄过。
      //   注意不能用"核心工具是否存在"来判断——实测 before=9 时 read/write/bash 都在，
      //   少的是 fr_*，coreSeen=7 依然健康，检测不到。
      //   正确判据：want -. visible 的差集非空（且差集里全是"我们确信该有"的工具）。
      //   反向保护：首个挂载时 visible 是真实全集，差集只可能是"本机未安装该工具"
      //   （例如没装 pwsh），此时求交结果本来就对 —— 直授也无害，因为 restrict 忽略不存在的名字。
      // ★★ 2026-11-08 修复：restrict 的 allow **只能含全局工具名**。
      //   契约原文：restrict "Empty filters, unknown names, **scope-local names**, and
      //   reserved transport names fail." —— fr_* 现在注册在 agent scope 里，
      //   再放进 allow 会让整个 restrict 抛错（实测：names unknown global tool "fr_status"...），
      //   结果是 restrict 完全没挂上，工具面停在 67/64。
      //   而 scope 注册的工具本来就一直可见，不需要（也不能）靠 restrict 放行。
      const wantGlobal = want.filter(n => !/^fr_/.test(n))
      const missingFromVisible = wantGlobal.filter(n => !visible.has(n))
      const looksNarrowed = hadRestrict || missingFromVisible.length > 0
      let allow
      if (looksNarrowed) {
        allow = wantGlobal                // 直授：绕开"被自己（或上一实例）收窄过"的投影
      } else {
        allow = wantGlobal.filter(n => visible.has(n))
      }
      if (!allow.length) { policyAgentId[role] = id; return { skipped: 'none-visible', before: visible.size } }
      const dispose = tools.restrict({ allow })
      if (typeof dispose === 'function') modeDisposers[role] = dispose
      policyAgentId[role] = id
      event('tool-policy-rearm', { role, agent: id.slice(-10), before: visible.size, after: allow.length, direct: looksNarrowed, missing: missingFromVisible.length })
      log(`工具面挂载: ${role} ${visible.size} → ${allow.length}${looksNarrowed ? `（直授，visible 缺 ${missingFromVisible.length} 项）` : ''}`)
      return { before: visible.size, after: allow.length, direct: looksNarrowed }
    } catch (e) {
      log(`工具面挂载 fail ${role}: ` + e.message)
      return { error: String(e && e.message || e).slice(0, 120) }
    }
  }

  /**
   * 幂等补挂：只给"还没挂过/已被替换"的 agent 挂。
   * 不用 applyMode() 是因为它会重写 mode.md、重发模式说明（噪音且破坏 prefix cache）。
   */
  function reapplyToolPolicyIfNeeded () {
    for (const [role, ag] of [['front', front], ['back', back]]) {
      if (!ag) continue
      attachToolPolicyFor(role, ag)
    }
  }

  /** B14 路由跟随（省钱）：把会话的 provider/model 同步到全局默认。
   *  实测（2026-10-17）：Agent.options 在会话创建时钉死，用户切到免费模型后旧会话仍在烧付费 API；
   *  且 options **可写** ⇒ 这里每次解析接线时同步一次。 */
  function syncRoute (agent, role) {
    if (!agent) return
    // ★ 显式配置优先：先于 followGlobalRoute 判断，否则关掉"跟随全局"时守卫根本跑不到
    {
      const ep = role === 'front' ? (cfg.frontProvider || '') : (cfg.backProvider || '')
      const em = role === 'front' ? (cfg.frontModel || '') : (cfg.backModel || '')
      if (ep && em) {
        const o0 = agent.options
        if (!o0 || o0.provider !== ep || o0.model !== em) {
          if (o0) { o0.provider = ep; o0.model = em } else { agent.options = { provider: ep, model: em } }
          event('route-pinned', { role, to: ep + '/' + em })
          log('路由钉住 ' + role + ' -> ' + ep + '/' + em + '（显式配置优先）')
        }
        return
      }
    }
    if (!cfg.followGlobalRoute) return
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

  /** ★ 2026-11-07：把文本里的 fr_* 工具名换成**本实例**的名字（a 实例原样返回）。
   *  多实例下本实例注册的是 fr_escalate_b，若简报/模式说明里仍写 fr_escalate，
   *  模型会去调一个不存在的工具 ⇒ 白白浪费一步。
   *  ⚠️ 原实现只在 brief() 里内联做了这件事，applyMode 注入的 modeNotice **漏了**，
   *  而 modeNotice 里恰好有 fr_escalate / fr_mode / fr_worker 三处。 */
  function localizeToolNames (text) {
    if (TAG === 'a' || !text) return text
    // 长的先替换，避免 fr_mode 被 fr_mode_x 的前缀匹配干扰（这里都是固定表，简单替换即可）
    for (const n of ['fr_escalate', 'fr_route', 'fr_status', 'fr_worker', 'fr_poke', 'fr_mode']) {
      text = text.split(n).join(TN(n))
    }
    return text
  }

  function brief (agent, role) {
    // ★ Phase 1：简报里带上当前模式片段（模式在中途变化时由 applyMode 的 inject 补发）
    let text = (role === 'front' ? FRONT_BRIEF : BACK_BRIEF).replace('{{BOARD}}', boardDir)
    // 模式说明片段（原有行为，不能被下面的替换切断）
    text += (typeof briefFragment === 'function' ? briefFragment(currentMode(), role) : '')
    // ★ 非默认实例：简报里的工具名换成带后缀的（否则模型会去调 fr_escalate，而本实例注册的是 fr_escalate_b）
    text = localizeToolNames(text)
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
  /** ★ 2026-11-07：worker 会话判定（只读检索会话，不参与编排）。
   *  按 id 前缀识别，而不是只在 workers 池里查 —— worker 停止/清理后仍可能残留会话，
   *  池里查不到但会话还在跑，那时它的 guard 仍需继续生效。 */
  const isWorkerAgent = (agent) => {
    try {
      if (!agent) return false
      const id = String(idOf(agent))
      if (!id.startsWith(SESSION_PREFIX)) return false
      return /^worker-/.test(id.slice(SESSION_PREFIX.length))
    } catch { return false }
  }

  // ── 通道：唤醒后台（不打断） / steer 前台 ───────────────────────────────
  let lastWakeAt = 0
  const wakeCount = { total: 0, byReason: {} }
  // ── 干扰预算（2026-11-07）：每任务统计"打扰了前台几次"。
  //   不是硬闸门（该叫醒还是要叫），而是超预算时记一条事件 + 日志，让"过度干扰"可测。
  let taskWakes = 0
  let taskFreezes = 0
  let budgetAlerted = false
  function noteWakeBudget (reason) {
    try {
      taskWakes++
      const lim = Number(cfg.budgetWakes) || 12
      if (!budgetAlerted && taskWakes > lim) {
        budgetAlerted = true
        event('budget-exceeded', { kind: 'wake', n: taskWakes, limit: lim, last: reason })
        log(`干扰预算超限：本任务已唤醒 ${taskWakes} 次（阈值 ${lim}）`)
      }
    } catch { /* 忽略 */ }
  }

  /** 关键唤醒：终局 / 上交 / T3 —— **不受冷却限制**（#5 修复：实测冷却把"终局"吞了） */
  let lastPrefetchAt = 0   // 流水线预规划冷却（避免每 tick 唤醒后台）

  /**
   * ★★ 2026-11-07 冷却策略重写：从「固定 45s 时间冷却」改成「缺口驱动 + 短冷却防刷屏」。
   *
   * 为什么改：实测后台产一批（2 步）只要 6.7 秒，却要等 45 秒冷却 ⇒ 后台 87% 的时间在空等。
   *   前台消费 2 步要 22.5 秒，比后台慢 3.4 倍 ⇒ 只要后台持续产出，前台就永不缺料。
   *   现在的 45s 冷却就是那条把流水线截断成串行的绳子。
   *
   * 新逻辑：
   *   · 有里程碑缺口（ms > steps） ⇒ 冷却 2 秒（缺口是最强信号，必须尽快补）
   *   · 缓冲低于水位（remain < watermark） ⇒ 冷却 5 秒（常规预取节奏）
   *   · 其它 ⇒ 用 cfg.prefetchCooldownMs（默认仍可配，作兜底）
   *
   * 保留时间下限的意义：防止 tick（30s）与投递回调（即时）在同一瞬间重复唤醒，
   * 造成同一次缺口被催两遍 —— 那是纯浪费 token。
   */
  function prefetchCooldownFor (ms, stepCount, remain) {
    const gap = (typeof ms === 'number' && ms > 0 && ms > stepCount)
    if (gap) return 2000
    if (remain <= 0) return 5000
    return Number(cfg.prefetchCooldownMs) || 45000
  }
  /** v2 唤醒合并：冷却期内积压的唤醒文本（官方 Super-agent「批量唤醒」思路） */
  const pendingWakeBatch = []
  /** 把积压的唤醒合并成一条发出；返回是否发出 */
  function flushWakeBatch () {
    if (!pendingWakeBatch.length) return false
    if (pendingWakeBatch.length === 1) {
      const only = pendingWakeBatch.shift()
      return wakeBack('batched', only)
    }
    const merged = pendingWakeBatch.map((t, i) => (i + 1) + '. ' + t).join(' | ')
    pendingWakeBatch.length = 0
    return wakeBack('batched', '【合并唤醒】' + merged)
  }

  /**
   * 统一唤醒前置过滤表（2026-11-07）。
   * 以前"某个 reason 需要连续失败 2 次才唤醒"这类条件散在调用点（tools/post-execute 里
   * `failStreak === 2`），新增 reason 就得再写一遍。现在收拢成一张表，wakeBack 入口统一判定：
   *   minStreak / maxStreak —— 依赖 toolStats.failStreak 的统计类 reason
   * 未列出的 reason 不受此表约束（哨兵、终局、手动等仍按各自逻辑）。
   */
  const WAKE_POLICY = {
    // 前台工具失败：同一工具连续失败第 2 次才值得惊动后台（第 1 次前台自己会改；
    // 第 3 次起交给 H4 哨兵处理，不再重复唤醒）
    'tool-fail': { minStreak: 2, maxStreak: 2 },
  }

  /** 把前台最近 5 次工具调用的摘要拼到唤醒文本尾部（后台据此判断前台实际做了什么）。 */
  function appendToolSummary (text) {
    try {
      const recent = Array.isArray(toolStats.recent) ? toolStats.recent.slice(-5) : []
      if (!recent.length) return text
      const s = recent.map((x) => `${x.n}${x.ok ? '✓' : '✗'}`).join(' · ')
      return String(text || '') + `\n【前台最近工具】${s}`
    } catch { return text }
  }

  /** 从工具结果里抽出可读错误文本（各工具形状不一，尽量兜住）。 */
  function resultErrorText (result) {
    try {
      if (!result) return ''
      if (typeof result === 'string') return result
      if (typeof result.content === 'string') return result.content
      if (Array.isArray(result.content)) {
        return result.content.map((p) => (p && (p.text || p.content)) || '').join(' ')
      }
      if (result.error) return String((result.error && result.error.message) || result.error)
      return ''
    } catch { return '' }
  }

  /**
   * 调用契约错误：工具名打错 / 参数不合法 —— 调用**没有到达工具本体**。
   * 这类失败不代表"任务做不下去"，计入 failStreak 会直接造成误冻结
   * （你的 #33：连续记错同一个工具名 → H4 判"连续失败 3 次" → 冻结并作废全部步骤）。
   */
  const CALL_CONTRACT_RE = /unknown tool|tool .{0,40}?(?:not found|not registered|does not exist)|no such tool|invalid (?:argument|arguments|parameter|params|schema)|missing required (?:property|parameter|argument)|参数.{0,20}?(?:无效|不合法|缺失)|工具.{0,20}?(?:不存在|未注册|不可用)/i
  const isCallContractError = (result) => CALL_CONTRACT_RE.test(resultErrorText(result))

  function wakeBack (reason, text) {
    const now = Date.now()
    if (!back) { log(`wake(${reason}) 跳过：后台未接线`); vlog('wake-skip', { reason, why: 'no-back' }); return false }
    // ★ 模式守卫（Phase 1）：速答/检索模式不需要后台 ⇒ 任何自动唤醒都跳过（手动除外）
    try {
      const mi = modeNow()
      // ★★ 2026-11-08：分诊/兜底升级必须能穿透 quick 模式的"不需要后台"守卫。
      //   逻辑悖论：triage 的职责恰恰是"判断 quick 模式要不要升级"，
      //   如果它自己被 quick 模式的 backend:false 拦住，分诊永远不会发生。
      //   实测：L3 灰区判型后 triage-woken 返回 woke:false，正是这个原因。
      const BYPASS = new Set(['manual', 'triage', 'auto-upgrade'])
      if (!mi.backend && !BYPASS.has(reason)) {
        log(`wake(${reason}) 跳过：模式 ${mi.key} 不需要后台`)
        vlog('wake-skip', { reason, why: 'mode-no-backend', mode: mi.key })
        event('wake-skip-mode', { reason, mode: mi.key })
        return false
      }
      if (!mi.backend && BYPASS.has(reason)) {
        log(`wake(${reason}) 穿透 ${mi.key} 模式的 backend:false（该 reason 本身就需要后台判断）`)
      }
    } catch { /* 模式层异常不影响唤醒 */ }
    // ★ 用户停止/暂停后 15s 内不唤醒（2026-10-18 修复：否则用户点了暂停，
    //   插件又把后台拉起来继续跑，表现为"暂停按不住"）
    if (now - userStopAt < 15000) { log(`wake(${reason}) 跳过：用户刚停止`); vlog('wake-skip', { reason, why: 'user-stop' }); return false }
    void setEffort('back')   // B10 档位漂移：先把全局档位切到后台该有的值
    // ★ 统一前置过滤（见 WAKE_POLICY）：统计类 reason 的阈值在这里一次判定
    const pol = WAKE_POLICY[reason]
    if (pol && typeof toolStats.failStreak === 'number') {
      if (pol.minStreak !== undefined && toolStats.failStreak < pol.minStreak) {
        vlog('wake-skip-policy', { reason, failStreak: toolStats.failStreak, min: pol.minStreak })
        log(`wake(${reason}) 前置过滤：failStreak ${toolStats.failStreak} < ${pol.minStreak}`)
        return false
      }
      if (pol.maxStreak !== undefined && toolStats.failStreak > pol.maxStreak) {
        vlog('wake-skip-policy', { reason, failStreak: toolStats.failStreak, max: pol.maxStreak })
        log(`wake(${reason}) 前置过滤：failStreak ${toolStats.failStreak} > ${pol.maxStreak}`)
        return false
      }
    }
    // ★ 前台最近动作随唤醒一起送（官方：决策方要看到执行方的真实动作，而不是只读 state.md）
    //   合并唤醒（batched）的文本里每条已经自带摘要，这里不再重复追加。
    const body = reason === 'batched' ? text : appendToolSummary(text)
    // ★ v2 抄官方 Super-agent「批量唤醒」：冷却期内的事件不再丢弃，而是入队合并。
    //   冷却结束由 tick 检查积压并合并成一条发出（官方数据：合并能省 30% Router 决策）。
    if (!CRITICAL_REASONS.has(reason) && now - lastWakeAt < cfg.wakeCooldownMs) {
      pendingWakeBatch.push(`[${reason}] ${String(body || '').slice(0, 300)}`)
      log(`wake(${reason}) 冷却中，已入队合并（积压 ${pendingWakeBatch.length} 条）`)
      return false
    }
    // ★★ 2026-11-07 改法 B：补步类信号在后台忙时**优先 followup**（排队立刻接续），
    //   而不是 steer（steer 要排到它当前回合的下一步，会等很久）。
    //
    //   实测 L3 时间线：
    //     +11.5s milestone-gap(need-next) → 后台正在跑 review-diff
    //     wakeBack 走 steer 分支 → 信号排进它的下一轮，直到 +37.6s 才被处理
    //     前台 +13.9s 就没料了，空等 28 秒。
    //
    //   语义：补步步是"断料救援"，优先级高于后台正在做的复核/审查这类后台自主动作。
    //   followup 会让后台在**当前回合结束后立刻**起新一轮处理补步，而不是把消息塞进当前回合中段。
    //
    //   例外：若后台只是"正在跑但马上要产出步骤"，steer 也无害；所以保留 steer 作为失败回退路径。
    const REPAIR_REASONS = new Set(['need-next', 'prefetch-urgent', 'prefetch', 'milestone-gap'])
    if (back.phase && back.phase.kind === 'running' && REPAIR_REASONS.has(reason)) {
      try {
        back.followup(msg(body))
        lastWakeAt = now; wakeCount.total++; wakeCount.byReason[reason] = (wakeCount.byReason[reason] || 0) + 1; noteWakeBudget(reason)
        event('wake', { reason, mode: 'followup-repair' })
        log(`wake(${reason}) → followup（补步优先，后台在跑也立即接续）`)
        vlog('wake', { reason, mode: 'followup-repair' })
        return true
      } catch (e) {
        log(`wake followup-repair fail: ${e.message} → 回退 steer`)
        try {
          back.steer(msg(body))
          lastWakeAt = now; wakeCount.total++; wakeCount.byReason[reason] = (wakeCount.byReason[reason] || 0) + 1; noteWakeBudget(reason)
          event('wake', { reason, mode: 'steer-fallback' }); return true
        } catch (e2) { log('wake steer-fallback fail: ' + e2.message); return false }
      }
    }
    if (back.phase && back.phase.kind === 'running') {
      // 正在深想：用 steer 排队到它下一步，不打断（内容在黑板，信号可晚到）
      try {
        back.steer(msg(body))
        lastWakeAt = now; wakeCount.total++; wakeCount.byReason[reason] = (wakeCount.byReason[reason] || 0) + 1; noteWakeBudget(reason)
        event('wake', { reason, mode: 'steer' }); log(`wake(${reason}) → steer（后台在跑）`); vlog('wake', { reason, mode: 'steer' }); return true
      } catch (e) {
        // ★ 实测（2026-10-17）：后台刚被唤醒、处于中间态时 steer 会抛 "unreachable variant: {}"。
        //   此时必须**回退到 followup**，否则这次唤醒彻底丢失（哨兵/终局信号会丢）。
        log('wake steer fail: ' + e.message + ' → 回退 followup')
        try {
          back.followup(msg(body))
          lastWakeAt = now; wakeCount.total++; wakeCount.byReason[reason] = (wakeCount.byReason[reason] || 0) + 1; noteWakeBudget(reason)
          event('wake', { reason, mode: 'followup-fallback' }); vlog('wake', { reason, mode: 'followup-fallback' }); return true
        } catch (e2) { log('wake followup-fallback fail: ' + e2.message); return false }
      }
    }
    try {
      back.followup(msg(body))          // 空闲 → 唤醒起一轮
      lastWakeAt = now; wakeCount.total++; wakeCount.byReason[reason] = (wakeCount.byReason[reason] || 0) + 1; noteWakeBudget(reason)
      if (pendingWakeBatch.length) event('wake-batch-flushed', { count: pendingWakeBatch.length })
      pendingWakeBatch.length = 0
      event('wake', { reason, mode: 'followup' }); log(`wake(${reason}) → followup（后台空闲）`); vlog('wake', { reason, mode: 'followup' }); return true
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
      const want = allowListFor(modeKey, role).map((n) => (String(n).startsWith('fr_') ? TN(n) : n))
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
    // ★ §22 优化③：同模式重复生效去重（auto 判型后又 user 锁定同模式 ⇒ 只更新 by/reason，不重刷 inject）
    // ★★ 2026-11-07 修正：去重时**仍必须重挂工具白名单**。
    //   原实现整个 return ⇒ autoheal/api-rebuild 重建会话后 applyToolPolicy 永不执行
    //   ⇒ restrict 丢失、前/后台各可见 68 个工具（含 dev_*/hindsight_*/subagent/workflow）。
    //   注：不重发 modeNotice（那条是噪音且破坏 prefix cache），只重挂工具面。
    if (activeMode === p.key && by !== 'startup') {
      modeBy = by || modeBy
      try { reapplyToolPolicyIfNeeded() } catch (e) { log('去重分支重挂工具面失败: ' + e.message) }
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
    vlog('mode-set', { mode: p.key, by: modeBy, reason: String(reason || '').slice(0, 120) })
    log(`模式 → ${p.label}（${p.key}，by ${modeBy}）`)
    // 模式变了 ⇒ 步长基线变了，自适应重新开始（避免沿用上个模式的批量）
    try { adaptiveBatch = 0; recentGaps = []; lastDeliverAt = 0 } catch { /* 初始化早期忽略 */ }
    const policy = applyToolPolicy(p.key)
    policyAgentId.front = front ? idOf(front) : ''
    policyAgentId.back = back ? idOf(back) : ''
    for (const [, ag] of [['front', front], ['back', back]]) {
      if (!ag) continue
      // ★ 2026-11-07：模式说明同样要做工具名本地化（原文里含 fr_escalate/fr_mode/fr_worker）
      try { ag.inject(msg(localizeToolNames(modeNotice(p.key, { fanout: cfg.fanoutWorkers !== false })), `模式：${p.label}`)) } catch { /* 忽略 */ }
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
  // ── steps → 官方 todo（单向镜像，2026-11-07）──────────────────────────────
  // 设计要点（读 dsh-tool-todo 源码确认）：
  //   · todo_write 等价于 session.append('todo/write', {todos})，整表替换、最后写赢
  //   · 投影 apply 里有 `if (event.type === 'turn/start') return null` ⇒ 每个 turn 重置
  //   所以：唯一写者是插件，且必须在每个 turn 开头重写一次快照，否则模型下一轮就看不到。
  //   这不是第二真相源——真相源仍是 steps/S*.md，todo 只是它的逐轮投影。
  // 最近一次发给前台的任务原文（首帧超时兜底时交回前台，避免它"猜任务"）
  let lastTaskText = ''
/** ★ 2026-11-08：上一次**判型时**的任务文本。用于判断"是不是同一个任务"。
 *  注意不能复用 lastTaskText —— 它在 deliver 开头就被赋成新文本了，
 *  再拿它比对会永远相等（等于没比对）。 */
let lastDetectText = ''
/** ★ 2026-11-08：模式被 pin 锁定（本任务不再自动判型/分诊） */
let modePinned = false
/** ★ 2026-11-08：本任务是否已因工具数兜底升级过（防重复触发） */
let autoUpgradedThisTask = false
/** ★ 2026-11-08：最近一次判型结果（灰区分诊/UI 展示用） */
let lastTriage = null
/** ★ 2026-11-08：coding 模式下前台是否已上交（用于执行层强制督促） */
let codingNotEscalated = false
/** ★ 2026-11-08：本任务最后一次上交时刻（0=未上交） */
let lastEscalateAt = 0

  let lastTodoKey = ''
  let todoSyncTimer = null
  // coding 模式「只读审 diff」：收集前台改过的文件，攒够就请后台只读复核一次
  const changedFiles = new Set()
  let lastDiffReviewAt = 0
  let diffReviewCount = 0

  function buildTodoSnapshot () {
    try {
      const files = listSteps()
      if (!files.length) return null
      const done = stepNo(readState().done || '')
      const todos = []
      for (const f of files.slice(0, 40)) {
        const k = stepNo(f)
        const body = readIf(join(P.stepsDir, f)) || ''
        const line = body.split('\n').find((l) => /^动作[:：]/.test(l)) || ''
        const act = line.replace(/^动作[:：]\s*/, '').trim()
        todos.push({
          content: `S${k} ${act || '(无描述)'}`.slice(0, 100),
          status: k <= done ? 'completed' : (k === done + 1 ? 'in_progress' : 'pending'),
        })
      }
      if (files.length > 40) todos.push({ content: `…另有 ${files.length - 40} 步`, status: 'pending' })
      // content 必须唯一（工具侧校验会去重）
      const seen = new Set()
      return todos.filter((t) => (seen.has(t.content) ? false : (seen.add(t.content), true)))
    } catch { return null }
  }

  /** 把当前步骤快照写进前台会话的 todos（幂等：内容不变则跳过）。 */
  function syncTodos (why) {
    try {
      if (cfg.todoMirror === false) return false
      if (!front || !front.session) return false
      const todos = buildTodoSnapshot()
      if (!todos) return false
      const key = JSON.stringify(todos)
      if (key === lastTodoKey) return false
      lastTodoKey = key
      front.session.append('todo/write', { todos })
      vlog('todo-mirror', { why, count: todos.length })
      return true
    } catch (e) { log('todo 镜像失败: ' + (e && e.message || e)); return false }
  }

  /** coding 模式：后台只读审 diff（不写代码）。攒够 3 个改动文件、冷却 2 分钟、每任务最多 3 次。 */
  function maybeReviewDiff () {
    try {
      if (cfg.reviewDiffEnabled === false) return false
      const p = modeInfo(currentMode())
      if (!p || !p.reviewDiff) return false
      if (changedFiles.size < 3) return false
      if (Date.now() - lastDiffReviewAt < 120000) return false
      if (diffReviewCount >= 3) return false
      lastDiffReviewAt = Date.now()
      diffReviewCount++
      const list = [...changedFiles].slice(-8).map((f) => '· ' + f).join('\n')
      changedFiles.clear()
      event('review-diff', { count: diffReviewCount })
      vlog('review-diff', { round: diffReviewCount })
      wakeBack('review-diff', `【审阅·只读】前台刚改了这些文件：\n${list}\n` +
        '请**只读**核对它们是否符合 route.md 的验收标准；只指出问题（≤3 条），**不要写代码、不要改文件、不要重排路线**。')
      return true
    } catch { return false }
  }

  /** 延迟一拍再写：turn/start 事件分发过程中直接 append 会重入。 */
  function queueTodoSync (why) {
    if (todoSyncTimer) return
    todoSyncTimer = setTimeout(() => { todoSyncTimer = null; syncTodos(why) }, 0)
  }

  // recent：前台最近若干次工具调用（供唤醒时随附给后台，见 appendToolSummary）
  // callErrHinted：已经给过"工具名/参数不合法"提示的工具名，避免重复刷屏
  const toolStats = { total: 0, failStreak: 0, failTotal: 0, sameName: {}, lastSame: '', sameCount: 0, lastFailName: '', recent: [], callErrHinted: new Set(), callErrStreak: 0, lastCallErrName: '' }
  /** v2 返工检测：最近写操作轨迹（文件 / 大小 / 时间） */
  const reworkTrail = []
  /** 已告警过的返工文件（同一文件只告警一次） */
  const reworkAlerted = new Set()
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
    try { taskFreezes++; event('freeze-budget', { n: taskFreezes }) } catch { /* 忽略 */ }
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
      vlog('freeze', { why: String(why).slice(0, 160), staleMoved: moved, frontRunning: running })
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
      vlog('sentinel', { id: a.id, why: a.why, failStreak: toolStats.failStreak, steps: stepsThisTask })
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
  let finalAsked = false         // 终局唤醒守卫（新步骤到达时重置）
  let finalAuditRetry = 0        // 终局对照审的补做次数
  let lastAuditedDeliverKey = ''  // 已审计过的 deliver 指纹（避免每 tick 重复审）
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
    if (cfg.firstFrameEcho === false) {
      steerFront('【等待超时】后台还没给出步骤（可能模型较慢）。你**先做只读侦察**（读文件/看目录/确认环境），不要猜任务、不要写交付物；把侦察结果写进 state.md 的「已知事实」，然后停下等步骤。', 'first-frame-timeout')
    } else {
      const taskEcho = lastTaskText ? String(lastTaskText).slice(0, 800) : ''
      steerFront('【等待超时】后台还没给出步骤（可能模型较慢）。**任务原文就在你手上，不用猜**：\n' +
        (taskEcho ? '「' + taskEcho + '」\n' : '') +
        '现在按你对任务的直接理解，先推进「确定要做、且不可逆风险低」的部分（读现状 / 建目录 / 改动实现 / 跑验证），' +
        '不要空等。唯一禁区：**先不要写最终交付物**（deliver），等后台步骤到了再对齐收口。', 'first-frame-timeout')
    }
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
      const mk = async (tag, wantId) => {
        // ★★ 2026-11-07 重载风暴根治：**优先 resume 旧会话**，而不是每次新建 id。
        //   实测：agentLoop 的服务是内存态，插件热重载后旧会话从 ctx.agents 消失，
        //   但**会话日志仍在磁盘**（该目录下已积累 521 个 fr 会话日志）。
        //   原实现只会 create 新 id ⇒ 7 次重载堆出 14 个会话 + 163 条工作区引用。
        //   agentLoop.resume() 能用**同一个 sessionId** 复活（已实测：resume 后 id 不变、
        //   且重新出现在 ctx.agents 列表里）。因此这里先 resume，失败才 create。
        if (wantId) {
          try {
            const h = await svcAgentLoop.resume(ctx, { resumeSessionId: wantId })
            const ag = h && h.agent
            if (ag) {
              // resume 出来的也会丢工具面 ⇒ 同样立刻挂
              try { await svcPresets.mount(ag.ctx, presetName()) } catch (e) { log('复活挂预设失败: ' + e.message) }
              try { attachToolPolicyFor(tag, ag) } catch (e) { log('复活即时挂工具面失败: ' + e.message) }
              // ★★ 2026-11-07 健康校验：复活出来的会话可能带着**上一个插件实例**挂的
              //   restrict（那个 disposer 已随旧实例销毁，无法解除）⇒ 工具面永久残缺。
              //   实测 mw63x2cm 就是这样卡在 9 个工具、怎么重挂都回不来。
              //   对策：复活后立刻校验可见工具数，达不到该角色白名单的 80% 就**放弃它**，
              //   走新建路径（宁可换 id，也不要一个残废的前台）。
              const wantN = allowListFor(currentMode(), tag).length
              let gotN = 0
              try {
                const tt = ag.ctx && typeof ag.ctx.get === 'function' ? ag.ctx.get('tools') : undefined
                gotN = (tt && typeof tt.schemas === 'function' ? tt.schemas(ag) : []).length
              } catch { gotN = 0 }
              if (gotN >= Math.max(5, Math.floor(wantN * 0.8))) {
                event('wire-resume', { role: tag, id: String(wantId), tools: gotN })
                log(`接线自愈：复活旧会话 ${tag}=${String(wantId).slice(0, 18)}（${gotN}/${wantN} 工具，不新建）`)
                return ag
              }
              event('wire-resume-unhealthy', { role: tag, id: String(wantId), got: gotN, want: wantN })
              log(`复活 ${tag} 不健康（${gotN}/${wantN} 工具，疑似旧实例 restrict 残留）⇒ 改新建`)
              try { if (typeof h.dispose === 'function') await h.dispose() } catch { /* 忽略 */ }
            }
          } catch (e) {
            log(`复活 ${tag} 失败（改新建）: ` + (e && e.message))
            event('wire-resume-fail', { role: tag, id: String(wantId), why: String(e && e.message || e).slice(0, 100) })
          }
        }
        const ag = await svcAgentLoop.create((TAG === 'a' ? 'session-fr-' : 'session-fr-' + TAG + '-') + tag + '-' + Date.now().toString(36),
          { provider: routeFor(tag).provider, model: routeFor(tag).model, reasoningEffort: effortFor(tag) }, { cwd: boardRoot })
        try { await svcPresets.mount(ag.ctx, presetName()) } catch (e) { log('自愈挂预设失败: ' + e.message) }
        // ★★ 2026-11-07 窗口归零：会话一创建就**立刻**挂工具面，
        //   不等 resolveAgents / applyMode 的下一次 tick。
        //   原实现要等下一次 resolveAgents（实测重建后约 20s）才重挂，
        //   这 20s 内新会话可见 68 个工具（含 dev_*/hindsight_*/subagent/workflow/fr_escalate），
        //   benchmark 若此时发任务，那一轮就是在不受控工具面上跑的。
        try { attachToolPolicyFor(tag, ag) } catch (e) { log('自愈即时挂工具面失败: ' + e.message) }
        return ag
      }
      if (!front) { const ag = await mk('front', pendingRevive.front || cfg.frontSessionId); front = ag; pendingRevive.front = ''; wire(idOf(ag), undefined); await nameSession(ag, 'front') }
      if (!back) { const ag = await mk('back', pendingRevive.back || cfg.backSessionId); back = ag; pendingRevive.back = ''; wire(undefined, idOf(ag)); await nameSession(ag, 'back') }
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
      // ★★ 2026-11-07 根因修复：工作区会话引用只增不减。
      //   实证：Desktop\FastReact 那个工作区累计 163 条会话引用，实际存活只有 1-2 个。
      //   原因：每次 autoheal/rebuild/建组都新建会话并 attach，旧会话**从不 detach**
      //   （detachSession 只被 deleteGroup 调用）。
      //   后果：侧边栏出现大量"幽灵会话"，且 resolveAgents/syncRoute/组自愈
      //   都要在这些死 id 上做 ctx.agents.get() 查空，白白放大开销与困惑。
      //   策略：每次挂新会话时，顺手把"已不存在于 ctx.agents"的引用摘掉；
      //   保留当前存活的一切（含别的组的活会话），只清死引用。
      try { await pruneDeadWorkspaceRefs(ws) } catch (e) { log('清理工作区死引用失败: ' + e.message) }
      return true
    } catch (e) { log('linkSession fail: ' + (e && e.message)); return false }
  }

  /** 摘掉工作区里"会话已不存在"的引用（只清死 id，不动活会话）。节流：60s 内不重复。 */
  let lastWsPruneAt = 0
  async function pruneDeadWorkspaceRefs (ws) {
    if (Date.now() - lastWsPruneAt < 60000) return 0
    lastWsPruneAt = Date.now()
    const ids = (ws && ws.sessionIds || []).map(String)
    if (ids.length <= 4) return 0                       // 引用不多 ⇒ 不值得扫
    const alive = (id) => { try { return !!(ctx.agents && ctx.agents.get(id)) } catch { return false } }
    let removed = 0
    for (const id of ids) {
      if (id === String(cfg.frontSessionId) || id === String(cfg.backSessionId)) continue
      if (alive(id)) continue
      try { await ws.detachSession(id); removed++ } catch { /* 单条失败不影响其它 */ }
    }
    if (removed) {
      event('workspace-prune', { removed, before: ids.length, after: (ws.sessionIds || []).length })
      log(`工作区死引用清理：移除 ${removed} 条（${ids.length} → ${(ws.sessionIds || []).length}）`)
    }
    return removed
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
    // ★ 多实例（2026-11-07）：按本实例的编号格式求最大值。
    //   实例 a 用 FR-<n>，其它用 FR-<tag>-<n>；两者混在同一个 groups.json 里时，
    //   只认自己那种格式，否则 b 每次都会算出同样的 FR-b-02（撞号）。
    const PREFIX = TAG === 'a' ? 'FR-' : ('FR-' + TAG + '-')
    const RE = TAG === 'a' ? /^FR-(\d+)$/ : new RegExp('^FR-' + TAG + '-(\\d+)$')
    let max = 0
    for (const g of list) {
      const k = String((g && g.key) || '')
      if (TAG === 'a' && /^FR-[b-z]-/.test(k)) continue   // a 不认 b 的编号
      const m = k.match(RE)
      if (m) max = Math.max(max, Number(m[1]))
    }
    return PREFIX + String(max + 1).padStart(2, '0')
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

  /** 规划闭环检测：统计 route.md「## 里程碑」段里列出的里程碑条数
   *  ★ 2026-11-07：实现已移入 lib/board.js（BB.routeMilestoneCount），此处转调，
   *    避免 scheduler.js（归档前要校验缺口）与 index.js（催补步）两处实现分叉。
   *    ⚠️ 必须用 BB（第 300 行声明）而不是后面的 B（第 2046 行），否则若被更早调用会触发 TDZ。 */
  function routeMilestoneCount () {
    try { return (typeof BB.routeMilestoneCount === 'function') ? BB.routeMilestoneCount() : 0 } catch { return 0 }
  }

  /** 解析 route.md 的「## 终态判定」段 → [{ id:'A1', text:'...' }]（格式由 renderRoute 控制，解析确定） */
  function routeAcceptance () {
    try {
      const t = readIf(join(boardDir, 'route.md'))
      if (!t) return []
      const m = t.match(/^##[^\n]*终态判定[^\n]*$/m)
      if (!m) return []
      const seg = t.slice(m.index + m[0].length).split(/\n##\s/)[0]
      const items = seg.split('\n')
        .filter((l) => /^\s*[-*]\s+\S/.test(l))
        .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
        .filter(Boolean)
      return items.map((text, i) => ({ id: 'A' + (i + 1), text }))
    } catch { return [] }
  }

  /** 终局对照审的唤醒文本：把开工时定下的验收标准原文交回去，要求逐条给证据。 */
  function buildFinalPrompt () {
    const acc = routeAcceptance()
    if (!acc.length) return null
    const t = readIf(join(boardDir, 'route.md')) || ''
    const gm = t.match(/^##[^\n]*目标[^\n]*\n+([\s\S]*?)(?=\n##\s|$)/m)
    const goal = gm ? gm[1].trim().slice(0, 200) : ''
    const verdict = acc.map((a) => a.id + '✓').join(' ')
    const list = acc.map((a) => `  ${a.id}: ${a.text}`).join('\n')
    return {
      acc,
      text: `【终局】清单最后一步已完成。现在做**验收对照**（不要复述过程）：\n` +
        `目标：${goal || '（route.md 未写）'}\n` +
        `验收标准：\n${list}\n\n` +
        `要求：\n` +
        `1. 逐条判定，每条一行：「A1 满足 — 证据：<文件路径 / 命令输出片段>」或「A1 不满足 — 缺：<什么>」\n` +
        `2. 全部满足 ⇒ 写 .board/deliver.v1.md，**首行必须是** \`验收: ${verdict}\`\n` +
        `3. 有任何一条不满足 ⇒ 不要写 deliver，写下一批 .board/steps/S*.md 补齐缺口`,
    }
  }

  /** 机械审计 deliver：必须存在「验收: A1✓ A2✓」行且覆盖全部验收条目。零模型。 */
  function deliverAudit () {
    const acc = routeAcceptance()
    if (!acc.length) return { ok: true, skipped: true }
    const t = readIf(join(boardDir, 'deliver.v1.md'))
    if (!t) return { ok: false, why: 'deliver 不存在' }
    const line = (t.match(/^\s*验收[:：].*$/m) || [])[0]
    if (!line) return { ok: false, why: '缺少「验收:」判定行', missing: acc.map((a) => a.id) }
    const missing = acc.filter((a) => !new RegExp(a.id + '\\s*[✓√]').test(line)).map((a) => a.id)
    return missing.length ? { ok: false, why: '验收声明缺项', missing } : { ok: true }
  }

  /** tick 里调用：deliver 出现/变更时审计一次；不合格则作废并让后台补（有上限）。 */
  function checkFinalAudit () {
    if (cfg.finalAudit === false) return
    if (!hasDeliver()) return
    const t = readIf(join(boardDir, 'deliver.v1.md')) || ''
    const key = t.length + ':' + t.slice(0, 40)
    if (key === lastAuditedDeliverKey) return
    lastAuditedDeliverKey = key
    const r = deliverAudit()
    if (r.ok) {
      event('deliver-audit', { ok: true, skipped: !!r.skipped })
      vlog('deliver-audit', { ok: true, skipped: !!r.skipped })
      return
    }
    const maxRetry = typeof cfg.finalAuditMaxRetry === 'number' ? cfg.finalAuditMaxRetry : 2
    if (finalAuditRetry >= maxRetry) {
      event('deliver-audit', { ok: false, giveUp: true, why: r.why, missing: r.missing })
      vlog('deliver-audit', { ok: false, giveUp: true, why: r.why, missing: r.missing })
      return
    }
    finalAuditRetry++
    try { renameSync(join(boardDir, 'deliver.v1.md'), join(boardDir, `deliver.invalid-${Date.now()}.md`)) } catch { /* 改名失败则保持原状 */ }
    finalAsked = false
    event('deliver-audit', { ok: false, retry: finalAuditRetry, why: r.why, missing: r.missing })
    vlog('deliver-audit', { ok: false, retry: finalAuditRetry, why: r.why, missing: r.missing })
    const verdict = routeAcceptance().map((a) => a.id + '✓').join(' ')
    wakeBack('final', `【终局·验收未通过】deliver 未通过机械对照：${r.why}${r.missing ? '（' + r.missing.join(',') + '）' : ''}。\n` +
      `请按 route.md 的「## 终态判定」逐条补齐后重写 deliver，**首行必须写** \`验收: ${verdict}\`；缺证据的条目要补做，不要只补文字。`)
  }

  // ── fr_route：结构化提交路线（LLM 想乱写格式也写不出来）───────────────────────
  /** 把结构化路线渲染成 route.md；若带 steps 参数，**同时**写出 steps/S<k>.md。
   *
   *  ★★ 2026-11-07 新增 mode 参数（区分「首次规划」与「补步」）：
   *    实测事故：后台每次被唤醒都会**整体重写路线**，哪怕只是补 S6/S7，
   *    也要把 S1-S5 重画一遍（`route-steps steps=4` 之后仍触发 `watcher-fire S1.md`）。
   *    一个 60 秒任务可能把同一条路线重画 3-5 遍 —— 这是最大的浪费。
   *
   *      mode='plan'   首次规划：覆写 route.md + 写全部 steps（现有行为）
   *      mode='append' 补步：**不动 route.md**，只写新步号，**已存在的直接跳过**
   *
   *    但 plan 模式有个隐患：它会覆写**已完成**的步骤（S1 已完成又重写）
   *    ⇒ seenSteps 被删 ⇒ 前台可能被重复投递已做完的步骤。
   *    所以 plan 也加了一条：**步号 <= 当前 done 的，不重写**。
   *
   *    修错场景（后台发现 S3 写错要改）：仍用 mode='plan'，编号不变、内容更新。
   *    （原本文档里的 `repairs: S<j>` 其实从未被代码解析过，是死设计，不用管。）
   */
  function renderRoute (args) {
    const mode = String(args.mode || 'plan')
    // 已存在的步骤文件（用于 append 模式跳过）
    let existingSteps = new Set()
    try { existingSteps = new Set(readdirSync(P.stepsDir).filter(f => /^S\d+\.md$/.test(f))) } catch { /* 忽略 */ }
    // 当前已完成步号（用于 plan 模式跳过已完成步骤）
    const doneNow = stepNo(readState().done || '')
    // append 只有在本任务已有 route 时才成立；否则退回 plan
    const isAppend = (mode === 'append' && existsSync(P.route))
    // ★ 2026-11-07：plan 模式的必需字段校验（schema 里 required 已清空，改在这里查）
    //   plan 要覆写整条路线，必须有 goal + milestones；append 只要 steps。
    if (!isAppend) {
      const mArr = Array.isArray(args.milestones) ? args.milestones.filter(m => m && m.id && m.desc) : []
      if (!String(args.goal || '').trim() && mArr.length === 0) {
        return { ok: false, error: 'plan 模式需要 goal 和 milestones；若只是补步骤，请用 mode:"append" 并只给 steps。' }
      }
    } else {
      const sArr = Array.isArray(args.steps) ? args.steps.filter(s => s && s.id && s.action) : []
      if (sArr.length === 0) {
        return { ok: false, error: 'append 模式必须给 steps（要补的步骤清单）。' }
      }
    }

    const lines = ['# route.md（由 fr_route 工具生成，勿手改写）', '']
    lines.push('## 目标', String(args.goal || '').trim() || '（未提供）', '')
    const acc = Array.isArray(args.acceptance) ? args.acceptance.filter(Boolean) : []
    if (acc.length) { lines.push('## 终态判定'); for (const a of acc) lines.push('- ' + String(a).trim()); lines.push('') }
    const ms = Array.isArray(args.milestones) ? args.milestones.filter(m => m && m.id && m.desc) : []
    // ★★ 2026-11-07 里程碑单调性约束（防"永远补不完"）—— 必须在生成 lines 之前跑
    //
    // 实测事故：同一任务内后台反复重规划，里程碑数一路涨：
    //   11:44:13 milestones=6 → 11:44:37 milestones=6 → 11:45:12 **milestones=9**
    //   而 steps 追不上（补到 6 又涨到 9）⇒ 缺口永不为 0 ⇒ 归档被拒、任务卡住。
    //
    // 根因：renderRoute 每次**整体覆写** route.md，从不检查既有 route；
    //   后台补步时重新规划，自然把"接下来的活"也算进里程碑，目标不断外扩。
    //
    // 对策：里程碑只许持平或减少，不许增长（增长时按旧数量截断并记事件）。
    //   理由：任务总量应在最初几次规划就定；补步阶段只该"补齐"，不该"加活"。
    if (ms.length > 0) {
      let prevMsCount = 0
      try {
        const prevRaw = readIf(P.route)
        if (prevRaw) {
          const mPrev = prevRaw.match(/^##[^\n]*里程碑[^\n]*$/m)
          if (mPrev) {
            const segPrev = prevRaw.slice(mPrev.index + mPrev[0].length).split(/\n##\s/)[0]
            prevMsCount = segPrev.split('\n').filter(l => /^\s*[-*]\s*\*?\*?M\d+/i.test(l)).length
          }
        }
      } catch { /* 忽略 */ }
      if (prevMsCount > 0 && ms.length > prevMsCount) {
        event('milestone-inflation-blocked', { was: prevMsCount, want: ms.length })
        log('fr_route：里程碑 ' + prevMsCount + ' → ' + ms.length + ' 已截断（补步阶段不许外扩任务量）')
        ms.length = prevMsCount
      }
    }
    lines.push('## 里程碑')
    for (const m of ms) lines.push(`- **${String(m.id).trim()}${m.step ? '（' + String(m.step).trim() + '）' : ''}**：${String(m.desc).trim()}`)
    lines.push('')
    // ★★ 2026-11-07 方案 A：哨兵「预存文件」拒绝
    //
    // 实测事故（L4 r1，13:59:19）：
    //   后台给出哨兵 C1 = file-exists(".../run-forced/L4/check.mjs")，
    //   但 check.mjs 是**题目自带**的验收脚本、规划时就已经存在 ⇒
    //   哨兵立即命中 ⇒ `sentinel-biz` + `interrupt-back` + `freeze` 三连，
    //   前台被冻结、后台被打断，任务卡死在 4/7。
    //
    // 语义错误：哨兵应该判断「**新出现的**文件/状态」，而不是「本来就有的文件」。
    //   后台不知道哪些文件是原有的，它把"文件存在"当成"活干完了"的信号。
    //
    // 修法：规划时检查目标——**如果文件此刻已经存在，这个 file-exists 哨兵必然立刻误触发**，
    //   直接丢弃并在事件里记一笔。file-absent 同理（若文件此刻不存在，哨兵也会立刻命中）。
    //   field-cmp / grep-match 无法静态判定，保持原样（它们依赖 done 状态变化，不会立即触发）。
    // 哨兵预检：丢弃会立即误触发的 file-*（纯逻辑见 route-plan.js，可单测）
    const rawSn = Array.isArray(args.sentinels) ? args.sentinels.filter(s => s && s.id && s.kind && s.target) : []
    const { kept: sn, rejected } = filterSentinelsPure(rawSn, {
      exists: existsSync,
      isAbsolute,
      root: boardRoot,
      resolve: (p) => join(boardRoot, p),
    })
    for (const r of rejected) {
      event('sentinel-rejected', { id: r.id, kind: r.kind, target: r.target, why: r.why })
      log(`fr_route：拒绝哨兵 ${r.id}（${r.why === 'already-exists' ? 'file-exists 目标已存在' : 'file-absent 目标已不存在'}，会立即误触发）：${r.target}`)
    }
    if (sn.length) {
      lines.push('## 哨兵条件')
      for (const x of sn) lines.push(`- ${String(x.id).trim()} | ${String(x.kind).trim()} | ${String(x.target).trim()}`)
      lines.push('')
    }
    const body = lines.join('\n')
    if (!isAppend) {
      // plan 模式：覆写 route.md（append 模式不动它，里程碑保持原样）
      writeAtomic(P.route, body)
      event('route-rendered', { chars: body.length, milestones: ms.length, sentinels: sn.length })
      log(`fr_route：route.md 已生成（${body.length} 字符，里程碑 ${ms.length}，哨兵 ${sn.length}）`)
    } else {
      event('route-append-mode', { existing: existingSteps.size, incoming: (Array.isArray(args.steps) ? args.steps.length : 0) })
      log(`fr_route：append 模式 —— 不覆写 route.md，只补新步骤（已有 ${existingSteps.size} 个）`)
    }

    // ★ 同批写出步骤文件（省掉后台单独写 steps 的那一次响应）
    let wrote = 0
    let skipped = 0
    const st = Array.isArray(args.steps) ? args.steps.filter(s => s && s.id && s.action) : []
    for (const s of st) {
      const k = stepNo(String(s.id))
      if (!k) continue
      // ★★ 两种模式的跳过规则：
      //   append：已存在的文件一律不碰（只写新增的步号）
      //   plan  ：步号 <= 当前 done 的已完成步骤不重写（避免重写已做完的活、误触发重新投递）
      if (isAppend && existingSteps.has(`S${k}.md`)) { skipped++; continue }
      if (!isAppend && doneNow > 0 && k <= doneNow) { skipped++; continue }
      const sl = [`# S${k}`, `动作: ${String(s.action).trim()}`, `验收: ${String(s.accept || '按动作完成').trim()}`, `assumes: ${String(s.assumes || '无').trim()}`]
      try {
        writeAtomic(join(P.stepsDir, `S${k}.md`), sl.join('\n') + '\n')
        try { seenSteps.delete(`S${k}.md`) } catch { /* 忽略 */ }   // 让投递逻辑重新认领
        wrote++
      } catch { /* 单步失败不影响其它 */ }
    }
    if (wrote || skipped) {
      event('route-steps', { steps: wrote, skipped, mode: isAppend ? 'append' : 'plan' })
      if (wrote) log(`fr_route：写出 ${wrote} 个步骤文件${skipped ? `（跳过 ${skipped} 个已存在/已完成）` : ''}`)
    }
    if (wrote && !isAppend) {
      // ★ 2026-11-07：**append 模式跳过这段清理**。
      //   原逻辑会删掉「编号 > 本批最大步号」的残留步骤。在 append 模式下，
      //   本批只写 S6/S7，maxK2=7；而盘上若已有 S8/S9（上一批补的），会被误删。
      //   清理只在 plan（全量重规划）时才有意义。
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
    // ★★ 2026-11-07 修复：route 写入后**立即**检查里程碑缺口，不等 30s tick。
    //   事故：tick 是 30 秒一次，而短任务（L1-L3）从 route 到归档只要 19 秒
    //   ⇒ checkLookahead 一次都没跑到 ⇒ 后台只写 2 步就再没人催 ⇒ 里程碑 4 个只兑现 2 个。
    //   实测：23 次归档 18 次有缺口，全库 milestone-gap 事件 0 条（催补从未生效）。
    //   现在在这里同步触发一次（不等下一 tick），并用 setTimeout 让投递逻辑先跑完。
    //   ★ 2026-11-07 二次修正：判据必须用**盘上的总步数**，不能用本批 st.length。
    //     append 模式下本批只写 2 步，但盘上可能已有 6 步 ⇒ 用 st.length 会误判为有缺口。
    let totalOnDisk = 0
    try { totalOnDisk = readdirSync(P.stepsDir).filter(f => /^S\d+\.md$/.test(f)).length } catch { /* 忽略 */ }
    if (wrote && ms.length > totalOnDisk) {
      event('route-gap-immediate', { milestones: ms.length, stepsOnDisk: totalOnDisk, batch: st.length, mode: isAppend ? 'append' : 'plan' })
      log(`fr_route：里程碑 ${ms.length} > 盘上步骤 ${totalOnDisk}，立即排程催补（不等 tick）`)
      try { setTimeout(() => { try { checkLookahead() } catch (e) { log('即时催补失败: ' + e.message) } }, 3000) } catch { /* 忽略 */ }
    }
    return { ok: true, mode: isAppend ? 'append' : 'plan', chars: body.length, milestones: ms.length, sentinels: sn.length, stepsWritten: wrote, stepsSkipped: skipped }
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
    // ★★ 2026-11-07 顺序修复：**缺口检查必须放在 hasDeliver 之前**。
    //
    // 原顺序：if (hasDeliver()) return   →  再做缺口检查
    // 后果：deliver 一旦存在（哪怕上一轮残留、哪怕只兑现了 2/4 个里程碑），
    //      缺口检查就被短路，催补永不触发。
    // 实测：黑板残留 deliver.v1.md 时，10 轮强制编排里 milestone-gap 事件 0 条。
    //
    // 语义修正：**交付 ≠ 规划完成**。deliver 只表示"前台说活干完了"，
    // 不代表后台列的 milestones 都兑现了。缺口还在就必须继续催，与 deliver 无关。
    const ms = routeMilestoneCount()
    if (ms > steps.length) {
      if (milestoneGapCount < 3) {
        milestoneGapCount++
        wakeBack('need-next', `【补步】route.md 列了 ${ms} 个里程碑，但 steps 只有 ${steps.length} 个（[${steps.map(n => 'S' + n).join(',')}]，done=S${doneNo}）。请补写缺失的步骤文件 —— **每个里程碑必须对应一个步骤**，写完即停。`)
        event('milestone-gap', { milestones: ms, steps: steps.length, done: doneNo, attempt: milestoneGapCount })
        log(`规划闭环：里程碑 ${ms} > 步骤 ${steps.length}，已催后台补步（第 ${milestoneGapCount} 次）`)
      }
      return
    }
    milestoneGapCount = 0                  // 缺口补齐 → 计数归零
    // 缺口已补齐后，才轮到"已交付就收工"的短路
    if (hasDeliver()) return
    const maxNo = Math.max(...steps)

    // ══ ★★ 2026-11-07 改动 4：合并「预取(prefetch)」与「催单(need-next)」两条重叠规则 ══
    //
    // 原实现有两条独立规则，判据重叠：
    //   ① remain <= watermark        → prefetch（水位不足就预取）
    //   ② doneNo+1 缺料              → need-next（真的断了才强力催）
    // 实测后果：同一个需求被催两次（`+16.9s need-next` 与 `+18.0s need-next` 间隔仅 1.1s）。
    //
    // 现在合并成一条统一判据：**前台在跑 + 后台空闲 + 未交付 + 缓冲不足(<=水位)**。
    // 冷却时间由 prefetchCooldownFor 决定（有缺口 2s / 常规 5s），是"防重复唤醒"而不是"控制节奏"。
    //
    // 为什么不加"未完成就无限催"：实测后台响应中位仅 7 秒、前台单步中位 8.2 秒，
    // 后台从来不慢，问题在"每次催都要完整重规划"——那个已由 mode=append 解决（改动 1）。
    // 所以这里只需要在"缓冲不足"时催，不必更激进。
    const remain = steps.filter(n => n > doneNo).length
    const frontBusy = !!(front && front.phase && front.phase.kind === 'running')
    const backBusy = !!(back && back.phase && back.phase.kind === 'running')
    const watermark = prefetchWatermark()
    const now = Date.now()

    if (frontBusy && !backBusy && remain <= watermark) {
      const cd = prefetchCooldownFor(ms, steps.length, remain)
      if (now - lastPrefetchAt >= cd) {
        lastPrefetchAt = now
        // 断粮（前方一步都没有）用更强的措辞，其余用"预规划"措辞
        const starving = remain === 0
        const nextNo = maxNo + 1
        wakeBack('need-next',
          starving
            ? `【催单·断粮】前台 done=S${doneNo}，steps 现有 [${steps.map(n => 'S' + n).join(',')}]，**前方已无步骤**。` +
              `请立刻用 ${TN('fr_route')}({mode:"append", steps:[...]}) 补写 S${nextNo} 起的新步骤（至少 2 步，自包含、含可验收判据）。` +
              `**不要写 deliver**。`
            : `【预规划·流水线】前台正在跑（done=S${doneNo}，前方仅剩 ${remain} 个未执行步骤 <= 水位 ${watermark}）。` +
              `请用 ${TN('fr_route')}({mode:"append", steps:[...]}) 从 S${nextNo} 起补到至少 ${watermark} 步缓冲。` +
              `**已存在的步骤不要重写**（append 模式会自动跳过）。**不要写 deliver**。`)
        event(starving ? 'need-next-starvation' : 'prefetch', { done: doneNo, remain, maxNo, watermark, maxSteps: ms })
        log(`统一催补：${starving ? '断粮' : '缓冲不足'}（remain=${remain}, watermark=${watermark}, maxNo=S${maxNo}）`)
        return
      }
    }
    // 前台没在跑（或后台正忙）⇒ 本轮不催，等下一 tick
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
    // ★★ 2026-11-08 灰区分诊回执：这轮是"灰区 → quick + 后台分诊"启动的，
    //   若后台**没写 verdict 而是写了 route** ⇒ 它判定需要编排 ⇒ 让前台切过去。
    //   这是"前台先干、后台并行判"闭环的最后一环。
    try {
      if (lastTriage && lastTriage.tend === 'gray' && !lastTriage.settled) {
        const routeNow = existsSync(P.route) ? statSync(P.route).mtimeMs : 0
        if (routeNow > lastTriage.at) {
          lastTriage.settled = 'upgraded'
          event('triage-upgraded', { score: lastTriage.score })
          log('灰区分诊：后台写了 route ⇒ 判定需要编排，切 coding 并引导前台按步骤走')
          try { applyMode('coding', 'auto', 'triage-upgraded') } catch { /* 忽略 */ }
          steerFront('【后台分诊：需要编排】后台判定这任务确实需要编排，路线已写好。\n' +
            '**现在按 .board/steps/ 里的步骤继续做**；你已完成的改动保留，不要重做。', 'triage-upgrade')
          return
        }
      }
    } catch { /* 忽略 */ }

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
    // ★ 2026-11-07：归档缺口守卫要用（scheduler.js 的 archiveBoardIfDone 里调）
    routeMilestoneCount: BB.routeMilestoneCount,
    get P(){ return P },
  }
  const Sched = makeScheduler({ S: SB, B, log, event, steerFront, wakeBack, lastAssistantText })
  const { prefetchWatermark, effectiveBatch, observeDeliveryForAdapt, parseStepMeta, checkAnalysisDelivery, checkMilestoneReview, archiveBoardIfDone, cleanupWorkers, resetTaskScheduler } = Sched
function annotateSteps () {
  try {
    const st = readState()
    const routeVer = st.planVersion || '1'
    const files = readdirSync(P.stepsDir).filter(f => /^S\d+\.md$/.test(f)).sort()
    let prev = null
    for (const f of files) {
      const full = join(P.stepsDir, f)
      let body = ''
      try { body = readFileSync(full, 'utf8') } catch { continue }
      if (body.includes('fr-meta:')) { prev = f; continue }
      const meta = '<!-- fr-meta: route:v' + routeVer + ' based:' + (prev || 'route') + ' at:' + new Date().toISOString() + ' -->\n'
      try { writeFileSync(full, meta + body, 'utf8'); prev = f } catch { /* ignore */ }
    }
  } catch { /* 注释失败不影响主流程 */ }
}

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
      finalAuditRetry = 0
      lastAuditedDeliverKey = ''
      taskWakes = 0
      taskFreezes = 0
      budgetAlerted = false
      changedFiles.clear()
      diffReviewCount = 0
      lastDiffReviewAt = 0
      lastTodoKey = ''
      finalAsked = false
      // 每任务重置"调用契约错"的提示与前台最近动作，避免跨任务串味
      try {
        toolStats.callErrHinted.clear()
        toolStats.callErrStreak = 0
        toolStats.lastCallErrName = ''
        toolStats.recent.length = 0
      } catch { /* 忽略 */ }
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
    // ★★ 2026-11-07 删除「并行组 P1」机制（三个事实证明它无用）：
    //   ① 后台**从未标过**并行组（归档 3 份，0 处「并行组」字段）
    //   ② 投递逻辑**不看**它 —— checkNewSteps 只按步号连续取，不按组投递
    //   ③ 前台**本来就会自己并行** —— L4 r2 实测有 7 批并行工具调用，全由前台自己判断
    //   所以「消息里加一句 ⚡ 并行组提示」这一环可有可无，保留只是噪音。
    steerFront(`${head}\n\n${parts.join('\n\n')}`, 'new-step')
    finalAsked = false   // ★ 新步骤到达 ⇒ 重置终局守卫（否则第二次清单耗尽时不会再触发终局询问）
    finalAnswerAsked = false   // 新步骤到达 ⇒ 重置终局正文守卫
    event('step-delivered', { files: names, chars: picked.reduce((s, p) => s + p.body.length, 0) })
    vlog('step-delivered', { files: names, batch: picked.length })
    queueTodoSync('step-delivered')
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
        // ★ 2026-11-07：预取提示要带上缺口，否则后台不知道还差几步
        const msNow = routeMilestoneCount()
        const backBusyNow = !!(back && back.phase && back.phase.kind === 'running')
        const now2 = Date.now()
        // ★ 2026-11-07：缺口驱动冷却 + 交付不该挡住"补缺口"
        //   原条件 `&& !hasDeliver()` 会在有 deliver 时彻底停掉预取 ——
        //   但缺口（ms > steps）恰恰是最需要补的时候，与是否交付无关。
        const gapNow = msNow > allNow.length
        const cd2 = prefetchCooldownFor(msNow, allNow.length, remainNow)
        if (!backBusyNow && remainNow <= watermark && now2 - lastPrefetchAt >= cd2 && (!hasDeliver() || gapNow)) {
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
            `已存在的步骤不要重写。` +
            // ★ 2026-11-07 修复：与上一处同理 —— 预规划阶段绝不引导写 deliver。
            `**不要写 deliver**（deliver 只由终局复核触发）。` +
            (msNow > allNow.length ? `route 列了 ${msNow} 个里程碑但只有 ${allNow.length} 个步骤，请补全缺口。` : '') +
            `写完即停。` + prereadHint)
          event('prefetch', { done: doneNow, remain: remainNow, maxNo: maxNow, trigger: 'step-delivered' })
          log(`流水线预规划（投递后即时）：剩余 ${remainNow} 步 <= 水位 ${watermark}，已唤醒后台补步`)
        }
      }
    } catch (e) { log('post-deliver prefetch fail: ' + e.message) }
  }

  // ══ 对外 API 装配（/fr 页面 + 外部脚本共用）═════════════════════════════════
  // 这里把插件的内部能力收敛成一个 app 对象，交给 lib/api.js 注册成 HTTP 端点。
  // 好处：页面/脚本/以后的其他工具都能用同一套接口，不必依赖 fr_poke 工具。
  /** 当前该挂的预设名：applyPatchPreset 打开时用 fast-react-front（standard + apply_patch）
   *  ★ 用函数声明而不是 const 箭头：它被 5 处 mount 调用，函数声明会提升，杜绝 TDZ。*/
  function presetName () {
    const p = cfg.agentPreset || 'standard'
    return (cfg.applyPatchPreset && p === 'standard') ? 'fast-react-front' : p
  }

  const apiApp = {
    basePath: BASE_PATH,
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
    // 干扰预算（每任务唤醒/冻结次数，超阈值已记事件）
    getBudget: () => ({ wakes: taskWakes, freezes: taskFreezes, limit: Number(cfg.budgetWakes) || 12, exceeded: budgetAlerted }),
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

    /** ★ 2026-11-08 刹车：按范围停止（front/back/all），**不禁用插件**、不销毁会话。
     *  与 stopAll 的区别：stopAll 关掉整个插件；brake 只踩当前任务，插件继续待命。
     *  同时设 pauseAt，否则下一个 tick 插件又会自动唤醒后台（等于没刹住）。 */
    brake (scope = 'all', reason = 'manual') {
      const out = { scope, stopped: [], kept: [] }
      const setPauseNow = () => { pauseAt = Date.now(); userStopAt = pauseAt }
      const kill = (ag, label) => {
        if (!ag) { out.kept.push(label + ':未接线'); return }
        try {
          const running = !!(ag.phase && ag.phase.kind === 'running')
          if (running) { ag.cancel(new Error('brake: ' + reason)); out.stopped.push(label) }
          else out.kept.push(label + ':空闲')
        } catch (e) { out.kept.push(label + ':停止失败(' + (e && e.message || e) + ')') }
      }
      if (scope === 'front' || scope === 'all') kill(front, 'front')
      if (scope === 'back' || scope === 'all') kill(back, 'back')
      // 只有全停才进入暂停态；只停一边时另一边的流程还得继续
      if (scope === 'all') setPauseNow()
      event('brake', out)
      log('刹车：' + JSON.stringify(out))
      return out
    },

    /** 解除刹车（恢复自动推进） */
    unbrake () {
      pauseAt = 0
      userStopAt = 0
      event('unbrake', {})
      log('刹车已解除，恢复自动推进')
      return { ok: true, paused: false }
    },

    /** 停止：取消正在跑的前后台（不销毁会话） */
    stopAll () {
      pauseAt = Date.now()         // ★ 真·用户暂停：优先级最高，连消防说明的 force 也不放行
      userStopAt = pauseAt         // ★ 用户点了停止 ⇒ 尊重意图，15s 内不再内联追加      const r = { front: false, back: false }
      try { if (front && front.phase && front.phase.kind === 'running') { front.cancel(new Error('api stop')); r.front = true } } catch { /* 忽略 */ }
      try { if (back && back.phase && back.phase.kind === 'running') { back.cancel(new Error('api stop')); r.back = true } } catch { /* 忽略 */ }
      return r
    },

    /** 重建：优先 cfg.provider/model（或显式传入），兜底全局默认模型；cwd 用 boardRoot */
    async rebuildSessions (explicit) {
      if (!svcAgentLoop || !svcPresets) return { error: 'agentLoop / agentPresets 服务未就绪' }
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
        return routeFor(tag)          // 已包含 frontProvider/backProvider 优先逻辑
      }
      const mk = async (tag) => {
        const r = effRoute(tag) || {}
        if (!r.provider || !r.model) return null
        const ag = await svcAgentLoop.create((TAG === 'a' ? 'session-fr-' : 'session-fr-' + TAG + '-') + tag + '-' + Date.now().toString(36),
          { provider: r.provider, model: r.model, reasoningEffort: effortFor(tag) }, { cwd: boardRoot })
        try { await svcPresets.mount(ag.ctx, presetName()) } catch (e) { log('挂预设失败: ' + e.message) }
        // ★★ 2026-11-07：会话一创建就立刻挂工具面（窗口 = 0，不等 resolveAgents）
        try { attachToolPolicyFor(tag, ag) } catch (e) { log('重建即时挂工具面失败: ' + e.message) }
        return ag
      }
      try { if (front) front.cancel(new Error('rebuild')) } catch { /* 忽略 */ }
      try { if (back) back.cancel(new Error('rebuild')) } catch { /* 忽略 */ }
      const f = await mk('front')
      const b = await mk('back')
      if (!f || !b) return { error: '拿不到模型路由（请设置 frontProvider/frontModel 或全局 provider/model）' }
      wire(idOf(f), idOf(b))
      // ★ 只在**显式传入**时才持久化（那是用户本轮的明确意图）。
      //   绝不把 resolveRoute 的 base 写回 cfg（那会污染角色覆盖）。
      if (explicitRoute) {
        overrides.provider = explicitRoute.provider
        overrides.model = explicitRoute.model
        cfg.provider = explicitRoute.provider
        cfg.model = explicitRoute.model
        saveOverrides()
      }
      briefed.clear()
      resolveAgents()          // ★ 立刻按新接线解析，避免后续逻辑仍拿旧的 front/back
      const fr = effRoute('front') || {}
      const bk = effRoute('back') || {}
      return {
        front: idOf(f), back: idOf(b),
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
        const FIRE = getFire(TAG)
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
      if (a === front) lastTaskText = body.slice(0, 4000)
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
      if (a === front) {
        try { resetTaskScheduler() } catch (e) { log('任务状态重置失败: ' + e.message) }
        taskBatchOverride = 0
        lastAgentError = null
      }
      // ── 模式自动判型（Phase 1）：用户发来新任务、且目标就是前台、且没被锁定时，
      //    按文本判一次；判型失败无害（默认 coding，与旧行为一致）。
      if (cfg.modeAuto !== false && !cfg.modeLocked && a === front) {
        try {
          // ★★ 2026-11-08 判型引擎 v2：三档判定 + 灰区并行分诊
          //
          //   · score <= -2  ⇒ 确信 quick，前台直接做（不惊动后台）
          //   · score >= 8   ⇒ 确信 coding，走标准编排
          //   · 中间灰区      ⇒ quick + **并行唤醒后台分诊**（前台不等，继续做）
          //
          //   分诊是对"词表不可靠"的兜底：机械判型免费但会误判，
          //   灰区里让真正的判断者（后台 LLM）看一眼，成本一次唤醒、不占前台墙钟。
          //
          //   严格模式（mode_strict / pin）下跳过一切判型与分诊。
          const prevText = String(lastDetectText || '').slice(0, 120)
          const thisText = String(body || '').slice(0, 120)
          const isSameTask = prevText && prevText === thisText
          const userPinned = (modeBy === 'user' && isSameTask)

          if (modePinned) {
            log('判型跳过：模式已被 pin 锁定')
          } else if (opts && opts.mode) {
            // ★ 显式模式（Agent/API 指定）——优先级最高，跳过机械判型
            const want = String(opts.mode)
            if (MODE_KEYS.includes(want)) {
              if (currentMode() !== want) applyMode(want, 'user', 'api:explicit')
              event('mode-explicit', { mode: want, strict: !!(opts && opts.mode_strict) })
              log(`模式由调用方显式指定 → ${want}${opts.mode_strict ? '（严格，不判型不分诊）' : ''}`)
            } else {
              log(`显式模式非法「${want}」，回落自动判型`)
            }
          } else if (opts && opts.mode_strict) {
            log('判型跳过：调用方要求严格模式（mode_strict）')
          } else if (userPinned) {
            log(`判型跳过：用户手选 ${currentMode()}（同一任务内保持）`)
          } else {
            const tri = shouldOrchestrate(body)
            lastTriage = { at: Date.now(), tend: tri.tend, score: tri.score, hits: tri.hits, taskText: thisText }
            event('detect-v2', { tend: tri.tend, score: tri.score, hits: tri.hits.slice(0, 8) })
            log(`判型 v2：${describeTendency(tri)} 命中[${tri.hits.slice(0, 6).join(',')}]`)

            if (tri.tend === 'coding') {
              if (currentMode() !== 'coding') {
                const r = applyMode('coding', 'auto', body.slice(0, 60))
                if (r && r.ok) log('判型 → coding（确信需要编排）')
              }
            } else {
              // quick（确信）或 gray（灰区）都以 quick 起步 —— 前台先干，不空等
              if (currentMode() !== 'quick') {
                const r = applyMode('quick', 'auto', body.slice(0, 60))
                if (r && r.ok) log(`判型 → quick（${tri.tend === 'gray' ? '灰区，将并行分诊' : '确信不需要编排'}）`)
              }
              // 灰区：并行唤醒后台做分诊（不阻塞前台）
              if (tri.tend === 'gray' && !(opts && opts.noTriage)) {
                try {
                  const woke = wakeBack('triage',
                    '【分诊·只做 1 件事，别规划别写步骤】\n' +
                    '判断这个任务需不需要编排（要不要写 route + steps）。判据：\n' +
                    '· 规格已给、≤2 文件、≤100 行、无需架构设计 ⇒ 写 .board/verdict.md 一行「short: <理由>」，然后停。\n' +
                    '· 需要自己设计架构 / 跨 3+ 文件 / 有并发·事务·恢复要求 ⇒ 正常调用 fr_route 写路线。\n' +
                    '前台已经开做了，你的判断只决定「要不要接管编排」，不要打断它。')
                  event('triage-woken', { woke: !!woke, score: tri.score })
                  if (woke) log(`灰区 ⇒ 已并行唤醒后台分诊（score=${tri.score}）`)
                } catch (e) { log('分诊唤醒失败: ' + e.message) }
              }
            }
          }
          lastDetectText = thisText
          // 新任务到达 ⇒ 清 pin（pin 只对上一条任务有效）
          try { if (modePinned && !isSameTask) { modePinned = false; event('mode-unpinned', {}) } } catch { /* 忽略 */ }
          // 新任务 ⇒ 重置兜底标记
          try { autoUpgradedThisTask = false; lastEscalateAt = 0 } catch { /* 忽略 */ }
        } catch (e) { log('模式判型失败: ' + e.message) }
      }
      // ★ §22 优化①：检测编号列举步骤数 ⇒ 本任务一次投全批（前台一个回合做完，省 5 次往返）
      try {
        const numbered = body.match(/[①-⑳]|^\s*\d+[.、）)]/gm) || []
        const cnSteps = body.match(/第[一二三四五六七八九十]+步/g) || []
        const count = Math.max(numbered.length, cnSteps.length)
        taskBatchOverride = count >= 3 ? Math.min(count, 8) : 0
        if (taskBatchOverride) log(`编号步骤任务：批量覆盖 = ${taskBatchOverride}`)
      } catch { /* 判定失败不影响投递 */ }
      const running = !!(a.phase && a.phase.kind === 'running')
      let cancelled = false
      if (interrupt && running) {
        try { a.cancel(new Error('send-interrupt')); cancelled = true } catch { /* 忽略 */ }
        if (cancelled) await new Promise((r) => setTimeout(r, 400))
      }
      lastBeatAt = Date.now()   // ★ §31 修复：新任务/插话起点 = 心跳基线重置（防 H3 把空闲期计入停滞误杀新任务）
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
      if (a === front && !isSteerInsert) {
        // ★ 2026-11-07：催补计数无条件随任务重置。
        //   原实现只在"缺口补齐"时归零，会跨任务累积：上一任务催 3 次未响应，
        //   新任务的缺口就一次也催不出来（`milestoneGapCount < 3` 恒假）。
        milestoneGapCount = 0
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
            lastAuditedDeliverKey = ''
            finalAuditRetry = 0
            finalAsked = false
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
            writeAtomic(P.state, 'planVersion: 0\nstatus: working\ndone: S0\nassumesMatch: yes\nrouteOk: yes\n')
          } catch { /* 忽略 */ }
          try { seenSteps.clear() } catch { /* 忽略 */ }
          milestoneGapCount = 0
          // ★★ 2026-11-07 改动 2：任务原文落盘（后台规划的唯一真相源）
          //   原来 api-task 只记 chars（字符数），原文根本没落盘 ⇒
          //   后台只能靠交接包里被压缩过的 goal 字段猜任务是什么。
          //   现在原文写进 .board/task.md，后台醒来直接 read，不用猜。
          try {
            writeAtomic(join(boardDir, 'task.md'), body)
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
          if (back && back.phase && back.phase.kind === 'running') {
            back.cancel(new Error('new-task-supersedes'))
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
        const id = (TAG === 'a' ? 'session-' : 'session-' + TAG + '-') + key.toLowerCase() + '-' + tag + '-' + Date.now().toString(36)
        const ag = await svcAgentLoop.create(id, { provider: routeFor(tag).provider, model: routeFor(tag).model, reasoningEffort: effortFor(tag) }, { cwd: boardRoot })
        await nameSession(ag, tag, key)
        try { await svcPresets.mount(ag.ctx, presetName()) } catch (e) { log('组挂预设失败: ' + e.message) }
        // ★★ 2026-11-07：会话组会话同样必须**一创建就挂**工具面（与 autoheal/rebuild 一致）。
        //   漏了这里 ⇒ 用「新建会话组」起的会话是 68 个工具（含 dev_*/hindsight_*/fr_escalate），
        //   而用户日常主要就是用组。
        try { attachToolPolicyFor(tag, ag) } catch (e) { log('组创建即时挂工具面失败: ' + e.message) }
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
        try { await svcPresets.mount(ag.ctx, presetName()) } catch { /* 忽略 */ }
        // ★★ 2026-11-07：组自愈重建的会话也必须立刻挂工具面
        try { attachToolPolicyFor(tag, ag) } catch (e) { log('组自愈即时挂工具面失败: ' + e.message) }
        return idOf(ag)
      }
      // ★ 多实例（2026-11-07）：重编号必须用本实例前缀，否则 b 的 FR-b-02 会被改回 FR-02，
      //   下次 nextGroupKey 又会撞号（自愈反而制造 bug）。
      const KEY_PREFIX = TAG === 'a' ? 'FR-' : ('FR-' + TAG + '-')
      const mine = list.filter((g) => {
        const k = String((g && g.key) || '')
        if (!k.startsWith(KEY_PREFIX)) return false
        if (TAG === 'a' && /^FR-[b-z]-/.test(k)) return false
        return true
      })
      for (let n = 0; n < mine.length; n++) {
        const g = mine[n]
        const want = KEY_PREFIX + String(n + 1).padStart(2, '0')
        if (g.key !== want) { report.renumbered.push({ from: g.key, to: want }); g.key = want }
      }
      // 会话自愈对**全部**组做（各实例只认自己的会话，isFrSession 已过滤）；
      // 重编号只动本实例前缀的组，绝不改别的实例编号。
      for (const g of list) {
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
        'frontProvider', 'frontModel', 'backProvider', 'backModel', 'batchAdapt', 'preread', 'workersEnabled',
        'verboseLog', 'finalAudit', 'finalAuditMaxRetry', 'todoMirror', 'budgetWakes', 'blockToolFold', 'tier', 'workerMax', 'fanoutWorkers', 'reviewDiffEnabled', 'applyPatchPreset', 'pollUnified', 'firstFrameEcho']
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
var KEY='__frLoader'+__FR_TAG__;
if(window[KEY])return;window[KEY]=1;
var lastVer='';
function load(){
  fetch(__FR_BASE__+'/sidebar.js?t='+Date.now(),{cache:'no-store'}).then(function(r){return r.text()}).then(function(txt){
    // 内容指纹：长度 + 首尾片段（比只比长度可靠）
    var ver=txt.length+':'+txt.slice(0,80)+':'+txt.slice(-120);
    if(ver===lastVer)return;
    lastVer=ver;
    var s=document.createElement('script');
    s.src=__FR_BASE__+'/sidebar.js?v='+Date.now();
    s.async=true;
    s.onerror=function(){try{console.error('[fast-react-'+__FR_TAG__+'] sidebar.js 加载失败')}catch(_){}};
    (document.body||document.documentElement).appendChild(s);
  }).catch(function(){});
}
if(document.body){load()}else{document.addEventListener('DOMContentLoaded',load)}
setInterval(load,3000);
})()`
  // ── 侧边栏浮层已停用（2026-11-06）────────────────────────────────────────
  //   控制台已改为官方应用级页面（@dsh-external/dsh-fast-react-ui 的 client 半边，
  //   走 sidebar.panellist + main slot），不再向 DSH 页面注入 fixed 浮层。
  //   /fr 页面与 /fr/api/* 端点保留：官方页面直接嵌它。
  //   需要回退：把下面这段的注释恢复即可（SIDEBAR_LOADER 仍在）。
  // try {
  //   ctx.on('webserver/index-inject', (table) => {
  //     try {
  //       if (!Array.isArray(table)) return
  //       if (table.some(r => r && typeof r.text === 'string' && r.text.indexOf('__frLoader') >= 0)) return
  //       table.push({ kind: 'script', placement: 'body', text: SIDEBAR_LOADER })
  //     } catch { /* 注入失败不影响插件其它部分 */ }
  //   })
  // } catch (e) { log('侧边栏 loader 注册失败: ' + (e && e.message || e)) }

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
        log(`Web 控制台已注册 [实例 ${TAG}] ${BASE_PATH}（${n - 1} 个 API 端点）`)
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
    log(`启动 [实例 ${TAG}] base=${BASE_PATH} board=${boardDir} front=${idOf(front) || '(未接线)'} back=${idOf(back) || '(未接线)'}`)

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
        // ★★ 2026-11-07 递归环硬拦（第二道，restrict 丢挂时仍生效）
        //   事故原理：这些 fr_* 工具本身就是「驱动另一个会话」的入口，
        //   若后台也能调，就构成 后台→fr_escalate→wakeBack→后台 的自唤醒死循环
        //   （每轮都写 handoff、每轮都唤醒自己，永远不停，且不断烧 token）。
        //   前台调 fr_route 也会绕过"后台唯一规划者"的设计，同样拦。
        const isFrontNow = isFront(exec.agent)
        const isBackNow = isBack(exec.agent)
        // ★ 2026-11-07（环 2 配套）：worker 会话的 guard。
        //   worker 是只读检索会话，**任何 fr_*（尤其 fr_escalate / fr_route / fr_poke）都不许调**。
        //   原因：worker 一旦能 fr_escalate 就写 handoff 唤醒后台 ⇒ 越权驱动编排；
        //   能 fr_route 就能伪造路线。restrict 会因会话重建丢失，这里做第二道。
        if (isWorkerAgent(exec.agent)) {
          if (/fr_/.test(String(exec.name || ''))) {
            event('block-recursive', { tool: String(exec.name), who: 'worker' })
            return `只读检索 worker 禁止调用 ${exec.name}：worker 不参与编排（不能唤醒后台、不能写路线）。结果请写进 .board/workers/ 结果文件。`
          }
        }
        if (isBackNow) {
          if (/^(fr_escalate|fr_mode|fr_worker|fr_status)$/.test(String(exec.name || ''))) {
            event('block-recursive', { tool: String(exec.name), who: 'back' })
            return `后台禁止调用 ${exec.name}：它用于驱动/唤醒其它会话，后台自己调会形成自唤醒死循环。后台的产出通道只有 fr_route（写黑板）。`
          }
        }
        if (isFrontNow && exec.name === TN('fr_route')) {
          event('block-recursive', { tool: 'fr_route', who: 'front' })
          return 'fr_route 只能由后台调用（前台请等步骤/写黑板）'
        }
        // ★ Phase 1 工具层第二道：restrict 只砍全局工具，会话级 scoped 工具（团队/运维类）
        //   仍会出现在工具表里 ⇒ 这里硬拒绝，双保险。
        if ((isFront(exec.agent) || isBack(exec.agent)) && isDeniedTool(exec.name, cfg.frDenyExtra)) {
          event('block-scoped', { tool: String(exec.name), who: isFront(exec.agent) ? 'front' : 'back' })
          return `快速反应的前台/后台禁止使用 ${exec.name}（团队/运维/跨会话类工具会绕过编排或抢占接线）`
        }
        // ★ 运维通道保护（2026-10-17）：插件注册的工具对**所有** agent 可见；若不拦，
        //   前台/后台能自己调 fr_poke 自我唤醒 / 绕过编排（实测观察到过不明 manual steer）。
        if (exec.name === TN('fr_poke') && (isFront(exec.agent) || isBack(exec.agent))) {
          event('block-opstool', { who: isFront(exec.agent) ? 'front' : 'back' })
          return 'fr_poke 是运维通道，前台/后台禁止调用；请走规定通道（前台用 fr_escalate，后台写黑板）'
        }
        // ★ 折叠工具（tool_fold / tool_groups）：编排会话不需要，而且有害（2026-11-07）
        //   1) 折叠会改变工具目录 ⇒ 每次折叠/展开都让请求前缀失效，破坏 prefix cache
        //   2) 前台被要求"一次并行 6-8 个调用"，工具被折起来后需要的工具会消失 ⇒ 白跑一轮
        //   3) 折叠状态是会话内存态，autoHeal 重建后复位 ⇒ 模型以为工具没了
        //   结论：对前台/后台硬禁（不影响普通交互会话里手动折叠）
        if (cfg.blockToolFold !== false
          && /^(tool_fold|tool_groups|collapse_tools)$/.test(String(exec.name || ''))
          && (isFront(exec.agent) || isBack(exec.agent))) {
          event('block-tool-fold', { tool: String(exec.name), who: isFront(exec.agent) ? 'front' : 'back' })
          return '快速反应的前台/后台不折叠工具面：编排会话按固定工具目录跑，折叠会破坏缓存前缀并让并行调用失败。'
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
      //   ★★ 2026-11-07 改造（改法 A + B）：
      //     A) 这里本来就在 turn-stopping 里，已经足够即时；但原条件 `!backBusy`
      //        会让"后台正在跑 review-diff 等低优先任务"时完全不催 ⇒ 前台干等 28 秒。
      //     B) 有里程碑缺口时，催补优先级**高于**后台正在做的任何事：
      //        用 wakeBack 的 reason 让上层决定"steer 还是打断"（见 wakeBack 里的 CRITICAL 处理）。
      //     实测依据（L3 任务时间线）：
      //        +11.5s milestone-gap attempt1 → 后台在跑 review-diff，被 steer 排队，没响应
      //        +13.9s 前台拉完 S2 → 没料
      //        +42.1s 才拉到 S3      ← 中间空等 28.1 秒
      //     现在：前台一转末就检查，有缺口立刻催，且不因后台忙而沉默。
      try {
        const stNow = readState()
        const doneNow = stepNo(stNow.done || '')
        const allNow = listSteps().map(stepNo)
        const maxNow = allNow.length ? Math.max(...allNow) : 0
        const remainNow = allNow.filter((x) => x > doneNow).length
        const wm = prefetchWatermark()
        const backBusy = !!(back && back.phase && back.phase.kind === 'running')
        const msIdle = routeMilestoneCount()
        const gapIdle = msIdle > allNow.length
        const cdIdle = prefetchCooldownFor(msIdle, allNow.length, remainNow)
        // ★ 缺口场景：即使后台在忙也要催（催补步优先于复核这类低优先工作）
        //   非缺口场景：保持原来的"后台忙就不打扰"
        const shouldWake = (gapIdle || !backBusy) && remainNow <= wm
        if (shouldWake && Date.now() - lastPrefetchAt >= cdIdle && (!hasDeliver() || gapIdle)) {
          lastPrefetchAt = Date.now()
          wakeBack('prefetch-urgent', `【空闲期预规划】前台刚好空闲、剩余步骤（${remainNow}）不足缓冲（${wm}）` +
            (gapIdle ? `，且 route 列了 ${msIdle} 个里程碑只写出 ${allNow.length} 个步骤（缺口 ${msIdle - allNow.length}）` : '') +
            `。请从 .board/steps/S${maxNow + 1}.md 起补到至少 ${wm + 1} 步；**不要写 deliver**（缺口未补齐前写 deliver 会被拒绝归档）。`)
          event('prefetch', { done: doneNow, remain: remainNow, maxNo: maxNow, trigger: 'turn-stopping-idle', gap: gapIdle, backBusy })
          log(`turn-stopping 催后台（trigger=turn-stopping-idle，gap=${gapIdle}，backBusy=${backBusy}）`)
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
    setFire(TAG, fireInterrupt)   // 按实例隔离，暴露给 fr_poke 的工具作用域

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
        // ★ 失败即学：该 route 不支持当前 effort ⇒ 记进黑名单，后续不再传
        if (/does not support reasoning effort/i.test(msg)) {
          try {
            const prov = String((payload && payload.provider) || '')
            const mo = String((agent && agent.options && agent.options.model) || cfg.model || '')
            if (prov && mo && !NO_EFFORT_ROUTES.has(prov + '/' + mo)) {
              NO_EFFORT_ROUTES.add(prov + '/' + mo)
              saveEffortLearned()
              event('effort-unsupported', { route: prov + '/' + mo })
              log(`记住：${prov}/${mo} 不支持 effort，后续不再传（已落盘）`)
            }
          } catch { /* 忽略 */ }
        }
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
        // ★ DSH 0.2.2 破坏性变更（2026-11-07 实测）：在 agent/request 里改写 provider/model
        //   会让引擎直接抛 "agent/request proposed ... after step preparation fixed ..."。
        //   正确通道是 step 准备前调用 agent.model.select()。
        //   这里改为：**不碰请求配置**，只把差异记录下来，由 syncRoute/ensureWiring 在
        //   会话 options 上同步（下次新建会话或重建时生效）。
        const cfg2 = await next()
        if (cfg2 && (cfg2.provider !== r.provider || cfg2.model !== r.model)) {
          event('route-drift', { role: tag, from: cfg2.provider + '/' + cfg2.model, to: r.provider + '/' + r.model })
          log('路由漂移 ' + tag + ': 请求用 ' + cfg2.provider + '/' + cfg2.model +
            '，期望 ' + r.provider + '/' + r.model + '（0.2.2 下不能中途改，需重建会话）')
          try {
            const a = tag === 'front' ? front : back
            if (a && a.options) { a.options.provider = r.provider; a.options.model = r.model }
            // ★ effort 兼容（2026-11-07）：模型不接受 reasoningEffort 时，把会话里残留的 effort 清掉，
            //   否则会出现 "does not support reasoning effort minimal" 而整轮失败。
            if (a && a.options && NO_EFFORT_RE.test(String(a.options.model || '')) && a.options.reasoningEffort !== undefined) {
              log('清除会话残留 effort(' + a.options.reasoningEffort + ')：' + a.options.model + ' 不支持')
              a.options.reasoningEffort = undefined
            }
            // 同时用新 API 记录选择（下一个 step 生效）
            if (a && a.model && typeof a.model.select === 'function') a.model.select({ provider: r.provider, model: r.model })
          } catch (e) { log('记录模型选择失败: ' + e.message) }
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
    // ②-b todo 镜像：每个 turn 开始重写一次快照（投影在 turn/start 会清空）
    yield ctx.on('session/event', (session, event) => {
      try {
        if (cfg.todoMirror === false) return
        if (!front || !front.session || session !== front.session) return
        if (event && event.type === 'turn/start') queueTodoSync('turn-start')
      } catch { /* 镜像失败绝不影响主流程 */ }
    })

    yield ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        if (!alive()) return next()      // 旧实例失效
        if (isFront(exec.agent)) {
          const ok = !(result && result.isError)
          const nm = String(exec.name || '?')
          toolStats.total++
          stepsThisTask++
          // ★★ 2026-11-08 执行层强制（A 方案）：coding 模式下前台不上交就催它上交
          //
          //   实测事故：判型明确判成 coding（L5 score=11），但前台看了简报觉得
          //   "我自己能做"就直接做了 —— 整轮 10/10 次 escalate=0，双会话空转。
          //   光改简报不够（模型会自我说服），必须在执行层**反复提醒**。
          //   触发：coding 模式 + 已跑 6 个工具 + 还没上交 ⇒ steer 一次（每任务最多 2 次）。
          try {
            if (currentMode() === 'coding' && !autoUpgradedThisTask) {
              if (stepsThisTask === 6 && !lastEscalateAt) {
                codingNotEscalated = true
                steerFront('【必须上交】你在 coding 模式下已跑了 6 个工具但还没调用 fr_escalate。\n' +
                  '**立刻调用 fr_escalate 上交**（reason/goal/hint 各一句即可），然后停手等 steps。\n' +
                  '这是本模式的硬规则：coding = 后台规划 + 前台执行，不要自己把整活干完。', 'must-escalate')
                event('must-escalate-nudge', { at: 6 })
                log('执行层强制：coding 模式 6 个工具未上交 ⇒ 已督促 fr_escalate')
              } else if (stepsThisTask === 12 && !lastEscalateAt) {
                codingNotEscalated = true
                steerFront('【第二次提醒】仍未见 fr_escalate。**现在就调它**，之后只需读 steps 执行。', 'must-escalate2')
                event('must-escalate-nudge', { at: 12 })
                log('执行层强制：12 个工具仍未上交 ⇒ 第二次督促')
              }
            }
          } catch { /* 督促失败不影响主流程 */ }

          // ★★ 2026-11-08 兜底：quick 模式跑太多工具 ⇒ 自动升级到编排
          //
          //   实测依据：L1-L4 单 Agent 最多用 16 个工具；L5 单 Agent 用 30-107 个。
          //   所以 25 是安全线 —— 超过说明"这活比预想的复杂"，qe 硬扛不如交给编排。
          //   只在 quick 模式生效，且每任务只触发一次（防刷）。
          try {
            if (currentMode() === 'quick' && !autoUpgradedThisTask && !hasDeliver() && stepsThisTask > 25) {
              autoUpgradedThisTask = true
              applyMode('coding', 'auto', '工具数兜底: ' + stepsThisTask)
              event('auto-upgrade', { tools: stepsThisTask, from: 'quick', to: 'coding' })
              log(`兜底升级：quick 模式已跑 ${stepsThisTask} 个工具仍未交付 ⇒ 切 coding 并唤醒后台`)
              wakeBack('auto-upgrade', `【兜底升级】前台在 quick 模式下已跑 ${stepsThisTask} 个工具仍未交付，判定为复杂任务。` +
                `请尽快调用 fr_route 规划路线（mode:"plan"），前台会按步骤继续。`)
            }
          } catch { /* 兜底失败不影响主流程 */ }
          // ★ #33 修：区分"调用契约错"和"真的做不下去"。
          //   工具名打错/参数不合法 ⇒ 调用根本没到工具本体，不计入 failStreak，
          //   否则同一个笔误连犯 3 次就会被 H4 判成"连续失败"→ 冻结前台 + 作废全部未执行步骤。
          const callErr = !ok && isCallContractError(result)
          if (ok) {
            toolStats.failStreak = 0
            toolStats.callErrStreak = 0
            toolStats.lastCallErrName = ''
          } else if (callErr) {
            toolStats.failStreak = 0                       // 不累积到哨兵
            toolStats.lastFailName = ''
            toolStats.callErrStreak = (toolStats.lastCallErrName === nm) ? (toolStats.callErrStreak + 1) : 1
            toolStats.lastCallErrName = nm
            // 同一个名字连续两次调用不合法 ⇒ 给一次明确提示（不改路线、不唤醒后台）
            if (toolStats.callErrStreak === 2 && !toolStats.callErrHinted.has(nm)) {
              toolStats.callErrHinted.add(nm)
              try {
                steerFront(`【提示】工具 ${nm} 的调用不合法（工具名或参数有误），这一次没有真正执行。请核对可用工具名与必填参数后重试。`, 'tool-call-error')
              } catch { /* 提示失败不影响主流程 */ }
            }
          } else {
            // ★ 按"失败的名字"聚合（2026-10-18 实测）：
            //   旧逻辑把跨不同工具、跨不同任务的失败也累加成 failStreak，
            //   导致上一轮任务的 web_fetch 失败残留到下一轮，一句「你好」就触发 H4 冻结。
            //   现在：连续失败必须**同一工具**才算堆积；换工具即重置。
            toolStats.failStreak = (toolStats.lastFailName === nm) ? (toolStats.failStreak + 1) : 1
            toolStats.lastFailName = nm
            toolStats.failTotal++
            toolStats.callErrStreak = 0
            toolStats.lastCallErrName = ''
          }
          // 最近动作环形缓冲：唤醒时随附给后台（见 appendToolSummary）
          try {
            toolStats.recent.push({ n: nm, ok, at: Date.now() })
            if (toolStats.recent.length > 8) toolStats.recent.shift()
          } catch { /* 忽略 */ }
          vlog('tool', {
            name: nm, ok, callErr,
            failStreak: toolStats.failStreak,
            callErrStreak: toolStats.callErrStreak,
            err: ok ? undefined : resultErrorText(result).slice(0, 160),
          })
          try {
            const wn = String(exec.name || '')
            if (ok && (wn === 'write' || wn === 'edit' || wn === 'writeText' || wn === 'editText' || wn === 'apply_patch')) {
              const a = exec.arguments || {}
              const fp = String(a.file_path || a.path || a.filePath || '')
              if (fp) changedFiles.add(fp)
              else if (wn === 'apply_patch') changedFiles.add('(multi-file patch)')
            }
          } catch { /* 忽略 */ }
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
          // ★ v2-效率改动（原实现是最大低效源：实测 37 次唤醒 / 1011 次工具调用）：
          //   前台工具失败大多是「路径写错/参数笔误/文件不存在」，前台自己就会重试改正，
          //   此时唤醒高档后台重规划 = 白烧一次 30s~2min 的生成。
          //   改为：只有在「同一工具连续失败 ≥2 次」（failStreak 机制已保证同工具才累加）
          //   才唤醒后台。首次失败只记日志，不唤醒。
          // ★ 触发阈值已收拢到 wakeBack 的 WAKE_POLICY（failStreak === 2）：
          //   这里只负责"失败了就上报"，要不要真唤醒由入口统一判定。
          //   调用契约错（工具名/参数不合法）已经在上面被排除，不参与该计数。
          if (!ok && !callErr) {
            wakeBack('tool-fail', `【T2】前台工具 ${nm} 连续失败 ${toolStats.failStreak} 次。请读 .board/state.md 与 heartbeat.log，判断是否需要调整计划。`)
          }
                // ── v2 新增：近距返工检测（唯一新增机制，专治"改坏又改回"）──
          // 为什么它省时间：返工是**纯浪费**（做错→改回=白做两步+多烧2轮模型），
          //   而"磨蹭"（步数多但每步都推进）不是浪费，不能干预。
          // 判据只认一件事：最近 6 次写类操作里，目标文件被反复改写且总字节数没增长。
          //   —— 这几乎必然是原地打转（改一次回一次），此时让后台介入才划算。
          try {
            const w = String(exec.name || '')
            if (ok && (w === 'write' || w === 'edit' || w === 'writeText' || w === 'editText')) {
              const a = exec.arguments || {}
              const fp = String(a.file_path || a.path || a.filePath || '')
              if (fp) {
                let sz = 0
                try { sz = statSync(fp).size } catch { sz = 0 }
                reworkTrail.push({ fp, sz, at: Date.now() })
                if (reworkTrail.length > 12) reworkTrail.shift()
                const recent = reworkTrail.slice(-6)
                const cur = recent[recent.length - 1]
                const sameFileHits = recent.filter(x => x.fp === cur.fp).length
                const grown = cur.sz - recent[0].sz
                // 同一文件 6 次内被写 ≥4 次，且总字节增长 < 200 → 判返工
                if (sameFileHits >= 4 && grown < 200) {
                  const k = 'rework:' + cur.fp
                  if (!reworkAlerted.has(k)) {
                    reworkAlerted.add(k)
                    event('rework-detected', { file: cur.fp, hits: sameFileHits, grown })
                    log(`近距返工：${cur.fp} 6 次内写 ${sameFileHits} 次且总量只增 ${grown}B → 唤醒后台`)
                    wakeBack('rework', `【返工】同一文件 ${cur.fp} 最近 6 次写操作里被改 ${sameFileHits} 次、总字节仅增 ${grown}B，疑似原地打转。请读 state.md 判断是否路线有误。`)
                  }
                }
              }
            }
          } catch { /* 返工检测失败不影响主流程 */ }
    // 重复动作（近似 H1；官方 repeat-tool-reminder 只管精确重复且只提醒）
          const key = exec.name + ':' + JSON.stringify(exec.arguments || {}).slice(0, 120)
          if (key === toolStats.lastSame) toolStats.sameCount++
          else { toolStats.lastSame = key; toolStats.sameCount = 1 }
          if (toolStats.sameCount === 4) wakeBack('stuck', `【H1】前台连续 4 次相同调用（${exec.name}），疑似打转。请给出脱困指令或改计划。`)
        } else if (isBack(exec.agent)) {
          // ★ M16 tick 事件化：后台一写完 steps 就立刻检查投递（原来只靠 30s 轮询）
          try { annotateSteps(); checkNewSteps() } catch { /* 忽略 */ }
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
            const auditPrompt = cfg.finalAudit === false ? null : buildFinalPrompt()
            if (auditPrompt) vlog('final-audit-start', { items: auditPrompt.acc.length })
            wakeBack('final', auditPrompt ? auditPrompt.text : '【终局】前台已跑完清单最后一步，请做终局复核：若完成，写 .board/deliver.v1.md；若未完成，写下一批 .board/steps/S*.md。')
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
        try { maybeReviewDiff() } catch { /* 只读审 diff 失败不影响主循环 */ }
        try { checkFinalAudit() } catch { /* 终局对照审失败不影响主循环 */ }
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
  const scopePatched = new Set()

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
      const want = new Set(allowListFor(currentMode(), role).map((n) => (String(n).startsWith('fr_') ? TN(n) : n)))
      let n = 0
      for (const def of FR_TOOL_DEFS) {
        const nm = def.name
        // ★ fr_status 已改为全局工具（所有会话都能查状态），这里跳过避免重复注册
        if (nm === TN('fr_status')) continue
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
      if (exists && globalRegistered.has(def.name)) return
      ctx.tools.register(def)
      globalRegistered.add(def.name)
      log(`全局工具 ${def.name} 已注册（所有会话可用）`)
    } catch (e) {
      log(`注册全局工具 ${def.name} 失败: ${e.message}`)
    }
  }
  const globalRegistered = new Set()

  globalRegister({
    name: TN('fr_task'),
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
        resolveAgents()
        const text = String((args && args.text) || '').trim()
        if (!text) return { ok: false, error: 'text 不能为空' }
        const opts = { external: true }
        if (args.group) opts.group = String(args.group)
        if (args.sessionId) opts.sessionId = String(args.sessionId)
        if (args.role) opts.role = String(args.role)
        if (args.mode && args.mode !== 'auto') opts.mode = String(args.mode)
        if (args.mode_strict) opts.mode_strict = true
        const r = await apiApp.deliver(opts, text, !!(args && args.interrupt))
        if (r && r.error) return { ok: false, error: r.error }
        event('tool-task', { group: opts.group || '', mode: opts.mode || 'auto', chars: text.length })
        return { ok: true, target: r.session || 'front', mode: opts.mode || 'auto', strict: !!opts.mode_strict }
      } catch (e) { return { ok: false, error: String(e && e.message || e) } }
    },
  })

  globalRegister({
    name: TN('fr_status'),
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
        resolveAgents()
        const out = {
          enabled: cfg.enabled,
          mode: currentMode(),
          modeBy,
          wiring: { front: front ? idOf(front) : null, back: back ? idOf(back) : null },
          running: {
            front: !!(front && front.phase && front.phase.kind === 'running'),
            back: !!(back && back.phase && back.phase.kind === 'running'),
          },
          board: boardDir,
          task: { chars: String(lastTaskText || '').length },
          lastTriage: lastTriage ? { tend: lastTriage.tend, score: lastTriage.score } : null,
          tools: { total: toolStats.total, failStreak: toolStats.failStreak },
        }
        if (args && args.group) {
          const g = loadGroups().find((x) => x.key === String(args.group))
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
    name: TN('fr_brake'),
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
        resolveAgents()
        return apiApp.brake(String((args && args.scope) || 'all'), String((args && args.reason) || 'tool'))
      } catch (e) { return { ok: false, error: String(e && e.message || e) } }
    },
  })

  // ── 以下为「快速反应内部角色」工具，仅 fr 会话可见（走 scope 注册）──
  safeRegister({
    name: TN('fr_status'),
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
    name: TN('fr_mode'),
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
      const r = applyMode(key, pin ? 'user' : 'agent', String((args && args.reason) || '模型声明'))
      if (pin) {
        modePinned = true
        event('mode-pinned', { mode: key })
        log(`模式被 pin 锁定 → ${key}（本任务不再自动判型/分诊）`)
      }
      return r
    },
  })

  safeRegister({
    name: TN('fr_worker'),
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
        try { fanoutMode = !!modeInfo(currentMode()).fanout } catch { /* 忽略 */ }
        if (!cfg.workersEnabled && !fanoutMode) return { ok: false, error: '只读 worker 未启用：配置 workersEnabled=true，或在 retrieval 模式下使用' }
        const task = String((args && args.task) || '').trim()
        if (!task) return { ok: false, error: 'task 不能为空' }
        if (!svcAgentLoop) return { ok: false, error: 'AgentLoop 不可用' }
        const wmax = Math.max(1, Math.min(8, Number(cfg.workerMax) || 2))
        if (workers.size >= wmax) return { ok: false, error: `并发 worker 已达上限（${wmax}）` }
        const id = (TAG === 'a' ? 'session-fr-worker-' : 'session-fr-' + TAG + '-worker-') + Date.now().toString(36)
        try { mkdirSync(join(boardDir, 'workers'), { recursive: true }) } catch { /* 忽略 */ }
        const outFile = join(boardDir, 'workers', id + '.md')
        const route = routeFor('front')
        const ag = await svcAgentLoop.create(id, { provider: route.provider, model: route.model, reasoningEffort: 'low' }, { cwd: boardRoot })
        try { if (svcPresets) await svcPresets.mount(ag.ctx, presetName()) } catch { /* 忽略 */ }
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
    name: TN('fr_poke'),
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
        const FIRE = getFire(TAG)
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
    name: TN('fr_route'),
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
    execute: async (args) => renderRoute(args || {}),
  })

  safeRegister({
    name: TN('fr_escalate'),
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
      resolveAgents()
      // ★★★ 2026-11-08 允许 quick 升级（解决 L3 不稳定）
      //
      //  实测事故：L3 判 quick（score=1），前台做了 27 个工具后自己意识到要编排，
      //  调用 fr_escalate 却被这里一刀切拒绝（escalate-blocked-by-mode），
      //  直到"25 工具兜底"把模式改成 coding 才放行 —— 白跑 27 个工具，单轮 143 秒。
      //
      //  设计修正：**前台主动要求上交，本身就是"这个任务比判型以为的复杂"的最强信号。**
      //  比机械判型和工具数兜底都准（前台有真实执行上下文）。
      //  所以：quick/retrieval 模式下允许上交，并自动升级到 coding。
      const mi = modeNow()
      if (!mi.backend) {
        const scored = shouldOrchestrate(lastTaskText || '')
        event('escalate-auto-upgrade', {
          from: mi.key, to: 'coding',
          score: scored.score, hits: scored.hits.slice(0, 5),
          frontAsked: true,
        })
        log(`前台在 ${mi.key} 模式下请求上交 ⇒ 自动升级 coding（判型分 ${scored.score}）`)
        try { applyMode('coding', 'auto', '前台请求升级') } catch { /* 忽略 */ }
        // 继续走下面的正常上交流程（不 return）
      }
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
        '## state.md 快照', readIf(P.state).slice(0, 800),
      ].join('\n\n')
      const ok = writeAtomic(join(boardDir, 'handoff.md'), doc)
      event('escalate', { reason: String(args.reason || '').slice(0, 140) })
      // ★ 2026-11-08：记录上交时刻（执行层强制敦促用它判断"是否已上交"）
      try { lastEscalateAt = Date.now(); codingNotEscalated = false } catch { /* 忽略 */ }
      // ★ 新任务开始 ⇒ 重置本任务计数（否则 H5「步数超阈」会永久误报 —— 后台自己诊断出来的 bug：
      //   stepsThisTask 原来跨 v1/ab2/ab3/吞吐测试一直累加，从不清零）
      stepsThisTask = 0
      alertedSentinels.clear()
      finalAuditRetry = 0
      lastAuditedDeliverKey = ''
      taskWakes = 0
      taskFreezes = 0
      budgetAlerted = false
      changedFiles.clear()
      diffReviewCount = 0
      lastDiffReviewAt = 0
      lastTodoKey = ''
      finalAsked = false
      cfg.batchSteps = DEFAULTS.batchSteps   // O2 自适应：新任务回到默认批量
      lastWakeAt = 0   // 显式上交不受冷却限制
      // ★ 首帧优化（2026-10-17）：把 handoff 内容**直接内联**进唤醒消息，省掉后台再 read 一次。
      //   ★ 2026-11-07：内联长度 1800 → 600。交接包瘦身后内容本身就短了（原文在 task.md）。
      let handoffBody = ''
      try { handoffBody = String(readIf(join(boardDir, 'handoff.md')) || '').slice(0, 600) } catch { /* 忽略 */ }
      const woke = wakeBack('escalate',
        `【前台上交】${String(args.reason || '')}\n\n` +
        `===== 交接包（已内联）=====\n${handoffBody}\n===== 交接包结束 =====\n\n` +
        '## 只做 1 件事，做完就停（禁止调研）\n' +
        '**先 read `.board/task.md`**（任务完整原文，这是唯一真相源，不要靠交接包里的摘要猜）。\n' +
        '若交接包列了「关键文件」，**优先读那几个**（前台已替你筛过，别再全目录乱搜）。\n' +
        '**然后调用一次 ' + TN('fr_route') + ' 工具**，一次给出：goal / acceptance / milestones / steps。\n' +
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
  /** 解析 route.md 的「## 哨兵条件」段（实现已抽到 sentinel.js，纯函数可单测） */
  const readSentinels = () => parseSentinels(readIf(P.route))

  /** 求值单条哨兵（实现已抽到 sentinel.js；这里注入本作用域的依赖） */
  const evalSentinel = (s) => evalSentinelPure(s, { readIf, readState, stepNo })

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
