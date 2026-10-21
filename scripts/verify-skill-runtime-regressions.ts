/** Restore each reviewed defect, run its behavioral regression, then restore exact bytes. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

type Edit = [file: string, before: string, after: string]
const tests = {
  pipeline: 'src/agent/__tests__/tool-pipeline.test.ts',
  http: 'src/server/__tests__/skill-runtime-closure.test.ts',
  process: 'src/skills/runtime/__tests__/closure-regressions.test.ts',
  leases: 'src/skills/runtime/__tests__/leases-closure.test.ts',
  pinned: 'src/skills/runtime/__tests__/pinned-plan.test.ts',
}
const routes = 'src/server/skill-runtime-routes.ts', executor = 'src/skills/runtime/executor.ts'
const requirements = 'src/skills/runtime/requirements.ts'
const cases: Array<{ name: string; file: string; pattern: string; edits: Edit[] }> = [
  { name: 'ordinary approval', file: tests.pipeline, pattern: 'skill runtime: real approval', edits: [['src/agent/tool-pipeline.ts', "const runtimeApprovalGate = tu.name === 'skill_runtime'", "const runtimeApprovalGate = false && tu.name === 'skill_runtime'"]] },
  { name: 'HTTP hard deny', file: tests.http, pattern: 'HTTP hard deny', edits: [['src/skills/runtime/policy.ts', "if (isToolDenied('skill_runtime'", "if (false && isToolDenied('skill_runtime'"]] },
  { name: 'pinned prepare input', file: tests.pinned, pattern: 'lazy snapshots prepare', edits: [[executor, 'packageRoot: inputRoot,', 'packageRoot: resolved.skill.skillDir!,']] },
  { name: 'hash preservation', file: tests.process, pattern: 'pip receives', edits: [[requirements, '` --hash=${hash}`', '`\n    --hash=${hash}`']] },
  { name: 'cancel waits for exit', file: tests.process, pattern: 'cancellation settles', edits: [['src/tools/process-exec.ts', 'if (!timedOut) { cancelled = true; stop() }', 'if (!timedOut) { cancelled = true; stop(); finish(true) }']] },
  { name: 'venv sandbox executor', file: tests.leases, pattern: 'venv uses per-call', edits: [['src/skills/runtime/environment-manager.ts', 'const venv = await exec(', 'const venv = await this.exec(']] },
  { name: 'cross-process run lease', file: tests.leases, pattern: 'separate processes exclude', edits: [['src/skills/runtime/environment-manager.ts', 'return this.leases.beginRun(envKey)', 'return Object.assign(() => {}, { onSpawn: (_pid: number) => {}, retain: () => {} })']] },
  { name: 'constraint preservation', file: tests.process, pattern: 'pip receives', edits: [[requirements, "output.push(`-${nestedMode === 'constraint' ? 'c' : 'r'}", "if (nestedMode !== 'constraint') output.push(`-${nestedMode === 'constraint' ? 'c' : 'r'}"]] },
  { name: 'truthful HTTP terminal state', file: tests.http, pattern: 'HTTP hard deny', edits: [
    [executor, "errorCode: ready?.status === 'environment_stale' ? 'environment_stale' : 'environment_not_prepared'", "errorCode: ready?.status === 'environment_stale' ? 'environment_stale' : undefined"],
    [routes, "outcome.status === 'ready' && !outcome.result.errorCode && (record.action === 'prepare' || outcome.result.exitCode === 0)", "!outcome.result.errorCode && (outcome.result.exitCode === undefined || outcome.result.exitCode === 0)"],
  ] },
  { name: 'running log retention', file: tests.http, pattern: 'HTTP hard deny', edits: [[routes, "const finished = Date.parse(op?.finishedAt ?? '')", "if (op) rmSync(logPath(op.id), { force: true }); const finished = Date.parse(op?.finishedAt ?? '')"]] },
  { name: 'mandatory preview binding', file: tests.http, pattern: 'HTTP hard deny', edits: [
    [routes, "if (typeof data.packageRef !== 'string' || !/^[a-f0-9]{64}$/.test(data.packageRef) || typeof data.previewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(data.previewDigest))", "if (false)"],
    [routes, 'if (data.packageRef !== target.resolved.packageRef)', "if (typeof data.packageRef === 'string' && data.packageRef !== target.resolved.packageRef)"],
    [routes, 'if (data.previewDigest !== plan.digest)', "if (typeof data.previewDigest === 'string' && data.previewDigest !== plan.digest)"],
  ] },
]
const results: string[] = []
for (const test of cases) {
  const originals = new Map<string, string>(), mutated = new Map<string, string>()
  try {
    for (const [file, before, after] of test.edits) {
      const source = mutated.get(file) ?? readFileSync(file, 'utf8')
      if (!originals.has(file)) originals.set(file, source)
      assert.ok(source.includes(before), `Missing mutation anchor: ${test.name}: ${file}`)
      mutated.set(file, source.replace(before, after))
    }
    for (const [file, source] of mutated) writeFileSync(file, source)
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', `--test-name-pattern=${test.pattern}`, test.file], { encoding: 'utf8', timeout: 40_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
    const output = run.stdout + run.stderr
    assert.equal(run.status, 1, `Defect was not detected: ${test.name}\n${output}`)
    assert.match(output, /ERR_ASSERTION|AssertionError/, `Expected a behavioral assertion, not an import/build failure: ${test.name}\n${output}`)
    results.push(test.name)
    console.log(`RED verified: ${test.name}`)
  } finally {
    for (const [file, source] of originals) {
      assert.equal(readFileSync(file, 'utf8'), mutated.get(file), `Concurrent edit detected; refusing to overwrite ${file}`)
      writeFileSync(file, source)
    }
  }
}
console.log(JSON.stringify({ verified: results.length, defects: results, sourcesRestored: true }))
