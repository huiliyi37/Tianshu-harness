import type { DelegationSnapshot } from './delegation-state.js'
// @ts-ignore Native development workers load TypeScript directly.
import { TailAccumulator } from './events-tail.ts'
/**
 * CPU-bound pure functions offloaded to a worker_threads pool.
 *
 * These are the single source of truth for diff computation — shared between
 * the worker thread (4s timeout) and the main-thread inline fallback (1s
 * timeout). The jsdiff functions are synchronous and O((N+M)·D); running them
 * in a worker keeps the TUI event loop alive during heavy rewrites.
 *
 * No side effects, no process/env — safe to run in any context.
 */

import { createTwoFilesPatch, structuredPatch, diffLines } from 'diff'

// ── Unified diff (for `buildFileDiff`) ──

export function diffUnifiedRaw(
  relPath: string,
  before: string,
  after: string,
  timeout: number,
): string | undefined {
  return createTwoFilesPatch(relPath, relPath, before, after, '', '', {
    context: 3,
    timeout,
  })
}

// ── Structured patch hunks (for `computeChangedLineRanges`) ──

export interface RawHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export function diffStructuredRaw(
  before: string,
  after: string,
  timeout: number,
): { hunks: RawHunk[] } | undefined {
  const patch = structuredPatch('a', 'a', before, after, '', '', {
    context: 0,
    timeout,
  })
  if (!patch) return undefined
  return { hunks: patch.hunks as RawHunk[] }
}

// ── Line-level diff (for `getDiffStats`) ──

export interface RawChange {
  added?: boolean
  removed?: boolean
  count?: number
}

export function diffLinesRaw(
  oldContent: string,
  newContent: string,
  timeout: number,
): RawChange[] | undefined {
  return diffLines(oldContent, newContent, { timeout }) as RawChange[] | undefined
}

// ── Session event-log parsing (reconnect replay) ──

/** Minimal structural shape of a persisted session event. Kept local so this
 *  module stays dependency-free (worker bundles it standalone). */
export interface RawSessionEvent {
  seq: number
  ts: number
  type: string
  data: Record<string, unknown>
}

/**
 * Parse an events.jsonl text into sorted events, dropping corrupt/partial
 * lines (crash mid-write). Single source of truth shared by the sync read
 * path and the worker-offloaded reconnect replay — JSON.parse over a large
 * log is exactly the kind of synchronous stretch that starves the sidecar
 * event loop (SSE pings included), so replays run it off-thread.
 */
/** 尾部读的回传形状——`events` 已按内存环容量截断，其余字段是「被截掉的头部
 *  里仍然需要的那点信息」，避免调用方为了拿它们而要求全量。 */
export interface RawEventsTail {
  delegationState?: DelegationSnapshot
  pendingQueueLaneIds?: string[]
  /** 尾部 maxEvents 条（日志更短时即全部）。 */
  events: RawSessionEvent[]
  /** 磁盘日志最早 seq（空日志为 0）——前端据此判断头部是否被截。 */
  diskFirstSeq: number
  /** 磁盘日志最大 seq（空日志为 0）。 */
  lastSeq: number
  /** 全量日志里出现过的 artifact id——去重集必须完整，否则被截头部的
   *  artifact 会在重放时被重新公告。 */
  artifactIds: string[]
  /** 全量事件数（0 用于区分空日志与「有日志但全是坏行」）。 */
  total: number
}

/**
 * 与 parseEventsJsonlRaw 同源，但只回传内存环留得下的尾部。
 *
 * parse 本身在 worker 里做多少都不占主线程，真正的开销是把结果搬过线程边界：
 * structured clone 的成本与条数成正比（实测 43,717 条 139ms / 5,000 条 14ms）。
 * 调用方拿到全量后立刻丢掉 90%，那份搬运是纯浪费——所以截断挪到这一侧做。
 */
export function parseEventsTailRaw(text: string, maxEvents: number, maxEventBytes?: number): RawEventsTail {
  const tail = new TailAccumulator(maxEvents, maxEventBytes)
  for (const line of text.split('\n')) tail.addLine(line)
  return tail.finish()
}

export function parseEventsJsonlRaw(text: string): RawSessionEvent[] {
  const events: RawSessionEvent[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as RawSessionEvent
      if (parsed && typeof parsed.seq === 'number' && typeof parsed.type === 'string') {
        events.push(parsed)
      }
    } catch {
      // corrupt/partial line (e.g. crash mid-write) — drop it, keep the rest
    }
  }
  events.sort((a, b) => a.seq - b.seq)
  return events
}

// ── esbuild 语法解析（写工具 syntax-check 的 worker 通道）──
// 主线程永不 require esbuild（issue #61 族：Windows AV/EDR 下首次加载原生
// 二进制可阻塞事件循环数分钟——worker 线程内阻塞只影响本任务，主线程的
// 软超时照常生效并降级）。与上面纯函数不同：本任务带模块级缓存的副作用。
import { createRequire } from 'node:module'
import type { ChildProcess } from 'node:child_process'
const _require = createRequire(import.meta.url)

interface EsbuildLike {
  transform(content: string, options: unknown): Promise<unknown>
  stop?(): Promise<void> | void
}
let _esbuild: EsbuildLike | null | undefined
/** 本 worker 里 esbuild 拉起、尚未被回收的 service 子进程（issue #315）。 */
const _esbuildChildren = new Set<ChildProcess>()

/** esbuild 的语法/解析失败（TransformFailure）带结构化 errors 数组（Message[]，
 *  每条含 text + location）；基础设施故障（平台二进制包缺失、service 起不来）
 *  只抛普通 Error，没有 errors 字段。分类必须在**错误产生点**完成：跨到主线程
 *  之后只剩 message 字符串，只能拿正则猜——issue #366 的用户可见泄漏正是这条
 *  猜法漏了 "could not be found"（Windows 包缺 @esbuild/win32-x64）。 */
export function isEsbuildSyntaxFailure(err: unknown): boolean {
  const errors = (err as { errors?: unknown } | null | undefined)?.errors
  return Array.isArray(errors) && errors.length > 0
}

/** worker 内部的「基础设施故障」标记，经 cpu-worker 透传为消息字段 `infra`。 */
export const ESBUILD_INFRA_FLAG = '__esbuildInfra'

export function esbuildInfraError(cause: unknown): Error {
  const e = new Error(cause instanceof Error ? cause.message : String(cause))
  ;(e as Error & Record<string, unknown>)[ESBUILD_INFRA_FLAG] = true
  return e
}

export async function esbuildTransformRaw(content: string, options: unknown): Promise<true> {
  if (_esbuild === undefined) {
    try {
      const req = createRequire(import.meta.url)
      _esbuild = req('esbuild') as EsbuildLike
    } catch {
      _esbuild = null
    }
  }
  if (!_esbuild) throw esbuildInfraError('esbuild unavailable in worker')
  // esbuild 在 transform() 的同步段里懒启动 `esbuild --service` 子进程，且不暴露句柄。
  // 子进程只能由拉起它的线程回收（libuv 按 loop 各自 waitpid）：worker 被 terminate
  // 后它退出了也没人收尸 → 永久 <defunct>，每次空闲回收 +1（issue #315）。这里只在
  // 同步段内临时包一层 spawn 记下句柄，供 esbuildStopRaw 等它真正退出。
  const cp = _require('node:child_process') as typeof import('node:child_process')
  const origSpawn = cp.spawn
  cp.spawn = ((...args: Parameters<typeof origSpawn>) => {
    const child = origSpawn(...args)
    _esbuildChildren.add(child)
    child.once('exit', () => { _esbuildChildren.delete(child) })
    return child
  }) as typeof origSpawn
  let pending: Promise<unknown>
  try {
    pending = _esbuild.transform(content, options)
  } finally {
    cp.spawn = origSpawn
  }
  try {
    await pending
  } catch (err) {
    // 语法失败原样上抛（主线程 tsSecondOpinion 复核后可能判为误报）；其余一律
    // 标记为基础设施故障——它们不是「文件有问题」，是「工具链有问题」，
    // 绝不参与「语法检查提示」的渲染与回滚决策。
    if (isEsbuildSyntaxFailure(err)) throw err
    throw esbuildInfraError(err)
  }
  return true
}

/**
 * 停掉 esbuild service 并等它的子进程被本线程回收（'exit' 事件在 waitpid 之后才发）。
 * cpu-pool 空闲回收 worker 前调用；超时兜底，不让回收流程卡住。
 */
export async function esbuildStopRaw(graceMs = 1000): Promise<number> {
  const children = [..._esbuildChildren]
  if (children.length === 0) return 0
  const exited = children.map(c => new Promise<void>(resolve => {
    if (c.exitCode !== null || c.signalCode !== null) resolve()
    else c.once('exit', () => resolve())
  }))
  try { await _esbuild?.stop?.() } catch { /* 已停 */ }
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.all(exited),
    new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs) }),
  ])
  if (timer) clearTimeout(timer)
  return children.length
}

// ── AST 扫描（ast_grep 的 worker 通道）──
// 2026-09-10 卡死事故的结构性根修：`napi.parse` 是同步 native 调用，在主线程执行
// 时任何超长解析都会占满事件循环（事故现场 88% CPU / 4 小时假死，SIGTERM 都进不去，
// 必须 SIGKILL）。把「读文件 + 准入判定 + parse + findAll + 纯数据提取」整段搬进
// worker 线程——`SgNode`/`SgRoot` 是 native 对象不能跨线程，所以所有 AST 操作必须
// 在本函数内做完，只回传纯数据。
//
// 与上面纯函数的差别（同 esbuildTransformRaw）：本段读 fs、读 env、加载 native 模块。
//
// 局限（诚实标注）：worker_threads 共享进程地址空间，AST 内存爆炸仍会拖垮整个进程
// （真正的内存隔离需 child_process，列 v2）；`terminate()` 对卡在 native 调用的线程
// 可能不生效——该线程泄漏，但主线程保持可用，TUI 不再假死。
import { readFileSync } from 'node:fs'
// @ts-ignore — 同上（显式 .ts：本模块经 cpu-worker 进入 worker 线程）
import { detectEol } from '../tools/line-endings.ts'
// @ts-ignore — 显式 .ts 扩展名：worker 线程用 Node 原生 type stripping 加载，
// 它不做 .js→.ts 映射（tsx 在 worker 线程内不生效，实测 --import tsx 被忽略）。
import { loadAstGrepNapi } from '../tools/ast-grep-napi.ts'
// @ts-ignore — 同上。单行 import 是必须的：@ts-ignore 只作用于下一条语句的
// 起始行，多行 import 的诊断报在末行（`} from '…'`），抑制不住。
import { buildLangMap, collectMetaVarNames, ensureDynamicLangsRegistered, isDynamicLang, parseSkipReason, resolveLang, resolveRuleOrPattern } from '../tools/ast-shared.ts'

export interface AstScanArgs {
  files: string[]
  /** 原始 pattern 串（裸串或 `{ rule: … }` JSON）——形态判定在 worker 内做，
   *  与工具侧的 regex 误用护栏共用 ast-shared.resolveRuleOrPattern。 */
  pattern: string
  explicitLang?: string
  limit: number
  includeMeta: boolean
  /** 准入护栏阈值（字节）——与主线程同一判定，超限文件只跳过不解析。 */
  maxBytes: number
}

export interface AstScanMatch {
  file: string
  line: number
  column: number
  matchText: string
  metaVariables?: Record<string, string>
}

export interface AstScanResult {
  matches: AstScanMatch[]
  filesScanned: number
  errors: string[]
  skipped: string[]
  degraded: string[]
  /** @ast-grep/napi 加载失败时的原始诊断——工具侧原样回传，不掩盖 cause
   *  （见 ast-grep-napi.ts：曾因裸 catch 断言未建立的 cause，把真正的失败丢掉）。 */
  loadError?: string
}

/** 在 worker 线程内完成 readFile + 准入 + parse + findAll + 纯数据提取。 */
export async function astScanRaw(args: AstScanArgs): Promise<AstScanResult> {
  const result: AstScanResult = {
    matches: [],
    filesScanned: 0,
    errors: [],
    skipped: [],
    degraded: [],
  }

  const loaded = await loadAstGrepNapi()
  if (!loaded.ok) {
    result.loadError = loaded.message
    return result
  }
  const napi = loaded.napi

  // Lang 的 getter 是非枚举的——必须在动态 import 落地后构建映射。
  const langMap = buildLangMap(napi)
  // 动态语言（python/json）的注册是 ast-shared 的模块级 flag。worker 线程是
  // 独立的模块实例，主线程注册过不会传过来，必须在本线程内自行注册一次，
  // 否则 .py/.json 在本通道里会退化成「不支持的语言」。
  await ensureDynamicLangsRegistered(napi)

  const { ruleOrPattern } = resolveRuleOrPattern(args.pattern)
  const metaVarDefs = args.includeMeta ? collectMetaVarNames(args.pattern) : []

  for (const filePath of args.files) {
    if (result.matches.length >= args.limit) break

    const langStr = resolveLang(args.explicitLang, filePath)
    if (!langStr) {
      result.errors.push(`${filePath}: 不支持的语言（该扩展名无语法）`)
      continue
    }

    const langValue = isDynamicLang(langStr) ? langStr : langMap[langStr]
    if (typeof langValue !== 'string') {
      result.errors.push(`${filePath}: LANG_MAP 对 "${langStr}" 返回了非字符串——可能是 @ast-grep/napi API 变更`)
      continue
    }

    let buf: Buffer
    try {
      buf = readFileSync(filePath)
    } catch {
      result.errors.push(`${filePath}: 无法读取文件`)
      continue
    }
    const skipReason = parseSkipReason(filePath, buf, args.maxBytes)
    if (skipReason) {
      result.skipped.push(skipReason)
      continue
    }
    const source = buf.toString('utf-8')

    result.filesScanned++

    let root: ReturnType<ReturnType<typeof napi.parse>['root']>
    try {
      root = napi.parse(langValue, source).root()
    } catch {
      result.errors.push(`${filePath}: 解析错误`)
      continue
    }

    // tree-sitter 错误恢复后 AST 仍有可用结构——只警告不跳过（Wave 1 的决策：
    // 整文件跳过等于「一处不识别语法就废掉该文件的全部 AST 搜索」）。
    const errorNodes = root.findAll({ rule: { kind: 'ERROR' } } as unknown as string)
    if (errorNodes.length > 0) {
      result.degraded.push(`${filePath}: ${errorNodes.length} 处错误恢复区`)
    }

    let found
    try {
      found = root.findAll(ruleOrPattern as string)
    } catch {
      result.errors.push(`${filePath}: pattern 编译错误`)
      continue
    }

    for (const node of found) {
      if (result.matches.length >= args.limit) break
      const range = node.range()
      const match: AstScanMatch = {
        file: filePath,
        line: range.start.line + 1,
        column: range.start.column + 1,
        matchText: node.text(),
      }
      if (args.includeMeta) {
        match.metaVariables = {}
        for (const { name, multi } of metaVarDefs) {
          if (multi) {
            const mvs = node.getMultipleMatches(name)
            if (mvs && mvs.length > 0) {
              // 形状摘要而非原始文本：$$$BODY 可能横跨整个函数体（KB 级源码），
              // 模型需要的是「多大、开头是什么」——全文交给 read_file。
              const texts = mvs.map(n => n.text())
              const nodeCount = texts.length
              const lineCount = texts.reduce((sum, t) => sum + t.split('\n').length, 0)
              const firstLine = texts[0]!.split('\n')[0]!.trim().slice(0, 50)
              match.metaVariables[name] = `${nodeCount}n/${lineCount}L: ${firstLine}`
            }
          } else {
            const mv = node.getMatch(name)
            if (mv) match.metaVariables[name] = mv.text().slice(0, 120)
          }
        }
      }
      result.matches.push(match)
    }
  }

  return result
}

// ── AST 编辑计算（ast_edit 的 worker 通道）──
// 与 astScanRaw 同因（2026-09-10 卡死事故）：parse / findAll / commitEdits 都是
// 同步 native 调用，留在主线程等于保留「任何超长解析冻结整个进程」的形态。
// **只把「计算」搬进来，写文件留在主线程**——审批、备份、写后语法复检与回滚
// 必须保持单一入口，写路径的审计面也不该扩散到 worker。

export interface AstEditOpArg {
  find: string
  replace: string
}

export interface AstEditChange {
  before: string
  after: string
  line: number
}

export interface AstEditComputeArgs {
  files: string[]
  ops: AstEditOpArg[]
  explicitLang?: string
  /** 与主线程原实现一致：dryRun 时跳过「编辑后语法检查」。 */
  dryRun: boolean
  limit: number
  maxBytes: number
}

export interface AstEditFileResult {
  file: string
  /** 编辑后的完整源码——主线程据此写文件（写路径不进 worker）。 */
  newSource: string
  changes: AstEditChange[]
  /** 最终语法检查通过才为 true；false 时主线程丢弃该文件更改。 */
  syntaxOk: boolean
  /** 编辑**前**文件的主导行尾（null = 新/空文件）——主线程写盘时据此保持原样，
   *  避免 worker 边界两侧各读一次文件造成 TOCTOU。 */
  existingEol: 'crlf' | 'lf' | null
}

export interface AstEditComputeResult {
  files: AstEditFileResult[]
  errors: string[]
  /** @ast-grep/napi 加载失败时的原始诊断——工具侧原样回传，不掩盖 cause。 */
  loadError?: string
}

interface SgNodeLike {
  text(): string
  range(): { start: { index: number; line: number; column: number }; end: { index: number; line: number; column: number } }
  getMatch(name: string): SgNodeLike | null
  getMultipleMatches(name: string): SgNodeLike[] | null
}

/** 用元变量值填充 replace 模板。SgNode 是 native 对象不能跨线程——本函数必须
 *  在 worker 内完成插值，只把最终字符串带出去。 */
function interpolateTemplate(template: string, node: SgNodeLike): string {
  let result = template
  const vars = collectMetaVarNames(template)
  // replace in reverse order of length to avoid partial matches (e.g. $NAME vs $NAME2)
  for (const { name, multi } of vars.sort((a, b) => b.name.length - a.name.length)) {
    if (multi) {
      const mvs = node.getMultipleMatches(name)
      if (mvs && mvs.length > 0) {
        result = result.replace(new RegExp(`\\$\\$\\${name}`, 'g'), mvs.map((n: SgNodeLike) => n.text()).join(''))
      }
    } else {
      const mv = node.getMatch(name)
      if (mv) {
        result = result.replace(new RegExp(`\\$${name}\\b`, 'g'), mv.text())
      }
    }
  }
  return result
}

/** 在 worker 线程内完成逐文件的 parse + 编辑计算 + 最终语法检查，回传纯数据。 */
export async function astEditComputeRaw(args: AstEditComputeArgs): Promise<AstEditComputeResult> {
  const result: AstEditComputeResult = { files: [], errors: [] }

  const loaded = await loadAstGrepNapi()
  if (!loaded.ok) {
    result.loadError = loaded.message
    return result
  }
  const napi = loaded.napi
  const langMap = buildLangMap(napi)
  // 模块级注册 flag 不跨线程——worker 内必须自行注册一次（同 astScanRaw）。
  await ensureDynamicLangsRegistered(napi)

  for (const filePath of args.files) {
    const langStr = resolveLang(args.explicitLang, filePath)
    if (!langStr) {
      result.errors.push(`${filePath}: 不支持的语言`)
      continue
    }

    const langValue = isDynamicLang(langStr) ? langStr : langMap[langStr]
    if (typeof langValue !== 'string') {
      result.errors.push(`${filePath}: LANG_MAP 对 "${langStr}" 返回了非字符串——可能是 @ast-grep/napi API 变更`)
      continue
    }

    let buf: Buffer
    try {
      buf = readFileSync(filePath)
    } catch {
      result.errors.push(`${filePath}: 无法读取文件`)
      continue
    }
    const skipReason = parseSkipReason(filePath, buf, args.maxBytes)
    if (skipReason) {
      result.errors.push(skipReason)
      continue
    }
    const source = buf.toString('utf-8')

    const changes: AstEditChange[] = []
    let currentSource = source

    for (const op of args.ops) {
      let root: ReturnType<ReturnType<typeof napi.parse>['root']>
      try {
        root = napi.parse(langValue, currentSource).root()
      } catch {
        result.errors.push(`${filePath}: 操作 "${op.find.slice(0, 40)}" 解析错误`)
        break
      }

      const errorNodes = root.findAll({ rule: { kind: 'ERROR' } } as unknown as string)
      if (errorNodes.length > 0) {
        result.errors.push(`${filePath}: 解析错误（${errorNodes.length} 个语法错误）`)
        break
      }

      const { ruleOrPattern: pattern } = resolveRuleOrPattern(op.find)

      let found
      try {
        found = root.findAll(pattern as string)
      } catch {
        result.errors.push(`${filePath}: 模式 "${op.find.slice(0, 40)}" 编译错误`)
        continue
      }

      if (found.length === 0) continue

      const edits: Array<{ startPos: number; endPos: number; insertedText: string }> = []
      const count = Math.min(found.length, args.limit)
      for (let i = 0; i < count; i++) {
        const node = found[i]!
        const before = node.text()
        const range = node.range()
        changes.push({ before, after: interpolateTemplate(op.replace, node), line: range.start.line + 1 })
        edits.push({ startPos: range.start.index, endPos: range.end.index, insertedText: interpolateTemplate(op.replace, node) })
      }

      // 重叠护栏：嵌套/交叉范围会让 commitEdits 产出损坏源码，保留最外层匹配。
      edits.sort((a, b) => a.startPos - b.startPos)
      const deduped: typeof edits = []
      let skippedOverlap = 0
      for (const e of edits) {
        const prev = deduped[deduped.length - 1]
        if (prev && e.startPos < prev.endPos) {
          skippedOverlap++
          continue
        }
        deduped.push(e)
      }
      if (skippedOverlap > 0) {
        result.errors.push(`${filePath}: 已跳过 ${skippedOverlap} 个重叠匹配（"${op.find.slice(0, 40)}"）——嵌套范围会破坏编辑`)
      }

      try {
        currentSource = root.commitEdits(deduped)
      } catch {
        result.errors.push(`${filePath}: 操作 "${op.find.slice(0, 40)}" 的 commitEdits 失败`)
        break
      }
    }

    if (changes.length > 0) {
      // 最后一个 op 的结果不会在循环内复检——替换模板本身可能引入无效语法。
      // dryRun 时与原实现一致地跳过（预览不做写入前的最终门）。
      let syntaxOk = true
      if (!args.dryRun) {
        try {
          const finalRoot = napi.parse(langValue, currentSource).root()
          const finalErrors = finalRoot.findAll({ rule: { kind: 'ERROR' } } as unknown as string)
          if (finalErrors.length > 0) {
            result.errors.push(`${filePath}: 编辑后语法错误（${finalErrors.length} 个 ERROR 节点）——文件未写入，更改已丢弃`)
            syntaxOk = false
          }
        } catch {
          result.errors.push(`${filePath}: 编辑后解析失败——文件未写入，更改已丢弃`)
          syntaxOk = false
        }
      }
      result.files.push({ file: filePath, newSource: currentSource, changes, syntaxOk, existingEol: detectEol(source) })
    }
  }

  return result
}
