/**
 * 技能加载失败的按会话记录通道。
 *
 * 天枢有两条技能加载路径，分属两个模块：
 *  - `session-manager.createSession`：立即加载（技能面板在首条消息前就要能显示），
 *    结果记进 `session.skillLoadErrors`。
 *  - `serve-agent.buildSessionStores`：agent 创建时补做 `importFromClaude` 的文件
 *    复制（幂等），其 errors 此前被直接丢弃 —— 配了 `skills.importFromClaude: ["x"]`
 *    而 x 拿不到时，用户永远看不到提示，只会觉得「配了却没生效」。
 *
 * 两条路径的 errors 需要在 `GET /sessions/:id/skills` 的 `loadErrors` 里合并展示，
 * 但两个模块互相 import 会形成环（serve-agent 只以 `import type` 引用
 * session-manager）。故把共享状态放这里：两边都只依赖本模块。
 */

const bySession = new Map<string, string[]>()

/** 记录一次技能导入的结果。空数组即清理，避免残留上一轮的旧错误。 */
export function recordSkillLoadErrors(sessionId: string, errors: string[]): void {
  if (errors.length === 0) bySession.delete(sessionId)
  else bySession.set(sessionId, [...errors])
}

/** 该会话由 agent 创建路径补做的技能加载所报的错误（无则空数组）。 */
export function getSkillLoadErrorsForSession(sessionId: string): string[] {
  return bySession.get(sessionId) ?? []
}

/** 会话永久销毁时清理（内存有界）。 */
export function forgetSkillLoadErrors(sessionId: string): void {
  bySession.delete(sessionId)
}
