/**
 * token-ledger 公共类型：本地 token 消耗台账 + 论坛同步快照。
 *
 * 事实源是各会话的 `cache-log.jsonl` 计费行（判据见
 * `src/cache/usage-aggregator.ts::isBilledCacheLogEvent`，本模块不重复定义）；
 * 本模块在其上做两层加工：
 *   1. 本地台账（TokenLedgerState）——按 day × model(×provider) 累计，落盘
 *      `~/.rivet/token-ledger.json`，append-only 日志按字节偏移增量消费；
 *   2. 论坛快照（TokenUsageSnapshot）——**累计语义**的幂等载荷，论坛端按
 *      deviceId upsert 最新快照即可，丢包/重推/乱序都不会重复计数。
 */

/** 单粒累计记录：day × model(×provider)。 */
export interface TokenDayModelRecord {
  /** local-time YYYY-MM-DD（与 usage-aggregator 的 dayKey 同口径） */
  date: string
  model: string
  provider?: string
  /** 计费请求数（主请求 + side_path + aborted retry 行） */
  requests: number
  /** cache-inclusive input tokens（与 Usage.input_tokens 口径一致） */
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  /** 按行级时间计价（DeepSeek 官方峰谷经 findUsagePricing）；定价缺失落 0 */
  cost: number
}

export interface TokenLedgerTotals {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  cost: number
}

export interface TokenHourModelRecord {
  hour: string
  model: string
  provider: string
  input: number
  output: number
}

export interface TokenHourlyCoverage {
  state: 'complete' | 'partial'
  from: string | null
  through: string | null
  missingFiles: number
}

/** 推送论坛的快照载荷（POST body）。累计快照，论坛端按 deviceId upsert。 */
export interface TokenUsageSnapshot {
  version: 1 | 2
  hours?: TokenHourModelRecord[]
  /** 安装级匿名 id（首次生成后独立持久化，并兼容旧台账身份迁移） */
  deviceId: string
  /** 展示用设备名（config tokenLedger.deviceName，缺省 os.hostname()） */
  deviceName: string
  /** 本次推送时间 ISO 字符串 */
  sentAt: string
  totals: TokenLedgerTotals
  /** 累计 day×model 明细，按 date 升序 */
  days: TokenDayModelRecord[]
}

/**
 * 台账落盘状态。失效方向：offsets 与 days 必须同一份原子写入——
 * 折叠持久化失败两者都不前进（下次重扫重算），绝不允许「days 已加、offsets 未走」
 * 之外的反向（offsets 走、days 没加 = 丢数据）。跨进程刷新和回执在独占锁内
 * reload → 更新 → 原子持久化，避免旧实例整文件覆盖较新的累计和回执。
 */
export interface TokenLedgerState {
  version: 1
  deviceId: string
  hours?: Record<string, Record<string, TokenHourModelRecord>>
  hourlyMigration?: { version: 1; files: Record<string, { offset: number; partial: boolean; evidence?: string }> }
  syncBatch?: {digest:string;targetHash:string;pages:TokenUsageSnapshot[];nextPage:number;lastConfirmedAt?:string}
  /** cache-log 相对 sessionsRoot 的路径 → 已消费字节偏移（日志 append-only） */
  offsets: Record<string, number>
  /** date → bucketKey(provider\0model 或裸 model) → 累计记录 */
  days: Record<string, Record<string, TokenDayModelRecord>>
  /** cache-log相对路径 → 已消费attempt键，跨增量批次/重启去重。 */
  attempts?: Record<string, string[]>
  /** 最近一次构造快照的单调时间；独立身份文件也保留用于账本恢复。 */
  lastSnapshotAt?: string
  /** 最近一次回执所确认/处理的快照时间，防止乱序回执覆盖。 */
  lastPushSnapshotAt?: string
  /** 最近一次确认的同步目标摘要（不含API key原文）。 */
  lastPushedTargetHash?: string
  /** 最近一次成功推送（2xx）时间 */
  lastPushAt?: string
  /** 最近一次 2xx 确认的快照摘要；与当前 digest 不同 = 有未推送变更 */
  lastPushedDigest?: string
  lastPushResult?: { ok: boolean; status?: number; code?: string; error?: string; at?: string }
}
