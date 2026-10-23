/**
 * sentinels.js —— 机械哨兵规则（S5）
 *
 * 本模块只做**判定**（纯函数），不执行动作：
 * 命中后由主循环负责 event / wakeBack / freezeFront，这样改规则不用动主循环。
 */
export function heartbeatAge (B) {
  try {
    const t = B.readIf(B.P.heartbeat)
    const lines = t.trim().split('\n').filter(Boolean)
    if (!lines.length) return null
    const last = lines[lines.length - 1]
    const ts = last.slice(0, last.indexOf('|')).trim()
    const at = Date.parse(ts)
    return Number.isFinite(at) ? Date.now() - at : null
  } catch { return null }
}

/** 计算本轮「新命中」的哨兵（已去重，同一 id 只报一次） */
export function computeAlerts ({ S, B, cfg, now = Date.now() }) {
  if (cfg.sentinelEnabled === false) return []
  const frontRunning = !!(S.front && S.front.phase && S.front.phase.kind === 'running')
  const st0 = B.readState()
  const steps0 = B.listSteps()
  const done0 = B.stepNo(st0.done || '')
  const maxNo = steps0.length ? Math.max(...steps0.map(B.stepNo)) : 0
  const hasActiveTask = steps0.length > 0 && done0 < maxNo
  const busy = frontRunning || !!(S.back && S.back.phase && S.back.phase.kind === 'running')
  // 空闲对话场景：清空历史告警标记，不产生任何 alert（否则一句「你好」也会被冻结）
  if (!hasActiveTask && !busy) { S.alertedSentinels.clear(); return [] }

  const alerts = []
  // H3 心跳停滞：前台在跑但超过阈值没有新 heartbeat
  const staleMs = now - S.lastBeatAt
  if (frontRunning && staleMs > (cfg.heartbeatStaleMs || 300000)) {
    alerts.push({ id: 'H3', why: `心跳停滞 ${Math.round(staleMs / 1000)}s` })
  }
  // H4 失败堆积：只在前台真的在跑时判定（任务结束后残留 failStreak 不算）
  if (frontRunning && S.toolStats.failStreak >= cfg.failStreakMax) {
    alerts.push({ id: 'H4', why: `连续失败 ${S.toolStats.failStreak} 次` })
  }
  // H5 膨胀：步数超阈 **且** 伴随连续失败才算异常（步数多 ≠ 任务失控）
  if (S.stepsThisTask > cfg.taskStepMax && S.toolStats.failStreak >= 2) {
    alerts.push({ id: 'H5', why: `本任务步数 ${S.stepsThisTask} 超阈 ${cfg.taskStepMax}（且连续失败 ${S.toolStats.failStreak} 次）` })
  }
  return alerts.filter(a => !S.alertedSentinels.has(a.id))
}
