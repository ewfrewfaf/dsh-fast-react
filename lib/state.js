/**
 * state.js —— 插件运行时状态容器（S1）
 *
 * 目的：给其他模块一个**单一状态入口**，避免它们去碰 index.js 的闭包变量。
 * 实现：不搬运变量（搬运 30 个 let 会把整个闭包拆掉、风险极高），而是让 S 成为
 * 「活绑定门面」——每个字段是 getter/setter，读写直接作用在 index.js 的原变量上。
 * 因此行为完全不变，但 delivery/scheduler/sentinels 等模块可以只依赖 S。
 */
export function createState () {
  const S = { _keys: new Set() }

  /** 绑定一个运行时状态：getter/setter 指向调用方作用域里的真实变量 */
  S.bind = (name, get, set) => {
    Object.defineProperty(S, name, {
      get,
      set: set || ((v) => { throw new Error(`state "${name}" 是只读的`) }),
      enumerable: true,
      configurable: true,
    })
    S._keys.add(name)
    return S
  }

  S.keys = () => [...S._keys]

  /** 快照（只读拷贝，用于日志/诊断；不包含函数） */
  S.snapshot = () => {
    const out = {}
    for (const k of S._keys) {
      try {
        const v = S[k]
        if (typeof v !== 'function') out[k] = v && typeof v === 'object' ? (Array.isArray(v) ? [...v] : { ...v }) : v
      } catch { /* 忽略不可读字段 */ }
    }
    return out
  }

  return S
}
