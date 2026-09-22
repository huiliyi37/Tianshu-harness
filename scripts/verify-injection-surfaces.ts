/**
 * 注入点申报表校验器 —— 把 `src/prompt/injection-surfaces.ts` 与源码逐条对账。
 *
 * 八道检查，任一失败即 exit 1：
 *
 * | # | 检查 | 拦住什么 |
 * |---|------|----------|
 * | V1 | 形状 | id 重复、枚举越界、appendix 序号不连续、非 appendix 带 order |
 * | V2 | 锚点 | 申报的表指向了不存在的文件/符号（重构后表烂掉） |
 * | V3 | CVM 计量源全覆盖 | 新增一个 CvmInjectionSource 却没人申报计量 |
 * | V4 | frozen 三分区 | 往冻结前缀里塞了新字段（每轮都在变的 churner 混进字节 0） |
 * | V5 | appendix 推送点对齐 | 新增/删除/重排/复制了 appendix 块而没更新申报表 |
 * | V6 | 顺序倒挂（仅报告） | 「稳定在前、易变在后」的意图被违反（不阻断，只提示） |
 * | V7 | 挂载拓扑 | appendix 被挪出「用户原文之后」这个尾部位置（整段缓存设计的前提被改动） |
 *
 * `runChecks` 接受一个变异回调，测试用它证明每道检查**确实会失败**
 * （不会失败的门禁等于装饰，见 `scripts/__tests__/injection-surfaces.test.ts`）。
 *
 * 用法：
 * ```sh
 * npm run surfaces:check            # 人类可读报告
 * npm run surfaces:check -- --json  # 机读 JSON（供桌面端 / 文档生成消费）
 * npm run surfaces:check -- --list  # 附上从源码实抽的 push 点清单
 * ```
 *
 * @module
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APPENDIX_PROTECTED_SURFACES,
  INJECTION_SURFACES,
  FROZEN_KEEP_FIELDS,
  FROZEN_STRIPPED_FIELDS,
  type InjectionSurface,
} from '../src/prompt/injection-surfaces.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const VOLATILE = 'src/prompt/volatile.ts'
const ENGINE = 'src/prompt/engine.ts'
const PRESSURE = 'src/context/pressure-monitor.ts'

/**
 * 冻结内部渲染时引用的**非内容** ctx 字段：仅渲染支撑（预算表、工作目录），
 * 不携带模型可读内容。单独列出，让三分区检查精确到「内容字段」这一层。
 */
const FROZEN_RENDER_SUPPORT: readonly string[] = ['blockCaps', 'cwd']

/** 校验视图——测试可变异其中任一项来证明对应的检查会失败。 */
export interface ManifestView {
  surfaces: InjectionSurface[]
  protectedIds: string[]
  frozenKeep: string[]
  frozenStripped: string[]
  renderSupport: string[]
  /** 测试用：按仓库相对路径替换源码内容，用来证明源码侧的检查确实会咬。 */
  sourceOverrides: Record<string, string>
}

export interface Failure {
  check: string
  message: string
}

export interface Report {
  ok: boolean
  failures: Failure[]
  warnings: string[]
  stats: {
    surfaces: number
    appendix: number
    appendixProtected: number
    channels: number
    metered: number
    anchorsVerified: number
    frozenKeep: number
    frozenStripped: number
  }
}

function freshView(): ManifestView {
  return {
    // consumes 也要复制：浅拷贝会让测试里的 push 泄漏回模块常量，污染后续用例
    surfaces: INJECTION_SURFACES.map(s => ({
      ...s,
      anchor: { ...s.anchor },
      ...(s.consumes ? { consumes: [...s.consumes] } : {}),
    })),
    protectedIds: APPENDIX_PROTECTED_SURFACES.map(s => s.id),
    frozenKeep: [...FROZEN_KEEP_FIELDS],
    frozenStripped: [...FROZEN_STRIPPED_FIELDS],
    renderSupport: [...FROZEN_RENDER_SUPPORT],
    sourceOverrides: {},
  }
}

// ── 源码扫描原语 ────────────────────────────────────────────────────────────

/** 跳过一段字符串/模板字面量，返回结束引号之后的下标；失败返回 -1。 */
function skipString(source: string, start: number): number {
  const quote = source[start]!
  let i = start + 1
  while (i < source.length) {
    const c = source[i]!
    if (c === '\\') { i += 2; continue }
    if (quote === '`' && c === '$' && source[i + 1] === '{') {
      const end = findBalanced(source, i + 1, '{', '}')
      if (end < 0) return -1
      i = end + 1
      continue
    }
    if (c === quote) return i + 1
    i++
  }
  return -1
}

/** 从 `start`（必须是 open 字符）起做括号配对，返回配对 close 的下标；失败 -1。 */
function findBalanced(source: string, start: number, open: string, close: string): number {
  let depth = 0
  let i = start
  while (i < source.length) {
    const c = source[i]!
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      if (nl < 0) return -1
      i = nl
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      const e = source.indexOf('*/', i + 2)
      if (e < 0) return -1
      i = e + 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const next = skipString(source, i)
      if (next < 0) return -1
      i = next
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

/** 取一个具名函数的大括号层面函数体文本；找不到返回 null。 */
function functionBody(source: string, header: string): string | null {
  const at = source.indexOf(header)
  if (at < 0) return null
  const open = source.indexOf('{', at + header.length)
  if (open < 0) return null
  const close = findBalanced(source, open, '{', '}')
  if (close < 0) return null
  return source.slice(open + 1, close)
}

/**
 * 从具名函数声明起、到下一个顶层函数声明为止的文本跨度。
 *
 * 为什么不用 `functionBody`：`resolveTersenessFlags(ctx: { … }, env): { … } { … }`
 * 这类签名里，header 之后的第一个 `{` 是**参数的内联对象类型**、不是函数体——
 * 精确配对会配到类型注解上，得到一个空的「函数体」。而类型注解里只写裸字段名
 * （`tersenessEnabled?: boolean`），不带 `ctx.` 前缀，所以放宽成「到下一个顶层
 * 函数声明为止」不会污染 `ctx.*` 的抽取结果。
 */
function functionSpan(source: string, header: string): string | null {
  const at = source.indexOf(header)
  if (at < 0) return null
  const rest = source.slice(at + header.length)
  const next = /\n(?:export )?(?:async )?function [A-Za-z0-9_]+\s*\(/.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

function readRepoFile(rel: string): string {
  const abs = join(REPO_ROOT, rel)
  if (!existsSync(abs)) throw new Error(`源码文件缺失：${rel}`)
  return readFileSync(abs, 'utf-8')
}

function lineOf(source: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === '\n') line++
  return line
}

// ── appendix 推送点解析 ─────────────────────────────────────────────────────

export interface PushSite {
  /** 归一化后的生产者键，与申报表的 `producer` 同口径。 */
  key: string
  /** 第二个实参若是字符串字面量（CVM 计量源），取其值。 */
  metered?: string
  /** 源码行号，供报告定位。 */
  line: number
  /** 是否来自受保护块数组（`protectedParts.push`）。 */
  protected: boolean
}

/**
 * 从 `buildDynamicAppendixParts` 里抽出 push 点，归一到申报表的 producer 口径。
 *
 * 归一规则（与申报表逐条对应）：
 *   `` push(`<tag>…`) ``        → `tag:<tag>`
 *   `push(ctx.field, …)`        → `ctx.field`
 *   `push(fn(…))`               → `fn()`
 *   `push(localVar)`            → 解析一层 `const localVar = fn(…)` → `fn()`
 */
function parsePushSites(body: string, source: string, bodyOffset: number, protectedOnly: boolean): PushSite[] {
  const sites: PushSite[] = []
  const re = protectedOnly ? /protectedParts\.push\s*\(/g : /(?<![.\w$])push\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const openIdx = m.index + m[0].length - 1
    const closeIdx = findBalanced(body, openIdx, '(', ')')
    if (closeIdx < 0) continue
    const argText = body.slice(openIdx + 1, closeIdx)
    const key = normalizeProducer(argText, body)
    if (!key) continue
    const site: PushSite = { key, line: lineOf(source, bodyOffset + m.index), protected: protectedOnly }
    const meterMatch = /,\s*'([a-z-]+)'\s*$/.exec(argText.trimEnd().replace(/\s+/g, ' '))
    if (meterMatch) site.metered = meterMatch[1]!
    sites.push(site)
  }
  return sites
}

/** 把 push 的第一个实参归一成 producer 键。 */
function normalizeProducer(argText: string, body: string, depth = 0): string | null {
  const arg = argText.trim()
  if (arg.length === 0) return null
  const tag = /^`<([A-Za-z0-9_-]+)/.exec(arg)
  if (tag) return `tag:${tag[1]!}`
  const ctxField = /^ctx\.([A-Za-z0-9_]+)/.exec(arg)
  if (ctxField) return `ctx.${ctxField[1]!}`
  const call = /^([A-Za-z0-9_]+)\s*\(/.exec(arg)
  if (call) return `${call[1]!}()`
  const bare = /^([A-Za-z0-9_]+)$/.exec(arg)
  if (bare && depth < 2) {
    const decl = new RegExp(`const\\s+${bare[1]!}\\s*=\\s*([^\\n]+)`).exec(body)
    if (decl) return normalizeProducer(decl[1]!, body, depth + 1)
    return bare[1]!
  }
  return null
}

/** 按首次出现顺序去重——同一 producer 出现在多个互斥分支时只留一个位置。 */
function dedupeKeepOrder(keys: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of keys) {
    if (seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

/** 逐位比对两个序列，给出「缺/多/错位」三种可操作信息。 */
function compareSequence(
  check: string,
  label: string,
  declared: readonly string[],
  actual: readonly string[],
  failures: Failure[],
): void {
  if (declared.length === actual.length && declared.every((v, i) => v === actual[i])) return
  const missing = actual.filter(a => !declared.includes(a))
  const extra = declared.filter(d => !actual.includes(d))
  if (missing.length > 0) failures.push({ check, message: `${label}：源码里有未申报的推送点 ${missing.join(', ')}（补进申报表，或确认后删除）` })
  if (extra.length > 0) failures.push({ check, message: `${label}：申报了但源码里已不存在 ${extra.join(', ')}` })
  if (missing.length === 0 && extra.length === 0) {
    const firstDiff = declared.findIndex((v, i) => v !== actual[i])
    failures.push({
      check,
      message: `${label}：顺序不一致，首个错位在第 ${firstDiff} 位（申报 ${declared[firstDiff]} vs 源码 ${actual[firstDiff]}）——顺序即缓存设计，重排需同步改 order`,
    })
  }
}

// ── 检查主体 ────────────────────────────────────────────────────────────────

export function runChecks(mutate?: (view: ManifestView) => void): Report {
  const view = freshView()
  if (mutate) mutate(view)

  const failures: Failure[] = []
  const warnings: string[] = []
  const fail = (check: string, message: string): void => { failures.push({ check, message }) }

  const readSrc = (rel: string): string => view.sourceOverrides[rel] ?? readRepoFile(rel)
  const volatileSrc = readSrc(VOLATILE)
  const engineSrc = readSrc(ENGINE)
  const pressureSrc = readSrc(PRESSURE)

  const protectedSet = new Set(view.protectedIds)
  const appendixAll = view.surfaces.filter(s => s.channel === 'appendix')
  const appendixProtected = appendixAll.filter(s => protectedSet.has(s.id))
  const appendixRegular = appendixAll.filter(s => !protectedSet.has(s.id))

  // ── V1 形状 ──
  const ids = new Set<string>()
  for (const s of view.surfaces) {
    if (ids.has(s.id)) fail('V1', `id 重复：${s.id}`)
    ids.add(s.id)
    if (s.note.trim().length === 0) fail('V1', `${s.id}：note 为空`)
    if (s.anchor.file.trim().length === 0 || s.anchor.symbol.trim().length === 0) {
      fail('V1', `${s.id}：anchor 不完整`)
    }
    if (s.channel === 'appendix' && s.order === undefined) fail('V1', `${s.id}：appendix 块缺 order`)
    if (s.channel !== 'appendix' && s.order !== undefined) fail('V1', `${s.id}：非 appendix 通道不应有 order`)
    if (s.pushSites !== undefined && s.pushSites < 1) fail('V1', `${s.id}：pushSites 必须 ≥1`)
  }
  for (const [label, group] of [['受保护块', appendixProtected], ['普通块', appendixRegular]] as const) {
    const orders = group.map(s => s.order ?? -1)
    const sorted = [...orders].sort((a, b) => a - b)
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== i) {
        fail('V1', `appendix ${label} order 必须是从 0 起的连续序号，实际 [${orders.join(', ')}]`)
        break
      }
    }
  }

  // ── V2 锚点存在 ──
  let anchorsVerified = 0
  for (const s of view.surfaces) {
    const abs = join(REPO_ROOT, s.anchor.file)
    if (!existsSync(abs)) {
      fail('V2', `${s.id}：锚点文件不存在 ${s.anchor.file}`)
      continue
    }
    const src = readFileSync(abs, 'utf-8')
    if (!src.includes(s.anchor.symbol)) {
      fail('V2', `${s.id}：${s.anchor.file} 中找不到符号 ${JSON.stringify(s.anchor.symbol)}`)
      continue
    }
    anchorsVerified++
  }

  // ── V3 CvmInjectionSource 全覆盖 ──
  const enumBlock = /export type CvmInjectionSource =([\s\S]*?)\n\n/.exec(pressureSrc)
  const enumMembers = enumBlock ? [...enumBlock[1]!.matchAll(/'([a-z-]+)'/g)].map(m => m[1]!) : []
  if (enumMembers.length === 0) {
    fail('V3', `无法从 ${PRESSURE} 解析 CvmInjectionSource 联合类型`)
  } else {
    const declared = new Set(view.surfaces.map(s => s.metered).filter((v): v is NonNullable<typeof v> => v !== undefined))
    for (const member of enumMembers) {
      if (!declared.has(member as never)) {
        fail('V3', `CvmInjectionSource '${member}' 没有任何申报条目认领——新增计量通道必须登记注入点`)
      }
    }
    for (const d of declared) {
      if (!enumMembers.includes(d)) fail('V3', `申报表声明了不存在的计量源 '${d}'`)
    }
  }

  // ── V4 frozen 三分区 ──
  const stableBody = functionBody(volatileSrc, 'export function buildStableVolatileBlock')
  if (!stableBody) {
    fail('V4', `无法定位 ${VOLATILE} 的 buildStableVolatileBlock`)
  } else {
    const parsedStripped = [...new Set([...stableBody.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*undefined,\s*$/gm)].map(m => m[1]!))].sort()
    const declaredStripped = [...view.frozenStripped].sort()
    const missing = parsedStripped.filter(f => !declaredStripped.includes(f))
    const extra = declaredStripped.filter(f => !parsedStripped.includes(f))
    if (missing.length > 0) fail('V4', `strip list 里有未申报的剥离字段：${missing.join(', ')}（补进 FROZEN_STRIPPED_FIELDS）`)
    if (extra.length > 0) fail('V4', `申报表声明的剥离字段在 strip list 里不存在：${extra.join(', ')}（已失效，从表里删掉）`)

    const internalBody = functionBody(volatileSrc, 'function buildVolatileBlockInternal')
    if (!internalBody) {
      fail('V4', `无法定位 ${VOLATILE} 的 buildVolatileBlockInternal`)
    } else {
      const rendered = [...new Set([...internalBody.matchAll(/ctx\.([A-Za-z][A-Za-z0-9_]*)/g)].map(m => m[1]!))].sort()
      const frozenFacing = rendered.filter(f => !parsedStripped.includes(f))
      const declaredFrozen = [...new Set([...view.frozenKeep, ...view.renderSupport])].sort()
      const undeclared = frozenFacing.filter(f => !declaredFrozen.includes(f))
      const stale = declaredFrozen.filter(f => !frozenFacing.includes(f))
      if (undeclared.length > 0) {
        fail('V4', `冻结前缀里渲染了未申报的字段：${undeclared.join(', ')}——会话常量补进 FROZEN_KEEP_FIELDS；每轮会变的必须剥离出 frozen 并进 appendix`)
      }
      if (stale.length > 0) {
        fail('V4', `FROZEN_KEEP_FIELDS/支撑字段里有已不再渲染的：${stale.join(', ')}（从表里删掉）`)
      }
    }
  }

  // ── V5 appendix 推送点对齐 ──
  const partsBody = functionBody(volatileSrc, 'export function buildDynamicAppendixParts')
  if (!partsBody) {
    fail('V5', `无法定位 ${VOLATILE} 的 buildDynamicAppendixParts`)
  } else {
    const bodyOffset = volatileSrc.indexOf(partsBody)
    const sites = [
      ...parsePushSites(partsBody, volatileSrc, bodyOffset, false),
      ...parsePushSites(partsBody, volatileSrc, bodyOffset, true),
    ]
    const regularSites = sites.filter(s => !s.protected)
    const protectedSites = sites.filter(s => s.protected)

    compareSequence(
      'V5',
      'appendix 普通块',
      [...appendixRegular].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(s => s.producer),
      dedupeKeepOrder(regularSites.map(s => s.key)),
      failures,
    )
    compareSequence(
      'V5',
      'appendix 受保护块',
      [...appendixProtected].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(s => s.producer),
      dedupeKeepOrder(protectedSites.map(s => s.key)),
      failures,
    )

    // 重数核对 + 计量源字面量核对
    const counts = new Map<string, number>()
    for (const site of sites) counts.set(site.key, (counts.get(site.key) ?? 0) + 1)
    for (const surface of appendixAll) {
      const expected = surface.pushSites ?? 1
      const actual = counts.get(surface.producer) ?? 0
      if (actual !== expected) {
        fail('V5', `${surface.id}：源码里有 ${actual} 个 push 点，申报 pushSites=${expected}（改动分支结构后需同步）`)
      }
    }
    for (const site of sites) {
      const surface = appendixAll.find(s => s.producer === site.key)
      if (!surface) continue
      if (site.metered !== surface.metered) {
        fail('V5', `${surface.id}：代码里计量源是 ${site.metered ?? '(无)'}，申报表写的是 ${surface.metered ?? '(无)'}（${VOLATILE}:${site.line}）`)
      }
    }
  }

  // ── V7 appendix 挂载拓扑 ──
  // 整段缓存设计的前提：appendix 追加在**用户原文之后**（尾部位），而不是塞进
  // system 段。塞进 system 段会让其后每轮都变 → 全量重建。这里钉住三个必要形状。
  for (const needle of ['buildTraileredUserContent', 'trailerTextPrefix']) {
    if (!engineSrc.includes(needle)) {
      fail('V7', `${ENGINE} 里找不到 ${needle}——appendix 的尾部挂载路径被改动了，重新确认注入拓扑后更新本检查`)
    }
  }
  for (const needle of ['(appendix ? ', 'text: appendix']) {
    if (!engineSrc.includes(needle)) {
      fail('V7', `${ENGINE} 中缺少 appendix 追加在用户内容之后的形状 ${JSON.stringify(needle)}——若确实改成了别的位置，需重新评估缓存代价`)
    }
  }

  // ── V6 顺序倒挂（仅报告）──
  // 注意口径：这是**与源码注释声明的意图对账**，不是已量化的成本。源码里
  // 「cache-friendly ordering — stable sections first, volatile last」的注释写在
  // trailer 架构之前；当前 appendix 一律挂在消息尾部、且 delta 模式只发变化过的
  // 子块（engine.ts buildAppendixBody），所以块内顺序**不会**让已缓存字节失效。
  // 没有实测支持就不声称代价，故这条只作意图漂移信号，不阻断。
  const RANK: Record<string, number> = { 'session-constant': 0, transition: 1, 'per-boundary': 2, 'per-turn': 3 }
  const ordered = [...appendixRegular].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!
    const cur = ordered[i]!
    if ((RANK[cur.volatility] ?? 0) < (RANK[prev.volatility] ?? 0)) {
      warnings.push(`顺序与源码注释声明的意图不一致：${prev.id}(${prev.volatility}) 排在 ${cur.id}(${cur.volatility}) 之前（当前 trailer + delta 下顺序不影响已缓存字节，仅为意图漂移）`)
    }
  }

  // ── V8 间接消费 ──
  // progress / terseness 这类块由渲染函数内部读 ctx，光看 push 点看不见。
  // 双向对账：函数体里的每个 ctx.<field> 都必须在 consumes 里申报；申报的也必须真被读。
  for (const surface of appendixAll) {
    const declared = surface.consumes
    const fnName = surface.consumesIn ?? /^([A-Za-z0-9_]+)\(\)$/.exec(surface.producer)?.[1]
    if (declared === undefined || declared.length === 0) {
      if (surface.consumesIn !== undefined) fail('V8', `${surface.id}：给了 consumesIn 却没有 consumes`)
      continue
    }
    if (!fnName) {
      fail('V8', `${surface.id}：无法从 producer ${surface.producer} 推出消费函数名，请显式给 consumesIn`)
      continue
    }
    const fnBody = functionSpan(volatileSrc, `function ${fnName}(`) ?? functionSpan(volatileSrc, `export function ${fnName}(`)
    if (!fnBody) {
      fail('V8', `${surface.id}：在 ${VOLATILE} 里找不到消费函数 ${fnName}`)
      continue
    }
    const actual = [...new Set([...fnBody.matchAll(/ctx\.([A-Za-z][A-Za-z0-9_]*)/g)].map(m => m[1]!))].sort()
    const expect = [...declared].sort()
    const undeclaredFields = actual.filter(f => !expect.includes(f))
    const staleFields = expect.filter(f => !actual.includes(f))
    if (undeclaredFields.length > 0) {
      fail('V8', `${surface.id}：${fnName} 读了未申报的字段 ${undeclaredFields.join(', ')}——补进 consumes，否则该字段绕过申报表进入上下文`)
    }
    if (staleFields.length > 0) {
      fail('V8', `${surface.id}：consumes 里的 ${staleFields.join(', ')} 在 ${fnName} 里已不再被读（从表里删掉）`)
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    stats: {
      surfaces: view.surfaces.length,
      appendix: appendixRegular.length,
      appendixProtected: appendixProtected.length,
      channels: new Set(view.surfaces.map(s => s.channel)).size,
      metered: view.surfaces.filter(s => s.metered !== undefined).length,
      anchorsVerified,
      frozenKeep: view.frozenKeep.length,
      frozenStripped: view.frozenStripped.length,
    },
  }
}

/** 从源码实抽的 push 点清单（`--list` 用；解析失败返回空数组）。 */
export function listPushSites(): PushSite[] {
  const volatileSrc = readRepoFile(VOLATILE)
  const body = functionBody(volatileSrc, 'export function buildDynamicAppendixParts')
  if (!body) return []
  const bodyOffset = volatileSrc.indexOf(body)
  return [
    ...parsePushSites(body, volatileSrc, bodyOffset, false),
    ...parsePushSites(body, volatileSrc, bodyOffset, true),
  ]
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main(): void {
  const json = process.argv.includes('--json')
  const list = process.argv.includes('--list')
  let report: Report
  try {
    report = runChecks()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, failures: [{ check: 'internal', message }] }, null, 2) + '\n')
    } else {
      console.error(`❌ 注入点申报表校验失败：${message}`)
    }
    process.exit(1)
  }

  if (json) {
    const payload = list ? { ...report, pushSites: listPushSites() } : report
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
    process.exit(report.ok ? 0 : 1)
  }

  const s = report.stats
  console.log('注入点申报表 · 校验报告')
  console.log(`  申报条目 ${s.surfaces}（appendix 普通块 ${s.appendix} + 受保护块 ${s.appendixProtected} + 通道级 ${s.surfaces - s.appendix - s.appendixProtected}）`)
  console.log(`  通道 ${s.channels} · 挂 CVM 计量的 ${s.metered} · 锚点核验 ${s.anchorsVerified}`)
  console.log(`  frozen 分区：保留 ${s.frozenKeep} / 剥离 ${s.frozenStripped}`)

  if (list) {
    console.log('\n源码实抽的 push 点（顺序）')
    for (const site of listPushSites()) {
      console.log(`  ${site.protected ? '[protected] ' : ''}${site.key}${site.metered ? ` (${site.metered})` : ''}  :${site.line}`)
    }
  }

  if (report.warnings.length > 0) {
    console.log('\n⚠ 提示（不阻断）')
    for (const w of report.warnings) console.log(`  - ${w}`)
  }

  if (!report.ok) {
    console.error('\n❌ 失败')
    for (const f of report.failures) console.error(`  [${f.check}] ${f.message}`)
    console.error('\n申报表：src/prompt/injection-surfaces.ts')
    process.exit(1)
  }

  console.log('\n✅ 申报表与源码一致')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
