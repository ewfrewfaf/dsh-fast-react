import fs from 'node:fs'
const s = fs.readFileSync('C:/Users/admin/.dsh/plugins/dsh-fast-react/lib/index.js', 'utf8')
const c = {
  'userStopAt 声明': s.includes('let userStopAt'),
  'stopAll 记录': /stopAll \(\) \{[\s\S]{0,120}userStopAt = Date\.now\(\)/.test(s),
  'fireInterrupt 记录': /function fireInterrupt[\s\S]{0,160}userStopAt = Date\.now\(\)/.test(s),
  'turn-stopping 尊重用户': s.includes("event('inline-skip', { why: 'user-stop' })"),
  'turn-stopping 需 running': s.includes("if (phaseNow !== 'running') return"),
  'wakeBack 尊重': s.includes('跳过：用户刚停止'),
  'steerFront 尊重': s.includes('跳过：用户刚停止'),
  '禁止派生子智能体（简报）': s.includes('禁止派生任何子智能体'),
  '工具层拦 subagent': s.includes('block-subagent'),
  'wire 身份校验': s.includes('isFrSession'),
  '脏接线丢弃': s.includes('wire-dirty-drop'),
  'pendingDeliver tick 兜底': s.includes('if (pendingDeliver || deliverRetry > 0)'),
  'event-driven prefetch': s.includes("trigger: 'step-delivered'"),
  '无任务不跑哨兵': s.includes('hasActiveTask'),
  'H5 需伴随失败': s.includes('stepsThisTask > cfg.taskStepMax && toolStats.failStreak'),
  '同名工具失败才累加': s.includes('lastFailName'),
  '尊重用户走编排': s.includes('verdict-short-overruled'),
  '冻结只调一次': (s.match(/freezeFront\(hits\.map/g) || []).length === 1,
  '终局正文兜底': s.includes('final-answer-ask'),
  '新路线重置 done': s.includes('state-reset'),
  'effort 显式传': s.includes('reasoningEffort: effortFor(tag)'),
  'wire() 统一入口': s.includes('const wire = (frontId, backId)'),
}
let pass = 0
for (const [k, v] of Object.entries(c)) { if (v) pass++; console.log(v ? '✅' : '❌', k) }
console.log(`\n${pass}/${Object.keys(c).length} 通过`)
console.log(pass === Object.keys(c).length ? 'PASS' : 'FAIL')
