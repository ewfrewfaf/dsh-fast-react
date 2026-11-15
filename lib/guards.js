/**
 * guards.js —— 机械守卫：看门狗 / T3 拦截 / 哨兵冻结 / 首帧兜底 / 上下文守护 / 档位漂移 / 业务哨兵
 * 从 lib/index.js 抽出的第 1 阶段模块（行为不变 refactor）。
 *
 * 依赖（D 依赖袋，字段调用时读取）：
 *   稳定字段（工厂顶部解构）：K cfg ctx log vlog event TAG BASE_PATH boardRoot boardDir P BB
 *   惰性字段：alive listSteps readIf readState steerFront stepNo toolStats wakeBack writeAtomic
 *   K 共享状态：见 index.js 的 K 袋（本模块读写的跨模块可变状态全部经 K）。
 *
 * 区块地图：
 *   看门狗：lastUserText / lastAssistantText / checkStall（stallTimer 注册留在 index 原位）
 *   T3：isDestructive / hasConfirm（K.t3Blocked 初始化留在 index）
 *   机械哨兵：sentinelState（模块私有）/ freezeFront / runSentinels
 *   首帧兜底：checkFirstFrame（K.firstFrameNudgedAt 初始化留在 index）
 *   上下文守护：checkContextBudget（svcMeter/svcCompaction inject 与 K.lastCompactAt 留在 index）
 *   B10 档位漂移：setEffort（K.curEffort 初始化留在 index）
 *   B12 业务哨兵：readSentinels / evalSentinel / runBusinessSentinels（B11 度量落盘整段留在 index）
 *   api：listPendingConfirms / approveConfirm / rejectConfirm
 */

import { DESTRUCTIVE } from './policies.js'
import { join } from 'node:path'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { tailLines } from './api.js'
import { msg } from './briefs.js'
import { evalSentinel as evalSentinelPure, parseSentinels } from './route-plan.js'

export function makeGuards (D) {
  const { cfg, ctx, log, vlog, event, TAG, BASE_PATH, boardRoot, boardDir, P, BB, K } = D

  /** 取该会话最后一条**真人**消息（跳过【系统】/<注入> 话术） */
  function lastUserText (agent) {
    try {
      const evs = (agent.session && agent.session.snapshotEvents && agent.session.snapshotEvents()) || []
      for (let i = evs.length - 1; i >= 0; i--) {
        const e = evs[i], ev = e.event || e
        if (!ev || ev.type !== 'user/message') continue
        const d = ev.data || {}
        const parts = d.content || (d.message && d.message.content) || []
        let t = ''
        if (Array.isArray(parts)) for (const p of parts) { if (p && p.type === 'text' && p.text) t += p.text }
        t = String(t || '').trim()
        if (!t) continue
        if (t.charAt(0) === '【' || t.charAt(0) === '<') continue
        return t
      }
    } catch { /* 忽略 */ }
    return ''
  }

  /** 取该会话最后一条 assistant 回复的正文（用于判断"终局有没有真的交付"） */
  function lastAssistantText (agent) {
    try {
      const evs = (agent.session && agent.session.snapshotEvents && agent.session.snapshotEvents()) || []
      for (let i = evs.length - 1; i >= 0; i--) {
        const e = evs[i], ev = e.event || e
        if (!ev || ev.type !== 'assistant/message') continue
        const d = ev.data || {}
        const parts = d.content || []
        let t = ''
        if (Array.isArray(parts)) for (const x of parts) { if (x && x.type === 'text' && x.text) t += x.text }
        if (!t && typeof d.text === 'string') t = d.text
        return String(t || '').trim()
      }
    } catch { /* 忽略 */ }
    return ''
  }

  function checkStall () {
    if (!cfg.stallWatchdog || !K.front) return
    try {
      const phase = (K.front.phase && K.front.phase.kind) || ''
      if (phase !== 'running') { K.prevFrontPhase = phase; return }
      if (K.prevFrontPhase !== 'running') {          // 新一轮开始：重置基线
        K.prevFrontPhase = 'running'
        K.turnStartAt = Date.now()
        K.lastToolAt = 0
        return
      }
      const idleMs = Date.now() - Math.max(K.turnStartAt, K.lastToolAt)
      if (idleMs < cfg.stallTimeoutMs) return
      const hadTool = K.lastToolAt > 0
      event('stall-kill', { role: 'front', idleMs, hadTool })
      log(`看门狗：前台僵死 ${Math.round(idleMs / 1000)}s（hadTool=${hadTool}）→ cancel`)
      try { K.front.cancel(new Error('stall watchdog')) } catch (e) { log('看门狗 cancel 失败: ' + e.message) }
      K.prevFrontPhase = ''
      if (cfg.stallSafeRetry && !hadTool) {
        const txt = lastUserText(K.front)
        if (txt) {
          setTimeout(() => {
            try { D.steerFront(txt, 'stall-retry'); event('stall-retry', { chars: txt.length }); log('看门狗：本轮未动手，已安全重投') } catch (e) { log('看门狗重投失败: ' + e.message) }
          }, 1500)
        }
      }
    } catch (e) { log('checkStall fail: ' + e.message) }
  }

  function isDestructive (name, args) {
    if (!/^(pwsh|bash)$/i.test(String(name))) return null
    const cmd = String((args && (args.command || args.cmd)) || '')
    for (const re of DESTRUCTIVE) if (re.test(cmd)) return cmd.slice(0, 300)
    return null
  }

  function hasConfirm (stepId) { return BB.hasConfirm(stepId) } /* 单份实现：board.js */

  // ── B7 机械哨兵（零 LLM） ───────────────────────────────────────────────
  const sentinelState = { lastHeartbeatLen: -1, lastHeartbeatAt: Date.now(), lastSteps: 0, alerts: {} }

  // ── 哨兵命中 ⇒ 冻结前台 + 作废未执行步骤 ───────────────────────────────
  // 背景（2026-10-17 发现的缺口）：预取 N 步时，哨兵命中只会打断后台重估，
  // 但**前台会继续把剩下的过时步骤跑完** ⇒ 预取越深、跑错越远，而 DSH 没有回滚。
  // 做法：把 k > done 的 steps 移进 .board/stale/（不删，留审计），前台在跑时通知它停手。
  // 恢复：后台写出新步骤后，checkNewSteps 会自动让前台继续。
  function freezeFront (why) {
    let moved = 0
    try { K.taskFreezes++; event('freeze-budget', { n: K.taskFreezes }) } catch { /* 忽略 */ }
    try {
      const st = D.readState()
      const doneNo = D.stepNo(st.done || '')
      const staleDir = join(boardDir, 'stale')
      try { mkdirSync(staleDir, { recursive: true }) } catch { /* 已存在 */ }
      let names = []
      try { names = readdirSync(P.stepsDir).filter(f => /^S\d+\.md$/.test(f)) } catch { names = [] }
      for (const f of names) {
        if (D.stepNo(f) <= doneNo) continue
        try {
          renameSync(join(P.stepsDir, f), join(staleDir, f))
          K.seenSteps.delete(f)
          moved++
        } catch { /* 单个失败忽略 */ }
      }
      const running = !!(K.front && K.front.phase && K.front.phase.kind === 'running')
      if (running) {
        D.steerFront(`【冻结】哨兵命中：${String(why).slice(0, 140)}\n立刻停手，**不要再执行任何步骤**；后台给出新路线后会自动恢复。`, 'freeze')
      }
      try {
        const t = D.readIf(P.state)
        if (t && !/routeOk\s*:\s*no/i.test(t)) D.writeAtomic(P.state, t.replace(/\s*$/, '') + '\nrouteOk: no\n')
      } catch { /* 忽略 */ }
      event('freeze', { why: String(why).slice(0, 160), staleMoved: moved, frontRunning: running })
      vlog('freeze', { why: String(why).slice(0, 160), staleMoved: moved, frontRunning: running })
      log(`哨兵冻结：作废 ${moved} 个未执行步骤${running ? '，已通知前台停手' : ''}`)
    } catch (e) { log('freezeFront fail: ' + e.message) }
    return moved
  }

  function runSentinels () {
    if (cfg.sentinelEnabled === false) return []   // 总开关
    const alerts = []
    const frontRunning = K.front && K.front.phase && K.front.phase.kind === 'running'
    // ★ 无任务时不跑哨兵（2026-10-18 实测事故：用户只发了一句「你好」，
    //   但上一轮任务残留的 failStreak / 心跳基线 / 产物文件让 H3/H4/C1 连续命中，
    //   直接冻结前台并作废步骤 —— 纯对话根本不该触发编排水位哨兵）。
    const st0 = D.readState()
    const steps0 = D.listSteps()
    const hasActiveTask = steps0.length > 0 && D.stepNo(st0.done || '') < (steps0.length ? Math.max(...steps0.map(D.stepNo)) : 0)
    const busy = frontRunning || (K.back && K.back.phase && K.back.phase.kind === 'running')
    if (!hasActiveTask && !busy) {
      // 空闲对话场景：只清空历史告警标记，不产生任何 alert
      K.alertedSentinels.clear()
      return []
    }
    // H3 心跳停滞：前台在跑但 5 分钟没有新 heartbeat（基线是内存 lastBeatAt，不看文件旧行）
    const staleMs = Date.now() - K.lastBeatAt
    if (frontRunning && staleMs > (cfg.heartbeatStaleMs || 300000)) {
      alerts.push({ id: 'H3', why: `心跳停滞 ${Math.round(staleMs / 1000)}s` })
    }
    // H4 失败堆积：只在前台**真的在跑**时判定；
    //   任务结束后残留的 failStreak 不算（实测残留 5 次导致一句「你好」就被冻结）
    if (frontRunning && D.toolStats.failStreak >= cfg.failStreakMax) {
      alerts.push({ id: 'H4', why: `连续失败 ${D.toolStats.failStreak} 次` })
    }
    // H5 膨胀：步数超阈（★ 2026-10-18 实测事故：70 步的调研任务被 H5 判定"膨胀"并冻结，
    //   直接作废 6 步。步数多 ≠ 任务失控 —— 只应该在**同时伴随大量失败**时才算异常）
    if (K.stepsThisTask > cfg.taskStepMax && D.toolStats.failStreak >= 2) {
      alerts.push({ id: 'H5', why: `本任务步数 ${K.stepsThisTask} 超阈 ${cfg.taskStepMax}（且连续失败 ${D.toolStats.failStreak} 次）` })
    }
    // H7 已删除（2026-10-17 实测）：原逻辑拿 state.planVersion（路线版本号，如 1、2）
    // 和"步骤数量"（如 6、12）比大小 ⇒ 两者无可比性，任务一长必然误报，
    // 误报会触发 freezeFront 把**全部未执行步骤移到 stale**（实测一次误删 6 步）。
    // 真正的"路线版本撕裂"应由后台在 route.md 里自己维护，不靠机械哨兵猜。
    // ★ 去重：同一条哨兵只唤醒后台一次（实测 H5 会在步数超阈后**每 30s 唤醒一次**，白烧 token）
    const fresh = alerts.filter(a => !K.alertedSentinels.has(a.id))
    for (const a of fresh) {
      K.alertedSentinels.add(a.id)
      event('sentinel', a)
      log(`哨兵命中 ${a.id}: ${a.why}`)
      vlog('sentinel', { id: a.id, why: a.why, failStreak: D.toolStats.failStreak, steps: K.stepsThisTask })
    }
    if (fresh.length) {
      D.wakeBack('sentinel', `【哨兵】${fresh.map(a => a.id + ' ' + a.why).join('；')}。请读 .board/ 最新状态后决定是否调整计划。`)
      freezeFront(fresh.map(a => a.id + ' ' + a.why).join('；'))
    }
    return fresh
  }

  // ── P1 慢模型兜底：首帧超时 ────────────────────────────────────────────
  // 免费/慢模型下，后台出第一个 step 可能要几分钟，前台会干等。
  // 用事件日志判断（不引入新状态）：最后一次 escalate 之后没有任何 step-delivered，且已超时
  // ⇒ 让前台先做**只读侦察**（不猜任务、不写交付物），侦察结果写进 state.md 当后台的输入。
  function checkFirstFrame () {
    // ★ 尾部定向读（2026-10-24）：原来整读 events.jsonl，长任务下每次 tick 都是一次同步全量解析
    const ev = tailLines(P.events, 300)
    let escAt = 0
    let delivAt = 0
    for (const l of ev) {
      try {
        const o = JSON.parse(l)
        const t = Date.parse(o.at) || 0
        if (o.kind === 'escalate') escAt = Math.max(escAt, t)
        if (o.kind === 'step-delivered') delivAt = Math.max(delivAt, t)
      } catch { /* 坏行跳过 */ }
    }
    if (!escAt || delivAt >= escAt) return
    const waitMs = Date.now() - escAt
    if (waitMs < (cfg.firstFrameTimeoutMs || 180000)) return
    if (K.firstFrameNudgedAt === escAt) return        // 同一次上交只提醒一次
    K.firstFrameNudgedAt = escAt
    if (cfg.firstFrameEcho === false) {
      D.steerFront('【等待超时】后台还没给出步骤（可能模型较慢）。你**先做只读侦察**（读文件/看目录/确认环境），不要猜任务、不要写交付物；把侦察结果写进 state.md 的「已知事实」，然后停下等步骤。', 'first-frame-timeout')
    } else {
      const taskEcho = K.lastTaskText ? String(K.lastTaskText).slice(0, 800) : ''
      D.steerFront('【等待超时】后台还没给出步骤（可能模型较慢）。**任务原文就在你手上，不用猜**：\n' +
        (taskEcho ? '「' + taskEcho + '」\n' : '') +
        '现在按你对任务的直接理解，先推进「确定要做、且不可逆风险低」的部分（读现状 / 建目录 / 改动实现 / 跑验证），' +
        '不要空等。唯一禁区：**先不要写最终交付物**（deliver），等后台步骤到了再对齐收口。', 'first-frame-timeout')
    }
    event('first-frame-timeout', { waitedMs: waitMs })
    log('首帧超时（' + Math.round(waitMs / 1000) + 's），已让前台先做只读侦察')
  }

  async function checkContextBudget () {
    if (!cfg.contextGuard) return
    if (!K.svcMeter || !K.svcCompaction) return
    const pairs = [[K.front, 'front', cfg.frontContextLimit], [K.back, 'back', cfg.backContextLimit]]
    for (const [agent, role, limit] of pairs) {
      if (!agent || !limit) continue
      // 只在空闲时压（compactNow 要求 idle agent 且无排队唤醒）
      if (!(agent.phase && agent.phase.kind === 'idle')) continue
      if (Date.now() - K.lastCompactAt[role] < 30000) continue
      let surface = null
      try { surface = K.svcMeter.measure(agent.session).surfaceTokens } catch { /* 测量不可用 */ }
      if (surface == null || surface < limit) continue
      K.lastCompactAt[role] = Date.now()
      try {
        // ★ 实测：compactNow 要传 **agent**（不是 session）——传 session 会报
        //   "manual compaction requires an idle agent with no waking queued work"
        const r = K.svcCompaction.compactNow(agent, new AbortController().signal)
        const v = (r && typeof r.then === 'function') ? await r : r
        let after = null
        try { after = K.svcMeter.measure(agent.session).surfaceTokens } catch { /* 忽略 */ }
        event('ctx-compact', { role, before: surface, after, result: v ? String(JSON.stringify(v)).slice(0, 160) : null })
        log(`按角色压缩 ${role}: ${surface} → ${after}（预算 ${limit}）`)
      } catch (e) {
        event('ctx-compact-fail', { role, before: surface, err: String(e && e.message || e).slice(0, 160) })
        log(`按角色压缩失败 ${role}: ${e.message}`)
      }
    }
  }

  async function setEffort (role) {
    if (!cfg.effortDrift) return
    try {
      const want = role === 'back' ? cfg.backEffort : cfg.frontEffort
      if (!want || want === K.curEffort) return
      const dm = ctx.agentDefaultModel
      if (!dm) return
      const sel = dm.currentSelection()
      if (!sel) return
      if (sel.reasoningEffort === want) { K.curEffort = want; return }
      await dm.saveSelection({ provider: sel.provider, model: sel.model, reasoningEffort: want })
      K.curEffort = want
      event('effort-switch', { role, effort: want })
      log('全局档位 -> ' + want + '（为 ' + role + '）')
    } catch (e) { log('setEffort fail: ' + e.message) }
  }

  // ══ B12 业务哨兵（route.md 的机械条件）═════════════════════════════════
  // 契约（已写进 BACK_BRIEF）：route.md 的「## 哨兵条件」段，一行一条：
  //   - C1 | file-exists | <绝对路径>            （条件成立 ⇒ 路线作废）
  //   - C2 | file-absent | <绝对路径>
  //   - C3 | field-cmp   | <state字段> | >= | S<k>
  //   - C4 | grep-match  | <文件路径> | <子串>
  /** 解析 route.md 的「## 哨兵条件」段（实现已抽到 sentinel.js，纯函数可单测） */
  const readSentinels = () => parseSentinels(D.readIf(P.route))

  /** 求值单条哨兵（实现已抽到 sentinel.js；这里注入本作用域的依赖） */
  const evalSentinel = (s) => evalSentinelPure(s, { readIf: D.readIf, readState: D.readState, stepNo: D.stepNo })

  function runBusinessSentinels () {
    if (cfg.sentinelEnabled === false) return   // 总开关
    const list = readSentinels()
    if (!list.length) return
    // ★ 无任务时不跑业务哨兵（2026-10-18 实测事故：用户只发「你好」，
    //   上一轮任务遗留的 REPORT.md 让 C1「文件存在」反复命中 ⇒ 冻结前台。
    //   业务哨兵只该在**有活任务**时生效。
    try {
      const st0 = D.readState()
      const steps0 = D.listSteps()
      const doneNo0 = D.stepNo(st0.done || '')
      const maxNo0 = steps0.length ? Math.max(...steps0.map(D.stepNo)) : 0
      const busy = (K.front && K.front.phase && K.front.phase.kind === 'running') ||
                   (K.back && K.back.phase && K.back.phase.kind === 'running')
      if (!busy && !(maxNo0 > 0 && doneNo0 < maxNo0)) {
        K.lastBizAlertKey = ''
        return
      }
    } catch { /* 忽略 */ }
    const hits = []
    for (const s of list) { const why = evalSentinel(s); if (why) hits.push({ id: s.id, why }) }
    if (!hits.length) { K.lastBizAlertKey = ''; return }
    const key = hits.map(h => h.id).join(',')
    if (key === K.lastBizAlertKey) return       // 同一条只报一次，避免刷屏
    K.lastBizAlertKey = key
    for (const h of hits) { event('sentinel-biz', h); log('业务哨兵命中 ' + h.id + ': ' + h.why) }
    // 命中 ⇒ 后台正在想的那份计划已作废 → **打断它**（全架构唯一"打断收益为正"的场景）
    let cancelled = false
    if (K.back && K.back.phase && K.back.phase.kind === 'running') {
      try {
        K.back.cancel(new Error('route sentinel invalidated the in-flight plan'))
        cancelled = true
        event('interrupt-back', { why: key })
        log('已打断后台（业务哨兵 ' + key + '）')
      } catch (e) { log('interrupt back fail: ' + e.message) }
    }
    const wakeMsg = '【业务哨兵】' + hits.map(h => h.id + ' ' + h.why).join('；') +
      '。路线已作废，请读 .board/state.md 与 heartbeat.log 后重估 route.md。'
    // ★ 实测（2026-10-17）：cancel() 之后**立即** steer/followup 会抛
    //   "unreachable variant: {}"（状态机还没复位）⇒ 这次唤醒彻底丢失。所以延迟 ~1s 再唤醒。
    if (cancelled) {
      setTimeout(() => {
        try { if (!D.alive()) return; K.lastWakeAt = 0; D.wakeBack('sentinel', wakeMsg) } catch (e) { log('delayed wake fail: ' + e.message) }
      }, 1000)
    } else {
      K.lastWakeAt = 0
      D.wakeBack('sentinel', wakeMsg)
    }
    // ★ 同时冻结前台 + 作废未执行步骤（否则前台会把过时步骤继续跑完）
    //   注意：这里只能调用一次（2026-10-18 修：历史上重复写了两次，
    //   导致日志里 freeze 事件成对出现、步骤被连续作废两轮）
    freezeFront(hits.map(h => h.id + ' ' + h.why).join('；'))
  }

  // ── apiApp 内抽出的方法（index 用 ...GD.api 展开）──
  const api = {
    /** T3 待批准列表（供面板展示） */
    listPendingConfirms () {
      try {
        const out = []
        const dir = P.confirmDir
        let files = []
        try { files = readdirSync(dir).filter((f) => /^S\d+\.pending$/.test(f)) } catch { /* 无目录 */ }
        for (const f of files) {
          let body = ''
          try { body = readFileSync(join(dir, f), 'utf8') } catch { /* 忽略 */ }
          out.push({ id: f.replace(/\.pending$/, ''), step: f, cmd: body.slice(0, 500), at: (() => { try { return statSync(join(dir, f)).mtime.toISOString() } catch { return '' } })() })
        }
        return out
      } catch { return [] }
    },
    /** 批准：写 S<k>.ok 并删除 pending */
    approveConfirm (step) {
      try {
        const s = String(step || '').replace(/[^A-Za-z0-9]/g, '')
        if (!s) return { error: '缺少 step' }
        D.writeAtomic(join(P.confirmDir, s + '.ok'), new Date().toISOString())
        try { unlinkSync(join(P.confirmDir, s + '.pending')) } catch { /* 忽略 */ }
        event('t3-approved-by-user', { step: s })
        log('T3 用户批准: ' + s)
        // ★ 批准后必须主动唤醒前台：它可能已停在"等待审批"状态，不会自己回来
        let woke = false
        try {
          woke = D.steerFront('【已批准】危险操作已获用户批准（' + s + '），请**继续执行刚才那条命令**，不要重试其它方式。', 't3-approved', { force: true })
        } catch (e) { log('T3 批准唤醒失败: ' + e.message) }
        // 若前台没跑（steer 失败/空闲未起），用 followup 兜底再叫一次
        if (!woke) {
          try {
            if (K.front) { K.front.followup(msg('【已批准】' + s + ' 已获用户批准，请继续执行之前那条命令。')); woke = true }
          } catch (e) { log('T3 批准 followup 兜底失败: ' + e.message) }
        }
        return { ok: true, step: s, woke }
      } catch (e) { return { error: String(e && e.message || e) } }
    },
    /** 拒绝：删除 pending，并告知前台不要重试 */
    rejectConfirm (step) {
      try {
        const s = String(step || '').replace(/[^A-Za-z0-9]/g, '')
        if (!s) return { error: '缺少 step' }
        try { unlinkSync(join(P.confirmDir, s + '.pending')) } catch { /* 忽略 */ }
        try { D.writeAtomic(join(P.confirmDir, s + '.denied'), new Date().toISOString()) } catch { /* 忽略 */ }
        event('t3-rejected-by-user', { step: s })
        log('T3 用户拒绝: ' + s)
        try { D.steerFront('【已拒绝】用户拒绝了这个危险操作，请放弃该命令并说明原因或另想办法。', 't3-rejected', { force: true }) } catch { /* 忽略 */ }
        try { D.steerFront('用户已拒绝该删除/破坏性操作，请勿重试；如需换方式请说明原因。', 't3-denied') } catch { /* 忽略 */ }
        return { ok: true, step: s, denied: true }
      } catch (e) { return { error: String(e && e.message || e) } }
    },
  }

  return { lastUserText, lastAssistantText, checkStall, isDestructive, hasConfirm, freezeFront, runSentinels, checkFirstFrame, checkContextBudget, setEffort, readSentinels, evalSentinel, runBusinessSentinels, api }
}
