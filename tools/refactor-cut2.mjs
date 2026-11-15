// refactor-cut2.mjs —— 第二阶段重构机械切割器（runtime / api-app / tools-reg）
// 基于 cut1 的 TS-checker 符号级改名逻辑，扩展：
//   · retNames 含全部被移走的顶层声明（函数 + 普通 const），保证 RT.xxx 外部引用可解析
//   · factoryAtEnd：工厂调用放在段尾（tools-reg 的 K 初始化必须先于注册副作用）
//   · object 模式：整个对象字面量抽出（api-app），drop 指定行、改名、自定义 index 重组
// 用法：node tools/refactor-cut2.mjs cut <runtime|api-app|tools-reg> | audit
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require2 = createRequire(import.meta.url)
const ts = require2(process.env.FRT_TS || 'C:/Users/admin/.dsh/plugins/dsh-ego-browser/node_modules/typescript')
const ROOT = path.resolve(import.meta.dirname, '..')
const INDEX = path.join(ROOT, 'lib', 'index.js')
const RANGES = path.join(ROOT, 'tools', 'refactor-ranges2.json')
const STABLE = new Set(['K', 'cfg', 'ctx', 'log', 'vlog', 'event', 'TAG', 'BASE_PATH', 'boardRoot', 'boardDir', 'P', 'BB'])

function makeProgram (file, text) {
  const opts = { allowJs: true, checkJs: false, noEmit: true, noLib: true, skipLibCheck: true,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }
  const host = ts.createCompilerHost(opts)
  const norm = (n) => path.resolve(n).toLowerCase()
  const origGet = host.getSourceFile.bind(host)
  host.getSourceFile = (name, lang, onError, shouldCreate) =>
    norm(name) === norm(file) ? ts.createSourceFile(name, text, lang, true, ts.ScriptKind.JS) : origGet(name, lang, onError, shouldCreate)
  host.fileExists = (n) => norm(n) === norm(file) ? true : ts.sys.fileExists(n)
  host.readFile = (n) => norm(n) === norm(file) ? text : ts.sys.readFile(n)
  const prog = ts.createProgram([file], opts, host)
  const sf = prog.getSourceFile(file)
  if (!sf) throw new Error('parse failed: ' + file)
  return { sf, checker: prog.getTypeChecker() }
}
function walk (node, cb) { cb(node); ts.forEachChild(node, (c) => walk(c, cb)) }
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1
function applyEdits (text, edits) {
  edits.sort((a, b) => b.start - a.start || b.end - a.end)
  let last = Infinity
  for (const e of edits) {
    if (e.end > last) throw new Error(`edit overlap at ${e.start}..${e.end} (last=${last})`)
    text = text.slice(0, e.start) + e.text + text.slice(e.end)
    last = e.start
  }
  return text
}
function isNonRefPosition (node) {
  const p = node.parent
  if (!p) return true
  if (ts.isPropertyAccessExpression(p) && p.name === node) return true
  if (ts.isPropertyAssignment(p) && p.name === node) return true
  if (ts.isMethodDeclaration(p) && p.name === node) return true
  if (ts.isMethodSignature(p) && p.name === node) return true
  if (ts.isVariableDeclaration(p) && p.name === node) return true
  if (ts.isParameter(p) && p.name === node) return true
  if (ts.isFunctionDeclaration(p) && p.name === node) return true
  if (ts.isFunctionExpression(p) && p.name === node) return true
  if (ts.isClassDeclaration(p) && p.name === node) return true
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p)) return true
  if (ts.isBindingElement(p) && p.name === node) return true
  if (ts.isLabeledStatement(p) && p.label === node) return true
  if (ts.isBreakOrContinueStatement(p) && p.label === node) return true
  return false
}
function refSymbol (checker, node) {
  const p = node.parent
  if (p && ts.isShorthandPropertyAssignment(p) && p.name === node) return checker.getShorthandAssignmentValueSymbol(p)
  return checker.getSymbolAtLocation(node)
}
function findApply (sf) {
  const fn = sf.statements.find((s) => ts.isFunctionDeclaration(s) && s.name && s.name.text === 'apply')
  if (!fn || !fn.body) throw new Error('apply() not found')
  return fn
}

function cut (modName) {
  const cfgAll = JSON.parse(fs.readFileSync(RANGES, 'utf8'))
  const cfg = cfgAll[modName]
  if (!cfg) throw new Error('no config for ' + modName)
  const isObject = !!cfg.object
  const text = fs.readFileSync(INDEX, 'utf8')
  const lines = text.split('\n')
  const { sf, checker } = makeProgram(INDEX, text)
  const applyFn = findApply(sf)

  const allRanges = [...cfg.move.map((r) => ({ ...r, kind: 'move' }))]
  for (const r of allRanges) {
    const fl = lines[r.s - 1], ll = lines[r.e - 1]
    if (!fl || !fl.includes(r.first)) throw new Error(`anchor mismatch ${modName} L${r.s}: expect "${r.first}" got "${fl}"`)
    if (!ll || !ll.includes(r.last)) throw new Error(`anchor mismatch ${modName} L${r.e}: expect "${r.last}" got "${ll}"`)
  }
  const inRanges = (pos) => { const ln = lineOf(sf, pos); return allRanges.some((r) => ln >= r.s && ln <= r.e) }
  // stay：apply 顶层 K.x = 初始化（AST）+ 显式 stay 段
  const kAssignLines = new Set()
  for (const st of applyFn.body.statements) {
    if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = st.expression.left
      if (ts.isPropertyAccessExpression(l) && ts.isIdentifier(l.expression) && l.expression.text === 'K') kAssignLines.add(lineOf(sf, st.getStart(sf)))
    }
  }
  const staySet = new Set()
  for (const r of cfg.move) for (let ln = r.s; ln <= r.e; ln++) {
    if (kAssignLines.has(ln) || (cfg.stay || []).some((s) => ln >= s.s && ln <= s.e)) staySet.add(ln)
  }
  // object 模式：drop 行（spread）也视为 stay（不抽走），但 index 侧整段删除
  const dropSet = new Set()
  if (isObject) for (const r of cfg.move) for (let ln = r.s; ln <= r.e; ln++) {
    if ((cfg.object.drop || []).some((d) => lines[ln - 1].includes(d))) dropSet.add(ln)
  }

  // 顶层被移走的声明名（函数 + 单标识符 const），用于 return
  const topLevelHelpers = []
  walk(sf, (node) => {
    const isTopFn = ts.isFunctionDeclaration(node) && node.name && node.parent === applyFn.body
    const isTopVar = ts.isVariableStatement(node) && node.parent === applyFn.body
    if (!isTopFn && !isTopVar) return
    if (!inRanges(node.getStart(sf))) return
    if (staySet.has(lineOf(sf, node.getStart(sf)))) return
    if (isTopFn) { topLevelHelpers.push(node.name.text); return }
    const ds = node.declarationList.declarations
    if (ds.length === 1 && ts.isIdentifier(ds[0].name)) topLevelHelpers.push(ds[0].name.text)
  })

  // 被移走声明的符号（index 剩余代码加前缀）；object 模式不加前缀（apiApp 仍在 index 重组声明）
  const movedDeclSyms = new Set()
  if (!isObject) walk(sf, (node) => {
    const isDecl = (ts.isFunctionDeclaration(node) && node.name) ||
      (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) ||
      (ts.isMethodDeclaration(node) && node.name)
    if (!isDecl) return
    if (!inRanges(node.getStart(sf))) return
    if (staySet.has(lineOf(sf, node.getStart(sf)))) return
    const sym = checker.getSymbolAtLocation(node.name)
    if (sym) movedDeclSyms.add(sym)
  })

  const dFields = new Set()
  const importNeeds = new Map()
  const moduleEdits = []
  const indexPrefixEdits = []
  const unresolved = new Set()
  walk(sf, (node) => {
    if (!ts.isIdentifier(node)) return
    const ln0 = lineOf(sf, node.getStart(sf))
    const inside = inRanges(node.getStart(sf)) && !staySet.has(ln0) && !dropSet.has(ln0)
    if (isNonRefPosition(node)) return
    const sym = refSymbol(checker, node)
    if (inside) {
      if (!sym) { if (/^[A-Z_$]/.test(node.text) || ['process', 'console', 'arguments'].includes(node.text)) unresolved.add(node.text); return }
      const decl = sym.declarations && sym.declarations[0]
      if (!decl) return
      if (ts.isImportSpecifier(decl)) {
        const impDecl = decl.parent.parent.parent
        const mod = impDecl.moduleSpecifier.text
        if (!importNeeds.has(mod)) importNeeds.set(mod, new Set())
        importNeeds.get(mod).add(decl.propertyName ? `${decl.propertyName.text} as ${decl.name.text}` : decl.name.text)
        return
      }
      if (inRanges(decl.getStart(sf)) && !dropSet.has(lineOf(sf, decl.getStart(sf)))) return
      const declFile = decl.getSourceFile()
      if (declFile.fileName !== sf.fileName) {
        let imp = decl
        while (imp && !ts.isImportSpecifier(imp) && !ts.isImportClause(imp) && !ts.isNamespaceImport(imp)) imp = imp.parent
        if (imp && ts.isImportSpecifier(imp)) {
          const spec = imp.parent.parent.parent
          const mod = spec.moduleSpecifier.text
          if (!importNeeds.has(mod)) importNeeds.set(mod, new Set())
          importNeeds.get(mod).add(imp.name.text)
        }
        return
      }
      const name = node.text
      if (STABLE.has(name)) return
      dFields.add(name)
      const p = node.parent
      if (ts.isShorthandPropertyAssignment(p) && p.name === node) moduleEdits.push({ start: node.getStart(sf), end: node.end, text: `${name}: D.${name}` })
      else moduleEdits.push({ start: node.getStart(sf), end: node.end, text: `D.${name}` })
    } else {
      if (!sym || !movedDeclSyms.has(sym)) return
      const name = node.text
      const p = node.parent
      if (ts.isShorthandPropertyAssignment(p) && p.name === node) indexPrefixEdits.push({ start: node.getStart(sf), end: node.end, text: `${name}: ${cfg.v}.${name}` })
      else indexPrefixEdits.push({ start: node.getStart(sf), end: node.end, text: `${cfg.v}.${name}` })
    }
  })

  // 行内偏移应用 moduleEdits
  const editsByLine = new Map()
  for (const e of moduleEdits) {
    const lc = sf.getLineAndCharacterOfPosition(e.start); const ln = lc.line + 1
    if (!editsByLine.has(ln)) editsByLine.set(ln, [])
    const endLc = sf.getLineAndCharacterOfPosition(e.end)
    if (endLc.line + 1 !== ln) throw new Error('multi-line identifier edit at L' + ln)
    editsByLine.get(ln).push({ s: lc.character, e: endLc.character, text: e.text })
  }
  const renderLine = (ln) => {
    let l = lines[ln - 1]
    const es = (editsByLine.get(ln) || []).sort((a, b) => b.s - a.s)
    for (const e of es) l = l.slice(0, e.s) + e.text + l.slice(e.e)
    return l
  }
  const importLines = [...importNeeds.entries()].map(([mod, names]) => `import { ${[...names].sort().join(', ')} } from '${mod}'`)
  const header = `/**
 * ${cfg.title}
 * 从 lib/index.js 抽出的第 3 阶段模块（行为不变 refactor）。
 *
 * 依赖（D 依赖袋，字段调用时读取）：
 *   稳定字段（工厂顶部解构）：K cfg ctx log vlog event TAG BASE_PATH boardRoot boardDir P BB
 *   惰性字段：${[...dFields].sort().join(' ') || '(无)'}
 *   K 共享状态：见 index.js 的 K 袋。
 *
 * 区块地图：
${cfg.map.map((m) => ' *   ' + m).join('\n')}
 */
`
  const body = []
  body.push(header)
  if (importLines.length) body.push(importLines.join('\n'), '')
  body.push(`export function ${cfg.factory} (D) {`)
  body.push(`  const { ${[...STABLE].filter((n) => n !== 'K').join(', ')}, K } = D`)
  body.push('')
  let retExpr
  if (isObject) {
    // 整个对象字面量：改名 varName → api，drop spread 行
    body.push(`  // ── apiApp 剩余方法（index 用 { ...AA, ...GR.api, ...GD.api } 重组）──`)
    for (const r of cfg.move) for (let ln = r.s; ln <= r.e; ln++) {
      if (dropSet.has(ln)) continue
      let l = renderLine(ln)
      if (ln === r.s) l = l.replace(`const ${cfg.object.varName} =`, 'const api =')
      body.push(l)
    }
    body.push('')
    retExpr = 'api'
  } else {
    for (const r of cfg.move) {
      for (let ln = r.s; ln <= r.e; ln++) { if (staySet.has(ln)) continue; body.push(renderLine(ln)) }
      body.push('')
    }
    retExpr = [...new Set(topLevelHelpers)].join(', ')
  }
  body.push(`  return ${isObject ? retExpr : `{ ${retExpr} }`}`)
  body.push('}')
  const modPath = path.join(ROOT, 'lib', cfg.file)
  if (fs.existsSync(modPath)) throw new Error('module already exists: ' + modPath)
  fs.writeFileSync(modPath, body.join('\n') + '\n', 'utf8')

  // ── index 侧 ──
  const edits = [...indexPrefixEdits]
  const lineStart = (ln) => lines.slice(0, ln - 1).join('\n').length + (ln > 1 ? 1 : 0)
  // 删除被移走的行（move 模式保留 stay；object 模式整段删，含 drop/spread）
  for (const r of cfg.move) for (let ln = r.s; ln <= r.e; ln++) {
    if (!isObject && staySet.has(ln)) continue
    const ls = lineStart(ln); const le = ls + lines[ln - 1].length + 1
    edits.push({ start: ls, end: Math.min(le, text.length), text: '' })
  }
  // 工厂调用 + index 重组
  const firstStart = lineStart(cfg.move[0].s)
  const lastEnd = lineStart(cfg.move[cfg.move.length - 1].e) + lines[cfg.move[cfg.move.length - 1].e - 1].length + 1
  const insertPos = cfg.factoryAtEnd ? lastEnd : firstStart
  let replacement
  if (isObject) replacement = `  // [重构③] ${cfg.marker} → lib/${cfg.file}\n  const ${cfg.v} = ${cfg.factory}(D)\n${cfg.object.indexReplace}\n`
  else replacement = `  // [重构③] ${cfg.marker} → lib/${cfg.file}\n  const ${cfg.v} = ${cfg.factory}(D)\n`
  edits.push({ start: insertPos, end: insertPos, text: replacement })
  const lastImport = [...sf.statements].reverse().find((s) => ts.isImportDeclaration(s))
  edits.push({ start: lastImport.end, end: lastImport.end, text: `\nimport { ${cfg.factory} } from './${cfg.file}'` })
  const out = applyEdits(text, edits)
  fs.writeFileSync(INDEX, out, 'utf8')
  console.log(`cut ${modName}: lib/${cfg.file} written (${body.length} lines)`)
  console.log('D fields used:', [...dFields].sort().join(', '))
  console.log('imports needed:', JSON.stringify(Object.fromEntries([...importNeeds.entries()].map(([k, v]) => [k, [...v]]))))
  console.log('index refs prefixed:', indexPrefixEdits.length, '| returned:', retExpr)
  if (unresolved.size) console.log('NOTE unresolved (globals kept):', [...unresolved].join(', '))
}

function audit () {
  const idx = fs.readFileSync(INDEX, 'utf8')
  const dProvided = new Set()
  const dBlock = idx.match(/const D = \{[\s\S]*?\n  \}/)
  if (dBlock) for (const m of dBlock[0].matchAll(/(?:get\s+)?([A-Za-z_$][\w$]*)\s*(?:\(\)|,|:)/g)) dProvided.add(m[1])
  const kProvided = new Set([...idx.matchAll(/^\s*K\.([A-Za-z_$][\w$]*)\s*=/gm)].map((m) => m[1]))
  let bad = 0
  for (const f of ['groups.js', 'guards.js', 'mode-auto.js', 'runtime.js', 'api-app.js', 'tools-reg.js']) {
    const p = path.join(ROOT, 'lib', f)
    if (!fs.existsSync(p)) { console.log(f, ': not yet extracted'); continue }
    const src = fs.readFileSync(p, 'utf8')
    const dUsed = new Set([...src.matchAll(/\bD\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
    const kUsed = new Set([...src.matchAll(/\bK\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
    const dMiss = [...dUsed].filter((n) => !dProvided.has(n))
    const kMiss = [...kUsed].filter((n) => !kProvided.has(n))
    console.log(`${f}: D uses ${dUsed.size} (missing: ${dMiss.join(',') || 'none'}), K uses ${kUsed.size} (missing: ${kMiss.join(',') || 'none'})`)
    bad += dMiss.length + kMiss.length
  }
  console.log(bad ? 'AUDIT FAIL' : 'AUDIT PASS')
  process.exitCode = bad ? 1 : 0
}
const cmd = process.argv[2]
if (cmd === 'cut') cut(process.argv[3])
else if (cmd === 'audit') audit()
else { console.log('usage: refactor-cut2.mjs cut <runtime|api-app|tools-reg> | audit'); process.exit(1) }
