// 查：接线被非 fr 会话抢占 + 子智能体活动
const port = process.argv[2] || '4099'
const base = `http://127.0.0.1:${port}`
const fs = await import('node:fs')
const board = 'C:/Users/admin/Desktop/FastReact/.board'
const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const j = async (p) => { try { const r = await fetch(base + p); return await r.json() } catch (e) { return { error: String(e.message) } } }

const st = await j('/fr/api/status')
const sess = await j('/fr/api/sessions')
const cfg = await j('/fr/api/config')

console.log('=== 接线 ===')
console.log('cfg.frontSessionId =', cfg.cfg && cfg.cfg.frontSessionId)
console.log('cfg.backSessionId  =', cfg.cfg && cfg.cfg.backSessionId)
console.log('当前 front =', st.front && st.front.id)
console.log('当前 back  =', st.back && st.back.id)
console.log('wiring =', JSON.stringify(st.wiring))

console.log('\n=== 所有活会话 ===')
;(sess.sessions || []).forEach(s => {
  const isFr = /^session-fr-/.test(s.id)
  console.log(` ${isFr ? '🏷️' : '  '} ${s.id.slice(0, 40)} | role=${s.role} phase=${s.phase} preset=${s.preset}`)
})

console.log('\n=== 子智能体线索（是否开了 subagent）===')
const evs = rd(board + '/events.jsonl').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } })
const sub = evs.filter(e => /subagent|spawn|delegate/i.test(JSON.stringify(e)))
console.log('事件中 subagent 相关:', sub.length)
sub.slice(-5).forEach(e => console.log(' ', e.kind, JSON.stringify(e.detail || {}).slice(0, 100)))

console.log('\n=== 日志中的接线变化 ===')
const log = rd('C:/Users/admin/.dsh/super-injector/fast-react.log').trim().split('\n')
const wireLogs = log.filter(l => /接线|焊死|自愈|front=|back=/i.test(l))
wireLogs.slice(-12).forEach(l => console.log(' ', l.slice(0, 175)))

console.log('\n=== 关键判断 ===')
const frontIsFr = /^session-fr-/.test(st.front && st.front.id || '')
const backIsFr = /^session-fr-/.test(st.back && st.back.id || '')
console.log('front 是插件创建的会话?', frontIsFr ? '✅' : '❌ 被别的会话抢占了')
console.log('back  是插件创建的会话?', backIsFr ? '✅' : '❌ 被别的会话抢占了')
if (!frontIsFr || !backIsFr) {
  console.log('\n→ 这是严重 bug：resolveAgents 的自动发现把非 fr 会话当成了前后台')
  console.log('→ 后果：插件的步骤投递到了错误会话，真正的前台/后台反而空闲')
}
