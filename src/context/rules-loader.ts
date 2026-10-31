import { isFilesystemMetadata } from '../utils/file-metadata.js'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { projectSurfaceAllowed } from '../config/project-trust.js'
import type { ClaimProposal } from './claims.js'

const MAX_RULE_LENGTH = 500

/**
 * 软链收容（2026-10-31 审计 Finding 1）：readFileSync 跟随软链——`.rivet/rules/`
 * 下的 .md 或 rules 目录本身指向项目外时，项目外内容会以 confidence 1.0 的
 * project_rule 进入模型上下文。解析后的真实路径必须落在项目根内。
 */
function realPathWithin(root: string, target: string): string | undefined {
  try {
    const real = realpathSync(target)
    const rel = relative(root, real)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
    return real
  } catch {
    return undefined
  }
}

export function loadProjectRules(cwd: string): ClaimProposal[] {
  // 未授信项目不载入规则——claim 注入即进模型上下文（2026-10-07 审计 Finding 1c）。
  if (!projectSurfaceAllowed(cwd, 'rules')) return []
  const rulesDir = join(cwd, '.rivet', 'rules')
  if (!existsSync(rulesDir)) return []
  // 目录级逃逸：目录本身为软链、非目录，或解析后越出项目根 → 整个规则面跳过。
  const dirStat = lstatSync(rulesDir, { throwIfNoEntry: false })
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return []
  let root: string
  try {
    root = realpathSync(cwd)
  } catch {
    return []
  }
  const safeRulesDir = realPathWithin(root, rulesDir)
  if (!safeRulesDir) return []

  const now = Date.now()
  const proposals: ClaimProposal[] = []

  try {
    const files = readdirSync(safeRulesDir).filter(f => !isFilesystemMetadata(f) && f.endsWith('.md'))

    for (const file of files) {
      try {
        const candidate = join(safeRulesDir, file)
        // 文件级逃逸：软链本身（readFileSync 会跟随）或 realpath 落在项目外 → 跳过。
        const fileStat = lstatSync(candidate, { throwIfNoEntry: false })
        if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isFile()) continue
        const realFile = realPathWithin(root, candidate)
        if (!realFile) continue

        const content = readFileSync(realFile, 'utf-8').trim()
        if (!content || content.includes('\0')) continue

        proposals.push({
          kind: 'project_rule',
          scope: 'project',
          text: content.slice(0, MAX_RULE_LENGTH),
          confidence: 1.0,
          fitness: 10,
          source: { actor: 'user', sessionId: 'project', turn: 0, eventId: `rules:${file}` },
          evidence: [{ id: `rules:${file}`, kind: 'file', summary: `project rule from .rivet/rules/${file}`, path: candidate, createdAt: now }],
          createdAt: now,
          tags: ['project_rule', file.replace('.md', '')],
        })
      } catch {
        // skip unreadable rule files
      }
    }
  } catch {
    // readdirSync failed (permissions, etc.)
  }

  return proposals
}
