/**
 * session-module-store-reaper — 会话键控的 agent 层 module store 收割汇点。
 *
 * wave 结果桥 / wave 门禁 / plan-store / post-commit 待审集 / skill-gate 五张
 * 会话键控表此前只注册不清理——跑过团队计划/defer 审查的会话把这些记录永久
 * 钉在进程内（cron 每任务新 sessionId，长驻 sidecar 日积月累可达百 MB 级）。
 * releaseAgent（空闲回收/归档）与 hardDelete 都经 session-manager 的
 * forgetStores 走到这里，故每表按 sessionId 精确删除即可双链全覆盖。
 *
 * @module session-module-store-reaper
 */

import { clearWaveResults } from './wave-results-store.js'
import { clearWaveGate } from './wave-gate.js'
import { clearPlan } from './plan-store.js'
import { clearPendingReview } from './post-commit-review-pending.js'
import { clearSkillGate } from './skill-gate.js'

/**
 * 收割指定会话在五张 module store 里的条目。各 clear 均按 sessionId 精确
 * 删除，不触碰他会在用条目与 '__default__' 兜底键；运行中的会话不会走到
 * releaseAgent，故不存在清掉在飞运行数据的窗口。
 */
export function reapSessionModuleStores(sessionId: string): void {
  try { clearWaveResults(sessionId) } catch { /* best-effort */ }
  try { clearWaveGate(sessionId) } catch { /* best-effort */ }
  try { clearPlan(sessionId) } catch { /* best-effort */ }
  try { clearPendingReview(sessionId) } catch { /* best-effort */ }
  try { clearSkillGate(sessionId) } catch { /* best-effort */ }
}
