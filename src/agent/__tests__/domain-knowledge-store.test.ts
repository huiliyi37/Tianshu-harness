import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DomainKnowledgeStore, type DomainLesson } from '../domain-knowledge-store.js'

const TMP = join(tmpdir(), `rivet-domain-kb-test-${Date.now()}`)

function makeStore(): DomainKnowledgeStore {
  mkdirSync(TMP, { recursive: true })
  return new DomainKnowledgeStore(TMP)
}

function cleanup() {
  rmSync(TMP, { recursive: true, force: true })
}

describe('DomainKnowledgeStore — deposit & recall', () => {
  test('deposit creates a new lesson', () => {
    const store = makeStore()
    try {
      store.deposit({
        domainId: 'tianquan',
        kind: 'defect_pattern',
        text: '这个库的缺陷常长在输入边界',
        evidence: 'src/parser.ts:42',
      })
      store.flushSync()

      const lessons = store.recall('tianquan', 10)
      assert.equal(lessons.length, 1)
      assert.equal(lessons[0]!.text, '这个库的缺陷常长在输入边界')
      assert.equal(lessons[0]!.kind, 'defect_pattern')
      assert.equal(lessons[0]!.grade, 'novice')
      assert.equal(lessons[0]!.reinforcement, 1)
    } finally {
      cleanup()
    }
  })

  test('deposit deduplicates and reinforces', () => {
    const store = makeStore()
    try {
      store.deposit({ domainId: 'tianquan', kind: 'defect_pattern', text: '边界检查缺失', evidence: 'a.ts:1' })
      store.deposit({ domainId: 'tianquan', kind: 'defect_pattern', text: '边界检查缺失', evidence: 'b.ts:2' })
      store.flushSync()

      const lessons = store.recall('tianquan', 10)
      assert.equal(lessons.length, 1)
      assert.equal(lessons[0]!.reinforcement, 2)
      assert.equal(lessons[0]!.grade, 'journeyman')
      assert.equal(lessons[0]!.evidence, 'b.ts:2') // updated evidence
    } finally {
      cleanup()
    }
  })

  test('recall returns empty for unknown domain', () => {
    const store = makeStore()
    try {
      const lessons = store.recall('nonexistent', 10)
      assert.deepEqual(lessons, [])
    } finally {
      cleanup()
    }
  })

  test('recall respects topK limit', () => {
    const store = makeStore()
    try {
      for (let i = 0; i < 10; i++) {
        store.deposit({ domainId: 'pojun', kind: 'adversarial_input', text: `input ${i}`, evidence: `e${i}` })
      }
      store.flushSync()

      const lessons = store.recall('pojun', 3)
      assert.equal(lessons.length, 3)
    } finally {
      cleanup()
    }
  })

  test('recall sorts by grade×strength desc', () => {
    const store = makeStore()
    try {
      // Create a novice lesson
      store.deposit({ domainId: 'tianfu', kind: 'invariant', text: 'novice lesson', evidence: 'a' })
      // Create an expert lesson by reinforcing 4 times
      for (let i = 0; i < 4; i++) {
        store.deposit({ domainId: 'tianfu', kind: 'invariant', text: 'expert lesson', evidence: 'b' })
      }
      store.flushSync()

      const lessons = store.recall('tianfu', 10)
      assert.equal(lessons.length, 2)
      assert.equal(lessons[0]!.text, 'expert lesson')
      assert.equal(lessons[0]!.grade, 'expert')
      assert.equal(lessons[1]!.text, 'novice lesson')
      assert.equal(lessons[1]!.grade, 'novice')
    } finally {
      cleanup()
    }
  })

  test('text is truncated to 200 chars', () => {
    const store = makeStore()
    try {
      store.deposit({ domainId: 'pojun', kind: 'adversarial_input', text: 'x'.repeat(300), evidence: 'e' })
      store.flushSync()

      const lessons = store.recall('pojun', 10)
      assert.equal(lessons[0]!.text.length, 200)
    } finally {
      cleanup()
    }
  })

  test('empty text is rejected', () => {
    const store = makeStore()
    try {
      store.deposit({ domainId: 'pojun', kind: 'adversarial_input', text: '   ', evidence: 'e' })
      store.flushSync()

      const lessons = store.recall('pojun', 10)
      assert.equal(lessons.length, 0)
    } finally {
      cleanup()
    }
  })
})

describe('DomainKnowledgeStore — persistence', () => {
  test('flushSync writes to disk', () => {
    const store = makeStore()
    try {
      store.deposit({ domainId: 'tianquan', kind: 'selection_rule', text: 'review early', evidence: 'spec.md' })
      store.flushSync()

      const path = join(TMP, 'domains', 'tianquan.jsonl')
      assert.ok(existsSync(path))
      const raw = readFileSync(path, 'utf-8')
      assert.ok(raw.includes('review early'))
    } finally {
      cleanup()
    }
  })

  test('lessons survive reload', () => {
    const store = makeStore()
    try {
      store.deposit({ domainId: 'tianliang', kind: 'invariant', text: 'always test', evidence: 'test.ts' })
      store.flushSync()

      // New store instance reads from same dir
      const store2 = new DomainKnowledgeStore(TMP)
      const lessons = store2.recall('tianliang', 10)
      assert.equal(lessons.length, 1)
      assert.equal(lessons[0]!.text, 'always test')
    } finally {
      cleanup()
    }
  })

  test('listDomainIds returns domains with files', () => {
    const store = makeStore()
    try {
      store.deposit({ domainId: 'pojun', kind: 'adversarial_input', text: 'test', evidence: 'e' })
      store.deposit({ domainId: 'tianfu', kind: 'invariant', text: 'test2', evidence: 'e' })
      store.flushSync()

      const ids = store.listDomainIds()
      assert.ok(ids.includes('pojun'))
      assert.ok(ids.includes('tianfu'))
      assert.ok(!ids.includes('tianquan'))
    } finally {
      cleanup()
    }
  })
})

describe('DomainKnowledgeStore — persistence guards', () => {
  test('bad JSONL lines are skipped during reload', () => {
    const store = makeStore()
    try {
      mkdirSync(join(TMP, 'domains'), { recursive: true })
      writeFileSync(join(TMP, 'domains', 'tianquan.jsonl'), [
        '{bad json',
        JSON.stringify({
          id: 'good-lesson',
          domainId: 'tianquan',
          kind: 'selection_rule',
          text: 'keep valid lessons',
          evidence: 'manual fixture',
          strength: 0.7,
          reinforcement: 2,
          grade: 'journeyman',
          depositedAt: Date.now(),
          halfLifeMs: 604_800_000,
        }),
      ].join('\n') + '\n')

      const reloaded = new DomainKnowledgeStore(TMP)
      const lessons = reloaded.recall('tianquan', 10)
      assert.equal(lessons.length, 1)
      assert.equal(lessons[0]!.text, 'keep valid lessons')
    } finally {
      cleanup()
    }
  })

  test('invalid domain ids cannot traverse persistence paths', () => {
    const store = makeStore()
    try {
      store.deposit({ domainId: '../../escape', kind: 'reframe', text: 'must not escape', evidence: 'fault-injection' })
      store.flushSync()

      assert.equal(existsSync(join(TMP, 'domains', '..', '..', 'escape.jsonl')), false)
      assert.equal(store.recall('../../escape', 10).length, 0)
      assert.equal(store.compact('../../escape'), 0)
    } finally {
      cleanup()
    }
  })

  test('deposit redacts credentials before persistence', () => {
    const store = makeStore()
    try {
      store.deposit({
        domainId: 'tianquan',
        kind: 'defect_pattern',
        text: 'failed with api_key=abc123 and sk-secretvalue123456',
        evidence: 'Authorization: Bearer token.secret.value password=hunter2',
      })
      store.flushSync()

      const raw = readFileSync(join(TMP, 'domains', 'tianquan.jsonl'), 'utf-8')
      assert.ok(!raw.includes('abc123'))
      assert.ok(!raw.includes('sk-secretvalue123456'))
      assert.ok(!raw.includes('token.secret.value'))
      assert.ok(!raw.includes('hunter2'))
      assert.ok(raw.includes('api_key=[redacted]'))
      assert.ok(raw.includes('sk-xxx'))
      assert.ok(raw.includes('Bearer [redacted]'))
      assert.ok(raw.includes('password=[redacted]'))
    } finally {
      cleanup()
    }
  })

  test('lock timeout fails closed and keeps dirty data retryable', () => {
    const store = makeStore()
    try {
      mkdirSync(join(TMP, 'domains'), { recursive: true })
      writeFileSync(join(TMP, 'domains', 'pojun.jsonl.lock'), String(process.pid))

      store.deposit({ domainId: 'pojun', kind: 'adversarial_input', text: 'retry after lock timeout', evidence: 'fault-injection' })
      assert.doesNotThrow(() => store.flushSync())
      assert.equal(existsSync(join(TMP, 'domains', 'pojun.jsonl')), false)

      unlinkSync(join(TMP, 'domains', 'pojun.jsonl.lock'))
      store.flushSync()

      const raw = readFileSync(join(TMP, 'domains', 'pojun.jsonl'), 'utf-8')
      assert.ok(raw.includes('retry after lock timeout'))
    } finally {
      cleanup()
    }
  })

  test('dead-pid stale locks are recovered without losing dirty data', () => {
    const store = makeStore()
    try {
      mkdirSync(join(TMP, 'domains'), { recursive: true })
      writeFileSync(join(TMP, 'domains', 'tianji.jsonl.lock'), '999999999')

      store.deposit({ domainId: 'tianji', kind: 'reframe', text: 'recover stale lock', evidence: 'fault-injection' })
      store.flushSync()

      const raw = readFileSync(join(TMP, 'domains', 'tianji.jsonl'), 'utf-8')
      assert.ok(raw.includes('recover stale lock'))
      assert.equal(existsSync(join(TMP, 'domains', 'tianji.jsonl.lock')), false)
    } finally {
      cleanup()
    }
  })

  test('filesystem write failure does not throw and keeps dirty data retryable', () => {
    const store = makeStore()
    try {
      mkdirSync(join(TMP, 'domains', 'tianxuan.jsonl'), { recursive: true })

      store.deposit({ domainId: 'tianxuan', kind: 'reframe', text: 'retry after write failure', evidence: 'fault-injection' })
      assert.doesNotThrow(() => store.flushSync())
      assert.equal(existsSync(join(TMP, 'domains', 'tianxuan.jsonl', '.domain-does-not-matter')), false)

      rmSync(join(TMP, 'domains', 'tianxuan.jsonl'), { recursive: true, force: true })
      store.flushSync()

      const raw = readFileSync(join(TMP, 'domains', 'tianxuan.jsonl'), 'utf-8')
      assert.ok(raw.includes('retry after write failure'))
    } finally {
      cleanup()
    }
  })

  test('debounced background flush failure does not crash and stays retryable', async () => {
    const store = makeStore()
    try {
      mkdirSync(join(TMP, 'domains', 'tianliang.jsonl'), { recursive: true })

      store.deposit({ domainId: 'tianliang', kind: 'invariant', text: 'retry after background write failure', evidence: 'fault-injection' })
      await new Promise(resolve => setTimeout(resolve, 250))
      assert.equal(existsSync(join(TMP, 'domains', 'tianliang.jsonl', '.domain-does-not-matter')), false)

      rmSync(join(TMP, 'domains', 'tianliang.jsonl'), { recursive: true, force: true })
      store.flushSync()

      const raw = readFileSync(join(TMP, 'domains', 'tianliang.jsonl'), 'utf-8')
      assert.ok(raw.includes('retry after background write failure'))
    } finally {
      cleanup()
    }
  })

  test('concurrent stores merge lessons without losing prior disk updates', () => {
    const storeA = makeStore()
    const storeB = new DomainKnowledgeStore(TMP)
    try {
      storeA.deposit({ domainId: 'tianfu', kind: 'invariant', text: 'lesson from A', evidence: 'a.ts:1' })
      storeB.deposit({ domainId: 'tianfu', kind: 'invariant', text: 'lesson from B', evidence: 'b.ts:1' })
      storeA.flushSync()
      storeB.flushSync()

      const reloaded = new DomainKnowledgeStore(TMP)
      const texts = reloaded.recall('tianfu', 10).map(l => l.text)
      assert.ok(texts.includes('lesson from A'))
      assert.ok(texts.includes('lesson from B'))
    } finally {
      cleanup()
    }
  })

  test('deposit auto-compacts domains beyond max retained lessons', () => {
    const store = makeStore()
    try {
      for (let i = 0; i < 105; i++) {
        store.deposit({ domainId: 'tianquan', kind: 'defect_pattern', text: `bulk lesson ${i}`, evidence: `e${i}` })
      }
      store.flushSync()

      const reloaded = new DomainKnowledgeStore(TMP)
      const lessons = reloaded.recall('tianquan', 200)
      assert.equal(lessons.length, 100)
    } finally {
      cleanup()
    }
  })
})

describe('DomainKnowledgeStore — compact', () => {
  test('compact prunes decayed lessons', () => {
    const store = makeStore()
    try {
      // Persist first, then age only the synthetic JSON fixture. A 1ms half-life
      // before flushSync lets its own compaction remove the lesson during I/O.
      store.deposit({ domainId: 'tianji', kind: 'reframe', text: 'old insight', evidence: 'e' })
      store.deposit({ domainId: 'tianji', kind: 'reframe', text: 'fresh insight', evidence: 'fresh' })
      store.flushSync()
      const path = join(TMP, 'domains', 'tianji.jsonl')
      const persisted = readFileSync(path, 'utf-8').trim().split('\n').map(line => JSON.parse(line) as DomainLesson)
      assert.equal(persisted.length, 2)
      const old = persisted.find(lesson => lesson.text === 'old insight')!
      assert.ok(old)
      old.depositedAt = Date.now() - 1_000
      old.halfLifeMs = 1
      writeFileSync(path, persisted.map(lesson => JSON.stringify(lesson)).join('\n') + '\n')

      const agedStore = new DomainKnowledgeStore(TMP)
      const lessons = agedStore.recall('tianji', 10)
      assert.ok(lessons.length >= 1)
      assert.ok(lessons.some(lesson => lesson.text === 'old insight'))
      const pruned = agedStore.compact('tianji')
      assert.ok(typeof pruned === 'number')
      assert.equal(pruned, 1)
      assert.deepEqual(agedStore.recall('tianji', 10).map(lesson => lesson.text), ['fresh insight'])
      agedStore.flushSync()
      assert.deepEqual(new DomainKnowledgeStore(TMP).recall('tianji', 10).map(lesson => lesson.text), ['fresh insight'])
    } finally {
      cleanup()
    }
  })

  test('compact caps at MAX_PER_DOMAIN', () => {
    const store = makeStore()
    try {
      // This test verifies the cap logic exists; MAX_PER_DOMAIN=100 is too high to test directly
      for (let i = 0; i < 10; i++) {
        store.deposit({ domainId: 'tianquan', kind: 'defect_pattern', text: `lesson ${i}`, evidence: `e${i}` })
      }
      store.flushSync()

      const pruned = store.compact('tianquan')
      assert.equal(pruned, 0) // 10 < 100, nothing pruned
    } finally {
      cleanup()
    }
  })
})

describe('DomainKnowledgeStore — grade progression', () => {
  test('novice → journeyman → expert', () => {
    const store = makeStore()
    try {
      store.deposit({ domainId: 'tianquan', kind: 'selection_rule', text: 'rule', evidence: 'e' })
      assert.equal(store.recall('tianquan', 1)[0]!.grade, 'novice')

      store.deposit({ domainId: 'tianquan', kind: 'selection_rule', text: 'rule', evidence: 'e' })
      assert.equal(store.recall('tianquan', 1)[0]!.grade, 'journeyman')

      store.deposit({ domainId: 'tianquan', kind: 'selection_rule', text: 'rule', evidence: 'e' })
      store.deposit({ domainId: 'tianquan', kind: 'selection_rule', text: 'rule', evidence: 'e' })
      assert.equal(store.recall('tianquan', 1)[0]!.grade, 'expert')
    } finally {
      cleanup()
    }
  })
})
