// 覆写决策回归（2026-11-15）：plan 覆写 / append 补步的跳过/清尾/重置规则
import { planOverwriteDecision } from '../lib/route-plan.js'
let pass = 0, fail = 0
const t = (name, cond) => { if (cond) { pass++ } else { fail++; console.log('FAIL ' + name) } }

const mid = planOverwriteDecision({ doneNo: 2, status: 'working', incomingKs: [1, 2, 3, 4], existingKs: [1, 2], isAppend: false })
t('plan 已完成步跳过', mid.skip(1) === true && mid.skip(2) === true)
t('plan 未完成步不跳', mid.skip(3) === false && mid.skip(4) === false)
t('plan 清尾阈值=本批最大', mid.pruneAbove === 4)
t('plan 中途覆写不重置', mid.reset === false)

const over = planOverwriteDecision({ doneNo: 4, status: 'working', incomingKs: [1, 2, 3], existingKs: [1, 2, 3, 4], isAppend: false })
t('done>=max 重置进度', over.reset === true)
t('重置时清尾阈值=3', over.pruneAbove === 3)

const doneStatus = planOverwriteDecision({ doneNo: 0, status: 'done', incomingKs: [1, 2], existingKs: [], isAppend: false })
t('status=done 重置', doneStatus.reset === true)

const app = planOverwriteDecision({ doneNo: 9, status: 'done', incomingKs: [2, 3], existingKs: [1, 2], isAppend: true })
t('append 已存在跳过', app.skip(2) === true)
t('append 新步不跳', app.skip(3) === false)
t('append 不清尾', app.pruneAbove === Infinity)
t('append 不重置', app.reset === false)

const fresh = planOverwriteDecision({ doneNo: 0, status: '', incomingKs: [1, 2], existingKs: [], isAppend: false })
t('新任务不跳不重置', fresh.skip(1) === false && fresh.reset === false)

console.log(`overwrite: ${pass}/${pass + fail} pass`)
process.exit(fail ? 1 : 0)
