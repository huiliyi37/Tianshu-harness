import { appendFile, mkdir, rm, stat, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, relative, extname } from 'path'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { validatePath } from './path-validate.js'
import { syntaxCheck, checkSyntax } from './syntax-check.js'
import { getFileReadMtime, recordSuccessfulEdit, incrementEditFailCount, resetEditFailCount } from './read-file.js'
import { landingWriteFile, delegatedToToolResult, isDelegateRejected } from './client-delegate.js'
import { trackFileChange, restoreLatestBackup } from '../agent/recovery-stack.js'
import { applyEol, chooseEol, detectFileEol, toLf } from './line-endings.js'
import { getTargetEol } from '../platform.js'
import { buildFileDiff, computeChangedLineRanges, type LineRange } from './edit-diff.js'
import { detectPointerPlaceholder, pointerPlaceholderError, resolveIdempotentPointer } from './pointer-guard.js'
import { toPosixPath } from '../path-format.js'
import { writeMarkdownAsDocx } from './office-writer.js'
import { formatActivePlanDraftReceipt, canonicalizePathForCompare } from '../agent/plan-mode.js'

const MAX_WRITE_FILE_BYTES = 10 * 1024 * 1024 // 10MB — safety ceiling for single write_file call

/** 总闸/用户打断后的迟到写防护（2026-09-08 写后挂起事故族）：工具级 120s
 *  总闸 reject 后原 execute 仍在跑（JS 无强取消）——delegated fail-back 的
 *  本地写可能在回合已按超时错误继续后才到达，覆盖模型后续方案。写盘入口
 *  前检查 composed abortSignal，已放弃的调用不再落盘。正常快速写（ms 级）
 *  在 abort 前完成，零影响。 */
function abortedWrite(params: ToolCallParams): ToolResult | null {
  if (params.abortSignal?.aborted) {
    return {
      content: '错误：写入已中止——本工具调用已超时或被中断，未执行磁盘写入。请 read_file 确认当前文件状态后重试。',
      isError: true,
    }
  }
  return null
}

// Rewrite-loop hint: repeated writes of the same path usually mean the model
// lost track of what landed on disk (7 rewrites in the 2026-08-01 desktop
// session). Track per-session write counts and nudge from the 2nd write
// onward — a soft warning, never a block (legitimate iterative edits must
// keep working).
const rewriteCounts = new Map<string, { count: number; lastHash: string; warned: boolean }>()
function rewriteLoopHint(sessionId: string | undefined, filePath: string, content: string): string {
  const key = `${sessionId ?? 'default'}:${filePath}`
  const prev = rewriteCounts.get(key)
  // 内容指纹：同内容重复写是最确定的浪费（token 重发+磁盘写），每次提示并
  // 附加「内容与上次相同」；内容不同的迭代只提示一次（B1 教训：重复提醒
  // 不改变行为，纯噪音——A 型重写循环的内容往往不同，首次警告已足够）。
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
  const n = (prev?.count ?? 0) + 1
  const sameContent = prev?.lastHash === hash
  rewriteCounts.set(key, { count: n, lastHash: hash, warned: prev?.warned ?? false })
  if (n < 2) return ''
  if (!sameContent && (prev?.warned ?? false)) return ''
  rewriteCounts.set(key, { count: n, lastHash: hash, warned: true })
  return `\n\n⚠ 疑似重写循环：本会话已 ${n} 次写入 ${toPosixPath(filePath)}${sameContent ? '，且本次内容与上次相同' : ''}。每次写入都已成功落盘。若只是想确认内容，请 read_file 查看，无需重写。`
}

export const WRITE_FILE_TOOL: Tool = {
  definition: {
    name: 'write_file',
    description: `创建、覆盖或追加一个文件。自动创建父目录。

### 用法
- 对已有文件的定点修改优先用 edit_file
- write_file 只用于新文件或整文件重写
- 始终提供绝对文件路径
- overwrite 时 content 是完整文件内容（不是 diff）；append 时 content 是本次追加的块
- 父目录不存在时自动创建
- mode 缺省 overwrite；append 把内容原样追加到文件末尾（不自动加换行）
- 单次内容过大时分块写新文件：先 overwrite 第一块，再用 append 依次追加后续块；绝不要用分块方式修改已有文件的中间部分

### 示例
好的：write_file(file_path="/abs/path/src/new-component.tsx", content="...full file content...")
好的：write_file(file_path="/abs/path/big-data.sql", content="...chunk 2...", mode="append")
坏的：用 write_file 只改已有文件里的一行（应改用 edit_file）

**注意：** 磁盘上的文件是唯一事实来源。写入成功后无需重写或回贴内容确认；后续轮次如需回看写入内容，用 \`read_file\`。`,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件的绝对路径。先提供此参数。' },
        content: { type: 'string', description: '完整文件内容（append 时为本块内容；不是 diff）。最后提供此参数。' },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append'],
          description: '写入模式。缺省 overwrite 整文件覆盖；append 原样追加到文件末尾（不自动加换行），用于分块写入新文件。',
        },
      },
      required: ['file_path', 'content'],
    },
  },

  async execute(params) {
    const abortedEarly = abortedWrite(params)
    if (abortedEarly) return abortedEarly
    let filePath: string
    try {
      filePath = validatePath(params.cwd, params.input.file_path as string, 'write')
    } catch (e) {
      return { content: `错误：${e instanceof Error ? e.message : '路径逃逸出项目目录'}`, isError: true }
    }
    const content = params.input.content as string
    const rawMode = params.input.mode
    if (rawMode !== undefined && rawMode !== 'overwrite' && rawMode !== 'append') {
      return { content: `错误：mode 只支持 'overwrite'（缺省）或 'append'，收到 ${JSON.stringify(rawMode)}。`, isError: true }
    }
    const append = rawMode === 'append'

    // Office: Markdown → .docx（仅整篇覆盖；追加对该格式无意义）
    if (extname(filePath).toLowerCase() === '.docx') {
      if (append) {
        return { content: '错误：append 模式不支持 .docx（该格式走 Markdown 整篇转换写入）。', isError: true }
      }
      try {
        const result = await writeMarkdownAsDocx(filePath, content)
        return {
          content: `已将 Markdown→docx 写入 ${toPosixPath(relative(params.cwd, filePath))}（引擎：${result.engine}）`,
          rawPath: filePath,
        }
      } catch (e) {
        return {
          content: `错误：Markdown→docx 转换失败：${e instanceof Error ? e.message : '未知'}。请安装 pandoc（brew install pandoc）或 LibreOffice。`,
          isError: true,
        }
      }
    }

    const dir = dirname(filePath)

    // Pointer-regurgitation guard: the arg post-processors replace large
    // content fields in message history with pointer placeholders. Models
    // imitate that pattern in long sessions and echo a pointer back as the
    // real content (session 05e1500e; word-batch report 2026-07-06). Checks
    // ALL pointer prefixes — the model may echo any tool's placeholder here.
    const matchedPointer = detectPointerPlaceholder(content)
    if (matchedPointer) {
      const resolved = await resolveIdempotentPointer({ mode: 'full', filePath, value: content, matchedPrefix: matchedPointer })
      if (resolved) return resolved
      return {
        content: pointerPlaceholderError({ toolName: 'write_file', field: 'content', matchedPrefix: matchedPointer, filePath }),
        isError: true,
      }
    }

    if (content.length > MAX_WRITE_FILE_BYTES) {
      const sizeMB = (content.length / (1024 * 1024)).toFixed(1)
      return {
        content: `错误：内容过大，超出 write_file 能力（${sizeMB}MB）。请拆成更小的文件，或用 edit_file 做增量修改。`,
        isError: true,
      }
    }

    await mkdir(dir, { recursive: true })

    // The active plan-mode draft is intentionally created as an empty file by
    // the system. Writing the first content to it is not a blind overwrite of
    // user content, so skip the read-before-write guard for that exact path.
    const isActivePlanDraft = params.activePlanFilePath
      && canonicalizePathForCompare(toPosixPath(relative(params.cwd, filePath)))
        === canonicalizePathForCompare(params.activePlanFilePath)

    // If overwriting an existing file, back it up for recovery
    let fileExists = false
    let existingSize = 0
    // Old content (LF-normalized) as the diff base; '' → new file (all-additions).
    let oldContentForDiff = ''
    // When an existing file could not be read (binary, unreadable, or too large),
    // we intentionally skip the diff so the card falls back to the summary text
    // instead of showing a misleading all-additions diff.
    let haveOldContentForDiff = false
    try {
      const existingStat = await stat(filePath)
      fileExists = true
      existingSize = existingStat.size
      if (existingStat.size <= MAX_WRITE_FILE_BYTES) {
        try {
          oldContentForDiff = toLf(await readFile(filePath, 'utf-8'))
          haveOldContentForDiff = true
        } catch {
          // Binary/unreadable — skip diff base, card falls back to summary text.
        }
      }
    } catch {
      // File doesn't exist yet — empty base is intentional; produce an all-additions diff.
      haveOldContentForDiff = true
    }

    // ── append 分块写通道（kimi-code Write 同款语义）──────────────────────
    // 不读不回写既有内容；跳过盲覆盖守卫（追加无信息销毁）；跳过整文件语法检查
    // 与回滚（分块中途文件天然不完整）；不计入重写循环提示（分块本就是多次写
    // 同一路径）。delegated 落地仅支持整篇覆盖 —— append 始终本地 appendFile。
    if (append) {
      if (fileExists) {
        await trackFileChange(params.cwd, { filePath: relative(params.cwd, filePath), action: 'write', toolCallId: params.toolUseId ?? 'write_file' })
      }
      const eol = fileExists ? await detectFileEol(filePath) : null
      const chunk = applyEol(content, chooseEol(filePath, eol, getTargetEol()))
      const abortedAppend = abortedWrite(params)
      if (abortedAppend) return abortedAppend
      try {
        await appendFile(filePath, chunk)
      } catch (e) {
        return { content: `错误：追加写入失败：${e instanceof Error ? e.message : '未知错误'}`, isError: true }
      }
      await recordSuccessfulEdit(filePath, params.sessionId)
      const total = (await stat(filePath)).size
      return { content: `已追加 ${chunk.length} 字符到 ${toPosixPath(filePath)}（文件现共 ${total} 字节）。` }
    }

    // Blind-overwrite guard (fail-closed): overwriting an existing file this
    // session never observed (no read_file / grep hit / prior own edit —
    // lastKnownFileState has no entry) destroys content the model has never
    // seen. Byte-identical rewrites are exempt (no information loss). After
    // the refusal a single read_file registers the observation and the next
    // write_file goes through — self-correcting, one extra tool call.
    // Plan-mode drafts are exempt: they start empty and exist only for the
    // agent to fill in.
    if (
      fileExists
      && !isActivePlanDraft
      && process.env.RIVET_WRITE_OVERWRITE_GUARD !== '0'
      && getFileReadMtime(filePath, params.sessionId) === null
      && !(haveOldContentForDiff && oldContentForDiff === toLf(content))
    ) {
      return {
        content: `错误：${filePath} 已存在（${existingSize} 字节），但本会话从未读取过。`
          + `盲目覆盖会销毁你尚未见过的内容。`
          + `请先 read_file 确认要替换的内容，再用 edit_file 做定向修改，`
          + `或再次调用 write_file 进行有意的整文件重写。`,
        isError: true,
      }
    }

    if (fileExists) {
      const relPath = relative(params.cwd, filePath)
      await trackFileChange(params.cwd, { filePath: relPath, action: 'write', toolCallId: params.toolUseId ?? 'write_file' })
    }

    // Staleness check: warn if file was read earlier and has since been modified
    // by another process/tool (prevents silent overwrite of external changes).
    try {
      const currentStat = await stat(filePath)
      const currentMtime = currentStat.mtimeMs
      const lastReadMtime = getFileReadMtime(filePath, params.sessionId)
      if (lastReadMtime !== null && currentMtime !== lastReadMtime) {
        console.warn(`⚠ write_file: ${filePath} was modified externally since last read. Overwriting.`)
      }
    } catch {
      // File doesn't exist yet — skip staleness check
    }

    // Line-ending policy: force CRLF for Windows batch files, preserve an
    // existing file's dominant EOL on overwrite, default to LF for new files.
    // The LF branch is byte-identical to writing `content` verbatim.
    const existingEol = fileExists ? await detectFileEol(filePath) : null
    const finalContent = applyEol(content, chooseEol(filePath, existingEol, getTargetEol()))

    // 迟到写防护：总闸超时/打断后不再落盘（delegated fail-back 可能在回合
    // 已继续后到达——覆盖模型后续方案的窗口）。
    const abortedLanding = abortedWrite(params)
    if (abortedLanding) return abortedLanding

    const land = await landingWriteFile(params, filePath, haveOldContentForDiff ? oldContentForDiff : '', finalContent)
    if (land.kind === 'delegated') {
      if (isDelegateRejected(land.delegated) || land.delegated.isError) {
        return delegatedToToolResult(land.delegated)
      }
      // Client applied — continue post-write validation on the live file.
    }

    // Post-write structural validation: if the file is unparseable, roll back.
    const syntax = await checkSyntax(filePath, finalContent)
    if (syntax.fatal) {
      const relPath = relative(params.cwd, filePath)
      let rollbackMsg: string
      if (!fileExists && land.kind !== 'delegated') {
        // 新文件没有备份可恢复（trackFileChange 只备份已存在文件）——
        // 回滚 = 移除刚写入的坏文件，不把语法损坏的残尸留在磁盘上。
        try {
          await rm(filePath, { force: true })
          rollbackMsg = '新文件已自动移除（写入前不存在，无备份可恢复）。'
        } catch {
          rollbackMsg = '自动回滚失败。'
        }
      } else {
        const restored = await restoreLatestBackup(params.cwd, relPath, params.sessionId)
        rollbackMsg = restored ? '更改已自动回滚。' : '自动回滚失败。'
      }
      const fails = incrementEditFailCount(filePath)
      const gatePrefix = fails >= 3 ? `此文件已连续写入失败 ${fails} 次，再次编辑前必须先重新 read_file。\n\n` : ''
      return {
        content: gatePrefix + `错误：${syntax.fatal}\n\n${rollbackMsg}\n\n请修复内容后重试。`,
        isError: true,
        errorKind: 'syntax_error',
      }
    }

    resetEditFailCount(filePath)
    await recordSuccessfulEdit(filePath, params.sessionId)
    const lines = finalContent.split('\n').length

    // Post-write enhancements (syntax-check, diff, changed-ranges) are
    // display-only / diagnostics-narrowing.  Failures here MUST NOT cause
    // the tool call to report an error — the file is already on disk and
    // an error would create a "write succeeded but tool reports failure"
    // loop: the model retries, hits the blind-overwrite guard, and stalls.
    let warn = syntax.warning ?? ''
    let diff = ''
    let changedRanges: LineRange[] = []
    // display-only 段整体软上界（2026-09-08 写后挂起事故族防御纵深）：
    // buildFileDiff 内部已有 pool/inline 双层超时，此 race 兜底未来实现
    // 变化引入的无界路径；超时走 catch → diff 跳过（文件已在盘上，仅卡
    // 丢失展示层信息）。
    const DISPLAY_ONLY_SOFT_TIMEOUT_MS = 5000
    try {
      const afterForDiff = toLf(content)
      if (haveOldContentForDiff) {
        const [d, cr] = await Promise.race([
          Promise.all([
            buildFileDiff(relative(params.cwd, filePath), oldContentForDiff, afterForDiff),
            computeChangedLineRanges(oldContentForDiff, afterForDiff),
          ]),
          new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new Error(`display-only 段超过 ${DISPLAY_ONLY_SOFT_TIMEOUT_MS / 1000}s`)), DISPLAY_ONLY_SOFT_TIMEOUT_MS)
            if (typeof t.unref === 'function') t.unref()
          }),
        ])
        diff = d
        changedRanges = cr
      }
    } catch (e) {
      warn = warn ? `${warn}\n(diff 已跳过：${(e as Error).message})` : `(diff 已跳过：${(e as Error).message})`
    }
    const uiContent = diff ? (warn ? `${diff}\n\n${warn}` : diff) : (warn ? warn : undefined)
    const draftReceipt = formatActivePlanDraftReceipt(
      params.cwd,
      filePath,
      params.activePlanFilePath,
      finalContent.length,
    )
    const receipt = draftReceipt
      ?? `已写入 ${finalContent.length} 字节（${lines} 行）到 ${toPosixPath(filePath)}——内容与你提交的一致`
    return {
      content: receipt + rewriteLoopHint(params.sessionId, filePath, content) + (warn ? '\n\n' + warn : ''),
      uiContent,
      changedRanges,
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
