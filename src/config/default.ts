import type { Config } from './schema.js'
import { cloneProviderPreset } from './provider-presets.js'

export const DEFAULT_CONFIG: Config = {
  editor: { platform: 'auto', eol: 'auto' },
  provider: {
    default: 'deepseek',
    providers: {
      deepseek: cloneProviderPreset('deepseek'),
      // Kimi Code 订阅端点（api.kimi.com/coding/v1 + KIMI_API_KEY + k3）——
      // 与预设 kimi 同源，避免「预设卡」与「内置供应商」两套端点/模型 id 漂移。
      kimi: cloneProviderPreset('kimi'),
      glm: cloneProviderPreset('glm'),
      claude: {
        name: 'claude',
        apiKeyEnv: 'CLAUDE_API_KEY',
        // Anthropic 无原生 OpenAI 兼容端点；需自行部署代理（如 litellm/openrouter）并替换此 URL。
        baseUrl: 'https://api.anthropic.com/v1',
        protocol: 'openai' as const,
        capabilities: {
          cacheControl: false,
          stripParams: [],
          toolJsonBug: false,
          prefixCache: 'none' as const,
          prefixCompletion: false,
        },
        thinking: 'enabled',
        maxTokens: 128000,
        models: [
          {
            id: 'claude-opus-4-8',
            // alias 用实际后端名，消除迷惑。id 不可改（代理按 id 路由）。
            alias: 'qwen37-max',
            contextWindow: 1_000_000,
            maxTokens: 128000,
            reasoningEffort: 'max',
          },
          {
            id: 'claude-opus-4-7',
            alias: 'opus-4-7',
            contextWindow: 1_000_000,
            maxTokens: 128000,
            reasoningEffort: 'max',
          },
          {
            id: 'claude-opus-4-6',
            alias: 'opus-4-6',
            contextWindow: 1_000_000,
            maxTokens: 128000,
            reasoningEffort: 'max',
          },
          {
            id: 'claude-sonnet-4-5',
            alias: 'sonnet-4-5',
            contextWindow: 1_000_000,
            maxTokens: 128000,
            reasoningEffort: 'max',
          },
        ],
        unsupported: [],
      },
      mimo: cloneProviderPreset('mimo'),
      'mimo-api': cloneProviderPreset('mimo-api'),
      minimax: cloneProviderPreset('minimax'),
      codex: cloneProviderPreset('codex'),
      ccswitch: cloneProviderPreset('ccswitch'),
      // Aggregator / relay providers — registered but not the default.
      // Users pick them from the provider selector when they have the
      // corresponding API key / self-hosted relay running.
      siliconflow: cloneProviderPreset('siliconflow'),
      dashscope: cloneProviderPreset('dashscope'),
      openrouter: cloneProviderPreset('openrouter'),
      relay: cloneProviderPreset('relay'),
    },
  },
  agent: {
    approval: 'suggest',
    unsandboxed: false,
    maxTurns: 200,
    mode: 'code',
    autoReasoning: true,
    defaultDomain: 'qiming',
    domainKeywordRouting: true,
    verificationSnapshot: 'auto',
    songlineEnabled: false,
    constellationEnabled: false,
    companionPresenceEnabled: false,
    dreamEnabled: true,
    securityGuidance: true,
    scoutEvidenceFirewall: false,
    desktopTools: false,
    crossSessionEnabled: true,
    hearthObserveEnabled: false,
    toolGating: {
      enabled: true,
      extraCore: [],
      disabledTools: [],
    },
    antiAnchoring: {
      enabled: false,
      blindExploration: true,
      mctsPlanning: false,
      branches: 3,
      planningTurn: 1,
      projectionThreshold: 0.4,
      seedMaxTokens: 512,
      anchorBreakScout: {
        enabled: false,
        complexityThreshold: 0.5,
        minTurn: 3,
        scoutBudgetMs: 60_000,
        scoutMaxTokens: 2048,
      },
    },
    autoDelegateEnabled: false,
    maxDelegationDepth: 2,
    maxTeamParallel: 3,
    council: { seats: [] },
    checkpointEveryTurns: 0,
    intentRetrievalRouter: {
      enabled: true,
      classifier: 'heuristic',
      timeoutMs: 4_000,
      maxTokens: 600,
      temperature: 0,
    },
    llmSpeculation: {
      enabled: false,
      maxPerTurn: 3,
      maxTokens: 320,
      timeoutMs: 8_000,
      minProbability: 0.5,
      slowToolsOnly: true,
    },
    teamSchedulerBanditEnabled: false,
    modelTierBanditEnabled: false,
    modelRoutingGatedEnabled: false,
    banditPromotion: {
      modelTier: 'shadow',
      teamScheduler: 'shadow',
      modelRouting: 'shadow',
      effort: 'shadow',
      killSwitch: false,
    },
    permissions: {
      allow: [],
      deny: [],
      bash: { allowlist: [], denylist: [] },
      additionalReadDirs: [],
      additionalWriteDirs: [],
    },
    review: {
      profiles: {},
      skipAuto: false,
      skipAutoSpark: false,
      mechanicalFastPath: true,
    },
    // 未配 visionModel 时不自动挑视觉模型送图——opt-in，见 schema 注释。
    visionAutoBridge: false,
    goal: {
      judge: {
        enabled: true,
        maxRuns: 3,
        browser: false,
      },
    },
    greeting: {
      enabled: true,
      model: 'deepseek-v4-flash',
    },
    delivery: {
      autoCommit: true,
    },
  },
  compact: {
    enabled: true,
    autoThreshold: 800_000,
    autoFloor: 500_000,
    model: 'deepseek-v4-flash',
    qualityCompact: {
      perTokenThreshold: 0.55,
      subscriptionThreshold: 0.45,
      subscriptionCeiling: 0.6,
    },
  },
  search: {
    // bing first: cn.bing.com is China-reachable with no API key and returns
    // direct URLs. duckduckgo is the offshore fallback. Users on either side
    // of the GFW get at least one working backend without touching config.
    backends: ['bing', 'duckduckgo'],
    braveApiKeyEnv: 'BRAVE_API_KEY',
    tavilyApiKeyEnv: 'TAVILY_API_KEY',
    bochaApiKeyEnv: 'BOCHA_API_KEY',
    timeoutMs: 15_000,
  },
  fetch: {
    timeoutMs: 15_000,
    maxResponseBytes: 10_485_760,
    maxRedirects: 5,
    userAgent: 'Tianshu/1.0 (terminal coding agent)',
    extractMainContent: true,
    enablePlaywright: false,
    renderTimeoutMs: 30_000,
    renderWaitMs: 0,
    cacheMaxAgeMs: 172_800_000,
    jinaBaseUrl: 'https://r.jina.ai',
  },
  network: {},
  mcp: {
    enabled: true,
    servers: {},
  },
  workers: {
    profiles: {
      cheap: { provider: 'minimax', model: 'MiniMax-M2.7' },
      'cheap-flash': { provider: 'deepseek', model: 'deepseek-v4-flash' },
      capable: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      mimo: { provider: 'mimo', model: 'mimo-v2.5' },
      'mimo-pro': { provider: 'mimo', model: 'mimo-v2.5-pro' },
      'mimo-ultra': { provider: 'mimo-api', model: 'mimo-v2.5-pro-ultraspeed' },
    },
    routing: {
      repo_summarization: 'cheap-flash',
      code_edit: 'cheap-flash',
      test_failure_diagnosis: 'cheap-flash',
      risky_refactor: 'cheap-flash',
      // 2026-08-02：v4-flash 能力实测已超 v4-pro（去廉价化），planning 同走 flash
      planning: 'cheap-flash',
    },
    patcherTier: 'cheap',
    escalationCap: 'off',
  },
  skills: {
    importFromClaude: [],
  },
  mirrors: {
    enabled: false,
    preset: 'default',
    github: 'default',
    npm: 'default',
    pypi: 'default',
    go: 'default',
    rust: 'default',
    autoFallback: true,
    fallbackMemoryMinutes: 10,
    fallbackTimeoutSec: 60,
  },
  prDefaults: {
    mergeMethod: 'squash',
    autoFix: false,
    autoMerge: false,
    ciPollSeconds: 10,
  },
  env: {
    resolve: true,
    extraPath: [],
    extraVars: {},
  },
  ui: {},
  // 项目验证命令声明 — 默认空，由项目层 .rivet-config.json 覆盖（/init 生成）
  verify: {},
  tools: {},
  // 前缀档位：空对象 = 走 schema 默认（standard）。这里刻意不写死 profile，
  // 让「无配置 = 现状」这一不变量只有一个来源（block-policy.resolvePromptBlocks）。
  prompt: { blocks: {} },
  // Runtime lean：默认关。开启后展开为 minimal tools / lean prompt / 无 embeddings
  // / 无 Meridian 启动回填 / 更紧的会话驻留（见 runtime-lean.ts）。
  // 按域覆盖（domains）：defaultDomain 钉定某域时该域配置优先于全局——
  // 例：{ "agent": { "defaultDomain": "changgeng" }, "runtime": { "lean": false,
  //   "domains": { "changgeng": { "lean": true, "toolPreset": "taiyi" } } } }
  // → 启动即长庚域 + lean + 最小工具集，无需启动参数（/config 面板可配）。
  runtime: { lean: false, domains: {} },
  // Pro 双层模式：enabled 由许可证/RIVET_PRO 决定（Basic=false）；features 与
  // schema 默认一致为 true——「Pro 激活即全部 Pro 功能可用」，显式 false 才关。
  // 注意 DEFAULT_CONFIG 是 loadConfig 的第一层，会 deep-merge 覆盖 schema 默认，
  // 这里写 false 会导致 Pro 用户也拿不到功能（2026-07-10 修复）。
  pro: {
    enabled: false,
    features: {
      computerUse: true,
      chatGateway: true,
      teamMax: true,
      councilMultiRound: true,
      unattendedAutomation: true,
      spark: true,
    },
  },
  plugins: { enabled: {} },
  hooks: {},
}
