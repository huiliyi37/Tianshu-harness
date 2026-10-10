import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { GLOB_TOOL, GLOB_EMPTY_RESULT } from '../glob.js'

describe('GLOB_TOOL', () => {
  let testDir: string

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), 'glob-test-'))
    mkdirSync(join(testDir, 'src', 'components'), { recursive: true })
    mkdirSync(join(testDir, 'src', 'utils'), { recursive: true })
    mkdirSync(join(testDir, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(testDir, '.codex'), { recursive: true })
    mkdirSync(join(testDir, '.test-tmp'), { recursive: true })
    writeFileSync(join(testDir, 'src', 'app.ts'), '')
    writeFileSync(join(testDir, 'src', 'components', 'Button.tsx'), '')
    writeFileSync(join(testDir, 'src', 'components', 'Modal.tsx'), '')
    writeFileSync(join(testDir, 'src', 'utils', 'helpers.ts'), '')
    writeFileSync(join(testDir, 'src', 'style.css'), '')
    writeFileSync(join(testDir, 'README.md'), '')
    writeFileSync(join(testDir, 'layout.log'), '')
    writeFileSync(join(testDir, '.codex', 'hooks.json'), '')
    writeFileSync(join(testDir, '.test-tmp', 'debug.json'), '')
    writeFileSync(join(testDir, 'node_modules', 'pkg', 'index.ts'), '')
  })

  after(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  function makeParams(input: Record<string, unknown>) {
    return {
      input,
      toolUseId: 'test',
      cwd: testDir,
    }
  }

  it('finds files matching a simple pattern', async () => {
    const result = await GLOB_TOOL.execute(makeParams({ pattern: '*.md' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('README.md'))
  })

  it('matches ** recursively', async () => {
    const result = await GLOB_TOOL.execute(makeParams({ pattern: 'src/**/*.ts' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('src/app.ts'))
    assert.ok(result.content.includes('src/utils/helpers.ts'))
  })

  it('excludes build/runtime/foreign attention noise from broad discovery', async () => {
    const result = await GLOB_TOOL.execute(makeParams({ pattern: '**/*' }))
    assert.ok(!result.content.includes('node_modules'))
    assert.ok(!result.content.includes('layout.log'))
    assert.ok(!result.content.includes('.codex'))
    assert.ok(!result.content.includes('.test-tmp'))
    assert.ok(result.content.includes('src/app.ts'))
  })

  it('keeps explicitly targeted silent-layer glob results visible while preserving project gitignore semantics', async () => {
    const logResult = await GLOB_TOOL.execute(makeParams({ pattern: '*.log' }))
    assert.ok(logResult.content.includes('layout.log'))

    const foreignResult = await GLOB_TOOL.execute(makeParams({ pattern: '.codex/**' }))
    assert.ok(foreignResult.content.includes('.codex/hooks.json'))

    const ignoredResult = await GLOB_TOOL.execute(makeParams({ pattern: 'node_modules/**' }))
    assert.ok(!ignoredResult.content.includes('node_modules/pkg/index.ts'))
  })

  it('limits to 500 results', async () => {
    const limitDir = mkdtempSync(join(tmpdir(), 'glob-limit-'))
    try {
      for (let i = 0; i < 510; i++) {
        writeFileSync(join(limitDir, `file${i}.ts`), '')
      }
      const result = await GLOB_TOOL.execute({
        input: { pattern: '*.ts' },
        toolUseId: 'test',
        cwd: limitDir,
      })
      const lines = result.content.split('\n').filter((l) => l.trim())
      assert.equal(lines.length, 500)
    } finally {
      rmSync(limitDir, { recursive: true, force: true })
    }
  })

  it('returns no files message for no matches', async () => {
    const result = await GLOB_TOOL.execute(makeParams({ pattern: '*.xyz' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes(GLOB_EMPTY_RESULT))
  })

  it('rejects parent directory traversal in search path', async () => {
    const result = await GLOB_TOOL.execute(makeParams({ pattern: '*.ts', path: '..' }))
    assert.equal(result.isError, true)
    assert.match(result.content, /outside project directory/i)
  })

  it('rejects absolute paths outside cwd', async () => {
    const result = await GLOB_TOOL.execute(makeParams({ pattern: '*.ts', path: tmpdir() }))
    assert.equal(result.isError, true)
    assert.match(result.content, /outside project directory/i)
  })

  it('does not follow symlink cycles', async (t) => {
    const loopDir = mkdtempSync(join(tmpdir(), 'glob-loop-'))
    try {
      mkdirSync(join(loopDir, 'a'), { recursive: true })
      writeFileSync(join(loopDir, 'a', 'file.ts'), '')
      try {
        symlinkSync(loopDir, join(loopDir, 'a', 'loop'), 'dir')
      } catch (err) {
        // Windows 无管理员/开发者模式时 symlink 创建 EPERM——环境权限问题，
        // 不是被测逻辑缺陷（issue #189）：跳过而非判红。
        if ((err as NodeJS.ErrnoException).code === 'EPERM') {
          return t.skip('symlink creation requires admin/dev mode on Windows')
        }
        throw err
      }

      const result = await GLOB_TOOL.execute({
        input: { pattern: '**/*.ts' },
        toolUseId: 'test',
        cwd: loopDir,
      })

      assert.equal(result.isError, undefined)
      assert.ok(result.content.includes('a/file.ts'))
    } finally {
      rmSync(loopDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  it('requiresApproval and isConcurrencySafe', () => {
    assert.equal(GLOB_TOOL.requiresApproval(makeParams({ pattern: 'test' })), false)
    assert.equal(GLOB_TOOL.isConcurrencySafe(), true)
  })
  it('excludes filesystem metadata even when explicitly targeted and preserves ordinary dotfiles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'glob-metadata-'))
    try {
      mkdirSync(join(dir, 'nested'))
      mkdirSync(join(dir, '._metadata-directory'))
      for (const file of ['note.txt', '.notes.txt', '._note.txt', '.DS_Store', 'nested/real.txt', 'nested/._real.txt', '._metadata-directory/leak.txt']) {
        writeFileSync(join(dir, file), 'synthetic fixture')
      }
      const execute = (pattern: string) => GLOB_TOOL.execute({ input: { pattern }, toolUseId: 'metadata', cwd: dir })
      assert.equal((await execute('**/*.txt')).content, '.notes.txt\nnested/real.txt\nnote.txt')
      assert.equal((await execute('._*')).content, GLOB_EMPTY_RESULT)
      assert.equal((await execute('.DS_Store')).content, GLOB_EMPTY_RESULT)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

})
