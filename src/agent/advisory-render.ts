import type { AdvisoryEntry, DeliveredAdvisory } from './advisory-bus.js'

/** One tone evaluation produces both the request bytes and internal delivery proof. */
export function renderAdvisories(entries: AdvisoryEntry[], tone: (e: AdvisoryEntry) => string): { block: string; delivered: DeliveredAdvisory[] } {
  const contents = entries.map(e => escapeXml(tone(e)))
  return {
    block: entries.length ? `<星域-advisory>\n${entries.map((e, i) => `  <entry key="${escapeXml(e.key)}" priority="${e.priority.toFixed(2)}" category="${e.category}">${contents[i]}</entry>`).join('\n')}\n</星域-advisory>` : '',
    delivered: entries.map((e, i) => ({ key: e.key, category: e.category, tier: e.tier, expect: e.expect,
      ...(e.candidateId ? { candidateId: e.candidateId, renderedContent: contents[i] } : {}) })),
  }
}

export function escapeXml(text: string | null | undefined): string {
  return (text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
