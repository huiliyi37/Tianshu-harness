import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { RUN_TESTS_TOOL, runTestCommandIn, type RunTestCommandDeps, type RunnableTestCommand } from '../run-tests.js'

class Child extends EventEmitter { stdout = new PassThrough(); stderr = new PassThrough() }

/** Completion capture is prepared off-thread, so the spawn lands on a later
 *  macrotask — wait for the observable side effect instead of assuming it. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 3000; attempt++) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
  assert.fail(`timed out waiting for ${label}`)
}
const ipcError = 'Error: listen ENOTSUP: operation not supported on socket /fixture/tsx-501/42.pipe\n    at createIpcServer (tsx/dist/cli.mjs:1:1)'

for (const [label, stderr, code, retries, channel] of [
  ['tsx IPC ENOTSUP', ipcError, 1, 1],
  ['legacy EPERM', 'EPERM', 1, 1],
  ['stdout-only IPC text', ipcError, 1, 0, 'stdout'],
  ['tests already started', ipcError, 1, 0, 'started'],
  ['truncated test progress', ipcError, 1, 0, 'truncated'],
  ['decoder tail test progress', ipcError, 1, 0, 'tail'],
  ['application IPC server', ipcError.replace('tsx/dist/cli.mjs', 'app.mjs'), 1, 0],
  ['ordinary ENOTSUP', 'test failed: ENOTSUP filesystem operation', 1, 0],
  ['unrelated socket ENOTSUP', 'Error: listen ENOTSUP /fixture/app.pipe', 1, 0],
  ['successful diagnostic text', ipcError, 0, 0],
] as Array<[string, string, number, number, ('stdout' | 'stderr' | 'started' | 'truncated' | 'tail')?]>) {
  test(`${label}: fallback preserves argv, budget and tool identity`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-tests-ipc '))
    const children = [new Child(), new Child()]
    const spawns: Array<{ command: string; args: string[] }> = []
    const timers: number[] = [], persisted: string[] = []; let decoders = 0
    const clock = Date.now, base = clock(); let elapsed = 0
    Date.now = () => base + elapsed
    const deps: RunTestCommandDeps = {
      spawn: (command, args) => { spawns.push({ command, args: [...args] }); return children[spawns.length - 1]! },
      kill: () => {}, persist: async id => { persisted.push(id); return join(cwd, 'raw') },
      setTimeout: (_callback, ms) => { timers.push(ms); return timers.length }, clearTimeout: () => {},
      createDecoder: () => { const stdout = decoders++ === 0; return { write: (data: Buffer) => data.toString(), end: () => channel === 'tail' && stdout ? 'TAP version 13' : '' } },
      // Completion capture normally runs in an evidence worker process; these
      // cases assert the spawn/retry contract, so the seam returns no capture.
      prepareCompletion: async () => undefined,
    }
    try {
      const target = 'src/空 格.test.ts'
      const command: RunnableTestCommand = { type: 'run', command: 'tsx', args: ['--test', '--test-concurrency=1', target], display: 'tsx --test', runner: 'node-test', scope: 'targeted' }
      const pending = runTestCommandIn(cwd, command, { input: {}, cwd, toolUseId: 'original-tool' }, target, 50, deps, cwd)
      await waitFor(() => spawns.length === 1, 'initial test spawn')
      children[0]![channel === 'stdout' ? 'stdout' : 'stderr'].write(stderr); if (channel === 'started') children[0]!.stdout.write('TAP version 13\n# tests 1\n# fail 1'); if (channel === 'truncated') children[0]!.stdout.write('TAP version 13\n' + ' '.repeat(200_000)); elapsed = 40; children[0]!.emit('close', code, null)
      if (retries) {
        await waitFor(() => spawns.length === 2, 'tsx IPC retry spawn')
        assert.equal(spawns[1]!.command, process.execPath)
        assert.deepEqual(spawns[1]!.args.slice(-3), ['--test', '--test-concurrency=1', target])
        assert.equal(spawns[1]!.args[0], '--import')
        assert.ok(timers.includes(10), 'retry must receive only the remaining budget')
        children[1]!.emit('close', 0, null)
      }
      assert.equal(spawns.length, 1 + retries)
      const result = await pending
      assert.equal(result.verification?.scope, 'targeted')
      assert.deepEqual(persisted, ['original-tool'])
      assert.equal(result.isError, code !== 0 && retries === 0)
    } finally { Date.now = clock; rmSync(cwd, { recursive: true, force: true }) }
  })
}

test('targeted TypeScript uses the project loader and complete proof for spaced Unicode paths', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'run-tests-targeted 中文 空格 %25 '))
  try {
    mkdirSync(join(cwd, 'src'))
    const projectTsx = join(cwd, 'node_modules', 'tsx'), require = createRequire(import.meta.url)
    mkdirSync(projectTsx, { recursive: true })
    writeFileSync(join(projectTsx, 'package.json'), JSON.stringify({ type: 'module', exports: { '.': './loader.mjs', './cli': './cli.mjs' } }))
    writeFileSync(join(projectTsx, 'loader.mjs'), `import ${JSON.stringify(pathToFileURL(require.resolve('tsx')).href)}; process.env.TIANSHU_QA_PROJECT_LOADER = 'yes';`)
    writeFileSync(join(projectTsx, 'cli.mjs'), `#!/usr/bin/env node\nprocess.env.TIANSHU_QA_PROJECT_LOADER='yes';await import(${JSON.stringify(pathToFileURL(require.resolve('tsx/cli')).href)});`)
    mkdirSync(join(cwd, 'node_modules/.bin'))
    if (process.platform === 'win32') writeFileSync(join(cwd, 'node_modules/.bin/tsx.cmd'), `@echo off\r\n"${process.execPath}" "${join(projectTsx, 'cli.mjs')}" %*\r\n`)
    else { symlinkSync(join(projectTsx, 'cli.mjs'), join(cwd, 'node_modules/.bin/tsx')); chmodSync(join(projectTsx, 'cli.mjs'), 0o755) }
    mkdirSync(join(cwd, 'scripts'))
    writeFileSync(join(cwd, 'scripts/run-node-tests.ts'), `import {spawnSync} from 'node:child_process';
import {completionBatch,sealCompletionRun} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../test-completion.ts')).href)};
const b=completionBatch(['--import','tsx','--test',...process.argv.slice(2)],process.cwd(),process.env);
const r=spawnSync(process.execPath,b.args,{env:b.env,stdio:'inherit'});b.finish(r.status===0);sealCompletionRun(1,1);process.exit(r.status??1);`)
    writeFileSync(join(cwd, '.gitignore'), 'node_modules\n.rivet\n')
    writeFileSync(join(cwd, 'src/空 格.test.ts'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; const value: number = 42; test('typed',()=>{assert.equal(value,42);assert.equal(process.env.TIANSHU_QA_PROJECT_LOADER,'yes');});")
    writeFileSync(join(cwd, 'src/direct.test.ts'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; const value: number = 42; test('direct typed',()=>assert.equal(value,42));")
    execFileSync('git', ['init', '-q'], { cwd })
    execFileSync('git', ['add', '.'], { cwd })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture'], { cwd })
    for (const script of ['tsx --test', 'node --import tsx --test', 'tsx scripts/run-node-tests.ts']) {
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: script } }))
      const result = await RUN_TESTS_TOOL.execute({ input: { filter: 'src/空 格.test.ts' }, cwd, toolUseId: 'typed' })
      assert.equal(result.isError, false, script + '\n' + result.content)
      assert.equal(result.verification?.scope, 'targeted')
      assert.equal(result.verification!.command, "npm run test -- 'src/空 格.test.ts'")
      assert.equal(result.verification?.coverage?.complete, true, result.content)
      assert.equal(result.verification?.coverage?.repositoryRoot, realpathSync(cwd))
      assert.equal(result.verification?.coverage?.executionRoot, realpathSync(cwd))
      assert.equal(result.verification?.coverage?.files[0]?.path, 'src/空 格.test.ts')
    }
    const direct = await runTestCommandIn(cwd, { type: 'run', command: 'tsx', args: ['--test', 'src/direct.test.ts'], display: 'tsx --test', runner: 'node-test', scope: 'targeted' }, { input: {}, cwd, toolUseId: 'direct-tsx' }, undefined, 15_000, undefined, cwd)
    assert.equal(direct.isError, false, direct.content)
    assert.equal(direct.verification?.coverage?.complete, true, direct.content)
    assert.equal(direct.verification?.coverage?.files[0]?.path, 'src/direct.test.ts')
  } finally { rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) }
})
