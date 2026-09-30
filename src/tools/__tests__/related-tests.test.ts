import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { RELATED_TESTS_TOOL, createRelatedTestsTool } from '../related-tests.js'
import type { MeridianDb } from '../../repo/meridian-db.js'

describe('RELATED_TESTS_TOOL', () => {
  let testDir: string

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), 'related-tests-'))
    // src/foo.ts -> src/__tests__/foo.test.ts
    mkdirSync(join(testDir, 'src', '__tests__'), { recursive: true })
    writeFileSync(join(testDir, 'src', 'foo.ts'), '')
    writeFileSync(join(testDir, 'src', '__tests__', 'foo.test.ts'), '')

    // src/tools/bash.ts -> src/tools/bash.test.ts (co-located)
    mkdirSync(join(testDir, 'src', 'tools'), { recursive: true })
    writeFileSync(join(testDir, 'src', 'tools', 'bash.ts'), '')
    writeFileSync(join(testDir, 'src', 'tools', 'bash.test.ts'), '')

    // src/api/client.ts -> no tests
    mkdirSync(join(testDir, 'src', 'api'), { recursive: true })
    writeFileSync(join(testDir, 'src', 'api', 'client.ts'), '')

    // Non-src path: lib/utils.ts -> lib/__tests__/utils.test.ts
    mkdirSync(join(testDir, 'lib', '__tests__'), { recursive: true })
    writeFileSync(join(testDir, 'lib', 'utils.ts'), '')
    writeFileSync(join(testDir, 'lib', '__tests__', 'utils.test.ts'), '')
  })

  after(async () => {
    // Windows 上临时文件可能仍被 spawned 进程/AV 占用——rmSync 直接 EPERM；
    // 带重试的清理是平台无关的（POSIX 下立即成功）。
    await rm(testDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 })
  })

  function makeParams(input: Record<string, unknown>) {
    return {
      input,
      toolUseId: 'test',
      cwd: testDir,
    }
  }

  it('finds __tests__/foo.test.ts for src/foo.ts', async () => {
    const result = await RELATED_TESTS_TOOL.execute(makeParams({ file: 'src/foo.ts' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes(join('src', '__tests__', 'foo.test.ts')))
  })

  it('finds co-located bash.test.ts for src/tools/bash.ts', async () => {
    const result = await RELATED_TESTS_TOOL.execute(makeParams({ file: 'src/tools/bash.ts' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes(join('src', 'tools', 'bash.test.ts')))
  })

  it('returns empty message when no tests exist', async () => {
    const result = await RELATED_TESTS_TOOL.execute(makeParams({ file: 'src/api/client.ts' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('未找到相关测试'))
  })

  it('supports non-src paths', async () => {
    const result = await RELATED_TESTS_TOOL.execute(makeParams({ file: 'lib/utils.ts' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes(join('lib', '__tests__', 'utils.test.ts')))
  })

  it('requiresApproval and isConcurrencySafe', () => {
    assert.equal(RELATED_TESTS_TOOL.requiresApproval(makeParams({ file: 'test' })), false)
    assert.equal(RELATED_TESTS_TOOL.isConcurrencySafe(), true)
  })

  it('finds source file for a test file (reverse lookup)', async () => {
    const result = await RELATED_TESTS_TOOL.execute(
      makeParams({ file: 'src/__tests__/foo.test.ts' }),
    )
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes(join('src', 'foo.ts')))
  })
})

describe('RELATED_TESTS_TOOL — Python heuristics (W1)', () => {
  let pyDir: string

  before(() => {
    pyDir = mkdtempSync(join(tmpdir(), 'related-tests-py-'))
    // Co-located: pkg/utils.py -> pkg/test_utils.py
    mkdirSync(join(pyDir, 'pkg'), { recursive: true })
    writeFileSync(join(pyDir, 'pkg', 'utils.py'), '')
    writeFileSync(join(pyDir, 'pkg', 'test_utils.py'), '')

    // Sibling tests/ dir: pkg/core.py -> pkg/tests/test_core.py
    mkdirSync(join(pyDir, 'pkg', 'tests'), { recursive: true })
    writeFileSync(join(pyDir, 'pkg', 'core.py'), '')
    writeFileSync(join(pyDir, 'pkg', 'tests', 'test_core.py'), '')

    // Top-level flat tests/: helpers.py -> tests/test_helpers.py
    mkdirSync(join(pyDir, 'tests'), { recursive: true })
    writeFileSync(join(pyDir, 'helpers.py'), '')
    writeFileSync(join(pyDir, 'tests', 'test_helpers.py'), '')

    // tests/ mirror: src/mail/message.py -> tests/mail/test_message.py
    mkdirSync(join(pyDir, 'src', 'mail'), { recursive: true })
    mkdirSync(join(pyDir, 'tests', 'mail'), { recursive: true })
    writeFileSync(join(pyDir, 'src', 'mail', 'message.py'), '')
    writeFileSync(join(pyDir, 'tests', 'mail', 'test_message.py'), '')

    // No tests: pkg/lonely.py
    writeFileSync(join(pyDir, 'pkg', 'lonely.py'), '')
  })

  after(async () => {
    await rm(pyDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 })
  })

  function makeParams(input: Record<string, unknown>) {
    return { input, toolUseId: 'test', cwd: pyDir }
  }

  it('finds co-located test_<name>.py', async () => {
    const result = await RELATED_TESTS_TOOL.execute(makeParams({ file: 'pkg/utils.py' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes(join('pkg', 'test_utils.py')))
  })

  it('finds sibling tests/ dir test', async () => {
    const result = await RELATED_TESTS_TOOL.execute(makeParams({ file: 'pkg/core.py' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes(join('pkg', 'tests', 'test_core.py')))
  })

  it('finds top-level flat tests/test_<name>.py', async () => {
    const result = await RELATED_TESTS_TOOL.execute(makeParams({ file: 'helpers.py' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes(join('tests', 'test_helpers.py')))
  })

  it('finds tests/ mirror for src/ path', async () => {
    const result = await RELATED_TESTS_TOOL.execute(makeParams({ file: 'src/mail/message.py' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes(join('tests', 'mail', 'test_message.py')))
  })

  it('returns empty message when no python tests exist', async () => {
    const result = await RELATED_TESTS_TOOL.execute(makeParams({ file: 'pkg/lonely.py' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('未找到相关测试'))
  })

  it('reverse lookup: test_utils.py -> utils.py', async () => {
    const result = await RELATED_TESTS_TOOL.execute(makeParams({ file: 'pkg/test_utils.py' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes(join('pkg', 'utils.py')))
  })

  it('reverse lookup: pkg/tests/test_core.py -> pkg/core.py', async () => {
    const result = await RELATED_TESTS_TOOL.execute(makeParams({ file: 'pkg/tests/test_core.py' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes(join('pkg', 'core.py')))
  })
})

describe('createRelatedTestsTool (meridian factory)', () => {
  function mockDb(tests: Record<string, string[]>): MeridianDb {
    return {
      getTestsFor: (f: string) => tests[f] ?? [],
      getReverseDependents: () => [],
      getCoEditNeighbors: () => [],
    } as unknown as MeridianDb
  }

  it('returns meridian SQL results when indexer is available', async () => {
    const db = mockDb({ 'src/foo.ts': ['src/__tests__/foo.test.ts', 'src/__tests__/foo-extra.test.ts'] })
    const tool = createRelatedTestsTool(() => ({ getDb: () => db }) as never)
    const result = await tool.execute({
      input: { file: 'src/foo.ts' },
      toolUseId: 'test',
      cwd: '/fake',
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('foo.test.ts'))
    assert.ok(result.content.includes('foo-extra.test.ts'))
  })

  it('falls back to hardcoded heuristics when indexer returns no tests', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'rt-fallback-'))
    try {
      mkdirSync(join(testDir, 'src', '__tests__'), { recursive: true })
      writeFileSync(join(testDir, 'src', 'foo.ts'), '')
      writeFileSync(join(testDir, 'src', '__tests__', 'foo.test.ts'), '')

      const db = mockDb({}) // empty → no meridian results
      const tool = createRelatedTestsTool(() => ({ getDb: () => db }) as never)
      const result = await tool.execute({
        input: { file: 'src/foo.ts' },
        toolUseId: 'test',
        cwd: testDir,
      })
      assert.ok(result.content.includes('foo.test.ts'))
    } finally {
      await rm(testDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 })
    }
  })

  it('falls back to hardcoded heuristics when indexer is null', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'rt-null-'))
    try {
      mkdirSync(join(testDir, 'src', '__tests__'), { recursive: true })
      writeFileSync(join(testDir, 'src', 'bar.ts'), '')
      writeFileSync(join(testDir, 'src', '__tests__', 'bar.test.ts'), '')

      const tool = createRelatedTestsTool(() => null)
      const result = await tool.execute({
        input: { file: 'src/bar.ts' },
        toolUseId: 'test',
        cwd: testDir,
      })
      assert.ok(result.content.includes('bar.test.ts'))
    } finally {
      await rm(testDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 })
    }
  })
})
