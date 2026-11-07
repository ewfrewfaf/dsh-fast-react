#!/usr/bin/env node
/**
 * mksandbox.mjs —— 预先批量生成所有测试轮次的沙箱（零模型成本）
 *
 * 目的：每轮 A/B 跑完不用手动 reset，直接换下一个"冷"沙箱，省时间也避免"忘记重置"。
 *
 * 用法：
 *   node tools/mksandbox.mjs                 # 生成全部（每个任务 × N 轮）
 *   node tools/mksandbox.mjs --reset t1-edit # 只重置一个（老用法，保险用）
 *   node tools/mksandbox.mjs --list          # 只列已生成
 *   node tools/mksandbox.mjs --rounds 4      # 每任务生成 4 轮（默认 3 组 × 3 轮 = 9 不够，见下）
 *
 * 命名规则：<任务>-r<N>，例如 t1-edit-r1 … t1-edit-r6
 *   默认每任务 6 轮 = 开 3 次 + 关 3 次（刚好够一组完整 A/B）
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const LEGACY = join(homedir(), 'Desktop', 'FastReact')
const ROOT = process.env.FAST_REACT_BOARD
  || (existsSync(join(LEGACY, '.board', 'config.json')) ? LEGACY : join(HOME, 'fast-react'))
const SB = join(ROOT, 'test-sandbox')

const w = (base, p, s) => {
  const full = join(base, p)
  mkdirSync(join(full, '..').replace(/\\[^\\]+$/, ''), { recursive: true })
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, s.trimStart(), 'utf8')
}

// ── 各任务的生成函数：base = 目标目录 ──────────────────────
function t1 (base) {
  mkdirSync(join(base, 'docs'), { recursive: true })
  w(base, 'README.md', `
# 项目 README

- TODO 补充安装步骤
- 参见 docs/guide.md
- 另见 docs/missing.md
`)
  w(base, 'CHANGELOG.md', `
# CHANGELOG

## 0.1
- TODO 补一条 breaking change 说明
- 参见 README.md
`)
  w(base, 'docs/guide.md', `
# 使用指南

- 参见 ../README.md
- TODO 补截图
- 详细 API 见 api-v2.md
`)
  w(base, 'docs/api.md', `
# API

- 参见 guide.md
- 无待办
`)
  w(base, 'notes.md', `
# 随手记

- 无待办
- 参见 README.md
`)
}

function t2 (base) {
  mkdirSync(base, { recursive: true })
  w(base, 'util.js', `
export function formatBytes(n) {
  // TODO: 实现（0 → "0B"，1024 → "1KB"，1536 → "1.5KB"，空输入 → "0B"）
  return String(n)
}
export function clamp(v, lo, hi) {
  // TODO: 实现（越界夹到边界，空输入返回 lo）
  return v
}
`)
  w(base, 'roles.js', `
export function describeRole(role) {
  if (role === 'admin') {
    return { label: '管理员', level: 3, canDelete: true }
  }
  if (role === 'editor') {
    return { label: '编辑者', level: 2, canDelete: true }
  }
  if (role === 'viewer') {
    return { label: '访客', level: 1, canDelete: false }
  }
  return { label: '未知', level: 0, canDelete: false }
}
`)
  w(base, 'self-test.js', `
// TODO: 覆盖 5 种情况（0 / 1KB / 1MB / 空输入 / 越界）
`)
  w(base, 'README.md', `
# t2-accept

- util.js：实现 formatBytes 与 clamp，并补全 self-test.js（至少 5 种情况）
- roles.js：三个 if 分支结构重复，可合并为查表
`)
}

function t5 (base) {
  mkdirSync(base, { recursive: true })
  const hits = { 2: true, 5: true, 9: true }
  for (let i = 1; i <= 12; i++) {
    const lines = []
    for (let j = 1; j <= 3000; j++) {
      lines.push(hits[i] && j % 900 === 1 ? `line ${j}: ALPHA marker here` : `line ${j}: filler content`)
    }
    writeFileSync(join(base, `file${String(i).padStart(2, '0')}.txt`), lines.join('\n'), 'utf8')
  }
}

function t7 (base) {
  mkdirSync(base, { recursive: true })
  const hitAt = { 3: 1, 11: 2, 19: 3, 27: 1, 33: 2, 39: 1 }
  for (let i = 1; i <= 40; i++) {
    const body = [`# doc ${i}`]
    for (let k = 0; k < 6; k++) {
      body.push(hitAt[i] && k === 0
        ? `omega 相关段落：这是第 ${i} 号文件里关于 omega 的说明。`
        : `普通段落 ${k}：讨论缓存策略与部署流程。`)
    }
    writeFileSync(join(base, `doc${String(i).padStart(2, '0')}.md`), body.join('\n\n'), 'utf8')
  }
}

const GEN = { 't1-edit': t1, 't2-accept': t2, 't5-long': t5, 't7-search': t7 }

// ── 参数 ──────────────────────────────────────────────
const args = process.argv.slice(2)
mkdirSync(SB, { recursive: true })

if (args[0] === '--list') {
  const dirs = readdirSync(SB, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  console.log('已生成沙箱（' + dirs.length + '）:')
  for (const d of dirs.sort()) console.log('  ' + d)
  process.exit(0)
}

if (args[0] === '--reset') {
  const name = args[1]
  const key = Object.keys(GEN).find((k) => name && name.startsWith(k))
  if (!key) { console.error('未知目标（可选: ' + Object.keys(GEN).join(', ') + '）'); process.exit(1) }
  const target = join(SB, name)
  if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  GEN[key](target)
  console.log('已重置: ' + target)
  process.exit(0)
}

const roundsIdx = args.indexOf('--rounds')
const rounds = roundsIdx >= 0 ? Number(args[roundsIdx + 1]) || 6 : 6

let n = 0
for (const [key, fn] of Object.entries(GEN)) {
  for (let i = 1; i <= rounds; i++) {
    const target = join(SB, `${key}-r${i}`)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    fn(target)
    n++
  }
}
console.log(`已生成 ${n} 个沙箱（${Object.keys(GEN).length} 任务 × ${rounds} 轮）于：`)
console.log('  ' + SB)
console.log('每任务可用的轮次: ' + Object.keys(GEN).map((k) => k + '-r1…r' + rounds).join('  '))
