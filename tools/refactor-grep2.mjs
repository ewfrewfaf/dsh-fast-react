// refactor-grep2.mjs —— 第二阶段重构辅助：整词引用定位（临时 scratch，最后删）
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(import.meta.dirname, '..')
const file = process.argv[2] || 'lib/index.js'
const t = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')
const names = process.argv.slice(3)
for (const n of names) {
  const re = new RegExp('\\b' + n.replace(/[$]/g, '\\$') + '\\b')
  const hits = []
  t.forEach((l, i) => { if (re.test(l)) hits.push(i + 1) })
  console.log(n.padEnd(24), hits.join(',') || '(none)')
}
