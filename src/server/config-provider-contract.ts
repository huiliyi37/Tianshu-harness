import type { ProviderProtocol } from '../config/schema.js'
import type { ProviderRetryConfig } from '../config/retry-schema.js'
import type { ProviderKeyListItem } from '../config/provider-key-store.js'

export interface ProviderListItem {
  userSaved?: boolean
  name: string
  label: string
  endpointNetworkPolicy?: { origin: string; allowPrivateNetwork?: boolean; proxyDns?: 'local-check' | 'trusted-proxy'; proxyOrigin?: string }
  baseUrl: string
  protocol: ProviderProtocol
  isDefault: boolean
  keyStatus: { source: 'inline' | 'env' | 'none'; ref: string }
  /** OAuth 型 provider（codex 订阅制）：存在即 'oauth'。此时 keyStatus 恒 none
   *  （没有 API key 这个概念），UI 应看 oauthAuthenticated 而不是 keyStatus。 */
  authType?: 'oauth' | 'tianshu-account'
  officialAvailable?: boolean
  /** OAuth 型 provider 的登录态（token store 可读即 true）。非 oauth 不下发。 */
  oauthAuthenticated?: boolean
  /** 无需 API key 的端点：keyless 预设（ollama），或未配任何密钥材料的自定义
   *  provider（桌面表单 API Key 可选，用户有意空着 = keyless 端点）。
   *  模型选择器据此区分「keyless」与「该配 key 而没配」——前者照常列出。 */
  keyless: boolean
  models: { id: string; alias?: string; supportsVision?: boolean; supportsVideo?: boolean; supportsImageGen?: boolean; free?: boolean; effortSupported?: boolean; reasoningEffort?: string }[]
  /** 端点是否真的会把推理档位发上线（provider 级 resolveEffortSupported）。
   *  设置页开关据此回显真实状态——不是「是否显式声明」，避免预设名自带通道时
   *  取消勾选成为空操作。undefined 字段兜底旧 sidecar（按支持处理）。 */
  effortSupported?: boolean
  /** 已显式声明的档位通道（capabilities.effortFormat）；undefined = 未声明，
   *  按 provider 名推导。 */
  effortFormat?: 'reasoning_effort' | 'output_config' | 'none'
  /** 多 key 池（PR-3）：每个 key 的自身凭据状态与模型归属。顶层 models /
   *  keyStatus 保留为兼容视图（与默认 key 一致）；UI 改为消费本数组。
   *  未迁移且无凭证无模型的 provider 为空数组。 */
  keys: ProviderKeyListItem[]
  isPreset: boolean
  allowProFallback: boolean
  /** 三态：undefined = 按名称/baseUrl 启发式；true/false 压过启发式。 */
  slowThinking?: boolean
  /** 显式重试上限（0–20）；undefined = 按错误类别默认（issue #75）。 */
  maxRetries?: number
  /** 重试策略块（退避/类别覆盖/客户端限速）；undefined = 未配置（历史行为）。 */
  retry?: ProviderRetryConfig
}

