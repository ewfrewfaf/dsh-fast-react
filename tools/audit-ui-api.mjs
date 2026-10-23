// UI/API 审计：页面结构、接口契约、错误路径
const port = process.argv[2] || '4099'
const base = `http://127.0.0.1:${port}`
const j = async (p, opt) => {
  try {
    const r = await fetch(base + p, opt)
    const t = await r.text()
    let parsed = null
    try { parsed = JSON.parse(t) } catch { /* 非 JSON */ }
    return { status: r.status, text: t, json: parsed }
  } catch (e) { return { error: String(e.message) } }
}

const out = []
const add = (name, ok, detail) => out.push({ name, ok, detail: String(detail || '') })

// 1) 页面
const page = await j('/fr')
add('页面可访问', page.status === 200, `HTTP ${page.status} ${page.text ? page.text.length + 'B' : ''}`)
const html = page.text || ''
for (const [name, needle] of [
  ['会话组面板', 'id="groupsModal"'],
  ['模型切换', 'id="btnModel"'],
  ['发送即打断', 'id="fireMode"'],
  ['权限切换按钮', 'perm-btn'],
  ['思考折叠', 'class="think"'],
  ['复制按钮', 'class="copy"'],
  ['草稿保存', 'DRAFT_KEY'],
  ['Ctrl+K', "'k'"],
  ['空状态大字', 'empty-title'],
]) add('  └ ' + name, html.includes(needle))

// 2) 不渲染后台消息（上次修的）
add('  └ 不渲染 chat.back', !html.includes('chat.back || []').length || html.includes('不再渲染 chat.back'))

// 3) 关键 API
const st = await j('/fr/api/status')
add('/status', st.status === 200, st.json ? `wiring=${JSON.stringify(st.json.wiring || null)}` : '')
add('  └ wiring 字段存在', !!(st.json && st.json.wiring))

const cfg = await j('/fr/api/config')
add('/config GET', cfg.status === 200 && !!cfg.json.cfg)
add('  └ pipelinePrefetch 可见', cfg.json && cfg.json.cfg && cfg.json.cfg.pipelinePrefetch !== undefined, cfg.json && cfg.json.cfg && cfg.json.cfg.pipelinePrefetch)

const sess = await j('/fr/api/sessions')
add('/sessions', sess.status === 200 && Array.isArray(sess.json.sessions), (sess.json && sess.json.sessions || []).length + ' 个')

const groups = await j('/fr/api/groups')
add('/groups', groups.status === 200, (groups.json && groups.json.groups || []).length + ' 组')
add('  └ 权限目录', !!(groups.json && groups.json.permission && groups.json.permission.options.length))

const models = await j('/fr/api/models')
add('/models', models.status === 200 && (models.json.providers || []).length > 0, (models.json && models.json.providers || []).length + ' provider')

// 4) 错误路径（应该优雅失败，不是 500）
const bad1 = await j('/fr/api/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
add('空 text 应 400', bad1.status === 400, `HTTP ${bad1.status}`)
const bad2 = await j('/fr/api/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x', sessionId: 'nope' }) })
add('无效 sessionId 应 4xx', bad2.status >= 400 && bad2.status < 500, `HTTP ${bad2.status}`)
const bad3 = await j('/fr/api/session?id=nope')
add('无效 session 查询应 404', bad3.status === 404, `HTTP ${bad3.status}`)
const bad4 = await j('/fr/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'policy', key: 'FR-99', preset: 'x' }) })
add('无效组 policy 应报错', !!(bad4.json && bad4.json.error), JSON.stringify(bad4.json || {}).slice(0, 60))
const bad5 = await j('/fr/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'zzz' }) })
add('未知 action 应 400', bad5.status === 400, `HTTP ${bad5.status}`)

// 5) 鉴权/安全：path traversal
const trav = await j('/fr/sidebar.js/../../index.js')
add('路径穿越不泄露', trav.status === 404 || (trav.text || '').indexOf('FRONT_BRIEF') < 0, `HTTP ${trav.status}`)

const pass = out.filter(x => x.ok).length
out.forEach(x => console.log(`${x.ok ? '✅' : '❌'} ${x.name}${x.detail ? '  ' + x.detail : ''}`))
console.log(`\n结果：${pass} 通过 / ${out.length - pass} 失败 / 共 ${out.length}`)
