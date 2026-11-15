// 重启后活体冒烟（2026-11-15）：宿主侧改动需 DSH 重启才生效（路由闭包持旧 app，热重载无效已实测）。
// 用法：node tools/post-restart-smoke.mjs [--roundtrip]
//   默认只读：验证新 status 字段 / groups.archived / restore 动作已路由。
//   --roundtrip：建自检组 → 删除(归档) → 恢复 → 再删除(归档)，留下一个隐藏归档组作证据。
const BASE = process.env.FR_BASE || 'http://127.0.0.1:2172/fr'
const j = async (p, opt) => (await fetch(BASE + p, opt)).json()
let pass = 0, fail = 0
const t = (n, c) => { if (c) { pass++; console.log('✅ ' + n) } else { fail++; console.log('❌ ' + n) } }

const s = await j('/api/status')
t('status.presets 字段存在（宿主新代码已生效）', s && Object.prototype.hasOwnProperty.call(s, 'presets'))
t('status.judge 字段存在', s && Object.prototype.hasOwnProperty.call(s, 'judge'))
const g = await j('/api/groups')
t('groups.archived 字段存在', g && Array.isArray(g.archived))
const r = await j('/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'restore', key: '__no_such_group__' }) })
t('restore 动作已路由（假 key 返回"找不到归档"而非未知 action）', r && /找不到归档/.test(String(r.error || '')))

if (process.argv.includes('--roundtrip')) {
  const c = await j('/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', title: '自检-归档往返' }) })
  t('建自检组', c && c.ok && c.group)
  const key = c.group.key
  const d = await j('/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', key, force: true }) })
  t('删除=归档', d && d.ok)
  const g2 = await j('/api/groups')
  t('归档台账有记录', (g2.archived || []).some(x => x.key === key))
  const u = await j('/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'restore', key }) })
  t('恢复成功', u && u.ok)
  const g3 = await j('/api/groups')
  t('恢复后回列表且归档清空', (g3.groups || []).some(x => x.key === key) && !(g3.archived || []).some(x => x.key === key))
  const d2 = await j('/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', key, force: true }) })
  t('再删除留归档作证据', d2 && d2.ok)
}
console.log(`smoke: ${pass}/${pass + fail} pass`)
process.exit(fail ? 1 : 0)
