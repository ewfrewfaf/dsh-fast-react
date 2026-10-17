#!/usr/bin/env node
/**
 * 快速反应 · 插件自检脚本（升级 DSH 前后各跑一次，对照结果）
 *
 * 用法：
 *   node tools/selfcheck.mjs                 # 默认 127.0.0.1:19387
 *   node tools/selfcheck.mjs 19388           # 指定端口
 *   node tools/selfcheck.mjs 19387 out.json  # 结果另存 JSON（做基线）
 */
const port = process.argv[2] || '19387'
const outFile = process.argv[3] || ''
const base = `http://127.0.0.1:${port}`

const checks = []
function add(name, ok, detail) { checks.push({ name, ok, detail: String(detail ?? '') }) }
async function j(path) {
  const r = await fetch(base + path)
  const t = await r.text()
  try { return { status: r.status, json: JSON.parse(t) } } catch { return { status: r.status, text: t } }
}
async function txt(path) {
  const r = await fetch(base + path)
  return { status: r.status, text: await r.text() }
}

// ① 插件是否加载（侧边栏注入脚本可访问 + 版本号正确）
try {
  const s = await txt('/fr/sidebar.js?t=' + Date.now())
  const ver = (s.text.match(/var VERSION = '([^']+)'/) || [])[1] || ''
  add('sidebar.js 可访问', s.status === 200 && s.text.length > 1000, `HTTP ${s.status} / ${s.text.length}B`)
  add('侧边栏脚本版本', ver === '1.0', ver || '(未找到 VERSION)')
} catch (e) { add('sidebar.js 可访问', false, e.message) }

// ② 控制台页面（UI 结构）
try {
  const p = await txt('/fr?t=' + Date.now())
  add('控制台页面可打开', p.status === 200, `HTTP ${p.status}`)
  add('  └ 会话组面板存在', p.text.includes('id="groupsModal"'), '')
  add('  └ 模型切换存在', p.text.includes('id="btnModel"'), '')
  add('  └ 发送即打断开关', p.text.includes('id="fireMode"'), '')
} catch (e) { add('控制台页面可打开', false, e.message) }

// ③ status：核心服务（agentLoop / approval / permissionPresets / workspace 等都会体现在这里）
try {
  const { json: d } = await j('/fr/api/status')
  add('status 接口', !!(d && d.ok !== false), '')
  add('  └ 前后台接线', !!(d.front || d.back), `front=${d.front ? d.front.phase : 'null'} back=${d.back ? d.back.phase : 'null'}`)
  add('  └ models 字段', !!(d.models && d.models.model), JSON.stringify(d.models))
  add('  └ permissions 字段', !!(d.permissions), JSON.stringify(d.permissions))
  add('  └ stall 看门狗字段', !!(d.stall), JSON.stringify(d.stall))
  add('  └ chat 结构', Array.isArray((d.chat || {}).front), `front=${((d.chat || {}).front || []).length}条`)
  add('  └ state 黑板状态', !!d.state, JSON.stringify(d.state))
} catch (e) { add('status 接口', false, e.message) }

// ④ 模型目录（ctx.llm 发现能力）
try {
  const { json: m } = await j('/fr/api/models')
  const n = (m.providers || []).length
  add('models 接口 / ctx.llm', n > 0, `${n} 个 provider`)
} catch (e) { add('models 接口 / ctx.llm', false, e.message) }

// ⑤ 会话组（groups + permissionPresets 目录）
try {
  const { json: g } = await j('/fr/api/groups')
  add('groups 接口', !!g.ok, `groups=${(g.groups || []).length}`)
  const opts = ((g.permission || {}).options || []).length
  add('  └ permissionPresets 目录', opts > 0, `${opts} 个预设`)
} catch (e) { add('groups 接口', false, e.message) }

// ⑥ 会话清单（ctx.agents.list）
try {
  const { json: s } = await j('/fr/api/sessions')
  add('sessions 接口 / ctx.agents', Array.isArray(s.sessions), `共 ${(s.sessions || []).length} 个会话`)
} catch (e) { add('sessions 接口 / ctx.agents', false, e.message) }

// ⑦ 工作区挂载（workspaceRegistry）——通过当前前后台是否已挂进工作区间接判断
try {
  const { json: d } = await j('/fr/api/status')
  const wired = [d.front, d.back].filter(Boolean).length
  add('前后台可用（工作区挂载前提）', wired > 0, `${wired}/2`)
} catch { /* 已在③覆盖 */ }

const pass = checks.filter((c) => c.ok).length
const fail = checks.length - pass
for (const c of checks) {
  console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? '  ' + c.detail : ''}`)
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败 / 共 ${checks.length}`)
if (outFile) {
  const fs = await import('node:fs')
  fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), port, pass, fail, checks }, null, 2))
  console.log(`已保存：${outFile}`)
}
process.exit(fail ? 1 : 0)
