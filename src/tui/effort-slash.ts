import { createLogEntry } from './log-state.js'
import { contractModels } from '../config/contract-models.js'
import { resolveEffortChoices, type ReasoningEffortChoice } from '../api/provider.js'
import type { SlashHandlerContext } from './slash-commands.js'
import type { ProviderConfig } from '../config/schema.js'

export function resolveActiveEffortChoices(
  provider: ProviderConfig,
  activeModelId?: string,
): ReasoningEffortChoice[] | undefined {
  try {
    const activeModel = contractModels(provider).find(m => m.id === activeModelId)
    return resolveEffortChoices(provider.name, provider, activeModel?.capabilities)
  } catch {
    return undefined
  }
}

export function handleEffortSlash(ctx: SlashHandlerContext): boolean {
  const { parts, pushStatic, setIsStreaming, surfacePush } = ctx
  const rawArg = parts[1]?.toLowerCase()

  if (ctx.effortChoices !== undefined) {
    if (ctx.effortChoices.length === 0) {
      pushStatic(createLogEntry({ type: 'system', content: '当前模型不支持推理等级调节。' }))
      setIsStreaming(false)
      return true
    }

    if (!rawArg) {
      pushStatic(createLogEntry({ type: 'system', content: '也可在 /model 面板用 </> 随模型一起调整推理等级（Enter 仅应用本会话，s 设为默认）。' }))
      ctx.setChoicePanelKind?.('effort')
      surfacePush?.('choice-panel')
      setIsStreaming(false)
      return true
    }

    if (rawArg === 'auto') {
      ctx.setReasoningEffort?.('auto')
      pushStatic(createLogEntry({ type: 'system', content: 'Reasoning effort: auto (autoReasoning picks per task)' }))
      setIsStreaming(false)
      return true
    }

    const matched = ctx.effortChoices.find(c =>
      c.id === rawArg ||
      c.wireValue?.toLowerCase() === rawArg ||
      c.label.toLowerCase() === rawArg
    )

    if (matched) {
      ctx.setReasoningEffort?.(matched.id)
      pushStatic(createLogEntry({ type: 'system', content: 'Reasoning effort set to: ' + matched.label }))
    } else {
      const allowedStr = [...ctx.effortChoices.map(c => c.id), 'auto'].join('|')
      const hasMax = ctx.effortChoices.some(c => c.id === 'max')
      const maxGuidance = hasMax ? 'Set max for full reasoning on every turn. ' : ''
      pushStatic(createLogEntry({ type: 'system', content: 'Usage: /effort [' + allowedStr + ']\n\n' + maxGuidance + 'auto lets autoReasoning pick per-task complexity.' }))
    }
    setIsStreaming(false)
    return true
  }

  const valid = ['off', 'low', 'medium', 'high', 'max', 'auto']
  if (!rawArg) {
    pushStatic(createLogEntry({ type: 'system', content: '也可在 /model 面板用 </> 随模型一起调整推理等级（Enter 仅应用本会话，s 设为默认）。' }))
    ctx.setChoicePanelKind?.('effort')
    surfacePush?.('choice-panel')
    setIsStreaming(false)
    return true
  }
  if (valid.includes(rawArg)) {
    ctx.setReasoningEffort?.(rawArg as any)
    pushStatic(createLogEntry({ type: 'system', content: rawArg === 'auto'
      ? 'Reasoning effort: auto (autoReasoning picks per task)'
      : 'Reasoning effort set to: ' + rawArg }))
  } else {
    pushStatic(createLogEntry({ type: 'system', content: 'Usage: /effort [off|low|medium|high|max|auto]\n\nSet max for full reasoning on every turn. auto lets autoReasoning pick per-task complexity.' }))
  }
  setIsStreaming(false)
  return true
}
