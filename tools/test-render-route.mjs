// renderRoute 端到端验证（无需任何模型额度）：建临时黑板，直接调 runtime 的 fr_route 实现
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeRuntime } from '../lib/runtime.js'

const boardRoot = mkdtempSync(join(tmpdir(), 'fr-route-'))
const boardDir = join(boardRoot, '.board')
const stepsDir = join(boardDir, 'steps')
mkdirSync(stepsDir, { recursive: true })
const P = { route: join(boardDir, 'route.md'), stepsDir, state: join(boardDir, 'state.md') }
writeFileSync(P.state, 'planVersion: 0\nstatus: working\ndone: S0\nassumesMatch: yes\nrouteOk: yes\n')

let stateDone = 'S0'
const K = { seenSteps: new Map(), milestoneGapCount: 0 }
const D = {
  cfg: {}, ctx: {}, K, TAG: 'test', BASE_PATH: '/fr', boardRoot, boardDir, P, BB: {},
  log: (m) => console.log('  [log]', m), vlog: () => {}, event: () => {},
  readIf: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : ''),
  readState: () => ({ done: stateDone, status: 'working' }),
  stepNo: (s) => Number(String(s).replace(/\D/g, '')) || 0,
  listSteps: () => readdirSync(stepsDir).filter((f) => /^S\d+\.md$/.test(f)),
  hasDeliver: () => false,
  alive: () => true,
  writeAtomic: (p, t) => writeFileSync(p, t),
}
const RT = makeRuntime(D)

// ★ 这就是之前炸掉的那条路径：plan 模式 + milestones + steps
const r = RT.renderRoute({
  mode: 'plan',
  goal: '为 kvengine 增加网络服务层',
  acceptance: ['RESP 协议解析通过', '并发请求 100 连接无错'],
  milestones: [{ id: 'M1', step: 'S1', desc: 'RESP 解析器' }, { id: 'M2', step: 'S2', desc: '并发接入' }],
  steps: [
    { id: 'S1', action: '实现 RESP 协议解析器', accept: '单测通过' },
    { id: 'S2', action: '接入并发连接处理', accept: '压测通过' },
  ],
})
const files = readdirSync(stepsDir).sort()
const route = readFileSync(P.route, 'utf8')
let fail = 0
const t = (name, cond) => { if (cond) console.log('PASS', name); else { fail++; console.log('FAIL', name) } }

t('返回 ok', r && r.ok === true)
t('未抛 doneNo ReferenceError（走到 stepsWritten）', r && r.stepsWritten === 2)
t('route.md 已生成', route.includes('## 里程碑') && route.includes('M1'))
t('写出 S1.md / S2.md', files.includes('S1.md') && files.includes('S2.md'))
t('S1 内容正确', readFileSync(join(stepsDir, 'S1.md'), 'utf8').includes('RESP 协议解析器'))

// append 模式：已存在步骤不重写
const r2 = RT.renderRoute({ mode: 'append', steps: [{ id: 'S3', action: '增加指标埋点' }, { id: 'S1', action: '不该被重写' }] })
t('append 只新增 S3', r2.ok && r2.stepsWritten === 1 && r2.stepsSkipped === 1)
t('append 不改 S1 内容', readFileSync(join(stepsDir, 'S1.md'), 'utf8').includes('RESP 协议解析器'))

// 判断点停写：含 needs:judge 的步之后截断
const r3 = RT.renderRoute({ mode: 'append', steps: [
  { id: 'S4', action: '需人工确认协议版本', needs: 'judge' },
  { id: 'S5', action: '依赖判断结果，不该落盘' },
] })
t('判断点停写：S4 写、S5 不写', r3.stepsWritten === 1 && !readdirSync(stepsDir).includes('S5.md'))
t('S4 带 needs: judge 标记', readFileSync(join(stepsDir, 'S4.md'), 'utf8').includes('needs: judge'))

rmSync(boardRoot, { recursive: true, force: true })
console.log(fail ? `❌ renderRoute: ${fail} fail` : '✅ renderRoute: 全部通过')
process.exit(fail ? 1 : 0)
