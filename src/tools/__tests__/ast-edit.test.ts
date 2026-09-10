import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cpuPool } from '../../workers/cpu-pool.js'
import type { Tool, ToolCallParams } from '../types.js'

let astEdit: Tool

const testDir = join(process.cwd(), '.test-tmp', `ast-edit-${randomBytes(4).toString('hex')}`)

const tsFixture = `
var count = 0
var total = 100
var name = "test"

function inc() {
  count = count + 1
}
`.trim()

async function setupFixtures(): Promise<void> {
  await rm(testDir, { recursive: true, force: true })
  await mkdir(testDir, { recursive: true })
  await writeFile(join(testDir, 'sample.ts'), tsFixture)
  await writeFile(join(testDir, 'write-test.ts'), tsFixture)
  await writeFile(join(testDir, 'broken.ts'), 'var x = {')
  await writeFile(join(testDir, 'other.ts'), 'var a = 1\nvar b = 2')
}

before(async () => {
  await setupFixtures()
  const mod = await import('../ast-edit.js')
  astEdit = mod.AST_EDIT_TOOL
})

async function call(params: Record<string, unknown>): Promise<string> {
  const result = await astEdit.execute({
    input: params,
    cwd: testDir,
    toolUseId: 'test-edit',
    abortSignal: new AbortController().signal,
    onOutput: undefined,
  } as unknown as ToolCallParams)
  if (result.isError) throw new Error(result.content)
  return result.content
}

// ── dryRun (default true) ─────────────────────────────────────────

describe('ast-edit dryRun mode', () => {
  it('reports changes without writing to file by default', async () => {
    const out = await call({
      ops: [{ find: 'var $NAME = $VAL', replace: 'const $NAME = $VAL' }],
      paths: ['sample.ts'],
      lang: 'TypeScript',
    })
    // Should show preview of changes
    assert.ok(out.includes('var') || out.includes('const'), `expected change preview, got: ${out}`)

    // File should NOT be modified
    const content = await readFile(join(testDir, 'sample.ts'), 'utf-8')
    assert.ok(content.includes('var count'), 'file should still contain var declarations')
  })

  it('writes changes when dryRun is false', async () => {
    const out = await call({
      ops: [{ find: 'var $NAME = $VAL', replace: 'const $NAME = $VAL' }],
      paths: ['write-test.ts'],
      lang: 'TypeScript',
      dryRun: false,
    })
    assert.ok(out.includes('const'), `expected applied changes, got: ${out}`)

    const content = await readFile(join(testDir, 'write-test.ts'), 'utf-8')
    assert.ok(!content.includes('var count'), 'file should have const declarations')
    assert.ok(content.includes('const count'), 'file should have const declarations')
  })
})

// ── basic replace ─────────────────────────────────────────────────

describe('ast-edit pattern replace', () => {
  it('replaces matched nodes with template', async () => {
    const out = await call({
      ops: [{ find: 'var $NAME = $VAL', replace: 'let $NAME = $VAL' }],
      paths: ['sample.ts'],
      lang: 'TypeScript',
      dryRun: true,
    })
    assert.ok(out.includes('let'), `expected let replacement, got: ${out}`)
  })

  it('returns empty when pattern has no matches', async () => {
    const out = await call({
      ops: [{ find: 'class $NAME { $$$ }', replace: 'interface $NAME { $$$ }' }],
      paths: ['sample.ts'],
      lang: 'TypeScript',
      dryRun: true,
    })
    assert.ok(out.includes('0 处更改') || out.includes('0 个文件') || out.includes('无改动'),
      `expected no-change message, got: ${out}`)
  })

  it('applies multiple ops sequentially on same file', async () => {
    const out = await call({
      ops: [
        { find: 'var $NAME = $VAL', replace: 'const $NAME = $VAL' },
        { find: 'function inc() { $$$BODY }', replace: 'function increment() { $$$BODY }' },
      ],
      paths: ['sample.ts'],
      lang: 'TypeScript',
      dryRun: true,
    })
    assert.ok(out.includes('increment'), `expected function rename, got: ${out}`)
  })
})

// ── error handling ────────────────────────────────────────────────

describe('ast-edit error handling', () => {
  it('rejects empty ops array', async () => {
    try {
      await call({ ops: [], paths: ['sample.ts'] })
      assert.fail('should have thrown')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      assert.ok(msg.includes('find/replace') || msg.includes('op'),
        `expected ops error, got: ${msg}`)
    }
  })

  it('skips files with parse errors and warns', async () => {
    const out = await call({
      ops: [{ find: 'var $X = $Y', replace: 'const $X = $Y' }],
      paths: ['broken.ts'],
      lang: 'TypeScript',
      dryRun: true,
    })
    assert.ok(out.includes('错误') || out.includes('解析'), `expected parse warning, got: ${out}`)
  })
})

// ── multi-file ────────────────────────────────────────────────────

describe('ast-edit multi-file', () => {
  it('processes multiple files', async () => {
    const out = await call({
      ops: [{ find: 'var $NAME = $VAL', replace: 'const $NAME = $VAL' }],
      paths: ['sample.ts', 'other.ts'],
      lang: 'TypeScript',
      dryRun: true,
    })
    // Should mention both files or have multiple changes
    assert.ok(
      out.includes('sample.ts') || out.includes('other.ts') || out.includes('2 个文件'),
      `expected multi-file output, got: ${out}`,
    )
  })
})

// ── onFileWrite callback ──────────────────────────────────────────

describe('ast-edit onFileWrite', () => {
  it('calls onFileWrite with file path when dryRun is false', async () => {
    // fresh file to avoid pollution from prior dryRun:false test
    const fixtureFile = join(testDir, 'onfilewrite-test.ts')
    await writeFile(fixtureFile, 'var x = 1\nvar y = 2')

    const written: string[] = []
    const result = await astEdit.execute({
      input: {
        ops: [{ find: 'var $NAME = $VAL', replace: 'const $NAME = $VAL' }],
        paths: ['onfilewrite-test.ts'],
        lang: 'TypeScript',
        dryRun: false,
      },
      cwd: testDir,
      toolUseId: 'test-onfilewrite',
      abortSignal: new AbortController().signal,
      onOutput: undefined,
      onFileWrite: (path: string) => written.push(path),
    } as unknown as ToolCallParams)
    assert.ok(!result.isError, `unexpected error: ${result.content}`)
    assert.ok(written.length >= 1, `expected at least 1 onFileWrite call, got ${written.length}`)
    assert.ok(written.some(p => p.includes('onfilewrite-test.ts')), `expected onfilewrite-test.ts in ${written.join(', ')}`)
  })

  it('does NOT call onFileWrite when dryRun is true', async () => {
    const written: string[] = []
    await astEdit.execute({
      input: {
        ops: [{ find: 'var $NAME = $VAL', replace: 'const $NAME = $VAL' }],
        paths: ['sample.ts'],
        lang: 'TypeScript',
        dryRun: true,
      },
      cwd: testDir,
      toolUseId: 'test-onfilewrite-dry',
      abortSignal: new AbortController().signal,
      onOutput: undefined,
      onFileWrite: (path: string) => written.push(path),
    } as unknown as ToolCallParams)
    assert.equal(written.length, 0, `expected 0 onFileWrite calls in dryRun mode, got ${written.length}`)
  })

  // ── post-edit syntax gate (#2) ────────────────────────────────────
  // A replacement whose template itself introduces invalid syntax (unbalanced
  // braces) must be caught by the post-edit ERROR-node check and the file must
  // NOT be written. Without the gate, a broken file would persist silently.

  it('does NOT write a file when the replace introduces a syntax error', async () => {
    const target = join(testDir, 'syntax-gate-test.ts')
    await writeFile(target, 'var x = 1\nvar y = 2\n')
    const before = await readFile(target, 'utf-8')
    const result = await astEdit.execute({
      input: {
        // replace with an unbalanced brace — valid ast-grep template, invalid TS
        ops: [{ find: 'var $NAME = $VAL', replace: 'var $NAME = {{{' }],
        paths: ['syntax-gate-test.ts'],
        lang: 'TypeScript',
        dryRun: false,
      },
      cwd: testDir,
      toolUseId: 'test-syntax-gate',
      abortSignal: new AbortController().signal,
      onOutput: undefined,
    } as unknown as ToolCallParams)
    const after = await readFile(target, 'utf-8')
    assert.equal(after, before, 'file must be unchanged when post-edit syntax check fails')
    assert.ok(result.content.includes('未写入') || result.content.includes('语法错误'),
      `expected post-edit syntax gate error in output, got: ${result.content}`)
  })

  // ── multi-line dryRun diff (#6) ───────────────────────────────────

  it('dryRun preview shows multi-line before/after as separate blocks, not collapsed \\n', async () => {
    // A function-body match spans multiple lines. The preview must show the
    // actual line shape (not collapse to \n) so the model can judge the change.
    const target = join(testDir, 'multiline-preview.ts')
    await writeFile(target, 'function inc() {\n  count = count + 1\n}\n')
    const out = await call({
      ops: [{ find: 'function $NAME($$$A) { $$$B }', replace: 'async function $NAME($$$A) { $$$B }' }],
      paths: ['multiline-preview.ts'],
      lang: 'TypeScript',
      dryRun: true,
    })
    // Multi-line aware: before/after on separate lines with - / + markers,
    // not a single line with literal \n.
    assert.ok(out.includes('async function'), `expected the replacement in preview, got: ${out}`)
    assert.ok(!out.includes('\\n'), `multi-line change should not be collapsed to literal \\n: ${out}`)
  })
})

// ── 工作区边界与敏感文件门（安全修复：ast_edit 曾完全绕过 validatePath）──────

describe('ast_edit path validation', () => {
  async function callRaw(params: Record<string, unknown>) {
    return astEdit.execute({
      input: params,
      cwd: testDir,
      toolUseId: 'test-edit',
      abortSignal: new AbortController().signal,
      onOutput: undefined,
    } as unknown as ToolCallParams)
  }

  it('rejects a path outside the workspace (escape via ..)', async () => {
    const result = await callRaw({
      ops: [{ find: 'var $A = $B', replace: 'var $A = $B' }],
      paths: ['../escape-target.ts'],
      dryRun: true,
    })
    assert.ok(result.isError, `expected workspace-boundary rejection, got: ${result.content}`)
    assert.match(result.content, /工作区|workspace|权限|boundary|outside/i)
  })

  it('rejects an absolute path outside the workspace', async () => {
    const result = await callRaw({
      ops: [{ find: 'var $A = $B', replace: 'var $A = $B' }],
      paths: [join(testDir, '..', 'abs-escape.ts')],
      dryRun: true,
    })
    assert.ok(result.isError, `expected rejection, got: ${result.content}`)
  })

  it('rejects a sensitive file (.env) even inside the workspace', async () => {
    await writeFile(join(testDir, '.env'), 'KEY=value\n')
    try {
      const result = await callRaw({
        ops: [{ find: 'var $A = $B', replace: 'var $A = $B' }],
        paths: ['.env'],
        dryRun: true,
      })
      assert.ok(result.isError, `expected sensitive-file rejection, got: ${result.content}`)
      assert.match(result.content, /敏感|sensitive/i)
    } finally {
      await rm(join(testDir, '.env'), { force: true })
    }
  })

  it('still allows an in-workspace file after validation wiring', async () => {
    const out = await call({
      ops: [{ find: 'var a = 1', replace: 'var a = 2' }],
      paths: ['other.ts'],
      lang: 'TypeScript',
      dryRun: true,
    })
    assert.ok(out.length > 0)
  })
})

// ── Wave 5：解析隔离（worker 通道）────────────────────────────────────
// ast_edit 的 native AST 操作（parse / findAll / commitEdits / 最终语法检查）
// 搬进 worker 线程；**写文件仍在主线程**——审批、备份、写后语法复检与回滚
// 保持单一入口。不可用/超时一律报错降级，不回退主线程解析（回退等于把
// 2026-09-10 的冻结风险请回来）。

/** 子进程跑一次 ast_edit：cpu-pool 的 DISABLED 是模块加载时常量，同进程内改
 *  env 无效，只能在子进程里设。dryRun 默认 true——不写文件。 */
const RUN_AST_EDIT = `
import { AST_EDIT_TOOL } from './src/tools/ast-edit.ts'
const r = await AST_EDIT_TOOL.execute({
  input: { ops: [{ find: 'var $NAME = $VAL', replace: 'const $NAME = $VAL' }], paths: ['src/tools/ast-edit.ts'], lang: 'TypeScript' },
  cwd: process.cwd(),
  toolUseId: 'probe',
  abortSignal: new AbortController().signal,
})
console.log('IS_ERROR=' + String(r.isError) + '|' + r.content.slice(0, 200).replace(/\\n/g, ' '))
`

function runAstEditInChild(env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', RUN_AST_EDIT], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const fail = (e: Error): void => {
      try { child.kill() } catch { /* already gone */ }
      reject(e)
    }
    child.stdout.on('data', (c: Buffer) => { out += String(c) })
    child.stderr.on('data', (c: Buffer) => { err += String(c) })
    child.on('error', fail)
    child.on('close', (code) => {
      if (code !== 0) fail(new Error(`child exited ${code}: ${err.slice(0, 300)}`))
      else resolve(out)
    })
  })
}

describe('ast-edit 解析隔离（Wave 5：worker 通道）', () => {
  it('RIVET_CPU_POOL=0：报「AST 解析不可用」且不回退主线程解析', async () => {
    const out = await Promise.race([
      runAstEditInChild({ RIVET_CPU_POOL: '0' }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('子进程未退出')), 30_000)),
    ])
    assert.ok(out.includes('IS_ERROR=true'), `应为错误结果：${out}`)
    assert.ok(out.includes('AST 解析不可用'), `应报解析不可用降级文案：${out}`)
    assert.ok(out.includes('grep'), `应提示改用 grep：${out}`)
  })

  it('worker 可用时走 worker 通道并正常返回更改', async () => {
    const out = await Promise.race([
      runAstEditInChild({ RIVET_CPU_POOL_IDLE_MS: '100' }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('子进程未退出')), 30_000)),
    ])
    assert.ok(out.includes('IS_ERROR=undefined'), `应成功返回：${out}`)
    assert.ok(out.includes('处更改'), `应返回更改摘要：${out}`)
  })

  it('pool 不可用时：在窗口内返回降级文案，不挂起', async () => {
    // 确定性触发（同 ast-grep.test.ts）：dispose 让 pool 永久不可用 → 走降级分支。
    cpuPool.dispose()
    try {
      const t0 = Date.now()
      const result = await astEdit.execute({
        input: { ops: [{ find: 'var $NAME = $VAL', replace: 'const $NAME = $VAL' }], paths: ['sample.ts'], lang: 'TypeScript' },
        cwd: testDir,
        toolUseId: 'test-edit-timeout',
        abortSignal: new AbortController().signal,
        onOutput: undefined,
      } as unknown as ToolCallParams)
      const elapsed = Date.now() - t0
      assert.equal(result.isError, true, `应降级为错误，实际：${result.content}`)
      assert.ok(result.content.includes('AST 解析不可用'), `应报降级文案：${result.content}`)
      assert.ok(elapsed < 10_000, `应在超时窗口内返回，实际 ${elapsed}ms`)
    } finally {
      delete process.env.RIVET_AST_SCAN_TIMEOUT_MS
    }
  })
})
