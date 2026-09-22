import {
  computeSourceFingerprint,
  readCachedTypecheck,
  defaultCacheDir,
  isLockHeld,
} from '../lsp/typecheck-cache.js'
import { TSC_GATE_VARIANT } from '../lsp/client.js'

/** Theta 尝试的诚实归因——每个返回值都说得清「这次到底发生了什么」。
 *  - ok: 回放到一份「tsc 退出 0、无类型错误」的验证期结论
 *  - type_errors: 回放到有类型错误的结论（errors 可能因解析不到文件而为空）
 *  - timeout: 内层预算超时（唯一推进连续超时退避的结局）。
 *    **2026-09-22 起 theta 不再自己跑 tsc，此 outcome 不再由本模块产出**；保留在
 *    联合类型里是为了兼容既有 meta（thetaCheckSummary.outcomes）与旧缓存条目。
 *  - spawn_error: tsc spawn 失败。同上，保留仅为兼容旧数据。
 *  - busy: 闸门正持锁实跑——不抢锁、不伪装成「空错误且非超时」的假绿
 *  - backoff: 负缓存窗口内。同上，保留仅为兼容旧数据。
 *  - no-fresh-verdict: 本工作树近期没进过验证期，该指纹没有可用结论。
 *    诚实地说「没有新鲜结论」，而不是自己 spawn 一个再超时。 */
export type ThetaOutcome = 'ok' | 'type_errors' | 'timeout' | 'spawn_error' | 'busy' | 'backoff' | 'no-fresh-verdict'

export interface ThetaCheckResult {
  errors: string[]
  durationMs: number
  /** 兼容字段——等价于 outcome === 'timeout'。旧消费者（theta-hook 等）不迁移。 */
  timedOut: boolean
  outcome: ThetaOutcome
}

/** outcome 推断（旧格式缓存无 outcome 字段时的兼容读取）。 */
export function inferOutcome(result: Pick<ThetaCheckResult, 'errors' | 'timedOut' | 'outcome'>): ThetaOutcome {
  if (result.outcome) return result.outcome
  return result.timedOut ? 'timeout' : result.errors.length > 0 ? 'type_errors' : 'ok'
}

function parseTypeScriptErrorFiles(output: string): string[] {
  const files = new Set<string>()
  for (const line of output.split('\n')) {
    if (!line.includes('error TS')) continue
    const match = line.match(/^(.+?)\(\d+,\d+\):\s+error TS\d+:/)
    if (match?.[1]) files.add(match[1])
  }
  return [...files]
}

// ── 共享 typecheck 闸门：只读消费者 ─────────────────────────────────
//
// 2026-09-22 起 theta 不再自己 spawn tsc。两条理由，第一条是实测的，第二条是
// 结构性的：
//
// ① 预算 < 工作量 ⇒ 必然超时。theta 原本 spawn 全项目 `tsc --noEmit
//    --skipLibCheck`，本仓库实测 21.0s，而预算 THETA_BUDGET_MS = 15s。观测到
//    40/42 次 timeout（成功率 5%），lastDurationMs 19.2s = 15s 触发 kill + 收尾。
//    旧注释自称「~6s」——陈旧估算让这个错配在评审时不可见。
//
// ② 本仓库已有跨进程共享的 typecheck 闸门（src/lsp/typecheck-cache.ts），
//    交付门禁 / wave-gate / `npm run typecheck` / bash ad-hoc 四条路径都经它
//    收口。theta 是唯一绕过它的消费者，绕过的代价是：不去重（别人刚跑完同一份
//    代码的结果用不上）、不串行（与闸门抢同一批核心，而闸门文档记着实测超线性
//    退化——5 路并发把 43s 拖到分钟级）、且被 SIGKILL 的 tsc 产出的是
//    inconclusive 结果（闸门纪律 isCacheableOutcome：只有真正跑完的 0/1 可缓存，
//    缓存超时结果等于把它固化成所有会话的共识）。
//
// 于是 theta 降为**只读消费者**：指纹命中就回放验证期留下的结论（零 spawn、零锁
// 竞争、不做任何写），否则诚实返回 no-fresh-verdict。「要不要在未命中时触发一次
// 真跑」是刻意留出的第二步，不在本次范围内。
//
// 参数必须与门禁同 variant（TSC_GATE_VARIANT）：指纹与 variant **共同**定位缓存
// 条目，自建一套参数等于永远命不中；而且换了参数两边会看到不同的错误集——那会让
// theta 的提示与交付门禁的判定互相矛盾。

function noVerdictResult(): ThetaCheckResult {
  return { errors: [], durationMs: 0, timedOut: false, outcome: 'no-fresh-verdict' }
}

/** 锁被占 = 有人正在跑真检查，结论稍后就到。诚实报 busy，不自己去抢。 */
function busyResult(): ThetaCheckResult {
  return { errors: [], durationMs: 0, timedOut: false, outcome: 'busy' }
}

/**
 * 只读地取用闸门留下的结论。**不做任何写、不 spawn、不加锁。**
 *
 * - 指纹不可得（非 git 仓库等）→ no-fresh-verdict
 * - 闸门持锁（正在实跑）→ busy
 * - 该指纹有缓存条目 → 按 stdout 抽类型错误，ok / type_errors
 * - 无条目 → no-fresh-verdict（诚实：本工作树近期没进过验证期，没有新鲜结论）
 */
function readSharedVerdict(cwd: string): ThetaCheckResult {
  const fingerprint = computeSourceFingerprint(cwd, TSC_GATE_VARIANT)
  if (!fingerprint) return noVerdictResult()

  const dir = defaultCacheDir(cwd)
  if (isLockHeld(dir)) return busyResult()

  const cached = readCachedTypecheck(dir, fingerprint)
  if (!cached) return noVerdictResult()

  // 只有 tsc 真正跑完（0/1）才会被写入缓存，所以到这里结论是可信的。
  const errors = parseTypeScriptErrorFiles(`${cached.stdout}\n${cached.stderr}`)
  return {
    errors,
    // durationMs 是「本次取用耗时」而非 tsc 耗时——回放不花时间，别谎报成我们自己跑的。
    durationMs: 0,
    timedOut: false,
    outcome: cached.status === 0 && errors.length === 0 ? 'ok' : 'type_errors',
  }
}

/**
 * Theta 一致性检查（只读消费者形态）。
 *
 * `timeoutMs` 参数保留是为了接口稳定（controller 传入 THETA_BUDGET_MS），当前
 * 不参与判定——没有 spawn 就没有内层预算可言。若第二步引入「未命中时触发一次
 * 真跑」，预算应改用闸门导出的 TYPECHECK_CALLER_BUDGET_MS，而不是这个拍脑袋值。
 */
export function runThetaCheck(cwd: string, timeoutMs = 15_000): Promise<ThetaCheckResult> {
  void timeoutMs
  try {
    return Promise.resolve(readSharedVerdict(cwd))
  } catch {
    // 只读路径理论上不抛（闸门 API 全部 fail-open），兜底保持「永不阻断主循环」。
    return Promise.resolve(noVerdictResult())
  }
}
