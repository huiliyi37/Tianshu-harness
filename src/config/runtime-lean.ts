/**
 * Runtime lean profile — single switch that expands into existing resource knobs.
 *
 * Resolution: `RIVET_LEAN=1|0` (env wins) → `runtime.lean` in project then user config.
 * Expansions (only when caller has not set an explicit value) live in the
 * respective resolvers: prompt profile → lean, maxWorkers → 1, embeddings off,
 * Meridian startup backfill off, tighter session pool, constellation/companion/
 * dream hooks off.
 * （tools aspect 已退出：2026-09-23 起装配默认档恒为 minimal，lean 与否同值。）
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { userConfigPath } from './paths.js'

export const LEAN_MAX_LOADED_SESSIONS = 4
export const LEAN_IDLE_AGENT_TTL_MS = 10 * 60_000
export const DEFAULT_MAX_LOADED_SESSIONS = 16
export const DEFAULT_IDLE_AGENT_TTL_MS = 30 * 60_000
/** Disk cap for desktop events.jsonl (non-lean). */
export const DEFAULT_MAX_EVENTS_DISK_BYTES = 50 * 1024 * 1024
/** Tighter disk cap under lean. */
export const LEAN_MAX_EVENTS_DISK_BYTES = 10 * 1024 * 1024

// ── 单一真相源 ──────────────────────────────────────────────
// 下方三个 MIN_* 是 schema/manager/UI 三层校验的唯一下限来源——曾经分散在
// 三处手写（schema.min() / manager 抛错 / settings intField.min），审查中
// maxEventsDiskBytes 已漂移过一次（UI min=1 vs 校验 1M）。所有下限校验必须
// 引用这里，不得另写魔法数字。
export const MIN_MAX_LOADED_SESSIONS = 1
export const MIN_IDLE_AGENT_TTL_MS = 0
export const MIN_MAX_EVENTS_DISK_BYTES = 1_000_000

/** 按 lean 生效值解析阈值默认——settings 层 load/get 的唯一回落口径（替代
 *  settings-model / settings-persist / resolveSessionPoolOptions 三处各写的
 *  `(lean ? LEAN_X : DEFAULT_X)` 三元）。 */
export function resolveLeanDefaults(lean: boolean): SessionPoolOptions {
  return {
    maxLoadedSessions: lean ? LEAN_MAX_LOADED_SESSIONS : DEFAULT_MAX_LOADED_SESSIONS,
    idleAgentTtlMs: lean ? LEAN_IDLE_AGENT_TTL_MS : DEFAULT_IDLE_AGENT_TTL_MS,
    maxEventsDiskBytes: lean ? LEAN_MAX_EVENTS_DISK_BYTES : DEFAULT_MAX_EVENTS_DISK_BYTES,
  }
}

/** 校验 lean 切片字段（lean/三阈值）。下限引用 MIN_* 常量——schema 与 manager
 *  的唯一校验来源，消除手写 `< N` 抛错。`prefix` 用于错误消息定位（如
 *  'domains.changgeng' 或空串）。非 lean 字段（toolPreset 等）由调用方自校验。 */
export function validateRuntimeLeanSlice(
  slice: Record<string, unknown>,
  prefix = '',
): void {
  const p = prefix ? `${prefix}.` : ''
  if (slice.lean !== undefined && typeof slice.lean !== 'boolean') {
    throw new Error(`${p}lean must be a boolean`)
  }
  if (slice.maxLoadedSessions !== undefined
    && (typeof slice.maxLoadedSessions !== 'number' || !Number.isInteger(slice.maxLoadedSessions) || slice.maxLoadedSessions < MIN_MAX_LOADED_SESSIONS)) {
    throw new Error(`${p}maxLoadedSessions must be an integer >= ${MIN_MAX_LOADED_SESSIONS}`)
  }
  if (slice.idleAgentTtlMs !== undefined
    && (typeof slice.idleAgentTtlMs !== 'number' || !Number.isInteger(slice.idleAgentTtlMs) || slice.idleAgentTtlMs < MIN_IDLE_AGENT_TTL_MS)) {
    throw new Error(`${p}idleAgentTtlMs must be an integer >= ${MIN_IDLE_AGENT_TTL_MS}`)
  }
  if (slice.maxEventsDiskBytes !== undefined
    && (typeof slice.maxEventsDiskBytes !== 'number' || !Number.isInteger(slice.maxEventsDiskBytes) || slice.maxEventsDiskBytes < MIN_MAX_EVENTS_DISK_BYTES)) {
    throw new Error(`${p}maxEventsDiskBytes must be an integer >= ${MIN_MAX_EVENTS_DISK_BYTES}`)
  }
}

export interface RuntimeLeanConfigSlice {
  lean?: boolean
  maxLoadedSessions?: number
  idleAgentTtlMs?: number
  maxEventsDiskBytes?: number
}

/** 域级 runtime 覆盖（runtime.domains[domainId]），含工具档位。 */
export interface RuntimeDomainConfigSlice extends RuntimeLeanConfigSlice {
  toolPreset?: 'minimal' | 'frontend' | 'full' | 'taiyi'
}

interface RuntimeSection {
  runtime?: RuntimeLeanConfigSlice & { domains?: Record<string, RuntimeDomainConfigSlice> }
}

function findProjectConfigPath(startDir: string): string | undefined {
  let dir = resolve(startDir)
  for (let i = 0; i < 20; i++) {
    const candidate = join(dir, '.rivet-config.json')
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function readRuntimeSection(path: string): RuntimeLeanConfigSlice | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as RuntimeSection
    const section = raw.runtime
    if (!section || typeof section !== 'object') return null
    return section
  } catch {
    return null
  }
}

/** Effective lean flag. Env overrides config; project overrides user. */
export function isRuntimeLean(configLean?: boolean, cwd?: string): boolean {
  if (process.env.RIVET_LEAN === '1') return true
  if (process.env.RIVET_LEAN === '0') return false
  if (configLean === true) return true
  if (configLean === false) return false

  if (cwd) {
    const projectPath = findProjectConfigPath(cwd)
    if (projectPath) {
      const project = readRuntimeSection(projectPath)
      if (project?.lean === true) return true
      if (project?.lean === false) return false
    }
  }

  const user = readRuntimeSection(userConfigPath())
  if (user?.lean === true) return true
  // 2026-08-09 产品决策：删除 RIVET_LEAN_AUTO 最后回退——不再按内存自动降级，
  // 8GB 机器默认全功能；低内存由桌面端弹一次性引导，用户自主选择开启。
  return false
}

/** Per-aspect lean knobs selectable via `RIVET_LEAN_ASPECT=tools,prompt,…`.
 *  Resolution order: `RIVET_LEAN` (global master switch, wins) →
 *  `RIVET_LEAN_ASPECT` (explicit aspect list) → original config/env chain.
 *  Semantics stay with the caller: prompt preset treats lean as a fallback
 *  ("explicit setting wins"), embeddings/meridian/pool treat it as a hard off.
 *  tools 已退出（2026-09-23：装配默认档恒 minimal，aspect 列出 tools 是 no-op）。 */
export type LeanAspect = 'tools' | 'prompt' | 'embeddings' | 'meridian' | 'pool'

export function isRuntimeLeanAspect(
  aspect: LeanAspect,
  configLean?: boolean,
  cwd?: string,
): boolean {
  if (process.env.RIVET_LEAN === '1') return true
  if (process.env.RIVET_LEAN === '0') return false
  const aspectEnv = process.env.RIVET_LEAN_ASPECT
  if (aspectEnv !== undefined && aspectEnv.trim() !== '') {
    return aspectEnv
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .includes(aspect)
  }
  return isRuntimeLean(configLean, cwd)
}

export interface SessionPoolOptions {
  maxLoadedSessions: number
  idleAgentTtlMs: number
  maxEventsDiskBytes: number
}

/** Resolve session residency / events disk caps from runtime config + lean.
 *  显式配置值优先，缺省回落 `resolveLeanDefaults(lean)`。 */
export function resolveSessionPoolOptions(
  runtime: RuntimeLeanConfigSlice | undefined,
  lean: boolean,
): SessionPoolOptions {
  const defaults = resolveLeanDefaults(lean)
  return {
    maxLoadedSessions: runtime?.maxLoadedSessions ?? defaults.maxLoadedSessions,
    idleAgentTtlMs: runtime?.idleAgentTtlMs ?? defaults.idleAgentTtlMs,
    maxEventsDiskBytes: runtime?.maxEventsDiskBytes ?? defaults.maxEventsDiskBytes,
  }
}

/**
 * 域级 runtime 覆盖（2026-08-04）：`defaultDomain` 钉定某域时，该域在
 * `runtime.domains[domainId]` 下的 lean/阈值/工具档位覆盖全局 runtime 值。
 * 返回 undefined = 该域无覆盖（调用方回退全局解析，保持既有行为）。
 *
 * 注意：只对「装配期可读的静态钉定域」生效（defaultDomain 配置或
 * 启动参数）；auto 关键词路由与运行期 /domain 切换发生在装配之后，
 * 工具指纹与 runtimeLean 已冻结——由调用方文档化取舍，本函数不处理。
 */
export function resolveDomainRuntimeConfig(
  domainId: string | undefined,
  runtime: (RuntimeLeanConfigSlice & { domains?: Record<string, RuntimeDomainConfigSlice> }) | undefined,
): RuntimeDomainConfigSlice | undefined {
  if (!domainId || !runtime?.domains) return undefined
  return runtime.domains[domainId]
}

/**
 * 按域生效的 lean 判定：域覆盖存在时用域值，否则回退全局。
 * env 主开关（RIVET_LEAN=1/0）恒优先——显式环境变量不被域配置覆盖。
 */
export function isRuntimeLeanForDomain(
  domainId: string | undefined,
  runtime: (RuntimeLeanConfigSlice & { domains?: Record<string, RuntimeDomainConfigSlice> }) | undefined,
  cwd?: string,
): boolean {
  if (process.env.RIVET_LEAN === '1') return true
  if (process.env.RIVET_LEAN === '0') return false
  const domainCfg = resolveDomainRuntimeConfig(domainId, runtime)
  if (domainCfg?.lean !== undefined) return domainCfg.lean
  return isRuntimeLean(runtime?.lean, cwd)
}
