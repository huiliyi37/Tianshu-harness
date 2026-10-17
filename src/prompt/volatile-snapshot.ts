import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { gitStatusCache } from './volatile-git.js'
import type { GitStatusCache } from './volatile-git.js'
import { summarizeGitStatus } from './git-status-summary.js'
import { loadProjectMemory } from '../context/project-memory-loader.js'
import { loadKnowledgeManifestBlock } from '../context/knowledge-manifest.js'
import { renderResidentCapsuleBlock } from '../agent/seed-capsule-store.js'
import { generateCodebaseIndexBlock, getHeadSha } from '../repo/codebase-index.js'
import { detectCwdRelation } from './self-recognition.js'
import type { VolatileContext } from './volatile.js'
import { standardPromptBlocks, type PromptBlockPolicy } from './block-policy.js'
import { projectInstructionsAllowed, projectStateAllowed } from '../config/project-trust.js'
import { loadUserInstructionsBlock } from '../config/user-instructions.js'

export interface SnapshotInput {
  cwd: string
  /** 前缀块策略（缺省 = standard，与历史行为逐字节一致）。
   *  只作用于参考类块；行为护栏不受它影响，见 block-policy.ts。 */
  blockPolicy?: PromptBlockPolicy
  getGitStatus?: () => string | undefined
  rivetMd?: string
  globalInstructionsBlock?: string
  sessionMemoryBlock?: string
  workingSet?: string[]
  activeDomain?: VolatileContext['activeDomain']
  projectMemoryBlock?: string
  /** Optional pre-built knowledge manifest routing block（Wave 4b）。 */
  knowledgeManifestBlock?: string
  /** Optional pre-built codebase index block. If not provided, generated from MeridianDB. */
  projectIndexBlock?: string
  /** Optional MeridianDb instance for codebase index generation. */
  meridianDb?: import('../repo/meridian-db.js').MeridianDb
  /** 新鲜度判定用的 git 状态缓存（createVolatileSnapshotFresh 专用；
   *  createVolatileSnapshot 不读它——历史行为逐字节一致）。 */
  gitCache?: GitStatusCache
}

function readRivetMdOnce(cwd: string): string | undefined {
  // #218 信任门：与 volatile.ts:readRivetMd 同一契约——未受信目录不读不注入。
  // 这是生产主路径（create-agent-config → createVolatileSnapshot）；门缺失时
  // volatile.ts 的 readRivetMd 会兜底读到未受信内容，故两处都必须挡。
  if (!projectInstructionsAllowed(cwd)) return undefined
  // Load AGENTS.md (architecture map) + .rivet.md (operating manual)
  const parts: string[] = []
  const agentsPath = join(cwd, 'AGENTS.md')
  const rivetPath = join(cwd, '.rivet.md')
  try {
    if (existsSync(agentsPath)) parts.push(readFileSync(agentsPath, 'utf-8'))
  } catch { /* ignore */ }
  try {
    if (existsSync(rivetPath)) parts.push(readFileSync(rivetPath, 'utf-8'))
  } catch { /* ignore */ }
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

export function createVolatileSnapshot(input: SnapshotInput): VolatileContext {
  const rawGit = input.getGitStatus
    ? input.getGitStatus()
    : gitStatusCache.get(input.cwd)
  const gitStatus = rawGit ? summarizeGitStatus(rawGit) : undefined

  const rivetMd = input.rivetMd ?? readRivetMdOnce(input.cwd)
  const globalInstructionsBlock = input.globalInstructionsBlock ?? loadUserInstructionsBlock()

  const workingSet = input.workingSet
    ? Object.freeze([...input.workingSet])
    : undefined

  // 缺省 standard —— 无 policy 的调用方（worker / 测试 / sidecar 早期路径）
  // 必须拿到与历史版本逐字节一致的快照。
  const policy = input.blockPolicy ?? standardPromptBlocks()

  // 显式传入的块（调用方已备好内容）不受档位开关影响——档位只管「自动加载什么」，
  // 不越权丢弃调用方明确要求注入的内容。
  // 自动加载过 #218 信任门的 .rivet 状态面扩展（projectStateAllowed，2026-10-03
  // 安全报告链 A/B）：memory/manifest 随仓库分发，未受信目录不读不注入。
  const projectMemoryBlock = input.projectMemoryBlock
    ?? (policy.blocks.projectMemory && projectStateAllowed(input.cwd)
      ? loadProjectMemory(input.cwd).content
      : undefined)

  // Wave 4b（知识重构）：manifest 路由地图——"何时该召回什么"的索引，
  // 会话启动快照一次，进 frozen base，知识本文一律走 recall。
  const knowledgeManifestBlock = input.knowledgeManifestBlock
    ?? (policy.blocks.knowledgeManifest && projectStateAllowed(input.cwd)
      ? loadKnowledgeManifestBlock(input.cwd)
      : undefined)

  // 常驻注入的是 gist 索引，不是正文（943414c2）：每星一行摘要进 frozen，
  // 完整方法论经 recall_capsule 按需拉取。行为护栏本身不在这里——V3.1
  // (0c776b9→17b496a) 证明护栏撤成按需召回会漂移，因此已蒸馏进 static.ts
  // 的 evidence-scope / external-source-verification / delivery-contract。
  // 改动此处前先确认要撤的是「参考资料」而非「刹车」。
  const seedCapsuleBlock = policy.blocks.seedCapsule
    ? renderResidentCapsuleBlock(input.cwd, policy.capsuleIndexLimit)
    : undefined

  // Codebase index — generated from MeridianDB at snapshot time.
  // Frozen: placed in stable prefix alongside projectMemoryBlock.
  const projectIndexBlock = input.projectIndexBlock ?? (
    input.meridianDb && policy.blocks.codebaseIndex
      ? generateCodebaseIndexBlock(input.meridianDb, getHeadSha())
      : undefined
  )

  return Object.freeze({
    cwd: input.cwd,
    blockCaps: policy.caps,
    blockToggles: policy.blocks,
    cwdRelation: detectCwdRelation(input.cwd),
    rivetMd,
    globalInstructionsBlock,
    gitStatus,
    workingSet,
    activeDomain: input.activeDomain ?? undefined,
    sessionMemoryBlock: input.sessionMemoryBlock,
    projectMemoryBlock,
    knowledgeManifestBlock,
    seedCapsuleBlock,
    projectIndexBlock,
  }) as VolatileContext
}

/**
 * 带新鲜度判定的会话启动快照（生产主路径，create-agent-config 使用）。
 *
 * 不变量：冻结的 git 快照要么新鲜（≤TTL）要么不存在，绝不冻结陈旧值。
 * 背景（2026-10-11 注入快照滞后事故）：gitStatusCache.get() 同步且不查 TTL，
 * 常驻进程（桌面 sidecar）空闲数小时后新建会话，会把上次缓存值（可任意旧，
 * 甚至落在 detached HEAD 等异常窗口）原样冻进会话首屏，而首 2 条用户消息
 * 没有任何解冻路径（engine.ts 的 refreshGit 需 userMessagesSinceGitRefresh
 * >= 3 或 markGitDirty 写类工具）。冷进程反而首轮就准——ctx.gitStatus 为
 * undefined 时 volatile.ts 的 `ctx.gitStatus ?? gitStatusCache.get(ctx.cwd)`
 * 会在轮边界 refreshIfStale 刷新缓存后读到新值。本函数把冷进程的语义
 * 推广到热进程：陈旧缓存 → 冻结 undefined，走同一条回落路径。
 *
 * 缓存安全：git 块只进 dynamic appendix（末位 user 消息 trailer，请求最尾），
 * 不进冻结前缀；会话首条消息前不存在旧前缀，无缓存可碎。
 */
export function createVolatileSnapshotFresh(input: SnapshotInput): VolatileContext {
  if (input.getGitStatus) return createVolatileSnapshot(input)

  const cache = input.gitCache ?? gitStatusCache
  if (!cache.isFreshAt(input.cwd)) {
    return createVolatileSnapshot({ ...input, getGitStatus: () => undefined })
  }
  // 新鲜路径：显式取注入缓存（或全局缓存）的当前值冻结——不能裸调
  // createVolatileSnapshot(input)，否则值会从全局缓存另读一份，与
  // isFreshAt 判定的缓存不一致（测试注入 gitCache 时即暴露该分叉）。
  return createVolatileSnapshot({ ...input, getGitStatus: () => cache.get(input.cwd) })
}
