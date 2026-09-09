import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { MeridianDb } from './meridian-db.js'
import { MeridianBehavior } from './meridian-behavior.js'
import { parseFile, parseTypeScriptFile, initParser, detectLang } from './meridian-parser.js'
import { buildRepoMap } from './meridian-graph.js'
import { analyzeImpact, inferTestedByTargets } from './meridian-impact.js'
import { extractExpressRoutes, extractJsxChildren } from './meridian-framework.js'
import type { RepoMapResult, MeridianSymbol, MeridianSymbolKind, MeridianEdge } from './meridian-types.js'
import type { CallSite } from './meridian-types.js'
import type { RepoMapOptions } from './meridian-graph.js'
import type { ImpactResult } from './meridian-impact.js'
import type { StigmergyStore } from '../context/stigmergy.js'
import { classifyPath } from '../context/attention-filter.js'

// ─── 语言扩展评估门（wave4 T10，2026-08）─────────────────────────────
// 评估结论：tree-sitter-wasms@0.1.13 实际分发的 grammar 仅 3 个——typescript、
// python、go（本地 node_modules/tree-sitter-wasms/out/ 实测 3 个 wasm，
// 无 rust/java）。依计划 T10「可得再增，不可得后置」裁决：Rust/Java 扩展
// 后置，不为凑语言数引入新依赖。
// 依赖升级路径：待 tree-sitter-wasms 发布包含 tree-sitter-rust.wasm /
// tree-sitter-java.wasm 的版本后，在 meridian-parser.ts 的 LANG_WASM /
// EXT_TO_LANG 注册新语言并补对应 walkSymbols/walkCalls 解析器，即完成扩展。

const TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']
const ALL_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go']
const IGNORE_PATTERNS = ['node_modules', 'dist', '.git', '.rivet']

/** probeFile 结果：skip = 不可索引/越界/正在索引；unchanged = hash 未变
 *  （已记 access）；parse = 需要入队重解析（未写任何索引数据）。 */
export type MeridianProbeStatus = 'skip' | 'unchanged' | 'parse'

export interface MeridianIndexOptions {
  /** meridian-hook 队列专用：1-hop import 递归前让出事件循环。
   *  默认 false，保持 backfill/工具路径行为不变。 */
  yieldBetweenImports?: boolean
}

/**
 * 可索引判定（扩展名白名单 + IGNORE_PATTERNS + attention 静默层）——
 * 懒建（indexFile）与后台全量索引（meridian-backfill）共用的单一来源，
 * 防两处规则漂移。输入必须是 repo 相对路径；越界/绝对路径的 fail-closed
 * 归 toRepoRelative 管，不在此层。
 */
export function isMeridianIndexablePath(rel: string): boolean {
  if (IGNORE_PATTERNS.some(p => rel.includes(p))) return false
  if (classifyPath(rel).silent) return false
  return ALL_EXTENSIONS.some(ext => rel.endsWith(ext))
}

// ─── Flow 查询（wave4 T9）：named-symbol BFS，≤1 个未命名桥 ──────────
// 吸收 CodeGraph MAX_BRIDGE=1 设计：从命名符号出发沿边双向 BFS，路径上
// 允许穿过至多 maxBridges 个未命名节点（`file:*:0` 占位，如 imports 边的
// target），起点与命中点都必须命名符号——未命名节点只作桥、不进结果。

export interface FlowQueryOptions {
  /** BFS 深度上限（默认 4）。 */
  maxHops?: number
  /** 路径允许的未命名桥数上限（默认 1 = CodeGraph MAX_BRIDGE=1）。 */
  maxBridges?: number
}

export interface FlowHit {
  symbolId: string
  name: string
  kind: MeridianSymbolKind
  filePath: string
  line: number
  /** 到达该命中点的 BFS 跳数。 */
  hops: number
  /** 路径经过的未命名桥数（0 = 全程命名符号直达）。 */
  bridges: number
}

/** 未命名占位 id（`file:*:0`）判定——flow 两端 named 约束的核心谓词。 */
export function isUnnamedSymbolId(id: string): boolean {
  return id.endsWith(':*:0')
}

/** named-symbol BFS：seed 必须是命名符号；返回的命中点也全是命名符号。 */
export function queryFlow(db: MeridianDb, seedId: string, opts?: FlowQueryOptions): FlowHit[] {
  const maxHops = opts?.maxHops ?? 4
  const maxBridges = opts?.maxBridges ?? 1
  // 两端 named 约束：未命名 seed 直接拒绝（空结果）。
  if (isUnnamedSymbolId(seedId)) return []
  const seedFile = seedId.split(':')[0]!
  const seed = db.getSymbolsForFile(seedFile).find(s => s.id === seedId)
  if (!seed) return []

  const hits = new Map<string, FlowHit>()
  const visited = new Set<string>()
  let frontier: Array<{ id: string; bridges: number; hops: number }> = [{ id: seedId, bridges: 0, hops: 0 }]
  visited.add(`${seedId}:0`)

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: Array<{ id: string; bridges: number; hops: number }> = []
    for (const cur of frontier) {
      const neighbors = [
        ...db.getEdgesFrom(cur.id).map(e => e.targetId),
        ...db.getEdgesTo(cur.id).map(e => e.sourceId),
      ]
      for (const nid of neighbors) {
        const unnamed = isUnnamedSymbolId(nid)
        const bridges = cur.bridges + (unnamed ? 1 : 0)
        if (bridges > maxBridges) continue
        const key = `${nid}:${bridges}`
        if (visited.has(key)) continue
        visited.add(key)
        if (unnamed) {
          next.push({ id: nid, bridges, hops: cur.hops + 1 })
        } else {
          const file = nid.split(':')[0]!
          const sym = db.getSymbolsForFile(file).find(s => s.id === nid)
          if (sym) {
            // 同一符号多条路径命中：保留 bridges 更小的那条（≤1 桥优先）。
            const existing = hits.get(nid)
            if (!existing || bridges < existing.bridges) {
              hits.set(nid, { symbolId: nid, name: sym.name, kind: sym.kind, filePath: sym.filePath, line: sym.line, hops: cur.hops + 1, bridges })
            }
            next.push({ id: nid, bridges, hops: cur.hops + 1 })
          }
        }
      }
    }
    frontier = next
  }
  return [...hits.values()].sort((a, b) => a.hops - b.hops || a.symbolId.localeCompare(b.symbolId))
}

/** 删除文件处理（wave4 T9）：文件删除后，跨文件入边复活为 pending——target
 *  从具体符号 `file:sym:line` 重定向到文件级占位 `file:*:0`，依赖关系不静默
 *  断裂（getReverseDependents 的 GLOB `file:*` 仍命中该文件）。文件重新索引
 *  时 buildCallEdges 会按名字重建精确边。返回复活（pending）的入边条数。 */
export function reviveDeletedFile(db: MeridianDb, rel: string): number {
  const symbols = db.getSymbolsForFile(rel)
  let revived = 0
  for (const sym of symbols) {
    for (const edge of db.getEdgesTo(sym.id)) {
      const sourceFile = edge.sourceId.split(':')[0]
      if (sourceFile && sourceFile !== rel) {
        db.upsertEdge(edge.sourceId, `${rel}:*:0`, edge.kind, edge.weight, edge.confidence ?? 'extracted')
        revived++
      }
    }
  }
  // 清空该文件的符号与出边（files 行保留占位，contentHash 置空使重现文件
  // 的 needsParse 判定必然为 true，触发重新解析）。
  db.upsertFile({ filePath: rel, contentHash: '', symbols: [], edges: [], imports: [], calls: [] })
  return revived
}

export class MeridianIndexer {
  private db: MeridianDb
  private behavior: MeridianBehavior
  private initialized = false
  private indexing = new Set<string>()
  /** invalidateFile 并发守卫（共享 indexer 场景）：同 rel 只跑一个解析，
   *  并发到达标 pending，首个完成后重跑一轮，保证最终落到最新内容。 */
  private invalidating = new Set<string>()
  private pendingInvalidations = new Set<string>()
  /** 后台全量索引（meridian-backfill）每实例只调度一次的 flag。 */
  backfillScheduled = false

  constructor(private cwd: string, stateDir?: string, stigmergy?: StigmergyStore) {
    const dir = stateDir ?? resolve(cwd, '.rivet')
    this.db = new MeridianDb(dir)
    this.behavior = new MeridianBehavior(this.db, stigmergy)
  }

  getDb(): MeridianDb { return this.db }

  /**
   * 廉价探针（meridian-hook read_file 热路径，2026-09-08 阻塞修复）：
   * 与 indexFile 前缀完全同序地完成 path 校验 → indexable → db available →
   * 读文件 → sha256 → needsParse。hash 未变时写 recordAccess 并返回
   * 'unchanged'；需要重解析时返回 'parse'，由 hook 将完整 indexFile 入队，
   * 不在 postTool 链上执行 tree-sitter/事务。此方法只做同步 IO + 一次
   * SELECT，不触碰 parser，不写库（unchanged 的 access_log 除外）。
   */
  probeFile(filePath: string): MeridianProbeStatus {
    const rel = this.toRepoRelative(filePath)
    if (rel === null) return 'skip'
    if (this.indexing.has(rel)) return 'skip'
    if (!this.isIndexable(rel)) return 'skip'
    if (!this.db.available) return 'skip'
    const absPath = resolve(this.cwd, rel)
    if (!existsSync(absPath)) return 'skip'
    const source = readFileSync(absPath, 'utf-8')
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)
    if (!this.db.needsParse(rel, hash)) {
      this.db.recordAccess(rel)
      return 'unchanged'
    }
    return 'parse'
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await initParser()
      this.initialized = true
    }
  }

  async indexFile(filePath: string, options: MeridianIndexOptions = {}): Promise<void> {
    const rel = this.toRepoRelative(filePath)
    if (rel === null) return
    if (this.indexing.has(rel)) return
    if (!this.isIndexable(rel)) return
    // Bail before touching the disk, not after. Everything below — read, hash,
    // tree-sitter parse — exists only to fill the index, and the 1-hop import
    // expansion at the bottom multiplies it across every direct dependency.
    if (!this.db.available) return

    const absPath = resolve(this.cwd, rel)
    if (!existsSync(absPath)) return

    const source = readFileSync(absPath, 'utf-8')
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)

    if (!this.db.needsParse(rel, hash)) {
      this.db.recordAccess(rel)
      return
    }

    await this.ensureInit()
    this.indexing.add(rel)

    try {
      const result = await parseFile(rel, source)
      // Resolve raw import strings to repo-relative paths before storing, so
      // reverse-dependency lookups (getReverseDependents) actually match. The
      // 1-hop expansion below reuses the same resolved set to avoid re-resolving.
      const resolvedImports = this.resolveImports(rel, result.imports)

      // 1-hop expand first: cross-file symbols must be in the DB before the
      // framework extraction below resolves handlers/components by name.
      for (const resolved of resolvedImports) {
        if (!this.indexing.has(resolved)) {
          if (options.yieldBetweenImports) {
            // 队列项内部让出：import 密集大文件不再把多个同步 parse 连成
            // 一个超长微任务链；timer/HTTP 可在每次 1-hop 递归前插入。
            await new Promise<void>(resolve => setTimeout(resolve, 0))
          }
          await this.indexFile(resolved, options)
        }
      }

      // Framework edges (CodeGraph mechanism absorption — route_handles/jsx_children).
      // knownSymbols = this file + symbols from reachable files (cross-file
      // handlers/components resolve); fileSymbols stays this-file-only so the
      // JSX enclosing selection never compares against foreign line numbers
      // (review MEDIUM-1).
      const known = [...result.symbols, ...resolvedImports.flatMap(imp => this.db.getSymbolsForFile(imp))]
      const fw = this.extractFrameworkEdges(rel, source, result.symbols, known)
      // Single upsertFile with the complete symbol set — a second upsertFile
      // would wipe tested_by edges built below (review MEDIUM-2).
      this.db.upsertFile({ ...result, imports: resolvedImports, symbols: [...result.symbols, ...fw.symbols] })
      this.db.recordAccess(rel)

      // Build tested_by edges if this file is a test
      if (this.isTestFile(rel)) {
        this.buildTestEdges(rel)
      }

      for (const e of fw.edges) {
        this.db.upsertEdge(e.sourceId, e.targetId, e.kind, e.weight, e.confidence ?? 'extracted')
      }

      // Cross-file call resolution runs after the import expansion above, so
      // symbols reachable via imports are already in the DB when matched.
      this.buildCallEdges(rel, result.calls)
    } finally {
      this.indexing.delete(rel)
    }
  }

  async invalidateFile(filePath: string): Promise<void> {
    const rel = this.toRepoRelative(filePath)
    if (rel === null) return
    if (!this.isIndexable(rel)) return

    // 并发守卫（共享 indexer）：同 rel 已有解析在跑时只标 pending，由当前
    // 持有者完成后重跑一轮——避免并发双解析，同时保证并发写后的最终内容
    // 仍会落到 DB（跳过守卫会让后写会话的索引结果丢失到前一个解析）。
    if (this.invalidating.has(rel)) {
      this.pendingInvalidations.add(rel)
      return
    }
    this.invalidating.add(rel)
    try {
      do {
        this.pendingInvalidations.delete(rel)
        await this.invalidateFileCore(rel)
      } while (this.pendingInvalidations.has(rel))
    } finally {
      this.invalidating.delete(rel)
    }
  }

  private async invalidateFileCore(rel: string): Promise<void> {
    const absPath = resolve(this.cwd, rel)
    if (!existsSync(absPath)) return

    await this.ensureInit()
    const source = readFileSync(absPath, 'utf-8')
    const result = await parseFile(rel, source)
    const resolvedImports = this.resolveImports(rel, result.imports)
    // Framework extraction on the hot-update path too (review HIGH-1): upsertFile
    // wipes all symbols/out-edges for the file, so without this the route symbols
    // and route_handles/jsx_children edges disappear after every agent edit until
    // the next full backfill.
    const known = [...result.symbols, ...resolvedImports.flatMap(imp => this.db.getSymbolsForFile(imp))]
    const fw = this.extractFrameworkEdges(rel, source, result.symbols, known)
    this.db.upsertFile({ ...result, imports: resolvedImports, symbols: [...result.symbols, ...fw.symbols] })
    // Hot-update must rebuild tested_by edges too (review LOW-1) — keep this
    // path in lockstep with indexFile.
    if (this.isTestFile(rel)) {
      this.buildTestEdges(rel)
    }
    for (const e of fw.edges) {
      this.db.upsertEdge(e.sourceId, e.targetId, e.kind, e.weight, e.confidence ?? 'extracted')
    }
    this.buildCallEdges(rel, result.calls)
  }

  /** Shared framework-edge extraction (route_handles/jsx_children) for the
   *  indexFile and invalidateFile paths — keeps the two production paths in
   *  lockstep so hot updates never silently drop framework edges.
   *  fileSymbols must stay this-file-only (JSX enclosing selection compares
   *  line numbers); knownSymbols may include cross-file symbols (route handler /
   *  component name matching). */
  private extractFrameworkEdges(
    rel: string,
    source: string,
    fileSymbols: MeridianSymbol[],
    knownSymbols: MeridianSymbol[],
  ): { symbols: MeridianSymbol[]; edges: MeridianEdge[] } {
    const out: { symbols: MeridianSymbol[]; edges: MeridianEdge[] } = { symbols: [], edges: [] }
    const fw = extractExpressRoutes(rel, source, knownSymbols)
    out.symbols.push(...fw.symbols)
    out.edges.push(...fw.edges)
    const jsx = extractJsxChildren(rel, source, fileSymbols, knownSymbols)
    out.edges.push(...jsx.edges)
    return out
  }

  /** 删除文件处理（wave4 T9）：跨文件入边复活为 pending 而非静默断裂。
   *  已删除/不可索引的文件直接忽略。返回复活（pending）的入边条数。 */
  removeFile(filePath: string): number {
    const rel = this.toRepoRelative(filePath)
    if (rel === null) return 0
    if (!this.isIndexable(rel)) return 0
    return reviveDeletedFile(this.db, rel)
  }

  async query(seedFile: string, opts?: Partial<RepoMapOptions>): Promise<RepoMapResult> {
    await this.behavior.refreshPheromoneCache()
    return buildRepoMap(this.db, seedFile, {
      maxHops: opts?.maxHops ?? 3,
      decay: opts?.decay ?? 0.5,
      maxTokens: opts?.maxTokens ?? 2000,
      behavior: this.behavior,
    })
  }

  recordEdit(filePath: string, turn: number): void {
    const rel = this.toRepoRelative(filePath)
    if (rel === null) return
    this.behavior.recordEdit(rel, turn)
  }

  flushTurn(): void {
    this.behavior.flushCoEdits()
  }

  /** Analyze impact radius for changed files */
  impact(changedFiles: string[], opts?: { maxHops?: number }): ImpactResult {
    return analyzeImpact(this.db, changedFiles, opts)
  }

  /** Build tested_by edges for a test file based on naming + imports */
  buildTestEdges(testFilePath: string): void {
    const allFiles = this.db.getAllFiles()
    const targets = inferTestedByTargets(testFilePath, allFiles)
    for (const target of targets) {
      const sourceId = `${testFilePath}:*:0`
      const targetId = `${target}:*:0`
      this.db.upsertEdge(sourceId, targetId, 'tested_by', 0.7, 'inferred')
    }
  }

  /** Resolve same-file-unresolved call sites against cross-file symbols by name.
   *  Unique match → inferred; multiple matches → ambiguous on every candidate.
   *  Confidence drives the CONFIDENCE_MULTIPLIER discount in the graph layer.
   *
   *  2026-09-08：不再 getAllSymbols 全表物化 + 逐 call 内存 filter——收集本次
   *  全部 callee name 后一次 getSymbolsByNames 批量拉取（走 idx_symbols_name），
   *  内存只建 name → symbols Map；同名多命中 ambiguous 语义不变。 */
  private buildCallEdges(fromFile: string, calls: CallSite[]): void {
    if (calls.length === 0) return
    const names = [...new Set(calls.map(c => c.name))]
    const symbolsByName = new Map<string, MeridianSymbol[]>()
    for (const symbol of this.db.getSymbolsByNames(names)) {
      if (symbol.filePath === fromFile) continue
      const list = symbolsByName.get(symbol.name)
      if (list) list.push(symbol)
      else symbolsByName.set(symbol.name, [symbol])
    }
    for (const call of calls) {
      const matches = symbolsByName.get(call.name) ?? []
      if (matches.length === 0) continue
      if (matches.length === 1) {
        const target = matches[0]
        if (target) this.db.upsertEdge(call.sourceId, target.id, 'calls', 1.0, 'inferred')
      } else {
        for (const m of matches) {
          this.db.upsertEdge(call.sourceId, m.id, 'calls', 1.0, 'ambiguous')
        }
      }
    }
  }

  getStats() {
    return this.db.getStats()
  }

  close(): void {
    this.db.close()
  }

  /** Normalize to repo-relative path for classification & DB keys.
   *  Returns null for any path that resolves outside the repo root —
   *  covers both absolute paths and relative `../` traversal.
   *  Fail-closed: the indexer must never read/parse/store files
   *  outside the project boundary. */
  private toRepoRelative(filePath: string): string | null {
    const absCwd = resolve(this.cwd)
    // Symlink hardening: canonicalize both sides before the prefix check.
    // Without resolving cwd, a repo reached through a symlink (macOS
    // /var→/private/var temp dirs, symlinked home/mount/repo) lets the
    // resolved file escape the boundary while the string prefix still
    // matches — the indexer must never read/parse/store files outside
    // the project boundary. Mirrors src/tools/path-validate.ts:46-50.
    let realCwd: string
    try {
      realCwd = realpathSync(this.cwd)
    } catch {
      realCwd = absCwd
    }
    const absFile = resolve(absCwd, filePath)
    // Prefix guard BEFORE slicing (review MEDIUM-3): a shared-prefix outside path
    // (e.g. cwd+'-other/...') would otherwise leave a residual suffix that lands
    // inside realCwd after rebasing and pass the check.
    if (!absFile.startsWith(absCwd + '/')) return null
    let realFile: string
    try {
      // Existing file: resolve symlinks so an in-repo link pointing outside
      // the project boundary fails the prefix check.
      realFile = realpathSync(absFile)
    } catch {
      // Non-existent file (classification probe): resolve within the real cwd
      // domain — realpath(absFile) would throw, and an unresolved absFile
      // compared against a realpath'd cwd mismatches on macOS /var→/private/var.
      // Rebase the cwd-relative suffix (may contain ../ segments — resolve
      // normalizes them, the prefix check below rejects escapes).
      realFile = resolve(realCwd, '.' + absFile.slice(absCwd.length))
    }
    if (!realFile.startsWith(realCwd + '/')) return null
    // Key by the non-canonical relative path so DB keys stay stable
    // regardless of symlink resolution differences across runs.
    return absFile.slice(absCwd.length + 1)
  }

  private isIndexable(filePath: string): boolean {
    const rel = this.toRepoRelative(filePath)
    if (rel === null) return false
    return isMeridianIndexablePath(rel)
  }

  private isTestFile(filePath: string): boolean {
    return filePath.includes('.test.') || filePath.includes('.spec.') ||
      filePath.includes('__tests__/') || filePath.includes('test/')
  }

  /** Resolve a list of raw import strings to deduped repo-relative paths.
   *  External packages (zod, node:fs) and tsconfig path aliases (@/, ~) fail
   *  resolution and are dropped — they carry no reverse-dependency value here. */
  private resolveImports(fromFile: string, imports: string[]): string[] {
    const seen = new Set<string>()
    for (const imp of imports) {
      const resolved = this.resolveImport(fromFile, imp)
      if (resolved) seen.add(resolved)
    }
    return [...seen]
  }

  private resolveImport(fromFile: string, importPath: string): string | null {
    const baseDir = dirname(resolve(this.cwd, fromFile))
    for (const ext of TS_EXTENSIONS) {
      const withExt = resolve(baseDir, importPath.replace(/\.[jt]sx?$/, '') + ext)
      if (existsSync(withExt)) {
        return withExt.slice(resolve(this.cwd).length + 1)
      }
      const indexFile = resolve(baseDir, importPath, 'index' + ext)
      if (existsSync(indexFile)) {
        return indexFile.slice(resolve(this.cwd).length + 1)
      }
    }
    return null
  }
}
