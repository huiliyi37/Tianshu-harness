import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sandboxExec } from '../sandbox-exec.js'

describe('sandboxExec', () => {
  it('captures stdout from console.log', async () => {
    const result = await sandboxExec('console.log("hello world");')
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /hello world/)
  })

  it('captures stderr on error and exits non-zero', async () => {
    const result = await sandboxExec('throw new Error("boom");')
    assert.notEqual(result.exitCode, 0)
    assert.match(result.stderr, /boom/)
  })

  it('times out long-running code', async () => {
    const result = await sandboxExec(
      'while(true) {}',
      { timeoutMs: 500 },
    )
    assert.notEqual(result.exitCode, 0)
    assert.match(result.stderr, /timeout/)
  })

  it('truncates large stdout', async () => {
    const result = await sandboxExec(
      'for(let i=0;i<10000;i++) console.log("x".repeat(100));',
      { maxOutputChars: 2000 },
    )
    assert.ok(result.stdout.length <= 2100) // small buffer for truncation message
    assert.match(result.stdout, /\[output truncated/)
  })

  it('does NOT leak secrets via process.env', async () => {
    // Set a fake secret in current process
    const SECRET_KEY = 'TEST_SECRET_DO_NOT_LEAK'
    process.env[SECRET_KEY] = 'super-secret-value'
    try {
      const result = await sandboxExec(
        `console.log(process.env.${SECRET_KEY} || 'NOT_SET')`,
      )
      assert.match(result.stdout, /NOT_SET/)
      assert.ok(!result.stdout.includes('super-secret-value'))
    } finally {
      delete process.env[SECRET_KEY]
    }
  })

  it('cleans up the temp script file after execution', async () => {
    const { existsSync } = await import('node:fs')
    const { basename } = await import('node:path')
    const result = await sandboxExec('console.log(__filename)')
    assert.equal(result.exitCode, 0)
    const script = result.stdout.trim()
    assert.match(basename(script), /^rivet-sandbox-[a-f0-9]{8}\.cjs$/)
    const deadline = Date.now() + 2000
    while (existsSync(script) && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(existsSync(script), false, 'this invocation must remove its own temp script')
  })
})
