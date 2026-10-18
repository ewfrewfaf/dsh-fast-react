// 生成 GitHub 上传素材包：04-GitHub更新-<ver>/ + 同名 zip（根层即仓库内容）
// 说明与 Release 文案拆成两个独立文件：上传说明.md（步骤）/ Release说明-<ver>.md（纯文案，全选即可复制）
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const src = 'C:/Users/admin/.dsh/plugins/dsh-fast-react'
const outRoot = 'C:/Users/admin/Desktop/快速反应-交付'
const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'))
const ver = pkg.version
const packDir = path.join(outRoot, `04-GitHub更新-${ver}`)

fs.rmSync(packDir, { recursive: true, force: true })
fs.mkdirSync(packDir, { recursive: true })

const SKIP = new Set(['node_modules', '.git', '.board'])
const copy = (rel) => {
  const from = path.join(src, rel)
  if (!fs.existsSync(from)) return false
  const to = path.join(packDir, rel)
  const st = fs.statSync(from)
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.name.endsWith('.tgz') || e.name === '上传说明.md') continue
      copy(path.join(rel, e.name))
    }
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
  }
  return true
}
for (const rel of ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', '.gitignore', 'lib', 'docs', 'tools']) copy(rel)

// ── ① 上传说明：只讲步骤，不放长文案 ────────────────────────────────
const guide = `# GitHub 上传素材 · 快速反应 v${ver}

> 本文件只是**操作步骤**，不要上传。
> 隔壁的 \`Release说明-${ver}.md\` 是**纯发布文案**，打开后全选复制到 GitHub 即可。

## 一、上传代码（2 分钟）

1. 打开 <https://github.com/Ewfrewfaf/dsh-fast-react/upload/main>
2. 把本文件夹里的 \`lib\`、\`docs\`、\`tools\`、\`README.md\`、\`package.json\`、\`LICENSE\`、\`cordis.patch.yml\`、\`.gitignore\` **全选拖进去**
   （⚠️ 不要拖 \`上传说明.md\` 和 \`Release说明-${ver}.md\`）
3. 底部 **Commit changes** → 保持 *Commit directly to main* → **Commit changes**

## 二、发 Release（1 分钟）

1. 打开 <https://github.com/Ewfrewfaf/dsh-fast-react/releases/new>
2. **Choose a tag** → 输入 \`v${ver}\` → 点绿色 **Create new tag: v${ver} on publish**
3. **Release title** 填 \`v${ver}\`
4. **Describe this release**：打开 \`Release说明-${ver}.md\` → 全选（Ctrl+A）复制 → 粘贴
5. **Attach binaries**：拖入 \`01-安装包/dsh-fast-react-${ver}.tgz\`
6. 右下绿色 **Publish release**

## 三、本次涉及的文件

| 路径 | 变化 |
|---|---|
| \`package.json\` | 版本 ${ver} |
| \`lib/index.js\` | 新路线重置进度、终局交付兜底、创建会话显式传 effort、前台禁自审插件 |
| \`lib/api.js\` | 会话级寻址、会话清单 |
| \`lib/ui/page.html\` | 隐藏后台内部话术、修复消息排序、终局/运行指示 |
| \`lib/ui/sidebar.js\` | 版本号显示 1.0 |
| \`docs/使用须知.md\` \`docs/技术路线.md\` | 已更新 |
| \`docs/升级验证.md\` | **新增**：升级自检清单 + 0.2.1 两个坑（BOM / effort） |
| \`tools/*.mjs\` | **新增**：selfcheck / heal / diag / repair-state / sync-desktop / make-github-pack |

## 四、上传后自检

\`\`\`bash
node tools/selfcheck.mjs <DSH端口>
# 期望 18/18 通过
\`\`\`
`
fs.writeFileSync(path.join(packDir, '上传说明.md'), guide, 'utf8')

// ── ② Release 文案：纯正文，无标题无说明，全选即用 ──────────────────
const notes = `## 快速反应 v${ver}

AI Project · DeepSeek Harness 双会话编排插件（前台快答快做 + 后台逐步规划）。

### 本版重点：适配 DSH 0.2.1

- **修复：升级 0.2.1 后插件消失** —— \`package.json\` 的 UTF-8 BOM 被严格解析拒绝，插件被静默跳过；本包已去 BOM
- **修复：思考强度错乱** —— 新版不再继承全局 \`reasoningEffort\`；改为创建会话时显式传（前台 low / 后台 max，可在 config 调整）
- **修复：后台下发步骤后前台空等** —— 上一轮 \`done\` 卡在最后一步导致找不到下一步；新路线到达时自动重置进度
- **修复：终局不交付** —— 简报强制「跑完最后一步必须在回复里给结论 / 路径 / 注意事项」，并加插件层兜底（回复过短会催一次）
- **修复：面板显示后台内部话术** —— 不再渲染后台会话；消息按真实时间戳排序
- **搜索类任务提速** —— 后台步骤改为批量并行（一步 3–5 个查询，总步数 ≤5）
- **新增运维工具** —— \`selfcheck\`（18 项自检）/ \`heal\` / \`diag\` / \`repair-state\`

### 安装

\`\`\`bash
dsh plugin --profile <你的 profile> add dsh-fast-react-${ver}.tgz
# 装完重启一次 DSH，打开侧边栏「快速反应」或 http://127.0.0.1:<DSH端口>/fr
\`\`\`

### 从旧版升级

- 若插件在 DSH 0.2.1 里不出现：确认 \`package.json\` 无 BOM（本包已修复）
- 升级后跑一次自检：\`node tools/selfcheck.mjs <端口>\`（期望 18/18）

### 文档

- 使用须知：\`docs/使用须知.md\`
- 技术路线：\`docs/技术路线.md\`
- 升级验证：\`docs/升级验证.md\`
`
fs.writeFileSync(path.join(packDir, `Release说明-${ver}.md`), notes, 'utf8')

// ── ③ 打 zip（根层=仓库内容，排除两个说明文件）────────────────────
const tmp = 'C:/Users/admin/AppData/Local/Temp/fr-gh-pack'
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
for (const e of fs.readdirSync(packDir)) {
  if (e === '上传说明.md' || e.startsWith('Release说明-')) continue
  fs.cpSync(path.join(packDir, e), path.join(tmp, e), { recursive: true })
}
const zip = path.join(outRoot, `github-pack-${ver}.zip`)
fs.rmSync(zip, { force: true })
execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${tmp}\\*' -DestinationPath '${zip}' -Force`], { stdio: 'inherit' })
fs.rmSync(tmp, { recursive: true, force: true })

const files = []
const walk = (d, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); const r = path.join(rel, e.name); if (e.isDirectory()) walk(p, r); else files.push(r) } }
walk(packDir)
console.log(JSON.stringify({ version: ver, packDir, zip, files: files.length, list: files.filter(f => !f.includes(path.sep + 'lib') && !f.includes(path.sep + 'docs') && !f.includes(path.sep + 'tools') || false) }, null, 1))
