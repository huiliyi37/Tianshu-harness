import { glob, mkdir } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeTestFlags, resolveTestTimeoutMs } from './test-runner-flags.js'
import { runGuardedChild } from './test-child-guard.js'

const args = process.argv.slice(2)
const includeTui = !args.includes('--exclude-tui')
const integrationOnly = args.includes('--integration')
const unitOnly = args.includes('--unit') || args.includes('--fast') || args.includes('--exclude-tui')

// Positional (non-flag) args are substring filters over the file path, e.g.
// `npm test src/tools/web-search` runs only matching test files. Paths are
// normalized to forward slashes so Windows-style `\` filters also match.
const pathFilters = args
  .filter(a => !a.startsWith('--'))
  .map(a => a.replace(/\\/g, '/'))

// Temp dir policy: tests MUST get a temp dir OUTSIDE the repo when possible.
// An in-repo temp dir breaks fixture hermeticity — mkdtemp fixtures inside the
// repo let git discovery, node module resolution, tsc/tsconfig lookup and
// .rivet-config walk-up all "see" the real repo, which flips a dozen tests
// (checkpoint/git/worktree/theta/native-resolver/layered-config...).
// The in-repo .test-tmp fallback exists only for sandboxed runs where the OS
// temp dir is not writable (the original EPERM issue, commit 7cc487b2).
function resolveTestTmp(): string {
  try {
    const probe = mkdtempSync(join(tmpdir(), 'rivet-tmp-probe-'))
    rmSync(probe, { recursive: true, force: true })
    return tmpdir()
  } catch {
    return join(process.cwd(), '.test-tmp')
  }
}

const PROJECT_TMP = resolveTestTmp()
await mkdir(PROJECT_TMP, { recursive: true })

// `scripts/` 也要收：打包裁剪（wasm 白名单 / typescript 瘦身 / 外来平台包过滤）与
// 遥测探针的测试都住在那儿。曾经只 glob `src/`，那 4 个文件写了却从不执行——
// 裁剪逻辑错了会直接毁发布产物，恰恰是最需要门禁的一类。
const TEST_GLOBS = ['src/**/*.test.ts', 'scripts/**/*.test.ts']

const files: string[] = []
for await (const file of glob(TEST_GLOBS)) {
  const normalized = file.replace(/\\/g, '/')
  // scripts/cloudflare-update-worker 等嵌套包一旦 npm install 就会带进 node_modules
  if (normalized.includes('/node_modules/')) continue
  const isIntegration = normalized.includes('/integration/')
  if (integrationOnly && !isIntegration) continue
  if (unitOnly && isIntegration) continue
  if (!includeTui && normalized.includes('/tui/__tests__/')) continue
  if (pathFilters.length > 0 && !pathFilters.some(f => normalized.includes(f))) continue
  files.push(file)
}
files.sort()

if (files.length === 0) {
  console.error(
    pathFilters.length > 0
      ? `No test files matched: ${pathFilters.join(', ')}`
      : 'No test files found',
  )
  process.exit(1)
}

const testEnv = {
  ...process.env,
  TMPDIR: PROJECT_TMP,
  TMP: PROJECT_TMP,
  TEMP: PROJECT_TMP,
  // When the fallback in-repo temp dir is in use, stop git repo discovery
  // from walking up out of it into the real repo (test fixtures created via
  // mkdtemp expect "not a git repo"). Harmless for the OS temp dir case.
  GIT_CEILING_DIRECTORIES: PROJECT_TMP,
}

// 超时上限是防「电脑卡死」的关键：Node 不设 --test-timeout 就是 Infinity，任一测试
// 卡住整个批次进程就永久挂着，被遗弃的整跑会一直占 CPU 直到手动清理。曾攒下 4 个
// 跑满一天多的僵留进程，机器 15 分钟负载均值 76。详见 test-runner-flags.ts。
const NODE_FLAGS = nodeTestFlags(resolveTestTimeoutMs(process.env.RIVET_TEST_TIMEOUT))

// Windows caps a process command line at ~32767 chars; passing all ~900 test
// files at once overflows it (ENAMETOOLONG). Chunk the file list by cumulative
// arg length so each spawn stays well under the limit. node runs each test file
// in its own child regardless, so batching across invocations is equivalent.
const FIXED_LEN = process.execPath.length + NODE_FLAGS.join(' ').length + 8
const MAX_ARGS_LEN = 24_000 - FIXED_LEN

function batchFiles(all: string[]): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let len = 0
  for (const file of all) {
    const cost = file.length + 3 // path + quotes/space overhead
    if (current.length > 0 && len + cost > MAX_ARGS_LEN) {
      batches.push(current)
      current = []
      len = 0
    }
    current.push(file)
    len += cost
  }
  if (current.length > 0) batches.push(current)
  return batches
}

let shuttingDown = false
/** 触发中断的信号，用于收尾退出码（128+signum）。 */
let interruptSignal: NodeJS.Signals | null = null

// 被中断时必须带走子进程。此前 runner 没装信号处理：Ctrl-C / 终端关闭 / 工具取消
// 打断后，批次子进程会被 reparent 到 init 继续跑——实测捡到 4 个 PPID=1、跑满一天多
// 的僵留进程，合计吃掉约 50% CPU。
// 2026-09-12：杀子进程的职责移交 runGuardedChild（它是唯一持有 child 引用的地方，且
// 同时负责 idle/hard 看门狗收尾）；这里只立旗标，让批次循环在开下一批之前停下。
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return
    shuttingDown = true
    interruptSignal = sig
  })
}

interface BatchOutcome {
  code: number
  tests: number
  pass: number
  fail: number
  /** 是否见到 node 的汇总段。false = 跑了但什么都没验证。 */
  complete: boolean
}

/**
 * 跑一批，三个职责都交给 test-child-guard：plain 跑法（不强制提前退出，保住完整汇总）、
 * idle/hard 看门狗（真挂起时有界收场）、汇总完整性 fail-closed（没有 `ℹ tests` 行即判失败）。
 */
async function runBatch(batch: string[]): Promise<BatchOutcome> {
  const res = await runGuardedChild({ args: [...NODE_FLAGS, ...batch], env: testEnv })
  if (res.killed === 'idle') {
    console.error('⚠️  本批长时间无输出，看门狗已强制收场（子进程挂死或句柄未释放）。')
  } else if (res.killed === 'hard') {
    console.error('⚠️  本批超出总时长上限，看门狗已强制收场。')
  }
  if (!res.summarySeen) {
    console.error('⚠️  本批未打印汇总段（ℹ tests）——按 fail-closed 判失败：没有汇总等于没有验证。')
  }
  return {
    code: res.code,
    tests: res.tests ?? 0,
    pass: res.pass ?? 0,
    fail: res.fail ?? 0,
    complete: res.summarySeen,
  }
}

const batches = batchFiles(files)
if (batches.length > 1) {
  console.error(`Running ${files.length} test files in ${batches.length} batches (Windows cmdline limit)`)
}

let worstExit = 0
let totalTests = 0
let totalPass = 0
let totalFail = 0
for (const batch of batches) {
  if (shuttingDown) break
  const out = await runBatch(batch)
  totalTests += out.tests
  totalPass += out.pass
  totalFail += out.fail
  if (out.code !== 0) worstExit = out.code
}
if (batches.length > 1) {
  // 分批时各批各自打印汇总，这里再给一行跨批合计——否则总数得靠人肉加。
  console.error(`合计：${totalTests} 条（pass ${totalPass} / fail ${totalFail}）· ${batches.length} 批`)
}
process.exit(interruptSignal !== null ? 128 + (constants.signals[interruptSignal] ?? 15) : worstExit)
