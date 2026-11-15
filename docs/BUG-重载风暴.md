# 快反「重载风暴」—— 会话/工作区无限膨胀 BUG 档案

> 记录时间：2026-11-07
> 状态：**已修复并实测通过**
> 关联：[BUG-工具面丢失.md](./BUG-工具面丢失.md)（同一批修复，根因相邻）

---

## 症状（用户视角）

侧边栏里出现**多个都叫「快速反应」的工作区**，每个下面挂着几十上百个会话。

实测数据：

| 工作区路径 | 会话引用数 | 说明 |
|---|---|---|
| `Desktop\FastReact` | **163** | 当前在用 |
| `Desktop\FastReact-b` | 21 | 多实例测试残留 |
| `~\.dsh\fast-react` | 10 | 改默认 boardRoot 那次残留 |

而实际存活的会话只有 **3 个**。也就是说 190+ 条是死引用。

---

## 根因（三层，缺一不可）

### ① 插件热重载会销毁**内存**会话，但不会销毁**磁盘日志**

`agentLoop` 创建的会话是**内存态**。插件被热重载（`dev_reload_package`）后：

- `ctx.agents` 里查不到旧会话（内存已销毁）
- 但 `~/.dsh/sessions/--C-Users-admin-Desktop-FastReact--/` 下的日志**还在**
  （实测已堆积 **521 个** `session-fr-*` 日志）

于是插件认为"接线没了"，必须重建。

### ② 重建时**总是生成新 id**，从不复用

原 `ensureWiring` 的 `mk()` 只有一条路：

```js
svcAgentLoop.create('session-fr-front-' + Date.now().toString(36), ...)
```

每次重载 ⇒ 2 个新会话 ⇒ 挂进工作区。**7 次重载 = 14 个会话**。

### ③ `linkSession` 只增不减

工作区引用只 `attachSession`，永不 `detachSession`
（`detachSession` 只在 `deleteGroup` 里被调用）。

⇒ 每次新会话都往上叠，163 条就是这么来的。

---

## 修复

### 根治 ②：改成**优先 resume 旧会话**

`agentLoop.resume(ctx, { resumeSessionId: 旧id })` 能用**同一个 sessionId** 复活会话
（实测：resume 后 `id` 完全不变，且重新出现在 `ctx.agents` 列表中）。

关键难点：**resume 必须在"判脏"之前**。

原时序是致命的：

```
resolveAgents 判脏 → wire-dirty-drop → wire-cleared → cfg.frontSessionId 被清空
                                                    ↓
                        ensureWiring 再想 resume 时，旧 id 已经没了 → 只能新建
```

所以加了 `pendingRevive`：

```js
// 判脏之前先登记，不立即清空 cfg
pendingRevive.front = wantedF
// ensureWiring 消费：
mk('front', pendingRevive.front || cfg.frontSessionId)
```

`mk()` 内部顺序：**先 resume → 失败才 create**。resume 出来的会话同样立刻挂工具面。

### 根治 ③：`linkSession` 顺手清理死引用

```js
async function linkSession (sid, pin) {
  ...attach...
  await pruneDeadWorkspaceRefs(ws)   // 每次挂新会话时清一遍
}
```

`pruneDeadWorkspaceRefs` 只摘「`ctx.agents.get(id)` 查不到」的引用，
**保留当前接线和一切活会话**（含别的组的）。节流 60s，引用 ≤4 时跳过。
事件：`workspace-prune`。

### 附带：区分「会话真没了」和「服务还没就绪」

重载瞬间 `agentLoop` 刚注入、`ctx.agents.list()` 还是空。
原实现会把这时的**有效接线**判成脏数据。

新增判据：

```js
const svcReady = !!(svcAgentLoop && svcPresets)
const listHasAnyone = Array.isArray(list) && list.length > 0
const deferred = (!svcReady || !listHasAnyone) && !!(wantedF || wantedB)
```

暂缓时：不自动发现、不清空接线、不重建（事件 `wire-deferred` / `wire-deferred-cleared`）。

---

## 验证

```
# 重载一次，然后看事件：
wire-revive-queued  role=back id=session-fr-back-mw64k2af
wire-resume         role=back id=session-fr-back-mw64k2af   ← 复活成功，id 不变
autoheal            front=session-fr-front-mw63x2cm back=session-fr-back-mw64k2af
```

**会话总数稳定在 3，工作区引用稳定在 2**（不再随重载增长）。

对比：修复前每次重载 +2 会话，7 次重载堆出 14 个。

---

## 铁律

1. `ensureWiring` / `mk()` **必须先 resume、后 create**。删掉 resume 分支 =
   重载风暴立刻复发。
2. `pendingRevive` 的登记必须**早于** `wire-cleared`。把 resume 挪到 `ensureWiring`
   里面而不改判脏时序 = 无效修复（已经踩过一次）。
3. 任何新增的 `attachSession` 调用点都必须伴随 `pruneDeadWorkspaceRefs`，
   否则工作区引用又会只增不减。
4. `workspace.json` 是 DSH 核心存储。改它之前**必须备份**
   （`~/.dsh/storages/workspace.json.bak-*`），并优先走 `workspaceRegistry` API
   而不是直接改文件。
5. 判「接线是脏数据」之前，必须先排除「服务未就绪」这个可能。

---

## 清理记录（2026-11-07）

| 操作 | 结果 |
|---|---|
| 删除多余工作区注册 | `FastReact-b`(21) / `.dsh\fast-react`(10) 已删 |
| 清 `Desktop\FastReact` 死引用 | 163 → 2（detach 162，0 失败） |
| 清 `.dsh` 死引用 | 5 → 1（保留当前会话） |
| 删除残留会话组 | 23 组全为 DEAD，已删（备份 `groups.json.bak-20261107-160002`） |
| 清板子垃圾 | `_mcp_*.json`×14、Minecraft 坐标 json×5、`mcbuild/`(748KB) |

最终：**1 个「快速反应」工作区**，会话引用 2 条。

---

## 追加：route 污染（同批修复）

### 症状

`POST /fr/api/rebuild` 返回 `provider: "buddy", model: "glm-5.3-flash"`，
但 config 里 `frontProvider/frontModel` 明明是 `deepseek-official/deepseek-flash`。

### 根因

```js
const route = resolveRoute(explicit)   // → cfg.provider/cfg.model（可能是 buddy）
mk(): routeFor(tag)                    // ✅ 会话是对的（优先 frontProvider）
overrides.provider = route.provider    // ❌ 把 buddy 持久化
cfg.provider = route.provider          // ❌ 污染全局
return { provider: route.provider }    // ❌ 返回值谎报
```

三个后果：

1. **返回值谎报**：API 说 buddy、实际跑 deepseek ⇒ 排障被带偏
2. **持久化污染**：`buddy/glm-5.3-flash` 被写进 config.json，之后任何走
   `resolveRoute` 的路径（worker、组会话、ensureWiring 的 base）都拿到 buddy ⇒ **静默换模型**
3. 若全局默认被切到免费模型，会被固化成前后台 base

实测证据：修复前 config.json 里确实躺着 `provider: "buddy"`。

### 修复

- 不再把 `resolveRoute` 的 base 当结果；改为按角色 `effRoute(tag) = routeFor(tag)`
- **只在显式传参时**才持久化（那是用户本轮的明确意图）
- 返回值如实给出 front/back 各自的 provider/model
- 清掉已被污染的 `provider`/`model` 键（备份 `config.json.bak-routefix-*`）

修复后实测：`rebuild` 返回 `deepseek-official/deepseek-flash`，config 不再被写入。

### 守卫

```js
'rebuild 不污染全局路由': !/overrides\.provider\s*=\s*route\.provider/.test(src),
'rebuild 按角色取路由'  : /effRoute\s*=\s*\(tag\)[\s\S]{0,120}routeFor\(tag\)/.test(src),
```

---

## 追加：工具脚本硬编码路径（打包可移植性）

`tools/*.mjs` 里 21 个文件写死了 `C:/Users/admin/...`，打包给别人后一跑就 ENOENT。

修复：新增 `tools/paths.mjs`，解析规则与 `lib/defaults.js` 同源（避免两处漂移）：

| 导出 | 含义 |
|---|---|
| `PLUGIN_ROOT` | 插件包根（`dirname(dirname(__file))`） |
| `boardDir()` | 黑板 `.board` 目录 |
| `boardFile(name)` | 黑板下某文件 |
| `pluginLog()` | 注入器日志 |
| `libFile(name)` | `lib/` 下某文件 |
| `tmpDir(name)` | 临时目录 |
| `desktopDir()` | 桌面（含 fallback） |

`lib/` 本身**没有**硬编码用户路径（只有一处注释说明来历），因此使用者完全不受影响。

守卫：`lib 无硬编码用户路径`、`tools 有 paths.mjs`、`boardRoot 可移植`。

---

## 打包可移植性：黑板落在哪

`boardRoot` 的解析优先级（`lib/defaults.js`）：

| 优先级 | 条件 | 落点 |
|---|---|---|
| ① | `FAST_REACT_BOARD` 环境变量 | 指定路径 |
| ② | `~/Desktop/FastReact` 已有 `.board/config.json` | 沿用老路径（**迁移保护**） |
| ③ | `DSH_HOME` 环境变量 | `$DSH_HOME/fast-react` |
| ④ | 都没有 | `~/.dsh/fast-react` |

⚠️ **② 必须排在 ③ 之前**。`DSH_HOME` 在 DSH 里通常是默认就设好的环境变量，
若让 ③ 压过 ②，老用户会被"凭空搬一次黑板"——而 `boardRoot` 在 `PINNED` 列表里
（盘上不保存），用户无法靠旧 config 自救。这是会丢数据的方向。

验证（`verify-portability`）：本机不改道 / 新机器不落 Desktop / `DSH_HOME` 生效 /
`FAST_REACT_BOARD` 最高优先 / 全部为绝对路径。

打包内容干净：`files: ["lib","docs","tools","cordis.patch.yml","README.md","LICENSE"]`，
**不含** `.board`、会话日志、`config.json`（后者在用户家目录，本就在包外）。
