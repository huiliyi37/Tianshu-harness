import { readFile, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { validatePath } from './path-validate.js'
import { buildFileDiff, computeChangedLineRanges, type LineRange } from './edit-diff.js'
import { hashLine } from './hash-edit.js'
import { getFileReadMtime, noteFileObserved, recordSuccessfulEdit, wasFileEditedBySession, incrementEditFailCount, resetEditFailCount } from './read-file.js'
import { syntaxCheck, checkSyntax } from './syntax-check.js'
import { findFuzzyMatch, applyFuzzyReplacement } from './fuzzy-match.js'
import { landingWriteFile, delegatedToToolResult, isDelegateRejected } from './client-delegate.js'

/** E4-aware write: client apply_edit or local atomic write. */
async function writeEditLanding(
  params: ToolCallParams,
  filePath: string,
  oldContent: string,
  newContent: string,
  eol: Eol,
): Promise<{ delegatedRejectOrError: ReturnType<typeof delegatedToToolResult> } | { ok: true }> {
  const land = await landingWriteFile(params, filePath, oldContent, applyEol(newContent, eol))
  if (land.kind === 'delegated') {
    if (isDelegateRejected(land.delegated) || land.delegated.isError) {
      return { delegatedRejectOrError: delegatedToToolResult(land.delegated) }
    }
  }
  return { ok: true }
}
import { detectEol, chooseEol, toLf, applyEol, type Eol } from './line-endings.js'
import { getTargetEol } from '../platform.js'
import { detectPointerPlaceholder, pointerPlaceholderError, resolveIdempotentPointer } from './pointer-guard.js'
import { asBool } from './write-tool-helpers.js'
import { withFileChangeTracking, restoreFileChange, type FileChangeRecord } from '../agent/recovery-stack.js'
import { formatActivePlanDraftReceipt } from '../agent/plan-mode.js'

// Large files are common (generated code, lockfiles, big modules). 100KB was
// far too small. 8MB reads comfortably into the Node heap; anything larger is
// almost certainly machine-generated and better edited with apply_patch/sed.
const MAX_EDIT_FILE_BYTES = 8 * 1024 * 1024 // 8MB

/** Regex patterns that indicate the model is treating old_string as a regex
 *  instead of a literal string. edit_file uses exact string matching.
 *
 *  Only flag unambiguous regex tokens — things that are NEVER valid literal
 *  text in source code. Avoid flagging  .*  .+  |  ^  $  which appear
 *  legitimately in shell commands, import paths, and everyday code. */
const REGEX_MISUSE_PATTERNS = [
  /\\[dDwWsSbB]/,        // \d \D \w \W \s \S \b \B — class shorthands
  /\\[1-9]/,             // \1 \2 ... backreferences
  /\\[AGZz]/,            // \A \G \Z \z boundary anchors
  /\(\?[:=!<]/,          // (?:...) (?=...) (?!...) (?<=...) (?<!...)
  /\{\d+(?:,\d*)?\}/,    // {n} {n,m} quantifiers — literal {3} in code is rare
]

/** Returns a human-readable name for the first regex pattern found, or null. */
function detectRegexPattern(oldString: string): string | null {
  const names: [RegExp, string][] = [
    [/\\[dDwWsSbB]/, '\\d / \\w / \\s / \\b class shorthand'],
    [/\\[1-9]/, '\\1 backreference'],
    [/\\[AGZz]/, '\\A / \\Z boundary anchor'],
    [/\(\?[:=!<]/, '(?: / (?= / (?! / (?<= group'],
    [/\{\d+(?:,\d*)?\}/, '{n} / {n,m} quantifier'],
  ]
  for (const [re, name] of names) {
    if (re.test(oldString)) return name
  }
  return null
}

/**
 * Regex-misuse diagnosis, appended to "old_string not found" errors.
 *
 * Deliberately NOT a pre-flight gate. It used to run before the file was even
 * read and rejected any old_string containing regex-looking tokens, which in a
 * codebase full of regex literals means "you may not edit those lines": on
 * 2026-07-27 it blocked three legitimate edits whose old_string was copied
 * verbatim and correctly from the file (TOOL_VERB_PATTERN in
 * action-intent-detector.ts, a `split(/\r?\n/)` line in pointer-guard.ts).
 *
 * Presence of `\d` or `(?:` says nothing about intent — only a failed match
 * does. So the hint now fires exactly where it is informative: the string did
 * not match AND it looks like a pattern.
 */
function regexMisuseHint(oldString: string): string {
  const pattern = detectRegexPattern(oldString)
  if (!pattern) return ''
  return `\n\n注意：old_string 含有正则记法（${pattern}）。edit_file 是精确字符串匹配，不是正则——`
    + `该记法被当作字面文本处理。若你本意是按模式匹配：先用 grep 按正则找到实际内容，`
    + `再把命中的字面文本复制为 old_string；复杂改动改用带锚点的 hash_edit。`
}


export const EDIT_FILE_TOOL: Tool = {
  definition: {
    name: 'edit_file',
    description: `在已有文件中执行精确字符串替换。

- old_string 必须唯一——必要时带上周边上下文
- 严格保留文件原有的缩进（tabs/spaces）
- replace_all 替换所有出现处；expected_count 数量不符时给出警告
- 大编辑后消息历史只保留短指针——看到指针说明编辑已成功，不要重做；用 read_file 回看

唯一字符串替换优先用 edit_file；空白字符有歧义的编辑用 hash_edit；单文件多处改动、超过约 20 行的编辑或结构性重构，用 apply_patch 加 unified diff。`,

    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '要编辑文件的绝对路径。先提供此参数。' },
        old_string: { type: 'string', description: '要替换的原始文本（必须在文件中唯一）' },
        new_string: { type: 'string', description: '替换后的文本' },
        replace_all: { type: 'boolean', description: '替换 old_string 的所有出现处（默认：false）' },
        expected_count: {
          type: 'number',
          description: 'replace_all 为 true 时预期的替换次数。实际次数不符时返回警告，便于你用 grep 核实是否有遗漏（例如缩进差异导致的漏配）。'
        },
        dry_run: {
          type: 'boolean',
          description: '为 true 时，计算并返回将要应用的 diff，但不写盘。',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },

  execute: withFileChangeTracking(async (params: ToolCallParams, trackFileChange): Promise<ToolResult> => {
    let filePath: string
    try {
      filePath = validatePath(params.cwd, params.input.file_path as string, 'write')
    } catch (e) {
      return { content: `错误：${e instanceof Error ? e.message : '路径逃逸出项目目录'}`, isError: true }
    }

    // Pointer-regurgitation guard: reject placeholder text ("[file written to …]",
    // "[edit on …]", …) echoed from message history as old_string/new_string.
    // Without this the placeholder is written verbatim into the file (the
    // 2026-07-06 word-batch report caught a literal pointer line on disk).
    for (const field of ['old_string', 'new_string'] as const) {
      const value = params.input[field]
      if (typeof value !== 'string') continue
      const matchedPointer = detectPointerPlaceholder(value)
      if (matchedPointer) {
        const resolved = await resolveIdempotentPointer({ mode: 'edit', filePath, value, matchedPrefix: matchedPointer })
        if (resolved) return resolved
        return {
          content: pointerPlaceholderError({ toolName: 'edit_file', field, matchedPrefix: matchedPointer, filePath }),
          isError: true,
        }
      }
    }

    let fileStat: Awaited<ReturnType<typeof stat>>
    try {
      fileStat = await stat(filePath)
    } catch {
      return { content: `错误：文件未找到：${filePath}`, isError: true }
    }

    // Stale file detection: if the file was modified externally since the
    // model's last read_file, reject the edit to prevent silent corruption.
    // hash_edit is the safe alternative — its anchor verification catches this.
    const currentMtime = fileStat.mtimeMs
    const lastReadMtime = getFileReadMtime(filePath, params.sessionId)
    if (lastReadMtime !== null && currentMtime !== lastReadMtime) {
      // Note the observed state to prevent a read-edit-stale loop (表2 only —
      // the read-dedup tables are untouched so read-ref stays honest):
      noteFileObserved(filePath, currentMtime, fileStat.size, params.sessionId)

      // Smart stale recovery: instead of a generic "re-read" error, auto-read
      // the current content and either re-apply or show what changed.
      const oldString = toLf(params.input.old_string as string)
      try {
        // OOM guard: check file size before reading (same as normal path above)
        if (fileStat.size > MAX_EDIT_FILE_BYTES) {
          return { content: `文件已被外部修改，且当前过大（${Math.round(fileStat.size / 1024 / 1024)}MB > ${MAX_EDIT_FILE_BYTES / 1024 / 1024}MB 上限），无法自动恢复。请改用带当前锚点的 hash_edit。`, isError: true }
        }
        // Normalize to LF for matching; restore the file's EOL on write-back so a
        // CRLF file stays CRLF instead of degrading into mixed line endings.
        const freshRaw = await readFile(filePath, 'utf-8')
        const freshEol = chooseEol(filePath, detectEol(freshRaw), getTargetEol())
        const freshContent = toLf(freshRaw)
        const freshLines = freshContent.split('\n')

        if (freshContent.includes(oldString)) {
          // old_string still matches — just re-apply the edit
          const newString = toLf(params.input.new_string as string)
          const replaceAll = asBool(params.input.replace_all)
          if (replaceAll) {
            const newContent = freshContent.replaceAll(oldString, newString)
            const dryRun = asBool(params.input.dry_run)
            if (dryRun) {
              return buildDryRunPreview(params.cwd, filePath, freshContent, newContent)
            }
            const capture = await trackFileChange(params.cwd, { filePath: relative(params.cwd, filePath), action: 'edit', toolCallId: params.toolUseId ?? 'edit_file' })
            {
              const land = await writeEditLanding(params, filePath, freshContent, newContent, freshEol)
              if ('delegatedRejectOrError' in land) return land.delegatedRejectOrError
            }
            const occurrences = (freshContent.match(new RegExp(escapeRegExp(oldString), 'g')) || []).length
            const expectedCount = params.input.expected_count as number | undefined
            return await finalizeEdit(params.cwd, filePath, freshContent, newContent, params.sessionId, capture, (warn, ui, changedRanges) => {
              if (expectedCount !== undefined && occurrences !== expectedCount) {
                const base = `文件已被外部修改，但 old_string 仍能匹配。警告：预期替换 ${expectedCount} 处，实际只替换了 ${occurrences} 处（${filePath}）。请用 grep 核实是否有遗漏——缩进或空白差异可能导致 replace_all 只部分匹配。`
                return { content: base + (warn ? '\n\n' + warn : ''), uiContent: ui, changedRanges }
              }
              return { content: `文件已被外部修改，但 old_string 仍能匹配。已重新应用 ${occurrences} 处替换（${filePath}）${warn ? '\n\n' + warn : ''}`, uiContent: ui, changedRanges }
            })
          }
          const firstIdx = freshContent.indexOf(oldString)
          const secondIdx = freshContent.indexOf(oldString, firstIdx + oldString.length)
          if (secondIdx !== -1) {
            return { content: buildMultipleMatchError(filePath, oldString, freshContent), isError: true }
          }
          const recovered = freshContent.replace(oldString, newString)
          const dryRun = asBool(params.input.dry_run)
          if (dryRun) {
            return buildDryRunPreview(params.cwd, filePath, freshContent, recovered)
          }
          const capture = await trackFileChange(params.cwd, { filePath: relative(params.cwd, filePath), action: 'edit', toolCallId: params.toolUseId ?? 'edit_file' })
          {
            const land = await writeEditLanding(params, filePath, freshContent, recovered, freshEol)
            if ('delegatedRejectOrError' in land) return land.delegatedRejectOrError
          }
          return await finalizeEdit(params.cwd, filePath, freshContent, recovered, params.sessionId, capture, (warn, ui, changedRanges) => ({
            content: `已编辑 ${filePath}（文件已被外部修改，但内容仍能匹配）${warn ? '\n\n' + warn : ''}`,
            uiContent: ui,
            changedRanges,
          }))
        }

        // old_string not found — show what the file actually looks like near the best guess
        const oldFirstLine = oldString.split('\n')[0] ?? ''
        const trimmedTarget = oldFirstLine.trim()
        let bestIdx = -1
        let bestScore = 0
        for (let i = 0; i < freshLines.length; i++) {
          const trimmed = freshLines[i]!.trim()
          if (trimmed.length === 0) continue
          const score = sharedPrefixLength(trimmed, trimmedTarget)
          if (score > bestScore) { bestScore = score; bestIdx = i }
        }

        const CONTEXT = 5
        if (bestIdx >= 0 && bestScore >= Math.max(8, Math.floor(trimmedTarget.length * 0.3))) {
          const start = Math.max(0, bestIdx - CONTEXT)
          const end = Math.min(freshLines.length, bestIdx + oldString.split('\n').length + CONTEXT)
          const actualWindow = freshLines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n')
          const modNote = wasFileEditedBySession(filePath, params.sessionId) ? '——你在当前会话中曾编辑过此文件' : '（外部）'
          const fails = incrementEditFailCount(filePath)
          const gatePrefix = fails >= 3 ? `此文件已连续编辑失败 ${fails} 次，再次编辑前必须先重新 read_file。\n\n` : ''
          return {
            content: gatePrefix + `自你上次 read_file 以来，文件 ${filePath} 已被修改${modNote}。old_string 已不再匹配。\n\n预期位置附近的当前内容（第 ${bestIdx + 1} 行）：\n\`\`\`\n${actualWindow}\n\`\`\`\n\n请更新 old_string 以匹配当前内容后重试，或改用带锚点的 hash_edit。` + regexMisuseHint(oldString),
            isError: true,
          }
        }

        // No close match — show file head
        const head = freshLines.slice(0, 30).map((l, i) => `${i + 1}: ${l}`).join('\n')
        const modNote = wasFileEditedBySession(filePath, params.sessionId) ? '——你在当前会话中曾编辑过此文件' : '（外部）'
        const fails = incrementEditFailCount(filePath)
        const gatePrefix = fails >= 3 ? `此文件已连续编辑失败 ${fails} 次，再次编辑前必须先重新 read_file。\n\n` : ''
        return {
          content: gatePrefix + `自你上次 read_file 以来，文件 ${filePath} 已被修改${modNote}。未找到 old_string。\n\n文件开头：\n\`\`\`\n${head}${freshLines.length > 30 ? `\n...（共 ${freshLines.length} 行）` : ''}\n\`\`\`\n\n请重新读取文件查看完整内容，或改用带锚点的 hash_edit。` + regexMisuseHint(oldString),
          isError: true,
        }
      } catch {
        return {
          content: `错误：自你上次 read_file 以来，文件 ${filePath} 已被修改。请重新读取文件以更新视图。`,
          isError: true,
        }
      }
    }

    // OOM guard: reject only truly huge files that would blow the heap.
    if (fileStat.size > MAX_EDIT_FILE_BYTES) {
      const sizeMB = (fileStat.size / 1024 / 1024).toFixed(1)
      return {
        content: `错误：文件过大，超出 edit_file 能力（${sizeMB}MB > ${MAX_EDIT_FILE_BYTES / 1024 / 1024}MB）。定向编辑请用 apply_patch 加 unified diff；超大文件的简单字符串替换可用 bash + sed。`,
        isError: true,
      }
    }

    // Normalize to LF for matching; restore the file's EOL on write-back so a
    // CRLF file stays CRLF instead of degrading into mixed line endings (the
    // model's old_string/new_string are also normalized to LF to match).
    const rawContent = await readFile(filePath, 'utf-8')
    const eol = chooseEol(filePath, detectEol(rawContent), getTargetEol())
    const content = toLf(rawContent)
    const oldString = toLf(params.input.old_string as string)
    const newString = toLf(params.input.new_string as string)
    const replaceAll = asBool(params.input.replace_all)

    if (replaceAll) {
      if (!content.includes(oldString)) {
        const fails = incrementEditFailCount(filePath)
        const gatePrefix = fails >= 3 ? `此文件已连续编辑失败 ${fails} 次，再次编辑前必须先重新 read_file。\n\n` : ''
        return {
          content: gatePrefix + buildNotFoundError(filePath, oldString, content),
          isError: true,
        }
      }
      const newContent = content.replaceAll(oldString, newString)
      const dryRun = asBool(params.input.dry_run)
      if (dryRun) {
        return buildDryRunPreview(params.cwd, filePath, content, newContent)
      }
      const capture = await trackFileChange(params.cwd, { filePath: relative(params.cwd, filePath), action: 'edit', toolCallId: params.toolUseId ?? 'edit_file' })
      {
        const land = await writeEditLanding(params, filePath, content, newContent, eol)
        if ('delegatedRejectOrError' in land) return land.delegatedRejectOrError
      }
      const occurrences = (content.match(new RegExp(escapeRegExp(oldString), 'g')) || []).length
      const expectedCount = params.input.expected_count as number | undefined
      return await finalizeEdit(params.cwd, filePath, content, newContent, params.sessionId, capture, (warn, ui, changedRanges) => {
        if (expectedCount !== undefined && occurrences !== expectedCount) {
          const base = `警告：预期替换 ${expectedCount} 处，实际只替换了 ${occurrences} 处（${filePath}）。文件已修改。请用 grep 核实是否有遗漏——缩进或空白差异可能导致 replace_all 只部分匹配。`
          return { content: base + (warn ? '\n\n' + warn : ''), uiContent: ui, changedRanges }
        }
        const draftReceipt = formatActivePlanDraftReceipt(params.cwd, filePath, params.activePlanFilePath, newContent.length)
        const base = draftReceipt ?? `已替换全部 ${occurrences} 处（${filePath}）`
        return { content: base + (warn ? '\n\n' + warn : ''), uiContent: ui, changedRanges }
      })
    }

    const firstIndex = content.indexOf(oldString)
    if (firstIndex === -1) {
      // Whitespace-tolerant fallback: if the block exists modulo indentation /
      // tab-vs-space / trailing-space drift AND is unique, splice the edit onto
      // the file's real text instead of bouncing back a "not found" error.
      const fuzzy = findFuzzyMatch(content, oldString)
      if (fuzzy) {
        const recovered = applyFuzzyReplacement(content, fuzzy, newString)
        const dryRun = asBool(params.input.dry_run)
        if (dryRun) {
          return buildDryRunPreview(params.cwd, filePath, content, recovered)
        }
        const capture = await trackFileChange(params.cwd, { filePath: relative(params.cwd, filePath), action: 'edit', toolCallId: params.toolUseId ?? 'edit_file' })
        {
          const land = await writeEditLanding(params, filePath, content, recovered, eol)
          if ('delegatedRejectOrError' in land) return land.delegatedRejectOrError
        }
        return await finalizeEdit(params.cwd, filePath, content, recovered, params.sessionId, capture, (warn, ui, changedRanges) => {
          // Surface the whitespace drift so the model can self-correct in
          // subsequent edits — without this, error accumulates across calls.
          const diff = diffBlock(oldString, fuzzy.matchedText)
          const fuzzyReport = [
            `已编辑 ${filePath}（空白容错匹配）`,
            `[fuzzy] 你的 old_string 与文件存在空白/缩进漂移：`,
            `[fuzzy] diff:\n${diff}`,
          ].join('\n')
          return {
            content: fuzzyReport + (warn ? '\n\n' + warn : ''),
            uiContent: ui,
            changedRanges,
          }
        })
      }
      const fails = incrementEditFailCount(filePath)
      const gatePrefix = fails >= 3 ? `此文件已连续编辑失败 ${fails} 次，再次编辑前必须先重新 read_file。\n\n` : ''
      return {
        content: gatePrefix + buildNotFoundError(filePath, oldString, content),
        isError: true,
      }
    }
    const secondIndex = content.indexOf(oldString, firstIndex + 1)
    if (secondIndex !== -1) {
      return {
        content: buildMultipleMatchError(filePath, oldString, content),
        isError: true,
      }
    }
    const newContent = content.replace(oldString, newString)
    const dryRun = asBool(params.input.dry_run)
    if (dryRun) {
      return buildDryRunPreview(params.cwd, filePath, content, newContent)
    }
    const capture = await trackFileChange(params.cwd, { filePath: relative(params.cwd, filePath), action: 'edit', toolCallId: params.toolUseId ?? 'edit_file' })
    {
      const land = await writeEditLanding(params, filePath, content, newContent, eol)
      if ('delegatedRejectOrError' in land) return land.delegatedRejectOrError
    }
    return await finalizeEdit(params.cwd, filePath, content, newContent, params.sessionId, capture, (warn, ui, changedRanges) => {
      const draftReceipt = formatActivePlanDraftReceipt(params.cwd, filePath, params.activePlanFilePath, newContent.length)
      const base = draftReceipt ?? `已编辑 ${filePath}`
      return {
        content: base + (warn ? '\n\n' + warn : ''),
        uiContent: ui,
        changedRanges,
      }
    })
  }),
  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Assemble the display-only uiContent for a successful edit: a colored inline
 * diff (rendered by the TUI/desktop tool card) plus any syntax-check warning.
 * Returns undefined when there is nothing extra to show (card falls back to
 * the model-facing `content`).
 */
async function editUiContent(cwd: string, filePath: string, before: string, after: string, warn: string | null): Promise<string | undefined> {
  const diff = await buildFileDiff(relative(cwd, filePath), before, after)
  if (!diff) return warn ? warn : undefined
  return warn ? `${diff}\n\n${warn}` : diff
}

/**
 * Post-write enhancements for a successful edit: syntax-check, diff, and
 * changed-line-range computation. All three are display-only /
 * diagnostics-narrowing — failures here MUST NOT cause the tool to report an
 * error. The file is already on disk; an error would create a "write succeeded
 * but tool reports failure" → orphan tool_call loop.
 */
async function buildEditSuccessResult(
  cwd: string,
  filePath: string,
  before: string,
  after: string,
  precomputedSyntaxWarning?: string | null,
): Promise<{ warn: string; uiContent?: string; changedRanges: LineRange[] }> {
  let warn = precomputedSyntaxWarning ?? ''
  let uiContent: string | undefined
  let changedRanges: LineRange[] = []

  if (!warn) {
    try {
      const result = await syntaxCheck(filePath, after)
      if (result) warn = result
    } catch (e) {
      warn = `(语法检查已跳过： ${(e as Error).message})`
    }
  }

  try {
    uiContent = await editUiContent(cwd, filePath, before, after, warn || null)
    changedRanges = await computeChangedLineRanges(before, after)
  } catch (e) {
    if (!warn) warn = `(diff 已跳过： ${(e as Error).message})`
    else warn = `${warn}\n(diff 已跳过： ${(e as Error).message})`
  }

  return { warn, uiContent, changedRanges }
}

/**
 * Preview mode for dry_run: compute the diff and changed ranges without
 * writing anything to disk. Still runs a syntax check so the model can see
 * whether applying the edit would introduce parse errors.
 */
async function buildDryRunPreview(
  cwd: string,
  filePath: string,
  before: string,
  after: string,
): Promise<{ content: string; uiContent?: string; changedRanges: LineRange[] }> {
  let warn = ''
  try {
    const check = await checkSyntax(filePath, after)
    if (check.fatal) warn = `若应用将出现语法错误：${check.fatal}`
    else if (check.warning) warn = check.warning
  } catch (e) {
    warn = `(语法检查已跳过： ${(e as Error).message})`
  }

  let diff = ''
  let changedRanges: LineRange[] = []
  try {
    diff = await buildFileDiff(relative(cwd, filePath), before, after)
    changedRanges = await computeChangedLineRanges(before, after)
  } catch (e) {
    warn = warn ? `${warn}\n(diff 已跳过： ${(e as Error).message})` : `(diff 已跳过： ${(e as Error).message})`
  }

  const content = `预览（dry_run）${filePath} — 未写入任何更改：\n\n${diff || '（无文本变更）'}` + (warn ? `\n\n${warn}` : '')
  return { content, uiContent: diff || undefined, changedRanges }
}

/**
 * Post-write validation + rollback helper.
 * Runs strict syntax/AST checks on the edited file. If a fatal parse error is
 * detected, automatically restores its pre-edit capture and returns an error.
 * Otherwise records the successful edit and returns the normal success payload.
 */
async function finalizeEdit(
  cwd: string,
  filePath: string,
  before: string,
  after: string,
  sessionId: string | undefined,
  capture: FileChangeRecord,
  buildSuccessResult: (warn: string, uiContent: string | undefined, changedRanges: LineRange[]) => { content: string; uiContent?: string; changedRanges: LineRange[] },
): Promise<{ content: string; uiContent?: string; changedRanges: LineRange[]; isError?: boolean; errorKind?: 'syntax_error' }> {
  const check = await checkSyntax(filePath, after)
  if (check.fatal) {
    const restored = await restoreFileChange(cwd, capture, sessionId)
    // 回滚后 mtime 会变（copyFileSync 不保留原始时间戳），但内容已恢复。
    // 刷新读文件 mtime 追踪器——否则后续 hash_edit 的仅位置锚点检查会误报
    // "文件已变化，请重新 read_file"，主控白费一轮重读。
    if (restored) {
      try {
        const s = await stat(filePath)
        // 回滚恢复的就是编辑前内容：带上 before 重建内容哈希基线——否则
        // hash_edit 的位置锚点检查（要求完整观察且内容未变）会因 mtime 变化误报。
        noteFileObserved(filePath, s.mtimeMs, s.size, sessionId, before)
      } catch { /* stat 失败不影响主流程 */ }
    }
    const fails = incrementEditFailCount(filePath)
    const gatePrefix = fails >= 3 ? `此文件已连续编辑失败 ${fails} 次，再次编辑前必须先重新 read_file。\n\n` : ''
    const rollbackMsg = restored ? '更改已自动回滚。' : '自动回滚失败。'
    return {
      content: gatePrefix + `错误：${check.fatal}\n\n${rollbackMsg}\n\n请修复编辑后重试。复杂改动建议优先用 apply_patch 加 unified diff。`,
      isError: true,
      errorKind: 'syntax_error',
      changedRanges: [],
    }
  }
  await recordSuccessfulEdit(filePath, sessionId)
  resetEditFailCount(filePath)
  const { warn, uiContent, changedRanges } = await buildEditSuccessResult(cwd, filePath, before, after, check.warning)
  return buildSuccessResult(warn, uiContent, changedRanges)
}

/**
 * When old_string is not found, locate the closest substring in the file
 * and emit a unified-style diff so the model can see what its old_string
 * "looked like" in reality. Common failure modes this catches:
 *   - whitespace mismatch (tabs vs spaces, trailing spaces, CRLF vs LF)
 *   - off-by-one characters from manual transcription
 *   - line that "looks" the same but has subtle Unicode differences
 */
function buildNotFoundError(filePath: string, oldString: string, fileContent: string): string {
  return buildNotFoundErrorBody(filePath, oldString, fileContent) + regexMisuseHint(oldString)
}

function buildNotFoundErrorBody(filePath: string, oldString: string, fileContent: string): string {
  const oldLines = oldString.split('\n')
  const firstLine = oldLines[0] ?? ''
  const lastLine = oldLines[oldLines.length - 1] ?? ''

  // Strategy: find the file line whose trimmed content most closely matches
  // the trimmed first line of old_string. Then extract a window of size
  // matching old_string's line count. This handles indentation drift well.
  const fileLines = fileContent.split('\n')
  const trimmedFirst = firstLine.trim()
  const trimmedLast = lastLine.trim()

  let bestIdx = -1
  let bestScore = 0
  for (let i = 0; i < fileLines.length; i++) {
    const trimmed = fileLines[i]!.trim()
    if (trimmed.length === 0) continue
    const score = sharedPrefixLength(trimmed, trimmedFirst)
    if (score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }

  // Require a meaningful match: at least 8 chars or 30% of the first line.
  const minScore = Math.max(8, Math.floor(trimmedFirst.length * 0.3))
  if (bestIdx === -1 || bestScore < minScore) {
    return `错误：在 ${filePath} 中未找到 old_string。文件中没有任何内容接近 old_string 的首行。请重新读取文件查看当前内容。`
  }

  // Extract a window of the same line count as old_string from the file.
  const windowSize = oldLines.length
  const start = bestIdx
  const end = Math.min(fileLines.length, start + windowSize)
  const actualWindow = fileLines.slice(start, end).join('\n')

  // If the trimmed last line also matches better with a longer window, expand.
  // (Rare, but helps when the model's old_string skipped middle lines.)
  if (trimmedLast.length > 0 && windowSize > 1) {
    for (let extend = end; extend < Math.min(fileLines.length, start + windowSize + 5); extend++) {
      if (fileLines[extend]!.trim() === trimmedLast) {
        const expanded = fileLines.slice(start, extend + 1).join('\n')
        const hint = hashEditHint(fileContent, start + 1, extend + 1)
        return hint
          ? `${formatDiffError(filePath, oldString, expanded, start + 1)}\n\n提示：改用这些 hash_edit 锚点：\n  ${hint}`
          : formatDiffError(filePath, oldString, expanded, start + 1)
      }
    }
  }

  const hint = hashEditHint(fileContent, start + 1, end)
  return hint
    ? `${formatDiffError(filePath, oldString, actualWindow, start + 1)}\n\n提示：改用这些 hash_edit 锚点：\n  ${hint}`
    : formatDiffError(filePath, oldString, actualWindow, start + 1)
}

/**
 * When old_string matches multiple locations, show the line number and
 * surrounding context for each match so the model can pick the right one
 * and add disambiguating context.
 */
function buildMultipleMatchError(filePath: string, oldString: string, fileContent: string): string {
  const matches: Array<{ lineNumber: number; context: string }> = []
  let searchFrom = 0
  while (matches.length < 3) {
    const idx = fileContent.indexOf(oldString, searchFrom)
    if (idx === -1) break
    const lineNumber = fileContent.slice(0, idx).split('\n').length
    // Show the line containing the match plus 1 line above and below.
    const lines = fileContent.split('\n')
    const ctxStart = Math.max(0, lineNumber - 2)
    const ctxEnd = Math.min(lines.length, lineNumber + 1)
    const context = lines.slice(ctxStart, ctxEnd)
      .map((l, i) => `${ctxStart + i + 1}: ${l}`)
      .join('\n')
    matches.push({ lineNumber, context })
    searchFrom = idx + oldString.length
  }

  const matchSummary = matches
    .map((m, i) => {
      const startLine = m.lineNumber
      const endLine = startLine + oldString.split('\n').length - 1
      const anchors = hashEditHint(fileContent, startLine, endLine)
      const hint = anchors ? `\n  提示：使用 hash_edit anchors=["${anchors.split('  ').join('", "')}"]` : ''
      return `匹配 ${i + 1}（第 ${m.lineNumber} 行）：\n${m.context}${hint}`
    })
    .join('\n\n')

  return `错误：old_string 在 ${filePath} 中匹配到多处。使用 replace_all=true 替换所有出现处，或为 old_string 补充周围上下文使其唯一。\n\n找到的匹配：\n\n${matchSummary}`
}

function formatDiffError(filePath: string, oldString: string, actualWindow: string, startLine: number): string {
  const oldLines = oldString.split('\n')
  const actualLines = actualWindow.split('\n')

  const diffLines: string[] = []
  diffLines.push(`--- 预期（你的 old_string）`)
  diffLines.push(`+++ 实际（文件第 ${startLine} 行）`)

  const maxLen = Math.max(oldLines.length, actualLines.length)
  for (let i = 0; i < maxLen; i++) {
    const exp = oldLines[i]
    const act = actualLines[i]
    if (exp === act) {
      diffLines.push(`  ${exp ?? ''}`)
    } else {
      if (exp !== undefined) diffLines.push(`- ${exp}`)
      if (act !== undefined) diffLines.push(`+ ${act}`)
    }
  }

  return `错误：在 ${filePath} 中未找到 old_string。最接近的匹配在第 ${startLine} 行：\n\n${diffLines.join('\n')}\n\n请修正 old_string 以匹配文件实际内容（检查空白、缩进和换行符）后重试。`
}

/**
 * Compact line-by-line diff between `expected` (model's old_string) and
 * `actual` (file's real matched text). Used in the fuzzy-match success
 * path so the model sees WHERE its old_string differed from the file —
 * preventing error accumulation in subsequent edits.
 *
 * Compares raw lines (not normalized) so whitespace/indentation drift
 * is surfaced even when fuzzy match proved normalized equality.
 * maxDiffs limits the number of differing lines shown.
 */
function diffBlock(expected: string, actual: string, maxDiffs = 5): string {
  const expLines = expected.split('\n')
  const actLines = actual.split('\n')
  const maxLen = Math.max(expLines.length, actLines.length)
  const diffs: string[] = []
  let diffCount = 0
  let i = 0

  for (; i < maxLen; i++) {
    const exp = expLines[i] ?? '<eof>'
    const act = actLines[i] ?? '<eof>'
    // Compare raw — fuzzy match proved normalized equality, so any raw
    // difference is exactly the whitespace drift we want to surface.
    if (exp !== act) {
      const expShow = JSON.stringify(exp.slice(0, 60))
      const actShow = JSON.stringify(act.slice(0, 60))
      diffs.push(`  L${i + 1}: exp ${expShow}`)
      diffs.push(`  L${i + 1}: act ${actShow}`)
      if (++diffCount >= maxDiffs) break
    }
  }

  if (diffs.length === 0) {
    return '  （各行相同——无差异）'
  }
  const truncated = i + 1 < maxLen ? `\n  …（另 +${maxLen - i - 1} 行）` : ''
  return diffs.join('\n') + truncated
}

/** Length of common prefix between two strings. Used as a cheap similarity score. */
function sharedPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a[i] === b[i]) i++
  return i
}

/** Generate hash_edit anchor hints for the given line range in fileContent.
 *  Returns a string like "L42:a1b2c3d4  L44:e5f6a7b8" or null if out of range. */
function hashEditHint(fileContent: string, startLine: number, endLine: number): string | null {
  const fileLines = fileContent.split('\n')
  if (startLine < 1 || endLine > fileLines.length || startLine > endLine) return null
  const first = `L${startLine}:${hashLine(fileLines[startLine - 1]!)}`
  if (startLine === endLine) return first
  const last = `L${endLine}:${hashLine(fileLines[endLine - 1]!)}`
  return `${first}  ${last}`
}
