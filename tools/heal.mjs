// 升级/重启后自愈：启动接线 + 打印关键状态（不依赖外部工具）
const port = process.argv[2] || '1784'
const base = `http://127.0.0.1:${port}`
const j = async (p, opt) => {
  const r = await fetch(base + p, opt)
  const t = await r.text()
  try { return { status: r.status, json: JSON.parse(t) } } catch { return { status: r.status, text: t } }
}
const out = {}
out.status = await j('/fr/api/status').catch((e) => ({ err: String(e.message) }))
if (out.status.status !== 200) {
  console.log(JSON.stringify({ error: '插件未就绪', status: out.status }, null, 1))
  process.exit(1)
}
const before = out.status.json
console.log('重启后初态 front=%s back=%s', before.front && before.front.phase, before.back && before.back.phase)
if (!before.front || !before.back) {
  await j('/fr/api/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  await new Promise((r) => setTimeout(r, 4000))
}
const st = (await j('/fr/api/status')).json
const cfg = (await j('/fr/api/config')).json
const sess = (await j('/fr/api/sessions')).json
console.log(JSON.stringify({
  front: st.front, back: st.back,
  models: st.models,
  stall: st.stall,
  permissions: st.permissions,
  ctx: st.ctx,
  enabled: cfg.cfg && cfg.cfg.enabled,
  effortCfg: { front: cfg.cfg && cfg.cfg.frontEffort, back: cfg.cfg && cfg.cfg.backEffort },
  sessions: (sess.sessions || []).length,
}, null, 1))
