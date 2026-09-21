/**
 * `rivet provider <add|list|models|probe|remove>` — unified provider
 * onboarding CLI (Wave 3). Same write core (manager.registerProvider) and
 * same probe (api/provider-probe) as the desktop routes and the /connect
 * wizard; same-name writes require explicit --force.
 */
import { loadConfig, registerProvider, removeProvider, getApiKeyStatus } from './manager.js'
import { tryResolveCredentialKey } from '../api/factory.js'
import { resolveCapabilities } from '../api/provider.js'
import { probeProvider, aliasTableWithProbeInfos, type ProbeReport } from '../api/provider-probe.js'
import { normalizeBaseUrl } from '../api/endpoint-map.js'
import { matchModelIds, type ModelMatchResult } from '../api/model-id-matcher.js'
import type { ModelAliasMetadata } from '../api/model-aliases.js'
import { PROVIDER_PROTOCOL_VALUES, type ModelConfig, type ProviderCapabilitiesConfig, type ProviderProtocol } from './schema.js'
import { contractModels } from './contract-models.js'

export interface ProviderCliIO {
  write?: (line: string) => void
  writeErr?: (line: string) => void
  exit?: (code: number) => void
}

const out = (io: ProviderCliIO, line: string) => (io.write ?? console.log)(line)
const err = (io: ProviderCliIO, line: string) => (io.writeErr ?? console.error)(line)
const exit = (io: ProviderCliIO, code: number) => (io.exit ?? process.exit)(code)

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function printHelp(io: ProviderCliIO): void {
  out(io, `Rivet Provider Management

Usage: rivet provider <command>

Commands:
  add <name> --base-url <url>   Add a custom provider (probe-first)
      [--api-key KEY] [--api-key-env ENV] [--protocol openai|anthropic]
      [--no-probe] [--force] [--default]
  list                          List configured providers
  models <name>                 Fetch the endpoint's model list and print a
                                pasteable models[] snippet (alias-table matched)
  probe <name>                  Probe a configured provider (models + completion)
  remove <name>                 Remove a provider (its model group + stored API key)

Examples:
  rivet provider add my-relay --base-url http://127.0.0.1:3000/v1 --api-key-env RELAY_API_KEY
  rivet provider add claude-proxy --base-url https://proxy.example.com --protocol anthropic
  rivet provider models my-relay`)
}

/** 解析可用 API key 的「尽力而为」入口——本地端点无需 key，故不抛错。
 *  直接复用 factory 的三槽解析（keyRef→apiKey→apiKeyEnv→`<NAME>_API_KEY`）：
 *  此前这里有一份平行实现，与 resolveApiKey 的链路各写一遍，正是漂移的来源。 */
function bestEffortApiKey(provider: { apiKey?: string; apiKeyEnv?: string; keyRef?: string; name: string }): string | undefined {
  return tryResolveCredentialKey({
    name: provider.name,
    keyRef: provider.keyRef,
    apiKey: provider.apiKey,
    apiKeyEnv: provider.apiKeyEnv,
  })
}

/**
 * Turn matcher results into config-ready model descriptors. Matched entries
 * backfill alias-table metadata (L1/L2 silently, L3 annotated); unknowns come
 * through as bare `{ id }` skeletons for the user to fill — never an error.
 * The endpoint's RAW id is kept as the config id: it must stay callable.
 */
export function toModelDescriptors(results: ModelMatchResult[]): {
  models: Array<Partial<ModelConfig> & { id: string }>
  notes: string[]
} {
  const models: Array<Partial<ModelConfig> & { id: string }> = []
  const notes: string[] = []
  for (const result of results) {
    if (!result.entry) {
      models.push({ id: result.rawId })
      notes.push(`[TODO] ${result.rawId}: 未匹配已知模型——请手填 contextWindow/maxTokens`)
      continue
    }
    const metadata: ModelAliasMetadata = result.entry.metadata
    const descriptor: Partial<ModelConfig> & { id: string } = {
      id: result.rawId,
      ...(metadata.contextWindow !== undefined ? { contextWindow: metadata.contextWindow } : {}),
      ...(metadata.maxTokens !== undefined ? { maxTokens: metadata.maxTokens } : {}),
      ...(metadata.reasoningEffort ? { reasoningEffort: metadata.reasoningEffort } : {}),
      ...(metadata.supportsVision !== undefined ? { supportsVision: metadata.supportsVision } : {}),
      ...(metadata.tier ? { tier: metadata.tier } : {}),
      ...(metadata.pricing ? { pricing: metadata.pricing } : {}),
      ...(metadata.capabilities && Object.keys(metadata.capabilities).length > 0 ? { capabilities: metadata.capabilities } : {}),
    }
    models.push(descriptor)
    if (result.tier === 'fuzzy') {
      notes.push(`[低置信] ${result.rawId} ≈ ${result.entry.canonicalId}（score ${result.confidence.toFixed(2)}）——元数据为推断值，请确认`)
    }
  }
  return { models, notes }
}

/**
 * 探测到的模型里，哪些虽然带 `reasoningEffort`、但该 provider 解析出的能力**没有承载它的
 * 通道**（issue #153）——这些档位会在请求体里被静默丢弃：界面可选中、线上没有该字段。
 *
 * 必须带 provider **名**才判得准：`resolveCapabilities` 先命中 `WELL_KNOWN_DEFAULTS`
 * （deepseek / openai / kimi / glm / relay / ccswitch… 都带 `effortFormat`），只有名字不在
 * 表里的自建 / 中转 provider 才落回 `DEFAULT_CAPABILITIES` 的 `'none'`。放在
 * `toModelDescriptors` 里判不了——那个函数看不到名字，会对所有推理模型一律告警。
 */
export function effortChannelNotes(
  providerName: string,
  models: Array<Partial<ModelConfig> & { id: string }>,
  providerOverrides?: ProviderCapabilitiesConfig,
): string[] {
  const notes: string[] = []
  for (const model of models) {
    if (!model.reasoningEffort) continue
    // provider 级与 model 级 capabilities 各算一层 override（dashscope 的 qwen3.x-max
    // 就是在 model 级写的）。--force 覆盖已有 provider 时要把已有的声明带进来，
    // 否则会对已经声明过通道的 provider 误报。
    const caps = resolveCapabilities(providerName, providerOverrides, model.capabilities)
    if (caps.effortFormat !== 'none' || caps.thinkingBudgetField === 'budget_tokens') continue
    notes.push(
      `[档位不生效] ${model.id}：模型带 reasoningEffort(${model.reasoningEffort})，但 provider "${providerName}" 解析出的推理通道是 `
      + `none——档位会在请求体里被静默丢弃。补 capabilities: { effortFormat: 'reasoning_effort' }（provider 级）`
      + `或写在该 model 的 capabilities 上即可把该字段发出去。`
      + `\n  注意：部分中转站在**带 tools** 时拒绝 reasoning_effort 并返回 400`
      + `（实测见 issue #153：\`Function tools with reasoning_effort are not supported …\`），`
      + `那种站上开了反而整条 provider 不可用——若开始报 400 就撤掉这个声明。`,
    )
  }
  return notes
}

function formatProbeSummary(report: ProbeReport): string[] {
  const lines: string[] = []
  lines.push(`Models list: ${report.modelsOk ? `${report.models.length} model(s)` : 'unavailable'}`)
  lines.push(`Completion probe: ${report.completionOk ? `ok${report.latencyMs !== undefined ? ` (${report.latencyMs}ms)` : ''}` : 'failed/skipped'}`)
  if (report.hints.reasoningSplit) lines.push('Hint: endpoint emits reasoning_content → consider capabilities.reasoningSplit: true')
  for (const error of report.errors) lines.push(`⚠ ${error}`)
  return lines
}

async function cmdAdd(args: string[], io: ProviderCliIO): Promise<void> {
  const name = args[1]
  const rawBaseUrl = readFlag(args, '--base-url')
  if (!name || !rawBaseUrl) {
    err(io, 'Usage: rivet provider add <name> --base-url <url> [--api-key KEY|--api-key-env ENV] [--protocol openai|anthropic|openai-responses] [--no-probe] [--force] [--default]')
    exit(io, 1)
    return
  }
  const baseUrl = normalizeBaseUrl(rawBaseUrl)
  if (baseUrl !== rawBaseUrl) out(io, `Base URL normalized: ${rawBaseUrl} → ${baseUrl}`)
  const apiKey = readFlag(args, '--api-key')
  const apiKeyEnv = readFlag(args, '--api-key-env')
  const protocolRaw = readFlag(args, '--protocol')
  if (protocolRaw !== undefined && !(PROVIDER_PROTOCOL_VALUES as readonly string[]).includes(protocolRaw)) {
    err(io, `Invalid --protocol "${protocolRaw}" (expected ${PROVIDER_PROTOCOL_VALUES.join(' | ')})`)
    exit(io, 1)
    return
  }
  const protocol = protocolRaw as ProviderProtocol | undefined
  const noProbe = hasFlag(args, '--no-probe')
  const key = apiKey ?? (apiKeyEnv ? process.env[apiKeyEnv] : undefined)

  let models: Array<Partial<ModelConfig> & { id: string }> = []
  if (!noProbe) {
    out(io, `Probing ${baseUrl} ...`)
    const report = await probeProvider({ baseUrl, apiKey: key, protocol, providerName: name })
    for (const line of formatProbeSummary(report)) out(io, `  ${line}`)
    if (report.models.length > 0) {
      const { models: descriptors, notes } = toModelDescriptors(matchModelIds(report.models, aliasTableWithProbeInfos(report.modelInfos)))
      models = descriptors
      for (const note of notes) err(io, note)
      // issue #153 —— 档位能不能发出去取决于 provider **名**解析出的能力，注册前先说清楚。
      // --force 覆盖已有 provider 时把它的声明带上，免得对已声明通道的 provider 误报。
      const existing = loadConfig().provider.providers[name]
      for (const note of effortChannelNotes(name, models, existing?.capabilities)) err(io, note)
    }
  }

  registerProvider({
    providerName: name,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(protocol ? { protocol } : {}),
    models,
    makeDefault: hasFlag(args, '--default'),
    force: hasFlag(args, '--force'),
  })
  out(io, `Provider "${name}" registered${models.length > 0 ? ` with ${models.length} model(s)` : ' (no models yet — run `rivet provider models ' + name + '`)'}.`)
}

async function cmdModels(args: string[], io: ProviderCliIO): Promise<void> {
  const name = args[1]
  if (!name) {
    err(io, 'Usage: rivet provider models <name>')
    exit(io, 1)
    return
  }
  const provider = loadConfig().provider.providers[name]
  if (!provider) {
    err(io, `Provider "${name}" not found. Run \`rivet provider list\` or \`rivet provider add ${name} --base-url <url>\`.`)
    exit(io, 1)
    return
  }
  const report = await probeProvider({
    baseUrl: provider.baseUrl,
    apiKey: bestEffortApiKey(provider),
    protocol: provider.protocol,
    providerName: name,
    skipCompletion: true,
  })
  if (!report.modelsOk) {
    for (const error of report.errors) err(io, `⚠ ${error}`)
    exit(io, 1)
    return
  }
  const { models, notes } = toModelDescriptors(matchModelIds(report.models, aliasTableWithProbeInfos(report.modelInfos)))
  for (const note of notes) err(io, note)
  // issue #153 —— 这里多半是「把 snippet 贴回配置」之前，正好提醒档位通道缺失。
  for (const note of effortChannelNotes(name, models, provider.capabilities)) err(io, note)
  out(io, JSON.stringify({ models }, null, 2))
}

async function cmdProbe(args: string[], io: ProviderCliIO): Promise<void> {
  const name = args[1]
  if (!name) {
    err(io, 'Usage: rivet provider probe <name>')
    exit(io, 1)
    return
  }
  const provider = loadConfig().provider.providers[name]
  if (!provider) {
    err(io, `Provider "${name}" not found. Run \`rivet provider list\`.`)
    exit(io, 1)
    return
  }
  const report = await probeProvider({
    baseUrl: provider.baseUrl,
    apiKey: bestEffortApiKey(provider),
    protocol: provider.protocol,
    providerName: name,
    probeModel: contractModels(provider)[0]?.id,
  })
  for (const line of formatProbeSummary(report)) out(io, line)
  if (report.models.length > 0) out(io, `Models: ${report.models.join(', ')}`)
  exit(io, report.completionOk ? 0 : 1)
}

function cmdList(io: ProviderCliIO): void {
  const cfg = loadConfig()
  const entries = Object.entries(cfg.provider.providers)
  if (entries.length === 0) {
    out(io, 'No providers configured. Run `rivet provider add <name> --base-url <url>`.')
    return
  }
  for (const [name, provider] of entries) {
    const key = getApiKeyStatus(name)
    const star = name === cfg.provider.default ? ' *' : ''
    out(io, `${name}${star}  [${provider.protocol}]  ${provider.baseUrl}  models=${contractModels(provider).length}  key=${key.source === 'none' ? 'missing' : key.source}`)
  }
}

function cmdRemove(args: string[], io: ProviderCliIO): void {
  const name = args[1]
  if (!name) {
    err(io, 'Usage: rivet provider remove <name>')
    exit(io, 1)
    return
  }
  const result = removeProvider(name)
  const secretNote = !result.keyRef
    ? ''
    : result.secretDeleted
      ? ' API key deleted from secrets.json.'
      : result.keyRefSharedWith.length > 0
        ? ` Key ref "${result.keyRef}" still referenced by ${result.keyRefSharedWith.join(', ')} — secret kept.`
        : ' (no stored key found)'
  out(io, `Provider "${name}" removed (${result.modelCount} models).${secretNote}`)
}

export async function runProviderCLI(args: string[], io: ProviderCliIO = {}): Promise<void> {
  const cmd = args[0]
  try {
    switch (cmd) {
      case 'add':
        await cmdAdd(args, io)
        return
      case 'list':
        cmdList(io)
        return
      case 'models':
        await cmdModels(args, io)
        return
      case 'probe':
        await cmdProbe(args, io)
        return
      case 'remove':
        cmdRemove(args, io)
        return
      default:
        printHelp(io)
        if (cmd) exit(io, 1)
    }
  } catch (error) {
    err(io, error instanceof Error ? error.message : String(error))
    exit(io, 1)
  }
}
