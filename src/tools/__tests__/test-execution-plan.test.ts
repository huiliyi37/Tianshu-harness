import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { classifyVerificationCommand } from '../verification-command.js'
import { buildTestExecutionPlan } from '../test-execution-plan.js'
import { classifyVerificationIntent } from '../../agent/verification-intent.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'test-plan-'))
  const write = (path: string, content: unknown) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content)) }
  write('package.json', { name: 'root', packageManager: 'pnpm@11.7.0', scripts: { test: 'pnpm --filter @fixture/web test' }, workspaces: ['packages/*'] })
  write('packages/web/package.json', { name: '@fixture/web', scripts: { test: 'vitest run --config vitest.config.ts --maxWorkers=1' } })
  write('packages/web/src/a.spec.tsx', '// fixture')
  write('node_modules/vitest/package.json', { name: 'vitest', version: '5.0.5', bin: { vitest: 'vitest.mjs' } })
  write('node_modules/vitest/vitest.mjs', '// resolver-only fixture, never executed')
  write('node_modules/vite/package.json', { name: 'vite', main: 'index.js' })
  write('node_modules/vite/index.js', '// resolver fixture')
  return { root, write, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

test('one resolver follows workspace forwarding without confusing files with name filters', () => {
  const f = fixture()
  try {
    for (const command of ['npm test', 'pnpm --filter @fixture/web test', 'npm --workspace=@fixture/web test', 'yarn workspace @fixture/web test', 'bun run test']) {
      const info = classifyVerificationCommand(command, f.root)
      assert.equal(info.runner, 'vitest', command)
      assert.equal(info.resolvedCwd, join(f.root, 'packages/web'))
      assert.equal(info.filtered, false)
    }
    assert.equal(classifyVerificationCommand('pnpm exec vitest run src/a.spec.tsx', f.root).filtered, false)
    assert.equal(classifyVerificationCommand('npm exec -- vitest run -t name src/a.spec.tsx', f.root).filtered, true)
    assert.equal(classifyVerificationIntent('pnpm --filter @fixture/web test', f.root).allowsCompletionEvidence, true)
    assert.equal(classifyVerificationIntent('vitest --watch', f.root).waitingEligible, false)
    assert.equal(classifyVerificationCommand('bun test', f.root).runner, undefined)
  } finally { f.dispose() }
})

test('workspace files produce package-scoped batches and keep their original script', () => {
  const f = fixture()
  try {
    const plan = buildTestExecutionPlan(f.root, { files: ['packages/web/src/a.spec.tsx'] })
    assert.deepEqual(plan.blocked, [])
    assert.equal(plan.groups[0]!.cwd, f.root, 'a unique root forwarding chain retains root hooks too')
    assert.equal(plan.groups[0]!.packageRoot, join(f.root, 'packages/web'))
    assert.deepEqual(plan.groups[0]!.args, ['run', 'test', 'src/a.spec.tsx'])
    assert.equal(plan.groups[0]!.command, 'pnpm')
    assert.deepEqual(plan.groups[0]!.files, ['packages/web/src/a.spec.tsx'])
    const full = buildTestExecutionPlan(f.root)
    assert.equal(full.groups[0]!.cwd, f.root)
    assert.deepEqual(full.groups[0]!.args, ['run', 'test'])
  } finally { f.dispose() }
})

test('desktop package test script produces a file-scoped Node batch', () => {
  const f = fixture()
  try {
    f.write('desktop/package.json', { name: 'tianshu-desktop', scripts: { test: 'node --import tsx scripts/run-tests.ts' } })
    f.write('desktop/scripts/__tests__/panel.test.ts', '// fixture')
    const desktop = join(f.root, 'desktop')
    const invocation = classifyVerificationCommand('npm test', desktop)
    assert.equal(invocation.runner, 'node-test')
    assert.equal(invocation.batchRunner, true)
    const plan = buildTestExecutionPlan(f.root, { files: ['desktop/scripts/__tests__/panel.test.ts'] })
    assert.deepEqual(plan.blocked, [])
    assert.equal(plan.groups[0]!.cwd, desktop)
    assert.deepEqual(plan.groups[0]!.files, ['desktop/scripts/__tests__/panel.test.ts'])
    assert.deepEqual(plan.groups[0]!.args, ['run', 'test', '--', 'scripts/__tests__/panel.test.ts'])
    assert.equal(classifyVerificationCommand('node --import tsx scripts/run-tests.ts', f.root).runner, undefined, 'same relative script outside desktop remains unsupported')
  } finally { f.dispose() }
})

test('ambiguous names, escaping symlinks, cycles and unknown options fail towards less execution', () => {
  const f = fixture()
  try {
    f.write('packages/other/a.spec.tsx', '// duplicate')
    assert.equal(buildTestExecutionPlan(f.root, { filter: 'a.spec.tsx' }).blocked[0]!.code, 'filter_ambiguous')
    assert.equal(buildTestExecutionPlan(f.root, { filter: '../a.spec.tsx' }).blocked[0]!.code, 'invalid_selection')
    assert.equal(buildTestExecutionPlan(f.root, { files: ['packages/web/src/a.spec.tsx'], filter: 'a' }).groups.length, 0)
    const outside = mkdtempSync(join(tmpdir(), 'test-plan-outside-'))
    try {
      writeFileSync(join(outside, 'escape.spec.tsx'), '// outside')
      symlinkSync(join(outside, 'escape.spec.tsx'), join(f.root, 'escape.spec.tsx'))
      assert.equal(buildTestExecutionPlan(f.root, { files: ['escape.spec.tsx'] }).groups.length, 0)
    } finally { rmSync(outside, { recursive: true, force: true }) }
    f.write('package.json', { scripts: { test: 'npm test' } })
    assert.match(classifyVerificationCommand('npm test', f.root).reason!, /循环|深度/)
    assert.match(classifyVerificationCommand('vitest run --unrecognized value', f.root).reason!, /未适配/)
    assert.equal(classifyVerificationCommand('vitest run && echo ok', f.root).runner, undefined)
  } finally { f.dispose() }
})

test('Jest uses exact paths, missing dependencies remain blocked, and batches stay bounded', () => {
  const f = fixture()
  try {
    f.write('packages/web/package.json', { name: '@fixture/web', scripts: { test: 'jest --runInBand' } })
    assert.equal(buildTestExecutionPlan(f.root, { files: ['packages/web/src/a.spec.tsx'] }).blocked[0]!.code, 'missing_dependency')
    f.write('node_modules/jest/package.json', { name: 'jest', version: '30.5.2', bin: { jest: 'bin/jest.js' } })
    f.write('node_modules/jest/bin/jest.js', '// fixture')
    const files = Array.from({ length: 24 }, (_, index) => `packages/web/src/case-${index}.test.cjs`)
    for (const file of files) f.write(file, '// test')
    const plan = buildTestExecutionPlan(f.root, { files })
    assert.deepEqual(plan.groups.map(group => group.files.length), [20, 4])
    assert.ok(plan.groups.every(group => group.args.includes('--runTestsByPath')))
    f.write('packages/web/package.json', { name: '@fixture/web', scripts: { test: 'jest --runTestsByPath ' + files.map(file => file.slice('packages/web/'.length)).join(' ') } })
    const fixed = buildTestExecutionPlan(f.root, { files })
    assert.equal(fixed.groups.length, 0, 'fixed targets cannot pretend to be split while executing the whole script twice')
    assert.match(fixed.blocked[0]!.reason, /固定文件数量/)
  } finally { f.dispose() }
})
