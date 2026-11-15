// 自定义模式 ground-truth：sanitize / setCustomModes / modeInfo / MODE_KEYS / modeNotice
import assert from 'node:assert'
import { sanitizeCustomMode, setCustomModes, customModeKeys, modeInfo, MODE_KEYS, modeNotice } from '../lib/modes.js'

let pass = 0, fail = 0
function t (name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name) }
  catch (e) { fail++; console.log('  ❌ ' + name + ': ' + e.message) }
}

t('非法 key 拒绝', () => {
  assert.strictEqual(sanitizeCustomMode('Bad Key', {}), null)
  assert.strictEqual(sanitizeCustomMode('1abc', {}), null)
  assert.strictEqual(sanitizeCustomMode('quick', {}), null) // 与内置冲突
})
t('合法 key + 默认值 + clamp', () => {
  const p = sanitizeCustomMode('my-mode', { label: '我的', batchSteps: 99, fanout: -3, frontEffort: 'bogus' })
  assert.strictEqual(p.key, 'my-mode')
  assert.strictEqual(p.label, '我的')
  assert.strictEqual(p.batchSteps, 8)
  assert.strictEqual(p.fanout, 0)
  assert.strictEqual(p.frontEffort, undefined)
  assert.strictEqual(p.backend, true)
  assert.strictEqual(p.custom, true)
})
t('setCustomModes 注册 + MODE_KEYS 含自定义', () => {
  setCustomModes({ 'my-mode': { label: '我的' }, 'bad key': {} })
  assert.deepStrictEqual(customModeKeys(), ['my-mode'])
  assert.ok(MODE_KEYS.includes('my-mode'))
  assert.ok(MODE_KEYS.includes('coding'))
})
t('modeInfo 解析自定义', () => {
  const p = modeInfo('my-mode')
  assert.strictEqual(p.key, 'my-mode')
  assert.strictEqual(p.custom, true)
})
t('modeNotice 自定义含编排说明', () => {
  const txt = modeNotice('my-mode', {})
  assert.ok(txt.includes('我的'))
  assert.ok(txt.includes('后台负责写路线与步骤'))
})
t('清空注册表恢复内置', () => {
  setCustomModes({})
  assert.deepStrictEqual(customModeKeys(), [])
  assert.ok(!MODE_KEYS.includes('my-mode'))
  assert.strictEqual(modeInfo('my-mode').key, 'coding') // 回落默认
})

console.log(`\n=== 自定义模式：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
