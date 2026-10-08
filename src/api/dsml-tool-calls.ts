/**
 * DSML 文本形态工具调用的恢复（网#2）。
 *
 * 背景（2026-10-06 线上会话 2026100677724c4ca112：182 条记录中 23 条命中）：
 * DeepSeek 系网关/中转会把工具调用以标记文本塞进 content，而不是结构化
 * tool_calls 字段。openai-client 的 JSON 兜底（网#1）只认 `{`/`[` 开头，
 * 于是这些调用蒸发成纯文本 → 本轮零 tool_call → 会话静默结束，用户看到
 * 「无缘无故停了」。既有 isReportChannelError 只看 worker 报告通道。
 *
 * 线上抓样（竖线为 U+FF5C 全角；部分网关用半角 |，两种都容忍）：
 *
 *   <｜DSML｜tool_calls>
 *     <｜DSML｜invoke name="edit_file">
 *       <｜DSML｜parameter name="file_path" string="true">lab.py</｜DSML｜parameter>
 *     </｜DSML｜invoke>
 *   </｜DSML｜tool_calls>
 *
 * 命中条件刻意收紧为「tool_calls 开标记 + 至少一个完整 invoke」，避免把模型
 * 在正文里复述标记（讨论该格式、贴日志）误判成真实调用。
 */

export interface DsmlToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

/**
 * 从累积正文里解析 DSML 工具调用。
 *
 * @param emit 每命中一个 invoke 调用一次。
 * @returns 剥掉标记区后的正文（周边散文照常展示，不因一处标记丢失整段）；
 *          未命中时返回 null，调用方据此保持原文不变。
 */
export function recoverDsmlToolCallsFromContent(
  text: string,
  emit: (block: DsmlToolUseBlock) => void,
): string | null {
  // Scan protocol envelopes only outside Markdown literals. Keep offsets in
  // the original text so removing an actionable envelope never removes prose.
  const literals = markdownLiteralRanges(text)
  const isLiteral = (index: number) => literals.some(([start, end]) => index >= start && index < end)
  const envelopeRe = /<[｜|]DSML[｜|]tool_calls\s*>/g
  const closerRe = /<\/[｜|]DSML[｜|]tool_calls\s*>/g
  const invokeRe = /<[｜|]DSML[｜|]invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/[｜|]DSML[｜|]invoke>/g
  const paramRe = /<[｜|]DSML[｜|]parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/[｜|]DSML[｜|]parameter>/g
  const removed: Array<[number, number]> = []
  let toolUses = 0
  let open: RegExpExecArray | null
  while ((open = envelopeRe.exec(text)) !== null) {
    if (isLiteral(open.index)) continue
    const start = open.index + open[0].length
    closerRe.lastIndex = start
    const closer = closerRe.exec(text)
    const end = closer ? closer.index + closer[0].length : text.length
    const body = text.slice(start, closer?.index ?? end)
    let envelopeCalls = 0
    invokeRe.lastIndex = 0
    let invoke: RegExpExecArray | null
    while ((invoke = invokeRe.exec(body)) !== null) {
      if (isLiteral(start + invoke.index)) continue
      const name = invoke[1]!
      const input: Record<string, unknown> = {}
      paramRe.lastIndex = 0
      let param: RegExpExecArray | null
      while ((param = paramRe.exec(invoke[2]!)) !== null) {
        const rawValue = param[3]!
        if (param[2] === 'false') {
          try { input[param[1]!] = JSON.parse(rawValue) } catch { input[param[1]!] = rawValue }
        } else {
          input[param[1]!] = rawValue
        }
      }
      emit({ type: 'tool_use', id: `fallback_${name}_${toolUses++}`, name, input })
      envelopeCalls++
    }
    if (envelopeCalls > 0) removed.push([open.index, end])
    envelopeRe.lastIndex = end
  }
  if (toolUses === 0) return null
  let remaining = ''
  let offset = 0
  for (const [start, end] of removed) {
    remaining += text.slice(offset, start)
    offset = end
  }
  return (remaining + text.slice(offset)).trim()
}

function markdownLiteralRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let fence: { marker: string; length: number; start: number } | undefined
  const lines = /[^\n]*(?:\n|$)/g
  let line: RegExpExecArray | null
  while ((line = lines.exec(text)) !== null && line[0]) {
    const value = line[0]
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(value)
    if (fence) {
      if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
        ranges.push([fence.start, line.index + value.length])
        fence = undefined
      }
    } else if (marker) {
      fence = { marker: marker[1]![0]!, length: marker[1]!.length, start: line.index }
    } else if (/^ {0,3}>|^(?: {4}|\t)/.test(value)) {
      ranges.push([line.index, line.index + value.length])
    }
  }
  if (fence) ranges.push([fence.start, text.length])
  const inline = /(`+)([^`]|`(?!`))*?\1/g
  let match: RegExpExecArray | null
  while ((match = inline.exec(text)) !== null) ranges.push([match.index, match.index + match[0].length])
  return ranges
}
