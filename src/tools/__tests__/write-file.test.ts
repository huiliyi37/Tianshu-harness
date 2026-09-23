import { after, describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync, existsSync, statSync, readFileSync } from 'fs'
import { join } from 'path'
import { WRITE_FILE_TOOL } from '../write-file.js'
import { __setFileReadMtimeForTests } from '../read-file.js'
import type { ToolCallParams } from '../types.js'
import { setTargetConventions } from '../../platform.js'

// 本文件断言的是 LF 形态的文件内容。新建文件的 EOL 由「目标平台约定」决定
// （src/platform.ts 的 getTargetEol），未初始化时兜底到宿主——Windows 上即 crlf，
// 这些断言便恒红。文件级钉到 POSIX 让用例与宿主解耦；退出时恢复宿主默认，避免
// 同一进程里的兄弟测试文件被污染（与 platform-conventions.test.ts 同纪律）。
setTargetConventions('linux', 'auto')
after(() => setTargetConventions('auto', 'auto'))

const TEST_DIR = join(process.cwd(), '.test-tmp', 'opencode-write-test')

function makeParams(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'test-id', cwd: TEST_DIR }
}

/** Register the file as observed this session so the blind-overwrite guard lets
 *  the write through. Key must match validatePath output — the resolve(cwd, path)
 *  form, NOT realpathSync (diverges under symlinked tmp dirs, e.g. macOS /var). */
function markObserved(file: string): void {
  __setFileReadMtimeForTests(file, statSync(file).mtimeMs)
}

describe('write_file tool — uiContent diff', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  it('new file → uiContent is an all-additions diff', async () => {
    const file = join(TEST_DIR, 'fresh.txt')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'one\ntwo\nthree\n',
    }))
    assert.ok(!result.isError)
    assert.ok(result.content.startsWith('已写入 '))
    assert.ok(!result.content.includes('@@'), 'diff must not leak into model content')
    assert.ok(result.uiContent && /^@@/m.test(result.uiContent), 'uiContent has hunk header')
    assert.ok(/^\+one$/m.test(result.uiContent!))
    const removals = result.uiContent!.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'))
    assert.equal(removals.length, 0, 'no removal content lines for a new file')
  })

  it('overwrite → uiContent shows removals and additions', async () => {
    const file = join(TEST_DIR, 'over.txt')
    writeFileSync(file, 'keep\nold line\ntail\n')
    markObserved(file)
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'keep\nnew line\ntail\n',
    }))
    assert.ok(!result.isError)
    assert.ok(result.uiContent && /^@@/m.test(result.uiContent), 'uiContent has diff')
    assert.ok(/^-old line$/m.test(result.uiContent!), 'removal line')
    assert.ok(/^\+new line$/m.test(result.uiContent!), 'addition line')
  })

  it('overwrite → changedRanges localizes the changed line (for LSP narrowing)', async () => {
    const file = join(TEST_DIR, 'ranges.txt')
    writeFileSync(file, 'keep\nold line\ntail\n')
    markObserved(file)
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'keep\nnew line\ntail\n',
    }))
    assert.ok(!result.isError)
    assert.ok(Array.isArray(result.changedRanges) && result.changedRanges.length === 1, 'one changed range')
    assert.deepEqual(result.changedRanges![0], { start: 2, end: 2 }, 'line 2 changed')
  })

  it('new file → changedRanges covers the whole file', async () => {
    const file = join(TEST_DIR, 'brand-new.txt')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'a\nb\nc\n',
    }))
    assert.ok(!result.isError)
    assert.ok(Array.isArray(result.changedRanges) && result.changedRanges.length === 1)
    assert.equal(result.changedRanges![0]!.start, 1)
    assert.ok(result.changedRanges![0]!.end >= 3)
  })

  it('rewriting identical content yields no diff (uiContent undefined)', async () => {
    const file = join(TEST_DIR, 'same.txt')
    writeFileSync(file, 'unchanged\n')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'unchanged\n',
    }))
    assert.ok(!result.isError)
    assert.equal(result.uiContent, undefined)
  })

  it('rejects pointer-placeholder content regurgitated from history', async () => {
    const file = join(TEST_DIR, 'regurgitated.ts')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: `[file written to ${file} — 202 lines, 6462 chars. Use read_file to review.]`,
    }))
    assert.ok(result.isError, 'pointer placeholder must be rejected')
    assert.ok(result.content.includes('pointer placeholder'), 'error explains what went wrong')
    assert.ok(!existsSync(file), 'no file must be created from placeholder content')
  })

  it('rejects pointer-placeholder content with leading whitespace', async () => {
    const file = join(TEST_DIR, 'regurgitated2.ts')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: `\n  [file written to ${file} — 10 lines, 100 chars. Use read_file to review.]`,
    }))
    assert.ok(result.isError)
    assert.ok(!existsSync(file))
  })

  it('allows real content that merely mentions the pointer prefix mid-text', async () => {
    const file = join(TEST_DIR, 'mentions-pointer.md')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'Docs: the history shows "[file written to ..." pointers for large writes.\n',
    }))
    assert.ok(!result.isError, 'mid-text mention must not be rejected')
    assert.ok(existsSync(file))
  })

  it('overwriting an oversized existing file skips the diff base (no misleading diff)', async () => {
    const file = join(TEST_DIR, 'huge.txt')
    // 11 MB — above MAX_WRITE_FILE_BYTES, so the old content is intentionally
    // not read and the card should fall back to the summary text.
    writeFileSync(file, 'x'.repeat(11 * 1024 * 1024))
    markObserved(file)
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'small replacement',
    }))
    assert.ok(!result.isError)
    assert.ok(result.content.startsWith('已写入 '))
    assert.equal(result.uiContent, undefined, 'uiContent should be undefined when old content is not loaded')
    assert.deepEqual(result.changedRanges, [], 'changedRanges should be empty when old content is unknown')
  })
})

describe('write_file tool — blind-overwrite guard', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  it('refuses to overwrite an existing file never observed this session', async () => {
    const file = join(TEST_DIR, 'precious.test.ts')
    writeFileSync(file, 'original 221-line test suite\n')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'blind replacement\n',
    }))
    assert.ok(result.isError, 'blind overwrite must be refused')
    assert.ok(result.content.includes('本会话从未读取过'), 'error explains the guard')
    assert.equal(readFileSync(file, 'utf-8'), 'original 221-line test suite\n', 'file untouched')
  })

  it('allows overwrite once the file has been observed', async () => {
    const file = join(TEST_DIR, 'observed.txt')
    writeFileSync(file, 'old\n')
    markObserved(file)
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'new\n',
    }))
    assert.ok(!result.isError)
    assert.equal(readFileSync(file, 'utf-8'), 'new\n')
  })

  it('byte-identical rewrite of an unobserved file is exempt (no information loss)', async () => {
    const file = join(TEST_DIR, 'identical.txt')
    writeFileSync(file, 'same content\n')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'same content\n',
    }))
    assert.ok(!result.isError, 'identical content cannot destroy anything')
  })

  it('new files are never guarded', async () => {
    const file = join(TEST_DIR, 'brand-new-guarded.txt')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'hello\n',
    }))
    assert.ok(!result.isError)
  })

  it('RIVET_WRITE_OVERWRITE_GUARD=0 disables the guard', async () => {
    const file = join(TEST_DIR, 'unguarded.txt')
    writeFileSync(file, 'old\n')
    process.env.RIVET_WRITE_OVERWRITE_GUARD = '0'
    try {
      const result = await WRITE_FILE_TOOL.execute(makeParams({
        file_path: file,
        content: 'new\n',
      }))
      assert.ok(!result.isError)
    } finally {
      delete process.env.RIVET_WRITE_OVERWRITE_GUARD
    }
  })

  it('exempts the active plan-mode draft from the blind-overwrite guard', async () => {
    // Plan-mode drafts are created empty by the system; writing the first
    // content should not require a pointless read_file of the empty file.
    const relDraft = '.rivet/plans/draft-1234567890123.md'
    const file = join(TEST_DIR, relDraft)
    mkdirSync(join(TEST_DIR, '.rivet', 'plans'), { recursive: true })
    writeFileSync(file, '')
    const result = await WRITE_FILE_TOOL.execute({
      ...makeParams({
        file_path: file,
        content: '# Plan\n\nFirst draft content.\n',
      }),
      activePlanFilePath: relDraft,
    })
    assert.ok(!result.isError, `plan draft write must not be blocked: ${result.content}`)
    assert.equal(readFileSync(file, 'utf-8'), '# Plan\n\nFirst draft content.\n')
  })

  it('rolls back overwrite that introduces a fatal Python syntax error', async () => {
    const file = join(TEST_DIR, 'valid.py')
    const original = 'def foo():\n    return 1\n'
    writeFileSync(file, original)
    markObserved(file)
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      // 未闭合括号:tree-sitter 检出（缩进错误则被 tree-sitter 宽松放过,见 syntax-check 测试）
      content: 'def foo():\n    return (1\n',
    }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Python 语法错误'), `Expected syntax error, got: ${result.content}`)
    assert.ok(result.content.includes('已自动回滚'), `Expected rollback note, got: ${result.content}`)
    assert.equal(readFileSync(file, 'utf-8'), original, 'File should be rolled back to original content')
  })

  it('removes a newly written file with a fatal syntax error (no backup to restore)', async () => {
    // 2026-08-10 galaxy worker 事故：trackFileChange 只备份已存在文件，新文件
    // 无备份 → restoreLatestBackup 必然失败，坏文件曾带「自动回滚失败」留盘。
    const file = join(TEST_DIR, 'brand-new.py')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'def foo():\n    return (1\n',
    }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('新文件已自动移除'), `Expected removal note, got: ${result.content}`)
    assert.ok(!existsSync(file), 'broken new file must be removed from disk')
  })
})

describe('write_file tool — rewrite-loop hint (A-type placeholder loop)', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  it('second write to the same path appends a rewrite-loop hint', async () => {
    const file = join(TEST_DIR, 'loop.txt')
    const r1 = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'version one\n',
    }))
    assert.ok(!r1.isError)
    assert.ok(!r1.content.includes('疑似重写循环'), 'first write must not hint')

    // Second write overwrites with different content; observe first so the
    // blind-overwrite guard lets it through (mirrors a real rewrite loop).
    markObserved(file)
    const r2 = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'version two\n',
    }))
    assert.ok(!r2.isError)
    assert.ok(r2.content.includes('疑似重写循环'), `second write must hint, got: ${r2.content}`)
    assert.ok(r2.content.includes('read_file'), 'hint points at read_file instead of rewriting')
  })

  it('hint is session-scoped — a fresh session writing once has no hint', async () => {
    const file = join(TEST_DIR, 'cross-session.txt')
    const sessionA = 'sess-a'
    const sessionB = 'sess-b'

    const rA1 = await WRITE_FILE_TOOL.execute({
      ...makeParams({ file_path: file, content: 'a1\n' }),
      sessionId: sessionA,
    })
    assert.ok(!rA1.isError)
    markObserved(file)
    const rA2 = await WRITE_FILE_TOOL.execute({
      ...makeParams({ file_path: file, content: 'a2\n' }),
      sessionId: sessionA,
    })
    assert.ok(rA2.content.includes('疑似重写循环'), 'second write in the same session hints')

    // Fresh session, first write to the same path: must NOT hint. Content is
    // byte-identical to disk so the blind-overwrite guard (which keys on the
    // same sessionId) does not intercept — this test targets the hint, not
    // the guard.
    const rB1 = await WRITE_FILE_TOOL.execute({
      ...makeParams({ file_path: file, content: 'a2\n' }),
      sessionId: sessionB,
    })
    assert.ok(!rB1.isError)
    assert.ok(!rB1.content.includes('疑似重写循环'), `fresh session first write must not hint, got: ${rB1.content}`)
  })

  it('byte-identical rewrite flags same content explicitly', async () => {
    const file = join(TEST_DIR, 'same-content.txt')
    const content = 'identical payload\n'
    const r1 = await WRITE_FILE_TOOL.execute(makeParams({ file_path: file, content }))
    assert.ok(!r1.isError)
    markObserved(file)
    const r2 = await WRITE_FILE_TOOL.execute(makeParams({ file_path: file, content }))
    assert.ok(r2.content.includes('疑似重写循环'), 'second write hints')
    assert.ok(r2.content.includes('内容与上次相同'),
      `identical-content rewrite must be flagged, got: ${r2.content}`)
  })

  it('content-changing iterations do not re-hint after the first warning', async () => {
    const file = join(TEST_DIR, 'iterate.txt')
    const r1 = await WRITE_FILE_TOOL.execute(makeParams({ file_path: file, content: 'v1\n' }))
    assert.ok(!r1.content.includes('疑似重写循环'), 'first write must not hint')
    markObserved(file)
    const r2 = await WRITE_FILE_TOOL.execute(makeParams({ file_path: file, content: 'v2\n' }))
    assert.ok(r2.content.includes('疑似重写循环'), 'first content change warns')
    markObserved(file)
    const r3 = await WRITE_FILE_TOOL.execute(makeParams({ file_path: file, content: 'v3\n' }))
    assert.ok(!r3.content.includes('疑似重写循环'),
      'subsequent content-changing iterations must not re-hint (B1 lesson: repeated reminders are noise)')
  })
})

describe('write_file tool — append mode (chunked writes)', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  it('append creates a missing file, then concatenates without adding a newline', async () => {
    const file = join(TEST_DIR, 'chunks.sql')
    const r1 = await WRITE_FILE_TOOL.execute(makeParams({ file_path: file, content: 'first\n', mode: 'append' }))
    assert.ok(!r1.isError, `append create: ${r1.content}`)
    assert.ok(r1.content.includes('已追加'), `append receipt: ${r1.content}`)

    const r2 = await WRITE_FILE_TOOL.execute(makeParams({ file_path: file, content: 'second\n', mode: 'append' }))
    assert.ok(!r2.isError)
    assert.equal(readFileSync(file, 'utf-8'), 'first\nsecond\n')
  })

  it('append bypasses the blind-overwrite guard (no information destroyed)', async () => {
    const file = join(TEST_DIR, 'unobserved.txt')
    writeFileSync(file, 'existing\n')
    // Never read this session — overwrite would be blocked, append must pass.
    const result = await WRITE_FILE_TOOL.execute(makeParams({ file_path: file, content: 'more\n', mode: 'append' }))
    assert.ok(!result.isError, `append must not hit the blind-overwrite guard: ${result.content}`)
    assert.equal(readFileSync(file, 'utf-8'), 'existing\nmore\n')
  })

  it('append skips the fatal syntax check — mid-chunk files are intentionally incomplete', async () => {
    const file = join(TEST_DIR, 'partial.py')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'def foo():\n    return (1\n',
      mode: 'append',
    }))
    assert.ok(!result.isError, `mid-chunk append must not fail: ${result.content}`)
    assert.ok(existsSync(file), 'mid-chunk file must not be rolled back/removed')
  })

  it('repeated appends to one path do not trip the rewrite-loop hint', async () => {
    const file = join(TEST_DIR, 'multi-chunk.txt')
    for (const chunk of ['c1\n', 'c2\n', 'c3\n']) {
      const r = await WRITE_FILE_TOOL.execute(makeParams({ file_path: file, content: chunk, mode: 'append' }))
      assert.ok(!r.isError)
      assert.ok(!r.content.includes('疑似重写循环'), `chunked append must not hint: ${r.content}`)
    }
    assert.equal(readFileSync(file, 'utf-8'), 'c1\nc2\nc3\n')
  })

  it('rejects an invalid mode', async () => {
    const file = join(TEST_DIR, 'bad-mode.txt')
    const result = await WRITE_FILE_TOOL.execute(makeParams({ file_path: file, content: 'x\n', mode: 'upsert' }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('mode'), `should explain valid modes: ${result.content}`)
  })
})
