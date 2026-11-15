#!/usr/bin/env node
/**
 * measure.mjs —— 跑一个任务并测量（A/B 测试的量尺）
 *
 * 用法：
 *   node tools/measure.mjs <board目录> <端口> <base路径> "<任务文本>" [标签]
 *
 * 例：
 *   node tools/measure.mjs boardDir() 13904 /fr "读 t1-edit-r1 的 README 并列出 TODO" T1-on
 *
 * 产出（追加到 <board>/measure.jsonl，同时打印）：
 *   wallMs        任务从投递到前台回合结束
 *   tools         工具调用次数
 *   toolFails     失败次数（含契约错）
 *   wakes         唤醒次数
 *   compacts      上下文压缩次数
 *   tokens        metrics 里的累计 token 增量
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { boardDir } from './paths.mjs'

const [board, port, base, text, label = 'run'] = process.argv.slice(2)
if (!board || !port || !base || !text) {
  console.error('用法: measure.mjs <board> <port> <base> "<text>" [label]')
  process.exit(1)
}

const API = `http://127.0.0.1:${port}${base}`
const ev = join(board, 'events.jsonl')
const dl = join(board, 'detail.jsonl')
const mt = join(board, 'metrics.json')
const out = join(board, 'measure.jsonl')

const countLines = (p) => {
  try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).length } catch { return 0 }
}
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return {} } }

const ev0 = countLines(ev)
const dl0 = countLines(dl)
const tok0 = Number((readJson(mt).usage || {}).total || 0)

const t0 = Date.now()
const res = await fetch(`${API}/api/task`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text }),
})
const jr = await res.json().catch(() => ({}))

// 轮询直到「前台回合结束」出现（最多 180s）
let wallMs = 0
const deadline = Date.now() + 180000
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2500))
  let lines = []
  try { lines = readFileSync(ev, 'utf8').split('\n').filter(Boolean).slice(ev0) } catch { /* 忽略 */ }
  // 完成判定：投递之后出现 front-turn-end（且已投递），或者出现 deliver
  // ★ deliver 是「投递」事件，不是完成；完成只认 front-turn-end
  const sawTask = lines.some((l) => l.includes('"kind":"api-task"'))
  const turnEnd = lines.some((l) => l.includes('"kind":"front-turn-end"'))
  if (sawTask && turnEnd) {
    // 再等 3 秒，让 detail.jsonl 落盘
    await new Promise((r) => setTimeout(r, 3000))
    wallMs = Date.now() - t0
    break
  }
}

// 统计增量
const newEv = (() => { try { return readFileSync(ev, 'utf8').split('\n').filter(Boolean).slice(ev0) } catch { return [] } })()
const newDl = (() => { try { return readFileSync(dl, 'utf8').split('\n').filter(Boolean).slice(dl0) } catch { return [] } })()
const parse = (ls) => ls.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

const E = parse(newEv)
const D = parse(newDl)
const tools = D.filter((x) => x.kind === 'tool')
const row = {
  at: new Date().toISOString(),
  label,
  wallMs,
  apiOk: !!jr.ok,
  session: jr.session || '',
  tools: tools.length,
  toolFails: tools.filter((x) => !x.ok).length,
  callErrs: tools.filter((x) => x.callErr).length,
  wakes: D.filter((x) => x.kind === 'wake').length,
  wakeSkips: D.filter((x) => x.kind === 'wake-skip').length,
  compacts: E.filter((x) => x.kind === 'ctx-compact').length,
  steps: E.filter((x) => x.kind === 'step-delivered').length,
  mode: jr.mode || '',
  toolNames: [...new Set(tools.map((x) => x.name))].join(','),
}

appendFileSync(out, JSON.stringify(row) + '\n')
console.log(JSON.stringify(row, null, 1))
