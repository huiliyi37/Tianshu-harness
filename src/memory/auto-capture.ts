/**
 * 记忆形成（auto-capture）：重要操作后模型自主判断 + 截取摘要 → 写入长期记忆。
 *
 * 与 essence-gate 的分工：gate 是会话末对「可迁移本质原则」的质量门；这里是对
 * 「刚做的重要操作」的操作后捕获（实现/修复、踩坑/根因），标准见 product 需求。
 * 职责只在判断 + 写 LTM，不改变 essence-gate、supersede、写锁协议。
 *
 * 缓存纪律：本模块只写 `.rivet/knowledge/memory.jsonl`（LTM），不触碰 prompt；
 * 召回侧（adaptive-memory / memory recall）负责后续注入。闭环 = 形成 → 写入 → 使用。
 */

import type { RuntimeToolEvent } from '../agent/runtime-hooks.js'
import { appendMemoryEntry, type MemoryKind, type MemorySource } from './unified-memory.js'
import { scrubMemoryText } from './memory-scrub.js'

/// 抄送端类型：postTool hook 传入的工具事件形状（与 runtime-hooks 对齐）。
export interface CaptureCandidate {
  /** 触发工具名（write_file / run_tests / bash …）。 */
  tool: string
  success: boolean
  /** 工具参数摘要（目标文件 / 命令首行）。 */
  summary: string
  /** 工具结果摘要（error / pass / 关键输出）。 */
  result: string
  failureClass?: string
}

export interface CaptureVerdict {
  index: number
  /** 模型判断是否值得沉淀。 */
  worth: boolean
  /** 截取的摘要（worth=true 时写入）。 */
  summary: string
  kind: MemoryKind
  confidence: number
  /** 适用范围（可选，与 essence-gate 的 transferableTo 同语义）。 */
  transferableTo?: string[]
  topic?: string
}

const CODE_WRITE_TOOLS = new Set(['write_file', 'write', 'edit', 'edit_file', 'apply_patch', 'ast_edit', 'hash-edit', 'multi_edit'])
const FAILURE_HINTS = /\b(error|fail|fatal|exception|traceback|ENOENT|EACCES|E2BIG|timeout|reject|undefined)\b/i

/** 供记忆形成判断用，拼接候选中文摘要。 */
function toolLabel(tool: string): string {
  const map: Record<string, string> = {
    write_file: '写文件', write: '写文件', edit: '改文件', edit_file: '改文件',
    apply_patch: '打补丁', ast_edit: '改代码', 'hash-edit': '改代码', multi_edit: '多处修改',
    run_tests: '跑测试', bash: '执行命令', deliver: '交付', plan_close: '关闭计划',
  }
  return map[tool] ?? tool
}

/**
 * 启发式预筛：判定一个工具操作是否「值得让模型再判断」。
 * 只筛掉明显不相关的工具，把真正的重要判断交给模型（省 LLM 调用，不漏原则）。
 */
export function isImportantOperation(
  tool: RuntimeToolEvent,
  _cwd: string,
): CaptureCandidate | null {
  // 只关心写入/验证/执行类工具；纯读库/搜索/对话不沉淀。
  const isWrite = CODE_WRITE_TOOLS.has(tool.name)
  const isError = tool.isError === true || tool.failureClass !== undefined || !tool.success
  const isTest = tool.name === 'run_tests'
  const isBash = tool.name === 'bash'
  const target = typeof tool.target === 'string' ? tool.target : ''
  const resultContent = (tool.resultContent ?? '').slice(0, 400) || (tool.failureClass ?? '')

  // 错误 / 失败（发现坑、根因）：任意工具报错都算候选。
  if (isError) {
    if (!resultContent && !isBash && !isTest) return null
    return {
      tool: tool.name, success: tool.success,
      summary: `${toolLabel(tool.name)} ${target}`.trim() || toolLabel(tool.name),
      result: resultContent || '失败',
      failureClass: tool.failureClass,
    }
  }

  // 写代码成功（实现/修复）：只对代码目标沉淀。
  if (isWrite) {
    if (target && !/\.(ts|tsx|js|jsx|py|rs|go|java|cs|cpp|c|h|rb|vue|svelte|zig|sh)$/.test(target) && !target.includes('src/')) {
      return null
    }
    return {
      tool: tool.name, success: true,
      summary: `${toolLabel(tool.name)} ${target}`.trim(),
      result: resultContent.slice(0, 300),
    }
  }

  // 测试通过（验证）。
  if (isTest) {
    return {
      tool: tool.name, success: true,
      summary: '跑测试', result: resultContent.slice(0, 300),
    }
  }

  // bash 重要输出（报错已在上方覆盖）。只筛目标/结果里带失败信号的命令。
  if (isBash && FAILURE_HINTS.test(target + ' ' + resultContent)) {
    return {
      tool: tool.name, success: tool.success,
      summary: target.slice(0, 120),
      result: resultContent.slice(0, 300),
    }
  }

  return null
}

/** 判断 prompt（模型自主判断 + 截取摘要）。 */
export function buildCapturePrompt(candidates: CaptureCandidate[], sessionId?: string): string {
  const lines: string[] = []
  lines.push('你是编码智能体的记忆筛选器。下面是一段会话里发生的操作。判断哪些是值得跨会话记住的：')
  lines.push('1. 实现了/修复了某样东西（代码层面）')
  lines.push('2. 发现了一个坑或报错根因')
  lines.push('3. 用户明确交代要记住的约束')
  lines.push('4. 其余琐碎操作不要记。')
  lines.push('对每个值得记的操作，截取成一段简洁的摘要（1-2 句，能脱离上下文独立理解），并给 kind。')
  lines.push('kind 只取：decision（实现/修复）、failure_pattern（坑/根因）、user_constraint（约束）、verification_fact（验证）。')
  lines.push('')
  lines.push(`候选（${candidates.length} 条，CANDIDATES）：`)
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!
    lines.push(`${i} | ${c.tool} | 成功=${c.success} | ${c.summary.slice(0, 160)}`)
    lines.push(`   结果：${c.result.slice(0, 240)}`)
  }
  lines.push('')
  lines.push('只返回一个 JSON 数组（无 markdown 围栏），每个候选一项：')
  lines.push('[{"index":0,"worth":true,"summary":"...","kind":"decision","confidence":0.9,"transferableTo":["..."],"topic":"..."}]')
  if (sessionId) lines.push(`会话：${sessionId}`)
  return lines.join('\n')
}

function extractJsonArray(raw: string): string | null {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced?.[1]?.trim() ?? trimmed
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return null
  return body.slice(start, end + 1)
}

const VALID_KINDS = new Set<MemoryKind>([
  'decision', 'failure_pattern', 'user_constraint', 'verification_fact',
  'project_rule', 'finding',
])

/** 解析模型裁决。结构性意外返回 null（fail-closed）。 */
export function parseCaptureOutput(raw: string, candidateCount: number): CaptureVerdict[] | null {
  const jsonText = extractJsonArray(raw)
  if (!jsonText) return null
  let parsed: unknown
  try { parsed = JSON.parse(jsonText) } catch { return null }
  if (!Array.isArray(parsed)) return null

  const verdicts: CaptureVerdict[] = []
  const seen = new Set<number>()
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const v = item as Record<string, unknown>
    const index = typeof v.index === 'number' ? v.index : Number.NaN
    if (!Number.isInteger(index) || index < 0 || index >= candidateCount || seen.has(index)) continue
    seen.add(index)
    const kind = VALID_KINDS.has(v.kind as MemoryKind) ? v.kind as MemoryKind : 'decision'
    const confidence = typeof v.confidence === 'number'
      ? Math.min(1, Math.max(0, v.confidence)) : 0.9
    verdicts.push({
      index,
      worth: v.worth === true,
      summary: typeof v.summary === 'string' ? v.summary.trim() : '',
      kind,
      confidence,
      transferableTo: Array.isArray(v.transferableTo)
        ? v.transferableTo.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        : undefined,
      topic: typeof v.topic === 'string' && v.topic.trim() ? v.topic.trim().toLowerCase() : undefined,
    })
  }
  return verdicts
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * 应用裁决：把 worth 的候选写成 LTM 条目，返回写入数。
 * 无 LLM 输出（超时/不可解析）→ 不写（fail-closed，宁缺毋滥）。
 */
export function applyCaptureVerdicts(
  cwd: string,
  sessionId: string | undefined,
  candidates: CaptureCandidate[],
  verdicts: CaptureVerdict[],
): number {
  let written = 0
  for (const verdict of verdicts) {
    if (!verdict.worth || verdict.summary.length < 8) continue
    const candidate = candidates[verdict.index]
    // 敏感信息过滤：摘要/evidence 写入前 scrub；纯敏感则丢弃该条。
    const text = scrubMemoryText(verdict.summary)
    if (!text) continue
    const evidenceCandidate = candidate
      ? `[${candidate.tool}] ${candidate.summary}` + (candidate.result ? ` — ${candidate.result.slice(0, 120)}` : '')
      : undefined
    const evidence = evidenceCandidate ? scrubMemoryText(evidenceCandidate) ?? undefined : undefined
    try {
      appendMemoryEntry(cwd, {
        text: escapeXml(text).slice(0, 500),
        kind: verdict.kind,
        confidence: verdict.confidence,
        source: 'auto-capture' as MemorySource,
        status: 'observed',
        tags: ['auto-capture', verdict.kind],
        sessionId,
        evidence,
        transferableTo: verdict.transferableTo,
        topic: verdict.topic,
      })
      written++
    } catch { /* LTM write must never break the caller */ }
  }
  return written
}

/** 记忆形成侧缺省开启判断流程（可用 env 关）。 */
export function autoCaptureEnabled(value = process.env.RIVET_MEMORY_AUTO_CAPTURE): boolean {
  const v = value?.trim().toLowerCase()
  if (v === '0' || v === 'off' || v === 'false') return false
  // 默认开（产品需求）；shadow 不写了，正常判断记入。
  return true
}
