# 快反工具面丢失 —— BUG 档案（必须保持修复）

> 记录时间：2026-11-07
> 状态：**已修复并实测通过**（本文件是回归依据，任何改动后必须重跑验证）

---

## 一句话

快反的 `restrict` 工具白名单是**会话级内存态**，会话一旦被 `autoheal` / `rebuildSessions`
重建就整个丢失 ⇒ 前/后台恢复成 **68 个工具**，包含 `dev_*` / `hindsight_*` /
`subagent` / `workflow` / `schedule_*`，与设计（15~17 个官方工作集）严重不符。

**这不是"小瑕疵"**：在不受控工具面上跑 benchmark，测出来的所有数字都不可信。

---

## 症状（怎么认出来）

- `/fr/api/relay` 的 `probe-tools2` 返回 `front: 68, back: 68`
- `events.jsonl` 里 `tool-policy` 很久没有新记录
- 前后台会话 id 变新了，但 `tool-policy-rearm` 没跟上
- 现象具有**欺骗性**：插件一切"正常"（接线 ✓、简报 ✓、能干活 ✓），只是工具面悄悄变宽

---

## 三个真实成因（按发现顺序）

### ① `allowListFor` 忽略 role（递归环 1）

```js
// 错：前/后台拿到同一份表
export function allowListFor (key, role) { return WORK_TOOLS }
```

后果：后台也拿到 `fr_escalate`。而 `fr_escalate` = 写 handoff + `wakeBack('escalate')`
⇒ **后台自己调用就变成后台唤醒后台的死循环**，每轮写 handoff、每轮唤醒自己。

修复：拆成 `WORK_TOOLS_FRONT` / `WORK_TOOLS_BACK`，后台只有 `fr_route` 一条产出通道。

### ② `isFrSession` 只判前缀 ⇒ worker 被认成前/后台（递归环 2）

worker 会话 id = `session-fr-worker-<ts>`，**命中 `session-fr-` 前缀**。
自动发现可能把它当成前台/后台接线 ⇒ 只读 worker 拿到 `fr_escalate` ⇒ 越权唤醒后台。

修复：前缀之后白名单（含 worker 优先排除 + 会话组格式 + 跨实例隔离）：

```js
const rest = id.slice(SESSION_PREFIX.length)
if (/^worker-/.test(rest)) return false
if (TAG === 'a' && /^[b-z]-/.test(rest)) return false
if (/^(front|back)-/.test(rest)) return true
return /^[a-z0-9]{1,8}-(front|back)-/.test(rest)   // 会话组 session-fr-01-front-x
```

### ③ restrict 不随会话重建（本 bug 主体）

`applyMode` 的「同模式去重」分支直接 `return` ⇒ 重建后 `applyToolPolicy` 永不执行。

修复三层：
1. `applyMode` 去重分支里仍调 `reapplyToolPolicyIfNeeded()`
2. `resolveAgents` 末尾调 `reapplyToolPolicyIfNeeded()`
3. **`autoheal` / `rebuildSessions` 的 `mk()` 里，会话一创建就 `attachToolPolicyFor(tag, ag)`**
   —— 这是"窗口归零"的关键，不等下一次 tick

---

## 顺手挖出的两个坑（同样必须保持）

### TDZ 崩溃

`modeDisposers` 原来是第 708 行的 `const`，但重挂函数在 441 行被调用 ⇒
`apply` 抛 `ReferenceError` ⇒ **整个插件不接线**（历史事故同款：loader 显示 absent，
日志却写"接线自愈"）。已把 `modeDisposers` / `policyAgentId` 提到 `resolveAgents` 之前。

### 会话组整组失联（我自己引入又修掉的回归）

第一版白名单写 `^(front|back)-`，把组会话 id `session-fr-01-front-x` **全部排除**。
组会话是**主要使用方式**，这会让整个会话组功能失效。
教训：改身份判定必须同时覆盖所有 id 形态，不能只看默认会话。
`session-fr-b-front-x` 也一度被实例 a 认领（`b-front-x` 恰好符合"组前缀-front"）⇒ 需显式排除 `^[b-z]-`。

---

## 验证方法（改任何相关代码后必跑）

```powershell
# 1) 语法
node --check C:\Users\admin\.dsh\plugins\dsh-fast-react\lib\index.js

# 2) 工具面边界（25 项断言）
node C:\Users\admin\Desktop\快速反应测试-沙箱\verify-recursion.mjs

# 3) 会话身份（17 项，含 worker / 会话组 / 跨实例）
node C:\Users\admin\Desktop\快速反应测试-沙箱\verify-session-id2.mjs

# 4) 运行时实测（必须，前两步过不代表生效）
dev_reload_package dsh-fast-react
# 等 autoheal，然后：
POST http://127.0.0.1:<port>/fr/api/relay {"action":"probe-tools2"}
# 期望：front 17 / back 14
```

**期望值**

| 角色 | 数量 | 工具 |
|---|---|---|
| front | 17 | read write edit glob grep working_directory bash pwsh read_image fr_status fr_mode fr_worker fr_escalate present web_search web_fetch todo_write |
| back | 14 | read write edit glob grep working_directory bash pwsh read_image fr_route present web_search web_fetch todo_write |

**事件证据链**（时序即证明"窗口归零"）：

```
tool-policy-rearm  role=front before=68 after=17   ← 先挂
session-named      front ...                        ← 后命名
autoheal           front/back ...                   ← 最后才写事件
```

如果 `tool-policy-rearm` 出现在 `autoheal` 之后几十秒 ⇒ 窗口又回来了，说明 ③ 的修复被破坏。

---

## 铁律

1. 任何涉及 `attachToolPolicyFor` / `reapplyToolPolicyIfNeeded` / `isFrSession` /
   `WORK_TOOLS_*` 的改动，**必须重跑上面 4 步**，只跑 `node --check` 不算验证。
2. **新增会话创建点**（新的 `svcAgentLoop.create`）必须紧跟一次 `attachToolPolicyFor`，
   否则又是一个窗口。
3. 前后台工具面**绝不允许**出现 `dev_*` / `hindsight_*` / `subagent` / `workflow` /
   `schedule_*` / `create_goal` / `skill`。
4. 后台**绝不**允许出现 `fr_escalate` / `fr_mode` / `fr_worker` / `fr_status`（递归入口）。
5. worker 会话**绝不**允许出现任何 `fr_*`。

---

## 追加：restrict 跨实例残留（工具面自我固化）

### 症状

前台会话工具数卡在 **9**（正常 17），怎么重挂都回不来：

```
tool-policy-rearm  role=front  before=9  after=9  direct=false
```

反复重载、反复 `attachToolPolicyFor` 都是 9。

### 根因（两层）

**① `allow = want ∩ visible` 会自我固化**

`tools.schemas(ag)` 在**已挂过 restrict** 的会话上返回的是"被限制后"的投影。
于是 `want ∩ visible` 把上一次的限制当事实，越收越窄。

**② restrict 是跨插件实例残留的，且无法解除**

`restrict()` 返回的 disposer 绑定在**创建它的那个插件实例**上。
热重载后，旧实例销毁 ⇒ 旧 disposer 跟着失效 ⇒ 新实例**无法释放**旧限制。
所以 `hadRestrict` 判断不出来（实测 `direct: false`），因为新实例的
`modeDisposers[role]` 是 `null`。

结果：`mw63x2cm` 这种会话被永久锁死在 9 个工具，而它又是 `cfg.frontSessionId`，
每次重载都被 `resume` 捡回来当前台。

### 修复（三处配合）

**A. 判据改为"want 里缺什么"**，而不是看核心工具是否存在：

```js
const missingFromVisible = want.filter(n => !visible.has(n))
const looksNarrowed = hadRestrict || missingFromVisible.length > 0
```

（曾试过 `coreSeen < 4` 的判据，失败：before=9 时 `read/write/bash` 都还在，
`coreSeen=7` 依然"健康"，检测不到。少的是 `fr_*`。）

若 `looksNarrowed` ⇒ **直授 `want` 全集**，不与 `visible` 求交。
安全性：`want` 是插件自己维护的固定白名单（不含 `dev_*`/`hindsight_*`/`subagent`），
且 `restrict` 会忽略本会话不存在的名字。

**B. resume 后健康校验**

复活出来的会话若工具数 < 该角色白名单的 80%，判定为"旧实例 restrict 残留"，
`dispose()` 掉并改走新建路径（宁可换 id，也不要一个残废前台）。

**C. 接线后自检（最终兜底）**

`resolveAgents` 接线确定后校验工具数；不达标就 `wire-unhealthy` 事件 + 解除接线，
下一轮 `ensureWiring` 自然换新的。

实测：

```
wire-unhealthy  role=front id=session-fr-front-mw63x2cm got=9 want=17
autoheal        front=session-fr-front-mw65nz0c   ← 自动换新
probe-tools2  → front 17  back 14  ✅
```

### 附带：自动发现不再"取最早两个"

原实现按创建时间**正序**取最早的两个，于是残废会话永远优先被捡回来。
改为：

- 排除可见工具 < 5 的（残废会话不参与接线）
- 按创建时间**倒序**取最新

### 铁律（追加）

6. 判断"会话是否被收窄过"，**只看 `want - visible` 的差集**，不要看核心工具是否存在。
7. `restrict` 的 disposer **不能跨插件实例**复用。任何依赖"之前挂过"的判断在
   重载后都会失效。
8. 会话复用（resume）**必须带健康校验**，否则会把残废会话一代代传下去。
