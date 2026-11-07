/**
 * modes.js —— 快速反应的「任务模式」预设层（Phase 1）
 *
 * 设计原则（2026-10-24 定稿）：
 *  - 复杂度放在**数据**里，不放在代码分支里：加预设 = 加一条表项，不改流水线。
 *  - 每个预设只影响 4 个旋钮：工具白名单 / 节奏（batchSteps·复核·预取）/ 预算 / 交付形态。
 *  - 5 个正交维度（shape/depth/parallel/autonomy/deliver）先只用于描述与展示，
 *    真正生效的是各预设里的显式字段；以后要加"组合模式"时再按维度推导。
 *  - 判型失败永远有安全值：默认 coding（和现在行为一致）。
 *
 * 本文件是纯数据 + 纯函数，不碰 fs/ctx，便于单测。
 */

/** 5 个正交维度：只作描述与未来组合用 */
export const DIMENSIONS = {
  shape: ['consult', 'retrieval', 'build', 'ops', 'review'],
  depth: ['low', 'medium', 'high', 'xhigh'],
  parallel: ['solo', 'groups', 'worker'],
  autonomy: ['strict', 'normal', 'loose'],
  deliver: ['answer', 'analysis', 'report', 'patch'],
}

/**
 * 预设表。
 * backend     是否需要后台参与
 * writeSteps  后台是否写 route+steps（false ⇒ 只输出 analysis，咨询/速答用）
 * firstAck    前台是否"先回一句再干"
 * batchSteps  一次投递几条（0 = 不适用）
 * reviewEvery 每几步触发一次后台轻复核（0 = 关）
 * prefetch    是否启用流水线预取
 * research    是否允许用 web 工具查资料
 * 注：历史版本这里有过 frontTools/backTools 按模式的白名单，已于 2026-10-24 移除（设计倒退，见 M13 原则）
 */
export const PRESETS = {
  quick: {
    key: 'quick',
    label: '速答',
    summary: '不编排：前台自己做（问答/小改动/单文件实现都归这里）',
    dims: { shape: 'consult', depth: 'low', parallel: 'solo', autonomy: 'loose', deliver: 'answer' },
    backend: false,
    writeSteps: false,
    firstAck: true,
    batchSteps: 0,
    reviewEvery: 0,
    prefetch: false,
    research: true,
    // ★ 极速反射（2026-11-07 二次修正）：'minimal' 不是合法值。
    //   DeepSeek 官方支持 off/low/high/max —— 关闭思考用 'off'。
    //   'off' 是"极速反射"的正确表达：真的关掉思考，而不是降档。
    frontEffort: 'off',
  },
  consult: {
    key: 'consult',
    label: '咨询',
    summary: '深度分析：后台可查资料，只产出 analysis.md，不写步骤',
    dims: { shape: 'consult', depth: 'high', parallel: 'solo', autonomy: 'normal', deliver: 'analysis' },
    backend: true,
    writeSteps: false,
    firstAck: true,
    batchSteps: 0,
    reviewEvery: 0,
    prefetch: false,
    research: true,
  },
  retrieval: {
    key: 'retrieval',
    label: '检索',
    summary: '长检索：前台自己并行查，不惊动后台',
    dims: { shape: 'retrieval', depth: 'low', parallel: 'groups', autonomy: 'loose', deliver: 'report' },
    backend: false,
    writeSteps: false,
    firstAck: true,
    batchSteps: 0,
    reviewEvery: 0,
    prefetch: false,
    research: true,
    // ★ 扇形检索（2026-11-07）：本模式的独特形态——前台 1 派 N 个只读 worker 并行查，
    //   再汇总作答。方向正确：只读、并行、由快模型承担执行。
    fanout: 2,
  },
  // ══ 审查模式（2026-11-08 新增）══════════════════════════════════════════
  //   用途：读代码找问题、产审查报告，**不改代码**。
  //   与 consult 的区别：consult 分析"为什么/怎么做"，review 检查"哪里错了/有什么隐患"。
  //   与 coding 的区别：coding 改代码，review 只读不写。
  review: {
    key: 'review',
    label: '审查',
    summary: '读代码找问题，产审查报告，不改代码',
    dims: { shape: 'review', depth: 'high', parallel: 'solo', autonomy: 'strict', deliver: 'report' },
    backend: true,          // 需要后台：规划"审哪些文件、按什么标准审"
    writeSteps: false,      // 不写 steps，只产出 review.md
    firstAck: false,
    batchSteps: 0,
    reviewEvery: 0,
    prefetch: false,
    research: true,
    frontEffort: 'high',    // 审查要深度思考
  },
  coding: {
    key: 'coding',
    label: '编码',
    summary: '标准编排：后台写路线+步骤，前台执行（与旧行为一致）',
    dims: { shape: 'build', depth: 'medium', parallel: 'groups', autonomy: 'normal', deliver: 'patch' },
    backend: true,
    writeSteps: true,
    firstAck: true,
    batchSteps: 2,
    reviewEvery: 5,
    prefetch: true,
    research: true,
    // ★ 编码模式的独特形态（2026-11-07）：前台写、后台**只读审 diff**（不写代码）。
    //   比"后台写代码、前台测试"效率方向正确——慢模型只做判断，快模型做体力。
    reviewDiff: true,
  },
}

export const DEFAULT_MODE = 'coding'
export const MODE_KEYS = Object.keys(PRESETS)

/**
 * ★★ 2026-11-07 判型优化：判断「这个任务值不值得走编排」。
 *
 * 数据依据（每档 5 轮实测，见 快速反应-效率对比报告-第五版.md）：
 *   L1 编排 17.4s vs 单Agent 12.1s  → 慢 43%
 *   L2 编排 28.9s vs 单Agent 21.3s  → 慢 36%
 *   L3 编排 57.2s vs 单Agent 39.7s  → 慢 44%
 *   L4 编排 50.1s vs 单Agent 44.3s  → 慢 13%
 *   L5 编排 60.6s vs 单Agent 141.2s → 快 57%（工具 18 vs 49）
 *
 * 关键发现：**分界线不是「文件数」**（L3 有 3 个文件仍亏 44%），
 *   而是「任务是不是需要**设计**，而非**实现**」。
 *   L1-L4 都是"规格已给、照着实现"；L5 是"自己定架构"（WAL 格式/事务隔离/并发）。
 *
 * 所以判据看「系统级设计信号」，不看文件数或代码量。
 *
 * 返回 { orchestrate: boolean, score: number, hits: string[] }
 */
/**
 * ★★ 2026-11-08 判型引擎 v2：分层细词表 + 三档判定
 *
 * 设计原则（参照 Hindsight/灵枢 的双路径架构）：
 *   · 机械判型只负责"**确信**"的两端（免费、瞬时）
 *   · 不确定的中间地带交给后台分诊（一次 LLM 调用）
 *   · 这是"弱命中不裁决"原则的落地 —— 词表不可靠时不硬判，让能判断的去判断
 *
 * 为什么词表要细：
 *   实测旧版只有 6 个强信号，L3 得 0 分是"碰巧"低于阈值 3，不是靠特征判对。
 *   细粒度词表的目标不是"更准"（词表永远不可能完全准），而是"**降低漏判**"，
 *   再把不确定的都推进灰区让分诊兜底。
 *
 * 三档：
 *   score >= 8   → coding（确信需要编排）
 *   score <= -2  → quick（确信不需要）
 *   否则          → 灰区 ⇒ quick + 后台并行分诊
 */

/** 词表：每个条目 = [正则, 标签, 权重]。同层有上限，防"并发 并发 并发"刷分。 */
const LEX = {
  // ══ 层 1：系统设计核心（+3/条，同层最多计 3 条）══════════════════════
  sys: [
    // 存储引擎
    [/(?:WAL|write-ahead|预写日志|预写|日志回放|replay|redo log)/i, 'WAL/日志回放', 3],
    [/(?:memtable|LSM|B\+?树|B tree|compaction|压缩合并|快照|snapshot)/i, '存储引擎结构', 3],
    [/(?:键索引|二级索引|倒排索引|索引结构|索引维护|索引重建)/, '索引设计', 3],
    [/(?:持久化|落盘|fsync|刷盘|磁盘格式|页格式|段文件)/, '持久化/磁盘格式', 3],
    // 并发
    // ★ 2026-11-08 放宽：允许「支持/可/实现/保证 + 并发」这类动词前缀
    //   实测漏判：「把单线程KV改造成支持并发、崩溃可恢复、带索引」只拿 3 分（该 6+）
    [/(?:支持|可|实现|保证|需要)?\s*(?:线程安全|并发安全|并发控制|并发访问|并发读写|并行安全|race condition|竞态|数据竞争)/i, '并发安全', 3],
    [/(?:加锁|锁粒度|锁升级|死锁|读锁|写锁|互斥|Mutex|Semaphore)/i, '锁设计', 3],
    [/(?:原子操作|CAS|compare.and.swap|内存序|happens.before)/i, '原子性/内存序', 3],
    [/(?:无锁|lock.free|wait.free)/i, '无锁设计', 3],
    // 事务
    [/(?:事务隔离|隔离级别|未提交|不可重复读|幻读|脏读)/, '事务隔离', 3],
    [/(?:ACID|两阶段提交|2PC|原子性|原子提交|rollback|回滚)/i, '原子性/回滚', 3],
    // 恢复
    [/(?:支持|可|实现|保证|需要)?\s*(?:崩溃恢复|崩溃可恢复|断电恢复|故障恢复|故障转移|恢复到最后|crash recovery|恢复流程)/i, '崩溃恢复', 3],
    // 协议
    [/(?:一致性协议|共识算法|共识协议|consensus)/i, '一致性协议', 3],
    // ★ 2026-11-08：raft/paxos/选举/日志复制 单独成条。
    //   实测：「实现 Raft 共识协议，支持选举和日志复制」原来只命中一条(+3)，
    //   而 GRAY_LOW=3 是 <= ⇒ 被误判成 quick。拆开后能命中两条(+6)稳定进 coding。
    [/(?:raft|paxos|选举|日志复制|quorum|多数派)/i, '共识协议实现', 3],
    [/(?:分布式系统|分布式存储|分布式锁|分布式事务)/, '分布式系统', 3],
    // 分布式
    [/(?:分布式|分片|sharding|复制副本|replication|分区容错|CAP)/i, '分布式设计', 3],
    // 编译器/解释器
    [/(?:词法分析|语法分析|AST|抽象语法树|字节码|虚拟机|解释器|编译器|解析器)/, '编译/解释器', 3],
    // 网络协议
    [/(?:握手协议|状态机协议|消息队列|订阅发布|背压|流控)/, '协议/消息', 3],
  ],

  // ══ 层 2：架构设计动作（+2/条，同层最多计 3 条）═════════════════════
  arch: [
    [/(?:从零|从头|重新设计|推倒重来|重新实现)/, '从零设计', 2],
    [/(?:架构改造|架构设计|系统级|整体设计|完整实现|改造成|重构为|重写为)/, '架构改造', 2],
    [/(?:实现一个|自行设计|自己设计|设计一个|搭建一个)/, '自主设计', 2],
    [/(?:拆分|抽象|解耦|分层设计|模块化设计|插件化|泛化)/, '结构性重构', 2],
    [/(?:设计模式|策略模式|工厂模式|观察者|责任链|状态机|管道模式)/, '设计模式', 2],
    [/(?:增量构建|冷热分离|读写分离|缓存分层|多级缓存)/, '架构策略', 2],
  ],

  // ══ 层 3：复杂度信号（+1/条，同层最多计 4 条）═══════════════════════
  complex: [
    [/(?:多文件|多个文件|跨文件|多模块|多个模块|子系统)/, '多文件/模块', 1],
    [/(?:重构|改造|迁移|重写)/, '重构/改造', 1],
    [/(?:端到端|全流程|全链路|完整链路|流水线|pipeline)/i, '端到端流程', 1],
    [/(?:并发执行|并行执行|批量处理|批处理|批量化)/, '并发/批量', 1],
    [/(?:调度器|调度|编排|编排器|协调器|管理器)/, '调度/编排', 1],
    [/(?:状态机|状态流转|生命周期|会话管理|连接池)/, '状态管理', 1],
    [/(?:性能优化|减少延迟|吞吐|压力测试|基准测试|benchmark)/i, '性能工程', 1],
    [/(?:边界情况|异常路径|错误恢复|降级|熔断|限流)/, '鲁棒性设计', 1],
    [/(?:数据迁移|版本兼容|向后兼容|升级路径)/, '兼容性设计', 1],
  ],

  // ══ 层 4：反面词（−3/条，同层最多计 3 条）═══════════════════════════
  //  强烈的"照着做就行"信号 —— 出现这些说明不需要设计
  spec: [
    [/(?:已知的|已知问题|下面只说现象|下述现象|现象如下)/, '已知问题清单', -3],
    [/(?:按.{0,12}实现|照.{0,8}写|按规格|按文档|按接口)/, '照规格实现', -3],
    [/(?:规格已|验收标准已|实现要求|需求已明确|要求如下)/, '规格已给出', -3],
    [/(?:逐条实现|逐项实现|一项项|逐行)/, '逐条实现', -3],
    [/(?:修复|修一下|改一下|打个补丁|补丁|fix|bug|报错)/i, '修 bug', -3],
    [/(?:加一个函数|加个函数|新增函数|补个函数|写个函数)/, '加函数', -3],
    [/(?:单文件|单个文件|一个文件|单函数|单个函数)/, '单文件', -3],
    // ★★ 2026-11-08：**「已知 N 个问题」是极强的"照着做"信号**
    //   实测依据（L4，8 轮真编排 vs 5 轮单 Agent）：
    //     单 Agent 中位 44.3s（27,43,44,49,55）
    //     真编排   中位 55.3s（28,44,46,50,61,78,80,83）
    //     ⇒ 编排慢 25%，而且 L4 只有 1 个文件（scheduler/index.js）
    //   所以"列出了 N 个已知问题 + 不涉及多文件" ⇒ 前台一次读完就能做，不需要后台规划。
    [/(?:\d+|几|多)\s*个\s*(?:问题|bug|缺陷|毛病)/i, '已知N个问题', -6],
  ],
}

/** 反向加分：明确的大规模信号（代码行数很大时抵消"单文件"的负分） */
const SCALE = [
  [/(?:约|大概|接近)?\s*(\d{3,})\s*行/, '代码量提示'],
]

// ★★ 2026-11-08 阈值调整（实测定档）
//
//  旧：灰区 (−2, 8)，宽 10
//  新：灰区 ( 1, 6)，宽 5  —— 收紧 + 整体右移
//
//  依据（v4 灰区实测 4 轮）：
//    L3 score=2 —— 判 quick 是对的（24.7s 那轮比单 Agent 的 39.7s 还快）
//    L4 score=6 —— 多文件+重构+并发+调度，该判 coding（它 r1 分诊后确实升级了）
//    分诊 4 次唤醒只有 1 次真正产出结果 ⇒ 灰区越大越亏
//
//  所以：把"模糊"的判定窗口做窄、并往上抬，让 L4 这种"看起来中等但其实复杂"
//  的任务直接走 coding；L3 这种"3文件但代码少"的仍留在灰区问一次。
const GRAY_HIGH = 6     // >= 6 → 确信 coding
const GRAY_LOW = 3      // <= 3 → 确信 quick
// ★ 2026-11-08 二次调整：GRAY_LOW 从 1 提到 3。
//   依据（L3 四轮实测）：判 gray 时中位 57-76s，而单 Agent 只要 39.7s —— 慢 44-91%。
//   根因：灰区里前台"先做"，做了一半后台才判"需要编排"⇒ 切换 ⇒ 两次功。
//   所以 L3(score=2) 这种"3文件但代码少"的任务，直接判 quick 让前台一次做完更快。
const THRESHOLD_HIGH = GRAY_HIGH
const THRESHOLD_LOW = GRAY_LOW
const LAYER_CAP = { sys: 3, arch: 3, complex: 4, spec: 3 }

/**
 * 判型（机械，零模型调用）
 * @returns {{ tend: 'coding'|'quick'|'gray', score: number, hits: string[], gray: boolean }}
 */
export function shouldOrchestrate (text) {
  const t = String(text || '')
  if (!t.trim()) return { tend: 'quick', orchestrate: false, score: 0, hits: [], gray: false }

  const hits = []
  const detail = []
  let score = 0

  for (const [layer, rules] of Object.entries(LEX)) {
    let counted = 0
    for (const [re, label, weight] of rules) {
      if (counted >= LAYER_CAP[layer]) break
      if (!re.test(t)) continue
      score += weight
      counted++
      hits.push(label)
      detail.push({ layer, label, weight })
    }
    if (counted >= LAYER_CAP[layer]) hits.push(`${layer}层封顶(${LAYER_CAP[layer]})`)
  }

  // 代码量：>=150 行抵消"单文件/小"的负分（重新加回 +2）
  const linesMatch = t.match(/(?:约|大概|接近)?\s*(\d{2,4})\s*行/)
  if (linesMatch) {
    const n = Number(linesMatch[1])
    if (n >= 350) { score += 3; hits.push(`代码量 ${n} 行(+3)`) }
    else if (n >= 150) { score += 2; hits.push(`代码量 ${n} 行(+2)`) }
    else if (n <= 60) { score += -1; hits.push(`代码量 ${n} 行(-1)`) }
  }

  // 子模块数（从路径推断）
  const paths = t.match(/[A-Za-z0-9_\-]+\/[A-Za-z0-9_\-]+\.(?:js|mjs|ts|tsx|py|go|rs|java|c|cpp|h)/g) || []
  const moduleCount = new Set(paths.map(p => p.split('/')[0])).size
  if (moduleCount >= 4) { score += 3; hits.push(`${moduleCount} 个子模块(+3)`) }
  else if (moduleCount >= 3) { score += 2; hits.push(`${moduleCount} 个子模块(+2)`) }

  // ★ 短文本兜底：没有任何"动手"意图的短问题 ⇒ 直接 quick（不进灰区）
  const hasAction = /(改|修|实现|写|加|创建|新建|重构|优化|迁移|部署|构建|跑|执行|删除|清理)/.test(t)
  const isShortQuestion = t.trim().length <= 120 && !hasAction
  if (isShortQuestion && score < THRESHOLD_HIGH) {
    return { tend: 'quick', orchestrate: false, gray: false, score, hits, detail, reason: '短问句无动作意图' }
  }

  // 三档判定
  let tend
  if (score >= THRESHOLD_HIGH) tend = 'coding'
  else if (score <= THRESHOLD_LOW) tend = 'quick'
  else tend = 'gray'

  return {
    tend,
    orchestrate: tend === 'coding',
    gray: tend === 'gray',
    score,
    hits,
    detail,
  }
}

/** 判型可读摘要（日志/事件用） */
export function describeTendency (r) {
  if (!r) return 'unknown'
  const zone = r.tend === 'coding' ? '确信编排' : (r.tend === 'quick' ? '确信不编排' : '灰区(需分诊)')
  return `${r.tend}（${zone}，score=${r.score}）`
}

export function modeInfo (key) {
  return PRESETS[String(key || '').trim()] || PRESETS[DEFAULT_MODE]
}

/** 机械兜底判型（保守：拿不准就是 coding）。
 *  只在"前台没有主动声明模式"时使用；词表宁可窄也不要把编码任务误判成检索。 */
export function detectMode (text) {
  const t = String(text || '')
  if (t.trim().length === 0) return DEFAULT_MODE
  // ★ 2026-11-08 审查意图：只查不改 ⇒ review 模式（在一切判型之前）
  //   与 consult 的边界：consult 问"为什么/怎么做"，review 问"哪里错了/有什么隐患"。
  const REVIEW_INTENT = /(审查|代码审查|review|code review|检查代码|看下代码|代码质量|有什么问题|有没有隐患|哪里有问题|安全审计|漏洞|安全隐患|风险点|代码问题|找出问题)/i
  const REVIEW_VERB = /(审|查|找问题|挑毛病|评估代码|看一下这|读一下这|有没有|是否|哪里|隐患|风险|建议)/.test(t)
  const NO_WRITE = !/(改|修|实现|写|新增|重构|优化|迁移|部署|删除)/.test(t)
  if (REVIEW_INTENT.test(t) && NO_WRITE) {
    // 但排除"帮我修"这类带修意图的
    if (!/(帮我修|修一下|改一下|修好|修复)/.test(t)) return 'review'
  }
  if (REVIEW_INTENT.test(t) && REVIEW_VERB && NO_WRITE) return 'review'

  const writeIntent = /(改|修改|修复|实现|写一|写个|创建|新建|删除|删掉|清理|清空|移动|复制|重命名|改名|重命名|重构|部署|安装|配置|提交|构建|跑一下|执行)/.test(t)
  // ★ 2026-10-24：文件/系统操作动词——即使没有代码上下文也必须能执行（要 shell/写权限）
  const fsOpIntent = /(删除|删掉|删了|清理|清空|移动|挪到|复制|拷贝|重命名|改名|新建|创建|解压|压缩|安装|卸载)/.test(t)
  // ★ 2026-10-24 暴力测试修正：明确限定语优先于动作词
  const onlyScoped = /(只给分析|只分析|只解释|只说明|不要创建|不要真的创建|不要修改|不要修改任何文件|只写回复|只写到回复|不要写文件)/.test(t)
    && !/要求一|要求二|第一步|第二步/.test(t)   // 排除编号列举式任务描述（那是任务本体不是限定语）
  const buildIntent = /(文件|代码|目录|仓库|脚本|项目|插件|函数|bug|报错|编译|测试)/.test(t)
  // ★ 2026-11-08 修：「对比」移到 consult。
  //   实测：「这两个方案哪个好，优缺点对比」原来命中 researchIntent 的「对比」⇒ 判 retrieval，
  //   但那是"比较优劣"（咨询），不是"检索资料"。retrieval 在 consult 之前返回，轮不到 consult。
  const researchIntent = /(搜索|检索|查一下|查查|搜一下|搜集|收集|调研|资料|全网|网上|最新|行情|新闻|论文|官网)/.test(t)
  const consultIntent = /(分析|评估|为什么|为何|是否|值不值|可行性|建议|怎么看|优缺点|对比|方案对比|解释|原理|哪一个好)/.test(t)
  // 0) ★★ 2026-11-07 判型优化（最高优先级）：先判断「这个任务值不值得走编排」。
  //
  // 数据依据（每档 5 轮实测）：
  //   L1 −43%、L2 −36%、L3 −44%、L4 −13%   ← 单文件/规格实现，编排纯亏
  //   L5 +57%（工具 18 vs 49）              ← 系统级设计，编排大赚
  //
  // ⚠️ 必须放在 fsOpIntent 分支**之前**：
  //   实测 L3 因为含"新建 test.js"命中 fsOpIntent，被第 177 行直接判成 coding，
  //   绕过了编排判据 ⇒ 白亏 44%。而 fsOpIntent 的本意是"确保有执行能力"，
  //   这件事现在由工具面统一保证（quick 也有 write/edit/bash），不需要靠模式来保证。
  const orchestration = shouldOrchestrate(t)
  if (writeIntent || fsOpIntent) {
    // 明确的写/文件操作意图 ⇒ 一定不是纯问答，交给编排判据决定走 coding 还是 quick
    if (!onlyScoped) return orchestration.orchestrate ? 'coding' : 'quick'
  }
  // 0b) 文件/系统操作但无写意图（极少见）⇒ 保守走 coding
  if (fsOpIntent && !onlyScoped) return 'coding'
  // 1) 明确执行/构建/部署 ⇒ coding（即使带着"分析"字样）
  const execIntent = /(跑一下|执行|部署|安装|构建|编译|跑个|运行)/.test(t)
  // 1a) 明确"只分析/只解释" ⇒ 咨询，不进 coding
  const onlyConsult = /(只给分析|只分析|只解释|只说明|不要创建|不要真的创建|不要修改|不要修改任何文件|只写回复|只写到回复|不要写文件)/.test(t)
  const retrievalVerb0 = (x) => /(在 .+ 下找|找出|列出|读 |总结|查看|浏览)/.test(x)
  if (onlyConsult) return (researchIntent || retrievalVerb0(t)) ? 'retrieval' : 'consult'
  // 2) 纯检索意图且无写意图 ⇒ retrieval
  if (researchIntent && !writeIntent) return 'retrieval'
  // 2a) 读/找/列出文件类（带具体路径）且无写/执行意图 ⇒ retrieval（暴力测试 #8/#9/#10）
  const hasPath = /[A-Za-z]:[\\\/]/.test(t)
  const retrievalVerb2 = /(在 .+ 下找|找出|列出|总结内容|查看|浏览|^读 )/.test(t)
  if (retrievalVerb2 && hasPath && !writeIntent && !fsOpIntent) return 'retrieval'
  // 3) 分析/判断类 ⇒ consult（含"解释/说明/什么是"等纯问答——即使提到了技术名词）
  if (consultIntent || /(什么|如何|怎么|为什么|解释|说明|介绍一下|对比)/.test(t)) return 'consult'
  // 4) 很短且无任何写/检索意图 ⇒ quick
  if (t.trim().length <= 40 && !writeIntent && !researchIntent) return 'quick'
  return DEFAULT_MODE
}

/**
 * ★ 架构修正（2026-10-24）：工具能力与任务模式解耦。
 * 理由：模式判型是关键词匹配（机械、会误判），不该因为判错就让 Agent "没有工具可用"。
 * 真正需要限制的只有安全边界（运维/越权/跨会话），与"是不是编码任务"无关。
 */
/**
 * ★ 2026-11-07 递归修正（方案 D）：工具面按**角色**拆分，且**只给该角色真正要用的 fr_* 工具**。
 *
 * 事故根因：此前 allowListFor(key, role) 忽略了 role，前/后台拿到同一份 WORK_TOOLS，
 * 于是：
 *   - 后台拿到 fr_escalate / fr_mode / fr_worker / fr_status —— 而这些是**驱动前台/唤醒后台**的入口。
 *     后台调 fr_escalate ⇒ 再写 handoff + 再 wakeBack ⇒ 后台自己唤醒自己 ⇒ **无限递归**。
 *   - 前台拿到 fr_route（guard 拦掉，白占一个工具位）。
 *   - 谁也没拿到 fr_route，但 BACK_BRIEF 要求后台必须调它 ⇒ 后台无产出通道。
 *   - 缺 bash（方案 C 已启用 bash 却不在白名单）。
 *
 * 现在的边界（"谁能驱动谁"）：
 *   前台：fr_escalate（上交，唯一合法驱动后台的入口）+ fr_status/fr_mode（自检/换模式）
 *         + 正式工作集。**没有 fr_route**（那是后台产出动作）。
 *   后台：fr_route（唯一产出动作）。**没有 fr_escalate / fr_mode / fr_status / fr_worker**
 *         —— 后台不许再唤起任何会话，否则成环。
 *   fr_poke 两边都不给（运维通道，只能由主控/用户通过工具或 HTTP 调用）。
 *   fr_worker 只给前台（后台不派生 worker；worker 会话本身不是前后台，见 isFront/isBack）。
 */
export const WORK_TOOLS_FRONT = [
  'read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'bash', 'read_image', 'web_fetch', 'web_search',
  'present', 'todo_write', 'working_directory',
  'fr_status', 'fr_mode', 'fr_worker', 'fr_escalate',
]
export const WORK_TOOLS_BACK = [
  'read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'bash', 'read_image', 'web_fetch', 'web_search',
  'present', 'todo_write', 'working_directory',
  'fr_route',
]

/** 兼容旧引用：并集（仅用于回归守卫/自检，**不要**再拿去挂 restrict） */
export const WORK_TOOLS = [...new Set([...WORK_TOOLS_FRONT, ...WORK_TOOLS_BACK])]

/** 硬禁工具（按安全边界，不按模式） */
export const DENY_PATTERNS = [
  /^dev_/, /^team_task_/, /^spawn_teammate$/, /^subagent/, /^send_message$/, /^list_agents$/, /^wait_agent$/, /^interrupt_agent$/,
  /^schedule_/, /^job_/, /^create_goal$/, /^update_goal$/, /^get_goal$/, /^hindsight_/, /^workflow$/, /^skill$/,
  /^ask_user_question$/, /^exit_plan_mode$/,
]
/**
 * 编排会话用不到的「外围插件工具」（2026-11-07）。
 * 这些不是安全问题，而是**噪音**：会进工具表、进上下文、还可能被模型误调。
 * 默认全部禁用；想放开某个，把对应正则从 cfg.frDenyExtra 里去掉即可。
 */
// ★ 2026-11-07（方案 C）：改为**空表**。
//   原设计用黑名单在插件内裁剪工具，但会误伤（例如 ops_bash 被禁后前台完全没有执行能力）。
//   现在改为「在 profile 层禁用不需要的插件」——插件本身不再猜该给哪些工具。
export const FR_NOISE_PATTERNS = []
/** 是否属于硬禁 */
export function isDeniedTool (name, extra) {
  const n = String(name || '')
  // ★ 与 M13（2026-10-17）原始设计对齐：只按**安全边界**拒绝，不按任务模式削减能力
  if (DENY_PATTERNS.some((re) => re.test(n))) return true
  // 外围插件噪音（可通过 cfg.frDenyExtra 覆盖）
  const list = Array.isArray(extra) ? extra : FR_NOISE_PATTERNS
  return list.some((re) => (re instanceof RegExp ? re : new RegExp(String(re))).test(n))
}
/** 工具白名单（已去重；与真实全局工具求交在调用方做） */
export function allowListFor (key, role) {
  // ★ 2026-11-07：按角色返回，不再忽略 role。
  //   后台若是拿到 fr_escalate ⇒ 能自己写 handoff 再唤醒自己 ⇒ 无限递归（真事故路径）。
  return role === 'back' ? WORK_TOOLS_BACK : WORK_TOOLS_FRONT
}

/** 注入给某个角色的模式说明（短，进 inbox 不唤醒） */
export function modeNotice (key, opts) {
  const p = modeInfo(key)
  const lines = [`【模式】${p.label}（${p.key}）— ${p.summary}`]
  if (!p.backend) lines.push('本模式**不需要后台**：不用 fr_escalate 等路线，自己完成并交付。')
  else if (!p.writeSteps) lines.push('本模式后台**只输出分析**（写 .board/analysis.md 并回一句话），**不写步骤**；前台不要等步骤。')
  else lines.push('本模式后台负责写路线与步骤，前台按步骤执行。')
  if (p.fanout && (!opts || opts.fanout !== false)) {
    lines.push(`本模式走**扇形检索**：把大范围搜索拆成 ${p.fanout} 个互不依赖的子查询，**在同一个回复里并行**调用 fr_worker（每个子查询一次），` +
      '然后读它们写出的 .board/workers/<id>.md，汇总后作答。**不要自己串行查 10 遍**。')
  }
  if (p.reviewDiff) lines.push('本模式后台会**只读复核你改过的文件**（不改代码）；收到【审阅】消息时按它指出的问题修正即可。')
  if (p.firstAck) lines.push('收到任务后**第一句先回一句状态**（≤40 字，说明你打算怎么做），再开始干活。')
  lines.push('若执行中发现此模式不适合当前任务（如 quick 模式下发现要干多步的活 ⇒ 要 coding），**调用一次 fr_mode 切换**，不必请示用户。')
  return lines.join('\n')
}

/** 步长自适应（纯函数，可单测）：
 *  依据「最近几步的投递间隔（近似每步耗时）」与失败情况，给出下一轮建议批量。
 *  规则刻意保守并带滞回：只有连续偏快才加、偏慢才减，避免在阈值附近来回震荡。
 *  - gaps: 每步耗时（毫秒）数组，越新越靠后；只看最近 3 个
 *  - failStreak: 连续同名失败次数
 *  - t3Delta: 上次观测以来的 T3 拦截增量
 *  返回 { batch, reason }
 */
export function adaptBatch (current, gaps, failStreak, t3Delta) {
  const base = Math.max(1, Math.min(8, Number(current) || 2))
  const recent = (Array.isArray(gaps) ? gaps : []).filter(g => Number.isFinite(g) && g > 0).slice(-3)
  if ((Number(failStreak) || 0) >= 2 || (Number(t3Delta) || 0) > 0) {
    return { batch: 1, reason: 'fail-or-t3' }   // 出过错：步子放到最小，稳一点
  }
  if (recent.length < 3) return { batch: base, reason: 'insufficient-data' }
  const avg = recent.reduce((s, g) => s + g, 0) / recent.length
  const fast = recent.every(g => g < 25000) && avg < 22000
  const slow = recent.every(g => g > 90000) && avg > 95000
  if (fast) return { batch: Math.min(5, base + 1), reason: 'fast:' + Math.round(avg) }
  if (slow) return { batch: Math.max(1, base - 1), reason: 'slow:' + Math.round(avg) }
  return { batch: base, reason: 'steady:' + Math.round(avg) }
}

/** 从步骤正文里抠出可能需要预读的文件路径（只做提示，不实际读） */
export function extractPaths (text, limit = 6) {
  const out = []
  try {
    const t = String(text || '')
    const re = /(?:[A-Za-z]:[\\/][^\s'"`，。；）)]{2,180}|(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.(?:md|js|mjs|ts|json|yaml|yml|py|ps1|sh|html|txt))/g
    for (const m of t.matchAll(re)) {
      const p = String(m[0]).trim()
      if (!p || p.length > 200) continue
      if (!out.includes(p)) out.push(p)
      if (out.length >= limit) break
    }
  } catch { /* 忽略 */ }
  return out
}

/** 简报里追加的模式片段（brief 时注入一次） */export function briefFragment (key, role) {
  const p = modeInfo(key)
  const parts = [`\n\n## 当前模式：${p.label}（${p.key}）`, `- ${p.summary}`]
  // ══ coding 模式：强制上交（2026-11-08）══════════════════════════════
  //   实测事故：判型明确判成 coding（L5 score=11），但前台看了简报觉得"我自己能做"
  //   就直接做了（escalate=0、route=0，整轮双会话架构空转）。
  //   判型和实际行为脱节 ⇒ 这里必须**覆盖**通用简报里的"默认自己干完"。
  if (key === 'coding' && role === 'front') {
    parts.push(
      '- ★ **本模式必须上交**：收到任务的**第一个动作**就是调用 fr_escalate，然后停手等 steps。',
      '- **禁止**"我自己能做就直接做"——这是本模式的硬规则，不是建议。',
      '- 上交后只做无损前置工作（只读侦察 / 建空目录 / 跑基线），最多 3 个动作，然后停。',
      '- 拿到 steps 后严格按 S1、S2… 顺序执行，每完成一步读下一步。',
      '- 只有**明确信号**才可自行改做：步数≤2 且无依赖，且后台已判 short（verdict.md 出现 short）。',
      '',
      '**⚠️ 覆盖上式**：简报前文的「分诊（默认自己干完）」和「轻任务必须自己做」**在本模式下不适用**。',
      '那两段是为 quick/consult 写的；本模式是 coding，规则以上面这条「必须上交」为准。'
    )
  }

  // ══ 审查模式专用指令（2026-11-08 新增）══════════════════════════════
  //   与 consult 的边界：consult 回答"为什么/怎么做"，review 检查"哪里错了/有什么隐患"。
  //   与 coding 的边界：coding 改代码，review **只读不写**。
  if (key === 'review') {
    if (role === 'front') {
      parts.push(
        '- **只读不改**：不要用 write/edit 修改任何业务文件。发现的问题写进报告，不要直接修。',
        '- **必须给证据**：每条问题都要带「文件:行号 + 代码片段 + 为什么是问题」。',
        '- **分级**：用 [严重]/[中等]/[轻微] 标注，严重的排在最前面。',
        '- **不臆测**：拿不准的标「待确认」，不要编造行为。',
        '- 产出写到 .board/review.md，然后在回复正文里给出结论摘要（用户只看得到回复正文）。'
      )
    } else {
      parts.push(
        '- **规划审什么**：列出要审的文件与审查维度（正确性/边界/并发/错误处理/可维护性/性能）。',
        '- **不要改代码**：只写审查要点与判据，不改业务文件。',
        '- 复核前台结论：前台说"没问题"时，核对它是否真的看过对应代码。'
      )
    }
    return parts.join('\n')
  }
  // #2/#3（2026-10-24）：文件同步与 worker 并行的使用提示
  if (role === 'front') {
    const frontHints = []
    if (p.research) frontHints.push('- 需要大范围检索时，可一次派 2 个 fr_worker 并行查（各自落盘 .board/workers/），再自己汇总。')
    if (p.backend) frontHints.push('- 上交后台时，把相关文件/图片的**绝对路径**写进 handoff 的「已知事实」，后台可直接 read。')
    if (frontHints.length) parts.push(...frontHints)
  }
  if (role === 'back') {
    if (!p.backend) parts.push('- 本模式不需要后台参与，通常不会被唤醒。')
    else if (!p.writeSteps) parts.push('- **只输出分析**：把结论写进 `.board/analysis.md`，然后一句话回复；**不要写 route.md / steps/**。')
    else parts.push('- 写 route.md + steps/，并在里程碑处复核。')
    parts.push(p.research ? '- 允许用 web 工具查资料（结论要带来源）。' : '- 本模式尽量不联网。')
  } else {
    parts.push(p.firstAck ? '- 收到任务先回一句状态（≤40 字），再动手。' : '- 直接动手，不要开场白。')
    if (!p.backend) parts.push('- 本模式**不转交后台**，自己做完并交付。')
  }
  return parts.join('\n')
}
