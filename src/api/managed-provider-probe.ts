import { loadConfig } from '../config/manager.js'
import { createManagedAccountAuth, isOfficialProvider, resolveModelRuntime } from '../models/model-runtime.js'
import { captureOfficialIdentity, getOfficialCatalog } from '../auth/official-model-auth.js'
import { createProviderClient } from './factory.js'
import { completionFromClient } from '../agent/goal-criteria.js'
import { OfficialError } from '../models/official-contract.js'
import type { ProbeOptions, ProbeReport } from './provider-probe.js'

export async function probeManagedProvider(options: ProbeOptions, policy: { timeoutMs: number; sessionId: string; visionPrompt: string; visionImage: string }): Promise<ProbeReport | undefined> {
  const configured = options.providerName ? loadConfig() : undefined
  const managed = configured?.provider.providers[options.providerName!]
  if (configured && managed && isOfficialProvider(managed)) {
    const auth = createManagedAccountAuth()
    const identity = captureOfficialIdentity()
    const report: ProbeReport = { models: [], modelsOk: false, completionOk: false, hints: {}, errors: [] }
    try {
      if (options.apiKey || options.baseUrl && options.baseUrl !== managed.baseUrl || options.protocol && options.protocol !== managed.protocol) throw new OfficialError('model_unavailable', 409, false)
      if (!identity) throw new OfficialError('auth_required', 401, false)
      const catalog = await getOfficialCatalog(identity, 'probe')
      report.models = catalog.models.filter(m => m.status === 'available').map(m => m.id)
      report.modelsOk = true
      if (!options.skipCompletion && options.probeModel) {
        const signal = AbortSignal.timeout(options.timeoutMs ?? policy.timeoutMs)
        const runtime = await resolveModelRuntime({ config: configured, provider: managed, auth, apiKey: '', modelId: options.probeModel, targetProvider: managed.name, purpose: options.vision ? 'vision' : 'probe', signal })
        const client = createProviderClient(runtime.provider, runtime.capabilities, { apiKey: '', model: runtime.modelId, auth: runtime.auth, maxTokens: 32, requestAuth: runtime.requestAuth, sessionId: policy.sessionId })
        if (options.vision) {
          await client.stream({ model: runtime.modelId, max_tokens: 32, messages: [{ role: 'user', content: [{ type: 'text', text: policy.visionPrompt }, { type: 'image_url', image_url: { url: policy.visionImage } }] }] }, { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error) { throw error } }, signal)
        } else await completionFromClient(client, runtime.modelId, 32)('Respond briefly.', 'Reply OK', signal)
        report.completionOk = true; report.probedModel = runtime.modelId
      }
    } catch (error) {
      const code = error instanceof OfficialError ? error.code : 'service_error'
      const failure = { code, status: error instanceof OfficialError ? error.status : 503, message: code }
      report.errors.push(code)
      if (report.modelsOk) report.completionError = failure; else report.modelListError = failure
    }
    return report
  }
}
