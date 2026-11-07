#!/usr/bin/env node
/**
 * preflight.mjs —— 测试前置体检（零模型成本）
 *
 * 每次开测前先跑这个：确认「代码已加载 / 配置已生效 / 记录已开始」，
 * 否则后面所有 A/B 数据都不可信。
 *
 * 用法：node tools/preflight.mjs [端口]
 */

const port = process.argv[2] || '11235'
const base = `http://127.0.0.1:${port}`

const get = async (p) => {
  const r = await fetch(base + p, { cache: 'no-store' })
  const t = await r.text()
  try { return { ok: r.ok, code: r.status, json: JSON.parse(t) } } catch { return { ok: r.ok, code: r.status, text: t } }
}

let pass = 0, fail = 0
const line = (ok, name, detail = '') => {
  if (ok) pass++; else fail++
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`)
}

console.log('=== 快速反应 · 测试前置体检 ===')
console.log('base = ' + base + '\n')

// ── 1. 页面与接口可用 ───────────────────────────────────────────────
console.log('[1] 页面与接口')
const page = await get('/fr').catch(() => ({ ok: false }))
line(!!page.ok && typeof page.text === 'string', '/fr 可打开（不能是空响应）',
  page.text ? `${page.text.length} B` : String(page.code))
const inlineCfg = typeof page.text === 'string' && /window\.__FR_CFG=/.test(page.text)
line(inlineCfg, '/fr 内联了 __FR_CFG（轮询开关生效前提）')
const settings = await get('/fr/settings').catch(() => ({ ok: false }))
line(!!settings.ok && typeof settings.text === 'string', '/fr/settings 可打开')
const st = await get('/fr/api/status').catch(() => ({ ok: false }))
line(!!st.ok && !!st.json, '/fr/api/status 可用')
const cf = await get('/fr/api/config').catch(() => ({ ok: false }))
line(!!cf.ok && !!(cf.json || {}).cfg, '/fr/api/config 可用')
const cfg = (cf.json || {}).cfg || {}

// ── 2. 本次改动的开关是否都在 ──────────────────────────────────────
console.log('\n[2] 新开关是否已加载')
const EXPECT = [
  ['finalAudit', true], ['finalAuditMaxRetry', 2], ['todoMirror', true],
  ['blockToolFold', true], ['verboseLog', true],
  ['budgetWakes', 12], ['pollUnified', true], ['firstFrameEcho', true],
  ['tier', 'balanced'], ['workerMax', 2], ['fanoutWorkers', true],
  ['reviewDiffEnabled', true], ['applyPatchPreset', false],
  ['frontContextLimit', 80000],
]
for (const [k, want] of EXPECT) {
  const cur = cfg[k]
  const ok = cur === want
  line(ok, k, `now=${JSON.stringify(cur)} want=${JSON.stringify(want)}`)
}

// ── 3. 黑板位置与历史 ──────────────────────────────────────────────
console.log('\n[3] 黑板')
const board = cfg.boardRoot || ''
line(!!board, 'boardRoot 有值', board)
const isLegacy = /Desktop[\\/]FastReact/i.test(board)
line(isLegacy, '沿用历史黑板（Desktop/FastReact），没有改道到新目录')

// ── 4. 详细日志是否开始写 ───────────────────────────────────────────
console.log('\n[4] 观测')
line(cfg.verboseLog === true, 'verboseLog 开（否则 detail.jsonl 不会有内容）')
const budget = (st.json || {}).budget
line(!!budget && typeof budget.wakes === 'number', 'status 带 budget 字段',
  budget ? `wakes=${budget.wakes} freezes=${budget.freezes} limit=${budget.limit}` : '')

// ── 5. 会话与接线 ──────────────────────────────────────────────────
console.log('\n[5] 接线')
const wiring = (st.json || {}).wiring || {}
line(wiring.state === 'wired', '前后台已接线', `state=${wiring.state}`)
line(!!wiring.frontMatched && !!wiring.backMatched, '两会话身份匹配（防劫持）')

// ── 6. 预设能否承载 apply_patch ────────────────────────────────────
console.log('\n[6] 预设')
line(cfg.agentPreset === 'standard', 'agentPreset 是 standard（applyPatchPreset 前提）',
  `now=${cfg.agentPreset}`)

// ── 汇总 ──────────────────────────────────────────────────────────
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
if (fail) {
  console.log('有失败项 ⇒ 先修再测，否则数据不可信。')
  process.exit(1)
}
console.log('前置条件齐备，可以开始 A/B。')
