import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildBashVerification, inferBashVerificationScope } from '../bash-verification.js'

describe('bash verification facts', () => {
  it('preserves domain failure exit codes even when the command executed normally', () => {
    const result = { content: 'AssertionError', isError: false, exitCode: 1 }
    const verification = buildBashVerification('node --test src/cache.test.mjs', result, result)
    assert.equal(verification.status, 'failed')
    assert.equal(verification.exitCode, 1)
    assert.equal(verification.failureKind, 'test_failure')
    assert.equal(verification.scope, 'targeted')
    assert.deepEqual(verification.targetFiles, ['src/cache.test.mjs'])
  })

  it('does not fabricate a successful exit when the tool returned no exit code', () => {
    const result = { content: 'still running', isError: false }
    const verification = buildBashVerification('npm test', result, result)
    assert.equal(verification.status, 'blocked')
    assert.equal(verification.exitCode, undefined)
  })

  it('keeps timeouts distinct from failed test assertions', () => {
    const result = { content: 'timed out', isError: true, exitCode: -1, errorClass: 'timeout' as const }
    const verification = buildBashVerification('npm test', result, result)
    assert.equal(verification.status, 'failed')
    assert.equal(verification.exitCode, -1)
    assert.equal(verification.failureKind, 'timeout')
  })

  it('uses the successful retry result instead of an earlier harness error class', () => {
    const result = { content: '# pass 1\n# fail 0', isError: false, exitCode: 0 }
    const verification = buildBashVerification('npm test', result, { ...result, errorClass: 'timeout' })
    assert.equal(verification.status, 'passed')
    assert.equal(verification.exitCode, 0)
    assert.equal(verification.failureKind, undefined)
  })

  it('rejects a contradictory successful exit with failed TAP assertions', () => {
    const result = { content: '# pass 3\n# fail 1\n# skipped 2', isError: false, exitCode: 0 }
    const verification = buildBashVerification('npm test', result, result)
    assert.equal(verification.status, 'failed')
    assert.equal(verification.passed, 3)
    assert.equal(verification.failed, 1)
    assert.equal(verification.skipped, 2)
  })
})

describe('bash verification scope', () => {
  it('allows known unfiltered suite invocations', () => {
    for (const command of ['npm test', 'npm run typecheck', 'npx tsc --noEmit', 'node --test', 'npx vitest run']) {
      assert.equal(inferBashVerificationScope(command).scope, 'full', command)
    }
  })

  it('does not extend selected files, test names or shell chains to full coverage', () => {
    for (const command of ['npm test -- src/cache.test.ts', 'pytest -k cache', 'node --test --test-name-pattern cache',
      'npm test && echo done', 'npm test || true', 'cd nested && npm test', 'npm run custom-verify']) {
      assert.equal(inferBashVerificationScope(command).scope, 'targeted', command)
    }
  })

  it('preserves quoted file targets and Windows executable paths', () => {
    assert.deepEqual(inferBashVerificationScope('node --test "src/cache manager.test.mjs"'), {
      scope: 'targeted', targetFiles: ['src/cache manager.test.mjs'],
    })
    assert.equal(inferBashVerificationScope('"C:\\Program Files\\nodejs\\node.exe" --test').scope, 'full')
  })
})
