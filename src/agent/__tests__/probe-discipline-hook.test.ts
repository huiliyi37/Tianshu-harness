import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProbeDisciplineHook } from '../hooks/probe-discipline-hook.js'
import type { RuntimeToolEvent } from '../runtime-hooks.js'

interface Submitted {
  category: string
  content: string
}

function makeDeps() {
  const submitted: Submitted[] = []
  const advisoryBus = { submit: (a: Submitted) => { submitted.push(a) } }
  return { submitted, advisoryBus }
}

function ev(name: string): RuntimeToolEvent {
  return { name, success: true }
}

test('fires after 5 consecutive read-only tools', async () => {
  const { submitted, advisoryBus } = makeDeps()
  const hook = createProbeDisciplineHook({ advisoryBus })
  for (const n of ['read_file', 'grep', 'glob', 'read_file', 'repo_map']) {
    await hook.run({} as never, ev(n))
  }
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0]!.category, 'discipline')
  assert.ok(submitted[0]!.content.includes('探针'), 'content mentions probe')
})

test('does not fire before the threshold', async () => {
  const { submitted, advisoryBus } = makeDeps()
  const hook = createProbeDisciplineHook({ advisoryBus })
  await hook.run({} as never, ev('read_file'))
  await hook.run({} as never, ev('grep'))
  assert.equal(submitted.length, 0)
})

test('a write/verify tool breaks the read streak', async () => {
  const { submitted, advisoryBus } = makeDeps()
  const hook = createProbeDisciplineHook({ advisoryBus })
  await hook.run({} as never, ev('read_file'))
  await hook.run({} as never, ev('grep'))
  await hook.run({} as never, ev('bash'))
  await hook.run({} as never, ev('read_file'))
  await hook.run({} as never, ev('grep'))
  assert.equal(submitted.length, 0, 'streak reset by non-readonly tool')
})

test('cooldown prevents repeated injection within 12 calls', async () => {
  const { submitted, advisoryBus } = makeDeps()
  const hook = createProbeDisciplineHook({ advisoryBus })
  // First trigger at call 5
  for (let i = 0; i < 5; i++) await hook.run({} as never, ev('read_file'))
  assert.equal(submitted.length, 1)
  // 11 more readonly calls — still inside cooldown (12 calls), no second inject
  for (let i = 0; i < 11; i++) await hook.run({} as never, ev('read_file'))
  assert.equal(submitted.length, 1, 'cooldown suppresses second injection')
  // Call 17 crosses the cooldown window → second injection
  await hook.run({} as never, ev('read_file'))
  assert.equal(submitted.length, 2, 'injection repeats after cooldown')
})

test('zero-anchor read streak fires 取证 (evidence-first), not plain probe', async () => {
  const { submitted, advisoryBus } = makeDeps()
  const hook = createProbeDisciplineHook({ advisoryBus })
  for (const n of ['read_file', 'grep', 'glob', 'read_file', 'repo_map']) {
    await hook.run({} as never, ev(n))
  }
  assert.equal(submitted.length, 1)
  assert.ok(submitted[0]!.content.includes('取证'), 'zero-anchor reads should nudge evidence collection')
  assert.ok(submitted[0]!.content.includes('锚点'), 'mentions observation anchors')
})

test('anchored read streak fires plain probe (has evidence, needs kill)', async () => {
  const { submitted, advisoryBus } = makeDeps()
  const hook = createProbeDisciplineHook({ advisoryBus })
  // read_section 恒算锚点；再补带 context_lines 的 grep；其余为普通只读
  await hook.run({} as never, { ...ev('read_section'), input: {} })
  await hook.run({} as never, { ...ev('grep'), input: { pattern: 'x', context_lines: 3 } })
  await hook.run({} as never, { ...ev('glob'), input: { pattern: '**/*.ts' } })
  await hook.run({} as never, { ...ev('read_file'), input: { file_path: 'a.ts' } })
  await hook.run({} as never, { ...ev('repo_map'), input: {} })
  assert.equal(submitted.length, 1)
  assert.ok(submitted[0]!.content.includes('探针'), 'anchored reads → probe nudge')
  assert.ok(!submitted[0]!.content.includes('锚点'), 'anchored reads should not nudge evidence collection')
})
