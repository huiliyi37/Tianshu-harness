import type { ManagedAgent, ModelOption } from './session-manager.js'
import type { SessionRecord } from './protocol.js'

export function operationModelView(read?: () => ModelOption[]): () => ModelOption[] {
  let models: ModelOption[] | undefined
  return () => {
    if (!models) {
      try { models = read?.() ?? [] } catch { models = [] }
    }
    return models
  }
}

export function enrichSessionRecord(
  session: { record: SessionRecord; agent: ManagedAgent | null; reasoningEffort?: SessionRecord['reasoningEffort'] },
  models: () => readonly ModelOption[],
  modelOptionMatches: (current: string | undefined, model: ModelOption) => boolean,
  resolveDomainPersona: (key: string | undefined) => { glyph: SessionRecord['domainGlyph']; accent: SessionRecord['domainAccent'] },
): SessionRecord {
    const record = { ...session.record }
    if (session.agent) {
      try { record.contextTokens = session.agent.getEstimatedTokens?.() } catch {  }
      try { record.contextBudget = session.agent.getContextBudget?.() ?? record.contextBudget } catch {  }
      try { record.contextWindow = session.agent.getContextWindow?.() } catch {  }
    }
    if (record.contextWindow === undefined) {
      try {
        record.contextWindow = models().find((model) => modelOptionMatches(record.model, model))?.contextWindow
      } catch {  }
    }
    if (session.agent) {
      try { record.reasoningEffort = session.reasoningEffort ?? session.agent.getReasoningEffort?.() } catch {  }
    }
    const persona = resolveDomainPersona(record.domain)
    record.domainGlyph = persona.glyph
    record.domainAccent = persona.accent
    return record
  }
