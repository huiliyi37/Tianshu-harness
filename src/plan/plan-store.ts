/**
 * Plan Store — 计划文件持久化 (.rivet/plans/*.md)
 *
 * 职责：
 * - plan_submit tool 写入计划文件
 * - /plan-approve 列出/读取/批准计划
 * - 批准的 plan 载入 volatile context 供 agent 执行
 */

import { mkdir, readdir, readFile, stat, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'

export interface PlanDocument {
  /** 文件名 slug (不含 .md) */
  slug: string
  /** 计划标题（从 markdown H1 提取） */
  title: string
  /** 完整 markdown 内容 */
  content: string
  /** 文件路径（相对于 project root） */
  path: string
  /** 创建时间 */
  createdAt: Date
  /** 状态 */
  status: 'submitted' | 'approved' | 'executed' | 'rejected'
  /** 批准时间 */
  approvedAt?: Date
  /** 多方案选项（submit 时持久化） */
  options?: PlanOption[]
  /** 产出模型留痕（submit 时写入）。缺失 = 旧计划或未知模型。 */
  model?: string
  /** 产出模型 tier（名字推断）。中性留痕元数据，不驱动任何差异化提示。 */
  modelTier?: 'cheap' | 'balanced' | 'strong' | null
}

export interface PlanOption {
  label: string
  description: string
}

// \r?\n（而非入口归一化）：此 regex 还用于 replace 回写文件，归一化会改动
// 用户文件的换行风格。
const PLAN_OPTIONS_FRONTMATTER_RE = /^---\r?\nrivet-options:\s*(\[[\s\S]*?\])\s*\r?\n---\r?\n/

/** approve/reject 写入的状态标记行（H1 前）。 */
const PLAN_STATUS_LINE_RE = /^>\s*\*\*Status:\s*(?:APPROVED|REJECTED|EXECUTED)\*\*.*(?:\r?\n)+/gm

/**
 * 剥离 approve/reject 留下的状态标记行。重新提交（尤其是省略 plan 字段、
 * 从活动计划文件整读的路径）时必须清掉，否则旧的 REJECTED 标记会让
 * 新提交被 parsePlanStatus 误判为 rejected，从待批准列表里消失。
 */
export function stripPlanStatusMarkers(content: string): string {
  return content.replace(PLAN_STATUS_LINE_RE, '')
}

/** plan submit 写入的产出模型留痕行（H1 前，与 Status 标记同款）。 */
const PLAN_MODEL_LINE_RE = /^>\s*\*\*Model:\s*(.+?)(?:\s*\((cheap|balanced|strong)\))?\*\*.*(?:\r?\n)+/m

export interface PlanModelProvenance {
  model: string
  tier: 'cheap' | 'balanced' | 'strong' | null
}

/** 解析计划的产出模型留痕。无标记（旧计划）返回 undefined。 */
export function parsePlanModel(content: string): PlanModelProvenance | undefined {
  const m = content.match(PLAN_MODEL_LINE_RE)
  if (!m) return undefined
  return { model: m[1]!.trim(), tier: (m[2] as PlanModelProvenance['tier']) ?? null }
}

/**
 * 写入/刷新产出模型留痕（幂等：先剥旧标记再插入）。放 H1 前，
 * 与 Status 标记同一可视位置——审批人在计划正文里直接看到产出模型。
 */
export function insertPlanModelMarker(
  content: string,
  model: string,
  tier: 'cheap' | 'balanced' | 'strong' | null,
): string {
  const stripped = content.replace(new RegExp(PLAN_MODEL_LINE_RE, 'gm'), '')
  const line = `> **Model: ${model}${tier ? ` (${tier})` : ''}**\n\n`
  const h1Match = stripped.match(/^#\s+.*$/m)
  if (h1Match) {
    const idx = stripped.indexOf(h1Match[0])
    return stripped.slice(0, idx) + line + stripped.slice(idx)
  }
  return line + stripped
}

/** .rivet/plans 相对于项目根目录的路径 */
const PLANS_DIR = '.rivet/plans'

/**
 * Plan-mode 活动草稿的 slug 形状（createActivePlanDraftPath 生成
 * `draft-<timestamp>.md`，loop 的清理正则同源）。草稿是规划中的工作文件，
 * 不是已提交的计划——listPlans 过滤它们，防止空草稿以 "Untitled Plan"
 * 的形态冒充待审计划泄漏进 TUI/桌面的计划列表。
 */
export function isDraftSlug(slug: string): boolean {
  return /^draft-\d+$/.test(slug)
}

function plansRoot(cwd: string): string {
  return join(cwd, PLANS_DIR)
}

function planFilePath(cwd: string, slug: string): string {
  return join(plansRoot(cwd), `${slug}.md`)
}

/** 确保 .rivet/plans 目录存在 */
async function ensurePlansDir(cwd: string): Promise<void> {
  const dir = plansRoot(cwd)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

/** 从 slug 生成安全文件名 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'plan'
}

/** 从 markdown 内容提取 H1 标题 */
function extractTitle(content: string): string {
  const m = content.match(/^#\s+(.+)$/m)
  return m?.[1]?.trim() || 'Untitled Plan'
}

/** 从计划 frontmatter 解析多方案选项 */
export function parsePlanOptions(content: string): PlanOption[] | undefined {
  const m = content.match(PLAN_OPTIONS_FRONTMATTER_RE)
  if (!m) return undefined
  try {
    const parsed = JSON.parse(m[1]!) as unknown
    if (!Array.isArray(parsed)) return undefined
    const options = parsed.filter(
      (item): item is PlanOption =>
        item !== null
        && typeof item === 'object'
        && typeof (item as PlanOption).label === 'string'
        && typeof (item as PlanOption).description === 'string',
    )
    return options.length > 0 ? options : undefined
  } catch {
    return undefined
  }
}

/**
 * 在方案列表中解析用户输入的方案名。大小写不敏感、忽略首尾空白，
 * 并容忍省略 "(Recommended)" 一类括号后缀。命中时返回规范标签
 * （options 中的原始 label），未命中返回 undefined。
 */
export function resolvePlanOptionLabel(
  options: readonly PlanOption[],
  input: string,
): string | undefined {
  const normalize = (s: string) => s.trim().toLowerCase()
  const stripSuffix = (s: string) => normalize(s).replace(/\s*\([^)]*\)\s*$/, '')
  const wanted = normalize(input)
  const exact = options.find(o => normalize(o.label) === wanted)
  if (exact) return exact.label
  const wantedBare = stripSuffix(input)
  const bareMatches = options.filter(o => stripSuffix(o.label) === wantedBare)
  return bareMatches.length === 1 ? bareMatches[0]!.label : undefined
}

/**
 * 剥离用户从提示行整段复制来的 " — <title>" 后缀。/plan-list 与 /plan-approve
 * 的提示渲染成 `slug — title`，整行复制会把 title 混进参数。用 em-dash（前后带空格）
 * 切分，只取首段 slug 候选；未含分隔符时原样返回（去首尾空白）。
 */
export function stripCopiedTitleSuffix(input: string): string {
  const idx = input.indexOf(' — ')
  return (idx >= 0 ? input.slice(0, idx) : input).trim()
}

/** resolvePlanRef 结果：命中唯一计划 / 多个候选歧义 / 未命中。 */
export type PlanRefResolution =
  | { kind: 'match'; plan: PlanDocument }
  | { kind: 'ambiguous'; slugs: string[] }
  | { kind: 'none' }

/**
 * 在计划列表中解析用户输入的计划标识，容忍复制粘贴与标题近似。
 * 优先级：slug 精确 → slugify(title) 精确 → slug 前缀模糊。
 * 命中唯一返回 match；命中多个返回 ambiguous；都没命中返回 none。
 */
export function resolvePlanRef(
  plans: readonly PlanDocument[],
  input: string,
): PlanRefResolution {
  const stripped = stripCopiedTitleSuffix(input)
  const wanted = stripped.toLowerCase()
  if (!wanted) return { kind: 'none' }
  const exact = plans.find(p => p.slug.toLowerCase() === wanted)
  if (exact) return { kind: 'match', plan: exact }
  const wantedSlug = slugify(stripped)
  const byTitle = plans.filter(p => slugify(p.title) === wantedSlug)
  if (byTitle.length === 1) return { kind: 'match', plan: byTitle[0]! }
  if (byTitle.length > 1) return { kind: 'ambiguous', slugs: byTitle.map(p => p.slug) }
  const prefix = plans.filter(p => p.slug.toLowerCase().startsWith(wanted))
  if (prefix.length === 1) return { kind: 'match', plan: prefix[0]! }
  if (prefix.length > 1) return { kind: 'ambiguous', slugs: prefix.map(p => p.slug) }
  return { kind: 'none' }
}

function buildPlanFrontmatter(options?: readonly PlanOption[]): string {
  if (!options || options.length === 0) return ''
  return `---\nrivet-options: ${JSON.stringify(options)}\n---\n\n`
}

/** 写计划文件。返回写入的文件路径（相对于 cwd） */
export async function writePlan(
  cwd: string,
  slug: string,
  content: string,
  options?: readonly PlanOption[],
): Promise<string> {
  await ensurePlansDir(cwd)
  const filePath = planFilePath(cwd, slug)
  const body = buildPlanFrontmatter(options) + content.replace(PLAN_OPTIONS_FRONTMATTER_RE, '')
  await writeFile(filePath, body, 'utf-8')
  return `${PLANS_DIR}/${slug}.md`
}

/** 读单个计划 */
export async function readPlan(
  cwd: string,
  slug: string,
): Promise<PlanDocument | null> {
  const filePath = planFilePath(cwd, slug)
  try {
    const content = await readFile(filePath, 'utf-8')
    const s = await stat(filePath)
    const status = parsePlanStatus(content)
    const provenance = parsePlanModel(content)
    return {
      slug,
      title: extractTitle(content),
      content,
      path: `${PLANS_DIR}/${slug}.md`,
      createdAt: s.birthtime,
      status,
      options: parsePlanOptions(content),
      ...(provenance ? { model: provenance.model, modelTier: provenance.tier } : {}),
    }
  } catch {
    return null
  }
}

/**
 * 同步读单个计划。供 TUI 渲染 provider（渲染路径不能 await）与
 * readPlanSync 场景使用；语义与 readPlan 一致，仅换 *Sync fs API。
 */
export function readPlanSync(cwd: string, slug: string): PlanDocument | null {
  const filePath = planFilePath(cwd, slug)
  try {
    const content = readFileSync(filePath, 'utf-8')
    const s = statSync(filePath)
    const provenance = parsePlanModel(content)
    return {
      slug,
      title: extractTitle(content),
      content,
      path: `${PLANS_DIR}/${slug}.md`,
      createdAt: s.birthtime,
      status: parsePlanStatus(content),
      options: parsePlanOptions(content),
      ...(provenance ? { model: provenance.model, modelTier: provenance.tier } : {}),
    }
  } catch {
    return null
  }
}

/**
 * 剥掉计划文件里的非正文「chrome」行，返回正文行数组：开头一处
 * frontmatter（--- ... ---，正文中的 --- 分隔线保留）与 `> **Status:`/
 * `> **Model:` 留痕行。审批卡 excerpt 与 pager 全文预览共用此口径。
 */
export function stripPlanChrome(content: string): string[] {
  const rawLines = content.split('\n')
  let start = 0
  if (rawLines[0]?.trim() === '---') {
    const close = rawLines.findIndex((l, i) => i > 0 && l.trim() === '---')
    if (close > 0) start = close + 1
  }
  const out: string[] = []
  for (const raw of rawLines.slice(start)) {
    const t = raw.trim()
    if (t.startsWith('> **Status:') || t.startsWith('> **Model:')) continue
    out.push(raw)
  }
  return out
}

/** 列出所有计划 */
export async function listPlans(cwd: string): Promise<PlanDocument[]> {
  const dir = plansRoot(cwd)
  if (!existsSync(dir)) return []

  const entries = await readdir(dir)
  const plans: PlanDocument[] = []

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const slug = entry.replace(/\.md$/, '')
    if (isDraftSlug(slug)) continue
    const plan = await readPlan(cwd, slug)
    if (plan) plans.push(plan)
  }

  return plans.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

/**
 * 同步列出所有计划。供 TUI overlay 的渲染 provider 使用（渲染路径无法 await
 * 异步 listPlans）。语义与 listPlans 一致，仅换用 *Sync fs API。
 */
export function listPlansSync(cwd: string): PlanDocument[] {
  const dir = plansRoot(cwd)
  if (!existsSync(dir)) return []

  const plans: PlanDocument[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue
    const slug = entry.replace(/\.md$/, '')
    if (isDraftSlug(slug)) continue
    try {
      const filePath = planFilePath(cwd, slug)
      const content = readFileSync(filePath, 'utf-8')
      const s = statSync(filePath)
      const provenance = parsePlanModel(content)
      plans.push({
        slug,
        title: extractTitle(content),
        content,
        path: `${PLANS_DIR}/${slug}.md`,
        createdAt: s.birthtime,
        status: parsePlanStatus(content),
        options: parsePlanOptions(content),
        ...(provenance ? { model: provenance.model, modelTier: provenance.tier } : {}),
      })
    } catch {
      // Skip unreadable entries (mirrors readPlan's swallow-on-error).
    }
  }

  return plans.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

/** 标记计划为已批准（在文件头部插入状态标记） */
export async function approvePlan(cwd: string, slug: string): Promise<PlanDocument | null> {
  return markPlanStatus(cwd, slug, 'APPROVED')
}

/**
 * 拒绝计划:写入 REJECTED 状态标记而非删除文件,保留原稿供 agent 在其上修订。
 * 返回更新后的文档,计划不存在时返回 null。
 */
export async function rejectPlan(cwd: string, slug: string): Promise<PlanDocument | null> {
  return markPlanStatus(cwd, slug, 'REJECTED')
}

/** 在第一个 H1 前插入状态标记，返回更新后的文本（纯函数，无 IO）。
 *  用于 plan_close 直接对已读入的 markdown 打 EXECUTED 标记（含
 *  docs/superpowers/plans 下、无 slug 语义的计划文件）。 */
export function insertPlanStatusMarker(
  content: string,
  status: 'APPROVED' | 'REJECTED' | 'EXECUTED',
): string {
  const statusLine = `> **Status: ${status}** — ${new Date().toISOString()}\n\n`
  const h1Match = content.match(/^#\s+.*$/m)
  if (h1Match) {
    const idx = content.indexOf(h1Match[0])
    return content.slice(0, idx) + statusLine + content.slice(idx)
  }
  return statusLine + content
}

/** 在第一个 H1 前插入状态标记并回写,返回更新后的文档。 */
async function markPlanStatus(
  cwd: string,
  slug: string,
  status: 'APPROVED' | 'REJECTED' | 'EXECUTED',
): Promise<PlanDocument | null> {
  const plan = await readPlan(cwd, slug)
  if (!plan) return null

  const newContent = insertPlanStatusMarker(plan.content, status)

  // 透传 options — writePlan 会剥离旧 frontmatter，不传会把多方案记录抹掉，
  // 导致 approve 后 selectedApproach 校验永远跳过（见 2026-07-03 缺陷复盘）。
  await writePlan(cwd, slug, newContent, plan.options)
  return readPlan(cwd, slug)
}

/** 删除计划 */
export async function deletePlan(cwd: string, slug: string): Promise<boolean> {
  const filePath = planFilePath(cwd, slug)
  try {
    await rm(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * 从计划内容解析状态。
 * 查找 "Status: APPROVED" 等标记。
 */
function parsePlanStatus(content: string): PlanDocument['status'] {
  if (/Status:\s*EXECUTED/i.test(content)) return 'executed'
  if (/Status:\s*APPROVED/i.test(content)) return 'approved'
  if (/Status:\s*REJECTED/i.test(content)) return 'rejected'
  return 'submitted'
}
