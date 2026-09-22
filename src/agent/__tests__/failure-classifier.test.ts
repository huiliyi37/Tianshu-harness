import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure, classifyTestRun, classifyToolFailure, isTransient, isTestRunInvocation, isReadProbeInvocation, resolveErrorKind } from '../failure-classifier.js'

describe('classifyFailure', () => {
  it('classifies TS type errors correctly', () => {
    const result = classifyFailure("src/foo.ts:10:5 - error TS2322: Type 'string' is not assignable to type 'number'.")
    assert.equal(result.class, 'type_error')
    assert.ok(result.confidence >= 0.9)
  })

  it('classifies assertion failures', () => {
    const result = classifyFailure('AssertionError: expected true but got false')
    assert.equal(result.class, 'assertion')
    assert.ok(result.confidence >= 0.7)
  })

  it('classifies module resolution errors', () => {
    const result = classifyFailure("Cannot find module '../utils/helper' or its corresponding type declarations.")
    assert.equal(result.class, 'module_resolution')
    assert.ok(result.confidence >= 0.9)
  })

  it('classifies missing dependency errors', () => {
    const result = classifyFailure('sh: vitest: command not found')
    assert.equal(result.class, 'missing_dep')
    assert.ok(result.confidence >= 0.8)
  })

  it('classifies timeout errors', () => {
    const result = classifyFailure('Error: test timed out after 5000ms')
    assert.equal(result.class, 'timeout')
    assert.ok(result.confidence >= 0.8)
  })

  it('classifies snapshot errors', () => {
    const result = classifyFailure('Snapshot mismatch: expected 42 lines but received 38 lines (diff)')
    assert.equal(result.class, 'snapshot')
    assert.ok(result.confidence >= 0.85)
  })

  it('classifies environment errors', () => {
    const result = classifyFailure('Error: API key environment variable is not set')
    assert.equal(result.class, 'env_missing')
    assert.ok(result.confidence >= 0.8)
  })

  it('falls back to unknown for unclassified errors', () => {
    const result = classifyFailure('something weird happened')
    assert.equal(result.class, 'unknown')
    assert.ok(result.confidence <= 0.5)
  })

  // === probe_miss（A5 信号互扰治理 M3）===
  it('只读探测的 File not found → probe_miss（反幻影探针不是认知失败）', () => {
    const result = classifyFailure('File not found: /repo/src/maybe-exists.ts', { isReadProbe: true })
    assert.equal(result.class, 'probe_miss')
    assert.equal(result.retryable, false)
  })

  it('只读探测的 ENOENT → probe_miss', () => {
    const result = classifyFailure("ENOENT: no such file or directory, open '/repo/x.ts'", { isReadProbe: true })
    assert.equal(result.class, 'probe_miss')
  })

  it('非探测来源的 File not found 保持原分类（unknown）——写路径缺文件是真失败', () => {
    const result = classifyFailure('File not found: /repo/src/maybe-exists.ts')
    assert.equal(result.class, 'unknown')
  })

  it('isReadProbeInvocation: 只读探测工具 true，写/执行工具 false', () => {
    assert.equal(isReadProbeInvocation('read_file'), true)
    assert.equal(isReadProbeInvocation('glob'), true)
    assert.equal(isReadProbeInvocation('grep'), true)
    assert.equal(isReadProbeInvocation('file_info'), true)
    assert.equal(isReadProbeInvocation('bash'), false)
    assert.equal(isReadProbeInvocation('edit_file'), false)
    assert.equal(isReadProbeInvocation('write_file'), false)
  })

  // === permission_denied ===
  it('classifies EACCES permission errors', () => {
    const result = classifyFailure("EACCES: permission denied, open '/etc/shadow'")
    assert.equal(result.class, 'permission_denied')
    assert.equal(result.retryable, false)
  })

  it('classifies Permission denied string', () => {
    const result = classifyFailure('Error: Permission denied')
    assert.equal(result.class, 'permission_denied')
  })

  it('classifies Operation not permitted', () => {
    const result = classifyFailure('EPERM: operation not permitted')
    assert.equal(result.class, 'permission_denied')
  })

  // === context_window_exceeded ===
  it('classifies context length exceeded', () => {
    const result = classifyFailure("This model's maximum context length is 200000 tokens")
    assert.equal(result.class, 'context_window_exceeded')
    assert.equal(result.retryable, false)
  })

  it('classifies token limit errors', () => {
    const result = classifyFailure('Maximum context length exceeded')
    assert.equal(result.class, 'context_window_exceeded')
  })

  it('classifies too many tokens', () => {
    const result = classifyFailure('Too many tokens in input')
    assert.equal(result.class, 'context_window_exceeded')
  })

  // === api_error ===
  it('classifies 429 rate limit', () => {
    const result = classifyFailure('429 Too Many Requests')
    assert.equal(result.class, 'api_error')
    assert.equal(result.retryable, true)
  })

  it('classifies 500 server error', () => {
    const result = classifyFailure('500 Internal Server Error')
    assert.equal(result.class, 'api_error')
  })

  it('classifies 502 bad gateway', () => {
    const result = classifyFailure('502 Bad Gateway')
    assert.equal(result.class, 'api_error')
  })

  it('classifies rate limit text', () => {
    const result = classifyFailure('Error: rate limit exceeded')
    assert.equal(result.class, 'api_error')
  })

  // === syntax_error ===
  it('classifies SyntaxError', () => {
    const result = classifyFailure('SyntaxError: Unexpected token')
    assert.equal(result.class, 'syntax_error')
    assert.equal(result.retryable, false)
  })

  it('classifies ParseError', () => {
    const result = classifyFailure('ParseError: Unexpected end of input')
    assert.equal(result.class, 'syntax_error')
  })

  it('classifies compilation error', () => {
    const result = classifyFailure('compilation error in module foo')
    assert.equal(result.class, 'syntax_error')
  })

  it('classifies reference error (is not defined)', () => {
    const result = classifyFailure('ReferenceError: myVar is not defined')
    assert.equal(result.class, 'syntax_error')
  })

  // === format_error ===
  it('classifies JSON parse errors', () => {
    const result = classifyFailure('JSON.parse: unexpected character at line 1 column 5')
    assert.equal(result.class, 'format_error')
    assert.equal(result.retryable, true)
  })

  it('classifies malformed output', () => {
    const result = classifyFailure('Error: malformed response from API')
    assert.equal(result.class, 'format_error')
  })

  it('classifies unterminated string in JSON', () => {
    const result = classifyFailure('Unterminated string in JSON at position 42')
    assert.equal(result.class, 'format_error')
  })
})

describe('classifyTestRun', () => {
  it('parses multiple node:test failures', () => {
    const output = `
ok 1 - setup
not ok 2 - should add numbers
  AssertionError: expected 3 to equal 4
    at TestContext.<anonymous> (src/math.test.ts:5:10)
not ok 3 - should handle timeout
  Error: timed out after 1000ms
    at TestContext.<anonymous> (src/math.test.ts:12:8)
`
    const results = classifyTestRun(output)
    assert.equal(results.length, 2)
    assert.equal(results[0]!.class, 'assertion')
    assert.equal(results[1]!.class, 'timeout')
  })

  it('parses vitest FAIL sections', () => {
    const output = `
FAIL  src/utils/format.test.ts > should format dates
  AssertionError: expected "2024-01-01" to equal "01/01/2024"
  at Context.<anonymous> (src/utils/format.test.ts:15:5)
FAIL  src/utils/math.test.ts > should divide
  error TS2322: Type 'string' is not assignable to type 'number'
`
    const results = classifyTestRun(output)
    assert.equal(results.length, 2)
    assert.equal(results[0]!.class, 'assertion')
    assert.equal(results[1]!.class, 'type_error')
  })
})

describe('isTransient', () => {
  it('returns true for timeout class', () => {
    assert.equal(isTransient('timeout'), true)
  })

  it('returns true for flaky class', () => {
    assert.equal(isTransient('flaky'), true)
  })

  it('returns false for type_error', () => {
    assert.equal(isTransient('type_error'), false)
  })

  it('returns false for assertion', () => {
    assert.equal(isTransient('assertion'), false)
  })

  it('classifies ECONNRESET as transient from raw error text', () => {
    assert.equal(isTransient(classifyFailure('Error: ECONNRESET connection reset').class), true)
  })

  it('marks TypeScript failures as not retryable', () => {
    const result = classifyFailure('error TS2305: Module has no exported member')
    assert.equal(result.class, 'type_error')
    assert.equal(result.retryable, false)
    assert.match(result.suggestion, /fix/i)
  })

  it('marks timeout failures as retryable', () => {
    const result = classifyFailure('Command timed out after 120000ms')
    assert.equal(result.class, 'timeout')
    assert.equal(result.retryable, true)
  })

  it('marks flaky failures as retryable', () => {
    const result = classifyFailure('intermittent flaky test failure')
    assert.equal(result.class, 'flaky')
    assert.equal(result.retryable, true)
  })

  // ── test_red routing (TDD RED must not be penalized) ──

  it('routes assertion failure to test_red when isTestRun', () => {
    const result = classifyFailure('AssertionError: expected 2 but got 1', { isTestRun: true })
    assert.equal(result.class, 'test_red')
  })

  it('keeps assertion class for non-test-run assertion failures', () => {
    const result = classifyFailure('AssertionError: expected 2 but got 1')
    assert.equal(result.class, 'assertion')
  })

  it('test_red does not swallow type errors in test runs', () => {
    // A type error during a test run is a build failure, not a RED.
    const result = classifyFailure('error TS2345: Argument of type ...', { isTestRun: true })
    assert.equal(result.class, 'type_error')
  })
})

describe('isTestRunInvocation', () => {
  it('run_tests tool always counts', () => {
    assert.equal(isTestRunInvocation('run_tests', undefined), true)
  })

  it('bash with test-runner commands counts', () => {
    for (const command of [
      'npm test',
      'npm run test -- --grep foo',
      'pnpm test',
      'npx tsx --test src/agent/__tests__/foo.test.ts',
      'node --test dist/test/',
      'npx vitest run',
      'pytest tests/',
      'go test ./...',
      'cargo test',
    ]) {
      assert.equal(isTestRunInvocation('bash', { command }), true, `should match: ${command}`)
    }
  })

  it('bash with non-test commands does not count', () => {
    for (const command of [
      'npm run build',
      'git status',
      'node script.js --testfile foo', // --testfile ≠ --test
      'ls contest/', // "test" substring inside a word
      'echo latest',
    ]) {
      assert.equal(isTestRunInvocation('bash', { command }), false, `should NOT match: ${command}`)
    }
  })

  it('non-bash tools never count', () => {
    assert.equal(isTestRunInvocation('edit_file', { command: 'npm test' }), false)
  })
})

describe('resolveErrorKind（结构化短路解析）', () => {
  it('errorKind 直读优先', () => {
    assert.equal(resolveErrorKind({ errorKind: 'probe_miss' }), 'probe_miss')
    assert.equal(resolveErrorKind({ errorKind: 'runtime_gate' }), 'runtime_gate')
    assert.equal(resolveErrorKind({ errorKind: 'timeout', errorClass: 'environment' }), 'timeout')
  })

  it('bash errorClass 三态桥接：timeout / environment 映射，exec-failure 不桥接', () => {
    assert.equal(resolveErrorKind({ errorClass: 'timeout' }), 'timeout')
    assert.equal(resolveErrorKind({ errorClass: 'environment' }), 'missing_dep')
    assert.equal(resolveErrorKind({ errorClass: 'exec-failure' }), undefined)
  })

  it('无结构信号返回 undefined', () => {
    assert.equal(resolveErrorKind(undefined), undefined)
    assert.equal(resolveErrorKind({}), undefined)
  })
})

describe('classifyToolFailure（结构优先的工具失败分类）', () => {
  it('工具自报 errorKind 短路文本正则——中文消息不再依赖英文模式', () => {
    const r = classifyToolFailure({ errorKind: 'timeout' }, '测试超时，已终止进程')
    assert.equal(r.class, 'timeout')
    assert.equal(r.confidence, 1)
    assert.equal(r.retryable, true)

    const gate = classifyToolFailure({ errorKind: 'runtime_gate' }, '协调器正在关闭')
    assert.equal(gate.class, 'runtime_gate')
    assert.equal(gate.retryable, false)
  })

  it('结构短路结果与文本分类的 retryable 语义一致', () => {
    const structured = classifyToolFailure({ errorKind: 'type_error' }, '任意文案')
    const textual = classifyFailure("error TS2322: Type 'a' is not assignable")
    assert.equal(structured.class, textual.class)
    assert.equal(structured.retryable, textual.retryable)
  })

  it('无结构信号回退 classifyFailure 文本匹配，行为不变', () => {
    const r = classifyToolFailure(undefined, 'Error: Cannot find module "./foo.js"')
    assert.equal(r.class, 'module_resolution')
    const r2 = classifyToolFailure({}, 'ENOENT: no such file or directory', { isReadProbe: true })
    assert.equal(r2.class, 'probe_miss')
  })
})

// ─── 2026-09-22: api_error 不再吃裸三位数字 ──────────────────────────────────
// 原 /429|500|502|503/ 会命中文本里任何位置，实测 7 个真实工具输出 6 个误报。
// 现场证据：run_tests 报「Missing script: test」，因 npm 日志名含时间戳
// `…T05_03_30_502Z-debug-0.log` 而被注入 `Diagnosis: Transient API error.
// Retry after cooldown.`——把模型引向「等一会儿重试」而非「补 test script」。
describe('classifyFailure — api_error 需要 HTTP 语义上下文（不吃裸数字）', () => {
  // 真实 API 错误文案（取自 src/api 各 client 的构造形状）：仍须识别
  const genuine: [string, string][] = [
    ['OpenAI 风格', 'OpenAI API error (HTTP 502): upstream connect error'],
    ['OpenAI 带 code', 'OpenAI API error (500): internal error'],
    ['Anthropic 风格', 'Anthropic API error (503): overloaded'],
    ['Codex 风格', 'Codex API error (429): rate limited'],
    ['http 前缀', 'GET /models failed with HTTP 503'],
    ['状态码 + 原因短语', 'server responded 502 Bad Gateway'],
    ['status 字段', 'request failed, status: 503'],
    ['纯原因短语', 'Error: rate limit exceeded'],
  ]
  for (const [label, text] of genuine) {
    it(`仍判为 api_error：${label}`, () => {
      assert.equal(classifyFailure(text).class, 'api_error', text)
    })
  }

  // 误报面：这些真实文本里都含 500/502/503/429，但都不是 HTTP 错误
  const falsePositives: [string, string][] = [
    ['npm 日志名时间戳', 'npm error A complete log of this run can be found in: /Users/x/.npm/_logs/2026-09-22T05_03_30_502Z-debug-0.log'],
    ['测试计数 1500', 'ℹ tests 1500\nℹ pass 1499\nℹ fail 1'],
    ['端口 5000', 'server listening on http://127.0.0.1:5000'],
    ['文件大小 502 KB', 'wrote 502 KB to dist/bundle.js'],
    ['git hash', 'commit 5001abc2f'],
    ['耗时 503ms', 'tool took 503ms'],
  ]
  for (const [label, text] of falsePositives) {
    it(`不再误判为 api_error：${label}`, () => {
      assert.notEqual(classifyFailure(text).class, 'api_error', text)
    })
  }

  it('现场原例：缺 npm script 不得被判成 transient API error', () => {
    const content = [
      '退出码：1',
      '0 通过，0 失败，0 跳过',
      'npm error Missing script: "test"',
      'npm error A complete log of this run can be found in: /Users/x/.npm/_logs/2026-09-22T05_03_30_502Z-debug-0.log',
    ].join('\n')
    const result = classifyFailure(content)
    assert.notEqual(result.class, 'api_error')
    assert.ok(
      !/Transient API error/.test(result.suggestion),
      'suggestion 不得把模型引向「等一会儿重试」',
    )
  })
})
