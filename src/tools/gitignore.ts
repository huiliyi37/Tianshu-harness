import { existsSync } from 'fs'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'path'
import { relativePosix } from '../path-format.js'

const DEFAULT_IGNORE = [
  'node_modules', '.git', '.svn', '.hg',
  '__pycache__', '.pytest_cache', '.mypy_cache',
  '.next', '.nuxt', '.cache', '.turbo',
  'dist', 'build', 'out', 'target',
  '.env', '.env.local', '.env.production',
  '*.pyc', '*.pyo', '*.so', '*.dylib', '*.dll',
  '*.min.js', '*.min.css', '*.map',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.DS_Store', 'Thumbs.db',
]

export class GitignoreFilter {
  private patterns: string[]

  constructor(_cwd: string, patterns?: string[]) {
    this.patterns = patterns ?? [...DEFAULT_IGNORE]
  }

  static async create(cwd: string): Promise<GitignoreFilter> {
    const patterns = [...DEFAULT_IGNORE]
    const gitignorePath = join(cwd, '.gitignore')
    if (existsSync(gitignorePath)) {
      try {
        const content = await readFile(gitignorePath, 'utf-8')
        for (const line of content.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith('#')) continue
          patterns.push(trimmed)
        }
      } catch { /* ignore */ }
    }
    return new GitignoreFilter(cwd, patterns)
  }

  isIgnored(cwd: string, filePath: string): boolean {
    const absPath = resolve(cwd, filePath)
    const relPath = relativePosix(cwd, absPath)

    // Gitignore rules only apply inside the project tree. Paths outside the
    // project (e.g. ~/.rivet/sessions/ on the same machine) must not be blocked
    // — the user may have explicitly granted access to read session logs.
    // Guard on a real parent hop ('..' / '../…'): an in-tree entry whose name
    // merely starts with two dots (e.g. `..cache/`) is NOT outside the tree and
    // must stay subject to the ignore rules.
    if (relPath === '..' || relPath.startsWith('../')) return false

    for (const pattern of this.patterns) {
      if (this.matchPattern(pattern, relPath)) return true
    }
    return false
  }

  private matchPattern(pattern: string, relPath: string): boolean {
    // Negation patterns — not supported, skip
    if (pattern.startsWith('!')) return false

    // Directory-only patterns (trailing /)
    let cleanPattern = pattern
    const dirOnly = cleanPattern.endsWith('/')
    if (dirOnly) cleanPattern = cleanPattern.replace(/\/+$/, '')

    // Root-anchored patterns (leading /). Git reads a leading slash as "anchored
    // at the repository root": strip the marker and match the full relative path
    // only. Falling through to the per-segment loop below would let `/js` also
    // match `vendor/js`, defeating the anchor.
    const anchored = cleanPattern.startsWith('/')
    if (anchored) cleanPattern = cleanPattern.replace(/^\/+/, '')
    if (anchored) return this.matchGlob(cleanPattern, relPath)

    // Check if any path segment or the full path matches
    const segments = relPath.split('/')
    for (let i = 0; i < segments.length; i++) {
      const candidate = segments.slice(i).join('/')
      if (this.matchGlob(cleanPattern, candidate)) return true
      if (dirOnly && i === 0 && segments.length > 1 && this.matchGlob(cleanPattern, segments[i]!)) return true
    }

    return false
  }

  private matchGlob(pattern: string, str: string): boolean {
    // 含 glob 元字符的模式必须整体翻译——精确与前缀/后缀分支只对纯字面量模式成立。
    // 否则未闭合字符类（`x[`）会经 `pattern === str` 命中，而 git 实测使整条模式
    // 不匹配（`git check-ignore` 对 `x[` vs `x[` 报 not ignored）。
    if (hasGlobMeta(pattern)) return globToRegex(pattern).test(str)

    // Exact match
    if (pattern === str) return true

    // Prefix match — "src" matches "src/anything"
    if (str.startsWith(pattern + '/') || str === pattern) return true

    // Suffix match — ".min.js" matches "app.min.js"
    if (pattern.startsWith('.') && str.endsWith(pattern)) return true

    return false
  }
}

/** Backslash, built without a literal so the escape survives any transform. */
const BACKSLASH = String.fromCharCode(92)

/** 触发 glob 翻译的模式元字符：`*` / `?` / `[`（字符类）/ `\`（转义下一个字符）。
 *  只有全字面量的模式才走精确与前缀/后缀分支——混合模式必须整体翻译，否则
 *  字面分支会给出与 git 不一致的结果（未闭合 `[` 的误命中即由此而来）。
 *  用字符判断而非正则字面量：正则里的字符类要写出包含 `[` 与 `\` 的方括号组，
 *  多重转义下极易写成未终结的类。 */
function hasGlobMeta(pattern: string): boolean {
  for (const ch of pattern) {
    if (ch === '*' || ch === '?' || ch === '[' || ch === BACKSLASH) return true
  }
  return false
}


/** 永不匹配的正则：未闭合 `[` 使整条 gitignore 模式失效（git check-ignore 实测）。 */
const NEVER_MATCH = /(?!)/

/** Regex metacharacters that must be escaped when interpolated as literals. */
const RE_SPECIAL = new Set([
  '.', '$', '^', '{', '}', '(', ')', '|', '[', ']', BACKSLASH,
])

/**
 * Translate a gitignore glob into an anchored RegExp.
 *
 * Two glob features the previous implementation got wrong:
 *  - a double star matches across separators, and a double star followed by a
 *    slash matches "zero or more directories" so it also covers the root;
 *  - a pattern that names a directory also ignores everything beneath it.
 */
function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (ch === '?') {
      re += '[^/]'
    } else if (ch === BACKSLASH) {
      // 转义下一个字符为字面量；末尾孤立反斜杠退化为字面反斜杠。
      const next = glob[i + 1]
      if (next === undefined) {
        re += BACKSLASH + BACKSLASH
      } else {
        re += RE_SPECIAL.has(next) ? BACKSLASH + next : next
        i++
      }
    } else if (ch === '[') {
      const cls = translateCharClass(glob, i)
      if (cls === null) return NEVER_MATCH
      re += cls.re
      i = cls.end
    } else if (RE_SPECIAL.has(ch)) {
      re += BACKSLASH + ch
    } else {
      re += ch
    }
  }
  return new RegExp('^(?:' + re + ')(?:/.*)?$')
}

/**
 * `[...]` 字符类 → 正则片段。三条语义均以 `git check-ignore` 实测为准：
 * - 否定类同时接受 `[!...]` 与 `[^...]`（实测 `[^abc].txt` 既忽略 `z.txt` 也忽略 `^.txt`）；
 * - 类不跨目录分隔符（实测 `a[bc]` 不忽略 `a/b`）→ 类体里的斜杠剔除；
 * - 未闭合方括号（找不到闭合符）→ 返回 null，由调用方令整条模式不匹配
 *   （实测 `x[` 对同名文件报 not ignored）。
 *
 * 不支持的形态（POSIX 类 `[[:alpha:]]`、嵌套方括号）同样返回 null —— 降级为
 * 「整条不匹配」只造成漏判，不会产生误拦（安全的失败方向）。
 */
function translateCharClass(glob: string, start: number): { re: string; end: number } | null {
  const close = glob.indexOf(']', start + 1)
  if (close === -1) return null
  const body = glob.slice(start + 1, close)
  if (body.includes('[')) return null

  const negated = body.startsWith('!') || body.startsWith('^')
  let inner = negated ? body.slice(1) : body
  // 类体里的正则元字符按字面量处理：反斜杠先自身转义，首字符 `^` 避免被读成否定。
  inner = inner.split(BACKSLASH).join(BACKSLASH + BACKSLASH)
  if (!negated && inner.startsWith('^')) inner = BACKSLASH + inner
  inner = inner.split('/').join('')
  if (inner === '') return null
  return { re: '[' + (negated ? '^' : '') + inner + ']', end: close }
}
