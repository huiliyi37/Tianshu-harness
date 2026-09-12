#!/usr/bin/env tsx
/**
 * contributors.ts — 贡献者名单（CONTRIBUTORS.md）的生成与对账。
 *
 * ## 为什么数据源不是「合并 PR」
 *
 * 本仓为了让本体代码不被外部贡献改崩，绝大多数外部 PR **不直接 merge**：先在 dev 仓按
 * 当前代码现状重写（收编）→ 验证 → 经 sync 推到公开仓。于是这些 PR 在 GitHub 上的状态是
 * `CLOSED` 而非 `MERGED`。旧脚本 `update-contributors.sh` 只扫 `Merge PR #N` 形式的合并
 * 提交，在这套流程下一条都扫不到，重跑会把整张名单清空（2026-09 实际踩过）。
 *
 * 因此本脚本以 **GitHub PR 列表（全部状态）** 为权威数据源，收编流程只影响「署名」
 * （由 `scripts/credit-contributors.sh` 在公开仓以 Co-authored-by 落账），不影响「上榜」。
 *
 * ## 安全不变量：只增不删
 *
 * 既有条目的 login、人工撰写的「贡献」描述、条目相对顺序，都不被自动流程改写；PR 列表
 * 只做并入（去重升序）。数据源临时不可用时宁可保留陈旧条目，也不静默丢人。
 *
 * ## 用法
 *
 *   tsx scripts/contributors.ts --check   # 只对账：报告未登记的贡献者/PR；有差异退出码 1
 *   tsx scripts/contributors.ts --write   # 合并写回 CONTRIBUTORS.md（保留人工描述）
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export interface ContributorPr {
  number: number
  login: string
  title: string
  state: string
  createdAt: string
}

export interface ContributorEntry {
  login: string
  description: string
  prs: number[]
  /** 该贡献者最早 PR 的创建时间；既有条目在数据源未覆盖时为空。 */
  firstSeen?: string
}

export const CONTRIBUTORS_REPO = 'huiliyi37/Tianshu-harness'
export const REPO_OWNER = 'huiliyi37'

const prUrl = (n: number): string => `https://github.com/${CONTRIBUTORS_REPO}/pull/${n}`

/**
 * 解析 CONTRIBUTORS.md 表格：`| **login** | 描述 | [#N](url), … |`。
 * 描述里的 HTML 注释原样保留（不剥除），否则 render→parse→render 不幂等。
 */
export function parseContributorsMarkdown(md: string): ContributorEntry[] {
  const entries: ContributorEntry[] = []
  for (const rawLine of md.split('\n')) {
    const line = rawLine.trim()
    const m = /^\|\s*\*\*([^*|]+)\*\*\s*\|(.*)\|\s*([^|]*)\|\s*$/.exec(line)
    if (!m) continue
    const login = (m[1] ?? '').trim()
    if (!login) continue
    // 描述列可能含 `|`（表格里罕见），此正则取第一个非贪婪匹配，超出部分归入描述。
    const description = (m[2] ?? '').trim()
    const prs = [...(m[3] ?? '').matchAll(/pull\/(\d+)/g)].map(x => Number(x[1]))
    entries.push({ login, description, prs: [...new Set(prs)].sort((a, b) => a - b) })
  }
  return entries
}

/** 新贡献者的描述初稿：取其 PR 标题拼接（人工后续润色）。 */
function draftDescription(prs: ContributorPr[]): string {
  const titles = prs
    .slice()
    .sort((a, b) => a.number - b.number)
    .map(p => p.title.trim().replace(/\s+/g, ' '))
    .slice(0, 3)
  const joined = titles.join('；')
  return `${joined.length > 160 ? `${joined.slice(0, 160)}…` : joined}（待润色：请人工归纳贡献）`
}

/**
 * 合并：既有条目原地保留（并集 PR），新贡献者按首次贡献时间插入正确位置。
 * 返回新增 login 与每位既有作者新并入的 PR 号，便于打印与审计。
 */
export function mergeContributors(
  existing: ContributorEntry[],
  prs: ContributorPr[],
): { entries: ContributorEntry[]; added: string[]; newPrs: Map<string, number[]> } {
  const byLogin = new Map<string, ContributorPr[]>()
  for (const p of prs) {
    if (!p.login || p.login === REPO_OWNER) continue
    const arr = byLogin.get(p.login) ?? []
    arr.push(p)
    byLogin.set(p.login, arr)
  }

  const merged: ContributorEntry[] = existing.map(e => {
    const found = byLogin.get(e.login) ?? []
    const union = [...new Set([...e.prs, ...found.map(p => p.number)])].sort((a, b) => a - b)
    const firstSeen = found.reduce<string | undefined>(
      (min, p) => (min === undefined || p.createdAt < min ? p.createdAt : min),
      undefined,
    )
    return firstSeen === undefined ? { ...e, prs: union } : { ...e, prs: union, firstSeen }
  })

  const newPrs = new Map<string, number[]>()
  for (const e of merged) {
    const before = existing.find(x => x.login === e.login)?.prs ?? []
    const addedPrs = e.prs.filter(n => !before.includes(n))
    if (addedPrs.length > 0) newPrs.set(e.login, addedPrs)
  }

  const known = new Set(existing.map(e => e.login))
  const additions: ContributorEntry[] = [...byLogin.entries()]
    .filter(([login]) => !known.has(login))
    .map(([login, list]) => ({
      login,
      description: draftDescription(list),
      prs: list.map(p => p.number).sort((a, b) => a - b),
      firstSeen: list.reduce<string>(
        (min, p) => (p.createdAt < min ? p.createdAt : min),
        list[0]?.createdAt ?? '',
      ),
    }))
    .sort((a, b) => ((a.firstSeen ?? '') < (b.firstSeen ?? '') ? -1 : 1))

  // 插入位置：第一个「首次贡献时间更晚」的既有条目之前；既有条目缺 firstSeen 时视为更早，位置不动。
  const out = merged.slice()
  for (const add of additions) {
    const idx = out.findIndex(e => e.firstSeen !== undefined && (add.firstSeen ?? '') < e.firstSeen)
    if (idx === -1) out.push(add)
    else out.splice(idx, 0, add)
  }

  return { entries: out, added: additions.map(a => a.login), newPrs }
}

/** 对账：报告数据源里有、但名单里没有的作者与 PR（`--check` 用）。 */
export function diffContributors(
  existing: ContributorEntry[],
  prs: ContributorPr[],
): { missingLogins: string[]; missingPrs: Array<{ login: string; prs: number[] }> } {
  const external = prs.filter(p => p.login && p.login !== REPO_OWNER)
  const existingLogins = new Set(existing.map(e => e.login))
  const missingLogins = [...new Set(external.map(p => p.login))]
    .filter(login => !existingLogins.has(login))
    .sort()
  const missingPrs: Array<{ login: string; prs: number[] }> = []
  for (const e of existing) {
    const known = new Set(e.prs)
    const miss = external
      .filter(p => p.login === e.login && !known.has(p.number))
      .map(p => p.number)
      .sort((a, b) => a - b)
    if (miss.length > 0) missingPrs.push({ login: e.login, prs: miss })
  }
  return { missingLogins, missingPrs }
}

const FOOTER = (contributors: number, prs: number): string => `
本文件由 \`scripts/contributors.ts\` 生成与对账（\`--check\` 只报告差异；\`--write\` 合并写回）。
共 ${contributors} 位外部贡献者 / ${prs} 个 PR，按首次贡献时间排序。
**「贡献」列由人工撰写，自动流程只增不删**——既有条目、描述与顺序不会被覆盖。
PR 编号以 \`${CONTRIBUTORS_REPO}\` 为准（该仓库由 \`Tianshu-Tui\` 更名而来，历史链接自动重定向）。

> 关于署名：外部 PR 经「收编」流程合入时，作者署名以 commit 的 \`Co-authored-by\` trailer 计入
> 贡献者图谱（\`scripts/credit-contributors.sh\` 在公开仓落账）。部分贡献者在早期提交中使用了
> 另一个账号署名（例如 LinHoMo 的历史提交署名为 \`linskadi\`），亦属同一人，不影响归属。
>
> 为什么外部 PR 多为 CLOSED 却已上榜：本仓不允许外部改动直接落到本体代码，绝大多数 PR 先在
> dev 仓按现状重写（收编）、验证，再经 sync 推到公开仓——PR 本身被 close，代码以另一种形态
> 合入。署名与上榜与 GitHub 的 merge 状态无关。
`

/** 渲染整份 CONTRIBUTORS.md（表结构固定，描述原样输出）。 */
export function renderContributorsMarkdown(entries: ContributorEntry[]): string {
  const totalPrs = new Set(entries.flatMap(e => e.prs)).size
  const rows = entries.map(e => {
    const links = e.prs.map(n => `[#${n}](${prUrl(n)})`).join(', ')
    return `| **${e.login}** | ${e.description} | ${links} |`
  })
  return `# Contributors ✨

感谢以下贡献者（按首次贡献时间排序）：

| 贡献者 | 贡献 | PR |
|--------|------|-----|
${rows.join('\n')}
${FOOTER(entries.length, totalPrs)}`
}

/** 拉取全部 PR（含 CLOSED——收编的 PR 不会被 merge）。gh 不可用时返回 null。 */
export function fetchContributorPrs(): ContributorPr[] | null {
  const r = spawnSync(
    'gh',
    ['pr', 'list', '-R', CONTRIBUTORS_REPO, '--state', 'all', '--limit', '500',
      '--json', 'number,author,title,state,createdAt'],
    { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
  )
  if (r.status !== 0 || !r.stdout) return null
  try {
    const raw = JSON.parse(r.stdout) as Array<{
      number: number
      author: { login?: string } | null
      title: string
      state: string
      createdAt: string
    }>
    return raw
      .filter(x => x.author?.login)
      .map(x => ({
        number: x.number,
        login: x.author?.login ?? '',
        title: x.title,
        state: x.state,
        createdAt: x.createdAt,
      }))
  } catch {
    return null
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const file = join(root, 'CONTRIBUTORS.md')

  const existing = parseContributorsMarkdown(readFileSync(file, 'utf-8'))
  const prs = fetchContributorPrs()
  if (prs === null) {
    const msg = '⚠ 无法获取 GitHub PR 列表（gh 缺失/未认证/网络不可用）——跳过对账'
    if (write) {
      console.error(msg)
      process.exit(1)
    }
    console.warn(`${msg}（--check 不阻塞）`)
    process.exit(0)
  }

  if (write) {
    const { entries, added, newPrs } = mergeContributors(existing, prs)
    writeFileSync(file, renderContributorsMarkdown(entries))
    const mergedPrs = [...newPrs.values()].reduce((n, list) => n + list.length, 0)
    console.log(
      `✓ 已更新 CONTRIBUTORS.md：${entries.length} 位贡献者；`
      + `新增 ${added.length} 位${added.length > 0 ? `（${added.join(', ')}）` : ''}；并入 ${mergedPrs} 个新 PR`,
    )
    if (added.length > 0) console.log('  提示：新条目的「贡献」列是 PR 标题初稿，请人工润色后提交。')
    return
  }

  const { missingLogins, missingPrs } = diffContributors(existing, prs)
  const clean = missingLogins.length === 0 && missingPrs.length === 0
  if (clean) {
    console.log(`✓ CONTRIBUTORS.md 与 GitHub 记录一致（${existing.length} 位贡献者 / ${new Set(existing.flatMap(e => e.prs)).size} 个 PR）`)
    return
  }
  console.error('✗ CONTRIBUTORS.md 与 GitHub 记录不一致：')
  if (missingLogins.length > 0) console.error(`  未登记的贡献者：${missingLogins.join(', ')}`)
  for (const m of missingPrs) console.error(`  ${m.login} 未登记的 PR：${m.prs.map(n => `#${n}`).join(' ')}`)
  console.error('  修复：tsx scripts/contributors.ts --write（随后润色新条目的描述列）')
  process.exit(1)
}

const invoked = process.argv[1] ?? ''
if (/contributors\.(ts|js|mjs)$/.test(invoked)) main()
