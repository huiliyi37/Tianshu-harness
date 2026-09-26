/**
 * swebench 共享小工具——run 与 worker 两脚本同源引用。
 * 数据集字段（repo/base_commit/instance_id）来自不可信 parquet/jsonl：
 * instance_id 只作单段路径字符；git 一律参数数组执行，杜绝 shell 拼接。
 */

import { execFileSync } from 'node:child_process'

/** instance_id 清洗为安全路径段——防目录穿越出 workRoot。 */
export function sanitizeSegment(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9._-]/g, '_')
  if (clean.startsWith('.')) return '_' + clean.slice(1)
  return clean || 'unknown'
}

/** 参数数组 git 调用（无 shell）。 */
export function runGit(cwd: string, args: string[], timeoutMs?: number): void {
  execFileSync('git', args, { cwd, ...(timeoutMs ? { timeout: timeoutMs } : {}), windowsHide: true })
}
