/**
 * pre-write-claims — 写前认领路径解析：这次工具调用准备写哪些文件。
 *
 * 从 tool-pipeline.ts 拆出（2026-09-12，行数棘轮 ceiling 只降不升）：两个纯
 * 函数只做「工具 input → cwd 相对路径键」的归一，不依赖管线状态与回调，是
 * 天然接缝。消费方两处——R2 跨会话写前独占守卫，以及写后账本的 file_write
 * 归属（tool-pipeline 的 apply_patch / ast_edit 分支）。两侧共用本模块的
 * cwd 相对键形：绝对路径入参、ast_edit 的单数 path 别名，在写前写后得到同一
 * 个键，claim / ownership / ledger 三处不会各记各的。
 *
 * @module pre-write-claims
 */

/** Extract target file paths from a unified diff's `+++ b/…` headers
 *  (deletions fall back to the preceding `--- a/…` line). Best-effort —
 *  feeds TaskLedger file_write attribution for apply_patch, which carries
 *  no file_path parameter of its own. */
export function patchTargetPaths(diff: string): string[] {
  const out = new Set<string>()
  const lines = diff.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const plus = /^\+\+\+ (?:b\/)?(.+)$/.exec(lines[i] ?? '')
    if (!plus) continue
    const p = (plus[1] ?? '').split('\t')[0]!.trim()
    if (p && p !== '/dev/null') {
      out.add(p)
      continue
    }
    // Deletion (`+++ /dev/null`): the removed file is the preceding --- header.
    const minus = /^--- (?:a\/)?(.+)$/.exec(lines[i - 1] ?? '')
    const mp = (minus?.[1] ?? '').split('\t')[0]!.trim()
    if (mp && mp !== '/dev/null') out.add(mp)
  }
  return [...out]
}

/**
 * Paths a tool call is about to write, in the same cwd-relative key form the
 * post-write claim path uses. Covers every workspace-writing tool — a pre-write
 * guard keyed to write_file/edit_file alone left hash_edit / ast_edit /
 * apply_patch / plan_close as unguarded side doors around the peer-session
 * exclusive claim. Read-only variants (apply_patch check_only, ast_edit dry
 * run, plan_close without apply) never claim.
 */
export function preWriteClaimPaths(
  tu: { id: string; name: string; input: Record<string, unknown> },
  cwd: string,
): string[] {
  const norm = (p: string): string =>
    p.startsWith(cwd + '/') || p.startsWith(cwd + '\\') ? p.slice(cwd.length + 1) : p
  const one = (v: unknown): string[] =>
    typeof v === 'string' && v.length > 0 ? [norm(v)] : []
  switch (tu.name) {
    case 'write_file':
    case 'edit_file':
    case 'hash_edit':
      return one(tu.input.file_path)
    case 'ast_edit': {
      // 工具真值：ast-edit.ts `const dryRun = input.dryRun !== false`——只有显式
      // false 才落盘，缺省即预览。只读变体不认领（认领会锁死 peer 写入，而
      // claims 表无 TTL，只随进程死亡回收）。
      if (tu.input.dryRun !== false) return []
      // 路径取值镜像 ast-edit.ts 的顺序：paths 数组 → 单数 path 别名 → 缺省 ['.']。
      // 忽略单数形态会让真实的全仓写入整段绕过守卫（该文件注释：模型/worker
      // 常写成单数，忽略它会静默退化为 ['.'] 全仓扫描）。
      const raw: unknown[] = Array.isArray(tu.input.paths)
        ? tu.input.paths
        : typeof tu.input.path === 'string' && tu.input.path.trim().length > 0
          ? [tu.input.path.trim()]
          : ['.']
      return raw
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .map(norm)
    }
    case 'apply_patch':
      if (tu.input.check_only === true || typeof tu.input.diff !== 'string') return []
      return patchTargetPaths(tu.input.diff).map(norm)
    case 'plan_close':
      return tu.input.apply === true ? one(tu.input.file_path) : []
    default:
      return []
  }
}
