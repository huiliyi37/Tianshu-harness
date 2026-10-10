/**
 * 审批提示的风险解释（Wave 1-2）。
 *
 * 用户停在一个权限提示前，真正缺的往往不是"要不要批"这个问题，而是回答它所需的
 * 信息：这条命令实际做什么、在当前上下文里为什么需要它、批了可能出什么问题。
 * 本模块按需生成这三点并给一个 low/medium/high 评级。
 *
 * 本模块只负责「问什么」与「怎么解析」；缓存与安全纪律统一由 `side-path-ask.ts`
 * 承担。这里唯一的额外约束是：**按键才发请求，绝不预生成**——绝大多数审批用户一眼
 * 就能判，为每次弹窗预先烧一次请求既费钱又拖慢弹窗出现。
 */

import { askSidePath, type SidePathAskDeps } from './side-path-ask.js'

export type RiskLevel = 'low' | 'medium' | 'high'

export interface RiskExplanation {
  level: RiskLevel
  /** 已按行拆分的解释正文，供 TUI 直接渲染。 */
  lines: string[]
}

export type RiskExplainDeps = SidePathAskDeps

export interface RiskExplainParams {
  toolName: string
  input: Record<string, unknown>
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 20_000
/** 解释正文的行数上限。审批提示是行内展示，超出会把待批的命令挤出屏幕。 */
const MAX_LINES = 6

function buildInstruction(toolName: string, input: Record<string, unknown>): string {
  let rendered: string
  try {
    rendered = JSON.stringify(input, null, 2)
  } catch {
    rendered = String(input)
  }
  // 极长入参（大段文件内容）截断：解释要的是意图，不是原文。
  if (rendered.length > 4000) rendered = rendered.slice(0, 4000) + '\n…（已截断）'

  return [
    '【侧路提问，不影响主任务】上面是当前对话。agent 正请求执行下面这个工具，等待用户批准：',
    '',
    `工具：${toolName}`,
    '参数：',
    '```json',
    rendered,
    '```',
    '',
    '请基于上述对话上下文，帮用户判断是否该批准。回答三点：',
    '1. 它实际会做什么（不要复述参数，说效果）',
    '2. 结合当前对话，为什么这一步是需要的',
    '3. 批准后可能出什么问题——是否不可逆、影响范围多大',
    '',
    '第一行必须是 `RISK: low`、`RISK: medium` 或 `RISK: high` 三者之一，',
    `其后用中文简述，最多 ${MAX_LINES} 行，不要用标题、不要调用工具。`,
    '评级口径：只读或易撤销 = low；会改动工作区但可回滚 = medium；',
    '不可逆、触及工作区外、或会影响远端/生产 = high。',
  ].join('\n')
}

/** 解析模型输出。首行取评级，其余为正文；评级缺失时保守判 medium。 */
export function parseRiskExplanation(raw: string): RiskExplanation | null {
  const text = raw.trim()
  if (!text) return null

  const lines = text.split('\n')
  let level: RiskLevel = 'medium'
  let bodyStart = 0

  const head = lines[0]?.trim() ?? ''
  const m = /^`?RISK:\s*(low|medium|high)`?/i.exec(head)
  if (m) {
    level = m[1]!.toLowerCase() as RiskLevel
    bodyStart = 1
  }

  const body = lines
    .slice(bodyStart)
    .map(l => l.replace(/\s+$/, ''))
    .filter((l, i, arr) => !(l === '' && (i === 0 || arr[i - 1] === '')))
  while (body.length > 0 && body[0] === '') body.shift()
  while (body.length > 0 && body[body.length - 1] === '') body.pop()

  if (body.length === 0) return null
  return { level, lines: body.slice(0, MAX_LINES) }
}

/**
 * 为一次待批准的工具调用生成风险解释。返回 null 表示不可用（无客户端、超时、
 * 被取消或模型无输出）——调用方应当静默降级，审批本身不受影响。
 */
export async function explainToolRisk(
  deps: RiskExplainDeps,
  params: RiskExplainParams,
): Promise<RiskExplanation | null> {
  const raw = await askSidePath(deps, {
    instruction: buildInstruction(params.toolName, params.input),
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: params.signal,
    purpose: 'risk_explain',
  })
  return raw === null ? null : parseRiskExplanation(raw)
}
