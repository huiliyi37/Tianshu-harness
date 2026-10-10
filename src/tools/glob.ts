import { currentWorkspaceRoots } from './workspace-context.js'
import { readdir, lstat, realpath, stat } from 'node:fs/promises'
import { join } from 'path'
import type { Tool, ToolCallParams } from './types.js'
import { validatePathSafe } from './path-validate.js'
import { relativePosix } from '../path-format.js'
import { GitignoreFilter } from './gitignore.js'
import { classifyPath } from '../context/attention-filter.js'
import { isRestrictedPath } from '../platform/restricted-paths.js'
import { SCAN_EXCLUDE_DIRS } from './scan-excludes.js'
import { isFilesystemMetadata } from '../utils/file-metadata.js'

const EXCLUDE_DIRS = SCAN_EXCLUDE_DIRS
const MAX_RESULTS = 500

function escapeRegex(str: string): string {
  return str.replace(/[.+^$()|[\]\\{}]/g, '\\$&')
}

function globPatternExplicitlyTargetsSilentLayer(pattern: string, requestedRoot: string): boolean {
  if (classifyPath(pattern).silent) return true
  const normalized = `${requestedRoot}/${pattern}`.replaceAll('\\', '/').replace(/\/+/g, '/')
  const literalPrefix = normalized.split(/[*?{]/, 1)[0] ?? ''
  const trimmed = literalPrefix.replace(/^\.\//, '').replace(/\/$/, '')
  if (!trimmed) return false
  return classifyPath(trimmed).silent
}

function globToRegex(pattern: string): RegExp {
  let regex = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!
    if (ch === '*' && pattern[i + 1] === '*') {
      regex += '.*'
      i += 2
      if (pattern[i] === '/') i++
    } else if (ch === '*') {
      regex += '[^/]*'
      i++
    } else if (ch === '?') {
      regex += '[^/]'
      i++
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i)
      if (end === -1) {
        regex += '\\{'
        i++
      } else {
        const alternatives = pattern
          .slice(i + 1, end)
          .split(',')
          .map((a) => escapeRegex(a.trim()))
          .join('|')
        regex += `(?:${alternatives})`
        i = end + 1
      }
    } else if ('.+^$()|[]\\{}'.includes(ch)) {
      regex += '\\' + ch
      i++
    } else {
      regex += ch
      i++
    }
  }
  return new RegExp(`^${regex}$`)
}

async function walkDir(
  dir: string,
  results: string[],
  root: string,
  filter: RegExp | undefined,
  includeSilentMatches: boolean,
  visited = new Set<string>(),
): Promise<void> {
  if (results.length >= MAX_RESULTS) return

  let real: string
  try {
    real = await realpath(dir)
  } catch {
    return
  }
  if (visited.has(real)) return
  visited.add(real)

  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    // Root path restricted → propagate (agent needs "target unreachable" not empty result).
    // Non-root + restricted system path + permission error → silent skip.
    // Other errors on subdirs → silent skip (preserves existing catch-all behavior).
    if (dir === root || !isRestrictedPath(String(e.path ?? e.message ?? ''), e.code ?? '')) {
      if (dir === root) throw err
      return
    }
    return
  }

  for (const name of names) {
    if (isFilesystemMetadata(name)) continue
    if (results.length >= MAX_RESULTS) return
    const fullPath = join(dir, name)
    let s: Awaited<ReturnType<typeof lstat>>
    try {
      s = await lstat(fullPath)
    } catch {
      continue
    }

    if (s.isSymbolicLink()) continue
    const rel = relativePosix(root, fullPath)
    const verdict = classifyPath(rel)
    if (s.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue
      if (verdict.tier === 'L0_build') continue
      await walkDir(fullPath, results, root, filter, includeSilentMatches, visited)
    } else if (s.isFile()) {
      if ((!verdict.silent || includeSilentMatches) && (!filter || filter.test(rel))) {
        results.push(rel)
      }
    }
  }
}

/** 空结果 sentinel——search-pod-hook 靠 includes(此串) 识别「可信排除」，
 *  改文案必须与 hook 同步（用常量共享，禁止两边各自手抄）。 */
export const GLOB_EMPTY_RESULT = '未找到匹配 pattern 的文件'

export const GLOB_TOOL: Tool = {
  definition: {
    name: 'glob',
    description: `查找匹配 glob 模式的文件。

### 用法
- 读取文件前，先用 glob 按名称或模式定位文件
- 支持 ** 递归匹配目录
- 支持 * 通配符、? 单字符、{a,b} 多选一
- 结果排序返回，上限 500 条

### 示例
Good: glob(pattern="src/**/*.ts")
Good: glob(pattern="*.test.ts", path="src/")
Good: glob(pattern="src/components/**/*.tsx")
Bad: glob(pattern="node_modules/**") (excluded by default)`,
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob 模式，如 "src/**/*.ts" 或 "*.md"',
        },
        path: {
          type: 'string',
          description: '搜索的根目录（默认：cwd）',
        },
      },
      required: ['pattern'],
    },
  },

  async execute(params: ToolCallParams) {
    const roots = currentWorkspaceRoots(params.cwd)
    if (params.input.path === undefined && roots.length > 1) {
      const paths = new Set<string>()
      for (const root of roots) {
        const result = await GLOB_TOOL.execute({ ...params, input: { ...params.input, path: root } })
        if (result.isError) return result
        if (result.content !== GLOB_EMPTY_RESULT) for (const file of result.content.split('\n')) paths.add(join(params.cwd, file))
      }
      return { content: paths.size ? [...paths].sort().join('\n') : GLOB_EMPTY_RESULT }
    }
    const pattern = params.input.pattern as string
    const requestedRoot = params.input.path ? String(params.input.path) : '.'
    const validated = validatePathSafe(params.cwd, requestedRoot)
    if (!validated.ok) {
      return { content: `错误：${validated.error}`, isError: true }
    }
    const searchRoot = validated.path

    let s: Awaited<ReturnType<typeof stat>>
    try {
      s = await stat(searchRoot)
    } catch {
      // probe_miss：只读探测确认目录不存在是有效信息收集，不是认知失败。
      // 结构字段先行——中文文案不再被 classifyFailure 的英文正则命中。
      return { content: `错误：目录不存在：${searchRoot}`, isError: true, errorKind: 'probe_miss' as const }
    }
    if (!s.isDirectory()) {
      return { content: `错误：不是目录：${searchRoot}`, isError: true }
    }

    const regex = globToRegex(pattern)
    const gitignore = await GitignoreFilter.create(searchRoot)
    const includeSilentMatches = globPatternExplicitlyTargetsSilentLayer(pattern, requestedRoot)
    const files: string[] = []
    try {
      await walkDir(searchRoot, files, searchRoot, regex, includeSilentMatches)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `错误：${message}`, isError: true }
    }

    const matches = files
      .filter(f => !gitignore.isIgnored(searchRoot, join(searchRoot, f)))
      .sort()
      .map((f) => relativePosix(params.cwd, join(searchRoot, f)))

    return {
      content: matches.length > 0 ? matches.join('\n') : GLOB_EMPTY_RESULT,
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
