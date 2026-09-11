import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { win32 as winPath } from 'node:path'
import { createMultiLspManager, defaultLspSpawn, type MultiLspOptions } from '../multi-manager.js'
import type { LspServerDef } from '../server-registry.js'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { encodeMessage, decodeMessages } from '../rpc.js'

function mockChild(): ChildProcess {
  return { kill: () => true, on: () => {}, pid: 0 } as unknown as ChildProcess
}

describe('createMultiLspManager spawnFor wiring', () => {
  it('routes npx def to spawnFor for .ts files', () => {
    const captured: Array<{ command: string; args: string[] }> = []

    const opts: MultiLspOptions = {
      which: () => true,
      spawnFor: (def: LspServerDef) => {
        captured.push({ command: def.command, args: def.args ?? [] })
        return mockChild()
      },
    }

    const mgr = createMultiLspManager('/tmp', opts)
    void mgr.gotoDefinition('test.ts', 1, 0)

    assert.equal(captured.length, 1, 'spawnFor should be called once')
    assert.equal(captured[0]!.command, 'npx', 'TS LSP def command should be npx')
    assert.ok(captured[0]!.args.includes('-y'), 'args should include -y')
  })

  it('routes non-npx def to spawnFor for .go files', () => {
    const captured: Array<{ command: string; args: string[] }> = []

    const opts: MultiLspOptions = {
      which: () => true,
      spawnFor: (def: LspServerDef) => {
        captured.push({ command: def.command, args: def.args ?? [] })
        return mockChild()
      },
    }

    const mgr = createMultiLspManager('/tmp', opts)
    void mgr.gotoDefinition('main.go', 1, 0)

    assert.equal(captured.length, 1)
    assert.equal(captured[0]!.command, 'gopls', 'gopls def command should pass through')
    assert.deepEqual(captured[0]!.args, [])
  })
})

describe('never-initializing LSP is bounded, not a wedge', () => {
  it('getFileDiagnostics degrades to [] when the server never answers initialize', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const opts: MultiLspOptions = {
      which: () => true,
      initializeTimeoutMs: 60,
      spawnFor: () => ({
        stdin,
        stdout,
        stderr: new PassThrough(),
        kill: () => true,
        on: () => {},
      }) as unknown as ChildProcess,
    }
    const mgr = createMultiLspManager('/tmp', opts)
    const started = Date.now()
    const diagnostics = await mgr.getFileDiagnostics('test.ts', 30)
    const elapsed = Date.now() - started

    assert.deepEqual(diagnostics, [], 'must degrade to no diagnostics')
    assert.ok(elapsed < 1_000, `must not hang; took ${elapsed}ms`)
    mgr.dispose()
  })

  it('hard initialize timeout disposes the hung child', async () => {
    let killed = false
    const opts: MultiLspOptions = {
      which: () => true,
      initializeTimeoutMs: 20,
      spawnFor: () => ({
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => { killed = true; return true },
        on: () => {},
      }) as unknown as ChildProcess,
    }
    const mgr = createMultiLspManager('/tmp', opts)
    await mgr.getFileDiagnostics('test.ts', 100)

    assert.equal(killed, true, 'hung child must be killed at the hard bound')
    mgr.dispose()
  })
})

describe('defaultLspSpawn', () => {
  it('rewrites npx against desktop bundled node-runtime layout (win-x64)', () => {
    // Simulate fetch-node-runtime Windows layout — NOT the host Homebrew Node:
    //   resources/node-runtime/win-x64/node.exe
    //   resources/node-runtime/win-x64/node_modules/npm/bin/npx-cli.js
    const execPath = 'C:\\App\\resources\\node-runtime\\win-x64\\node.exe'
    const cli = winPath.join(
      'C:\\App\\resources\\node-runtime\\win-x64',
      'node_modules', 'npm', 'bin', 'npx-cli.js',
    )

    const captured: Array<{ command: string; args: string[]; env?: Record<string, string> }> = []
    const spawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      captured.push({
        command: cmd,
        args,
        env: opts.env as Record<string, string> | undefined,
      })
      return mockChild()
    }

    const npxDef: LspServerDef = {
      id: 'test-npx',
      extensions: ['.ts'],
      command: 'npx',
      args: ['-y', 'typescript-language-server', '--stdio'],
      languageId: 'typescript',
      alwaysAvailable: true,
    }

    defaultLspSpawn(npxDef, 'C:\\proj', spawnFn, {
      execPath,
      platform: 'win32',
      existsSync: (p) => p === cli,
    })

    assert.equal(captured.length, 1, 'spawnFn should be called once')
    // Deleting resolveNpmCliCommand from defaultLspSpawn → command stays 'npx' → RED.
    assert.equal(captured[0]!.command, execPath, 'command should be bundled node.exe, not bare npx')
    assert.equal(captured[0]!.args[0], cli)
    assert.deepEqual(captured[0]!.args.slice(1), ['-y', 'typescript-language-server', '--stdio'])
    assert.ok(
      captured[0]!.env?.PATH?.startsWith('C:\\App\\resources\\node-runtime\\win-x64;'),
      `PATH should prepend bundled nodeDir, got ${captured[0]!.env?.PATH}`,
    )
  })
})


describe('LSP 服务器崩溃后有界重启（2026-09-11 F4）', () => {
  function makeRestartableMock() {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let serverBuf = ''
    const exitHandlers: Array<(...args: unknown[]) => void> = []
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
              result: { capabilities: { definitionProvider: true, referencesProvider: true } },
            }))
          } else if (method === 'textDocument/definition') {
            stdout.write(encodeMessage({
              jsonrpc: '2.0' as const,
              id,
              result: [{
                uri: 'file:///tmp/test.ts',
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
              }],
            }))
          }
        }
      }
    })
    const proc = {
      stdin,
      stdout,
      stderr,
      kill: () => true,
      on: (ev: string, cb: (...args: unknown[]) => void) => {
        if (ev === 'exit') exitHandlers.push(cb)
      },
    } as unknown as ChildProcess
    return { proc, emitExit: () => { for (const cb of [...exitHandlers]) cb(1, null) } }
  }

  it('崩死后下次调用重启出新进程；重启次数有界，crash-loop 不打爆 spawn', async () => {
    const mocks: Array<ReturnType<typeof makeRestartableMock>> = []
    const opts: MultiLspOptions = {
      which: () => true,
      spawnFor: () => {
        const m = makeRestartableMock()
        mocks.push(m)
        return m.proc
      },
    }
    const mgr = createMultiLspManager('/tmp', opts)
    // 本文件的既有用例依赖上游 runner 的循环语义；此处显式保活，确保
    // 重启链路（多次 spawn/init/exit）在任意环境下都能走完。
    const keepAlive = setInterval(() => {}, 50)
    try {
      const loc1 = await mgr.gotoDefinition('test.ts', 1, 0)
      assert.equal(mocks.length, 1)
      assert.ok(loc1.length > 0, '首个实例正常服务')
      mocks[0]!.emitExit() // 服务器崩死

      const loc2 = await mgr.gotoDefinition('test.ts', 1, 0)
      assert.equal(mocks.length, 2, `崩溃后必须重启出新进程（修复前 ensure 永远返回 null），spawns=${mocks.length}`)
      assert.ok(loc2.length > 0, '重启后的实例正常服务')
      mocks[1]!.emitExit()

      await mgr.gotoDefinition('test.ts', 1, 0)
      assert.equal(mocks.length, 3, '第二次重启')
      mocks[2]!.emitExit()

      const loc4 = await mgr.gotoDefinition('test.ts', 1, 0)
      assert.equal(mocks.length, 3, '重启有界：额度耗尽不再 spawn')
      assert.deepEqual(loc4, [], '额度耗尽后降级为空（不挂起）')
    } finally {
      mgr.dispose()
      clearInterval(keepAlive)
    }
  })
})

