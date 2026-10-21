import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { formatDeliveryVerificationPlan, buildDeliveryVerificationPlan, renderDeliveryVerificationPlan } from '../delivery-verification-plan.js'
import { createDeliverTaskTool } from '../deliver-task.js'
import { createTaskLedger } from '../task-ledger.js'
import { createOwnershipLedger } from '../ownership-ledger.js'
import { createWorktreeBaseline } from '../worktree-baseline.js'
import { createVerificationAttribution } from '../verification-attribution.js'
import { createDeliveryGateV2 } from '../delivery-gate-v2.js'
import { BASH_TOOL } from '../../tools/bash.js'
import { buildBashVerification } from '../bash-verification.js'

it('candidate plan carries deliveryFiles into each batch and omits live-tree shell commands', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'delivery-candidate-plan-'))
  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
    writeFileSync(join(cwd, 'feature.test.mjs'), "import { test } from 'node:test'; test('ok', () => {})")
    const plan = buildDeliveryVerificationPlan(cwd, ['feature.test.mjs'], ['feature.test.mjs'], 0, [], 'candidate-ref', ['feature.ts'])
    const rendered = renderDeliveryVerificationPlan(plan, cwd).join('\n')
    assert.deepEqual(plan.candidateFiles, ['feature.ts'])
    assert.match(rendered, /run_tests\(files=\["feature.test.mjs"\], deliveryFiles=\["feature.ts"\]/)
    assert.doesNotMatch(rendered, /cwd:/)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

it('actual delivery returns executable batches; all batches cover obligations and advisory never blocks', { skip: process.platform === 'win32' }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'delivery-batches-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-qm', 'base'], { cwd })
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }))
    const required = Array.from({ length: 24 }, (_, i) => `part-${i}.test.mjs`)
    for (const path of [...required, 'advisory.test.mjs']) writeFileSync(join(cwd, path), "import {test} from 'node:test'; test('proof',()=>{});")
    writeFileSync(join(cwd, 'feature.js'), 'export const feature = 1;')
    const ledger = createTaskLedger({ taskId: 'batches' })
    ledger.record({ type: 'file_write', path: 'feature.js' })
    ledger.record({ type: 'verification', command: 'typecheck', status: 'passed', meta: { kind: 'typecheck', scope: 'full', exitCode: 0 } })
    const ownership = createOwnershipLedger({ taskLedger: ledger, baseline: createWorktreeBaseline({ branch: 'main', head: 'base', preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() }) })
    const gate = createDeliveryGateV2({ taskLedger: ledger, ownership, attribution: createVerificationAttribution({ ownership }) })
    let commits = 0
    const tool = createDeliverTaskTool(() => ({ taskLedger: ledger, ownership, gate, getCurrentDirtyFiles: () => ['feature.js'], resolveDeliveryImpact: async () => ({ resolved: true, requiredTests: required, advisoryTests: ['advisory.test.mjs'], policyVersion: 1 }), detectWroteButNeverRead: () => [], commitOwnedFiles: () => { commits++; return { ok: true, output: 'fixture commit' } } }))
    const params = { cwd, toolUseId: 'batch-deliver', input: { commit: true, force: true, message: 'fix: fixture' } }
    const status = await tool.execute({ ...params, input: { commit: false } })
    assert.notEqual(status.isError, true)
    assert.match(status.content, /required 24，已覆盖 0，剩余 24/)
    const first = await tool.execute(params)
    assert.equal(first.isError, true)
    assert.equal(commits, 0)
    assert.match(first.content, /required 24，已覆盖 0，剩余 24/)
    assert.ok(first.content.indexOf('run_tests(files=') < first.content.indexOf('part-0.test.mjs: not_run'), 'the first executable batch precedes per-file reasons')
    assert.match(first.content, /其余 16 个文件状态见 verificationPlan.pendingReasons/)
    const commands = first.verificationPlan!.batches.map(batch => batch.display)
    assert.equal(first.verificationPlan!.pending.length, 24)
    assert.equal(commands.length, 2)
    for (let i = 0; i < commands.length; i++) {
      const result = await BASH_TOOL.execute({ cwd, toolUseId: `batch-${i}`, input: { command: commands[i]! } })
      const proof = buildBashVerification(commands[i]!, result, { content: result.content, isError: !!result.isError })
      assert.equal(proof.coverage?.complete, true)
      ledger.record({ type: 'verification', command: commands[i]!, status: proof.status, meta: { ...proof } })
      const delivered = await tool.execute(params)
      if (i === 0) { assert.equal(delivered.isError, true); assert.equal(commits, 0); assert.match(delivered.content, /已覆盖 20，剩余 4/) }
      else { assert.notEqual(delivered.isError, true, delivered.content); assert.equal(commits, 1) }
    }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

it('nested packages get their own cwd; unsupported runners keep every pending obligation visible', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'delivery-package-'))
  try {
    mkdirSync(join(cwd, 'nested'))
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    writeFileSync(join(cwd, 'nested/package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
    const required = ['a.test.js', 'nested/b.test.mjs']
    for (const path of required) writeFileSync(join(cwd, path), '// fixture')
    const text = formatDeliveryVerificationPlan(cwd, required, required, 9999).join('\n')
    assert.match(text, /advisory 9999 不阻断/)
    assert.match(text, /未生成可采证批命令.*义务保留：a.test.js/)
    assert.match(text, /run_tests\(files=\["nested\/b.test.mjs"\]\)/)
    assert.ok(text.indexOf('未生成可采证批命令') < text.indexOf('run_tests(files='), 'unverifiable obligations are visible before batch commands')
    assert.equal(buildDeliveryVerificationPlan(cwd, required, required, 0).batches[0]!.cwd, join(cwd, 'nested'))
    assert.ok(!text.includes("node --test 'a.test.js'"))
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

it('batch suggestions preserve preload flags and never silently replace fixed or filtered targets', { skip: process.platform === 'win32' }, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'delivery-runner-'))
  try {
    symlinkSync(join(import.meta.dirname, '../../../node_modules'), join(cwd, 'node_modules'), 'junction')
    const file = 'feature.test.ts'
    writeFileSync(join(cwd, file), '// fixture')
    for (const script of ['node --import tsx --require setup.cjs scripts/run-node-tests.ts', 'node --import tsx --require setup.cjs --test', 'rtk node --import tsx --require setup.cjs scripts/run-node-tests.ts', 'rtk node --import tsx --require setup.cjs --test']) {
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: script } }))
      const output = formatDeliveryVerificationPlan(cwd, [file], [file], 0).join('\n')
      assert.match(output, /run_tests\(files=\["feature.test.ts"\]\)/)
      assert.equal(buildDeliveryVerificationPlan(cwd, [file], [file], 0).batches[0]!.display, 'npm run test -- feature.test.ts')
      assert.doesNotMatch(output, /rtk rtk/)
    }
    for (const script of ['node --test fixed.test.js', 'node --test --test-name-pattern selected', 'tsx scripts/run-node-tests.ts fixed.test.js']) {
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: script } }))
      assert.match(formatDeliveryVerificationPlan(cwd, [file], [file], 0).join('\n'), /未生成可采证批命令.*义务保留：feature.test.ts/)
    }
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'tsx scripts/run-node-tests.ts' } }))
    assert.match(formatDeliveryVerificationPlan(cwd, [file], [file], 0).join('\n'), /npm run test -- feature.test.ts/)
    assert.match(formatDeliveryVerificationPlan(cwd, ['../outside.test.ts'], ['../outside.test.ts'], 0).join('\n'), /当前仓库内.*义务保留/)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
