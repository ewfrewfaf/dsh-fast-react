import { parseSentinels, evalSentinel, evaluateSentinels } from '../lib/sentinel.js'
import { writeFileSync, existsSync } from 'fs'

let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('✅ ' + name) }
  else { fail++; console.log('❌ ' + name + (detail ? '  ' + detail : '')) }
}

// ── parseSentinels ──
const route1 = `# route
## 目标
做点事

## 哨兵条件
- C1 | file-exists | C:/tmp/a.txt
- C2 | file-absent | C:/tmp/b.txt
- C3 | field-cmp | done | >= | S3
- C4 | grep-match | C:/tmp/c.md | TODO

## 里程碑
- **M1**
`
const parsed = parseSentinels(route1)
t('解析出 4 条', parsed.length === 4, '实得 ' + parsed.length)
t('第1条 id=C1', parsed[0]?.id === 'C1')
t('第1条 kind=file-exists', parsed[0]?.kind === 'file-exists')
t('第4条 rest 含 TODO', String(parsed[3]?.rest).includes('TODO'))

// 带序号的标题（实测模型会这么写）
const route2 = `## 5. 哨兵条件（成立即路线作废）
- X1 | file-exists | /tmp/x
`
t('宽松标题匹配', parseSentinels(route2).length === 1)

// 无哨兵段
t('无哨兵段返回空', parseSentinels('# route\n## 目标\n').length === 0)

// ── evalSentinel ──
const deps = {
  readIf: (f) => (f === '/tmp/c.md' ? 'x TODO y' : ''),
  readState: () => ({ done: 'S5', status: 'working' }),
  stepNo: (s) => { const m = /S(\d+)/.exec(String(s)); return m ? Number(m[1]) : 0 },
}

t('file-exists 未命中', evalSentinel({ id: 'C1', kind: 'file-exists', rest: '/tmp/not-exist-zzz' }, deps) === null)
t('file-absent 命中', evalSentinel({ id: 'C2', kind: 'file-absent', rest: '/tmp/not-exist-zzz' }, deps) !== null)
t('field-cmp >= 命中', evalSentinel({ id: 'C3', kind: 'field-cmp', rest: 'done | >= | S3' }, deps) !== null)
t('field-cmp >= 未命中', evalSentinel({ id: 'C3', kind: 'field-cmp', rest: 'done | >= | S9' }, deps) === null)
t('grep-match 命中', evalSentinel({ id: 'C4', kind: 'grep-match', rest: '/tmp/c.md | TODO' }, deps) !== null)
t('grep-match 未命中', evalSentinel({ id: 'C4', kind: 'grep-match', rest: '/tmp/c.md | NOPE' }, deps) === null)
t('未知 kind 返回 null', evalSentinel({ id: 'X', kind: 'weird', rest: '' }, deps) === null)

// ── evaluateSentinels ──
const hits = evaluateSentinels(route1, deps)
t('批量求值返回数组', Array.isArray(hits))
t('命中项带 why', hits.every(h => typeof h.why === 'string' && h.why.length > 0))

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
