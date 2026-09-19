import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { gitStatusCache } from './volatile-git.js'
import { summarizeGitStatus } from './git-status-summary.js'
import { loadProjectMemory } from '../context/project-memory-loader.js'
import { loadKnowledgeManifestBlock } from '../context/knowledge-manifest.js'
import { renderResidentCapsuleBlock } from '../agent/seed-capsule-store.js'
import { generateCodebaseIndexBlock, getHeadSha } from '../repo/codebase-index.js'
import { detectCwdRelation } from './self-recognition.js'
import type { VolatileContext } from './volatile.js'
import { standardPromptBlocks, type PromptBlockPolicy } from './block-policy.js'
import { projectInstructionsAllowed } from '../config/project-trust.js'

export interface SnapshotInput {
  cwd: string
  /** 前缀块策略（缺省 = standard，与历史行为逐字节一致）。
   *  只作用于参考类块；行为护栏不受它影响，见 block-policy.ts。 */
  blockPolicy?: PromptBlockPolicy
  getGitStatus?: () => string | undefined
  rivetMd?: string
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

  const workingSet = input.workingSet
    ? Object.freeze([...input.workingSet])
    : undefined

  // 缺省 standard —— 无 policy 的调用方（worker / 测试 / sidecar 早期路径）
  // 必须拿到与历史版本逐字节一致的快照。
  const policy = input.blockPolicy ?? standardPromptBlocks()

  // 显式传入的块（调用方已备好内容）不受档位开关影响——档位只管「自动加载什么」，
  // 不越权丢弃调用方明确要求注入的内容。
  const projectMemoryBlock = input.projectMemoryBlock
    ?? (policy.blocks.projectMemory ? loadProjectMemory(input.cwd).content : undefined)

  // Wave 4b（知识重构）：manifest 路由地图——"何时该召回什么"的索引，
  // 会话启动快照一次，进 frozen base，知识本文一律走 recall。
  const knowledgeManifestBlock = input.knowledgeManifestBlock
    ?? (policy.blocks.knowledgeManifest ? loadKnowledgeManifestBlock(input.cwd) : undefined)

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
