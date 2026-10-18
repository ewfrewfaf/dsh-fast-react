// 定向验证：事件驱动预规划（投递后即时唤醒后台）
const port = process.argv[2] || '4099'
const base = `http://127.0.0.1:${port}`
const fs = await import('node:fs')
const board = 'C:/Users/admin/Desktop/FastReact/.board'
const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const j = async (p, opt) => {
  try { const r = await fetch(base + p, opt); return await r.json() } catch (e) { return { error: String(e.message) } }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 清空黑板，从零开始
const reset = async () => {
  try {
    fs.writeFileSync(board + '/state.md', 'planVersion: 0\nstatus: working\ndone: S0\n', 'utf8')
    for (const f of fs.readdirSync(board + '/steps')) { try { fs.unlinkSync(board + '/steps/' + f) } catch {} }
    for (const f of fs.readdirSync(board)) { if (/^deliver\.v\d+\.md$/.test(f)) fs.unlinkSync(board + '/' + f) }
    fs.writeFileSync(board + '/events.jsonl', '', 'utf8')
    fs.rmSync(board + '/briefed.json', { force: true })
    return true
  } catch (e) { return e.message }
}

console.log('清黑板:', await reset())
await j('/fr/api/rebuild', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
await sleep(5000)
await j('/fr/api/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
await sleep(6000)

const st = await j('/fr/api/status')
console.log('接线:', st.wiring && st.wiring.state, '| front:', st.front && st.front.phase, '| back:', st.back && st.back.phase)

// 发一个明确要多步的任务
const task = '【必须调度后台·多步】调研并分别产出 4 份文件：(1) DSH 插件机制 (2) Cordis Context (3) 双会话编排 (4) 总结。每份写成一个 md 文件，放在桌面 test-multi 目录。'
console.log('\n投递…')
console.log(JSON.stringify(await j('/fr/api/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: task, interrupt: true }) })))

let prefetchCount = 0, routes = 0, delivered = 0, freezes = 0, sentinels = 0
for (let i = 0; i < 40; i++) {
  await sleep(6000)
  const evs = rd(board + '/events.jsonl').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } })
  prefetchCount = evs.filter(e => e.kind === 'prefetch').length
  routes = evs.filter(e => e.kind === 'route-rendered').length
  delivered = evs.filter(e => e.kind === 'step-delivered').length
  freezes = evs.filter(e => e.kind === 'freeze').length
  sentinels = evs.filter(e => /sentinel/.test(e.kind)).length
  const s2 = await j('/fr/api/status')
  if (i % 4 === 0 || prefetchCount > 0) {
    console.log(`[${(i + 1) * 6}s] front=${s2.front && s2.front.phase} back=${s2.back && s2.back.phase} routes=${routes} delivered=${delivered} prefetch=${prefetchCount} freeze=${freezes}`)
  }
  if (prefetchCount > 0) break
}

console.log('\n=== 判定 ===')
console.log(prefetchCount > 0 ? `✅ 预规划已触发（${prefetchCount} 次）— 后台在前台跑完后被即时唤醒补步` : '❌ 预规划未触发')
console.log('路线次数:', routes, '| 投递次数:', delivered)
console.log('冻结:', freezes, freezes === 0 ? '✅ 无误冻结' : '❌ 被冻结')
console.log('哨兵:', sentinels, sentinels === 0 ? '✅ 无误报' : '⚠️ 有哨兵命中')
