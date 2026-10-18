// 诊断：为什么只发"你好"也会触发 H4 冻结
import fs from 'node:fs'
const port = process.argv[2] || '8595'
const base = `http://127.0.0.1:${port}`
const board = 'C:/Users/admin/Desktop/FastReact/.board'
const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const j = async (p) => {
  try { const r = await fetch(base + p); return await r.json() } catch (e) { return { error: String(e.message) } }
}

console.log('=== 当前状态 ===')
const st = await j('/fr/api/status')
if (st.error) { console.log('插件未响应:', st.error); process.exit(0) }
console.log('front:', st.front && st.front.id, '|', st.front && st.front.phase)
console.log('back :', st.back && st.back.id, '|', st.back && st.back.phase)
console.log('models:', JSON.stringify(st.models))
console.log('t3Blocked:', st.t3Blocked, '| tools:', JSON.stringify(st.tools))
console.log('metrics:', JSON.stringify(st.metrics || {}).slice(0, 300))

console.log('\n=== 黑板事件中 sentinel / freeze / tool-fail ===')
const evs = rd(board + '/events.jsonl').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } })
const interesting = evs.filter(e => /sentinel|freeze|tool-fail|escalate/.test(e.kind))
console.log('总数:', interesting.length)
interesting.slice(-12).forEach(e => console.log(' ', e.kind, String(e.at).slice(11, 19), JSON.stringify(e.detail || {}).slice(0, 160)))

console.log('\n=== heartbeat.log 尾部（FAIL 计数来源）===')
const hb = rd(board + '/heartbeat.log').trim().split('\n')
console.log('总行数:', hb.length)
console.log('最近 15 行:')
hb.slice(-15).forEach(l => console.log(' ', l.slice(0, 130)))
const fails = hb.filter(l => /FAIL/.test(l))
console.log('FAIL 总数:', fails.length, '| 最近 5 条 FAIL:')
fails.slice(-5).forEach(l => console.log(' ', l.slice(0, 130)))

console.log('\n=== metric 文件（失败计数持久化）===')
console.log(rd(board + '/metrics.json').slice(0, 600))

console.log('\n=== 插件日志中哨兵/冻结上下文 ===')
const log = rd('C:/Users/admin/.dsh/super-injector/fast-react.log').trim().split('\n')
const hits = log.map((l, i) => /哨兵|冻结|失败|fail|failStreak/i.test(l) ? i : -1).filter(i => i >= 0).slice(-10)
hits.forEach(i => console.log(' ', log[i].slice(0, 190)))
