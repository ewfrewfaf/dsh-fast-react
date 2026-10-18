// 全量回归：一次性跑完所有检查项
const port = process.argv[2] || '4099'
const base = `http://127.0.0.1:${port}`
const fs = await import('node:fs')
const { execFileSync } = await import('node:child_process')

const root = 'C:/Users/admin/.dsh/plugins/dsh-fast-react'
const results = []
const run = (label, script, args = []) => {
  try {
    const out = execFileSync('node', [root + '/tools/' + script, ...args], { encoding: 'utf8', timeout: 180000 })
    const pass = /PASS/.test(out) || /全部通过: true/.test(out) || /0 失败/.test(out) || /通过 \/ 0/.test(out)
    const lastLines = out.trim().split('\n').slice(-3).join(' | ')
    results.push({ label, ok: pass, detail: lastLines.slice(0, 160) })
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '')
    const lastLines = out.trim().split('\n').slice(-3).join(' | ')
    results.push({ label, ok: false, detail: lastLines.slice(0, 160) || String(e.message).slice(0, 120) })
  }
}

console.log('=== 全量回归开始（可能需要几分钟）===\n')

// 1) 静态审计（只检查关键项，不判失败）
try {
  const out = execFileSync('node', [root + '/tools/audit-static.mjs'], { encoding: 'utf8', timeout: 60000 })
  const j = JSON.parse(out)
  const fatal = (j.issues || []).filter(x => x.level === 'error')
  results.push({ label: '静态审计（致命问题）', ok: fatal.length === 0, detail: fatal.length ? JSON.stringify(fatal) : '无致命问题' })
} catch (e) { results.push({ label: '静态审计', ok: false, detail: String(e.message).slice(0, 100) }) }

// 2) 自检 18 项
try {
  const out = execFileSync('node', [root + '/tools/selfcheck.mjs', port], { encoding: 'utf8', timeout: 120000 })
  const m = out.match(/结果：(\d+) 通过 \/ (\d+) 失败/)
  const pass = m ? Number(m[2]) === 0 : false
  results.push({ label: 'selfcheck 18 项', ok: pass, detail: m ? `${m[1]} 通过 / ${m[2]} 失败` : '无法解析' })
} catch (e) {
  const out = String(e.stdout || '')
  const m = out.match(/结果：(\d+) 通过 \/ (\d+) 失败/)
  results.push({ label: 'selfcheck 18 项', ok: m ? Number(m[2]) === 0 : false, detail: m ? `${m[1]}/${m[2]}` : String(e.message).slice(0, 100) })
}

// 3) UI/API 审计
try {
  const out = execFileSync('node', [root + '/tools/audit-ui-api.mjs', port], { encoding: 'utf8', timeout: 120000 })
  const m = out.match(/结果：(\d+) 通过 \/ (\d+) 失败/)
  results.push({ label: 'UI/API 审计', ok: m ? Number(m[2]) === 0 : false, detail: m ? `${m[1]} 通过 / ${m[2]} 失败` : '无法解析' })
} catch (e) {
  const out = String(e.stdout || '')
  const m = out.match(/结果：(\d+) 通过 \/ (\d+) 失败/)
  results.push({ label: 'UI/API 审计', ok: m ? Number(m[2]) === 0 : false, detail: m ? `${m[1]}/${m[2]}` : String(e.message).slice(0, 100) })
}

// 4) 代码关键修复点存在性
const src = fs.readFileSync(root + '/lib/index.js', 'utf8')
const api = fs.readFileSync(root + '/lib/api.js', 'utf8')
const page = fs.readFileSync(root + '/lib/ui/page.html', 'utf8')
const codeChecks = {
  'wire() 统一接线': src.includes('const wire = (frontId, backId)'),
  'effort 显式传': src.includes('reasoningEffort: effortFor(tag)'),
  'BOM 已除': !fs.readFileSync(root + '/package.json').slice(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])),
  '预规划（投递后即时）': src.includes("trigger: 'step-delivered'"),
  '无任务不跑哨兵': src.includes('hasActiveTask'),
  'H5 需伴随失败': src.includes('stepsThisTask > cfg.taskStepMax && toolStats.failStreak'),
  '同名工具失败才累加': src.includes('lastFailName'),
  '尊重用户走编排': src.includes('verdict-short-overruled'),
  '冻结只调一次': (src.match(/freezeFront\(hits\.map/g) || []).length === 1,
  '终局正文兜底': src.includes('final-answer-ask'),
  '新路线重置 done': src.includes('state-reset'),
  'wiring 健康度字段': api.includes("state,") && api.includes('frontMatched'),
  'policy 语义正确': api.includes('if (r && r.error) return fail(res, 404'),
  '面板显示自愈中': page.includes("自愈中…"),
  '不渲染 chat.back': !/chat\.back \|\| \[\]\)\.forEach/.test(page),
}
const codeFail = Object.entries(codeChecks).filter(([, v]) => !v)
results.push({ label: '代码修复点（15 项）', ok: codeFail.length === 0, detail: codeFail.length ? '缺失: ' + codeFail.map(([k]) => k).join(', ') : '全部存在' })

// 汇总
console.log('\n=== 回归结果 ===')
let fail = 0
for (const r of results) {
  if (!r.ok) fail++
  console.log(`${r.ok ? '✅' : '❌'} ${r.label}  ${r.detail}`)
}
console.log(`\n总计：${results.length - fail} 通过 / ${fail} 失败`)
console.log(fail === 0 ? '\n✅ PASS 全部回归通过' : '\n❌ FAIL 存在失败项')
