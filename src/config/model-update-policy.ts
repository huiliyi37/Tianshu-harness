import type { ModelConfig } from './schema.js'

/**
 * Clamp a model's output ceiling to its context window. `maxTokens` is the
 * single-response output cap and can never exceed the total window; letting a
 * mis-typed value through (e.g. maxTokens=1M on a 128K model) skews compaction
 * headroom and can trip provider 400s. This is the shared backstop for every
 * config write path (wizard, desktop form, direct upsert).
 */
export function clampModelTokens<T extends { contextWindow: number; maxTokens: number }>(model: T): T {
  const contextWindow = model.contextWindow === undefined ? undefined : Math.max(1, Math.floor(model.contextWindow))
  const maxTokens = model.maxTokens === undefined ? undefined : Math.max(1, Math.min(Math.floor(model.maxTokens), contextWindow ?? Infinity))
  return { ...model, ...(contextWindow === undefined ? {} : { contextWindow }), ...(maxTokens === undefined ? {} : { maxTokens }) }
}

/**
 * Merge a model update onto the existing entry instead of replacing it.
 *
 * Every write path here carries a *partial* model: the desktop Settings form
 * sends only `{id, alias, contextWindow, maxTokens}`, and `rivet config
 * set-model` sends just what the user typed. Whole-object replacement drops
 * every field the form does not carry — `supportsVision`, `tier`, `pricing` —
 * and all three failures are silent: images get dropped with no error, tier
 * falls back to guessing from the model name, cost accounting reads zero.
 * An absent key means "caller had no opinion", so the stored value wins;
 * clearing a field is `removeModel`'s job, not a side effect of editing a
 * context window.
 */
export function mergeModelUpdate(existing: ModelConfig, incoming: ModelConfig): ModelConfig {
  const merged: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    if (['capabilities', 'pricing', 'imageGen'].includes(key) && value && typeof value === 'object') {
      const previous = (merged[key] ?? {}) as Record<string, unknown>
      const fields = Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined))
      merged[key] = { ...previous, ...fields, ...(key === 'capabilities' && fields.effortCap ? { effortCap: { ...(previous.effortCap as object ?? {}), ...(fields.effortCap as object) } } : {}) }
    } else merged[key] = value
  }
  return clampModelTokens(merged as ModelConfig)
}
