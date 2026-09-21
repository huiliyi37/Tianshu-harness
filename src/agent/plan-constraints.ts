/**
 * D8 计划约束自动注入 — 从计划文档解析「反目标/非目标/不做的事」与「待验证假设」，
 * 派发 worker 时自动成为 WorkOrder.constraints 条目（L2）。L1（工单约束通道）是
 * 地基；本模块在其上补计划级广播：哪条约束该给哪个 worker 是后续问题，本轮只做
 * 计划级注入。不广播 taskContract.constraints（那是 task-contract.ts 用
 * CONSTRAINT_MARKER_PATTERN 从用户散文按分句抽的噪声源），计划约束另起字段。
 *
 * 两个形态（12 份计划语料实测，加粗标签才是主流）：
 * - 标题形态：`## 反目标` / `### 待验证假设` 等精确章节名（2-6 级标题）
 * - 加粗标签形态：`**非目标**` / `**待验证假设：**`——只认精确标签名，不含糊匹配
 *   「假设」两字，否则 `### 假设 1：「…」` 会把整段方案论证拖进 worker 提示词。
 *
 * 五个入口：
 * - extractPlanConstraints(markdown)：从 markdown 解析（标题 + 加粗两种形态）
 * - renderPlanConstraints(items, planRef?)：渲染为 ≤MAX_TASK_CONSTRAINT_CHARS 的约束行
 * - resolvePlanConstraints(cwd, src)：来源解析链（markdown → planPath → objective 的
 *   .md → fromContract → 最近 APPROVED 计划），全程 fail-open
 * - findApprovedPlanConstraints(cwd)：从最近 APPROVED 计划提取（零接线回退）
 *
 * 纪律：任何截断都必须带指针（`…（全文见 …）`），不留无声截断——work-order.ts 的
 * withTaskConstraints 会再 `.slice(0, MAX_TASK_CONSTRAINT_CHARS)` 无声切一刀，
 * 渲染器必须自己保证产出 ≤ 上限，否则又是一次「截断了但看起来完整」。
 */

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { validatePathSafe } from '../tools/path-validate.js'
import { listPlansSync } from '../plan/plan-store.js'
import { MAX_TASK_CONSTRAINT_CHARS } from './work-order.js'

export type PlanConstraintKind = 'anti-goal' | 'constraint' | 'assumption'

export interface PlanConstraint {
  kind: PlanConstraintKind
  /** 原文条目，未加前缀未截断 */
  text: string
  /** 命中的章节名，超长条目的指针要用 */
  section: string
}

/** 章节头（中英双语，2-6 级标题）。结尾允许 `（…）` 括号补充（语料里有
 *  `## 回归清单（重构类）` 这种），但**不允许任意后缀**——否则 `### 无法复现的项
 *  （降级为待验证假设）` 会命中。不能用 `\b` 锚定 CJK 变体（CJK 字符非 \w），
 *  直接行尾 `$`（与 regression-inventory.ts 的 INVENTORY_HEADING_RE 同一坑）。 */
const HEADING_RE = /^(反目标|非目标|不做的事|待验证假设|anti-?goals?|non-?goals?|assumptions?)\s*(?:[（(].*)?$/i

/** 加粗标签形态：`**非目标** 不动 X`（同行余下即一条），或 `**待验证假设**` 后跟列表
 *  （到下一个加粗标签行或任意标题终止）。「约束」标签只在加粗形态出现——标题名单无它。 */
const BOLD_RE = /^\*\*(反目标|非目标|不做的事|待验证假设|约束)[：:]*\*\*\s*[：:]?\s*(.*)$/

/** 列表条目：`- item` / `* item` / `- [ ] item` / `1. item`。
 *  与 regression-inventory.ts 同源，但**项目符号后强制要求空白**（markdown 本就如此）：
 *  松散的 `[-*]\s*` 会把 `---` 分割线吃成条目 `--`，把 `**技术栈：** …` 的第一个 `*`
 *  当成项目符号、吐出残缺的 `*技术栈：** …`。两者都会逐字进 worker 提示词。 */
const LIST_ITEM_RE = /^\s*(?:[-*]\s+(?:\[[ xX]\]\s*)?|\d+\.\s+)(.+)$/

/** 分割线：`---` / `***` / `- - -`。是章节边界，不是列表条目。 */
const THEMATIC_BREAK_RE = /^([-*_])(?:\s*\1){2,}$/

/** 任意加粗开头的行。未命中 BOLD_RE 的（`**技术栈：**` 之类）不是约束，但同样是
 *  加粗列表的终止边界——否则它后面的列表会继续算在上一个加粗标签名下。 */
const BOLD_LINE_RE = /^\*\*/

/** objective 里的 .md 路径 token。排除尖括号/引号/反引号包裹（`<abs/path.md>` 取内层）。 */
const MD_TOKEN_RE = /([^\s<>"'`]+\.md)/g

/** 单文件大小上限：超过视为噪声/产物，跳过（advisory）。 */
const MAX_PLAN_BYTES = 512 * 1024

function kindForWord(word: string): PlanConstraintKind {
  const w = word.toLowerCase()
  if (w === '待验证假设' || w === 'assumption' || w === 'assumptions') return 'assumption'
  return 'anti-goal'
}

function kindForBoldWord(word: string): PlanConstraintKind {
  if (word === '待验证假设') return 'assumption'
  // `**约束**` 是实现约束（「通过 RIVET_X=0 可关闭」），不是反目标。混进 anti-goal
  // 会给 worker 打上「计划反目标」的禁令前缀，把要做的事说成不要做的事。
  if (word === '约束') return 'constraint'
  return 'anti-goal'
}

/**
 * 从计划 markdown 提取反目标与待验证假设条目（标题形态 + 加粗标签形态，两者都收）。
 * 标题章节以同级或更高级标题结束；加粗列表到下一个加粗标签行或任意标题结束。
 * 无章节 / 只有标题没有列表均返回空数组（fail-open，绝不拦派发）。
 */
export function extractPlanConstraints(markdown: string): PlanConstraint[] {
  if (!markdown) return []
  const items: PlanConstraint[] = []
  const push = (kind: PlanConstraintKind, text: string, section: string) => {
    const trimmed = text.trim()
    if (trimmed) items.push({ kind, text: trimmed, section })
  }

  // 当前收集状态：标题章节与加粗列表互斥，任一存在时列表行归它。
  let heading: { kind: PlanConstraintKind; level: number; section: string } | null = null
  let bold: { kind: PlanConstraintKind; section: string } | null = null

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    // 任意标题：终止加粗列表；命中章节名的进入标题收集，同级或更高级标题终止标题收集。
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      bold = null
      const level = headingMatch[1]!.length
      const title = headingMatch[2]!.trim()
      const hit = title.match(HEADING_RE)
      if (hit) {
        heading = { kind: kindForWord(hit[1]!), level, section: title }
      } else if (heading && level <= heading.level) {
        heading = null
      }
      continue
    }
    // 分割线是章节边界，不是列表条目——同时终止加粗列表。
    if (THEMATIC_BREAK_RE.test(line)) {
      bold = null
      continue
    }
    // 加粗标签：同行有内容即一条；无内容进入列表收集（下一个加粗标签或任意标题终止）。
    const boldMatch = line.match(BOLD_RE)
    if (boldMatch) {
      const kind = kindForBoldWord(boldMatch[1]!)
      const rest = boldMatch[2]!.trim()
      bold = rest ? null : { kind, section: boldMatch[1]! }
      if (rest) push(kind, rest, boldMatch[1]!)
      continue
    }
    // 未命中标签名的加粗行同样终止加粗列表，且绝不当成列表条目。
    if (BOLD_LINE_RE.test(line)) {
      bold = null
      continue
    }
    const listMatch = line.match(LIST_ITEM_RE)
    if (listMatch && listMatch[1]!.trim()) {
      const text = listMatch[1]!.trim()
      if (bold) push(bold.kind, text, bold.section)
      else if (heading) push(heading.kind, text, heading.section)
    }
  }
  return items
}

/** 计划级约束渲染前缀的公共前缀——消费侧用它嗅探 request.constraints 是否已含
 *  计划级条目，避免兜底注入冲突。改 PREFIX_BY_KIND 时此常量须同步更新。 */
export const PLAN_CONSTRAINT_PREFIX = '[计划'

const PREFIX_BY_KIND: Record<PlanConstraintKind, string> = {
  'anti-goal': `${PLAN_CONSTRAINT_PREFIX}反目标] `,
  constraint: `${PLAN_CONSTRAINT_PREFIX}约束] `,
  assumption: `${PLAN_CONSTRAINT_PREFIX}待验证假设·执行期先验证] `,
}

/** 句末标点（截断落点）。 */
const SENTENCE_END_RE = /[。．.！!？?]/g

/** 超长条目带指针截断：textBudget 内找最后一个句末标点，接 `…（全文见 …「章节」）`；
 *  找不到句末标点按字符截断，指针照加——任何截断都必须带指针，不留无声截断。 */
function truncateWithPointer(text: string, section: string, planRef: string | undefined, budget: number): string {
  const pointer = `…（全文见 ${planRef ?? '计划'}「${section}」）`
  const textBudget = Math.max(8, budget - pointer.length)
  if (text.length <= textBudget) return text
  let cut = -1
  for (const m of text.slice(0, textBudget).matchAll(SENTENCE_END_RE)) {
    cut = m.index! + 1
  }
  if (cut < 0) cut = textBudget
  return text.slice(0, cut) + pointer
}

/** 渲染约束行：anti-goal → constraint → assumption（禁令最硬，待验证项最软），稳定
 *  排序保持组内原文顺序。每条保证 前缀+正文 ≤ MAX_TASK_CONSTRAINT_CHARS（超长带指针
 *  截断）。去重与总数封顶交给下游 withTaskConstraints，渲染器不重复实现。 */
export function renderPlanConstraints(items: readonly PlanConstraint[], planRef?: string): string[] {
  const rank: Record<PlanConstraintKind, number> = { 'anti-goal': 0, constraint: 1, assumption: 2 }
  const sorted = [...items].sort((a, b) => rank[a.kind] - rank[b.kind])
  return sorted.map(item => {
    const prefix = PREFIX_BY_KIND[item.kind]
    return prefix + truncateWithPointer(item.text, item.section, planRef, MAX_TASK_CONSTRAINT_CHARS - prefix.length)
  })
}

export interface PlanConstraintSource {
  /** 显式正文，team 手上那份 */
  markdown?: string
  /** 显式路径，galaxy 新增参数 / team 的 planPath */
  planPath?: string
  /** 派发目标文本，用于识别其中的 .md 路径 */
  objective?: string
  /** 会话契约里已渲染好的条目 */
  fromContract?: readonly string[]
  /** 显式计划全文指针（会话契约里的 planRef）——截断指针的优先来源。 */
  planRef?: string
}

/** 计划契约解析结果：约束行 + 可读的计划全文指针（同源派生，避免两处口径）。 */
export interface ResolvedPlanContract {
  /** 渲染好的约束行（计划级，含 [计划…] 指纹） */
  constraints: string[]
  /** 计划全文的 cwd 相对路径（worker 可直接 read_file）；无文件来源时缺席 */
  planRef?: string
}

/** 路径在 cwd 内时给出 POSIX 相对路径；在 cwd 外返回 undefined（不把机器路径泄进 prompt）。 */
function relativeRef(cwd: string, absPath: string): string | undefined {
  const rel = relative(cwd, absPath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return rel.split(sep).join('/')
}

/**
 * 计划全文指针解析（契约传导回流 D1）：输入可以是 ① 项目内的显式相对/绝对路径
 * （含 `.rivet/plans/x.md` 这种）；② 裸 slug（自动落到 `.rivet/plans/<slug>.md`，
 * 无后缀也认）。
 *
 * 返回**可读的 cwd 相对路径**，且必须真实存在（statSync isFile）——指不到的指针
 * 比没有指针更糟：worker 会以为能读全文却 read_file 失败。越界路径（`../`、
 * cwd 外绝对路径）一律 undefined。
 */
export function planRefFor(cwd: string, slugOrPath: string): string | undefined {
  const trimmed = slugOrPath.trim()
  if (!trimmed) return undefined
  const candidates = trimmed.includes('/') || trimmed.includes('\\')
    ? [trimmed]
    : trimmed.endsWith('.md')
      ? [`${PLANS_DIR}/${trimmed}`]
      : [`${PLANS_DIR}/${trimmed}.md`, `${PLANS_DIR}/${trimmed}`]
  for (const candidate of candidates) {
    const validated = validatePathSafe(cwd, candidate)
    if (!validated.ok) continue
    try {
      if (!statSync(validated.path).isFile()) continue
    } catch {
      continue
    }
    const ref = relativeRef(cwd, validated.path)
    if (ref) return ref
  }
  return undefined
}

/** 读路径 → 解析 → 渲染（连同可读指针一起返回）。路径经 validatePathSafe 校验
 *  （绝对路径落在 cwd 内也放行），不存在 / 非文件 / 超 512KB / 越界一律返回空，
 *  绝不抛错。 */
function readPlanAndRenderContract(cwd: string, pathToken: string): ResolvedPlanContract {
  const validated = validatePathSafe(cwd, pathToken)
  if (!validated.ok) return { constraints: [] }
  let stat
  try {
    stat = statSync(validated.path)
  } catch {
    return { constraints: [] }
  }
  if (!stat.isFile() || stat.size > MAX_PLAN_BYTES) return { constraints: [] }
  let content = ''
  try {
    content = readFileSync(validated.path, 'utf-8')
  } catch {
    return { constraints: [] }
  }
  // 指针用**可读相对路径**渲染（不再是调用方给的裸 token——那正是 D1 的断点：
  // loop 传 `<slug>.md`、markdown 分支干脆不传，worker 都读不到全文）。
  const planRef = relativeRef(cwd, validated.path)
  return { constraints: renderPlanConstraints(extractPlanConstraints(content), planRef), ...(planRef ? { planRef } : {}) }
}

/**
 * 来源解析链：markdown → planPath → objective 里的 .md → fromContract →
 * 最近 APPROVED 计划。任一级产出非空即返回，不合并（合并会让同一份计划的条目在
 * 两级各来一遍）。RIVET_PLAN_CONSTRAINTS=0 时恒返回 []。整个函数 fail-open：
 * 任何异常返回 []——解析失败、路径不存在、章节缺席一律降级为空，绝不拦派发。
 */
export function resolvePlanConstraints(cwd: string, src: PlanConstraintSource): string[] {
  return resolvePlanContract(cwd, src).constraints
}

/**
 * 约束 + 可读指针的同源解析（契约传导回流 D1）。链与旧版一致：markdown →
 * planPath → objective 里的 .md → fromContract → 最近 APPROVED 计划，任一级
 * 产出非空即止（不合并，避免同一份计划在两处各来一遍）。区别只在于**同时**
 * 把「这一级用的是哪个文件」作为可读 planRef 透出——worker 的全文指针与约束
 * 出自同一来源，不会出现「约束来自 A 计划、指针指向 B」。
 *
 * 指针优先级：显式 src.planRef（会话契约里存的，经 planRefFor 校验）> 实际读到的
 * 文件路径。markdown / fromContract / approved 回退这几级没有单一文件归属时
 * planRef 缺席（宁缺勿错——指不到的指针比没有更糟）。
 */
export function resolvePlanContract(cwd: string, src: PlanConstraintSource): ResolvedPlanContract {
  const noRef: ResolvedPlanContract = { constraints: [] }
  if (process.env.RIVET_PLAN_CONSTRAINTS === '0') return noRef
  const explicitRef = src.planRef ? planRefFor(cwd, src.planRef) : undefined
  const withRef = (c: ResolvedPlanContract): ResolvedPlanContract => (explicitRef ? { ...c, planRef: explicitRef } : c)
  try {
    if (src.markdown) {
      const rendered = renderPlanConstraints(extractPlanConstraints(src.markdown), explicitRef)
      if (rendered.length > 0) return withRef({ constraints: rendered })
    }
    if (src.planPath) {
      const contract = readPlanAndRenderContract(cwd, src.planPath)
      if (contract.constraints.length > 0) return withRef(contract)
    }
    if (src.objective) {
      const seen = new Set<string>()
      for (const raw of src.objective.matchAll(MD_TOKEN_RE)) {
        const token = raw[1]!.trim().replace(/[.,;:)\]}>]+$/, '')
        if (!token || seen.has(token)) continue
        seen.add(token)
        const contract = readPlanAndRenderContract(cwd, token)
        if (contract.constraints.length > 0) return contract
      }
    }
    if (src.fromContract && src.fromContract.length > 0) return withRef({ constraints: [...src.fromContract] })
    const approved = findApprovedPlanConstraints(cwd)
    if (approved && approved.length > 0) return withRef({ constraints: approved })
    return explicitRef ? { constraints: [], planRef: explicitRef } : noRef
  } catch {
    return explicitRef ? { constraints: [], planRef: explicitRef } : noRef
  }
}

/** `.rivet/plans` 相对项目根目录的路径——与 plan-store.ts 的 PLANS_DIR 同源。 */
const PLANS_DIR = '.rivet/plans'

/** findApprovedPlanConstraints 缓存条目。 */
interface ApprovedPlanCacheEntry {
  /** 缓存值：undefined = 「无 approved 计划」也是可缓存答案。 */
  value: string[] | undefined
  /** 写入时刻（epoch ms），TTL 失效判据。 */
  at: number
  /** 缓存时的 .rivet/plans 目录 mtimeMs；目录不存在时为 -1。 */
  dirMtimeMs: number
}

/**
 * 按 cwd 的模块级缓存（delegateBatch 循环体每个工单调一次，starflow 一次完整
 * 流程十几到二十几个工单；192 份计划 / 2.2MB 实测 listPlansSync 117ms）。
 *
 * 双重失效：目录 mtime（新增/删除计划文件立即失效，成本 0.012ms）+ TTL
 * （approvePlan 原地改写文件内容不更新父目录 mtime，靠 TTL 兜住——本特性
 * advisory，几秒陈旧无害，工单风暴在毫秒级窗口内）。目录不存在也缓存
 * 「无计划」答案（dirMtimeMs=-1），别每次重试。
 */
const approvedPlanCache = new Map<string, ApprovedPlanCacheEntry>()
const APPROVED_PLAN_CACHE_TTL_MS = 5000

/** 测试用：清空 findApprovedPlanConstraints 缓存（模块级状态必须可复位）。 */
export function resetApprovedPlanCache(): void {
  approvedPlanCache.clear()
}

/** 从最近的 APPROVED 计划提取计划约束（executed/rejected 不算——已交付或已弃）。
 *  零接线回退：无显式源时用它。任何异常返回 undefined（advisory，绝不阻断派发）。 */
export function findApprovedPlanConstraints(cwd: string): string[] | undefined {
  try {
    let dirMtimeMs = -1
    try {
      dirMtimeMs = statSync(join(cwd, PLANS_DIR)).mtimeMs
    } catch {
      // 目录不存在：mtime 记 -1，「无计划」同样进缓存，避免每次重试。
    }
    const now = Date.now()
    const cached = approvedPlanCache.get(cwd)
    if (cached && now - cached.at < APPROVED_PLAN_CACHE_TTL_MS && cached.dirMtimeMs === dirMtimeMs) {
      return cached.value
    }
    const approved = listPlansSync(cwd).filter(p => p.status === 'approved')
    const value = approved.length === 0
      ? undefined
      // listPlansSync 已按 createdAt 降序 — 取最新的 approved。
      : (() => {
          const rendered = renderPlanConstraints(extractPlanConstraints(approved[0]!.content))
          return rendered.length > 0 ? rendered : undefined
        })()
    approvedPlanCache.set(cwd, { value, at: now, dirMtimeMs })
    return value
  } catch {
    return undefined
  }
}

/**
 * 从 UnifiedPlan 契约提取计划约束（starflow / team 的 planJson 来源，D8 计划级
 * 通道）：nonGoals → anti-goal；obligations 中 deferred_decision /
 * high_risk_mitigation → constraint（advisory_gate 跳过——它带 gate 命令走
 * verification 通道）。参数用结构化类型，不 import unified-plan.ts（避免反向依赖）。
 */
export function constraintsFromUnifiedPlan(src: {
  nonGoals?: string[]
  assumptions?: string[]
  obligations?: { kind: string; text: string }[]
}): string[] {
  const items: PlanConstraint[] = []
  for (const raw of src.nonGoals ?? []) {
    const text = raw.trim()
    if (text) items.push({ kind: 'anti-goal', text, section: 'nonGoals' })
  }
  // D4：待验证假设的结构化载体（UnifiedPlan.assumptions → assumption 种类，
  // 渲染指纹 [计划待验证假设·执行期先验证]——告诉 worker「先验证再执行」）。
  for (const raw of src.assumptions ?? []) {
    const text = raw.trim()
    if (text) items.push({ kind: 'assumption', text, section: 'assumptions' })
  }
  for (const ob of src.obligations ?? []) {
    if (ob.kind === 'advisory_gate') continue
    const text = ob.text.trim()
    if (text) items.push({ kind: 'constraint', text, section: `obligations.${ob.kind}` })
  }
  return renderPlanConstraints(items)
}
