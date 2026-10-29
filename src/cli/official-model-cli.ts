import { loadConfig, saveConfig, setDefaultModelConfig } from '../config/manager.js'
import { captureOfficialIdentity, getOfficialCatalog, withCurrentOfficialIdentity } from '../auth/official-model-auth.js'
import { createManagedAccountAuth, prepareModelRuntime, isOfficialProvider, resolveProviderForModel } from '../models/model-runtime.js'
import { assertDefaultModelRef, contractModels } from '../config/contract-models.js'
import { OfficialError, publicFailure, type Catalog } from '../models/official-contract.js'
import { OFFICIAL_PROVIDER_ID, projectOfficialCatalogConfig } from '../models/official-catalog.js'
import { handleAccountLogin, handleAccountLogout } from '../tui/account-login.js'

type AccountLogin = (app: Parameters<typeof handleAccountLogin>[0], onResult?: (success: boolean) => void) => Promise<boolean>

export async function runOfficialModelCLI(args: readonly string[], options: { write?: (line: string) => void; login?: AccountLogin } = {}): Promise<{ output: string; exitCode: number }> {
  const lines: string[] = []
  const app = { commitStatic: (text: string) => { if (options.write) options.write(text); else lines.push(text) } }
  try {
    if (args[0] === 'account') {
      if (args[1] === 'status' && args.length === 2) return { output: captureOfficialIdentity() ? '已登录天枢账号。' : '未登录。请执行 tianshu account login', exitCode: 0 }
      if (args[1] === 'logout' && args.length === 2) { await handleAccountLogout(app); return { output: lines.join('\n'), exitCode: 0 } }
      if (args[1] === 'login' && args.length === 2) {
        let success = false
        const login: AccountLogin = options.login ?? handleAccountLogin
        await login(app, value => { success = value })
        return { output: lines.join('\n'), exitCode: success ? 0 : 1 }
      }
    } else if (args[0] === 'model') {
      let config = loadConfig()
      const identity = captureOfficialIdentity()
      let catalog: Catalog | undefined
      let catalogFailure: OfficialError | undefined
      const configuredProvider = config.provider.providers[config.provider.default] ?? Object.values(config.provider.providers)[0]
      const existingTarget = args[1] === 'use' && args[2] && configuredProvider
        ? resolveProviderForModel({ config, provider: configuredProvider, apiKey: '' }, args[2]) : null
      if (identity && (args[1] === 'list' || !existingTarget || 'error' in existingTarget || isOfficialProvider(existingTarget.provider))) {
        try {
          catalog = await getOfficialCatalog(identity, 'agent')
          config = projectOfficialCatalogConfig(config, catalog)
        } catch (error) {
          if (args[1] !== 'list') throw error
          catalogFailure = publicFailure(error)
        }
      }
      if (!identity && args[1] === 'use' && args[2]?.startsWith(`${OFFICIAL_PROVIDER_ID}:`)) throw new OfficialError('auth_required', 401, false)
      const providers = config.provider.providers
      const provider = providers[config.provider.default] ?? Object.values(providers)[0]
      if (!provider) throw new OfficialError('model_unavailable', undefined, false)
      const auth = createManagedAccountAuth()
      if (args[1] === 'list' && args.length === 2) {
        for (const [name, p] of Object.entries(providers)) for (const model of contractModels(p)) {
          if (!isOfficialProvider(p) || catalog?.models.some(m => m.id === model.id && m.status === 'available')) lines.push(`${name}:${model.id}${isOfficialProvider(p) ? ' · 天枢官方' : ''}`)
        }
        if (!identity) lines.push('官方模型需要登录：tianshu account login')
        if (catalogFailure) lines.push(`官方模型暂不可用：${catalogFailure.code}`)
        return { output: lines.join('\n'), exitCode: 0 }
      }
      if (args[1] === 'use' && args.length === 3) {
        const prepared = await prepareModelRuntime({ config, provider, apiKey: '', auth, modelId: args[2]!, purpose: 'agent' })
        const ref = `${prepared.providerName}:${prepared.keyId ? prepared.keyId + ':' : ''}${prepared.modelId}`
        if (isOfficialProvider(prepared.provider)) {
          if (!identity) throw new OfficialError('auth_required', 401, false)
          assertDefaultModelRef(config.provider.providers, ref)
          withCurrentOfficialIdentity(identity, () => saveConfig({ ...config, agent: { ...config.agent, defaultModel: ref } }))
        } else setDefaultModelConfig({ defaultModel: ref })
        return { output: `默认模型：${ref}`, exitCode: 0 }
      }
    }
    return { output: '用法：tianshu account login|status|logout；tianshu model list|use <provider:model>', exitCode: 1 }
  } catch (error) {
    return { output: error instanceof OfficialError ? `${error.code}${error.code === 'auth_required' ? '：请执行 tianshu account login' : ''}` : '命令未完成，请检查账号与模型配置。', exitCode: 1 }
  }
}
