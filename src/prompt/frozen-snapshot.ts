/**
 * 冻结前缀快照的可序列化形态——随会话落盘（`<id>.frozen.json`），
 * resume 时读回经 PromptEngine 的 inheritFrozenFrom 喂给新引擎，
 * 历史 user 消息恢复原始字节 → 服务商前缀缓存 TTL 内 resume 不再
 * byte-0 全 miss（只在新 user 边界断尾）。
 *
 * 独立成模块（零依赖）是为了让 session-persist 直接引用而不产生
 * prompt/engine ↔ agent/session-persist 的循环依赖。
 */

import { isRewindGenerationAuthorization } from '../api/continuation-prefix.js'

export interface FrozenSnapshotData {
  executionSnapshot?: import('../api/continuation-prefix.js').ContinuationPrefixProof
  rewindAuthorization?: import('../api/continuation-prefix.js').RewindGenerationAuthorization
  v: 1 | 2
  userKeys?: string[]
  anchors?: import('./frozen-anchors.js').FrozenAnchor[]
  /** sha256 of the stable frozen volatile block at export time. A resume in the
   *  same cwd/config must match and may reuse the active boundary bytes; a
   *  mismatch means the config changed and the active boundary must rebuild. */
  frozenBaseHash?: string
  frozenUserMerged: Array<[string, string[]]>
  frozenPendingMerged: Array<[string, string]>
  firstUserKey: string | null
  collapseWatermark: number
  collapseTokenStep: number
}

/** 盘存快照的最小形状校验（坏文件/旧版本 → undefined，调用方降级为全量重建）。 */
export function parseFrozenSnapshotData(raw: unknown): FrozenSnapshotData | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const d = raw as Record<string, unknown>
  if (d.rewindAuthorization !== undefined && !isRewindGenerationAuthorization(d.rewindAuthorization)) return undefined
  if (d['v'] !== 1 && d['v'] !== 2) return undefined
  if (d.userKeys !== undefined && (!Array.isArray(d.userKeys) || !d.userKeys.every(k => typeof k === 'string' && /^[a-f0-9]{64}:\d+$/.test(k)))) return undefined
  if (d.frozenBaseHash !== undefined && (typeof d.frozenBaseHash !== 'string' || !/^[a-f0-9]{64}$/.test(d.frozenBaseHash))) return undefined
  if (d['v'] === 2 && (!Array.isArray(d.anchors) || !d.anchors.every(a =>
    a && typeof a.key === 'string' && /^[a-f0-9]{64}:\d+$/.test(a.key)
    && (a.type === 'text' || a.type === 'parts') && typeof a.prefix === 'string'
    && typeof a.suffix === 'string' && (a.legacyText === undefined || typeof a.legacyText === 'string')))) return undefined
  if (!Array.isArray(d['frozenUserMerged']) || !Array.isArray(d['frozenPendingMerged'])) return undefined
  if (!d.frozenUserMerged.every(x => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string'
    && Array.isArray(x[1]) && x[1].every((v: unknown) => typeof v === 'string'))) return undefined
  if (!d.frozenPendingMerged.every(x => Array.isArray(x) && x.length === 2 && x.every(v => typeof v === 'string'))) return undefined
  if (typeof d['collapseWatermark'] !== 'number' || typeof d['collapseTokenStep'] !== 'number' || !Number.isFinite(d.collapseWatermark) || !Number.isFinite(d.collapseTokenStep)) return undefined
  if (d['firstUserKey'] !== null && typeof d['firstUserKey'] !== 'string') return undefined
  return raw as FrozenSnapshotData
}
