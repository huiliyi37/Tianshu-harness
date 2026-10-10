import { createHash } from 'node:crypto'
import { readFile, stat, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute, dirname, basename } from 'node:path'
import { asBool, extractWriteFilePaths, extractPatchTargetPathsFromDiff } from '../tools/write-tool-helpers.js'
import { isTransientPlanDraftPath } from './plan-mode.js'

/** 凭据类文件不参与进度记账：多跳过只是少记一次进展，伪造进展才是错侧。
 *  用词边界而非裸子串——`tokenizer.ts` / `tokens-budget.ts` 这类正常文件不该被
 *  `token` 误伤（旧写法把它们的编辑整段吞掉，改道周期永不推进）。 */
const SENSITIVE_PATH_RE = /(?:\.env(?:[.\-/\\]|$)|credentials[.\-/\\]|private[\w.-]*key|(?<![a-z0-9])(?:token|secret)s?(?![a-z0-9]))/i

/** 工具性路径不是工作产物，不参与工作版本记账（P2）：
 *  - `.rivet/plans/draft-*.md` 瞬态计划草稿——"草稿不是代码证据"（与
 *    task-state-persist 同判据、同精神，isTransientPlanDraftPath 单一来源）；
 *  - `.rivet/scratch/` 一次性探针文件——提示词钦点的验证工具出口，收尾即清。
 *  排除后归入"不可判"（unknown）：不推进 mutationRevision（不触发相位切换）、
 *  不冒充 unchanged（不压缩 editRatio 的写样本）。 */
function isToolingPath(rel: string): boolean {
  const normalized = rel.replace(/\\/g, '/')
  return normalized.startsWith('.rivet/scratch/') || isTransientPlanDraftPath(normalized)
}

async function joinCanonicalParent(path: string): Promise<string> {
  return resolve(await realpath(dirname(path)).catch(() => dirname(path)), basename(path))
}
async function fingerprint(path: string, cwd: string): Promise<string | null> {
  try {
    const real = await realpath(path)
    const rel = relative(cwd, real)
    if (rel.startsWith('..') || isAbsolute(rel) || SENSITIVE_PATH_RE.test(real)) return null
    const info = await stat(real)
    if (!info.isFile() || info.size > 2_000_000) return null
    return createHash('sha256').update(await readFile(real)).digest('hex')
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : null }
}

/** P0 三态（《收敛阶段补修》§3）：changed / unchanged / unknown。
 *  有任一确认变化 → changed；全部可判且无变化 → unchanged；存在不可判
 *  （敏感/项目外/过大/读失败/无目标）且无 changed → unknown。缺失判断为
 *  unknown，不伪装 unchanged。 */
export type FileProgressOutcome = 'changed' | 'unchanged' | 'unknown'

export interface FileProgressFact {
  outcome: FileProgressOutcome
  /** 本次监控的候选相对路径（供消费侧/断言观测；不含内容）。 */
  targets: string[]
}

export interface FileProgressMonitor {
  /** 执行结束消费。isError（失败/自动回滚）→ unknown：不推进，也不冒充
   *  unchanged（回滚是否彻底不可见）。 */
  finish(opts: { isError: boolean }): Promise<FileProgressFact>
}

/** dry-run / check-only 预览：确定不产生盘上变化（不是 unknown）。 */
function isPreviewOnly(name: string, input: Record<string, unknown>): boolean {
  if (name === 'ast_edit') return input.dryRun !== false // 工具真值：缺省即预览
  if (name === 'apply_patch') return asBool(input.check_only)
  return false
}

/** 变化检测的目标集：apply_patch 需含纯删除路径（+++ /dev/null 的线索在
 *  `--- a/<path>` 头）；其余走共享的 extractWriteFilePaths。 */
function progressTargetCandidates(name: string, input: Record<string, unknown>): string[] {
  if (name === 'apply_patch' && typeof input.diff === 'string') {
    return extractPatchTargetPathsFromDiff(input.diff, { includeDeleted: true })
  }
  return extractWriteFilePaths(name, input)
}

/** Unknown/large/outside-project/sensitive paths earn no progress credit. */
export async function captureCourseFileProgress(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<FileProgressMonitor> {
  if (isPreviewOnly(name, input)) {
    return { finish: async () => ({ outcome: 'unchanged', targets: [] }) }
  }
  cwd = await realpath(cwd).catch(() => cwd)
  const candidates = await Promise.all(progressTargetCandidates(name, input).map(async path => {
    const absolute = resolve(cwd, path)
    return realpath(absolute).catch(async () => joinCanonicalParent(absolute))
  }))
  const paths = candidates.filter(path => {
    const rel = relative(cwd, path)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) && !SENSITIVE_PATH_RE.test(rel) && !isToolingPath(rel)
  })
  const before = await Promise.all(paths.map(path => fingerprint(path, cwd)))
  return {
    finish: async ({ isError }) => {
      // 无目标可监控 / 执行失败（回滚）→ unknown：不推进，也不宣称无变化。
      if (paths.length === 0 || isError) return { outcome: 'unknown', targets: paths }
      const after = await Promise.all(paths.map(path => fingerprint(path, cwd)))
      let changed = false
      let unknown = false
      for (let i = 0; i < paths.length; i++) {
        const b = before[i]!
        const a = after[i]!
        if (b === null || a === null) { unknown = true; continue }
        if (b !== a) changed = true
      }
      return { outcome: changed ? 'changed' : unknown ? 'unknown' : 'unchanged', targets: paths }
    },
  }
}

/**
 * 文件进展三态包装；验证事实转交 pipeline，在门禁后的实际执行点登记。
 */
export async function executeWithCourseProgress(deps: import('./tool-execution.js').ToolExecutionDeps, ...args: Parameters<typeof import('./tool-pipeline.js').executeToolUse>): ReturnType<typeof import('./tool-pipeline.js').executeToolUse> {
  const { executeToolUse } = await import('./tool-pipeline.js')
  const [tu] = args
  const monitor = deps.onCourseFileChange ? await captureCourseFileProgress(tu.name, tu.input, deps.cwd) : null
  const result = await executeToolUse(tu, { ...args[1], onVerificationExecutionStart: deps.onVerificationExecutionStart ?? args[1].onVerificationExecutionStart }, args[2], args[3], args[4])
  if (monitor && result.toolResult.type === 'tool_result') {
    deps.onCourseFileChange!(await monitor.finish({ isError: result.toolResult.is_error === true }))
  }
  return result
}
