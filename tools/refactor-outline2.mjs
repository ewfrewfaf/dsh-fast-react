// refactor-outline2.mjs —— 列出 apply() 顶层语句（类型/名字/行段），供切割地图复核（scratch，最后删）
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require2 = createRequire(import.meta.url)
const ts = require2(process.env.FRT_TS || 'C:/Users/admin/.dsh/plugins/dsh-ego-browser/node_modules/typescript')
const ROOT = path.resolve(import.meta.dirname, '..')
const INDEX = path.join(ROOT, 'lib', 'index.js')
const text = fs.readFileSync(INDEX, 'utf8')
const sf = ts.createSourceFile(INDEX, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
const applyFn = sf.statements.find((s) => ts.isFunctionDeclaration(s) && s.name && s.name.text === 'apply')
const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1
const lo = Number(process.argv[2] || 0), hi = Number(process.argv[3] || 99999)
for (const st of applyFn.body.statements) {
  const s = lineOf(st.getStart(sf)), e = lineOf(st.end)
  if (e < lo || s > hi) continue
  let kind = ts.SyntaxKind[st.kind], name = ''
  if (ts.isFunctionDeclaration(st)) name = st.name ? st.name.text : '(anon)'
  else if (ts.isVariableStatement(st)) name = st.declarationList.declarations.map((d) => d.name.getText(sf)).join(',')
  else if (ts.isExpressionStatement(st)) {
    const ex = st.expression
    if (ts.isBinaryExpression(ex)) name = ex.left.getText(sf) + ' ='
    else if (ts.isCallExpression(ex)) name = ex.getText(sf).slice(0, 60)
    else name = ex.getText(sf).slice(0, 60)
  } else name = st.getText(sf).split('\n')[0].slice(0, 70)
  console.log(`${String(s).padStart(5)}-${String(e).padEnd(5)} ${kind.padEnd(22)} ${name}`)
}
