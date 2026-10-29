/**
 * Git 仓库状态戳：不起子进程，只 stat 几个文件，判断「HEAD 与 index 自上次以来是否可能变过」。
 *
 * 为什么需要它（2026-10-21 现场）：sidecar 是单进程，交付指纹每次工具调用都要同步
 * spawn `git rev-parse HEAD` + `git ls-files --stage`（一次工具调用里还会算好几遍），
 * 12 个会话并发时 CPU 采样 60 秒里有 10 秒卡在 spawn 上，单次最长 3 秒——事件循环被
 * 堵住，宿主健康探针超时，判 runtime 无响应并重启，所有会话被中止。
 *
 * 戳的组成：gitdir/HEAD 的内容 + gitdir/index、HEAD 指向的 ref 文件、commondir/packed-refs
 * 的 (mtimeMs, size)。git 改 index / 移动分支都会改写这些文件；任何一步读不到 → 返回
 * null，调用方必须退回真实 git 调用（fail-open 到「不缓存」，不会给出旧结果）。
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const gitDirCache = new Map<string, { gitDir: string; commonDir: string } | null>()

function locateGitDir(root: string): { gitDir: string; commonDir: string } | null {
  if (gitDirCache.has(root)) return gitDirCache.get(root)!
  let found: { gitDir: string; commonDir: string } | null = null
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git')
    try {
      const st = statSync(dotGit)
      let gitDir = dotGit
      if (st.isFile()) {
        // 链接工作树：`.git` 是 "gitdir: <path>" 文本文件
        const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
        if (!m) break
        gitDir = isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!)
      }
      let commonDir = gitDir
      try {
        const rel = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
        if (rel) commonDir = isAbsolute(rel) ? rel : resolve(gitDir, rel)
      } catch { /* 主工作树没有 commondir */ }
      found = { gitDir, commonDir }
      break
    } catch { /* 本层没有 .git，继续向上 */ }
    if (dirname(dir) === dir) break
  }
  gitDirCache.set(root, found)
  return found
}

function statKey(path: string): string {
  try { const s = statSync(path); return `${s.mtimeMs}:${s.size}` } catch { return 'absent' }
}

/** 返回状态戳；null = 无法可靠判定（调用方不得使用缓存）。 */
export function gitStateStamp(root: string): string | null {
  const loc = locateGitDir(root)
  if (!loc) return null
  try {
    const head = readFileSync(join(loc.gitDir, 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]
    const refKey = ref ? statKey(join(loc.commonDir, ref)) : ''
    const index = statSync(join(loc.gitDir, 'index'))
    return [head, refKey, statKey(join(loc.commonDir, 'packed-refs')), `${index.mtimeMs}:${index.size}`].join('|')
  } catch {
    return null
  }
}

/** 测试用：清空 gitdir 定位缓存。 */
export function resetGitStateStampCache(): void { gitDirCache.clear() }
