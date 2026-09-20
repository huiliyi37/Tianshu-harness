import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTypeCheck } from '../../client.js'

/**
 * Smoke test: verify require('typescript') loads and the compiler API pipeline
 * runs to completion in the current environment (tsx for tests, bundled dist
 * for production). If this fails (ranOk=false), the typecheck gate silently
 * becomes a no-op — every delivery gets a false GREEN.
 *
 * This is the ONLY test that exercises the real runTypeCheck path (all
 * typecheck-gate tests inject a mock runner). Without it, a require resolution
 * failure in the bundled dist would go undetected until production.
 *
 * Kept under src/lsp/__tests__/integration/ because it spawns a real tsc
 * subprocess over the whole repo — 全量套件里最贵的一项，空闲实测 35–50s，
 * 并发时更久。too slow for the unit fast path.
 */

/** 全仓 tsc 上限。上限存在的意义是「卡死要被发现」，不是「正常但慢要被误杀」。
 *  负载实测：空闲 35–50s、套件并发下 140–300s+ 波动——240s 预算在重载日会被
 *  正常命中（test 被 cancel，runTypeCheck 路径该轮零验证），按极端负载 +50% 余量放宽。
 *  2026-09-20 再放宽：仓库规模增长后全仓 tsc 空闲实测已到 ~400s（real 398s /
 *  user 92s，大头在 I/O 等待而非 CPU），420s 预算空闲单机都会命中。对齐当前
 *  真实基线 ×2 余量；真卡死仍会被 900s 上限抓到，只是更晚。 */
const TSC_BUDGET_MS = 900_000
/**
 * 单用例预算必须高于 `TSC_BUDGET_MS`，否则 node 会先把用例判超时，
 * 我们就拿不到 runTypeCheck 自己的超时诊断。也覆盖 runner 的全局 --test-timeout。
 */
const TEST_BUDGET_MS = TSC_BUDGET_MS + 60_000

/**
 * 跑一次，两个用例共享。此前两个用例各跑一遍全仓 tsc —— 等于每次 `npm test`
 * 白烧一次全量类型检查，是「跑测试就把机器拖死」的最大单项来源。
 */
let typeCheckOnce: Promise<Awaited<ReturnType<typeof runTypeCheck>>> | null = null
const runOnce = (): Promise<Awaited<ReturnType<typeof runTypeCheck>>> =>
  (typeCheckOnce ??= (() => {
    // 全仓 tsc 空闲 35–50s、并发负载下 200s+（实测 228s），静默期会触发 runner 的
    // 180s 闲置看门狗把整批误杀为「挂死」（D 波遗留 a 的真凶）。测试进程 stdout
    // 经 node --test 实时透传（已实测），每 20s 一行心跳保持批次活性。
    const heartbeat = setInterval(() => {
      process.stdout.write(`[client-typecheck] tsc still running @${new Date().toISOString()}\n`)
    }, 20_000)
    heartbeat.unref()
    return runTypeCheck(process.cwd(), '*', TSC_BUDGET_MS).finally(() => clearInterval(heartbeat))
  })())

test('runTypeCheck: require(typescript) loads and returns ranOk=true', { timeout: TEST_BUDGET_MS }, async () => {
  const res = await runOnce()
  assert.equal(res.ranOk, true, 'tsc must run to completion — if ranOk is false, require(typescript) failed to load')
  // A clean repo has 0 errors, but the key assertion is ranOk, not the count.
  assert.ok(Array.isArray(res.diagnostics), 'diagnostics must be an array')
})

test('runTypeCheck: diagnostics have valid structure when present', { timeout: TEST_BUDGET_MS }, async () => {
  const res = await runOnce()
  if (!res.ranOk) return // can't check structure if tsc didn't run
  for (const d of res.diagnostics) {
    assert.ok(typeof d.file === 'string', `diagnostic file must be string, got ${typeof d.file}`)
    assert.ok(typeof d.line === 'number', `diagnostic line must be number, got ${typeof d.line}`)
    assert.ok(typeof d.message === 'string', `diagnostic message must be string, got ${typeof d.message}`)
  }
})
