// 接线稳定性审计：连续采样，看 front/back 是否会掉
const port = process.argv[2] || '4099'
const base = `http://127.0.0.1:${port}`
const j = async (p) => { try { const r = await fetch(base + p); return await r.json() } catch (e) { return { error: String(e.message) } } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const samples = []
for (let i = 0; i < 12; i++) {
  const st = await j('/fr/api/status')
  samples.push({
    t: i,
    front: st.front ? st.front.id.slice(-8) + ':' + st.front.phase : 'NULL',
    back: st.back ? st.back.id.slice(-8) + ':' + st.back.phase : 'NULL',
  })
  await sleep(2500)
}

console.log('=== 接线采样（每 2.5s）===')
samples.forEach(s => console.log(`  [${s.t}] front=${s.front}  back=${s.back}`))

const nulls = samples.filter(s => s.front === 'NULL' || s.back === 'NULL')
const ids = new Set(samples.map(s => s.front).filter(x => x !== 'NULL'))
console.log('\n=== 判定 ===')
console.log('采样数:', samples.length)
console.log('front/back 为 null 的次数:', nulls.length, nulls.length ? '❌ 会掉线' : '✅ 稳定')
console.log('front id 变化次数:', ids.size, ids.size > 1 ? '⚠️ 会话被重建' : '✅ 稳定')
if (nulls.length) {
  console.log('\n掉线详情:', JSON.stringify(nulls.slice(0, 3)))
  console.log('→ 可能是 autoheal 重建会话期间的窗口期（resolveAgents 还没跑完）')
}
