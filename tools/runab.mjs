#!/usr/bin/env node
/**
 * runab.mjs —— 跑完整 A/B（建立沙箱 → 投递 → 等完成 → 统计）
 *
 * 用法：
 *   node tools/runab.mjs <board> <port> <base> <sandboxPrefix> <rounds> <onValue|offValue> <开关名> "<任务模板>"
 *
 * 例（T1 的 off 组）：
 *   node tools/runab.mjs "C:/.../.board" 13904 /fr t1-edit 3 false todoMirror \
 *     "在 <SB>/<rN> 目录里：1) 读 README.md 2) 把三处 TODO 改成 - [ ] xxx 3) docs/ 下建 summary.md 汇总"
 *
 * 任务模板里把 <SB> 换成沙箱根、<rN> 换成具体轮次目录名。
 */

import { readFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const [board, port, base, prefix, roundsArg, value, key, tpl] = process.argv.slice(2)
if (!board || !port || !base || !prefix || !tpl) {
  console.error('参数不足')
  process.exit(1)
}
const rounds = Number(roundsArg) || 3
const API = `http://127.0.0.1:${port}${base}`
const SB = join(board, '..', 'test-sandbox')

const setCfg = async (k, v) => {
  const body = {}
  body[k] = (v === 'true' ? true : v === 'false' ? false : Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : v)
  const r = await fetch(`${API}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((x) => x.json()).catch(() => ({}))
  return r
}

const lines = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).length } catch { return 0 } }
const readParsed = (p, from = 0) => {
  try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(from).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] }
}

// 设定开关
const applied = await setCfg(key, value)
console.log(`[设置] ${key}=${value}`, JSON.stringify(applied))

const results = []
for (let i = 1; i <= rounds; i++) {
  const dir = `${prefix}-r${i}`
  // 重置沙箱（用 mksandbox 的 --reset，只支持基础名；这里直接复制模板）
  const tplDir = join(SB, `${prefix}-r1`)
  const dst = join(SB, dir)
  try {
    execFileSync('node', ['tools/mksandbox.mjs', '--reset', `${prefix}-r${i}`], { cwd: process.cwd(), stdio: 'ignore' })
  } catch { /* 用已有 */ }

  const task = tpl.replace(/<SB>/g, SB.replace(/\\/g, '/')).replace(/<rN>/g, dir)
  const ev = join(board, 'events.jsonl')
  const dl = join(board, 'detail.jsonl')
  const ev0 = lines(ev); const dl0 = lines(dl)

  const t0 = Date.now()
  const res = await fetch(`${API}/api/task`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: task }),
  }).then((r) => r.json()).catch(() => ({}))

  let wallMs = 0
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    const cur = readParsed(ev, ev0)
    const sawTask = cur.some((x) => x.kind === 'api-task')
    const turnEnd = cur.some((x) => x.kind === 'front-turn-end')
    if (sawTask && turnEnd) { await new Promise((r) => setTimeout(r, 2500)); wallMs = Date.now() - t0; break }
  }

  const E = readParsed(ev, ev0)
  const D = readParsed(dl, dl0)
  const T = D.filter((x) => x.kind === 'tool')
  const row = {
    at: new Date().toISOString(), group: `${key}=${value}`, round: i,
    wallMs, taskChars: task.length,
    tools: T.length, toolFails: T.filter((x) => !x.ok).length, callErrs: T.filter((x) => x.callErr).length,
    wakes: D.filter((x) => x.kind === 'wake').length,
    compacts: E.filter((x) => x.kind === 'ctx-compact').length,
    steps: E.filter((x) => x.kind === 'step-delivered').length,
    todoMirror: D.filter((x) => x.kind === 'todo-mirror').length,
    reviewDiff: E.filter((x) => x.kind === 'review-diff').length,
    toolNames: [...new Set(T.map((x) => x.name))].join(','),
  }
  results.push(row)
  appendFileSync(join(board, 'measure.jsonl'), JSON.stringify(row) + '\n')
  console.log(`  r${i}: ${row.wallMs}ms tools=${row.tools} fails=${row.toolFails} wakes=${row.wakes} mirror=${row.todoMirror}`)
}

// 汇总中位数
const med = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)] || 0 }
console.log('\n=== 汇总 ===')
console.log(`组 ${key}=${value}: 墙钟中位 ${med(results.map((r) => r.wallMs))}ms | 工具中位 ${med(results.map((r) => r.tools))} | 唤醒中位 ${med(results.map((r) => r.wakes))}`)
