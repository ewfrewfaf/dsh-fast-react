// 最终验收：免费模型跑完整「前台→上交→后台规划→执行→交付」链路
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

let st = await j('/fr/api/status')
console.log('模型:', JSON.stringify(st.models))
console.log('front:', st.front && st.front.id, '| back:', st.back && st.back.id)

// 清黑板，从干净状态开始
try {
  fs.writeFileSync(board + '/state.md', 'planVersion: 0\nstatus: working\ndone: S0\n', 'utf8')
  for (const f of fs.readdirSync(board + '/steps')) fs.unlinkSync(board + '/steps/' + f)
  fs.writeFileSync(board + '/events.jsonl', '', 'utf8')
  fs.rmSync(board + '/briefed.json', { force: true })
  console.log('黑板已清空')
} catch (e) { console.log('清黑板:', e.message) }

// 重启接线让简报重新注入
await j('/fr/api/rebuild', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
await sleep(5000)
await j('/fr/api/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
await sleep(5000)

// 发一个明确要求走后台的多步任务
const task = '请调度后台规划：在本机桌面新建一个 test-fr 文件夹，里面创建 a.txt（内容 hello）和 b.txt（内容 world），再写一份 README.md 说明这两个文件。完成后向我汇报。'
console.log('\n投递任务…')
const sent = await j('/fr/api/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: task, interrupt: true }) })
console.log('投递:', JSON.stringify(sent))

const marks = { escalate: false, route: false, steps: 0, delivered: false, finalAnswer: '' }
for (let i = 0; i < 40; i++) {
  await sleep(6000)
  st = await j('/fr/api/status')
  const evs = rd(board + '/events.jsonl').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } })
  marks.escalate = marks.escalate || evs.some(e => e.kind === 'escalate')
  marks.route = marks.route || evs.some(e => e.kind === 'route-rendered')
  marks.delivered = marks.delivered || evs.some(e => e.kind === 'step-delivered')
  try { marks.steps = fs.readdirSync(board + '/steps').length } catch { /* 忽略 */ }
  const chat = (st.chat && st.chat.front) || []
  const last = chat[chat.length - 1] || {}
  const isFinal = last.role === 'agent' && String(last.text || '').length > 60
  if (isFinal) marks.finalAnswer = String(last.text)
  if (i % 3 === 0 || isFinal) {
    console.log(`[${(i + 1) * 6}s] front=${st.front && st.front.phase} back=${st.back && st.back.phase} steps=${marks.steps} delivered=${marks.delivered} escalate=${marks.escalate} route=${marks.route} last=${last.role || '-'}${isFinal ? ' ★终局' : ''}`)
  }
  if (isFinal && st.front && st.front.phase === 'idle') break
}

console.log('\n=== 结果 ===')
console.log('前台上交后台:', marks.escalate ? '✅' : '❌')
console.log('后台出路线:', marks.route ? '✅' : '❌')
console.log('步骤数:', marks.steps)
console.log('步骤投递:', marks.delivered ? '✅' : '❌')
console.log('终局交付字数:', marks.finalAnswer.length)
if (marks.finalAnswer) console.log('--- 交付正文 ---\n' + marks.finalAnswer.slice(0, 500))

// 检查产出文件
console.log('\n=== 产出物 ===')
for (const p of ['C:/Users/admin/Desktop/test-fr/a.txt', 'C:/Users/admin/Desktop/test-fr/b.txt', 'C:/Users/admin/Desktop/test-fr/README.md']) {
  try { console.log('✅', p, '=', JSON.stringify(fs.readFileSync(p, 'utf8').slice(0, 40))) } catch { console.log('❌', p, '不存在') }
}
