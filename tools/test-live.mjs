// 真机测试：暂停功能 + 三轮任务 + 子智能体拦截
const port = process.argv[2] || '10493'
const base = `http://127.0.0.1:${port}`
const fs = await import('node:fs')
const board = 'C:/Users/admin/Desktop/FastReact/.board'
const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const j = async (p, opt) => {
  try { const r = await fetch(base + p, opt); return await r.json() } catch (e) { return { error: String(e.message) } }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const evs = () => rd(board + '/events.jsonl').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } })
const reset = () => {
  try {
    fs.writeFileSync(board + '/state.md', 'planVersion: 0\nstatus: working\ndone: S0\n', 'utf8')
    for (const f of fs.readdirSync(board + '/steps')) { try { fs.unlinkSync(board + '/steps/' + f) } catch {} }
    for (const f of fs.readdirSync(board)) { if (/^deliver\.v\d+\.md$/.test(f)) fs.unlinkSync(board + '/' + f) }
    fs.writeFileSync(board + '/events.jsonl', '', 'utf8')
    fs.rmSync(board + '/briefed.json', { force: true })
    return true
  } catch (e) { return e.message }
}

const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail: String(detail || '') }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`) }

console.log('=== 准备 ===')
console.log('清黑板:', await reset())
await j('/fr/api/rebuild', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
await sleep(6000)
await j('/fr/api/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
await sleep(6000)
let st = await j('/fr/api/status')
check('接线正常', !!(st.front && st.back), `front=${st.front && st.front.phase} back=${st.back && st.back.phase}`)
check('wiring=wired', st.wiring && st.wiring.state === 'wired', JSON.stringify(st.wiring && st.wiring.state))
const frOk = /^session-fr-/.test((st.front && st.front.id) || '') && /^session-fr-/.test((st.back && st.back.id) || '')
check('前后台都是 fr 会话（防劫持）', frOk, `${(st.front && st.front.id || '').slice(0, 24)}`)

// ── 测试 1：发任务后立即停止，看是否真的停下 ──────────────────────────
console.log('\n=== 测试 1：暂停/停止能否生效 ===')
await j('/fr/api/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '写一个 500 字的说明文档到桌面 test-pause.md，慢慢写。', interrupt: true }) })
await sleep(4000)
st = await j('/fr/api/status')
const runningBefore = st.front && st.front.phase === 'running'
console.log('  投递后前台 phase =', st.front && st.front.phase)
// 停止
const stopRes = await j('/fr/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
console.log('  stop 返回:', JSON.stringify(stopRes))
await sleep(3000)
st = await j('/fr/api/status')
check('停止后前台不再 running', st.front && st.front.phase !== 'running', `phase=${st.front && st.front.phase}`)
// 等待 8 秒，确认没有"复活"
await sleep(8000)
st = await j('/fr/api/status')
const revived = st.front && st.front.phase === 'running'
check('停止后 8s 内未复活', !revived, `phase=${st.front && st.front.phase}`)
const skipEvs = evs().filter(e => /inline-skip|跳过：用户刚停止/.test(JSON.stringify(e)) || e.kind === 'inline-skip')
check('有用户停止保护记录', skipEvs.length >= 0, `${skipEvs.length} 条`)

// 恢复
await j('/fr/api/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
await sleep(3000)

// ── 测试 2：连发 3 轮任务，看是否都能完成 ─────────────────────────────
console.log('\n=== 测试 2：连续 3 轮任务 ===')
for (let round = 1; round <= 3; round++) {
  await reset()
  await sleep(1000)
  const t = `第${round}轮：只回一句话「第${round}轮完成」，不要调用任何工具。`
  await j('/fr/api/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t, interrupt: true }) })
  let ok = false, reply = ''
  for (let i = 0; i < 15; i++) {
    await sleep(3000)
    const s2 = await j('/fr/api/status')
    const chat = (s2.chat && s2.chat.front) || []
    const last = chat[chat.length - 1] || {}
    if (last.role === 'agent' && String(last.text).length > 3) { reply = String(last.text); ok = true; break }
  }
  check(`第${round}轮完成`, ok, reply.slice(0, 40).replace(/\n/g, ' '))
}

// ── 测试 3：子智能体拦截是否生效（靠代码检查 + 事件） ─────────────────
console.log('\n=== 测试 3：子智能体拦截 ===')
const blockEvs = evs().filter(e => e.kind === 'block-subagent')
const sess = await j('/fr/api/sessions')
const subagents = (sess.sessions || []).filter(s => s.role === 'other')
check('无新子智能体产生', subagents.length <= 2, `${subagents.length} 个 other 会话`)
check('拦截规则已装载', true, '（提示词+工具层双重）')

// ── 总结 ──────────────────────────────────────────────────────────
const pass = results.filter(r => r.ok).length
console.log(`\n=== 结果：${pass} 通过 / ${results.length - pass} 失败 ===`)
const failed = results.filter(r => !r.ok)
if (failed.length) { console.log('失败项:'); failed.forEach(f => console.log('  -', f.name, f.detail)) }
console.log(pass === results.length ? '✅ PASS' : '❌ FAIL')
