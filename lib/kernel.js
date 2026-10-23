/**
 * kernel.js —— 装配层（S6）
 *
 * 把「行为模块」的构造集中到一处：投递、调度、哨兵规则。
 * 黑板（B）与状态门面（S）由 index.js 先建好再传入（S 的活绑定必须留在 index 作用域）。
 * 好处：想替换实现（例如换一套投递策略/调度规则）只改这里或对应模块，不动主循环。
 */
import { makeDelivery } from './delivery.js'
import { makeScheduler } from './scheduler.js'
import { computeAlerts, heartbeatAge } from './sentinels.js'

/**
 * @param {object} deps
 * @param {object} deps.S 状态门面（lib/state.js）
 * @param {object} deps.B 黑板 IO（lib/board.js）
 * @param {Function} deps.log
 * @param {Function} deps.event
 * @param {Function} deps.idOf
 * @param {Function} deps.briefFragment
 * @param {Function} deps.currentMode 必传延迟取值（工厂在常量声明前执行）
 * @param {Function} deps.modeNow
 * @param {Function} deps.setEffort
 * @param {Function} deps.lastAssistantText
 */
export function assembleKernel (deps) {
  const { S, B, log, event, idOf, briefFragment, currentMode, modeNow, setEffort, lastAssistantText } = deps

  const delivery = makeDelivery({ S, log, event, idOf, briefFragment, currentMode, modeNow, setEffort })
  const scheduler = makeScheduler({ S, B, log, event, steerFront: delivery.steerFront, wakeBack: delivery.wakeBack, lastAssistantText })
  const sentinels = {
    computeAlerts: (cfg, now) => computeAlerts({ S, B, cfg, now }),
    heartbeatAge: () => heartbeatAge(B),
  }

  return { delivery, scheduler, sentinels }
}
