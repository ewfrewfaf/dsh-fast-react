/**
 * delivery.js —— 与 Agent 交互的唯一出口（S3）
 *
 * 三个函数：
 *   brief(agent, role)            注入角色简报（inject，不唤醒）
 *   wakeBack(reason, text)        唤醒/排队给后台（steer → followup 回退）
 *   steerFront(text, reason, opts) 投递给前台（空闲 followup / 运行中 steer）
 *
 * 约定：所有运行时状态通过 S（lib/state.js 门面）读写，行为与原来完全一致。
 * 换驱动方式（例如统一改用 kick/wakeDriver）时只改本文件。
 */
import { FRONT_BRIEF, BACK_BRIEF } from './briefs.js'
import { msg } from './messages.js'
import { CRITICAL_REASONS } from './policies.js'

export function makeDelivery (deps) {
  const { S, log, event, idOf, briefFragment, currentMode, modeNow, setEffort } = deps

  function brief (agent, role) {
    // ★ Phase 1：简报里带上当前模式片段（模式在中途变化时由 applyMode 的 inject 补发）
    const text = (role === 'front' ? FRONT_BRIEF : BACK_BRIEF).replace('{{BOARD}}', S.boardDir)
      + (typeof briefFragment === 'function' ? briefFragment(currentMode(), role) : '')
    try {
      // ★ 用 inject（**不唤醒**）：简报只进 inbox，等该 agent 下一次真正运行时自然读到。
      agent.inject(msg(text, `快速反应角色简报：${role}`))
      event('brief', { role, id: idOf(agent), mode: 'inject' })
      log(`角色简报已注入（不唤醒）→ ${role} ${idOf(agent).slice(0, 14)}`)
    } catch (e) { log('brief fail ' + role + ': ' + e.message) }
  }

  /** 唤醒后台：关键原因不受冷却限制；运行中 steer、空闲 followup，失败回退 */
  function wakeBack (reason, text) {
    const now = Date.now()
    const back = S.back
    if (!back) { log(`wake(${reason}) 跳过：后台未接线`); return false }
    // 模式守卫：速答/检索模式不需要后台 ⇒ 任何自动唤醒都跳过（手动除外）
    try {
      const mi = modeNow()
      if (!mi.backend && reason !== 'manual') {
        log(`wake(${reason}) 跳过：模式 ${mi.key} 不需要后台`)
        event('wake-skip-mode', { reason, mode: mi.key })
        return false
      }
    } catch { /* 模式层异常不影响唤醒 */ }
    // 用户停止/暂停后 15s 内不唤醒（否则表现为"暂停按不住"）
    if (now - S.userStopAt < 15000) { log(`wake(${reason}) 跳过：用户刚停止`); return false }
    void setEffort('back')   // B10 档位漂移：先把全局档位切到后台该有的值
    if (!CRITICAL_REASONS.has(reason) && now - S.lastWakeAt < S.cfg.wakeCooldownMs) { log(`wake(${reason}) 跳过：冷却中`); return false }
    const bump = () => { S.lastWakeAt = now; S.wakeCount.total++; S.wakeCount.byReason[reason] = (S.wakeCount.byReason[reason] || 0) + 1 }
    if (back.phase && back.phase.kind === 'running') {
      try {
        back.steer(msg(text))
        bump(); event('wake', { reason, mode: 'steer' }); log(`wake(${reason}) → steer（后台在跑）`); return true
      } catch (e) {
        // 后台中间态 steer 会抛 "unreachable variant: {}" ⇒ 必须回退 followup，否则唤醒丢失
        log('wake steer fail: ' + e.message + ' → 回退 followup')
        try {
          back.followup(msg(text))
          bump(); event('wake', { reason, mode: 'followup-fallback' }); return true
        } catch (e2) { log('wake followup-fallback fail: ' + e2.message); return false }
      }
    }
    try {
      back.followup(msg(text))
      bump(); event('wake', { reason, mode: 'followup' }); log(`wake(${reason}) → followup（后台空闲）`); return true
    } catch (e) { log('wake followup fail: ' + e.message); return false }
  }

  /** 投递给前台：空闲必须 followup 起一轮（steer 只入队会悬空） */
  function steerFront (text, reason, opts) {
    const front = S.front
    if (!front) return false
    const forced = !!(opts && opts.force)
    if (Date.now() - S.pauseAt < 15000) { log(`steer 前台(${reason}) 跳过：用户刚暂停`); return false }
    if (!forced && Date.now() - S.userStopAt < 15000) { log(`steer 前台(${reason}) 跳过：用户刚停止`); return false }
    void setEffort('front')
    const running = !!(front.phase && front.phase.kind === 'running')
    try {
      if (running) front.steer(msg(text))
      else front.followup(msg(text))
      event('steer-front', { reason, mode: running ? 'steer' : 'followup' })
      log(`steer 前台(${reason}, ${running ? 'steer' : 'followup'})`)
      return true
    } catch (e) {
      log('steerFront fail: ' + e.message + ' → 回退 followup')
      try {
        front.followup(msg(text))
        event('steer-front', { reason, mode: 'followup-fallback' })
        return true
      } catch (e2) { log('steerFront followup fallback fail: ' + e2.message); return false }
    }
  }

  return { brief, wakeBack, steerFront }
}
