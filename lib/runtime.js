/**
 * runtime.js —— 通道(wake/steer/预算) + heartbeat/todo 镜像 + 实时投递 + 终局审计 + fr_route/renderRoute + 催单 + B6 投递/M19 拆分
 * 从 lib/index.js 抽出的第 2 阶段模块（行为不变 refactor）。
 *
 * 依赖（D 依赖袋，字段调用时读取）：
 *   稳定字段（工厂顶部解构）：K cfg ctx log vlog event TAG BASE_PATH boardRoot boardDir P BB
 *   惰性字段：GD MA TN alive appendLine attribute currentMode effectiveBatch hasDeliver judgeFile listSteps modeNow observeDeliveryForAdapt parseStepMeta prefetchWatermark readIf readState resetTaskScheduler stepNo toolStats writeAtomic
 *   K 共享状态：见 index.js 的 K 袋。
 *
 * 区块地图：
 *   通道：noteWakeBudget/prefetchCooldownFor/flushWakeBatch/WAKE_POLICY/appendToolSummary/resultErrorText/isCallContractError/wakeBack/steerFront（wakeCount 随之）
 *   todo 镜像：buildTodoSnapshot/syncTodos/maybeReviewDiff/queueTodoSync
 *   heartbeat：synthHeartbeat
 *   实时投递：startStepsWatcher（fs.watch）
 *   终局：routeMilestoneCount/routeAcceptance/buildFinalPrompt/deliverAudit/checkFinalAudit
 *   fr_route：renderRoute/ensureRouteMilestones/frontThoughtTail/judgePendingOnDisk/checkLookahead
 *   B6/M19：MIN_STEP_CHARS/SETTLE_MS/splitBatchFile/checkVerdict/annotateSteps/checkNewSteps
 *   注：K.* 初始化、toolStats/reworkTrail、SB/B/Sched 调度装配、presetName/BUILD_TAG/CONFIG_KEYS 仍留 index
 */

import { CRITICAL_REASONS } from './policies.js'
import { msg } from './briefs.js'
import { isAbsolute, join } from 'node:path'
import { extractPaths, modeInfo } from './modes.js'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { filterSentinels as filterSentinelsPure, planOverwriteDecision } from './route-plan.js'
import { tailLines } from './api.js'

export function makeRuntime (D) {
  const { cfg, ctx, log, vlog, event, TAG, BASE_PATH, boardRoot, boardDir, P, BB, K } = D

  const wakeCount = { total: 0, byReason: {} }
  // ── 干扰预算（2026-11-07）：每任务统计"打扰了前台几次"。
  //   不是硬闸门（该叫醒还是要叫），而是超预算时记一条事件 + 日志，让"过度干扰"可测。
  function noteWakeBudget (reason) {
    try {
      K.taskWakes++
      const lim = Number(cfg.budgetWakes) || 12
      if (!K.budgetAlerted && K.taskWakes > lim) {
        K.budgetAlerted = true
        event('budget-exceeded', { kind: 'wake', n: K.taskWakes, limit: lim, last: reason })
        log(`干扰预算超限：本任务已唤醒 ${K.taskWakes} 次（阈值 ${lim}）`)
      }
    } catch { /* 忽略 */ }
  }

  /** 关键唤醒：终局 / 上交 / T3 —— **不受冷却限制**（#5 修复：实测冷却把"终局"吞了） */

  /**
   * ★★ 2026-11-07 冷却策略重写：从「固定 45s 时间冷却」改成「缺口驱动 + 短冷却防刷屏」。
   *
   * 为什么改：实测后台产一批（2 步）只要 6.7 秒，却要等 45 秒冷却 ⇒ 后台 87% 的时间在空等。
   *   前台消费 2 步要 22.5 秒，比后台慢 3.4 倍 ⇒ 只要后台持续产出，前台就永不缺料。
   *   现在的 45s 冷却就是那条把流水线截断成串行的绳子。
   *
   * 新逻辑：
   *   · 有里程碑缺口（ms > steps） ⇒ 冷却 2 秒（缺口是最强信号，必须尽快补）
   *   · 缓冲低于水位（remain < watermark） ⇒ 冷却 5 秒（常规预取节奏）
   *   · 其它 ⇒ 用 cfg.prefetchCooldownMs（默认仍可配，作兜底）
   *
   * 保留时间下限的意义：防止 tick（30s）与投递回调（即时）在同一瞬间重复唤醒，
   * 造成同一次缺口被催两遍 —— 那是纯浪费 token。
   */
  function prefetchCooldownFor (ms, stepCount, remain) {
    const gap = (typeof ms === 'number' && ms > 0 && ms > stepCount)
    if (gap) return 2000
    if (remain <= 0) return 5000
    return Number(cfg.prefetchCooldownMs) || 45000
  }
  /** v2 唤醒合并：冷却期内积压的唤醒文本（官方 Super-agent「批量唤醒」思路） */
  const pendingWakeBatch = []
  /** 把积压的唤醒合并成一条发出；返回是否发出 */
  function flushWakeBatch () {
    if (!pendingWakeBatch.length) return false
    if (pendingWakeBatch.length === 1) {
      const only = pendingWakeBatch.shift()
      return wakeBack('batched', only)
    }
    const merged = pendingWakeBatch.map((t, i) => (i + 1) + '. ' + t).join(' | ')
    pendingWakeBatch.length = 0
    return wakeBack('batched', '【合并唤醒】' + merged)
  }

  /**
   * 统一唤醒前置过滤表（2026-11-07）。
   * 以前"某个 reason 需要连续失败 2 次才唤醒"这类条件散在调用点（tools/post-execute 里
   * `failStreak === 2`），新增 reason 就得再写一遍。现在收拢成一张表，wakeBack 入口统一判定：
   *   minStreak / maxStreak —— 依赖 toolStats.failStreak 的统计类 reason
   * 未列出的 reason 不受此表约束（哨兵、终局、手动等仍按各自逻辑）。
   */
  const WAKE_POLICY = {
    // 前台工具失败：同一工具连续失败第 2 次才值得惊动后台（第 1 次前台自己会改；
    // 第 3 次起交给 H4 哨兵处理，不再重复唤醒）
    'tool-fail': { minStreak: 2, maxStreak: 2 },
  }

  /** 把前台最近 5 次工具调用的摘要拼到唤醒文本尾部（后台据此判断前台实际做了什么）。 */
  function appendToolSummary (text) {
    try {
      const recent = Array.isArray(D.toolStats.recent) ? D.toolStats.recent.slice(-5) : []
      if (!recent.length) return text
      const s = recent.map((x) => `${x.n}${x.ok ? '✓' : '✗'}`).join(' · ')
      return String(text || '') + `\n【前台最近工具】${s}`
    } catch { return text }
  }

  /** 从工具结果里抽出可读错误文本（各工具形状不一，尽量兜住）。 */
  function resultErrorText (result) {
    try {
      if (!result) return ''
      if (typeof result === 'string') return result
      if (typeof result.content === 'string') return result.content
      if (Array.isArray(result.content)) {
        return result.content.map((p) => (p && (p.text || p.content)) || '').join(' ')
      }
      if (result.error) return String((result.error && result.error.message) || result.error)
      return ''
    } catch { return '' }
  }

  /**
   * 调用契约错误：工具名打错 / 参数不合法 —— 调用**没有到达工具本体**。
   * 这类失败不代表"任务做不下去"，计入 failStreak 会直接造成误冻结
   * （你的 #33：连续记错同一个工具名 → H4 判"连续失败 3 次" → 冻结并作废全部步骤）。
   */
  const CALL_CONTRACT_RE = /unknown tool|tool .{0,40}?(?:not found|not registered|does not exist)|no such tool|invalid (?:argument|arguments|parameter|params|schema)|missing required (?:property|parameter|argument)|参数.{0,20}?(?:无效|不合法|缺失)|工具.{0,20}?(?:不存在|未注册|不可用)/i
  const isCallContractError = (result) => CALL_CONTRACT_RE.test(resultErrorText(result))

  function wakeBack (reason, text) {
    if (reason === 'auto-upgrade' && (cfg.modeLocked || cfg.orchestration === 'fixed')) { log('auto-upgrade 跳过：固定锁'); return false }
    const now = Date.now()
    if (!K.back) { log(`wake(${reason}) 跳过：后台未接线`); vlog('wake-skip', { reason, why: 'no-back' }); return false }
    // ★ 模式守卫（Phase 1）：速答/检索模式不需要后台 ⇒ 任何自动唤醒都跳过（手动除外）
    try {
      const mi = D.modeNow()
      // ★★ 2026-11-08：分诊/兜底升级必须能穿透 quick 模式的"不需要后台"守卫。
      //   逻辑悖论：triage 的职责恰恰是"判断 quick 模式要不要升级"，
      //   如果它自己被 quick 模式的 backend:false 拦住，分诊永远不会发生。
      //   实测：L3 灰区判型后 triage-woken 返回 woke:false，正是这个原因。
      const BYPASS = new Set(['manual', 'triage', 'auto-upgrade'])
      if (!mi.backend && !BYPASS.has(reason)) {
        log(`wake(${reason}) 跳过：模式 ${mi.key} 不需要后台`)
        vlog('wake-skip', { reason, why: 'mode-no-backend', mode: mi.key })
        event('wake-skip-mode', { reason, mode: mi.key })
        return false
      }
      if (!mi.backend && BYPASS.has(reason)) {
        log(`wake(${reason}) 穿透 ${mi.key} 模式的 backend:false（该 reason 本身就需要后台判断）`)
      }
    } catch { /* 模式层异常不影响唤醒 */ }
    // ★ 用户停止/暂停后 15s 内不唤醒（2026-10-18 修复：否则用户点了暂停，
    //   插件又把后台拉起来继续跑，表现为"暂停按不住"）
    if (now - K.userStopAt < 15000) { log(`wake(${reason}) 跳过：用户刚停止`); vlog('wake-skip', { reason, why: 'user-stop' }); return false }
    void D.GD.setEffort('back')   // B10 档位漂移：先把全局档位切到后台该有的值
    // ★ 统一前置过滤（见 WAKE_POLICY）：统计类 reason 的阈值在这里一次判定
    const pol = WAKE_POLICY[reason]
    if (pol && typeof D.toolStats.failStreak === 'number') {
      if (pol.minStreak !== undefined && D.toolStats.failStreak < pol.minStreak) {
        vlog('wake-skip-policy', { reason, failStreak: D.toolStats.failStreak, min: pol.minStreak })
        log(`wake(${reason}) 前置过滤：failStreak ${D.toolStats.failStreak} < ${pol.minStreak}`)
        return false
      }
      if (pol.maxStreak !== undefined && D.toolStats.failStreak > pol.maxStreak) {
        vlog('wake-skip-policy', { reason, failStreak: D.toolStats.failStreak, max: pol.maxStreak })
        log(`wake(${reason}) 前置过滤：failStreak ${D.toolStats.failStreak} > ${pol.maxStreak}`)
        return false
      }
    }
    // ★ 前台最近动作随唤醒一起送（官方：决策方要看到执行方的真实动作，而不是只读 state.md）
    //   合并唤醒（batched）的文本里每条已经自带摘要，这里不再重复追加。
    const body = reason === 'batched' ? text : appendToolSummary(text)
    // ★ v2 抄官方 Super-agent「批量唤醒」：冷却期内的事件不再丢弃，而是入队合并。
    //   冷却结束由 tick 检查积压并合并成一条发出（官方数据：合并能省 30% Router 决策）。
    if (!CRITICAL_REASONS.has(reason) && now - K.lastWakeAt < cfg.wakeCooldownMs) {
      pendingWakeBatch.push(`[${reason}] ${String(body || '').slice(0, 300)}`)
      D.attribute({ role: 'back', trigger: reason, ok: false, queued: true })
      log(`wake(${reason}) 冷却中，已入队合并（积压 ${pendingWakeBatch.length} 条）`)
      return false
    }
    // ★★ 2026-11-07 改法 B：补步类信号在后台忙时**优先 followup**（排队立刻接续），
    //   而不是 steer（steer 要排到它当前回合的下一步，会等很久）。
    //
    //   实测 L3 时间线：
    //     +11.5s milestone-gap(need-next) → 后台正在跑 review-diff
    //     wakeBack 走 steer 分支 → 信号排进它的下一轮，直到 +37.6s 才被处理
    //     前台 +13.9s 就没料了，空等 28 秒。
    //
    //   语义：补步步是"断料救援"，优先级高于后台正在做的复核/审查这类后台自主动作。
    //   followup 会让后台在**当前回合结束后立刻**起新一轮处理补步，而不是把消息塞进当前回合中段。
    //
    //   例外：若后台只是"正在跑但马上要产出步骤"，steer 也无害；所以保留 steer 作为失败回退路径。
    const REPAIR_REASONS = new Set(['need-next', 'prefetch-urgent', 'prefetch', 'milestone-gap'])
    if (K.back.phase && K.back.phase.kind === 'running' && REPAIR_REASONS.has(reason)) {
      try {
        K.back.followup(msg(body))
        K.lastWakeAt = now; wakeCount.total++; wakeCount.byReason[reason] = (wakeCount.byReason[reason] || 0) + 1; noteWakeBudget(reason); D.attribute({ role: 'back', trigger: reason, ok: true })
        event('wake', { reason, mode: 'followup-repair' })
        log(`wake(${reason}) → followup（补步优先，后台在跑也立即接续）`)
        vlog('wake', { reason, mode: 'followup-repair' })
        return true
      } catch (e) {
        log(`wake followup-repair fail: ${e.message} → 回退 steer`)
        try {
          K.back.steer(msg(body))
          K.lastWakeAt = now; wakeCount.total++; wakeCount.byReason[reason] = (wakeCount.byReason[reason] || 0) + 1; noteWakeBudget(reason); D.attribute({ role: 'back', trigger: reason, ok: true })
          event('wake', { reason, mode: 'steer-fallback' }); return true
        } catch (e2) { log('wake steer-fallback fail: ' + e2.message); return false }
      }
    }
    if (K.back.phase && K.back.phase.kind === 'running') {
      // 正在深想：用 steer 排队到它下一步，不打断（内容在黑板，信号可晚到）
      try {
        K.back.steer(msg(body))
        K.lastWakeAt = now; wakeCount.total++; wakeCount.byReason[reason] = (wakeCount.byReason[reason] || 0) + 1; noteWakeBudget(reason); D.attribute({ role: 'back', trigger: reason, ok: true })
        event('wake', { reason, mode: 'steer' }); log(`wake(${reason}) → steer（后台在跑）`); vlog('wake', { reason, mode: 'steer' }); return true
      } catch (e) {
        // ★ 实测（2026-10-17）：后台刚被唤醒、处于中间态时 steer 会抛 "unreachable variant: {}"。
        //   此时必须**回退到 followup**，否则这次唤醒彻底丢失（哨兵/终局信号会丢）。
        log('wake steer fail: ' + e.message + ' → 回退 followup')
        try {
          K.back.followup(msg(body))
          K.lastWakeAt = now; wakeCount.total++; wakeCount.byReason[reason] = (wakeCount.byReason[reason] || 0) + 1; noteWakeBudget(reason); D.attribute({ role: 'back', trigger: reason, ok: true })
          event('wake', { reason, mode: 'followup-fallback' }); vlog('wake', { reason, mode: 'followup-fallback' }); return true
        } catch (e2) { log('wake followup-fallback fail: ' + e2.message); return false }
      }
    }
    try {
      K.back.followup(msg(body))          // 空闲 → 唤醒起一轮
      K.lastWakeAt = now; wakeCount.total++; wakeCount.byReason[reason] = (wakeCount.byReason[reason] || 0) + 1; noteWakeBudget(reason); D.attribute({ role: 'back', trigger: reason, ok: true })
      if (pendingWakeBatch.length) event('wake-batch-flushed', { count: pendingWakeBatch.length })
      pendingWakeBatch.length = 0
      event('wake', { reason, mode: 'followup' }); log(`wake(${reason}) → followup（后台空闲）`); vlog('wake', { reason, mode: 'followup' }); return true
    } catch (e) { log('wake followup fail: ' + e.message); return false }
  }

  function steerFront (text, reason, opts) {
    if (!K.front) return false
    // ★ 用户刚停止/暂停 ⇒ 不再向台前投递（2026-10-18：这是"暂停按不住"的主因之一）
    // ★ 例外（2026-10-24）：消防通道的说明必须发得出去 —— 它发生在 cancel 之后、且本身就是
    //   用户/后台的显式打断。用 opts.force 绕过本通道自己刚写的 userStopAt，
    //   但**真·用户暂停**（pauseAt）仍然优先：暂停后 15s 内任何 force 也不放行。
    const forced = !!(opts && opts.force)
    if (Date.now() - K.pauseAt < 15000) { log(`steer 前台(${reason}) 跳过：用户刚暂停`); return false }
    if (!forced && Date.now() - K.userStopAt < 15000) { log(`steer 前台(${reason}) 跳过：用户刚停止`); return false }
    void D.GD.setEffort('front')   // B10 档位漂移：先把全局档位切到前台该有的值
    const running = !!(K.front.phase && K.front.phase.kind === 'running')
    try {
      // ★ 关键修复（2026-10-17）：空闲时 steer() 只把消息排进队列、**不会起一轮**，
      //   消息会一直悬空 —— 用户从面板发的消息于是"消失"（实测：api-task 记录成功，
      //   但前台会话事件里根本没有这条 user 消息）。空闲必须 followup() 起一轮。
      if (running) K.front.steer(msg(text))
      else K.front.followup(msg(text))
      event('steer-front', { reason, mode: running ? 'steer' : 'followup' })
      log(`steer 前台(${reason}, ${running ? 'steer' : 'followup'})`)
      return true
    } catch (e) {
      log('steerFront fail: ' + e.message + ' → 回退 followup')
      try {
        K.front.followup(msg(text))
        event('steer-front', { reason, mode: 'followup-fallback' })
        return true
      } catch (e2) { log('steerFront followup fallback fail: ' + e2.message); return false }
    }
  }

  // ── B3 heartbeat 合成（E1）＋ 失败计数（H4） ────────────────────────────
  // ── steps → 官方 todo（单向镜像，2026-11-07）──────────────────────────────
  // 设计要点（读 dsh-tool-todo 源码确认）：
  //   · todo_write 等价于 session.append('todo/write', {todos})，整表替换、最后写赢
  //   · 投影 apply 里有 `if (event.type === 'turn/start') return null` ⇒ 每个 turn 重置
  //   所以：唯一写者是插件，且必须在每个 turn 开头重写一次快照，否则模型下一轮就看不到。
  //   这不是第二真相源——真相源仍是 steps/S*.md，todo 只是它的逐轮投影。

  function buildTodoSnapshot () {
    try {
      const files = D.listSteps()
      if (!files.length) return null
      const done = D.stepNo(D.readState().done || '')
      const todos = []
      for (const f of files.slice(0, 40)) {
        const k = D.stepNo(f)
        const body = D.readIf(join(P.stepsDir, f)) || ''
        const line = body.split('\n').find((l) => /^动作[:：]/.test(l)) || ''
        const act = line.replace(/^动作[:：]\s*/, '').trim()
        todos.push({
          content: `S${k} ${act || '(无描述)'}`.slice(0, 100),
          status: k <= done ? 'completed' : (k === done + 1 ? 'in_progress' : 'pending'),
        })
      }
      if (files.length > 40) todos.push({ content: `…另有 ${files.length - 40} 步`, status: 'pending' })
      // content 必须唯一（工具侧校验会去重）
      const seen = new Set()
      return todos.filter((t) => (seen.has(t.content) ? false : (seen.add(t.content), true)))
    } catch { return null }
  }

  /** 把当前步骤快照写进前台会话的 todos（幂等：内容不变则跳过）。 */
  function syncTodos (why) {
    try {
      if (cfg.todoMirror === false) return false
      if (!K.front || !K.front.session) return false
      const todos = buildTodoSnapshot()
      if (!todos) return false
      const key = JSON.stringify(todos)
      if (key === K.lastTodoKey) return false
      K.lastTodoKey = key
      K.front.session.append('todo/write', { todos })
      vlog('todo-mirror', { why, count: todos.length })
      return true
    } catch (e) { log('todo 镜像失败: ' + (e && e.message || e)); return false }
  }

  /** coding 模式：后台只读审 diff（不写代码）。攒够 3 个改动文件、冷却 2 分钟、每任务最多 3 次。 */
  function maybeReviewDiff () {
    try {
      if (cfg.reviewDiffEnabled === false) return false
      const p = modeInfo(D.currentMode())
      if (!p || !p.reviewDiff) return false
      if (K.changedFiles.size < 3) return false
      if (Date.now() - K.lastDiffReviewAt < 120000) return false
      if (K.diffReviewCount >= 3) return false
      K.lastDiffReviewAt = Date.now()
      K.diffReviewCount++
      const list = [...K.changedFiles].slice(-8).map((f) => '· ' + f).join('\n')
      K.changedFiles.clear()
      event('review-diff', { count: K.diffReviewCount })
      vlog('review-diff', { round: K.diffReviewCount })
      wakeBack('review-diff', `【审阅·只读】前台刚改了这些文件：\n${list}\n` +
        '请**只读**核对它们是否符合 route.md 的验收标准；只指出问题（≤3 条），**不要写代码、不要改文件、不要重排路线**。')
      return true
    } catch { return false }
  }

  /** 延迟一拍再写：turn/start 事件分发过程中直接 append 会重入。 */
  function queueTodoSync (why) {
    if (K.todoSyncTimer) return
    K.todoSyncTimer = setTimeout(() => { K.todoSyncTimer = null; syncTodos(why) }, 0)
  }

  const synthHeartbeat = (toolName, ok) => {
    const line = `${new Date().toISOString()} | tool=${toolName} | ${ok ? 'ok' : 'FAIL'} | task_steps=${K.stepsThisTask}`
    D.appendLine(P.heartbeat, line)
    K.lastBeatAt = Date.now()   // ★ H3 基线：只用本次会话/本轮产生的心跳
    K.lastToolAt = Date.now()   // ★ 看门狗：有工具执行就算"还活着"
  }

  // ── 实时投递（首帧杀手）：fs.watch 监听 steps 目录，文件落盘立即投递 ────────────
  // 背景（2026-10-17 实测）：首帧 20.8s 里最大一块是"插件 30s 轮询"——
  // 后台把步骤写进 steps/ 后，前台平均要等 15s、最坏 30s 才收到。
  // 这里用 fs.watch 把这段延迟压到毫秒级。
  function startStepsWatcher () {
    try {
      let timer = null
      const w = watch(P.stepsDir, { persistent: false }, (evt, fname) => {
        if (!D.alive()) return
        const fn = String(fname || '')
        // ★ 过滤：writeAtomic 会先写 .tmpdir 再 rename ⇒ 每次写步骤会触发 2 次事件。
        //   只对正式步骤文件 / BATCH 清单响应，避免无谓的重复处理。
        if (fn && !/^S\d+\.md$/i.test(fn) && !/^BATCH.*\.md$/i.test(fn)) return
        if (timer) return                       // 合并短时间内的多次写入
        timer = setTimeout(() => {
          timer = null
          try {
            if (!D.alive()) return
            const t0 = Date.now()
            splitBatchFile()
            checkNewSteps()
            event('watcher-fire', { file: String(fname || ''), ms: Date.now() - t0 })
            log(`实时投递触发（${fname || '?'}，处理 ${Date.now() - t0}ms）`)
          } catch (e) { log('steps watcher err: ' + e.message) }
        }, 120)
      })
      w.on('error', (e) => log('steps watcher error: ' + (e && e.message || e)))
      log('实时投递：steps 目录已监听（首帧轮询延迟 ~30s → ~0.1s）')
      return w
    } catch (e) {
      log('steps watcher 启动失败（退回 30s tick）: ' + e.message)
      return null
    }
  }

  /** 规划闭环检测：统计 route.md「## 里程碑」段里列出的里程碑条数
   *  ★ 2026-11-07：实现已移入 lib/board.js（BB.routeMilestoneCount），此处转调，
   *    避免 scheduler.js（归档前要校验缺口）与 index.js（催补步）两处实现分叉。
   *    ⚠️ 必须用 BB（第 300 行声明）而不是后面的 B（第 2046 行），否则若被更早调用会触发 TDZ。 */
  function routeMilestoneCount () {
    try { return (typeof BB.routeMilestoneCount === 'function') ? BB.routeMilestoneCount() : 0 } catch { return 0 }
  }

  /** 解析 route.md 的「## 终态判定」段 → [{ id:'A1', text:'...' }]（格式由 renderRoute 控制，解析确定） */
  function routeAcceptance () {
    try {
      const t = D.readIf(join(boardDir, 'route.md'))
      if (!t) return []
      const m = t.match(/^##[^\n]*终态判定[^\n]*$/m)
      if (!m) return []
      const seg = t.slice(m.index + m[0].length).split(/\n##\s/)[0]
      const items = seg.split('\n')
        .filter((l) => /^\s*[-*]\s+\S/.test(l))
        .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
        .filter(Boolean)
      return items.map((text, i) => ({ id: 'A' + (i + 1), text }))
    } catch { return [] }
  }

  /** 终局对照审的唤醒文本：把开工时定下的验收标准原文交回去，要求逐条给证据。 */
  function buildFinalPrompt () {
    const acc = routeAcceptance()
    if (!acc.length) return null
    const t = D.readIf(join(boardDir, 'route.md')) || ''
    const gm = t.match(/^##[^\n]*目标[^\n]*\n+([\s\S]*?)(?=\n##\s|$)/m)
    const goal = gm ? gm[1].trim().slice(0, 200) : ''
    const verdict = acc.map((a) => a.id + '✓').join(' ')
    const list = acc.map((a) => `  ${a.id}: ${a.text}`).join('\n')
    return {
      acc,
      text: `【终局】清单最后一步已完成。现在做**验收对照**（不要复述过程）：\n` +
        `目标：${goal || '（route.md 未写）'}\n` +
        `验收标准：\n${list}\n\n` +
        `要求：\n` +
        `1. 逐条判定，每条一行：「A1 满足 — 证据：<文件路径 / 命令输出片段>」或「A1 不满足 — 缺：<什么>」\n` +
        `2. 全部满足 ⇒ 写 .board/deliver.v1.md，**首行必须是** \`验收: ${verdict}\`\n` +
        `3. 有任何一条不满足 ⇒ 不要写 deliver，写下一批 .board/steps/S*.md 补齐缺口`,
    }
  }

  /** 机械审计 deliver：必须存在「验收: A1✓ A2✓」行且覆盖全部验收条目。零模型。 */
  function deliverAudit () {
    const acc = routeAcceptance()
    if (!acc.length) return { ok: true, skipped: true }
    const t = D.readIf(join(boardDir, 'deliver.v1.md'))
    if (!t) return { ok: false, why: 'deliver 不存在' }
    const line = (t.match(/^\s*验收[:：].*$/m) || [])[0]
    if (!line) return { ok: false, why: '缺少「验收:」判定行', missing: acc.map((a) => a.id) }
    const missing = acc.filter((a) => !new RegExp(a.id + '\\s*[✓√]').test(line)).map((a) => a.id)
    return missing.length ? { ok: false, why: '验收声明缺项', missing } : { ok: true }
  }

  /** tick 里调用：deliver 出现/变更时审计一次；不合格则作废并让后台补（有上限）。 */
  function checkFinalAudit () {
    if (cfg.finalAudit === false) return
    if (!D.hasDeliver()) return
    const t = D.readIf(join(boardDir, 'deliver.v1.md')) || ''
    const key = t.length + ':' + t.slice(0, 40)
    if (key === K.lastAuditedDeliverKey) return
    K.lastAuditedDeliverKey = key
    const r = deliverAudit()
    if (r.ok) {
      event('deliver-audit', { ok: true, skipped: !!r.skipped })
      vlog('deliver-audit', { ok: true, skipped: !!r.skipped })
      return
    }
    const maxRetry = typeof cfg.finalAuditMaxRetry === 'number' ? cfg.finalAuditMaxRetry : 2
    if (K.finalAuditRetry >= maxRetry) {
      event('deliver-audit', { ok: false, giveUp: true, why: r.why, missing: r.missing })
      vlog('deliver-audit', { ok: false, giveUp: true, why: r.why, missing: r.missing })
      return
    }
    K.finalAuditRetry++
    try { renameSync(join(boardDir, 'deliver.v1.md'), join(boardDir, `deliver.invalid-${Date.now()}.md`)) } catch { /* 改名失败则保持原状 */ }
    K.finalAsked = false
    event('deliver-audit', { ok: false, retry: K.finalAuditRetry, why: r.why, missing: r.missing })
    vlog('deliver-audit', { ok: false, retry: K.finalAuditRetry, why: r.why, missing: r.missing })
    const verdict = routeAcceptance().map((a) => a.id + '✓').join(' ')
    wakeBack('final', `【终局·验收未通过】deliver 未通过机械对照：${r.why}${r.missing ? '（' + r.missing.join(',') + '）' : ''}。\n` +
      `请按 route.md 的「## 终态判定」逐条补齐后重写 deliver，**首行必须写** \`验收: ${verdict}\`；缺证据的条目要补做，不要只补文字。`)
  }

  // ── fr_route：结构化提交路线（LLM 想乱写格式也写不出来）───────────────────────
  /** 把结构化路线渲染成 route.md；若带 steps 参数，**同时**写出 steps/S<k>.md。
   *
   *  ★★ 2026-11-07 新增 mode 参数（区分「首次规划」与「补步」）：
   *    实测事故：后台每次被唤醒都会**整体重写路线**，哪怕只是补 S6/S7，
   *    也要把 S1-S5 重画一遍（`route-steps steps=4` 之后仍触发 `watcher-fire S1.md`）。
   *    一个 60 秒任务可能把同一条路线重画 3-5 遍 —— 这是最大的浪费。
   *
   *      mode='plan'   首次规划：覆写 route.md + 写全部 steps（现有行为）
   *      mode='append' 补步：**不动 route.md**，只写新步号，**已存在的直接跳过**
   *
   *    但 plan 模式有个隐患：它会覆写**已完成**的步骤（S1 已完成又重写）
   *    ⇒ seenSteps 被删 ⇒ 前台可能被重复投递已做完的步骤。
   *    所以 plan 也加了一条：**步号 <= 当前 done 的，不重写**。
   *
   *    修错场景（后台发现 S3 写错要改）：仍用 mode='plan'，编号不变、内容更新。
   *    （原本文档里的 `repairs: S<j>` 其实从未被代码解析过，是死设计，不用管。）
   */
  function renderRoute (args) {
    const mode = String(args.mode || 'plan')
    // 已存在的步骤文件（用于 append 模式跳过）
    let existingSteps = new Set()
    try { existingSteps = new Set(readdirSync(P.stepsDir).filter(f => /^S\d+\.md$/.test(f))) } catch { /* 忽略 */ }
    // 当前已完成步号（用于 plan 模式跳过已完成步骤）
    const doneNow = D.stepNo(D.readState().done || '')
    // append 只有在本任务已有 route 时才成立；否则退回 plan
    const isAppend = (mode === 'append' && existsSync(P.route))
    // ★ 2026-11-07：plan 模式的必需字段校验（schema 里 required 已清空，改在这里查）
    //   plan 要覆写整条路线，必须有 goal + milestones；append 只要 steps。
    if (!isAppend) {
      const mArr = Array.isArray(args.milestones) ? args.milestones.filter(m => m && m.id && m.desc) : []
      if (!String(args.goal || '').trim() && mArr.length === 0) {
        return { ok: false, error: 'plan 模式需要 goal 和 milestones；若只是补步骤，请用 mode:"append" 并只给 steps。' }
      }
    } else {
      const sArr = Array.isArray(args.steps) ? args.steps.filter(s => s && s.id && s.action) : []
      if (sArr.length === 0) {
        return { ok: false, error: 'append 模式必须给 steps（要补的步骤清单）。' }
      }
    }

    const lines = ['# route.md（由 fr_route 工具生成，勿手改写）', '']
    lines.push('## 目标', String(args.goal || '').trim() || '（未提供）', '')
    const acc = Array.isArray(args.acceptance) ? args.acceptance.filter(Boolean) : []
    if (acc.length) { lines.push('## 终态判定'); for (const a of acc) lines.push('- ' + String(a).trim()); lines.push('') }
    const ms = Array.isArray(args.milestones) ? args.milestones.filter(m => m && m.id && m.desc) : []
    // ★★ 2026-11-07 里程碑单调性约束（防"永远补不完"）—— 必须在生成 lines 之前跑
    //
    // 实测事故：同一任务内后台反复重规划，里程碑数一路涨：
    //   11:44:13 milestones=6 → 11:44:37 milestones=6 → 11:45:12 **milestones=9**
    //   而 steps 追不上（补到 6 又涨到 9）⇒ 缺口永不为 0 ⇒ 归档被拒、任务卡住。
    //
    // 根因：renderRoute 每次**整体覆写** route.md，从不检查既有 route；
    //   后台补步时重新规划，自然把"接下来的活"也算进里程碑，目标不断外扩。
    //
    // 对策：里程碑只许持平或减少，不许增长（增长时按旧数量截断并记事件）。
    //   理由：任务总量应在最初几次规划就定；补步阶段只该"补齐"，不该"加活"。
    if (ms.length > 0) {
      let prevMsCount = 0
      try {
        const prevRaw = D.readIf(P.route)
        if (prevRaw) {
          const mPrev = prevRaw.match(/^##[^\n]*里程碑[^\n]*$/m)
          if (mPrev) {
            const segPrev = prevRaw.slice(mPrev.index + mPrev[0].length).split(/\n##\s/)[0]
            prevMsCount = segPrev.split('\n').filter(l => /^\s*[-*]\s*\*?\*?M\d+/i.test(l)).length
          }
        }
      } catch { /* 忽略 */ }
      if (prevMsCount > 0 && ms.length > prevMsCount) {
        event('milestone-inflation-blocked', { was: prevMsCount, want: ms.length })
        log('fr_route：里程碑 ' + prevMsCount + ' → ' + ms.length + ' 已截断（补步阶段不许外扩任务量）')
        ms.length = prevMsCount
      }
    }
    lines.push('## 里程碑')
    for (const m of ms) lines.push(`- **${String(m.id).trim()}${m.step ? '（' + String(m.step).trim() + '）' : ''}**：${String(m.desc).trim()}`)
    lines.push('')
    // ★★ 2026-11-07 方案 A：哨兵「预存文件」拒绝
    //
    // 实测事故（L4 r1，13:59:19）：
    //   后台给出哨兵 C1 = file-exists(".../run-forced/L4/check.mjs")，
    //   但 check.mjs 是**题目自带**的验收脚本、规划时就已经存在 ⇒
    //   哨兵立即命中 ⇒ `sentinel-biz` + `interrupt-back` + `freeze` 三连，
    //   前台被冻结、后台被打断，任务卡死在 4/7。
    //
    // 语义错误：哨兵应该判断「**新出现的**文件/状态」，而不是「本来就有的文件」。
    //   后台不知道哪些文件是原有的，它把"文件存在"当成"活干完了"的信号。
    //
    // 修法：规划时检查目标——**如果文件此刻已经存在，这个 file-exists 哨兵必然立刻误触发**，
    //   直接丢弃并在事件里记一笔。file-absent 同理（若文件此刻不存在，哨兵也会立刻命中）。
    //   field-cmp / grep-match 无法静态判定，保持原样（它们依赖 done 状态变化，不会立即触发）。
    // 哨兵预检：丢弃会立即误触发的 file-*（纯逻辑见 route-plan.js，可单测）
    const rawSn = Array.isArray(args.sentinels) ? args.sentinels.filter(s => s && s.id && s.kind && s.target) : []
    const { kept: sn, rejected } = filterSentinelsPure(rawSn, {
      exists: existsSync,
      isAbsolute,
      root: boardRoot,
      resolve: (p) => join(boardRoot, p),
    })
    for (const r of rejected) {
      event('sentinel-rejected', { id: r.id, kind: r.kind, target: r.target, why: r.why })
      log(`fr_route：拒绝哨兵 ${r.id}（${r.why === 'already-exists' ? 'file-exists 目标已存在' : 'file-absent 目标已不存在'}，会立即误触发）：${r.target}`)
    }
    if (sn.length) {
      lines.push('## 哨兵条件')
      for (const x of sn) lines.push(`- ${String(x.id).trim()} | ${String(x.kind).trim()} | ${String(x.target).trim()}`)
      lines.push('')
    }
    const body = lines.join('\n')
    if (!isAppend) {
      // plan 模式：覆写 route.md（append 模式不动它，里程碑保持原样）
      D.writeAtomic(P.route, body)
      event('route-rendered', { chars: body.length, milestones: ms.length, sentinels: sn.length })
      log(`fr_route：route.md 已生成（${body.length} 字符，里程碑 ${ms.length}，哨兵 ${sn.length}）`)
    } else {
      event('route-append-mode', { existing: existingSteps.size, incoming: (Array.isArray(args.steps) ? args.steps.length : 0) })
      log(`fr_route：append 模式 —— 不覆写 route.md，只补新步骤（已有 ${existingSteps.size} 个）`)
    }

    // ★ 同批写出步骤文件（省掉后台单独写 steps 的那一次响应）
    let wrote = 0
    let skipped = 0
    let st = Array.isArray(args.steps) ? args.steps.filter(s => s && s.id && s.action) : []
    // ★ 2026-11-15 机械停写：本批含 judge 步 ⇒ 截断其后所有步（不依赖模型自觉，闭环硬保证）
    const jIdx = st.findIndex((x) => String(x.needs || '').trim() === 'judge')
    if (jIdx >= 0 && jIdx < st.length - 1) {
      event('judge-stop-truncated', { kept: jIdx + 1, dropped: st.length - jIdx - 1 })
      log(`fr_route：判断点停写机械截断，保留 ${jIdx + 1} 步、丢弃其后 ${st.length - jIdx - 1} 步`)
      st = st.slice(0, jIdx + 1)
    }
    // ★ 2026-11-15：跳过/清尾/重置决策抽纯函数 planOverwriteDecision（回归可证）
    const ovd = planOverwriteDecision({
      doneNo, status: String(D.readState().status || ''),
      incomingKs: st.map((x) => D.stepNo(String(x.id)) || 0),
      existingKs: Array.from(existingSteps).map((f) => D.stepNo(f)),
      isAppend,
    })
    for (const s of st) {
      const k = D.stepNo(String(s.id))
      if (!k) continue
      // ★★ 两种模式的跳过规则：
      //   append：已存在的文件一律不碰（只写新增的步号）
      //   plan  ：步号 <= 当前 done 的已完成步骤不重写（避免重写已做完的活、误触发重新投递）
      if (ovd.skip(k)) { skipped++; continue }
      const sl = [`# S${k}`, `动作: ${String(s.action).trim()}`, `验收: ${String(s.accept || '按动作完成').trim()}`, `assumes: ${String(s.assumes || '无').trim()}`]
      // ★ 2026-11-15：判断点标记落盘（parseStepMeta 认 needs: judge ⇒ 投后停牌）
      if (String(s.needs || '').trim() === 'judge') sl.push('needs: judge')
      try {
        D.writeAtomic(join(P.stepsDir, `S${k}.md`), sl.join('\n') + '\n')
        try { K.seenSteps.delete(`S${k}.md`) } catch { /* 忽略 */ }   // 让投递逻辑重新认领
        wrote++
      } catch { /* 单步失败不影响其它 */ }
    }
    if (wrote || skipped) {
      event('route-steps', { steps: wrote, skipped, mode: isAppend ? 'append' : 'plan' })
      if (wrote) log(`fr_route：写出 ${wrote} 个步骤文件${skipped ? `（跳过 ${skipped} 个已存在/已完成）` : ''}`)
    }
    if (wrote && !isAppend) {
      // ★ 2026-11-07：**append 模式跳过这段清理**。
      //   原逻辑会删掉「编号 > 本批最大步号」的残留步骤。在 append 模式下，
      //   本批只写 S6/S7，maxK2=7；而盘上若已有 S8/S9（上一批补的），会被误删。
      //   清理只在 plan（全量重规划）时才有意义。
      //   上一轮多出来的 S<maxK+1>… 会留在盘上。上一轮 S1..S8 / 本轮 S1..S3 时，
      //   前台跑完 S3 会被投递**上一轮的 S4**，等于跨任务串味（做错事、白烧 token）。
      //   规则：只清理编号 > 本轮最大步号的尾部残留（不动本轮之前的已执行步骤，避免
      //   后台"只重发剩余步骤"的重规划被误删）。
      try {
        const maxK2 = st.reduce((max, x) => Math.max(max, D.stepNo(String(x.id)) || 0), 0)
        const staleDir = join(boardDir, 'stale')
        let moved = 0
        for (const f of readdirSync(P.stepsDir)) {
          if (!/^S\d+\.md$/.test(f)) continue
          const k = D.stepNo(f)
          if (!k || k <= ovd.pruneAbove) continue
          try {
            if (!existsSync(staleDir)) mkdirSync(staleDir, { recursive: true })
            renameSync(join(P.stepsDir, f), join(staleDir, `S${k}.${Date.now()}.md`))
            moved++
          } catch { /* 单文件失败忽略 */ }
          try { K.seenSteps.delete(f) } catch { /* 忽略 */ }
        }
        if (moved) {
          event('steps-pruned', { moved, keepMax: maxK2 })
          log(`fr_route：清理上一轮遗留步骤 ${moved} 个（>S${maxK2}，已移入 stale/）`)
        }
      } catch { /* 清理失败不影响本轮 */ }
      // ★ 新路线到达 ⇒ 重置进度（防呆）
      //   实测事故：上一轮 state.md 残留 done: S4 / status: done，后台本轮写了 S1-S4，
      //   插件按 "S<done+1>" 找 S5 ⇒ 永远没有可投步骤 ⇒ 前台空等「等待步骤」。
      try {
        const stNow = D.readState()
        const doneNo = D.stepNo(stNow.done || '')
        const maxK = Math.max(...st.map((x) => D.stepNo(String(x.id)) || 0), wrote, 0)
        if (ovd.reset) {
          D.writeAtomic(P.state, `planVersion: 0
status: working
done: S0
assumesMatch: yes
routeOk: yes
`)
          event('state-reset', { from: String(stNow.done || ''), reason: 'new-route' })
          log('新路线到达 ⇒ 进度重置（done ' + String(stNow.done || '-') + ' -> S0）')
        }
      } catch (e) { log('state reset fail: ' + e.message) }
    }
    // ★★ 2026-11-07 修复：route 写入后**立即**检查里程碑缺口，不等 30s tick。
    //   事故：tick 是 30 秒一次，而短任务（L1-L3）从 route 到归档只要 19 秒
    //   ⇒ checkLookahead 一次都没跑到 ⇒ 后台只写 2 步就再没人催 ⇒ 里程碑 4 个只兑现 2 个。
    //   实测：23 次归档 18 次有缺口，全库 milestone-gap 事件 0 条（催补从未生效）。
    //   现在在这里同步触发一次（不等下一 tick），并用 setTimeout 让投递逻辑先跑完。
    //   ★ 2026-11-07 二次修正：判据必须用**盘上的总步数**，不能用本批 st.length。
    //     append 模式下本批只写 2 步，但盘上可能已有 6 步 ⇒ 用 st.length 会误判为有缺口。
    let totalOnDisk = 0
    try { totalOnDisk = readdirSync(P.stepsDir).filter(f => /^S\d+\.md$/.test(f)).length } catch { /* 忽略 */ }
    if (wrote && ms.length > totalOnDisk && !judgePendingOnDisk()) {
      event('route-gap-immediate', { milestones: ms.length, stepsOnDisk: totalOnDisk, batch: st.length, mode: isAppend ? 'append' : 'plan' })
      log(`fr_route：里程碑 ${ms.length} > 盘上步骤 ${totalOnDisk}，立即排程催补（不等 tick）`)
      try { setTimeout(() => { try { checkLookahead() } catch (e) { log('即时催补失败: ' + e.message) } }, 3000) } catch { /* 忽略 */ }
    }
    return { ok: true, mode: isAppend ? 'append' : 'plan', chars: body.length, milestones: ms.length, sentinels: sn.length, stepsWritten: wrote, stepsSkipped: skipped }
  }

  /** ⑤ 自动补全：后台没写「## 里程碑」段时，插件按 steps 数量自动补上（不依赖 LLM 遵守） */
  function ensureRouteMilestones () {
    try {
      if (!existsSync(P.route)) return
      const t = D.readIf(P.route)
      if (!t) return
      if (/^##[^\n]*里程碑/m.test(t)) return          // 已有 → 不动
      let names = []
      try { names = readdirSync(P.stepsDir).filter(f => /^S\d+\.md$/.test(f)) } catch { names = [] }
      if (!names.length) return
      names.sort((a, b) => D.stepNo(a) - D.stepNo(b))
      const add = ['', '## 里程碑（插件自动补全）', ...names.map((f, i) => `- M${i + 1}（S${D.stepNo(f)}）：见 steps/${f}`)]
      D.writeAtomic(P.route, t.replace(/\s*$/, '') + '\n' + add.join('\n') + '\n')
      event('route-autofill', { milestones: names.length })
      log(`route 自动补全：补了 ${names.length} 个里程碑（后台没写）`)
    } catch { /* 忽略 */ }
  }

  /** ★ 2026-11-15 后台可选看前台思维链：取前台会话 reasoning 尾部（复核/判断唤醒附引用） */
  function frontThoughtTail (maxChars) {
    try {
      if (!K.front || !K.front.session || !K.front.session.snapshotEvents) return ''
      const evs = K.front.session.snapshotEvents()
      const win = evs.slice(-120)
      let buf = ''
      for (let i = win.length - 1; i >= 0 && buf.length < maxChars; i--) {
        const ev = win[i].event || win[i]
        if (!ev || ev.type !== 'assistant/message') continue
        const content = (ev.data && ev.data.message && ev.data.message.content) || []
        for (const p of content) {
          if (p && /reason|think/i.test(String(p.type)) && p.text) buf = String(p.text) + '\n' + buf
        }
      }
      return buf.slice(-maxChars)
    } catch { return '' }
  }

  /** ★ 2026-11-15 闭环守卫：判断点停牌期间禁止催补。
   *  否则「判断点停写」（steps 停在 judge 步 < milestones）会被 milestone-gap
   *  强制催补打破——后台被迫写出依赖现场结果的后续步，停写形同虚设。 */
  function judgePendingOnDisk () {
    if (K.judgeWaiting) return true
    try {
      const doneNo = D.stepNo(D.readState().done || '')
      return D.listSteps().some((f) => {
        const k = D.stepNo(f)
        if (k <= doneNo) return false
        try { return D.parseStepMeta(D.readIf(join(P.stepsDir, f))).judge } catch { return false }
      })
    } catch { return false }
  }

  function checkLookahead () {
    const st = D.readState()
    const doneNo = D.stepNo(st.done || '')
    const steps = D.listSteps().map(D.stepNo)
    if (!steps.length) return            // 还没有路线，不催
    // ★★ 2026-11-07 顺序修复：**缺口检查必须放在 hasDeliver 之前**。
    //
    // 原顺序：if (hasDeliver()) return   →  再做缺口检查
    // 后果：deliver 一旦存在（哪怕上一轮残留、哪怕只兑现了 2/4 个里程碑），
    //      缺口检查就被短路，催补永不触发。
    // 实测：黑板残留 deliver.v1.md 时，10 轮强制编排里 milestone-gap 事件 0 条。
    //
    // 语义修正：**交付 ≠ 规划完成**。deliver 只表示"前台说活干完了"，
    // 不代表后台列的 milestones 都兑现了。缺口还在就必须继续催，与 deliver 无关。
    const ms = routeMilestoneCount()
    if (ms > steps.length && judgePendingOnDisk()) {
      event('gap-deferred-judge', { milestones: ms, steps: steps.length, done: doneNo })
      return                              // 判断点未决：缺口是"故意停写"，不催
    }
    if (ms > steps.length) {
      if (K.milestoneGapCount < 3) {
        K.milestoneGapCount++
        wakeBack('need-next', `【补步】route.md 列了 ${ms} 个里程碑，但 steps 只有 ${steps.length} 个（[${steps.map(n => 'S' + n).join(',')}]，done=S${doneNo}）。请补写缺失的步骤文件 —— **每个里程碑必须对应一个步骤**，写完即停。`)
        event('milestone-gap', { milestones: ms, steps: steps.length, done: doneNo, attempt: K.milestoneGapCount })
        log(`规划闭环：里程碑 ${ms} > 步骤 ${steps.length}，已催后台补步（第 ${K.milestoneGapCount} 次）`)
      }
      return
    }
    K.milestoneGapCount = 0                  // 缺口补齐 → 计数归零
    // 缺口已补齐后，才轮到"已交付就收工"的短路
    if (D.hasDeliver()) return
    const maxNo = Math.max(...steps)

    // ══ ★★ 2026-11-07 改动 4：合并「预取(prefetch)」与「催单(need-next)」两条重叠规则 ══
    //
    // 原实现有两条独立规则，判据重叠：
    //   ① remain <= watermark        → prefetch（水位不足就预取）
    //   ② doneNo+1 缺料              → need-next（真的断了才强力催）
    // 实测后果：同一个需求被催两次（`+16.9s need-next` 与 `+18.0s need-next` 间隔仅 1.1s）。
    //
    // 现在合并成一条统一判据：**前台在跑 + 后台空闲 + 未交付 + 缓冲不足(<=水位)**。
    // 冷却时间由 prefetchCooldownFor 决定（有缺口 2s / 常规 5s），是"防重复唤醒"而不是"控制节奏"。
    //
    // 为什么不加"未完成就无限催"：实测后台响应中位仅 7 秒、前台单步中位 8.2 秒，
    // 后台从来不慢，问题在"每次催都要完整重规划"——那个已由 mode=append 解决（改动 1）。
    // 所以这里只需要在"缓冲不足"时催，不必更激进。
    const remain = steps.filter(n => n > doneNo).length
    const frontBusy = !!(K.front && K.front.phase && K.front.phase.kind === 'running')
    const backBusy = !!(K.back && K.back.phase && K.back.phase.kind === 'running')
    const watermark = D.prefetchWatermark()
    const now = Date.now()

    if (frontBusy && !backBusy && remain <= watermark) {
      const cd = prefetchCooldownFor(ms, steps.length, remain)
      if (now - K.lastPrefetchAt >= cd) {
        K.lastPrefetchAt = now
        // 断粮（前方一步都没有）用更强的措辞，其余用"预规划"措辞
        const starving = remain === 0
        const nextNo = maxNo + 1
        wakeBack('need-next',
          starving
            ? `【催单·断粮】前台 done=S${doneNo}，steps 现有 [${steps.map(n => 'S' + n).join(',')}]，**前方已无步骤**。` +
              `请立刻用 ${D.TN('fr_route')}({mode:"append", steps:[...]}) 补写 S${nextNo} 起的新步骤（至少 2 步，自包含、含可验收判据）。` +
              `**不要写 deliver**。`
            : `【预规划·流水线】前台正在跑（done=S${doneNo}，前方仅剩 ${remain} 个未执行步骤 <= 水位 ${watermark}）。` +
              `请用 ${D.TN('fr_route')}({mode:"append", steps:[...]}) 从 S${nextNo} 起补到至少 ${watermark} 步缓冲。` +
              `**已存在的步骤不要重写**（append 模式会自动跳过）。**不要写 deliver**。`)
        event(starving ? 'need-next-starvation' : 'prefetch', { done: doneNo, remain, maxNo, watermark, maxSteps: ms })
        log(`统一催补：${starving ? '断粮' : '缓冲不足'}（remain=${remain}, watermark=${watermark}, maxNo=S${maxNo}）`)
        return
      }
    }
    // 前台没在跑（或后台正忙）⇒ 本轮不催，等下一 tick
  }

  // ── B6 新步骤到达 → steer 前台并把指令内联（E1） ────────────────────────
  // #3 修复（2026-10-17 实测竞态）：后台是"先写占位、再补内容"的，原实现只要**文件名出现**
  // 就投递，结果把 11 字节的 "placeholder" 当成步骤指令投给了前台。
  // 现在三条件：① 内容够长（非占位）② 文件已稳定（mtime 距今 > SETTLE_MS）③ 内容指纹变化才重投。
  const MIN_STEP_CHARS = 120
  const SETTLE_MS = 5000

  // ── M19 批量步骤清单：后台写一个 BATCH 文件，插件拆成 steps/S<k>.md ─────────
  // 背景：后台逐个写 steps/S<k>.md 要 N 次响应（每次 10-30s）。改成**一次响应**写一个
  // BATCH.md（含多条 `## S<k>` 段），插件拆开 ⇒ 后台产出速度提升到 N 倍。
  function splitBatchFile () {
    let files = []
    try { files = readdirSync(P.stepsDir).filter(f => /^BATCH.*\.md$/i.test(f)) } catch { return 0 }
    if (!files.length) return 0
    let created = 0
    for (const f of files) {
      const full = join(P.stepsDir, f)
      let body = ''
      try {
        body = readFileSync(full, 'utf8')
        if (Date.now() - statSync(full).mtimeMs < 3000) continue   // 还在写，下一轮再拆
      } catch { continue }
      const parts = body.split(/^[ \t]*##[ \t]*S(\d+)[ \t]*$/m)
      for (let i = 1; i + 1 < parts.length; i += 2) {
        const k = Number(parts[i])
        const content = String(parts[i + 1] || '').trim()
        if (!k || content.length < 40) continue
        const target = join(P.stepsDir, `S${k}.md`)
        if (existsSync(target)) continue                          // 不覆盖已存在的步骤
        if (D.writeAtomic(target, `# S${k}\n${content}\n`)) {
          created++
          // ★ 重要：新生产出来的步骤必须清掉 seenSteps 指纹，否则内容与上一批相同的步骤
          //   会被"已投递过"去重逻辑拦住，永远不投给前台（实测踩过）。
          try { K.seenSteps.delete(`S${k}.md`) } catch { /* 忽略 */ }
          event('batch-split', { batch: f, step: `S${k}`, chars: content.length })
        }
      }
      // 标记已处理（移到 stale/ 保留审计，避免重复拆分）
      try { mkdirSync(join(boardDir, 'stale'), { recursive: true }) } catch { /* 已存在 */ }
      try { renameSync(full, join(boardDir, 'stale', f + '.' + Date.now())) } catch { /* 忽略 */ }
    }
    if (created) log(`M19 批量清单拆分：新增 ${created} 个步骤`)
    return created
  }

  /** 后台分诊否决：verdict.md 里写「short: 理由」= 这任务不值得编排，让前台自己做 */
  function checkVerdict () {
    const vFile = join(boardDir, 'verdict.md')
    // ★★ 2026-11-08 灰区分诊回执：这轮是"灰区 → quick + 后台分诊"启动的，
    //   若后台**没写 verdict 而是写了 route** ⇒ 它判定需要编排 ⇒ 让前台切过去。
    //   这是"前台先干、后台并行判"闭环的最后一环。
    try {
      if (K.lastTriage && K.lastTriage.tend === 'gray' && !K.lastTriage.settled) {
        const routeNow = existsSync(P.route) ? statSync(P.route).mtimeMs : 0
        if (routeNow > K.lastTriage.at) {
          K.lastTriage.settled = 'upgraded'
          event('triage-upgraded', { score: K.lastTriage.score })
          log('灰区分诊：后台写了 route ⇒ 判定需要编排，切 coding 并引导前台按步骤走')
          try { D.MA.applyMode('coding', 'auto', 'triage-upgraded') } catch { /* 忽略 */ }
          steerFront('【后台分诊：需要编排】后台判定这任务确实需要编排，路线已写好。\n' +
            '**现在按 .board/steps/ 里的步骤继续做**；你已完成的改动保留，不要重做。', 'triage-upgrade')
          return
        }
      }
    } catch { /* 忽略 */ }

    const raw = D.readIf(vFile).trim()
    if (!raw || raw === K.verdictSeen) return
    // ★ 修复（2026-10-24）：verdict 可能是**上一个任务**遗留的文件（实测本机 board 里有
    //   10-17 的旧 verdict；route 已到 10-18）。这种旧分诊在重启后会被重新应用，
    //   直接告诉前台「这任务不值得编排，你自己干」—— 等于废掉双会话。
    //   判据：verdict 的 mtime 必须晚于**本任务起点**（最近一次 api-task / deliver / escalate）。
    let vMtime = 0
    try { vMtime = statSync(vFile).mtimeMs } catch { /* 文件刚被删 */ }
    let taskStart = 0
    for (const line of tailLines(P.events, 300)) {
      try {
        const o = JSON.parse(line)
        if (o.kind !== 'api-task' && o.kind !== 'deliver' && o.kind !== 'escalate') continue
        const at = Date.parse(o.at) || 0
        if (at > taskStart) taskStart = at
      } catch { /* 坏行跳过 */ }
    }
    if (vMtime <= taskStart) {
      K.verdictSeen = raw            // 记下内容，避免每次 tick 重复判定
      event('verdict-stale', { verdictMtime: vMtime, taskStart, why: '旧任务遗留的 verdict，忽略' })
      log('判定：verdict.md 早于本任务起点 ⇒ 视为陈旧分诊，忽略')
      return
    }
    K.verdictSeen = raw
    const m = raw.match(/^short\s*[:：]\s*(.+)$/im)
    if (!m) return
    const why = m[1].slice(0, 160)
    // ★ 尊重用户显式要求（2026-10-18 实测）：用户说「调度后台 / 走编排 / 多步」时
    //   不接受后台的「短任务」分诊 —— 否则后台一旦判短就不再规划，
    //   用户看到的就是"疑似没拉起后台"。
    try {
      const handoff = D.readIf(join(boardDir, 'handoff.md'))
      const userWant = /(调度后台|走后台|走编排|必须调度|需要后台|多步|规划路线)/.test(handoff)
      if (userWant) {
        event('verdict-short-overruled', { why: why.slice(0, 80) })
        log('后台判短任务，但用户显式要求走编排 ⇒ 忽略分诊，继续等路线')
        return
      }
    } catch { /* 忽略 */ }
    // ★ O2 自适应批量：后台判为短任务 ⇒ 一次多给几条步骤（简单任务不必逐条验证）
    cfg.batchSteps = Math.max(cfg.batchSteps || 2, 5)
    event('batch-adapt', { batchSteps: cfg.batchSteps, why: 'verdict-short' })
    steerFront(`【后台分诊：短任务】${why}\n判定：这个任务不值得走编排。**你自己直接做完并交付**，不要等步骤；做完把 state.md 的 status 写成 done。`, 'verdict-short')
    event('verdict-short', { why })
    log('后台判为短任务，已让前台自己做: ' + why)
  }

function annotateSteps () {
  try {
    const st = D.readState()
    const routeVer = st.planVersion || '1'
    const files = readdirSync(P.stepsDir).filter(f => /^S\d+\.md$/.test(f)).sort()
    let prev = null
    for (const f of files) {
      const full = join(P.stepsDir, f)
      let body = ''
      try { body = readFileSync(full, 'utf8') } catch { continue }
      if (body.includes('fr-meta:')) { prev = f; continue }
      const meta = '<!-- fr-meta: route:v' + routeVer + ' based:' + (prev || 'route') + ' at:' + new Date().toISOString() + ' -->\n'
      try { writeFileSync(full, meta + body, 'utf8'); prev = f } catch { /* ignore */ }
    }
  } catch { /* 注释失败不影响主流程 */ }
}

function checkNewSteps () {
    let files = []
    try { files = readdirSync(P.stepsDir).filter(f => /^S\d+\.md$/.test(f)) } catch { return }
    // ★ Phase 3 停牌：等后台判断（judge.ok 出现才继续，'fr_poke resolve' / 后台写文件均可解除）
    if (K.judgeWaiting) {
      if (existsSync(D.judgeFile)) {
        K.judgeWaiting = false
        event('judge-resolved', {})
        log('停牌解除：judge.ok 已就绪，继续投递')
      } else return
    }
    const doneNo = D.stepNo(D.readState().done || '')
    // ★ §22 优化①：任务级批量覆盖优先（编号步骤任务一次投全批）
    const batch = Math.max(D.effectiveBatch(), K.taskBatchOverride || 0)
    const picked = []
    // 只从 S(done+1) 起、连续取 batch 条（跳号一律不投，避免"路线断裂"）
    for (let n = doneNo + 1; n <= doneNo + batch; n++) {
      const f = `S${n}.md`
      if (!files.includes(f)) break
      const full = join(P.stepsDir, f)
      let body = ''
      let mtime = 0
      try { body = readFileSync(full, 'utf8'); mtime = statSync(full).mtimeMs } catch { break }
      if (body.trim().length < MIN_STEP_CHARS) break       // ① 占位/未写完
      if (Date.now() - mtime < SETTLE_MS) break            // ② 还在写
      const h = `${body.length}:${body.slice(0, 60)}:${body.slice(-60)}`
      if (K.seenSteps.get(f) === h) break                    // ③ 已投过
      const meta = D.parseStepMeta(body)
      // ★ Phase 2 依赖：depends 里的步号还没完成 ⇒ 降级串行（等它完成，不跳号、不卡死）
      if (meta.depends.length) {
        const missing = meta.depends.filter(d => d > doneNo)
        if (missing.length) {
          event('dep-blocked', { file: f, missing })
          break
        }
      }
      picked.push({ f, body, h, meta })
      // ★ Phase 3 停牌步骤：只投它自己，后续等 judge.ok
      if (meta.judge) break
    }
    if (!picked.length) return
    // ★ M1（拉取模式）：前台**正在跑**时不推送 —— 它干完会自己读 steps/S<k+1>.md。
    //   只有前台**空闲**且下一步已就绪时才推（防 stall，守住"及时响应"这个 KPI）。
    if (cfg.pullSteps) {
      const busy = K.front && K.front.phase && K.front.phase.kind === 'running'
      if (busy) {
        // ★ 实测竞态（2026-10-17）：新步骤落盘时前台正好在收尾（相差 31ms），
        //   这里一 return 就再也没有文件事件了，下一步要等 30s tick 才可能投递 ⇒ 任务卡住。
        // ★★ 2026-10-18 修复（严重）：原来只安排 6 次 ×1.2s = 7.2s 的延迟重试，
        //   而前台跑一步通常 20-60s ⇒ 重试耗尽后**永远不再投递**，
        //   实测表现为 watcher-fire 三次但 step-delivered 为 0、前台一直 running 空转。
        //   现在：重试窗口内快速重试；窗口耗尽后交给 nextDeliverRetryAt 由 30s tick 继续兜底，
        //   直到前台空闲或步骤被投递，绝不永久放弃。
        if (K.deliverRetry < 6) {
          K.deliverRetry++
          setTimeout(() => {
            K.deliverRetry--
            try { if (D.alive()) checkNewSteps() } catch { /* 忽略 */ }
          }, 1200)
        } else {
          // 重试预算用尽：标记一个"待投递"，由 tick 在下一轮继续尝试（不丢）
          K.pendingDeliver = true
          if (!K.pendingDeliverLogged) {
            K.pendingDeliverLogged = true
            log('投递等待中：前台仍在运行，已转入 tick 兜底（不会丢失）')
            event('deliver-deferred', { files: picked.map(p => p.f) })
          }
        }
        return
      }
      K.deliverRetry = 0
      K.pendingDeliver = false
      K.pendingDeliverLogged = false
    }
    for (const p of picked) K.seenSteps.set(p.f, p.h)
    // ★ 投递 S1（= 新任务起点）时重置本任务计数，避免 H5 跨任务累计永久误报
    if (picked.some(p => p.f === 'S1.md')) {
      K.stepsThisTask = 0
      K.alertedSentinels.clear()
      K.finalAuditRetry = 0
      K.lastAuditedDeliverKey = ''
      K.taskWakes = 0
      K.taskFreezes = 0
      K.budgetAlerted = false
      K.changedFiles.clear()
      K.diffReviewCount = 0
      K.lastDiffReviewAt = 0
      K.lastTodoKey = ''
      K.finalAsked = false
      // 每任务重置"调用契约错"的提示与前台最近动作，避免跨任务串味
      try {
        D.toolStats.callErrHinted.clear()
        D.toolStats.callErrStreak = 0
        D.toolStats.lastCallErrName = ''
        D.toolStats.recent.length = 0
      } catch { /* 忽略 */ }
      D.resetTaskScheduler()
      // ★ §25 优化A：override 不在 S1 清零——任务级保持（整个任务期间大 batch）
      //   清零时机移到"新任务文本到达"（api-task 的 resetTaskScheduler 前）
    }
    // ★ Phase 3 停牌：本批最后一步要求人工/后台判断 ⇒ 投出后等待 judge.ok
    const judgeStep = picked.find(p => p.meta && p.meta.judge)
    if (judgeStep) {
      K.judgeWaiting = true
      try { if (existsSync(D.judgeFile)) unlinkSync(D.judgeFile) } catch { /* 忽略 */ }
      const jThought = cfg.backSeeFrontThought ? frontThoughtTail(1500) : ''
      wakeBack('judge', `【需要判断】步骤 ${judgeStep.f.replace('.md', '')} 需要先判断再继续。请读该步骤与 state.md，把结论写进 .board/verdict.md（格式 \`judge: 允许|不允许 <理由>\`），并在通过时写一个空文件 .board/judge.ok（不允许就别写，直接说明原因）。` + (jThought ? `\n\n【前台近期思维（供判断参考）】\n${jThought}` : ''))
      event('judge-wait', { step: judgeStep.f.replace('.md', '') })
      log(`停牌：${judgeStep.f} 等后台判断（judge.ok）`)
    }
    const names = picked.map(p => p.f.replace('.md', ''))
    const parts = picked.map(p => `=== ${p.f.replace('.md', '')} ===\n${p.body.slice(0, 1200)}`)
    const head = cfg.pullSteps
      ? `【步骤就绪：${names.join(' / ')}】执行后**立刻自己读 .board/steps/ 下的下一步**接着干，不要等推送。`
      : `【计划就绪：${names.join(' → ')}】按顺序执行，**每完成一步就把 state.md 的 done 更新成该步号**。`
    // ★★ 2026-11-07 删除「并行组 P1」机制（三个事实证明它无用）：
    //   ① 后台**从未标过**并行组（归档 3 份，0 处「并行组」字段）
    //   ② 投递逻辑**不看**它 —— checkNewSteps 只按步号连续取，不按组投递
    //   ③ 前台**本来就会自己并行** —— L4 r2 实测有 7 批并行工具调用，全由前台自己判断
    //   所以「消息里加一句 ⚡ 并行组提示」这一环可有可无，保留只是噪音。
    steerFront(`${head}\n\n${parts.join('\n\n')}`, 'new-step')
    K.finalAsked = false   // ★ 新步骤到达 ⇒ 重置终局守卫（否则第二次清单耗尽时不会再触发终局询问）
    K.finalAnswerAsked = false   // 新步骤到达 ⇒ 重置终局正文守卫
    event('step-delivered', { files: names, chars: picked.reduce((s, p) => s + p.body.length, 0) })
    for (const p of picked) D.attribute({ step: p.f.replace('.md', ''), role: 'front', trigger: 'deliver', ok: true })
    vlog('step-delivered', { files: names, batch: picked.length })
    queueTodoSync('step-delivered')
    try { D.observeDeliveryForAdapt() } catch { /* 自适应失败不影响投递 */ }
    // ★ 事件驱动预规划（2026-10-18 修复）：
    //   实测问题：后台一次只给 4 步、前台 40s 跑完，而预取检查只挂在 30s tick 上，
    //   两者撞不上 ⇒ 用户观测到"后台不提前生成"。
    //   现在每次投递后**立刻**算一次缓冲，不够就马上唤醒后台补下一批（自带冷却）。
    try {
      if (cfg.pipelinePrefetch !== 0) {
        const stNow = D.readState()
        const doneNow = D.stepNo(stNow.done || '')
        const allNow = D.listSteps().map(D.stepNo)
        const maxNow = allNow.length ? Math.max(...allNow) : 0
        const remainNow = allNow.filter((n) => n > doneNow).length
        const watermark = D.prefetchWatermark()
        // ★ 2026-11-07：预取提示要带上缺口，否则后台不知道还差几步
        const msNow = routeMilestoneCount()
        const backBusyNow = !!(K.back && K.back.phase && K.back.phase.kind === 'running')
        const now2 = Date.now()
        // ★ 2026-11-07：缺口驱动冷却 + 交付不该挡住"补缺口"
        //   原条件 `&& !hasDeliver()` 会在有 deliver 时彻底停掉预取 ——
        //   但缺口（ms > steps）恰恰是最需要补的时候，与是否交付无关。
        const gapNow = msNow > allNow.length
        const cd2 = prefetchCooldownFor(msNow, allNow.length, remainNow)
        if (!backBusyNow && remainNow <= watermark && now2 - K.lastPrefetchAt >= cd2 && (!D.hasDeliver() || gapNow)) {
          K.lastPrefetchAt = now2
          // ★ Phase 2 收尾：预读提示（纯提示，不实际读；从剩余步骤正文里抠路径）
          let prereadHint = ''
          if (cfg.preread !== false) {
            try {
              const remainFiles = readdirSync(P.stepsDir).filter(f => /^S\d+\.md$/.test(f) && D.stepNo(f) > doneNow).slice(0, 2)
              const paths = []
              for (const f of remainFiles) {
                try { paths.push(...extractPaths(readFileSync(join(P.stepsDir, f), 'utf8'), 3)) } catch { /* 忽略 */ }
              }
              const uniq = [...new Set(paths)].slice(0, 5)
              if (uniq.length) {
                // [#5 预读落地] 把候选路径写进 .board/preread.md，供前台/后续步骤直接引用（preread-cache）
                try { D.writeAtomic(join(boardDir, 'preread.md'), '# 预读候选（只读提示）\n\n' + uniq.join('\n') + '\n') } catch { /* 忽略 */ }
                prereadHint = '\n【可选·预读】先把这些可能用到的文件**只读**看一遍（别改），清单也已写进 .board/preread.md：' + uniq.join('、')
              }
            } catch { /* 忽略 */ }
          }
          wakeBack('prefetch', `【预规划·流水线】刚投递 ${names.join(',')}（done=S${doneNow}，前方仅剩 ${remainNow} 步）。` +
            `请在后台**提前规划后续步骤**（从 .board/steps/S${maxNow + 1}.md 起，补到至少 ${watermark} 步缓冲）；` +
            `已存在的步骤不要重写。` +
            // ★ 2026-11-07 修复：与上一处同理 —— 预规划阶段绝不引导写 deliver。
            `**不要写 deliver**（deliver 只由终局复核触发）。` +
            (msNow > allNow.length ? `route 列了 ${msNow} 个里程碑但只有 ${allNow.length} 个步骤，请补全缺口。` : '') +
            `写完即停。` + prereadHint)
          event('prefetch', { done: doneNow, remain: remainNow, maxNo: maxNow, trigger: 'step-delivered' })
          log(`流水线预规划（投递后即时）：剩余 ${remainNow} 步 <= 水位 ${watermark}，已唤醒后台补步`)
        }
      }
    } catch (e) { log('post-deliver prefetch fail: ' + e.message) }
  }

  return { wakeCount, noteWakeBudget, prefetchCooldownFor, pendingWakeBatch, flushWakeBatch, WAKE_POLICY, appendToolSummary, resultErrorText, CALL_CONTRACT_RE, isCallContractError, wakeBack, steerFront, buildTodoSnapshot, syncTodos, maybeReviewDiff, queueTodoSync, synthHeartbeat, startStepsWatcher, routeMilestoneCount, routeAcceptance, buildFinalPrompt, deliverAudit, checkFinalAudit, renderRoute, ensureRouteMilestones, frontThoughtTail, judgePendingOnDisk, checkLookahead, MIN_STEP_CHARS, SETTLE_MS, splitBatchFile, checkVerdict, annotateSteps, checkNewSteps }
}
