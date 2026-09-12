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
import { join } from 'node:path'
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

/** 锁被视为陈旧的墙钟上限。tsc 全量 43s，2 分钟是 timeout 默认值，10 分钟给足
 *  了慢机器与排队的余量——超过它基本只能是持锁者被 SIGKILL 后没跑 finally。 */
const STALE_LOCK_MS = 10 * 60_000
/** 缓存条目保留数量。多会话交替修改时各自的指纹会轮换，只留一份等于互相踢掉。 */
const MAX_CACHE_ENTRIES = 8
const WAIT_POLL_MS = 200

/**
 * 只有「tsc 真正跑完」的结果可以缓存：0 = 无错，1 = 有类型错误，两者都是编译器
 * 给出的结论。其余（null = 超时/被信号杀、2+ = 崩溃）是 **inconclusive**——
 * 缓存它等于把一次偶发超时固化成所有并发会话的共识，交付门禁会就此长期 fail-open。
 * 与 typecheck-gate 的进程内 memo 同一条纪律。
 */
export function isCacheableOutcome(outcome: TscRunOutcome): boolean {
  return outcome.status === 0 || outcome.status === 1
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
    }).trim()
    return top || cwd
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

/** 与陈旧锁上限对齐：超过它说明持锁者虽然活着但已经不正常，那时自己跑才有意义。 */
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
      // 持锁者失联才是放弃等待的正当理由——它死了才等不到结果。只要它还在推进，
      // 等下去几乎总优于自己跑：自己跑要付全额时间，还会抢走它的核心让两边都更慢。
      const holder = readLockOwner(cacheDir)
      if (holder && !isAlive(holder.pid)) break
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
