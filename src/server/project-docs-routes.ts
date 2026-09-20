/**
 * GET /project-docs?cwd=...  — read the project's AGENTS.md / .rivet.md.
 * PUT /project-docs          — write one or both files and return the updated state.
 *
 * These two files are the prefix cornerstone of the system prompt. The desktop
 * Settings UI exposes them for viewing/editing with a prominent warning that
 * modifying them mid-session fractures the prefix cache.
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { AGENTS_MD_PATH, RIVET_MD_PATH } from '../bootstrap/project-templates.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { isKnownWorkspace, UNKNOWN_WORKSPACE_ERROR } from './workspace-guard.js'

export interface ProjectDocs {
  cwd: string
  agentsMd: string
  rivetMd: string
  agentsExists: boolean
  rivetExists: boolean
}

function assertProjectPath(cwd: string, file: string): string {
  const base = resolve(cwd)
  const target = resolve(base, file)
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escape detected: ${file}`)
  }
  return target
}

function readDoc(cwd: string, file: string): { content: string; exists: boolean } {
  const p = assertProjectPath(cwd, file)
  if (!existsSync(p)) {
    return { content: '', exists: false }
  }
  try {
    return { content: readFileSync(p, 'utf-8'), exists: true }
  } catch (err) {
    throw new Error(`Failed to read ${file}: ${(err as Error).message}`)
  }
}

function writeDoc(cwd: string, file: string, content: string): void {
  const p = assertProjectPath(cwd, file)
  try {
    writeFileSync(p, content, 'utf-8')
  } catch (err) {
    throw new Error(`Failed to write ${file}: ${(err as Error).message}`)
  }
}

function readDocs(cwd: string): ProjectDocs {
  const agents = readDoc(cwd, AGENTS_MD_PATH)
  const rivet = readDoc(cwd, RIVET_MD_PATH)
  return {
    cwd,
    agentsMd: agents.content,
    rivetMd: rivet.content,
    agentsExists: agents.exists,
    rivetExists: rivet.exists,
  }
}

/**
 * @param knownWorkspaces 已注册工作区（存活会话 cwd + 默认工作区）。缺省为空 =
 * 拒绝一切 cwd——fail-closed，装配点必须显式提供（issue #221）。
 */
export function buildProjectDocsRoutes(
  apiToken?: string,
  knownWorkspaces: () => string[] = () => [],
): Record<string, RouteHandler> {
  return {
    'GET /project-docs': (body, params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
      if (!cwd) return { status: 400, body: { error: 'Missing cwd query parameter' } }
      if (!isKnownWorkspace(cwd, knownWorkspaces())) {
        return { status: 403, body: { error: UNKNOWN_WORKSPACE_ERROR } }
      }
      try {
        return { status: 200, body: readDocs(cwd) }
      } catch (err) {
        return { status: 500, body: { error: (err as Error).message } }
      }
    },

    'PUT /project-docs': (body, _params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const input = (body ?? {}) as Record<string, unknown>
      const cwd = typeof input.cwd === 'string' ? input.cwd : ''
      if (!cwd) return { status: 400, body: { error: 'Missing cwd' } }
      if (!isKnownWorkspace(cwd, knownWorkspaces())) {
        return { status: 403, body: { error: UNKNOWN_WORKSPACE_ERROR } }
      }

      const agentsMd = input.agentsMd
      const rivetMd = input.rivetMd
      if (agentsMd !== undefined && typeof agentsMd !== 'string') {
        return { status: 400, body: { error: 'agentsMd must be a string' } }
      }
      if (rivetMd !== undefined && typeof rivetMd !== 'string') {
        return { status: 400, body: { error: 'rivetMd must be a string' } }
      }
      if (agentsMd === undefined && rivetMd === undefined) {
        return { status: 400, body: { error: 'agentsMd or rivetMd is required' } }
      }

      try {
        if (agentsMd !== undefined) writeDoc(cwd, AGENTS_MD_PATH, agentsMd)
        if (rivetMd !== undefined) writeDoc(cwd, RIVET_MD_PATH, rivetMd)
        return { status: 200, body: readDocs(cwd) }
      } catch (err) {
        return { status: 500, body: { error: (err as Error).message } }
      }
    },
  }
}
