import { PLUGIN_ROOT } from './paths.mjs'
// 全量回归：一次性跑完所有检查项
// ★ 2026-11-07：端口自动探测（不写死）。写死端口会让整套回归在"环境变了"时全红，
//   把人误导成"代码坏了"。子脚本自己也探测，这里只在**显式传入**时才透传。
const CANDIDATES = ['1890', '11296', '2204', '7408', '3557', '9148', '10304', '13889', '7754', '19387', '4099', '5239', '7351', '3633']
async function detectPort () {
  for (const p of CANDIDATES) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/fr/status`, { signal: AbortSignal.timeout(1200) })
      if (r.ok || r.status === 401 || r.status === 403) return p
    } catch { /* 下一个 */ }
  }
  return ''
}
const explicitPort = process.argv[2] || ''
const port = explicitPort || (await detectPort())
const base = `http://127.0.0.1:${port || 13889}`
const portArgs = explicitPort ? [explicitPort] : []    // 未显式指定 ⇒ 让子脚本自己探测
const fs = await import('node:fs')
const { execFileSync } = await import('node:child_process')

const root = PLUGIN_ROOT
const results = []
const run = (label, script, args = []) => {
  try {
    const out = execFileSync('node', [root + '/tools/' + script, ...args], { encoding: 'utf8', timeout: 180000 })
    const pass = /PASS/.test(out) || /全部通过: true/.test(out) || /0 失败/.test(out) || /通过 \/ 0/.test(out)
    const lastLines = out.trim().split('\n').slice(-3).join(' | ')
    results.push({ label, ok: pass, detail: lastLines.slice(0, 160) })
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '')
    const lastLines = out.trim().split('\n').slice(-3).join(' | ')
    results.push({ label, ok: false, detail: lastLines.slice(0, 160) || String(e.message).slice(0, 120) })
  }
}

console.log('=== 全量回归开始（可能需要几分钟）===\n')

// 1) 静态审计（只检查关键项，不判失败）
try {
  const out = execFileSync('node', [root + '/tools/audit-static.mjs'], { encoding: 'utf8', timeout: 60000 })
  const j = JSON.parse(out)
  const fatal = (j.issues || []).filter(x => x.level === 'error')
  results.push({ label: '静态审计（致命问题）', ok: fatal.length === 0, detail: fatal.length ? JSON.stringify(fatal) : '无致命问题' })
} catch (e) { results.push({ label: '静态审计', ok: false, detail: String(e.message).slice(0, 100) }) }

// 2) 自检 18 项
try {
  const out = execFileSync('node', [root + '/tools/selfcheck.mjs', ...portArgs], { encoding: 'utf8', timeout: 120000 })
  const m = out.match(/结果：(\d+) 通过 \/ (\d+) 失败/)
  const pass = m ? Number(m[2]) === 0 : false
  results.push({ label: 'selfcheck 18 项', ok: pass, detail: m ? `${m[1]} 通过 / ${m[2]} 失败` : '无法解析' })
} catch (e) {
  const out = String(e.stdout || '')
  const m = out.match(/结果：(\d+) 通过 \/ (\d+) 失败/)
  results.push({ label: 'selfcheck 18 项', ok: m ? Number(m[2]) === 0 : false, detail: m ? `${m[1]}/${m[2]}` : String(e.message).slice(0, 100) })
}

// 3) UI/API 审计
try {
  const out = execFileSync('node', [root + '/tools/audit-ui-api.mjs', ...portArgs], { encoding: 'utf8', timeout: 120000 })
  const m = out.match(/结果：(\d+) 通过 \/ (\d+) 失败/)
  results.push({ label: 'UI/API 审计', ok: m ? Number(m[2]) === 0 : false, detail: m ? `${m[1]} 通过 / ${m[2]} 失败` : '无法解析' })
} catch (e) {
  const out = String(e.stdout || '')
  const m = out.match(/结果：(\d+) 通过 \/ (\d+) 失败/)
  results.push({ label: 'UI/API 审计', ok: m ? Number(m[2]) === 0 : false, detail: m ? `${m[1]}/${m[2]}` : String(e.message).slice(0, 100) })
}

// 4) 代码关键修复点存在性
const src = fs.readFileSync(root + '/lib/index.js', 'utf8')
// ★ #8 拆分后：部分关键逻辑迁到 lib/*.js，静态审计要覆盖全模块（否则误报"缺失"）
const mods = ['board.js', 'state.js', 'delivery.js', 'scheduler.js', 'sentinels.js', 'kernel.js', 'modes.js', 'defaults.js']
  .map((f) => { try { return fs.readFileSync(root + '/lib/' + f, 'utf8') } catch { return '' } })
  .join('\n')
const all = src + '\n' + mods
const api = fs.readFileSync(root + '/lib/api.js', 'utf8')
const page = fs.readFileSync(root + '/lib/ui/page.html', 'utf8')
const codeChecks = {
  '工具能力策略(解耦M13)': all.includes('WORK_TOOLS') && all.includes('isDeniedTool') && !/frontTools:\s*\[/.test(all),
  // ★ 2026-11-07 递归环修复：旧守卫断言 allowListFor 一律返回 WORK_TOOLS（正是 bug 本身）。
  //   新不变式：allowListFor 必须**按 role 分流**，且后台不得拿到任何驱动会话的工具。
  '工具面按角色分流': /export function allowListFor[\s\S]{0,400}role\s*===\s*'back'/.test(all),
  '后台无递归入口': (() => {
    const m = all.match(/WORK_TOOLS_BACK\s*=\s*\[([\s\S]*?)\]/)
    if (!m) return false
    return !/fr_escalate|fr_mode|fr_worker|fr_status|fr_poke/.test(m[1])
  })(),
  '后台有产出通道': (() => {
    const m = all.match(/WORK_TOOLS_BACK\s*=\s*\[([\s\S]*?)\]/)
    return !!m && m[1].includes('fr_route')
  })(),
  '前台无 fr_route': (() => {
    const m = all.match(/WORK_TOOLS_FRONT\s*=\s*\[([\s\S]*?)\]/)
    return !!m && !m[1].includes('fr_route')
  })(),
  // 身份判定：worker 不得被当成编排会话（递归环 2）
  'worker 不被认作 fr 会话': /if\s*\(\s*\/\^worker-\/\.test\(rest\)\s*\)\s*return false/.test(src),
  // 工具面随会话重建即时挂载（本 bug 主体，窗口必须为 0）
  '重建即时挂工具面': (src.match(/attachToolPolicyFor\(tag, ag\)/g) || []).length >= 2,
  // ★ 强制：**每一个** svcAgentLoop.create 后 10 行内必须有挂载动作，
  //   防止将来新增创建点忘了挂（漏一个就是一个 68 工具的窗口）
  '所有创建点均挂工具面': (() => {
    const lines = src.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (!/svcAgentLoop\.create/.test(lines[i])) continue
      const win = lines.slice(i, i + 10).join(' ')
      if (!/attachToolPolicyFor|__frWorkerDispose|tools\.restrict/.test(win)) return false
    }
    return true
  })(),
  '去重分支仍重挂': /activeMode === p\.key[\s\S]{0,400}reapplyToolPolicyIfNeeded/.test(src),
  'resolveAgents 末尾重挂': /reapplyToolPolicyIfNeeded\(\)[\s\S]{0,200}\}/.test(src),
  // TDZ：modeDisposers 必须先于 resolveAgents 声明
  'modeDisposers 无 TDZ': (() => {
    const d = src.indexOf('const modeDisposers')
    const r = src.indexOf('function resolveAgents')
    return d > 0 && r > 0 && d < r
  })(),
  // ★ 2026-11-07 route 污染守卫：rebuildSessions 绝不能把 resolveRoute 的 base 写回 cfg
  //   （那会把 buddy/glm 固化成前后台 base，导致会话被静默换模型 + 返回值谎报）
  'rebuild 不污染全局路由': !/overrides\.provider\s*=\s*route\.provider/.test(src),
  'rebuild 按角色取路由': /effRoute\s*=\s*\(tag\)[\s\S]{0,120}routeFor\(tag\)/.test(src),
  // 可移植：lib 不得有硬编码用户路径（注释除外，故只查非注释行）
  'lib 无硬编码用户路径': !(src.split(/\r?\n/) || []).some(l => !/^\s*(?:\/\/|\*)/.test(l) && /C:[\\/]Users[\\/](?!admin\.\.\.)[a-z]/i.test(l)),
  'tools 有 paths.mjs': fs.existsSync(root + '/tools/paths.mjs'),
  'boardRoot 可移植': /FAST_REACT_BOARD/.test(mods) && /DSH_HOME/.test(mods),
  // ★ 多实例工具名本地化：简报与模式说明都必须走 localizeToolNames
  '有 localizeToolNames': /function localizeToolNames/.test(src),
  'brief 走本地化': /function brief[\s\S]{0,400}localizeToolNames\(text\)/.test(src),
  'modeNotice 走本地化': /localizeToolNames\(modeNotice\(/.test(src),
  // ★ 2026-11-07 归档缺口守卫（实测：23 次归档 18 次有「里程碑>步骤」缺口，
  //   milestone-gap 事件 0 条 —— 催补机制从未生效，因为任务在 19s 内就归档了）
  '归档前校验里程碑缺口': /archiveBlocked|archive-blocked/.test(fs.readFileSync(root + '/lib/scheduler.js', 'utf8')),
  '缺口守卫调用 routeMilestoneCount': /routeMilestoneCount/.test(fs.readFileSync(root + '/lib/scheduler.js', 'utf8')),
  'board 导出 routeMilestoneCount': /routeMilestoneCount/.test(fs.readFileSync(root + '/lib/board.js', 'utf8')),
  // 判据要排除注释行（修复说明里引用了原句，会误报）
  '预规划不再诱导写 deliver': !(src.split('\n').some(l => !/^\s*(?:\/\/|\*)/.test(l) && /若任务.{0,6}接近完成.{0,10}写.{0,20}deliver/.test(l))),
  'route 后即时催补': /route-gap-immediate/.test(src),
  'briefs 要求响应催补': /milestone-gap 催补/.test(fs.readFileSync(root + '/lib/briefs.js', 'utf8')),
  // ★ 2026-11-07 催补链路修复（根因：deliver 残留堵死缺口检查）
  'checkLookahead 缺口检查在 hasDeliver 之前': (() => {
    const i = src.indexOf('function checkLookahead')
    if (i < 0) return false
    const body = src.slice(i, i + 2000)
    // 只看"非注释行"，否则会匹配到解释原顺序的注释
    const codeLines = body.split('\n').filter(l => !/^\s*(?:\/\/|\*)/.test(l)).join('\n')
    const gap = codeLines.indexOf('routeMilestoneCount()')
    const dv = codeLines.search(/if\s*\(\s*hasDeliver\(\)\s*\)\s*return/)
    return gap >= 0 && dv >= 0 && gap < dv
  })(),
  '新任务清理旧 deliver': /deliver-cleared/.test(src),
  '归档时清理 deliver': /deliver-cleared/.test(fs.readFileSync(root + '/lib/scheduler.js', 'utf8')),
  '催补计数随任务重置': /if \(a === front && !isSteerInsert\) \{[\s\S]{0,300}milestoneGapCount\s*=\s*0/.test(src),
  'API 任务一律清场': /const isApiTask = !!\(opts && opts\.external\)/.test(src) && /external: true/.test(fs.readFileSync(root + '/lib/api.js', 'utf8')),
  // ★ 2026-11-08 判型修复：modeBy==='user' 不该永久阻断自动判型
  '判型不被 by=user 永久阻断': /modeBy === 'user' && isSameTask/.test(src),
  '判型有独立文本记录': /let lastDetectText/.test(src),
  '判型后记录文本': /lastDetectText = thisText/.test(src),
  // ★ 2026-11-08 判型 v2 + 分诊 + 刹车 + review 模式
  '判型v2：三档判定': /tend === 'coding'|tend = 'gray'/.test(mods) && /THRESHOLD_HIGH/.test(mods),
  '判型v2：细词表(4层)': /LEX = \{/.test(mods) && /sys:/i.test(mods) && /arch:/i.test(mods),
  '判型v2：层内封顶': /LAYER_CAP/.test(mods),
  '判型v2：灰区分诊': /triage-woken/.test(src) && /wakeBack\('triage'/.test(src),
  '判型v2：显式模式参数': /mode-explicit/.test(src) && /opts\.mode_strict/.test(src),
  '判型v2：pin 锁定': /modePinned/.test(src) && /mode-pinned/.test(src),
  '判型v2：API mode 参数': /extraOpts\.mode/.test(fs.readFileSync(root + '/lib/api.js', 'utf8')),
  '兜底：25 工具自动升级': /auto-upgrade/.test(src) && /stepsThisTask > 25/.test(src),
  'review 模式存在': /key: 'review'/.test(mods),
  'review 判型意图': /REVIEW_INTENT/.test(mods),
  '刹车 API': /\/api\/brake/.test(fs.readFileSync(root + '/lib/api.js', 'utf8')),
  '解除刹车 API': /\/api\/unbrake/.test(fs.readFileSync(root + '/lib/api.js', 'utf8')),
  'unbrake 方法': /unbrake \(\)/.test(src),
  'brake 方法': /brake \(scope/.test(src),
  // ★ 2026-11-08 三项补完
  '刹车按钮 UI': /btnBrake/.test(fs.readFileSync(root + '/lib/ui/page.html', 'utf8')),
  '刹车按钮事件绑定': /post\('\/brake'/.test(fs.readFileSync(root + '/lib/ui/page.html', 'utf8')),
  '分诊回执(route→升级)': /triage-upgraded/.test(src),
  'review 模式简报(前台)': /只读不改/.test(fs.readFileSync(root + '/lib/modes.js', 'utf8')),
  'review 模式简报(后台)': /规划审什么/.test(fs.readFileSync(root + '/lib/modes.js', 'utf8')),
  // ★ 2026-11-08 A 方案：coding 模式强制上交
  'coding 强制上交(简报)': /本模式必须上交/.test(fs.readFileSync(root + '/lib/modes.js', 'utf8')),
  // ★ 2026-11-08 阈值收紧+后移：灰区从 (-2,8) 改为 (1,6)
  '灰区收紧后移': /GRAY_HIGH = 6/.test(fs.readFileSync(root + '/lib/modes.js', 'utf8')) && /GRAY_LOW = 3/.test(fs.readFileSync(root + '/lib/modes.js', 'utf8')),
  '已知N个问题强负信号': /已知N个问题/.test(fs.readFileSync(root + '/lib/modes.js', 'utf8')),
  'quick 可升级(coding)': /escalate-auto-upgrade/.test(src),
  // ★ 2026-11-08 模式判决微调
  '对比归 consult': /优缺点\|对比\|方案对比/.test(fs.readFileSync(root + '/lib/modes.js', 'utf8')),
  // ★ 2026-11-08 工具作用域：fr_* 只对快速反应会话可见
  'fr_* 按 agent scope 注册': /function registerFrToolsTo/.test(src) && /tools\.register\(def\)/.test(src),
  // ★ 2026-11-08 全局入口工具（任何会话可用）
  '全局工具 fr_task': /globalRegister\(\{[\s\S]{0,300}TN\('fr_task'\)/.test(src),
  '全局工具 fr_status': /globalRegister\(\{[\s\S]{0,300}TN\('fr_status'\)/.test(src),
  '全局工具 fr_brake': /globalRegister\(\{[\s\S]{0,300}TN\('fr_brake'\)/.test(src),
  'fr_task 支持组寻址': /group: \{ type: 'string', description: '精确投递到某个会话组/.test(src),
  'fr_task 支持模式指定': /mode_strict: \{/.test(src) && /enum: \['auto', 'quick', 'consult', 'retrieval', 'review', 'coding'\]/.test(src),
  'scope 跳过 fr_status': /if \(nm === TN\('fr_status'\)\) continue/.test(src),
  'fr 工具不进全局': /const FR_TOOL_DEFS = \[\]/.test(src) && /FR_TOOL_DEFS\.push\(def\)/.test(src),
  'scope 注册在 restrict 之前': (() => { const a = src.indexOf('registerFrToolsTo(ag, role)'); const b = src.indexOf('tools.restrict({ allow })'); return a > 0 && b > 0 && a < b })(),
  '强信号放宽前缀': /并发可读写|支持\|可\|实现\|保证/.test(fs.readFileSync(root + '/lib/modes.js', 'utf8')) || /崩溃可恢复/.test(fs.readFileSync(root + '/lib/modes.js', 'utf8')),
  'quick 上交不被拒': !/当前模式「\$\{mi\.label\}」不需要后台：请自己完成并交付/.test(src) || /escalate-auto-upgrade/.test(src),
  '共识协议拆分': /共识协议实现/.test(fs.readFileSync(root + '/lib/modes.js', 'utf8')),
  'coding 覆盖通用分诊': /覆盖上式/.test(fs.readFileSync(root + '/lib/modes.js', 'utf8')),
  'coding 执行层督促': /must-escalate-nudge/.test(src),
  'esc 时间戳记录': /lastEscalateAt = Date\.now\(\)/.test(src),
  'esc 时间戳重置': /autoUpgradedThisTask = false; lastEscalateAt = 0/.test(src),
  '分诊穿透 quick 守卫': /BYPASS = new Set\('manual', 'triage', 'auto-upgrade'\)/i.test(src) || /'triage', 'auto-upgrade'/.test(src),
  // ★ 2026-11-07 冷却策略重写（45s 固定冷却把后台 87% 时间耗在空等）
  '缺口驱动冷却函数存在': /function prefetchCooldownFor/.test(src),
  '缺口冷却 ≤3s': /if\s*\(gap\)\s*return\s*2000/.test(src),
  '三处冷却都用新函数': (src.match(/prefetchCooldownFor\(/g) || []).length >= 3,
  '缺口不再被 hasDeliver 挡住': /!hasDeliver\(\)\s*\|\|\s*gapNow/.test(src),
  '新任务打断后台': /back-cancelled/.test(src),
  'defaults 冷却已降': !/prefetchCooldownMs:\s*45000/.test(fs.readFileSync(root + '/lib/defaults.js', 'utf8')),
  'briefs 产到水位': /产到水位再停/.test(fs.readFileSync(root + '/lib/briefs.js', 'utf8')),
  // ★ 2026-11-07 三个遗留问题修复
  // ① modeLocked 不该禁"任务重置"（重置必须无条件，判型才受锁定控制）
  '任务重置不受 modeLocked 影响': (() => {
    // 直接找"非注释"的 `if (a === front) { resetTaskScheduler... }`，
    // 这段必须**不**位于 `if (cfg.modeAuto !== false && !cfg.modeLocked` 的块内。
    const lines = src.split('\n').filter(l => !/^\s*(?:\/\/|\*)/.test(l))
    const code = lines.join('\n')
    // 找到独占一行的 resetTaskScheduler 调用（我改成的形式）
    const m = code.match(/if\s*\(a === front\)\s*\{\s*try\s*\{[^}]*resetTaskScheduler\(\)/)
    return !!m
  })(),
  // ② 里程碑单调性（防"永远补不完"）
  '里程碑不许外扩': /milestone-inflation-blocked/.test(src),
  '里程碑截断在 lines 之前': (() => {
    const i = src.indexOf('function renderRoute')
    if (i < 0) return false
    // 用全文件行号比较，避免切片窗口被新增代码挤出
    const seg = src.slice(i)
    const inflIdx = seg.indexOf('milestone-inflation-blocked')
    const pushIdx = seg.indexOf("lines.push('## 里程碑')")
    return inflIdx >= 0 && pushIdx >= 0 && inflIdx < pushIdx
  })(),
  // ③ 新任务清场（steps/route/state）
  '新任务清 steps': /task-cleared/.test(src),
  '新任务清 route': /route\.\$\{Date\.now\(\)\}\.md/.test(src),
  // ★ 2026-11-07 改法 A+B：催补即时化 + 补步优先
  'turn-stopping 缺口时不等后台空闲': /const shouldWake = \(gapIdle \|\| !backBusy\)/.test(src),
  '补步类 reason 优先 followup': /REPAIR_REASONS/.test(src),
  'need-next 属关键唤醒': /need-next/.test(fs.readFileSync(root + '/lib/policies.js', 'utf8')),
  'prefetch-urgent 属关键唤醒': /prefetch-urgent/.test(fs.readFileSync(root + '/lib/policies.js', 'utf8')),
  'wire() 统一接线': src.includes('const wire = (frontId, backId)'),
  'effort 显式传': src.includes('reasoningEffort: effortFor(tag)'),
  'BOM 已除': !fs.readFileSync(root + '/package.json').slice(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])),
  '预规划（投递后即时）': src.includes("trigger: 'step-delivered'"),
  '无任务不跑哨兵': all.includes('hasActiveTask'),
  'H5 需伴随失败': all.includes('taskStepMax') && all.includes('failStreak >= 2'),
  '同名工具失败才累加': src.includes('lastFailName'),
  '尊重用户走编排': src.includes('verdict-short-overruled'),
  '冻结只调一次': (all.match(/freezeFront\(hits\.map/g) || []).length === 1,
  '终局正文兜底': src.includes('final-answer-ask'),
  '新路线重置 done': src.includes('state-reset'),
  'wiring 健康度字段': api.includes("state,") && api.includes('frontMatched'),
  'policy 语义正确': api.includes('if (r && r.error) return fail(res, 404'),
  '面板显示自愈中': page.includes("自愈中…"),
  '不渲染 chat.back': !/chat\.back \|\| \[\]\)\.forEach/.test(page),
  // ★ 2026-11-07 第三轮优化（五项改动）的守卫
  'fr_route 有 mode 参数': /enum: \['plan', 'append'\]/.test(src),
  'append 模式不覆写 route': /mode === 'append' && existsSync\(P\.route\)/.test(src),
  'append 跳过已有步骤': /existingSteps\.has/.test(src),
  'plan 跳过已完成步骤': /doneNow > 0 && k <= doneNow/.test(src),
  'append 不清 steps': /if \(wrote && !isAppend\)/.test(src),
  '缺口判据用盘上总数': /totalOnDisk/.test(src),
  '任务原文落盘': /task-saved/.test(src),
  '交接包已瘦身（newGoal 字段消失）': !/args\.known|args\.tried|args\.stuck/.test(src),
  '交接包有 files 字段': /files: \{[\s\S]{0,120}type: 'array'/.test(src),
  '催补判据已合并': !/haveFromNext/.test(src),
  '断粮用 starvation 事件': /need-next-starvation/.test(src),
  'P1 已删除（无 parHint）': !/parHint/.test(src),
  'schema 无 group 字段': !/group: \{ type: 'string', description: '可选：并行组名/.test(src),
  '哨兵拒绝预存文件': /sentinel-rejected/.test(src),
  '哨兵记录了拒绝原因': (() => {
    const rp = fs.readFileSync(root + '/lib/route-plan.js', 'utf8')
    return /already-exists/.test(rp) && /already-absent/.test(rp) && /sentinel-rejected/.test(src)
  })(),
  'isAbsolute 已导入': /import .*isAbsolute.* from 'node:path'/.test(src),
  // ★ 2026-11-07 判型优化（基于 5 轮实测：单文件/小规格走编排纯亏）
  '判型：shouldOrchestrate 存在': /export function shouldOrchestrate/.test(fs.readFileSync(root + '/lib/modes.js', 'utf8')),
  '判型：编排判据在 fsOpIntent 之前': (() => {
    const i = mods.indexOf('export function detectMode')
    if (i < 0) return false
    const seg = mods.slice(i)
    const orch = seg.indexOf('shouldOrchestrate(t)')
    const fsop = seg.indexOf("if (fsOpIntent && !onlyScoped) return 'coding'")
    return orch >= 0 && fsop >= 0 && orch < fsop
  })(),
  '判型：不需要编排时降级 quick': /orchestration\.orchestrate \? 'coding' : 'quick'/.test(mods),
  '判型：系统设计信号存在': /WAL\|write-ahead/.test(mods) && /事务隔离/.test(mods),
  // ★ 2026-11-08 记录文件治理（实测：插件对这些文件名引用 0 次，纯浪费 50-60s/任务）
  'briefs 禁止前台写记录文件': /禁止要求前台写/.test(fs.readFileSync(root + '/lib/briefs.js', 'utf8')),
  'briefs 允许后台读代码': /想看进度就直接读代码/.test(fs.readFileSync(root + '/lib/briefs.js', 'utf8')),
  '唤醒消息允许读代码': /可以（且鼓励）只读看代码/.test(src),
  '唤醒消息禁止记录文件': /不要要求前台写记录类文件/.test(src),
}
const codeFail = Object.entries(codeChecks).filter(([, v]) => !v)
results.push({ label: `代码修复点（${Object.keys(codeChecks).length} 项）`, ok: codeFail.length === 0, detail: codeFail.length ? '缺失: ' + codeFail.map(([k]) => k).join(', ') : '全部存在' })

// 汇总
console.log('\n=== 回归结果 ===')
let fail = 0
for (const r of results) {
  if (!r.ok) fail++
  console.log(`${r.ok ? '✅' : '❌'} ${r.label}  ${r.detail}`)
}
console.log(`\n总计：${results.length - fail} 通过 / ${fail} 失败`)
console.log(fail === 0 ? '\n✅ PASS 全部回归通过' : '\n❌ FAIL 存在失败项')
