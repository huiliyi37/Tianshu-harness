import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { LspManager, createLspManager } from '../manager.js'
import { PassThrough } from 'node:stream'
import { encodeMessage, decodeMessages } from '../rpc.js'

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
              uri: 'file:///project/src/target.ts',
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
              { uri: 'file:///project/src/a.ts', range: { start: { line: 5, character: 3 }, end: { line: 5, character: 9 } } },
              { uri: 'file:///project/src/b.ts', range: { start: { line: 12, character: 1 }, end: { line: 12, character: 7 } } },
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
      // Notifications (initialized, textDocument/didOpen) — no response needed
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

  return { proc, stdin, stdout, stderr }
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
      '/project',
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
      '/project',
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
})
