import { ref, computed } from 'vue'
import { release } from '../release'

export type Locale = 'zh' | 'en'

const translations: Record<Locale, Record<string, string>> = {
  zh: {
    // Navbar
    'nav.features': '特性',
    'nav.stars': '星域',
    'nav.demo': '演示',
    'nav.download': '下载',
    'nav.docs': '文档',
    'nav.faq': 'FAQ',
    'nav.github': 'GitHub',
    'nav.download_btn': '下载',

    // Hero
    'hero.badge': `${release.license} 开源 · 终端 AI 编程代理`,
    'hero.title': '天枢',
    'hero.subtitle': '终端里的 AI 编程合伙人',
    'hero.desc': '为 DeepSeek V4 前缀缓存优化的开源编程代理。支持多模型路由、子智能体编排、结构化安全机制，让长会话开发高效且可控。',
    'hero.install_hint': `需要 Node.js ${release.nodeMajor}+。也可直接`,
    'hero.download_desktop': '下载桌面版',
    'hero.cta_download': '下载桌面版',
    'hero.cta_terminal': '终端快速开始',
    'hero.learn_more': '了解更多',

    // Trust Bar
    'trust.prefix_cache': 'Prefix Cache 命中率',
    'trust.models': '支持模型',
    'trust.tools': '内置工具',
    'trust.opensource': '开源协议',

    // Star Skills
    'stars.badge': '星域技能',
    'stars.title': '群星协作，各尽其道',
    'stars.desc': '天枢不是单一模型，而是一片星图。每颗星承担不同认知职责，在长会话中共同定向、称量、突破与守护。',

    // Features
    'features.badge': '为长会话编程而生',
    'features.title': '不只是 AI 助手，是开发伙伴',
    'features.desc': '天枢把上下文当作结构化、可缓存的资源来管理，让每一次代码修改都可控、可回滚、可验证。',
    'feature.cache.title': 'Prefix Cache 引擎',
    'feature.cache.desc': '冻结前缀 + 增量附录，DeepSeek V4 实战命中率高达 95–99%，显著降低长会话成本。',
    'feature.router.title': '多模型自适应路由',
    'feature.router.desc': '一条命令切换 DeepSeek、Claude、GLM、Codex、MiniMax、MiMo，主代理与子代理可配置不同模型。',
    'feature.agent.title': '子智能体编排',
    'feature.agent.desc': '类型化 work order、只读/写 worker 隔离、批量调度与多种聚合策略，复杂任务自动拆解。',
    'feature.security.title': '结构化安全机制',
    'feature.security.desc': '路径边界、敏感文件拒绝、审批模式、git checkpoint + 文件级 undo，fail-closed 默认安全。',
    'feature.mcp.title': 'MCP 扩展生态',
    'feature.mcp.desc': '通过 Model Context Protocol 接入文档搜索、数据库、API 等外部工具服务器。',
    'feature.desktop.title': '天枢桌面版',
    'feature.desktop.desc': 'Tauri 构建的本地 App：多会话 dashboard、artifact 审查、审批介入、定时任务、浏览器验证。',

    // Terminal Demo
    'demo.title': '看天枢如何工作',
    'demo.desc': '设定目标后，它自动读取、规划、修改、验证，并在每一步保持上下文紧凑。',
    'demo.hover_pause': '悬停暂停',

    // Download
    'download.badge': '桌面版',
    'download.title': '开箱即用，本地化运行',
    'download.desc': '基于 Tauri 2.x 构建的本地 App。Node runtime 作为 localhost sidecar 运行，代码与上下文完全保留在本地。',
    'download.btn': '下载',
    'download.coming_soon': '即将推出',
    'download.features_title': '桌面版核心能力',
    'download.feature1': '多会话 Dashboard，实时查看 phase 与进度',
    'download.feature2': 'Artifact 审查与反馈回灌',
    'download.feature3': '审批 / Intent 介入，diff 可视化',
    'download.feature4': '定时任务 /schedule，cron 会话管理',
    'download.feature5': '浏览器验证与外部 OAuth 登录',

    // Quick Start
    'quickstart.title': '终端快速开始',
    'quickstart.desc': '几分钟内即可在终端运行天枢。支持交互式 TUI 与 headless 脚本模式。',
    'quickstart.step1_title': '克隆并构建',
    'quickstart.step2_title': '配置 API Key',
    'quickstart.step3_title': '启动',
    'quickstart.docs_link': '完整用户手册',
    'quickstart.docs_hint': '了解模型配置、Slash 命令与安全审批。',

    // FAQ
    'faq.title': '常见问题',
    'faq.q1': '天枢和 Copilot/Cursor 有什么区别？',
    'faq.a1': '天枢是一个运行在终端/桌面的开源代理，强调「Models as partners」：它拥有认知虚拟机、自感知层和信息素记忆，能在长会话中保持上下文紧凑，并针对 DeepSeek V4 前缀缓存做了深度优化。',
    'faq.q2': '使用天枢需要付费吗？',
    'faq.a2': '天枢本身是 Apache-2.0 开源软件，免费使用。你只需要自备模型提供商的 API Key（如 DeepSeek、Claude 等），按需支付给模型提供商。',
    'faq.q3': '支持哪些模型提供商？',
    'faq.a3': '目前支持 DeepSeek、Claude（通过 cc-switch 代理）、GLM、Codex (ChatGPT OAuth)、MiniMax、MiMo。会话内可用 /model 命令随时切换。',
    'faq.q4': '代码安全吗？会不会泄露到云端？',
    'faq.a4': '天枢默认在本地运行，代码和上下文不会上传到天枢的服务器。路径边界、敏感文件拒绝、审批模式等机制进一步保护你的代码库。',
    'faq.q5': '桌面版和终端版有什么区别？',
    'faq.a5': '终端版是核心 TUI，适合习惯命令行的开发者；桌面版在 TUI 之上提供了图形化 Dashboard、Artifact 审查、审批面板和多会话管理，更适合需要可视化介入的场景。',
    'faq.q6': '如何参与贡献？',
    'faq.a6': '欢迎提交 Issue 和 PR。请阅读仓库中的 CONTRIBUTING.md 了解开发流程、代码规范和测试要求。',

    // Community
    'community.badge': '开源社区',
    'community.title': '与社区一起构建',
    'community.desc': '天枢采用 Apache-2.0 协议开源。欢迎提交 Issue、PR，或分享你的使用经验。',
    'community.github': 'GitHub',
    'community.github_desc': '查看源码、提交反馈、参与贡献',
    'community.github_btn': '访问仓库',
    'community.docs': '文档',
    'community.docs_desc': '配置指南、模型提供方、Slash 命令',
    'community.docs_btn': '阅读文档',
    'community.discuss': '讨论',
    'community.discuss_desc': '交流用法、分享技能与最佳实践',
    'community.discuss_btn': '加入讨论',
    'community.footer': '由社区驱动，Apache-2.0 协议开源',

    // Footer
    'footer.copyright': '©',
    'footer.features': '特性',
    'footer.download': '下载',
    'footer.quickstart': '快速开始',
    'footer.contributing': '贡献',
    'footer.license': 'Apache-2.0',
  },
  en: {
    // Navbar
    'nav.features': 'Features',
    'nav.stars': 'Stars',
    'nav.demo': 'Demo',
    'nav.download': 'Download',
    'nav.docs': 'Docs',
    'nav.faq': 'FAQ',
    'nav.github': 'GitHub',
    'nav.download_btn': 'Download',

    // Hero
    'hero.badge': `${release.license} Open Source · Terminal AI Programming Agent`,
    'hero.title': 'Tianshu',
    'hero.subtitle': 'Your AI Programming Partner in Terminal',
    'hero.desc': 'An open-source programming agent optimized for DeepSeek V4 prefix caching. Supports multi-model routing, sub-agent orchestration, and structured security mechanisms for efficient and controllable long-session development.',
    'hero.install_hint': `Requires Node.js ${release.nodeMajor}+. Or directly`,
    'hero.download_desktop': 'Download Desktop',
    'hero.cta_download': 'Download Desktop',
    'hero.cta_terminal': 'Terminal Quick Start',
    'hero.learn_more': 'Learn More',

    // Trust Bar
    'trust.prefix_cache': 'Prefix Cache Hit Rate',
    'trust.models': 'Supported Models',
    'trust.tools': 'Built-in Tools',
    'trust.opensource': 'Open Source License',

    // Star Skills
    'stars.badge': 'Star Skills',
    'stars.title': 'A Constellation of Collaborators',
    'stars.desc': 'Tianshu is not a single model, but a star chart. Each star holds a different cognitive responsibility, orienting, weighing, breaking through, and guarding together across long sessions.',

    // Features
    'features.badge': 'Built for Long-Session Programming',
    'features.title': 'Not Just an AI Assistant, a Development Partner',
    'features.desc': 'Tianshu treats context as a structured, cacheable resource, making every code modification controllable, rollbackable, and verifiable.',
    'feature.cache.title': 'Prefix Cache Engine',
    'feature.cache.desc': 'Frozen prefix + incremental append, DeepSeek V4 real-world hit rate up to 95-99%, significantly reducing long-session costs.',
    'feature.router.title': 'Multi-Model Adaptive Routing',
    'feature.router.desc': 'Switch between DeepSeek, Claude, GLM, Codex, MiniMax, MiMo with one command. Main and sub-agents can use different models.',
    'feature.agent.title': 'Sub-Agent Orchestration',
    'feature.agent.desc': 'Typed work orders, read/write worker isolation, batch scheduling with multiple aggregation strategies for automatic complex task decomposition.',
    'feature.security.title': 'Structured Security Mechanisms',
    'feature.security.desc': 'Path boundaries, sensitive file rejection, approval mode, git checkpoint + file-level undo, fail-closed default security.',
    'feature.mcp.title': 'MCP Extension Ecosystem',
    'feature.mcp.desc': 'Connect to document search, databases, APIs and other external tool servers via Model Context Protocol.',
    'feature.desktop.title': 'Tianshu Desktop',
    'feature.desktop.desc': 'Tauri-built local App: multi-session dashboard, artifact review, approval intervention, scheduled tasks, browser verification.',

    // Terminal Demo
    'demo.title': 'See How Tianshu Works',
    'demo.desc': 'After setting a goal, it automatically reads, plans, modifies, verifies, and keeps context compact at every step.',
    'demo.hover_pause': 'Hover to Pause',

    // Download
    'download.badge': 'Desktop',
    'download.title': 'Ready to Use, Runs Locally',
    'download.desc': 'A local App built with Tauri 2.x. Node runtime runs as a localhost sidecar, code and context stay completely local.',
    'download.btn': 'Download',
    'download.coming_soon': 'Coming Soon',
    'download.features_title': 'Desktop Core Capabilities',
    'download.feature1': 'Multi-session Dashboard, real-time phase and progress viewing',
    'download.feature2': 'Artifact review and feedback injection',
    'download.feature3': 'Approval / Intent intervention, diff visualization',
    'download.feature4': 'Scheduled tasks /schedule, cron session management',
    'download.feature5': 'Browser verification and external OAuth login',

    // Quick Start
    'quickstart.title': 'Terminal Quick Start',
    'quickstart.desc': 'Run Tianshu in terminal within minutes. Supports interactive TUI and headless script mode.',
    'quickstart.step1_title': 'Clone and Build',
    'quickstart.step2_title': 'Configure API Key',
    'quickstart.step3_title': 'Start',
    'quickstart.docs_link': 'Full User Guide',
    'quickstart.docs_hint': 'Learn about model configuration, Slash commands, and security approval.',

    // FAQ
    'faq.title': 'Frequently Asked Questions',
    'faq.q1': "What's the difference between Tianshu and Copilot/Cursor?",
    'faq.a1': "Tianshu is an open-source agent running in terminal/desktop, emphasizing 'Models as partners': it has a cognitive VM, self-awareness layer, and pheromone memory, maintaining compact context in long sessions, with deep optimization for DeepSeek V4 prefix caching.",
    'faq.q2': 'Does Tianshu require payment?',
    'faq.a2': 'Tianshu itself is Apache-2.0 open-source software, free to use. You only need to provide your own model provider API Key (like DeepSeek, Claude, etc.) and pay the provider as needed.',
    'faq.q3': 'Which model providers are supported?',
    'faq.a3': 'Currently supports DeepSeek, Claude (via cc-switch proxy), GLM, Codex (ChatGPT OAuth), MiniMax, MiMo. Use /model command to switch anytime within a session.',
    'faq.q4': 'Is my code secure? Will it leak to the cloud?',
    'faq.a4': 'Tianshu runs locally by default, code and context are not uploaded to any server. Path boundaries, sensitive file rejection, approval mode and other mechanisms further protect your codebase.',
    'faq.q5': "What's the difference between desktop and terminal versions?",
    'faq.a5': 'Terminal version is the core TUI, suitable for developers comfortable with command line; Desktop version adds graphical Dashboard, Artifact review, approval panel and multi-session management on top of TUI, more suitable for scenarios requiring visual intervention.',
    'faq.q6': 'How to contribute?',
    'faq.a6': 'Welcome to submit Issues and PRs. Please read CONTRIBUTING.md in the repository for development workflow, code standards, and testing requirements.',

    // Community
    'community.badge': 'Open Source Community',
    'community.title': 'Build with the Community',
    'community.desc': 'Tianshu is open-sourced under Apache-2.0 license. Welcome to submit Issues, PRs, or share your experience.',
    'community.github': 'GitHub',
    'community.github_desc': 'View source, submit feedback, contribute',
    'community.github_btn': 'Visit Repository',
    'community.docs': 'Docs',
    'community.docs_desc': 'Configuration guide, model providers, Slash commands',
    'community.docs_btn': 'Read Docs',
    'community.discuss': 'Discussions',
    'community.discuss_desc': 'Share usage, tips and best practices',
    'community.discuss_btn': 'Join Discussion',
    'community.footer': 'Community-driven, Apache-2.0 open source',

    // Footer
    'footer.copyright': '©',
    'footer.features': 'Features',
    'footer.download': 'Download',
    'footer.quickstart': 'Quick Start',
    'footer.contributing': 'Contributing',
    'footer.license': 'Apache-2.0',
  },
}

const saved = localStorage.getItem('tianshu-locale') as Locale | null
const initialLocale: Locale = saved === 'en' ? 'en' : 'zh'

const locale = ref<Locale>(initialLocale)

export function useI18n() {
  const t = computed(() => (key: string) => translations[locale.value][key] || key)

  function setLocale(newLocale: Locale) {
    locale.value = newLocale
    localStorage.setItem('tianshu-locale', newLocale)
  }

  return {
    locale: computed(() => locale.value),
    setLocale,
    t: t.value,
  }
}
