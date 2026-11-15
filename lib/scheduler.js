/**
 * scheduler.js —— 调度核心（S4）
 *
 * 职责：预取水位 / 批大小自适应 / 步骤元数据解析 / 咨询分析投递 /
 *       里程碑复核 / 黑板归档 / 只读 worker 清理 / 任务级状态重置。
 * 约定：运行时状态经 S（lib/state.js 门面）读写；黑板 IO 经 B（lib/board.js）。
 */
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, existsSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { adaptBatch, STRATEGY, defaultStrategyForStep } from './modes.js'

/**
 * ★ 2026-11-15 里程碑复核判定（纯函数，可单测）：
 *   全局开关 milestoneCheck 打开 ⇒ 间隔取 milestoneEvery（覆盖模式 reviewEvery），
 *   覆盖所有含后台的模式；关闭 ⇒ 沿用模式 reviewEvery（原行为）。
 *   安全上限不变：前后台都空闲、10 分钟节流、每任务 ≤3 次、新完成 ≥ 间隔步。
 */
export function milestoneReviewDue ({ cfg = {}, mode = {}, frontIdle = false, backIdle = false, now = 0, lastReviewAt = 0, reviewCount = 0, doneNow = 0, lastReviewStepNo = 0 } = {}) {
  const globalOn = cfg.milestoneCheck === true
  const every = globalOn ? Math.max(1, Number(cfg.milestoneEvery) || 5) : (Number(mode.reviewEvery) || 0)
  const base = { every, globalOn }
  if (!mode.backend || every <= 0) return { due: false, ...base }
  if (!frontIdle || !backIdle) return { due: false, ...base }
  if (now - lastReviewAt < 10 * 60 * 1000) return { due: false, ...base }
  if (reviewCount >= 3) return { due: false, ...base }
  if (doneNow <= 0 || doneNow - lastReviewStepNo < every) return { due: false, ...base }
  return { due: true, ...base }
}

export function makeScheduler (deps) {
  const { S, B, log, event, steerFront, wakeBack, lastAssistantText } = deps
  // 归档缺口守卫去重（同一缺口只记一次事件，避免 30s tick 刷屏）
  let lastArchiveGuardKey = ''

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
    let out = Math.max(1, Math.min(8, S.adaptiveBatch || clamped))
    // ★ 2026-11-14 #8/R5：批不跨相位（连续同策略步为界）
    if (S.cfg.enablePhases) {
      try {
        const list = deps.nextStrategies ? deps.nextStrategies() : []
        if (list.length) {
          let run = 0
          for (const s of list) { if (s === list[0]) run++; else break }
          out = Math.min(out, Math.max(1, run))
        }
      } catch { /* 忽略 */ }
    }
    return out
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
    const meta = { depends: [], judge: false, group: '', strategy: '' }
    try {
      const dep = /depends?\s*[:：]\s*([^\n]+)/i.exec(body)
      if (dep) meta.depends = String(dep[1]).split(/[,，\s]+/).map(B.stepNo).filter(n => n > 0)
      if (/needs?\s*[:：]\s*judge/i.test(body)) meta.judge = true
      const st = (/strategy\s*[:：]\s*([a-z]+)/i.exec(body) || [])[1]
      meta.strategy = (st && STRATEGY[st]) ? st : defaultStrategyForStep(body)
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
    const front = S.front
    const back = S.back
    if (!front || !back) return false
    const frontIdle = !(front.phase && front.phase.kind === 'running')
    const backIdle = !(back.phase && back.phase.kind === 'running')
    const now = Date.now()
    const doneNow = B.stepNo(B.readState().done || '')
    // ★ 2026-11-15：全局开关 milestoneCheck 覆盖模式 reviewEvery（判定抽纯函数可单测）
    const verdict = milestoneReviewDue({
      cfg: S.cfg, mode: mi, frontIdle, backIdle, now,
      lastReviewAt: S.lastReviewAt, reviewCount: S.reviewCount,
      doneNow, lastReviewStepNo: S.lastReviewStepNo,
    })
    if (!verdict.due) return false
    const every = verdict.every
    const thought = (deps.frontThought && deps.frontThought()) || ''
    const woke = wakeBack('review', `【中途复核】前台已完成 ${doneNow} 步（当前模式 ${mi.label}）。请只做一件轻量检查：读 .board/state.md + 最近事件 + steps 已交付情况，判断"是否还在路线上"。\n- 若正常：只回一个字 OK（不要写任何文件）。\n- 若偏航：写一行到 .board/verdict.md（格式 drift: <一句话>）并回一句话说明。` + (thought ? `\n\n【前台近期思维（供判断参考）】\n${thought}` : ''))
    if (!woke) return false   // 唤醒被冷却/模式拦住 ⇒ 不消耗本轮预算，下个 tick 再试
    S.lastReviewAt = now
    S.lastReviewStepNo = doneNow
    S.reviewCount++
    event('milestone-review', { done: doneNow, count: S.reviewCount, every, global: verdict.globalOn })
    return true
  }

  /** 任务已交付 ⇒ 把步骤文件归档（state/route 复制一份），黑板保持小而可查 */
  function archiveBoardIfDone () {
    try {
      if (!B.hasDeliver()) return false
      let files = []
      try { files = readdirSync(B.P.stepsDir).filter(f => /^S\d+\.md$/.test(f)) } catch { return false }
      if (files.length === 0) return false

      // ★★ 2026-11-07 关键修复（缺口守卫）：里程碑数 > 已写步骤数 ⇒ **拒绝归档**。
      //
      // 事故：后台被 BACK_BRIEF 要求「steps 先只写 2 个」以求首帧快，插件本应随后催补；
      // 但后台一看到 prefetch 提示里的「若任务接近完成，写 deliver.v1.md 收口」，
      // 就写 deliver 提前结束 ⇒ 这里立刻归档并把 steps 目录搬走 ⇒
      // checkLookahead 的 milestone-gap 催单**永远来不及跑**（tick 是 30s，任务 19s 就归档了）。
      //
      // 实测证据：23 次归档里 18 次存在「里程碑 4/5，步骤只有 2/3」的缺口；
      // 全库历史 milestone-gap 事件 0 条（催补机制从未生效过）。
      //
      // 后果：M3/M4 的活儿从未被规划过，全靠前台自己兜底；编排的"规划"实际只兑现了前 2 步。
      //
      // 修法：归档前校验里程碑与步骤数一致。不一致就不归档，任务继续留在活跃黑板，
      // checkLookahead 每 tick 会看到缺口并 wakeBack 催后台补步（最多 3 次）。
      const ms = (typeof B.routeMilestoneCount === 'function') ? B.routeMilestoneCount() : 0
      if (ms > files.length) {
        const key = `${ms}>>${files.length}`
        if (key !== lastArchiveGuardKey) {
          lastArchiveGuardKey = key
          event('archive-blocked', { milestones: ms, steps: files.length, files: files.join(',') })
          log(`归档拒绝：里程碑 ${ms} > 步骤 ${files.length}，后台仍未补全（不归档，交给催补机制）`)
        }
        return false
      }
      lastArchiveGuardKey = ''

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
      event('board-archived', { dir: 'archive/' + stamp, steps: moved, milestones: ms })
      log(`任务已完成 ⇒ 归档 ${moved} 个步骤到 .board/archive/${stamp}/`)
      // ★★ 2026-11-07：归档成功后**清理 deliver**，否则它会一直堵住下一个任务的缺口检查。
      //   实测事故：黑板里同时躺着 deliver.v1/v2/invalid-* 三个文件，导致随后 10 轮强制编排
      //   里 milestone-gap 事件 0 条 —— checkLookahead 第一行 if (hasDeliver()) return 就短路了。
      //   虽然入口处（deliver() 投递新任务时）也会清，但两处都清才安全：
      //   ① 这里保证"归档即清场"，任务闭环干净；
      //   ② 入口那处保证"历史遗留脏文件"也能被清掉（用户重启/换任务时）。
      try {
        let cleared = []
        for (const f of readdirSync(S.boardDir)) {
          if (!/^deliver(\.v\d+)?\.md$/i.test(f) && !/^deliver\.invalid-/.test(f)) continue
          try {
            renameSync(join(S.boardDir, f), join(dir, f))
            cleared.push(f)
          } catch { /* 忽略 */ }
        }
        if (cleared.length) {
          event('deliver-cleared', { files: cleared, by: 'archive' })
          log(`归档时清理交付文件 ${cleared.join(',')}`)
        }
      } catch { /* 清理失败不影响归档结论 */ }
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

  /** ★ 断粮降精度（2026-11-14，#38）：前台空闲 + 无待做步骤 + 后台仍在规划，持续超阈值
   *  ⇒ 让后台本轮改粗粒度规划（一句话目标+关键文件），细节交前台决策，换交付速度。
   *  前台重新有活干或后台交付后自动恢复精度。只在该触发时触发，不误伤正常流水线。 */
  function checkPlanningStarvation () {
    if (S.cfg.planningDegrade === false) return
    if (!S.modeNow().writeSteps) return
    let pending = 0
    try { pending = B.steps().filter(s => !s.done).length } catch { return }
    const frontBusy = !!(S.front && S.front.phase && S.front.phase.kind === 'running')
    const backBusy = !!(S.back && S.back.phase && S.back.phase.kind === 'running')
    const now = Date.now()
    if (!frontBusy && pending === 0 && backBusy) {
      if (!S.starvedSince) S.starvedSince = now
      const waited = now - S.starvedSince
      const after = Math.max(5000, Number(S.cfg.degradeAfterMs) || 20000)
      if (!S.degraded && waited >= after) {
        S.degraded = true
        event('planning-degraded', { waitedMs: waited, pending })
        log(`前台断粮 ${Math.round(waited / 1000)}s：后台本轮降精度规划（粗粒度步骤，细节交前台）`)
        wakeBack('degrade', '【降精度指令】前台已断粮等待。本轮降低规划精度换速度：只给粗粒度步骤（每步一句话目标 + 关键文件/命令），省略细节论证，细节交给前台自行决策；尽快交付 steps。')
      }
    } else {
      if (S.degraded && (pending > 0 || !backBusy)) {
        S.degraded = false
        event('planning-restored', { pending })
        log('前台恢复供料：规划精度恢复')
      }
      S.starvedSince = 0
    }
  }

  /** ★ 2026-11-14 相位转移：把执行策略对齐到"下一条待做步"，只在相位边界切 L2。
   *  切 L2 不翻 L1/不重置自适应；离 fanout 清 worker；唤醒前设 effort；更新心跳基线；落 phase.md。 */
  function syncPhaseToNextStep () {
    if (S.cfg.enablePhases === false) return null
    if (!S.modeNow().writeSteps) return null
    let list = []
    try { list = deps.nextStrategies ? deps.nextStrategies() : [] } catch { return null }
    if (!list.length) return null
    const want = list[0]
    if (S.phaseStrategy === want) return want
    const prev = S.phaseStrategy
    S.phaseStrategy = want
    S.phaseSince = Date.now()
    const st = STRATEGY[want] || STRATEGY.build
    if (prev && (STRATEGY[prev] || {}).parallel === 'fanout' && st.parallel !== 'fanout') {
      try { deps.cleanupWorkersNow && deps.cleanupWorkersNow() } catch { /* 忽略 */ }
    }
    try { deps.setEffortFor && deps.setEffortFor('front', st.effort) } catch { /* 忽略 */ }
    try { deps.applyStrategy && deps.applyStrategy(want) } catch { /* 忽略 */ }
    try { deps.touchBeat && deps.touchBeat() } catch { /* 忽略 */ }
    event('phase-set', { from: prev || null, to: want })
    log(`阶段 → ${st.label}（${want}）`)
    // ★ 2026-11-15 phase.md 仅作观测：真相=每 tick 从 steps 重算，重启不读回旧标签
    try { writeFileSync(join(S.boardDir, 'phase.md'), `phase: ${want}\nlabel: ${st.label}\nat: ${new Date().toISOString()}\n`) } catch { /* 忽略 */ }
    return want
  }

  /** 新任务起点：重置本任务的调度/复核/分析状态 */
  function resetTaskScheduler () {
    S.judgeWaiting = false
    S.reviewCount = 0
    S.lastReviewStepNo = 0
    S.lastReviewAt = 0
    S.lastAnalysisMtime = 0
    S.starvedSince = 0
    S.degraded = false
    S.phaseStrategy = null
    S.phaseSince = 0
    try { if (existsSync(S.judgeFile)) unlinkSync(S.judgeFile) } catch { /* 忽略 */ }
  }

  return {
    prefetchWatermark, effectiveBatch, observeDeliveryForAdapt, parseStepMeta,
    checkAnalysisDelivery, checkMilestoneReview, archiveBoardIfDone, cleanupWorkers, resetTaskScheduler, checkPlanningStarvation, syncPhaseToNextStep,
  }
}
