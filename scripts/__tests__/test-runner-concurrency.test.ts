import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..')

test('runner honors a serial concurrency request across real test files', () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-concurrency-'))
  try {
    const tests = join(root, 'scripts')
    const events = join(root, 'events.jsonl')
    mkdirSync(tests)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    for (let id = 0; id < 4; id++) {
      writeFileSync(join(tests, `worker-${id}.test.mjs`), [
        "import { test } from 'node:test'",
        "import { appendFileSync } from 'node:fs'",
        `const events = ${JSON.stringify(events)}`,
        `test('scheduled worker ${id}', async () => {`,
        `  appendFileSync(events, JSON.stringify({ id: ${id}, phase: 'start' }) + '\\n')`,
        '  await new Promise(resolve => setTimeout(resolve, 1500))',
        `  appendFileSync(events, JSON.stringify({ id: ${id}, phase: 'end' }) + '\\n')`,
        '})',
      ].join('\n'))
    }
    const run = spawnSync(process.execPath, ['--import', 'tsx', join(repo, 'scripts/run-node-tests.ts')], {
      cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true,
      env: { ...process.env, RIVET_TEST_CONCURRENCY: '1', RIVET_TEST_TIMEOUT: '20000' },
    })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    let active = 0
    let peak = 0
    const recorded = readFileSync(events, 'utf8').trim().split('\n')
    assert.equal(recorded.length, 8, 'all four files must execute and finish')
    for (const line of recorded) {
      active += JSON.parse(line).phase === 'start' ? 1 : -1
      peak = Math.max(peak, active)
    }
    assert.equal(active, 0)
    assert.equal(peak, 1, 'RIVET_TEST_CONCURRENCY=1 must prevent overlapping workers')
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})
