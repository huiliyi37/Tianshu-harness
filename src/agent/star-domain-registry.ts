/**
 * Star Domain Registry — extensible domain management.
 *
 * Mirrors profile-registry.ts pattern: built-in domains + user-loaded
 * domains from .rivet/domains/<id>/card.md. Replaces the hardcoded
 * STAR_DOMAINS Record and parallel lists (glance-bus ALL_DOMAINS).
 *
 * Design goals:
 * - Backward-compatible: existing StarDomainId / STAR_DOMAINS imports still work
 * - Extensible: user domains loaded at startup, no code changes needed
 * - Single source of truth: one registry, all consumers read from it
 */

import {
  STAR_DOMAINS,
  type StarDomain,
  type StarDomainId,
} from './star-domain.js'
import { normalizeFrontmatterSource } from '../utils/frontmatter.js'

// Re-export for backward compatibility
export type { StarDomain, StarDomainId }

/** Max length for string fields from user domain cards (prevents abuse) */
const MAX_STRING_FIELD_LENGTH = 2000
/** Max items in array fields from user domain cards */
const MAX_ARRAY_ITEMS = 50
/** Allowed characters for domain id (alphanumeric, underscore, hyphen) */
const DOMAIN_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/

export class StarDomainRegistry {
  private domains = new Map<string, StarDomain>()
  private initialized = false

  constructor() {
    // Defer STAR_DOMAINS access to first use to avoid circular ESM init
  }

  /** Ensure built-in domains are loaded (lazy init breaks circular dep) */
  private ensureInit(): void {
    if (this.initialized) return
    for (const domain of Object.values(STAR_DOMAINS)) {
      this.domains.set(domain.id, domain)
    }
    this.initialized = true
  }

  /** Load user domains from .rivet/domains/ directory.
   *  Each subdirectory is a domain card: <id>/card.md */
  async loadFromDirectory(dir: string): Promise<{ loaded: string[]; errors: string[] }> {
    this.ensureInit()
    const loaded: string[] = []
    const errors: string[] = []
    try {
      const { readdirSync } = await import('node:fs')
      const { join } = await import('node:path')
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        try {
          const cardPath = join(dir, entry.name, 'card.md')
          const { readFileSync } = await import('node:fs')
          const content = readFileSync(cardPath, 'utf-8')
          const def = parseDomainCard(content, entry.name)
          if (this.domains.has(def.id) && this.domains.get(def.id)!.isCustom === false) {
            errors.push(`${entry.name}: cannot override built-in domain "${def.id}"`)
            continue
          }
          // Second load of same custom id = error (no silent overwrite)
          if (this.domains.has(def.id) && this.domains.get(def.id)!.isCustom === true) {
            errors.push(`${entry.name}: duplicate custom domain id "${def.id}"`)
            continue
          }
          this.domains.set(def.id, def)
          loaded.push(def.id)
        } catch (e) {
          errors.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    } catch {
      // directory doesn't exist — fine, only built-ins
    }
    return { loaded, errors }
  }

  /** Get a domain definition by id */
  get(id: string): StarDomain | undefined {
    this.ensureInit()
    return this.domains.get(id)
  }

  /** Get all registered domain ids */
  getDomainIds(): string[] {
    this.ensureInit()
    return [...this.domains.keys()]
  }

  /** Get all registered domains */
  list(): StarDomain[] {
    this.ensureInit()
    return [...this.domains.values()]
  }

  /** Check if a domain id is registered */
  has(id: string): boolean {
    this.ensureInit()
    return this.domains.has(id)
  }

  /** Match a task description to the best domain by keyword scoring.
   *  Returns null if no domain matches (all scores = 0 or tie).
   *  `pool` 限定参与计分的域 id 集合（缺省 = 全集）——auto 路由收窄用。 */
  matchDomain(taskDescription: string, pool?: readonly string[]): string | null {
    return this.matchDomainDetailed(taskDescription, pool).id
  }

  /**
   * Keyword-score match with audit detail: which keywords hit, hit/tie/no-match
   * verdict, and optional runner-up. `matchDomain` is a thin `.id` projection —
   * same inputs must keep returning the same id (or null).
   */
  matchDomainDetailed(taskDescription: string, pool?: readonly string[]): DomainMatchDetail {
    this.ensureInit()
    // Cap scan length so pathological objectives cannot explode includes() work.
    const lower = taskDescription.slice(0, MAX_MATCH_CHARS).toLowerCase()
    const scores = new Map<string, number>()
    const keywordsByDomain = new Map<string, string[]>()

    for (const domain of this.domains.values()) {
      if (pool !== undefined && !pool.includes(domain.id)) continue
      let score = 0
      const matched: string[] = []
      for (const keyword of domain.keywords) {
        if (lower.includes(keyword.toLowerCase())) {
          score++
          matched.push(keyword)
        }
      }
      if (score > 0) {
        scores.set(domain.id, score)
        keywordsByDomain.set(domain.id, matched)
      }
    }

    if (scores.size === 0) {
      return { id: null, matchedKeywords: [], verdict: 'no-match' }
    }

    let max = 0
    for (const s of scores.values()) {
      if (s > max) max = s
    }

    const winners = [...scores.entries()].filter(([, s]) => s === max)
    if (winners.length > 1) {
      const tiedIds = winners.map(([id]) => id).sort()
      return {
        id: null,
        matchedKeywords: [],
        verdict: 'tie',
        tiedIds,
        runnerUp: tiedIds[1],
      }
    }

    const winnerId = winners[0]![0]
    // Runner-up = next-highest score (any domain strictly below max), if any.
    let runnerUp: string | undefined
    let runnerScore = 0
    for (const [id, s] of scores) {
      if (id === winnerId) continue
      if (s > runnerScore) {
        runnerScore = s
        runnerUp = id
      }
    }

    return {
      id: winnerId,
      matchedKeywords: keywordsByDomain.get(winnerId) ?? [],
      verdict: 'hit',
      runnerUp,
    }
  }
}

/** Cap for keyword scanning — objectives beyond this are truncated for matching. */
export const MAX_MATCH_CHARS = 500

export type DomainMatchVerdict = 'hit' | 'tie' | 'no-match'

export interface DomainMatchDetail {
  id: string | null
  /** Keywords that hit on the winning domain, in domain-definition order. Empty on tie/no-match. */
  matchedKeywords: string[]
  verdict: DomainMatchVerdict
  /** Second-best domain id (hit) or second tied id (tie). */
  runnerUp?: string
  /** Sorted tied domain ids when verdict === 'tie'. */
  tiedIds?: string[]
}

// ─── Validation helpers ──────────────────────────────────────────

/** Clamp a number to [min, max] */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** Validate a domain id: lowercase alphanumeric + underscore/hyphen, 1-32 chars */
function validateDomainId(id: string): string {
  if (!DOMAIN_ID_RE.test(id)) {
    throw new Error(`Invalid domain id "${id}": must be 1-32 lowercase alphanumeric/underscore/hyphen chars, starting with a letter`)
  }
  return id
}

/** Sanitize a string field: trim and cap length */
function sanitizeString(value: unknown, _fieldName: string): string {
  if (typeof value !== 'string') return ''
  return value.slice(0, MAX_STRING_FIELD_LENGTH).trim()
}

/** Sanitize an array of strings: cap items, trim, and remove empty strings */
function sanitizeStringArray(value: unknown, _fieldName: string): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string')
    .slice(0, MAX_ARRAY_ITEMS)
    .map(v => v.trim())
    .filter(v => v.length > 0)
}

// ─── Card parser ─────────────────────────────────────────────────

/** Parse a domain card.md file (YAML frontmatter + body as systemPromptSuffix) */
function parseDomainCard(content: string, fallbackId: string): StarDomain {
  content = normalizeFrontmatterSource(content)
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!fmMatch) {
    throw new Error('Missing YAML frontmatter (--- delimiters)')
  }

  const raw = fmMatch[1]!
  const body = sanitizeString(fmMatch[2]?.trim(), 'systemPromptSuffix')

  // Simple YAML parse (same pattern as profile-registry.ts)
  const fm: Record<string, unknown> = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (m) {
      const key = m[1]!
      const val = m[2]!.trim()
      if (val.startsWith('[')) {
        try {
          fm[key] = JSON.parse(val.replace(/'/g, '"'))
        } catch {
          throw new Error(`Failed to parse array for field "${key}": "${val}"`)
        }
      } else {
        fm[key] = val
      }
    }
  }

  // Validate required fields whose raw type carries semantic meaning.
  if (typeof fm.name !== 'string' || !fm.name.trim()) {
    throw new Error('Missing required field: name')
  }

  // Validate & sanitize id
  const rawId = typeof fm.id === 'string' && fm.id ? fm.id : fallbackId
  const id = validateDomainId(rawId)

  // Validate decisionStyle
  const decisionStyle = fm.decisionStyle as string | undefined
  if (decisionStyle && !['bold', 'cautious', 'methodical'].includes(decisionStyle)) {
    throw new Error(`Invalid decisionStyle "${decisionStyle}". Must be: bold, cautious, methodical`)
  }

  // Validate accent (must be one of the known theme keys)
  const accent = fm.accent as string | undefined
  const VALID_ACCENTS = ['primary', 'secondary', 'success', 'warning', 'error']
  if (accent && !VALID_ACCENTS.includes(accent)) {
    throw new Error(`Invalid accent "${accent}". Must be: ${VALID_ACCENTS.join(', ')}`)
  }

  // Validate separator
  const separator = fm.separator as string | undefined
  const VALID_SEPARATORS = ['thin', 'thick', 'dots']
  if (separator && !VALID_SEPARATORS.includes(separator)) {
    throw new Error(`Invalid separator "${separator}". Must be: ${VALID_SEPARATORS.join(', ')}`)
  }

  // Sanitize array fields first, then validate the values that will actually
  // take effect. Raw-array checks are not enough: [1,2,3] sanitizes to [], and
  // [''] sanitizes to an empty tool name that would fail closed silently later.
  const keywords = sanitizeStringArray(fm.keywords, 'keywords').filter(Boolean)
  const toolWhitelist = sanitizeStringArray(fm.toolWhitelist, 'toolWhitelist').filter(Boolean)
  if (keywords.length === 0) {
    throw new Error('keywords must contain at least one non-empty string value')
  }
  if (toolWhitelist.length === 0) {
    throw new Error('toolWhitelist must contain at least one non-empty string value')
  }

  // Sanitize string fields
  const name = sanitizeString(fm.name, 'name')
  const motto = sanitizeString(fm.motto, 'motto')
  const volatileBlock = sanitizeString(fm.volatileBlock, 'volatileBlock')

  return {
    id: id as StarDomainId,
    name,
    motto,
    volatileBlock,
    decisionStyle: (decisionStyle ?? 'methodical') as StarDomain['decisionStyle'],
    courageThreshold: clamp(
      typeof fm.courageThreshold === 'number'
        ? fm.courageThreshold
        : typeof fm.courageThreshold === 'string'
          ? Number(fm.courageThreshold) || 0.5
          : 0.5,
      0, 1,
    ),
    keywords,
    isCustom: true,
    toolWhitelist,
    systemPromptSuffix: body,
    uiPersona: {
      separator: (separator as StarDomain['uiPersona']['separator']) ?? 'dots',
      accent: (accent as StarDomain['uiPersona']['accent']) ?? 'secondary',
      glyph: typeof fm.glyph === 'string' ? fm.glyph.slice(0, 4) : '◆',
    },
  }
}

/** Global singleton */
export const starDomainRegistry = new StarDomainRegistry()
