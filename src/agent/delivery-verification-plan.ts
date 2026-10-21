import { deliveryScopeProgress } from './delivery-scope-progress.js'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildTestExecutionPlan, type DeliveryVerificationPlan } from '../tools/test-execution-plan.js'
import { renderTestCommand } from '../tools/test-command-render.js'
import { getShellCommand } from '../platform.js'
import { readCompletionCoverage } from '../tools/test-completion.js'
import type { TaskLedgerEvent } from './task-ledger.js'

export type { DeliveryVerificationPlan } from '../tools/test-execution-plan.js'

export function buildDeliveryVerificationPlan(cwd: string, required: readonly string[], uncovered: readonly string[], advisoryCount: number, evidence: readonly TaskLedgerEvent[] = [], currentSnapshotRef?: string, candidateFiles?: readonly string[], candidateRef?: string): DeliveryVerificationPlan {
  const active = [...new Set(required.filter(file => existsSync(resolve(cwd, file))))].sort()
  const pending = [...new Set(uncovered)].sort()
  const scopes = deliveryScopeProgress(active, evidence, currentSnapshotRef)
  const plan = pending.length ? buildTestExecutionPlan(cwd, { files: pending, shard: false }) : undefined
  if (plan && scopes.requiredScopes.length) plan.groups = plan.groups.flatMap(group => {
    const missing = scopes.pendingScopes.filter(s => group.files.includes(s.path))
    const labels = [...new Set(missing.map(s => s.label ?? ''))]
    const unique = labels.every(label => label && new Set(scopes.requiredScopes.filter(s => group.files.includes(s.path) && s.label === label).map(s => s.project)).size === 1)
    return buildTestExecutionPlan(cwd, { files: group.files, projects: unique ? labels : [], shard: false }).groups
  })
  const pendingReasons: DeliveryVerificationPlan['pendingReasons'] = pending.map(path => {
    const blocked = plan?.blocked.find(block => block.files.includes(path))
    if (blocked) return { path, state: 'unsupported', reason: blocked.reason }
    const missing = scopes.pendingScopes.filter(s => s.path === path)
    if (missing.length) {
      const failed = evidence.some(e => !e.meta?.stale && readCompletionCoverage(e.meta?.coverage)?.files.some(f => f.path === path && f.outcome === 'failed' && missing.some(s => s.project === f.project)))
      return { path, state: failed ? 'failed' : 'not_run', reason: '待验证配置项目：' + missing.map(s => s.label || s.project.slice(0, 12)).join(', ') }
    }
    for (const event of [...evidence].reverse()) {
      const coverage = readCompletionCoverage(event.meta?.coverage)
      const file = coverage?.files.find(file => file.path === path)
      const targets = event.meta?.targetFiles
      if (!file && !(Array.isArray(targets) && targets.includes(path))) continue
      if (event.meta?.stale || coverage?.workspaceChanged || currentSnapshotRef && event.meta?.snapshotRef && event.meta.snapshotRef !== currentSnapshotRef) return { path, state: 'stale', reason: '运行后工作区或快照变化，需针对当前代码重新验证。' }
      if (file?.outcome === 'failed' || event.status === 'failed') return { path, state: 'failed', reason: '测试失败；先处理失败归因，再执行该批。' }
      return { path, state: 'incomplete', reason: coverage?.filtered ? '存在用例筛选，未证明完整文件。' : '证明缺失、不完整或没有通过用例。' }
    }
    return { path, state: 'not_run', reason: '尚无该文件的完整执行证明。' }
  })
  return { version: 1, ...(candidateFiles?.length ? { candidateFiles: [...candidateFiles], candidateRef } : {}), ...scopes, required: active, covered: active.filter(file => !pending.includes(file)), pending, advisoryCount,
    batches: plan?.groups ?? [], blocked: plan?.blocked ?? [], pendingReasons }
}

/** Presentation is derived from the same plan consumed by the tool, never a second runner detector. */
export function renderDeliveryVerificationPlan(plan: DeliveryVerificationPlan, cwd: string): string[] {
  const lines = [...(plan.candidateRef ? [`提交候选：${plan.candidateRef}（${plan.candidateFiles?.length ?? 0} 个文件）。`] : []),
    `验证进度：required ${plan.required.length}，已覆盖 ${plan.covered.length}，剩余 ${plan.pending.length}；advisory ${plan.advisoryCount} 不阻断提交。`,
    `验证计划：可执行 ${plan.batches.length} 批；不可自动采证 ${plan.blocked.reduce((count, block) => count + block.files.length, 0)} 个文件。完整批次与文件状态见 verificationPlan。`,
    plan.candidateFiles?.length
      ? '按剩余文件分批执行带相同 deliveryFiles 的 run_tests；候选验证须在隔离树运行。完成后再调用 deliver_task；force 不豁免验证义务。'
      : '按剩余文件分批执行 run_tests；也可用下面的独立命令在对应 cwd 后台执行。完成后再调用 deliver_task；force 不豁免验证义务。']
  for (const block of plan.blocked.slice(0, 4)) {
    const preview = block.files.slice(0, 5).join(', ')
    lines.push(`  未生成可采证批命令（${block.code}）：${block.reason}；义务保留：${preview}${block.files.length > 5 ? ` 等共 ${block.files.length} 个文件` : ''}`)
  }
  if (plan.blocked.length > 4) lines.push(`  其余 ${plan.blocked.length - 4} 组不可采证项见 verificationPlan.blocked。`)
  for (const batch of plan.batches.slice(0, 3)) {
    lines.push(`  run_tests(files=${JSON.stringify(batch.files)}${plan.candidateFiles?.length ? ', deliveryFiles=' + JSON.stringify(plan.candidateFiles) : ''}${batch.projects ? ', projects=' + JSON.stringify(batch.projects) : ''}${batch.shard === false ? ', shard=false' : ''})`)
    if (plan.candidateFiles?.length) continue
    if (batch.requiresAdapter) { lines.push('  此批需要运行时适配项目／分片覆盖；请执行上面的 run_tests 调用。'); continue }
    const command = renderTestCommand([batch.command, ...batch.args], getShellCommand().kind)
    lines.push(`  cwd: ${batch.cwd}`)
    if (command) {
      const shell = getShellCommand().kind
      const change = renderTestCommand(['cd', ...(shell === 'cmd' ? ['/d'] : shell === 'powershell' ? [] : ['--']), batch.cwd], shell)
      lines.push(`  ${batch.cwd === resolve(cwd) ? '' : shell === 'powershell' ? `Set-Location -LiteralPath '${batch.cwd.replaceAll("'", "''")}'; ` : `${change} && `}${command}`)
    } else lines.push('  当前 shell 无法安全表达该路径；请使用上面的 run_tests(files)。')
  }
  if (plan.batches.length > 3) lines.push(`  其余 ${plan.batches.length - 3} 批可执行命令见 verificationPlan.batches；完成当前批次后重新调用 deliver_task 获取最新计划。`)
  for (const item of plan.pendingReasons.slice(0, 8)) lines.push(`  ${item.path}: ${item.state} — ${item.reason}`)
  if (plan.pendingReasons.length > 8) lines.push(`  其余 ${plan.pendingReasons.length - 8} 个文件状态见 verificationPlan.pendingReasons。`)
  return lines
}
export function formatDeliveryVerificationPlan(cwd: string, required: readonly string[], uncovered: readonly string[], advisoryCount: number): string[] {
  return renderDeliveryVerificationPlan(buildDeliveryVerificationPlan(cwd, required, uncovered, advisoryCount), cwd)
}

/** Project configuration and scope discovery never run on the HTTP event loop. */
export async function buildDeliveryVerificationPlanAsync(signal: AbortSignal | undefined, ...args: Parameters<typeof buildDeliveryVerificationPlan>): Promise<DeliveryVerificationPlan> {
  const { evidenceProcess } = await import('../workers/evidence-process.js')
  let worker: ReturnType<typeof evidenceProcess> | undefined
  try {
    worker = evidenceProcess(Date.now() + 10_000, signal)
    return await worker.call('delivery-plan', args)
  } catch {
    signal?.throwIfAborted()
    const [, required, uncovered, advisoryCount] = args
    return { version: 1, ...(args[6]?.length ? { candidateFiles: [...args[6]], candidateRef: args[7] } : {}), required: [...required], covered: [], pending: [...uncovered], advisoryCount,
      requiredScopes: [], coveredScopes: [], pendingScopes: [], batches: [],
      blocked: [{ code: 'unknown_runner', files: [...uncovered], reason: 'verification_worker_unavailable: 无法完成验证计划；义务保留，请稍后重试。' }],
      pendingReasons: uncovered.map(path => ({ path, state: 'unsupported', reason: '验证计划进程不可用；未取得新证明。' })) }
  } finally { worker?.dispose() }
}
