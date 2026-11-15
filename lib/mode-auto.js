/**
 * mode-auto.js —— 任务模式生效 / L2 策略 / auto 判型与分诊 / 自动升级
 * 从 lib/index.js 抽出的第 1 阶段模块（行为不变 refactor）。
 *
 * 依赖（D 依赖袋，字段调用时读取）：
 *   稳定字段（工厂顶部解构）：K cfg ctx log vlog event TAG BASE_PATH boardRoot boardDir P BB
 *   惰性字段：B applyToolPolicy currentMode hasDeliver idOf localizeToolNames modeFile modeNow policyAgentId reapplyToolPolicyIfNeeded steerFront wakeBack writeAtomic
 *   K 共享状态：见 index.js 的 K 袋（本模块读写的跨模块可变状态全部经 K）。
 *
 * 区块地图：
 *   applyMode：写 mode.md + 事件 + 工具白名单 + 注入说明（applyToolPolicy/reapplyToolPolicyIfNeeded 仍在 index，经 D 调用）
 *   applyStrategy：L2 相位策略旋钮（K.activeStrategy 初始化留在 index）
 *   resolveAutoPhases：auto+phases 的 L1 决议（确信quick / 编排+侦察门）
 *   touchBeat / nextStrategies：心跳基线 / 阶段策略序列（供 scheduler）
 *   detectAndApplyTask(body, opts, a)：原 apiApp.deliver 内的每任务判型块（三档+灰区分诊+pin）
 *   upgradeByToolCount()：原 tools/post-execute 内「工具数兜底」片段（quick>25 工具升 coding）
 *   upgradeByFrontRequest()：原 fr_escalate 内「前台请求升级」片段（无后台模式自动升 coding）
 *   注：effortOverride/setEffortFor 与 _effortForRaw 耦合，留在 index；readModeFile/currentMode/modeNow 留在 index 经 D 调用
 */

import { MODE_KEYS, STRATEGY, defaultStrategyForStep, describeTendency, detectMode, modeInfo, modeNotice, shouldOrchestrate } from './modes.js'
import { msg } from './briefs.js'
import { join } from 'node:path'

export function makeModeAuto (D) {
  const { cfg, ctx, log, vlog, event, TAG, BASE_PATH, boardRoot, boardDir, P, BB, K } = D

  /** 生效一个模式：写 mode.md + 事件 + 工具白名单 + 给两会话注入说明（inject 不唤醒） */
  function applyMode (key, by, reason) {
    const p = modeInfo(key)
    if (cfg.modeLocked && by !== 'user' && by !== 'startup') {
      log(`模式已锁定（${K.activeMode || '?'}），忽略 ${by} 的切换请求`)
      return { ok: false, error: 'mode-locked', mode: D.currentMode() }
    }
    // ★ §22 优化③：同模式重复生效去重（auto 判型后又 user 锁定同模式 ⇒ 只更新 by/reason，不重刷 inject）
    // ★★ 2026-11-07 修正：去重时**仍必须重挂工具白名单**。
    //   原实现整个 return ⇒ autoheal/api-rebuild 重建会话后 applyToolPolicy 永不执行
    //   ⇒ restrict 丢失、前/后台各可见 68 个工具（含 dev_*/hindsight_*/subagent/workflow）。
    //   注：不重发 modeNotice（那条是噪音且破坏 prefix cache），只重挂工具面。
    if (K.activeMode === p.key && by !== 'startup') {
      K.modeBy = by || K.modeBy
      try { D.reapplyToolPolicyIfNeeded() } catch (e) { log('去重分支重挂工具面失败: ' + e.message) }
      try {
        D.writeAtomic(D.modeFile, [
          `mode: ${p.key}`,
          `label: ${p.label}`,
          `by: ${K.modeBy}`,
          `reason: ${String(reason || '').replace(/\s+/g, ' ').slice(0, 200)}`,
          `at: ${new Date().toISOString()}`,
          '',
        ].join('\n'))
      } catch { /* 忽略 */ }
      return { ok: true, dedup: true, mode: p.key }
    }
    K.activeMode = p.key
    K.modeBy = by || 'auto'
    K.activeStrategy = null
    K.phaseStrategy = null
    D.writeAtomic(D.modeFile, [
      `mode: ${p.key}`,
      `label: ${p.label}`,
      `by: ${K.modeBy}`,
      `reason: ${String(reason || '').replace(/\s+/g, ' ').slice(0, 200)}`,
      `at: ${new Date().toISOString()}`,
      '',
    ].join('\n'))
    event('mode-set', { mode: p.key, by: K.modeBy, reason: String(reason || '').slice(0, 120) })
    vlog('mode-set', { mode: p.key, by: K.modeBy, reason: String(reason || '').slice(0, 120) })
    log(`模式 → ${p.label}（${p.key}，by ${K.modeBy}）`)
    // 模式变了 ⇒ 步长基线变了，自适应重新开始（避免沿用上个模式的批量）
    try { K.adaptiveBatch = 0; K.recentGaps = []; K.lastDeliverAt = 0 } catch { /* 初始化早期忽略 */ }
    const policy = D.applyToolPolicy(p.key)
    D.policyAgentId.front = K.front ? D.idOf(K.front) : ''
    D.policyAgentId.back = K.back ? D.idOf(K.back) : ''
    for (const [, ag] of [['front', K.front], ['back', K.back]]) {
      if (!ag) continue
      // ★ 2026-11-07：模式说明同样要做工具名本地化（原文里含 fr_escalate/fr_mode/fr_worker）
      try { ag.inject(msg(D.localizeToolNames(modeNotice(p.key, { fanout: cfg.fanoutWorkers !== false })), `模式：${p.label}`)) } catch { /* 忽略 */ }
    }
    return { ok: true, mode: p.key, label: p.label, by: K.modeBy, policy }
  }

  // ★ 2026-11-14 L2 策略切换：只调旋钮+发增量简报，不翻 L1/不重置自适应/不重刷全量简报

  function applyStrategy (key) {
    const st = STRATEGY[key] || STRATEGY.build
    if (K.activeStrategy === key) return { ok: true, dedup: true }
    K.activeStrategy = key
    event('strategy-set', { strategy: key })
    try { D.writeAtomic(join(boardDir, 'strategy.md'), `strategy: ${key}\nlabel: ${st.label}\nat: ${new Date().toISOString()}\n`) } catch { /* 忽略 */ }
    const artifact = st.deliver === 'analysis' ? 'analysis.md' : st.deliver === 'report' ? 'research.md' : null
    const note = `【阶段策略：${st.label}】本阶段 parallel=${st.parallel} effort=${st.effort}。` +
      (artifact ? `阶段产出写 .board/${artifact}，**不要写 deliver.v1.md**（仅末阶段交付才写）。` : `本阶段为实现/交付；仅当它是最后阶段才写 deliver.v1.md。`) +
      `消费上一阶段产出物，不要重做上一阶段工作。`
    if (K.front) { try { K.front.inject(msg(D.localizeToolNames(note), `阶段：${st.label}`)) } catch { /* 忽略 */ } }
    return { ok: true, strategy: key }
  }
  /** auto+phases 的 L1 决议：调用方固定 > 机械确信quick(solo) > 编排(后台规划兼分诊+前台侦察门) */
  function resolveAutoPhases (body, opts) {
    if (opts && opts.mode && MODE_KEYS.includes(String(opts.mode))) { applyMode(String(opts.mode), 'user', 'api:explicit'); return }
    const tri = shouldOrchestrate(body)
    K.lastTriage = { at: Date.now(), tend: tri.tend, score: tri.score, hits: tri.hits, taskText: String(body || '').slice(0, 120) }
    event('detect-phases', { tend: tri.tend, score: tri.score, hits: tri.hits.slice(0, 8) })
    if (tri.tend === 'quick') { if (D.currentMode() !== 'quick') applyMode('quick', 'auto', 'phases:确信quick'); return }
    if (D.currentMode() !== 'coding') applyMode('coding', 'auto', 'phases:编排')
    D.steerFront('【侦察门】后台正在规划。你先只做只读侦察（读文件/列目录），不要写代码/不要交付；等 verdict 或 steps 落地再执行。', 'recon-gate')
    D.wakeBack('plan', '【规划+分诊】理解整体任务后写 route+steps，并给每个步骤标 strategy: research|think|build|deliver（按阶段）。若判断为短任务（规格已给/≤2文件/无需设计）写 .board/verdict.md 一行「short: 理由」然后停。前台只做只读侦察等你。')
  }

  function touchBeat () { K.lastBeatAt = Date.now() }
  function nextStrategies () {
    try {
      return D.B.steps().filter(s => !s.done).map(s => s.strategy || defaultStrategyForStep(s.body || ''))
    } catch { return [] }
  }

  // [重构] 原 index.js 内联片段 → detectAndApplyTask
  function detectAndApplyTask (body, opts, a) {
      // ── 模式自动判型（Phase 1）：用户发来新任务、且目标就是前台、且没被锁定时，
      //    按文本判一次；判型失败无害（默认 coding，与旧行为一致）。
      if (cfg.modeAuto !== false && !cfg.modeLocked && a === K.front) {
        try {
          // ★★ 2026-11-08 判型引擎 v2：三档判定 + 灰区并行分诊
          //
          //   · score <= -2  ⇒ 确信 quick，前台直接做（不惊动后台）
          //   · score >= 8   ⇒ 确信 coding，走标准编排
          //   · 中间灰区      ⇒ quick + **并行唤醒后台分诊**（前台不等，继续做）
          //
          //   分诊是对"词表不可靠"的兜底：机械判型免费但会误判，
          //   灰区里让真正的判断者（后台 LLM）看一眼，成本一次唤醒、不占前台墙钟。
          //
          //   严格模式（mode_strict / pin）下跳过一切判型与分诊。
          const prevText = String(K.lastDetectText || '').slice(0, 120)
          const thisText = String(body || '').slice(0, 120)
          const isSameTask = prevText && prevText === thisText
          const userPinned = (K.modeBy === 'user' && isSameTask)

          const usePhases = cfg.enablePhases && cfg.orchestration !== 'fixed'
          if (usePhases) { resolveAutoPhases(body, opts) } else if (K.modePinned) {
            log('判型跳过：模式已被 pin 锁定')
          } else if (opts && opts.mode) {
            // ★ 显式模式（Agent/API 指定）——优先级最高，跳过机械判型
            const want = String(opts.mode)
            if (MODE_KEYS.includes(want)) {
              if (D.currentMode() !== want) applyMode(want, 'user', 'api:explicit')
              event('mode-explicit', { mode: want, strict: !!(opts && opts.mode_strict) })
              log(`模式由调用方显式指定 → ${want}${opts.mode_strict ? '（严格，不判型不分诊）' : ''}`)
            } else {
              log(`显式模式非法「${want}」，回落自动判型`)
            }
          } else if (opts && opts.mode_strict) {
            log('判型跳过：调用方要求严格模式（mode_strict）')
          } else if (userPinned) {
            log(`判型跳过：用户手选 ${D.currentMode()}（同一任务内保持）`)
          } else {
            // ★ 1.6.1 修复：detectMode 此前是死导入——检索/咨询/审查意图从不自动切换。
            //   现在先认意图（retrieval/consult/review），命中直接切；其余落编排判据（coding/quick/灰区）。
            const dm = detectMode(body)
            if (dm === 'retrieval' || dm === 'consult' || dm === 'review') {
              event('detect-intent', { mode: dm, task: thisText })
              if (D.currentMode() !== dm) {
                const r = applyMode(dm, 'auto', body.slice(0, 60))
                if (r && r.ok) log(`自动判型 → ${dm}（意图命中）`)
              }
            } else {
            const tri = shouldOrchestrate(body)
            K.lastTriage = { at: Date.now(), tend: tri.tend, score: tri.score, hits: tri.hits, taskText: thisText }
            event('detect-v2', { tend: tri.tend, score: tri.score, hits: tri.hits.slice(0, 8) })
            log(`判型 v2：${describeTendency(tri)} 命中[${tri.hits.slice(0, 6).join(',')}]`)

            if (tri.tend === 'coding') {
              if (D.currentMode() !== 'coding') {
                const r = applyMode('coding', 'auto', body.slice(0, 60))
                if (r && r.ok) log('判型 → coding（确信需要编排）')
              }
            } else {
              // quick（确信）或 gray（灰区）都以 quick 起步 —— 前台先干，不空等
              if (D.currentMode() !== 'quick') {
                const r = applyMode('quick', 'auto', body.slice(0, 60))
                if (r && r.ok) log(`判型 → quick（${tri.tend === 'gray' ? '灰区，将并行分诊' : '确信不需要编排'}）`)
              }
              // 灰区：并行唤醒后台做分诊（不阻塞前台）
              if (tri.tend === 'gray' && !(opts && opts.noTriage)) {
                try {
                  const woke = D.wakeBack('triage',
                    '【分诊·只做 1 件事，别规划别写步骤】\n' +
                    '判断这个任务需不需要编排（要不要写 route + steps）。判据：\n' +
                    '· 规格已给、≤2 文件、≤100 行、无需架构设计 ⇒ 写 .board/verdict.md 一行「short: <理由>」，然后停。\n' +
                    '· 需要自己设计架构 / 跨 3+ 文件 / 有并发·事务·恢复要求 ⇒ 正常调用 fr_route 写路线。\n' +
                    '前台已经开做了，你的判断只决定「要不要接管编排」，不要打断它。')
                  event('triage-woken', { woke: !!woke, score: tri.score })
                  if (woke) log(`灰区 ⇒ 已并行唤醒后台分诊（score=${tri.score}）`)
                } catch (e) { log('分诊唤醒失败: ' + e.message) }
              }
            }
            }
          }
          K.lastDetectText = thisText
          // 新任务到达 ⇒ 清 pin（pin 只对上一条任务有效）
          try { if (K.modePinned && !isSameTask) { K.modePinned = false; event('mode-unpinned', {}) } } catch { /* 忽略 */ }
          // 新任务 ⇒ 重置兜底标记
          try { K.autoUpgradedThisTask = false; K.lastEscalateAt = 0 } catch { /* 忽略 */ }
        } catch (e) { log('模式判型失败: ' + e.message) }
      }
  }

  // [重构] 原 index.js 内联片段 → upgradeByToolCount
  function upgradeByToolCount () {
          // ★★ 2026-11-08 兜底：quick 模式跑太多工具 ⇒ 自动升级到编排
          //
          //   实测依据：L1-L4 单 Agent 最多用 16 个工具；L5 单 Agent 用 30-107 个。
          //   所以 25 是安全线 —— 超过说明"这活比预想的复杂"，qe 硬扛不如交给编排。
          //   只在 quick 模式生效，且每任务只触发一次（防刷）。
          try {
            if (D.currentMode() === 'quick' && !K.autoUpgradedThisTask && !D.hasDeliver() && K.stepsThisTask > 25) {
              K.autoUpgradedThisTask = true
              applyMode('coding', 'auto', '工具数兜底: ' + K.stepsThisTask)
              event('auto-upgrade', { tools: K.stepsThisTask, from: 'quick', to: 'coding' })
              log(`兜底升级：quick 模式已跑 ${K.stepsThisTask} 个工具仍未交付 ⇒ 切 coding 并唤醒后台`)
              D.wakeBack('auto-upgrade', `【兜底升级】前台在 quick 模式下已跑 ${K.stepsThisTask} 个工具仍未交付，判定为复杂任务。` +
                `请尽快调用 fr_route 规划路线（mode:"plan"），前台会按步骤继续。`)
            }
          } catch { /* 兜底失败不影响主流程 */ }
  }

  // [重构] 原 index.js 内联片段 → upgradeByFrontRequest
  function upgradeByFrontRequest () {
      // ★★★ 2026-11-08 允许 quick 升级（解决 L3 不稳定）
      //
      //  实测事故：L3 判 quick（score=1），前台做了 27 个工具后自己意识到要编排，
      //  调用 fr_escalate 却被这里一刀切拒绝（escalate-blocked-by-mode），
      //  直到"25 工具兜底"把模式改成 coding 才放行 —— 白跑 27 个工具，单轮 143 秒。
      //
      //  设计修正：**前台主动要求上交，本身就是"这个任务比判型以为的复杂"的最强信号。**
      //  比机械判型和工具数兜底都准（前台有真实执行上下文）。
      //  所以：quick/retrieval 模式下允许上交，并自动升级到 coding。
      const mi = D.modeNow()
      if (!mi.backend) {
        const scored = shouldOrchestrate(K.lastTaskText || '')
        event('escalate-auto-upgrade', {
          from: mi.key, to: 'coding',
          score: scored.score, hits: scored.hits.slice(0, 5),
          frontAsked: true,
        })
        log(`前台在 ${mi.key} 模式下请求上交 ⇒ 自动升级 coding（判型分 ${scored.score}）`)
        try { applyMode('coding', 'auto', '前台请求升级') } catch { /* 忽略 */ }
        // 继续走下面的正常上交流程（不 return）
      }
  }

  return { applyMode, applyStrategy, resolveAutoPhases, touchBeat, nextStrategies, detectAndApplyTask, upgradeByToolCount, upgradeByFrontRequest }
}
