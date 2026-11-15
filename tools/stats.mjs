#!/usr/bin/env node
/**
 * stats.mjs —— 快速反应「机制到底有没有在干活」统计器
 *
 * 读两类记录：
 *   .board/events.jsonl   审计事件（一直在写）
 *   .board/detail.jsonl   详细日志（verboseLog=true 时写，含事件缺失的路径）
 *
 * 用法：
 *   node tools/stats.mjs                       # 默认黑板目录
 *   node tools/stats.mjs "C:/path/.board" 24   # 指定 board + 最近 24 小时
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DEFAULT_BOARD = process.env.FAST_REACT_BOARD
  ? join(process.env.FAST_REACT_BOARD, '.board')
  : join(homedir(), 'Desktop', 'FastReact', '.board')

const board = process.argv[2] || DEFAULT_BOARD
const hours = Number(process.argv[3] || 0)          // 0 = 全部
const since = hours > 0 ? Date.now() - hours * 3600e3 : 0

function readJsonl (p) {
  if (!existsSync(p)) return []
  const out = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
  }
  return out
}
const events = readJsonl(join(board, 'events.jsonl'))
const detail = readJsonl(join(board, 'detail.jsonl'))
const inWin = (o) => {
  const t = Date.parse(o.at || '') || 0
  return !since || t >= since
}
const E = events.filter(inWin)
const D = detail.filter(inWin)

const pad = (s, n) => String(s).padEnd(n)
const incr = (m, k) => m.set(k, (m.get(k) || 0) + 1)
function table (title, map, opts = {}) {
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1])
  if (!rows.length) { console.log(`\n${title}: （无记录）`); return }
  console.log(`\n${title}:`)
  const width = Math.max(...rows.map(([k]) => String(k).length), 8)
  for (const [k, v] of rows) console.log('  ' + pad(k, width) + '  ' + v)
}

console.log('=== 快速反应 · 机制活动统计 ===')
console.log('board : ' + board)
console.log('窗口  : ' + (hours > 0 ? `最近 ${hours} 小时` : '全部') +
  `  · 事件 ${E.length} 条 / 详细日志 ${D.length} 条`)
if (!existsSync(join(board, 'detail.jsonl'))) {
  console.log('提示：detail.jsonl 不存在 ⇒ verboseLog 关着，下面只有事件部分（可能有缺项）')
}

// ── 唤醒 ──
const wake = new Map(); const wakeSkip = new Map()
for (const e of E) if (e.kind === 'wake') incr(wake, e.detail?.reason || '?')
for (const d of D) {
  if (d.kind === 'wake') incr(wake, d.reason || '?')
  if (d.kind === 'wake-skip') incr(wakeSkip, d.why || '?')
  if (d.kind === 'wake-skip-policy') incr(wakeSkip, 'policy:' + (d.reason || '?'))
}
table('唤醒 by reason', wake)
table('唤醒被跳过 by 原因', wakeSkip)

// ── 工具 ──
const tool = new Map(); const toolFail = new Map(); const callErr = new Map()
for (const d of D.filter((x) => x.kind === 'tool')) {
  incr(tool, d.name || '?')
  if (!d.ok) incr(toolFail, d.name || '?')
  if (d.callErr) incr(callErr, d.name || '?')
}
table('工具调用（detail）', tool)
table('工具失败', toolFail)
table('调用契约错（不计 failStreak）', callErr)

// ── 机制触发 ──
const mech = new Map()
const MECH_NAMES = [
  'step-delivered', 'rework-detected', 'milestone-review', 'freeze', 'sentinel',
  'mode-set', 'deliver-audit', 'review-diff', 'todo-mirror', 'budget-exceeded',
  'block-tool-fold', 'block-subagent', 'first-frame-timeout', 'wake-batch-flushed',
  'batch-adapted', 'analysis-delivered', 'deliver', 'autoheal',
]
for (const x of [...E, ...D]) {
  if (MECH_NAMES.includes(x.kind)) incr(mech, x.kind)
}
table('机制触发次数', mech)

// ── effort 决策（是否存在“看起来生效、实际空操作”） ──
const effort = new Map()
for (const d of D.filter((x) => x.kind === 'effort')) {
  incr(effort, `${d.tag} ${d.model} → ${d.effort}`)
}
table('effort 决策', effort)

// ── 比率 ──
const totalTools = [...tool.values()].reduce((a, b) => a + b, 0)
const totalWakes = [...wake.values()].reduce((a, b) => a + b, 0)
if (totalTools) {
  console.log('\n每 1000 次工具调用唤醒次数: ' + Math.round(totalWakes / totalTools * 1000))
}
console.log('')
