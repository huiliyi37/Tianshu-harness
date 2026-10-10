import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { classifyVerificationCommand, shellWord } from '../tools/verification-command.js'

/** Suggestions never reduce the gate's obligations or run a command themselves. */
export function formatDeliveryVerificationPlan(cwd: string, required: readonly string[], uncovered: readonly string[], advisoryCount: number): string[] {
  const root = resolve(cwd)
  const pending = [...new Set(uncovered)].sort()
  const active = new Set(required.filter(file => existsSync(resolve(root, file))))
  const lines = [`验证进度：required ${active.size}，已覆盖 ${Math.max(0, active.size - pending.length)}，剩余 ${pending.length}；advisory ${advisoryCount} 不阻断提交。`, '分批完整执行即可累计逐文件证据，无需全量；以下命令逐条执行，可用 bash(run_in_background=true)，完成后再调用 deliver_task。']
  const groups = new Map<string, string[]>()
  for (const file of pending) {
    const inside = relative(root, resolve(root, file))
    if (isAbsolute(inside) || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\')) {
      lines.push(`  未生成命令（路径不在当前项目内，义务保留）：${file}`)
      continue
    }
    let directory = dirname(resolve(root, file))
    while (directory !== root && !existsSync(resolve(directory, 'package.json'))) directory = dirname(directory)
    const files = groups.get(directory) ?? []
    files.push(file)
    groups.set(directory, files)
  }
  for (const [directory, files] of groups) {
    let runner: string | undefined
    try {
      const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as { scripts?: { test?: string } }
      const invocation = classifyVerificationCommand(pkg.scripts?.test ?? '', directory)
      const needsTsx = files.some(file => /\.(?:[cm]?tsx?|jsx)$/.test(file))
      if (!files.every(file => /\.[cm]?[jt]sx?$/.test(file))) throw new Error('runner language mismatch')
      if ((invocation.batchRunner || invocation.nodeTest) && !invocation.filtered && !invocation.targets.length && !invocation.argv.includes('--test-force-exit')) {
        const argv = [...invocation.argv]
        if (invocation.batchRunner) {
          const script = argv.findIndex(word => /(?:^|\/)(?:scripts\/run-node-tests\.ts|desktop\/scripts\/run-tests\.ts)$/.test(word.replaceAll('\\', '/')))
          argv[script] = '--test'
          if (argv[invocation.runnerIndex] === 'tsx') {
            createRequire(resolve(directory, 'package.json')).resolve('tsx')
            argv.splice(invocation.runnerIndex, 1, 'node', '--import', 'tsx')
          }
        }
        if (needsTsx && !argv.some(word => /^(?:--import|--loader|--experimental-loader)(?:=|$)/.test(word)) && !/(?:^|[/\\])tsx$/.test(argv[invocation.runnerIndex] ?? '')) {
          createRequire(resolve(directory, 'package.json')).resolve('tsx')
          argv.splice(invocation.runnerIndex + 1, 0, '--import', 'tsx')
        }
        runner = argv.map(word => /^[\w./:-]+$/.test(word) ? word : shellWord(word)).join(' ')
      }
      // Current completion argv cannot preserve shell expansions or escaped quotes.
      if (files.some(file => /[\n\r`$%'\\]/.test(file)) || /[\n\r`$%'\\]/.test(directory)) runner = undefined
      if (process.platform === 'win32') runner = undefined // POSIX argv quoting is not a cmd.exe contract.
    } catch { runner = undefined }
    if (!runner) {
      lines.push(`  未生成可采证批命令（${directory}）：请确认该项目的 runner 与采证适配；义务保留：${files.join(', ')}`)
      continue
    }
    const prefix = directory === root ? '' : `cd -- ${shellWord(directory)} && `
    for (let offset = 0; offset < files.length; offset += 20) {
      lines.push(`  ${prefix}${runner} ${files.slice(offset, offset + 20).map(file => shellWord(relative(directory, resolve(root, file)))).join(' ')}`)
    }
  }
  return lines
}
