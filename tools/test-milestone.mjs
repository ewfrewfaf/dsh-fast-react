// 里程碑复核判定回归（2026-11-15）：全局开关覆盖模式 reviewEvery + 安全上限
import { milestoneReviewDue } from '../lib/scheduler.js'
let pass = 0, fail = 0
const t = (name, cond) => { if (cond) { pass++ } else { fail++; console.log('FAIL ' + name) } }
const NOW = 1_000_000_000_000
const base = { frontIdle: true, backIdle: true, now: NOW, lastReviewAt: 0, reviewCount: 0, doneNow: 10, lastReviewStepNo: 0 }

const modeOn = milestoneReviewDue({ ...base, cfg: {}, mode: { backend: true, reviewEvery: 5 } })
t('模式 reviewEvery 原行为', modeOn.due === true && modeOn.globalOn === false && modeOn.every === 5)

const modeOff = milestoneReviewDue({ ...base, cfg: {}, mode: { backend: true, reviewEvery: 0 } })
t('无 reviewEvery 不复核', modeOff.due === false)

const glob = milestoneReviewDue({ ...base, cfg: { milestoneCheck: true, milestoneEvery: 3 }, mode: { backend: true, reviewEvery: 0 }, lastReviewStepNo: 7 })
t('全局开关覆盖模式', glob.due === true && glob.globalOn === true && glob.every === 3)

const globNoBackend = milestoneReviewDue({ ...base, cfg: { milestoneCheck: true }, mode: { backend: false, reviewEvery: 0 } })
t('无后台模式不复核', globNoBackend.due === false)

const busy = milestoneReviewDue({ ...base, cfg: { milestoneCheck: true }, mode: { backend: true }, frontIdle: false })
t('前台忙不复核', busy.due === false)

const throttle = milestoneReviewDue({ ...base, cfg: { milestoneCheck: true }, mode: { backend: true }, lastReviewAt: NOW - 60_000 })
t('10 分钟节流', throttle.due === false)

const cap = milestoneReviewDue({ ...base, cfg: { milestoneCheck: true }, mode: { backend: true }, reviewCount: 3 })
t('每任务 ≤3 次', cap.due === false)

const gap = milestoneReviewDue({ ...base, cfg: { milestoneCheck: true, milestoneEvery: 5 }, mode: { backend: true }, lastReviewStepNo: 8 })
t('新完成不足间隔不复核', gap.due === false)

const zero = milestoneReviewDue({ ...base, cfg: { milestoneCheck: true }, mode: { backend: true }, doneNow: 0 })
t('done=0 不复核', zero.due === false)

const fallback = milestoneReviewDue({ ...base, cfg: { milestoneCheck: true, milestoneEvery: 0 }, mode: { backend: true } })
t('间隔非法回落 5', fallback.every === 5 && fallback.due === true)

console.log(`milestone: ${pass}/${pass + fail} pass`)
process.exit(fail ? 1 : 0)
