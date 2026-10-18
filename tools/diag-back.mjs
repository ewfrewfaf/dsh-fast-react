// 诊断：为什么后台没被拉起
import fs from 'node:fs'
const port = process.argv[2] || '8595'
const base = `http://127.0.0.1:${port}`
const board = 'C:/Users/admin/Desktop/FastReact/.board'
const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const j = async (p) => { try { const r = await fetch(base + p); return await r.json() } catch (e) { return { error: String(e.message) } } }

const st = await j('/fr/api/status')
console.log('=== 状态 ===')
console.log('front:', st.front && st.front.id, '|', st.front && st.front.phase)
console.log('back :', st.back && st.back.id, '|', st.back && st.back.phase)
console.log('state:', JSON.stringify(st.state))
console.log('models:', JSON.stringify(st.models))

console.log('\n=== steps 目录 ===')
let steps = []
try { steps = fs.readdirSync(board + '/steps').filter(f => /^S\d+\.md$/.test(f)).sort((a,b)=>parseInt(a.slice(1))-parseInt(b.slice(1))) } catch {}
console.log('步骤:', steps.join(',') || '(无)')
for (const s of steps.slice(0, 6)) {
  const t = rd(board + '/steps/' + s)
  console.log(`  ${s}: ${t.split('\n')[1] ? t.split('\n')[1].slice(0, 60) : '(空)'}`)
}

console.log('\n=== 事件（最近 25）===')
const evs = rd(board + '/events.jsonl').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } })
evs.slice(-25).forEach(e => console.log(' ', String(e.at).slice(11, 19), e.kind, JSON.stringify(e.detail || {}).slice(0, 130)))

console.log('\n=== 唤醒统计 ===')
const wakes = evs.filter(e => e.kind === 'wake')
console.log('wake 事件数:', wakes.length)
const byReason = {}
wakes.forEach(w => { const r = (w.detail && w.detail.reason) || '?'; byReason[r] = (byReason[r] || 0) + 1 })
console.log('按原因:', JSON.stringify(byReason))
const skip = evs.filter(e => e.kind === 'wake-skip' || (e.detail && /skip|冷却/.test(JSON.stringify(e.detail))))
console.log('跳过记录:', skip.length, JSON.stringify(skip.slice(-3)).slice(0, 200))

console.log('\n=== 关键：是否存在 escalate（前台上交）===')
const esc = evs.filter(e => e.kind === 'escalate')
console.log('escalate 次数:', esc.length)
esc.slice(-3).forEach(e => console.log(' ', String(e.at).slice(11, 19), JSON.stringify(e.detail || {}).slice(0, 150)))

console.log('\n=== 插件日志尾部 20 ===')
const log = rd('C:/Users/admin/.dsh/super-injector/fast-react.log').trim().split('\n').slice(-20)
log.forEach(l => console.log(' ', l.slice(0, 180)))
