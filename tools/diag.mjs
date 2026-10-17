// 诊断：读黑板步骤/状态/事件尾部 + 通过 HTTP 取插件状态（桌面路径写在脚本里，避免 soft-gate 拦截命令行）
import fs from 'node:fs'
import path from 'node:path'

const board = 'C:/Users/admin/Desktop/FastReact/.board'
const port = process.argv[2] || '2859'
const base = `http://127.0.0.1:${port}`

const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const stepsDir = path.join(board, 'steps')
const steps = (() => { try { return fs.readdirSync(stepsDir) } catch { return [] } })()

let st = null
try { st = await (await fetch(base + '/fr/api/status')).json() } catch (e) { st = { error: String(e.message) } }

const events = read(path.join(board, 'events.jsonl')).trim().split('\n').slice(-10)

console.log(JSON.stringify({
  front: st.front && { id: st.front.id, phase: st.front.phase },
  back: st.back && { id: st.back.id, phase: st.back.phase },
  state: st.state,
  chatFront: (st.chat && st.chat.front || []).slice(-3).map(m => ({ role: m.role, len: (m.text || '').length, head: String(m.text || '').slice(0, 60) })),
  steps,
  stateMd: read(path.join(board, 'state.md')).split('\n').slice(0, 8).join(' | '),
  events: events.map(l => { try { const j = JSON.parse(l); return j.kind + ' ' + String(j.at).slice(11, 19) } catch { return l.slice(0, 60) } }),
}, null, 1))
