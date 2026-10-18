// 验证：闲聊天不再触发哨兵冻结
const port = process.argv[2] || '8595'
const base = `http://127.0.0.1:${port}`
const fs = await import('node:fs')
const board = 'C:/Users/admin/Desktop/FastReact/.board'
const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const j = async (p, opt) => {
  const r = await fetch(base + p, opt)
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { _raw: t.slice(0, 200) } }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let st = await j('/fr/api/status')
console.log('front:', st.front && st.front.phase, '| back:', st.back && st.back.phase, '| models:', JSON.stringify(st.models))
if (!st.front) { await j('/fr/api/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); await sleep(5000); st = await j('/fr/api/status') }

// 清事件，便于观察
fs.writeFileSync(board + '/events.jsonl', '', 'utf8')
console.log('\n发「你好」…')
console.log('投递:', JSON.stringify(await j('/fr/api/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好', interrupt: true }) })))

let reply = ''
for (let i = 0; i < 12; i++) {
  await sleep(5000)
  st = await j('/fr/api/status')
  const chat = (st.chat && st.chat.front) || []
  const last = chat[chat.length - 1] || {}
  if (last.role === 'agent') reply = String(last.text)
  console.log(`[${(i + 1) * 5}s] front=${st.front && st.front.phase} msgs=${chat.length} last=${last.role || '-'}`)
  if (reply && st.front && st.front.phase === 'idle') break
}

const evs = rd(board + '/events.jsonl').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } })
const freezes = evs.filter(e => e.kind === 'freeze' || e.kind === 'sentinel' || e.kind === 'sentinel-biz')
console.log('\n=== 判定 ===')
console.log(freezes.length === 0 ? '✅ 未触发任何哨兵/冻结（闲聊天安全）' : '❌ 仍有哨兵命中: ' + JSON.stringify(freezes.slice(0, 3)))
console.log('回复:', reply.slice(0, 100).replace(/\n/g, ' ') || '(无)')
console.log('state.routeOk:', (/routeOk\s*:\s*(\w+)/.exec(rd(board + '/state.md')) || [])[1] || '?')
