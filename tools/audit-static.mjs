// 静态审计：找出潜在 bug（未定义变量、重复定义、死代码、可疑模式）
import fs from 'node:fs'
const p = 'C:/Users/admin/.dsh/plugins/dsh-fast-react/lib/index.js'
const src = fs.readFileSync(p, 'utf8')
const lines = src.split('\n')

const issues = []

// 1) 重复的 var/let/const 声明（同名字符串出现多次且有 = 赋值）
const declRe = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/
const decls = new Map()
lines.forEach((l, i) => {
  const m = l.match(declRe)
  if (m) {
    const name = m[1]
    if (!decls.has(name)) decls.set(name, [])
    decls.get(name).push(i + 1)
  }
})
for (const [name, at] of decls) {
  if (at.length > 1) {
    // 检查是否在同一个作用域（粗略：都在顶层缩进）
    const sameIndent = at.every(n => (lines[n - 1].match(/^\s*/)[0].length) === (lines[at[0] - 1].match(/^\s*/)[0].length))
    if (sameIndent) issues.push({ type: '重复声明', detail: `${name} 在行 ${at.join(', ')}`, level: 'warn' })
  }
}

// 2) 调用了但从未定义的函数（常见笔误）
const defined = new Set()
const defRe = /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\()/g
let m
while ((m = defRe.exec(src))) defined.add(m[1] || m[2])
const callRe = /\b([a-zA-Z_$][\w$]{2,})\s*\(/g
const builtin = new Set(['if','for','while','switch','catch','return','function','typeof','new','delete','void','await','async','parseInt','parseFloat','String','Number','Boolean','Array','Object','JSON','Math','Date','Promise','Set','Map','Error','RegExp','require','import','console','setTimeout','setInterval','clearTimeout','clearInterval','fetch','encodeURIComponent','decodeURIComponent','isNaN','isFinite','structuredClone','queueMicrotask'])
const undefinedCalls = new Set()
while ((m = callRe.exec(src))) {
  const name = m[1]
  if (builtin.has(name)) continue
  if (defined.has(name)) continue
  // 方法调用（前面有点）不算
  const idx = m.index
  if (idx > 0 && src[idx - 1] === '.') continue
  undefinedCalls.add(name)
}
if (undefinedCalls.size) issues.push({ type: '可能的未定义调用', detail: [...undefinedCalls].slice(0, 15).join(', '), level: 'info' })

// 3) 检查常见的可疑逻辑：if (x) return 后又有 x 的判断
const suspiciousPatterns = [
  { re: /doneNo >= maxNo\)\s*return[\s\S]{0,200}?doneNo >= maxNo/, name: '同一条件重复判断（可能有死代码）' },
  { re: /setInterval\([^)]*\)[\s\S]{0,100}?setInterval\(/, name: '多个 setInterval（确认是否重复注册）', level: 'info' },
]

// 4) 关键函数存在性
const required = ['resolveAgents','steerFront','wakeBack','freezeFront','runSentinels','checkLookahead','checkNewSteps','wire','effortFor','deliver','listSessions','sessionInfo','createGroup','deleteGroup','switchGroup','repairGroups','setGroupPolicy']
const missing = required.filter(f => !src.includes(f))
if (missing.length) issues.push({ type: '关键函数缺失', detail: missing.join(', '), level: 'error' })

// 5) TODO/FIXME/临时
const todos = lines.map((l, i) => ({ l, i: i + 1 })).filter(x => /TODO|FIXME|XXX|临时|待修/i.test(x.l))
if (todos.length) issues.push({ type: '遗留标记', detail: todos.map(t => `L${t.i}`).join(', '), level: 'info' })

// 6) console.log 残留（生产代码不应有）
const logs = lines.map((l, i) => ({ l, i: i + 1 })).filter(x => /console\.(log|debug|warn|error)/.test(x.l))
if (logs.length) issues.push({ type: 'console 残留', detail: logs.map(t => `L${t.i}`).join(', '), level: 'info' })

// 7) 递归/无限循环风险：while 无明确退出
const whiles = lines.map((l, i) => ({ l, i: i + 1 })).filter(x => /^\s*while\s*\(/.test(x.l))
if (whiles.length > 3) issues.push({ type: 'while 循环较多', detail: whiles.map(t => `L${t.i}`).join(', '), level: 'info' })

console.log(JSON.stringify({ totalIssues: issues.length, issues }, null, 1))
