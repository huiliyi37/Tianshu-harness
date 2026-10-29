import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { open, readFile, unlink } from 'node:fs/promises'
import { ArtifactStore } from '../artifact/store.js'
import { spawnGitSync } from '../tools/spawn-git.js'
import { OfficialError } from '../models/official-contract.js'
import type { CompactionConfig } from '../compact/constants.js'
import { WorktreeCoordinator } from './worktree-coordinator.js'
import { getCurrentGitRef, revParseHead } from './worktree.js'
import { collectDiff, formatDiffArtifact } from './diff-collector.js'
import {
  buildBlockedWorkerResult,
  parseWorkerResult,
  salvageWorkerResult,
  type WorkOrder,
  type WorkerResult,
} from './work-order.js'
import { buildWorkerPrompt } from './worker-prompts.js'
import {
  applyWriteGateToResult,
  evaluateWorkerWriteGate,
  workerWriteGateEnabled,
  type EvaluateWorkerWriteGateInput,
  type WorkerWriteGateReport,
} from './worker-write-gate.js'
import { provisionSnapshotDeps } from './snapshot-deps.js'
import { buildWorkerKnowledgeBlock } from './worker-knowledge.js'
import { buildDomainKnowledgeBlock } from './domain-knowledge-block.js'
import type { DomainKnowledgeStore } from './domain-knowledge-store.js'
import { materializeScope } from './worktree-scope.js'
import type { AgentCallbacks } from './loop-types.js'
import type { Usage } from '../api/types.js'

function worktreeScopeFiles(order: WorkOrder): string[] {
  const changed = order.scope.files ?? []
  const explicitlyReadable = changed.filter(file => !file.startsWith('src/'))
  return explicitlyReadable
}

function buildHandsPrompt(config: HandsSessionConfig): string {
  const knowledgeBlocks = [
    config.activeClaims ? buildWorkerKnowledgeBlock(config.activeClaims) : '',
    config.domainKnowledgeStore && config.order.authority
      ? buildDomainKnowledgeBlock(config.domainKnowledgeStore, config.order.authority)
      : '',
  ].filter(Boolean)
  return [...knowledgeBlocks, buildWorkerPrompt(config.order, undefined, { ledgerCwd: config.cwd })].join('\n\n')
}

/**
 * 额外轮次的运行意图。调用方（coordinator）用它决定这一轮是「重开一个 worker
 * 会话」还是「让同一个 worker 接着上一轮的对话往下走」——`prompt` 参数在
 * coordinator 那侧是走不通的，它按 order 重建 worker prompt，所以续跑的目标
 * 必须以结构化字段递过去。
 */
export interface HandsRunAgentOptions {
  /** 覆盖本轮的 objective（续跑用）。 */
  objective?: string
  /** 承接上一轮的会话消息，而不是从零重来。 */
  continueSession?: boolean
}

export interface HandsSessionConfig {
  order: WorkOrder
  wtCoordinator: WorktreeCoordinator
  cwd: string
  maxTurns: number
  contextWindow: number
  compact: CompactionConfig
  activeClaims?: import('../context/claims.js').ContextClaim[]
  /** V3 Component B: optional per-domain lessons recalled into worker prompt. */
  domainKnowledgeStore?: DomainKnowledgeStore
  /** Base git ref to diff worker changes against. Defaults to current branch/HEAD of cwd. */
  baseRef?: string
  /** Shared-worktree mode: when true, the worker runs directly in `cwd` (the
   *  controller's single shared worktree/branch) instead of spawning its own
   *  git worktree. Orthogonal shards write disjoint files; the file-claim
   *  registry + same-file wave serialization prevent stomping. No per-worker
   *  isolated diff is collected — the controller reads aggregate git diff on the
   *  shared workspace. Reuses the same code path as the git-absent in-place
   *  fallback. */
  sharedWorkspace?: boolean
  /** Optional artifact store to persist the worker diff for independent review.
   *  When provided, the diff is saved (into the worker's fallback session) and the
   *  resulting artifactId is attached to the WorkerResult, so the UI can fetch it.
   *  Persistence failure is non-fatal — diffArtifactId is left undefined and the
   *  diff still travels in result.artifacts as before. */
  artifactStore?: {
    save(input: { tool: string; target: string; rawContent: string; summary: string; sections?: unknown[] }): Promise<string>
    saveDurable?(input: { tool: string; target: string; rawContent: string; summary: string; sections: [] }): Promise<string>
  }
  /**
   * Run the worker agent in the worktree.
   * Receives the worker prompt and AgentCallbacks; returns the full text output
   * which must contain a schema-valid WorkerResult JSON.
   */
  runAgent: (
    prompt: string,
    callbacks: AgentCallbacks,
    workerCwd: string,
    options?: HandsRunAgentOptions,
  ) => Promise<string>
  /** 工作树内补偿轮的阶段播报（续跑）。派发侧把它接到 worker 的活动上行通道，
   *  面板才能显示「续跑 1/2」，否则写工续跑期间外面只看到一段沉默。 */
  onLifecycle?: (detail: string) => void
  /** W4-D1: injectable write-gate evaluator (tests). Defaults to the real wave-gate wrapper. */
  evaluateWriteGate?: (input: EvaluateWorkerWriteGateInput) => Promise<WorkerWriteGateReport>
  /** W4-D1: override gate enablement (tests). Defaults to the env kill switch. */
  writeGateEnabled?: boolean
}

export interface HandsSessionRun {
  result: WorkerResult
  usage: Partial<Usage>
  /** 本次 hands 会话（首轮+续跑+修复各轮累计）的工具调用数——预算回馈的实际
   *  用量信号（预算发准，2026-08-18）。 */
  toolUses?: number
  /** W4-D1: main-side write-gate outcome, when the gate ran (write workers only). */
  writeGate?: { report: WorkerWriteGateReport; repairCount: number }
}

/**
 * Execute a write-capable worker in an isolated git worktree.
 *
 * Lifecycle:
 * 1. Create a worktree for the worker
 * 2. Run the agent with the worker prompt
 * 3. Parse the WorkerResult from the agent's output
 * 4. Collect git diff from the worktree and attach as artifact
 * 5. Clean up the worktree (always, even on failure)
 */
export async function runHandsSession(config: HandsSessionConfig): Promise<HandsSessionRun> {
  let wt: { path: string; branch?: string }
  let inPlace = false
  if (config.sharedWorkspace) {
    // Shared-worktree mode: run directly in the controller's single shared cwd.
    // No per-worker worktree, no isolated diff. Only sound when the write scopes
    // are disjoint from the primary's — the caller establishes that through the
    // isolation policy (isolation-policy.ts), not through a global switch. Note
    // that the file-claim registry is NOT the guarantee here: it is keyed by
    // session id, and workers claim under the primary's session id, so
    // same-session workers never block one another (see
    // .rivet/plans/worker-isolation-design.md §3).
    wt = { path: config.cwd }
    inPlace = true
  } else {
    // Isolated mode: this worker's write scope overlaps the primary's (review /
    // patch workers write the very files the primary just committed), so it must
    // NOT run in the primary worktree. The caller picks this branch through the
    // isolation policy (isolation-policy.ts), not through a global switch.
    try {
      wt = await config.wtCoordinator.create(config.order.id)
    } catch (err) {
      // Two failure classes, deliberately split apart:
      //  · structurally unavailable (cwd is not a git repo) — isolation was never
      //    possible here, and this is the long-standing no-git graceful
      //    degradation (hands-session.test.ts "runs in-place (no worktree) when
      //    git is unavailable"). The user has no git worktree to pollute.
      //  · transient/local failure inside a git repo (.git/worktrees lock
      //    contention, permissions, disk) — isolation should have worked. A
      //    silent in-place fallback is exactly how a review patcher ends up
      //    rewriting the user's working tree (worker-isolation-design.md §2.3)
      //    → abstain and report; never guess.
      if (!revParseHead(config.cwd)) {
        wt = { path: config.cwd }
        inPlace = true
      } else {
        return {
          result: buildBlockedWorkerResult(
            config.order,
            `Worktree isolation unavailable — refusing to run in the primary worktree: ${err instanceof Error ? err.message : String(err)}`,
            'policy_short_circuit',
          ),
          usage: {},
        }
      }
    }
  }
  config.order.workerCwd = wt.path
  const recoveryGit = (args: string[], input?: string): string => {
    const result = spawnGitSync(args, { cwd: wt.path, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 64 * 1024 * 1024, input })
    if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string') throw new Error('Worker recovery Git operation failed')
    return result.stdout
  }
  let recoveryBase: string | undefined
  if (!inPlace) {
    try { const base = recoveryGit(['rev-parse', '--verify', 'HEAD']).trim(); if (/^[a-f0-9]{40,64}$/.test(base)) recoveryBase = base } catch {}
  }
  let retainWorktree = false
  let officialRefusal: OfficialError | undefined
  const recoverySession = `worker-recovery-${createHash('sha256').update(config.order.id).digest('hex').slice(0, 16)}`
  const recoveryCheckpoint = join(config.cwd, '.rivet', 'worker-recovery', recoverySession)
  const protectedRecoveryStore = () => new ArtifactStore(join(config.cwd, '.rivet', 'worker-recovery'), recoverySession)
  const fallbackRecoveryStore = () => new ArtifactStore(join(config.cwd, '.rivet', 'artifacts'), recoverySession)
  try {
    const scopeResult = materializeScope(config.cwd, wt.path, worktreeScopeFiles(config.order))
    // Only block on genuinely unreachable scope entries (path escape / outside
    // repo). Files that don't exist yet in base (toBeCreated) are expected for
    // new-file-creating tasks — the worker will create them. T1 fix, 2026-07-29.
    if (scopeResult.missing.length > 0) {
      return {
        result: buildBlockedWorkerResult(
          config.order,
          `Worker scope file(s) are outside the project: ${scopeResult.missing.join(', ')}`,
        ),
        usage: {},
     }
   }
    let text = ''
    let apiError: string | undefined
    let officialFailure: OfficialError | undefined
    let turnUsage: Partial<Usage> = {}
    // 首轮之外的 agent 轮次总账——执行续跑 / 写闸门修复共用，避免叠乘。
    // 预算回馈的实际用量信号：跨轮（首轮/续跑/修复）累计的工具调用数。
    let toolUses = 0

    text = await config.runAgent(buildHandsPrompt(config), {
      onTextDelta: (delta) => { text += delta },
      onThinkingDelta: () => {},
      onToolUse: () => { toolUses++ },
      onToolResult: () => {},
      onTurnComplete: (usage) => { turnUsage = usage },
      onError: (err) => { apiError = err.message; if (err instanceof OfficialError) officialFailure = err },
      onAbort: () => { apiError = 'aborted' },
      onApprovalRequired: async () => false,
   }, wt.path)

    if (officialFailure) throw officialFailure
    if (apiError) {
      return {
        result: buildBlockedWorkerResult(config.order, apiError),
        usage: turnUsage,
     }
   }

    let result: WorkerResult
    try {
      result = parseWorkerResult(text, config.order.id)
   } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError)
      // Local salvage keeps partial evidence; it never starts another model request.
      result = salvageWorkerResult(text, config.order.id)
        ?? buildBlockedWorkerResult(config.order, message, 'json_parse')
   }

    // ── W4-D1: main-side write gate ──────────────────────────────────────
    // Workers self-report verification, but the main controller re-runs it
    // against the worker's actual tree (reusing wave-gate: scoped typecheck +
    // whitelisted declared command). A failed or blocked gate is terminal.
    let writeGate: HandsSessionRun['writeGate']
    const gateOn = config.writeGateEnabled ?? workerWriteGateEnabled()
    if (gateOn && result.changedFiles.length > 0 && result.status !== 'blocked' && !apiError) {
      const evaluate = config.evaluateWriteGate ?? evaluateWorkerWriteGate
      // Isolated worktrees lack node_modules/tsconfig links — provision them so
      // the scoped typecheck is runnable (best-effort; failure → gate blocked).
      if (!inPlace) {
        try { provisionSnapshotDeps(config.cwd, wt.path) } catch { /* gate will report unverifiable */ }
      }
      const report = await evaluate({ cwd: wt.path, result })
      const repairCount = 0
      result = applyWriteGateToResult(result, report, repairCount)
      writeGate = { report, repairCount }
    }

    if (result.status !== 'passed' || apiError || result.failureReason) result = { ...result, terminalFailure: true }

    // Collect diff only when running in a real worktree (in-place mode has no
    // isolated worktree and no base ref, so diff is meaningless). Collected
    // AFTER the write gate so the result and diff describe the same tree.
    const baseRef = inPlace ? undefined : (config.baseRef ?? getCurrentGitRef(config.cwd))
    // Materialized scope files are inputs copied from the base repo, not worker
    // output — exclude them so the patch applies back onto the base repo.
    const diff = baseRef ? collectDiff(config.cwd, wt.path, baseRef, scopeResult.materialized) : ''

    if (diff) {
      result.artifacts.push(formatDiffArtifact(diff, config.order.profile))
      // Persist the diff so the UI can review it independently. Saved into the
      // worker's fallback session (worker-<orderId>); fetchable by artifactId.
      // Failure is non-fatal: diffArtifactId stays undefined, diff still in artifacts.
      if (config.artifactStore) {
        try {
          result.diffArtifactId = await config.artifactStore.save({
            tool: 'hands_session',
            target: config.order.id,
            rawContent: diff,
            summary: `Patch: ${config.order.profile ?? 'worker'}`,
          })
        } catch {
          // 落盘失败（磁盘满/store 未注入正确 session 等）— 降级，前端隐藏 diff 入口
        }
      }
    }

    return { result, usage: turnUsage, ...(toolUses > 0 ? { toolUses } : {}), writeGate }
 } catch (error) {
    if (error instanceof OfficialError) {
      officialRefusal = error
      if (!inPlace) {
        retainWorktree = true
        let restartProtected = false
        const markerPath = join(wt.path, '.vsw-owner.json')
        const syncDirectory = async () => {
          if (process.platform === 'win32') return
          const directory = await open(wt.path, 'r')
          try { await directory.sync() } finally { await directory.close() }
        }
        const checkedMarker = async () => {
          const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { sessionId?: unknown; retainedForRecovery?: unknown; pid?: unknown }
          return marker.sessionId === config.order.id && marker.retainedForRecovery === true && typeof marker.pid !== 'number'
        }
        try {
          const marker = await open(markerPath, 'w')
          try {
            await marker.writeFile(JSON.stringify({ sessionId: config.order.id, retainedForRecovery: true }))
            await marker.sync()
          } finally { await marker.close() }
          await syncDirectory()
          if (!await checkedMarker()) throw new Error('Worker recovery marker verification failed')
          restartProtected = true
        } catch {
          try {
            try { await unlink(markerPath) } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
            await syncDirectory()
            try { restartProtected = await checkedMarker() } catch (error) {
              restartProtected = (error as NodeJS.ErrnoException).code === 'ENOENT'
            }
          } catch {}
        }
        try {
          if (!recoveryBase) throw new Error('Worker recovery base unavailable')
          const ignored = recoveryGit(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
          const submodules = recoveryGit(['submodule', 'status'])
          const entries = recoveryGit(['ls-files', '--stage'])
          const paths = ['--', '.', ':(exclude).vsw-owner.json']
          recoveryGit(['-c', 'core.autocrlf=false', 'add', '-A', ...paths])
          const attributes = recoveryGit(['check-attr', '--all', '-z', '--stdin'], recoveryGit(['ls-files', '-z']))
          const incomplete = !restartProtected || ignored.length > 0 || submodules.trim().length > 0 || /^160000 /m.test(entries) || attributes.length > 0
          const patch = recoveryGit(['diff', '--cached', '--binary', '--full-index', recoveryBase, ...paths])
          const store = config.artifactStore?.saveDurable ? config.artifactStore : fallbackRecoveryStore()
          const snapshot = {
            tool: 'hands_recovery', target: config.order.id, summary: `Worker recovery: ${config.order.id}`, sections: [] as [],
            rawContent: JSON.stringify({ version: 1, workOrderId: config.order.id, baseCommit: recoveryBase, worktreePath: wt.path, branch: wt.branch, retainedWorktree: incomplete, restartProtected, recoveryCheckpoint, patch }),
          }
          await protectedRecoveryStore().saveDurable(snapshot)
          await store.saveDurable!(snapshot)
          retainWorktree = incomplete
        } catch {
          try {
            const retained = { tool: 'hands_recovery', target: config.order.id, summary: `Retained worker worktree: ${config.order.id}`, sections: [] as [], rawContent: JSON.stringify({ version: 1, workOrderId: config.order.id, baseCommit: recoveryBase, worktreePath: wt.path, branch: wt.branch, retainedWorktree: true, restartProtected, recoveryCheckpoint }) }
            await protectedRecoveryStore().saveDurable(retained)
            await fallbackRecoveryStore().saveDurable(retained)
          } catch {}
        }
      }
    }
    throw error
 } finally {
    if (!retainWorktree) {
      if (officialRefusal) {
        try { await config.wtCoordinator.remove(config.order.id) } catch {}
      } else await config.wtCoordinator.remove(config.order.id)
    }
 }
}
