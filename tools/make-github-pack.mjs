// 生成 GitHub 上传素材包：04-GitHub更新-<ver>/ + 同名 zip（根层即仓库内容）
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
      if (SKIP.has(e.name) || e.name.endsWith('.tgz')) continue
      copy(path.join(rel, e.name))
    }
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
  }
  return true
}

for (const rel of ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', '.gitignore', 'lib', 'docs', 'tools']) copy(rel)

// 上传说明
const readme = `# GitHub 上传素材 · 快速反应 v${ver}

> 把本文件夹里的**所有内容**拖进 GitHub 上传页即可（同名文件自动覆盖）。
> 本说明文件**不要上传**（它只是给你看的）。

## 一、这次要上传的文件

| 路径 | 变化 |
|---|---|
| \`package.json\` | 版本 ${ver} |
| \`lib/index.js\` | 新路线重置进度、终局交付兜底、创建会话显式传 effort、前台禁自审插件 |
| \`lib/api.js\` | 会话级寻址（sessionId/group/role）、会话清单 |
| \`lib/ui/page.html\` | 隐藏后台内部话术、修复消息排序、终局/运行指示 |
| \`lib/ui/sidebar.js\` | 版本号显示 1.0 |
| \`docs/使用须知.md\` | 会话级 API、AI Project 说明 |
| \`docs/技术路线.md\` | 架构与踩坑复盘 |
| \`docs/升级验证.md\` | **新增**：升级前后自检清单 + 0.2.1 两个已知坑（BOM / effort） |
| \`tools/*.mjs\` | **新增**：selfcheck / heal / diag / repair-state / sync-desktop |
| \`README.md\` \`LICENSE\` \`cordis.patch.yml\` \`.gitignore\` | 无变化或仅版本号 |

## 二、上传步骤（网页，2 分钟）

1. 解压本目录旁边的 \`github-pack-${ver}.zip\`（或直接进本文件夹）
2. 打开 <https://github.com/Ewfrewfaf/dsh-fast-react/upload/main>
3. 把 \`lib\`、\`docs\`、\`tools\`、\`README.md\`、\`package.json\`、\`LICENSE\`、\`cordis.patch.yml\`、\`.gitignore\` 全选拖进去
4. 底部 **Commit changes** → 保持 *Commit directly to main* → **Commit changes**

## 三、发 Release（挂安装包）

1. <https://github.com/Ewfrewfaf/dsh-fast-react/releases/new>
2. Tag：\`v${ver}\` → **Create new tag**
3. Title：\`v${ver}\`
4. 附件：\`01-安装包/dsh-fast-react-${ver}.tgz\`
5. Publish release

### Release 说明（可直接粘贴）

\`\`\`markdown
## 快速反应 v${ver}

AI Project · DeepSeek Harness 双会话编排插件（前台快答快做 + 后台逐步规划）。

### 本版重点

- **修复：升级 DSH 0.2.1 后插件消失** —— package.json 的 UTF-8 BOM 被严格解析拒绝
- **修复：思考强度错乱** —— 新版不再继承全局 reasoningEffort，改为创建会话时显式传入
  （前台 low / 后台 max，可在 config 调整）
- **修复：后台下发步骤后前台空等** —— 新路线到达时重置上一轮进度（done 卡在最后一步）
- **修复：终局不交付** —— 简报强制"跑完最后一步必须在回复里给结论/路径/注意事项"，
  并加插件层兜底：回复过短会一次性催交付
- **修复：面板显示后台内部话术** —— 不再渲染后台与会话，排序按时间戳
- **新增：工具** —— selfcheck（18 项自检）/ heal / diag / repair-state
- 搜索类任务：后台步骤改为批量并行（一步 3-5 个查询，总步数 ≤5）

### 安装

\`\`\`bash
dsh plugin --profile <你的profile> add dsh-fast-react-${ver}.tgz
# 装完重启一次 DSH，打开侧边栏「快速反应」或 http://127.0.0.1:<DSH端口>/fr
\`\`\`

### 升级注意（从 1.0.2 之前版本上来）

- 若插件在 DSH 0.2.1 里不出现：确认 package.json 无 BOM（本包已修复）
- 升级后跑一次自检：\`node tools/selfcheck.mjs <端口>\`
\`\`\`

## 四、上传后自检

\`\`\`bash
node tools/selfcheck.mjs <DSH端口>
# 期望 18/18 通过
\`\`\`
`
fs.writeFileSync(path.join(packDir, '上传说明.md'), readme, 'utf8')

// 打包 zip（根层 = 仓库内容，排除上传说明）
const tmp = 'C:/Users/admin/AppData/Local/Temp/fr-gh-pack'
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
for (const e of fs.readdirSync(packDir)) {
  if (e === '上传说明.md') continue
  fs.cpSync(path.join(packDir, e), path.join(tmp, e), { recursive: true })
}
const zip = path.join(outRoot, `github-pack-${ver}.zip`)
fs.rmSync(zip, { force: true })
execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${tmp}\\*' -DestinationPath '${zip}' -Force`], { stdio: 'inherit' })
fs.rmSync(tmp, { recursive: true, force: true })

const files = []
const walk = (d, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); const r = path.join(rel, e.name); if (e.isDirectory()) walk(p, r); else files.push(r) } }
walk(packDir)
console.log(JSON.stringify({ version: ver, packDir, zip, files: files.length, list: files }, null, 1))
