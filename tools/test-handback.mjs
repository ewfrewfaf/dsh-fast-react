// 失败交回 test 信号 ground-truth：isTestSignal / nextTestFailStreak 纯函数
import assert from 'node:assert'
import { isTestSignal, nextTestFailStreak } from '../lib/modes.js'

let pass = 0, fail = 0
function t (name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name) }
  catch (e) { fail++; console.log('  ❌ ' + name + ': ' + e.message) }
}

t('识别 test 命令', () => {
  assert.strictEqual(isTestSignal('npm test', 'bash', ''), true)
  assert.strictEqual(isTestSignal('npx vitest run', 'bash', ''), true)
  assert.strictEqual(isTestSignal('pytest -q', 'pwsh', ''), true)
  assert.strictEqual(isTestSignal('node check.mjs', 'bash', ''), true)
  assert.strictEqual(isTestSignal('go test ./...', 'bash', ''), true)
})
t('shell+失败输出特征识别', () => {
  assert.strictEqual(isTestSignal('', 'bash', '3 tests failed'), true)
  assert.strictEqual(isTestSignal('', 'pwsh', 'AssertionError: expected 1'), true)
  assert.strictEqual(isTestSignal('', 'bash', 'exit code 1'), true)
})
t('非 test 不误判', () => {
  assert.strictEqual(isTestSignal('ls -la', 'bash', ''), false)
  assert.strictEqual(isTestSignal('npm install', 'bash', ''), false)
  assert.strictEqual(isTestSignal('', 'read', 'FAIL'), false)
  assert.strictEqual(isTestSignal('', 'bash', 'all good'), false)
})
t('计数：成功清零', () => {
  assert.strictEqual(nextTestFailStreak(3, true, true), 0)
})
t('计数：非 test 失败不累积', () => {
  assert.strictEqual(nextTestFailStreak(1, false, false), 1)
})
t('计数：test 失败累积到2触发', () => {
  let s = 0
  s = nextTestFailStreak(s, false, true); assert.strictEqual(s, 1)
  s = nextTestFailStreak(s, false, true); assert.strictEqual(s, 2) // >=2 ⇒ 交回
  s = 0 // 交回后重置
  s = nextTestFailStreak(s, false, true); assert.strictEqual(s, 1) // 不双计
})

console.log(`\n=== 失败交回 test 信号：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
