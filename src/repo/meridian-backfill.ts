/**
 * meridian-backfill.ts — Meridian 后台全量索引。
 *
 * 懒建（read_file 触发 indexFile）只覆盖 agent 读过的文件；本模块在显式
 * 需要时（RIVET_MERIDIAN_BACKFILL=1 启动 opt-in，或首次 repo_* 工具 on-demand）
 * 把可索引范围内的全项目文件逐步喂进同一 MeridianIndexer，让
 * repo_graph / related_tests / <codebase-index> 等 DB 派生消费端受益。
 * 复用 indexFile()——hash 幂等（meridian-db needsParse）使与懒建重叠、
 * 重复调度都零成本；同一实例进程内天然串行（SQLite 单写者）。
 *
 * 调度纪律：串行批循环，批间 setTimeout(0) 让出事件循环；总量上限默认
 * 2000（RIVET_MERIDIAN_BACKFILL_MAX 可调）；RIVET_MERIDIAN_BACKFILL=0 或 lean
 * 整体关闭。进程退出即自然终止——半成品文件 hash 已落库，下次接着建。
 *
 * 默认（无 env）：启动路径不回填；on-demand（repo_graph / repo_map）可回填。
 * RIVET_MERIDIAN_BACKFILL=1：启动也回填。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import type { MeridianIndexer } from './meridian-indexer.js'
import { isMeridianIndexablePath } from './meridian-indexer.js'
import { isRuntimeLeanAspect } from '../config/runtime-lean.js'
import { debugLog } from '../utils/debug.js'

/** 每批索引文件数——批间让出事件循环，TUI/sidecar 不被 tree-sitter 解析卡住。 */
const BACKFILL_BATCH_SIZE = 20
/** 默认全量索引上限（文件数）；RIVET_MERIDIAN_BACKFILL_MAX 覆盖。 */
export const DEFAULT_MERIDIAN_BACKFILL_MAX = 2000
/** git ls-files 枚举硬超时——启动闲时执行，比 file-completer 的 500ms 宽。 */
const GIT_LS_FILES_TIMEOUT_MS = 3000
/** 非 git 目录 readdir 回退的目录跳过集（与 indexer IGNORE_PATTERNS 对齐）。 */
const READDIR_SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.rivet'])
/** readdir 回退的枚举总量上限——防止失控遍历巨型目录树。 */
const READDIR_ENUM_CAP = 10_000

export interface MeridianBackfillHandle {
  stop(): void
  /** 索引循环结束（含被 stop 提前终止）时 resolve——测试与调用方可等待。 */
  done: Promise<void>
}

export type MeridianBackfillReason = 'startup' | 'ondemand' | 'read_cold'

export interface MeridianBackfillOptions {
  /**
   * `startup` — only runs when RIVET_MERIDIAN_BACKFILL=1.
   * `ondemand` / `read_cold` — runs unless explicitly disabled (=0) or lean
   * profile is on. `read_cold` 是 meridian-hook 冷库 read 触发的 on-demand
   * 细分，仅用于 debug 日志归因，门控语义与 ondemand 相同。
   * Default `ondemand` so existing call sites and tests keep working.
   */
  reason?: MeridianBackfillReason
}

/** `git ls-files --cached --others --exclude-standard`（gitignore 感知）。
 *  非 git 目录/命令失败/超时 → null，调用方回退 readdir。
 *  异步 execFile——回填由 repo_* 工具 on-demand 触发（scout 蜂群高频路径），
 *  同步 spawn 在冷盘/杀毒扫描的 Windows 上最多卡事件循环整个超时窗（3s），
 *  是 /scout 卡死事故线上的同步阻塞点之一（2026-08-24）。 */
const execFileAsync = promisify(execFile)

async function enumerateViaGit(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd,
      timeout: GIT_LS_FILES_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    })
    return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  } catch {
    return null
  }
}

/** 非 git 回退：有界递归 readdir，跳过依赖/构建/运行时目录。 */
function enumerateViaReaddir(cwd: string): string[] {
  const out: string[] = []
  const walk = (relDir: string): void => {
    if (out.length >= READDIR_ENUM_CAP) return
    let entries: Dirent[]
    try {
      entries = readdirSync(join(cwd, relDir || '.'), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= READDIR_ENUM_CAP) return
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!READDIR_SKIP_DIRS.has(entry.name)) walk(rel)
      } else if (entry.isFile()) {
        out.push(rel)
      }
    }
  }
  walk('')
  return out
}

/** mtime 新→旧排序（最近改动的文件最可能被用到）；stat 失败的文件跳过。 */
function sortByMtimeDesc(cwd: string, rels: string[]): string[] {
  const withMtime: Array<{ rel: string; mtimeMs: number }> = []
  for (const rel of rels) {
    try {
      withMtime.push({ rel, mtimeMs: statSync(join(cwd, rel)).mtimeMs })
    } catch { /* 枚举后消失的文件跳过 */ }
  }
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return withMtime.map(e => e.rel)
}

function backfillMaxFiles(): number {
  const raw = process.env.RIVET_MERIDIAN_BACKFILL_MAX
  if (!raw) return DEFAULT_MERIDIAN_BACKFILL_MAX
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MERIDIAN_BACKFILL_MAX
}

/** Whether a backfill request with the given reason is allowed under current env/lean. */
export function isMeridianBackfillAllowed(reason: MeridianBackfillReason = 'ondemand'): boolean {
  if (process.env.RIVET_MERIDIAN_BACKFILL === '0') return false
  if (isRuntimeLeanAspect('meridian')) return false
  if (reason === 'startup') return process.env.RIVET_MERIDIAN_BACKFILL === '1'
  return true
}

/**
 * 启动后台全量索引。调用方负责在闲时调度（两处入口均 setImmediate）。
 * 每个 indexer 实例只生效一次（实例上挂 flag），重复调用返回即刻完成的空句柄。
 */
export function scheduleMeridianBackfill(
  indexer: MeridianIndexer,
  cwd: string,
  opts: MeridianBackfillOptions = {},
): MeridianBackfillHandle {
  let stopped = false
  const stop = (): void => { stopped = true }
  const reason = opts.reason ?? 'ondemand'

  if (indexer.backfillScheduled) {
    return { stop, done: Promise.resolve() }
  }
  indexer.backfillScheduled = true

  if (!isMeridianBackfillAllowed(reason)) {
    debugLog(`[meridian-backfill] skipped (reason=${reason}, lean/env gate)`)
    return { stop, done: Promise.resolve() }
  }

  const maxFiles = backfillMaxFiles()
  const done = (async (): Promise<void> => {
    const enumerated = (await enumerateViaGit(cwd)) ?? enumerateViaReaddir(cwd)
    // 与懒建完全同规则过滤（isMeridianIndexablePath 单一来源，防漂移）
    const candidates = sortByMtimeDesc(cwd, enumerated.filter(isMeridianIndexablePath)).slice(0, maxFiles)
    debugLog(`[meridian-backfill] start: ${candidates.length} candidates (cwd=${cwd}, reason=${reason})`)
    let indexed = 0
    for (let i = 0; i < candidates.length && !stopped; i += BACKFILL_BATCH_SIZE) {
      for (const rel of candidates.slice(i, i + BACKFILL_BATCH_SIZE)) {
        if (stopped) break
        try {
          await indexer.indexFile(rel)
          indexed++
        } catch { /* 单文件失败不阻塞整体 */ }
      }
      // 批间让出事件循环
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    debugLog(`[meridian-backfill] done: indexed=${indexed}/${candidates.length}${stopped ? ' (stopped)' : ''}`)
  })().catch(err => {
    debugLog(`[meridian-backfill] failed: ${String(err)}`)
  })

  return { stop, done }
}
