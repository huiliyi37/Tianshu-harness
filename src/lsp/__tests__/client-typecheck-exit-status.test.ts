import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runTypeCheck, TSC_GATE_ARGS, TSC_GATE_VARIANT } from '../client.js'
import { computeSourceFingerprint, readCachedTypecheck } from '../typecheck-cache.js'

test('real tsc exit 2 preserves type errors in the live result and cache replay', async t => {
  const project = mkdtempSync(join(tmpdir(), 'rivet-tsc-exit-status-'))
  const previousShare = process.env.RIVET_TYPECHECK_SHARE
  const tscBin = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')
  const bin = join(project, 'node_modules', '.bin')
  const runner = join(bin, 'fixture-runner.cjs')
  const invocations = join(project, 'invocations.log')
  try {
    delete process.env.RIVET_TYPECHECK_SHARE
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(project, '.gitignore'), 'node_modules/\ninvocations.log\n')
    writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, types: [], lib: ['es5'], skipLibCheck: true },
      files: ['error.ts'],
    }))
    writeFileSync(join(project, 'error.ts'), 'export const value: string = 42\n')
    writeFileSync(runner,
      `require('node:fs').appendFileSync(${JSON.stringify(invocations)}, 'run\\n');\n`
      + `require(${JSON.stringify(tscBin)});\n`)
    if (process.platform === 'win32') {
      writeFileSync(join(bin, 'tsc.cmd'), `@"${process.execPath}" "${runner}" %*\r\n`)
    } else {
      const shim = join(bin, 'tsc')
      writeFileSync(shim, `#!${process.execPath}\nrequire(${JSON.stringify(runner)});\n`)
      chmodSync(shim, 0o755)
    }
    for (const args of [
      ['init', '-q'], ['config', 'user.email', 'test@example.com'],
      ['config', 'user.name', 'test'], ['config', 'commit.gpgsign', 'false'],
      ['add', '.'], ['commit', '-q', '-m', 'fixture'],
    ]) execFileSync('git', args, { cwd: project, stdio: 'ignore', windowsHide: true })

    const direct = spawnSync(process.execPath, [tscBin, ...TSC_GATE_ARGS], {
      cwd: project, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    })
    assert.equal(direct.error, undefined)
    assert.equal(direct.signal, null)
    assert.equal(direct.status, 2)
    assert.match(direct.stdout, /error\.ts\(1,14\): error TS2322/)
    t.diagnostic(`real compiler status=${direct.status}; ${direct.stdout.trim()}`)

    const live = await runTypeCheck(project, '*', 10_000)
    await t.test('completed compiler errors remain errors', () => {
      assert.equal(live.ranOk, true)
      assert.ok(live.diagnostics.some(d => d.file === 'error.ts' && d.severity === 'error'))
      assert.match(live.formatted, /error\.ts:1:14 error: Type 'number' is not assignable to type 'string'/)
    })
    await t.test('cached exit 2 replays the error diagnostics without rerunning tsc', async () => {
      const replay = await runTypeCheck(project, '*', 10_000)
      const fingerprint = computeSourceFingerprint(project, TSC_GATE_VARIANT)
      assert.ok(fingerprint)
      const cached = readCachedTypecheck(join(project, 'node_modules', '.cache', 'rivet-typecheck'), fingerprint)
      assert.equal(cached?.status, 2)
      assert.match(cached!.stdout, /TS2322/)
      assert.equal(readFileSync(invocations, 'utf8'), 'run\n')
      assert.equal(replay.ranOk, true)
      assert.deepEqual(replay.diagnostics, live.diagnostics)
      assert.ok(replay.diagnostics.some(d => d.severity === 'error'))
      assert.equal(replay.formatted, live.formatted)
    })
    await t.test('unknown statuses and timeout discard partial diagnostics', async () => {
      process.env.RIVET_TYPECHECK_SHARE = '0'
      const partial = "error.ts(1,14): error TS2322: partial diagnostic\n"
      for (const status of [3, 4, 255]) {
        writeFileSync(runner, `process.stdout.write(${JSON.stringify(partial)}); process.exit(${status});\n`)
        const result = await runTypeCheck(project, '*', 10_000)
        assert.equal(result.ranOk, false, `status ${status}`)
        assert.deepEqual(result.diagnostics, [])
        assert.equal(result.formatted, '')
      }
      writeFileSync(runner, `process.stdout.write(${JSON.stringify(partial)}); setTimeout(() => process.exit(0), 1000);\n`)
      const timedOut = await runTypeCheck(project, '*', 150)
      assert.equal(timedOut.ranOk, false)
      assert.deepEqual(timedOut.diagnostics, [])
      assert.equal(timedOut.formatted, '')
      if (process.platform !== 'win32') {
        writeFileSync(runner, `process.stdout.write(${JSON.stringify(partial)}); process.kill(process.pid, 'SIGTERM');\n`)
        const signalled = await runTypeCheck(project, '*', 10_000)
        assert.equal(signalled.ranOk, false)
        assert.deepEqual(signalled.diagnostics, [])
      }
    })
  } finally {
    if (previousShare === undefined) delete process.env.RIVET_TYPECHECK_SHARE
    else process.env.RIVET_TYPECHECK_SHARE = previousShare
    rmSync(project, { recursive: true, force: true })
  }
})
