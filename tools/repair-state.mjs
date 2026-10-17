// 手工修复：把卡住的黑板进度重置为首步，让投递逻辑重新认领 S1
import fs from 'node:fs'
const board = 'C:/Users/admin/Desktop/FastReact/.board'
const statePath = board + '/state.md'
const before = fs.readFileSync(statePath, 'utf8')
const after = `planVersion: 0
status: working
done: S0
assumesMatch: yes
routeOk: yes
goal: 调研 DeepSeek V4.1 flash 1017 的信息（版本/发布状态/能力/价格），产出可交付结论
updated: ${new Date().toISOString()}
`
fs.writeFileSync(statePath, after, 'utf8')
// 清 seenSteps 落盘（若有）：插件重启后按目录重新认领
console.log('state.md 重置完成\n--- 之前 ---\n' + before.slice(0, 200) + '\n--- 之后 ---\n' + after)
