import { spawnGit } from './spawn-git.js'
import { writeFile, unlink, readFile, mkdir, cp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import type { Tool, ToolCallParams } from './types.js'
import { checkSyntax } from './syntax-check.js'
import { trackFileChange, restoreLatestBackup } from '../agent/recovery-stack.js'
import { validatePathSafe } from './path-validate.js'
import { incrementEditFailCount, resetEditFailCount, recordSuccessfulEdit } from './read-file.js'
import { APPLY_PATCH_POINTER_PREFIX } from './apply-patch-arg-processor.js'
import { detectPointerPlaceholder, POINTER_GUARD_ERROR_MARKER } from './pointer-guard.js'
import { landingWriteFile, delegatedToToolResult, isDelegateRejected } from './client-delegate.js'

/** Post-apply syntax verification + rollback. Default on; RIVET_APPLY_PATCH_VERIFY=0
 *  falls back to the legacy "git apply and trust it" behaviour. */
function isApplyPatchVerifyEnabled(): boolean {
  const v = process.env.RIVET_APPLY_PATCH_VERIFY
  return v !== '0' && v !== 'false'
}

interface PatchTarget {
  /** Repo-relative path (forward slashes). */
  rel: string
  /** Absolute path on disk. */
  abs: string
  /** Whether the file existed before the patch (governs rollback strategy). */
  existedBefore: boolean
}

/** Extract the set of files a unified diff writes to (its `+++ ` headers).
 *  Skips `/dev/null` (pure deletions) — those carry no post-apply content to
 *  verify. Mirrors the arg-processor's parser so target sets stay consistent. */
export function extractPatchTargetPaths(diff: string): string[] {
  const paths = new Set<string>()
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+++ ')) continue
    let p = line.slice(4).trim()
    const tabIdx = p.indexOf('\t')
    if (tabIdx !== -1) p = p.slice(0, tabIdx)
    if (p === '/dev/null') continue
    p = p.replace(/^"(.*)"$/, '$1')
    p = p.replace(/^[ab]\//, '')
    if (p.length > 0) paths.add(p)
  }
  return [...paths]
}

export interface ApplyPatchInput {
  diff: string
  checkOnly?: boolean
}

export interface ApplyPatchResult {
  ok: boolean
  error: string
}

export async function applyPatch(cwd: string, input: ApplyPatchInput, abortSignal?: AbortSignal): Promise<ApplyPatchResult> {
  const patchFile = join(tmpdir(), `rivet-patch-${process.pid}-${Date.now()}.patch`)
  try {
    await writeFile(patchFile, input.diff)
    const args = ['apply', '--3way']
    if (input.checkOnly) args.push('--check')
    args.push(patchFile)

    const result = await new Promise<{status: number | null, stderr: string, stdout: string}>((resolve, reject) => {
      const child = spawnGit(args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      child.on('close', (status) => resolve({ status, stderr, stdout }))
      child.on('error', reject)

      if (abortSignal) {
        const onAbort = () => { child.kill('SIGTERM') }
        if (abortSignal.aborted) {
          child.kill('SIGTERM')
        } else {
          abortSignal.addEventListener('abort', onAbort, { once: true })
          child.on('close', () => { abortSignal.removeEventListener('abort', onAbort) })
        }
      }
    })

    if (result.status === 0) return { ok: true, error: '' }
    const errTrimmed = result.stderr.trim()
    const outTrimmed = result.stdout.trim()
    return { ok: false, error: errTrimmed || outTrimmed || `git apply 以状态码 ${result.status} 退出` }
  } finally {
    try {
      await unlink(patchFile)
    } catch {
      // Best effort cleanup.
    }
  }
}

export const APPLY_PATCH_TOOL: Tool = {
  definition: {
    name: 'apply_patch',
    description: '用 git apply 把 unified diff 应用到当前 git 仓库。支持应用前先做 check-only 校验。用于多文件改动或应用已有 patch；单点定向编辑优先用 edit_file 或 hash_edit。注意：大 patch 应用后，消息历史里只保留摘要指针（改动文件列表 + 大小）而非 diff 原文——用 read_file 或 git diff 查看结果。check_only 校验会保留完整 diff 内联。',
    input_schema: {
      type: 'object',
      properties: {
        diff: {
          type: 'string',
          description: '要应用的 unified diff 内容。',
        },
        check_only: {
          type: 'boolean',
          description: '只校验 patch 能否干净应用，不修改文件。',
        },
      },
      required: ['diff'],
    },
  },

  async execute(params: ToolCallParams) {
    const diff = params.input.diff
    if (typeof diff !== 'string' || diff.trim().length === 0) {
      return { content: 'apply_patch 需要非空的 "diff" 字符串。', isError: true }
    }

    // Pointer-regurgitation guard，两条并存：
    //
    // 1) 自己的折叠指针 —— 前缀匹配即拦。不能只靠下面的通用检测：tag 补齐
    //    之前产生的历史指针不带 #RIVET-POINTER-DISPLAY-ONLY#，过不了
    //    detectPointerPlaceholder 的「前缀 + marker」双条件，而它们仍散落在
    //    长会话的历史里。
    // 2) 其他工具的指针交叉 echo 进 diff —— write_file / edit_file / hash_edit /
    //    plan 的占位符同样会被模型当成内容传进来。write_file 侧的守卫早就
    //    「Checks ALL pointer prefixes」，apply_patch 此前只认自己那一个前缀，
    //    是这组守卫里唯一的窄口。
    //
    // 两条都必须带 POINTER_GUARD_ERROR_MARKER：pointer-regurgitation-hook 的
    // WRITE_CLASS_TOOLS 本就含 apply_patch，但它靠该 marker 计数；缺了它这里的
    // 拦截既不会升级提醒，也不会被 tool-history-recorder 标 transient（会被当成
    // 真实失败，污染 convergence 的 errorPenalty）。
    // 有意设计：apply_patch 不做 resolveIdempotentPointer 幂等化解——diff 输入
    // 无目标路径字段，无法与指针记录做路径比对；宁可硬错误让模型 read_file /
    // git diff 重取现状，也不把「编辑从未真正应用」误判为成功（与 write/edit/
    // hash_edit/plan 的宽容路径不对称是刻意的 fail-safe）。
    const echoedPointer = diff.trimStart().startsWith(APPLY_PATCH_POINTER_PREFIX)
      ? APPLY_PATCH_POINTER_PREFIX
      : detectPointerPlaceholder(diff)
    if (echoedPointer) {
      return {
        content: `错误："diff" 是历史消息里的显示指针（"${echoedPointer} …"），不是真正的 unified diff。`
          + '该占位符只在大内容写入/应用后的历史消息中出现——从来不是合法输入。'
          + '请提供实际的 unified diff，或先用 read_file / git diff 查看当前状态。'
          + `\n\n[${POINTER_GUARD_ERROR_MARKER}]`,
        isError: true,
      }
    }

    // Normalize header paths to forward slashes so patches produced on/with
    // Windows paths still apply cleanly and render as valid unified diffs.
    const normalizedDiff = normalizeDiffPaths(diff)
    const checkOnly = params.input.check_only === true
    const verify = isApplyPatchVerifyEnabled() && !checkOnly

    // Snapshot targets + back them up BEFORE applying, so a corrupting patch
    // can be rolled back per-file. check_only never writes, so it skips this.
    const targets: PatchTarget[] = verify
      ? extractPatchTargetPaths(normalizedDiff).map((rel) => {
          const abs = join(params.cwd, rel)
          return { rel, abs, existedBefore: existsSync(abs) }
        })
      : []
    // 目标过 validatePathSafe：git apply 自身拒绝绝对路径/..，但 verify/backup
    // 与 client-delegate 在 git 之前就读写这些 join 出来的绝对路径——符号链接
    // 目录场景下仍需工作区边界把关。
    for (const t of targets) {
      const check = validatePathSafe(params.cwd, t.rel, 'write')
      if (!check.ok) return { content: `错误：补丁目标 ${t.rel}：${check.error}`, isError: true }
    }
    for (const t of targets) {
      if (t.existedBefore) {
        await trackFileChange(params.cwd, { filePath: t.rel, action: 'edit', toolCallId: params.toolUseId ?? 'apply_patch' })
      }
    }

    // E4 — when a client can apply_edit, materialize final file snapshots in a
    // temp tree and land each file via WorkspaceEdit (whole-file payload).
    if (!checkOnly && params.onClientDelegate && targets.length > 0) {
      const clientResult = await applyPatchViaClient(params, normalizedDiff, targets)
      if (clientResult) return clientResult
      // null → fail-back to local git apply below
    }

    const result = await applyPatch(params.cwd, {
      diff: normalizedDiff,
      checkOnly,
    })

    if (!result.ok) {
      // `git apply --3way` reports conflicts as exit 1 AFTER partially applying:
      // conflict markers + clean hunks are already on disk, cleanly-merged files
      // are staged into the index, and conflicted files are left unmerged (UU).
      // Reporting "failed" over that half-applied tree makes the model retry a
      // patch that "never happened", and the unmerged index poisons standard
      // recovery (`git checkout -- <file>` dies with "path is unmerged"). Roll
      // the touched paths back to their pre-patch backups and unstage them —
      // the same rollback the fatal-syntax path below already performs.
      const rolledBack = targets.length > 0
      if (rolledBack) {
        await rollbackTargets(params.cwd, targets, params.sessionId)
        await unstagePatchTargets(params.cwd, targets)
      }
      for (const t of targets) incrementEditFailCount(t.abs)
      return {
        content: rolledBack
          ? `补丁应用失败（半套用状态已自动回滚）：${result.error}`
          : `补丁应用失败：${result.error}`,
        isError: true,
      }
    }

    // Post-apply structural verification: git apply --3way can leave conflict
    // markers or the patch itself can introduce a syntax error, either of which
    // silently corrupts the file. Parse-check each written file; on a fatal
    // error roll the whole patch back (restore backups / delete new files).
    if (verify) {
      const fatal = await firstFatalSyntax(targets)
      if (fatal) {
        await rollbackTargets(params.cwd, targets, params.sessionId)
        for (const t of targets) incrementEditFailCount(t.abs)
        return {
          content: `补丁已应用，但在 ${fatal.rel} 中引入了致命错误：\n${fatal.message}\n\n`
            + '补丁已自动回滚。请修复 diff（检查上下文漂移/冲突标记）后重试。',
          isError: true,
          errorKind: 'syntax_error',
        }
      }
      for (const t of targets) {
        resetEditFailCount(t.abs)
        await recordSuccessfulEdit(t.abs, params.sessionId)
      }
    }

    // uiContent (display-only): echo the applied diff so the TUI/desktop card
    // renders a colored +/- inline diff. Model-facing `content` stays a short
    // summary (unchanged) → no prefix-cache/context cost. Cap the display diff
    // to keep the UI responsive for huge patches.
    return {
      content: checkOnly
        ? '补丁可干净应用（仅校验；未修改文件）。'
        : '补丁应用成功。',
      uiContent: truncateDiffForUi(normalizedDiff.trim()),
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

/**
 * E4 path: apply patch in a temp tree, then land each resulting file via
 * apply_edit (whole-file old/new snapshots). Returns null to fail-back locally.
 */
async function applyPatchViaClient(
  params: ToolCallParams,
  normalizedDiff: string,
  targets: PatchTarget[],
): Promise<{ content: string; isError?: boolean; uiContent?: string } | null> {
  const tmpRoot = join(tmpdir(), `rivet-patch-client-${process.pid}-${Date.now()}`)
  try {
    await mkdir(tmpRoot, { recursive: true })
    for (const t of targets) {
      const dest = join(tmpRoot, t.rel)
      await mkdir(dirname(dest), { recursive: true })
      if (t.existedBefore) {
        await cp(t.abs, dest)
      }
    }
    // Init a throwaway git repo so `git apply` has a valid cwd.
    const { spawnSync } = await import('node:child_process')
    const init = spawnSync('git', ['init'], { cwd: tmpRoot, stdio: 'ignore' })
    if (init.status !== 0) return null
    const applied = await applyPatch(tmpRoot, { diff: normalizedDiff, checkOnly: false })
    if (!applied.ok) return null

    for (const t of targets) {
      const tmpFile = join(tmpRoot, t.rel)
      if (!existsSync(tmpFile) && !t.existedBefore) continue
      const oldContent = t.existedBefore && existsSync(t.abs)
        ? await readFile(t.abs, 'utf-8')
        : ''
      const newContent = existsSync(tmpFile) ? await readFile(tmpFile, 'utf-8') : ''
      // Deletion: newContent empty and file gone in tmp — still land empty + client deletes?
      // v1: write empty content for deleted-to-empty; skip pure deletions (no tmp file, existed).
      if (!existsSync(tmpFile) && t.existedBefore) {
        // Pure delete — fall back to local git apply for the whole patch.
        return null
      }
      const land = await landingWriteFile(params, t.abs, oldContent, newContent)
      if (land.kind === 'delegated') {
        if (isDelegateRejected(land.delegated) || land.delegated.isError) {
          return delegatedToToolResult(land.delegated)
        }
        // accepted — continue remaining files
        resetEditFailCount(t.abs)
        await recordSuccessfulEdit(t.abs, params.sessionId)
      } else {
        // Capability vanished mid-patch — remaining already written locally by landingWriteFile
        resetEditFailCount(t.abs)
        await recordSuccessfulEdit(t.abs, params.sessionId)
      }
    }
    return {
      content: '补丁应用成功。',
      uiContent: truncateDiffForUi(normalizedDiff.trim()),
    }
  } catch {
    return null
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }
}

/** Parse-check each written target; return the first fatal error found, or null.
 *  A read/check failure for one file degrades to "skip" (never blocks a patch
 *  whose file we simply can't re-read). */
async function firstFatalSyntax(targets: PatchTarget[]): Promise<{ rel: string; message: string } | null> {
  for (const t of targets) {
    if (!existsSync(t.abs)) continue
    try {
      const content = await readFile(t.abs, 'utf-8')
      const check = await checkSyntax(t.abs, content)
      if (check.fatal) return { rel: t.rel, message: check.fatal }
    } catch {
      // Unreadable (binary, races) — not a syntax verdict, skip.
    }
  }
  return null
}

/** Undo an applied patch: restore pre-patch content for files that existed,
 *  delete files the patch newly created. Best-effort per file. */
async function rollbackTargets(cwd: string, targets: PatchTarget[], sessionId?: string): Promise<void> {
  for (const t of targets) {
    if (t.existedBefore) {
      await restoreLatestBackup(cwd, t.rel, sessionId)
    } else {
      try { await unlink(t.abs) } catch { /* already gone */ }
    }
  }
}

/** Best-effort index cleanup after a failed `git apply --3way`: the failed
 *  apply can leave cleanly-merged targets staged and conflicted targets
 *  unmerged (UU). `git reset -- <path>` takes index entries back to HEAD
 *  (worktree untouched — content restore is rollbackTargets' job), un-poisoning
 *  recovery commands like `git checkout -- <file>`. Trade-off: pre-patch staged
 *  changes on those same paths are unstaged too — acceptable in the failure
 *  path, where the patch itself staged the entries. No-ops outside a git
 *  workspace (non-zero exit) — the worktree rollback already ran above. */
async function unstagePatchTargets(cwd: string, targets: PatchTarget[]): Promise<void> {
  if (targets.length === 0) return
  await new Promise<void>((resolve) => {
    const child = spawnGit(['reset', '-q', '--', ...targets.map((t) => t.rel)], {
      cwd,
      stdio: 'ignore',
    })
    child.on('close', () => resolve())
    child.on('error', () => resolve())
  })
}

const APPLY_PATCH_MAX_UI_LINES = 600

/** Normalize backslashes to forward slashes only in diff header lines so a
 *  patch created on Windows (or mentioning Windows paths) stays valid for
 *  `git apply` and renders correctly as a unified diff. Context/code lines are
 *  left untouched. */
function normalizeDiffPaths(diff: string): string {
  return diff
    .split('\n')
    .map((line) => {
      if (
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('diff --git')
      ) {
        return line.replace(/\\/g, '/')
      }
      return line
    })
    .join('\n')
}

/** Cap display-only diff lines; excess is replaced by a single hint line. */
function truncateDiffForUi(diff: string, maxLines = APPLY_PATCH_MAX_UI_LINES): string {
  const lines = diff.split('\n')
  if (lines.length <= maxLines) return diff
  const hidden = lines.length - maxLines
  return [...lines.slice(0, maxLines), `…（另有 ${hidden} 行 diff，Ctrl+O）`].join('\n')
}
