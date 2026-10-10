import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'crypto'
import { relative } from 'node:path'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { validatePath } from './path-validate.js'
import { checkSyntax } from './syntax-check.js'
import { detectPointerPlaceholder, pointerPlaceholderError, resolveIdempotentPointer } from './pointer-guard.js'
import { asBool } from './write-tool-helpers.js'
import { getFileReadContentHash, noteFileObserved, recordSuccessfulEdit, incrementEditFailCount, resetEditFailCount } from './read-file.js'
import { landingWriteFile, delegatedToToolResult, isDelegateRejected } from './client-delegate.js'
import { withFileChangeTracking, restoreFileChange, type FileChangeRecord } from '../agent/recovery-stack.js'
import { detectEol, chooseEol, toLf, applyEol } from './line-endings.js'
import { getTargetEol } from '../platform.js'
import { buildFileDiff, computeChangedLineRanges, type LineRange } from './edit-diff.js'

/**
 * Compute a 8-char hex hash of a line's content (stripped of trailing \r).
 * The hash is collision-resistant enough for anchor matching within a single
 * file — two different lines producing the same hash is astronomically unlikely
 * (1 in 2^32).
 */
export function hashLine(line: string): string {
  const clean = line.endsWith('\r') ? line.slice(0, -1) : line
  return createHash('sha256').update(clean).digest('hex').slice(0, 8)
}

/**
 * Build fresh chain-safe anchors for the region just written, so the model
 * can immediately hash_edit the same file again without re-reading it.
 * Emits up to 4 anchors: the context line before the edit, the first and
 * last lines of the new region, and the context line after.
 *
 * @param newFileLines  lines of the file AFTER the edit (LF-split)
 * @param editStart0    0-indexed position of the first new-content line
 * @param newLineCount  number of lines inserted (0 for pure deletion)
 */
export function buildFreshAnchors(newFileLines: string[], editStart0: number, newLineCount: number): string {
  // 每个锚点行附带该行内容（截断 80 字符）——模型无需 read_file 即可确认
  // 写入结果（对标 grok-build hashline 的 LINE:HASH→CONTENT；2026-08 实测：
  // 无内容行的锚点让模型无法确认自己写了什么，是 A 型重写循环的温床）。
  const lineWithContent = (lineNo0: number): string => {
    const content = (newFileLines[lineNo0] ?? '').replace(/\s+$/, '')
    const snippet = content.length > 80 ? `${content.slice(0, 80)}…` : content
    return `L${lineNo0 + 1}:${hashLine(newFileLines[lineNo0]!)} → ${snippet}`
  }
  const parts: string[] = []
  if (editStart0 > 0) {
    parts.push(lineWithContent(editStart0 - 1))
  }
  if (newLineCount > 0) {
    parts.push(lineWithContent(editStart0))
  }
  if (newLineCount > 1) {
    parts.push(lineWithContent(editStart0 + newLineCount - 1))
  }
  if (editStart0 + newLineCount < newFileLines.length) {
    parts.push(lineWithContent(editStart0 + newLineCount))
  }
  return parts.length > 0 ? `\n新鲜锚点（链式安全）：\n${parts.join('\n')}` : ''
}

/**
 * Validate a hash_edit write and roll back on fatal parse errors.
 * Returns the success content with any non-fatal warnings appended.
 */
async function finalizeHashEdit(
  filePath: string,
  cwd: string,
  newContent: string,
  sessionId: string | undefined,
  capture: FileChangeRecord,
  successContent: string,
  extraWarning: string,
): Promise<{ content: string; isError?: boolean; errorKind?: 'syntax_error' }> {
  const check = await checkSyntax(filePath, newContent)
  if (check.fatal) {
    const restored = await restoreFileChange(cwd, capture, sessionId)
    // 回滚后 mtime 会变（copyFileSync 不保留原始时间戳），但内容已恢复。
    // 刷新读文件 mtime 追踪器——否则后续 hash_edit 的仅位置锚点检查会误报
    // "文件已变化，请重新 read_file"。
    if (restored) {
      try {
        const s = await stat(filePath)
        // 回滚恢复的是编辑前内容：读回重建内容哈希基线——否则位置锚点检查
        // （要求完整观察且内容未变）会因 mtime 变化误报为「文件已变化」。
        const content = await readFile(filePath, 'utf8')
        noteFileObserved(filePath, s.mtimeMs, s.size, sessionId, content)
      } catch { /* stat/readFile 失败不影响主流程 */ }
    }
    const fails = incrementEditFailCount(filePath)
    const gatePrefix = fails >= 3 ? `此文件已连续 hash_edit 失败 ${fails} 次，再次编辑前必须先重新 read_file。\n\n` : ''
    const rollbackMsg = restored ? '更改已自动回滚。' : '自动回滚失败。'
    return {
      content: gatePrefix + `错误：${check.fatal}\n\n${rollbackMsg}\n\n请修复编辑后重试。复杂改动建议优先用 apply_patch 加 unified diff。`,
      isError: true,
      errorKind: 'syntax_error',
    }
  }
  await recordSuccessfulEdit(filePath, sessionId)
  resetEditFailCount(filePath)
  const combinedWarn = [check.warning, extraWarning].filter(Boolean).join('\n\n')
  return { content: successContent + (combinedWarn ? '\n\n' + combinedWarn : '') }
}

/**
 * Preview mode for dry_run: compute the diff and changed ranges without
 * writing anything to disk. Still runs a syntax check so the model can see
 * whether applying the edit would introduce parse errors.
 */
async function buildHashDryRunPreview(
  cwd: string,
  filePath: string,
  before: string,
  after: string,
): Promise<{ content: string; uiContent?: string; changedRanges: LineRange[] }> {
  const relPath = relative(cwd, filePath)
  let diff = ''
  let changedRanges: LineRange[] = []
  try {
    diff = await buildFileDiff(relPath, before, after)
    changedRanges = await computeChangedLineRanges(before, after)
  } catch {
    // diff is display-only; failures are not fatal in preview mode
  }

  let warn = ''
  try {
    const check = await checkSyntax(filePath, after)
    if (check.fatal) warn = `若应用将出现语法错误：${check.fatal}`
    else if (check.warning) warn = check.warning
  } catch (e) {
    warn = `(语法检查已跳过： ${(e as Error).message})`
  }

  const content = `预览（dry_run）${filePath} — 未写入任何更改：\n\n${diff || '（无文本变更）'}` + (warn ? `\n\n${warn}` : '')
  return { content, uiContent: diff || undefined, changedRanges }
}

interface Anchor {
  line: number      // 1-based
  hash: string | null  // 8-char hex, or null for position-only mode
}

/** Parse "L<num>:<hex>" or "L<num>" into { line, hash }.
 *  Returns null on parse failure. */
function parseAnchor(raw: string): Anchor | null {
  // Full format: L<num>:<8-char-hex>，容忍行尾内容后缀（fresh anchors 现附
  // " → content" snippet，模型回灌整行时不得解析失败）。
  const fullMatch = /^L(\d+):([0-9a-f]{8})(?:\s|$)/.exec(raw)
  if (fullMatch) {
    const line = parseInt(fullMatch[1]!, 10)
    if (line < 1) return null
    return { line, hash: fullMatch[2]! }
  }
  // Position-only format: L<num>
  const posMatch = /^L(\d+)(?:\s|$)/.exec(raw)
  if (posMatch) {
    const line = parseInt(posMatch[1]!, 10)
    if (line < 1) return null
    return { line, hash: null }
  }
  return null
}

const RECOVERY_NEAR_WINDOW = 200

/**
 * Recover stale full-hash anchors by searching the current file.
 *
 * Strategy:
 * 1. Search ±RECOVERY_NEAR_WINDOW lines around each anchor's expected line.
 * 2. If an anchor is not found, check whether already-recovered anchors share
 *    a consistent line shift; if so, search near the shifted position.
 *
 * Returns recovered anchors (same length, ascending line order) or null.
 */
function recoverStaleAnchors(anchors: Anchor[], lines: string[]): Anchor[] | null {
  const recovered: Anchor[] = anchors.map(a => ({ line: a.line, hash: a.hash }))
  const usedLines = new Set<number>()

  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i]!
    if (anchor.hash === null) continue // position-only anchors are not recovered by content
    const candidates = lines.flatMap((line, n) => hashLine(line) === anchor.hash ? [n + 1] : [])
    if (candidates.length !== 1) return null

    const found =
      findAnchorLine(anchor.hash, anchor.line, lines, usedLines, RECOVERY_NEAR_WINDOW)
      ?? findShiftedAnchorLine(anchor.hash, anchor.line, i, anchors, recovered, lines, usedLines)

    if (!found) return null
    recovered[i] = { line: found, hash: anchor.hash }
    usedLines.add(found)
  }

  // Ascending order must be preserved for first/last to define a valid range.
  for (let i = 1; i < recovered.length; i++) {
    if (recovered[i]!.line <= recovered[i - 1]!.line) return null
  }
  return recovered
}

function findAnchorLine(
  hash: string,
  expectedLine: number,
  lines: string[],
  usedLines: Set<number>,
  window: number,
): number | null {
  const searchStart = Math.max(1, expectedLine - window)
  const searchEnd = window === Infinity ? lines.length : Math.min(lines.length, expectedLine + window)
  let found: number | null = null
  for (let i = searchStart; i <= searchEnd; i++) {
    if (usedLines.has(i)) continue
    if (hashLine(lines[i - 1]!) === hash) { if (found !== null) return null; found = i }
  }
  return found
}

function findShiftedAnchorLine(
  hash: string,
  expectedLine: number,
  originalIndex: number,
  originalAnchors: Anchor[],
  recovered: Anchor[],
  lines: string[],
  usedLines: Set<number>,
): number | null {
  if (originalIndex === 0) return null
  const shifts: number[] = []
  for (let i = 0; i < originalIndex; i++) {
    if (originalAnchors[i]!.hash !== null) {
      shifts.push(recovered[i]!.line - originalAnchors[i]!.line)
    }
  }
  if (shifts.length === 0) return null
  const firstShift = shifts[0]!
  if (firstShift === 0 || !shifts.every(s => s === firstShift)) return null
  return findAnchorLine(hash, expectedLine + firstShift, lines, usedLines, 50)
}

function formatStaleDiagnostic(
  filePath: string,
  anchors: Anchor[],
  lines: string[],
  mismatches: Array<{ anchor: Anchor; actualHash: string; actualLine: string }>,
): string {
  const lines_of_evidence = mismatches.map(m => {
    const ctx = lines[m.anchor.line - 1] ?? '<未找到该行>'
    return `  L${m.anchor.line}: expected ${m.anchor.hash} | actual ${m.actualHash} | content: ${ctx.slice(0, 60)}`
  }).join('\n')

  const all_anchors = anchors.map(a => `  L${a.line}:${a.hash}`).join('\n')


  return [
    `hash_edit 在 ${filePath} 上失败：${mismatches.length} 个锚点已过期。`,
    '自你上次 read_file 以来文件已变化（可能是你自己更早的编辑导致）。',
    '',
    '期望的锚点：',
    all_anchors,
    '',
    '过期锚点（该行当前哈希）：',
    lines_of_evidence,
    '',
    '请先重新 read_file 确认目标语义，或用 grep 重新定位目标并取得新鲜的 L<line>:<hash> 锚点。',
    '禁止只把旧行号的哈希换成当前值后重试；同一位置可能已是别的内容。',
    '不要再用已经用过的锚点重试——它们是一次性坐标，完全相同的调用还会再次失败。',
  ].join('\n')
}

export const HASH_EDIT_TOOL: Tool = {
  definition: {
    name: 'hash_edit',
    description: `内容哈希锚定的文件编辑。比 edit_file 更安全的替代。

锚点格式为 L<line>:<8-char-hex>（完整哈希校验）或 L<line>
（仅位置快速路径——仅在你刚读过该文件时使用）。提供 1-3 个
锚点：首尾锚点定义含两端在内的替换区间；中间锚点校验区间内部。
单锚点模式替换该行（要插入就把该行内容原样放进 new_string 首/尾）。

哈希：SHA256(line_content_without_trailing_cr)[0:8]。
grep 结果对单文件匹配附带锚点提示。

### 锚点是一次性坐标
任何对该文件的写入都会让此前取得的锚点作废——包括你自己上一次的
hash_edit / edit_file / write_file。编辑点之后的所有行号还会整体漂移
（漂移量 = 新行数 − 旧行数）。拿旧锚点重试同一调用只会再次失败。

同一文件连续编辑：
- 改**刚编辑过的那一块**：用成功回传的「新鲜锚点」（只覆盖编辑点前后
  各一行与新块首尾）。
- 改**该文件的其他位置**：先用 grep 重新取锚点。read_file 的输出不带
  哈希，只有 grep 会给出 L<line>:<hash> 提示。
- 一次要改多处时，**从文件末尾往前改**——这样先改的位置不会让后面
  待改位置的行号漂移。

仅位置模式（L<line> 无哈希）适合首次编辑，且绝不能连续链式使用；
链式编辑一律用带哈希的完整锚点（L<line>:<hash>）。

### 示例
替换 L5-L7：anchors=["L5:a1b2c3d4","L7:e5f6a7b8"], new_string="新5\\n新6\\n新7"
删除 L10-L12：anchors=["L10:deadbeef","L12:cafebabe"], new_string=""
在 L42 后插入：anchors=["L42:feedface"], new_string="<L42 原内容>\\n新增行"

多处改动、超过约 20 行的编辑或结构性重构，优先用
apply_patch 加 unified diff。

注意：new_string 较大时，消息历史只保留短指针
（file_path + 大小）——看到指针说明那次编辑已成功落盘，
不是你写了占位符，不要重做。后续轮次用 read_file 回看当前内容。
new_string 必须是真实文件内容；把历史里的
[hash_edit applied to …] 指针原样传回会被拦截。`,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '要编辑文件的绝对路径。先提供此参数。' },
        anchors: {
          type: 'array',
          items: { type: 'string' },
          description: '1-3 个锚点，格式 "L<line>:<8-char-hex>"（完整）或 "L<line>"（仅位置）。首尾锚点定义含两端在内的替换区间。',
        },
        new_string: { type: 'string', description: '锚定区间的替换文本。传 "" 表示删除。最后提供此参数。' },
        dry_run: { type: 'boolean', description: '为 true 时，计算并返回将要应用的 diff，但不写盘。' },
      },
      required: ['file_path', 'anchors', 'new_string'],
    },
  },

  execute: withFileChangeTracking(async (params: ToolCallParams, trackFileChange): Promise<ToolResult> => {
    let filePath: string
    try {
      filePath = validatePath(params.cwd, params.input.file_path as string, 'write')
    } catch (e) {
      return { content: `错误：${e instanceof Error ? e.message : '路径逃逸出项目目录'}`, isError: true }
    }

    // Pointer-regurgitation guard: reject placeholder text echoed from message
    // history as new_string — otherwise the pointer line is spliced verbatim
    // into the file (observed in the 2026-07-06 word-batch report).
    const newStringInput = params.input.new_string
    if (typeof newStringInput === 'string') {
      const matchedPointer = detectPointerPlaceholder(newStringInput)
      if (matchedPointer) {
        const resolved = await resolveIdempotentPointer({ mode: 'edit', filePath, value: newStringInput, matchedPrefix: matchedPointer })
        if (resolved) return resolved
        return {
          content: pointerPlaceholderError({ toolName: 'hash_edit', field: 'new_string', matchedPrefix: matchedPointer, filePath }),
          isError: true,
        }
      }
    }

    // Check file exists asynchronously
    try {
      await stat(filePath)
    } catch {
      return { content: `错误：文件未找到：${filePath}`, isError: true }
    }

    const rawAnchors = params.input.anchors as string[] | undefined
    if (!rawAnchors || rawAnchors.length === 0 || rawAnchors.length > 3) {
      return { content: '错误：anchors 必须是 1-3 个 "L<line>:<hash>" 或 "L<line>" 字符串组成的数组', isError: true }
    }

    const anchors: Anchor[] = []
    for (const raw of rawAnchors) {
      const parsed = parseAnchor(raw)
      if (!parsed) {
        return { content: `错误：无效锚点格式 "${raw}"。期望 "L<num>:<8-char-hex>"（如 "L5:a1b2c3d4"）或 "L<num>"（如 "L5"）`, isError: true }
      }
      anchors.push(parsed)
    }

    // Ascending order check: anchors must be in strictly increasing line order
    // for first/last to define a valid replacement range. Reversed anchors
    // cause line duplication and silent file corruption.
    for (let i = 1; i < anchors.length; i++) {
      if (anchors[i]!.line <= anchors[i - 1]!.line) {
        return {
          content: `错误：anchors 必须严格按行号升序排列。` +
            `锚点 ${i + 1}（L${anchors[i]!.line}）没有排在锚点 ${i}（L${anchors[i - 1]!.line}）之后。`,
          isError: true,
        }
      }
    }

    const newString = params.input.new_string as string

    // Normalize to LF for line splitting/rebuild; restore the file's EOL on
    // write-back. Without this, splicing LF new_string lines into a CRLF file's
    // (still \r-terminated) lines produces a mixed-EOL file. hashLine already
    // strips trailing \r, so anchor matching is unaffected either way.
    const rawContent = await readFile(filePath, 'utf-8')
    const eol = chooseEol(filePath, detectEol(rawContent), getTargetEol())
    const content = toLf(rawContent)
    const lines = content.split('\n')

    // Position anchors require a complete content observation, including mixed anchors.
    // A write invalidates that observation; fresh full-hash anchors remain usable.
    if (anchors.some(a => a.hash === null) && anchors.every(a => a.line <= lines.length)) {
      const observed = getFileReadContentHash(filePath, params.sessionId)
      const current = createHash('sha256').update(rawContent).digest('hex')
      if (!observed || observed !== current) return {
        content: '错误：仅位置锚点缺少有效读取基线或文件内容已变化。请重新 read_file 或使用内容哈希锚点；未写入文件。',
        isError: true,
      }
    }

    // Verify all anchors — compute line hashes and match
    const mismatches: Array<{ anchor: Anchor; actualHash: string; actualLine: string }> = []
    for (const anchor of anchors) {
      if (anchor.line > lines.length) {
        mismatches.push({ anchor, actualHash: '<eof>', actualLine: '<行号超出文件长度>' })
        continue
      }
      if (anchor.hash !== null) {
        // Full hash verification
        const actualHash = hashLine(lines[anchor.line - 1]!)
        if (actualHash !== anchor.hash) {
          mismatches.push({ anchor, actualHash, actualLine: lines[anchor.line - 1]! })
        }
      }
      // Position-only anchors (hash === null) only verify line exists — already checked above
    }

    if (mismatches.length > 0) {
      // ── Stale recovery: attempt to find anchor content in current file ──
      // When full-hash anchors go stale (e.g. after a prior edit shifted line
      // numbers), search ±RECOVERY_NEAR_WINDOW lines around the expected
      // position, detect a consistent line shift, or fall back to a global
      // search. If ALL anchors are recovered and remain in ascending order,
      // apply the edit with updated anchors.
      const allFullHash = mismatches.every(m => m.anchor.hash !== null)
      if (allFullHash) {
        const recoveredAnchors = recoverStaleAnchors(anchors, lines)
        if (recoveredAnchors) {
          const firstLine = recoveredAnchors[0]!.line
          const lastLine = recoveredAnchors[recoveredAnchors.length - 1]!.line

          const before = lines.slice(0, firstLine - 1)
          const after = lines.slice(lastLine)
          const newLines = newString === '' ? [] : newString.split('\n')
          const newContent = [...before, ...newLines, ...after].join('\n')

          const recoveredCount = anchors.reduce((n, a, i) => a.hash !== null && a.line !== recoveredAnchors[i]!.line ? n + 1 : n, 0)
          const dryRun = asBool(params.input.dry_run)
          if (dryRun) {
            return buildHashDryRunPreview(params.cwd, filePath, content, newContent)
          }
          const relPath = relative(params.cwd, filePath)
          const capture = await trackFileChange(params.cwd, { filePath: relPath, action: 'edit', toolCallId: params.toolUseId ?? 'hash_edit' })

          {
            const land = await landingWriteFile(params, filePath, content, applyEol(newContent, eol))
            if (land.kind === 'delegated' && (isDelegateRejected(land.delegated) || land.delegated.isError)) {
              return delegatedToToolResult(land.delegated)
            }
          }
          const recoveredInfo = recoveredCount > 0
            ? `（已自动恢复 ${recoveredCount} 个过期锚点）`
            : ''
          const freshAnchors = buildFreshAnchors(newContent.split('\n'), before.length, newLines.length)
          return await finalizeHashEdit(
            filePath, params.cwd, newContent, params.sessionId, capture,
            `hash_edit${recoveredInfo} 已应用到 ${filePath}：将 L${firstLine}-L${lastLine}（${lastLine - firstLine + 1} 行）替换为 ${newLines.length} 行${freshAnchors}`,
            '',
          )
        }
      }

      // Recovery not possible — return the original stale diagnostic
      const fails = incrementEditFailCount(filePath)
      const gatePrefix = fails >= 3 ? `此文件已连续 hash_edit 失败 ${fails} 次，再次编辑前必须先重新 read_file。\n\n` : ''
      return {
        content: gatePrefix + formatStaleDiagnostic(filePath, anchors, lines, mismatches),
        isError: true,
      }
    }

    // All anchors verified — apply the edit
    const firstLine = anchors[0]!.line
    const lastLine = anchors[anchors.length - 1]!.line

    // Build the new file content
    const before = lines.slice(0, firstLine - 1)
    const after = lines.slice(lastLine) // lastLine is 1-based inclusive, slice is exclusive
    const newLines = newString === '' ? [] : newString.split('\n')
    const newContent = [...before, ...newLines, ...after].join('\n')

    const dryRun = asBool(params.input.dry_run)
    if (dryRun) {
      return buildHashDryRunPreview(params.cwd, filePath, content, newContent)
    }

    // Record file change for recovery tracking (backup created by trackFileChange)
    const relPath = relative(params.cwd, filePath)
    const capture = await trackFileChange(params.cwd, { filePath: relPath, action: 'edit', toolCallId: params.toolUseId ?? 'hash_edit' })

    {
      const land = await landingWriteFile(params, filePath, content, applyEol(newContent, eol))
      if (land.kind === 'delegated' && (isDelegateRejected(land.delegated) || land.delegated.isError)) {
        return delegatedToToolResult(land.delegated)
      }
    }
    const freshAnchors = buildFreshAnchors(newContent.split('\n'), before.length, newLines.length)
    return await finalizeHashEdit(
      filePath, params.cwd, newContent, params.sessionId, capture,
      `hash_edit 已应用到 ${filePath}：将 L${firstLine}-L${lastLine}（${lastLine - firstLine + 1} 行）替换为 ${newLines.length} 行${freshAnchors}`,
      '',
    )
  }),

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
