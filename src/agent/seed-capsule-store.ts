import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isProjectTrusted, notifyUntrustedOnce } from '../config/project-trust.js'

/**
 * 种子胶囊引擎 — 星域经验自动加载机制。
 *
 * 从 docs/seed-capsule-*.md 文件中自动发现并加载所有种子胶囊。
 * 每个胶囊文档包含一个 <seed-capsule star="..." sealed="..."> XML 块。
 * 提取后合并渲染到 frozen volatile block，session 全程稳定，prefix cache safe。
 *
 * 参考：docs/superpowers/specs/2026-05-28-seed-capsule-engine-design.md
 */

/** 胶囊文档命名模式：docs/seed-capsule-{starSlug}.md */
const CAPSULE_GLOB = /^seed-capsule-.+\.md$/

export interface SeedCapsule {
  /** 来源星域名 */
  star: string
  /** 封存日期 */
  sealedAt: string
  /** 一行索引摘要（gist 属性；缺省时为空） */
  gist?: string
  /** L1 核心文本（从 <seed-capsule> 标签内容提取） */
  raw: string
  /** 渲染后的完整 XML 块（可直接注入 volatile block） */
  block: string
}

interface ParsedTag {
  star: string
  sealed: string
  gist?: string
  content: string
}

/**
 * 从 markdown 文档中提取 <seed-capsule> 标签。
 * 格式：
 *   <seed-capsule star="天璇" sealed="2026-05-21" gist="跨域换视角">
 *     ...内容...
 *   </seed-capsule>
 *
 * 解析对**属性顺序与数量都容错**——先抓整个开标签，再逐属性提取。
 * 这样未知/额外属性（如 gist、seal）不会让整个胶囊被静默丢弃。
 * （根治"缺/多字段时解析退化"缺陷族——瑶光在自封胶囊时亲历过。）
 */
function parseCapsuleTag(md: string): ParsedTag | null {
  const openRe = /<seed-capsule\b([^>]*)>/
  const match = md.match(openRe)
  if (!match) return null

  const attrs = match[1] ?? ''
  const attr = (name: string): string | undefined => {
    const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`))
    return m ? m[1] : undefined
  }

  const star = attr('star')
  const sealed = attr('sealed')
  if (!star || !sealed) return null // star + sealed 是必需的最小契约

  const gist = attr('gist')
  const contentStart = match.index! + match[0].length
  const closeTag = '</seed-capsule>'
  const closeIdx = md.indexOf(closeTag, contentStart)
  if (closeIdx === -1) return null

  const content = md.slice(contentStart, closeIdx).trim()
  if (!content) return null

  return { star, sealed, gist, content }
}

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * 加载单个胶囊文档，返回 SeedCapsule 或 null。
 */
function loadCapsuleFile(filePath: string): SeedCapsule | null {
  let md: string
  try {
    md = readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }

  const parsed = parseCapsuleTag(md)
  if (!parsed) return null

  return {
    star: parsed.star,
    sealedAt: parsed.sealed,
    gist: parsed.gist,
    raw: parsed.content,
    block: `<seed-capsule star="${escapeXml(parsed.star)}" sealed="${escapeXml(parsed.sealed)}">
${escapeXml(parsed.content)}
</seed-capsule>`,
  }
}

/**
 * 缓存：`(cwd, 信任态)` → 已加载的胶囊列表。多槽 Map（而非单槽 cachedCwd），
 * 这样并发 worktree / 多会话在不同 cwd 间交替时不会互相清空缓存（单槽会反复
 * 重读 docs/）；key 并入信任态（`\0T` / `\0U`），/trust 切换后自动重载，
 * 不让陈旧结果跨信任态泄漏。
 */
const capsuleCacheByCwd = new Map<string, SeedCapsule[]>()

/**
 * 定位随安装包 ship 的胶囊目录：tsup 在构建后把 docs/seed-capsule-*.md 拷进
 * dist/seed-capsules/，使 npm / 桌面端用户开箱即用（他们的安装目录旁没有 docs/）。
 * 相对本模块 URL 解析并带上一级兜底；源码/dev(tsx) 未构建 → 返回 null，
 * 此时胶囊仅来自项目 <cwd>/docs（且仅项目已授信时——见 loadAllCapsules 信任门）。
 * 镜像 skill-loader.bundledSkillsDir()。
 */
function bundledCapsulesDir(): string | null {
  let base: string
  try {
    base = dirname(fileURLToPath(import.meta.url))
  } catch {
    return null
  }
  for (const candidate of [join(base, 'seed-capsules'), join(base, '..', 'seed-capsules')]) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return null
}

/** 从单个目录收集 seed-capsule-*.md 到 into（按文件名 key，后写入者覆盖同名项）。 */
function collectCapsulesFrom(dir: string, into: Map<string, SeedCapsule>): void {
  if (!existsSync(dir)) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!CAPSULE_GLOB.test(entry)) continue
    const capsule = loadCapsuleFile(join(dir, entry))
    if (capsule) into.set(entry, capsule)
  }
}

/**
 * 按目录顺序收集胶囊：靠后的目录按**文件名**覆盖靠前的（项目可覆盖同名内置胶囊）。
 * 结果按 sealedAt 排序（最早在前，稳定顺序）。纯函数，便于单测。
 */
export function collectCapsules(dirs: string[]): SeedCapsule[] {
  const byFile = new Map<string, SeedCapsule>()
  for (const dir of dirs) collectCapsulesFrom(dir, byFile)
  return [...byFile.values()].sort((a, b) => a.sealedAt.localeCompare(b.sealedAt))
}

/**
 * 发现并加载所有 seed-capsule-*.md 胶囊。来源合并（靠后按文件名覆盖靠前）：
 *   1. 随安装包 ship 的 dist/seed-capsules/（内置，低优先——让装了包的用户可用；
 *      恒加载，与项目信任无关）
 *   2. 项目 <cwd>/docs/（仓库内 / 项目自定义，高优先——同名覆盖内置；**仅项目已授信时**）
 * 结果按 sealedAt 排序；按 (cwd, 信任态) 缓存在内存中（胶囊静态，session 内不重读；
 * 信任态进 key 保证 /trust 切换后自动重载）。
 *
 * 信任门（2026-10-09 安全审计补门族）：项目 docs/ 是**随仓库分发**的内容，与
 * .rivet 状态面同属「未授信不读不注入」的对象；未授信且存在胶囊文件时发一次性
 * 提示（静默失效即缺陷，与 projectStateAllowed 同契约）。门下沉在本函数内，
 * renderResidentCapsuleBlock / getCapsuleByStar / listCapsuleStars / extractPrinciples
 * 四个消费出口自动过门（防新调用点漏）。
 */
export function loadAllCapsules(cwd: string): SeedCapsule[] {
  const trusted = isProjectTrusted(cwd)
  const cacheKey = `${cwd}\0${trusted ? 'T' : 'U'}`
  const cached = capsuleCacheByCwd.get(cacheKey)
  if (cached) return cached

  const dirs: string[] = []
  const bundled = bundledCapsulesDir()
  if (bundled) dirs.push(bundled)
  if (trusted) {
    dirs.push(join(cwd, 'docs'))
  } else if (hasProjectCapsuleFiles(cwd)) {
    notifyUntrustedOnce('capsules', cwd)
  }

  const capsules = collectCapsules(dirs)
  capsuleCacheByCwd.set(cacheKey, capsules)
  return capsules
}

/** cwd/docs 下是否存在 seed-capsule-*.md（未授信时决定是否发提示；任何异常按不存在处理）。 */
function hasProjectCapsuleFiles(cwd: string): boolean {
  try {
    return readdirSync(join(cwd, 'docs')).some(entry => CAPSULE_GLOB.test(entry))
  } catch {
    return false
  }
}

/**
 * 将所有已加载的胶囊合并渲染为一个 volatile block。
 * 返回合并后的 XML 片段，或 undefined（无胶囊时）。
 */
export function renderAllCapsulesBlock(cwd: string): string | undefined {
  const capsules = loadAllCapsules(cwd)
  if (capsules.length === 0) return undefined
  return capsules.map(c => c.block).join('\n\n')
}

/**
 * 所有星域胶囊均改为 recall-only：主控冻结前缀只挂 gist 一行索引，
 * 完整正文经 recall_capsule(star) 按需拉取。
 * 天璇的换视角核心思维已蒸馏进 static.ts BASE_PROMPT，天权的规划原则
 * 已由 evidence-scope / workflow 规则覆盖，CORE_GUARDRAILS 的 5 条护栏
 * 已由 evidence-scope（含原 self-verification / cross-layer 证据内核）/
 * external-source-verification / delivery-contract 覆盖。
 * 不再在冻结前缀常驻任何胶囊全文或护栏——省 ~6K tokens。
 */

export function renderResidentCapsuleBlock(cwd: string, limit?: number): string | undefined {
  return renderCapsuleIndexBlock(cwd, limit)
}

/**
 * 渲染**极小的 L1 索引**（仅星名 + gist 一行），用于注入冻结前缀。
 * 替代 renderAllCapsulesBlock 的全文注入：膨胀从"每星一胶囊"降到"每星一行"，
 * 稳定、可缓存、可无限加星。完整正文经 recall_capsule 工具按需拉取
 * （落在工具结果通道 = anchor 之后，cache-safe，不篡改冻结前缀）。
 *
 * @param limit lean 档下只展开前 N 条 gist（sealedAt 稳定序，不引入新排序）。
 *   被略去的星**仍列出星名**——丢的是摘要，不是可发现性；模型照样知道
 *   该 recall 谁。若连星名都省掉，recall_capsule 就成了盲调。
 */
export function renderCapsuleIndexBlock(cwd: string, limit?: number): string | undefined {
  const capsules = loadAllCapsules(cwd)
  if (capsules.length === 0) return undefined

  const full = renderIndex(capsules, capsules.length)
  if (limit === undefined || limit <= 0 || limit >= capsules.length) return full

  // 省不下就不截：胶囊少或 gist 短时，「其余 N 位」尾行会比省掉的那几行更长。
  // 没有这道闸，lean 档在小仓库下会比 standard 还胖。
  const truncated = renderIndex(capsules, limit)
  return truncated.length < full.length ? truncated : full
}

function renderIndex(capsules: readonly SeedCapsule[], shownCount: number): string {
  const shown = capsules.slice(0, shownCount)
  const lines = shown.map(c => `  ${c.star} — ${c.gist ?? '（无摘要）'}`)
  if (shown.length < capsules.length) {
    const rest = capsules.slice(shownCount).map(c => c.star).join(' / ')
    lines.push(`  其余 ${capsules.length - shown.length} 位（${rest}）经 recall_capsule 取摘要与全文。`)
  }
  return [
    '<seed-capsules note="前辈星域封存的方法索引。需要某位的完整原则时调用 recall_capsule(star)。">',
    ...lines,
    '任务涉及规划/审查/验证/勘探/调校时，调用 recall_capsule(星名) 获取完整方法论。',
    '</seed-capsules>',
  ].join('\n')
}

/** 按星名取单个胶囊的完整 XML 块（供 recall_capsule 工具按需拉取）。 */
export function getCapsuleByStar(cwd: string, star: string): SeedCapsule | undefined {
  const q = star.trim().toLowerCase()
  return loadAllCapsules(cwd).find(c => c.star.toLowerCase() === q)
}

/** 已加载胶囊的星名列表（供工具枚举可选值 / 模糊匹配兜底）。 */
export function listCapsuleStars(cwd: string): string[] {
  return loadAllCapsules(cwd).map(c => c.star)
}

// ─── Phase 2: Principle Extraction ─────────────────────────────

export interface ExtractedPrinciple {
  key: string
  maxim: string
  actionPrompt: string
}

const PRINCIPLE_RE = /<principle\s+key="([^"]+)"\s+action="([^"]+)">([^<]+)<\/principle>/g

/**
 * 从胶囊 raw 文本中提取 <principle> 标记的原则条目。
 * 标签格式：<principle key="Y1" action="动作提示">格言</principle>
 * 返回空数组当无标签时（调用方应 fallback 到硬编码池）。
 */
export function extractPrinciplesFromRaw(raw: string): ExtractedPrinciple[] {
  const results: ExtractedPrinciple[] = []
  let m: RegExpExecArray | null
  const re = new RegExp(PRINCIPLE_RE.source, PRINCIPLE_RE.flags)
  while ((m = re.exec(raw)) !== null) {
    results.push({
      key: m[1]!,
      actionPrompt: m[2]!,
      maxim: m[3]!.trim(),
    })
  }
  return results
}

/**
 * 按星名从胶囊文档中提取原则池。
 * 返回 null 当胶囊不存在或无 <principle> 标签时。
 */
export function extractPrinciples(cwd: string, star: string): ExtractedPrinciple[] | null {
  const capsule = getCapsuleByStar(cwd, star)
  if (!capsule) return null
  const principles = extractPrinciplesFromRaw(capsule.raw)
  return principles.length > 0 ? principles : null
}

/** 清除缓存（主要用于测试） */
export function clearCapsuleCache(): void {
  capsuleCacheByCwd.clear()
}
