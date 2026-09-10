import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cpuPool } from '../../workers/cpu-pool.js'

// We import the tool creator after TypeScript compilation, but for
// node:test with tsx we import directly from the .ts source.
import type { Tool, ToolCallParams } from '../types.js'

// Will be set when ast-grep.ts is created
let astGrep: Tool

// Use a project-relative temp dir (sandbox blocks /tmp outside workspace)
const testDir = join(process.cwd(), '.test-tmp', `ast-grep-${randomBytes(4).toString('hex')}`)
// 2026-09-10 卡死事故夹具目录：只放大文件，与常规夹具隔离。
const bigDir = join(process.cwd(), '.test-tmp', `ast-big-${randomBytes(4).toString('hex')}`)

const tsFixture = `
function foo(a: number) {
  return a + 1
}

const bar = (x: string) => x.toUpperCase()

function baz(b: string, c: number) {
  console.log(b, c)
}

class MyClass {
  greet() {
    return "hello"
  }
}

function multiStmt(d: number) {
  const x = d * 2
  const y = x + 1
  if (y > 10) {
    return y
  }
  return x
}
`.trim()

const jsFixture = `
function multiply(a, b) {
  return a * b
}
const result = multiply(3, 4)
`.trim()

async function setupFixtures(): Promise<void> {
  await rm(testDir, { recursive: true, force: true })
  await mkdir(testDir, { recursive: true })
  await writeFile(join(testDir, 'sample.ts'), tsFixture)
  await writeFile(join(testDir, 'sample.js'), jsFixture)
  // 2026-09-10 ERROR 门降级：夹具从「整文件损坏」改为「含合法部分 + 一处语法错误」，
  // 因为新行为是「警告 + 继续匹配」而非「整文件跳过」。
  await writeFile(join(testDir, 'broken.ts'), 'function validInBroken(a: number) {\n  return a + 1\n}\n\nfunction broken( {\n')
  await writeFile(join(testDir, 'sample.rs'), 'fn main() { println!("hello"); }')

  // 2026-09-10 ast-grep 卡死事故夹具：大二进制 + 超大文本，二者都不得被解析。
  // 事故现场：调用方传 path（单数）被静默忽略 → paths 退化为 ['.'] → 全仓扫描
  // → release/ 里 248MB 的 AppImage 被当 TypeScript 解析 → tree-sitter 爆炸，
  // 同步阻塞事件循环 4 小时（实测 6MB 二进制单次解析就要 9 秒）。
  await rm(bigDir, { recursive: true, force: true })
  await mkdir(bigDir, { recursive: true })
  await writeFile(join(bigDir, 'big-binary.bin'), randomBytes(2 * 1024 * 1024))
  await writeFile(join(bigDir, 'huge.ts'), '// ' + 'x'.repeat(2 * 1024 * 1024))
}

before(async () => {
  await setupFixtures()
  // Dynamic import after test file is written — will fail until ast-grep.ts exists
  const mod = await import('../ast-grep.js')
  astGrep = mod.AST_GREP_TOOL
})

async function call(params: Record<string, unknown>): Promise<string> {
  const result = await astGrep.execute({
    input: params,
    cwd: testDir,
    toolUseId: 'test-1',
    abortSignal: new AbortController().signal,
    onOutput: undefined,
  } as unknown as ToolCallParams)
  if (result.isError) throw new Error(result.content)
  return result.content
}

// ── pattern matching ──────────────────────────────────────────────

describe('ast-grep pattern matching', () => {
  it('finds function declarations by pattern', async () => {
    const out = await call({
      pattern: 'function $NAME($$$ARGS) { $$$BODY }',
      paths: ['sample.ts'],
      lang: 'TypeScript',
    })
    assert.ok(out.includes('foo'), 'should find function foo')
    assert.ok(out.includes('baz'), 'should find function baz')
  })

  it('returns empty when no nodes match', async () => {
    const out = await call({
      pattern: 'class $NAME extends $SUPER { $$$ }',
      paths: ['sample.ts'],
      lang: 'TypeScript',
    })
    assert.ok(out.includes('0 处匹配'), out)
  })

  it('supports rule-based matching', async () => {
    const out = await call({
      pattern: JSON.stringify({ rule: { kind: 'function_declaration' } }),
      paths: ['sample.ts'],
      lang: 'TypeScript',
    })
    assert.ok(out.includes('foo') || out.includes('baz'), 'should find at least one function')
  })
})

// ── language inference ────────────────────────────────────────────

describe('ast-grep language handling', () => {
  it('infers TypeScript from .ts extension', async () => {
    const out = await call({
      pattern: 'const $NAME = $$$',
      paths: ['sample.ts'],
    })
    assert.ok(out.includes('bar'), 'should find const bar')
  })

  it('infers JavaScript from .js extension', async () => {
    const out = await call({
      pattern: 'function $NAME($$$) { $$$ }',
      paths: ['sample.js'],
    })
    assert.ok(out.includes('multiply'), 'should find multiply function')
  })

  it('reports error for unsupported extension', async () => {
    const result = await astGrep.execute({
      input: { pattern: 'fn $NAME()', paths: ['sample.rs'] },
      cwd: testDir,
      toolUseId: 'test-unsupported',
      abortSignal: new AbortController().signal,
      onOutput: undefined,
    } as unknown as ToolCallParams)
    assert.ok(result.content.includes('不支持的语言') || result.content.includes('错误'),
      `expected unsupported language error, got: ${result.content}`)
  })
})

// ── error handling ────────────────────────────────────────────────

describe('ast-grep error handling', () => {
  it('含语法错误的文件仍能匹配到合法部分并报解析降级', async () => {
    const out = await call({
      pattern: 'function $NAME($$$ARGS) { $$$BODY }',
      paths: ['broken.ts'],
      lang: 'TypeScript',
    })
    assert.ok(out.includes('validInBroken'), `应匹配到合法函数 validInBroken：${out}`)
    assert.ok(out.includes('解析降级'), `应报解析降级提示：${out}`)
  })

  it('rejects empty pattern', async () => {
    try {
      await call({
        pattern: '   ',
        paths: ['sample.ts'],
      })
      assert.fail('should have thrown')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      assert.ok(msg.includes('pattern'), `expected pattern error, got: ${msg}`)
    }
  })

  it('rejects regex tokens in bare pattern string', async () => {
    const result = await astGrep.execute({
      input: { pattern: 'function \\d+', paths: ['sample.ts'], lang: 'TypeScript' },
      cwd: testDir,
      toolUseId: 'test-regex',
      abortSignal: new AbortController().signal,
      onOutput: undefined,
    } as unknown as ToolCallParams)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('正则 token'), `expected regex misuse error, got: ${result.content}`)
  })

  it('allows regex-like strings inside JSON rule objects', async () => {
    const result = await astGrep.execute({
      input: {
        pattern: JSON.stringify({ rule: { kind: 'function_declaration', regex: '^foo' } }),
        paths: ['sample.ts'],
        lang: 'TypeScript',
      },
      cwd: testDir,
      toolUseId: 'test-rule-object',
      abortSignal: new AbortController().signal,
      onOutput: undefined,
    } as unknown as ToolCallParams)
    assert.equal(result.isError, undefined)
  })
})

// ── meta-variables ────────────────────────────────────────────────

describe('ast-grep meta-variables', () => {
  it('captures named meta-variables when includeMeta is true', async () => {
    const out = await call({
      pattern: 'function $NAME($$$ARGS) { $$$BODY }',
      paths: ['sample.ts'],
      lang: 'TypeScript',
      includeMeta: true,
    })
    assert.ok(out.includes('NAME=foo') || out.includes('NAME=baz'),
      `expected meta-variable NAME in output, got: ${out}`)
  })

  it('multi-node meta-var shows shape summary (nodes/lines/first-line), not raw blob', async () => {
    // multiStmt has a 5-line body across multiple statements — $$$BODY captures
    // all of them. The summary must report the shape, not dump joined text.
    const out = await call({
      pattern: 'function $NAME($$$ARGS) { $$$BODY }',
      paths: ['sample.ts'],
      lang: 'TypeScript',
      includeMeta: true,
    })
    // Find the multiStmt match line
    const multiLine = out.split('\n').find(l => l.includes('multiStmt'))
    assert.ok(multiLine, `expected multiStmt in output: ${out}`)
    // Shape summary format: BODY=<nodeCount>n/<lineCount>L: <first line preview>
    // Must NOT be a raw joined code blob (no commas joining statements).
    const bodyMatch = multiLine!.match(/BODY=(\d+)n\/(\d+)L:\s*(.*)/)
    assert.ok(bodyMatch, `BODY should be a shape summary like "3n/5L: ...", got: ${multiLine}`)
    const [, nodeStr, lineStr, preview] = bodyMatch!
    assert.ok(parseInt(nodeStr!) >= 1, `node count should be >= 1, got ${nodeStr}`)
    assert.ok(parseInt(lineStr!) >= 4, `multiStmt body should span 4+ lines, got ${lineStr}`)
    assert.ok(preview!.length > 0 && preview!.length <= 50, `preview should be a short first-line, got "${preview}"`)
    // The preview should be the first statement, not a comma-joined blob
    assert.ok(!preview!.includes(', '), `preview should not be comma-joined statements, got "${preview}"`)
  })

  it('single-node meta-var stays as raw text (no shape summary)', async () => {
    // $NAME is a single-node capture — it should stay as the identifier text,
    // not get a "1n/1L:" prefix. Only $$$ multi-node vars get shape summaries.
    const out = await call({
      pattern: 'function $NAME($$$ARGS) { $$$BODY }',
      paths: ['sample.ts'],
      lang: 'TypeScript',
      includeMeta: true,
    })
    // NAME=foo (raw identifier), NOT NAME=1n/1L: foo
    // Match NAME= followed by its value up to the next comma/space — must NOT
    // start with the "<digits>n/" shape-summary prefix.
    const nameMatch = out.match(/NAME=([^,\]]+)/)
    assert.ok(nameMatch, `expected NAME= in output: ${out}`)
    const nameVal = nameMatch![1]!
    assert.ok(!/^\d+n\//.test(nameVal), `single-node NAME should not have shape summary, got "NAME=${nameVal}"`)
    assert.equal(nameVal, 'foo', `NAME should be raw identifier "foo", got "${nameVal}"`)
  })
})

// ── 2026-09-10 卡死事故：文件准入护栏 ────────────────────────────────
// 事故现场（会话 886df48f，TUI 进程被 SIGKILL 前 88% CPU / 5.8GB 内存）：
// 调用方传 path（单数，schema 只认 paths）被静默忽略 → paths 退化为 ['.']
// → 全仓扫描 → release/ 下 248MB 的 AppImage 被当 TypeScript 解析 →
// tree-sitter 进入超长解析（栈 100% 在 ts_parser__do_all_potential_reductions），
// 同步阻塞事件循环，整个 TUI 假死 4 小时。实测 6MB 二进制单次解析需 9 秒。
describe('ast-grep file admission guard (2026-09-10 卡死事故)', () => {
  it('跳过超大文件与二进制文件：不解析、报出跳过原因', async () => {
    const t0 = Date.now()
    const out = await call({
      pattern: 'function $NAME($$$) { $$$ }',
      paths: [bigDir],
      lang: 'TypeScript',
    })
    const elapsed = Date.now() - t0
    assert.ok(elapsed < 10_000, `不应尝试解析 2MB 二进制/超大文本（耗时 ${elapsed}ms）`)
    assert.ok(out.includes('跳过'), `应报出跳过原因，实际输出：${out}`)
  })

  it('path（单数）别名生效：不再静默退化为全目录扫描', async () => {
    const out = await call({
      pattern: 'function $NAME($$$) { $$$ }',
      path: 'sample.ts',
      lang: 'TypeScript',
    })
    assert.ok(out.includes('foo'), `应按 path 搜索 sample.ts：${out}`)
    assert.ok(!out.includes('multiply'), `不应扫到同目录的 sample.js（说明 path 被忽略）：${out}`)
  })
})

// ── Wave 3：解析隔离（worker 通道）────────────────────────────────────
// 2026-09-10 事故的结构性根修：napi.parse 是同步 native 调用，在主线程执行时
// 任何超长解析都会占满事件循环（事故现场 4 小时假死、SIGTERM 进不去）。解析搬
// 进 worker 线程后，不可用/超时一律**报错降级**（提示改用 grep），绝不回退主
// 线程——回退等于把冻结风险请回来。

/** 子进程跑一次 ast_grep：cpu-pool 的 DISABLED 是模块加载时常量，同进程内改
 *  env 无效，只能在子进程里设（与 cpu-pool.test.ts 同一模式）。 */
const RUN_AST_GREP = `
import { AST_GREP_TOOL } from './src/tools/ast-grep.ts'
const r = await AST_GREP_TOOL.execute({
  input: { pattern: 'function $NAME($$$ARGS) { $$$BODY }', paths: ['src/workers/cpu-pool.ts'], lang: 'TypeScript' },
  cwd: process.cwd(),
  toolUseId: 'probe',
  abortSignal: new AbortController().signal,
})
console.log('IS_ERROR=' + String(r.isError) + '|' + r.content.slice(0, 240).replace(/\\n/g, ' '))
`

function runAstGrepInChild(env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', RUN_AST_GREP], {
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

describe('ast-grep 解析隔离（Wave 3：worker 通道）', () => {
  it('RIVET_CPU_POOL=0：报「AST 解析不可用」且不回退主线程解析', async () => {
    const out = await Promise.race([
      runAstGrepInChild({ RIVET_CPU_POOL: '0' }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('子进程未退出')), 30_000)),
    ])
    assert.ok(out.includes('IS_ERROR=true'), `应为错误结果：${out}`)
    assert.ok(out.includes('AST 解析不可用'), `应报解析不可用降级文案：${out}`)
    assert.ok(out.includes('grep'), `应提示改用 grep：${out}`)
  })

  it('worker 可用时走 worker 通道并正常返回匹配', async () => {
    const out = await Promise.race([
      runAstGrepInChild({ RIVET_CPU_POOL_IDLE_MS: '100' }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('子进程未退出')), 30_000)),
    ])
    assert.ok(out.includes('IS_ERROR=undefined'), `应成功返回：${out}`)
    assert.ok(out.includes('处匹配'), `应返回匹配摘要：${out}`)
  })

  it('pool 不可用时：在窗口内返回降级文案，不挂起', async () => {
    // 确定性触发：dispose 让 pool 永久不可用 → run() 立即 reject → 走降级分支。
    // 1ms 真实超时在预热过的 worker 上会 flaky（响应可能快于 1ms），而「超时」
    // 与「不可用」共用同一个 catch（超时语义由 cpu-pool 既有用例覆盖）。
    cpuPool.dispose()
    try {
      const t0 = Date.now()
      const result = await astGrep.execute({
        input: { pattern: 'function $NAME($$$ARGS) { $$$BODY }', paths: ['sample.ts'], lang: 'TypeScript' },
        cwd: testDir,
        toolUseId: 'test-scan-timeout',
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
