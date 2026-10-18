import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const out = 'C:/Users/admin/Desktop/快速反应-交付'
const src = 'C:/Users/admin/.dsh/plugins/dsh-fast-react'
const ver = JSON.parse(fs.readFileSync(src + '/package.json', 'utf8')).version

// 1) 清理旧版本产物
const keep = new Set([`dsh-fast-react-${ver}.tgz`, `github-pack-${ver}.zip`, `dsh-fast-react-source-${ver}.zip`, `04-GitHub更新-${ver}`, `dsh-fast-react-${ver}`])
const walkClean = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    const rel = path.relative(out, p)
    const top = rel.split(path.sep)[0]
    const isOld = /^(04-GitHub更新-\d|github-pack-|dsh-fast-react-\d|dsh-fast-react-source-)/.test(top) && !keep.has(top)
    if (isOld) { fs.rmSync(p, { recursive: true, force: true }); console.log('清理:', rel) }
    else if (e.isDirectory() && rel.split(path.sep).length < 2) walkClean(p)
  }
}
walkClean(out)

// 2) 重建 1.2.0 源码快照
const snap = path.join(out, '02-源码', `dsh-fast-react-${ver}`)
fs.rmSync(snap, { recursive: true, force: true })
const SKIP = new Set(['node_modules', '.git', '.board'])
const copy = (rel) => {
  const from = path.join(src, rel)
  if (!fs.existsSync(from)) return
  const to = path.join(snap, rel)
  const st = fs.statSync(from)
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true })
    for (const e of fs.readdirSync(from)) { if (SKIP.has(e) || e.endsWith('.tgz')) continue; copy(path.join(rel, e)) }
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
  }
}
for (const r of ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', '.gitignore', 'lib', 'docs', 'tools']) copy(r)

// 3) 打源码 zip（根层 = 仓库内容）
const tmp = 'C:/Users/admin/AppData/Local/Temp/fr-src-final'
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
fs.cpSync(snap, tmp, { recursive: true })
const zip = path.join(out, '02-源码', `dsh-fast-react-source-${ver}.zip`)
fs.rmSync(zip, { force: true })
execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${tmp}\\*' -DestinationPath '${zip}' -Force`], { stdio: 'inherit' })
fs.rmSync(tmp, { recursive: true, force: true })

// 4) 文档同步
const docDir = path.join(out, '03-文档')
fs.mkdirSync(docDir, { recursive: true })
for (const f of fs.readdirSync(src + '/docs')) fs.copyFileSync(`${src}/docs/${f}`, path.join(docDir, f))
fs.copyFileSync(src + '/README.md', path.join(docDir, 'README.md'))

console.log(JSON.stringify({ version: ver, snapshot: snap, sourceZip: zip }, null, 1))
