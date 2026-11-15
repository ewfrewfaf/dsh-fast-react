// 阶段流水线（两层解耦）ground-truth 测试：modes STRATEGY/守卫 + scheduler 相位批/转移/重置
import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STRATEGY, STRATEGY_KEYS, defaultStrategyForStep, shouldOrchestrate } from '../lib/modes.js'
import { makeScheduler } from '../lib/scheduler.js'

let pass = 0, fail = 0
function t (name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name) }
  catch (e) { fail++; console.log('  ❌ ' + name + ': ' + e.message) }
}

// ── modes ──
t('STRATEGY 四键且纯 L2（不含 backend/writeSteps）', () => {
  assert.deepStrictEqual(STRATEGY_KEYS.sort(), ['build', 'deliver', 'research', 'think'])
  for (const k of STRATEGY_KEYS) {
    assert.ok(!('backend' in STRATEGY[k]), k + ' 不应含 backend')
    assert.ok(!('writeSteps' in STRATEGY[k]), k + ' 不应含 writeSteps')
  }
})
t('defaultStrategyForStep 按步类型回落', () => {
  assert.strictEqual(defaultStrategyForStep('大规模查资料'), 'research')
  assert.strictEqual(defaultStrategyForStep('设计架构方案'), 'think')
  assert.strictEqual(defaultStrategyForStep('交付总结回答'), 'deliver')
  assert.strictEqual(defaultStrategyForStep('实现该函数'), 'build')
})
t('研究规模守卫：不确信 quick', () => {
  const r = shouldOrchestrate('先大规模查资料再总结')
  assert.notStrictEqual(r.tend, 'quick')
})
t('普通短问句仍 quick', () => {
  const r = shouldOrchestrate('今天星期几')
  assert.strictEqual(r.tend, 'quick')
})

// ── scheduler ──
function mk (over = {}) {
  const calls = { applyStrategy: [], setEffort: [], cleanup: 0, beat: 0, events: [] }
  const S = {
    cfg: { enablePhases: true, batchAdapt: true, pipelinePrefetch: 3, ...(over.cfg || {}) },
    modeNow: () => ({ writeSteps: over.writeSteps !== false, batchSteps: 2 }),
    adaptiveBatch: 0, recentGaps: [], lastDeliverAt: 0, toolStats: { failStreak: 0 }, t3Blocked: 0, lastT3Seen: 0,
    boardDir: mkdtempSync(join(tmpdir(), 'frphase-')),
    phaseStrategy: over.phaseStrategy || null, phaseSince: 0,
    starvedSince: 0, degraded: false,
    lastAnalysisMtime: 0, judgeWaiting: false, reviewCount: 0, lastReviewStepNo: 0, lastReviewAt: 0,
    judgeFile: join(mkdtempSync(join(tmpdir(), 'frj-')), 'judge.ok'),
    workers: new Map(),
  }
  const B = { steps: () => (over.steps || []), stepNo: (x) => Number(String(x).replace(/\D/g, '')) || 0, readIf: () => '', readState: () => ({}), hasDeliver: () => false }
  const sched = makeScheduler({
    S, B, log: () => {}, event: (n, d) => calls.events.push([n, d]),
    steerFront: () => {}, wakeBack: () => true, lastAssistantText: () => '',
    applyStrategy: (k) => calls.applyStrategy.push(k),
    setEffortFor: (r, e) => calls.setEffort.push([r, e]),
    touchBeat: () => calls.beat++,
    cleanupWorkersNow: () => calls.cleanup++,
    nextStrategies: () => (over.next || []),
  })
  return { S, sched, calls }
}

t('parseStepMeta 解析 strategy + 回落', () => {
  const { sched } = mk()
  assert.strictEqual(sched.parseStepMeta('strategy: research\n查资料').strategy, 'research')
  assert.strictEqual(sched.parseStepMeta('strategy: bogus\n实现').strategy, 'build')
  assert.strictEqual(sched.parseStepMeta('设计架构').strategy, 'think')
})
t('相位批上限：批不跨策略', () => {
  const { sched } = mk({ next: ['build', 'build', 'think'] })
  assert.ok(sched.effectiveBatch() <= 2)
})
t('闸 off：相位批不生效', () => {
  const { sched } = mk({ cfg: { enablePhases: false }, next: ['build', 'think'] })
  assert.strictEqual(sched.effectiveBatch(), 2)
})
t('syncPhase：闸 off 返回 null', () => {
  const { sched } = mk({ cfg: { enablePhases: false }, next: ['research'] })
  assert.strictEqual(sched.syncPhaseToNextStep(), null)
})
t('syncPhase：设置策略+effort+delta+心跳+phase.md', () => {
  const { S, sched, calls } = mk({ next: ['research'] })
  assert.strictEqual(sched.syncPhaseToNextStep(), 'research')
  assert.strictEqual(S.phaseStrategy, 'research')
  assert.deepStrictEqual(calls.applyStrategy, ['research'])
  assert.deepStrictEqual(calls.setEffort, [['front', 'low']])
  assert.strictEqual(calls.beat, 1)
  assert.ok(calls.events.some(e => e[0] === 'phase-set'))
})
t('syncPhase：同策略不重复切', () => {
  const { sched, calls } = mk({ next: ['research'], phaseStrategy: 'research' })
  sched.syncPhaseToNextStep()
  assert.strictEqual(calls.applyStrategy.length, 0)
})
t('syncPhase：离 fanout 清 worker', () => {
  const { sched, calls } = mk({ next: ['think'], phaseStrategy: 'research' })
  sched.syncPhaseToNextStep()
  assert.strictEqual(calls.cleanup, 1)
})
t('syncPhase：非 writeSteps 不切', () => {
  const { sched } = mk({ next: ['research'], writeSteps: false })
  assert.strictEqual(sched.syncPhaseToNextStep(), null)
})
t('reset 清相位', () => {
  const { S, sched } = mk({ phaseStrategy: 'build' })
  sched.resetTaskScheduler()
  assert.strictEqual(S.phaseStrategy, null)
  assert.strictEqual(S.phaseSince, 0)
})

console.log(`\n=== 阶段流水线逻辑：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
