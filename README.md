# dsh-fast-react

> **快速反应编排插件** —— 让 AI Agent 对突发任务"立刻开干"，而不是先想半天。
>
> 前台低档快答快做 + 后台高档逐条规划，双会话通过**黑板文件**协作；内置独立 Web 控制台与便捷 API。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Zero Build](https://img.shields.io/badge/build-none-brightgreen.svg)](#开发)
[![DSH](https://img.shields.io/badge/DSH-0.2.x-8a2be2.svg)](#安装)

---

## 这是什么

普通 Agent 收到任务后，会用**同一个会话**既规划又执行 —— 规划拖慢了每一次响应。

`dsh-fast-react` 把它拆成两个会话：

| 角色 | 职责 | 特点 |
|---|---|---|
| **前台** | 只执行，不规划 | 响应极短（实测 **1.4–2.6 s**），且随时可被用户打断 |
| **后台** | 只规划，不执行 | 产出结构化步骤 + 路线，可做终局复核 |

两者**不直接对话**，只通过 `.board/` 目录下的黑板文件协作：

```
用户 ──→ 前台 ──(escalate)──→ 后台
          │                     │
          │  ←─ 步骤文件 ────────┘
          │
          └─→ 执行 ─→ state.md / heartbeat.log
```

**已实测收益**（DeepSeek v4.1-flash）：

| 指标 | 数值 |
|---|---|
| 前台单次响应 | **1.4 – 2.6 s** |
| 步间衔接 | **9 ms** |
| 首帧（上交 → 前台开工） | **10.7 s** |
| 消防打断 | **47 ms** |
| 上下文自动压缩 | **−92%** |
| 天然串行任务 vs 单模型 | **快 2.5×** |

---

## 特性

- **双会话编排**：前台执行 / 后台规划，黑板解耦，互不阻塞
- **自动分诊**：轻任务不编排（后台一句话否决），重任务才上交
- **实时投递**：`fs.watch` 监听步骤目录，文件落盘 **~150 ms** 内投给前台
- **结构化路线**：`fr_route` 工具用 JSON Schema 提交路线 + 步骤，格式永不走样
- **规划闭环**：里程碑数与步骤数不一致时自动催单补齐
- **机械哨兵**：`file-exists` / `file-absent` / `field-cmp` / `grep-match` 四类条件，命中即冻结前台 + 作废过时步骤
- **消防通道**：用户随时打断前台（47 ms）
- **按角色压缩**：前台 60k / 后台 60k 独立阈值，DSH 原生压缩作安全网
- **中文 / 零依赖 / 零构建**：手写 ESM，`node --check` 即可验证

---

## 安装

### 方式 A：作为 bundle 安装（推荐）

```bash
# 1. 把本目录放到 DSH 插件目录
#    例：~/.dsh/dsh-fast-react

# 2. 在 profile 的 package.json 里加依赖
#    "dsh-fast-react": "link:<绝对路径>"

# 3. 在 profile 的 dsh.profile.bundles 里加 "dsh-fast-react"

# 4. 重启 DSH
```

### 方式 B：用 dsh-super-injector 热注入（开发时）

```js
// 在 DSH 会话里
dev_inject_plugin({ dir: "<本目录绝对路径>" })
```

安装成功后访问 **`http://127.0.0.1:19387/fr`** 打开控制台。

---

## Web 控制台

独立全页（不是悬浮小窗），打开即用：

| 区域 | 功能 |
|---|---|
| **顶栏** | 前台/后台状态灯 · 任务状态 · **一键启动 / 重建会话 / 停止** |
| **左栏** | 任务输入框 · 提交任务 · 消防打断 · 当前步骤进度条 · 里程碑一致性检查 |
| **中栏** | 效率指标（首帧/投递延迟/上下文占用/压缩记录）· 唤醒分布 · 计数器 |
| **右栏** | 实时事件流（最近 30 条，关键事件高亮）|
| **底栏** | 投递批量 / 前后台上下文限额 / 前台档位 · 保存配置 |

页面每秒轮询 `/fr/api/status`，断线自动恢复。

---

## 便捷 API

所有端点返回 JSON，成功 `{ ok: true, ... }`，失败 `{ ok:false, error }`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/fr` | 控制台页面 |
| `GET` | `/fr/api/status` | 全量状态（页面一次拿全）|
| `POST` | `/fr/api/start` | 一键启动（接线 + 自动修复会话）|
| `POST` | `/fr/api/stop` | 停止（取消正在跑的前后台）|
| `POST` | `/fr/api/rebuild` | 重建前后台会话（用当前默认模型）|
| `POST` | `/fr/api/task` | 提交任务 `{ text }` |
| `POST` | `/fr/api/fire` | 消防打断 `{ reason }` |
| `GET/POST` | `/fr/api/config` | 读 / 改配置（白名单字段，立即生效）|
| `GET` | `/fr/api/events?since=&limit=` | 事件增量 |
| `POST` | `/fr/api/relay` | 通用中继 `{ action, ... }`（`wake` / `steer` / `fire` / `config`）|

### 示例

```bash
# 开跑
curl -X POST http://127.0.0.1:19387/fr/api/start

# 交任务
curl -X POST http://127.0.0.1:19387/fr/api/task \
  -H 'content-type: application/json' \
  -d '{"text":"把 src 下所有 .ts 补上类型标注并逐个 tsc 校验"}'

# 看状态
curl http://127.0.0.1:19387/fr/api/status | jq '.front,.firstFrameMs,.steps'

# 紧急打断
curl -X POST http://127.0.0.1:19387/fr/api/fire \
  -H 'content-type: application/json' -d '{"reason":"方向错了，停"}'
```

---

## 配置

黑板目录下的 `config.json`（不存在则用默认值）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `boardRoot` | `~/Desktop/FastReact` | 黑板根目录 |
| `frontPreset` / `backPreset` | `fast-react-front/-back` | 会话预设名 |
| `frontSessionId` / `backSessionId` | 自动发现 | 钉住的会话 id |
| `enabled` | `true` | 总开关 |
| `batchSteps` | `3` | 一次投递几条步骤 |
| `pullSteps` | `true` | 前台自己读下一步（拉模式）|
| `contextGuard` | `true` | 按角色上下文压缩开关 |
| `frontContextLimit` | `60000` | 前台压缩阈值 |
| `backContextLimit` | `60000` | 后台压缩阈值（**别设太大**，见下方"坑"）|
| `lookahead` | `1` | 前方至少备几条步骤才不催单 |
| `autoHeal` | `true` | 重启后自动重建前后台 |
| `interruptCooldownMs` | `60000` | 消防打断冷却 |
| `interruptMaxPerTask` | `5` | 单任务最多打断次数 |
| `firstFrameTimeoutMs` | `180000` | 首帧超时兜底 |
| `sentinelIntervalMs` | `30000` | 机械哨兵轮询间隔 |

配置修改后可通过 `POST /fr/api/config` 或 `fr_poke {action:"config"}` 立即生效。

---

## 工具（给 Agent 用）

| 工具 | 谁用 | 作用 |
|---|---|---|
| `fr_escalate` | 前台 | 上交任务给后台（自动内联交接包）|
| `fr_route` | 后台 | **结构化提交路线 + 步骤**（JSON Schema 校验）|
| `fr_poke` | 人类/运维 | 手动 `wake` / `steer` / `resolve` / `pin` / `cancel` / `config` / `route` / `fire` |
| `fr_status` | 只读自检 | 返回前后台接线、板面、计数、最近事件 |

`fr_route` 的 schema 保证了格式永不走样：

```js
fr_route({
  goal: "一句话目标",
  acceptance: ["可机器判定的判据1", "判据2"],
  milestones: [{ id: "M1", desc: "补 docstring", step: "S1" }],
  steps: [
    { id: "S1", action: "给 m1.py 加 docstring", accept: "py_compile 通过", assumes: "无" },
    { id: "S2", action: "给 m2.py 加 docstring", accept: "py_compile 通过", assumes: "S1 完成", group: "P1" }
  ],
  sentinels: [{ id: "C1", kind: "file-exists", target: "C:\\work\\REPORT.md" }]
})
```

---

## 目录结构

```
dsh-fast-react/
├── lib/
│   ├── index.js      # 主插件（核心逻辑，~1500 行）
│   ├── api.js        # HTTP API（11 个端点）
│   └── page.js       # 独立控制台页面（全内联 HTML/CSS/JS）
├── cordis.patch.yml  # DSH bundle patch
├── package.json
├── README.md
└── LICENSE
```

**零构建**：`lib/*.js` 就是源码，手写 ESM，直接 `import()` 即可。

---

## 已知的坑（踩过的）

| # | 坑 | 结论 |
|---|---|---|
| 1 | **后台上下文设太大**（如 600k）⇒ 永不压缩，累积到 132k 后首帧从 8s 涨到 23s | 后台保持 **≤60k** |
| 2 | `cancel()` 后立即 `steer/followup` 会抛 `unreachable variant` | cancel 后延迟 ~1s 再唤醒 |
| 3 | `writeAtomic` 先写临时文件 ⇒ `fs.watch` 每次触发两次 | watcher 过滤 `^S\d+\.md$` |
| 4 | 后台会"过度调研"（50 个工具调用才产出 2 步） | 简报里写死「只做 1 件事 + 禁止 pwsh」|
| 5 | 提示词约束对**输出格式**不可靠 | 改用 `fr_route` 工具 + JSON Schema |
| 6 | `record.planVersion` 和步骤数比大小会误报 | 已删（机械哨兵别猜语义）|
| 7 | 热重载时旧实例不 dispose ⇒ 双实例叠加 | 模块级代际守卫 `ACTIVE_GEN` |

---

## 开发

```bash
# 语法检查（无需安装依赖）
node -e "import('file:///ABS/PATH/lib/index.js').then(()=>console.log('OK'))"

# 改了 lib/*.js 后让插件重载（注入器环境）
dev_reload_package { packageName: "dsh-fast-react" }
```

**所有代码零依赖、零构建**，不需要 `npm install`。

---

## 设计原则

1. **一切以效率为准** —— 每加一个机制先算：省的时间 > 花的时间吗？
2. **前台绝不空等** —— 要么在执行，要么在做前置侦察；上交≠停工
3. **黑板是唯一真相** —— 前后台不直接对话，只读写信箱/状态/步骤文件
4. **格式靠代码不靠自觉** —— LLM 会不遵守提示词，但不会违反 JSON Schema
5. **打断只给极少数场景** —— 每次打断都浪费一次生成

---

## License

[MIT](LICENSE)
