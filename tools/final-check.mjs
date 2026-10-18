// 收尾检查：新实例状态 + 自检
const port = process.argv[2] || '8595'
const base = `http://127.0.0.1:${port}`
const j = async (p, opt) => {
  const r = await fetch(base + p, opt)
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { _raw: t.slice(0, 200) } }
}

let st
try {
  st = await j('/fr/api/status')
} catch (e) {
  console.log('插件未就绪（可能需重启或注入）:', e.message)
  process.exit(1)
}
console.log('端口:', port)
console.log('front:', st.front && st.front.id, '|', st.front && st.front.phase)
console.log('back :', st.back && st.back.id, '|', st.back && st.back.phase)
console.log('models:', JSON.stringify(st.models))
console.log('permissions:', JSON.stringify(st.permissions))
console.log('stall:', JSON.stringify(st.stall))

if (!st.front || !st.back) {
  console.log('→ 接线缺失，尝试 start')
  await j('/fr/api/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  await new Promise(r => setTimeout(r, 5000))
  st = await j('/fr/api/status')
  console.log('start 后 front:', st.front && st.front.phase, 'back:', st.back && st.back.phase)
}
