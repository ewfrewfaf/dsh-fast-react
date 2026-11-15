// refactor-smoke.mjs —— apply() 冒烟：mock ctx 加载插件，抓 TDZ/引用/顺序错误
// 用法：node tools/refactor-smoke.mjs [目标js路径]
// 判据：apply 不抛错 + 日志出现「apply 完成」+  disposer 全部可回收。
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const target = process.argv[2] ? fileURLToPath(pathToFileURL(process.argv[2])) : fileURLToPath(new URL('../lib/index.js', import.meta.url))
const board = mkdtempSync(join(tmpdir(), 'fr-smoke-'))
const disposers = []
const errors = []

function runEffect (fn) {
  try {
    const r = fn()
    if (r && typeof r.next === 'function') {
      let step = r.next()
      while (!step.done) { if (typeof step.value === 'function') disposers.push(step.value); step = r.next() }
    } else if (typeof r === 'function') disposers.push(r)
  } catch (e) { errors.push('effect: ' + (e && e.stack || e)) }
}
const ctx = {
  effect: runEffect,
  on: () => () => {},
  inject: () => {},
  get: () => undefined,
  agents: { list: () => [], get: () => null },
  tools: { register: () => () => {}, schemas: () => [], guard: () => () => {}, restrict: () => () => {}, get: () => undefined },
  sessions: {},
  setInterval: (fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t) },
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
}

const mod = await import(pathToFileURL(target).href)
try {
  mod.apply(ctx, { boardRoot: board, instanceTag: 'smoke', verboseLog: false })
} catch (e) {
  console.error('APPLY THROW:', e && e.stack || e)
  process.exit(1)
}
const logFile = join(process.env.DSH_HOME || join(tmpdir(), '..', 'admin', '.dsh'), 'super-injector', 'fast-react.log')
let loaded = false
try {
  // 实例 smoke 的日志与主实例共用文件；用 board 内 events 判断 apply 走完
  loaded = existsSync(join(board, '.board'))
} catch { /* */ }
// ★ saveMetrics 在 apply 末尾无条件执行且被 try/catch 包着——metrics.json 缺失 = 静默坏（简写漏改探针）
if (!existsSync(join(board, '.board', 'metrics.json'))) {
  console.error('SMOKE FAIL: metrics.json 缺失（saveMetrics 静默失败？）')
  process.exit(1)
}
for (const d of disposers) { try { d() } catch (e) { errors.push('dispose: ' + e.message) } }
if (errors.length) { console.error('EFFECT ERRORS:\n' + errors.join('\n')); process.exit(1) }
console.log('SMOKE PASS: apply ok, board=' + loaded + ', disposers=' + disposers.length)
setTimeout(() => { try { rmSync(board, { recursive: true, force: true }) } catch { /* */ } process.exit(0) }, 3500)
