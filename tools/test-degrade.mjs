// 断粮降精度（#38）ground-truth 逻辑测试：mock S/B/deps，验证只在该触发时触发
import assert from 'node:assert'
import { makeScheduler } from '../lib/scheduler.js'

let pass = 0, fail = 0
function t (name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name) }
  catch (e) { fail++; console.log('  ❌ ' + name + ': ' + e.message) }
}

function mk (over = {}) {
  const events = [], wakes = []
  const S = {
    cfg: { planningDegrade: true, degradeAfterMs: 20000, ...(over.cfg || {}) },
    modeNow: () => ({ writeSteps: over.writeSteps !== false }),
    front: { phase: { kind: over.front || 'idle' } },
    back: { phase: { kind: over.back || 'running' } },
    starvedSince: over.starvedSince || 0,
    degraded: !!over.degraded,
  }
  const B = { steps: () => (over.pending ? [{ done: false }] : []) }
  const sched = makeScheduler({
    S, B, log: () => {}, event: (n, d) => events.push([n, d]),
    steerFront: () => {}, wakeBack: (r, txt) => wakes.push([r, txt]), lastAssistantText: () => '',
  })
  return { S, sched, events, wakes }
}
const STARVED = Date.now() - 25000

t('断粮超阈值 ⇒ 触发一次降精度唤醒', () => {
  const { S, sched, events, wakes } = mk({ starvedSince: STARVED })
  sched.checkPlanningStarvation()
  assert.strictEqual(S.degraded, true)
  assert.strictEqual(wakes.length, 1)
  assert.strictEqual(wakes[0][0], 'degrade')
  assert.ok(events.some(e => e[0] === 'planning-degraded'))
})
t('持续断粮不重复唤醒', () => {
  const { sched, wakes } = mk({ starvedSince: STARVED })
  sched.checkPlanningStarvation()
  sched.checkPlanningStarvation()
  assert.strictEqual(wakes.length, 1)
})
t('前台恢复供料 ⇒ 恢复精度', () => {
  const { S, sched, events } = mk({ starvedSince: STARVED, degraded: true, pending: true })
  sched.checkPlanningStarvation()
  assert.strictEqual(S.degraded, false)
  assert.strictEqual(S.starvedSince, 0)
  assert.ok(events.some(e => e[0] === 'planning-restored'))
})
t('开关关闭 ⇒ 不触发', () => {
  const { S, sched, wakes } = mk({ starvedSince: STARVED, cfg: { planningDegrade: false } })
  sched.checkPlanningStarvation()
  assert.strictEqual(S.degraded, false)
  assert.strictEqual(wakes.length, 0)
})
t('前台在跑 ⇒ 不触发（正常流水线不误伤）', () => {
  const { S, sched, wakes } = mk({ starvedSince: STARVED, front: 'running' })
  sched.checkPlanningStarvation()
  assert.strictEqual(S.degraded, false)
  assert.strictEqual(wakes.length, 0)
})
t('非编排模式 ⇒ 不触发', () => {
  const { S, sched, wakes } = mk({ starvedSince: STARVED, writeSteps: false })
  sched.checkPlanningStarvation()
  assert.strictEqual(S.degraded, false)
  assert.strictEqual(wakes.length, 0)
})
t('未超阈值 ⇒ 不触发', () => {
  const { S, sched, wakes } = mk({ starvedSince: Date.now() - 5000 })
  sched.checkPlanningStarvation()
  assert.strictEqual(S.degraded, false)
  assert.strictEqual(wakes.length, 0)
})
t('reset 清断粮状态', () => {
  const { S, sched } = mk({ starvedSince: STARVED, degraded: true })
  sched.resetTaskScheduler()
  assert.strictEqual(S.starvedSince, 0)
  assert.strictEqual(S.degraded, false)
})

console.log(`\n=== 断粮降精度逻辑：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
