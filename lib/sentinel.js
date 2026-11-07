/**
 * @file lib/sentinel.js —— 业务哨兵：解析与求值
 *
 * 从 index.js 的 apply() 里抽出来的纯逻辑层。原来这两段埋在 4900 行的巨型函数中，
 * 既没法单测，也容易被后续改动误伤。抽出来之后：
 *   · 纯函数（依赖通过参数注入）⇒ 可直接 import 测试
 *   · 契约集中在一处（route.md 的「## 哨兵条件」格式）
 *
 * ══ 契约（已写进 BACK_BRIEF，后台据此写 route.md）══
 *     ## 哨兵条件
 *     - C1 | file-exists | <绝对路径>             条件成立 ⇒ 路线作废
 *     - C2 | file-absent | <绝对路径>
 *     - C3 | field-cmp   | <state字段> | >= | S<k>
 *     - C4 | grep-match  | <文件路径> | <子串>
 */

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
