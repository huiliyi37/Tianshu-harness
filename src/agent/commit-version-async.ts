import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { gitCommand, type GitCommandOptions } from '../tools/git-command.js'
import { detectSensitiveFile } from '../tools/sensitive-file-detector.js'
import type { CommitVersion } from './commit-version.js'
import { EOL_NORMALIZE_INLINE_LIMIT_BYTES, normalizeEolBytes } from '../utils/eol-bytes.js'

export type CommitVersionFailureCode =
  | 'sensitive-file'
  | 'path-escape'
  | 'symlink-escape'
  | 'index-unreadable'
  | 'git-error'

export type CommitVersionCapture =
  | { ok: true; version: CommitVersion }
  | { ok: false; code: CommitVersionFailureCode; detail: string }

/**
 * 捕获提交基准，失败时说明原因。
 *
 * 旧版只返回 `CommitVersion | null`，5 条失败路径（敏感文件 / 路径逃逸 / 符号链接逃逸 /
 * index 读不出 / git 异常）最终都被上层归纳成同一句「HEAD or index changed」，
 * 把排查方向引到 HEAD 上（issue #537）。这里保留原因，让调用方能给出可操作的下一步。
 */
export async function captureCommitVersionDetailed(cwd: string, files: string[], options: GitCommandOptions = {}): Promise<CommitVersionCapture> {
  try {
    const hash = createHash('sha256'), root = await realpath(cwd)
    for (const file of [...new Set(files)].sort()) {
      options.signal?.throwIfAborted()
      const path = resolve(root, file), rel = relative(root, path)
      if (detectSensitiveFile(file).sensitive) return { ok: false, code: 'sensitive-file', detail: file }
      if (isAbsolute(rel) || rel.startsWith('..')) return { ok: false, code: 'path-escape', detail: file }
      hash.update(file.replace(/\\/g, '/'))
      try {
        const actual = await realpath(path), inside = relative(root, actual)
        if (isAbsolute(inside) || inside.startsWith('..')) return { ok: false, code: 'symlink-escape', detail: file }
        // 行尾归一化：工作区可能是 CRLF，而快照/HEAD 是 LF（issue #537 A 项）。
        // 中小文件整读后归一化——跨块边界的 \r\n 用流式归一化会漏判，而 ref
        // 之间必须可比；超过阈值保持流式原样（不做归一化），避免整文件进内存。
        const size = (await stat(actual)).size
        if (size <= EOL_NORMALIZE_INLINE_LIMIT_BYTES) {
          hash.update(normalizeEolBytes(await readFile(actual, { signal: options.signal })))
        } else {
          for await (const chunk of createReadStream(actual, { signal: options.signal })) hash.update(chunk)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        hash.update('deleted')
      }
    }
    const head = await gitCommand(cwd, ['rev-parse', '--verify', 'HEAD'], options)
    const index = await gitCommand(cwd, ['ls-files', '--stage', '-z'], options)
    if (index.status !== 0 || head.interrupted) {
      return {
        ok: false,
        code: 'index-unreadable',
        detail: head.interrupted ? 'HEAD 查询被中断' : `git ls-files 退出码 ${index.status}`,
      }
    }
    return {
      ok: true,
      version: {
        head: head.status === 0 ? head.stdout.trim() : 'unborn',
        index: createHash('sha256').update(index.stdout).digest('hex'),
        files: hash.digest('hex'),
      },
    }
  } catch (error) {
    options.signal?.throwIfAborted()
    return { ok: false, code: 'git-error', detail: error instanceof Error ? error.message : String(error) }
  }
}

/** 旧签名：保留给既有调用点，失败时仍返回 null（行为不变）。 */
export async function captureCommitVersionAsync(cwd: string, files: string[], options: GitCommandOptions = {}): Promise<CommitVersion | null> {
  const capture = await captureCommitVersionDetailed(cwd, files, options)
  return capture.ok ? capture.version : null
}
