import { existsSync, globSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { classifyVerificationCommand, shellWord } from './verification-command.js'
import { canonicalTestPath, insideTestRoot, readTestPackage, testPackageManager } from './test-workspaces.js'
import { installedTestRunner, resolveRunnerDependency } from './test-runner-module.js'
import type { TestRunner } from './test-runner-options.js'

export interface TestExecutionGroup {
  cwd: string
  packageRoot: string
  runner: TestRunner
  command: string
  args: string[]
  files: string[]
  display: string
  originalCommand: string
  runnerArgv: string[]
  requiresAdapter?: boolean
  projects?: string[]
  shard?: false
  packageName?: string
  proof: 'file-completion-v2'
}
export interface TestPlanBlock { files: string[]; code: 'invalid_selection' | 'filter_unresolved' | 'filter_ambiguous' | 'unknown_runner' | 'missing_dependency' | 'unsupported_selection'; reason: string; candidates?: string[] }
export interface TestExecutionPlan { version: 1; repositoryRoot: string; groups: TestExecutionGroup[]; blocked: TestPlanBlock[] }
export interface DeliveryVerificationPlan {
  version: 1
  /** Explicit delivery candidate; batch calls must use this same file set. */
  candidateFiles?: string[]
  /** The HEAD + selected-file identity used for impact and plan discovery. */
  candidateRef?: string
  required: string[]
  covered: string[]
  pending: string[]
  requiredScopes?: import('./test-scope-catalog.js').TestScope[]
  coveredScopes?: import('./test-scope-catalog.js').TestScope[]
  pendingScopes?: import('./test-scope-catalog.js').TestScope[]
  advisoryCount: number
  batches: TestExecutionGroup[]
  blocked: TestPlanBlock[]
  pendingReasons: Array<{ path: string; state: 'failed' | 'not_run' | 'incomplete' | 'stale' | 'unsupported'; reason: string }>
}
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/i
const SOURCE = /\.[cm]?[jt]sx?$/i
function packageForFile(root: string, file: string): string {
  let directory = dirname(resolve(root, file))
  while (directory !== root && !readTestPackage(directory)?.scripts?.test) directory = dirname(directory)
  return directory
}
/** Pure planning: no runner starts, no dependency is installed and no obligation disappears. */
export function buildTestExecutionPlan(cwd: string, selection: { files?: readonly string[]; filter?: string; projects?: readonly string[]; shard?: false } = {}): TestExecutionPlan {
  const root = resolve(cwd), plan: TestExecutionPlan = { version: 1, repositoryRoot: root, groups: [], blocked: [] }
  const block = (files: string[], code: TestPlanBlock['code'], reason: string, candidates?: string[]) => plan.blocked.push({ files, code, reason, ...(candidates ? { candidates } : {}) })
  if (selection.files && selection.filter || selection.files && (!selection.files.length || selection.files.some(file => typeof file !== 'string' || !file))) {
    block([], 'invalid_selection', 'files 必须为非空文件列表，且不能与 filter 同时使用。'); return plan
  }
  let files = selection.files ? [...new Set(selection.files)] : []
  if (selection.filter) {
    const filter = selection.filter.replaceAll('\\', '/')
    const path = resolve(root, filter)
    if (!insideTestRoot(root, path) || isAbsolute(filter)) { block([filter], 'invalid_selection', 'filter 不得越出当前仓库。'); return plan }
    if (insideTestRoot(root, path) && existsSync(path) && statSync(path).isFile() && TEST.test(path)) files = [relative(root, path)]
    else {
      const stem = filter.split('/').pop()!.replace(/\.(?:test|spec)(?:\.[cm]?[jt]sx?)?$/, '')
      const matches = stem ? globSync('**/*', { cwd: root, exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'] })
        .filter(file => TEST.test(file) && (file.split(/[\\/]/).pop()!.replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/, '') === stem || file.split(/[\\/]/).pop()!.includes(stem))).sort() : []
      if (matches.length !== 1) { block([], matches.length ? 'filter_ambiguous' : 'filter_unresolved', matches.length ? '测试文件名有歧义，请使用精确路径或 files。' : '无法把 filter 解析为测试文件。', matches); return plan }
      files = matches
    }
  }
  const groups = new Map<string, string[]>()
  for (const file of files) {
    const path = resolve(root, file)
    if (isAbsolute(file) || !insideTestRoot(root, path) || !insideTestRoot(canonicalTestPath(root), canonicalTestPath(path)) || !existsSync(path) || !statSync(path).isFile() || !SOURCE.test(file)) {
      block([file], 'invalid_selection', '目标必须是当前仓库内存在的测试文件。'); continue
    }
    const directory = packageForFile(root, file), owned = groups.get(directory) ?? []
    owned.push(relative(root, path).replaceAll('\\', '/')); groups.set(directory, owned)
  }
  if (!files.length && !plan.blocked.length) groups.set(root, [])
  for (const [directory, targets] of groups) {
    let entryCwd = directory
    if (directory !== root) {
      const rootEntry = classifyVerificationCommand('npm run test', root)
      if (rootEntry.runner && !rootEntry.reason && !rootEntry.filtered && !rootEntry.persistent && rootEntry.resolvedCwd && canonicalTestPath(rootEntry.resolvedCwd) === canonicalTestPath(directory)) entryCwd = root
    }
    const manager = testPackageManager(entryCwd)
    const prefix = [manager, 'run', 'test']
    const invocation = classifyVerificationCommand(prefix.map(shellWord).join(' '), entryCwd)
    if (!invocation.runner || invocation.reason || invocation.filtered || invocation.persistent) {
      block(targets, 'unknown_runner', invocation.reason ?? '该入口包含用例筛选或常驻模式，不能生成完整文件验证。'); continue
    }
    const packageRoot = invocation.resolvedCwd ?? directory
    const native = invocation.resolvedArgv ?? invocation.argv
    if (native.some(arg => arg === '--test-force-exit' || arg === '--forceExit')) {
      block(targets, 'unsupported_selection', 'forced_exit_unverifiable：强制退出无法证明 reporter 与输出完整结束；请提供保留 loader/setup/config 的有限测试入口。'); continue
    }
    if (invocation.runner === 'node-test' && (selection.projects?.length || selection.shard === false && invocation.targets.length > 0 && native.some(arg => arg.startsWith('--test-shard')))) { block(targets, 'unsupported_selection', 'node_shard_override_unavailable：Node 在预加载前解析分片参数；请提供保留 hooks/loader 的未分片脚本入口。'); continue }
    const installed = installedTestRunner(packageRoot, invocation.runner)
    if (installed.reason) { block(targets, installed.packageFile ? 'unsupported_selection' : 'missing_dependency', installed.reason); continue }
    if (invocation.runner === 'vitest' && (!installed.packageFile || !resolveRunnerDependency(packageRoot, installed.packageFile, 'vite'))) { block(targets, 'missing_dependency', '项目的 Vitest 无法解析所需的 Vite；请按该项目的包管理器补齐 peer 依赖后重试。'); continue }
    const selected = targets.map(file => relative(packageRoot, resolve(root, file)).replaceAll('\\', '/'))
    if (selected.some(file => file === '..' || file.startsWith('../'))) { block(targets, 'unsupported_selection', '脚本转发到另一个包，目标文件不属于该执行根。'); continue }
    const fixed = targets.length && invocation.targets.length > 0
    if (fixed && (invocation.targets.length !== selected.length || invocation.targets.some(file => !selected.includes(file)))) { block(targets, 'unsupported_selection', '包脚本含固定目标，不能静默替换或扩大执行范围。'); continue }
    if (JSON.stringify(native).length > 4500 || fixed && selected.length > 20) { block(targets, 'unsupported_selection', '原脚本的长度或固定文件数量超过安全批次上限，不能在保留脚本时自动拆分。'); continue }
    for (let offset = 0; offset < Math.max(1, selected.length);) {
      const batch: string[] = []
      while (offset < selected.length && batch.length < 20 && JSON.stringify([...native, ...batch, selected[offset]]).length < 5000) batch.push(selected[offset++]!)
      if (offset < selected.length && !batch.length) { block(targets.slice(offset), 'unsupported_selection', '单个文件路径超过平台安全命令长度。'); break }
      const overrides = [...(selection.shard === false ? invocation.runner === 'node-test' ? native.some(arg => arg.startsWith('--test-shard')) ? ['--test-shard=1/1'] : [] : ['--rivet-unsharded'] : []), ...(invocation.runner !== 'node-test' && selection.projects ? selection.projects.length ? selection.projects.map(project => '--rivet-project=' + project) : ['--rivet-all-projects'] : [])]
      const args = [...prefix.slice(1), ...(overrides.length && manager === 'npm' ? ['--'] : []), ...overrides, ...(batch.length && !fixed ? [...(manager === 'npm' && !overrides.length ? ['--'] : []), ...(invocation.runner === 'jest' ? ['--runTestsByPath'] : []), ...batch] : [])]
      plan.groups.push({ cwd: entryCwd, packageRoot, runner: invocation.runner, command: manager, args,
        requiresAdapter: overrides.some(arg => arg.startsWith('--rivet-')), projects: invocation.runner !== 'node-test' && selection.projects ? [...selection.projects] : undefined, shard: invocation.runner === 'node-test' ? undefined : selection.shard, originalCommand: readTestPackage(entryCwd)?.scripts?.test ?? '', runnerArgv: [...native, ...(batch.length && !fixed ? [...(invocation.runner === 'jest' ? ['--runTestsByPath'] : []), ...batch] : [])], packageName: readTestPackage(packageRoot)?.name, proof: 'file-completion-v2',
        files: batch.map(file => relative(root, resolve(packageRoot, file)).replaceAll('\\', '/')),
        display: [manager, ...args].map(word => /^[\w./:@=-]+$/.test(word) ? word : shellWord(word)).join(' ') })
      if (!selected.length) break
    }
  }
  return plan
}
