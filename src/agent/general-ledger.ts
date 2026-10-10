/**
 * 将星战绩账本（general ledger）— `.rivet/generals/<slug>.md`。
 *
 * 将星 = 基因（seed capsule，docs/seed-capsule-*.md）+ 战绩（ledger，本模块）。
 * 胶囊是封存的方法论，经 recall_capsule 召回；账本是跨会话生长的记忆
 * （缺陷族/能力族 + recurrenceCount），经 recall_general 召回、
 * record_general_finding 追加。设计依据：Team Mode V3.1 spec §3。
 *
 * 解析/回写是段落级 markdown 操作：族条目以
 *   `### <family-slug> | recurrenceCount: N | lastSeen: DATE`
 * 为界，同族追加 = 头行计数++ + 段尾追加日期行；新族 = 追加新段落。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { starDomainRegistry } from './star-domain-registry.js'
import { isFilesystemMetadata } from '../utils/file-metadata.js'

const GENERALS_DIR = '.rivet/generals'

// ── 遥测（Y8 静音之道：先装账本，账本机制自己也要有账本）──────────
// 模块级 sink，loop-factory 在 telemetryWriter 就绪后接线；未接线时零开销。
// 记录读/写各一事件，让「账本是否在被使用、哪个星在生长」可从 sensorium.jsonl 观测。

export interface GeneralLedgerTelemetryEvent {
  kind: 'general-ledger'
  op: 'read' | 'write'
  star: string
  slug: string
  /** write 专有：是否新建族 / 写后计数。 */
  created?: boolean
  recurrenceCount?: number
  family?: string
}

let telemetrySink: ((event: GeneralLedgerTelemetryEvent) => void) | null = null

/** 接线遥测 sink（传 null 断开）。sink 抛错被吞——遥测永不影响账本 I/O。 */
export function setGeneralLedgerTelemetrySink(sink: ((event: GeneralLedgerTelemetryEvent) => void) | null): void {
  telemetrySink = sink
}

function emitLedgerTelemetry(event: GeneralLedgerTelemetryEvent): void {
  try {
    telemetrySink?.(event)
  } catch {
    // Telemetry must never break ledger I/O.
  }
}

/** 星域之外的将星（有胶囊/账本但无 star-domain id）。 */
const EXTRA_GENERAL_SLUGS: Record<string, string> = {
  贪狼: 'tanlang',
}

/** 星名（中文或 slug）→ 账本 slug。未知返回 null。 */
export function starToGeneralSlug(star: string): string | null {
  const q = star.trim()
  if (!q) return null
  const lower = q.toLowerCase()
  for (const id of starDomainRegistry.getDomainIds()) {
    const domain = starDomainRegistry.get(id)
    if (id === lower || domain?.name === q) return id
  }
  if (EXTRA_GENERAL_SLUGS[q]) return EXTRA_GENERAL_SLUGS[q]
  if (Object.values(EXTRA_GENERAL_SLUGS).includes(lower)) return lower
  return null
}

export function generalLedgerPath(cwd: string, slug: string): string {
  return join(cwd, GENERALS_DIR, `${slug}.md`)
}

/** 读取将星账本全文。星名未知或文件不存在返回 null。 */
export function readGeneralLedger(cwd: string, star: string): { slug: string; content: string } | null {
  const slug = starToGeneralSlug(star)
  if (!slug) return null
  const path = generalLedgerPath(cwd, slug)
  if (!existsSync(path)) return null
  try {
    const content = readFileSync(path, 'utf-8')
    emitLedgerTelemetry({ kind: 'general-ledger', op: 'read', star: star.trim(), slug })
    return { slug, content }
  } catch {
    return null
  }
}

/** 已有账本的将星 slug 列表。 */
export function listGenerals(cwd: string): string[] {
  const dir = join(cwd, GENERALS_DIR)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.md') && !isFilesystemMetadata(f))
      .map(f => f.replace(/\.md$/, ''))
  } catch {
    return []
  }
}

// ── 族条目解析 ──────────────────────────────────────────────────

const FAMILY_HEADING_RE = /^### (\S+) \| recurrenceCount: (\d+) \| lastSeen: (\S+)\s*$/

export interface LedgerFamily {
  family: string
  recurrenceCount: number
  lastSeen: string
  /** 一行摘要（族段落里的 **signature** 行，无则空串）。 */
  signature: string
}

/** 从账本 markdown 提取全部族条目（供 worker prompt top-N 合并）。 */
export function parseLedgerFamilies(content: string): LedgerFamily[] {
  const lines = content.split('\n')
  const families: LedgerFamily[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(FAMILY_HEADING_RE)
    if (!m) continue
    let signature = ''
    for (let j = i + 1; j < lines.length && !lines[j]!.startsWith('### '); j++) {
      const sig = lines[j]!.match(/^\*\*signature\*\*[：:]\s*(.+)$/)
      if (sig) { signature = sig[1]!.trim(); break }
    }
    families.push({
      family: m[1]!,
      recurrenceCount: Number.parseInt(m[2]!, 10),
      lastSeen: m[3]!,
      signature,
    })
  }
  return families
}

/** 按 recurrenceCount 降序取某将星账本的 top-N 族（无账本 → []）。 */
export function topGeneralFamilies(cwd: string, star: string, n = 3): LedgerFamily[] {
  const ledger = readGeneralLedger(cwd, star)
  if (!ledger) return []
  return parseLedgerFamilies(ledger.content)
    .sort((a, b) => b.recurrenceCount - a.recurrenceCount)
    .slice(0, n)
}

// ── 追加式写入（record_general_finding）─────────────────────────

export interface GeneralFindingInput {
  star: string
  /** 族 slug（kebab-case，如 always-true-on-missing-field）。 */
  family: string
  /** 一行战绩描述（会作为日期实例行追加）。 */
  note: string
  /** 覆盖日期（默认今天，YYYY-MM-DD）。 */
  date?: string
}

export interface GeneralFindingResult {
  slug: string
  /** true = 新建族条目；false = 同族复发（recurrenceCount++）。 */
  created: boolean
  recurrenceCount: number
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 追加一条将星战绩：同族已存在 → 头行 recurrenceCount++ / lastSeen 更新 +
 * 段尾追加日期行；不存在 → 新建族段落。账本文件不存在时自动创建骨架。
 * 返回 null 当星名未知。
 */
export function appendGeneralFinding(cwd: string, finding: GeneralFindingInput): GeneralFindingResult | null {
  const slug = starToGeneralSlug(finding.star)
  if (!slug) return null
  const date = finding.date ?? today()
  const family = finding.family.trim()
  const note = finding.note.trim()

  const dir = join(cwd, GENERALS_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = generalLedgerPath(cwd, slug)

  let content: string
  if (existsSync(path)) {
    content = readFileSync(path, 'utf-8')
  } else {
    const starName = starDomainRegistry.get(slug)?.name
      ?? Object.entries(EXTRA_GENERAL_SLUGS).find(([, s]) => s === slug)?.[0]
      ?? slug
    content = [
      `# 将星 · ${starName}`,
      '',
      '## ledger（战绩账本 · 持续生长）',
      '',
      '> 格式：### family-slug | recurrenceCount: N | lastSeen: DATE',
      '',
    ].join('\n')
  }

  const lines = content.split('\n')
  const headingIdx = lines.findIndex(line => {
    const m = line.match(FAMILY_HEADING_RE)
    return m !== null && m[1] === family
  })

  if (headingIdx >= 0) {
    // 同族复发：计数++、更新 lastSeen、段尾（下一个 ### / --- / EOF 之前）追加实例行。
    const m = lines[headingIdx]!.match(FAMILY_HEADING_RE)!
    const count = Number.parseInt(m[2]!, 10) + 1
    lines[headingIdx] = `### ${family} | recurrenceCount: ${count} | lastSeen: ${date}`
    let end = lines.length
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (lines[i]!.startsWith('### ') || lines[i]!.startsWith('---')) { end = i; break }
    }
    // 回退越过段尾空行，让实例行紧贴段落内容。
    let insertAt = end
    while (insertAt > headingIdx + 1 && lines[insertAt - 1]!.trim() === '') insertAt--
    lines.splice(insertAt, 0, `- ${date} ${note}`)
    writeFileSync(path, lines.join('\n'), 'utf-8')
    emitLedgerTelemetry({ kind: 'general-ledger', op: 'write', star: finding.star.trim(), slug, created: false, recurrenceCount: count, family })
    return { slug, created: false, recurrenceCount: count }
  }

  // 新族：追加到尾部注释（<!-- ... -->）之前，无注释则到 EOF。
  const newBlock = [
    `### ${family} | recurrenceCount: 1 | lastSeen: ${date}`,
    '',
    `- ${date} ${note}`,
    '',
  ]
  const commentIdx = lines.findIndex(line => line.trimStart().startsWith('<!--'))
  if (commentIdx >= 0) {
    lines.splice(commentIdx, 0, ...newBlock)
  } else {
    if (lines.length > 0 && lines[lines.length - 1]!.trim() !== '') lines.push('')
    lines.push(...newBlock)
  }
  writeFileSync(path, lines.join('\n'), 'utf-8')
  emitLedgerTelemetry({ kind: 'general-ledger', op: 'write', star: finding.star.trim(), slug, created: true, recurrenceCount: 1, family })
  return { slug, created: true, recurrenceCount: 1 }
}
