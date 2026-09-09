/**
 * Shared star-domain picker entry builder.
 *
 * Single source of truth for the "Auto / <built-in & custom domains>"
 * selection list, consumed by BOTH the TUI domain-picker overlay (src/main.ts)
 * and the desktop server's GET /sessions/:id/domains route. Keeps the two
 * surfaces byte-identical instead of drifting copies.
 */
import { starDomainRegistry } from './star-domain-registry.js'
import { STAR_GENESIS } from './star-genesis-data.js'
import type { ActiveStarDomain } from './star-domain.js'

/**
 * Shared warning shown when a star-domain is switched MID-SESSION. Swapping the
 * volatileBlock rewrites frozenBase, so the prefix cache is fully invalidated and
 * the next request rebuilds the whole context (~10x cost). New sessions / picking
 * a domain before the first turn pay nothing.
 */
export const DOMAIN_SWITCH_CACHE_WARNING =
  '⚠ 会话中途切换星域会使前缀缓存整体失效，下一次请求需全量重建上下文（成本约 10 倍+）。建议新开会话或在会话开始时选择。'

/** 选择器底部的常驻预防性备注（短版；切换后的忠告用上面的 WARNING）。 */
export const DOMAIN_SWITCH_CACHE_NOTE =
  '⚠ 会话内切换星域会打断前缀缓存，建议在新会话切换'

export interface DomainPickerEntry {
  /** Selection key: 'auto' | domain id. */
  key: string
  name: string
  motto: string
  /** 工程别名（如 晨光向导）——custom 域缺省时 UI 回退 tagline。 */
  alias?: string
  /** 职责标语（如 破夜指引 · 洞察全景）——custom 域无 tagline 时回退 motto。 */
  tagline?: string
  /** Secondary dim meta: decisionStyle · keywords. */
  meta: string
  /** One-shot essence preview (never the full volatileBlock). */
  essence: string
  /** 创始星短名（来自 star-genesis-data；custom 域缺省）。 */
  founder?: string
  /** 一句话核心专长（来自 star-genesis-data；custom 域缺省）。 */
  expertise?: string
  /** Whether this is the session's current selection. */
  current: boolean
  uiPersona?: {
    separator: 'thin' | 'thick' | 'dots'
    accent: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'dim'
    glyph: string
  }
}

/**
 * Build the domain picker entries given the session's current domain state.
 *
 * User-selectable options: `Auto` + each built-in/custom domain. The `Off`
 * option was removed — a session with no persona is only reachable via the
 * `STAR_SOUL=0` env kill switch, not a picker choice.
 *
 * Tri-state mirrors AgentLoop.getSessionDomain():
 *  - `undefined` → Auto (per-message keyword match)
 *  - `null`      → no persona (env kill switch only; not user-selectable)
 *  - object      → a specific domain is pinned
 */
const DOMAIN_PINYIN_MAP: Record<string, string> = {
  auto: 'zìdòng',
  tianshu: 'tiānshū',
  pojun: 'pòjūn',
  tianfu: 'tiānfǔ',
  tianliang: 'tiānliáng',
  tianquan: 'tiānquán',
  tianji: 'tiānjī',
  tianxuan: 'tiānxuán',
  fu: 'fǔ',
  wenqu: 'wénqǔ',
  kaiyang: 'kāiyáng',
  yaoguang: 'yáoguāng',
  huagai: 'huágài',
  qiming: 'qǐmíng',
  changgeng: 'chánggēng',
  qisha: 'qīshā',
}

export function buildDomainPickerEntries(
  current: ActiveStarDomain | null | undefined,
): DomainPickerEntry[] {
  return [
    {
      key: 'auto',
      name: 'Auto',
      motto: '按任务匹配',
      alias: '按任务匹配',
      tagline: '关键词自动路由 · 未命中回退天权',
      meta: 'zìdòng · 关键词自动匹配星域',
      essence: '根据每条消息内容自动匹配最合适的星域方法论；未命中时回退天权。',
      // null (env kill switch) has no picker entry → also reflect as Auto-selected.
      current: current === undefined || current === null,
      uiPersona: { separator: 'thin', accent: 'primary', glyph: '❂' },
    },
    ...starDomainRegistry.list().map((d) => {
      const firstLine = (d.volatileBlock || '')
        .split('\n')
        .map((s) => s.trim())
        .find((s) => s.length > 0) ?? ''
      const essence = [d.motto, firstLine].filter(Boolean).join(' — ').slice(0, 400)
      const pinyin = DOMAIN_PINYIN_MAP[d.id] ?? d.id
      const genesis = STAR_GENESIS.find((g) => g.key === d.id)
      return {
        key: d.id,
        name: d.name,
        motto: d.motto ?? '',
        alias: d.alias,
        tagline: d.tagline ?? d.motto ?? '',
        meta: `${pinyin} · ${d.keywords.slice(0, 4).join(',')}`,
        essence,
        founder: genesis?.founder,
        expertise: genesis?.expertise,
        current: current != null && current.id === d.id,
        uiPersona: d.uiPersona,
      }
    }),
  ]
}
