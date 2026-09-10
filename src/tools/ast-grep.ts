import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { resolve } from 'node:path'
import { cpuPool } from '../workers/cpu-pool.js'
import type { AstScanArgs, AstScanMatch, AstScanResult } from '../workers/cpu-tasks.js'
import { MAX_PARSE_FILE_BYTES, astScanSoftMs, astScanUnavailable, collectFiles, resolveRuleOrPattern } from './ast-shared.js'

export interface AstGrepInput {
  pattern: string
  paths?: string[]
  lang?: string
  limit?: number
  includeMeta?: boolean
}

/** 匹配结果的对外形状——直接复用 worker 通道回传的纯数据类型，两处共用一份
 *  定义，避免「工具认一种、worker 认另一种」的漂移。 */
export type AstGrepMatch = AstScanMatch

function formatMatch(m: AstGrepMatch, includeMeta: boolean): string {
  // Multi-line matches (e.g. a whole function) would dump the body into the
  // result line and bury the meta-vars at the end. Show only the first line of
  // the match + a line-count marker, so the meta-var shape summaries stay
  // visible on the same logical line the model scans.
  const raw = m.matchText
  const lines = raw.split('\n')
  const head = lines.length > 1 ? `${lines[0]!.slice(0, 70)} (+${lines.length - 1} 行)` : lines[0]!.slice(0, 80)
  const base = `${m.file}:${m.line}:${m.column}: ${head}`
  if (includeMeta && m.metaVariables && Object.keys(m.metaVariables).length > 0) {
    const mv = Object.entries(m.metaVariables).map(([k, v]) => `${k}=${v.slice(0, 40)}`).join(', ')
    return `${base}  [${mv}]`
  }
  return base
}

/** 空结果首行前缀——search-pod-hook 靠 startsWith 识别；改文案必须与 hook 同步。 */
export const AST_GREP_EMPTY_PREFIX = '0 处匹配'

/** 格式化匹配计数摘要行（空结果时以 AST_GREP_EMPTY_PREFIX 开头）。 */
export function formatAstGrepSummary(matchCount: number, filesScanned: number, errorCount: number): string {
  const errPart = errorCount > 0 ? `，${errorCount} 个错误` : ''
  return `${matchCount} 处匹配，扫描了 ${filesScanned} 个文件${errPart}`
}

export const AST_GREP_TOOL: Tool = {
  definition: {
    name: 'ast_grep',
    description:
      '按 AST 结构（而非文本）搜索代码。用 ast-grep 模式（如 `function $NAME($$$) { $$$ }`）匹配语法节点。返回 file:line:column 及匹配文本。支持 TypeScript/JavaScript/Tsx/Html/Css。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'ast-grep 模式（如 "function $NAME($$$) { $$$ }"）或 rule 对象' },
        paths: { type: 'array', items: { type: 'string' }, description: '要搜索的文件或目录' },
        lang: { type: 'string', description: '语言：TypeScript、Tsx、JavaScript、Html、Css' },
        limit: { type: 'integer', description: '最大匹配数（默认 50）' },
        includeMeta: { type: 'boolean', description: '是否附带元变量绑定' },
      },
      required: ['pattern'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const input = params.input as Record<string, unknown>
    const pattern = String(input.pattern ?? '').trim()
    if (!pattern) return { content: '错误：需要提供 pattern', isError: true }

    // pattern 形态判定：裸串与 `{ rule: … }` JSON 都合法。此处只需要
    // isRuleObject 决定 regex 误用护栏是否跳过对象内部字段；真正的匹配在
    // worker 内用同一判定（ast-shared.resolveRuleOrPattern）。
    const { isRuleObject } = resolveRuleOrPattern(pattern)
    // Regex-misuse guard: ast_grep uses ast-grep pattern syntax ($NAME, $$NAME),
    // not regular expressions. \d \w \1 etc. will not work as intended.
    if (!isRuleObject && /\\[dDwWsSbB1-9]/.test(pattern)) {
      return {
        content: `错误：pattern 含有正则 token（\\d、\\w、\\s、\\1 等）。\n\nast_grep 使用 ast-grep 语法，不是正则表达式。用 $NAME 捕获单节点，用 $$NAME 做省略（多节点）捕获。\n\n有问题的 pattern：${pattern.slice(0, 80)}`,
        isError: true,
      }
    }

    // path（单数）别名：schema 只声明 paths，但模型/worker 常写成单数。忽略它
    // 会静默退化为 ['.'] 全仓扫描——2026-09-10 卡死事故的直接触发条件。
    const paths = Array.isArray(input.paths)
      ? (input.paths as unknown[]).filter((p): p is string => typeof p === 'string')
      : typeof input.path === 'string' && input.path.trim()
        ? [input.path.trim()]
        : ['.']
    const explicitLang = typeof input.lang === 'string' && input.lang.trim() ? input.lang.trim() : undefined
    const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : 50
    const includeMeta = input.includeMeta === true

    const allFiles: string[] = []
    for (const p of paths) {
      const resolved = resolve(params.cwd ?? process.cwd(), p)
      try {
        allFiles.push(...await collectFiles(resolved))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { content: `错误：${message}`, isError: true }
      }
    }

    // 解析整段在 worker 线程执行（cpu-tasks.astScanRaw）：native parse 同步阻塞
    // 事件循环，留在主线程等于保留 2026-09-10 的假死形态。worker 不可用/超时
    // 一律报错降级，**不回退主线程**。
    const scanArgs: AstScanArgs = {
      files: allFiles,
      pattern,
      explicitLang,
      limit,
      includeMeta,
      maxBytes: MAX_PARSE_FILE_BYTES,
    }

    let scan: AstScanResult
    try {
      scan = await cpuPool.run('astScanRaw', [scanArgs], astScanSoftMs()) as AstScanResult
    } catch (err) {
      return {
        content: astScanUnavailable(err instanceof Error ? err.message : String(err)),
        isError: true,
      }
    }
    // napi 加载失败：原样回传 worker 侧诊断（不掩盖 cause），同样不回退主线程。
    if (scan.loadError) return { content: scan.loadError, isError: true }

    const summary = formatAstGrepSummary(scan.matches.length, scan.filesScanned, scan.errors.length)
    const body = scan.matches.map(m => formatMatch(m, includeMeta)).join('\n')
    const errorSection = scan.errors.length > 0 ? `\n\n错误：\n${scan.errors.map(e => `  - ${e}`).join('\n')}` : ''
    const skipSection = scan.skipped.length > 0 ? `\n\n跳过：\n${scan.skipped.map(s => `  - ${s}`).join('\n')}` : ''
    const degradeSection = scan.degraded.length > 0
      ? `\n\n解析降级（以下文件有 tree-sitter 错误恢复区，匹配可能不完整）：\n${scan.degraded.map(d => `  - ${d}`).join('\n')}`
      : ''

    return { content: `${summary}\n\n${body}${errorSection}${skipSection}${degradeSection}` }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
