import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
// Mutations are loaded in memory; concurrent worktree edits are never rewritten.
const root = resolve(import.meta.dirname, '..')
const require = createRequire(root + '/package.json')
const { transformSync } = require('esbuild')
const cases = [
  ['watchdog controller reset', 'src/agent/loop.ts', 'this.abortController = new AbortController()\n    return true', 'return true', 'watchdog-rescue.test.ts', 'completed batch continues'],
  ['user abort priority', 'src/agent/loop.ts', 'this._pendingAbort || !this._watchdogAborted', '!this._watchdogAborted', 'watchdog-rescue.test.ts', 'user Esc during drain'],
  ['Esc preservation during endTurn rescue', 'src/agent/loop.ts', ' || this._pendingAbort', '', 'watchdog-rescue.test.ts', 'pending Esc wins', 'this._pendingAbort || !this._watchdogAborted', '!this._watchdogAborted'],
  ['prewarm lookup key', 'src/agent/coordinator.ts', 'batchPrewarmByOrder.get(order.parentTurnId)', 'batchPrewarmByOrder.get(order.id)', 'batch-side-table-isolation.test.ts', '两个并发顶层批'],
  ['stigmergy lookup key', 'src/agent/coordinator.ts', 'batchStigmergyByOrder.get(order.parentTurnId)', 'batchStigmergyByOrder.get(order.id)', 'batch-side-table-isolation.test.ts', '两个并发顶层批'],
  ['old prewarm side table', 'src/agent/coordinator.ts', /batchPrewarmByOrder\.(get|set|delete)\((order|o)\.parentTurnId/g, 'batchPrewarmByOrder.$1($2.id', 'batch-side-table-isolation.test.ts', '两个并发顶层批'],
  ['old stigmergy side table', 'src/agent/coordinator.ts', /batchStigmergyByOrder\.(get|set|delete)\((order|o)\.parentTurnId/g, 'batchStigmergyByOrder.$1($2.id', 'batch-side-table-isolation.test.ts', '两个并发顶层批'],
  ['prewarm cross-batch cleanup', 'src/agent/coordinator.ts', /batchPrewarmByOrder\.(get|set|delete)\((order|o)\.parentTurnId/g, 'batchPrewarmByOrder.$1($2.id', 'batch-side-table-isolation.test.ts', 'settling one batch'],
  ['stigmergy cross-batch cleanup', 'src/agent/coordinator.ts', /batchStigmergyByOrder\.(get|set|delete)\((order|o)\.parentTurnId/g, 'batchStigmergyByOrder.$1($2.id', 'batch-side-table-isolation.test.ts', 'settling one batch'],
  ['blocked-order cleanup', 'src/agent/coordinator.ts', 'this.batchPrewarmByOrder.delete(o.parentTurnId)\n        this.batchStigmergyByOrder.delete(o.parentTurnId)', '', 'batch-side-table-isolation.test.ts', 'dependency-blocked'],
]
if (process.env.REVIT_PR_DEFECT !== undefined) {
  const [, file, good, bad, , , good2, bad2] = cases[Number(process.env.REVIT_PR_DEFECT)]
  registerHooks({ load(url, ctx, next) {
    if (!url.startsWith('file:') || fileURLToPath(url) !== root + '/' + file) return next(url, ctx)
    const source = readFileSync(new URL(url), 'utf8')
    const mutated = source.replace(good, bad)
    assert.notEqual(source, mutated, 'mutation anchor missing')
    const final = good2 ? mutated.replace(good2, bad2) : mutated
    return { shortCircuit: true, format: 'module', source: transformSync(final, { loader: 'ts', format: 'esm', target: 'esnext' }).code }
  } })
} else {
  for (const [i, [name, , , , test, pattern]] of cases.entries()) {
    const result = spawnSync('rtk', ['node', '--import', 'tsx', '--import', import.meta.filename, '--test', '--test-timeout=15000', '--test-name-pattern=' + pattern, 'src/agent/__tests__/' + test], {
      cwd: root, env: { ...process.env, REVIT_PR_DEFECT: String(i) }, encoding: 'utf8', timeout: 30000, windowsHide: true,
    })
    const out = result.stdout + result.stderr
    assert.ok(result.status !== 0 && out.includes('AssertionError'), name + ' not assertion RED:\n' + out.slice(-3000))
    console.log('ASSERTION RED: ' + name)
  }
  console.log(`${cases.length}/${cases.length} restored defects caught; checkout untouched`)
}
