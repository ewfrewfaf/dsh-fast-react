// 生成 GitHub 上传素材包：04-GitHub更新-<ver>/ + 同名 zip（根层即仓库内容）
// 说明与 Release 文案拆成两个独立文件：上传说明.md（步骤）/ Release说明-<ver>.md（纯文案，全选即可复制）
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PLUGIN_ROOT, tmpDir, desktopDir } from './paths.mjs'
import { join } from 'node:path'

const src = PLUGIN_ROOT
const outRoot = join(desktopDir(), '快速反应-交付')
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
for (const rel of ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', '.gitignore', 'icon.svg', 'locale', 'lib', 'docs', 'tools']) copy(rel)

// ── ① 上传说明：只讲步骤，不放长文案 ────────────────────────────────
const guide = `# GitHub 上传素材 · 快速反应 v${ver}

> 本文件只是**操作步骤**，不要上传。
> 隔壁的 \`Release说明-${ver}.md\` 是**纯发布文案**，打开后全选复制到 GitHub 即可。

## 一、上传代码（2 分钟）

1. 打开 <https://github.com/Ewfrewfaf/dsh-fast-react/upload/main>
2. 把本文件夹里的 \`lib\`、\`docs\`、\`tools\`、\`README.md\`、\`package.json\`、\`LICENSE\`、\`cordis.patch.yml\`、\`.gitignore\` **全选拖进去**
   （⚠️ 不要拖 \`上传说明.md\` 和 \`Release说明-${ver}.md\`）
3. 底部 **Commit changes** → 保持 *Commit directly to main* → **Commit changes**

> **v1.5.0 起改为单包**：客户端页面（侧边栏入口 + 控制台挂载）已并入主包，
> 不再需要单独安装 \`@dsh-external/dsh-fast-react-ui\`。

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
| \`package.json\` | 版本 ${ver}，新增 icon / locale / exports |
| \`icon.svg\` | **新增**：插件管理页图标 |
| \`locale/zh.json\` \`locale/en.json\` | **新增**：管理页标题与介绍 |
| \`lib/sentinel.js\` | **新增**：哨兵解析与求值（纯函数） |
| \`lib/route-plan.js\` | **新增**：路线参数校验 / 里程碑截断 / 哨兵预检 |
| \`lib/modes.js\` | 判型引擎 v2、5 种模式、review 模式简报 |
| \`lib/index.js\` | 三档判型接入、强制上交、全局工具、scope 工具注册 |
| \`lib/api.js\` | 刹车 API、mode/mode_strict 参数 |
| \`lib/ui/page.html\` | 刹车按钮 |
| \`docs/移植指南.md\` | **新增**：换机器安装说明 |
| \`tools/test-sentinel.mjs\` \`tools/test-route-plan.mjs\` | **新增**：33 例单测 |

## 四、上传后自检

\`\`\`bash
node tools/selfcheck.mjs <DSH端口>
# 期望 18/18 通过
\`\`\`
`
fs.writeFileSync(path.join(packDir, '上传说明.md'), guide, 'utf8')

// ── ② Release 文案：纯正文，无标题无说明，全选即用 ──────────────────
// Release 文案用数组拼（内容里含大量反引号，用模板字符串会打架）
const notesLines = [
  '## 快速反应 v' + ver,
  '',
  'DeepSeek Harness 双会话编排插件：前台快速执行，后台逐步规划。',
  '',
  '### 本版重点：判型引擎',
  '',
  '**核心变化：不再「什么都走编排」。** 内置机械判型（细词表三档打分），简单任务直接做、复杂任务才叫后台。',
  '',
  '实测（L1-L5 各 2 轮）：',
  '',
  '| 档 | 单 Agent | 旧版强制编排 | 本版判型后 |',
  '|---|---|---|---|',
  '| L1 | 12.1s | 17.4s | **6.4s** |',
  '| L2 | 21.3s | 28.9s | **10.0s** |',
  '| L5 | 141.2s | 60.6s | **62.0s** |',
  '',
  'L1 快 47%，L2 快 53%，L5 保持编排优势。',
  '',
  '### 新增',
  '',
  '- **判型引擎 v2** —— 四层词表（60+ 规则）、层内封顶防刷分、三档判定',
  '  - score >= 6 → 编排；score <= 3 → 自己做；中间灰区 ⇒ 前台先做 + 后台并行分诊',
  '- **review 模式** —— 读代码找问题，只读不改，产出带文件行号的分级报告',
  '- **三个全局工具** —— fr_task（可精确到会话组）/ fr_status / fr_brake，任意会话可调',
  '- **刹车按钮** —— 控制台工具栏 [启动] [⏸ 刹车] [停止]；刹车只停当前任务，不停插件',
  '- **插件图标** —— 管理页显示自定义图标与介绍',
  '',
  '### 修复',
  '',
  '- **quick 模式可升级** —— 前台主动上交时自动切 coding（原来被一刀切拒绝，实测单轮白跑 27 个工具 / 143 秒）',
  '- **coding 强制上交** —— 简报覆盖 + 6/12 工具处催促 + 25 工具兜底（原来判了 coding 也不上交，双会话空转）',
  '- **哨兵拒绝预存文件** —— file-exists 目标已存在时丢弃（原来会立即误触发、冻结前台）',
  '- **工具面按会话隔离** —— fr_* 内部工具只对快速反应会话可见，普通会话不再多出 6 个用不上的工具',
  '- **记录文件治理** —— 禁止要求前台写 notes.md / checklist.md 等中间记录（实测纯浪费 50-60s/任务，验收根本不读）',
  '',
  '### 代码结构',
  '',
  '- 新增 lib/sentinel.js（哨兵解析与求值）、lib/route-plan.js（路线参数校验/里程碑截断/哨兵预检）',
  '- 抽出纯函数后配套 **33 例单测**（tools/test-sentinel.mjs / tools/test-route-plan.mjs）',
  '- index.js 文件头新增模块划分、区块地图、机制速查',
  '',
  '### 安装',
  '',
  '```bash',
  'dsh plugin --profile <你的 profile> add dsh-fast-react-' + ver + '.tgz',
  '# 装完重启一次 DSH（package.json 的 meta 只在启动时扫描）',
  '# 打开侧边栏「快速反应」或 http://127.0.0.1:<DSH端口>/fr',
  '```',
  '',
  '### 验证',
  '',
  '```bash',
  'node tools/regression.mjs',
  '# 期望：静态审计 / selfcheck 18 项 / UI-API 25 项 / 代码修复点 129 项 全部通过',
  '```',
  '',
  '### 兼容性',
  '',
  '**无破坏性变更**：配置格式、API 路径、黑板结构均向后兼容，老的 .board 目录可直接用。',
  '',
  '唯一注意：fr_* 从「全局注册」改为「按会话注册」。若有脚本依赖它全局可见，请改用 fr_task / fr_status / fr_brake。',
  '',
  '### 文档',
  '',
  '- 使用须知：docs/使用须知.md',
  '- 技术路线：docs/技术路线.md',
  '- 移植指南：docs/移植指南.md',
  '',
].join('\n')
const notes = notesLines
fs.writeFileSync(path.join(packDir, `Release说明-${ver}.md`), notes, 'utf8')

// ── ③ 打 zip（根层=仓库内容，排除两个说明文件）────────────────────
const tmp = tmpDir('fr-gh-pack')
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
// ── ④ 把 tgz 归入 01-安装包/（上传说明里引用的路径）─────────────────
const binDir = path.join(outRoot, '01-安装包')
fs.mkdirSync(binDir, { recursive: true })
const tgzSrc = path.join(desktopDir(), `dsh-fast-react-${ver}.tgz`)
if (fs.existsSync(tgzSrc)) {
  fs.copyFileSync(tgzSrc, path.join(binDir, `dsh-fast-react-${ver}.tgz`))
  console.log('tgz 已归入 01-安装包/')
} else {
  console.log('⚠️ 未找到 ' + tgzSrc + '（先跑 npm pack）')
}

console.log(JSON.stringify({ version: ver, packDir, zip, files: files.length, list: files.filter(f => !f.includes(path.sep + 'lib') && !f.includes(path.sep + 'docs') && !f.includes(path.sep + 'tools') || false) }, null, 1))
