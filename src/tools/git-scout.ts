/**
 * git_scout — 只读 git 史实侦察工具（worker 用，回流自 `origin/tianshu-alpha-3.14`）。
 *
 * 背景（alpha 侧 2026-09-06 scout 失败归因，主线同样成立）：readonly profile
 * （code_scout / doc_scout / reviewer / architect）的工具集里**没有 bash、也没有
 * git**——主线的 `git` 工具含写动作（commit / stash / stash_pop），整把交给 readonly
 * 会破坏子代理隔离信任链（`WRITE_CAPABLE_TOOLS` 把 `git` 算写权）；而 `read_file`
 * 硬拒 `.git/`（DEFAULT_IGNORE 含 `.git`）。结果：侦察 worker 完全无法做 git 史实
 * 取证（log / tag / branch / merge-base / rev-list），只能退到 web 旁证——而
 * "这行代码是什么时候、为什么变成这样的"恰恰只能从 git 历史回答。
 *
 * 本工具是纯只读动作子集：所有 action 只跑 git 的查询命令，schema 层就没有写动作；
 * execute 对写动作防御性拒绝。工具名不进 `WRITE_CAPABLE_TOOLS` / `FILE_EDIT_TOOLS`，
 * 故 readonly / plan-mode 语义判定不受影响（`requiresApproval: false`）。
 *
 * 与 alpha 版的差异：alpha 用 `git.ts` 的 `runGitSafe`/`runGitExitCode`（分支侧新增），
 * 主线的 `git.ts` 只有内部 runner 且含写动作——这里改用 `spawn-git.ts` 的 `spawnGit`
 * 自建薄 runner（**不 import 含写动作的 git 工具模块**，隔离边界更干净）。
 */

import type { Tool, ToolCallParams } from './types.js'
import { spawnGit } from './spawn-git.js'
import { killProcessTree } from './process-kill.js'

const ACTIONS = [
  'log',        // 提交历史（compact：%h|%ad|%s，带日期），支持 range/path/maxCount
  'count',      // 提交数（rev-list --count）
  'show',       // 单提交详情
  'tags',       // tag 列表（版本自然序）
  'branches',   // 分支列表，可过滤 contains
  'ancestry',   // a 是否为 b 的祖先
  'merge_base', // 分叉点
  'resolve',    // ref → commit sha
  'diff',       // --stat 差异
] as const
type ScoutAction = (typeof ACTIONS)[number]

const MAX_LOG = 1000
/** 单次输出上限：侦察工具的输出进上下文，不该被一条 log 冲爆。 */
const MAX_OUTPUT = 50_000
const MAX_REF_LEN = 200
/** 参数防注入（与 alpha 逐字一致）：拒以 '-' 开头的值（防 flag 注入）与 shell
 *  元字符（防御纵深——虽走参数数组无 shell，仍显式拒绝）。
 *  注意**不要**把 `~`/`^`/`:` 加进来：`HEAD~1`、`main..HEAD`、`a:b` 都是合法
 *  rev 语法，拒了会让 ancestry/merge_base/range 全线不可用（本批实测踩过）。 */
const BAD_REF = /^-|[\s"'`$&;|<>]/

interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 跑一条 git 读命令并收集输出。超时/中止都走 process-kill 的树杀（git 可能拉起
 * pager / fsmonitor 子进程，只杀父进程会留孤儿）。
 */
function runGit(args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 15_000): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = spawnGit(args, { cwd })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
    }
    // 树杀两段式（与 git.ts 同纪律）：git 会拉起 pager/fsmonitor 子进程，只 SIGTERM
    // 父进程会留孤儿；3s 后 SIGKILL 兜底。timer 不 unref 也没关系——finish 里清了。
    const treeKill = (): void => {
      killProcessTree(child, 'SIGTERM')
      setTimeout(() => killProcessTree(child, 'SIGKILL'), 3000).unref?.()
    }
    const onAbort = (): void => {
      treeKill()
      finish(130)
    }
    const timer = setTimeout(() => {
      treeKill()
      finish(124)
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('error', (err: Error) => { stderr = err.message; finish(127) })
    child.on('close', (code: number | null) => finish(code ?? 0))
  })
}

/** 成功（exit 0）返回 output=stdout；失败返回 output=stderr（供模型自纠）。 */
async function runGitSafe(args: string[], cwd: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  const r = await runGit(args, cwd, signal)
  const clip = (text: string): string =>
    text.length <= MAX_OUTPUT ? text : `${text.slice(0, MAX_OUTPUT)}\n…(输出已截断到 ${MAX_OUTPUT} 字符)`
  return r.code === 0
    ? { ok: true, output: clip(r.stdout) }
    : { ok: false, output: clip(r.stderr || `git ${args[0]} 退出码 ${r.code}`) }
}

async function runGitExitCode(args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number; stderr: string }> {
  const r = await runGit(args, cwd, signal)
  return { code: r.code, stderr: r.stderr }
}

function validateRef(name: string, label: string): string | null {
  if (!name || name.length > MAX_REF_LEN || BAD_REF.test(name) || name.startsWith('-')) {
    return `${label} 非法：必须是 ref 名/tag/commit sha（不以 - 开头、不含空白与 shell 元字符）`
  }
  return null
}

function validateMaxCount(value: unknown): number | null {
  if (value === undefined) return 50
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LOG) {
    return null
  }
  return value
}

/** path 校验（宽松）：path 总在参数数组的 `--` 分隔之后传给 git——无 flag 注入、
 *  无 shell 注入面（不走 shell）；git 对仓库外 pathspec 自身报错不越界。故只拒
 *  空串与超长，空格/&/;/引号等合法文件名字符一概放行。 */
function validatePathArg(path: string): string | null {
  if (!path || path.length > MAX_REF_LEN) {
    return 'path 非法：必须是仓库内相对路径'
  }
  return null
}

export const GIT_SCOUT_TOOL: Tool = {
  definition: {
    name: 'git_scout',
    description: `只读 git 史实侦察（不修改仓库任何状态）。Actions:
- log: 提交历史，每行 \`<短sha>|<月-日 时:分>|<主题>\`（range 如 "A..B" 只列 B 可达而 A 不可达的提交；path 限定文件；maxCount 默认 50 上限 ${MAX_LOG}）
- count: 提交数（rev-list --count range；缺省 range 数 HEAD 全部历史）
- show: 单提交详情（sha | iso 日期 | refs | subject）
- tags: tag 列表（版本自然序）
- branches: 分支列表；contains 传 ref 时只列包含该提交的分支
- ancestry: 判定 a 是否为 b 的祖先 → YES/NO
- merge_base: a 与 b 的分叉点 sha
- resolve: ref/tag/branch/HEAD → 40-hex commit sha
- diff: a 与 b 间的 --stat（缺省 a/b 时对工作树）

纯查询：无 commit/checkout/reset/stash 等任何写动作。`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: '要执行的只读 git 操作',
        },
        range: {
          type: 'string',
          description: '提交区间（如 "A..B" 或 "HEAD"；log/count 用）',
        },
        ref: {
          type: 'string',
          description: 'ref 名/tag/sha（resolve/branches.contains 用）',
        },
        commit: {
          type: 'string',
          description: 'commit ref（show 用，默认 HEAD）',
        },
        a: { type: 'string', description: 'diff/ancestry/merge_base 的左侧 ref' },
        b: { type: 'string', description: 'diff/ancestry/merge_base 的右侧 ref（diff 缺省对工作树）' },
        path: {
          type: 'string',
          description: '限定 log/diff 到单个仓库内路径',
        },
        contains: {
          type: 'string',
          description: 'branches 过滤：只列包含该 ref 的分支',
        },
        maxCount: {
          type: 'number',
          description: `log 最大条数（默认 50，上限 ${MAX_LOG}）`,
        },
      },
      required: ['action'],
    },
  },

  async execute(params: ToolCallParams) {
    const input = params.input as Record<string, unknown>
    const action = input.action as ScoutAction
    const cwd = params.cwd

    if (!ACTIONS.includes(action)) {
      return {
        content: `git_scout 是只读侦察工具，不支持 action "${String(action)}"。支持：${ACTIONS.join(', ')}。写操作请走主控的 git/bash 工具。`,
        isError: true,
      }
    }

    try {
      switch (action) {
        case 'log': {
          const maxCount = validateMaxCount(input.maxCount)
          if (maxCount === null) {
            return { content: `maxCount 必须是 1-${MAX_LOG} 的整数`, isError: true }
          }
          const range = typeof input.range === 'string' ? input.range : undefined
          if (range !== undefined) {
            const err = validateRef(range, 'range')
            if (err) return { content: err, isError: true }
          }
          const path = typeof input.path === 'string' ? input.path : undefined
          if (path !== undefined) {
            const err = validatePathArg(path)
            if (err) return { content: err, isError: true }
          }
          const args = ['log', '-n', String(maxCount), '--date=format:%m-%d %H:%M', '--pretty=format:%h|%ad|%s']
          if (range !== undefined) args.push(range)
          if (path !== undefined) args.push('--', path)
          const { ok, output } = await runGitSafe(args, cwd, params.abortSignal)
          return ok
            ? { content: output || '(空——该区间/路径无提交)' }
            : { content: output, isError: true }
        }

        case 'count': {
          // range 缺省 = 数 HEAD 全部可达历史（git rev-list --count 无参语义）
          const range = typeof input.range === 'string' && input.range ? input.range : undefined
          if (range !== undefined) {
            const err = validateRef(range, 'range')
            if (err) return { content: err, isError: true }
          }
          const args = range !== undefined ? ['rev-list', '--count', range] : ['rev-list', '--count', 'HEAD']
          const { ok, output } = await runGitSafe(args, cwd, params.abortSignal)
          return ok ? { content: output } : { content: output, isError: true }
        }

        case 'show': {
          const commit = typeof input.commit === 'string' && input.commit ? input.commit : 'HEAD'
          const err = validateRef(commit, 'commit')
          if (err) return { content: err, isError: true }
          const { ok, output } = await runGitSafe(
            ['show', '-s', '--format=%H | %ad | %D | %s', '--date=iso', commit],
            cwd,
            params.abortSignal,
          )
          return ok ? { content: output } : { content: output, isError: true }
        }

        case 'tags': {
          const { ok, output } = await runGitSafe(['tag', '-l', '--sort=v:refname'], cwd, params.abortSignal)
          return ok ? { content: output || '(无 tag)' } : { content: output, isError: true }
        }

        case 'branches': {
          const contains = typeof input.contains === 'string' && input.contains ? input.contains : undefined
          if (contains !== undefined) {
            const err = validateRef(contains, 'contains')
            if (err) return { content: err, isError: true }
          }
          const args = contains !== undefined ? ['branch', '-a', '--contains', contains] : ['branch', '-a']
          const { ok, output } = await runGitSafe(args, cwd, params.abortSignal)
          return ok ? { content: output } : { content: output, isError: true }
        }

        case 'ancestry': {
          const a = typeof input.a === 'string' ? input.a : ''
          const b = typeof input.b === 'string' ? input.b : ''
          const errA = validateRef(a, 'a')
          if (errA) return { content: errA, isError: true }
          const errB = validateRef(b, 'b')
          if (errB) return { content: errB, isError: true }
          const { code, stderr } = await runGitExitCode(['merge-base', '--is-ancestor', a, b], cwd, params.abortSignal)
          if (code === 0) return { content: 'YES' }
          if (code === 1) return { content: 'NO' }
          return { content: `ancestry 判定失败（exit ${code}）：${stderr}`, isError: true }
        }

        case 'merge_base': {
          const a = typeof input.a === 'string' ? input.a : ''
          const b = typeof input.b === 'string' ? input.b : ''
          const errA = validateRef(a, 'a')
          if (errA) return { content: errA, isError: true }
          const errB = validateRef(b, 'b')
          if (errB) return { content: errB, isError: true }
          const { ok, output } = await runGitSafe(['merge-base', a, b], cwd, params.abortSignal)
          return ok ? { content: output } : { content: output || '两 ref 无共同祖先', isError: true }
        }

        case 'resolve': {
          const ref = typeof input.ref === 'string' && input.ref ? input.ref : ''
          const err = validateRef(ref, 'ref')
          if (err) return { content: err, isError: true }
          const { ok, output } = await runGitSafe(['rev-parse', '--verify', `${ref}^{commit}`], cwd, params.abortSignal)
          return ok ? { content: output } : { content: `无法解析 ref "${ref}"`, isError: true }
        }

        case 'diff': {
          const a = typeof input.a === 'string' && input.a ? input.a : undefined
          const b = typeof input.b === 'string' && input.b ? input.b : undefined
          for (const [v, label] of [[a, 'a'], [b, 'b']] as const) {
            if (v !== undefined) {
              const err = validateRef(v, label)
              if (err) return { content: err, isError: true }
            }
          }
          const path = typeof input.path === 'string' ? input.path : undefined
          if (path !== undefined) {
            const err = validatePathArg(path)
            if (err) return { content: err, isError: true }
          }
          const args = ['diff', '--stat']
          if (a !== undefined) args.push(a)
          if (b !== undefined) args.push(b)
          if (path !== undefined) args.push('--', path)
          const { ok, output } = await runGitSafe(args, cwd, params.abortSignal)
          return ok ? { content: output || '(无差异)' } : { content: output, isError: true }
        }
      }
    } catch (err) {
      return { content: `git_scout 执行失败：${err instanceof Error ? err.message : String(err)}`, isError: true }
    }

    // switch 全覆盖后的兜底（TS 穷尽检查）
    return { content: `未知 action：${String(action)}`, isError: true }
  },

  // 纯只读工具：永不要求审批（无写动作），可并发执行（readonly 并行侦察语义）
  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
