/**
 * board.js —— 黑板 IO（v1.3.1 从 index.js 抽出，S2 步）
 *
 * 设计：makeBoard(boardDir, log) 返回一套纯 IO 函数，不依赖任何闭包状态。
 * 目的：黑板读写可单测、可指向临时目录做镜像测试（见 workbuddy-restore/test-*.mjs）。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const LOG_ROTATE_BYTES = Number(process.env.FAST_REACT_LOG_ROTATE_BYTES || 8 * 1024 * 1024)
export const HEARTBEAT_ROTATE_BYTES = Number(process.env.FAST_REACT_HEARTBEAT_ROTATE_BYTES || 4 * 1024 * 1024)

export function makeBoard (boardDir, log = () => {}) {
  const P = {
    state: join(boardDir, 'state.md'),
    heartbeat: join(boardDir, 'heartbeat.log'),
    events: join(boardDir, 'events.jsonl'),
    route: join(boardDir, 'route.md'),
    stepsDir: join(boardDir, 'steps'),
    confirmDir: join(boardDir, 'confirm'),
  }

  const ensure = () => {
    for (const d of [boardDir, P.stepsDir, P.confirmDir]) {
      try { mkdirSync(d, { recursive: true }) } catch { /* 已存在 */ }
    }
  }

  const readIf = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }

  const writeAtomic = (f, text) => {
    try {
      mkdirSync(dirname(f), { recursive: true })
      const tmp = f + '.tmp'
      writeFileSync(tmp, text, 'utf8')
      renameSync(tmp, f)
      return true
    } catch (e) { log('writeAtomic fail ' + f + ': ' + e.message); return false }
  }

  const appendLine = (f, line) => {
    try { mkdirSync(dirname(f), { recursive: true }); appendFileSync(f, line + '\n'); return true } catch { return false }
  }

  const event = (kind, detail) => appendLine(P.events, JSON.stringify({ at: new Date().toISOString(), kind, detail }))

  /** 日志轮转：超阈值整份改名 *.1.*（只留 1 代，旧代可人工审计） */
  function rotateIfLarge (file, keepFile, threshold) {
    try {
      if (!existsSync(file)) return false
      if (statSync(file).size < threshold) return false
      renameSync(file, keepFile)
      return true
    } catch { return false }
  }

  function ensureLogsBounded () {
    const rotated = rotateIfLarge(P.events, join(boardDir, 'events.1.jsonl'), LOG_ROTATE_BYTES)
    rotateIfLarge(P.heartbeat, join(boardDir, 'heartbeat.1.log'), HEARTBEAT_ROTATE_BYTES)
    if (rotated) event('events-rotated', { kept: 'events.1.jsonl', threshold: LOG_ROTATE_BYTES })
  }

  /** 读 state.md 的 `key: value` 受控字段（前台写的结构化进度） */
  const readState = () => {
    const t = readIf(P.state)
    const out = {}
    for (const m of t.matchAll(/^\s*([A-Za-z][\w-]*)\s*:\s*(.+?)\s*$/gm)) out[m[1]] = m[2]
    return out
  }

  const listSteps = () => {
    try { return readdirSync(P.stepsDir).filter(f => /^S\d+\.md$/.test(f)).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1))) }
    catch { return [] }
  }

  const stepNo = (f) => parseInt(String(f).replace(/\D/g, ''), 10) || 0

  const hasConfirm = (stepId) => {
    try { return existsSync(join(P.confirmDir, `${stepId}.ok`)) } catch { return false }
  }

  /** 已交付？交付后停止一切催单（否则"清单跑完"会被误判成"缺料"，变成 30s 死循环） */
  const hasDeliver = () => {
    try { return readdirSync(boardDir).some(f => /^deliver\.v\d+\.md$/.test(f)) } catch { return false }
  }

  /**
   * 解析 route.md 里的里程碑数量。
   * ★ 2026-11-07 从 index.js 移入（原为 routeMilestoneCount），目的是让 scheduler.js 也能用：
   *   归档前必须校验「里程碑数 > 步骤数 ⇒ 拒绝归档」，否则后台只写 2 步就被归档搬走，
   *   催补步机制永远来不及跑（实测 23 次归档里 18 次存在缺口）。
   *
   * 放宽标题匹配：模型会写 `## 3. 里程碑（3 节 = 3 步）` 这类带序号/括号的标题，
   * 原来用严格 /##\s*里程碑\s*\n/ 会匹配失败 ⇒ 计数恒为 0 ⇒ 闭环检测静默失效。
   */
  const routeMilestoneCount = () => {
    try {
      const t = readIf(P.route)
      if (!t) return 0
      const m = t.match(/^##[^\n]*里程碑[^\n]*$/m)
      if (!m) return 0
      const seg = t.slice(m.index + m[0].length).split(/\n##\s/)[0]
      return seg.split('\n').filter(l => /^\s*[-*]\s*\*?\*?M\d+/i.test(l)).length
    } catch { return 0 }
  }

  return { boardDir, P, ensure, readIf, writeAtomic, appendLine, event, rotateIfLarge, ensureLogsBounded, readState, listSteps, stepNo, hasConfirm, hasDeliver, routeMilestoneCount }
}
