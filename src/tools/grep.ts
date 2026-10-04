import { execFile } from 'child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)
import { existsSync } from 'fs'
import { createReadStream } from 'fs'
import { lstat, readdir, realpath, readFile, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { getResolvedEnv } from './resolved-env.js'
import { createInterface } from 'readline'
import type { Dirent } from 'node:fs'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { relativePosix } from '../path-format.js'
import { truncateContent } from './truncation.js'
import { GitignoreFilter } from './gitignore.js'
import { validatePathSafe } from './path-validate.js'
import { searchReadableFilesWithRipgrep } from './grep-ripgrep.js'
import { summarizeGrepResult } from '../artifact/summarize.js'
import type { ArtifactStore } from '../artifact/store.js'
import { computeModelReadCap, type ModelReadCap } from './model-read-cap.js'
import { getToolArtifactThreshold } from './artifact-threshold.js'
import { debugLog } from '../utils/debug.js'
import { hashLine } from './hash-edit.js'
import { registerGrepFileAccess } from './read-file.js'
import { isRestrictedPath } from '../platform/restricted-paths.js'
import { isScanExcludedDir } from './scan-excludes.js'

const MAX_RESULTS_DEFAULT = 100
const TIMEOUT_MS = 30_000

/** Safe label for debug logs — pattern may be missing if tool JSON is malformed. */
function grepPatternLabel(pattern: unknown): string {
  if (typeof pattern === 'string') return pattern.slice(0, 40)
  if (pattern == null) return '(missing)'
  return String(pattern).slice(0, 40)
}

function parseGrepPattern(input: Record<string, unknown>): string | null {
  const raw = input.pattern
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** 空结果 sentinel——search-pod-hook 靠 includes(此串) 识别「可信排除」，
 *  改文案必须与 hook 同步（用常量共享，禁止两边各自手抄）。 */
export const GREP_EMPTY_RESULT = '未找到匹配。'

export const GREP_TOOL: Tool = {
  definition: {
    name: 'grep',
    description: `用正则或字面量模式搜索文件内容。

### 用法
- 用 grep 在源码中查找函数、类、模式或关键字
- 优先用本工具而不是 bash grep/rg——更快，且遵守 .gitignore
- 结果按文件分组并带行号
- pattern 可以是正则（默认）或字面量字符串
- 不知道确切字符串或符号、需要按概念搜索时，改用 semantic_search

### 示例
Good: grep(pattern="function handleSubmit", path="src/")
Good: grep(pattern="API_KEY", path=".", glob="*.{ts,tsx}")
Good: grep(pattern="class Foo", path="src/", context_lines=3)
Bad: grep(pattern="x") (too broad — will match too many lines)`,
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的正则或字面量模式' },
        path: { type: 'string', description: '要搜索的目录或文件（默认：cwd）' },
        glob: { type: 'string', description: '文件过滤，如 "*.ts" 或 "*.{ts,tsx}"' },
        max_results: { type: 'integer', description: '最大匹配行数（默认：100）' },
        literal: { type: 'boolean', description: '把 pattern 按字面量处理，不当正则（默认：false）' },
        context_lines: { type: 'integer', description: '每个匹配前后附带的上下文行数（默认：0）。设 2-3 可直接看到周边代码，省去单独的 read_file。' },
      },
      required: ['pattern'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const pattern = parseGrepPattern(params.input)
    if (pattern === null) {
      const keys = Object.keys(params.input).sort()
      const keySummary = keys.length > 0 ? keys.join(', ') : '(无)'
      const patternType = typeof params.input.pattern
      // Foreign keys (file_path, section, command, ...) are the fingerprint of
      // streaming argument pollution: a parallel tool_call's args got grafted
      // onto this grep call. Flag it so the root cause is visible at the tool
      // layer instead of a generic "pattern is required".
      const knownKeys = new Set(['pattern', 'path', 'glob', 'max_results', 'literal', 'context_lines'])
      const foreignKeys = keys.filter(k => !knownKeys.has(k))
      const pollutionHint = foreignKeys.length > 0
        ? ` Input 含有无关键（${foreignKeys.join(', ')}）——可能是流式 tool_call 参数污染，而非格式错误的 grep 调用。`
        : ''
      return {
        content: `错误：需要提供 pattern（非空字符串）。收到的 input keys：${keySummary}。pattern 类型：${patternType}。` +
          (keys.length === 0 ? ' Input 为空——参数可能在流式传输期间解析失败。' : '') +
          pollutionHint,
        isError: true,
      }
    }
    const searchPath = (params.input.path as string) ?? '.'
    const glob = params.input.glob as string | undefined
    const maxResults = (params.input.max_results as number) ?? MAX_RESULTS_DEFAULT
    const literal = (params.input.literal as boolean) ?? false
    const contextLines = (params.input.context_lines as number) ?? 0
    const modelCap = params.readCapOverride ?? computeModelReadCap({
      contextWindow: params.contextWindow,
      providerProfile: params.providerProfile,
    })

    const validated = validatePathSafe(params.cwd, searchPath)
    if (!validated.ok) {
      return { content: `错误：${validated.error}`, isError: true }
    }
    const absPath = validated.path

    const artifactThreshold = getToolArtifactThreshold('grep', params.contextWindow)

    // Try ripgrep first, fall back to native search
    const rgResult = await tryRipgrep(pattern, absPath, searchPath, glob, maxResults, params.cwd, literal, contextLines, modelCap, params.artifactStore, artifactThreshold, params.abortSignal, params.sessionId)
    if (rgResult !== null) return rgResult

    if (params.abortSignal?.aborted) return { content: 'grep 已取消。', isError: true }

    // Native fallback
    const regex = buildRegex(pattern, literal)
    if (!regex) {
      return { content: `错误：无效的模式：${pattern}`, isError: true, errorKind: 'syntax_error' }
    }

    try {
      const { results, timedOut } = await nativeSearch(absPath, regex, glob, maxResults, params.cwd, contextLines)
      // A partial result that reads like a complete one is worse than no result:
      // "no matches" would be taken as proof the string is absent.
      const TIMEOUT_NOTE = timedOut
        ? `[grep] 回退搜索在 ${TIMEOUT_MS / 1000}s 后超时，以下结果不完整——缩小 path 或改用更具体的 glob 重试。\n`
        : ''
      if (results.length === 0) {
        return { content: `[grep] 未找到 ripgrep (rg) 或其执行失败；已使用慢速回退。\n${TIMEOUT_NOTE}${timedOut ? '' : GREP_EMPTY_RESULT}` }
      }
      const FALLBACK_PREFIX = '[grep] 未找到 ripgrep (rg) 或其执行失败；已使用慢速回退。\n' + TIMEOUT_NOTE
      const text = results.length > maxResults
        ? FALLBACK_PREFIX + results.slice(0, maxResults).join('\n') + '\n...（已截断）'
        : FALLBACK_PREFIX + results.join('\n')
      let hintedText = appendLogRangeHints(text, searchPath)
      hintedText = await appendHashEditHints(hintedText, absPath, params.cwd, params.sessionId)
      await registerGrepFilesFromOutput(hintedText, params.cwd, params.sessionId)

      if (params.artifactStore) {
        if (hintedText.length < artifactThreshold) {
          debugLog(`[artifact-skip] tool=grep pattern=${grepPatternLabel(pattern)} raw=${hintedText.length} threshold=${artifactThreshold}`)
          return { content: truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars) }
        }
        debugLog(`[artifact-wrap] tool=grep pattern=${grepPatternLabel(pattern)} raw=${hintedText.length} threshold=${artifactThreshold}`)
        const { summary, sections } = summarizeGrepResult(hintedText, pattern)
        const artifactId = await params.artifactStore.save({
          tool: 'grep',
          target: searchPath,
          rawContent: hintedText,
          summary,
          sections,
        })
        const truncated = truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars)
        return {
          content: `${truncated}\n\n${summary}\n使用 read_section(artifactId="${artifactId}", section="L1-L500") 获取完整匹配列表。\n[artifact:${artifactId}]`,
        }
      }

      return { content: truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars) }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `错误：${message}`, isError: true }
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}

function buildRegex(pattern: string, literal: boolean): RegExp | null {
  try {
    const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern
    return new RegExp(source)
  } catch {
    return null
  }
}

function isLogLikeFilePath(path: string): boolean {
  return /\.(?:log|jsonl|ndjson|out|err|trace)(?:\.\d+)?$/i.test(path)
}

function appendLogRangeHints(content: string, searchPath: string): string {
  if (!isLogLikeFilePath(searchPath)) return content
  const hints: string[] = []
  for (const line of content.split('\n')) {
    const match = line.match(/:(\d+):/) ?? line.match(/^(\d+):/)
    if (!match?.[1]) continue
    const offset = Math.max(1, Number(match[1]) - 20)
    hints.push(`- read_file(file_path="${searchPath}", offset=${offset}, limit<=80)`)
    if (hints.length >= 5) break
  }
  if (hints.length === 0) return content
  return `${content}\n\n建议的下一步读取：\n${hints.join('\n')}`
}

/**
 * For single-file grep results, append hash_edit anchor hints so the model
 * can edit without a full read_file call: grep → hash_edit directly.
 *
 * Reads the file once, extracts hashes for matched line numbers, appends them.
 */
async function appendHashEditHints(content: string, absPath: string, cwd: string, sessionId?: string): Promise<string> {
  // Only add hints for single-file results (not directory-wide greps)
  let fileStat
  try {
    fileStat = await stat(absPath)
  } catch { return content }
  if (!fileStat.isFile()) return content

  registerGrepFileAccess(absPath, fileStat.mtimeMs, sessionId)

  const lineNumbers: number[] = []
  for (const line of content.split('\n')) {
    // rg output format: "42: line content" or ">  42│ content" (context mode)
    const m = line.match(/^>?\s*(\d+)[│:|]/) ?? line.match(/:(\d+):/)
    if (m?.[1]) {
      const num = parseInt(m[1], 10)
      if (num > 0 && !lineNumbers.includes(num)) lineNumbers.push(num)
    }
    if (lineNumbers.length >= 10) break
  }
  if (lineNumbers.length === 0) return content

  let fileLines: string[]
  try {
    const raw = await readFile(absPath, 'utf-8')
    fileLines = raw.split('\n')
  } catch { return content }

  const hints: string[] = []
  for (const num of lineNumbers) {
    if (num <= fileLines.length) {
      const h = hashLine(fileLines[num - 1]!)
      hints.push(`  L${num}:${h}`)
    }
  }
  if (hints.length === 0) return content

  const relPath = relativePosix(cwd, absPath)
  return `${content}\n\nhash_edit 锚点（${relPath}）：\n${hints.join('\n')}`
}

/**
 * Register file access from grep results for directory-wide greps.
 * Parses rg output lines to extract file paths, stats each, and registers
 * them in fileReadHistory so hash_edit can be used directly.
 */
async function registerGrepFilesFromOutput(content: string, cwd: string, sessionId?: string): Promise<void> {
  const seen = new Set<string>()
  for (const line of content.split('\n')) {
    // rg --no-heading format: "relative/path:linenum: content"
    const m = line.match(/^(.+?):(\d+):/)
    if (!m?.[1]) continue
    const relPath = m[1]
    if (seen.has(relPath)) continue
    seen.add(relPath)
    try {
      const absFilePath = resolve(cwd, relPath)
      const s = await stat(absFilePath)
      if (s.isFile()) {
        registerGrepFileAccess(absFilePath, s.mtimeMs, sessionId)
      }
    } catch { /* skip unresolvable paths */ }
    if (seen.size >= 20) break
  }
}

/**
 * 解析 rg 二进制路径，带架构探活。
 *
 * 优先级：RIVET_RIPGREP_PATH env（调试/覆盖）> 自带 rg（RIVET_BUNDLED_RIPGREP_DIR，
 * 桌面端打包时由 Rust 注入，架构与目标平台匹配）> 系统 PATH 的 'rg'。
 *
 * 关键：每个候选首次解析时跑一次 rg --version 探活。系统 rg 可能架构不符
 * （如 ARM64 rg 在 x64 机器上报 Exec format error）——此前这种情况被静默吞掉，
 * grep 降级到慢速遍历。现在探活失败会记录具体原因并尝试下一个候选，debugLog
 * 里能看到"Exec format error"而非笼统的"未找到"。
 *
 * 结果缓存到 rgResolvedPath，同进程内不重复探活。
 */
let rgResolvedPath: string | null | undefined
let rgResolveInFlight: Promise<string | null> | undefined

/** 清空 rg 解析缓存（测试用）——置回未解析态，下次调用重新探活。
 *  模块级缓存跨测试存活：顺序依赖的测试（如"rg 不可用"回退路径）必须在
 *  开头清缓存、结尾恢复，否则前面测试解析出的路径会污染断言（2026-08-25
 *  grep.test.ts slow-fallback 顺序依赖失败）。 */
export function resetRgResolvedPath(): void {
  rgResolvedPath = undefined
  rgResolveInFlight = undefined
}

/** 异步探活版 rg 解析——execFile 探 --version 不占事件循环。同步 execFileSync
 *  探活（5s 超时）是蜂群冷启动路径上的阻塞点：冷盘/杀毒扫描的 Windows 上
 *  单次即卡满超时窗（2026-08-24 /scout 卡死事故线）。结果仍进程级缓存
 *  （成功与失败都缓存）；并发首调共享同一 in-flight promise。 */
async function resolveRgPath(): Promise<string | null> {
  if (rgResolvedPath !== undefined) return rgResolvedPath
  if (rgResolveInFlight) return rgResolveInFlight
  rgResolveInFlight = (async () => {
    const ext = process.platform === 'win32' ? '.exe' : ''
    const candidates: { path: string; label: string }[] = []

    // 1. RIVET_RIPGREP_PATH（显式覆盖，不探活——用户说啥是啥）
    const override = process.env.RIVET_RIPGREP_PATH
    if (override) {
      rgResolvedPath = override
      return override
    }

    // 2. 自带 rg（RIVET_BUNDLED_RIPGREP_DIR，桌面端打包注入）
    const bundledDir = process.env.RIVET_BUNDLED_RIPGREP_DIR
    if (bundledDir) {
      const bundledRg = bundledDir + require('path').sep + 'rg' + ext
      if (existsSync(bundledRg)) candidates.push({ path: bundledRg, label: 'bundled' })
    }

    // 3. 系统 PATH 的 rg（裸 'rg'，spawn 时由 PATH 解析）
    candidates.push({ path: 'rg', label: 'system' })

    // 探活：跑 rg --version，第一个成功的即为结果。
    for (const c of candidates) {
      try {
        await execFileAsync(c.path, ['--version'], { timeout: 5_000, windowsHide: true })
        debugLog(`[grep] rg resolved: ${c.label} (${c.path})`)
        rgResolvedPath = c.path
        return c.path
      } catch (err) {
        debugLog(`[grep] rg candidate ${c.label} (${c.path}) failed probe: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    debugLog('[grep] no usable rg found after probing all candidates')
    rgResolvedPath = null
    return null
  })()
  try {
    return await rgResolveInFlight
  } finally {
    rgResolveInFlight = undefined
  }
}

async function tryRipgrep(
  pattern: string,
  absPath: string,
  searchPath: string,
  glob: string | undefined,
  maxResults: number,
  cwd: string,
  literal: boolean,
  contextLines: number,
  modelCap: ModelReadCap,
  artifactStore?: ArtifactStore,
  artifactThreshold: number = 0,
  abortSignal?: AbortSignal,
  sessionId?: string,
): Promise<ToolResult | null> {
  try {
    const binary = await resolveRgPath()
    if (!binary) return null
    const { lines, truncated } = await searchReadableFilesWithRipgrep({
      binary, cwd, path: absPath, pattern, glob, literal, contextLines,
      maxResults, timeoutMs: TIMEOUT_MS, signal: abortSignal,
    })
    if (lines.length === 0) return { content: GREP_EMPTY_RESULT }
    const text = lines.join('\n') + (truncated ? '\n...（已截断）' : '')
    let hintedText = appendLogRangeHints(text, searchPath)
    hintedText = await appendHashEditHints(hintedText, absPath, cwd, sessionId)
    await registerGrepFilesFromOutput(hintedText, cwd, sessionId)
    if (artifactStore && hintedText.length >= artifactThreshold) {
      const { summary, sections } = summarizeGrepResult(hintedText, pattern)
      try {
        const artifactId = await artifactStore.save({ tool: 'grep', target: absPath, rawContent: hintedText, summary, sections })
        const text = truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars)
        return { content: `${text}\n\n${summary}\n使用 read_section(artifactId="${artifactId}", section="L1-L500") 获取完整匹配列表。\n[artifact:${artifactId}]` }
      } catch { /* use the bounded inline result */ }
    }
    return { content: truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars) }
  } catch (error) {
    debugLog(`[grep] rg fallback: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

interface NativeSearchOutcome {
  results: string[]
  /** Hit the deadline — `results` is whatever the walk reached in time. */
  timedOut: boolean
}

async function nativeSearch(
  absPath: string,
  regex: RegExp,
  glob: string | undefined,
  maxResults: number,
  cwd: string,
  contextLines: number = 0,
): Promise<NativeSearchOutcome> {
  const filter = await GitignoreFilter.create(cwd)
  const globRegex = glob ? globToRegex(glob) : null
  const results: string[] = []
  const visited = new Set<string>()
  // Same budget ripgrep gets. Without one this walk is unbounded: it is only
  // reached when rg is missing or already timed out, i.e. exactly when the tree
  // is hostile.
  const deadline = Date.now() + TIMEOUT_MS
  let timedOut = false

  /** Deadline check that latches the flag, so the reason survives the unwind. */
  function outOfTime(): boolean {
    if (Date.now() < deadline) return false
    timedOut = true
    return true
  }

  async function walk(dir: string, isRoot: boolean): Promise<void> {
    if (results.length >= maxResults) return
    if (outOfTime()) return

    let real: string
    try {
      real = await realpath(dir)
    } catch {
      return
    }
    if (visited.has(real)) return
    visited.add(real)

    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      // Non-root + known restricted system path + permission error → silent skip.
      // Root or other errors → propagate (outer catch → isError:true).
      if (!isRoot && isRestrictedPath(String(e.path ?? e.message ?? ''), e.code ?? '')) return
      throw err
    }
    for (const entry of entries) {
      if (results.length >= maxResults) return
      if (outOfTime()) return
      // Prune before the lstat. Descending costs a readdir plus an lstat for
      // every entry below, and the per-file gitignore check further down cannot
      // refund any of it — it runs after the walk has already paid.
      if (entry.isDirectory() && isScanExcludedDir(entry.name)) continue
      const fullPath = join(dir, entry.name)
      const s = await lstat(fullPath).catch(() => null)
      if (!s || s.isSymbolicLink()) continue

      if (s.isDirectory()) {
        await walk(fullPath, false)
      } else if (s.isFile()) {
        const relPath = relativePosix(cwd, fullPath)
        if (filter.isIgnored(cwd, fullPath)) continue
        if (globRegex && !globRegex.test(entry.name)) continue

        if (!validatePathSafe(cwd, fullPath).ok) continue
        const matched = await searchFile(fullPath, regex, maxResults - results.length, contextLines)
        for (const line of matched) {
          results.push(`${relPath}:${line}`)
          if (results.length >= maxResults) return
        }
      }
    }
  }

  const s = await lstat(absPath).catch(() => null)
  if (s?.isFile()) {
    const relPath = relativePosix(cwd, absPath)
    const matched = await searchFile(absPath, regex, maxResults, contextLines)
    for (const line of matched) {
      results.push(`${relPath}:${line}`)
      if (results.length >= maxResults) return { results, timedOut }
    }
  } else {
    await walk(absPath, true)
  }

  return { results, timedOut }
}

async function searchFile(
  filePath: string,
  regex: RegExp,
  remaining = Number.POSITIVE_INFINITY,
  contextLines = 0,
): Promise<string[]> {
  const allLines: string[] = []
  const matchLineNums: number[] = []

  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  let lineNum = 0
  for await (const line of rl) {
    lineNum++
    allLines.push(line)
    if (regex.test(line)) {
      matchLineNums.push(lineNum - 1) // 0-based index into allLines
      if (matchLineNums.length >= remaining) break
    }
  }

  rl.close()
  stream.destroy()

  if (contextLines <= 0 || matchLineNums.length === 0) {
    // No context — original behavior
    return matchLineNums.map(idx => `${idx + 1}:  ${allLines[idx]}`)
  }

  // With context: collect expanded line ranges, deduplicate, format
  const included = new Set<number>()
  for (const idx of matchLineNums) {
    for (let c = Math.max(0, idx - contextLines); c <= Math.min(allLines.length - 1, idx + contextLines); c++) {
      included.add(c)
    }
  }

  const results: string[] = []
  let prevLineNum = -1
  for (const lineNum_ of [...included].sort((a, b) => a - b)) {
    if (prevLineNum !== -1 && lineNum_ > prevLineNum + 1) {
      results.push('  ...')
    }
    const marker = matchLineNums.includes(lineNum_) ? '>' : ' '
    results.push(`${marker}${String(lineNum_ + 1).padStart(4)}│ ${allLines[lineNum_]}`)
    prevLineNum = lineNum_
  }
  return results
}

function globToRegex(glob: string): RegExp {
  const braceMatch = glob.match(/^(.*)\{([^}]+)\}(.*)$/)
  let patterns: string[]
  if (braceMatch) {
    const [, prefix, group, suffix] = braceMatch
    const options = group!.split(',')
    patterns = options.map(o => prefix! + o + suffix!)
  } else {
    patterns = [glob]
  }

  const regexes = patterns.map(p =>
    p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.'),
  )
  return new RegExp(`^(${regexes.join('|')})$`)
}
