/** defaults.js —— 插件默认配置（v1.3.1 从 index.js 抽出，纯常量对象） */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

// ★ 黑板目录默认值必须**可移植**（2026-11-07）：
//   原来写死 C:\Users\admin\Desktop\FastReact ⇒ 换台机器/换个 Windows 账号，
//   目录不存在，ensure() 要么建不出来（EPERM），要么把会话 cwd 指到不存在的路径。
//   优先级（从高到低）：
//     ① FAST_REACT_BOARD 环境变量（显式指定，最高优先）
//     ② 老装机迁移：~/Desktop/FastReact 已有 .board/config.json ⇒ 沿用
//     ③ DSH_HOME 环境变量 + /fast-react
//     ④ 默认：~/.dsh/fast-react
//   ⚠️ ② 必须**先于** ③：DSH_HOME 在很多机器上是默认就设好的环境变量，
//      若让 ③ 压过 ②，老用户会被"凭空搬一次黑板"（历史步骤/事件全部改道），
//      这是真正会丢数据的方向，比"尊重 DSH_HOME"重要。
//      实测：本机 DSH_HOME=C:\Users\admin\.dsh 一直是设着的，②在③前才不会改道。
export const DEFAULT_BOARD_ROOT = (() => {
  const explicit = process.env.FAST_REACT_BOARD
  if (explicit) return explicit
  // 老装机迁移：旧版默认写死在 Desktop/FastReact。已有板子 ⇒ 继续用它。
  const legacy = join(homedir(), 'Desktop', 'FastReact')
  try { if (existsSync(join(legacy, '.board', 'config.json'))) return legacy } catch { /* 忽略 */ }
  const dshHome = process.env.DSH_HOME
  if (dshHome) return join(dshHome, 'fast-react')
  return join(homedir(), '.dsh', 'fast-react')
})()

export const DEFAULTS = {
  boardRoot: DEFAULT_BOARD_ROOT,
  // 前后台用哪个模型：留空=跟随全局默认模型；建议显式指定一个快模型
  provider: '',
  model: '',
  frontPreset: 'fast-react-front',
  backPreset: 'fast-react-back',
  frontSessionId: '',
  backSessionId: '',
  enabled: true,
  // 流水线预规划：前台剩余步骤 <= pipelinePrefetch 时提前唤醒后台补下一批
  pipelinePrefetch: 3,
  // ★ 2026-11-07：45s → 10s。实测后台产一批只要 6.7s，45s 冷却等于让后台 87% 时间空等。
  //   真正的节奏由 prefetchCooldownFor() 决定（缺口 2s / 常规 5s / 此处作兜底上限）。
  prefetchCooldownMs: 10000,
  sentinelEnabled: true,
  batchSteps: 3,            // 一次投递几条步骤（固定 3，解耦自适应复杂度——已证自适应收益≈0）
  // M1 拉取模式：前台干完自己读 steps/S<k+1>.md（不走推送）⇒ 省掉 30s tick 的串行等待。
  // 仍然保留"前台空闲且下一步就绪时推一次"的兜底，避免 stall（守住"及时响应"KPI）。
  pullSteps: true,
  // ── 按角色的上下文守护（2026-10-17）：DSH 的 compaction-basic 只能按 {provider,model} 配阈值，
  //   而前后台用**同一个模型** ⇒ 无法区分。这里用 ctx.compaction.compactNow() 自己按角色压：
  //   前台要快 ⇒ 小预算；后台频率低、需要长历史 ⇒ 大预算（几乎不压）。
  //   配套：profile patch 里把该模型的 auto 阈值设高（0.9）当安全网，日常交给这里。
  contextGuard: true,
  frontContextLimit: 80000,
  backContextLimit: 600000,
  // ── 僵死看门狗（2026-10-17 实测事故）：前台 phase=running，但会话 4 分钟零写入、
  //   零工具调用（模型流卡住），插件完全不知情 ⇒ 用户干等。
  //   规则：running 且超时无任何活动 ⇒ cancel；若本轮**一个工具都还没跑**（没动过手），
  //   自动重投最后一条用户消息（safe-retry），避免用户重打一遍。
  stallWatchdog: true,
  stallTimeoutMs: 150000,           // 2.5 分钟无活动即判定僵死
  stallSafeRetry: true,             // 仅当本轮没执行过任何工具时才自动重投
  // ── 前台会话可见性（2026-10-17）：插件创建的会话是内存会话，**不会出现在 DSH 侧边栏**，
  //   用户无法打开原生会话页（只能看我做的面板）。这里把它 attach 到黑板所在目录的
  //   Workspace 并 pin 住 ⇒ DSH 侧边栏出现该会话，点开就是原生会话页。
  linkWorkspaceSession: true,
  // 接线自愈：自动创建的会话是内存态，DSH 重启后消失 ⇒ 插件自动重建（用全局默认模型 + standard 预设）
  autoHeal: true,
  // ── 消防通道（实现逻辑 v2 §5.5）：全架构唯一允许"打断"的通道。
  //    只有 3 类触发：① 用户插话 ② 环境危险事件 ③ 后台发现"正在做错事"。
  //    硬约束：冷却 + 每任务上限 + 必须记账（打断 = 白扔一次生成，median 11-14s）。
  interruptCooldownMs: 60000,
  interruptMaxPerTask: 5,            // 一次投递几条步骤（A/B 实测：逐条投递让前台步数翻倍）
  sentinelIntervalMs: 30000,
  wakeCooldownMs: 20000,
  // P1 慢模型兜底：escalate 后 N 分钟内仍无步骤投递 → 让前台先做只读侦察（别空等）
  firstFrameTimeoutMs: 180000,
  taskStepMax: 60,
  failStreakMax: 3,
  // ── 档位漂移（B10）：DSH 的 agentDefaultModel 是全局单例，无 per-session 档位。
  //    ⚠️ 2026-10-17 实测**对已存在会话无效**（会话的 effort 来自它自己的 model/selection，
  //    不是全局默认）⇒ 默认关闭，留作将来 New Session 时可用。
  effortDrift: false,
  frontEffort: 'low',
  backEffort: 'max',
  // ── 路由跟随（B14，省钱）：把已接线会话的 provider/model **同步到全局默认**。
  //    实测：Agent.options 在会话创建时钉死，用户在设置里切到免费模型对旧会话无效，
  //    旧会话仍在烧付费 API。开启后插件每次都把两会话同步到当前全局默认。
  followGlobalRoute: true,
  // ── 任务模式（Phase 1，2026-10-24）──────────────────────────────────────
  //   mode:''         = 自动判型（前台可用 fr_mode 声明覆盖；机械规则兜底）
  //   modeLocked:true = 锁定当前模式，拒绝自动/模型切换（用户手动切换仍允许）
  //   modeAuto:false  = 关闭自动判型，只认显式声明（保守用法）
  mode: '',
  modeLocked: false,
  modeAuto: true,
  // 前/后台会话挂哪个 DSH agent preset。standard=全量(含 team_*/subagent 等 scoped 工具)
  // minimal=精简工具集, 从源头避免看得见却调不动的诱饵工具
  agentPreset: 'standard',
  // 权限预设（T3 闸门判定依据；'' = 跟随 DSH 默认）
  permissionPreset: 'danger-full-access',
  // 哨兵阈值可配（Phase 4）：H3 心跳停滞阈值（毫秒）
  heartbeatStaleMs: 300000,
  // 前后台分开的模型（空 = 跟随 provider/model 全局默认；Phase 6 UI 用）
  frontProvider: '',
  frontModel: '',
  backProvider: '',
  backModel: '',
  // ── Phase 2 收尾（2026-10-24）：三个可观测开关 ──────────────────────────
  //   batchAdapt: 步长按"最近几步耗时/失败"自适应（保守+滞回；关闭则用模式固定值）
  //   preread:    预取唤醒时附带"可先只读预读这些文件"提示（纯提示，不实际读）
  //   workersEnabled: 受控只读 worker（默认关；开了也只允许只读工具）
  batchAdapt: true,
  preread: true,
  workersEnabled: false,
  // ── 详细日志（2026-11-07）：默认关闭。开启后只往 .board/detail.jsonl 追加结构化行，
  //   不参与任何判断、不进模型上下文；用于量化"某个机制到底省了多少"。
  //   运行时开关：POST /fr/api/config {"verboseLog":true}
  // ── 终局对照审（2026-11-07）：把「完成」的判定权从执行者的说辞挪到开工时定下的验收标准。
  //   开启后：终局唤醒内联 goal + acceptance；deliver 必须带「验收: A1✓ A2✓」行且覆盖全部条目，
  //   否则插件把该 deliver 改名作废、让后台补（最多 finalAuditMaxRetry 次，之后放行并标记）。
  finalAudit: true,
  finalAuditMaxRetry: 2,
  // ── steps → 官方 todo 的单向镜像（2026-11-07）
  //   唯一写者是插件；todo_write 是整表替换语义，冲突由覆盖收敛。
  //   ★ todos 投影在**每个 turn/start 重置**，所以每个 turn 开头要重写一次快照。
  todoMirror: true,
  // 干扰预算：单任务唤醒超过这个数就记 budget-exceeded 事件（不是硬闸门，只是可测）
  budgetWakes: 12,
  // 编排会话里禁用折叠工具（tool_fold）：折叠会改工具目录 ⇒ 破坏前缀缓存 + 并行调用时缺工具
  blockToolFold: true,
  // 编排会话的「外围噪音工具」黑名单（正则数组）。空数组/null = 用 modes.js 的默认表。
  // 测某插件时若需要它的工具，把对应项删掉或设 [] 全放开。
  frDenyExtra: null,
  // ── 多实例（2026-11-07）────────────────────────────────────────────────
  // 同一插件包可挂多次；tag 决定：会话前缀 / 工具名后缀 / 路由基路径。
  // 'a' = 默认（保持旧名 session-fr-*、fr_* 工具、/fr 路由），其它 tag 全部加后缀。
  instanceTag: 'a',
  // ── 实验开关（2026-11-07）：先装开关，测过再定默认值 ──────────────────
  // 性能档位：speed（极速，前台 minimal/后台 medium）| balanced（默认）| max（极致，前后台都高）
  tier: 'balanced',
  // worker 并发上限：retrieval 扇形检索实际能派几个（历史只有 2）
  workerMax: 2,
  // retrieval 模式是否下发"扇形派发"指令（关掉 = 退回前台自己并行查）
  // ★ 实测（2026-11-07）：40 文件检索任务中，扇形 worker 比前台自己 grep 慢 48%（30.7s vs 20.7s）、
  //   工具调用多 62%（13 vs 8）。worker 每次都要起完整会话（模型+简报+汇总）。
  //   默认改关；只在「文件数 > 200 或跨目录语义检索」时手动打开。
  fanoutWorkers: false,
  // coding 模式是否让后台只读复核改过的文件
  reviewDiffEnabled: true,
  // 是否用 fast-react-front 预设（= standard + apply_patch 打开）
  applyPatchPreset: false,
  // 面板轮询是否走统一调度器（关掉 = 退回每个模块各自的 setInterval，用于对照）
  pollUnified: true,
  // 首帧超时兜底：true = 回带任务原文并允许先推进；false = 老行为（只做只读侦察）
  firstFrameEcho: true,
  verboseLog: true,
}
