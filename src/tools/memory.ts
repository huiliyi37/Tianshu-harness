/**
 * memory tool — unified context memory: recall (search) + remember (persist).
 *
 * Merges the former recall + remember tools into a single tool with a
 * discriminated action field. Both operate on the same context claim store;
 * recall additionally searches .rivet/knowledge/ markdown files.
 */

import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ContextClaimKind, ContextClaimScope } from '../context/claims.js'
import type { ToolDefinition } from '../api/types.js'
import type { MemoryKind } from '../memory/unified-memory.js'
import { getKnowledgeIndex } from '../memory/knowledge-index.js'
import { getRecallTracker } from '../memory/recall-efficacy.js'
import { renderGateFeedbackHint } from '../memory/gate-ledger.js'
import { readCommitFacts } from '../context/project-memory-writer.js'
import { tokenizeRecallQuery } from '../memory/query-terms.js'
import { createEmbeddingProvider, type EmbeddingProvider } from '../search/embedding-provider.js'
import {
  collectTranscriptCandidates, buildDeepRecallPrompt, parseDeepRecallOutput, renderDeepRecallText,
} from '../memory/deep-recall.js'

// ── recall helpers ──

const DEFINITION: ToolDefinition = {
  name: 'memory',
  description: `跨会话搜索并持久化项目知识。

### Actions
- recall: 对项目知识库做混合检索（结构化条目 + knowledge/*.md + playbook 教训）。支持 kind/topic/source 过滤；默认只返回当前有效的条目（已被取代的知识需要 includeHistory）。
- deep_recall: 跨历史会话**原文**的深召回——需要知识库里没有的细节（某次会话里的具体操作/报错/决定）时用；侧路蒸馏成答案 + 证据引用，原文不占上下文。费用高于 recall，优先 recall。
- remember: 持久化一条 claim（决策、观察、验证事实、失败模式或项目规则）。session 作用域立即生效；project 作用域先入队，由会话结束时的质量门禁准入——返回 "pending quality gate" 表示该 claim 已被记录，不要重试。

### Claim kinds（remember 用）
- decision — 已做出的架构或实现决策
- file_observation — 对特定文件的关键观察
- verification_fact — 测试结果或已验证的事实
- failure_pattern — 遇到的 bug 及其根因
- project_rule — 代码库中发现的模式或约定`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['recall', 'remember', 'recall_feedback', 'deep_recall'], description: 'recall: 搜索记忆；remember: 存储一条 claim；recall_feedback: 记录召回是否被采纳；deep_recall: 跨历史会话原文的深召回（侧路蒸馏，答案+证据引用）' },
      // recall params
      query: { type: 'string', description: '搜索关键词（对项目知识库做 BM25 + 结构化过滤的混合检索）。recall 必填。' },
      kind: { type: 'string', enum: ['user_constraint', 'user_preference', 'decision', 'file_observation', 'verification_fact', 'failure_pattern', 'security_finding', 'worker_finding', 'project_rule'], description: '按 claim 类型过滤' },
      topic: { type: 'string', description: 'recall 时按主题范围（模块/主题元数据）过滤' },
      source: { type: 'string', enum: ['playbook'], description: '把 recall 限制在特定来源。"playbook" 只返回蒸馏后的 playbook 教训。' },
      limit: { type: 'number', default: 5, description: '返回的最大结果数' },
      includeHistory: { type: 'boolean', default: false, description: '在 recall 结果中包含已被取代/过期的知识条目（默认：只返回当前有效条目）' },
      includeCommitFacts: { type: 'boolean', default: false, description: '在 recall 结果中包含历史 commit 事实（query 形如 commit hash 时自动启用）' },
      entryId: { type: 'string', description: 'recall_feedback 时的记忆 ID，可从 recall 结果中获得' },
      outcome: { type: 'string', enum: ['adopted', 'rejected', 'contradicted'], description: 'recall_feedback 时的评估结果' },
      // remember params
      text: { type: 'string', description: 'claim 文本——简洁具体（1-3 句）。remember 必填。' },
      scope: { type: 'string', enum: ['session', 'project'], default: 'session', description: '生命周期：session（随会话消亡）或 project（跨会话存活）' },
      confidence: { type: 'number', default: 0.9, description: '置信度 0-1。已验证事实用 0.9+，试探性观察用 0.5-0.7' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选分类标签' },
    },
    required: ['action'],
  },
}

export interface MemoryContext {
  sessionId: string
  getTurn: () => number
  cwd?: string
  /** Optional injection for tests/hosts; defaults to configured provider. */
  embeddingProvider?: EmbeddingProvider
  /** deep_recall 侧路 LLM 通道（宿主接线，同 essence-gate 廉价路由）；未接线时 deep_recall 报错降级。 */
  deepRecallComplete?: (prompt: string, timeoutMs: number) => Promise<string>
  /** 历史会话目录（getSessionDir(cwd)）；deep_recall 扫描范围。 */
  sessionDir?: string
  /** 剔除当前会话（避免把本会话原文又蒸馏回来）。 */
  excludeSessionId?: string
}

const REMEMBER_KINDS: ContextClaimKind[] = [
  'decision', 'file_observation', 'verification_fact',
  'failure_pattern', 'project_rule',
]

export function createMemoryTool(store: ContextClaimStore, ctx?: MemoryContext): Tool {
  const configuredEmbedder = ctx?.embeddingProvider ?? createEmbeddingProvider()
  const embedder = configuredEmbedder.isAvailable() ? configuredEmbedder : undefined
  return {
    definition: DEFINITION,

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const action = params.input.action

      if (action === 'recall') {
        const query = typeof params.input.query === 'string' ? params.input.query.trim() : ''
        if (!query) return { content: '错误：recall 需要提供 query', isError: true }

        const kind = typeof params.input.kind === 'string' ? params.input.kind as MemoryKind : undefined
        const topic = typeof params.input.topic === 'string' ? params.input.topic.trim() : undefined
        const limit = typeof params.input.limit === 'number' ? params.input.limit : 5
        const includeHistory = params.input.includeHistory === true
        const source = params.input.source === 'playbook' ? 'playbook' as const : undefined

        const cwd = ctx?.cwd ?? process.cwd()

        // Hybrid 检索（Wave 3）：BM25 + 结构过滤 + 时间加权，统一覆盖
        // 知识条目、knowledge/*.md 分块与 playbook 教训。默认只返回 current 叶子。
        const index = getKnowledgeIndex(cwd, embedder)
        const hits = await index.search(query, { limit, kind, topic, includeHistory, source })

        // commit_fact 侧车：显式请求或 query 形如 commit hash 时才查
        const looksLikeCommitHash = /\b[0-9a-f]{7,40}\b/i.test(query)
        const includeCommitFacts = params.input.includeCommitFacts === true || looksLikeCommitHash
        const commitFacts = includeCommitFacts
          ? readCommitFacts(cwd)
              .filter(e => e.text.toLowerCase().includes(query.toLowerCase())
                || tokenizeRecallQuery(query).some(t => e.text.toLowerCase().includes(t)))
              .slice(-limit)
          : []

        // 召回健康账本（Wave 3）：记录每次召回的空/命中，postSession 聚合落盘
        if (ctx?.sessionId) {
          getRecallTracker(ctx.sessionId).record(query, hits.map(h => ({
            text: h.text,
            id: h.entry?.id,
            gateAdmitted: h.entry?.source === 'essence-gate',
          })))
        }

        const lines: string[] = []

        // Wave 5（反馈闭环）：supersede 链结构告警（模型可见，不影响检索结果）
        const chainIssues = index.chainIssues
        if (chainIssues.length > 0) {
          lines.push(`⚠ 知识链完整性问题（${chainIssues.length}）：`)
          for (const issue of chainIssues.slice(0, 3)) {
            lines.push(`  [${issue.kind}] ${issue.detail}`)
          }
          lines.push('')
        }

        // Wave 5（反馈闭环）：闸门健康度——账本指标越过阈值才产出，正常时零噪声
        const gateFeedback = renderGateFeedbackHint(cwd)
        if (gateFeedback) {
          lines.push(gateFeedback)
          lines.push('')
        }

        const entryHits = hits.filter(h => h.entry)
        const mdHits = hits.filter(h => h.file)
        if (entryHits.length > 0) {
          lines.push(`知识条目（${entryHits.length}）：`)
          for (const h of entryHits) {
            const e = h.entry!
            const meta: string[] = []
            if (e.topic) meta.push(`topic:${e.topic}`)
            if (e.evidence) meta.push(`evidence:${e.evidence.slice(0, 60)}`)
            if (e.sessionId) meta.push(`session:${e.sessionId.slice(0, 8)}`)
            if (e.supersededBy) meta.push(`superseded-by:${e.supersededBy}`)
            lines.push(`- [${e.id}] [${e.kind}] ${e.text}${meta.length > 0 ? ` (${meta.join(', ')})` : ''}`)
          }
        }
        if (mdHits.length > 0) {
          lines.push(`知识文件（${mdHits.length}）：`)
          for (const h of mdHits) lines.push(`- ${h.file}: ${h.text.slice(0, 160).replace(/\n/g, ' ')}`)
        }
        const playbookHits = hits.filter(h => h.playbook)
        if (playbookHits.length > 0) {
          lines.push(`Playbook 教训（${playbookHits.length}）：`)
          for (const h of playbookHits) lines.push(`- ${h.text.replace(/\n/g, ' ')}`)
        }
        if (commitFacts.length > 0) {
          lines.push(`Commit 事实（${commitFacts.length}）：`)
          for (const e of commitFacts) lines.push(`- ${e.text}`)
        }
        // 告警行（链校验/闸门健康）可能存在于零命中的响应里——仍要明确"没找到"
        if (hits.length === 0 && commitFacts.length === 0) {
          lines.push(`未找到与「${query}」相关的记忆。`)
        }
        return { content: lines.join('\n') }
      }

      if (action === 'deep_recall') {
        const query = typeof params.input.query === 'string' ? params.input.query.trim() : ''
        if (!query) return { content: '错误：deep_recall 需要提供 query', isError: true }
        if (!ctx?.deepRecallComplete || !ctx.sessionDir) {
          return { content: '错误：当前宿主未接线深召回的侧路模型通道——请改用 recall（知识库检索）。', isError: true }
        }
        // 原文不进主上下文：检索候选 → 侧路蒸馏 → 只回紧凑结果。
        const candidates = collectTranscriptCandidates(ctx.sessionDir, query)
        if (candidates.length === 0) {
          return { content: `历史会话中没有与「${query}」相关的片段——deep_recall 无可蒸馏素材。` }
        }
        let raw: string
        try {
          raw = await ctx.deepRecallComplete(buildDeepRecallPrompt(query, candidates), 20_000)
        } catch {
          return { content: '深召回失败（侧路模型不可用/超时）——fail-closed 不编造，可改用 recall。', isError: true }
        }
        const result = parseDeepRecallOutput(raw)
        if (!result) {
          return { content: '深召回失败（蒸馏输出不可解析）——fail-closed 不编造，可改用 recall。', isError: true }
        }
        return { content: renderDeepRecallText(result) }
      }

      if (action === 'recall_feedback') {
        const entryId = typeof params.input.entryId === 'string' ? params.input.entryId.trim() : ''
        const outcome = params.input.outcome
        if (!entryId || (outcome !== 'adopted' && outcome !== 'rejected' && outcome !== 'contradicted')) {
          return { content: '错误：recall_feedback 需要一个已召回的 entryId 和合法的 outcome。', isError: true }
        }
        if (!ctx?.sessionId || !getRecallTracker(ctx.sessionId).recordOutcome(entryId, outcome)) {
          return { content: '错误：该 entryId 在本会话中没有被召回过。', isError: true }
        }
        return { content: `已记录召回反馈：${entryId} → ${outcome}。` }
      }

      // action === 'remember'
      const kind = typeof params.input.kind === 'string'
        ? (REMEMBER_KINDS.includes(params.input.kind as ContextClaimKind) ? params.input.kind as ContextClaimKind : null)
        : null
      if (!kind) {
        return { content: `错误：remember 需要提供 kind。必须是：${REMEMBER_KINDS.join(', ')}`, isError: true }
      }
      const text = typeof params.input.text === 'string' ? params.input.text.trim() : ''
      if (!text) return { content: '错误：remember 需要提供 text', isError: true }

      const scope: ContextClaimScope = params.input.scope === 'project' ? 'project' : 'session'
      const confidence = typeof params.input.confidence === 'number' ? Math.max(0, Math.min(1, params.input.confidence)) : 0.9
      const tags = Array.isArray(params.input.tags) ? params.input.tags.filter((t): t is string => typeof t === 'string') : undefined

      const turn = ctx?.getTurn() ?? 0
      const sessionId = ctx?.sessionId ?? 'unknown'

      const createdAt = Date.now()
      store.propose({
        kind,
        text,
        scope,
        confidence,
        fitness: confidence,
        source: { actor: 'assistant', eventId: `memory:${sessionId}:turn${turn}`, sessionId, turn },
        evidence: [],
        createdAt,
        tags: tags ?? [],
      })

      // Wave 2（知识重构）：project scope 不再直写 .rivet/knowledge/memory.jsonl。
      // 项目级持久化统一走 postSession essence-gate（LLM 准入闸）——claim store
      // 中 scope=project 的本会话条目由闸门收口裁决（loop-factory essenceGate 接线）。
      // 会话内该条目经 active-claims 通道立即可见，不受影响。
      if (scope === 'project') {
        return { content: `✅ 已记住：[${kind}] ${text}\n（项目作用域持久化待会话结束时的质量门禁）` }
      }

      return { content: `✅ 已记住：[${kind}] ${text}` }
    },

    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

// ── Backward-compat: createRecallTool / createRememberTool ──
export const createRecallTool = createMemoryTool
export const createRememberTool = createMemoryTool
