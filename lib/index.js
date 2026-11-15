/**
 * @dsh-external/dsh-fast-react —— 快速反应插件（宿主半边，零构建 ESM）
 *
 * 目标：效率。前台（LOW）快答快做，后台（HIGH）逐条规划，两者只通过黑板交换信息。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ▍模块划分（v1.6.3 结构重构）
 * ══════════════════════════════════════════════════════════════════════════
 *  本文件（index.js）是**装配层 + 状态所有权**：持有 apply() 闭包与共享状态袋 K，
 *  通过依赖袋 D 把各业务模块串起来。跨模块可变状态一律走 K.<name>，
 *  跨模块函数调用一律走 D.<fn>（调用时读取，允许组装顺序交错）。
 *
 *  宿主业务模块（工厂 makeXxx(D)，各自文件头有职责/依赖/区块注释）：
 *    lib/groups.js      会话组 + Workspace 挂载 + 权限预设 + 组 API 方法
 *    lib/guards.js      看门狗 / T3 拦截 / 机械+业务哨兵 / 首帧兜底 / 上下文守护 / 档位漂移
 *    lib/mode-auto.js   applyMode / 每任务自动判型 / 相位策略 / 自动升级兜底
 *    lib/runtime.js     通道(wake/steer/预算) + heartbeat/todo 镜像 + 实时投递 + 催单 + 批量拆分 + renderRoute（第二阶段）
 *    lib/tools-reg.js   全部工具注册（全局入口 + 内部角色 + 自检）（第三阶段）
 *    lib/api-app.js     apiApp 剩余 glue（status/task intake/config/models/mode/events）（第三阶段）
 *  纯逻辑模块（可单测，无 D 依赖）：
 *    lib/board.js       黑板 IO（原子写 / 日志轮转 / state 解析 / steps 列表）
 *    lib/scheduler.js   调度核心（批量自适应 / 预取水位 / 里程碑复核 / 归档守卫）
 *    lib/modes.js       任务模式预设（5 种 + 自定义 + 判型引擎 v2 + 工具白名单）
 *    lib/route-plan.js  路线纯逻辑：参数校验 / 里程碑截断 / 哨兵预检 / 覆写决策 / 哨兵解析求值（1.6.3 并入 sentinel.js）
 *    lib/briefs.js      前后台角色简报 + 消息构造 msg（1.6.3 并入 messages.js）
 *    lib/defaults.js    默认配置与黑板根解析（多环境可移植）
 *    lib/policies.js    破坏性命令 / 关键唤醒原因的常量表
 *    lib/api.js         HTTP 路由（控制台 / 便捷 API / 侧边栏注入）
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ▍apply() 内的区块地图（按出现顺序，行号为约值）
 * ══════════════════════════════════════════════════════════════════════════
 *   L~150  配置加载（boardRoot/config.json 覆盖默认值）+ 多实例身份
 *   L~270  共享状态袋 K + 依赖袋 D 定义
 *   L~385  B1 黑板 IO 代理（实际实现在 board.js）
 *   L~420  B2 接线：识别前台 / 后台（含接线自愈、健康检查）
 *   L~793  makeRuntime 组装（通道 wake/steer/预算 + heartbeat/todo 镜像 + 实时投递 + 催单 + 批量拆分 + renderRoute）
 *   L~855  makeModeAuto 组装 + Phase2 调度器接入
 *   L~953  makeGuards 组装（看门狗/T3/哨兵/首帧/上下文守护/漂移）
 *   L~1088 makeGroups 组装（Workspace/组注册表/权限预设）
 *   L~1199 makeApiApp 组装 + apiApp 重组（{ ...AA, ...GR.api, ...GD.api }）（第三阶段移 api-app.js）
 *   L~1209 侧边栏 loader（死代码，待删）+ 独立页面注册（热重载兼容）
 *   L~1273 装配：effect + 全部监听器
 *   L~1948 makeToolsReg 组装（自检/全局入口/内部角色工具 + scope 注册）（第三阶段移 tools-reg.js）
 *   L~1950 B10 档位漂移接线 + B11 度量落盘
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
import { parseSentinels, evalSentinel as evalSentinelPure } from './route-plan.js'
import { validateRouteArgs, capMilestones, filterSentinels as filterSentinelsPure, buildRouteMarkdown, planOverwriteDecision } from './route-plan.js'
import { DEFAULT_MODE, MODE_KEYS, modeInfo, detectMode, shouldOrchestrate, describeTendency, allowListFor, modeNotice, briefFragment, adaptBatch, extractPaths, isDeniedTool, STRATEGY, STRATEGY_KEYS, defaultStrategyForStep, isTestSignal, nextTestFailStreak, setCustomModes, setPresetOverrides } from './modes.js'
import { FRONT_BRIEF, BACK_BRIEF } from './briefs.js'
import { DEFAULTS } from './defaults.js'
import { msg } from './briefs.js'
import { makeScheduler } from './scheduler.js'
import { makeBoard } from './board.js'
import { DESTRUCTIVE, CRITICAL_REASONS } from './policies.js'
import { makeGroups } from './groups.js'
import { makeGuards } from './guards.js'
import { makeModeAuto } from './mode-auto.js'
import { makeRuntime } from './runtime.js'
import { makeApiApp } from './api-app.js'
import { makeToolsReg } from './tools-reg.js'

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
  try { setCustomModes(cfg.customModes) } catch { /* 自定义模式注册失败不影响启动 */ }
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
  // ★ 性能档位已移除（2026-11-14，用户要求暂删、后期用别的机制补）：
  //   effort 现在只由 模式预设 > 全局 frontEffort/backEffort > 默认 决定。
  if (effortOverride[tag]) return effortOverride[tag]
  if (tag === 'back') return cfg.backEffort || 'max'
  // ★ 极速反射（2026-11-07）：模式可以覆盖前台档位（quick ⇒ minimal）。
  //   优先级：模式预设 > 全局 frontEffort > 'low'。
  //   activeMode 在此函数被调用时（建会话/重建）早已初始化；try 兜住初始化早期。
  try {
    const m = modeInfo(K.activeMode)
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
  /** ★ 2026-11-15 归因日志：每步/每次唤醒记实际 model+effort+phase（审计/成本/调参），纯增量 */
  function attribute (info) {
    try {
      const role = info.role || 'front'
      const rt = currentRouteFor(role) || {}
      const rec = {
        at: Date.now(), step: info.step || null, phase: K.phaseStrategy || null, role,
        provider: rt.provider || null, model: rt.model || null, effort: resolveEffort(role) || null,
        trigger: info.trigger || null, ok: info.ok !== false,
        ...(info.queued ? { queued: true } : {}), ...(info.mode ? { mode: info.mode } : {}),
      }
      event('attribution', rec)
      vlog('attribution', rec)
    } catch { /* 归因失败不影响主流程 */ }
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
  // ── K：跨模块共享状态袋（第一阶段重构）────────────────────────────────
  // 原 apply() 闭包里的跨模块可变状态统一挂到 K；抽出的模块经 D.K 读写。
  // 各 K.x 的初始化仍留在原位置（顺序与副作用与原实现完全一致）。
  const K = {}

  // ── D：模块依赖袋 ─────────────────────────────────────────────────────
  // makeGroups/makeGuards/makeModeAuto 经 D 读取 apply() 闭包依赖。
  // 函数/后定义绑定一律 getter：字段在**调用时**读取（惰性），不做快照。
  const D = {
    K, cfg, ctx, TAG, BASE_PATH, boardRoot, boardDir,
    get P() { return P }, get BB() { return BB },
    get log() { return log }, get vlog() { return vlog }, get event() { return event },
    get alive() { return alive }, get TN() { return TN }, get idOf() { return idOf },
    get readIf() { return readIf }, get writeAtomic() { return writeAtomic },
    get readState() { return readState }, get listSteps() { return listSteps }, get stepNo() { return stepNo },
    get toolStats() { return toolStats }, get policyAgentId() { return policyAgentId },
    get modeFile() { return modeFile }, get currentMode() { return currentMode }, get modeNow() { return modeNow },
    get reapplyToolPolicyIfNeeded() { return reapplyToolPolicyIfNeeded },
    get applyToolPolicy() { return applyToolPolicy }, get localizeToolNames() { return localizeToolNames },
    get resolveRoute() { return resolveRoute }, get routeFor() { return routeFor }, get effortFor() { return effortFor },
    get presetName() { return presetName }, get attachToolPolicyFor() { return attachToolPolicyFor },
    get nameSession() { return nameSession }, get norm() { return norm },
    get wire() { return wire }, get unwire() { return unwire }, get resolveAgents() { return resolveAgents },
    get steerFront() { return RT.steerFront }, get wakeBack() { return RT.wakeBack },
    get hasDeliver() { return hasDeliver }, get B() { return B }, get apiApp() { return apiApp },
    // [重构②] runtime / api-app / tools-reg 依赖（惰性 getter，调用时读取）
    get RT() { return RT }, get GD() { return GD }, get MA() { return MA }, get GR() { return GR },
    get appendLine() { return appendLine }, get attribute() { return attribute }, get judgeFile() { return judgeFile },
    get effectiveBatch() { return effectiveBatch }, get observeDeliveryForAdapt() { return observeDeliveryForAdapt },
    get parseStepMeta() { return parseStepMeta }, get prefetchWatermark() { return prefetchWatermark },
    get resetTaskScheduler() { return resetTaskScheduler },
    // [重构③] api-app 依赖（惰性 getter，调用时读取）
    get BUILD_TAG() { return BUILD_TAG }, get CONFIG_KEYS() { return CONFIG_KEYS },
    get cfgFile() { return cfgFile }, get cwdOf() { return cwdOf }, get ensureWiring() { return ensureWiring },
    get getFire() { return getFire }, get saveOverrides() { return saveOverrides },
    // [重构③] tools-reg 依赖
    get presetOf() { return presetOf },
  }

  K.overrides = {}
  K.droppedOnce = new Set()   // 本次保存要从盘上显式删除的键（解绑用；见 saveOverrides）
  try {
    if (existsSync(cfgFile)) {
      K.overrides = JSON.parse(readFileSync(cfgFile, 'utf8')) || {}
      // ★ 多实例（2026-11-07）：实例身份/黑板位置**只认本次挂载传入的 config**，
      //   绝不被盘上的旧值覆盖 —— 否则第二个实例会读到第一个实例的 boardRoot，
      //   还会把自己的 instanceTag 写成 'a'（两个实例互相污染）。
      const PINNED = ['instanceTag', 'boardRoot']
      const pinned = {}
      for (const k of PINNED) if (userConfig && userConfig[k] !== undefined) pinned[k] = userConfig[k]
      Object.assign(cfg, K.overrides, pinned)
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
      for (const k of K.droppedOnce) delete disk[k]
      // 实例身份与黑板位置不是"运行时设置"，不落盘（避免两实例互相覆盖）
      delete disk.instanceTag
      delete disk.boardRoot
      K.droppedOnce.clear()
      const merged = Object.assign({}, disk, K.overrides)
      writeFileSync(cfgFile, JSON.stringify(merged, null, 2), 'utf8')
      K.overrides = merged
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
      if (frontId) { cfg.frontSessionId = frontId; K.overrides.frontSessionId = frontId }
      else { cfg.frontSessionId = ''; delete K.overrides.frontSessionId; K.droppedOnce.add('frontSessionId') }
    }
    if (backId !== undefined) {
      if (backId) { cfg.backSessionId = backId; K.overrides.backSessionId = backId }
      else { cfg.backSessionId = ''; delete K.overrides.backSessionId; K.droppedOnce.add('backSessionId') }
    }
    saveOverrides()
  }
  const unwire = () => {
    cfg.frontSessionId = ''; cfg.backSessionId = ''
    delete K.overrides.frontSessionId; delete K.overrides.backSessionId
    K.droppedOnce.add('frontSessionId'); K.droppedOnce.add('backSessionId')
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
  K.front = null
  K.back = null
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
  K.briefed = new Set((() => { try { return JSON.parse(readIf(BRIEF_MARK)) || [] } catch { return [] } })())

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
    const svcReady = !!(K.svcAgentLoop && K.svcPresets)
    const listHasAnyone = Array.isArray(list) && list.length > 0
    // 服务未就绪 且 磁盘上本来有接线 ⇒ 本轮整体"暂缓"：不发现、不清空、不重建
    const deferred = (!svcReady || !listHasAnyone) && !!(wantedF || wantedB)
    K.front = (wantedF && byId(wantedF) && isFrSession(byId(wantedF))) ? byId(wantedF) : null
    K.back = (wantedB && byId(wantedB) && isFrSession(byId(wantedB))) ? byId(wantedB) : null
    if (wantedF && !K.front) {
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
    if (wantedB && !K.back) {
      if (!svcReady || !listHasAnyone) {
        event('wire-deferred', { role: 'back', id: wantedB, svcReady, listCount: (list || []).length })
      } else {
        pendingRevive.back = wantedB
        event('wire-revive-queued', { role: 'back', id: wantedB })
      }
    }
    // ② preset 兜底（同样只认 fr 会话）
    if (!K.front && !deferred) { const p = byPreset(cfg.frontPreset); if (p && isFrSession(p)) K.front = p }
    if (!K.back && !deferred) { const p = byPreset(cfg.backPreset); if (p && isFrSession(p)) K.back = p }
    // ③ 自动发现：**只从 fr 会话里挑**，按创建时间排序取最早两个
    //   ★ 暂缓时**不发现**（否则会凭空捡到别的会话并焊死接线，正是历史事故的形态）
    if ((!K.front || !K.back) && !deferred) {
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
      if (!K.front) K.front = frList.find(a => a !== K.back) || null
      if (!K.back) K.back = frList.find(a => a !== K.front) || null
    }
    if (K.front && K.back && idOf(K.front) === idOf(K.back)) K.back = null
    // ④ 最终守卫：任何一个不是 fr 会话 ⇒ 一律置空，交给 ensureWiring 重建
    if (K.front && !isFrSession(K.front)) { event('wire-reject', { role: 'front', id: idOf(K.front) }); K.front = null }
    if (K.back && !isFrSession(K.back)) { event('wire-reject', { role: 'back', id: idOf(K.back) }); K.back = null }
    // B14 路由跟随（省钱）：先把两会话的 model 路由同步到全局默认，再考虑简报
    if (K.front) syncRoute(K.front, 'front')
    if (K.back) syncRoute(K.back, 'back')
    // ★ 接线焊死：把自动发现的结果写回 config.json，避免同目录出现第三个会话时接线被抢
    //   ⚠️ 只焊死"两者都是 fr 会话"的合法接线（2026-10-18 加固）
    if (K.front && K.back && isFrSession(K.front) && isFrSession(K.back)) {
      const f = idOf(K.front); const b = idOf(K.back)
      if (cfg.frontSessionId !== f || cfg.backSessionId !== b) {
        wire(f, b)
        event('wire-latched', { front: f, back: b })
        log(`接线已焊死: front=${f.slice(0, 14)} back=${b.slice(0, 14)}`)
      }
    } else if (!deferred && (cfg.frontSessionId || cfg.backSessionId) && (!K.front || !K.back)) {
      // 接线不完整/不合法 ⇒ 清掉脏记录，让 ensureWiring 干净重建
      // ★ 暂缓时**不清空**：磁盘接线先保留，等 agentLoop 就绪后重试（避免重载风暴）
      if (cfg.frontSessionId && !K.front) wire('', cfg.backSessionId || '')
      if (cfg.backSessionId && !K.back) wire(cfg.frontSessionId || '', '')
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
      for (const [role, ag, wantN] of [['front', K.front, wantF], ['back', K.back, wantB]]) {
        if (!ag || !wantN) continue
        let got = 0
        try {
          const tt = ag.ctx && typeof ag.ctx.get === 'function' ? ag.ctx.get('tools') : undefined
          got = (tt && typeof tt.schemas === 'function' ? tt.schemas(ag) : []).length
        } catch { continue }
        if (got > 0 && got < Math.max(5, Math.floor(wantN * 0.8))) {
          event('wire-unhealthy', { role, id: idOf(ag), got, want: wantN })
          log(`接线会话不健康：${role} 仅 ${got}/${wantN} 工具（旧实例 restrict 残留）⇒ 解除接线，下一轮重建`)
          if (role === 'front') K.front = null; else K.back = null
          if (role === 'front' && cfg.frontSessionId) wire('', cfg.backSessionId || '')
          if (role === 'back' && cfg.backSessionId) wire(cfg.frontSessionId || '', '')
        }
      }
    } catch { /* 健康自检失败不影响主流程 */ }

    // 接线（或切换）时补发角色简报：每个 (角色, agent) 只发一次；标记落盘，重载不重发
    for (const pair of [[K.front, 'front'], [K.back, 'back']]) {
      const a = pair[0]; const role = pair[1]
      if (!a) continue
      const key = role + ':' + idOf(a)
      if (K.briefed.has(key)) continue
      K.briefed.add(key)
      brief(a, role)
      try { writeAtomic(BRIEF_MARK, JSON.stringify([...K.briefed], null, 1)) } catch { /* 静默 */ }
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
    try { TR.registerFrToolsTo(ag, role) } catch (e) { log('注册 fr 工具到 scope 失败: ' + (e && e.message || e)) }
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
    for (const [role, ag] of [['front', K.front], ['back', K.back]]) {
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

  const isFront = (agent) => !!K.front && !!agent && idOf(agent) === idOf(K.front)
  const isBack = (agent) => !!K.back && !!agent && idOf(agent) === idOf(K.back)
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
  K.lastWakeAt = 0
  // [重构②] 通道 wakeBack/steerFront/干扰预算 + heartbeat/todo 镜像 + 实时投递 + renderRoute/checkLookahead + B6/M19 → lib/runtime.js
  const RT = makeRuntime(D)
  K.taskWakes = 0
  K.taskFreezes = 0
  K.budgetAlerted = false
  K.lastPrefetchAt = 0   // 流水线预规划冷却（避免每 tick 唤醒后台）

  /**
   * 构造一条**格式完整**的 user 消息。
   * #1 修复（2026-10-17 实测）：只给 {role,content} 会让 loop 读 `source.kind` 时抛
   * `Cannot read properties of undefined (reading 'kind')`，把被唤醒的那一轮直接打挂。
   * 权威形状取自官方 dsh-repeat-tool-reminder：{role:'user', id, source:{kind,form,summary}, content}。
   * source.kind 用插件自己的名字，**绝不写 'user'**（'user' 是真人消息的标记）。
   */

    // ── 任务模式（Phase 1）：预设表在 lib/modes.js，这里只负责「生效 / 通知 / 工具白名单」──
  const modeFile = join(boardDir, 'mode.md')
  K.activeMode = ''            // 已生效的预设 key
  K.modeBy = ''                // auto / agent / user / startup

  function readModeFile () {
    try {
      const m = /^\s*mode\s*:\s*([a-z]+)\s*$/mi.exec(readIf(modeFile))
      return m ? m[1] : ''
    } catch { return '' }
  }
  const currentMode = () => (K.activeMode || readModeFile() || DEFAULT_MODE)


  /** 工具白名单（三层里的第一层）：restrict 砍全局工具；scoped 工具由 guard 兜。
   *  ★ 修复（2026-10-24）：求交集的"已知工具"必须用**该 agent 自己的可见集**
   *  `tools.schemas(agent)`（含 preset 带入的工具），不能用 `ctx.tools.schemas()`——
   *  后者只返回插件注册的全局工具（fr_*），会把 read/write/pwsh 判成"未知"从而砍掉，
   *  前台直接失去执行能力（实测：allow 只剩 fr_status/fr_escalate）。 */
  function applyToolPolicy (modeKey) {
    const out = {}
    for (const [role, ag] of [['front', K.front], ['back', K.back]]) {
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

  // [重构①] 模式生效 applyMode / L2 策略 applyStrategy / auto 决议 resolveAutoPhases / touchBeat / nextStrategies → lib/mode-auto.js
  const MA = makeModeAuto(D)

  // [重构①] 模式生效 applyMode / L2 策略 applyStrategy / auto 决议 resolveAutoPhases / touchBeat / nextStrategies（续）→ lib/mode-auto.js
  K.activeStrategy = null
  // [重构①] 模式生效 applyMode / L2 策略 applyStrategy / auto 决议 resolveAutoPhases / touchBeat / nextStrategies（续）→ lib/mode-auto.js
  const effortOverride = { front: null, back: null }
  function setEffortFor (role, effort) { effortOverride[role] = effort || null; try { void GD.setEffort(role) } catch { /* 忽略 */ } }
  // [重构①] 模式生效 applyMode / L2 策略 applyStrategy / auto 决议 resolveAutoPhases / touchBeat / nextStrategies（续）→ lib/mode-auto.js

  // ── Phase 2 调度器：步长 / 依赖 / 停牌 / 分析交付 / 归档 ─────────────────────
  const modeNow = () => modeInfo(currentMode())
  const judgeFile = join(boardDir, 'judge.ok')
  K.workers = new Map()          // 只读 worker 池（id → { ag, at, out, done, task }）
  K.judgeWaiting = false          // 停牌中：等后台写 judge.ok（或 fr_poke resolve）
  K.lastAnalysisMtime = 0         // 咨询模式：analysis.md 的已投递 mtime
  K.lastReviewAt = 0              // 里程碑复核节流
  K.reviewCount = 0               // 每任务复核次数
  K.lastReviewStepNo = 0          // 上次复核时的 done 步号
  // Phase 2 收尾：步长自适应的观测窗口
  K.recentGaps = []               // 最近几步的投递间隔（近似每步耗时，ms）
  K.adaptiveBatch = 0             // 自适应得到的批量（0 = 未启用/未定）
  K.lastDeliverAt = 0             // 上次投递时间
  K.lastT3Seen = 0                // 上次观测到的 T3 拦截数
  K.phaseStrategy = null          // ★ 2026-11-14 当前 L2 相位策略
  K.phaseSince = 0
  K.testFailStreak = 0   // ★ 2026-11-15 连续 test/build 失败计数

  /** #1 速度自适应预取水位：前台跑得快 ⇒ 加深缓冲；跑得慢 ⇒ 收缩（2..4，避震荡） */


  /** 一次投递几条：模式基线 → 自适应覆盖（可关）；夹在 1..8 */


  /** 观测一次投递，更新步长自适应（保守 + 滞回，避免震荡） */


  /** 解析步骤里的调度元数据：depends: S1,S2 / needs: judge / 并行组: g1 */


  /** 咨询/速答模式：.board/analysis.md 一出现就投给前台（由前台转述给用户） */


  /** 里程碑复核：前后台都空闲、距上次 ≥10 分钟、本任务 ≤3 次、且新完成 ≥reviewEvery 步 */


  /** 任务已交付 ⇒ 把步骤文件归档（state/route 复制一份），黑板保持小而可查 */


  /** 只读 worker 清理：完成（.done 出现）或超 10 分钟 ⇒ 取消会话并释放工具限制 */


  /** 新任务起点：重置本任务的调度/复核/分析状态 */


  // 最近一次发给前台的任务原文（首帧超时兜底时交回前台，避免它"猜任务"）
  K.lastTaskText = ''
/** ★ 2026-11-08：上一次**判型时**的任务文本。用于判断"是不是同一个任务"。
 *  注意不能复用 lastTaskText —— 它在 deliver 开头就被赋成新文本了，
 *  再拿它比对会永远相等（等于没比对）。 */
K.lastDetectText = ''
/** ★ 2026-11-08：模式被 pin 锁定（本任务不再自动判型/分诊） */
K.modePinned = false
/** ★ 2026-11-08：本任务是否已因工具数兜底升级过（防重复触发） */
K.autoUpgradedThisTask = false
/** ★ 2026-11-08：最近一次判型结果（灰区分诊/UI 展示用） */
K.lastTriage = null
/** ★ 2026-11-08：coding 模式下前台是否已上交（用于执行层强制督促） */
K.codingNotEscalated = false
/** ★ 2026-11-08：本任务最后一次上交时刻（0=未上交） */
K.lastEscalateAt = 0

  K.lastTodoKey = ''
  K.todoSyncTimer = null
  // coding 模式「只读审 diff」：收集前台改过的文件，攒够就请后台只读复核一次
  K.changedFiles = new Set()
  K.lastDiffReviewAt = 0
  K.diffReviewCount = 0


  // recent：前台最近若干次工具调用（供唤醒时随附给后台，见 appendToolSummary）
  // callErrHinted：已经给过"工具名/参数不合法"提示的工具名，避免重复刷屏
  const toolStats = { total: 0, failStreak: 0, failTotal: 0, sameName: {}, lastSame: '', sameCount: 0, lastFailName: '', recent: [], callErrHinted: new Set(), callErrStreak: 0, lastCallErrName: '' }
  /** v2 返工检测：最近写操作轨迹（文件 / 大小 / 时间） */
  const reworkTrail = []
  /** 已告警过的返工文件（同一文件只告警一次） */
  K.reworkAlerted = new Set()
  K.stepsThisTask = 0
  // H3 基线：插件启动时设为当下；之后每合成一条 heartbeat 就刷新。
  // 用它而不是文件里最后一行 —— 否则会把"上一轮任务遗留的旧心跳"误判成"当前停滞"（实测误报 11730s）。
  K.lastBeatAt = Date.now()


  // ── 僵死看门狗（2026-10-17 实测事故：running 但 4 分钟零产出，用户干等）──
  K.lastToolAt = 0
  K.turnStartAt = 0
  K.prevFrontPhase = ''

  // [重构①] 僵死看门狗 / T3 拦截 / 机械哨兵 / 首帧兜底（函数体） → lib/guards.js
  const GD = makeGuards(D)
  try {
    const stallTimer = setInterval(GD.checkStall, 15000)
    if (typeof ctx.effect === 'function') ctx.effect(() => () => { try { clearInterval(stallTimer) } catch { /* 忽略 */ } })
  } catch { /* 忽略 */ }

  // ── B4 T3 拦截：破坏性命令 → 拒绝 + 唤醒后台 ────────────────────────────
  K.t3Blocked = 0

  // [重构①] 僵死看门狗 / T3 拦截 / 机械哨兵 / 首帧兜底（函数体）（续）→ lib/guards.js
  // [重构①] 僵死看门狗 / T3 拦截 / 机械哨兵 / 首帧兜底（函数体）（续）→ lib/guards.js
  /** 已唤醒过的哨兵 id（同一条只唤醒一次，防 30s 重复点火） */
  K.alertedSentinels = new Set()
  // ★ §22 优化①：编号步骤任务的任务级批量覆盖（≥3 个编号 ⇒ 一次投全批）
  K.taskBatchOverride = 0


  // [重构①] 僵死看门狗 / T3 拦截 / 机械哨兵 / 首帧兜底（函数体）（续）→ lib/guards.js

  // ── B5 催单 T9（lookahead） ─────────────────────────────────────────────
  /** 已交付？交付后停止一切催单（否则"清单跑完"会被误判成"缺料"，变成 30s 一次的死循环） */
  const hasDeliver = () => BB.hasDeliver() /* 代理 board.js */
  K.finalAnswerAsked = false   // 终局正文交付守卫（只催一次）
  K.finalAsked = false         // 终局唤醒守卫（新步骤到达时重置）
  K.finalAuditRetry = 0        // 终局对照审的补做次数
  K.lastAuditedDeliverKey = ''  // 已审计过的 deliver 指纹（避免每 tick 重复审）
  K.milestoneGapCount = 0     // 规划闭环催单计数（同一缺口最多催 3 次，防无限唤醒）
  K.deliverRetry = 0
  K.userStopAt = 0              // 用户按暂停/停止的时刻（15s 内禁止一切内联追加）
  K.pauseAt = 0                 // 真·用户暂停时刻（stopAll）；优先级高于 userStopAt，force 也绕不过它
  K.pendingDeliver = false        // 投递被前台忙挡住、重试预算耗尽 ⇒ 转 tick 兜底
  K.pendingDeliverLogged = false          // 投递被"前台忙"挡住时的延迟重试计数（防竞态卡死）
  K.stepsThisTaskBase = 0     // 任务起始时的总步数基线（用于判断 H5 是否本任务造成）
  // [重构①] 僵死看门狗 / T3 拦截 / 机械哨兵 / 首帧兜底（函数体）（续）→ lib/guards.js
  K.firstFrameNudgedAt = 0

  // ── 接线自愈：重启后自动建的会话（内存态）会消失 ⇒ 插件自动重建 ──────────────
  K.svcAgentLoop = null
  K.svcPresets = null
  K.autoHealAt = 0
  K.autoHealDone = false
  try {
    ctx.inject(['agentLoop', 'agentPresets'], (c2) => {
      K.svcAgentLoop = c2.agentLoop
      K.svcPresets = c2.agentPresets
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
    if (!cfg.autoHeal || K.autoHealDone) return
    if (!K.svcAgentLoop || !K.svcPresets) return
    if (K.front && K.back) { K.autoHealDone = true; return }
    if (Date.now() - K.autoHealAt < 20000) return     // 20s 内不重复尝试
    K.autoHealAt = Date.now()
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
            const h = await K.svcAgentLoop.resume(ctx, { resumeSessionId: wantId })
            const ag = h && h.agent
            if (ag) {
              // resume 出来的也会丢工具面 ⇒ 同样立刻挂
              try { await K.svcPresets.mount(ag.ctx, presetName()) } catch (e) { log('复活挂预设失败: ' + e.message) }
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
        const ag = await K.svcAgentLoop.create((TAG === 'a' ? 'session-fr-' : 'session-fr-' + TAG + '-') + tag + '-' + Date.now().toString(36),
          { provider: routeFor(tag).provider, model: routeFor(tag).model, reasoningEffort: effortFor(tag) }, { cwd: boardRoot })
        try { await K.svcPresets.mount(ag.ctx, presetName()) } catch (e) { log('自愈挂预设失败: ' + e.message) }
        // ★★ 2026-11-07 窗口归零：会话一创建就**立刻**挂工具面，
        //   不等 resolveAgents / applyMode 的下一次 tick。
        //   原实现要等下一次 resolveAgents（实测重建后约 20s）才重挂，
        //   这 20s 内新会话可见 68 个工具（含 dev_*/hindsight_*/subagent/workflow/fr_escalate），
        //   benchmark 若此时发任务，那一轮就是在不受控工具面上跑的。
        try { attachToolPolicyFor(tag, ag) } catch (e) { log('自愈即时挂工具面失败: ' + e.message) }
        return ag
      }
      if (!K.front) { const ag = await mk('front', pendingRevive.front || cfg.frontSessionId); K.front = ag; pendingRevive.front = ''; wire(idOf(ag), undefined); await nameSession(ag, 'front') }
      if (!K.back) { const ag = await mk('back', pendingRevive.back || cfg.backSessionId); K.back = ag; pendingRevive.back = ''; wire(undefined, idOf(ag)); await nameSession(ag, 'back') }
      saveOverrides()
      K.briefed.clear()
      event('autoheal', { front: idOf(K.front), back: idOf(K.back) })
      log(`接线自愈：已重建会话 front=${idOf(K.front).slice(0, 16)} back=${idOf(K.back).slice(0, 16)}`)
      // 新会话没有继承工具白名单 ⇒ 自愈后重挂一次
      try { MA.applyMode(currentMode(), 'auto', 'autoheal') } catch (e) { log('自愈后重挂模式失败: ' + e.message) }
      K.autoHealDone = true
    } catch (e) { log('接线自愈失败: ' + e.message) }
  }

  // [重构①] Workspace 挂载 / 会话组注册表 / 权限预设 → lib/groups.js
  const GR = makeGroups(D)
  K.linkedSessions = new Set()
  K.lastWsPruneAt = 0
  try {
    const linkTimer = setInterval(() => {
      GR.linkFrontWorkspace().catch(() => {})
      // 默认权限兜底：只有在「当前接线不属于任何有 preset 的会话组」时，才把前后台
      // 校正到全局 permissionPreset。
      // ★ 修复（2026-10-24）：此前无条件按 cfg.permissionPreset 校正，于是组权限
      //   （g.preset，用户在面板「组权限」下拉里设的）最多 20s 就被全局默认覆盖掉 ——
      //   表现为「设了 read-only，过一会儿又变回 danger-full-access」。
      try {
        const g = GR.loadGroups().find(x => String(x.frontId) === String(cfg.frontSessionId) || String(x.backId) === String(cfg.backSessionId))
        const want = (g && g.preset) ? g.preset : cfg.permissionPreset
        if (want) {
          for (const ag of [K.front, K.back]) {
            if (!ag) continue
            const sid = idOf(ag)
            if (GR.currentPreset(sid) !== want) GR.applyPreset(sid, want)
          }
        }
      } catch { /* 忽略 */ }
    }, 20000)
    if (typeof ctx.effect === 'function') ctx.effect(() => () => { try { clearInterval(linkTimer) } catch { /* 忽略 */ } })
    setTimeout(() => { GR.linkFrontWorkspace().catch(() => {}) }, 3000)
  } catch { /* 忽略 */ }

  // ── 按角色的上下文守护：前台到 frontContextLimit 就压，后台几乎不压 ──────────
  // ⚠️ cordis 里直接 ctx.tokenMeter / ctx.compaction 属性访问可能抛 "cannot get property without inject"，
  //    所以通过 ctx.inject 拿服务（回调在服务就绪后执行）。
  K.svcMeter = null
  K.svcCompaction = null
  try {
    ctx.inject(['tokenMeter', 'compaction'], (c2) => {
      K.svcMeter = c2.tokenMeter
      K.svcCompaction = c2.compaction
      log('上下文守护：tokenMeter/compaction 服务已就绪')
    })
  } catch (e) { log('上下文守护服务注入失败: ' + e.message) }

  // ★ 2026-11-15 生效指示复用既有 svcPresets（1537 行已 inject agentPresets），不重复声明

  K.lastCompactAt = { front: 0, back: 0 }
  // [重构①] 僵死看门狗 / T3 拦截 / 机械哨兵 / 首帧兜底（函数体）（续）→ lib/guards.js



  K.seenSteps = new Map()   // file -> 内容指纹

  K.lastAgentError = null   // 最近一次模型/回合错误（余额不足等）
  K.verdictSeen = ''

    // ── S4：调度核心（实现在 lib/scheduler.js；SB/B 门面注入依赖）──
  const SB = {
    get cfg(){ return cfg },
    get recentGaps(){ return K.recentGaps }, set recentGaps(v){ K.recentGaps = v },
    modeNow,
    get adaptiveBatch(){ return K.adaptiveBatch }, set adaptiveBatch(v){ K.adaptiveBatch = v },
    get lastDeliverAt(){ return K.lastDeliverAt }, set lastDeliverAt(v){ K.lastDeliverAt = v },
    get toolStats(){ return toolStats },
    get t3Blocked(){ return K.t3Blocked },
    get lastT3Seen(){ return K.lastT3Seen }, set lastT3Seen(v){ K.lastT3Seen = v },
    get boardDir(){ return boardDir },
    get lastAnalysisMtime(){ return K.lastAnalysisMtime }, set lastAnalysisMtime(v){ K.lastAnalysisMtime = v },
    get front(){ return K.front },
    get back(){ return K.back },
    get lastReviewAt(){ return K.lastReviewAt }, set lastReviewAt(v){ K.lastReviewAt = v },
    get reviewCount(){ return K.reviewCount }, set reviewCount(v){ K.reviewCount = v },
    get lastReviewStepNo(){ return K.lastReviewStepNo }, set lastReviewStepNo(v){ K.lastReviewStepNo = v },
    get workers(){ return K.workers },
    get judgeWaiting(){ return K.judgeWaiting }, set judgeWaiting(v){ K.judgeWaiting = v },
    get judgeFile(){ return judgeFile },
    get phaseStrategy(){ return K.phaseStrategy }, set phaseStrategy(v){ K.phaseStrategy = v },
    get phaseSince(){ return K.phaseSince }, set phaseSince(v){ K.phaseSince = v },
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
  const Sched = makeScheduler({ S: SB, B, log, event, steerFront: RT.steerFront, wakeBack: RT.wakeBack, lastAssistantText: GD.lastAssistantText,
    frontThought: () => (cfg.backSeeFrontThought ? RT.frontThoughtTail(1500) : ''),
    applyStrategy: MA.applyStrategy, setEffortFor, touchBeat: MA.touchBeat, nextStrategies: MA.nextStrategies, cleanupWorkersNow: () => { try { Sched.cleanupWorkers() } catch { /* 忽略 */ } } })
  const { prefetchWatermark, effectiveBatch, observeDeliveryForAdapt, parseStepMeta, checkAnalysisDelivery, checkMilestoneReview, archiveBoardIfDone, cleanupWorkers, resetTaskScheduler, checkPlanningStarvation, syncPhaseToNextStep } = Sched

  // ══ 对外 API 装配（/fr 页面 + 外部脚本共用）═════════════════════════════════
  // 这里把插件的内部能力收敛成一个 app 对象，交给 lib/api.js 注册成 HTTP 端点。
  // 好处：页面/脚本/以后的其他工具都能用同一套接口，不必依赖 fr_poke 工具。
  /** 当前该挂的预设名：applyPatchPreset 打开时用 fast-react-front（standard + apply_patch）
   *  ★ 用函数声明而不是 const 箭头：它被 5 处 mount 调用，函数声明会提升，杜绝 TDZ。*/
  function presetName () {
    const p = cfg.agentPreset || 'standard'
    return (cfg.applyPatchPreset && p === 'standard') ? 'fast-react-front' : p
  }

  // ★ 热重载探针时间戳（每次 apply 新建）：status.buildTag 变化 ⇒ 路由闭包已换新
  const BUILD_TAG = 'fr-' + Date.now().toString(36)
  // ★ 2026-11-15 单配置文件：白名单=全部可编辑键（applyConfig 与 config.json 热重载共用）
  const CONFIG_KEYS = ['batchSteps', 'frontContextLimit', 'backContextLimit', 'pullSteps', 'contextGuard',
    'enabled', 'interruptCooldownMs', 'interruptMaxPerTask', 'sentinelIntervalMs',
    'stallWatchdog', 'stallTimeoutMs', 'stallSafeRetry', 'linkWorkspaceSession', 'permissionPreset',
    'pipelinePrefetch', 'prefetchCooldownMs', 'sentinelEnabled', 'heartbeatStaleMs', 'modeLocked', 'modeAuto',
    'frontProvider', 'frontModel', 'backProvider', 'backModel', 'batchAdapt', 'preread', 'workersEnabled',
    'verboseLog', 'finalAudit', 'finalAuditMaxRetry', 'todoMirror', 'budgetWakes', 'blockToolFold', 'workerMax', 'fanoutWorkers', 'reviewDiffEnabled', 'applyPatchPreset', 'pollUnified', 'firstFrameEcho', 'uiTheme', 'planningDegrade', 'degradeAfterMs', 'orchestration', 'enablePhases', 'customModes', 'milestoneCheck', 'milestoneEvery',
    'backSeeFrontThought', 'autoHeal', 'followGlobalRoute', 'effortDrift', 'wakeCooldownMs', 'firstFrameTimeoutMs', 'failStreakMax', 'modePresets']

  // [重构③] apiApp 剩余方法（组方法/T3 方法仍 spread 自 GR.api/GD.api） → lib/api-app.js
  const AA = makeApiApp(D)
  const apiApp = { ...AA, ...GR.api, ...GD.api }

  // ── 侧边栏浮层 loader 已删除（1.6.3：2026-11-06 起停用，死代码清理）──

  // ── 注册独立页面 + 便捷 API（webServer 服务就绪后自动挂上）────────────────────
  // ★ 1.6.2 热重载修复：路由每进程只注册一次，handler 经可变 app 引用转发。
  //   旧版每 fiber 注册闭包：热重载后旧闭包仍占路由 ⇒ 新代码永不生效、被迫重启 DSH。
  //   现在 handler 调用时读 globalThis.__frApp_<TAG>（每次 apply 替换）⇒ dev_reload_package 即时生效。
  globalThis['__frApp_' + TAG] = apiApp
  try {
    if (!globalThis['__frRoutes_' + TAG]) {
      globalThis['__frRoutes_' + TAG] = true
      ctx.inject(['webServer'], (c2) => {
        try {
          const appRef = new Proxy({}, {
            get: (_t, k) => {
              const cur = globalThis['__frApp_' + TAG] || apiApp
              const v = cur[k]
              return typeof v === 'function' ? v.bind(cur) : v
            },
          })
          const routes = makeRoutes(appRef)
          let n = 0
          for (const r of routes) {
            try { c2.webServer.register(r); n++ } catch (e) { log('注册路由失败 ' + r.path + ': ' + e.message) }
          }
          log(`Web 控制台已注册 [实例 ${TAG}] ${BASE_PATH}（${n - 1} 个 API 端点，热重载兼容）`)
        } catch (e) { log('注册 Web 控制台失败: ' + e.message) }
      })
    }
  } catch (e) { log('webServer 注入失败（控制台不可用，插件其它功能正常）: ' + e.message) }

  // ── 装配：effect + 监听器 ──────────────────────────────────────────────
  ctx.effect(function* () {
    ensure()
    if (!existsSync(cfgFile)) writeAtomic(cfgFile, JSON.stringify(DEFAULTS, null, 2))
    // ★ 2026-11-15 单配置文件：补齐缺失默认键 ⇒ config.json 成为全量可编辑文件（AI 可直接改）
    try {
      const disk0 = JSON.parse(readIf(cfgFile) || '{}')
      let added = 0
      for (const k of Object.keys(DEFAULTS)) {
        if (disk0[k] === undefined && k !== 'boardRoot' && k !== 'instanceTag') { disk0[k] = DEFAULTS[k]; added++ }
      }
      if (added) { writeAtomic(cfgFile, JSON.stringify(disk0, null, 2)); log('config.json 补齐默认键 ' + added + ' 个（单配置文件）') }
    } catch (e) { log('config 补齐失败: ' + e.message) }
    setPresetOverrides(cfg.modePresets || {})
    // 热重载：AI/用户直接改 config.json，保存 600ms 后生效（只读应用不回写，避免 watch 循环）
    try {
      let wt = null
      watch(cfgFile, () => {
        clearTimeout(wt)
        wt = setTimeout(() => {
          try {
            const d = JSON.parse(readIf(cfgFile) || '{}')
            let n = 0
            for (const k of CONFIG_KEYS) if (d[k] !== undefined) { cfg[k] = d[k]; n++ }
            setCustomModes(cfg.customModes || {})
            setPresetOverrides(cfg.modePresets || {})
            event('config-file-reload', { keys: n })
            log('config.json 热重载生效（' + n + ' 键）')
          } catch (e) { log('config 热重载失败: ' + e.message) }
        }, 600)
      })
    } catch (e) { log('config watch 失败: ' + e.message) }
    resolveAgents()
    event('plugin-start', { front: idOf(K.front), back: idOf(K.back), board: boardDir })
    // 模式初始化：显式配置 > 上次落盘的 mode.md > 默认 coding
    try { MA.applyMode(K.activeMode || readModeFile() || (cfg.mode || DEFAULT_MODE), 'startup', 'plugin start') } catch (e) { log('模式初始化失败: ' + e.message) }
    log(`启动 [实例 ${TAG}] base=${BASE_PATH} board=${boardDir} front=${idOf(K.front) || '(未接线)'} back=${idOf(K.back) || '(未接线)'}`)

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
        const cmd = GD.isDestructive(exec.name, exec.arguments)
        if (!cmd) return undefined
        // ★★ 按「权限预设」判定（2026-10-24 用户明确规则）：
        //   danger-full-access ⇒ 完全权限，直接干（不拦）
        //   read-only         ⇒ 只读，任何写/执行/删除都要审批
        //   workspace-write   ⇒ 工作区内可写，出界要审批
        //   auto              ⇒ 交给 DSH 自身策略
        let permNow = ''
        try {
          // 直接读：前台实际生效的权限预设（currentPreset 已在上面定义）
          if (K.front) permNow = String(GR.currentPreset(idOf(K.front)) || '')
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
        if (GD.hasConfirm(curStep)) {
          event('t3-pass', { tool: exec.name, step: curStep })
          log(`T3 放行（确认戳 ${curStep}）: ${cmd.slice(0, 80)}`)
          return undefined
        }
        K.t3Blocked++
        // ★ 写 .pending 让面板能看到并批准（原来只唤醒后台，用户无从得知）
        try { writeAtomic(join(P.confirmDir, curStep + '.pending'), cmd) } catch { /* 忽略 */ }
        event('t3-block', { tool: exec.name, cmd, step: curStep })
        log(`T3 拦截: ${cmd.slice(0, 120)}`)
        RT.wakeBack('t3', `【T3 待确认】前台要执行破坏性动作，已被拦截（等 .board/confirm/${curStep}.ok）：\n${cmd}\n请判断：允许则写 .board/confirm/${curStep}.ok；不允许则给出替代方案。`)
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
        if (Date.now() - K.userStopAt < 15000) {
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
        if (body.trim().length < RT.MIN_STEP_CHARS) return
        const h = `${body.length}:${body.slice(0, 60)}:${body.slice(-60)}`
        if (K.seenSteps.get(f) === h) return
        K.seenSteps.set(f, h)
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
        const backBusy = !!(K.back && K.back.phase && K.back.phase.kind === 'running')
        const msIdle = RT.routeMilestoneCount()
        const gapIdle = msIdle > allNow.length
        const cdIdle = RT.prefetchCooldownFor(msIdle, allNow.length, remainNow)
        // ★ 缺口场景：即使后台在忙也要催（催补步优先于复核这类低优先工作）
        //   非缺口场景：保持原来的"后台忙就不打扰"
        const shouldWake = (gapIdle || !backBusy) && remainNow <= wm
        if (shouldWake && Date.now() - K.lastPrefetchAt >= cdIdle && (!hasDeliver() || gapIdle)) {
          K.lastPrefetchAt = Date.now()
          RT.wakeBack('prefetch-urgent', `【空闲期预规划】前台刚好空闲、剩余步骤（${remainNow}）不足缓冲（${wm}）` +
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
      K.userStopAt = Date.now()      // ★ 打断 = 用户意图，短期内不再内联追加
      const target = agent || K.front
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
      if (note) RT.steerFront(`【消防通道·极简模式】只做下面这一件事，做完**只回一句话（≤20 字）**，然后**立刻回到原任务继续**（不要停等新指令）。\n禁止：解释、总结、复述、额外验证、读无关文件、更新 state.md、顺手做任务外的事。\n**如果这件事不需要工具（只是确认/回答），就直接回一句话，不要调用任何工具** —— 实测带工具的响应要 27s，纯文本只要 12s。\n\n${String(note).slice(0, 600)}`, 'fire', { force: true })
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
      const r = fireInterrupt(K.front, 'fire-file', note)
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
        K.lastAgentError = {
          at: new Date().toISOString(), role: who || 'other',
          turn: payload && payload.turn, step: payload && payload.step,
          provider: (payload && payload.provider) || '', status, message: msg,
        }
        event('agent-request-error', { role: K.lastAgentError.role, provider: K.lastAgentError.provider, status, message: msg.slice(0, 200) })
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
            const a = tag === 'front' ? K.front : K.back
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
        K.lastAgentError = { at: new Date().toISOString(), role: who || 'other', turn: payload && payload.turn, step: payload && payload.step, message: msg }
        event('agent-error', { role: K.lastAgentError.role, message: msg.slice(0, 200) })
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
        if (!K.front || !K.front.session || session !== K.front.session) return
        if (event && event.type === 'turn/start') RT.queueTodoSync('turn-start')
      } catch { /* 镜像失败绝不影响主流程 */ }
    })

    yield ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        if (!alive()) return next()      // 旧实例失效
        if (isFront(exec.agent)) {
          const ok = !(result && result.isError)
          const nm = String(exec.name || '?')
          toolStats.total++
          K.stepsThisTask++
          // ★★ 2026-11-08 执行层强制（A 方案）：coding 模式下前台不上交就催它上交
          //
          //   实测事故：判型明确判成 coding（L5 score=11），但前台看了简报觉得
          //   "我自己能做"就直接做了 —— 整轮 10/10 次 escalate=0，双会话空转。
          //   光改简报不够（模型会自我说服），必须在执行层**反复提醒**。
          //   触发：coding 模式 + 已跑 6 个工具 + 还没上交 ⇒ steer 一次（每任务最多 2 次）。
          try {
            if (currentMode() === 'coding' && !K.autoUpgradedThisTask) {
              if (K.stepsThisTask === 6 && !K.lastEscalateAt) {
                K.codingNotEscalated = true
                RT.steerFront('【必须上交】你在 coding 模式下已跑了 6 个工具但还没调用 fr_escalate。\n' +
                  '**立刻调用 fr_escalate 上交**（reason/goal/hint 各一句即可），然后停手等 steps。\n' +
                  '这是本模式的硬规则：coding = 后台规划 + 前台执行，不要自己把整活干完。', 'must-escalate')
                event('must-escalate-nudge', { at: 6 })
                log('执行层强制：coding 模式 6 个工具未上交 ⇒ 已督促 fr_escalate')
              } else if (K.stepsThisTask === 12 && !K.lastEscalateAt) {
                K.codingNotEscalated = true
                RT.steerFront('【第二次提醒】仍未见 fr_escalate。**现在就调它**，之后只需读 steps 执行。', 'must-escalate2')
                event('must-escalate-nudge', { at: 12 })
                log('执行层强制：12 个工具仍未上交 ⇒ 第二次督促')
              }
            }
          } catch { /* 督促失败不影响主流程 */ }

          // ★★ 2026-11-08 兜底：quick 模式跑太多工具 ⇒ 自动升级到编排 → lib/mode-auto.js
          MA.upgradeByToolCount()
          // ★ #33 修：区分"调用契约错"和"真的做不下去"。
          //   工具名打错/参数不合法 ⇒ 调用根本没到工具本体，不计入 failStreak，
          //   否则同一个笔误连犯 3 次就会被 H4 判成"连续失败"→ 冻结前台 + 作废全部未执行步骤。
          const callErr = !ok && RT.isCallContractError(result)
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
                RT.steerFront(`【提示】工具 ${nm} 的调用不合法（工具名或参数有误），这一次没有真正执行。请核对可用工具名与必填参数后重试。`, 'tool-call-error')
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
          // ★ 2026-11-15 失败交回 test 信号：test/build 连续失败2次⇒交回后台修订（共享 cooldown+budget，不双计）
          try {
            if (cfg.sentinelEnabled !== false) {
              const cmdText = String((exec && ((exec.args && (exec.args.command || exec.args.cmd)) || (exec.input && exec.input.command))) || '')
              const isTest = isTestSignal(cmdText, nm, RT.resultErrorText(result))
              K.testFailStreak = nextTestFailStreak(K.testFailStreak, ok, isTest && !callErr)
              if (K.testFailStreak >= 2) {
                K.testFailStreak = 0
                RT.wakeBack('test-fail', '【测试连续失败】前台测试/构建连续 2 次失败，可能方向有误。请只读复核相关代码/报错，修订路线或给出具体纠正，不要重做已完成步骤。')
              }
            }
          } catch { /* test 信号失败不影响主流程 */ }
          // 最近动作环形缓冲：唤醒时随附给后台（见 appendToolSummary）
          try {
            toolStats.recent.push({ n: nm, ok, at: Date.now() })
            if (toolStats.recent.length > 8) toolStats.recent.shift()
          } catch { /* 忽略 */ }
          vlog('tool', {
            name: nm, ok, callErr,
            failStreak: toolStats.failStreak,
            callErrStreak: toolStats.callErrStreak,
            err: ok ? undefined : RT.resultErrorText(result).slice(0, 160),
          })
          try {
            const wn = String(exec.name || '')
            if (ok && (wn === 'write' || wn === 'edit' || wn === 'writeText' || wn === 'editText' || wn === 'apply_patch')) {
              const a = exec.arguments || {}
              const fp = String(a.file_path || a.path || a.filePath || '')
              if (fp) K.changedFiles.add(fp)
              else if (wn === 'apply_patch') K.changedFiles.add('(multi-file patch)')
            }
          } catch { /* 忽略 */ }
          RT.synthHeartbeat(exec.name, ok)
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
                K.seenSteps.set(f, `${body.length}:${body.slice(0, 60)}:${body.slice(-60)}`)
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
            RT.wakeBack('tool-fail', `【T2】前台工具 ${nm} 连续失败 ${toolStats.failStreak} 次。请读 .board/state.md 与 heartbeat.log，判断是否需要调整计划。`)
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
                  if (!K.reworkAlerted.has(k)) {
                    K.reworkAlerted.add(k)
                    event('rework-detected', { file: cur.fp, hits: sameFileHits, grown })
                    log(`近距返工：${cur.fp} 6 次内写 ${sameFileHits} 次且总量只增 ${grown}B → 唤醒后台`)
                    RT.wakeBack('rework', `【返工】同一文件 ${cur.fp} 最近 6 次写操作里被改 ${sameFileHits} 次、总字节仅增 ${grown}B，疑似原地打转。请读 state.md 判断是否路线有误。`)
                  }
                }
              }
            }
          } catch { /* 返工检测失败不影响主流程 */ }
    // 重复动作（近似 H1；官方 repeat-tool-reminder 只管精确重复且只提醒）
          const key = exec.name + ':' + JSON.stringify(exec.arguments || {}).slice(0, 120)
          if (key === toolStats.lastSame) toolStats.sameCount++
          else { toolStats.lastSame = key; toolStats.sameCount = 1 }
          if (toolStats.sameCount === 4) RT.wakeBack('stuck', `【H1】前台连续 4 次相同调用（${exec.name}），疑似打转。请给出脱困指令或改计划。`)
        } else if (isBack(exec.agent)) {
          // ★ M16 tick 事件化：后台一写完 steps 就立刻检查投递（原来只靠 30s 轮询）
          try { RT.annotateSteps(); RT.checkNewSteps() } catch { /* 忽略 */ }
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
          if (maxNo > 0 && doneNo >= maxNo && !hasDeliver() && !K.finalAsked) {
            K.finalAsked = true
            const auditPrompt = cfg.finalAudit === false ? null : RT.buildFinalPrompt()
            if (auditPrompt) vlog('final-audit-start', { items: auditPrompt.acc.length })
            RT.wakeBack('final', auditPrompt ? auditPrompt.text : '【终局】前台已跑完清单最后一步，请做终局复核：若完成，写 .board/deliver.v1.md；若未完成，写下一批 .board/steps/S*.md。')
          }
          // ★ 终局正文兜底（实测事故：只写文件、回复一片废话、用户拿不到交付）
          if (maxNo > 0 && doneNo >= maxNo && !K.finalAnswerAsked) {
            const txt = GD.lastAssistantText(agent)
            if (txt.replace(/\s/g, '').length < 60) {
              K.finalAnswerAsked = true
              event('final-answer-ask', { chars: txt.length })
              log('终局正文缺失（' + txt.length + ' 字）→ 要求前台补交付')
              setTimeout(() => {
                try {
                  K.front.followup(msg('【终局交付】你已跑完最后一步，但用户看不到结果。现在**用 ≤400 字直接回答**：①结论是什么 ②产出文件绝对路径 ③注意事项。不要调用任何工具，只写正文。'))
                } catch (e2) { log('final-answer ask fail: ' + e2.message) }
              }, 400)
            }
          }
        }
      } catch (e) { log('turn-stopping err: ' + e.message) }
    })

    // ④ 30s 轮询：机械哨兵 + 催单 + 新步骤投递 + 重新解析接线（兜底；实时投递见 fs.watch）
    const stepsWatcher = RT.startStepsWatcher()
    yield () => { try { stepsWatcher && stepsWatcher.close() } catch { /* 忽略 */ } }
    yield ctx.setInterval(() => {
      const tickT0 = Date.now()
      try {
        if (!alive()) return        // ★ 旧实例（被热重载替换掉的）立即停摆，避免双实例叠加
        if (!cfg.enabled) return
        try { ensureLogsBounded() } catch { /* 轮转失败不影响主循环 */ }   // 日志无界增长治本
        resolveAgents()
        RT.splitBatchFile()         // M19：后台的批量清单 → 拆成 steps/S<k>.md
        RT.ensureRouteMilestones()  // ⑤ 自动补全：后台没写「## 里程碑」段时插件按 steps 补齐
        RT.checkVerdict()           // B13 后台分诊否决：判为短任务则让前台自己做
        checkFireFile()          // 消防通道 ②③：外部/后台写 fire.md ⇒ 打断前台
        GD.checkContextBudget().catch(() => {})   // 按角色的上下文守护（异步，不阻塞 tick）
        ensureWiring().catch(() => {})         // 接线自愈：重启后自动重建前后台
        GD.checkFirstFrame()        // P1 慢模型兜底：首帧超时 → 让前台先做只读侦察
        // ★ pendingDeliver 兜底（2026-10-18）：投递曾因前台长时间 running + 重试预算耗尽
        //   而永久放弃（实测 watcher-fire 3 次但 step-delivered 为 0）。
        //   这里每 tick 只要还有"待投递"标记、且前台已空闲，就再试一次。
        if (K.pendingDeliver || K.deliverRetry > 0) {
          const frontBusyNow = K.front && K.front.phase && K.front.phase.kind === 'running'
          if (!frontBusyNow) {
            K.deliverRetry = 0
            K.pendingDeliver = false
            K.pendingDeliverLogged = false
          }
        }
        try { syncPhaseToNextStep() } catch { /* 相位转移失败不影响主循环 */ }
        RT.checkNewSteps()
        RT.checkLookahead()
        try { checkPlanningStarvation() } catch { /* 断粮降精度失败不影响主循环 */ }
        // ★ Phase 2/3/4：咨询分析投递、里程碑复核、黑板归档（各自内部有守卫与节流）
        try { checkAnalysisDelivery() } catch { /* 忽略 */ }
        try { checkMilestoneReview() } catch { /* 忽略 */ }
        try { RT.maybeReviewDiff() } catch { /* 只读审 diff 失败不影响主循环 */ }
        try { RT.checkFinalAudit() } catch { /* 终局对照审失败不影响主循环 */ }
        try { archiveBoardIfDone() } catch { /* 忽略 */ }
        try { cleanupWorkers() } catch { /* 忽略 */ }
        GD.runSentinels()
        GD.runBusinessSentinels()   // B12 业务哨兵（route.md 的机械条件）+ 命中则打断后台
        saveMetrics()            // B11 度量落盘
        const tickMs = Date.now() - tickT0
        if (tickMs > 50) event('tick-slow', { ms: tickMs })
      } catch (e) { log('interval err: ' + e.message) }
    }, cfg.sentinelIntervalMs)

    log('接线完成，监听器已挂')
  }, 'dsh-fast-react: core')

  K.scopePatched = new Set()
  K.globalRegistered = new Set()
  // [重构③] 自检/全局入口/内部角色工具 + safeRegister/registerFrToolsTo/globalRegister → lib/tools-reg.js
  const TR = makeToolsReg(D)

  // ══ B10 档位漂移 ═══════════════════════════════════════════════════════
  // DSH 的 agentDefaultModel 是**全局单例**（无 per-session 档位），无法给两个会话分别设 effort。
  // 折中：**在唤醒谁之前**把全局档位切到该角色应有的值。前提：同一时刻基本只有一个角色在跑。
  K.curEffort = null
  // [重构①] 僵死看门狗 / T3 拦截 / 机械哨兵 / 首帧兜底（函数体）（续）→ lib/guards.js

  // ══ B11 度量落盘 ═══════════════════════════════════════════════════════
  // 计数器是内存态，插件重载会归零；落盘后重载可续（补齐「状态可从黑板重建」）。
  const METRICS_FILE = join(boardDir, 'metrics.json')
  function saveMetrics () {
    try {
      writeAtomic(METRICS_FILE, JSON.stringify({
        toolStats, wakeCount: RT.wakeCount, t3Blocked: K.t3Blocked, finalAsked: K.finalAsked, stepsThisTask: K.stepsThisTask, at: new Date().toISOString(),
      }, null, 1))
    } catch { /* 静默 */ }
  }
  try {
    const m = JSON.parse(readIf(METRICS_FILE))
    if (m) {
      if (m.toolStats) Object.assign(toolStats, m.toolStats)
      if (m.wakeCount) { RT.wakeCount.total = m.wakeCount.total || 0; RT.wakeCount.byReason = m.wakeCount.byReason || {} }
      if (typeof m.t3Blocked === 'number') K.t3Blocked = m.t3Blocked
      if (typeof m.finalAsked === 'boolean') K.finalAsked = m.finalAsked
      // ★ 不恢复 stepsThisTask：它是「本任务」计数，插件重启 ⇒ 新运行时 ⇒ 必须归零。
      //   实测：重启后从 metrics 恢复成 245 ⇒ H5「步数超阈」立刻误报并白唤醒后台。
      K.stepsThisTask = 0
      log('度量已恢复 tools=' + toolStats.total + ' wakes=' + RT.wakeCount.total + ' t3=' + K.t3Blocked + '（步数已归零）')
    }
  } catch { /* 首次运行 */ }
  saveMetrics()

  // [重构①] 僵死看门狗 / T3 拦截 / 机械哨兵 / 首帧兜底（函数体）（续）→ lib/guards.js

  K.lastBizAlertKey = ''
  // [重构①] 僵死看门狗 / T3 拦截 / 机械哨兵 / 首帧兜底（函数体）（续）→ lib/guards.js

  log('插件已加载（apply 完成）')
}
