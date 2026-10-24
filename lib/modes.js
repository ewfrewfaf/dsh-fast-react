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
    summary: '不编排：前台直接答，最多查一眼',
    dims: { shape: 'consult', depth: 'low', parallel: 'solo', autonomy: 'loose', deliver: 'answer' },
    backend: false,
    writeSteps: false,
    firstAck: true,
    batchSteps: 0,
    reviewEvery: 0,
    prefetch: false,
    research: true,
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
  },
}

export const DEFAULT_MODE = 'coding'
export const MODE_KEYS = Object.keys(PRESETS)

/** 预设信息；未知 key 一律回落到默认（安全值） */
export function modeInfo (key) {
  return PRESETS[String(key || '').trim()] || PRESETS[DEFAULT_MODE]
}

/** 机械兜底判型（保守：拿不准就是 coding）。
 *  只在"前台没有主动声明模式"时使用；词表宁可窄也不要把编码任务误判成检索。 */
export function detectMode (text) {
  const t = String(text || '')
  if (t.trim().length === 0) return DEFAULT_MODE
  const writeIntent = /(改|修改|修复|实现|写一|写个|创建|新建|删除|删掉|清理|清空|移动|复制|重命名|改名|重命名|重构|部署|安装|配置|提交|构建|跑一下|执行)/.test(t)
  // ★ 2026-10-24：文件/系统操作动词——即使没有代码上下文也必须能执行（要 shell/写权限）
  const fsOpIntent = /(删除|删掉|删了|清理|清空|移动|挪到|复制|拷贝|重命名|改名|新建|创建|解压|压缩|安装|卸载)/.test(t)
  // ★ 2026-10-24 暴力测试修正：明确限定语优先于动作词
  const onlyScoped = /(只给分析|只分析|只解释|只说明|不要创建|不要真的创建|不要修改|不要修改任何文件|只写回复|只写到回复|不要写文件)/.test(t)
    && !/要求一|要求二|第一步|第二步/.test(t)   // 排除编号列举式任务描述（那是任务本体不是限定语）
  const buildIntent = /(文件|代码|目录|仓库|脚本|项目|插件|函数|bug|报错|编译|测试)/.test(t)
  const researchIntent = /(搜索|检索|查一下|查查|搜一下|搜集|收集|调研|对比|资料|全网|网上|最新|行情|新闻|论文|官网)/.test(t)
  const consultIntent = /(分析|评估|为什么|为何|是否|值不值|可行性|建议|怎么看|优缺点|方案对比|解释|原理|哪一个好)/.test(t)
  // 0) 文件/系统操作 ⇒ 必须有执行能力（不能落到 quick）
  if (fsOpIntent && !onlyScoped) return 'coding'
  // 1) 明确执行/构建/部署 ⇒ coding（即使带着"分析"字样）
  const execIntent = /(跑一下|执行|部署|安装|构建|编译|跑个|运行)/.test(t)
  // 1a) 明确"只分析/只解释" ⇒ 咨询，不进 coding
  const onlyConsult = /(只给分析|只分析|只解释|只说明|不要创建|不要真的创建|不要修改|不要修改任何文件|只写回复|只写到回复|不要写文件)/.test(t)
  const retrievalVerb0 = (x) => /(在 .+ 下找|找出|列出|读 |总结|查看|浏览)/.test(x)
  if (onlyConsult) return (researchIntent || retrievalVerb0(t)) ? 'retrieval' : 'consult'
  // 1b) 写意图 + 代码上下文 + 非纯咨询 ⇒ coding
  if (writeIntent && buildIntent && !onlyScoped) return 'coding'
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
export const WORK_TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'read_image', 'web_fetch', 'web_search', 'present', 'todo_write', 'fr_status', 'fr_escalate', 'fr_mode', 'fr_worker']

/** 硬禁工具（按安全边界，不按模式） */
export const DENY_PATTERNS = [
  /^dev_/, /^team_task_/, /^spawn_teammate$/, /^subagent/, /^send_message$/, /^list_agents$/, /^wait_agent$/, /^interrupt_agent$/,
  /^schedule_/, /^job_/, /^create_goal$/, /^update_goal$/, /^get_goal$/, /^hindsight_/, /^workflow$/, /^skill$/,
  /^ask_user_question$/, /^exit_plan_mode$/,
]
/** 是否属于硬禁 */
export function isDeniedTool (name) {
  // ★ 与 M13（2026-10-17）原始设计对齐：只按**安全边界**拒绝，不按任务模式削减能力
  return DENY_PATTERNS.some((re) => re.test(String(name || '')))
}
/** 工具白名单（已去重；与真实全局工具求交在调用方做） */
export function allowListFor (key, role) {
  // ★ 工具能力与模式解耦（对齐 M13）：前/后台一律给完整工作集，
  //   安全边界由 isDeniedTool（guard 里调用）负责，与任务模式无关。
  //   模式只决定"要不要后台参与"（preset.backend），不再决定"给不给工具"。
  return WORK_TOOLS
}

/** 注入给某个角色的模式说明（短，进 inbox 不唤醒） */
export function modeNotice (key) {
  const p = modeInfo(key)
  const lines = [`【模式】${p.label}（${p.key}）— ${p.summary}`]
  if (!p.backend) lines.push('本模式**不需要后台**：不用 fr_escalate 等路线，自己完成并交付。')
  else if (!p.writeSteps) lines.push('本模式后台**只输出分析**（写 .board/analysis.md 并回一句话），**不写步骤**；前台不要等步骤。')
  else lines.push('本模式后台负责写路线与步骤，前台按步骤执行。')
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
