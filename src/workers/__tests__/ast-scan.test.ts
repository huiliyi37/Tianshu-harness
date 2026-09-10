/**
 * astScanRaw —— ast_grep 的 worker 通道任务（Wave 3 解析隔离）。
 *
 * 本文件 inline 调用任务函数（不经 worker 线程）：任务本身是纯数据进 / 纯数据
 * 出，inline 即可覆盖全部逻辑分支；worker 往返由 ast-grep.test.ts 的子进程用例
 * 与 dist smoke 覆盖（主进程内真实 spawn 会留 MessagePort ref，见 cpu-pool.test.ts）。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { astScanRaw, type AstScanArgs } from '../cpu-tasks.js'
import { MAX_PARSE_FILE_BYTES } from '../../tools/ast-shared.js'

const dir = join(process.cwd(), '.test-tmp', `ast-scan-${randomBytes(4).toString('hex')}`)

const FIXTURE = `
function foo(a: number) {
  return a + 1
}

function multiStmt(d: number) {
  const x = d * 2
  return x
}
`.trim()

function args(overrides: Partial<AstScanArgs> = {}): AstScanArgs {
  return {
    files: [join(dir, 'sample.ts')],
    pattern: 'function $NAME($$$ARGS) { $$$BODY }',
    limit: 50,
    includeMeta: false,
    maxBytes: MAX_PARSE_FILE_BYTES,
    ...overrides,
  }
}

before(async () => {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'sample.ts'), FIXTURE)
  await writeFile(join(dir, 'broken.ts'), 'function validInBroken(a: number) {\n  return a + 1\n}\n\nfunction broken( {\n')
  // 准入护栏夹具必须用「语言可识别」的扩展名：护栏在语言检查之后，用 .bin 会
  // 先落到「不支持的语言」分支（与主线程原实现的判定顺序一致）。
  await writeFile(join(dir, 'huge.ts'), '// ' + 'x'.repeat(2 * 1024 * 1024))
  await writeFile(join(dir, 'binary.ts'), Buffer.concat([
    Buffer.from('const a = 1\n'),
    Buffer.from([0, 1, 2, 3]),
    Buffer.from('x'.repeat(64)),
  ]))
  await writeFile(join(dir, 'sample.rs'), 'fn main() {}')
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('astScanRaw（worker 任务）', () => {
  it('返回纯数据匹配（file/line/column/matchText），可 JSON 往返', async () => {
    const r = await astScanRaw(args())
    assert.equal(r.errors.length, 0, `不应有错误：${r.errors.join('; ')}`)
    assert.equal(r.filesScanned, 1)
    assert.ok(r.matches.length >= 2, `应匹配 foo 与 multiStmt，实际 ${r.matches.length}`)
    const first = r.matches[0]!
    assert.equal(typeof first.file, 'string')
    assert.equal(typeof first.line, 'number')
    assert.equal(typeof first.column, 'number')
    assert.equal(typeof first.matchText, 'string')
    // 跨线程只传纯数据——native 对象过不去，JSON 往返必须不丢信息
    assert.deepEqual(JSON.parse(JSON.stringify(first)), first)
  })

  it('准入护栏：超大文件与二进制进 skipped，不解析', async () => {
    const r = await astScanRaw(args({ files: [join(dir, 'huge.ts'), join(dir, 'binary.ts')] }))
    assert.equal(r.filesScanned, 0, '两者都不应被解析')
    assert.equal(r.matches.length, 0)
    assert.equal(r.skipped.length, 2, `应报 2 条跳过原因：${r.skipped.join(' | ')}`)
    assert.ok(r.skipped.some(s => s.includes('二进制')), `应含二进制判定：${r.skipped.join(' | ')}`)
    assert.ok(r.skipped.some(s => s.includes('解析上限')), `应含体积判定：${r.skipped.join(' | ')}`)
  })

  it('含 ERROR 恢复区的文件仍匹配合法部分，并记入 degraded', async () => {
    const r = await astScanRaw(args({ files: [join(dir, 'broken.ts')] }))
    assert.ok(r.matches.some(m => m.matchText.includes('validInBroken')),
      `应匹配 validInBroken：${JSON.stringify(r.matches)}`)
    assert.equal(r.degraded.length, 1, `应记一条降级：${r.degraded.join(' | ')}`)
    assert.ok(r.degraded[0]!.includes('错误恢复区'), `降级文案应含错误恢复区：${r.degraded[0]}`)
  })

  it('includeMeta：多节点捕获用形状摘要，单节点保留原文', async () => {
    const r = await astScanRaw(args({ includeMeta: true }))
    const multi = r.matches.find(m => m.matchText.includes('multiStmt'))
    assert.ok(multi?.metaVariables, `应提取元变量：${JSON.stringify(multi)}`)
    assert.match(multi!.metaVariables!.BODY!, /^\d+n\/\d+L: /, `BODY 应为形状摘要：${multi!.metaVariables!.BODY}`)
    assert.equal(multi!.metaVariables!.NAME, 'multiStmt', 'NAME 应为原始标识符')
  })

  it('limit 截断：达到上限即停止收集', async () => {
    const r = await astScanRaw(args({ limit: 1 }))
    assert.equal(r.matches.length, 1, `limit=1 应只返回 1 条，实际 ${r.matches.length}`)
  })

  it('rule 对象 pattern（JSON 串）走同一通道', async () => {
    const r = await astScanRaw(args({ pattern: JSON.stringify({ rule: { kind: 'function_declaration' } }) }))
    assert.ok(r.matches.length >= 2, `rule 对象应匹配函数声明：${JSON.stringify(r.matches)}`)
  })

  it('不支持的语言记入 errors 而非崩溃', async () => {
    const r = await astScanRaw(args({ files: [join(dir, 'sample.rs')] }))
    assert.equal(r.matches.length, 0)
    assert.ok(r.errors.some(e => e.includes('不支持的语言')), `应报不支持语言：${r.errors.join(' | ')}`)
  })
})
