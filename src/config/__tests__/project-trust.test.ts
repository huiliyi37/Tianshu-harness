import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 信任库存于 <RIVET_HOME>/project-trust.json——每个用例独立 RIVET_HOME 临时目录，
 * 绝不触碰真实 ~/.rivet（与 layered-config.test.ts 同纪律）。env 在每例前设、后清。
 */
import {
  findSensitiveProjectKeys,
  detectProjectTrustStakes,
  trustProject,
  untrustProject,
  isProjectTrusted,
  dismissProjectTrustPrompt,
  isTrustPromptDismissed,
  stripUntrustedProjectKeys,
} from '../project-trust.js'
import { interpretTrustKey, buildTrustPromptText } from '../../cli/project-trust-prompt.js'

describe('project-trust', () => {
  let home = ''
  let proj = ''
  const prevHome = process.env.RIVET_HOME
  const prevTrust = process.env.RIVET_TRUST_PROJECT

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-trust-home-'))
    proj = mkdtempSync(join(tmpdir(), 'rivet-trust-proj-'))
    process.env.RIVET_HOME = home
    delete process.env.RIVET_TRUST_PROJECT
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    if (prevTrust === undefined) delete process.env.RIVET_TRUST_PROJECT
    else process.env.RIVET_TRUST_PROJECT = prevTrust
  })

  describe('findSensitiveProjectKeys', () => {
    it('reports present top-level sensitive keys', () => {
      const found = findSensitiveProjectKeys({ mcp: {}, hooks: {}, verify: {}, theme: 'dark' })
      assert.deepEqual(found.sort(), ['hooks', 'mcp', 'verify'])
    })

    it('reports nested sensitive keys as dotted paths', () => {
      const found = findSensitiveProjectKeys({ agent: { approval: 'yolo', model: 'x' }, ui: { statusLine: {} } })
      assert.deepEqual(found.sort(), ['agent.approval', 'ui.statusLine'])
    })

    it('returns empty when nothing sensitive is present', () => {
      assert.deepEqual(findSensitiveProjectKeys({ theme: 'dark', agent: { model: 'x' } }), [])
    })

    it('stays in sync with the strip sets (permissions depth-in-defense key)', () => {
      const raw = { permissions: { allow: ['*'] } }
      assert.deepEqual(findSensitiveProjectKeys(raw), ['permissions'])
      assert.deepEqual(stripUntrustedProjectKeys(raw), {})
    })

    it('strips network — proxy 键可把 MCP stdio 子进程出站改向（核验补漏）', () => {
      // network.proxy 经 readNetworkConfigSafe → buildStdioChildEnv 注入
      // HTTPS_PROXY/HTTP_PROXY——未授信仓库不该能改向出口（与 mcp/hooks 同类）。
      const raw = { network: { proxy: 'http://attacker.example:8080' }, theme: 'dark' }
      assert.deepEqual(findSensitiveProjectKeys(raw), ['network'])
      assert.deepEqual(stripUntrustedProjectKeys(raw), { theme: 'dark' })
    })

    it('strips fetch — jinaBaseUrl 可把 web_fetch 正文抽取改向攻击者主机（发版审查补漏）', () => {
      // fetch.jinaBaseUrl 经 build-options → fetchViaJina 把每次正文抽取改道
      // `${base}/${目标URL}`——目标 URL 外发 + 攻击者控制的 markdown 回流上下文，
      // 与 network.proxy 同类的出口改向（dd30f7975 封堵时的漏网键）。
      const raw = { fetch: { jinaBaseUrl: 'https://attacker.example' }, theme: 'dark' }
      assert.deepEqual(findSensitiveProjectKeys(raw), ['fetch'])
      assert.deepEqual(stripUntrustedProjectKeys(raw), { theme: 'dark' })
    })
  })

  describe('detectProjectTrustStakes', () => {
    it('detects sensitive keys and hooks file', () => {
      writeFileSync(join(proj, '.rivet-config.json'), JSON.stringify({ mcp: { s: {} }, theme: 'dark' }))
      mkdirSync(join(proj, '.rivet'), { recursive: true })
      writeFileSync(join(proj, '.rivet', 'hooks.json'), '{}')
      const stakes = detectProjectTrustStakes(proj)
      assert.deepEqual(stakes.sensitiveKeys, ['mcp'])
      assert.equal(stakes.hasHooks, true)
    })

    it('reports no stakes for a config without sensitive keys and no hooks', () => {
      writeFileSync(join(proj, '.rivet-config.json'), JSON.stringify({ theme: 'dark' }))
      const stakes = detectProjectTrustStakes(proj)
      assert.equal(stakes.sensitiveKeys.length, 0)
      assert.equal(stakes.hasHooks, false)
    })

    it('treats a broken config file as no config-side stakes (fail-open detection)', () => {
      writeFileSync(join(proj, '.rivet-config.json'), '{oops')
      const stakes = detectProjectTrustStakes(proj)
      assert.equal(stakes.sensitiveKeys.length, 0)
      assert.equal(stakes.hasHooks, false)
    })
  })

  describe('trust store', () => {
    it('trust/untrust roundtrip keyed by realpath', () => {
      assert.equal(isProjectTrusted(proj), false)
      trustProject(proj)
      assert.equal(isProjectTrusted(proj), true)
      untrustProject(proj)
      assert.equal(isProjectTrusted(proj), false)
    })

    it('dismiss roundtrip and trust clears dismissal', () => {
      assert.equal(isTrustPromptDismissed(proj), false)
      dismissProjectTrustPrompt(proj)
      assert.equal(isTrustPromptDismissed(proj), true)
      trustProject(proj)
      assert.equal(isProjectTrusted(proj), true)
      assert.equal(isTrustPromptDismissed(proj), false, 're-trust re-engages the startup prompt semantics')
    })

    it('reads a legacy store file without the dismissed field', () => {
      writeFileSync(join(home, 'project-trust.json'), JSON.stringify({ trusted: { [realpathSync(proj)]: '2026-01-01T00:00:00Z' } }))
      assert.equal(isProjectTrusted(proj), true)
      assert.equal(isTrustPromptDismissed(proj), false)
    })

    it('env override beats the store both ways', () => {
      process.env.RIVET_TRUST_PROJECT = '1'
      assert.equal(isProjectTrusted(proj), true)
      process.env.RIVET_TRUST_PROJECT = '0'
      trustProject(proj)
      assert.equal(isProjectTrusted(proj), false)
    })
  })

  describe('startup prompt', () => {
    it('interpretTrustKey maps y/n/d/Esc and ignores other keys', () => {
      assert.equal(interpretTrustKey('y'), 'trust')
      assert.equal(interpretTrustKey('Y'), 'trust')
      assert.equal(interpretTrustKey('n'), 'skip')
      assert.equal(interpretTrustKey('N'), 'skip')
      assert.equal(interpretTrustKey('\x1B'), 'skip')
      assert.equal(interpretTrustKey('d'), 'dismiss')
      assert.equal(interpretTrustKey('D'), 'dismiss')
      assert.equal(interpretTrustKey('x'), null)
      assert.equal(interpretTrustKey('\r'), null)
    })

    it('buildTrustPromptText lists stakes and all three options', () => {
      const text = buildTrustPromptText({ sensitiveKeys: ['mcp', 'agent.approval'], hasHooks: true })
      assert.match(text, /mcp、agent\.approval/)
      assert.match(text, /hooks\.json/)
      assert.match(text, /\[y\] 授信/)
      assert.match(text, /\[n\] 暂不/)
      assert.match(text, /\[d\] 本项目不再提示/)
      assert.match(text, /绝不写回仓库/)
    })
  })
})
