import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { projectStateAllowed } from '../config/project-trust.js'

const MAX_RENDER_CHARS = 1_500 // ~375 tokens for Tier 1 injection (Wave 4 收紧)

/**
 * Kinds eligible for Tier 1 prompt injection (high-signal, low-noise).
 * Wave 4（知识重构）收紧：decision / failure_pattern 转 recall-only——
 * 决策与失败模式属"需要时找得回"的知识，不属"每轮都推给模型"的约束。
 */
const TIER1_KINDS = new Set(['project_rule', 'user_constraint'])
/** Minimum confidence for Tier 1 injection. */
const TIER1_MIN_CONFIDENCE = 0.95

interface MemoryEntry {
  id: string
  kind: string
  text: string
  confidence: number
  createdAt: number
  source: string
  tags?: string[]
}

export interface ProjectMemoryBlock {
  content: string
  entryCount: number
}

/**
 * 软链收容（2026-10-31 审计 Finding 2）：memory.jsonl 或 .rivet/knowledge 目录
 * 为跨项目软链时，他项目的私有 user_constraint 会以 confidence 1.0 注入冻结前缀。
 * 解析后的真实路径必须落在项目根内。
 */
function realPathWithin(root: string, target: string): string | undefined {
  try {
    const real = realpathSync(target)
    const rel = relative(root, real)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
    return real
  } catch {
    return undefined
  }
}

/**
 * 解析 .rivet/knowledge/memory.jsonl 的可信真实路径；不可信（软链/越界/缺失）返回 undefined。
 *
 * 读取门（2026-10-31 审计 Finding 2）：信任门从调用点（volatile-snapshot.ts）下沉到
 * 读取函数内部，对照 readCommitFacts 的设计——直接调用 loader 的路径（recall、
 * compact、unified-memory 桥）原先无门，新调用点也容易漏门。
 */
function resolveMemoryPath(cwd: string): string | undefined {
  if (!projectStateAllowed(cwd)) return undefined
  const dir = join(cwd, '.rivet', 'knowledge')
  const path = join(dir, 'memory.jsonl')
  if (!existsSync(path)) return undefined

  let root: string
  try {
    root = realpathSync(cwd)
  } catch {
    return undefined
  }
  // 目录级逃逸：knowledge 目录本身为软链或非目录 → 拒绝。
  const dirStat = lstatSync(dir, { throwIfNoEntry: false })
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return undefined
  if (!realPathWithin(root, dir)) return undefined
  // 文件级逃逸：memory.jsonl 为软链（readFileSync 会跟随）→ 拒绝。
  const fileStat = lstatSync(path, { throwIfNoEntry: false })
  if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isFile()) return undefined
  const real = realPathWithin(root, path)
  if (!real) return undefined
  return real
}

/** Read all entries from .rivet/knowledge/memory.jsonl */
function readMemoryEntries(cwd: string): MemoryEntry[] {
  const path = resolveMemoryPath(cwd)
  if (!path) return []

  const entries: MemoryEntry[] = []
  try {
    const raw = readFileSync(path, 'utf-8')
    for (const line of raw.split('\n').filter(l => l.trim())) {
      try {
        const parsed = JSON.parse(line)
        if (parsed.id && parsed.text) entries.push(parsed)
      } catch { /* skip malformed */ }
    }
  } catch {
    return []
  }
  return entries
}

/**
 * Load Tier 1 project memory for frozen volatile block injection.
 * Only includes high-confidence project rules and user constraints.
 * Everything else is available via the recall tool (Tier 2).
 *
 * 信任门与软链收容都在 readMemoryEntries 内，本函数无需重复校验。
 */
export function loadProjectMemory(cwd: string): ProjectMemoryBlock {
  const entries = readMemoryEntries(cwd)

  // Filter to Tier 1 only: high-signal kinds with high confidence
  const tier1 = entries
    .filter(e => TIER1_KINDS.has(e.kind) && e.confidence >= TIER1_MIN_CONFIDENCE && !isCommitFact(e))
    .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)

  if (tier1.length === 0) return { content: '', entryCount: 0 }

  let budget = MAX_RENDER_CHARS
  const rendered: string[] = []
  let used = 0

  for (const entry of tier1) {
    const line = `  <m kind="${escapeXml(entry.kind)}" c="${entry.confidence.toFixed(2)}">${escapeXml(entry.text)}</m>`
    if (used + line.length > budget) break
    rendered.push(line)
    used += line.length
  }

  const content = `<project-memory entries="${rendered.length}">\n${rendered.join('\n')}\n</project-memory>`
  return { content, entryCount: rendered.length }
}

/**
 * Load all project memory entries (Tier 1 + Tier 2), unfiltered.
 *
 * @deprecated 仅限内部用途（compact、迁移、诊断）。recall 工具及任何面向
 * 模型的路径**不得**调用——全量 dump 曾把 187 条 commit 搬运噪声原样灌给
 * 模型（Wave 1 修复）。面向模型的检索一律走 `queryProjectMemoryEntries`
 * 或 `KnowledgeIndex.search`。
 */
export function loadAllProjectMemoryEntries(cwd: string): MemoryEntry[] {
  return readMemoryEntries(cwd)
    .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)
}

/**
 * Query project memory by keyword relevance — the recall-tool entry point.
 * Scores by term overlap (text ×2, tags ×1) weighted by confidence;
 * commit_fact entries are excluded (they live in the sidecar, see
 * project-memory-writer.readCommitFacts).
 */
export function queryProjectMemoryEntries(cwd: string, query: string, limit = 5): MemoryEntry[] {
  const terms = query.toLowerCase().split(/\W+/).filter(t => t.length >= 3)
  if (terms.length === 0) return []

  const scored = readMemoryEntries(cwd)
    .filter(e => !isCommitFact(e))
    .map(entry => {
      const text = entry.text.toLowerCase()
      const tagText = (entry.tags ?? []).join(' ').toLowerCase()
      let score = 0
      for (const term of terms) {
        if (text.includes(term)) score += 2
        if (tagText.includes(term)) score += 1
      }
      score *= entry.confidence
      return { entry, score }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt)

  return scored.slice(0, limit).map(s => s.entry)
}

function isCommitFact(entry: MemoryEntry): boolean {
  return entry.tags?.includes('commit_fact') ?? false
}

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
