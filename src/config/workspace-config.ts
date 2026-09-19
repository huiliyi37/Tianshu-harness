/**
 * 工作区配置读写（issue #147）——从 src/config/manager.ts 外移，守住该文件的行数
 * 棘轮（scripts/source-budgets.manifest.json）。语义与 greeting/mirror 等配置面同族：
 * 读 = loadConfig().workspace，写 = 落用户全局 config.json。
 */
import { loadConfig, saveConfig } from './manager.js'
import { rivetHome } from './paths.js'
import { isAbsolute, relative, resolve } from 'node:path'

export interface WorkspaceConfigSnapshot {
  /** 未指定目录的新会话落点；null = 未配置。 */
  defaultDir: string | null
  /** 临时会话隔离根目录覆盖；null = 用 <rivetHome>/workspace。 */
  scratchDir: string | null
}

/** 桌面端设置页读取。空配置 = 两个字段都 null，即「保持改造前行为」。 */
export function getWorkspaceConfig(): WorkspaceConfigSnapshot {
  const ws = loadConfig().workspace ?? {}
  return {
    defaultDir: ws.defaultDir ?? null,
    scratchDir: ws.scratchDir ?? null,
  }
}

/** 大小写不敏感文件系统的规范形（Windows 等）——同一目录的两种写法必须同判。 */
function canonical(p: string): string {
  const abs = resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/**
 * `scratchDir` 是「临时会话隔离根」：`POST /scratch/cleanup` 会递归删除它下面的
 * 直接子目录（见 scratch-cleanup.ts 的 resolveScratchRoot + removeScratchEntries）。
 * 数据根之内任意位置都可以，但不能是数据根本身（那会让清理打到 sessions/、
 * config.json 这些数据根的直接子项），也不能逃到数据根之外——否则任何能写配置
 * 的一方都能指定删除目标（issue #223）。
 *
 * @throws Error —— 路由层（workspace-route.ts 的 PUT /config/workspace）转 400。
 */
export function assertScratchDirInDataRoot(dir: string): void {
  const home = canonical(rivetHome())
  const target = canonical(dir)
  const rel = relative(home, target)
  if (rel === '') {
    throw new Error('Invalid "scratchDir" — must be a subdirectory of the Rivet data root, not the data root itself')
  }
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Invalid "scratchDir" — must live inside the Rivet data root (${rivetHome()})`)
  }
}

/**
 * 写入用户全局配置——**部分更新语义**（2026-09-15 审查跟进）：
 *   undefined = 不改该字段（设置页每个控件独立提交，漏传 ≠ 清除）；
 *   null / 空白字符串 = 清除该字段（回到旧行为）；
 *   非字符串值抛错（HTTP 层转 400），不静默忽略——静默忽略会让用户以为已保存。
 * 曾是整体替换：桌面端只传 defaultDir 的 PUT 会把已配置的 scratchDir 静默清掉
 * ——而它没有 UI 编辑入口，被清后无法自助恢复。
 */
export function setWorkspaceConfig(input: { defaultDir?: unknown; scratchDir?: unknown }): WorkspaceConfigSnapshot {
  const readPath = (value: unknown, field: string): string | undefined => {
    if (value === null) return undefined
    if (typeof value !== 'string') throw new Error(`Invalid "${field}" — expected a path string or null`)
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  const cfg = loadConfig()
  const next = { ...(cfg.workspace ?? {}) }
  if (input.defaultDir !== undefined) {
    const v = readPath(input.defaultDir, 'defaultDir')
    if (v) next.defaultDir = v
    else delete next.defaultDir
  }
  if (input.scratchDir !== undefined) {
    const v = readPath(input.scratchDir, 'scratchDir')
    if (v) {
      assertScratchDirInDataRoot(v)
      next.scratchDir = v
    } else delete next.scratchDir
  }
  cfg.workspace = next
  saveConfig(cfg)
  return getWorkspaceConfig()
}
