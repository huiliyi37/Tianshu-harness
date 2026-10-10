import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { containsSensitive, scrubMemoryText } from '../memory-scrub.js'

describe('memory scrub（阶段5安全）', () => {
  it('redacts common credential patterns to ***', () => {
    assert.equal(scrubMemoryText('连接用了 sk-abc123XYZ789opqrs'), '连接用了 ***')
    assert.equal(scrubMemoryText('Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig 失效'), '*** 失效')
    assert.match(scrubMemoryText('password = hunter2hunter2')!, /\*\*\*/)
    assert.equal(containsSensitive('sk-somekey1234567890abcdef'), true)
  })

  it('keeps normal prose untouched', () => {
    assert.equal(scrubMemoryText('实现了意图门控 STM，走 appendixDelta'), '实现了意图门控 STM，走 appendixDelta')
    assert.equal(scrubMemoryText('发现 run_tests 有并发竞争'), '发现 run_tests 有并发竞争')
    assert.equal(containsSensitive('普通文本无凭据'), false)
  })

  it('returns null when the summary is dominated by secrets (drop the entry)', () => {
    assert.equal(scrubMemoryText('sk-aaaaaaaaaaaaaaaaaaaa sk-aaaaaaaaaaaaaaaaaaaa'), null)
  })

  it('redacts extended provider token forms (GitHub/GitLab/HF/Slack/Stripe/Telegram/npm/PyPI)', () => {
    // 全部用 FAKE/TEST 重复字符，绝不用真实密钥。
    // 注：前缀与正文用拼接写法，避免文件中出现连续的"真密钥形态"字面量
    // 触发 GitHub push protection 拦截推送。
    const T = (prefix: string, body: string): string => prefix + body
    const tokens = [
      T('ghp_', 'FAKE'.repeat(10)), // 40 位 ≥ 36
      T('gho_', 'FAKE'.repeat(10)),
      T('ghu_', 'FAKE'.repeat(10)),
      T('ghs_', 'FAKE'.repeat(10)),
      T('ghr_', 'FAKE'.repeat(10)),
      T('glpat-', 'FAKEtest01'.repeat(3)), // 30 位 ≥ 20
      T('hf_', 'FAKEtest0123456789'.repeat(2)), // 36 位 ≥ 30
      T('xoxb-', 'FAKE-1234567890'.repeat(3)), // 45 位 ≥ 10
      T('xoxp-', '1234567890-FAKE'.repeat(3)),
      T('sk_live_', 'FAKEtest12345678'), // 16 位 ≥ 16
      T('rk_live_', 'FAKEtest12345678'),
      '123456789:' + 'FAKEtest1234567890123456789012345', // 33 位 ≥ 30
      T('npm_', 'FAKEtest0123456789'.repeat(2)), // 36 位 ≥ 30
      T('pypi-', 'FAKEtest01'.repeat(3)), // 30 位 ≥ 20
    ]
    for (const token of tokens) {
      assert.equal(containsSensitive(token), true, `should detect: ${token}`)
      const scrubbed = scrubMemoryText(`凭据 ${token} 结束`)
      assert.ok(scrubbed !== null && !scrubbed.includes(token), `should scrub: ${token}`)
    }
  })

  it('does not flag word-boundary lookalikes of the new patterns', () => {
    for (const prose of [
      'the npm_install step failed',
      'call hf_len helper function',
      'timeout was 12:3456789012345678901234567890abcde',
      'prefix glpat-is-not-a-token-here',
      'normal prose about skylines',
      '实现 npm 脚本 与 hf 模块 的正常说明',
    ]) {
      assert.equal(containsSensitive(prose), false, `should not flag: ${prose}`)
      assert.equal(scrubMemoryText(prose), prose, `should stay untouched: ${prose}`)
    }
  })

  // 回归：真实 PEM 头是「类型词 + PRIVATE KEY」，旧正则 `(RSA|EC|OPENSSH|PGP|DSA|PRIVATE) KEY`
  // 期待「类型词 + KEY」，三种最常见私钥头（RSA/OpenSSH/EC）全部漏检；且即便命中头行，
  // base64 主体仍原样留存，漏进长期记忆后跨会话长存。
  describe('private key blocks', () => {
    const BODY_LINE = 'MIIEowIBAAKCAQEAw8Xk2f0dummybase64line0001abcdef'

    const pemBlock = (header: string): string =>
      [`-----BEGIN ${header}-----`, BODY_LINE, 'AQEFAAOCAQ8AMIIBCgKCAQEAmorebase64line002xyz', `-----END ${header}-----`].join('\n')

    for (const header of ['RSA PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'EC PRIVATE KEY', 'DSA PRIVATE KEY', 'PRIVATE KEY', 'PGP PRIVATE KEY BLOCK']) {
      it(`detects and whole-block scrubs ${header}`, () => {
        const block = pemBlock(header)
        assert.equal(containsSensitive(block), true)
        const scrubbed = scrubMemoryText(block)
        assert.ok(scrubbed !== null)
        // 头、尾都不留
        assert.ok(!scrubbed!.includes('-----BEGIN'), 'private key header must not survive')
        assert.ok(!scrubbed!.includes('-----END'), 'private key footer must not survive')
        // 主体 base64 一行都不留
        assert.ok(!scrubbed!.includes(BODY_LINE), 'private key body must not survive')
        assert.ok(!/[A-Za-z0-9+/=]{20,}/.test(scrubbed!), 'no base64 body residue allowed')
        assert.match(scrubbed!, /\*\*\*/)
      })
    }

    it('scrubs a bare header with no END marker (header-only leak)', () => {
      const scrubbed = scrubMemoryText('-----BEGIN RSA PRIVATE KEY-----')
      assert.ok(scrubbed !== null)
      assert.ok(!scrubbed!.includes('-----BEGIN'), 'bare header must not survive')
    })

    it('keeps prose mentioning key types untouched', () => {
      for (const text of [
        'the RSA key is rotated quarterly',
        'OPENSSH key format 与 PEM 的区别',
        '我在讨论 EC key 的生成流程',
        'PGP key block 的解析器有 bug',
      ]) {
        assert.equal(containsSensitive(text), false, `must not flag: ${text}`)
        assert.equal(scrubMemoryText(text), text, `must not alter: ${text}`)
      }
    })
  })
})
