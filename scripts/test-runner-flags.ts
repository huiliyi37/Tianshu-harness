/**
 * 测试 runner 的 node 参数构造。单独成模块只为可单测 —— runner 本体是顶层脚本，
 * import 它就会真的去跑测试。
 */

/**
 * 单个测试的墙钟上限，只用来兜挂死，不该误杀慢测试。
 *
 * 定值依据（2026-07-29 全量实测 16,140 条时长）：单用例最慢 40s
 * （`T3: respects Pro upgrade limit`），另有 3 个 30s 档；p99 约 1.2s。
 * 取 120s ≈ 最慢用例的 3 倍余量。注意 `DelegationCoordinator (160s)` 之类是
 * **suite 汇总**不是单用例，别拿它定阈值。
 *
 * 真正需要更久的用例（如全仓 tsc）自己用 `test(name, { timeout }, fn)` 申报，
 * 单用例声明优先于此默认值。
 */
export const DEFAULT_TEST_TIMEOUT_MS = 120_000

/**
 * 解析 `RIVET_TEST_TIMEOUT`。非法值（空/非数字/非正/无穷）一律退回默认值——
 * 直接 `Number(raw)` 会把拼错的值变成 `--test-timeout=NaN`，那是整套测试跑不起来，
 * 比忽略这个覆盖严重得多。
 */
export function resolveTestTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TEST_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TEST_TIMEOUT_MS
  return parsed
}

/**
 * 批次子进程的 node 参数。
 *
 * `--test-timeout` 是硬性要求：Node 不设它就是 Infinity，任一测试卡住（子进程未回收、
 * socket/watcher/定时器未关）整个批次就永久挂着。曾因此攒下 4 个跑满一天多的僵留进程。
 *
 * **`--test-force-exit` 已于 2026-09-12 移除（实测翻转 2026-08-02 的结论）**：该 flag
 * 会让 node 在部分子进程结果未到齐时提前判定完成并退出，丢掉的用例既不计入
 * `ℹ tests` 也不进退出码。同一批 desktop 197 文件实测四次报 1523 / 1640 / 1661 /
 * 无汇总（四次 exit 0、fail 0），而同批 plain 跑两次稳定报 1789 且进程正常退出；
 * `--test-concurrency=1` 也救不了（1752）。它原本承担的「测试跑完但句柄未释放时收场」
 * 职责，改由 `scripts/test-child-guard.ts` 的 idle / hard 看门狗 + 汇总完整性
 * fail-closed 闸接管——护栏不减，但不再以"静默少跑"为代价。
 */
export function nodeTestFlags(timeoutMs: number): string[] {
  return ['--import', 'tsx', `--test-timeout=${timeoutMs}`, '--test']
}
