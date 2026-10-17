<div align="center">

# ⚡ 快速反应 · dsh-fast-react

**前台低档快答快做，后台高档逐步规划 —— 让两个会话像一条流水线那样干活**

[![AI Project](https://img.shields.io/badge/项目类型-AI%20Project-8957e5?style=for-the-badge)](#-ai-project-项目说明)
[![version](https://img.shields.io/badge/version-1.0.2-blue)](./package.json)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![platform](https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A5%200.2-6f42c1)](#-安装)

[快速开始](#-安装) · [使用指南](#-五分钟上手) · [API](#-http-api) · [架构](./docs/技术路线.md) · [FAQ](#-faq)

</div>

---

> ## 🤖 AI Project 项目说明
>
> **本项目是一个 AI Project（AI 项目）** —— 它运行在 **DeepSeek Harness（DSH）的 Web GUI** 里，
> 形态是「插件 + 浏览器控制台」，**不是独立的桌面应用，也不是可单独打开的网页**。
>
> | 要点 | 说明 |
> |---|---|
> | 🧩 形态 | DSH 插件（host 半 + 浏览器侧 UI），装进 profile 后随 DSH 一起运行 |
> | 🌐 入口 | DSH Web GUI 的侧边栏「快速反应」，或 `http://127.0.0.1:<DSH端口>/fr` |
> | 🖥️ 界面 | 在**浏览器渲染的原生会话区**内工作（iframe 浮层，像素级贴合 DSH 会话区） |
> | ⚙️ 技术栈 | Node.js（插件后端）+ 原生 HTML/CSS/JS（无框架）+ DSH Cordis 服务 |
> | 🚫 不是 | 不是 CLI 工具、不是独立 App、不提供 SaaS 服务、不附带模型额度 |
> | ✅ 前提 | 必须先有一个能正常运行的 DeepSeek Harness，并具备可用模型 provider |
>
> 如果你要的是「装完就能点开用的图形软件」，这个项目不适合；
> 如果你是**在 DSH Web 里干活、需要双会话编排 + 可视化控制台**，那就装它。

---

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

## 📦 安装

### 方式 A：tgz（推荐，离线可用）

```bash
# 1) 下载 Release 里的 dsh-fast-react-1.0.2.tgz
# 2) 装进 profile
dsh plugin --profile <你的 profile> add ./dsh-fast-react-<版本>.tgz
# 3) 重启一次 DSH
```

打开控制台：**侧边栏「插件」下方的「快速反应」**，或直接访问 `http://127.0.0.1:19387/fr`

### 方式 B：从源码链接（开发者）

在 profile 的 `package.json`：

```json
{
  "dependencies": { "dsh-fast-react": "link:C:/path/to/dsh-fast-react" },
  "dsh": { "profile": { "bundles": ["…", "dsh-fast-react"] } }
}
```

> 改 `lib/ui/*` **不用重启**：loader 每 3s 拉取并注入（首次装配需重启）。
> 改 `lib/index.js` / `lib/api.js` 需重载插件；**任务运行中别重载**（会销毁内存会话）。

### 环境要求

| 项 | 要求 |
|---|---|
| DeepSeek Harness | 桌面版或 `dsh web`（需要 `webserver` / `agentLoop` / `agentPresets`） |
| Node.js | ≥ 20 |
| 模型 | 任意可用 provider（面板内可切换，20+ 家） |

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
| ⊞ 会话组 | `FR-01…` 新建 / 收编当前 / 删除 / 切换 / 自愈；每组独立权限 |
| ⚙ 技术面板 | 进度、步骤、路线检查、效率指标、唤醒分布、事件流 |
| 模型 ▾ | 切换前后台模型 |
| 发送即打断 | 见上 |

---

## 🧩 会话组（推荐）

- 编号 `FR-01 / FR-02 …` **由服务端生成，界面不可改**（客户端传 `key` 会被忽略）
- 每组 = 前台 `FR-0x·F` + 后台 `FR-0x·B`，全部 attach + pin 到「快速反应」工作区 ⇒ **DSH 侧边栏可直接打开原生会话页**
- **收编当前**：把已在跑的前后台登记成组，不新建会话
- **自愈**：编号重排、丢失会话重建、工作区重挂、权限重应用
- **权限**：每组一个下拉（`read-only` / `workspace-write` / `danger-full-access` / `auto`），
  立即写入沙箱模式 + 审批策略（复用 DSH `permissionPresets`）——**不用再盯着会话点“允许”**
- 权限被拒时前台会回一行 `【上报·权限】缺 …` 并停下，不会无声重试

---

## 🔌 HTTP API

Base：`http://127.0.0.1:<DSH web 端口>`（示例统一写 19387），`Content-Type: application/json`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/fr` | 控制台页面 |
| GET | `/fr/sidebar.js` | 侧边栏注入脚本（热更新通道） |
| GET | `/fr/api/status` | 全量状态（前后台 phase、黑板、chat、模型、权限、stall） |
| POST | `/fr/api/start` | 启用编排 + 确保接线 |
| POST | `/fr/api/stop` | 取消前后台 + 暂停编排 |
| POST | `/fr/api/rebuild` | 重建前后台会话 |
| POST | `/fr/api/task` | **发任务**：`{text, interrupt?, sessionId?, group?, role?}` |
| GET | `/fr/api/sessions` | 所有活会话（id/role/phase/group/preset/wired） |
| GET | `/fr/api/session?id=&group=&role=` | 单个会话信息（会话级寻址） |
| POST | `/fr/api/fire` | 只打断：`{reason, sessionId?, group?, role?}` |
| GET/POST | `/fr/api/config` | 读写配置（白名单字段） |
| GET | `/fr/api/models` | 模型清单 |
| POST | `/fr/api/model` | 切换模型 `{provider, model}` |
| GET/POST | `/fr/api/groups` | 会话组：`create/adopt/switch/policy/repair/delete` |
| GET | `/fr/api/events?since=&limit=` | 事件增量 |
| POST | `/fr/api/relay` | 运维中继 `{action, args}` |

**示例**

```bash
# 发任务（排队）
curl -X POST localhost:19387/fr/api/task -H 'content-type: application/json' \
  -d '{"text":"把 README 的示例命令跑一遍并汇报"}'

# 发任务（先打断再投递）
curl -X POST localhost:19387/fr/api/task -H 'content-type: application/json' \
  -d '{"text":"停一下，只回三个字：已打断","interrupt":true}'

# 新建并切换会话组
curl -X POST localhost:19387/fr/api/groups -H 'content-type: application/json' -d '{"action":"create","title":"桌面整理"}'
curl -X POST localhost:19387/fr/api/groups -H 'content-type: application/json' -d '{"action":"switch","key":"FR-01"}'

# 给该组完全权限（不再弹审批）
curl -X POST localhost:19387/fr/api/groups -H 'content-type: application/json' \
  -d '{"action":"policy","key":"FR-01","preset":"danger-full-access"}'
```

---

## 🗂 黑板与文件

```
<工作目录>/.board/
├── config.json      # 运行配置
├── groups.json      # 会话组（FR-0x → sessionId + preset）
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

**为什么首帧要 30–60 秒？**
后台是高档次模型，在写 route + steps；前台本身仍是秒级响应。面板会显示「正在处理…」。

**热重载会怎样？**
插件创建的会话是内存态，重载=销毁（排队消息一起没）。所以任务运行中不要重载。

**面板会盖住右下角挂件吗？**
会。面板按原生会话区矩形整体覆盖，这是当前的取舍（可加排除区域，未做）。

**能和记忆 / 审计类插件一起用吗？**
可以，互不依赖、也不改 DSH 的 DOM 与全局配置。长期记忆请按你所装记忆插件自己的官方文档配置（模型、存储位置等由它决定）。

---

## 🧭 目录结构

```
dsh-fast-react/
├── package.json          # dsh 插件元信息（bundle.patch / console=/fr）
├── cordis.patch.yml      # profile 装配层
├── lib/
│   ├── index.js          # 装配 / 事件 / 简报 / 哨兵 / 看门狗 / 会话组
│   ├── api.js            # HTTP 路由（/fr, /fr/api/*）
│   └── ui/
│       ├── page.html     # 控制台（对话/技术面板/会话组/模型/权限）
│       └── sidebar.js    # 侧边栏注入与浮层（几何跟随、灰线对齐）
├── docs/
│   ├── 技术路线.md        # 架构原理 + 踩坑表
│   └── 使用须知.md        # 安装/上手/API/排障（详细版）
└── README.md
```

---

## 📄 License

MIT © 2026 — 见 [LICENSE](./LICENSE)




