import type { WorkerResult } from './work-order.js'
import type { WorkerTranscript } from './worker-session.js'
import { VERIFY_BASH_RE } from './hooks/self-verify-hook.js'

/** 能在批末口径（transcript=undefined）下保住 evidenceStatus=verified 的 profile。 
 *  batch-short-circuit.ts 的 DP 义务守卫复用同一事实源，避免硬编码漂移。 */
export const VERIFIED_CAPABLE_PROFILES = new Set(['adversarial_verifier', 'goal_judge'])

function addRisk(risks: string[], risk: string): string[] {
  return risks.includes(risk) ? risks : [...risks, risk]
}

const WRITE_PROFILES_ADVISORY = ['patcher']

/** 交付文本里的"宣称模式"——命中即认为 worker 在报告验证结论。 */
const CLAIM_RE = /全绿|已修复|(?:typecheck|类型检查)\s*(?:干净|clean|passed)|\b\d+\s*\/\s*\d+\s*(?:通过|passed|pass|全绿)|\btests?\s+(?:pass(?:ed|ing)?|green)\b|所有测试通过/i

/** transcript 取证：是否有真实且未失败的验证执行痕迹（run_tests 或验证形状的 bash）。 */
function provenVerification(transcript: WorkerTranscript): { proven: true } | { proven: false; reason: 'missing' | 'errored' } {
  const ranTests = transcript.toolUses.includes('run_tests')
  const verifyBashRuns = (transcript.bashCommands ?? []).filter(cmd => VERIFY_BASH_RE.test(cmd))
  if (!ranTests && verifyBashRuns.length === 0) return { proven: false, reason: 'missing' }

  // 验证形状 bash 失败不是证据——npm test 跑挂了照样宣称 verified 是本审计
  // 要拦的核心场景。failedBashCommands 缺省（旧固件）时按全部成功处理。
  const failedVerifyBash = (transcript.failedBashCommands ?? []).filter(cmd => VERIFY_BASH_RE.test(cmd))
  const verifyBashSucceeded = verifyBashRuns.length > failedVerifyBash.length

  // run_tests 报错检查（沿用 adversarial_verifier 的纵深检查：匹配错误串而非
  // 按索引对位，容忍乱序）。
  const testsErrored = ranTests && transcript.errors.some(e =>
    e.includes('run_tests') || e.includes('Test run failed'),
  )
  const testsSucceeded = ranTests && !testsErrored

  if (testsSucceeded || verifyBashSucceeded) return { proven: true }
  return { proven: false, reason: 'errored' }
}

/**
 * 系统捕获优先的结果校正：transcript 里的工具调用痕迹是主口径，
 * 自报 changedFiles/verification 只作交叉校验。
 *
 * - changedFiles：transcript.mutatedFiles 缺省（旧固件/测试）= 捕获未激活，
 *   保持自报不校验。已激活时取 自报 ∪ 捕获；自报里无工具调用痕迹的文件记
 *   risk，且 evidenceStatus 为 verified 时降 unverified。
 * - verification：真实跑过验证（provenVerification）却漏报元数据 → 补一条
 *   passed 记录；验证跑挂却自报 passed → 改 failed 并记 risk。其余保持自报。
 *
 * 幂等——worker-session 成功路径校一次后，聚合二次过闸再校结果不变。
 */
export function reconcileCapturedWorkerFacts(result: WorkerResult, transcript: WorkerTranscript): WorkerResult {
  let next = result

  if (transcript.mutatedFiles) {
    const capturedSet = new Set(transcript.mutatedFiles)
    const fabricated = next.changedFiles.filter(f => !capturedSet.has(f))
    const union = [...new Set([...next.changedFiles, ...transcript.mutatedFiles])]
    if (fabricated.length > 0 || union.length !== next.changedFiles.length) {
      next = {
        ...next,
        changedFiles: union,
        evidenceStatus: fabricated.length > 0 && next.evidenceStatus === 'verified' ? 'unverified' : next.evidenceStatus,
        risks: fabricated.length > 0
          ? addRisk(next.risks, `自报 changedFiles 无工具调用痕迹：${fabricated.join(', ')}`)
          : next.risks,
      }
    }
  }

  const proof = provenVerification(transcript)
  if (proof.proven && !next.verification) {
    const verifyBash = (transcript.bashCommands ?? []).find(cmd => VERIFY_BASH_RE.test(cmd))
    next = {
      ...next,
      verification: {
        command: transcript.toolUses.includes('run_tests') ? 'run_tests' : (verifyBash ?? 'run_tests'),
        status: 'passed',
        scope: 'targeted',
      },
    }
  } else if (!proof.proven && proof.reason === 'errored' && next.verification?.status === 'passed') {
    next = {
      ...next,
      verification: { ...next.verification, status: 'failed' },
      risks: addRisk(next.risks, '系统捕获到验证执行失败（run_tests/验证形状 bash errored），自报 passed 不可信'),
    }
  }

  return next
}

/**
 * Verify worker evidence for mutation safety.
 *
 * Gate logic: only `changedFiles` (files actually mutated) triggers verification.
 * `examinedFiles` (files read/inspected) are informational and never trigger the gate.
 *
 * When a `profile` is provided and it's a read-only profile, the gate is skipped
 * entirely if `changedFiles` is empty — read-only workers don't need verification metadata.
 *
 * However, read-only workers MUST NOT self-report `evidenceStatus: 'verified'`.
 * Only test-capable profiles (adversarial_verifier, goal_judge) can claim verified,
 * and only when they can prove tests actually ran. This prevents scan-level findings
 * from being treated as ground truth by the primary agent.
 *
 * @param result - The worker result to verify
 * @param profile - Optional worker profile for profile-aware verification
 * @param transcript - Optional worker transcript for behavior-backed verifier gating
 */
export function verifyWorkerEvidence(result: WorkerResult, profile?: string, transcript?: WorkerTranscript): WorkerResult {
  // 系统捕获优先（2026-08-01）：有 transcript 先以工具调用痕迹交叉校验自报的
  // changedFiles/verification，再走下游门禁。幂等——worker-session 成功路径已
  // 校过一次的结果在此重校不变；批量二次过闸不带 transcript 时自然跳过。
  if (transcript) result = reconcileCapturedWorkerFacts(result, transcript)

  // 复现即证明（全星域泛化，2026-07-07）：任何 profile 宣称 verified，只要有
  // transcript 就取证——没有真实 run_tests/验证形状 bash 的执行痕迹 → 降级。
  // adversarial_verifier 额外保留"无 transcript 也 fail-closed"（其裁决会被主
  // 会话当 ground truth）；其他 profile 缺 transcript 时不在此降级——批量聚合
  // 二次过闸不带 transcript（coordinator.ts:1961），全局 fail-closed 会把第一
  // 次带证据通过的结果误杀。
  if (result.evidenceStatus === 'verified') {
    if (profile === 'adversarial_verifier' && !transcript) {
      return {
        ...result,
        evidenceStatus: 'unverified',
        risks: addRisk(result.risks, 'adversarial_verifier reported verified without running run_tests'),
      }
    }
    if (transcript) {
      const proof = provenVerification(transcript)
      if (!proof.proven) {
        const label = profile ?? 'worker'
        const risk = proof.reason === 'errored'
          ? `${label} ran verification (run_tests / verify bash) but it errored — verdict not trustworthy`
          : `${label} reported verified without running run_tests or verify-shaped bash — 宣称未经复现`
        return {
          ...result,
          evidenceStatus: 'unverified',
          risks: addRisk(result.risks, risk),
        }
      }
    }
  }

  // 交付文本宣称扫描：summary 里出现"全绿/N/N 通过/已修复/typecheck 干净"类
  // 结论，但 transcript 无对应验证执行 → 降级 + risk。宣称不是证据。
  if (transcript && CLAIM_RE.test(result.summary) && !provenVerification(transcript).proven) {
    return {
      ...result,
      evidenceStatus: result.evidenceStatus === 'verified' ? 'unverified' : result.evidenceStatus,
      risks: addRisk(result.risks, '交付文本包含验证宣称（全绿/已修复/N过N）但 transcript 无验证工具执行痕迹 — 宣称未经复现'),
    }
  }

  // Read-only workers (no changed files) cannot claim verified unless they are
  // test-capable profiles with proven execution evidence.
  if (result.changedFiles.length === 0 && result.evidenceStatus === 'verified') {
    if (profile === 'goal_judge' && result.verification?.status !== 'passed') {
      return {
        ...result,
        evidenceStatus: 'unverified',
        risks: addRisk(result.risks, 'goal_judge reported verified without passing verification metadata'),
      }
    }
    // verified 资格白名单——与 batch-short-circuit.ts 共享同一事实源。
    if (profile !== 'adversarial_verifier' && profile !== 'goal_judge') {
      return {
        ...result,
        evidenceStatus: 'unverified',
        risks: addRisk(result.risks, 'read-only worker cannot claim verified; findings are scan-level only'),
      }
    }
  }

  // All workers with no changed files pass through — the evidence gate
  // is only about write workers who mutate files.
  if (result.changedFiles.length === 0) return result

  if (profile && WRITE_PROFILES_ADVISORY.includes(profile)) {
    if (result.evidenceStatus !== 'verified') {
      return {
        ...result,
        risks: addRisk(result.risks, `advisory: ${result.changedFiles.length} file(s) changed without verified evidence`),
      }
    }
    return result
  }

  const unverifiedRisk = `unverified: ${result.changedFiles.length} file(s) changed without verified evidence`

  if (result.evidenceStatus !== 'verified') {
    return {
      ...result,
      status: 'blocked',
      evidenceStatus: 'blocked',
      risks: addRisk(result.risks, unverifiedRisk),
    }
  }

  if (!result.verification) {
    return {
      ...result,
      status: 'blocked',
      evidenceStatus: 'blocked',
      risks: addRisk(result.risks, 'verified worker result is missing verification metadata'),
    }
  }

  if (result.verification.status === 'failed') {
    return {
      ...result,
      status: 'failed',
      evidenceStatus: 'failed',
      risks: addRisk(result.risks, `worker verification failed: ${result.verification.command}`),
    }
  }

  if (result.verification.status === 'blocked') {
    return {
      ...result,
      status: 'blocked',
      evidenceStatus: 'blocked',
      risks: addRisk(result.risks, `worker verification blocked: ${result.verification.command}`),
    }
  }

  return result
}
