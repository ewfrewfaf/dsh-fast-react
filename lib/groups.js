/**
 * groups.js —— 会话组注册表 / Workspace 挂载 / 权限预设
 * 从 lib/index.js 抽出的第 1 阶段模块（行为不变 refactor）。
 *
 * 依赖（D 依赖袋，字段调用时读取）：
 *   稳定字段（工厂顶部解构）：K cfg ctx log vlog event TAG BASE_PATH boardRoot boardDir P BB
 *   惰性字段：apiApp attachToolPolicyFor effortFor idOf nameSession presetName readIf resolveAgents resolveRoute routeFor unwire wire writeAtomic
 *   K 共享状态：见 index.js 的 K 袋（本模块读写的跨模块可变状态全部经 K）。
 *
 * 区块地图：
 *   Workspace 挂载：wsRegistry / ensureWorkspace / linkSession / pruneDeadWorkspaceRefs / detachSession / linkFrontWorkspace
 *   组注册表：GROUPS_FILE / GROUPS_ARCHIVED / loadGroups / saveGroups / loadArchived / saveArchived / nextGroupKey
 *   权限预设：svcPermissionPresets / permissionCatalog / applyPreset / currentPreset / applyGroupPreset
 *   api：listGroups / setGroupPolicy / createGroup / deleteGroup / restoreGroup / switchGroup / repairGroups
 *   注：linkTimer（20s 权限兜底）与 K.linkedSessions / K.lastWsPruneAt 初始化仍留在 index.js 原位
 */

import { join } from 'node:path'

export function makeGroups (D) {
  const { cfg, ctx, log, vlog, event, TAG, BASE_PATH, boardRoot, boardDir, P, BB, K } = D

  // ── 会话 → Workspace 挂载（2026-10-17）：插件创建的会话是内存会话，DSH 侧边栏
  //   看不到 ⇒ 用户无法打开原生会话页。attach + pin 到黑板所在目录的 Workspace 后，
  //   它会作为普通会话出现在侧边栏，点开即原生页面（可看原始对话/工具调用）。
  async function wsRegistry () {
    try { return (ctx && typeof ctx.get === 'function') ? ctx.get('workspaceRegistry') : undefined } catch { return undefined }
  }
  async function ensureWorkspace () {
    const wr = await wsRegistry()
    if (!wr) return null
    let ws = null
    try { ws = await wr.resolveByPath(boardRoot) } catch { /* 目录不存等 */ }
    if (!ws) ws = await wr.create(boardRoot, '快速反应')
    return ws
  }
  /** 把任意会话挂进工作区；pin=true 时置顶 */
  async function linkSession (sid, pin) {
    if (!cfg.linkWorkspaceSession || !sid) return false
    try {
      const wr = await wsRegistry()
      if (!wr) return false
      const ws = await ensureWorkspace()
      if (!ws) return false
      const ids = (ws.sessionIds || []).map(String)
      if (!ids.includes(String(sid))) await ws.attachSession(sid)
      if (pin && typeof wr.pinSession === 'function') { try { await wr.pinSession(sid) } catch { /* 忽略 */ } }
      K.linkedSessions.add(String(sid))
      // ★★ 2026-11-07 根因修复：工作区会话引用只增不减。
      //   实证：Desktop\FastReact 那个工作区累计 163 条会话引用，实际存活只有 1-2 个。
      //   原因：每次 autoheal/rebuild/建组都新建会话并 attach，旧会话**从不 detach**
      //   （detachSession 只被 deleteGroup 调用）。
      //   后果：侧边栏出现大量"幽灵会话"，且 resolveAgents/syncRoute/组自愈
      //   都要在这些死 id 上做 ctx.agents.get() 查空，白白放大开销与困惑。
      //   策略：每次挂新会话时，顺手把"已不存在于 ctx.agents"的引用摘掉；
      //   保留当前存活的一切（含别的组的活会话），只清死引用。
      try { await pruneDeadWorkspaceRefs(ws) } catch (e) { log('清理工作区死引用失败: ' + e.message) }
      return true
    } catch (e) { log('linkSession fail: ' + (e && e.message)); return false }
  }

  /** 摘掉工作区里"会话已不存在"的引用（只清死 id，不动活会话）。节流：60s 内不重复。 */
  async function pruneDeadWorkspaceRefs (ws) {
    if (Date.now() - K.lastWsPruneAt < 60000) return 0
    K.lastWsPruneAt = Date.now()
    const ids = (ws && ws.sessionIds || []).map(String)
    if (ids.length <= 4) return 0                       // 引用不多 ⇒ 不值得扫
    const alive = (id) => { try { return !!(ctx.agents && ctx.agents.get(id)) } catch { return false } }
    let removed = 0
    for (const id of ids) {
      if (id === String(cfg.frontSessionId) || id === String(cfg.backSessionId)) continue
      if (alive(id)) continue
      try { await ws.detachSession(id); removed++ } catch { /* 单条失败不影响其它 */ }
    }
    if (removed) {
      event('workspace-prune', { removed, before: ids.length, after: (ws.sessionIds || []).length })
      log(`工作区死引用清理：移除 ${removed} 条（${ids.length} → ${(ws.sessionIds || []).length}）`)
    }
    return removed
  }
  async function detachSession (sid) {
    try {
      const ws = await ensureWorkspace()
      if (ws && typeof ws.detachSession === 'function') await ws.detachSession(sid)
    } catch (e) { log('detachSession fail: ' + (e && e.message)) }
  }
  async function linkFrontWorkspace () {
    if (!cfg.linkWorkspaceSession || !K.front) return
    const sid = D.idOf(K.front)
    if (!sid || K.linkedSessions.has(sid)) return
    const ok = await linkSession(sid, true)
    if (ok) {
      event('workspace-link', { session: sid })
      log('前台会话已挂到工作区（侧边栏可见）')
    }
  }

  // ── 会话组注册表（FR-01 / FR-02 …）：编号由服务端生成、客户端不可改 ────────
  const GROUPS_FILE = join(boardDir, 'groups.json')
  function loadGroups () {
    try { const a = JSON.parse(D.readIf(GROUPS_FILE) || '[]'); return Array.isArray(a) ? a : [] } catch { return [] }
  }
  function saveGroups (list) {
    try { D.writeAtomic(GROUPS_FILE, JSON.stringify(list, null, 1)) } catch (e) { log('saveGroups fail: ' + (e && e.message)) }
  }
  // ★ 2026-11-15 归档组台账：删组=宿主级归档（可恢复），记录留在这里供恢复/审计
  const GROUPS_ARCHIVED = join(boardDir, 'groups.archived.json')
  function loadArchived () {
    try { const a = JSON.parse(D.readIf(GROUPS_ARCHIVED) || '[]'); return Array.isArray(a) ? a : [] } catch { return [] }
  }
  function saveArchived (list) {
    try { D.writeAtomic(GROUPS_ARCHIVED, JSON.stringify(list, null, 1)) } catch (e) { log('saveArchived fail: ' + (e && e.message)) }
  }
  function nextGroupKey (list) {
    // ★ 多实例（2026-11-07）：按本实例的编号格式求最大值。
    //   实例 a 用 FR-<n>，其它用 FR-<tag>-<n>；两者混在同一个 groups.json 里时，
    //   只认自己那种格式，否则 b 每次都会算出同样的 FR-b-02（撞号）。
    const PREFIX = TAG === 'a' ? 'FR-' : ('FR-' + TAG + '-')
    const RE = TAG === 'a' ? /^FR-(\d+)$/ : new RegExp('^FR-' + TAG + '-(\\d+)$')
    let max = 0
    // ★ 2026-11-15 修复：归档台账也参与编号（实测撞号：删组后新组复用已归档的 FR-02）
    for (const g of [...list, ...loadArchived()]) {
      const k = String((g && g.key) || '')
      if (TAG === 'a' && /^FR-[b-z]-/.test(k)) continue   // a 不认 b 的编号
      const m = k.match(RE)
      if (m) max = Math.max(max, Number(m[1]))
    }
    return PREFIX + String(max + 1).padStart(2, '0')
  }

  // ── 权限预设（沙箱模式 + 审批策略的捆绑）────────────────────────────────
  // 直接复用 DSH 的 permissionPresets 服务：set(session, preset) 同时写
  // sandbox/mode 与 approval/policy ⇒ 面板里选的权限与 DSH 原生「权限」下拉完全等价，
  // 且不需要人盯着会话点「允许」。
  function svcPermissionPresets () {
    try { return (ctx && typeof ctx.get === 'function') ? ctx.get('permissionPresets') : undefined } catch { return undefined }
  }
  function permissionCatalog () {
    const p = svcPermissionPresets()
    if (!p || typeof p.catalog !== 'function') return { options: [], defaultPreset: '' }
    try {
      const c = p.catalog() || {}
      return { options: c.options || [], defaultOptions: c.defaultOptions || [], defaultPreset: c.defaultPreset || '' }
    } catch (e) { log('permissionCatalog fail: ' + (e && e.message)); return { options: [], defaultPreset: '' } }
  }
  function applyPreset (sessionId, preset) {
    if (!sessionId || !preset) return false
    const p = svcPermissionPresets()
    if (!p || typeof p.set !== 'function') return false
    try {
      const a = ctx.agents.get(sessionId)
      if (!a) return false
      p.set(a.session, preset)
      return true
    } catch (e) { log('applyPreset(' + preset + ') fail: ' + (e && e.message)); return false }
  }
  function currentPreset (sessionId) {
    try {
      const p = svcPermissionPresets()
      const a = sessionId ? ctx.agents.get(sessionId) : null
      if (!p || !a) return ''
      return p.current(a.session) || ''
    } catch { return '' }
  }
  function applyGroupPreset (g) {
    if (!g) return
    const preset = g.preset || cfg.permissionPreset
    if (!preset) return
    applyPreset(g.frontId, preset)
    applyPreset(g.backId, preset)
  }

  // ── apiApp 内抽出的方法（index 用 ...GR.api 展开）──
  const api = {
    // ══ 会话组管理（FR-01 / FR-02 …）══════════════════════════════════════
    // 编号由服务端生成、客户端不可指定（防改号）；每组 = 前台 + 后台 两个会话，
    // 全部 attach 到「快速反应」工作区；删除需 force 且运行中默认拒绝。
    listGroups () {
      const list = loadGroups()
      const phaseOf = (id) => {
        try { const a = ctx.agents.get(id); return a ? ((a.phase && a.phase.kind) || '?') : 'missing' } catch { return 'missing' }
      }
      const active = (list.find((g) => String(g.frontId) === String(cfg.frontSessionId)) || {})
      return {
        groups: list.map((g) => ({
          key: g.key, title: g.title, frontId: g.frontId, backId: g.backId, createdAt: g.createdAt,
          frontPhase: phaseOf(g.frontId), backPhase: phaseOf(g.backId),
          active: String(g.frontId) === String(cfg.frontSessionId),
          attached: true,
          preset: g.preset || '',
          frontPreset: currentPreset(g.frontId),
          backPreset: currentPreset(g.backId),
        })),
        activeKey: active.key || '',
        archived: loadArchived(),
        permission: permissionCatalog(),
        defaultPreset: cfg.permissionPreset || '',
      }
    },
    /** 设置某组权限预设：写注册表 + 立即应用到前后台会话（会话缺失时先自愈） */
    async setGroupPolicy (key, preset) {
      const list = loadGroups()
      const g = list.find((x) => x.key === key)
      if (!g) return { error: '找不到会话组 ' + key }
      g.preset = String(preset || '')
      saveGroups(list)
      const alive = (id) => { try { return !!(ctx.agents && ctx.agents.get(id)) } catch { return false } }
      if (!alive(g.frontId) || !alive(g.backId)) {
        await D.apiApp.repairGroups()          // 防呆：会话丢了先重建，否则权限设不上
        const fresh = loadGroups().find((x) => x.key === key)
        if (fresh) { g.frontId = fresh.frontId; g.backId = fresh.backId }
      }
      applyGroupPreset(g)
      event('group-policy', { key, preset: g.preset })
      log('会话组 ' + key + ' 权限 -> ' + (g.preset || '(跟随默认)'))
      return { ok: true, key, preset: g.preset, frontPreset: currentPreset(g.frontId), backPreset: currentPreset(g.backId) }
    },
    async createGroup (title, adoptCurrent) {
      if (!K.svcAgentLoop || !K.svcPresets) return { error: 'agentLoop / agentPresets 服务未就绪' }
      const route = D.resolveRoute()
      if (!route) return { error: '拿不到模型路由（先配置或启动一次）' }
      const list = loadGroups()
      const key = nextGroupKey(list)
      // ★ adopt：把当前已接线的前后台直接收编成本组（不新建会话）
      if (adoptCurrent) {
        const live = (id) => { try { return !!(id && ctx.agents && ctx.agents.get(id)) } catch { return false } }
        if (!live(cfg.frontSessionId) || !live(cfg.backSessionId)) {
          return { error: '当前前后台未接线（先点「启动」）' }
        }
        const fId = String(cfg.frontSessionId), bId = String(cfg.backSessionId)
        for (const g of list) {
          if (String(g.frontId) === fId || String(g.backId) === bId) return { error: '当前前后台已属于会话组 ' + g.key }
        }
        const g = {
          key, title: String(title || ('快速反应 ' + key)).slice(0, 60), frontId: fId, backId: bId,
          createdAt: new Date().toISOString(), preset: cfg.permissionPreset || '', adopted: true,
        }
        applyGroupPreset(g)
        list.push(g)
        saveGroups(list)
        await linkSession(fId, true); await linkSession(bId, false)
        // ★ 收编后刷新两个会话的标题（带上组号，否则还是「快速反应 · 前台」无后缀）
        try {
          const fa = ctx.agents.get(fId); if (fa) await D.nameSession(fa, 'front', key)
          const ba = ctx.agents.get(bId); if (ba) await D.nameSession(ba, 'back', key)
        } catch { /* 忽略 */ }
        event('group-adopt', { key, front: fId, back: bId })
        log('收编当前前后台为会话组 ' + key)
        return { ok: true, group: g, groups: list, adopted: true }
      }
      const mk = async (tag) => {
        const id = (TAG === 'a' ? 'session-' : 'session-' + TAG + '-') + key.toLowerCase() + '-' + tag + '-' + Date.now().toString(36)
        const ag = await K.svcAgentLoop.create(id, { provider: D.routeFor(tag).provider, model: D.routeFor(tag).model, reasoningEffort: D.effortFor(tag) }, { cwd: boardRoot })
        await D.nameSession(ag, tag, key)
        try { await K.svcPresets.mount(ag.ctx, D.presetName()) } catch (e) { log('组挂预设失败: ' + e.message) }
        // ★★ 2026-11-07：会话组会话同样必须**一创建就挂**工具面（与 autoheal/rebuild 一致）。
        //   漏了这里 ⇒ 用「新建会话组」起的会话是 68 个工具（含 dev_*/hindsight_*/fr_escalate），
        //   而用户日常主要就是用组。
        try { D.attachToolPolicyFor(tag, ag) } catch (e) { log('组创建即时挂工具面失败: ' + e.message) }
        await linkSession(D.idOf(ag), tag === 'front')
        return D.idOf(ag)
      }
      try {
        const frontId = await mk('front')
        const backId = await mk('back')
        const g = {
          key, title: String(title || ('快速反应 ' + key)).slice(0, 60), frontId, backId,
          createdAt: new Date().toISOString(), preset: cfg.permissionPreset || '',
        }
        applyGroupPreset(g)
        list.push(g)
        saveGroups(list)
        event('group-create', { key, front: frontId, back: backId, preset: g.preset })
        log('新建会话组 ' + key + '（front=' + frontId.slice(0, 22) + '，权限=' + (g.preset || '默认') + '）')
        return { ok: true, group: g, groups: list }
      } catch (e) { return { error: String(e && e.message || e) } }
    },
    async deleteGroup (key, force) {
      const list = loadGroups()
      const i = list.findIndex((g) => g.key === key)
      if (i < 0) return { error: '找不到会话组 ' + key }
      const g = list[i]
      const ids = [g.frontId, g.backId].filter(Boolean)
      const agents = []
      for (const id of ids) { try { const a = ctx.agents.get(id); if (a) agents.push(a) } catch { /* 忽略 */ } }
      const running = agents.some((a) => a.phase && a.phase.kind === 'running')
      if (running && !force) return { error: '该组正在运行，需确认强制删除', needForce: true }
      for (const a of agents) { try { a.cancel(new Error('delete group')) } catch { /* 忽略 */ } }
      await new Promise((r) => setTimeout(r, 300))
      for (const id of ids) await detachSession(id)
      // ★ 2026-11-15 根因修复：detach 只摘工作区引用，会话本体仍留在 DSH 全局列表
      //   ⇒ 用户看到"大量未分组"。改为宿主级 archiveSession（可恢复，侧栏不再显示）。
      const wrArch = await wsRegistry()
      for (const id of ids) {
        try { if (wrArch && typeof wrArch.archiveSession === 'function') await wrArch.archiveSession(id) } catch (e) { log('archiveSession fail ' + id + ': ' + (e && e.message)) }
      }
      const arch = loadArchived()
      arch.push({ key: g.key, title: g.title || '', frontId: g.frontId, backId: g.backId, preset: g.preset || '', archivedAt: new Date().toISOString() })
      saveArchived(arch)
      list.splice(i, 1)
      saveGroups(list)
      event('group-delete', { key, ids, force: !!force })
      log('删除会话组 ' + key + '（' + ids.join(',') + '）')
      if (ids.includes(String(cfg.frontSessionId)) || ids.includes(String(cfg.backSessionId))) {
        D.unwire(); D.resolveAgents()
      }
      return { ok: true, key, deleted: ids, groups: list }
    },
    /** ★ 2026-11-15 恢复归档组：宿主 unarchive + 重新挂工作区 + 组记录回列表 */
    async restoreGroup (key) {
      const arch = loadArchived()
      const i = arch.findIndex((g) => g.key === key)
      if (i < 0) return { error: '找不到归档会话组 ' + key }
      const g = arch[i]
      const wr = await wsRegistry()
      // ★ 2026-11-15 收敛同号归档条目（历史撞号残留）：恢复会话 id 并集，台账整键清除
      const ids = [...new Set(arch.filter((x) => x.key === key).flatMap((x) => [x.frontId, x.backId].filter(Boolean)))]
      for (const id of ids) {
        try { if (wr && typeof wr.unarchiveSession === 'function') await wr.unarchiveSession(id) } catch (e) { log('unarchiveSession fail ' + id + ': ' + (e && e.message)) }
        // ★ 恢复意图=挂回工作区，不受 linkWorkspaceSession 开关限制（否则恢复后又变未分组）
        try {
          const wsR = await ensureWorkspace()
          if (wsR && typeof wsR.attachSession === 'function' && !(wsR.sessionIds || []).map(String).includes(String(id))) await wsR.attachSession(id)
        } catch { /* 忽略 */ }
      }
      const list = loadGroups()
      const exist = list.find((x) => x.key === key)
      if (exist) { exist.frontId = ids[0] || exist.frontId; exist.backId = ids[1] || exist.backId }
      else list.push({ key, title: g.title || '', frontId: ids[0] || '', backId: ids[1] || '', createdAt: g.createdAt || new Date().toISOString(), preset: g.preset || '' })
      saveGroups(list)
      saveArchived(arch.filter((x) => x.key !== key))
      // 与 createGroup 对齐：恢复后重挂该组权限预设（会话未复活时内部 no-op）
      try { applyGroupPreset(g) } catch { /* 忽略 */ }
      event('group-restore', { key, ids })
      log('恢复归档会话组 ' + key + '（' + ids.join(',') + '）')
      return { ok: true, key, restored: ids, groups: list }
    },
    async switchGroup (key) {
      const list = loadGroups()
      const g = list.find((x) => x.key === key)
      if (!g) return { error: '找不到会话组 ' + key }
      const alive = (id) => { try { return !!(ctx.agents && ctx.agents.get(id)) } catch { return false } }
      if (!alive(g.frontId) || !alive(g.backId)) {
        const r = await D.apiApp.repairGroups()      // 防呆：会话丢了先自愈再切
        if (r && r.error) return r
      }
      D.wire(g.frontId, g.backId)
      K.briefed.clear()                               // 新组需要重新注入角色简报
      D.resolveAgents()
      applyGroupPreset(g)                           // 切换后按该组权限预设重设前后台
      // ★ 切组后刷新两个会话的标题（带上新组号，否则侧边栏还是旧组的名字）
      try {
        const fa = ctx.agents.get(g.frontId); if (fa) await D.nameSession(fa, 'front', key)
        const ba = ctx.agents.get(g.backId); if (ba) await D.nameSession(ba, 'back', key)
      } catch { /* 忽略 */ }
      event('group-switch', { key, front: g.frontId, back: g.backId, preset: g.preset || '' })
      log('切换到会话组 ' + key)
      return { ok: true, key, front: D.idOf(K.front), back: D.idOf(K.back) }
    },
    /** 自愈：编号连续性 / 缺失会话重建 / 工作区重新挂载 */
    async repairGroups () {
      if (!K.svcAgentLoop || !K.svcPresets) return { error: 'agentLoop / agentPresets 服务未就绪' }
      const list = loadGroups()
      const report = { renumbered: [], recreated: [], attached: [], ok: true }
      const alive = (id) => { try { return !!(ctx.agents && ctx.agents.get(id)) } catch { return false } }
      const mk = async (g, tag) => {
        const id = 'session-' + g.key.toLowerCase() + '-' + tag + '-' + Date.now().toString(36)
        const route = D.resolveRoute() || {}
        const ag = await K.svcAgentLoop.create(id, { provider: D.routeFor(tag).provider, model: D.routeFor(tag).model, reasoningEffort: D.effortFor(tag) }, { cwd: boardRoot })
        try { await K.svcPresets.mount(ag.ctx, D.presetName()) } catch { /* 忽略 */ }
        // ★★ 2026-11-07：组自愈重建的会话也必须立刻挂工具面
        try { D.attachToolPolicyFor(tag, ag) } catch (e) { log('组自愈即时挂工具面失败: ' + e.message) }
        return D.idOf(ag)
      }
      // ★ 多实例（2026-11-07）：重编号必须用本实例前缀，否则 b 的 FR-b-02 会被改回 FR-02，
      //   下次 nextGroupKey 又会撞号（自愈反而制造 bug）。
      const KEY_PREFIX = TAG === 'a' ? 'FR-' : ('FR-' + TAG + '-')
      const mine = list.filter((g) => {
        const k = String((g && g.key) || '')
        if (!k.startsWith(KEY_PREFIX)) return false
        if (TAG === 'a' && /^FR-[b-z]-/.test(k)) return false
        return true
      })
      for (let n = 0; n < mine.length; n++) {
        const g = mine[n]
        const want = KEY_PREFIX + String(n + 1).padStart(2, '0')
        if (g.key !== want) { report.renumbered.push({ from: g.key, to: want }); g.key = want }
      }
      // 会话自愈对**全部**组做（各实例只认自己的会话，isFrSession 已过滤）；
      // 重编号只动本实例前缀的组，绝不改别的实例编号。
      for (const g of list) {
        if (!alive(g.frontId)) {
          try { g.frontId = await mk(g, 'front'); report.recreated.push({ key: g.key, role: 'front' }) } catch (e) { report.ok = false; log('自愈重建前台失败: ' + e.message) }
        }
        if (!alive(g.backId)) {
          try { g.backId = await mk(g, 'back'); report.recreated.push({ key: g.key, role: 'back' }) } catch (e) { report.ok = false; log('自愈重建后台失败: ' + e.message) }
        }
        for (const id of [g.frontId, g.backId]) {
          if (!id) continue
          const done = await linkSession(id, id === g.frontId)
          if (done) report.attached.push(id)
        }
        applyGroupPreset(g)                          // 自愈后重设权限（可能刚重建会话）
      }
      saveGroups(list)
      event('group-repair', report)
      log('会话组自愈：' + JSON.stringify(report).slice(0, 300))
      return report
    },
  }

  return { wsRegistry, ensureWorkspace, linkSession, pruneDeadWorkspaceRefs, detachSession, linkFrontWorkspace, loadGroups, saveGroups, loadArchived, saveArchived, nextGroupKey, svcPermissionPresets, permissionCatalog, applyPreset, currentPreset, applyGroupPreset, api }
}
