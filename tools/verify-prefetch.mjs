// 验证流水线预规划：前台跑第 N 步时，后台应被提前唤醒写下一批
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
console.log('前置:', JSON.stringify(st.models), '| front:', st.front && st.front.phase, '| back:', st.back && st.back.phase)
if (!st.front || !st.back) {
  await j('/fr/api/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  await sleep(6000)
}
// 确认 prefetch 配置已生效
const cfg = await j('/fr/api/config')
console.log('pipelinePrefetch:', cfg.cfg && cfg.cfg.pipelinePrefetch, '| prefetchCooldownMs:', cfg.cfg && cfg.cfg.prefetchCooldownMs, '| sentinelEnabled:', cfg.cfg && cfg.cfg.sentinelEnabled)

// 清黑板事件
fs.writeFileSync(board + '/events.jsonl', '', 'utf8')

// 发一个会跑多步的任务
const task = '调研 3 个话题并分别写成文件：(1) DSH 插件的 bundle 机制 (2) Cordis 的 Context 模型 (3) 快速反应的双会话编排。每个话题一个 md 文件，最后写一份汇总。'
console.log('\n投递长任务…')
console.log('投递:', JSON.stringify(await j('/fr/api/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: task, interrupt: true }) })))

let prefetchSeen = false, escal = false, routes = 0, deliv = 0
for (let i = 0; i < 50; i++) {
  await sleep(6000)
  st = await j('/fr/api/status')
  const evs = rd(board + '/events.jsonl').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } })
  const pf = evs.filter(e => e.kind === 'prefetch')
  if (pf.length) prefetchSeen = true
  escal = escal || evs.some(e => e.kind === 'escalate')
  routes = evs.filter(e => e.kind === 'route-rendered').length
  deliv = evs.filter(e => e.kind === 'step-delivered').length
  const freezes = evs.filter(e => e.kind === 'freeze').length
  if (i % 4 === 0 || prefetchSeen) {
    console.log(`[${(i + 1) * 6}s] front=${st.front && st.front.phase} back=${st.back && st.back.phase} escalate=${escal} routes=${routes} delivered=${deliv} prefetch=${pf.length} freeze=${freezes}`)
  }
  if (prefetchSeen && deliv >= 2) break
}

console.log('\n=== 判定 ===')
console.log('前台上交后台:', escal ? '✅' : '❌')
console.log('后台出路线次数:', routes, routes >= 1 ? '✅' : '❌')
console.log('流水线预规划命中:', prefetchSeen ? '✅ 后台被提前唤醒补步' : '⚠️ 未触发（可能任务步数太少/单批够用）')
console.log('步骤投递:', deliv, deliv >= 1 ? '✅' : '❌')
const evs = rd(board + '/events.jsonl').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } })
console.log('冻结次数:', evs.filter(e => e.kind === 'freeze').length, '（应为 0）')
console.log('哨兵命中:', evs.filter(e => /sentinel/.test(e.kind)).length, '（应为 0）')
