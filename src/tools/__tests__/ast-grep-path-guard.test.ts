/**
 * ast_grep 读面边界回归（安全审计 2026-11-09）。
 *
 * 漏洞：ast-grep.ts 曾直接 `resolve(cwd, p)` + collectFiles，完全绕过
 * validatePathSafe。实测可读工作区外源码、系统文件（/etc/passwd）与
 * 工作区内凭据（.env）——文件内容原样回传给模型，读面与 read_file 同级。
 *
 * 修复：paths 逐个过 validatePathSafe(mode='read')，收集结果再逐个复查
 * （工作区内指向外部的软链目录在遍历后才暴露）。
 *
 * 反向验证：去掉 ast-grep.ts 中的校验，本文件的用例即失败。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Tool, ToolCallParams } from '../types.js'
import { cpuPool } from '../../workers/cpu-pool.js'

let astGrep: Tool

// 沙箱不放行 /tmp，夹具放在仓库内；`outside` 是 workspace 的兄弟目录，
// 用相对穿越 `../outside` 访问，正是漏洞的触发形态。
const base = join(process.cwd(), '.test-tmp', `ast-grep-scope-${randomBytes(4).toString('hex')}`)
const ws = join(base, 'ws')
const outside = join(base, 'outside')

const SECRET = 'hunter2-outside-workspace'

function call(input: Record<string, unknown>) {
  return astGrep.execute({
    input,
    cwd: ws,
    toolUseId: 'scope-test',
    abortSignal: new AbortController().signal,
    onOutput: undefined,
  } as unknown as ToolCallParams)
}

before(async () => {
  await rm(base, { recursive: true, force: true })
  await mkdir(ws, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'secret.ts'), `const SECRET_TOKEN = "${SECRET}"\n`)
  await writeFile(join(ws, '.env'), 'OPENAI_API_KEY=sk-live-abcdef123456\n')
  await writeFile(join(ws, 'inside.ts'), 'function inside() {\n  return 1\n}\n')
  // 工作区内指向外部的软链文件：入口校验会实到 realpath，必须在 root 处就拒绝。
  await symlink(join(outside, 'secret.ts'), join(ws, 'linked.ts'))
  const mod = await import('../ast-grep.js')
  astGrep = mod.AST_GREP_TOOL
})

after(async () => {
  cpuPool.dispose()
  await rm(base, { recursive: true, force: true })
})

describe('ast_grep 读面边界', () => {
  it('拒绝相对穿越到工作区外', async () => {
    const r = await call({ pattern: 'const $A = $B', paths: ['../outside'], lang: 'TypeScript' })
    assert.equal(r.isError, true, `应拒绝，实际：${r.content}`)
    assert.ok(!r.content.includes(SECRET), `不得泄漏工作区外内容：${r.content}`)
    assert.ok(r.content.includes('outside project directory'), r.content)
  })

  it('拒绝绝对路径指向工作区外（/etc/passwd）', async () => {
    const r = await call({ pattern: 'root', paths: ['/etc/passwd'], lang: 'TypeScript' })
    assert.equal(r.isError, true, `应拒绝，实际：${r.content}`)
    assert.ok(!r.content.includes('root:x:'), `不得读取系统文件：${r.content}`)
  })

  it('拒绝工作区内敏感文件 .env', async () => {
    const r = await call({ pattern: '$A', paths: ['.env'], lang: 'TypeScript' })
    assert.equal(r.isError, true, `应拒绝，实际：${r.content}`)
    assert.ok(!r.content.includes('sk-live-abcdef123456'), `不得回传凭据：${r.content}`)
    assert.ok(r.content.includes('Sensitive file blocked'), r.content)
  })

  it('拒绝指向工作区外的软链文件', async () => {
    const r = await call({ pattern: 'const $A = $B', paths: ['linked.ts'], lang: 'TypeScript' })
    assert.equal(r.isError, true, `应拒绝，实际：${r.content}`)
    assert.ok(!r.content.includes(SECRET), `不得经软链泄漏：${r.content}`)
  })

  it('目录遍历中出现的越界软链也不得读取', async () => {
    const r = await call({ pattern: 'const $A = $B', paths: ['.'], lang: 'TypeScript' })
    assert.ok(!r.content.includes(SECRET), `目录遍历不得跟随外部软链：${r.content}`)
  })

  it('工作区内正常路径仍然可用（修复不误伤）', async () => {
    const r = await call({ pattern: 'function $NAME($$$) { $$$ }', paths: ['inside.ts'], lang: 'TypeScript' })
    assert.equal(r.isError, undefined, `不应报错：${r.content}`)
    assert.ok(r.content.includes('inside'), r.content)
  })
})
