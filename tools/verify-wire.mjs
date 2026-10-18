// 决定性验证：rebuild 后新会话必须真正接管并能被驱动
const port = process.argv[2] || '4847'
const base = `http://127.0.0.1:${port}`
const j = async (p, opt) => {
  const r = await fetch(base + p, opt)
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { _raw: t.slice(0, 400) } }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`) }

// 1) 重启后自愈
let st = await j('/fr/api/status')
if (!st.front || !st.back) {
  await j('/fr/api/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  await sleep(4000)
  st = await j('/fr/api/status')
}
check('接线可用', !!(st.front && st.back), `front=${st.front && st.front.phase} back=${st.back && st.back.phase}`)

// 2) rebuild → 新会话必须接管
const oldFront = st.front && st.front.id
const rb = await j('/fr/api/rebuild', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
check('rebuild 返回成功', !!rb.ok, `new=${String(rb.front).slice(0, 26)}`)
await sleep(2500)
st = await j('/fr/api/status')
check('status 已切到新会话（关键修复点）', st.front && st.front.id === rb.front,
  `status=${String(st.front && st.front.id).slice(0, 26)} vs rebuild=${String(rb.front).slice(0, 26)}`)
check('新会话 != 旧会话', st.front && st.front.id !== oldFront, `old=${String(oldFront).slice(0, 26)}`)

// 3) 新会话必须能被驱动（phase 进入 running）
const target = st.front && st.front.id
const sent = await j('/fr/api/task', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '只回三个字：已接管', interrupt: true }),
})
check('投递到新会话', !!sent.ok && sent.session === target, JSON.stringify(sent).slice(0, 120))

let sawRunning = false, reply = ''
for (let i = 0; i < 12; i++) {
  await sleep(4000)
  st = await j('/fr/api/status')
  if (st.front && st.front.phase === 'running') sawRunning = true
  const chat = (st.chat && st.chat.front) || []
  const last = chat[chat.length - 1]
  if (last && last.role === 'agent') { reply = String(last.text); break }
}
check('新会话被真正驱动（出现过 running）', sawRunning, '')
check('免费模型给出回复', reply.length > 0, reply.slice(0, 80).replace(/\n/g, ' '))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
