import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { spawnGitSync } from '../tools/spawn-git.js'
import { detectSensitiveFile } from '../tools/sensitive-file-detector.js'
import { normalizeEolBytes } from '../utils/eol-bytes.js'

export interface CommitVersion { head: string; index: string; files: string }

/** Hash only selected file bytes; never inspect credentials or escape the checkout. */
export function captureCommitVersion(cwd: string, files: string[]): CommitVersion | null {
  const hash = createHash('sha256')
  const root = resolve(cwd)
  for (const file of [...new Set(files)].sort()) {
    const path = resolve(root, file), rel = relative(root, path)
    if (isAbsolute(rel) || rel.startsWith('..') || detectSensitiveFile(file).sensitive) return null
    hash.update(file.replace(/\\/g, '/'))
    try {
      const actual = realpathSync(path), inside = relative(realpathSync(root), actual)
      if (isAbsolute(inside) || inside.startsWith('..')) return null
      // 行尾归一化：工作区可能是 CRLF（编辑器保存），与 HEAD/snapshot 的 LF 不同。
      // 语义相同就从同一个哈希出发，否则 expected/current 会因行尾形态漂移（#537 A 项）。
      hash.update(normalizeEolBytes(readFileSync(actual)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
      hash.update('deleted')
    }
  }
  const head = spawnGitSync(['rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf8' })
  const index = spawnGitSync(['ls-files', '--stage', '-z'], { cwd, encoding: 'utf8' })
  if (index.status !== 0) return null
  return { head: head.status === 0 ? head.stdout.trim() : 'unborn', index: createHash('sha256').update(index.stdout).digest('hex'), files: hash.digest('hex') }
}

export type VersionDiffKind = 'head-changed' | 'index-changed' | 'files-changed'

/**
 * 说明两份基准差在哪一段。
 *
 * 顺序不可换：head 变了之后 index 与 files 的差异都是噪声，先报 head 才是使用者
 * 真正需要的那句。`null` 表示三段全同——注意它**不**代表「基准可用」：两份都可能是
 * 同一个失败态，调用方必须先确认基准捕获本身是否成功（见 captureCommitVersionDetailed）。
 */
export function diffCommitVersion(expected: CommitVersion, current: CommitVersion): VersionDiffKind | null {
  if (expected.head !== current.head) return 'head-changed'
  if (expected.index !== current.index) return 'index-changed'
  if (expected.files !== current.files) return 'files-changed'
  return null
}
