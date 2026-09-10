import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { relative } from 'node:path'
import { writeFileAtomicAsync } from '../fs-atomic.js'
import { applyEol, chooseEol } from './line-endings.js'
import { getTargetEol } from '../platform.js'
import { incrementEditFailCount, resetEditFailCount } from './read-file.js'
import { checkSyntax } from './syntax-check.js'
import { trackFileChange, restoreLatestBackup } from '../agent/recovery-stack.js'
import { validatePathSafe } from './path-validate.js'
import { cpuPool } from '../workers/cpu-pool.js'
import type { AstEditChange, AstEditComputeArgs, AstEditComputeResult, AstEditOpArg } from '../workers/cpu-tasks.js'
import { MAX_PARSE_FILE_BYTES, astScanSoftMs, astScanUnavailable, collectFiles } from './ast-shared.js'

/** Post-write syntax verification + rollback for ast_edit. Default on;
 *  RIVET_AST_EDIT_VERIFY=0 falls back to the pre-write ERROR-node gate only. */
function isAstEditVerifyEnabled(): boolean {
  const v = process.env.RIVET_AST_EDIT_VERIFY
  return v !== '0' && v !== 'false'
}

// ── types ─────────────────────────────────────────────────────────

export type AstEditOp = AstEditOpArg

export interface AstEditInput {
  ops: AstEditOp[]
  paths?: string[]
  lang?: string
  dryRun?: boolean
  limit?: number
}

// ── tool ──────────────────────────────────────────────────────────

export const AST_EDIT_TOOL: Tool = {
  definition: {
    name: 'ast_edit',
    description:
      '按 AST 结构（而非文本）编辑代码。用 ast-grep 模式查找并替换语法节点。默认 dryRun（仅预览）。设 dryRun:false 才写文件。适用于 TypeScript/JavaScript/Tsx/Html/Css。',
    input_schema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string', description: '要查找的 ast-grep 模式（如 "var $NAME = $VAL"）' },
              replace: { type: 'string', description: '替换模板（如 "const $NAME = $VAL"）' },
            },
            required: ['find', 'replace'],
          },
          description: 'find/replace 操作的有序列表',
        },
        paths: { type: 'array', items: { type: 'string' }, description: '要编辑的文件或目录' },
        lang: { type: 'string', description: '语言：TypeScript, Tsx, JavaScript, Html, Css' },
        dryRun: { type: 'boolean', description: '为 true（默认）时仅预览——不写文件' },
        limit: { type: 'integer', description: '每文件最大改动数（默认 50）' },
      },
      required: ['ops'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const input = params.input as Record<string, unknown>
    const ops = Array.isArray(input.ops) ? (input.ops as AstEditOp[]) : []
    if (ops.length === 0) return { content: '错误：至少需要一个 find/replace 操作', isError: true }

    for (const op of ops) {
      if (typeof op.find !== 'string' || !op.find.trim()) {
        return { content: '错误：每个操作必须有非空的 "find" 模式', isError: true }
      }
      if (typeof op.replace !== 'string') {
        return { content: '错误：每个操作必须有 "replace" 模板', isError: true }
      }
    }

    // Regex-misuse guard: ast-grep uses its own pattern syntax ($NAME, $$),
    // not regular expressions. \d \w .* etc. will not work as intended.
    for (const op of ops) {
      const find = op.find as string
      if (/\\[dDwWsSbB1-9]/.test(find)) {
        return {
          content: `错误："find" 模式含有正则标记（\\d、\\w、\\s、\\1 等）。\n\nast_edit 使用 ast-grep 语法，不是正则表达式。诸如 "var $NAME = $VAL" 的模式匹配 AST 节点——用 $ 元变量作占位，用 $$ 表示省略。\n\n问题模式：${find.slice(0, 80)}`,
          isError: true,
        }
      }
      const replace = op.replace as string
      if (/\\[dDwWsSbB1-9]/.test(replace)) {
        return {
          content: `错误："replace" 模板含有正则标记（\\d、\\w、\\s、\\1 等）。\n\nast_edit 的替换模板使用 ast-grep 元变量（$NAME、$$NAME），不是正则表达式。这些标记会被原样写入文件。\n\n问题模板：${replace.slice(0, 80)}`,
          isError: true,
        }
      }
    }

    // path（单数）别名：schema 只声明 paths，但模型/worker 常写成单数。忽略它会
    // 静默退化为 ['.'] 全仓扫描——2026-09-10 卡死事故的直接触发条件。
    const paths = Array.isArray(input.paths)
      ? (input.paths as unknown[]).filter((p): p is string => typeof p === 'string')
      : typeof input.path === 'string' && input.path.trim()
        ? [input.path.trim()]
        : ['.']
    const explicitLang = typeof input.lang === 'string' && input.lang.trim() ? input.lang.trim() : undefined
    const dryRun = input.dryRun !== false // default true
    const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : 50

    const allFiles: string[] = []
    const mode = dryRun ? 'read' : 'write'
    const cwd = params.cwd ?? process.cwd()
    for (const p of paths) {
      // 工作区边界 + 授权 + 敏感文件硬门——ast_edit 是写类工具，路径必须与其余
      // 文件工具走同一校验（此前完全绕过 validatePath，是沙箱逃逸面）。
      const check = validatePathSafe(cwd, p, mode)
      if (!check.ok) return { content: `错误：${check.error}`, isError: true }
      try {
        const collected = await collectFiles(check.path)
        // 收集结果同样过校验：工作区内的符号链接目录可能指向外部。
        for (const f of collected) {
          const fcheck = validatePathSafe(cwd, f, mode)
          if (!fcheck.ok) {
            return { content: `错误：${fcheck.error}`, isError: true }
          }
          allFiles.push(fcheck.path)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { content: `错误：${message}`, isError: true }
      }
    }

    // 解析 + 编辑计算整段在 worker 线程（cpu-tasks.astEditComputeRaw）：native
    // parse / findAll / commitEdits 同步阻塞事件循环，留在主线程等于保留
    // 2026-09-10 的假死形态。**写文件仍在主线程**——审批、备份、写后语法复检与
    // 回滚必须保持单一入口。worker 不可用/超时一律报错降级，不回退主线程。
    const computeArgs: AstEditComputeArgs = {
      files: allFiles,
      ops,
      explicitLang,
      dryRun,
      limit,
      maxBytes: MAX_PARSE_FILE_BYTES,
    }

    let compute: AstEditComputeResult
    try {
      compute = await cpuPool.run('astEditComputeRaw', [computeArgs], astScanSoftMs()) as AstEditComputeResult
    } catch (err) {
      return {
        content: astScanUnavailable(err instanceof Error ? err.message : String(err)),
        isError: true,
      }
    }
    if (compute.loadError) return { content: compute.loadError, isError: true }

    const errors = compute.errors
    const fileResults: Array<{ file: string; changes: AstEditChange[] }> = []

    for (const fr of compute.files) {
      if (dryRun) {
        fileResults.push({ file: fr.file, changes: fr.changes })
        continue
      }
      // worker 的「编辑后语法检查」未过——错误已记在 errors，丢弃该文件更改。
      if (!fr.syntaxOk) continue

      const relPath = relative(cwd, fr.file)
      const verify = isAstEditVerifyEnabled()
      try {
        params.onFileWrite?.(fr.file)
        // Preserve the file's original line endings (CRLF on Windows-authored
        // files); ast-grep edits operate on \n-normalized ranges internally.
        const eol = chooseEol(fr.file, fr.existingEol, getTargetEol())
        // Back up before writing so a fatal post-write check can roll back.
        if (verify) {
          await trackFileChange(cwd, { filePath: relPath, action: 'edit', toolCallId: params.toolUseId ?? 'ast_edit' })
        }
        await writeFileAtomicAsync(fr.file, applyEol(fr.newSource, eol))

        // Authoritative post-write verification (python3 ast.parse / esbuild):
        // the ast-grep ERROR-node gate misses some corruption; checkSyntax is the
        // same gate edit_file/write_file use. Fatal → roll back.
        let rolledBack = false
        if (verify) {
          try {
            const check = await checkSyntax(fr.file, fr.newSource)
            if (check.fatal) {
              await restoreLatestBackup(cwd, relPath, params.sessionId)
              incrementEditFailCount(fr.file)
              errors.push(`${fr.file}: 写入后语法错误——已回滚：${check.fatal.split('\n')[0]}`)
              rolledBack = true
            }
          } catch {
            // checkSyntax degraded (missing parser/timeout) — keep the write.
          }
        }

        if (!rolledBack) {
          fileResults.push({ file: fr.file, changes: fr.changes })
          resetEditFailCount(fr.file)
        }
      } catch {
        errors.push(`${fr.file}: 写入更改失败`)
      }
    }

    // ── format output ─────────────────────────────────────────────

    const totalChanges = fileResults.reduce((sum, f) => sum + f.changes.length, 0)
    const action = dryRun ? '已预览' : '已应用'

    let body = ''
    for (const fr of fileResults) {
      body += `\n${fr.file}:`
      for (const ch of fr.changes) {
        // Multi-line-aware preview: show before/after as separate blocks instead
        // of collapsing newlines to \n. The model can judge whether a structural
        // replacement is correct only if it sees the actual shape of the change.
        const beforeLines = ch.before.split('\n')
        const afterLines = ch.after.split('\n')
        const beforeShow = beforeLines.length > 1
          ? beforeLines.slice(0, 3).join('\n    ') + (beforeLines.length > 3 ? `\n    …（另 +${beforeLines.length - 3} 行）` : '')
          : beforeLines[0]!.slice(0, 80)
        const afterShow = afterLines.length > 1
          ? afterLines.slice(0, 3).join('\n    ') + (afterLines.length > 3 ? `\n    …（另 +${afterLines.length - 3} 行）` : '')
          : afterLines[0]!.slice(0, 80)
        body += `\n  L${ch.line}:\n    - ${beforeShow}\n    + ${afterShow}`
      }
    }

    const summary = `${totalChanges} 处更改${action}于 ${fileResults.length} 个文件${errors.length > 0 ? `，${errors.length} 个错误` : ''}`
    const errorSection = errors.length > 0 ? `\n\n错误：\n${errors.map(e => `  - ${e}`).join('\n')}` : ''

    // Fail counter: if all ops produced errors and no changes, increment for
    // the first file with errors (the primary target). Reset on success above.
    if (errors.length > 0 && totalChanges === 0) {
      incrementEditFailCount(fileResults.length > 0 ? fileResults[0]!.file : (paths[0] ?? ''))
    }

    return { content: `${summary}\n${body}${errorSection}` }
  },

  requiresApproval: () => true, // ast-edit writes files — needs approval
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
