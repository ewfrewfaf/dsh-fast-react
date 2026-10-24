/** defaults.js —— 插件默认配置（v1.3.1 从 index.js 抽出，纯常量对象） */

export const DEFAULTS = {
  boardRoot: 'C:\\Users\\admin\\Desktop\\FastReact',
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
  prefetchCooldownMs: 45000,
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
  frontContextLimit: 60000,
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
}
