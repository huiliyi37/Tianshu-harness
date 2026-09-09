import { extname } from 'path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { getResolvedEnv } from './resolved-env.js'
// web-tree-sitter 0.24.x: default import doubles as a namespace (Parser.SyntaxNode).
import type Parser from 'web-tree-sitter'

// esbuild ships a native binary, so it can't be inlined into the tsup bundle.
// It is loaded and executed exclusively inside the cpu-pool worker thread
// (`esbuildTransformRaw`, src/workers/cpu-tasks.ts) — the main thread never
// require()s it. Rationale (issue #61 族): on Windows with antivirus/EDR the
// first require of the native binary can block the event loop for minutes;
// the old "async load with 3s timeout" was ineffective because the require
// executed synchronously before the timeout wrapper — the edit_file call
// appeared to hang 5-10 minutes with the UI stuck on "thinking". The worker
// channel makes the soft timeout real: pool unavailable/timed out → degrade
// (skip the JS/TS parse check), never block the loop, never a false fatal.

import { cpuPool } from '../workers/cpu-pool.js'

/** esbuild 语法解析的调用通道。null = 池不可用/已熔断（降级跳过检查，绝不误回滚）。 */
type EsbuildTransform = (content: string, options: { loader: string; target: string; jsx: string }) => Promise<unknown>

// 熔断器（issue #61 族）：worker 调用连续基础设施失败（超时/被杀/不可用）达到
// 阈值 = 本进程环境病理（典型：Windows AV/EDR 把 esbuild 原生二进制的加载卡到
// 分钟级）。熔断后剩余进程期跳过 TS/JS 解析检查——否则每次写都交一次软超时税。
// 任何一次成功调用即复位计数；解析错误（语法本身）是业务信号，不计入。
let esbuildInfraFailures = 0
let esbuildBreakerTripped = false
const ESBUILD_BREAKER_THRESHOLD = 2

function isEsbuildInfraError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /timed out|terminated|unavailable/i.test(msg)
}

function getEsbuildCallTimeoutMs(): number {
  // RIVET_ESBUILD_LOAD_TIMEOUT 保留为整次调用（含 worker 内加载）的软超时覆盖。
  const v = Number.parseInt(process.env.RIVET_ESBUILD_LOAD_TIMEOUT ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : TRANSFORM_TIMEOUT_MS + 2000
}

function getEsbuildTransform(): EsbuildTransform | null {
  if (esbuildBreakerTripped || !cpuPool.available) return null
  return async (content, options) => {
    try {
      await cpuPool.run('esbuildTransformRaw', [content, options], getEsbuildCallTimeoutMs())
      esbuildInfraFailures = 0
    } catch (err) {
      if (isEsbuildInfraError(err)) {
        esbuildInfraFailures++
        if (esbuildInfraFailures >= ESBUILD_BREAKER_THRESHOLD) esbuildBreakerTripped = true
      }
      throw err
    }
  }
}

/** Test-only: clear the esbuild circuit-breaker state so each test starts clean. */
export function _resetEsbuildCacheForTest(): void {
  esbuildInfraFailures = 0
  esbuildBreakerTripped = false
}

/** Files larger than this skip CSS/HTML/JSON branch checks (O(n) scans). */
const SYNC_SCAN_SIZE_LIMIT = 2 * 1024 * 1024 // 2 MB

/** Files larger than this skip external-parser checks (Python AST, esbuild). */
const EXTERNAL_PARSE_SIZE_LIMIT = 8 * 1024 * 1024 // 8 MB

/** Timeout for esbuild async transform — prevents a hung worker from blocking
 *  the tool call indefinitely (file is already written; losing syntax-check is
 *  a degradation, not a failure). */
const TRANSFORM_TIMEOUT_MS = 5000

/** Timeout for the tree-sitter Python parse (load + parse). Parsing is in-process
 *  and normally sub-millisecond, but the first wasm load can be slow on some
 *  environments; a short cap keeps a stuck load from stalling the turn (degrades
 *  to OK, never a false fatal). Override with RIVET_TS_PARSE_TIMEOUT (ms); set to
 *  0/negative to fall back to the 5s default. */
function getTsParseTimeoutMs(): number {
  const v = Number.parseInt(process.env.RIVET_TS_PARSE_TIMEOUT ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 5000
}

// ── TypeScript compiler (lazy, ground truth for esbuild false-positive filtering) ──
//
// esbuild's TypeScript parser is stricter than tsc: it rejects legal TS patterns
// like fullwidth parens（／）in JSDoc, certain Unicode positions, and complex
// generics nesting that tsc accepts. When esbuild reports a parse error we run a
// second opinion through the TypeScript compiler API. If TS accepts the file,
// esbuild's error is downgraded to a warning (no rollback). Only when both
// esbuild AND TS reject the file do we treat it as a fatal syntax error.
//
// We use `createSourceFile()` — a pure-syntax parse, ~10-50ms — not `tsc
// --noEmit` which requires tsconfig resolution, type-checking and project-wide
// analysis (~2s). The TS module is kept `external` in tsup (like esbuild) and
// loaded lazily via createRequire so the packaged sidecar without a local
// typescript install degrades to the tsc subprocess fallback.
//
// Timeout: RIVET_TS_LOAD_TIMEOUT (ms); set to 0/negative to fall back to 3s.

let _tsPromise: Promise<any | null> | undefined
let _tsModule: any | undefined

async function loadTsModule(): Promise<any | null> {
  try {
    const req = createRequire(import.meta.url)
    return req('typescript')
  } catch {
    return null
  }
}

async function getTypeScript(): Promise<any | null> {
  if (_tsModule !== undefined) return _tsModule
  if (_tsPromise) {
    _tsModule = await _tsPromise
    return _tsModule
  }
  _tsPromise = withTimeout(
    loadTsModule(),
    'TypeScript load',
    getTsLoadTimeoutMs(),
  ).catch(() => null)
  _tsModule = await _tsPromise
  return _tsModule
}

function getTsLoadTimeoutMs(): number {
  const v = Number.parseInt(process.env.RIVET_TS_LOAD_TIMEOUT ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 3000
}

/** Test-only: clear the TypeScript load cache. */
export function _resetTsCacheForTest(): void {
  _tsPromise = undefined
  _tsModule = undefined
}

interface TsSecondOpinionResult {
  /** true if TS accepted the file (esbuild false positive). */
  passed: boolean
  /** Parse error messages when TS also rejects the file. */
  errors?: string[]
  /** True when TS module AND tsc subprocess are both unavailable. */
  unavailable?: boolean
}

/** Run TypeScript compiler API as ground-truth second opinion.
 *  Returns {passed:true} when TS parser accepts the file → esbuild false positive.
 *  Returns {passed:false, errors} when TS also reports errors → real syntax error.
 *  Returns {unavailable:true} when TS module is absent → caller should try tsc fallback. */
async function tsSecondOpinion(
  filePath: string,
  content: string,
  ext: string,
): Promise<TsSecondOpinionResult> {
  const ts = await getTypeScript()
  if (!ts || !ts.createSourceFile) return { passed: false, unavailable: true }

  try {
    const scriptKindMap: Record<string, number> = {
      '.ts': ts.ScriptKind?.TS ?? 3,
      '.tsx': ts.ScriptKind?.TSX ?? 4,
      '.js': ts.ScriptKind?.JS ?? 1,
      '.jsx': ts.ScriptKind?.JSX ?? 2,
      '.mjs': ts.ScriptKind?.JS ?? 1,
      '.cjs': ts.ScriptKind?.JS ?? 1,
    }
    const scriptKind = scriptKindMap[ext] ?? scriptKindMap['.ts']!

    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget?.Latest ?? 99, // ES2024+
      /* setParentNodes */ true,
      scriptKind,
    )

    // parseDiagnostics contains only syntax/parse errors, not type errors
    const diagnostics: any[] = sourceFile.parseDiagnostics ?? []
    const errorCategory = ts.DiagnosticCategory?.Error ?? 1
    const syntaxErrors = diagnostics.filter((d: any) => d.category === errorCategory)

    if (syntaxErrors.length === 0) {
      return { passed: true }
    }

    const errorMessages = syntaxErrors.slice(0, 5).map((d: any) => {
      const pos = d.file?.getLineAndCharacterOfPosition?.(d.start ?? 0) ??
        sourceFile.getLineAndCharacterOfPosition(d.start ?? 0)
      const msg = typeof ts.flattenDiagnosticMessageText === 'function'
        ? ts.flattenDiagnosticMessageText(d.messageText, '\n')
        : String(d.messageText)
      return `  ${filePath}:${pos.line + 1}:${pos.character + 1} - ${msg}`
    })

    return { passed: false, errors: errorMessages }
  } catch {
    // TS API threw unexpectedly — treat as unavailable, fall through to tsc
    return { passed: false, unavailable: true }
  }
}

/** Timeout for tsc subprocess (used only as fallback when TS module is unavailable). */
function getTscFallbackTimeoutMs(): number {
  const v = Number.parseInt(process.env.RIVET_TSC_FALLBACK_TIMEOUT ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 8000
}

/** Run `tsc --noEmit` on the written file as a last-resort syntax check.
 *  Only invoked when the TypeScript compiler API module is unavailable.
 *  Returns 'pass' (tsc accepts → esbuild false positive), 'fail' (tsc rejects →
 *  real error), or 'degraded' (tsc unavailable/timeout → defer to esbuild). */
function tscSubprocessCheck(filePath: string): Promise<'pass' | 'fail' | 'degraded'> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('npx', ['tsc', '--noEmit', '--pretty', 'false', '--skipLibCheck', filePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: getResolvedEnv(),
        windowsHide: true,
        timeout: getTscFallbackTimeoutMs(),
      })
    } catch {
      resolve('degraded')
      return
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
      resolve('degraded')
    }, getTscFallbackTimeoutMs())

    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve('pass')
      } else {
        resolve('fail')
      }
    })

    child.on('error', () => {
      clearTimeout(timer)
      resolve('degraded')
    })
  })
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

export interface SyntaxCheckResult {
  /** Non-fatal lint/style warning to display to the model. */
  warning: string | null
  /** Fatal parse/integrity error. If set, the caller should roll back the write. */
  fatal: string | null
}

const OK: SyntaxCheckResult = { warning: null, fatal: null }

/**
 * Language-agnostic syntax and structural integrity check for written files.
 *
 * Runs after write in edit_file / write_file / hash_edit.
 * Catches syntax errors (missing bracket, broken JSX, unbalanced braces,
 * truncated JSON, unclosed HTML tags) in ~2ms per file and embeds the
 * warning directly into the ToolResult — so the model sees the error
 * immediately instead of discovering it 2–3 turns later.
 *
 * Supported: .ts .tsx .js .jsx (esbuild parser, async), .py (Python AST),
 * .css (brace balance), .html (tag balance), .json (JSON.parse).
 *
 * Returns null if clean or unsupported extension.
 * Returns a warning string if an integrity issue is detected.
 */
export async function syntaxCheck(filePath: string, content: string): Promise<string | null> {
  const result = await checkSyntax(filePath, content)
  return result.warning
}

/**
 * Strict syntax check that distinguishes fatal parse errors from warnings.
 * Fatal errors indicate the file is corrupted or unparseable and should be
 * rolled back by the caller.
 */
export async function checkSyntax(filePath: string, content: string): Promise<SyntaxCheckResult> {
  const ext = extname(filePath)

  // ── TypeScript/JavaScript via esbuild (cpu-pool worker 通道) ──
  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
    if (content.length > EXTERNAL_PARSE_SIZE_LIMIT) return OK
    const loaderMap: Record<string, 'ts' | 'tsx' | 'js' | 'jsx'> = {
      '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js',
    }
    const loader = loaderMap[ext] ?? 'js'
    const transform = getEsbuildTransform()
    if (!transform) return OK
    try {
      await transform(content, { loader, target: 'esnext', jsx: 'automatic' })
      return OK
    } catch (err) {
      // 基础设施失败（worker 超时/被杀/esbuild 缺失）与旧 !esbuild 同语义：
      // 降级跳过解析检查——绝不把环境问题伪装成语法错误回滚好文件。
      if (isEsbuildInfraError(err)) return OK
      if (!(err instanceof Error)) return OK
      const lines = err.message.split('\n')
      const errorLines = lines.filter(l => /ERROR:|error:/i.test(l))
      const detail = errorLines.length > 0
        ? errorLines.join('\n')
        : lines.slice(1).join('\n')
      const cleaned = detail.replace(/<stdin>:/g, '')

      // Second opinion: TypeScript compiler (ground truth for TS/JS syntax).
      // esbuild's parser is stricter than tsc — it rejects legal TS patterns
      // (fullwidth parens in JSDoc, certain Unicode positions, complex generics).
      // When esbuild and TS disagree, trust TS and downgrade to warning.
      const second = await tsSecondOpinion(filePath, content, ext)

      if (second.passed) {
        // TS accepted the file → esbuild false positive. Warn but don't roll back.
        const msg = `⚠️ 语法检查提示（低风险）：\n${cleaned}\n\n经二次确认，此文件语法正确，文件已保留未回滚。`
        return { warning: msg, fatal: null }
      }

      if (second.unavailable) {
        // TS module not available → try tsc subprocess as last resort
        const tscResult = await tscSubprocessCheck(filePath)
        if (tscResult === 'pass') {
          const msg = `⚠️ 语法检查提示（低风险）：\n${cleaned}\n\n经 tsc 二次确认，此文件语法正确，文件已保留未回滚。`
          return { warning: msg, fatal: null }
        }
        if (tscResult === 'degraded') {
          // Neither TS API nor tsc available — infrastructure failure must NOT
          // masquerade as fatal syntax error. Warn but don't roll back.
          const msg = `⚠️ 语法检查提示：\n${cleaned}\n\n语法验证工具暂时不可用，文件已保留未回滚。建议运行 typecheck 命令手动验证。`
          return { warning: msg, fatal: null }
        }
        // tsc also failed → real error, roll back
      }

      // Both esbuild AND TS/tsc agree — real syntax error. Roll back.
      const tsErrors = second.errors?.length
        ? `\n\n具体错误：\n${second.errors.join('\n')}`
        : ''
      const message = `⚠️ 语法检查发现错误：\n${cleaned}${tsErrors}\n\n文件已写入但存在语法问题，运行时将失败。`
      return { warning: message, fatal: message }
    }
  }

  // ── Python: in-process tree-sitter parse ──
  // 进程内 WASM 解析（无子进程 → 无跨进程编码问题，surrogate 不再触发误报；
  // 不依赖系统 python；~毫秒级）。tree-sitter 是容错解析器，对缩进错误/空 body
  // 等边界比 CPython ast.parse 宽松（可能漏报），对"写完即时结构校验"足够。
  if (ext === '.py') {
    if (content.length > EXTERNAL_PARSE_SIZE_LIMIT) return OK
    const result = await checkPythonSyntaxTreeSitter(content)
    if (result.error) {
      const message = `⚠️ Python 语法错误${result.line ? `（第 ${result.line} 行）` : ''}：${result.error}\n\n文件已写入但存在语法问题，运行时将失败。`
      return { warning: message, fatal: message }
    }
    return OK
  }

  // ── CSS: brace balance check (skip if >2MB) ──
  if (ext === '.css') {
    if (content.length > SYNC_SCAN_SIZE_LIMIT) return OK
    let depth = 0
    let inString = false
    let stringChar = ''
    let inComment = false
    for (let i = 0; i < content.length; i++) {
      const c = content[i]
      const prev = content[i - 1] ?? ''
      if (inComment) {
        if (c === '/' && prev === '*') inComment = false
        continue
      }
      if (c === '/' && content[i + 1] === '*') { inComment = true; i++; continue }
      if (inString) {
        if (c === stringChar && prev !== '\\') inString = false
        continue
      }
      if (c === '"' || c === "'") { inString = true; stringChar = c; continue }
      if (c === '{') depth++
      if (c === '}') depth--
      if (depth < 0) {
        const msg = `⚠️ CSS brace mismatch: unmatched '}' at position ${i}. Remove the extra closing brace.`
        return { warning: msg, fatal: msg }
      }
    }
    if (depth > 0) {
      const msg = `⚠️ CSS brace mismatch: ${depth} unmatched '{' (missing closing '}'). Check for unclosed blocks like @media or rule sets.`
      return { warning: msg, fatal: msg }
    }
    return OK
  }

  // ── HTML: basic tag balance (skip if >2MB) ──
  if (ext === '.html' || ext === '.htm') {
    if (content.length > SYNC_SCAN_SIZE_LIMIT) return OK
    const voids = new Set([
      'area','base','br','col','embed','hr','img','input','link','meta',
      'param','source','track','wbr',
    ])
    const openTagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*\/?>/g
    const stack: { tag: string; pos: number }[] = []
    let match
    while ((match = openTagRe.exec(content)) !== null) {
      const full = match[0]
      const tag = match[1]!.toLowerCase()
      const isClose = full.startsWith('</')
      const isSelfClose = full.endsWith('/>')
      if (isSelfClose || voids.has(tag)) continue
      if (isClose) {
        if (stack.length === 0 || stack[stack.length - 1]!.tag !== tag) {
          const expected = stack.length > 0 ? stack[stack.length - 1]!.tag : 'nothing'
          const msg = `⚠️ HTML tag mismatch: unexpected </${tag}> at position ${match.index} (expected </${expected}>)`
          return { warning: msg, fatal: msg }
        }
        stack.pop()
      } else {
        stack.push({ tag, pos: match.index })
      }
    }
    if (stack.length > 0) {
      const unclosed = stack.map(s => `<${s.tag}>`).join(', ')
      const msg = `⚠️ HTML tag mismatch: ${stack.length} unclosed tag(s): ${unclosed}. Add the missing closing tags.`
      return { warning: msg, fatal: msg }
    }
    return OK
  }

  // ── JSON: parse check (skip if >2MB) ──
  if (ext === '.json') {
    if (content.length > SYNC_SCAN_SIZE_LIMIT) return OK
    try {
      JSON.parse(content)
      return OK
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const message = `⚠️ Invalid JSON: ${msg}`
      return { warning: message, fatal: message }
    }
  }

  return OK
}

export interface PythonSyntaxResult {
  /** null = clean parse OR infrastructure degrade (never a false fatal). */
  error: string | null
  /** 1-based line of the first ERROR/MISSING node, when available. */
  line?: number
}

// ── tree-sitter Python parser (lazy, in-process WASM) ──
//
// Replaces the former `spawn python3 -c "ast.parse(stdin)"` path. That path
// had three structural weaknesses this eliminates: (1) cross-process encoding —
// lone surrogates (\udc80, GBK→UTF-8 residue on Windows) crashed the child with
// UnicodeEncodeError and were misreported as a syntax error → rollback; (2) a
// hard dependency on a system python interpreter; (3) per-check process fork
// cost. web-tree-sitter is pure WASM (already used by meridian-parser and listed
// in tsup externals), so it degrades consistently across platforms.
//
// Reuses meridian-parser's proven load pattern (TreeSitter.init + Language.load
// via require.resolve) but keeps its own cache to avoid coupling to the indexer
// (parseFile returns heavyweight symbol/edge results + a 250-parse reset).

let _tsPyPromise: Promise<Parser | null> | undefined

// web-tree-sitter 在 WASM 线性内存里分配 parser scratch，长期复用同一实例会让
// 内存单调增长（JS GC 管不到 WASM 堆）。meridian-parser 用同样的计数阈值周期性
// 重建 parser；此处照抄该阈值，独立计数。
const MAX_PARSES_BEFORE_RESET = 250
let _tsPyParseCount = 0

async function loadPythonParser(): Promise<Parser | null> {
  try {
    const TreeSitter = (await import('web-tree-sitter')).default
    await TreeSitter.init()
    const parser = new TreeSitter()
    const req = createRequire(import.meta.url)
    const wasmPath = req.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm')
    const language = await TreeSitter.Language.load(wasmPath)
    parser.setLanguage(language)
    return parser
  } catch {
    return null // load failure → degrade (never a false fatal)
  }
}

async function getPythonParser(): Promise<Parser | null> {
  if (_tsPyParseCount >= MAX_PARSES_BEFORE_RESET) {
    _tsPyPromise = undefined
    _tsPyParseCount = 0
  }
  if (_tsPyPromise) return _tsPyPromise
  _tsPyPromise = withTimeout(loadPythonParser(), 'tree-sitter python load', getTsParseTimeoutMs())
    .catch(() => null)
  return _tsPyPromise
}

/** Test-only: clear the tree-sitter python parser cache. */
export function _resetPythonParserForTest(): void {
  _tsPyPromise = undefined
  _tsPyParseCount = 0
}

/** Test-only: parses since the last parser rebuild (for the reset-cadence test). */
export function _pythonParseCountForTest(): number {
  return _tsPyParseCount
}

/** Depth-first search for the first ERROR or MISSING node (the syntax error
 *  location). Returns its 1-based line, or undefined if none found. */
function firstErrorLine(node: Parser.SyntaxNode): number | undefined {
  if (node.type === 'ERROR' || node.isMissing) return node.startPosition.row + 1
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    const line = firstErrorLine(child)
    if (line !== undefined) return line
  }
  return undefined
}

/**
 * Check Python syntax in-process via tree-sitter. Returns {error:null} on a
 * clean parse OR on any infrastructure failure (parser load failed, parse threw)
 * — those must NEVER masquerade as a fatal syntax error, since the caller rolls
 * back the write on a non-null error. Only a genuine parse tree with error nodes
 * is reported as an error.
 */
export async function checkPythonSyntaxTreeSitter(content: string): Promise<PythonSyntaxResult> {
  const parser = await getPythonParser()
  if (!parser) return { error: null } // degrade
  // Tree lives in WASM memory and is not reclaimed by the JS GC — it must be
  // deleted on every path, including the error path (same as meridian-parser).
  let tree: Parser.Tree | undefined
  try {
    tree = parser.parse(content)
    _tsPyParseCount++
    if (!tree.rootNode.hasError) return { error: null }
    const line = firstErrorLine(tree.rootNode)
    return { error: '存在无法解析的语法结构（括号/引号未闭合、意外符号等）。', line }
  } catch {
    return { error: null } // parse threw → degrade
  } finally {
    tree?.delete()
  }
}

