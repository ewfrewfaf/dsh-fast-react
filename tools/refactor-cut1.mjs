// refactor-cut1.mjs —— 第一阶段重构机械切割器（groups/guards/mode-auto）
// 用法：
//   node tools/refactor-cut1.mjs kbag          # 建 K 共享状态袋 + D 依赖袋，符号级改名全部共享状态引用
//   node tools/refactor-cut1.mjs cut groups    # 按 tools/refactor-ranges.json 切出模块（行号须先 grep 复核）
//   node tools/refactor-cut1.mjs audit         # 引用审计：模块用到的 D.xxx/K.xxx 是否都有提供
// 原理：TypeScript checker 解析符号 —— 只改「声明在 apply() 顶层的目标变量」的引用，
//       同名参数/局部变量/属性键自动豁免（符号不同）。不做正则整词替换，杜绝误伤。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require2 = createRequire(import.meta.url)
const TS_PATH = process.env.FRT_TS || 'C:/Users/admin/.dsh/plugins/dsh-ego-browser/node_modules/typescript'
const ts = require2(TS_PATH)

const ROOT = path.resolve(import.meta.dirname, '..')
const INDEX = path.join(ROOT, 'lib', 'index.js')
const RANGES = path.join(ROOT, 'tools', 'refactor-ranges.json')

// ── K 共享状态袋名单（任务书指定，76 个）──────────────────────────────────
const K_NAMES = ('front back briefed workers seenSteps changedFiles lastBeatAt stepsThisTask stepsThisTaskBase ' +
  'taskBatchOverride judgeWaiting lastAnalysisMtime lastReviewAt reviewCount lastReviewStepNo recentGaps adaptiveBatch ' +
  'lastDeliverAt lastT3Seen phaseStrategy phaseSince testFailStreak lastTaskText lastTodoKey todoSyncTimer lastDiffReviewAt ' +
  'diffReviewCount reworkAlerted lastToolAt turnStartAt prevFrontPhase t3Blocked alertedSentinels finalAnswerAsked finalAsked ' +
  'finalAuditRetry lastAuditedDeliverKey milestoneGapCount deliverRetry userStopAt pauseAt pendingDeliver pendingDeliverLogged ' +
  'firstFrameNudgedAt svcAgentLoop svcPresets autoHealAt autoHealDone linkedSessions lastWsPruneAt svcMeter svcCompaction ' +
  'lastCompactAt lastAgentError verdictSeen modePinned activeMode modeBy activeStrategy lastWakeAt taskWakes taskFreezes ' +
  'budgetAlerted lastPrefetchAt curEffort lastBizAlertKey scopePatched globalRegistered lastDetectText lastTriage ' +
  'autoUpgradedThisTask lastEscalateAt codingNotEscalated overrides droppedOnce').split(/\s+/)

// 模块工厂顶部解构的「稳定字段」（全部在首个工厂调用点之前完成初始化的 const/参数）
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

// 标识符是否是「声明名/属性键」这类不应按变量改名的位置
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

// 简写属性 { x } 的 name 既是键又是值引用：必须取值符号，否则拿到属性符号导致漏改
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

// ── kbag：K 声明转换 + 全文件符号级引用改名 + 插入 K/D ─────────────────────
function kbag () {
  const text = fs.readFileSync(INDEX, 'utf8')
  if (/\bconst K = \{\}/.test(text)) { console.log('kbag already applied'); return }
  const { sf, checker } = makeProgram(INDEX, text)
  const applyFn = findApply(sf)
  const targets = new Map() // name -> { stmt, decl }
  for (const st of applyFn.body.statements) {
    if (!ts.isVariableStatement(st)) continue
    if (st.declarationList.declarations.length !== 1) continue
    const d = st.declarationList.declarations[0]
    if (!ts.isIdentifier(d.name) || !K_NAMES.includes(d.name.text)) continue
    if (!d.initializer) throw new Error('K target without initializer: ' + d.name.text)
    if (targets.has(d.name.text)) throw new Error('duplicate K declaration: ' + d.name.text)
    targets.set(d.name.text, { stmt: st, decl: d })
  }
  const missing = K_NAMES.filter((n) => !targets.has(n))
  if (missing.length) throw new Error('K declarations not found at apply top level: ' + missing.join(', '))
  const targetDeclNodes = new Set([...targets.values()].map((t) => t.decl))
  const edits = []
  const refCount = {}
  walk(sf, (node) => {
    if (!ts.isIdentifier(node) || !K_NAMES.includes(node.text)) return
    if (isNonRefPosition(node)) return
    const sym = refSymbol(checker, node)
    if (!sym || !sym.declarations || !sym.declarations.some((d) => targetDeclNodes.has(d))) return
    const name = node.text
    refCount[name] = (refCount[name] || 0) + 1
    const p = node.parent
    if (ts.isShorthandPropertyAssignment(p) && p.name === node) {
      edits.push({ start: node.getStart(sf), end: node.end, text: `${name}: K.${name}` })
    } else {
      edits.push({ start: node.getStart(sf), end: node.end, text: `K.${name}` })
    }
  })
  // 声明转换：let/const x = init  →  K.x = init（原位、原初始化顺序、保留行尾注释）
  for (const [name, t] of targets) {
    edits.push({ start: t.stmt.getStart(sf), end: t.decl.initializer.getStart(sf), text: `K.${name} = ` })
  }
  // 在第一个共享状态声明（overrides）前插入 K 与 D
  const first = targets.get('overrides').stmt
  const anchor = first.getStart(sf)
  const KBAG = `// ── K：跨模块共享状态袋（第一阶段重构）────────────────────────────────
  // 原 apply() 闭包里的跨模块可变状态统一挂到 K；抽出的模块经 D.K 读写。
  // 各 K.x 的初始化仍留在原位置（顺序与副作用与原实现完全一致）。
  const K = {}

  // ── D：模块依赖袋 ─────────────────────────────────────────────────────
  // makeGroups/makeGuards/makeModeAuto 经 D 读取 apply() 闭包依赖。
  // 函数/后定义绑定一律 getter：字段在**调用时**读取（惰性），不做快照。
  const D = {
    K, cfg, ctx, TAG, BASE_PATH, boardRoot, boardDir,
    get P() { return P }, get BB() { return BB },
    get log() { return log }, get vlog() { return vlog }, get event() { return event },
    get alive() { return alive }, get TN() { return TN }, get idOf() { return idOf },
    get readIf() { return readIf }, get writeAtomic() { return writeAtomic },
    get readState() { return readState }, get listSteps() { return listSteps }, get stepNo() { return stepNo },
    get toolStats() { return toolStats }, get policyAgentId() { return policyAgentId },
    get modeFile() { return modeFile }, get currentMode() { return currentMode }, get modeNow() { return modeNow },
    get reapplyToolPolicyIfNeeded() { return reapplyToolPolicyIfNeeded },
    get applyToolPolicy() { return applyToolPolicy }, get localizeToolNames() { return localizeToolNames },
    get resolveRoute() { return resolveRoute }, get routeFor() { return routeFor }, get effortFor() { return effortFor },
    get presetName() { return presetName }, get attachToolPolicyFor() { return attachToolPolicyFor },
    get nameSession() { return nameSession }, get norm() { return norm },
    get wire() { return wire }, get unwire() { return unwire }, get resolveAgents() { return resolveAgents },
    get steerFront() { return steerFront }, get wakeBack() { return wakeBack },
    get hasDeliver() { return hasDeliver }, get B() { return B }, get apiApp() { return apiApp },
  }

  `
  edits.push({ start: anchor, end: anchor, text: KBAG })
  const out = applyEdits(text, edits)
  fs.writeFileSync(INDEX, out, 'utf8')
  const totalRefs = Object.values(refCount).reduce((a, b) => a + b, 0)
  console.log(`kbag done: ${targets.size} declarations converted, ${totalRefs} references renamed`)
  console.log('per-name refs:', JSON.stringify(refCount))
  const zero = K_NAMES.filter((n) => !refCount[n])
  if (zero.length) console.log('NOTE zero-ref names (decl only):', zero.join(', '))
}

// ── cut：按行段配置切出一个模块 ───────────────────────────────────────────
function cut (modName) {
  const cfgAll = JSON.parse(fs.readFileSync(RANGES, 'utf8'))
  const cfg = cfgAll[modName]
  if (!cfg) throw new Error('no config for ' + modName)
  const text = fs.readFileSync(INDEX, 'utf8')
  const lines = text.split('\n')
  const { sf, checker } = makeProgram(INDEX, text)
  const applyFn = findApply(sf)
  const applyStart = applyFn.getStart(sf)
  const applyEnd = applyFn.end

  // 校验行段锚点（防行号漂移）
  const allRanges = [...cfg.move.map((r) => ({ ...r, kind: 'move' })), ...cfg.api.map((r) => ({ ...r, kind: 'api' })),
    ...(cfg.wrapped || []).map((w) => ({ ...w.range, kind: 'wrapped' }))]
  for (const r of allRanges) {
    const fl = lines[r.s - 1], ll = lines[r.e - 1]
    if (!fl || !fl.includes(r.first)) throw new Error(`anchor mismatch ${modName} L${r.s}: expect "${r.first}" got "${fl}"`)
    if (!ll || !ll.includes(r.last)) throw new Error(`anchor mismatch ${modName} L${r.e}: expect "${r.last}" got "${ll}"`)
  }
  const inRanges = (pos, ranges) => {
    const ln = lineOf(sf, pos)
    return ranges.some((r) => ln >= r.s && ln <= r.e)
  }
  // stay 行判定：只认 apply() 顶层的 K.x = 初始化语句（AST 判定，函数体内的 K 赋值不算）
  const kAssignLines = new Set()
  for (const st of applyFn.body.statements) {
    if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = st.expression.left
      if (ts.isPropertyAccessExpression(l) && ts.isIdentifier(l.expression) && l.expression.text === 'K') kAssignLines.add(lineOf(sf, st.getStart(sf)))
    }
  }
  const staySet = new Set()
  for (const r of cfg.move) {
    for (let ln = r.s; ln <= r.e; ln++) {
      const isK = kAssignLines.has(ln)
      const isStay = (cfg.stay || []).some((s) => ln >= s.s && ln <= s.e)
      if (isK || isStay) staySet.add(ln)
    }
  }

  // 顶层 helper 名单（AST：只认 apply() 直接子级的函数声明/箭头函数 const，嵌套局部不算）
  const topLevelHelpers = []
  walk(sf, (node) => {
    const isTopFn = ts.isFunctionDeclaration(node) && node.name && node.parent === applyFn.body
    const isTopVar = ts.isVariableStatement(node) && node.parent === applyFn.body
    if (!isTopFn && !isTopVar) return
    if (!inRanges(node.getStart(sf), cfg.move)) return
    if (staySet.has(lineOf(sf, node.getStart(sf)))) return
    if (isTopFn) { topLevelHelpers.push(node.name.text); return }
    const ds = node.declarationList.declarations
    if (ds.length === 1 && ts.isIdentifier(ds[0].name) && ds[0].initializer &&
      (ts.isArrowFunction(ds[0].initializer) || ts.isFunctionExpression(ds[0].initializer))) topLevelHelpers.push(ds[0].name.text)
  })

  // 收集「被移走的声明」的符号（用于 index 剩余代码加前缀）
  const movedDeclSyms = new Set()
  walk(sf, (node) => {
    const isDecl = (ts.isFunctionDeclaration(node) && node.name) ||
      (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) ||
      (ts.isMethodDeclaration(node) && node.name)
    if (!isDecl) return
    if (!inRanges(node.getStart(sf), allRanges)) return
    if (staySet.has(lineOf(sf, node.getStart(sf)))) return // stay 行的声明不算移走
    const sym = checker.getSymbolAtLocation(node.name)
    if (sym) movedDeclSyms.add(sym)
  })

  // ── 模块侧改写：外部 apply 作用域绑定 → D.xxx（稳定字段除外）；import 保留 ──
  const dFields = new Set()
  const importNeeds = new Map() // moduleSpecifier -> Set<importedName>
  const moduleEdits = []
  const indexPrefixEdits = []
  const unresolved = new Set()
  walk(sf, (node) => {
    if (!ts.isIdentifier(node)) return
    const inside = inRanges(node.getStart(sf), allRanges) && !staySet.has(lineOf(sf, node.getStart(sf)))
    if (isNonRefPosition(node)) {
      // 简写属性在模块侧要展开成 key: D.key（键本身不改名）
      return
    }
    const sym = refSymbol(checker, node)
    if (inside) {
      // wrapped 段的包装参数（如 detectAndApplyTask 的 body/opts/a）：保持裸名，它们是新函数的参数
      const ln0 = lineOf(sf, node.getStart(sf))
      const w0 = (cfg.wrapped || []).find((w) => ln0 >= w.range.s && ln0 <= w.range.e)
      if (w0 && (w0.params || []).includes(node.text)) return
      if (!sym) { if (/^[A-Z_$]/.test(node.text) || ['process', 'console', 'arguments'].includes(node.text)) unresolved.add(node.text); return }
      const decl = sym.declarations && sym.declarations[0]
      if (!decl) return
      // import 绑定：声明是本文件的 ImportSpecifier ⇒ 模块直接重新 import
      if (ts.isImportSpecifier(decl)) {
        const impDecl = decl.parent.parent.parent // ImportSpecifier → NamedImports → ImportClause → ImportDeclaration
        const mod = impDecl.moduleSpecifier.text
        if (!importNeeds.has(mod)) importNeeds.set(mod, new Set())
        importNeeds.get(mod).add(decl.propertyName ? `${decl.propertyName.text} as ${decl.name.text}` : decl.name.text)
        return
      }
      if (inRanges(decl.getStart(sf), allRanges)) return // 同模块内部
      const declFile = decl.getSourceFile()
      if (declFile.fileName !== sf.fileName) {
        // import 来的：记录需要的导入名
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
      if (STABLE.has(name)) return // 工厂顶部解构
      dFields.add(name)
      const p = node.parent
      if (ts.isShorthandPropertyAssignment(p) && p.name === node) {
        moduleEdits.push({ start: node.getStart(sf), end: node.end, text: `${name}: D.${name}` })
      } else {
        moduleEdits.push({ start: node.getStart(sf), end: node.end, text: `D.${name}` })
      }
    } else {
      // index 剩余代码：引用被移走的声明 ⇒ 加模块前缀
      if (!sym || !movedDeclSyms.has(sym)) return
      const name = node.text
      const p = node.parent
      if (ts.isShorthandPropertyAssignment(p) && p.name === node) {
        indexPrefixEdits.push({ start: node.getStart(sf), end: node.end, text: `${name}: ${cfg.v}.${name}` })
      } else {
        indexPrefixEdits.push({ start: node.getStart(sf), end: node.end, text: `${cfg.v}.${name}` })
      }
    }
  })

  // ── 生成模块文件 ──
  const extract = (ranges, filterStay) => {
    const out = []
    for (const r of ranges) {
      const seg = []
      for (let ln = r.s; ln <= r.e; ln++) {
        if (filterStay && staySet.has(ln)) continue
        let l = lines[ln - 1]
        // 对模块侧的 D.xxx 改写：按行内偏移应用（edits 已按全文位置收集）
        seg.push({ ln, l })
      }
      out.push(seg)
    }
    return out
  }
  // 把 moduleEdits 映射到「行+列」，在抽取出的行文本上应用
  const editsByLine = new Map()
  for (const e of moduleEdits) {
    const lc = sf.getLineAndCharacterOfPosition(e.start)
    const ln = lc.line + 1
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
  const helperSegs = extract(cfg.move, true)
  const apiSegs = extract(cfg.api, false)
  const wrappedSegs = (cfg.wrapped || []).map((w) => ({ w, seg: extract([w.range], false)[0] }))

  const importLines = [...importNeeds.entries()].map(([mod, names]) => `import { ${[...names].sort().join(', ')} } from '${mod}'`)
  const helperNames = topLevelHelpers
  const wrappedNames = (cfg.wrapped || []).map((w) => w.name)
  const retNames = [...new Set([...helperNames, ...wrappedNames])]
  const header = `/**
 * ${cfg.title}
 * 从 lib/index.js 抽出的第 1 阶段模块（行为不变 refactor）。
 *
 * 依赖（D 依赖袋，字段调用时读取）：
 *   稳定字段（工厂顶部解构）：K cfg ctx log vlog event TAG BASE_PATH boardRoot boardDir P BB
 *   惰性字段：${[...dFields].sort().join(' ') || '(无)'}
 *   K 共享状态：见 index.js 的 K 袋（本模块读写的跨模块可变状态全部经 K）。
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
  for (const seg of helperSegs) {
    for (const { ln } of seg) body.push(renderLine(ln))
    body.push('')
  }
  for (const { w, seg } of wrappedSegs) {
    body.push(`  // [重构] 原 index.js 内联片段 → ${w.name}`)
    body.push(`  ${w.sig} {`)
    for (const { ln } of seg) body.push(renderLine(ln))
    body.push('  }')
    body.push('')
  }
  if (apiSegs.length) {
    body.push('  // ── apiApp 内抽出的方法（index 用 ...' + cfg.v + '.api 展开）──')
    body.push('  const api = {')
    for (const seg of apiSegs) {
      for (const { ln } of seg) body.push(renderLine(ln))
    }
    body.push('  }')
    body.push('')
  }
  body.push(`  return { ${retNames.join(', ')}${apiSegs.length ? ', api' : ''} }`)
  body.push('}')
  const modPath = path.join(ROOT, 'lib', cfg.file)
  if (fs.existsSync(modPath)) throw new Error('module already exists: ' + modPath)
  fs.writeFileSync(modPath, body.join('\n') + '\n', 'utf8')

  // ── index 侧改写 ──
  const edits = [...indexPrefixEdits]
  // 删除被移走的行（保留 stay 行），每个 move 段首位放标记注释 + 首段放工厂调用
  let firstMove = true
  for (const r of cfg.move) {
    const startLn = r.s
    const startPos = lines.slice(0, startLn - 1).join('\n').length + (startLn > 1 ? 1 : 0)
    let removedAny = false
    for (let ln = r.s; ln <= r.e; ln++) {
      if (staySet.has(ln)) continue
      const ls = lines.slice(0, ln - 1).join('\n').length + (ln > 1 ? 1 : 0)
      const le = ls + lines[ln - 1].length + 1 // 含换行
      edits.push({ start: ls, end: Math.min(le, text.length), text: '' })
      removedAny = true
    }
    if (removedAny) {
      const marker = firstMove
        ? `  // [重构①] ${cfg.marker} → lib/${cfg.file}\n  const ${cfg.v} = ${cfg.factory}(D)\n`
        : `  // [重构①] ${cfg.marker}（续）→ lib/${cfg.file}\n`
      edits.push({ start: startPos, end: startPos, text: marker })
      firstMove = false
    }
  }
  // api 段：整段删除，首段位置放展开
  let firstApi = true
  for (const r of cfg.api) {
    const startPos = lines.slice(0, r.s - 1).join('\n').length + (r.s > 1 ? 1 : 0)
    for (let ln = r.s; ln <= r.e; ln++) {
      const ls = lines.slice(0, ln - 1).join('\n').length + (ln > 1 ? 1 : 0)
      const le = ls + lines[ln - 1].length + 1
      edits.push({ start: ls, end: Math.min(le, text.length), text: '' })
    }
    if (firstApi) {
      edits.push({ start: startPos, end: startPos, text: `    // [重构①] ${cfg.apiMarker || '方法'} → lib/${cfg.file}\n    ...${cfg.v}.api,\n` })
      firstApi = false
    }
  }
  // wrapped 段：删除原行，原位放调用
  for (const w of cfg.wrapped || []) {
    const r = w.range
    const startPos = lines.slice(0, r.s - 1).join('\n').length + (r.s > 1 ? 1 : 0)
    for (let ln = r.s; ln <= r.e; ln++) {
      const ls = lines.slice(0, ln - 1).join('\n').length + (ln > 1 ? 1 : 0)
      const le = ls + lines[ln - 1].length + 1
      edits.push({ start: ls, end: Math.min(le, text.length), text: '' })
    }
    edits.push({ start: startPos, end: startPos, text: w.call + '\n' })
  }
  // import 插入（最后一个 import 之后）
  const lastImport = [...sf.statements].reverse().find((s) => ts.isImportDeclaration(s))
  const impPos = lastImport.end
  edits.push({ start: impPos, end: impPos, text: `\nimport { ${cfg.factory} } from './${cfg.file}'` })

  const out = applyEdits(text, edits)
  fs.writeFileSync(INDEX, out, 'utf8')
  console.log(`cut ${modName}: lib/${cfg.file} written (${body.length} lines)`)
  console.log('D fields used:', [...dFields].sort().join(', '))
  console.log('imports needed:', JSON.stringify(Object.fromEntries([...importNeeds.entries()].map(([k, v]) => [k, [...v]]))))
  console.log('index refs prefixed:', indexPrefixEdits.length)
  if (unresolved.size) console.log('NOTE unresolved (globals, kept as-is):', [...unresolved].join(', '))
}

// ── audit：模块 D/K 引用 vs index 提供 ────────────────────────────────────
function audit () {
  const idx = fs.readFileSync(INDEX, 'utf8')
  const dProvided = new Set()
  const dBlock = idx.match(/const D = \{[\s\S]*?\n  \}/)
  if (dBlock) {
    for (const m of dBlock[0].matchAll(/(?:get\s+)?([A-Za-z_$][\w$]*)\s*(?:\(\)|,|:)/g)) dProvided.add(m[1])
  }
  const kProvided = new Set([...idx.matchAll(/^\s*K\.([A-Za-z_$][\w$]*)\s*=/gm)].map((m) => m[1]))
  let bad = 0
  for (const f of ['groups.js', 'guards.js', 'mode-auto.js']) {
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
if (cmd === 'kbag') kbag()
else if (cmd === 'cut') cut(process.argv[3])
else if (cmd === 'audit') audit()
else { console.log('usage: refactor-cut1.mjs kbag|cut <groups|guards|mode-auto>|audit'); process.exit(1) }
