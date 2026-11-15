#!/usr/bin/env node
/**
 * bench_single.mjs —— 单 Agent 基线（不经过快速反应，直接调模型）
 *
 * 用法：node tools/bench_single.mjs <model> "<题目>" [标签]
 * 走本地 OpenAI 兼容桥（19023），只测模型裸速度。
 */

const [model, task, label = 'single'] = process.argv.slice(2)
if (!model || !task) { console.error('用法: bench_single.mjs <model> "<task>" [label]'); process.exit(1) }

// ★ 可移植：默认走本地 OpenAI 兼容桥，换环境用 FR_BENCH_BRIDGE 覆盖
const B = process.env.FR_BENCH_BRIDGE || 'http://127.0.0.1:19023/v1/chat/completions'
const t0 = Date.now()
let content = ''
let usage = null
try {
  const r = await fetch(B, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: task }], max_tokens: 4096 }),
  })
  const j = await r.json()
  content = (j.choices?.[0]?.message?.content || '')
  usage = j.usage
} catch (e) {
  content = 'ERROR: ' + e.message
}
const wallMs = Date.now() - t0
console.log(JSON.stringify({
  at: new Date().toISOString(), mode: 'single', label, model,
  wallMs, chars: content.length,
  tokens: usage ? usage.total_tokens : null,
  preview: content.slice(0, 80).replace(/\n/g, ' '),
}, null, 1))
