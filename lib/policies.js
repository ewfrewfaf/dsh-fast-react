/** policies.js —— 破坏性命令模式 / 关键唤醒原因等常量表（v1.3.1 抽出，纯数据） */

export const DESTRUCTIVE = [
  /\brm\s+(-\w*\s+)*-?\w*rf/i,
  /\brm\s+-r/i,
  /\bRemove-Item\b/i,
  /\bdel\s+[\/\\]/i,
  /\brmdir\s+\/s/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bgit\s+push\b[^\n]*--force/i,
  /\bgit\s+push\b[^\n]*\s-f\b/i,
  /\bgit\s+reset\s+--hard/i,
  /\bDROP\s+(TABLE|DATABASE)/i,
  /\bTRUNCATE\s+TABLE/i,
  /:\(\)\s*\{.*\}\s*;?\s*:/,
  /\bdiskpart\b/i,
  // ── 2026-10-17 实测补充：破坏性动作不只在 shell 里，脚本解释器一行也能删文件 ──
  /\bos\.remove\b/i,
  /\bos\.unlink\b/i,
  /\bshutil\.rmtree\b/i,
  /\brmtree\b/i,
  /\bfs\.rmSync\b/i,
  /\bfs\.unlinkSync\b/i,
  /\bfs\.rm\b/i,
  /\bunlinkSync\b/i,
]

export const CRITICAL_REASONS = new Set(['final', 'escalate', 't3', 'prefetch', 'judge', 'review'])
