// 运行时审计：一次性采集所有关键状态，用于定位真实 bug
import fs from 'node:fs'
const port = process.argv[2] || '4099'
const base = `http://127.0.0.1:${port}`
const board = 'C:/Users/admin/Desktop/FastReact/.board'
const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const j = async (p, opt) => {
  try { const r = await fetch(base + p, opt); const t = await r.text(); return JSON.parse(t) } catch (e) { return { error: String(e.message) } }
}

const out = { at: new Date().toISOString(), port }

// 1) 插件存活
const st = await j('/fr/api/status')
out.status = st.error ? { error: st.error } : {
  front: st.front, back: st.back, models: st.models, stall: st.stall,
  permissions: st.permissions, ctx: st.ctx, state: st.state,
  chatFront: (st.chat && st.chat.front || []).length,
  chatBack: (st.chat && st.chat.back || []).length,
  t3: st.t3Blocked, tools: st.tools,
}

// 2) 配置（含新字段是否生效）
const cfg = await j('/fr/api/config')
out.cfg = cfg.cfg ? {
  enabled: cfg.cfg.enabled, provider: cfg.cfg.provider, model: cfg.cfg.model,
  frontEffort: cfg.cfg.frontEffort, backEffort: cfg.cfg.backEffort,
  pipelinePrefetch: cfg.cfg.pipelinePrefetch, prefetchCooldownMs: cfg.cfg.prefetchCooldownMs,
  sentinelEnabled: cfg.cfg.sentinelEnabled, stallWatchdog: cfg.cfg.stallWatchdog,
  lookahead: cfg.cfg.lookahead, batchSteps: cfg.cfg.batchSteps,
} : { error: 'no cfg' }

// 3) 会话清单
const sess = await j('/fr/api/sessions')
out.sessions = (sess.sessions || []).map(s => ({ id: s.id.slice(0, 26), role: s.role, phase: s.phase, group: s.group, preset: s.preset }))

// 4) 黑板
out.board = {
  state: rd(board + '/state.md').split('\n').slice(0, 6).join(' | '),
  steps: (() => { try { return fs.readdirSync(board + '/steps').filter(f => /^S\d+\.md$/.test(f)).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1))) } catch { return [] } })(),
  hasDeliver: (() => { try { return fs.readdirSync(board).some(f => /^deliver\.v\d+\.md$/.test(f)) } catch { return false } })(),
  hasHandoff: (() => { try { return fs.existsSync(board + '/handoff.md') } catch { return false } })(),
  stale: (() => { try { return fs.readdirSync(board + '/stale') } catch { return [] } })(),
}

// 5) 事件统计（按 kind 聚合）+ 最近 15 条
const evs = rd(board + '/events.jsonl').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const byKind = {}
evs.forEach(e => { byKind[e.kind] = (byKind[e.kind] || 0) + 1 })
out.events = { total: evs.length, byKind, recent: evs.slice(-15).map(e => `${String(e.at).slice(11, 19)} ${e.kind}`) }

// 6) 心跳统计（失败率）
const hb = rd(board + '/heartbeat.log').trim().split('\n').filter(Boolean)
const failLines = hb.filter(l => /FAIL/.test(l))
out.heartbeat = { total: hb.length, fails: failLines.length, lastFail: failLines.slice(-1)[0] || '' }

// 7) 日志中的错误
const log = rd('C:/Users/admin/.dsh/super-injector/fast-react.log').trim().split('\n')
const errs = log.filter(l => /fail|error|失败|异常|undefined|cannot|NaN/i.test(l) && !/0 fail/i.test(l))
out.logErrors = errs.slice(-10).map(l => l.slice(0, 170))

console.log(JSON.stringify(out, null, 1))
