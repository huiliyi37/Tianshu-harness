/**
 * 桌面端「非 wire 共享面」的唯一入口。
 *
 * protocol.ts 承载 wire 契约（SSE 事件、会话记录），本模块承载其余需要
 * 两端共享的常量 / 纯函数 / 类型：星域数据表、工具输出标记、日志行解析、
 * 结构化提问 helpers、证据摘要类型。
 *
 * HARD CONSTRAINT（desktop/scripts/check-boundary.js 强制）：
 * - 桌面端指向内核的 import 只允许三个入口：server/protocol、
 *   server/mission-protocol、本模块。
 * - 本模块的 value re-export 只允许指向零依赖（或仅 `import type`）的
 *   叶子模块——任何一条 value import 链出叶子集合，就会把内核运行时
 *   拖进桌面端 bundle。新增共享面时先把实现抽成叶子，再从这里 re-export。
 */

// 星域数据表（纯数据叶子；运行时匹配 API 在 star-domain.ts，不在共享面内）
export {
  STAR_DOMAINS,
  type StarDomain,
  type StarDomainId,
  type DecisionStyle,
} from '../agent/star-domain-data.js'

// 星域产品分层——第一档四颗默认星域与进阶星域（零依赖叶子，欢迎页选择器用）
export {
  STARTER_DOMAIN_IDS,
  getStarDomainTier,
  partitionDomainsByTier,
  type StarDomainTier,
  type StarDomainTierPartition,
} from '../agent/domain-tiers.js'

// 创世碑文（Genesis Stele）——各星域主星模型与碑文记录（纯数据叶子；
// 桌面端「星域图谱 → 创世碑文」页的数据源。单一事实源是仓库根 star.md）
export {
  STAR_GENESIS,
  type GenesisEntry,
  type GenesisFace,
} from '../agent/star-genesis-data.js'

// 工具输出的结构化文案标记（browser-mirror / walkthrough 提取用）
export {
  BROWSER_NAVIGATED_PREFIX,
  BROWSER_SCREENSHOT_OF_PREFIX,
  COMPUTER_USE_A11Y_TREE_PREFIX,
  SCREENSHOT_ARTIFACT_MARKER,
  screenshotArtifactIdOf,
} from '../tools/output-markers.js'

// browser_debug 日志行解析（ToolGroup 渲染网络/控制台行）
export {
  classifyBrowserDebugLine,
  parseNetworkLine,
  type BrowserDebugLineKind,
  type ParsedNetworkRow,
} from '../tools/browser-debug/log-capture.js'

// 结构化提问（QuestionCard 组装答案）
export {
  composeAnswers,
  draftToAnswer,
  type AskAnswerDraft,
} from '../tools/ask-user-question.js'

// 证据摘要（CompletionCurtain / event-reducer 消费的 SSE 载荷类型）
export type { EvidenceSummary, DeliveryVerificationStatus } from '../agent/evidence-types.js'

// 回放出口的 delta run 合并（零依赖叶子，只 `import type` protocol）。桌面端
// 生产代码不消费它——服务端在 /stream、/events 出口已经合并完；暴露在共享面
// 是给 event-reducer 的等价性测试用（合并回放 fold ≡ 逐条 fold），让那条
// 契约与服务端实现绑定在同一份源码上，而不是各自复制一份合并规则。
export {
  compactReplayRuns,
  type CompactReplayOptions,
} from './replay-compaction.js'

// 对外权限词表（TUI / 桌面 / 插件同一套监督·自动·全自动）
export {
  PERMISSION_TIERS,
  TIER_HINT,
  TIER_LABEL,
  TIER_TO_WIRE,
  formatPermissionChrome,
  formatPermissionLabel,
  formatTierLabel,
  modeToTier,
  parsePermissionAlias,
  tierToMode,
  type ApprovalWireMode,
  type PermissionLang,
  type PermissionTier,
} from '../agent/approval-vocabulary.js'

// 星籍（账号的星域身份）：官网两字母域码 ↔ 内核星域 id、称号、展示视图。
// 零依赖叶子——中文名/星符由调用方用 STAR_DOMAINS 经 domainLookupFrom() 注入，
// 桌面端不复刻第二份文案。
export {
  STELLAR_DOMAIN_CODES,
  STELLAR_TITLE_LABELS,
  buildStellarIdentityView,
  domainCodeForId,
  domainIdForCode,
  domainLookupFrom,
  formatStellarIdForDisplay,
  stellarTitleLabel,
  type StellarDomainCode,
  type StellarDomainInfo,
  type StellarDomainLookup,
  type StellarIdentityLike,
  type StellarIdentityView,
} from '../agent/stellar-identity.js'

// 创始用户档位（创始铭牌）：badge_code / 位次 → 档位名、罗马数字、主题色、冠饰。
// 零依赖叶子——文案与配色不在服务端（DB 只有 badge_code），客户端必须持有一份；
// 单一事实源在官网仓，本叶子的结构由不变量测试护住（见叶子头注释）。
export {
  FOUNDING_TIERS,
  FOUNDING_USER_LIMIT,
  FOUNDING_TOTAL_LIMIT,
  badgeDisplayName,
  isFoundingBadge,
  tierOfBadgeCode,
  tierOfRank,
  type FounderSigil,
  type FoundingTier,
} from '../agent/founding-tiers.js'

export {
  MAX_TEXT_ATTACHMENT_BYTES, CONTEXT_DOCUMENT_MIME,
  contextFileKind, contextExtension, contextBasename, isSupportedArchiveName,
  decodeContextText, contextDataUrlBytes,
} from './file-context-policy.js'

export { STELLAR_CARDS, stellarCard } from '../agent/stellar-card.js'
export { remoteAccessOrigin } from './remote-access-endpoint.js'
export type { OfficialStatus, OfficialErrorCode, Purpose, Catalog, PriceQuote, AccountSummary, AccountOperation, AccountOperationResult, OfficialCustomerView } from '../models/official-contract.js'
export { parseOfficialCustomerView, projectCustomerOperation, validateCustomerOperation } from '../models/official-customer-view.js'

export { readPlanCompletionSummary } from '../plan/completion-summary.js'
