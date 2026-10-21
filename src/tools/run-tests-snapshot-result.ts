import type { ToolResult, VerificationSnapshotPlan } from './types.js'

export function snapshotOmissionNote(plan: VerificationSnapshotPlan): string {
  const omitted = plan.omittedDirtyFiles
  return omitted?.length
    ? `\n\n⚠ 快照未包含这些工作树改动的文件（不在本会话工具写入集合内，常见于 bash 脚本生成的改动）：${omitted.slice(0, 8).join('、')}${omitted.length > 8 ? ` 等 ${omitted.length} 个` : ''}。隔离结果可能不反映它们的改动。`
    : ''
}

/** 阶段 A 失败时也必须报告快照缺口；结果状态仍由 A 决定。 */
export function snapshotTestResult(phaseA: ToolResult, plan: VerificationSnapshotPlan, phaseB?: ToolResult): ToolResult {
  const phaseBNote = plan.candidateOnly
    ? '\n\n[提交候选] 已在当前 HEAD + deliveryFiles 上验证；范围外工作树改动不参与本次结果。'
    : !phaseB
    ? '\n\n[阶段 B · 当前 HEAD 集成] 跳过 — 隔离验证未通过，无需再跑集成阶段；请先诊断阶段 A 的失败。'
    : phaseB.verification?.status === 'blocked'
      ? `\n\n[阶段 B · 当前 HEAD 集成] 未完成 — ${phaseB.content}`
    : phaseB.isError
      ? phaseB.verification?.isolatedPassed
        ? '\n\n[阶段 B · 当前 HEAD 集成] FAILED — 隔离通过、集成失败，存在集成差异；门禁会核对版本和完整范围证明后判断是否阻断。'
        : '\n\n[阶段 B · 当前 HEAD 集成] FAILED — 隔离验证未通过，不能归因为并发冲突；请诊断阶段 A 的失败。'
      : '\n\n[阶段 B · 当前 HEAD 集成] 已通过。'
  return {
    ...phaseA,
    content: `[阶段 A · 隔离快照] ${phaseA.content}${snapshotOmissionNote(plan)}${phaseBNote}`,
    isError: phaseA.isError,
    ...(phaseB?.verification ? { extraVerifications: [phaseB.verification] } : {}),
  }
}
