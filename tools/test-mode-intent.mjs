// 意图判型回归（1.6.1）：detectMode 必须能认出 retrieval/consult/review（此前死导入导致从不自动切换）
import { detectMode } from '../lib/modes.js'
let pass = 0, fail = 0
const t = (name, got, want) => { if (got === want) pass++; else { fail++; console.log(`FAIL ${name}: got=${got} want=${want}`) } }

t('网上搜索事件 ⇒ retrieval', detectMode('帮我去网上搜一下昨天晚上DeepSeek网页端崩溃的事件，请范围搜索'), 'retrieval')
t('搜集资料 ⇒ retrieval', detectMode('搜集一下近三个月的开源语音克隆模型资料，汇总成清单'), 'retrieval')
t('方案对比 ⇒ consult', detectMode('这两个方案哪个好，优缺点对比一下'), 'consult')
t('纯问答 ⇒ consult', detectMode('解释一下什么是 WAL，为什么需要它'), 'consult')
t('只查不改 ⇒ review', detectMode('审查一下这段代码有没有隐患，不要修改'), 'review')
t('系统设计 ⇒ coding', detectMode('从零实现一个基于 WAL 的 KV 存储引擎，支持并发安全与崩溃恢复，带二级索引'), 'coding')
t('修 bug ⇒ quick', detectMode('修一下这个 bug'), 'quick')
// 纯问答按设计归 consult（modes.js 注释：含"解释/说明/什么是"等纯问答）；问候短句才 quick
t('纯问答 ⇒ consult', detectMode('今天天气怎么样'), 'consult')
t('问候短句子 ⇒ quick', detectMode('你好'), 'quick')

console.log(`mode-intent: ${pass}/${pass + fail} pass`)
process.exit(fail ? 1 : 0)
