import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool, ToolCallParams } from './types.js'

/**
 * Capability index — 能力索引（吸收 CLI-Anything matrix schema v2）。
 *
 * 数据模型：{ capability: { id, intent, hints, providers: [{ kind, name,
 * requires: { binary, env, package }, installHint }] } }
 * 内置常用 dev CLI 种子 registry；项目级 `.rivet/capabilities.json` 可扩展
 * （按 id 覆盖或新增，不删除种子条目）。preflight 逐 provider 检查
 * binary（PATH）/ env / package 存在性，返回 available / missing + installHint。
 * 查询面挂只读 capability 工具。
 */

export const CAPABILITY_SCHEMA_VERSION = '2'
export const PROJECT_REGISTRY_PATH = '.rivet/capabilities.json'

export interface CapabilityRequires {
  binary?: string[]
  env?: string[]
  package?: string[]
}

export interface CapabilityProvider {
  kind: string
  name: string
  requires?: CapabilityRequires
  installHint?: string
}

export interface Capability {
  id: string
  intent: string
  hints?: string[]
  providers: CapabilityProvider[]
}

export interface CapabilityRegistry {
  schemaVersion?: string
  capabilities: Capability[]
}

export interface ProviderPreflight {
  kind: string
  name: string
  available: boolean
  present: { binary: string[]; env: string[]; package: string[] }
  missing: { binary: string[]; env: string[]; package: string[] }
  installHint: string | undefined
}

export interface PreflightResult {
  capability: { id: string; intent: string; hints: string[] }
  summary: { providers: number; available: number; missing: number }
  providers: ProviderPreflight[]
}

/** 可注入的检查器，便于测试控制环境。 */
export interface Checkers {
  binary?: (name: string) => boolean
  env?: (name: string) => boolean
  package?: (name: string) => boolean
}

const require_ = createRequire(import.meta.url)

function defaultBinaryChecker(name: string): boolean {
  const res = spawnSync('which', [name], { stdio: 'ignore', windowsHide: true })
  return res.status === 0
}

function defaultEnvChecker(name: string): boolean {
  return process.env[name] !== undefined
}

function defaultPackageChecker(name: string): boolean {
  try {
    require_.resolve(name)
    return true
  } catch {
    try {
      require_.resolve(name.replaceAll('-', '_'))
      return true
    } catch {
      return false
    }
  }
}

/** 内置常用 dev CLI 种子 registry（ffmpeg / imagemagick / pandoc / jq / gh / rg）。 */
export const SEED_REGISTRY: CapabilityRegistry = {
  schemaVersion: CAPABILITY_SCHEMA_VERSION,
  capabilities: [
    {
      id: 'media-transcode',
      intent: '音视频转码、格式转换与媒体处理（ffmpeg）',
      hints: ['转码', '视频处理', '音频提取', 'ffmpeg'],
      providers: [
        {
          kind: 'public-cli',
          name: 'ffmpeg',
          requires: { binary: ['ffmpeg'] },
          installHint: 'brew install ffmpeg',
        },
      ],
    },
    {
      id: 'image-processing',
      intent: '图像处理与格式转换（ImageMagick）',
      hints: ['图片', '缩略图', 'convert', 'imagemagick'],
      providers: [
        {
          kind: 'public-cli',
          name: 'imagemagick',
          requires: { binary: ['magick', 'convert'] },
          installHint: 'brew install imagemagick',
        },
      ],
    },
    {
      id: 'document-conversion',
      intent: '文档格式转换（pandoc）',
      hints: ['markdown', 'pdf', 'docx', 'pandoc'],
      providers: [
        {
          kind: 'public-cli',
          name: 'pandoc',
          requires: { binary: ['pandoc'] },
          installHint: 'brew install pandoc',
        },
      ],
    },
    {
      id: 'json-processing',
      intent: 'JSON 处理与查询（jq）',
      hints: ['jq', 'json', '查询'],
      providers: [
        {
          kind: 'public-cli',
          name: 'jq',
          requires: { binary: ['jq'] },
          installHint: 'brew install jq',
        },
      ],
    },
    {
      id: 'github-ops',
      intent: 'GitHub 仓库操作（gh CLI）',
      hints: ['github', 'pr', 'issue', 'gh'],
      providers: [
        {
          kind: 'public-cli',
          name: 'gh',
          requires: { binary: ['gh'], env: ['GITHUB_TOKEN'] },
          installHint: 'brew install gh',
        },
      ],
    },
    {
      id: 'code-search',
      intent: '高性能代码搜索（ripgrep）',
      hints: ['搜索', 'rg', 'ripgrep'],
      providers: [
        {
          kind: 'public-cli',
          name: 'rg',
          requires: { binary: ['rg'] },
          installHint: 'brew install ripgrep',
        },
      ],
    },
  ],
}

function asList(value: unknown): string[] {
  if (value == null) return []
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return [String(value)]
}

function parseCapability(raw: unknown): Capability | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.id !== 'string' || typeof obj.intent !== 'string') return null
  const providers: CapabilityProvider[] = []
  if (Array.isArray(obj.providers)) {
    for (const p of obj.providers) {
      if (typeof p !== 'object' || p === null) continue
      const po = p as Record<string, unknown>
      if (typeof po.name !== 'string') continue
      const req = (typeof po.requires === 'object' && po.requires !== null
        ? po.requires
        : {}) as Record<string, unknown>
      providers.push({
        kind: typeof po.kind === 'string' ? po.kind : 'public-cli',
        name: po.name,
        requires: {
          binary: asList(req.binary),
          env: asList(req.env),
          package: asList(req.package),
        },
        installHint: typeof po.installHint === 'string' ? po.installHint : undefined,
      })
    }
  }
  return {
    id: obj.id,
    intent: obj.intent,
    hints: Array.isArray(obj.hints) ? obj.hints.filter((h): h is string => typeof h === 'string') : [],
    providers,
  }
}

export function parseRegistry(raw: unknown): CapabilityRegistry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.capabilities)) return null
  const capabilities = obj.capabilities
    .map(parseCapability)
    .filter((c): c is Capability => c !== null && c.providers.length > 0)
  return {
    schemaVersion: typeof obj.schemaVersion === 'string' ? obj.schemaVersion : CAPABILITY_SCHEMA_VERSION,
    capabilities,
  }
}

/** 读取项目级 `.rivet/capabilities.json`；文件缺失或解析失败返回 null。 */
export function loadProjectRegistry(cwd: string): CapabilityRegistry | null {
  const path = join(cwd, PROJECT_REGISTRY_PATH)
  if (!existsSync(path)) return null
  try {
    return parseRegistry(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return null
  }
}

/**
 * 合并种子与项目级 registry：项目级按 id 覆盖种子条目、新增条目追加，
 * 绝不删除种子条目（零契约破坏）。
 */
export function mergeRegistries(seed: CapabilityRegistry, project: CapabilityRegistry | null): CapabilityRegistry {
  if (!project) return seed
  const byId = new Map<string, Capability>()
  for (const c of seed.capabilities) byId.set(c.id, c)
  for (const c of project.capabilities) byId.set(c.id, c)
  return {
    schemaVersion: project.schemaVersion ?? seed.schemaVersion,
    capabilities: [...byId.values()],
  }
}

/** 默认合并加载器：种子 + 项目级覆盖。 */
export function loadMergedRegistry(cwd: string): CapabilityRegistry {
  return mergeRegistries(SEED_REGISTRY, loadProjectRegistry(cwd))
}

function checkRequires(requires: CapabilityRequires, checkers: Required<Checkers>): { present: ProviderPreflight['present']; missing: ProviderPreflight['missing'] } {
  const present = { binary: [] as string[], env: [] as string[], package: [] as string[] }
  const missing = { binary: [] as string[], env: [] as string[], package: [] as string[] }
  for (const name of requires.binary ?? []) {
    ;(checkers.binary(name) ? present : missing).binary.push(name)
  }
  for (const name of requires.env ?? []) {
    ;(checkers.env(name) ? present : missing).env.push(name)
  }
  for (const name of requires.package ?? []) {
    ;(checkers.package(name) ? present : missing).package.push(name)
  }
  return { present, missing }
}

export function checkProviderRequirements(provider: CapabilityProvider, checkers?: Checkers): ProviderPreflight {
  const c: Required<Checkers> = {
    binary: checkers?.binary ?? defaultBinaryChecker,
    env: checkers?.env ?? defaultEnvChecker,
    package: checkers?.package ?? defaultPackageChecker,
  }
  const { present, missing } = checkRequires(provider.requires ?? {}, c)
  const available = present.binary.length + present.env.length + present.package.length > 0
    && missing.binary.length === 0 && missing.env.length === 0 && missing.package.length === 0
  return {
    kind: provider.kind,
    name: provider.name,
    available,
    present,
    missing,
    installHint: provider.installHint,
  }
}

/** 对单个 capability 做 preflight；未找到返回 null。 */
export function preflightCapability(
  registry: CapabilityRegistry,
  capabilityId: string,
  checkers?: Checkers,
): PreflightResult | null {
  const capability = registry.capabilities.find((c) => c.id === capabilityId)
  if (!capability) return null
  const providers = capability.providers.map((p) => checkProviderRequirements(p, checkers))
  return {
    capability: {
      id: capability.id,
      intent: capability.intent,
      hints: capability.hints ?? [],
    },
    summary: {
      providers: providers.length,
      available: providers.filter((p) => p.available).length,
      missing: providers.filter((p) => !p.available).length,
    },
    providers,
  }
}

export function formatPreflight(result: PreflightResult): string {
  const lines = [
    `capability: ${result.capability.id}`,
    `intent: ${result.capability.intent}`,
    `preflight: ${result.summary.available}/${result.summary.providers} providers available`,
  ]
  for (const p of result.providers) {
    const missingBits = [
      ...p.missing.binary.map((b) => `binary:${b}`),
      ...p.missing.env.map((e) => `env:${e}`),
      ...p.missing.package.map((n) => `package:${n}`),
    ]
    const hint = p.installHint ? `  install: ${p.installHint}` : ''
    lines.push(`  - ${p.name} (${p.kind}) ${p.available ? 'available' : `missing ${missingBits.join(', ')}`}${hint}`)
  }
  return lines.join('\n')
}

export function formatRegistryList(registry: CapabilityRegistry): string {
  const lines = [`capability registry (schema v${registry.schemaVersion ?? CAPABILITY_SCHEMA_VERSION})`]
  for (const c of registry.capabilities) {
    const n = c.providers.length
    lines.push(`  - ${c.id}: ${c.intent} (${n} provider${n === 1 ? '' : 's'})`)
  }
  return lines.join('\n')
}

/**
 * 只读 capability 工具：缺省列出全部能力；传 capabilityId 做 preflight。
 */
export function createCapabilityTool(
  loadRegistry: (cwd: string) => CapabilityRegistry = loadMergedRegistry,
): Tool {
  return {
    definition: {
      name: 'capability',
      description: `只读查询能力索引（capability registry）。列出全部能力或对指定 capabilityId 做 preflight——逐 provider 报告本机 binary/env/package 可用性与安装提示。不修改任何状态。`,
      input_schema: {
        type: 'object',
        properties: {
          capabilityId: {
            type: 'string',
            description: '要 preflight 的能力 id；缺省时列出全部能力概览。',
          },
        },
      },
    },

    async execute(params: ToolCallParams) {
      const registry = loadRegistry(params.cwd)
      const id = params.input.capabilityId
      if (typeof id === 'string' && id.length > 0) {
        const result = preflightCapability(registry, id)
        if (!result) {
          return { content: `未找到 capability: ${id}`, isError: true }
        }
        return { content: formatPreflight(result) }
      }
      return { content: formatRegistryList(registry) }
    },

    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}
