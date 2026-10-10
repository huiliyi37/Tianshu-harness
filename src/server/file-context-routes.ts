import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { RouteHandler } from './index.js'
import { withAuth } from './route-auth.js'
import { getWorkspaceConfig } from '../config/workspace-config.js'
import { validatePath } from '../tools/path-validate.js'
import { GitignoreFilter } from '../tools/gitignore.js'
import { listProjectFiles, listDirEntries, rankPaths } from './file-list.js'
import { FILE_CONTEXT_CACHE_MS, contextFilePriority, isSuggestedContextFile } from './file-context-policy.js'
import { isKnownWorkspace, UNKNOWN_WORKSPACE_ERROR } from './workspace-guard.js'

type Index = { expires: number; files: Promise<string[]> }
const indexes = new Map<string, Index>()
export async function cachedProjectFiles(cwd: string, refresh = false): Promise<string[]> {
  cwd = await realpath(cwd)
  const entry = indexes.get(cwd)
  if (!refresh && entry && entry.expires > Date.now()) return entry.files
  if (indexes.size >= 32) indexes.delete(indexes.keys().next().value!)
  const files = listProjectFiles(cwd)
  const next = { expires: Date.now() + FILE_CONTEXT_CACHE_MS, files }
  indexes.set(cwd, next)
  void files.catch(() => { if (indexes.get(cwd) === next) indexes.delete(cwd) })
  return files
}

export function buildFileContextRoutes(
  apiToken?: string,
  knownWorkspaces: () => string[] = () => [],
): Record<string, RouteHandler> {
  return {
    'GET /workspace/file-context': withAuth(async (_body, params) => {
      const requested = typeof params?.cwd === 'string' ? params.cwd : getWorkspaceConfig().defaultDir
      if (!requested || !isAbsolute(requested)) return { status: 400, body: { error: 'Choose a workspace directory first' } }
      // 安全加固（与 issue #221 同族）：cwd 必须命中已注册工作区，防止 Bearer 持有者枚举任意目录结构
      if (!isKnownWorkspace(requested, knownWorkspaces())) {
        return { status: 403, body: { error: UNKNOWN_WORKSPACE_ERROR } }
      }
      let root: string
      try {
        root = await realpath(requested)
        if (!(await stat(root)).isDirectory()) return { status: 400, body: { error: 'Not a directory' } }
      } catch { return { status: 404, body: { error: 'Workspace directory is unavailable' } } }
      const query = typeof params?.q === 'string' ? params.q.replace(/\\/g, '/') : ''
      if (params?.refresh === '1') indexes.delete(root)
      const path = typeof params?.path === 'string' ? params.path : ''
      const limit = Math.min(Math.max(Number(params?.limit) || 100, 1), 200)
      try {
        if (query) {
          const files = await cachedProjectFiles(root, params?.refresh === '1')
          const folders = new Set<string>()
          for (const file of files) {
            const parts = file.split('/')
            parts.pop()
            while (parts.length) { folders.add(parts.join('/')); parts.pop() }
          }
          const candidates = [...files.filter(path => isSuggestedContextFile(path, query)), ...folders]
          const items = rankPaths(candidates, query, limit).map(path => ({ path, kind: folders.has(path) ? 'folder' as const : 'file' as const }))
          return { status: 200, body: { root, path: '', items } }
        }
        let dir: string
        try { dir = path ? validatePath(root, path, 'read') : root }
        catch { return { status: 403, body: { error: 'Directory outside workspace' } } }
        const actual = await realpath(dir)
        const rel = relative(root, actual)
        if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
          return { status: 403, body: { error: 'Directory outside workspace' } }
        }
        if (!(await stat(actual)).isDirectory()) return { status: 400, body: { error: 'Not a directory' } }
        const gitignore = await GitignoreFilter.create(root)
        const entries = await listDirEntries(actual, true)
        const items = entries.filter(e => !gitignore.isIgnored(root, resolve(actual, e.name)))
          .map(e => ({ path: [path.replace(/\\/g, '/'), e.name].filter(Boolean).join('/'), kind: e.isDirectory ? 'folder' as const : 'file' as const }))
          .filter(e => e.kind === 'folder' || isSuggestedContextFile(e.path))
          .sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || contextFilePriority(a.path) - contextFilePriority(b.path) || a.path.localeCompare(b.path))
        return { status: 200, body: { root, path, items } }
      } catch { return { status: 503, body: { error: 'Cannot browse this directory; retry or select another workspace' } } }
    }, apiToken),
  }
}
