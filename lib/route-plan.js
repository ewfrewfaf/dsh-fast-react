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
/**
 * ★ 2026-11-15 覆写决策（纯函数，可单测）：plan 覆写 / append 补步时，
 *   哪些步号跳过、尾部残留清理到哪个步号、是否重置进度指针。
 *   规则（与 index.js 原内联逻辑等价，抽出是为了回归可证）：
 *   · append：已存在的步号一律不碰；不清尾、不重置进度
 *   · plan  ：步号 <= done 的已完成步不重写；清理 > 本批最大步号的尾残留；
 *             done >= 本批最大步号 或 status=done ⇒ 重置进度（防前台空等 S<done+1>）
 */
export function planOverwriteDecision ({ doneNo = 0, status = '', incomingKs = [], existingKs = [], isAppend = false } = {}) {
  const maxK = incomingKs.reduce((m, k) => Math.max(m, Number(k) || 0), 0)
  const exist = new Set((existingKs || []).map((k) => Number(k) || 0))
  const skip = (k) => (isAppend ? exist.has(Number(k) || 0) : (doneNo > 0 && (Number(k) || 0) <= doneNo))
  return {
    maxK,
    skip,
    pruneAbove: isAppend ? Infinity : maxK,
    reset: !isAppend && (doneNo >= maxK || String(status || '') === 'done'),
  }
}

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


// ══ 业务哨兵：解析与求值（1.6.3 自 sentinel.js 并入，同族纯逻辑）══


import { existsSync } from 'node:fs'

/**
 * 从 route.md 的正文里解析出哨兵条目。
 *
 * ★ 标题匹配故意放宽（2026-10-17 实测）：模型很自然地会写
 *   `## 5. 哨兵条件（成立即路线作废）` —— 带序号、带括号说明。
 *   原来只认 `## 哨兵条件` 会静默失效（一个哨兵都不生效，且没有任何报错）。
 *
 * @param {string} routeText  route.md 的全文
 * @returns {Array<{id: string, kind: string, rest: string}>} 哨兵条目（rest 是 `|` 分隔的剩余部分原文）
 */
export function parseSentinels (routeText) {
  const t = String(routeText || '')
  const m0 = t.match(/^##[^\n]*哨兵条件[^\n]*$/m)
  if (!m0) return []
  const start = m0.index + m0[0].length
  // 取到下一个二级标题为止
  const seg = t.slice(start).split(/\n##\s/)[0]
  const out = []
  for (const line of seg.split('\n')) {
    const m = line.match(/^\s*-\s*([A-Za-z0-9_-]+)\s*\|\s*([a-z-]+)\s*\|\s*(.+?)\s*$/)
    if (m) out.push({ id: m[1], kind: m[2], rest: m[3] })
  }
  return out
}

/**
 * 求值单条哨兵。
 *
 * @param {{id:string, kind:string, rest:string}} s  哨兵条目
 * @param {object} deps  依赖注入（便于测试与解耦）
 * @param {(f:string)=>string} deps.readIf   读文件（失败返回 ''）
 * @param {()=>object} deps.readState        读 state.md 的受控字段
 * @param {(s:string)=>number} deps.stepNo   把 'S3' 解析成 3
 * @returns {string|null}  命中时返回人类可读的原因；未命中返回 null
 */
export function evalSentinel (s, deps) {
  try {
    const { readIf, readState, stepNo } = deps || {}
    const parts = String(s.rest || '').split('|').map((x) => x.trim())

    if (s.kind === 'file-exists') {
      const p = parts[0]
      return p && existsSync(p) ? ('文件存在 ' + p) : null
    }

    if (s.kind === 'file-absent') {
      const p = parts[0]
      return p && !existsSync(p) ? ('文件缺失 ' + p) : null
    }

    if (s.kind === 'field-cmp') {
      const st = readState ? readState() : {}
      const field = parts[0]
      const op = parts[1]
      const val = parts[2]
      const cur = String(st[field] === undefined ? '' : st[field])
      if (op === '>=') return stepNo && stepNo(cur) >= stepNo(val) ? (field + '=' + cur + ' >=' + val) : null
      if (op === '==') return cur === val ? (field + ' ==' + val) : null
      if (op === '!=') return cur !== val ? (field + ' !=' + val) : null
      return null
    }

    if (s.kind === 'grep-match') {
      const file = parts[0]
      const pat = parts[1]
      if (!pat || !readIf) return null
      return readIf(file).indexOf(pat) >= 0 ? ('匹配 ' + pat) : null
    }

    return null
  } catch {
    return null
  }
}

/**
 * 批量求值，返回所有命中的哨兵（每条附带原因）。
 *
 * @param {string} routeText  route.md 全文
 * @param {object} deps       同 evalSentinel
 * @returns {Array<{id:string, kind:string, why:string}>}
 */
export function evaluateSentinels (routeText, deps) {
  const hits = []
  for (const s of parseSentinels(routeText)) {
    const why = evalSentinel(s, deps)
    if (why) hits.push({ id: s.id, kind: s.kind, why })
  }
  return hits
}
