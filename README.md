<div align="center">

# ⚡ 快速反应 · dsh-fast-react

**vibecoding** · 前台快速执行，后台逐步规划 —— 让两个会话像一条流水线那样干活

[![npm version](https://img.shields.io/npm/v/dsh-fast-react?color=cb3837&label=npm)](https://www.npmjs.com/package/dsh-fast-react)
[![npm downloads](https://img.shields.io/npm/dm/dsh-fast-react?label=downloads)](https://www.npmjs.com/package/dsh-fast-react)
[![version](https://img.shields.io/github/v/release/Ewfrewfaf/dsh-fast-react?label=release&color=blue)](../../releases)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![platform](https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A5%200.2-6f42c1)](#-安装)

[安装](#-安装) · [判型](#-判型引擎) · [模式](#-五种模式) · [工具](#-工具与-api) · [实测数据](#-实测数据) · [架构](./docs/技术路线.md)

</div>

## 它是什么

单会话 Agent 有个绕不开的矛盾：**低档模型快但做长任务会跑偏，高档模型想得清楚但首帧要几十秒。**
快速反应把它拆成两个会话，用一块磁盘黑板缝起来：

```
         你（面板 / HTTP API）
                 │
                 ▼
      ┌──────────────────┐   上交/下发   ┌───────────────────┐
      │ 前台 · 低档 · 快  │ ◀──────────▶ │ 后台 · 高档 · 慢   │
      │ 只执行、只回报    │              │ 只规划、只复核      │
      └────────┬─────────┘              └─────────┬─────────┘
               │       .board/ 黑板（磁盘）        │
               └─────────►  route.md · steps/ · state.md ◄───────┘
                 ▲
                 │ 实时投递 / T3 闸门 / 哨兵 / 僵死看门狗（插件层）
```

- **会话随时会死，黑板永不丢**：任何状态都能从 `.board/` 重建
- **零轮询**：挂在 DSH 的 `agent/turn-stopping` 事件上，下一步在轮末瞬间塞进当前回合
- **破坏性操作有闸门**：`rm -rf`、部署、对外发送默认拦截，需令牌放行
- **卡死自愈**：150s 无输出自动 cancel，没动过手还会安全重投

---

## 🆕 v1.6.1（2026-11-15）

- **修复自动判型死导入**：`detectMode` 此前从未被任务投递路径调用 ⇒ 检索/咨询/审查任务永远停留 quick。现在投递时先认意图（retrieval/consult/review 命中即自动切换），其余落编排判据；`modeLocked`/pin/显式 mode 优先级不变。新增 `tools/test-mode-intent.mjs` 8 例回归。

## 🆕 v1.6.0（2026-11-15）

| 变更 | 说明 |
|---|---|
| **判断点停写** | 步骤可标 `needs: judge`：投出该步后停牌等后台判断；**机械截断**其后依赖步（不靠模型自觉），停牌期间里程碑催补自动暂停，判断解除后恢复 |
| **里程碑复核全局开关** | `milestoneCheck` + `milestoneEvery`：打开后每 N 步强制后台轻量复核前台是否偏航（覆盖各模式 `reviewEvery`；10 分钟节流、每任务 ≤3 次） |
| **后台看前台思维链** | `backSeeFrontThought`：复核/判断唤醒附前台 reasoning 尾部（≤1500 字），助判偏航；默认关 |
| **单配置文件** | `.board/config.json` 启动时补齐全部默认键 = 全量可编辑文件；`modePresets` 可覆写内置模式旋钮；**保存 600ms 后热重载**（AI 可直接改文件） |
| **删组 = 归档可恢复** | 删除会话组改为宿主级 `archiveSession`（侧栏不再留未分组）；归档台账 `groups.archived.json`；弹层「已归档」区单条/全部恢复；组编号计入归档台账防碰撞 |
| **历史未分组清理** | `POST /fr/api/archive-ungrouped` + 弹层「清理未分组」按钮：FR 产生、不在任何组/工作区的历史会话一键归档 |
| **批量操作 loading** | 批量删除/恢复显示玻璃进度条 + spinner + x/y 进度，期间禁用其它操作防叠单 |
| **设置页整改** | 删调试残留开关；按语义重分组；新增「生效指示」条（todo 镜像/apply_patch 预设/拉取/里程碑/判断停牌/上下文压缩 实时状态）；9 个新开关/数值入 UI |
| **发送键修复** | 空闲 = 箭头、运行中 = 停止方块（旧版因 phase 对象误比恒显方块） |
| **可单测化** | 覆写决策 `planOverwriteDecision`、复核判定 `milestoneReviewDue` 抽纯函数；新增 6 套单测，回归守卫 150 项全绿 |

---

## 🎯 判型引擎（v2）

**不再「什么都走编排」。** v1.4 的痛点是：1 个文件的小改动也要叫醒后台规划，白亏 30-60%。

v2 的设计原则：**机械判型只负责「确信」的两端**（零 LLM、瞬时）；不确定的中间地带交给后台分诊（一次 LLM 调用）——「弱命中不裁决」，词表不可靠时不硬判。

```
                    任务文本
                       │
            ┌──────────┴──────────┐
            │ 审查意图预检（只查不改）│──▶ review
            └──────────┬──────────┘
                       ▼
           ┌───────────────────────┐
           │ 四层词表+结构信号（零LLM）│
           └───────────┬───────────┘
                       │
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
  score >= 6      3 < score < 6    score <= 3
       │               │               │
   ┌────────┐     ┌──────────┐    ┌────────┐
   │ coding │     │   灰区   │    │ quick  │
   │ 标准编排│     │先做+分诊 │    │ 自己做 │
   └────────┘     └──────────┘    └────────┘
```

| 层 | 权重 | 条数 | 同层上限 | 示例 |
|---|---|---|---|---|
| **系统设计核心** | +3 | 17 | 3 | WAL、memtable、索引、事务隔离、崩溃恢复、锁/无锁、Raft/选举、分布式、AST |
| **架构设计动作** | +2 | 6 | 3 | 从零设计、架构改造、自主设计、结构性重构、设计模式 |
| **复杂度信号** | +1 | 9 | 4 | 多文件、端到端、调度编排、状态管理、性能工程、鲁棒性 |
| **反面词** | −3（「已知 N 个问题」−6） | 8 | 3 | 已知问题清单、照规格实现、修 bug、单文件、**已知 N 个问题** |

**结构信号**（词表之外）：代码量 ≥350 行 +3 / ≥150 行 +2 / ≤60 行 −1；子模块 ≥4 个 +3 / ≥3 个 +2。
**短问句规则**：短问句且无动作意图、非大规模检索 ⇒ 直接 quick，不进灰区。
**灰区分诊**：落在中间地带时，前台立刻开做，同时并行唤醒后台判断要不要接管 —— 前台不阻塞。

**阈值依据（实测定档）**：灰区从 (−2, 8) 收紧到 (3, 6)。v4 灰区实测 4 轮：L3 score=2 判 quick 正确（24.7s 快于单 Agent 39.7s）；L4 score=6 该判 coding；分诊 4 次唤醒仅 1 次真正产出 ⇒ 灰区越宽越亏，故做窄并上抬。

### 两层解耦（v1.6）

- **L1 模式**（quick/consult/retrieval/review/coding/自定义）决定「谁干」：后台参不参与、写不写步骤
- **L2 执行策略**（research/think/build/deliver）决定「怎么干」：并行度/思考强度/自治度/交付物；**切 L2 不翻 L1**
- `orchestration=auto/fixed`：编排自决 vs 调用方固定；`enablePhases` 为阶段流水线回滚闸（默认关）
- `planningDegrade`：前台断粮超 `degradeAfterMs` ⇒ 后台改粗粒度规划换速度，恢复供料自动复原

---

## 🎛 模式（5 内置 + 自定义）

| 模式 | 后台 | 前台强度 | 产出 | 用途 |
|---|---|---|---|---|
| `quick` | ❌ | `off` | 直接答/改 | 问答、小改动 |
| `consult` | ✅ 只分析 | `low` | `analysis.md` | 深度分析 |
| `retrieval` | ❌ | `low` | 检索结果 | 并行查资料 |
| `review` | ✅ | **`high`** | `review.md` | 代码审查（只读不改） |
| `coding` | ✅ 写步骤 | `low` | 代码 + `deliver` | 标准编排 |

**为什么 quick 关掉思考？** 小改动不需要推理。深度思考放在真正需要的地方：`coding` 由后台（`max` 档）承担，`review` 前台自己用 `high`。

**自定义模式**：设置页「＋ 自定义」可建模式（后台/写步骤/首句回执/预取/查资料/审 diff/步长/复核间隔/扇形数/前台强度全开放）；`config.json` 的 `modePresets` 还能覆写内置模式旋钮，保存即热重载。

---

## 📊 实测数据

L1-L5 代码任务，每题跑机器验收（`check.mjs`），DeepSeek V4.1 Flash，同模型对比。**注：以下为 v1.4 期基线数据**（判型 v2 阈值与两层解耦为其后改动，趋势结论仍适用，精确数字不作当前基线）。

| 档 | 任务 | 单 Agent | 判型后 | 判定 | 工具（单/后） |
|---|---|---|---|---|---|
| L1 | 单函数 11 行 | 12.1s | **8.4s** | quick | 5 / 4 |
| L2 | 单文件 27 行 | 21.3s | **10.0s** | quick | 8 / 4 |
| L3 | 3 文件 33 行 | 39.7s | **29.8s** | quick | 14 / 14 |
| L4 | 单文件 45 行 | **44.3s** | 63.6s | quick | 12 / 17 |
| L5 | 4 文件系统级 | 141.2s | **68.6s** | coding | 49 / 26 |

**轮次**：单 Agent 5 轮/档，判型后 3-5 轮/档。**验收：判型后 10/10 通过，单 Agent 23/24。**

### 结论

- **小任务（L1/L2）快 30-53%** —— 不再白跑一遍编排，工具也更少
- **L3 快 25%** —— 同样判 quick，但比单 Agent 稳定
- **L4 慢 44%** —— 反例。"单文件但复杂"这类任务，编排与自做差不多，判型偏保守
- **L5 快 51%** —— 编排价值成立，工具从 49 降到 26

### 必须说明的数据问题

**L3 与 L5 的方差很大。**

| 档 | 各轮 | 说明 |
|---|---|---|
| L3 | 143 / 89 / 30 / 30 / 25s | 有一轮前台跑偏（71 个工具、143 秒），非判型问题 |
| L5 | 73 / 69 / 51s | 相对稳定 |

轮次少（3-5 轮），中位数只能看趋势，**不能当作精确基线**。

---

## 📦 安装

```bash
# npm
dsh plugin --profile <profile> add dsh-fast-react

# 或离线 tgz（从 Release 下载）
dsh plugin --profile <profile> add ./dsh-fast-react-1.6.0.tgz
```

**装完必须重启一次 DSH** —— `package.json` 里的 icon / locale / client 只在启动时扫描，不重启侧边栏不出现、图标不显示。

打开控制台：侧边栏「快速反应」行，或 `http://127.0.0.1:<端口>/fr`（端口每次重启都可能变）。

### 环境要求

| 项 | 要求 |
|---|---|
| DeepSeek Harness | ≥ 0.2.2-rc.1 |
| Node.js | ≥ 20 |
| 模型 | 任意可用 provider（面板内可切换） |

### 开发者：从源码链接

profile 的 `package.json` 里加：

```json
{
  "dependencies": { "dsh-fast-react": "link:C:/path/to/dsh-fast-react" },
  "dsh": { "profile": { "bundles": ["...", "dsh-fast-react"] } }
}
```

改 `lib/ui/*` 不用重启（实时读盘）；改 `lib/index.js` 需重载插件，**任务运行中别重载**。

---

## 🚀 五分钟上手

1. 打开面板 → 右上 **启动**（前后台自动接线，首次会创建两个会话）
2. 输入任务 → `Enter` 发送
3. 简单任务前台自己干完；复杂任务前台上交后台，后台写出 `steps/S1.md` 后自动推进
4. 想插话随时发：
   - 开关**关**（默认）→ 消息排队，当前这步结束才处理
   - 开关**开（发送即打断）**→ 先 cancel 当前生成，立刻处理你的新消息

| 控件 | 作用 |
|---|---|
| 启动 / 停止 | 启用/暂停整套编排（T3 拦截、实时投递、巡检）。**不销毁会话** |
| ⊞ 会话组 | `FR-01…` 新建 / 收编当前 / 删除(=归档) / 切换 / 自愈 / 清理未分组；每组独立权限；已归档区可恢复 |
| 生效指示 | 设置页实时显示 todo 镜像 / apply_patch 预设 / 拉取 / 里程碑复核 / 判断停牌 / 上下文压缩 的开关与实际生效状态 |
| ⚙ 技术面板 | 进度、步骤、路线检查、效率指标、唤醒分布、事件流 |
| 模型 ▾ | 切换前后台模型 |
| 发送即打断 | 见上 |

---

## 🧩 会话组（推荐）

- 编号 `FR-01 / FR-02 …` **由服务端生成，界面不可改**（客户端传 `key` 会被忽略）
- 每组 = 前台 `FR-0x·F` + 后台 `FR-0x·B`，全部 attach + pin 到「快速反应」工作区 ⇒ **DSH 侧边栏可直接打开原生会话页**
- **收编当前**：把已在跑的前后台登记成组，不新建会话
- **自愈**：编号重排、丢失会话重建、工作区重挂、权限重应用
- **删除 = 归档**：v1.6 起删组不再留下未分组会话——宿主级归档、台账留痕，弹层「已归档」区可单条/全部恢复；「清理未分组」一键归档历史遗留
- **权限**：每组一个下拉（`read-only` / `workspace-write` / `danger-full-access` / `auto`），
  立即写入沙箱模式 + 审批策略（复用 DSH `permissionPresets`）——**不用再盯着会话点“允许”**
- 权限被拒时前台会回一行 `【上报·权限】缺 …` 并停下，不会无声重试

---

## 🔌 HTTP API

Base：`http://127.0.0.1:<端口>`，`Content-Type: application/json`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/fr` | 控制台页面 |
| GET | `/fr/api/status` | 全量状态 |
| POST | `/fr/api/task` | 发任务 `{text, mode?, mode_strict?, group?, role?, interrupt?}` |
| POST | `/fr/api/brake` | 刹车 `{scope, reason?}` |
| POST | `/fr/api/start` `/stop` `/rebuild` | 启动 / 停止 / 重建会话 |
| GET/POST | `/fr/api/groups` | 会话组：create/switch/policy/delete/**restore** |
| POST | `/fr/api/archive-ungrouped` | 历史未分组 FR 会话一键归档（v1.6） |
| GET/POST | `/fr/api/config` | 读/写运行配置（白名单键，v1.6 起含 modePresets/milestoneCheck 等） |
| GET/POST | `/fr/api/mode` | 读/切协作模式 |
| GET | `/fr/api/models` · POST `/fr/api/model` | 模型清单 / 切换前后台模型 |
| POST | `/fr/api/confirm` | T3 破坏性操作批准/拒绝 |
| GET | `/fr/api/events?since=&limit=` | 事件增量 |

```bash
# 发任务（排队）
curl -X POST localhost:19387/fr/api/task -H 'content-type: application/json'   -d '{"text":"把 README 的示例命令跑一遍","mode":"coding"}'

# 刹车
curl -X POST localhost:19387/fr/api/brake -H 'content-type: application/json'   -d '{"scope":"all","reason":"手动停"}'
```

---

## 🧰 工具与 API

### 全局工具（任意会话可调）

| 工具 | 参数 | 用途 |
|---|---|---|
| `fr_task` | `text`, `mode?`, `mode_strict?`, `group?`, `sessionId?`, `role?`, `interrupt?` | 投递任务，四级寻址 |
| `fr_status` | `detail?`, `group?` | 查状态 |
| `fr_brake` | `scope`, `reason?` | 刹车（不停插件） |

```js
// 投给会话组前台
fr_task({ text: "修一下这个 bug", group: "FR-123", mode: "coding" })
```

### 内部工具（仅快速反应会话可见）

按 agent scope 注册，普通会话看不到：

| 工具 | 角色 | 作用 |
|---|---|---|
| `fr_escalate` | 前台专属 | 上交任务 |
| `fr_route` | 后台专属 | 提交路线（plan/append） |
| `fr_mode` | 前台 | 声明/切换模式 |
| `fr_worker` | 前台 | 派只读检索 worker |

> `fr_escalate` 给后台会导致「后台上交给自己 → 无限递归」（真实事故）；
> `fr_route` 给前台等于自当规划者，双会话架构就没了。

**HTTP 与工具的分工**：HTTP 给外部程序（端口每次重启变、失败只看到超时）；工具给 DSH 内的 Agent（不依赖端口、错误结构化）。

---

## 🗂 黑板与文件

```
<工作目录>/.board/
├── config.json      # 运行配置
├── groups.json      # 会话组（FR-0x → sessionId + preset）
├── groups.archived.json  # 归档组台账（v1.6，删组留痕可恢复）
├── state.md         # planVersion / status / done
├── route.md         # 后台路线（含「## 里程碑」「## 哨兵条件」）
├── steps/S1.md…     # 步骤（前台自取）
├── handoff.md       # 前台上交
├── confirm/         # T3 放行令牌 S<k>.ok
├── heartbeat.log    # 工具执行流水
└── events.jsonl     # 全部事件（排障第一现场）
```

---

## 🛠 排障

| 症状 | 先看 | 处理 |
|---|---|---|
| 面板没反应 | `status.front` 是否 null | 点「启动」 |
| 发了消息没动作 | `phase` / `config.enabled` | 开「发送即打断」重发 |
| 长时间空白 | `stall` + `heartbeat.log` 末行 | 看门狗会 cancel；仍不动就「停止」再「启动」 |
| 卡在确认 | `.board/confirm/` + 琥珀色通知 | 写 `<step>.ok` 放行 |
| 权限被拒 | 权限 chip / 组权限下拉 | 改 `danger-full-access` |
| 侧边栏没会话 | 会话组状态点 `missing` | 点「自愈」 |
| 改 UI 不生效 | Console 有无 `/fr/sidebar.js` 请求 | 重启一次 DSH |

---

## ❓ FAQ

| 问题 | 答案 |
|---|---|
| **首帧为什么 30-60 秒？** | 后台是高档次模型在写 route + steps；前台仍是秒级响应 |
| **热重载会怎样？** | 会话是内存态，重载=销毁（排队消息一起没）。任务运行中别重载 |
| **判型阈值能调吗？** | 能。`lib/modes.js` 的 `GRAY_HIGH` / `GRAY_LOW`，改完重载生效 |
| **判错了怎么办？** | 三层兜底：①前台主动上交自动升级 ②跑满 25 个工具自动升级 ③`fr_task({mode, mode_strict})` 手动指定 |
| **为什么 quick 关掉思考？** | 小改动不需要推理，实测 L1 从 12.1s 降到 6.4s。深度思考交给 `coding`（后台 max）和 `review`（前台 high） |
| **侧边栏没有「快速反应」？** | 必须重启一次 DSH。`dsh.client` 只在启动时扫描 |
| **管理页不显示图标/介绍？** | 介绍看 `locale/zh.json` 的 `meta.description`；图标看 `package.json` 的 `icon`（**必须相对路径**，data URL 会报错） |
| **和记忆/审计插件冲突吗？** | 不冲突。互不依赖，也不改 DSH 的 DOM 与全局配置 |
| **面板会盖住右下角挂件吗？** | 会。面板按原生会话区矩形整体覆盖，这是当前取舍 |
| **改配置要重启吗？** | v1.6 起不用：`.board/config.json` 保存 600ms 后热重载（含 modePresets/自定义模式）；改 `lib/index.js` 才需重载/重启 |
| **删掉的会话组能找回吗？** | 能。v1.6 删组=宿主级归档，弹层「已归档」区单条/全部恢复；历史未分组用「清理未分组」归档 |

---

## 🧭 目录结构

```
dsh-fast-react/
├── package.json        # bundle / client / console / icon / locale
├── icon.svg            # 管理页图标
├── locale/             # 管理页标题与介绍（zh/en）
├── lib/
│   ├── index.js        # 装配层 + 状态机（文件头有区块地图）
│   ├── api.js          # HTTP 路由
│   ├── client.js       # 浏览器侧（侧边栏 + 控制台挂载）
│   ├── modes.js        # 五种模式 + 自定义模式 + 判型引擎
│   ├── defaults.js     # 全量默认配置（单配置文件补齐源）
│   ├── briefs.js       # 前后台简报（含判断点停写约束）
│   ├── policies.js     # 唤醒/打断策略
│   ├── sentinel.js     # 哨兵解析与求值（纯函数，可单测）
│   ├── route-plan.js   # 路线校验 / 里程碑截断 / 哨兵预检 / 覆写决策（纯函数）
│   ├── scheduler.js    # 调度核心（批量 / 水位 / 归档守卫 / 复核判定纯函数）
│   ├── board.js        # 黑板 IO
│   └── ui/             # 控制台页面 + 侧边栏注入
├── docs/               # 技术路线 / 使用须知 / 移植指南
└── tools/              # 自检 / 回归 / 单测 / 重启后冒烟
```

下沉到独立文件的逻辑都有单测：`test-sentinel` / `test-route-plan` / `test-custom` / `test-phases` / `test-degrade` / `test-handback` / `test-overwrite` / `test-milestone`（共 88 例）；`node tools/regression.mjs` 150 项守卫全绿；重启后活体验收 `node tools/post-restart-smoke.mjs --roundtrip`。

---

## 📄 License

MIT © 2026 — 见 [LICENSE](./LICENSE)




