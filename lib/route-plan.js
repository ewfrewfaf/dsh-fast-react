/**
 * @file lib/route-plan.js —— fr_route 的纯逻辑层
 *
 * 从 index.js 的 renderRoute（202 行）里抽出**无副作用**的部分：
 *   · validateRouteArgs      参数校验（plan 要 goal+milestones，append 要 steps）
 *   · capMilestones          里程碑单调性截断（补步阶段不许外扩任务量）
 *   · filterSentinels        哨兵预检（目标已存在/已缺失的 file-* 哨兵会立即误触发）
 *   · buildRouteMarkdown     把结构化参数渲染成 route.md 文本
 *
 * 为什么抽出来：
 *   这几段原来埋在闭包里，测不了、也容易被后续改动误伤。
 *   抽成纯函数后可以直接单测（见 tools/test-route-plan.mjs），
 *   而真正有副作用的部分（写文件、发事件、排程）仍留在 index.js。
 */

/**
 * 校验 fr_route 的参数。schema 里的 required 已清空（因为 append 不需要 goal），
 * 所以模式相关的必填校验放在这里。
 *
 * @param {object} args  fr_route 的参数
 * @param {boolean} isAppend  是否 append 模式（已确认 route.md 存在）
 * @returns {{ok:true}|{ok:false, error:string}}
 */
export function validateRouteArgs (args, isAppend) {
  if (!isAppend) {
    const ms = Array.isArray(args.milestones) ? args.milestones.filter((m) => m && m.id && m.desc) : []
    if (!String(args.goal || '').trim() && ms.length === 0) {
      return { ok: false, error: 'plan 模式需要 goal 和 milestones；若只是补步骤，请用 mode:"append" 并只给 steps。' }
    }
    return { ok: true }
  }
  const st = Array.isArray(args.steps) ? args.steps.filter((s) => s && s.id && s.action) : []
  if (st.length === 0) return { ok: false, error: 'append 模式必须给 steps（要补的步骤清单）。' }
  return { ok: true }
}

/**
 * 里程碑单调性截断。
 *
 * 实测事故（2026-11-07）：同一任务内后台反复重规划，里程碑一路涨
 *   11:44:13 milestones=6 → 11:44:37 milestones=6 → 11:45:12 **milestones=9**
 * 而 steps 追不上（补到 6 又涨到 9）⇒ 缺口永不为 0 ⇒ 归档被拒、任务卡住。
 *
 * 根因：renderRoute 每次整体覆写 route.md，从不检查既有 route；后台补步时
 * 重新规划，自然把"接下来的活"也算进里程碑，目标不断外扩。
 *
 * 对策：里程碑只许持平或减少，不许增长。任务总量应在最初几次规划就定；
 * 补步阶段只该"补齐"，不该"加活"。
 *
 * @param {object[]} ms          本次提交的里程碑
 * @param {number} prevMsCount   盘上既有 route.md 的里程碑数（0 = 还没有）
 * @returns {{ms: object[], truncated: boolean, was: number, want: number}}
 */
export function capMilestones (ms, prevMsCount) {
  const list = Array.isArray(ms) ? ms : []
  if (!(prevMsCount > 0) || list.length <= prevMsCount) {
    return { ms: list, truncated: false, was: prevMsCount, want: list.length }
  }
  const want = list.length
  const capped = list.slice(0, prevMsCount)
  return { ms: capped, truncated: true, was: prevMsCount, want }
}

/**
 * 哨兵预检：丢弃**会立即误触发**的 file-* 哨兵。
 *
 * 实测事故（2026-11-08，L4）：后台给出
 *   C1 = file-exists(".../run-forced/L4/check.mjs")
 * 但 check.mjs 是**题目自带**的验收脚本、规划时就已经存在 ⇒ 哨兵立即命中
 * ⇒ sentinel-biz + interrupt-back + freeze 三连 ⇒ 前台被冻结、任务卡死。
 *
 * 语义修正：哨兵应该判断"**新出现的**文件/状态"，不是"本来就有的文件"。
 *   file-exists 目标**已存在** ⇒ 必然立刻误触发 ⇒ 丢弃
 *   file-absent 目标**已不存在** ⇒ 同理 ⇒ 丢弃
 *   field-cmp / grep-match 无法静态判定（依赖运行时状态），保留。
 *
 * @param {object[]} raw      原始哨兵数组
 * @param {object} deps
 * @param {(p:string)=>boolean} deps.exists    路径是否存在
 * @param {(p:string)=>boolean} deps.isAbsolute 是否绝对路径
 * @param {string} deps.root   相对路径的解析基准（黑板根）
 * @param {(p:string)=>string} [deps.resolve]  路径拼接（缺省用 root + '/' + p）
 * @returns {{kept: object[], rejected: Array<{id:string,kind:string,target:string,why:string}>}}
 */
export function filterSentinels (raw, deps) {
  const list = Array.isArray(raw) ? raw : []
  const kept = []
  const rejected = []
  const { exists, isAbsolute, root, resolve } = deps || {}
  const joinRoot = resolve || ((p) => String(root || '').replace(/[/\\]+$/, '') + '/' + p)

  for (const s of list) {
    if (!s || !s.id || !s.kind || !s.target) continue
    const kind = String(s.kind).trim()
    const target = String(s.target).trim()
    try {
      const abs = typeof isAbsolute === 'function' && isAbsolute(target) ? target : joinRoot(target)
      if (kind === 'file-exists' && typeof exists === 'function' && exists(abs)) {
        rejected.push({ id: String(s.id), kind, target, why: 'already-exists' })
        continue
      }
      if (kind === 'file-absent' && typeof exists === 'function' && !exists(abs)) {
        rejected.push({ id: String(s.id), kind, target, why: 'already-absent' })
        continue
      }
    } catch { /* 路径非法等，保留原哨兵（交给运行时判断） */ }
    kept.push(s)
  }
  return { kept, rejected }
}

/**
 * 把结构化参数渲染成 route.md 的正文。
 *
 * @param {object} p
 * @param {string} p.goal
 * @param {string[]} p.acceptance
 * @param {object[]} p.milestones   [{id, desc, step?}]
 * @param {object[]} p.sentinels    [{id, kind, target}]
 * @returns {string}
 */
export function buildRouteMarkdown ({ goal, acceptance, milestones, sentinels }) {
  const lines = ['# route.md（由 fr_route 工具生成，勿手改写）', '']
  lines.push('## 目标', String(goal || '').trim() || '（未提供）', '')

  const acc = Array.isArray(acceptance) ? acceptance.filter(Boolean) : []
  if (acc.length) {
    lines.push('## 终态判定')
    for (const a of acc) lines.push('- ' + String(a).trim())
    lines.push('')
  }

  const ms = Array.isArray(milestones) ? milestones : []
  lines.push('## 里程碑')
  for (const m of ms) {
    const id = String(m.id).trim()
    const step = m.step ? '（' + String(m.step).trim() + '）' : ''
    lines.push(`- **${id}${step}**：${String(m.desc).trim()}`)
  }
  lines.push('')

  const sn = Array.isArray(sentinels) ? sentinels : []
  if (sn.length) {
    lines.push('## 哨兵条件')
    for (const s of sn) {
      lines.push(`- ${String(s.id).trim()} | ${String(s.kind).trim()} | ${String(s.target).trim()}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
