/**
 * Multi-language LSP manager.
 *
 * Wraps the single-server `createLspManager` and routes each request to the
 * language server matching the file's extension, lazily spawning + initializing
 * each server on first use. This gives polyglot go-to-definition / diagnostics
 * (pyright / gopls / rust-analyzer / clangd / jdtls / typescript-language-server)
 * behind the existing single `LspManager` interface, so the late-bound
 * `getLspManager()` getter and all call sites are unchanged.
 */

import type { ChildProcess } from 'node:child_process'
import { spawnHidden } from '../tools/spawn-hidden.js'
import {
  resolveNpmCliCommand,
  buildStdioEnvWithNodePath,
  type ResolveNodeCliDeps,
} from '../platform/resolve-node-cli.js'
import { createLspManager, type LspManager, type LspDiagnostic } from './manager.js'
import {
  serverForFile,
  availableServers,
  defaultWhich,
  type LspServerDef,
  type WhichFn,
} from './server-registry.js'

interface Location {
  uri: string
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
}

export interface MultiLspOptions {
  which?: WhichFn
  /** Injected for tests; defaults to a real child-process spawn. */
  spawnFor?: (def: LspServerDef, cwd: string) => ChildProcess
  /**
   * Hard ceiling for lazy server initialize(). When exceeded the hung child is
   * disposed and LSP degrades to null instead of wedging the turn.
   */
  initializeTimeoutMs?: number
}

export const DEFAULT_LSP_INITIALIZE_TIMEOUT_MS = 45_000
/** Shortest wait used by post-edit diagnostics so a cold LSP never stalls an edit. */
export const LSP_DIAGNOSTIC_READY_WAIT_MS = 2_000
/** 服务器崩死后允许的重启次数（有界，防 crash-loop 无限 spawn）。 */
const MAX_LSP_RESTARTS = 2

type LspSpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess

/**
 * Default spawn for LSP servers: rewrites bare npx/npm to node+cli.js so
 * Windows GUI / bundled-node launches don't ENOENT on npx.cmd when shell is
 * forced off (spawnHidden). Non-npx commands pass through unchanged.
 *
 * `resolveDeps` / `spawnFn` are injectable so tests can simulate the desktop
 * bundled node-runtime layout without depending on the host Node install.
 */
export function defaultLspSpawn(
  def: LspServerDef,
  cwd: string,
  spawnFn: LspSpawnFn = spawnHidden as LspSpawnFn,
  resolveDeps: ResolveNodeCliDeps = {},
): ChildProcess {
  const resolved = resolveNpmCliCommand(def.command, def.args ?? [], resolveDeps)
  const env = buildStdioEnvWithNodePath(undefined, {
    ...resolveDeps,
    getDefaultEnvironment: () => ({ ...process.env } as Record<string, string>),
  })
  return spawnFn(resolved.command, resolved.args, {
    cwd, stdio: ['pipe', 'pipe', 'pipe'], env,
  })
}

export function createMultiLspManager(cwd: string, opts: MultiLspOptions = {}): LspManager {
  const which = opts.which ?? defaultWhich
  const spawnFor = opts.spawnFor ?? ((def, c) => defaultLspSpawn(def, c))
  const initializeTimeoutMs = opts.initializeTimeoutMs ?? DEFAULT_LSP_INITIALIZE_TIMEOUT_MS

  interface LspEntry {
    mgr: LspManager
    ready: Promise<boolean>
  }
  const managers = new Map<string, LspEntry>()
  /** 每个 def 的累计重启次数。放在 managers 外：重启会删 entry 重建，
   *  计数挂 entry 上会被一并清零——上限永远达不到（crash-loop 防护失效）。 */
  const restartCounts = new Map<string, number>()
  let availableCache: LspServerDef[] | null = null

  const getAvailable = (): LspServerDef[] => {
    if (availableCache === null) availableCache = availableServers(which)
    return availableCache
  }

  /**
   * Lazily spawn + initialize a server, with TWO independent bounds:
   *  - `ready` hard-stops initialize() at initializeTimeoutMs, disposes the
   *    hung child, and resolves false (LSP degrades to null);
   *  - each call may race `ready` with a shorter `waitMs` and continue without
   *    LSP while a slow server keeps initializing in the background.
   */
  const ensure = async (def: LspServerDef, waitMs = initializeTimeoutMs): Promise<LspManager | null> => {
    let entry = managers.get(def.id)
    if (!entry) {
      const mgr = createLspManager(() => spawnFor(def, cwd), cwd)
      const ready = new Promise<boolean>((resolve) => {
        let settled = false
        const hardTimer = setTimeout(() => {
          if (settled) return
          settled = true
          // The initialize RPC may still be pending forever (spawn hung /
          // process dead); killing + disposing rejects it through the rpc
          // layer and releases the child.
          try { mgr.dispose() } catch { /* best-effort */ }
          resolve(false)
        }, initializeTimeoutMs)
        hardTimer.unref?.()

        mgr.initialize().then(
          () => {
            if (settled) return
            settled = true
            clearTimeout(hardTimer)
            resolve(mgr.isReady())
          },
          () => {
            if (settled) return
            settled = true
            clearTimeout(hardTimer)
            resolve(false)
          },
        )
      })
      entry = { mgr, ready }
      managers.set(def.id, entry)
    }

    const boundedWait = Number.isFinite(waitMs) && waitMs > 0 ? waitMs : initializeTimeoutMs
    const ok = await Promise.race([
      entry.ready,
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), boundedWait)
        timer.unref?.()
      }),
    ])
    if (ok && !entry.mgr.isReady()) {
      // initialize 曾成功、但服务器进程此后死掉：entry.ready 永远停在 true，
      // 没有本分支时之后每次 ensure() 都返回 null——LSP 对会话剩余时间静默
      // 失效（崩溃一次 = 定义跳转/诊断全部降级且永不恢复）。丢弃条目让下次
      // ensure 重新 spawn；有界重试防 crash-loop 打爆 spawn。
      const restarts = (restartCounts.get(def.id) ?? 0) + 1
      restartCounts.set(def.id, restarts)
      if (restarts <= MAX_LSP_RESTARTS) {
        try { entry.mgr.dispose() } catch { /* already dead */ }
        managers.delete(def.id)
        return ensure(def, waitMs)
      }
    }
    return ok && entry.mgr.isReady() ? entry.mgr : null
  }

  const resolve = (filePath: string): LspServerDef | null => serverForFile(filePath, which)

  return {
    async initialize(): Promise<void> {
      // Lazy: servers spawn on first matching file. Nothing to do eagerly.
    },
    isReady(): boolean {
      // Ready when at least one server is installed; per-file readiness is
      // resolved at call time.
      return getAvailable().length > 0
    },
    supportsDefinition(): boolean {
      return getAvailable().length > 0
    },
    supportsReferences(): boolean {
      return getAvailable().length > 0
    },
    async gotoDefinition(filePath: string, line: number, character: number): Promise<Location[]> {
      const def = resolve(filePath)
      if (!def) return []
      const mgr = await ensure(def)
      return mgr ? mgr.gotoDefinition(filePath, line, character) : []
    },
    async findReferences(filePath: string, line: number, character: number): Promise<Location[]> {
      const def = resolve(filePath)
      if (!def) return []
      const mgr = await ensure(def)
      return mgr ? mgr.findReferences(filePath, line, character) : []
    },
    changeFile(filePath: string): void {
      const def = resolve(filePath)
      if (!def) return
      void ensure(def).then(mgr => mgr?.changeFile(filePath)).catch(() => { /* best-effort */ })
    },
    async getFileDiagnostics(filePath: string, timeoutMs?: number): Promise<LspDiagnostic[]> {
      const def = resolve(filePath)
      if (!def) return []
      // Post-edit diagnostics are best-effort: wait at most the diagnostic
      // budget for the server to become ready, then continue without LSP.
      // A slow cold start no longer blocks the tool result (2026-09-08 wedge).
      const readyWaitMs = Math.min(timeoutMs ?? LSP_DIAGNOSTIC_READY_WAIT_MS, initializeTimeoutMs)
      const mgr = await ensure(def, readyWaitMs)
      return mgr ? mgr.getFileDiagnostics(filePath, timeoutMs) : []
    },
    dispose(): void {
      for (const { mgr } of managers.values()) {
        try { mgr.dispose() } catch { /* best-effort */ }
      }
      managers.clear()
    },
  }
}
