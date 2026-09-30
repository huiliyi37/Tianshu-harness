import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LspManager, createLspManager } from '../manager.js'
import { PassThrough } from 'node:stream'
import { encodeMessage, decodeMessages } from '../rpc.js'

/** mock 固定 cwd。Windows 上 '/project' 构不出合法 file:// URI——
 *  fileURLToPath('file:///project/...') 会抛「must be absolute」，产品走 catch
 *  分支导致相对化失效。平台化后两平台都走产品的主路径。 */
const MOCK_CWD = process.platform === 'win32' ? 'C:\\project' : '/project'
const mockUri = (rel: string): string => pathToFileURL(join(MOCK_CWD, rel)).href

/**
 * Create a mock LSP server process.
 * Client writes to proc.stdin → server reads from proc.stdin
 * Server writes to proc.stdout → client reads from proc.stdout
 */
function createMockServer() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()

  let killed = false
  /** 收到的 didOpen 通知数（F4：重初始化必须向新服务器重发 didOpen）。 */
  let didOpenCount = 0

  let serverBuf = ''
  stdin.on('data', (chunk: Buffer) => {
    serverBuf += chunk.toString()
    const { messages, rest } = decodeMessages(serverBuf)
    serverBuf = rest

    for (const msg of messages) {
      if ('method' in msg && 'id' in msg) {
        const id = (msg as { id: number }).id
        const method = (msg as { method: string }).method

        if (method === 'initialize') {
          stdout.write(encodeMessage({
            jsonrpc: '2.0' as const,
            id,
            result: {
              capabilities: {
                definitionProvider: true,
                referencesProvider: true,
              },
            },
          }))
        } else if (method === 'textDocument/definition') {
          stdout.write(encodeMessage({
            jsonrpc: '2.0' as const,
            id,
            result: [{
              uri: mockUri('src/target.ts'),
              range: {
                start: { line: 9, character: 4 },
                end: { line: 9, character: 10 },
              },
            }],
          }))
        } else if (method === 'textDocument/references') {
          stdout.write(encodeMessage({
            jsonrpc: '2.0' as const,
            id,
            result: [
              { uri: mockUri('src/a.ts'), range: { start: { line: 5, character: 3 }, end: { line: 5, character: 9 } } },
              { uri: mockUri('src/b.ts'), range: { start: { line: 12, character: 1 }, end: { line: 12, character: 7 } } },
            ],
          }))
        } else if (method === 'shutdown') {
          stdout.write(encodeMessage({
            jsonrpc: '2.0' as const,
            id,
            result: null,
          }))
        }
      }
      for (const msg of messages) {
        if ('method' in msg && (msg as { method: string }).method === 'textDocument/didOpen') {
          didOpenCount++
        }
      }
    }
  })

  const proc = {
    stdin,
    stdout,
    stderr,
    kill: () => { killed = true },
    on: (_ev: string, _cb: (...args: unknown[]) => void) => {},
    get killed() { return killed },
  }

  return { proc, stdin, stdout, stderr, get didOpenCount() { return didOpenCount } }
}

describe('LspManager', () => {
  const managers: LspManager[] = []

  afterEach(() => {
    for (const m of managers) {
      try { m.dispose() } catch { /* ignore */ }
    }
    managers.length = 0
  })

  it('initializes and reports capabilities', async () => {
    const mock = createMockServer()
    const mgr = createLspManager(
      () => mock.proc as any,
      '/project',
    )
    managers.push(mgr)

    await mgr.initialize()

    assert.equal(mgr.isReady(), true)
    assert.equal(mgr.supportsDefinition(), true)
    assert.equal(mgr.supportsReferences(), true)
  })

  it('go-to-definition returns target location', async () => {
    const mock = createMockServer()
    const mgr = createLspManager(
      () => mock.proc as any,
      MOCK_CWD,
    )
    managers.push(mgr)

    await mgr.initialize()
    const result = await mgr.gotoDefinition('src/file.ts', 10, 5)

    assert.equal(result.length, 1)
    assert.equal(result[0]!.uri, 'src/target.ts')
    assert.equal(result[0]!.range.start.line, 9)
    assert.equal(result[0]!.range.start.character, 4)
  })

  it('find-references returns reference list', async () => {
    const mock = createMockServer()
    const mgr = createLspManager(
      () => mock.proc as any,
      MOCK_CWD,
    )
    managers.push(mgr)

    await mgr.initialize()
    const result = await mgr.findReferences('src/file.ts', 10, 5)

    assert.equal(result.length, 2)
    assert.equal(result[0]!.uri, 'src/a.ts')
    assert.equal(result[1]!.uri, 'src/b.ts')
  })

  it('not-ready manager returns empty results', async () => {
    const mgr = createLspManager(
      () => { throw new Error('should not spawn') },
      '/project',
    )
    managers.push(mgr)

    assert.equal(mgr.isReady(), false)
    const result = await mgr.gotoDefinition('src/file.ts', 1, 1)
    assert.equal(result.length, 0)
  })

  it('spawn failure with null stdio degrades to not-ready instead of hanging', async () => {
    const mgr = createLspManager(
      () => ({
        stdin: null,
        stdout: null,
        stderr: null,
        kill: () => true,
        on: () => {},
      }) as any,
      '/project',
    )
    managers.push(mgr)

    await mgr.initialize()
    assert.equal(mgr.isReady(), false, 'desktop ENOENT spawn path must not wedge initialize')
  })

  it('dispose calls kill on the spawned process after initialization', async () => {
    // Create a mock that remembers kill invocation
    let killed = false
    const stdin = new PassThrough()
    const stdout = new PassThrough()

    // Minimal LSP initializer — respond to initialize
    let buf = ''
    stdin.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const { messages, rest } = decodeMessages(buf)
      buf = rest
      for (const msg of messages) {
        if ('method' in msg && msg.method === 'initialize' && 'id' in msg) {
          stdout.write(encodeMessage({
            jsonrpc: '2.0' as const,
            id: (msg as { id: number }).id,
            result: { capabilities: { definitionProvider: true } },
          }))
        }
      }
    })

    const mgr = createLspManager(
      () => ({
        stdin,
        stdout,
        stderr: new PassThrough(),
        kill: () => { killed = true },
        on: () => {},
      }) as any,
      '/project',
    )
    managers.push(mgr)

    await mgr.initialize()
    assert.equal(mgr.isReady(), true)
    mgr.dispose()
    assert.equal(killed, true)
  })

  it('handles null definition result (symbol not found)', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()

    let serverBuf = ''
    stdin.on('data', (chunk: Buffer) => {
      serverBuf += chunk.toString()
      const { messages, rest } = decodeMessages(serverBuf)
      serverBuf = rest
      for (const msg of messages) {
        if ('method' in msg && 'id' in msg) {
          const id = (msg as { id: number }).id
          const method = (msg as { method: string }).method
          if (method === 'initialize') {
            stdout.write(encodeMessage({
              jsonrpc: '2.0' as const, id,
              result: { capabilities: { definitionProvider: true } },
            }))
          } else if (method === 'textDocument/definition') {
            stdout.write(encodeMessage({
              jsonrpc: '2.0' as const, id,
              result: null,
            }))
          }
        }
      }
    })

    const mgr = createLspManager(
      () => ({ stdin, stdout, stderr: new PassThrough(), kill: () => {}, on: () => {} }) as any,
      '/project',
    )
    managers.push(mgr)

    await mgr.initialize()
    const result = await mgr.gotoDefinition('src/file.ts', 1, 1)
    assert.equal(result.length, 0)
  })

  it('重新 initialize 向新服务器重发 didOpen——openedDocs 必须清空（2026-09-11 F4）', async () => {
    // 目标文件必须真实存在：didOpen 只在读到磁盘内容时才发（读不到不发，免得把
    // 「暂时读不到」固化成「永久空文档」，见 language-id.test.ts）。本用例断言的是
    // 重初始化后的**重发**行为，故用真实 cwd + 真实文件。
    const cwd = mkdtempSync(join(tmpdir(), 'lsp-reinit-'))
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src/target.ts'), 'export const x = 1\n')
    const s1 = createMockServer()
    const s2 = createMockServer()
    const servers = [s1, s2]
    const mgr = createLspManager(() => servers.shift()!.proc as any, cwd)
    managers.push(mgr)

    await mgr.initialize()
    await mgr.gotoDefinition('src/target.ts', 10, 5)
    assert.equal(s1.didOpenCount, 1, '首任服务器收到 didOpen')

    mgr.dispose() // 模拟服务器死亡清理
    await mgr.initialize() // 重启路径：同一 manager 重新初始化
    await mgr.gotoDefinition('src/target.ts', 10, 5)
    assert.equal(s2.didOpenCount, 1,
      '新服务器必须重新收到 didOpen——修复前 openedDocs 残留把 didOpen 短路掉')
  })
})
