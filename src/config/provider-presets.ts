import type { ModelConfig, ProviderConfig } from './schema.js'
import { isLoopbackBaseUrl } from './local-endpoint.js'

export type ProviderPresetKey = 'deepseek' | 'glm' | 'kimi' | 'opencode-go' | 'opencode-go-anthropic' | 'mimo' | 'mimo-api' | 'minimax' | 'codex' | 'openai' | 'siliconflow' | 'longcat' | 'ccswitch' | 'zhipu-vision' | 'dashscope' | 'volc' | 'openrouter' | 'relay' | 'ollama'

/** 一种计费模式对应一个官方 Base URL（如百炼的按量计费 / token plan）。 */
export interface ProviderBillingMode {
  id: string
  label: string
  description?: string
  /** 可含 {WorkspaceId} 等占位符——端点确认步要求用户替换后才能探测。 */
  baseUrl: string
}

export interface ProviderPreset {
  key: ProviderPresetKey
  label: string
  description: string
  /** 免密钥端点（如本地 Ollama）——向导跳过 key 步直接探测。 */
  keyless?: boolean
  /** 中转/聚合平台（模型多且杂）——向导模型多选默认全不选，提供搜索/全选。 */
  aggregator?: boolean
  /** 多于一种计费模式时，向导在选类型后插入「计费模式」选择步。 */
  billingModes?: ProviderBillingMode[]
  provider: ProviderConfig
  defaultModelId: string
  /** 官方 API Key 控制台页——桌面端预设卡「获取 API Key ↗」直链（ZCode 对标）。
   *  keyless（ollama）/ OAuth（codex）/ 中转站（ccswitch、relay）不配。 */
  keyUrl?: string
}

export const PROVIDER_PRESETS: Record<ProviderPresetKey, ProviderPreset> = {
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek',
    description: '官方旗舰：1M 上下文 + 深度推理，适合重活主控',
    // 2026-09-11：V4-Pro 退役（官方 14 日下线，且能力已弱于 V4.1-Flash 线）——条目已移除，
    // 存量用户快照由 manager.ts 的 migrateDeepseekV4ProRetirement 清理（preset 改动单靠
    // deepMerge 到不了存量配置）。默认档为 v4-flash；强档落点改由 deepseek-flash
    // （V4.1 线）承接，见下方 models。
    // 与新装首模型（models[0]，无 agent.defaultModel 时的启动兜底）保持一致。
    defaultModelId: 'deepseek-v4-flash',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    provider: {
      name: 'deepseek',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseUrl: 'https://api.deepseek.com/v1',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: true,
        prefixCache: 'deepseek-native',
        prefixCompletion: true,
      },
      thinking: 'enabled',
      // 官方 API(api.deepseek.com/zh-cn/quick_start/pricing):
      // 上下文 100 万,单次输出上限 38.4 万。2026-07-01 误改为 6.4 万(V3 旧值),
      // 导致 reasoning_effort=max 时推理未完即被 length 截断、loop 收到空响应判死停止。
      maxTokens: 384_000,
      models: [
        {
          id: 'deepseek-v4-flash',
          description: '快速档：能力对标旗舰，成本更低',
          alias: 'v4-flash',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoningEffort: 'medium',
          tier: 'cheap',
          pricing: { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 1 },
        },
        {
          // 2026-09-10 接入（V4.1 Flash 线，用户指定 id）：1M 上下文 + 原生多模态，
          // 定价与 v4-flash 同档。图片按尺寸换算 token 计入计费。
          // 2026-09-11 起承接 strong 档：V4-Pro 退役后本卡是 DeepSeek 唯一的强档卡，
          // 议事会瑶光门席位（天府 / 三柱护栏席）与 planning 路由都落在它上面。
          // 名字里的 "flash" 只标定价档位、不代表能力——路由读的是 tier 字段，
          // 勿据模型名把它降档。
          id: 'deepseek-flash',
          description: '旗舰档：V4.1 线，1M 上下文 + 原生多模态（图像输入）',
          alias: 'v4.1-flash',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoningEffort: 'medium',
          tier: 'strong',
          supportsVision: true,
          pricing: { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 1 },
        },
      ],
      unsupported: [],
    },
  },
  glm: {
    key: 'glm',
    label: 'GLM',
    description: '智谱 Coding 订阅：1M 上下文 + 视觉支持',
    defaultModelId: 'glm-5.2',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    provider: {
      name: 'glm',
      apiKeyEnv: 'ZHIPU_API_KEY',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: false,
        // GLM-5.2 implicit exact-prefix cache (隐式缓存) — keeps the stable prefix
        // cache-warm so compaction stops re-prefilling the full 1M-window prompt.
        prefixCache: 'deepseek-native',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 131072,
      // Keep 0: GLM coding API inflates prompt_tokens; calibrateUsage scales
      // cache_read proportionally so the cache hit-ratio is preserved.
      usageCalibrationFactor: 0,
      models: [
        {
          id: 'glm-5.2',
          description: '1M 上下文，视觉支持',
          alias: 'glm',
          contextWindow: 1_000_000,
          maxTokens: 131072,
          reasoningEffort: 'max',
          tier: 'strong',
          // GLM 视觉系模型：接受 image_url 多模态输入（computer_use 截图回灌）。
          supportsVision: true,
          // GLM Coding Plan 是月度定额订阅,不按 token 计费 —— 单价清零,
          // 避免界面显示误导性的"花费金额"(用量/缓存命中率等真实指标不受影响)。
          pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        {
          id: 'glm-5.3',
          description: '文本旗舰，1M 上下文（Coding Plan 已上线）',
          alias: 'glm-53',
          contextWindow: 1_000_000,
          maxTokens: 131072,
          reasoningEffort: 'max',
          tier: 'strong',
          pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        {
          id: 'glm-5.3-flash',
          description: '原生多模态，1M 上下文（视觉 Coding）',
          alias: 'glm-53-flash',
          contextWindow: 1_000_000,
          maxTokens: 131072,
          reasoningEffort: 'max',
          tier: 'strong',
          supportsVision: true,
          pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      unsupported: ['stream_options'],
    },
  },
  kimi: {
    key: 'kimi',
    label: 'Moonshot Kimi',
    description: '月之暗面 Kimi Code：K3 旗舰 1M 上下文 + K2.7 Code（会员订阅）',
    defaultModelId: 'k3',
    keyUrl: 'https://www.kimi.com/code/console',
    provider: {
      name: 'kimi',
      apiKeyEnv: 'KIMI_API_KEY',
      baseUrl: 'https://api.kimi.com/coding/v1', // Kimi Code 订阅端点（开放平台按量端点 api.moonshot.cn/v1 是另一套 Key/模型 id）
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: false,
        prefixCache: 'none',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 131_072,
      models: [
        {
          id: 'k3',
          description: 'K3 旗舰：2.8T MoE，1M 上下文（Moderato 起可用）',
          alias: 'k3',
          contextWindow: 1_000_000,
          maxTokens: 131_072,
          reasoningEffort: 'max',
          tier: 'strong',
          pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // 会员订阅不按 token 计费（同 GLM Coding Plan）
        },
        {
          id: 'k3-256k',
          description: 'K3 256K 上下文版：消耗约为 k3 一半（不支持视频输入）',
          alias: 'k3-256k',
          contextWindow: 262_144,
          maxTokens: 131_072,
          reasoningEffort: 'max',
          tier: 'strong',
          pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        {
          id: 'kimi-for-coding',
          description: 'K2.7 Code：面向编程任务（所有会员可用）',
          alias: 'kimi',
          contextWindow: 256_000,
          maxTokens: 64_000,
          reasoningEffort: 'high',
          tier: 'strong',
          pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      unsupported: [],
    },
  },
  'opencode-go': {
    key: 'opencode-go',
    label: 'OpenCode Go',
    description: 'OpenCode 官方开源模型订阅（$10/月）：DeepSeek / GLM / Kimi / MiMo 一站式接入',
    defaultModelId: 'deepseek-v4-pro',
    keyUrl: 'https://opencode.ai/zen',
    provider: {
      name: 'opencode-go',
      apiKeyEnv: 'OPENCODE_GO_KEY',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
        toolJsonBug: false,
        prefixCache: 'none',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 64_000,
      // 上游强制 x-opencode-session + 非通用 UA（见 api/provider-catalog.ts
      // 的 HOST_WIRE_RULES），这里只声明模型；协议/头由 wire 层统一注入。
      // 模型 id 只放「已有官方预设中已存在的」：alias table 按 id 合并（保留
      // 先出现者的规格），新 id 若与 MODEL_META_KB 撞名会破坏 canonicalId 唯一性
      // （provider-probe 的重复检测会红）。
      models: [
        {
          id: 'deepseek-v4-pro',
          alias: 'go-ds4p',
          description: 'DeepSeek V4 Pro：1M 上下文，重活主控',
          contextWindow: 1_000_000,
          // 官方标称 1M/384K（2026-09-11 公告：V4 Pro 不下线、继续服务、计费
          // 不变）。此处是官方条目删除后别名表的首个携带者（first-wins）——标
          // 64K 会让所有 v4-pro 回填跟着塌；64K 另有 2026-07-01 推理截断事故先例。
          maxTokens: 384_000,
          reasoningEffort: 'max',
          tier: 'strong',
        },
        {
          id: 'deepseek-v4-flash',
          alias: 'go-ds4f',
          description: 'DeepSeek V4 Flash：1M 上下文，快且省',
          contextWindow: 1_000_000,
          // 同 v4-pro：官方标称 384K（与 V4.1 Flash 同表）。
          maxTokens: 384_000,
          reasoningEffort: 'high',
          tier: 'strong',
        },
        {
          id: 'glm-5.2',
          alias: 'go-glm',
          description: 'GLM-5.2：1M 上下文',
          contextWindow: 1_000_000,
          maxTokens: 64_000,
          reasoningEffort: 'max',
          tier: 'strong',
        },
        {
          id: 'kimi-k3',
          alias: 'go-kimi',
          description: 'Kimi K3：1M 上下文',
          contextWindow: 1_000_000,
          maxTokens: 64_000,
          reasoningEffort: 'high',
          tier: 'strong',
        },
      ],
      unsupported: [],
    },
  },
  'opencode-go-anthropic': {
    key: 'opencode-go-anthropic',
    label: 'OpenCode Go (Anthropic 协议)',
    description: 'OpenCode Go 的 /v1/messages 端点：Qwen / MiniMax 等模型，支持 cache_control 断点',
    defaultModelId: 'qwen3.7-max',
    keyUrl: 'https://opencode.ai/zen',
    provider: {
      name: 'opencode-go-anthropic',
      apiKeyEnv: 'OPENCODE_GO_KEY',
      baseUrl: 'https://opencode.ai/zen/go',
      protocol: 'anthropic',
      capabilities: {
        cacheControl: true,
        stripParams: [],
        toolJsonBug: false,
        prefixCache: 'anthropic-cache-control',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 64_000,
      models: [
        {
          id: 'qwen3.7-max',
          alias: 'go-qwen37',
          description: 'Qwen3.7 Max：1M 上下文',
          contextWindow: 1_000_000,
          maxTokens: 64_000,
          reasoningEffort: 'high',
          tier: 'strong',
        },
        {
          id: 'qwen3.6-plus',
          alias: 'go-qwen36',
          description: 'Qwen3.6 Plus：1M 上下文',
          contextWindow: 1_000_000,
          maxTokens: 64_000,
          reasoningEffort: 'high',
          tier: 'strong',
        },
        {
          id: 'qwen3.5-plus',
          alias: 'go-qwen35',
          description: 'Qwen3.5 Plus：1M 上下文',
          contextWindow: 1_000_000,
          maxTokens: 64_000,
          reasoningEffort: 'high',
          tier: 'strong',
        },
      ],
      unsupported: [],
    },
  },
  mimo: {
    key: 'mimo',
    label: 'MiMo',
    description: '小米 MiMo：1M 上下文，性价比推理',
    defaultModelId: 'mimo-v2.5-pro',
    keyUrl: 'https://mimo.mi.com/',
    provider: {
      name: 'mimo',
      apiKeyEnv: 'MIMO_API_KEY',
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: false,
        prefixCache: 'deepseek-native',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 128000,
      models: [
        {
          id: 'mimo-v2.5-pro',
          description: 'MiMo 旗舰推理档',
          alias: 'mimo-pro',
          contextWindow: 1_000_000,
          maxTokens: 128000,
          tier: 'strong',
          pricing: { input: 0.8, output: 3.2, cacheRead: 0.08, cacheWrite: 0.8 },
        },
        {
          id: 'mimo-v2.5',
          description: 'MiMo 轻量廉价档',
          alias: 'mimo',
          contextWindow: 1_000_000,
          maxTokens: 128000,
          tier: 'cheap',
          pricing: { input: 0.2, output: 0.8, cacheRead: 0.02, cacheWrite: 0.2 },
        },
      ],
      unsupported: ['stream_options'],
    },
  },
  'mimo-api': {
    key: 'mimo-api',
    label: 'MiMo API (新)',
    description: '小米 MiMo 按量 API，超速档',
    defaultModelId: 'mimo-v2.5-pro-ultraspeed',
    keyUrl: 'https://mimo.mi.com/',
    provider: {
      name: 'mimo-api',
      apiKeyEnv: 'MIMO_PAY_API_KEY',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: false,
        prefixCache: 'deepseek-native',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 128000,
      models: [
        {
          id: 'mimo-v2.5-pro-ultraspeed',
          description: 'MiMo 超速档',
          alias: 'mimo-ultra',
          contextWindow: 1_000_000,
          maxTokens: 128000,
          tier: 'strong',
          pricing: { input: 0.8, output: 3.2, cacheRead: 0.08, cacheWrite: 0.8 },
        },
      ],
      unsupported: ['stream_options'],
    },
  },
  minimax: {
    key: 'minimax',
    label: 'MiniMax',
    description: 'MiniMax：多档模型，旗舰带视觉',
    defaultModelId: 'MiniMax-M2.7',
    keyUrl: 'https://platform.minimaxi.com/',
    provider: {
      name: 'minimax',
      apiKeyEnv: 'MINIMAX_API_KEY',
      baseUrl: 'https://api.minimaxi.com/v1',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
        toolJsonBug: false,
        prefixCache: 'deepseek-native',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 64000,
      models: [
        {
          id: 'MiniMax-M2.7',
          description: 'MiniMax 均衡档',
          alias: 'minimax',
          contextWindow: 204_800,
          maxTokens: 64000,
          tier: 'balanced',
          pricing: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.3 },
        },
        {
          id: 'MiniMax-M3',
          description: 'MiniMax 旗舰，视觉支持',
          alias: 'minimax-m3',
          contextWindow: 1_000_000,
          maxTokens: 64000,
          tier: 'strong',
          supportsVision: true,
          pricing: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.3 },
        },
      ],
      unsupported: [],
    },
  },
  siliconflow: {
    key: 'siliconflow',
    label: '硅基流动 (SiliconFlow)',
    description: '聚合站：多模型可选，含 DeepSeek/GLM/Kimi/Qwen',
    aggregator: true,
    defaultModelId: 'deepseek-ai/DeepSeek-V4-Pro',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    provider: {
      name: 'siliconflow',
      apiKeyEnv: 'SILICONFLOW_API_KEY',
      baseUrl: 'https://api.siliconflow.cn/v1',
      protocol: 'openai',
      capabilities: {
        // WELL_KNOWN_DEFAULTS['siliconflow'] provides canonical cacheControl / stripParams
        // / prefixCache / prefixCompletion. Default model is a DeepSeek proxy → keep
        // the DeepSeek "tool JSON leaks into content" bug marker here; other fields
        // fall through to WELL_KNOWN.
        toolJsonBug: true,
      },
      thinking: 'enabled',
      maxTokens: 384_000,
      models: [
        {
          id: 'deepseek-ai/DeepSeek-V4-Pro',
          description: 'DeepSeek 旗舰推理（聚合）',
          alias: 'sf-v4-pro',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoningEffort: 'high',
          tier: 'strong',
          pricing: { input: 1.6, output: 3.135, cacheRead: 0.135 },
        },
        {
          id: 'deepseek-ai/DeepSeek-V4-Flash',
          description: 'DeepSeek 快档（聚合）',
          alias: 'sf-v4-flash',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoningEffort: 'medium',
          tier: 'cheap',
          pricing: { input: 0.13, output: 0.28 },
        },
        {
          id: 'zai-org/GLM-5.2',
          description: 'GLM 旗舰，视觉支持（聚合）',
          alias: 'sf-glm',
          contextWindow: 1_000_000,
          maxTokens: 131_072,
          reasoningEffort: 'max',
          tier: 'strong',
          supportsVision: true,
          pricing: { input: 1.4, output: 4.4 },
        },
        {
          id: 'moonshotai/Kimi-K2.7-Code',
          description: 'Kimi 编码模型（聚合）',
          alias: 'sf-kimi',
          contextWindow: 262_144,
          maxTokens: 131_072,
          tier: 'strong',
          pricing: { input: 0.94, output: 4.0 },
        },
        {
          id: 'Qwen/Qwen3.6-27B',
          description: '通义 Qwen 均衡档（聚合）',
          alias: 'sf-qwen',
          contextWindow: 262_144,
          maxTokens: 131_072,
          tier: 'balanced',
          pricing: { input: 0.3, output: 3.2 },
        },
      ],
      unsupported: [],
    },
  },
  // openai 必须排在 codex 之前：别名表按 preset 顺序合并重复 canonical
  // （gpt-5.6-sol 两处都有），保留首个条目的元数据——官方 API 定价优先于
  // codex 的订阅折算价。
  openai: {
    key: 'openai',
    label: 'OpenAI',
    description: 'OpenAI 官方 API：GPT-5.6 系列（Sol 旗舰 / Terra 均衡 / Luna 轻量）',
    defaultModelId: 'gpt-5.6-sol',
    keyUrl: 'https://platform.openai.com/api-keys',
    provider: {
      name: 'openai',
      apiKeyEnv: 'OPENAI_API_KEY',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: false,
        // OpenAI prompt caching 是服务端自动的，无需客户端标记。
        prefixCache: 'none',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 128_000,
      models: [
        {
          id: 'gpt-5.6-sol',
          description: '旗舰：1.05M 上下文，视觉支持',
          alias: 'sol',
          contextWindow: 1_050_000,
          maxTokens: 128_000,
          reasoningEffort: 'max',
          tier: 'strong',
          supportsVision: true,
          pricing: { input: 5, output: 30, cacheRead: 2.5, cacheWrite: 5 },
        },
        {
          id: 'gpt-5.6-terra',
          description: '均衡档：日常任务性价比之选',
          alias: 'terra',
          contextWindow: 400_000,
          maxTokens: 128_000,
          reasoningEffort: 'high',
          tier: 'strong',
          supportsVision: true,
          pricing: { input: 2.5, output: 15, cacheRead: 1.25, cacheWrite: 2.5 },
        },
        {
          id: 'gpt-5.6-luna',
          description: '轻量档：低成本快速任务',
          alias: 'luna',
          contextWindow: 400_000,
          maxTokens: 128_000,
          reasoningEffort: 'medium',
          tier: 'cheap',
          supportsVision: true,
          pricing: { input: 1, output: 6, cacheRead: 0.5, cacheWrite: 1 },
        },
      ],
      unsupported: [],
    },
  },
  codex: {
    key: 'codex',
    label: 'Codex',
    description: 'OpenAI Codex：OAuth 登录，旗舰推理',
    defaultModelId: 'gpt-5.6-sol',
    provider: {
      name: 'codex',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      protocol: 'openai',
      auth: { type: 'oauth', provider: 'codex' },
      capabilities: {
        cacheControl: true,
        stripParams: [],
        toolJsonBug: false,
        prefixCache: 'none',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 128000,
      models: [
        {
          id: 'gpt-5.6-sol',
          description: 'OpenAI 旗舰（Sol），视觉支持',
          alias: 'codex',
          contextWindow: 1_050_000,
          maxTokens: 128000,
          reasoningEffort: 'max',
          tier: 'strong',
          supportsVision: true,
          pricing: { input: 1.0, output: 4.0, cacheRead: 0.5, cacheWrite: 1.0 },
        },
      ],
      unsupported: [],
    },
  },
  longcat: {
    key: 'longcat',
    label: 'LongCat (美团龙猫)',
    description: '美团龙猫：1M 上下文，缓存读取免费',
    defaultModelId: 'LongCat-2.0',
    keyUrl: 'https://longcat.chat/platform/',
    provider: {
      name: 'longcat',
      apiKeyEnv: 'LONGCAT_API_KEY',
      baseUrl: 'https://api.longcat.chat/openai/v1',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: false,
        // LongCat cache 命中免费（官方政策），存在服务端隐式前缀缓存
        prefixCache: 'deepseek-native',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 131072,
      models: [
        {
          id: 'LongCat-2.0',
          description: '龙猫旗舰，缓存读取免费',
          alias: 'longcat',
          contextWindow: 1_000_000,
          maxTokens: 131072,
          tier: 'strong',
          // 官方定价 $0.75/$2.95 per M tokens (≈ ¥5/¥20)，cache read 免费
          pricing: { input: 0.75, output: 2.95, cacheRead: 0, cacheWrite: 0.75 },
        },
      ],
      unsupported: [],
    },
  },
  ccswitch: {
    key: 'ccswitch',
    label: 'CC Switch',
    description: 'cc-switch 本地代理：Claude/GPT/DeepSeek 等',
    aggregator: true,
    defaultModelId: 'claude-opus-4-8',
    provider: {
      name: 'ccswitch',
      apiKeyEnv: 'CC_SWITCH_PROXY_API_KEY',
      baseUrl: process.env.CC_SWITCH_PROXY_URL ?? 'http://127.0.0.1:8891/v1',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
        toolJsonBug: false,
        prefixCache: 'none',
        prefixCompletion: false,
      },
      // cc-switch 入口层透传 reasoning_effort，Rectifier 翻译为上游原生格式
      thinking: 'enabled',
      maxTokens: 128000,
      models: [
        {
          id: 'claude-opus-4-8',
          description: 'Claude 最强推理',
          alias: 'cc-opus',
          contextWindow: 1_000_000,
          maxTokens: 128000,
          reasoningEffort: 'max',
          tier: 'strong',
        },
        {
          id: 'claude-sonnet-4-5',
          description: 'Claude 均衡档',
          alias: 'cc-sonnet',
          contextWindow: 1_000_000,
          maxTokens: 128000,
          reasoningEffort: 'high',
          tier: 'strong',
        },
        {
          id: 'deepseek-v4-pro',
          description: 'DeepSeek 旗舰（代理）',
          alias: 'cc-dsv4',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoningEffort: 'high',
          tier: 'strong',
        },
        {
          id: 'glm-5.2',
          description: 'GLM 旗舰，视觉支持（代理）',
          alias: 'cc-glm',
          contextWindow: 1_000_000,
          maxTokens: 131_072,
          reasoningEffort: 'max',
          tier: 'strong',
          supportsVision: true,
        },
        {
          id: 'gpt-5.6',
          description: 'GPT 最新旗舰',
          alias: 'cc-gpt56',
          contextWindow: 200_000,
          maxTokens: 128_000,
          reasoningEffort: 'max',
          tier: 'strong',
        },
        {
          id: 'gpt-5.5',
          description: 'GPT 旗舰',
          alias: 'cc-gpt55',
          contextWindow: 200_000,
          maxTokens: 128_000,
          reasoningEffort: 'high',
          tier: 'strong',
        },
      ],
      unsupported: [],
    },
  },
  // 智谱免费视觉模型 — 走通用 PaaS 端点（非 coding 套餐端点）。
  // glm-4v-flash 是智谱首个完全免费的图像理解模型，API 调用免费、不限期。
  // 与 glm provider 复用同一个 ZHIPU_API_KEY，但端点不同：
  //   coding 套餐 → api/coding/paas/v4（glm provider 用，按订阅计费）
  //   通用 PaaS  → api/paas/v4（本 provider 用，glm-4v-flash 在此免费）
  // 上下文 8K / 最大输出 1K —— 只适合做识图桥（描述图片），不适合当主控。
  'zhipu-vision': {
    key: 'zhipu-vision',
    label: '智谱视觉 (GLM-4V-Flash 免费)',
    description: '智谱免费视觉桥：只适合识图，不适合主控',
    defaultModelId: 'glm-4v-flash',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    provider: {
      name: 'zhipu-vision',
      apiKeyEnv: 'ZHIPU_API_KEY',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: false,
        prefixCache: 'none',
        prefixCompletion: false,
      },
      thinking: 'disabled',
      maxTokens: 1024,
      models: [
        {
          id: 'glm-4v-flash',
          description: '免费识图桥（8K 上下文）',
          alias: 'glm-4v-flash',
          contextWindow: 8192,
          maxTokens: 1024,
          tier: 'cheap',
          supportsVision: true,
          pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, free: true },
        },
      ],
      unsupported: ['stream_options'],
    },
  },
  // 阿里 DashScope（通义千问 Qwen 官方 OpenAI 兼容端点）。
  // 模型能力分裂：Qwen3-max 支持 thinking block，Qwen-plus/turbo 不支持 ——
  // 由用户在 models[].capabilities 里按 model 覆盖（WELL_KNOWN_DEFAULTS 给出
  // 默认 thinkingBlockType='enabled'，对不支持 thinking 的 model 显式设 'none'）。
  dashscope: {
    key: 'dashscope',
    label: '阿里云百炼 (DashScope)',
    description: '阿里 DashScope：Qwen 系列官方端点，OpenAI 兼容协议',
    defaultModelId: 'qwen3.8-max',
    keyUrl: 'https://bailian.console.aliyun.com/',
    billingModes: [
      {
        id: 'payg',
        label: '按量计费',
        description: '需替换 {WorkspaceId} 为你的业务空间 ID（百炼控制台可查）',
        baseUrl: 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      },
      {
        id: 'token-plan',
        label: 'token plan',
        description: '订阅制 token 套餐专用端点',
        baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      },
    ],
    provider: {
      name: 'dashscope',
      apiKeyEnv: 'DASHSCOPE_API_KEY',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      protocol: 'openai',
      capabilities: {},
      thinking: 'enabled',
      maxTokens: 32_768,
      models: [
        {
          id: 'qwen3.8-max',
          description: 'Qwen3.8 旗舰（1M 上下文，支持 thinking）',
          alias: 'qs-max',
          contextWindow: 1_000_000,
          maxTokens: 131_072,
          reasoningEffort: 'high',
          tier: 'strong',
          pricing: { input: 12, output: 36, cacheRead: 1.5, cacheWrite: 15 },
          capabilities: { thinkingBlock: 'enabled', effortFormat: 'reasoning_effort' },
        },
        {
          id: 'qwen3.7-max',
          description: 'Qwen3.7 旗舰（1M 上下文，支持 thinking）',
          alias: 'qs37-max',
          contextWindow: 1_000_000,
          maxTokens: 131_072,
          reasoningEffort: 'high',
          tier: 'strong',
          capabilities: { thinkingBlock: 'enabled', effortFormat: 'reasoning_effort' },
        },
        {
          id: 'qwen3.7-plus',
          description: 'Qwen3.7 均衡档（1M 上下文，支持 thinking）',
          alias: 'qs37-plus',
          contextWindow: 1_000_000,
          maxTokens: 131_072,
          reasoningEffort: 'medium',
          tier: 'balanced',
          capabilities: { thinkingBlock: 'enabled', effortFormat: 'reasoning_effort' },
        },
        {
          id: 'qwen3.7-flash',
          description: 'Qwen3.7 快速档（1M 上下文，低成本）',
          alias: 'qs37-flash',
          contextWindow: 1_000_000,
          maxTokens: 131_072,
          reasoningEffort: 'medium',
          tier: 'cheap',
          capabilities: { thinkingBlock: 'enabled', effortFormat: 'reasoning_effort' },
        },
      ],
      unsupported: [],
    },
  },
  // OpenRouter — 国际聚合，含 OpenAI/Claude/Anthropic/开源模型。
  // thinking block 透传不稳定（多数模型只支持 reasoning_effort 透传），
  // 故 WELL_KNOWN_DEFAULTS 设 thinkingBlockType='none'、effortFormat='reasoning_effort'。
  openrouter: {
    key: 'openrouter',
    label: 'OpenRouter',
    description: 'OpenRouter 聚合：OpenAI / Claude / Gemini / 开源模型',
    aggregator: true,
    defaultModelId: 'anthropic/claude-sonnet-4.5',
    keyUrl: 'https://openrouter.ai/settings/keys',
    provider: {
      name: 'openrouter',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      baseUrl: 'https://openrouter.ai/api/v1',
      protocol: 'openai',
      capabilities: {},
      thinking: 'enabled',
      maxTokens: 32_768,
      models: [
        {
          id: 'anthropic/claude-sonnet-4.5',
          description: 'Claude Sonnet 4.5（聚合）',
          alias: 'or-sonnet',
          contextWindow: 200_000,
          maxTokens: 32_768,
          reasoningEffort: 'high',
          tier: 'strong',
        },
        {
          id: 'openai/gpt-5',
          description: 'GPT-5（聚合）',
          alias: 'or-gpt5',
          contextWindow: 200_000,
          maxTokens: 32_768,
          reasoningEffort: 'high',
          tier: 'strong',
        },
      ],
      unsupported: [],
    },
  },
  // one-api / new-api 自建中转通用模板。
  // 不预设具体模型 —— baseUrl 从环境变量取，用户按需填模型列表。
  // WELL_KNOWN_DEFAULTS['relay'] 提供 thinking 能力默认值（block=none + effort=reasoning_effort），
  // 与 ccswitch 同模板，但默认 config 不激活，让用户手动启用以避免体验重复。
  relay: {
    key: 'relay',
    label: '自建中转 (one-api / new-api)',
    description: '通用 OpenAI 兼容中转模板（one-api / new-api 等），baseUrl 走 RELAY_BASE_URL 环境变量',
    aggregator: true,
    defaultModelId: 'gpt-5',
    provider: {
      name: 'relay',
      apiKeyEnv: 'RELAY_API_KEY',
      baseUrl: process.env.RELAY_BASE_URL ?? 'http://127.0.0.1:3000/v1',
      protocol: 'openai',
      capabilities: {},
      thinking: 'enabled',
      maxTokens: 32_768,
      models: [
        {
          id: 'gpt-5',
          description: '示例模型（按需替换）',
          alias: 'relay-gpt5',
          contextWindow: 200_000,
          maxTokens: 32_768,
          reasoningEffort: 'high',
          tier: 'strong',
        },
      ],
      unsupported: [],
    },
  },
  volc: {
    key: 'volc',
    label: '火山方舟 (豆包)',
    description: '火山引擎方舟：豆包 Doubao 系列，OpenAI 兼容端点',
    defaultModelId: 'doubao-seed-2.0-pro',
    keyUrl: 'https://console.volcengine.com/ark',
    provider: {
      name: 'volc',
      apiKeyEnv: 'VOLC_API_KEY',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: false,
        prefixCache: 'none',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 32_768,
      // 方舟模型以控制台接入点为准——探测（/v3/models）能拉到真实列表，
      // 下表仅兜底推荐，型号随方舟发布更新。
      models: [
        {
          id: 'doubao-seed-2.0-pro',
          description: '豆包旗舰（以方舟控制台接入点为准）',
          alias: 'doubao-pro',
          contextWindow: 262_144,
          maxTokens: 32_768,
          reasoningEffort: 'high',
          tier: 'strong',
        },
        {
          id: 'doubao-seed-2.0-flash',
          description: '豆包快速档：低延迟轻量任务',
          alias: 'doubao-flash',
          contextWindow: 131_072,
          maxTokens: 16_384,
          reasoningEffort: 'medium',
          tier: 'cheap',
        },
      ],
      unsupported: [],
    },
  },
  // 本地 Ollama —— 免密钥，向导跳过 key 步直接探测。
  // 模型表只是兜底示例：探测能拉到用户实际 pull 的模型列表。
  ollama: {
    key: 'ollama',
    label: '本地 Ollama',
    description: '本地部署（默认 11434 端口），无需 API Key',
    keyless: true,
    defaultModelId: 'qwen3',
    provider: {
      name: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: false,
        prefixCache: 'none',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 32_768,
      models: [
        {
          id: 'qwen3',
          description: '示例模型（按你实际 pull 的模型替换）',
          alias: 'ollama-qwen3',
          contextWindow: 32_768,
          maxTokens: 8_192,
          reasoningEffort: 'medium',
          tier: 'cheap',
        },
      ],
      unsupported: [],
    },
  },
}

export const providerPresetKeys = Object.keys(PROVIDER_PRESETS) as ProviderPresetKey[]

export function cloneProviderPreset(key: ProviderPresetKey): ProviderConfig {
  return structuredClone(PROVIDER_PRESETS[key].provider)
}

export function isProviderPresetKey(value: string): value is ProviderPresetKey {
  return Object.prototype.hasOwnProperty.call(PROVIDER_PRESETS, value)
}

/** keyless 判定（单一事实源）：预设声明 keyless，或自定义 provider 未配密钥材料
 * 且 baseUrl 指向 loopback。云端 baseUrl 无 key 不算 keyless——忘配 key 必须
 * fail-closed 而非放行撞 401。消费方：resolveApiKey、config/providers、欢迎页。 */
export function isKeylessProviderEntry(
  name: string,
  entry?: { apiKey?: string; keyRef?: string; apiKeyEnv?: string; baseUrl?: string },
): boolean {
  if (isProviderPresetKey(name)) return PROVIDER_PRESETS[name].keyless === true
  if (!entry) return false
  if (entry.apiKey || entry.keyRef || entry.apiKeyEnv) return false
  return isLoopbackBaseUrl(entry.baseUrl)
}

/**
 * Look up a preset model's defaults by provider name and model id/alias.
 *
 * Used by CLI setup paths so that known models (e.g. deepseek-v4-pro)
 * inherit their real context window instead of a silent 128K default —
 * a wrong small window causes premature compaction tiers on 1M models.
 */
export function findPresetModel(providerName: string, modelId: string): ModelConfig | undefined {
  if (!isProviderPresetKey(providerName)) return undefined
  return PROVIDER_PRESETS[providerName].provider.models.find(
    m => m.id === modelId || m.alias === modelId,
  )
}
