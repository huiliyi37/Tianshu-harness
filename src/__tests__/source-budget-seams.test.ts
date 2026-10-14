import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as planConstraints from '../agent/plan-constraints.js'
import * as attachments from '../server/attachment-validation.js'
import * as runtimeEnv from '../prompt/runtime-env.js'
import * as mirrorEnv from '../tools/mirror-env.js'
import * as settingsFrontend from '../tui/settings-frontend.js'
import { MAX_IMAGES, MAX_IMAGE_BYTES } from '../server/attachment-limits.js'
import type { MirrorsConfig } from '../config/schema.js'
import type { SettingsDraft } from '../tui/settings-model.js'

test('approved-plan pointer preserves XML escaping and selected-approach guidance', () => {
  assert.equal(typeof planConstraints.formatActivePlanPointer, 'function')
  const pointer = planConstraints.formatActivePlanPointer({
    slug: 'a&b',
    title: '<Fix> "quotes"',
    selectedApproach: 'A > B & C',
  })
  assert.equal(pointer, '<active-plan slug="a&amp;b" title="&lt;Fix&gt; &quot;quotes&quot;" path=".rivet/plans/a&amp;b.md">已选方案: A &gt; B &amp; C。只执行此方案，勿执行未选中的备选。 已批准,正在执行此方案。完整步骤见该文件,需要时用 read_file 查看;开工前先用 todo 列出有序步骤跟踪进度,完成后 plan_close。</active-plan>')
  assert.doesNotMatch(planConstraints.formatActivePlanPointer({ slug: 'plain', title: 'Plain', selectedApproach: '' }), /已选方案/)
})

test('image validation keeps optional payloads, MIME allowlist and count errors', () => {
  assert.equal(typeof attachments.validateImagesPayload, 'function')
  assert.deepEqual(attachments.validateImagesPayload(undefined), {})
  for (const invalid of [null, [], 'image']) {
    assert.deepEqual(attachments.validateImagesPayload(invalid), { error: '"images" must be a non-empty array' })
  }
  const images = ['png', 'jpeg', 'webp', 'gif'].map(format => `data:image/${format};base64,YQ==`)
  const result = attachments.validateImagesPayload(images)
  assert.equal(result.images, images)
  assert.deepEqual(attachments.validateImagesPayload(['DATA:IMAGE/PNG;BASE64,YQ==']), { images: ['DATA:IMAGE/PNG;BASE64,YQ=='] })
  for (const invalid of [42, 'data:image/svg+xml;base64,YQ==', 'data:image/png;base64,']) {
    assert.deepEqual(attachments.validateImagesPayload([invalid]), { error: 'Each image must be a data:image/(png|jpeg|webp|gif);base64 URL' })
  }
  assert.deepEqual(attachments.validateImagesPayload(Array(MAX_IMAGES + 1).fill(images[0])), { error: `Max ${MAX_IMAGES} images allowed` })
})

test('image byte limits account for both base64 padding lengths exactly', () => {
  assert.equal(typeof attachments.validateImagesPayload, 'function')
  for (const bytes of [MAX_IMAGE_BYTES - 1, MAX_IMAGE_BYTES, MAX_IMAGE_BYTES + 1]) {
    const images = [`data:image/png;base64,${Buffer.alloc(bytes).toString('base64')}`]
    assert.deepEqual(attachments.validateImagesPayload(images), bytes <= MAX_IMAGE_BYTES
      ? { images }
      : { error: `Each image must be <= ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB` })
  }
})

test('shell guidance still follows the resolved family and is byte-stable', () => {
  assert.equal(typeof runtimeEnv.windowsShellNote, 'function')
  for (const [kind, required, forbidden] of [
    ['bash', /Git Bash.*2>\/dev\/null/, /\$env:/],
    ['powershell', /PowerShell.*\$env:NAME.*2>\$null.*\$LASTEXITCODE/, /shell 是 cmd/],
    ['cmd', /cmd\.exe.*%VAR%.*2>nul/, /\$env:/],
  ] as const) {
    const note = runtimeEnv.windowsShellNote(kind)
    assert.match(note, required)
    assert.doesNotMatch(note, forbidden)
    assert.equal(runtimeEnv.windowsShellNote(kind), note)
  }
  assert.equal(runtimeEnv.windowsShellNote('sh'), '')
})

test('GitHub clone early-fail environment respects fallback without requiring mirror enablement', () => {
  assert.equal(typeof mirrorEnv.gitCloneEarlyFailEnv, 'function')
  const config: MirrorsConfig = {
    enabled: false,
    preset: 'default',
    github: 'default',
    npm: 'default',
    pypi: 'default',
    go: 'default',
    rust: 'default',
    autoFallback: true,
    fallbackMemoryMinutes: 10,
    fallbackTimeoutSec: 60,
  }
  const expected = { GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '15' }
  assert.deepEqual(mirrorEnv.gitCloneEarlyFailEnv('git clone https://github.com/example/repo.git', config), expected)
  assert.deepEqual(mirrorEnv.gitCloneEarlyFailEnv('git -C work clone https://github.com/example/repo.git', config), expected)
  assert.deepEqual(mirrorEnv.gitCloneEarlyFailEnv('git clone https://github.com/example/repo.git', { ...config, autoFallback: false }), {})
  assert.deepEqual(mirrorEnv.gitCloneEarlyFailEnv('git fetch https://github.com/example/repo.git', config), {})
  assert.deepEqual(mirrorEnv.gitCloneEarlyFailEnv('git clone https://example.com/repo.git', config), {})
})

test('integer settings fields preserve receiver, parsing, guards and exception semantics', () => {
  assert.equal(typeof settingsFrontend.intField, 'function')
  const draft = { basics: { checkpointEveryTurns: 7 } } as SettingsDraft
  const calls: string[] = []
  const input: Parameters<typeof settingsFrontend.intField>[0] = {
    id: 'agent.checkpointEveryTurns',
    label: '检查点间隔（回合，0=关）',
    block: 'checkpoint',
    effect: 'next-session',
    min: 0,
    hint: '保留提示',
    get(current) {
      assert.equal(this.id, 'agent.checkpointEveryTurns')
      return current.basics.checkpointEveryTurns
    },
    guard() {
      assert.equal(this.min, 0)
      calls.push('guard')
      return undefined
    },
    set(current, value) {
      assert.equal(this.block, 'checkpoint')
      calls.push('set')
      return { ...current, basics: { ...current.basics, checkpointEveryTurns: value } }
    },
  }
  const field = settingsFrontend.intField(input)
  assert.equal(field.label, input.label)
  assert.equal(field.hint, '保留提示')
  assert.equal(field.display(draft, { models: [], domains: [] }), '7')
  assert.equal(field.raw?.(draft), '7')
  assert.ok(field.apply)
  assert.deepEqual(field.apply(draft, ' 0 '), { basics: { checkpointEveryTurns: 0 } })
  assert.deepEqual(calls, ['guard', 'set'])
  for (const invalid of ['-1', 'bad', '']) {
    assert.deepEqual(field.apply(draft, invalid), { error: '需为不小于 0 的整数' })
  }
  assert.equal(draft.basics.checkpointEveryTurns, 7)
  assert.deepEqual(field.apply(draft, ' 12suffix '), { basics: { checkpointEveryTurns: 12 } })
  input.guard = () => '先选择模型'
  assert.deepEqual(field.apply(draft, 'bad'), { error: '先选择模型' })
  const failure = new Error('guard failure')
  input.guard = () => { throw failure }
  assert.throws(() => field.apply!(draft, '1'), error => error === failure)
  input.guard = undefined
  input.set = () => { throw failure }
  assert.throws(() => field.apply!(draft, '1'), error => error === failure)
})
