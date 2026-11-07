/**
 * paths.mjs —— 工具脚本的可移植路径解析（2026-11-07）
 *
 * 背景：tools/*.mjs 里曾到处写死 `C:/Users/admin/...`，打包给别人后这些脚本
 *       全部指向原作者机器，一跑就 ENOENT。lib/ 是不受影响的（它用 defaults.js）。
 *
 * 解析规则（与 lib/defaults.js 同源，避免两处漂移）：
 *   ① FAST_REACT_BOARD 环境变量
 *   ② ~/Desktop/FastReact 已有 .board/config.json ⇒ 沿用（老装机迁移保护）
 *   ③ DSH_HOME/fast-react
 *   ④ ~/.dsh/fast-react
 *
 * 插件根目录：本文件位于 <pluginRoot>/tools/，所以 dirname(dirname(__file)) 即根。
 */
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 插件包根目录（= tools 的上一级） */
export const PLUGIN_ROOT = resolve(here, '..')

/** DSH 家目录 */
export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/** 黑板根目录 */
export function boardRoot () {
  const explicit = process.env.FAST_REACT_BOARD
  if (explicit) return explicit
  const legacy = join(homedir(), 'Desktop', 'FastReact')
  try {
    if (existsSync(join(legacy, '.board', 'config.json'))) return legacy
  } catch { /* 忽略 */ }
  return join(DSH_HOME, 'fast-react')
}

/** 黑板目录（.board） */
export function boardDir () {
  return join(boardRoot(), '.board')
}

/** 黑板下的某个文件 */
export function boardFile (name) {
  return join(boardDir(), name)
}

/** 插件日志（super-injector 注入时写的位置） */
export function pluginLog () {
  return join(DSH_HOME, 'super-injector', 'fast-react.log')
}

/** 插件源码目录 */
export function libFile (name) {
  return join(PLUGIN_ROOT, 'lib', name)
}

/** 临时目录 */
export function tmpDir (name) {
  return join(process.env.TEMP || process.env.TMP || '/tmp', name)
}

/** 桌面目录（仅交付脚本用；不存在则退回家目录） */
export function desktopDir () {
  const d = join(homedir(), 'Desktop')
  return existsSync(d) ? d : homedir()
}
