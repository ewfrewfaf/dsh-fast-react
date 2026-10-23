/**
 * scheduler.js —— 调度核心（S4）
 *
 * 职责：预取水位 / 批大小自适应 / 步骤元数据解析 / 咨询分析投递 /
 *       里程碑复核 / 黑板归档 / 只读 worker 清理 / 任务级状态重置。
 * 约定：运行时状态经 S（lib/state.js 门面）读写；黑板 IO 经 B（lib/board.js）。
 */
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, existsSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { adaptBatch } from './modes.js'

export function makeScheduler (deps) {
  const { S, B, log, event, steerFront, wakeBack, lastAssistantText } = deps

  /** 速度自适应预取水位：前台跑得快 ⇒ 加深缓冲；跑得慢 ⇒ 收缩（2..4，避震荡） */
  function prefetchWatermark () {
    const base = Math.max(2, Math.min(4, Number(S.cfg.pipelinePrefetch) || 3))
    try {
      const g = S.recentGaps.filter(x => Number.isFinite(x) && x > 0).slice(-3)
      if (g.length < 3) return base
      const avg = g.reduce((s, v) => s + v, 0) / g.length
      if (avg < 30000) return Math.min(4, base + 1)
      if (avg > 90000) return Math.max(2, base - 1)
    } catch { /* 忽略 */ }
    return base
  }

  /** 一次投递几条：模式基线 → 自适应覆盖（可关）；夹在 1..8 */
  function effectiveBatch () {
    const fromMode = Number(S.modeNow().batchSteps) || 0
    const base = fromMode > 0 ? fromMode : (Number(S.cfg.batchSteps) || 1)
    const clamped = Math.max(1, Math.min(8, base))
    if (S.cfg.batchAdapt === false) return clamped
    return Math.max(1, Math.min(8, S.adaptiveBatch || clamped))
  }

  /** 观测一次投递，更新步长自适应（保守 + 滞回，避免震荡） */
  function observeDeliveryForAdapt () {
    try {
      const now = Date.now()
      if (S.lastDeliverAt > 0) {
        const gap = now - S.lastDeliverAt
        if (gap > 0 && gap < 10 * 60 * 1000) {
          S.recentGaps.push(gap)
          if (S.recentGaps.length > 5) S.recentGaps = S.recentGaps.slice(-5)
        }
      }
      S.lastDeliverAt = now
      if (S.cfg.batchAdapt === false) { S.adaptiveBatch = 0; return }
      const fromMode = Number(S.modeNow().batchSteps) || 0
      const base = Math.max(1, Math.min(8, fromMode > 0 ? fromMode : (Number(S.cfg.batchSteps) || 1)))
      const r = adaptBatch(base, S.recentGaps, S.toolStats.failStreak, Math.max(0, S.t3Blocked - S.lastT3Seen))
      S.lastT3Seen = S.t3Blocked
      if (r.batch !== S.adaptiveBatch) {
        const prev = S.adaptiveBatch
        S.adaptiveBatch = r.batch
        event('batch-adapted', { from: prev || base, to: r.batch, reason: r.reason, gaps: S.recentGaps.slice(-3) })
        log(`步长自适应：${prev || base} → ${r.batch}（${r.reason}）`)
      }
    } catch (e) { log('步长自适应跳过: ' + e.message) }
  }

  /** 解析步骤里的调度元数据：depends: S1,S2 / needs: judge / 并行组: g1 */
  function parseStepMeta (body) {
    const meta = { depends: [], judge: false, group: '' }
    try {
      const dep = /depends?\s*[:：]\s*([^\n]+)/i.exec(body)
      if (dep) meta.depends = String(dep[1]).split(/[,，\s]+/).map(B.stepNo).filter(n => n > 0)
      if (/needs?\s*[:：]\s*judge/i.test(body)) meta.judge = true
      const grp = /并行组\s*[:：]\s*([A-Za-z0-9_-]+)/.exec(body)
      if (grp) meta.group = grp[1]
    } catch { /* 忽略 */ }
    return meta
  }

  /** 咨询/速答模式：.board/analysis.md 一出现就投给前台（由前台转述给用户） */
  function checkAnalysisDelivery () {
    if (S.modeNow().writeSteps) return false
    const f = join(S.boardDir, 'analysis.md')
    let m = 0
    try { m = statSync(f).mtimeMs } catch { return false }
    if (m <= S.lastAnalysisMtime) return false
    let body = ''
    try { body = B.readIf(f) } catch { return false }
    if (!body.trim()) return false
    S.lastAnalysisMtime = m
    steerFront(`【分析已就绪】后台结论如下。**不要重排计划**，直接据此给用户交付（超过 400 字先给结论）。\n\n${body.slice(0, 6000)}`, 'analysis')
    event('analysis-delivered', { chars: body.length })
    log(`analysis.md 已投递（${body.length} 字符）`)
    return true
  }

  /** 里程碑复核：前后台都空闲、节流 10 分钟、每任务 ≤3 次、且新完成 ≥reviewEvery 步 */
  function checkMilestoneReview () {
    const mi = S.modeNow()
    const every = Number(mi.reviewEvery) || 0
    if (!mi.backend || every <= 0) return false
    const front = S.front
    const back = S.back
    if (!front || !back) return false
    const frontIdle = !(front.phase && front.phase.kind === 'running')
    const backIdle = !(back.phase && back.phase.kind === 'running')
    if (!frontIdle || !backIdle) return false
    const now = Date.now()
    if (now - S.lastReviewAt < 10 * 60 * 1000) return false
    if (S.reviewCount >= 3) return false
    const doneNow = B.stepNo(B.readState().done || '')
    if (doneNow - S.lastReviewStepNo < every) return false
    if (doneNow <= 0) return false
    const woke = wakeBack('review', `【中途复核】前台已完成 ${doneNow} 步（当前模式 ${mi.label}）。请只做一件轻量检查：读 .board/state.md + 最近事件 + steps 已交付情况，判断"是否还在路线上"。\n- 若正常：只回一个字 OK（不要写任何文件）。\n- 若偏航：写一行到 .board/verdict.md（格式 drift: <一句话>）并回一句话说明。`)
    if (!woke) return false   // 唤醒被冷却/模式拦住 ⇒ 不消耗本轮预算，下个 tick 再试
    S.lastReviewAt = now
    S.lastReviewStepNo = doneNow
    S.reviewCount++
    event('milestone-review', { done: doneNow, count: S.reviewCount })
    return true
  }

  /** 任务已交付 ⇒ 把步骤文件归档（state/route 复制一份），黑板保持小而可查 */
  function archiveBoardIfDone () {
    try {
      if (!B.hasDeliver()) return false
      let files = []
      try { files = readdirSync(B.P.stepsDir).filter(f => /^S\d+\.md$/.test(f)) } catch { return false }
      if (files.length === 0) return false
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const dir = join(S.boardDir, 'archive', stamp)
      mkdirSync(dir, { recursive: true })
      let moved = 0
      for (const f of files) {
        try { renameSync(join(B.P.stepsDir, f), join(dir, f)); moved++ } catch { /* 单个失败忽略 */ }
      }
      for (const [src, name] of [[B.P.state, 'state.md'], [B.P.route, 'route.md']]) {
        try { if (existsSync(src)) writeFileSync(join(dir, name), readFileSync(src)) } catch { /* 忽略 */ }
      }
      event('board-archived', { dir: 'archive/' + stamp, steps: moved })
      log(`任务已完成 ⇒ 归档 ${moved} 个步骤到 .board/archive/${stamp}/`)
      return true
    } catch { return false }
  }

  /** 只读 worker 清理：完成（.done 出现）或超 10 分钟 ⇒ 取消会话并释放工具限制 */
  function cleanupWorkers () {
    if (S.workers.size === 0) return
    for (const [id, w] of S.workers) {
      let done = false
      try { done = existsSync(w.done) } catch { /* 忽略 */ }
      // 兜底：worker 只把结论回在对话里、没写文件时，清理前把末条回复落盘
      if (!done) {
        let idle = false
        try { idle = !(w.ag.phase && w.ag.phase.kind === 'running') } catch { /* 忽略 */ }
        if (idle && Date.now() - w.at > 45000) {
          try {
            const txt = lastAssistantText(w.ag)
            if (txt && String(txt).trim().length > 20) {
              writeFileSync(w.out, `# worker ${id}\n\n${String(txt).trim()}\n`)
              done = true
              event('worker-captured', { id, chars: String(txt).length })
              log(`只读 worker 结论已兜底落盘：${id}`)
            }
          } catch { /* 忽略 */ }
        }
      }
      if (!done && Date.now() - w.at < 10 * 60 * 1000) continue
      try { if (typeof w.ag.cancel === 'function') w.ag.cancel(new Error('worker cleanup')) } catch { /* 忽略 */ }
      try { if (typeof w.ag.__frWorkerDispose === 'function') w.ag.__frWorkerDispose() } catch { /* 忽略 */ }
      S.workers.delete(id)
      event('worker-cleaned', { id, reason: done ? 'done' : 'timeout' })
      log(`只读 worker 清理：${id}（${done ? '已完成' : '超时'}）`)
    }
  }

  /** 新任务起点：重置本任务的调度/复核/分析状态 */
  function resetTaskScheduler () {
    S.judgeWaiting = false
    S.reviewCount = 0
    S.lastReviewStepNo = 0
    S.lastReviewAt = 0
    S.lastAnalysisMtime = 0
    try { if (existsSync(S.judgeFile)) unlinkSync(S.judgeFile) } catch { /* 忽略 */ }
  }

  return {
    prefetchWatermark, effectiveBatch, observeDeliveryForAdapt, parseStepMeta,
    checkAnalysisDelivery, checkMilestoneReview, archiveBoardIfDone, cleanupWorkers, resetTaskScheduler,
  }
}
