/**
 * /handoff 交接能力 — 提示构建与提醒文案（纯函数，零依赖）。
 *
 * 设计（详见 slash-commands.ts 的 /handoff 注册）：
 * - agent 带全上下文把交接文档写到项目内 `.rivet/HANDOFF.md`（工作区内免审批）；
 * - TUI 在该 turn 完成后归档一份到会话目录 `<id>.handoff.md`——
 *   现有 loadPrevHandoff 注入管线（prev-session-handoff appendix）无缝受益；
 * - 上下文占用 ≥ HANDOFF_NUDGE_RATIO 时提醒用户先交接再开新会话。
 */

/** 上下文占用达到该比例时提醒 /handoff（首屏 resume + 会话中各一次）。 */
export const HANDOFF_NUDGE_RATIO = 0.6

/**
 * 交接指令全文——经 submitToAgent 发给 agent 执行。
 * 固定五章节：任务目标 / 已完成 / 当前卡点 / 下一步 / 坑。
 * 写给一个完全没有上下文的新会话（agent + 人类）看。
 */
export function buildHandoffPrompt(absPath: string, note?: string): string {
  const lines = [
    '本会话即将结束。请用 write_file 把交接文档写入下面的路径（覆盖写）：',
    '',
    `  ${absPath}`,
    '',
    '交接文档写给一个完全没有上下文的新会话（agent 和人类）看——读者看不到本会话的任何消息，',
    '所以文档必须自包含：不许引用「上文」「之前说过」「刚才的讨论」，关键事实全部落字。',
    '',
    '固定章节（标题照用）：',
    '## 任务目标 — 我们在做什么：用户原话级的一句话目标 + 明确的非目标',
    '## 已完成 — 每条带证据：改动文件（file:line）、跑过的验证命令与结果、提交哈希（如有）',
    '## 当前卡点 — 卡在哪、已排除哪些方向、怀疑对象',
    '## 下一步 — 按优先级排列、每条是可立即执行的动作（不是「继续优化」这种泛话）',
    '## 坑 — 绝对不要再踩的坑：每条一句话说清后果（别人踩过的别再交一遍学费）',
    '',
    '要求：具体、可执行、有 file:line 级锚点；不知道的就写「未知」，不要编造。写完回复一行确认。',
  ]
  if (note && note.trim()) {
    lines.push('', `用户补充指示：${note.trim()}`)
  }
  return lines.join('\n')
}

/**
 * 60% 交接提醒文案。ratio 为 estimatedTokens/contextWindow（调用方保证 ≥0）。
 */
export function formatHandoffNudge(ratio: number): string {
  const pct = Math.round(ratio * 100)
  return `⏜ 上下文已占用约 ${pct}%——建议 /handoff 写交接文档后开新会话（交接文档落在会话目录，新会话可直接读；比整段回连省前缀重建成本）。`
}
