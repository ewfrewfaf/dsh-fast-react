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
 * frontTools/backTools 工具白名单（会自动与"真实存在的全局工具"求交集）
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
    frontTools: ['read', 'glob', 'grep', 'web_fetch', 'web_search', 'fr_status', 'fr_escalate'],
    backTools: [],
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
    frontTools: ['read', 'glob', 'grep', 'read_image', 'web_fetch', 'web_search', 'present', 'fr_status', 'fr_escalate'],
    backTools: ['read', 'glob', 'grep', 'read_image', 'web_fetch', 'web_search', 'write', 'edit', 'fr_status'],
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
    frontTools: ['read', 'glob', 'grep', 'web_fetch', 'web_search', 'write', 'present', 'fr_status', 'fr_escalate'],
    backTools: [],
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
    frontTools: ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'read_image', 'web_fetch', 'web_search', 'present', 'todo_write', 'fr_status', 'fr_escalate'],
    backTools: ['read', 'glob', 'grep', 'read_image', 'web_fetch', 'web_search', 'write', 'edit', 'fr_route', 'fr_status'],
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
  const writeIntent = /(改|修改|修复|实现|写一|写个|创建|新建|删除|重构|部署|安装|配置|提交|构建|跑一下|执行)/.test(t)
  const buildIntent = /(文件|代码|目录|仓库|脚本|项目|插件|函数|bug|报错|编译|测试)/.test(t)
  const researchIntent = /(搜索|检索|查一下|查查|搜一下|搜集|收集|调研|对比|资料|全网|网上|最新|行情|新闻|论文|官网)/.test(t)
  const consultIntent = /(分析|评估|为什么|为何|是否|值不值|可行性|建议|怎么看|优缺点|方案对比|解释|原理|哪一个好)/.test(t)
  // 1) 有明确写意图 + 代码上下文 ⇒ coding
  if (writeIntent && buildIntent) return 'coding'
  // 2) 纯检索意图且无写意图 ⇒ retrieval
  if (researchIntent && !writeIntent) return 'retrieval'
  // 3) 分析/判断类 ⇒ consult
  if (consultIntent && !writeIntent) return 'consult'
  // 4) 很短且无任何写/检索意图 ⇒ quick
  if (t.trim().length <= 40 && !writeIntent && !researchIntent) return 'quick'
  return DEFAULT_MODE
}

/** 工具白名单（已去重；与真实全局工具求交在调用方做） */
export function allowListFor (key, role) {
  const preset = modeInfo(key)
  const list = role === 'back' ? preset.backTools : preset.frontTools
  return Array.isArray(list) ? [...new Set(list)] : []
}

/** 注入给某个角色的模式说明（短，进 inbox 不唤醒） */
export function modeNotice (key) {
  const p = modeInfo(key)
  const lines = [`【模式】${p.label}（${p.key}）— ${p.summary}`]
  if (!p.backend) lines.push('本模式**不需要后台**：不用 fr_escalate 等路线，自己完成并交付。')
  else if (!p.writeSteps) lines.push('本模式后台**只输出分析**（写 .board/analysis.md 并回一句话），**不写步骤**；前台不要等步骤。')
  else lines.push('本模式后台负责写路线与步骤，前台按步骤执行。')
  if (p.firstAck) lines.push('收到任务后**第一句先回一句状态**（≤40 字，说明你打算怎么做），再开始干活。')
  return lines.join('\n')
}

/** 简报里追加的模式片段（brief 时注入一次） */
export function briefFragment (key, role) {
  const p = modeInfo(key)
  const parts = [`\n\n## 当前模式：${p.label}（${p.key}）`, `- ${p.summary}`]
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
