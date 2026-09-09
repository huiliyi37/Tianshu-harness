import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { STAR_DOMAINS } from '../star-domain.js'
import { StarDomainRegistry, starDomainRegistry } from '../star-domain-registry.js'
import { makeTestDir, cleanupTestDir } from '../../tui/__tests__/_test-tmp.js'

const _require = createRequire(import.meta.url)

describe('StarDomainRegistry — built-in domains', () => {
  test('has all built-in domains (count derived from STAR_DOMAINS)', async () => {
    const reg = new StarDomainRegistry()
    assert.equal(reg.getDomainIds().length, Object.keys(STAR_DOMAINS).length)
    for (const id of Object.keys(STAR_DOMAINS) as Array<keyof typeof STAR_DOMAINS>) {
      assert.ok(reg.has(id), `missing built-in domain: ${id}`)
      assert.equal(reg.get(id)!.isCustom, false)
    }
  })

  test('get() returns domain definition with all required fields', async () => {
    const reg = new StarDomainRegistry()
    const tianquan = reg.get('tianquan')
    assert.ok(tianquan)
    assert.equal(tianquan.name, '天权')
    assert.equal(typeof tianquan.systemPromptSuffix, 'string')
    assert.ok(tianquan.systemPromptSuffix.length > 0)
    assert.ok(Array.isArray(tianquan.keywords))
    assert.ok(Array.isArray(tianquan.toolWhitelist))
    assert.ok(tianquan.uiPersona)
    assert.ok(tianquan.uiPersona.glyph)
  })

  test('matchDomain returns correct domain for known keywords', async () => {
    const reg = new StarDomainRegistry()
    // '按计划实现功能' → tianliang scores 2 ('实现'+'按计划')
    assert.equal(reg.matchDomain('按计划实现功能'), 'tianliang')
    // '重构优化性能' → tianfu scores 3 (重构+优化+性能), tianji no longer has 重构
    assert.equal(reg.matchDomain('重构优化性能'), 'tianfu')
  })

  test('resolved former ties: 审查 exclusive to tianquan, 探索 exclusive to pojun', async () => {
    const reg = new StarDomainRegistry()
    // '审查' is now exclusive to tianquan (removed from tianfu)
    assert.equal(reg.matchDomain('审查代码质量'), 'tianquan')
    // '探索' is now exclusive to pojun (removed from tianxuan)
    assert.equal(reg.matchDomain('探索新的可能性'), 'pojun')
  })

  test('matchDomain returns null when no keywords match', async () => {
    const reg = new StarDomainRegistry()
    assert.equal(reg.matchDomain('hello world xyz'), null)
  })

  test('方案 shared between tianquan and tianji — context keywords break tie', async () => {
    const reg = new StarDomainRegistry()
    // '审查方案' → tianquan:2(审查+方案) vs tianji:1(方案) → tianquan
    assert.equal(reg.matchDomain('审查方案'), 'tianquan')
    // '质疑方案' → tianquan:1(方案) vs tianji:2(质疑+方案) → tianji
    assert.equal(reg.matchDomain('质疑方案'), 'tianji')
    // '方案' alone → tianquan:1 vs tianji:1 → tie → null
    assert.equal(reg.matchDomain('这个方案'), null)
  })

  test('matchDomainDetailed — hit exposes keywords in domain-definition order', async () => {
    const reg = new StarDomainRegistry()
    const detail = reg.matchDomainDetailed('重构优化性能')
    assert.equal(detail.verdict, 'hit')
    assert.equal(detail.id, 'tianfu')
    assert.ok(detail.matchedKeywords.includes('重构'))
    assert.ok(detail.matchedKeywords.includes('优化'))
    assert.ok(detail.matchedKeywords.includes('性能'))
    // Domain-definition order: keywords appear in STAR_DOMAINS.tianfu.keywords order
    const defOrder = STAR_DOMAINS.tianfu.keywords.filter(k => detail.matchedKeywords.includes(k))
    assert.deepEqual(detail.matchedKeywords, defOrder)
    // Thin projection stays byte-equivalent
    assert.equal(reg.matchDomain('重构优化性能'), detail.id)
  })

  test('matchDomainDetailed — tie and no-match preserve matchDomain null', async () => {
    const reg = new StarDomainRegistry()
    const tie = reg.matchDomainDetailed('这个方案')
    assert.equal(tie.verdict, 'tie')
    assert.equal(tie.id, null)
    assert.ok(tie.tiedIds && tie.tiedIds.length >= 2)
    assert.deepEqual(tie.tiedIds, [...tie.tiedIds].sort())
    assert.equal(reg.matchDomain('这个方案'), null)

    const miss = reg.matchDomainDetailed('hello world xyz')
    assert.equal(miss.verdict, 'no-match')
    assert.equal(miss.id, null)
    assert.deepEqual(miss.matchedKeywords, [])
    assert.equal(reg.matchDomain('hello world xyz'), null)
  })

  test('matchDomainDetailed — deterministic for same input', async () => {
    const reg = new StarDomainRegistry()
    const a = reg.matchDomainDetailed('审查这个方案')
    const b = reg.matchDomainDetailed('审查这个方案')
    assert.deepEqual(a, b)
  })

  test('list() returns all domains', async () => {
    const reg = new StarDomainRegistry()
    assert.equal(reg.list().length, Object.keys(STAR_DOMAINS).length)
  })
})

describe('StarDomainRegistry — user domain loading', () => {
  const tmpBase = makeTestDir('rivet-domain-reg-test-')

  test('loads a valid user domain from directory', async () => {
    const dir = join(tmpBase, 'test-load')
    mkdirSync(join(dir, 'machao'), { recursive: true })
    writeFileSync(join(dir, 'machao', 'card.md'), [
      '---',
      'name: 马超',
      'motto: 长驱直入，势不可挡',
      'decisionStyle: bold',
      'courageThreshold: 0.2',
      "keywords: ['网络', '渗透', '安全', 'attack', 'network']",
      "toolWhitelist: ['read_file', 'bash', 'grep']",
      'separator: thick',
      'accent: error',
      'glyph: ⚔',
      '---',
      '',
      '你是马超——突击手。快速渗透网络层，发现安全弱点。',
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = await reg.loadFromDirectory(dir)
      assert.equal(errors.length, 0)
      assert.ok(loaded.includes('machao'))

      const machao = reg.get('machao')
      assert.ok(machao)
      assert.equal(machao.name, '马超')
      assert.equal(machao.isCustom, true)
      assert.equal(machao.systemPromptSuffix, '你是马超——突击手。快速渗透网络层，发现安全弱点。')
      assert.deepEqual(machao.keywords, ['网络', '渗透', '安全', 'attack', 'network'])
      assert.equal(machao.uiPersona.glyph, '⚔')
    } finally {
      cleanupTestDir(tmpBase)
    }
  })

  test('rejects override of built-in domain', async () => {
    const dir = join(tmpBase, 'test-override')
    mkdirSync(join(dir, 'tianquan'), { recursive: true })
    writeFileSync(join(dir, 'tianquan', 'card.md'), [
      '---',
      'name: 假天权',
      'motto: fake',
      "keywords: ['fake']",
      "toolWhitelist: ['read_file']",
      '---',
      '',
      'fake suffix',
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = await reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 0)
      assert.equal(errors.length, 1)
      assert.match(errors[0]!, /cannot override built-in/)
      // Original tianquan is intact
      assert.equal(reg.get('tianquan')!.name, '天权')
    } finally {
      cleanupTestDir(tmpBase)
    }
  })

  test('rejects duplicate custom domain id', async () => {
    const dir = join(tmpBase, 'test-dup')
    mkdirSync(join(dir, 'machao'), { recursive: true })
    mkdirSync(join(dir, 'machao2'), { recursive: true })
    const card = [
      '---',
      'name: 马超',
      'motto: 突击',
      "keywords: ['attack']",
      "toolWhitelist: ['read_file']",
      'id: machao',
      '---',
      '',
      'suffix',
    ].join('\n')
    writeFileSync(join(dir, 'machao', 'card.md'), card)
    writeFileSync(join(dir, 'machao2', 'card.md'), card)

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = await reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 1)
      assert.equal(errors.length, 1)
      assert.match(errors[0]!, /duplicate custom domain id/)
    } finally {
      cleanupTestDir(tmpBase)
    }
  })

  test('rejects invalid domain id characters', async () => {
    const dir = join(tmpBase, 'test-bad-id')
    mkdirSync(join(dir, 'BAD DOMAIN!'), { recursive: true })
    writeFileSync(join(dir, 'BAD DOMAIN!', 'card.md'), [
      '---',
      'name: Bad',
      'motto: bad',
      "keywords: ['bad']",
      "toolWhitelist: ['read_file']",
      '---',
      '',
      'suffix',
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = await reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 0)
      assert.equal(errors.length, 1)
      assert.match(errors[0]!, /Invalid domain id/)
    } finally {
      cleanupTestDir(tmpBase)
    }
  })

  test('clamps courageThreshold to [0, 1]', async () => {
    const dir = join(tmpBase, 'test-clamp')
    mkdirSync(join(dir, 'brave'), { recursive: true })
    writeFileSync(join(dir, 'brave', 'card.md'), [
      '---',
      'name: 勇者',
      'motto: brave',
      'courageThreshold: 999',
      "keywords: ['brave']",
      "toolWhitelist: ['read_file']",
      '---',
      '',
      'suffix',
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = await reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 1)
      assert.equal(errors.length, 0)
      assert.equal(reg.get('brave')!.courageThreshold, 1)
    } finally {
      cleanupTestDir(tmpBase)
    }
  })

  test('truncates long systemPromptSuffix to 2000 chars', async () => {
    const dir = join(tmpBase, 'test-truncate')
    mkdirSync(join(dir, 'talker'), { recursive: true })
    writeFileSync(join(dir, 'talker', 'card.md'), [
      '---',
      'name: 话痨',
      'motto: talk',
      "keywords: ['talk']",
      "toolWhitelist: ['read_file']",
      '---',
      '',
      'x'.repeat(3000),
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = await reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 1)
      assert.equal(errors.length, 0)
      assert.equal(reg.get('talker')!.systemPromptSuffix.length, 2000)
    } finally {
      cleanupTestDir(tmpBase)
    }
  })

  test('rejects arrays whose sanitized values are empty', async () => {
    const dir = join(tmpBase, 'test-sanitized-empty')
    mkdirSync(join(dir, 'empty-tools'), { recursive: true })
    writeFileSync(join(dir, 'empty-tools', 'card.md'), [
      '---',
      'name: Empty Tools',
      "keywords: ['valid']",
      "toolWhitelist: ['']",
      '---',
      '',
      'suffix',
    ].join('\n'))
    mkdirSync(join(dir, 'numeric-keywords'), { recursive: true })
    writeFileSync(join(dir, 'numeric-keywords', 'card.md'), [
      '---',
      'name: Numeric Keywords',
      'keywords: [1, 2, 3]',
      "toolWhitelist: ['read_file']",
      '---',
      '',
      'suffix',
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = await reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 0)
      assert.equal(errors.length, 2)
      assert.ok(errors.some(e => e.includes('toolWhitelist must contain')))
      assert.ok(errors.some(e => e.includes('keywords must contain')))
    } finally {
      cleanupTestDir(tmpBase)
    }
  })

  test('reports parse errors gracefully', async () => {
    const dir = join(tmpBase, 'test-error')
    mkdirSync(join(dir, 'bad-domain'), { recursive: true })
    writeFileSync(join(dir, 'bad-domain', 'card.md'), 'not valid yaml at all')

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = await reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 0)
      assert.equal(errors.length, 1)
      assert.match(errors[0]!, /Missing YAML frontmatter/)
    } finally {
      cleanupTestDir(tmpBase)
    }
  })

  test('handles missing directory gracefully', async () => {
    const reg = new StarDomainRegistry()
    const { loaded, errors } = await reg.loadFromDirectory('/nonexistent/path')
    assert.equal(loaded.length, 0)
    assert.equal(errors.length, 0)
  })
})

describe('starDomainRegistry singleton', () => {
  test('is an instance of StarDomainRegistry', async () => {
    assert.ok(starDomainRegistry instanceof StarDomainRegistry)
  })

  test('has the built-in domains (count derived from STAR_DOMAINS)', async () => {
    assert.equal(starDomainRegistry.getDomainIds().length, Object.keys(STAR_DOMAINS).length)
  })
})

// ─── P0-A2 fail-closed: sanitize-then-validate ────────────────
describe('parseDomainCard — P0-A2 fail-closed validation', () => {
  const tmpBase = makeTestDir('rivet-p0a2-test-')

  test('toolWhitelist:[1,2,3] → rejected (all non-string items filtered, empty after sanitize)', async () => {
    const dir = join(tmpBase, 'test-nonstring-wl')
    mkdirSync(join(dir, 'numwhitelist'), { recursive: true })
    // The YAML parser parses [1,2,3] as an array of numbers
    writeFileSync(join(dir, 'numwhitelist', 'card.md'), [
      '---',
      'name: NumberWL',
      'motto: test',
      "keywords: ['test']",
      'toolWhitelist: [1, 2, 3]',
      '---',
      '',
      'suffix',
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = await reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 0, 'should not load domain with non-string toolWhitelist')
      assert.equal(errors.length, 1)
      assert.match(errors[0]!, /toolWhitelist must contain at least one non-empty string/)
    } finally {
      cleanupTestDir(tmpBase)
    }
  })

  test("keywords:[''] → rejected (empty string filtered, no real keywords)", async () => {
    const dir = join(tmpBase, 'test-empty-kw')
    mkdirSync(join(dir, 'emptykw'), { recursive: true })
    writeFileSync(join(dir, 'emptykw', 'card.md'), [
      '---',
      'name: EmptyKW',
      'motto: test',
      "keywords: ['']",
      "toolWhitelist: ['read_file']",
      '---',
      '',
      'suffix',
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = await reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 0, 'should not load domain with empty-string keywords')
      assert.equal(errors.length, 1)
      assert.match(errors[0]!, /keywords must contain at least one non-empty string/)
    } finally {
      cleanupTestDir(tmpBase)
    }
  })

  test("toolWhitelist:[''] → rejected (empty string filtered)", async () => {
    const dir = join(tmpBase, 'test-empty-wl')
    mkdirSync(join(dir, 'emptywl'), { recursive: true })
    writeFileSync(join(dir, 'emptywl', 'card.md'), [
      '---',
      'name: EmptyWL',
      'motto: test',
      "keywords: ['test']",
      "toolWhitelist: ['']",
      '---',
      '',
      'suffix',
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = await reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 0, 'should not load domain with empty-string toolWhitelist')
      assert.equal(errors.length, 1)
      assert.match(errors[0]!, /toolWhitelist must contain at least one non-empty string/)
    } finally {
      cleanupTestDir(tmpBase)
    }
  })
})

// ─── P1-1 matchDomain unified: custom domain visible at runtime ──
describe('P1-1 — custom domain visible to runtime matchDomain', () => {
  test('runtime matchDomain (star-domain.ts delegate) sees custom domain in singleton registry', async () => {
    const tmpBase = makeTestDir('rivet-p11-test-')
    const dir = join(tmpBase, 'test-rt-match')
    mkdirSync(join(dir, 'machao'), { recursive: true })
    writeFileSync(join(dir, 'machao', 'card.md'), [
      '---',
      'name: 马超',
      'motto: 长驱直入',
      "keywords: ['penetration', '渗透', '安全测试']",
      "toolWhitelist: ['read_file', 'bash', 'grep']",
      '---',
      '',
      '突击手',
    ].join('\n'))

    try {
      // Load into the GLOBAL singleton — this is what runtime matchDomain delegates to
      const { loaded } = await starDomainRegistry.loadFromDirectory(dir)
      assert.ok(loaded.includes('machao'))

      // Use dynamic ESM import to get the runtime matchDomain (same as dispatcher.ts uses)
      const { matchDomain: runtimeMatchDomain } = await import('../star-domain.js')

      const match = runtimeMatchDomain('进行网络渗透安全测试')
      assert.equal(match, 'machao', 'runtime matchDomain (star-domain.ts) should see custom domain via registry singleton')
    } finally {
      // Cleanup: remove custom domain so it doesn't leak
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ;(starDomainRegistry as unknown as { domains: Map<string, unknown> }).domains.delete('machao')
      cleanupTestDir(tmpBase)
    }
  })
})
