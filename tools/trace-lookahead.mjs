// 追踪 checkLookahead 的决策路径（用一个探针函数复现判定条件）
const port = process.argv[2] || '4099'
const base = `http://127.0.0.1:${port}`
const fs = await import('node:fs')
const board = 'C:/Users/admin/Desktop/FastReact/.board'
const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const j = async (p) => { try { const r = await fetch(base + p); return await r.json() } catch (e) { return { error: String(e.message) } } }
const stepNo = (s) => parseInt(String(s).replace(/\D/g, ''), 10) || 0

const st = await j('/fr/api/status')
const stateTxt = rd(board + '/state.md')
const doneNo = stepNo((/done\s*:\s*(S\d+)/.exec(stateTxt) || [])[1] || '')
let steps = []
try { steps = fs.readdirSync(board + '/steps').filter(f => /^S\d+\.md$/.test(f)).map(stepNo).sort((a, b) => a - b) } catch {}
const maxNo = steps.length ? Math.max(...steps) : 0
const remain = steps.filter(n => n > doneNo).length

console.log('=== checkLookahead 判定复现 ===')
console.log('doneNo =', doneNo, '| steps =', steps.join(','), '| maxNo =', maxNo)
console.log('remain（未执行步骤数）=', remain)
console.log('front.phase =', st.front && st.front.phase, '→ frontBusy =', st.front && st.front.phase === 'running')
console.log('back.phase  =', st.back && st.back.phase, '→ backBusy =', st.back && st.back.phase === 'running')
console.log('watermark =', 3)
console.log('')

console.log('=== 判定链 ===')
if (!steps.length) console.log('✗ 无步骤 → return')
else {
  const hasDeliver = (() => { try { return fs.readdirSync(board).some(f => /^deliver\.v\d+\.md$/.test(f)) } catch { return false } })()
  console.log('hasDeliver =', hasDeliver, hasDeliver ? '→ ✗ 已交付，return（不会预取！）' : '→ 继续')
  // 里程碑检查
  const routeTxt = rd(board + '/route.md')
  const mseg = routeTxt.match(/^##[^\n]*里程碑[^\n]*$/m)
  let ms = 0
  if (mseg) {
    const seg = routeTxt.slice(mseg.index + mseg[0].length).split(/\n##\s/)[0]
    ms = (seg.match(/^\s*[-*]\s*\*?\*?M\d+/gmi) || []).length
  }
  console.log('里程碑数 =', ms, '| 步骤数 =', steps.length, ms > steps.length ? '→ ✗ 催补步' : '')
  console.log('doneNo >= maxNo ?', doneNo >= maxNo, doneNo >= maxNo ? '→ ✗ 已跑完，预取在其前所以会走' : '')
  const frontBusy = st.front && st.front.phase === 'running'
  const backBusy = st.back && st.back.phase === 'running'
  const willPrefetch = frontBusy && !backBusy && remain <= 3
  console.log('')
  console.log('预取条件 frontBusy && !backBusy && remain<=3 =', willPrefetch)
  if (!willPrefetch) {
    if (!frontBusy) console.log('  ← 原因：前台不忙（空闲时不会预取）')
    if (backBusy) console.log('  ← 原因：后台正在跑')
    if (remain > 3) console.log(`  ← 原因：剩余 ${remain} 步 > 水位 3`)
  }
}

console.log('\n=== 关键结论 ===')
console.log('steps 目录里只有 S1-S4，而 state.done=S4（全部做完）')
console.log('→ 已交付（hasDeliver=true）⇒ checkLookahead 第一行就 return')
console.log('→ 这是正确行为：任务已完成不该再预取')
console.log('')
console.log('真正的 bug 是：后台一次只规划 4 步，前台 40 秒跑完，中间没有预取机会')
console.log('修复方向：route-steps 写入后，立即检查是否需要追加预取，而不是等 tick')
