// 查为什么 steps 已存在但 delivered=0
const port = process.argv[2] || '4099'
const base = `http://127.0.0.1:${port}`
const fs = await import('node:fs')
const board = 'C:/Users/admin/Desktop/FastReact/.board'
const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const j = async (p) => { try { const r = await fetch(base + p); return await r.json() } catch (e) { return { error: String(e.message) } } }

const st = await j('/fr/api/status')
console.log('front:', st.front && st.front.id, st.front && st.front.phase)
console.log('back :', st.back && st.back.id, st.back && st.back.phase)
console.log('state:', JSON.stringify(st.state))
console.log('wiring:', JSON.stringify(st.wiring))

console.log('\n=== steps 目录 ===')
let files = []
try { files = fs.readdirSync(board + '/steps').sort() } catch {}
console.log('文件:', files.join(',') || '(空)')
for (const f of files) {
  const t = rd(board + '/steps/' + f)
  const mt = (() => { try { return fs.statSync(board + '/steps/' + f).mtimeMs } catch { return 0 } })()
  const ageS = Math.round((Date.now() - mt) / 1000)
  console.log(`  ${f}: ${t.trim().length} 字, mtime=${ageS}s 前, 首行=${t.split('\n')[0].slice(0, 40)}`)
}

console.log('\n=== 投递条件检查（MIN_STEP_CHARS=120, SETTLE_MS=5000）===')
const doneNo = parseInt((/done\s*:\s*S(\d+)/.exec(rd(board + '/state.md')) || [])[1] || '0')
console.log('doneNo =', doneNo)
for (const f of files.filter(x => /^S\d+\.md$/.test(x))) {
  const n = parseInt(f.slice(1))
  if (n <= doneNo) continue
  const t = rd(board + '/steps/' + f)
  const mt = fs.statSync(board + '/steps/' + f).mtimeMs
  const lenOk = t.trim().length >= 120
  const settleOk = Date.now() - mt >= 5000
  console.log(`  ${f}: 长度${t.trim().length}${lenOk ? '✅' : '❌不足120'} 稳定${Math.round((Date.now() - mt) / 1000)}s${settleOk ? '✅' : '❌未满5s'}`)
}

console.log('\n=== 事件（全部）===')
const evs = rd(board + '/events.jsonl').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } })
evs.forEach(e => console.log(' ', String(e.at).slice(11, 19), e.kind, JSON.stringify(e.detail || {}).slice(0, 110)))

console.log('\n=== 前台在做什么（chat 尾部）===')
const chat = (st.chat && st.chat.front) || []
chat.slice(-3).forEach(m => console.log(' ', m.role, ':', String(m.text || '').slice(0, 100).replace(/\n/g, ' ')))
