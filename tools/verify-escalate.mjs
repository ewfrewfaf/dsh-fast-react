// 定向验证：强制上交后台路径（免费模型）
const port = process.argv[2] || '4847'
const base = `http://127.0.0.1:${port}`
const j = async (p, opt) => {
  const r = await fetch(base + p, opt)
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { _raw: t.slice(0, 300) } }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const fs = await import('node:fs')
const board = 'C:/Users/admin/Desktop/FastReact/.board'
const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const evs = () => rd(board + '/events.jsonl').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } })

let st = await j('/fr/api/status')
console.log('模型:', JSON.stringify(st.models), '| front:', st.front && st.front.id, '| back:', st.back && st.back.id)

// 清黑板 + 重新接线
fs.writeFileSync(board + '/state.md', 'planVersion: 0\nstatus: working\ndone: S0\n', 'utf8')
try { for (const f of fs.readdirSync(board + '/steps')) fs.unlinkSync(board + '/steps/' + f) } catch { /* 忽略 */ }
fs.writeFileSync(board + '/events.jsonl', '', 'utf8')
fs.rmSync(board + '/briefed.json', { force: true })
await j('/fr/api/rebuild', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
await sleep(5000)
await j('/fr/api/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
await sleep(5000)

// 明确要求走后台 + 强制多步
const task = '【必须调度后台】这是一个需要 6 个有依赖步骤的任务：调研 DSH 插件生态现状并产出报告。请立刻 fr_escalate 上交给后台做路线规划，不要自己做。'
console.log('\n投递…')
console.log('投递:', JSON.stringify(await j('/fr/api/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: task, interrupt: true }) })))

let escAt = -1, routeAt = -1, delivAt = -1, stepsN = 0
for (let i = 0; i < 45; i++) {
  await sleep(6000)
  st = await j('/fr/api/status')
  const e = evs()
  if (escAt < 0 && e.some(x => x.kind === 'escalate')) escAt = i
  if (routeAt < 0 && e.some(x => x.kind === 'route-rendered')) routeAt = i
  if (delivAt < 0 && e.some(x => x.kind === 'step-delivered')) delivAt = i
  try { stepsN = Math.max(stepsN, fs.readdirSync(board + '/steps').length) } catch { /* 忽略 */ }
  if (i % 4 === 0 || [escAt, routeAt, delivAt].includes(i)) {
    console.log(`[${(i + 1) * 6}s] front=${st.front && st.front.phase} back=${st.back && st.back.phase} steps=${stepsN} esc=${escAt >= 0} route=${routeAt >= 0} deliv=${delivAt >= 0}`)
  }
  if (delivAt >= 0 && stepsN > 0 && st.front && st.front.phase === 'idle' && routeAt >= 0) break
}

console.log('\n=== 上交链路（免费模型）===')
console.log('前台上交:', escAt >= 0 ? `✅ ${(escAt + 1) * 6}s` : '❌')
console.log('后台路线:', routeAt >= 0 ? `✅ ${(routeAt + 1) * 6}s` : '❌')
console.log('步骤文件:', stepsN)
console.log('步骤投递:', delivAt >= 0 ? `✅ ${(delivAt + 1) * 6}s` : '❌')
console.log('\nstate:', rd(board + '/state.md').split('\n').slice(0, 4).join(' | '))
console.log('近期事件:', evs().slice(-8).map(x => x.kind).join(', '))
