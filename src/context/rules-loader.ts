import { isFilesystemMetadata } from '../utils/file-metadata.js'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectSurfaceAllowed } from '../config/project-trust.js'
import type { ClaimProposal } from './claims.js'

const MAX_RULE_LENGTH = 500

export function loadProjectRules(cwd: string): ClaimProposal[] {
  // 未授信项目不载入规则——claim 注入即进模型上下文（2026-10-07 审计 Finding 1c）。
  if (!projectSurfaceAllowed(cwd, 'rules')) return []
  const rulesDir = join(cwd, '.rivet', 'rules')
  if (!existsSync(rulesDir)) return []

  const now = Date.now()
  const proposals: ClaimProposal[] = []

  try {
    const files = readdirSync(rulesDir).filter(f => !isFilesystemMetadata(f) && f.endsWith('.md'))

    for (const file of files) {
      try {
        const content = readFileSync(join(rulesDir, file), 'utf-8').trim()
        if (!content || content.includes('\0')) continue

        proposals.push({
          kind: 'project_rule',
          scope: 'project',
          text: content.slice(0, MAX_RULE_LENGTH),
          confidence: 1.0,
          fitness: 10,
          source: { actor: 'user', sessionId: 'project', turn: 0, eventId: `rules:${file}` },
          evidence: [{ id: `rules:${file}`, kind: 'file', summary: `project rule from .rivet/rules/${file}`, path: join(rulesDir, file), createdAt: now }],
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
