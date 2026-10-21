import { relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TestPlanBlock, TestExecutionPlan } from './test-execution-plan.js'
import { buildTestExecutionPlanAsync } from './test-plan-async.js'
import { runTestPhases } from './run-test-phases.js'
import type { ToolCallParams, ToolResult } from './types.js'

function blockedResult(block: TestPlanBlock): ToolResult {
  const message = block.reason + (block.candidates?.length ? '\n候选文件：\n' + block.candidates.join('\n') : '')
  return { content: message, isError: true, verification: {
    command: '(auto-detect tests)', recommendedCommand: 'npm test', kind: 'test', status: 'blocked', scope: 'targeted',
    blockedReason: block.code === 'filter_unresolved' ? 'filter_unresolved' : 'unknown_runner',
    userGuidance: message, targetFiles: block.files, timestamp: Date.now(),
  } }
}
/** Every real batch retains its own receipt and phase; no aggregate can invent coverage. */
export async function runPlannedTests(params: ToolCallParams, remaining: () => number): Promise<ToolResult> {
  const files = params.input.files
  if (files !== undefined && (!Array.isArray(files) || files.some(file => typeof file !== 'string'))) return blockedResult({ files: [], code: 'invalid_selection', reason: 'files 必须是测试文件路径列表。' })
  if (params.input.projects !== undefined && (!Array.isArray(params.input.projects) || params.input.projects.some(p => typeof p !== 'string' || !p)) || params.input.shard !== undefined && params.input.shard !== false) return blockedResult({ files: [], code: 'invalid_selection', reason: 'projects 必须为非空名称列表；shard 只接受显式 false 覆盖。' })
  const candidate = params.verificationSnapshot?.candidateOnly ? params.verificationSnapshot : undefined
  const planRoot = candidate?.path ?? params.cwd
  const executionParams = candidate && params.onOutput
    ? { ...params, onOutput: (chunk: string) => params.onOutput?.(chunk.replaceAll(candidate.path, params.cwd)) }
    : params
  const planningStarted = Date.now()
  if (candidate) params.onOutput?.(`[提交候选 ${candidate.snapshotRef}] 开始规划测试；只读取候选树。\n`)
  let plan: TestExecutionPlan
  try {
    plan = await buildTestExecutionPlanAsync(Date.now() + remaining(), params.abortSignal, planRoot,
      { files: files as string[] | undefined, filter: params.input.filter as string | undefined, projects: params.input.projects as string[] | undefined, shard: params.input.shard as false | undefined })
  } catch {
    const stopped = params.abortSignal?.aborted || remaining() <= 0
    const result = blockedResult({ files: files as string[] ?? [], code: 'unknown_runner', reason: stopped ? '测试准备已取消或超时，未启动后续执行。' : '验证计划进程不可用或超时；未在服务线程同步重算，测试义务保留。' })
    if (!params.abortSignal?.aborted && remaining() <= 0) {
      result.errorKind = 'timeout'
      Object.assign(result.verification!, { failureKind: 'timeout', blockedReason: 'timeout' })
    }
    return result
  }
  if (candidate) params.onOutput?.(`[提交候选 ${candidate.snapshotRef}] 规划完成：${plan.groups.length} 批，${plan.blocked.length} 组受阻，耗时 ${Date.now() - planningStarted}ms。\n`)
  const results: ToolResult[] = []
  let completedGroups = 0
  for (const [index, group] of plan.groups.entries()) {
    params.onOutput?.(`[验证批次 ${index + 1}/${plan.groups.length}] ${group.files.length} 个测试文件 · ${group.display}\n`)
    const command = { type: 'run' as const, command: group.command, args: group.args, display: group.display,
      runner: group.runner, scope: group.files.length ? 'targeted' as const : 'full' as const,
      relativeCwd: relative(planRoot, group.cwd), targetFiles: group.files.length ? group.files : undefined }
    const batchStarted = Date.now()
    const result = await runTestPhases(executionParams, command, undefined, remaining)
    if (candidate) result.content = result.content.replaceAll(candidate.path, params.cwd)
    results.push(result)
    completedGroups++
    // A completed batch is durable evidence even when a later batch times out.
    // The pipeline recorder deduplicates these receipts by executionId when
    // the aggregate tool result arrives.
    for (const verification of [...(result.verification ? [result.verification] : []), ...(result.extraVerifications ?? [])]) {
      verification.executionId ??= randomUUID()
      params.onVerificationCompleted?.(verification)
    }
    params.onOutput?.(`[验证批次 ${index + 1}/${plan.groups.length}] ${result.verification?.status ?? '未完成'} · ${Date.now() - batchStarted}ms${result.verification?.executionId ? ` · 证据 ${result.verification.executionId}` : ''}\n`)
    if (params.abortSignal?.aborted || remaining() <= 0 || candidate && result.verification?.stale) break
  }
  results.push(...plan.blocked.map(blockedResult))
  if (!results.length) return blockedResult({ files: [], code: 'unknown_runner', reason: '没有可执行的测试计划。' })
  const unfinished = completedGroups < plan.groups.length
  const unfinishedNote = unfinished ? `\n后续 ${plan.groups.length - completedGroups} 批未完成（${params.abortSignal?.aborted ? '已取消' : remaining() <= 0 ? '总预算超时' : '候选快照变化'}）；已完成批次的证据保留。` : ''
  const retry = [...plan.groups.slice(completedGroups).flatMap(group => group.files),
    ...results.slice(0, completedGroups).flatMap((result, index) => result.isError ? plan.groups[index]?.files ?? [] : [])]
  const remainingFiles = [...new Set(retry)]
  const retryFull = candidate && results.slice(0, completedGroups).some((result, index) => result.isError && plan.groups[index]?.files.length === 0)
  const nextCall = candidate && (remainingFiles.length || retryFull)
    ? `\n下一步：run_tests(${remainingFiles.length ? `files=${JSON.stringify(remainingFiles)}, ` : ''}deliveryFiles=${JSON.stringify(params.input.deliveryFiles)}); 已完成批次的证据保留。`
    : ''
  if (nextCall) params.onOutput?.(nextCall + '\n')
  if (results.length === 1) return { ...results[0]!, content: `${results[0]!.content}${unfinishedNote}${nextCall}`, isError: results[0]!.isError || unfinished }
  const events = results.flatMap(result => [...(result.verification ? [result.verification] : []), ...(result.extraVerifications ?? [])])
  return { ...results[0], content: results.map((result, i) => `[验证批次 ${i + 1}/${results.length}]\n${result.content}`).join('\n\n') + unfinishedNote + nextCall,
    isError: unfinished || results.some(result => result.isError), verification: events[0], extraVerifications: events.slice(1) }
}
