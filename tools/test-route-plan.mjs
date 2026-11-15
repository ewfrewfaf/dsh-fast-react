import { validateRouteArgs, capMilestones, filterSentinels, buildRouteMarkdown }
  from '../lib/route-plan.js'

let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('✅ ' + name) }
  else { fail++; console.log('❌ ' + name + (detail ? '  ' + detail : '')) }
}

// ── validateRouteArgs ──
t('plan 缺 goal+milestones 报错', validateRouteArgs({}, false).ok === false)
t('plan 有 milestone 即可', validateRouteArgs({ milestones: [{ id: 'M1', desc: 'x' }] }, false).ok === true)
t('plan 有 goal 即可', validateRouteArgs({ goal: '做事' }, false).ok === true)
t('append 缺 steps 报错', validateRouteArgs({}, true).ok === false)
t('append 有 steps 通过', validateRouteArgs({ steps: [{ id: 'S1', action: 'x' }] }, true).ok === true)

// ── capMilestones ──
{
  const r = capMilestones([{ id: 'M1' }, { id: 'M2' }], 0)
  t('首次规划不截断', r.truncated === false && r.ms.length === 2)
}
{
  const r = capMilestones([{ id: 'M1' }, { id: 'M2' }, { id: 'M3' }], 2)
  t('补步阶段外扩被截断', r.truncated === true && r.ms.length === 2 && r.want === 3)
}
{
  const r = capMilestones([{ id: 'M1' }], 3)
  t('减少里程碑允许', r.truncated === false && r.ms.length === 1)
}

// ── filterSentinels ──
const deps = {
  exists: (p) => p.includes('exists.md'),
  isAbsolute: (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/'),
  root: '/board',
}
{
  const r = filterSentinels([{ id: 'C1', kind: 'file-exists', target: '/board/exists.md' }], deps)
  t('file-exists 目标已存在 ⇒ 拒绝', r.kept.length === 0 && r.rejected[0]?.why === 'already-exists')
}
{
  const r = filterSentinels([{ id: 'C2', kind: 'file-exists', target: '/board/future.md' }], deps)
  t('file-exists 目标不存在 ⇒ 保留', r.kept.length === 1)
}
{
  const r = filterSentinels([{ id: 'C3', kind: 'file-absent', target: '/board/missing.md' }], deps)
  t('file-absent 目标已缺失 ⇒ 拒绝', r.kept.length === 0 && r.rejected[0]?.why === 'already-absent')
}
{
  const r = filterSentinels([{ id: 'C4', kind: 'field-cmp', target: 'done | >= | S3' }], deps)
  t('field-cmp 不受影响', r.kept.length === 1)
}
{
  const r = filterSentinels([
    { id: 'C5', kind: 'file-exists', target: '/board/exists.md' },
    { id: 'C6', kind: 'file-exists', target: '/board/future.md' },
  ], deps)
  t('混合：1 拒 1 留', r.kept.length === 1 && r.rejected.length === 1)
}

// ── buildRouteMarkdown ──
{
  const md = buildRouteMarkdown({
    goal: '做件事',
    acceptance: ['A1 通过'],
    milestones: [{ id: 'M1', desc: '第一步', step: 'S1' }],
    sentinels: [{ id: 'C1', kind: 'file-exists', target: '/x' }],
  })
  t('含目标', md.includes('## 目标') && md.includes('做件事'))
  t('含终态判定', md.includes('## 终态判定') && md.includes('A1 通过'))
  t('含里程碑+步号', md.includes('## 里程碑') && md.includes('**M1（S1）**'))
  t('含哨兵', md.includes('## 哨兵条件') && md.includes('C1 | file-exists | /x'))
}
{
  const md = buildRouteMarkdown({ goal: 'x', milestones: [] })
  t('无哨兵时不输出哨兵段', !md.includes('## 哨兵条件'))
}

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
