/**
 * 跨进程共享的 typecheck 闸门——让并发会话「只跑一次」而不是各跑各的。
 *
 * 本仓库常有多个 agent 会话共用同一个工作树，而全量 `tsc --noEmit` 在这个
 * 仓库要 43s（2319 个文件）。两条路径都会触发它：
 *   ① `npm run typecheck`（人工/脚本）
 *   ② `lsp/client.ts::runTypeCheck` —— 交付门禁与 wave-gate 每次都跑全量
 * 并发跑不是线性变慢而是超线性退化（实测 5 路并发时单次从 43s 劣化到分钟级），
 * 因为它们抢的是同一批核心与内存带宽。
 *
 * 闸门做两件事：
 *   - **去重**：源码指纹一致 → 直接回放上一次结果，零耗时。共享工作树意味着
 *     并发会话检查的往往就是同一份代码，这一层命中率最高。
 *   - **串行**：指纹不同时排队，总吞吐高于并发抢核。
 *
 * ## 正确性优先于速度
 *
 * 缓存若让类型错误漏过交付门禁，代价远大于省下的 43 秒。因此：
 *   - 指纹**严格**匹配才复用：git HEAD + 每个脏文件的**内容** hash（不是 mtime，
 *     后者在同毫秒内的两次修改上会漏判）。
 *   - tsc 跑完**重算**指纹，与开跑时不一致就不写缓存——那 43 秒里源码若被改过，
 *     这份结果对应的是哪个版本已不可知。
 *   - 任何一步出错（非 git 仓库、锁坏了、缓存读不动）一律 fail-open 直接跑，
 *     闸门只做加速，不做正确性判断。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join, sep } from 'node:path'
import { freeDiskBytes, diskWarnThresholdMb } from '../utils/disk-space.js'

/** tsc 一次运行的原始产物。缓存的是它而不是解析后的诊断——调用方的 filePath
 *  过滤发生在解析之后，缓存原始输出才能让不同 filePath 的调用共享同一份。 */
export interface TscRunOutcome {
  status: number | null
  stdout: string
  stderr: string
}

export interface CachedTypecheck extends TscRunOutcome {
  fingerprint: string
  finishedAt: number
  durationMs: number
}

export type TypecheckShareEvent =
  | { kind: 'cache-hit'; fingerprint: string; ageMs: number }
  | { kind: 'reuse-after-wait'; fingerprint: string; waitedMs: number }
  | { kind: 'waiting'; holderPid: number | undefined }
  | { kind: 'wait-timeout'; waitedMs: number }
  | { kind: 'stale-lock-cleared'; holderPid: number | undefined }
  | { kind: 'cache-skip-low-disk'; freeBytes: number }
  | { kind: 'ran'; fingerprint: string | undefined; durationMs: number; cached: boolean }

export interface TypecheckShareDeps {
  now?: () => number
  isProcessAlive?: (pid: number) => boolean
  /** 覆盖缓存根目录。默认 `<cwd>/node_modules/.cache/rivet-typecheck`。 */
  cacheDir?: string
  onEvent?: (event: TypecheckShareEvent) => void
}

/** 锁被视为陈旧的墙钟上限。tsc 全量实测 15.5s（空载）→ 41s（4-5 路并发劣化），
 *  满载"几分钟"——300s（≈实测上界的数倍）之后仍持有的锁基本只能是持锁者被
 *  SIGKILL 没跑 finally，或锁泄漏（2026-10-08 实测：桌面端 serve 进程持锁 ≥10
 *  分钟且无 tsc 子进程在跑，后到的每个等待者都白等满旧上限 600s）。
 *  误清"真在慢跑"的锁的代价是并发跑（fail-open 既有语义，见 runTypecheckShared
 *  的「拿不到也继续」），远小于白等 10 分钟的反复代价——600→300 是二者再平衡。 */
export const STALE_LOCK_MS = 5 * 60_000
/**
 * 调用方（bash 工具等）应给全量类型检查留的工具级预算——**必须大于闸门的等待
 * 上限**，因为等待者可能排在 N-1 个实跑后面。
 *
 * 2026-09-14 实测：并发期单次实跑从空闲的 15.5s 劣化到 41.0s（缓存记录 8 条），
 * 4~5 路并发就足以让最后一个等待者越过 120s。工具管线的默认预算正是 120s，
 * 于是 worker 编队里必然出现 `[tool-timeout] bash timed out after 120s`——
 * 不是命令慢，是调用方给的预算小于闸门设计的等待上限。
 *
 * +3 分钟给 tsc 在等待结束后自己跑完。
 */
export const TYPECHECK_CALLER_BUDGET_MS = STALE_LOCK_MS + 3 * 60_000
/**
 * 调用方（bash 工具）本次该给这条命令多少超时预算——**只抬不压**。
 *
 * typecheck 形态要先过本模块的跨进程共享闸门，等待上限是
 * `TYPECHECK_CALLER_BUDGET_MS`。调用方给更小的值不会让它更快：只会让命令在
 * 闸门前被 SIGTERM，拿到 exit=-1 与（被 `| tail` 吞成）零输出，于是 ledger 记
 * 「验证超时」、`deliver_task` 拒绝提交、harness 再重试两轮。
 *
 * 2026-09-25 取证：tianshu-3.15 最近 7 个会话里含 typecheck 的 bash 调用 21 次，
 * 模型最常显式传 420000（8 次）。此前只有**声明侧**（`BASH_TOOL.timeoutMs`，
 * 2026-09-14）对齐了闸门预算，**执行侧**仍按调用方值落刀，比闸门早 6 分钟；
 * 交付门 31 次调用 20 次 error、RED 为 0，全部出自这条链。
 *
 * `RIVET_TYPECHECK_SHARE=0`（与共享锁同一逃生口）下闸门不生效，原样返回。
 */
/** 测试运行的专用闸门预算。全量约 52s，5 分钟足以吸收冷启动与 CPU 竞争。
 *  **有界是刻意的**：不给它 `TYPECHECK_CALLER_BUDGET_MS` 那 13 分钟——后者长是因为
 *  要等跨进程共享锁排队，测试不参与那把锁。 */
export const TEST_RUNNER_CALLER_BUDGET_MS = 5 * 60_000

export function resolveCallerTimeoutBudget(command: string, requestedMs: number, defaultMs: number): number {
  const requested = requestedMs > 0 ? requestedMs : defaultMs
  if (process.env.RIVET_TYPECHECK_SHARE === '0') return requested
  const gate = isTypecheckCommand(command) ? TYPECHECK_CALLER_BUDGET_MS
    : isTestRunnerCommand(command) ? TEST_RUNNER_CALLER_BUDGET_MS
    : 0
  return gate > 0 ? Math.max(requested, gate) : requested
}

/**
 * typecheck 形态命令超时时给模型的下一步。
 *
 * 放在这里而不是 bash 工具里：它不只是文案，是闸门语义的一部分（「被杀 = 本次
 * 没结果」≠「代码有问题」）；且 bash.ts 是点名巨石、只降不升（见
 * `scripts/source-budgets.manifest.json` 的 budgets）。
 */
export const TYPECHECK_TIMEOUT_HINT =
  '命令超时（typecheck 形态）：该命令要过跨进程共享闸门，排队等待可能长于本次预算，中途被杀不会产出任何结果。'
  + '\n下一步：用 run_in_background=true 重跑，再 job(action="await", id=...) 取结果——不要据此判定代码有问题。'

/**
 * 外层工具看门狗（`tool-pipeline` 读 `toolDef.timeoutMs`）比内层执行预算多留的余量。
 *
 * 两侧预算**相等**时看门狗必然先落刀：它在 tool-pipeline 读到声明值时就武装
 * （`execute` 之前），而内层 SIGTERM 定时器要等子进程起来才武装。后果是上面那段
 * `TYPECHECK_TIMEOUT_HINT`（专教模型改走 `run_in_background` 的引导）永远投递不
 * 出去，模型只拿到通用超时文案，于是重试同一条会挂死的路径——4a6380d5c 想改善的
 * 场景没生效（2026-09-25 二修）。
 *
 * 余量给内层「杀进程树（SIGTERM → 3s 后 SIGKILL）→ 整理输出 → 返回」留时间；
 * 30s 相对 13 分钟的总预算不到 4%，不会把兜底拖成实质失效。
 */
export const TYPECHECK_WATCHDOG_MARGIN_MS = 30_000

/**
 * 工具级**声明**预算（外层看门狗）——必须**严格大于**执行侧的 `resolveCallerTimeoutBudget`。
 * 这个大小关系是不变量而非巧合：相等即专用超时文案不可达（见上一段的机制）。
 * `bash-typecheck-timeout.test.ts` 的「声明侧必须严格大于执行侧」钉住它。
 *
 * 非 typecheck 形态原样返回 `defaultMs`（不参与抬升，与修复前一致）。
 */
export function resolveWatchdogTimeout(command: string, requestedMs: number, defaultMs: number): number {
  if (!isGateBudgetCommand(command)) return defaultMs
  return resolveCallerTimeoutBudget(command, requestedMs, defaultMs) + TYPECHECK_WATCHDOG_MARGIN_MS
}

/** 缓存条目保留数量。多会话交替修改时各自的指纹会轮换，只留一份等于互相踢掉。 */
const MAX_CACHE_ENTRIES = 16
const WAIT_POLL_MS = 200

/**
 * 只有「tsc 真正跑完」的结果可以缓存：TypeScript ExitStatus 的 0 = 无错，
 * 1/2 = 诊断存在、输出跳过/生成，都属于编译器结论，有诊断不等于检查通过。
 * 其余（null = 超时/被信号杀，其他状态 = 不完整/未知）是 **inconclusive**——
 * 缓存它等于把一次偶发超时固化成所有并发会话的共识，交付门禁会就此长期 fail-open。
 * 与 typecheck-gate 的进程内 memo 同一条纪律。
 */
export function isCacheableOutcome(outcome: TscRunOutcome): boolean {
  return outcome.status === 0 || outcome.status === 1 || outcome.status === 2
}

const defaultNow = () => Date.now()
const defaultIsAlive = (pid: number): boolean => {
  try {
    // signal 0 不发信号，只做存在性与权限检查。
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = 进程存在但不属于当前用户；仍算存活，清掉别人的锁更危险。
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function defaultCacheDir(cwd: string): string {
  return join(cwd, 'node_modules', '.cache', 'rivet-typecheck')
}

// ── 源码指纹 ────────────────────────────────────────────────────────────

/**
 * 返回 git 的**原始** stdout，不做 trim。
 *
 * porcelain 记录的前两个字符是状态位，未暂存的修改形如 ` M src/a.ts`——前导空格
 * 有语义。trim 掉它会让后续的固定偏移切片取到 `rc/a.ts`，路径前缀对不上就被
 * 当作「与类型检查无关」过滤掉，最终表现为改了源码指纹却不变、缓存无限回放旧结果。
 * 需要去尾换行的调用方（rev-parse）自己 trim。
 */
function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
  } catch {
    return undefined
  }
}

/** 只有能影响 `tsc --noEmit` 结果的路径才进指纹。改一篇 markdown 不该让所有
 *  会话的缓存失效——过滤掉它们能显著抬高命中率。
 *  2026-09-12 改为目录无关（cwd 感知）：此前只认 src/ 下 .ts，desktop/ 等
 *  非 src 树的改动不改变指纹——ad-hoc 调用（bash tsc，cwd 可以是任意子项目）
 *  开回放后会拿到陈旧结果。现按扩展名与清单文件判定（node_modules 除外），
 *  跨项目共用一份保守正确的指纹：无关子项目的改动只降低命中率，不影响正确性。 */
export function affectsTypecheck(path: string): boolean {
  if (path.includes('/node_modules/') || path.startsWith('node_modules/')) return false
  const base = path.split('/').pop() ?? path
  if (
    base === 'tsconfig.json' || /^tsconfig\..+\.json$/.test(base) || base === 'jsconfig.json' ||
    base === 'package.json' || base === 'package-lock.json' || base === 'pnpm-lock.yaml' || base === 'yarn.lock'
  ) return true
  return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|json)$/.test(base)
}

/**
 * 计算「当前工作树在类型检查视角下的身份」。
 *
 * HEAD 覆盖已提交的部分（O(1)），`git status --porcelain` 找出未提交的差异，
 * 再对这些脏文件逐个算内容 hash。脏文件通常只有几个到几十个，成本远低于把
 * 2319 个文件全读一遍，精度却相同。
 *
 * `variant` 用于区分调用形态：门禁跑 `--pretty false`（机器解析），npm script
 * 跑带颜色的默认格式，两者的原始输出**不能互相回放**。把它混进指纹即可让两组
 * 缓存自然分桶，同时仍共享同一把锁（串行化不受影响）。
 *
 * 返回 undefined 表示无法可靠指纹（非 git 仓库、git 不可用），调用方应直接跑。
 */
export function computeSourceFingerprint(cwd: string, variant = ''): string | undefined {
  const head = git(cwd, ['rev-parse', 'HEAD'])?.trim()
  if (head === undefined) return undefined

  // -z：文件名以 NUL 分隔，规避空格/引号/非 ASCII 路径的转义歧义。
  const status = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (status === undefined) return undefined

  const hash = createHash('sha256')
  hash.update(variant)
  hash.update('\0')
  hash.update(head)

  for (const path of parsePorcelainPaths(status)) {
    if (!affectsTypecheck(path)) continue
    hash.update('\0')
    hash.update(path)
    hash.update('\0')
    try {
      hash.update(createHash('sha256').update(readFileSync(join(cwd, path))).digest('hex'))
    } catch {
      // 读不到（刚被删/权限）——把状态本身编码进去，删除同样会改变类型检查结果。
      hash.update('<unreadable>')
    }
  }

  return hash.digest('hex')
}

/**
 * 解析 `git status --porcelain=v1 -z` 的记录。
 *
 * 每条形如 `XY <path>`，NUL 结尾；重命名/复制（R/C）额外**再跟一个** NUL 分隔的
 * 原路径字段。漏掉这条规则会把原路径当成下一条记录的状态位解析，导致后续整段错位。
 */
export function parsePorcelainPaths(raw: string): string[] {
  const fields = raw.split('\0')
  const paths: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (!entry || entry.length < 4) continue
    const statusCode = entry.slice(0, 2)
    paths.push(entry.slice(3))
    // 重命名/复制的来源路径占用下一个字段，两侧都要计入指纹。
    if (statusCode.includes('R') || statusCode.includes('C')) {
      const from = fields[++i]
      if (from) paths.push(from)
    }
  }
  return paths
}

// ── 结果缓存 ────────────────────────────────────────────────────────────

function entryPath(cacheDir: string, fingerprint: string): string {
  return join(cacheDir, `${fingerprint.slice(0, 32)}.json`)
}

export function readCachedTypecheck(
  cacheDir: string,
  fingerprint: string,
): CachedTypecheck | undefined {
  try {
    const parsed = JSON.parse(readFileSync(entryPath(cacheDir, fingerprint), 'utf-8')) as CachedTypecheck
    // 指纹前缀做文件名，理论上可碰撞——回读时校验全量指纹。
    if (parsed.fingerprint !== fingerprint) return undefined
    if (typeof parsed.stdout !== 'string' || typeof parsed.stderr !== 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function writeCachedTypecheck(cacheDir: string, entry: CachedTypecheck): void {
  try {
    mkdirSync(cacheDir, { recursive: true })
    // 先写临时文件再 rename：并发读者要么看到旧的完整文件，要么看到新的完整文件，
    // 不会读到写了一半的 JSON。
    const target = entryPath(cacheDir, entry.fingerprint)
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(entry), 'utf-8')
    renameSync(tmp, target)
    pruneCache(cacheDir)
  } catch {
    // 缓存写不进去不影响本次结果，静默降级。
  }
}

function pruneCache(cacheDir: string): void {
  try {
    const files = readdirSync(cacheDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const full = join(cacheDir, f)
        return { full, mtime: statSync(full).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
    for (const stale of files.slice(MAX_CACHE_ENTRIES)) rmSync(stale.full, { force: true })
  } catch {
    /* prune 失败无害 */
  }
}

// ── 互斥锁 ──────────────────────────────────────────────────────────────

interface LockOwner {
  pid: number
  startedAt: number
  fingerprint?: string
}

export interface LockHandle {
  release(): void
}

function lockDirPath(cacheDir: string): string {
  return join(cacheDir, 'run.lock')
}

function readLockOwner(cacheDir: string): LockOwner | undefined {
  try {
    return JSON.parse(readFileSync(join(lockDirPath(cacheDir), 'owner.json'), 'utf-8')) as LockOwner
  } catch {
    return undefined
  }
}

/**
 * 尝试拿锁。`mkdir` 在 POSIX 与 Windows 上都是原子的——已存在即抛 EEXIST，
 * 这正是「测试并设置」语义，不需要额外依赖。
 *
 * 拿不到时会检查持锁者是否已经死了（被 SIGKILL 的进程跑不到 finally），
 * 陈旧则清掉重试一次。
 */
export function tryAcquireLock(
  cacheDir: string,
  fingerprint: string | undefined,
  deps: TypecheckShareDeps = {},
): LockHandle | undefined {
  const now = deps.now ?? defaultNow
  const isAlive = deps.isProcessAlive ?? defaultIsAlive
  const dir = lockDirPath(cacheDir)

  const attempt = (): LockHandle | undefined => {
    try {
      mkdirSync(cacheDir, { recursive: true })
      mkdirSync(dir) // 不加 recursive：已存在时必须抛错，那是锁的语义
    } catch {
      return undefined
    }
    const owner: LockOwner = { pid: process.pid, startedAt: now(), ...(fingerprint ? { fingerprint } : {}) }
    try {
      writeFileSync(join(dir, 'owner.json'), JSON.stringify(owner), 'utf-8')
    } catch {
      /* 锁目录已建立即算持有，owner 元数据只服务于陈旧判定 */
    }
    return {
      release: () => {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* 清不掉就留给陈旧检测兜底 */
        }
      },
    }
  }

  const handle = attempt()
  if (handle) return handle

  const owner = readLockOwner(cacheDir)
  const stale = owner === undefined
    ? // 有锁目录却没有可读的 owner：要么正在建立（几微秒的窗口），要么是残骸。
      // 按未陈旧处理，交给等待逻辑，避免抢掉一把刚建好的锁。
      false
    : !isAlive(owner.pid) || now() - owner.startedAt > STALE_LOCK_MS

  if (!stale) return undefined

  deps.onEvent?.({ kind: 'stale-lock-cleared', holderPid: owner?.pid })
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    return undefined
  }
  return attempt()
}

export function isLockHeld(cacheDir: string): boolean {
  return existsSync(lockDirPath(cacheDir))
}

// ── ad-hoc 调用串行（bash 工具收口） ─────────────────────────────────────

/**
 * 判断一条 shell 命令是否是「全量类型检查」形态——npx/pnpm 直跑 tsc --noEmit
 * 或包管理器的 typecheck script。worker/会话经 bash 工具 ad-hoc 跑 tsc 时绕过
 * 门禁的串行锁，N 个并发 tsc 抢同一批核心是超线性退化（2026-09-12 galaxy 波
 * 实测工作区 17-19 个并发 tsc 互相饿死、无一取得 exit code）。tsc --watch
 * 等长跑形态不在此列（它们走后台 job 通道）。
 */
export function isTypecheckCommand(command: string): boolean {
  // --watch 是长跑形态：进程永不退出。送进闸门等于占着跨进程锁不放（真正的
  // typecheck 反被它挡住），前台跑还会一路等到工具超时。下面那条的注释早就
  // 声明了这个意图，但 2026-09-14 探针实测正则并未排除它
  // （`tsc --noEmit --watch` → true）。收口对象是「跑得完的检查」，
  // 长跑形态走后台 job 通道。
  if (/--watch\b/i.test(command)) return false
  // tsc --noEmit（允许 npx/pnpm/yarn/bun(bunx)/npm exec 前缀、vue-tsc 变体、
  // 路径形态调用）——前缀必须落在命令边界（^/&/;/|/( 或路径 /），字符串里
  // 提及 tsc 不算数；--watch 等长跑形态不匹配（走后台 job 通道）。
  if (/(?:^|[;&|(/])\s*(?:(?:npx|pnpm|yarn|bun|bunx|npm)\s+(?:exec\s+(?:--\s*)?)?)?(?:vue-tsc|tsc)\b[^;&|]*--noEmit\b/i.test(command)) return true
  // 包管理器的 typecheck script（script 内同样是 tsc --noEmit）；typecheck:watch
  // 等派生 script 不匹配。
  if (/(?:^|[;&|])\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?typecheck(?:\s|$|[;&|)])/i.test(command)) return true
  return false
}

/**
 * 判断一条 shell 命令是否是「测试运行」形态。
 *
 * 与 `bash-verification.ts::inferBashVerificationScope` 的对齐口径：**full 形态
 * （`npm test` / `node|tsx --test` / 裸 `vitest run` 等）两链一致**——只抬预算
 * 却换不来 passed 记录的空转必须避免。派生形态（`npm run test:unit` 等）两链
 * 刻意不同：预算链多认（子集也可能跑得久），验证链记 unknown（子集不该满足
 * full-scope 覆盖义务）——这不是漂移，是语义差异。`cargo test`/`go test`/`bun
 * test` 的覆盖差异同理（本仓 TS 为主，失效方向安全：预算宽松、记录严格）。
 *
 * 动机（2026-10-05 取证）：`npm test` 全量约 52s，但非 typecheck 形态只拿工具
 * 默认 120s；多会话共享工作区的 CPU 竞争下必然撞超时被杀，结果被超时占位替换 →
 * 无 exitCode、无输出计数 → verification 恒 `blocked` → 交付门禁的
 * full-scope 覆盖义务永远无法满足（**核心改动结构性无法提交**）。实测锚点：
 * `npm test` 记录 `scope:full, kind:test` 但无 `exitCode` 字段、`passed:0`，
 * 而同一条 `npm run typecheck`（13.7s 跑得完）带 `exitCode:2`。
 *
 * typecheck 形态早已有闸门预算（见 resolveCallerTimeoutBudget 的注释）；测试运行
 * 同属「跑得完但可能慢」的闸门命令，故一并纳入。`--watch` 类长跑形态不在此列
 * （进程永不退出，走后台 job 通道）。
 */
export function isTestRunnerCommand(command: string): boolean {
  if (/--watch\b/i.test(command)) return false
  // 包管理器的 test script（含 test:unit / test:desktop 等派生 script）。
  if (/(?:^|[;&|])\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)?(?:\s|$|[;&|)])/i.test(command)) return true
  // node/tsx 内置 test runner（允许 npx 等前缀；带 filter/文件参数同样算）。
  if (/(?:^|[;&|(/])\s*(?:(?:npx|pnpm|yarn|bun|bunx)\s+)?(?:node|tsx)\s+--test\b/i.test(command)) return true
  // 独立测试框架。
  if (/(?:^|[;&|(/])\s*(?:(?:npx|pnpm|yarn|bun|bunx)\s+)?(?:vitest|jest|pytest)\b/i.test(command)) return true
  return false
}

/** 走闸门超时预算的命令形态：全量类型检查 + 测试运行。 */
export function isGateBudgetCommand(command: string): boolean {
  return isTypecheckCommand(command) || isTestRunnerCommand(command)
}

/**
 * 锁/缓存根解析：cwd 的 git 顶层——在子目录里起的会话与在根目录的调用共享
 * 同一把锁（此前锁键是裸 cwd，`cd src/` 起会话就脱出 repo 级串行）。隔离
 * worktree 的 toplevel 是 worktree 自身，但其 node_modules 是指向主仓的
 * symlink → 缓存目录物理上仍是主仓同一把。非 git 目录回退 cwd 本身。
 */
export function resolveTypecheckLockRoot(cwd: string): string {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      // Windows：GUI 宿主下不加会闪控制台窗口（架构守卫 spawn-family 检查项）
      windowsHide: true,
    }).trim()
    // 归一为平台原生形态：git 在 Windows 上输出正斜杠（C:/...），而 catch /
    // 空输出分支返回的 cwd 是原生形态——两分支不同形态会让同一仓库以两种
    // 字符串进锁/缓存键（跨形态重复锁）。POSIX 上无变化。
    return top ? top.replaceAll('/', sep) : cwd
  } catch {
    return cwd
  }
}

/**
 * bash 工具的 ad-hoc tsc 收口：锁根 git-toplevel 化 + 共享缓存去重/串行。
 * 回放安全前提：variant = cwd + 原始命令全文（同目录同命令才共享结果），
 * 且 affectsTypecheck 已目录无关（desktop 等子项目改动同样使指纹失效）。
 * 真跑时 `run` 同时交出原始结果（live）与可缓存 outcome——调用方据此区分
 * 「真跑」与「回放」，回放时自行重建带标注的结果。
 */
export async function runAdhocTypecheckShared<T>(options: {
  cwd: string
  command: string
  run: () => Promise<{ live: T; outcome: TscRunOutcome }>
  /** 额外否决缓存写（如内容含会话级 artifact 引用，跨会话回放会悬空）。 */
  cacheable?: (outcome: TscRunOutcome) => boolean
  onEvent?: (event: TypecheckShareEvent) => void
}): Promise<{ kind: 'live'; live: T } | { kind: 'replay'; outcome: TscRunOutcome }> {
  let live: T | undefined
  const outcome = await runTypecheckShared({
    cwd: resolveTypecheckLockRoot(options.cwd),
    variant: `bash-adhoc\n${options.cwd}\n${options.command}`,
    cacheable: options.cacheable,
    onEvent: options.onEvent,
    run: async () => {
      const r = await options.run()
      live = r.live
      return r.outcome
    },
  })
  return live !== undefined ? { kind: 'live', live } : { kind: 'replay', outcome }
}

/** 后台 job 通道的尽力串行：拿得到锁就持有到 job 退出（调用方负责释放），
 *  拿不到 fail-open 直接跑——闸门只护负载，从不阻断检查本身。 */
export function tryAcquireAdhocLock(cwd: string): LockHandle | undefined {
  return tryAcquireLock(defaultCacheDir(resolveTypecheckLockRoot(cwd)), undefined)
}

// ── 编排 ────────────────────────────────────────────────────────────────

export interface RunSharedOptions extends TypecheckShareDeps {
  cwd: string
  /** 真正执行 tsc。注入而非内建，让调用方保留自己的 spawn 细节（超时、参数、平台差异）。 */
  run: () => Promise<TscRunOutcome>
  /**
   * 等待持锁者的墙钟上限，**兜底而非常规退出条件**。
   *
   * 常规退出是「持锁者释放了锁」或「持锁者进程没了」。预算耗尽只应发生在持锁者
   * 卡死却仍存活这种病态情形。别把它设小：tsc 的耗时随机器负载膨胀（本仓库空闲
   * 43s，满载可到几分钟），而闸门恰恰在高负载时最该生效——预算设小的后果是等待者
   * 齐刷刷超时后各自开跑，白等一场还把负载推得更高，闸门自己制造了要解决的问题。
   */
  waitBudgetMs?: number
  /** 调用形态标识（通常就是 tsc 参数）。输出格式不同的调用不可互相回放，
   *  见 {@link computeSourceFingerprint}。 */
  variant?: string
  /** 额外的缓存写否决（默认放行）。ad-hoc 调用方用它排除「内容含会话级
   *  artifact 引用」等跨进程回放会悬空的结果——与 isCacheableOutcome 是
   *  与关系。 */
  cacheable?: (outcome: TscRunOutcome) => boolean
}

/** 兜底等待上限（=陈旧阈值）：循环已在「失联/超龄」时提前 break 接管，本预算
 *  只应发生在漏判的病态情形。别把它调小——等待者齐刷超时各自开跑会抬高负载。 */
const DEFAULT_WAIT_BUDGET_MS = STALE_LOCK_MS

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * 带去重与串行的 typecheck 执行。语义上等价于直接调 `run()`，只是可能改为
 * 回放一份指纹相同的既有结果，或先排队等别的进程跑完。
 */
export async function runTypecheckShared(options: RunSharedOptions): Promise<TscRunOutcome> {
  const { cwd, run } = options
  const now = options.now ?? defaultNow
  const cacheDir = options.cacheDir ?? defaultCacheDir(cwd)
  const emit = options.onEvent ?? (() => { })
  const waitBudget = options.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS

  const fingerprint = computeSourceFingerprint(cwd, options.variant)
  if (fingerprint === undefined) {
    // 指纹算不出来（非 git 仓库等）→ 没有可靠的复用依据，直接跑。
    const started = now()
    const outcome = await run()
    emit({ kind: 'ran', fingerprint: undefined, durationMs: now() - started, cached: false })
    return outcome
  }

  const hit = readCachedTypecheck(cacheDir, fingerprint)
  if (hit) {
    emit({ kind: 'cache-hit', fingerprint, ageMs: now() - hit.finishedAt })
    return { status: hit.status, stdout: hit.stdout, stderr: hit.stderr }
  }

  let lock = tryAcquireLock(cacheDir, fingerprint, options)
  if (!lock) {
    const isAlive = options.isProcessAlive ?? defaultIsAlive
    emit({ kind: 'waiting', holderPid: readLockOwner(cacheDir)?.pid })
    const waitStarted = now()
    let timedOut = false
    for (;;) {
      if (now() - waitStarted >= waitBudget) { timedOut = true; break }
      await sleep(WAIT_POLL_MS)
      // 先查缓存再查锁：持锁者写完缓存到释放锁之间有个窗口，命中就不必再等。
      const afterWait = readCachedTypecheck(cacheDir, fingerprint)
      if (afterWait) {
        emit({ kind: 'reuse-after-wait', fingerprint, waitedMs: now() - waitStarted })
        return { status: afterWait.status, stdout: afterWait.stdout, stderr: afterWait.stderr }
      }
      if (!isLockHeld(cacheDir)) break
      // 持锁者失联或持有超龄才是放弃等待的正当理由——失联等不到结果；超龄
      // （>STALE_LOCK_MS，已远超 tsc 上界）说明这把锁大概率泄漏，不会再产出结果。
      // 立即 break 交下方 tryAcquireLock 清理接管，不白等满 waitBudget
      //（2026-10-08：泄漏锁曾让每个等待者白等满旧上限 600s）。
      const holder = readLockOwner(cacheDir)
      if (holder && (!isAlive(holder.pid) || now() - holder.startedAt > STALE_LOCK_MS)) break
    }
    if (timedOut) emit({ kind: 'wait-timeout', waitedMs: now() - waitStarted })
    // 拿不到也继续：并发跑回退到闸门接入前的行为，永远不因为锁而不检查。
    lock = tryAcquireLock(cacheDir, fingerprint, options)
  }

  const started = now()
  try {
    const outcome = await run()
    const durationMs = now() - started
    // 复算指纹：这几十秒里源码若被别的会话改过，这份结果对应哪个版本已不可知，
    // 缓存它就是在为后来者埋一个「看起来命中、其实检查的是旧代码」的坑。
    // 先判可缓存性再算指纹——超时结果无论如何都不写，省掉一次 git 调用。
    const settled = isCacheableOutcome(outcome)
      && (options.cacheable?.(outcome) ?? true)
      && computeSourceFingerprint(cwd, options.variant) === fingerprint
    if (settled) {
      // 磁盘水位防线（2026-09-12，termux worker 被 100% 满磁盘卡死事故）：
      // 低水位时写缓存只会再失败或再挤占——跳过并出事件，不阻断结果返回。
      const free = freeDiskBytes(cacheDir)
      const thresholdMb = diskWarnThresholdMb()
      if (free !== undefined && thresholdMb > 0 && free < thresholdMb * 1024 * 1024) {
        emit({ kind: 'cache-skip-low-disk', freeBytes: free })
      } else {
        writeCachedTypecheck(cacheDir, { ...outcome, fingerprint, finishedAt: now(), durationMs })
      }
    }
    emit({ kind: 'ran', fingerprint, durationMs, cached: settled })
    return outcome
  } finally {
    lock?.release()
  }
}
