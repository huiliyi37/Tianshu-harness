import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluatePromotion, claimHasFileEvidence, countClaimsByStatus, canRecallClaim } from '../promotion.js'
import type { ContextClaim } from '../claims.js'

function claim(overrides: Partial<ContextClaim> = {}): ContextClaim {
  return {
    id: 'c1',
    kind: 'user_constraint',
    scope: 'session',
    status: 'active',
    text: 'Run tests before claiming done',
    confidence: 0.9,
    fitness: 5,
    source: { actor: 'user', sessionId: 's1', turn: 1, eventId: 'e1' },
    evidence: [{ id: 'e1', kind: 'user_message', summary: 'Run tests', createdAt: 1 }],
    counterevidence: [],
    consumers: [],
    createdAt: 1,
    lastUsedAt: 1,
    tags: ['anchor'],
    ...overrides,
  }
}

describe('evaluatePromotion', () => {
  it('promotes active claims with three prompt consumers and no counterevidence', () => {
    const result = evaluatePromotion(claim({
      consumers: [
        { id: 'turn-1:prompt', kind: 'prompt', usedAt: 1 },
        { id: 'turn-2:prompt', kind: 'prompt', usedAt: 2 },
        { id: 'turn-3:prompt', kind: 'prompt', usedAt: 3 },
      ],
    }), 4)

    assert.equal(result, 'durable_candidate')
  })

  it('does not promote claims with counterevidence or expiry', () => {
    assert.equal(evaluatePromotion(claim({
      counterevidence: [{ id: 'ce1', kind: 'tool_result', summary: 'contradicted', createdAt: 2 }],
      consumers: [
        { id: 'turn-1:prompt', kind: 'prompt', usedAt: 1 },
        { id: 'turn-2:prompt', kind: 'prompt', usedAt: 2 },
        { id: 'turn-3:prompt', kind: 'prompt', usedAt: 3 },
      ],
    }), 4), null)

    assert.equal(evaluatePromotion(claim({
      expiresAt: 4,
      consumers: [
        { id: 'turn-1:prompt', kind: 'prompt', usedAt: 1 },
        { id: 'turn-2:prompt', kind: 'prompt', usedAt: 2 },
        { id: 'turn-3:prompt', kind: 'prompt', usedAt: 3 },
      ],
    }), 4), null)
  })

  it('does not promote with fewer than 3 unique consumers', () => {
    assert.equal(evaluatePromotion(claim({
      consumers: [
        { id: 'turn-1:prompt', kind: 'prompt', usedAt: 1 },
        { id: 'turn-2:prompt', kind: 'prompt', usedAt: 2 },
      ],
    }), 3), null)
  })

  it('does not promote with 4 total but only 2 unique consumers (dedup)', () => {
    assert.equal(evaluatePromotion(claim({
      consumers: [
        { id: 'turn-1:prompt', kind: 'prompt', usedAt: 1 },
        { id: 'turn-1:prompt', kind: 'prompt', usedAt: 2 },  // duplicate consumerId
        { id: 'turn-2:prompt', kind: 'prompt', usedAt: 3 },
        { id: 'turn-2:prompt', kind: 'prompt', usedAt: 4 },  // duplicate consumerId
      ],
    }), 4), null)
  })

  it('does not promote non-active claims', () => {
    assert.equal(evaluatePromotion(claim({
      status: 'stale',
      consumers: [
        { id: 'turn-1:prompt', kind: 'prompt', usedAt: 1 },
        { id: 'turn-2:prompt', kind: 'prompt', usedAt: 2 },
        { id: 'turn-3:prompt', kind: 'prompt', usedAt: 3 },
      ],
    }), 4), null)
  })

  it('promotes durable_candidate to durable after 5+ consumers and 10+ minutes', () => {
    const result = evaluatePromotion(claim({
      status: 'durable_candidate',
      consumers: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, kind: 'prompt' as const, usedAt: Date.now() - 600_001 })),
      createdAt: Date.now() - 600_001,
      counterevidence: [],
    }))
    assert.equal(result, 'durable')
  })

  it('does not promote durable_candidate with fewer than 5 consumers', () => {
    const result = evaluatePromotion(claim({
      status: 'durable_candidate',
      consumers: [{ id: 'c1', kind: 'prompt' as const, usedAt: Date.now() }],
      createdAt: Date.now() - 600_001,
      counterevidence: [],
    }))
    assert.equal(result, null)
  })

  it('does not promote durable_candidate younger than 10 minutes', () => {
    const result = evaluatePromotion(claim({
      status: 'durable_candidate',
      consumers: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, kind: 'prompt' as const, usedAt: Date.now() })),
      createdAt: Date.now() - 100,
      counterevidence: [],
    }))
    assert.equal(result, null)
  })

  it('does not promote durable_candidate with counterevidence', () => {
    const result = evaluatePromotion(claim({
      status: 'durable_candidate',
      consumers: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, kind: 'prompt' as const, usedAt: Date.now() - 600_001 })),
      createdAt: Date.now() - 600_001,
      counterevidence: [{ id: 'ce1', kind: 'tool_result', summary: 'contradicted', createdAt: 2 }],
    }))
    assert.equal(result, null)
  })
})

describe('claimHasFileEvidence', () => {
  it('matches file evidence by path', () => {
    const observed = claim({
      kind: 'file_observation',
      evidence: [{ id: 'f1', kind: 'file', summary: 'read config', path: '/repo/src/config.ts', createdAt: 1 }],
    })

    assert.equal(claimHasFileEvidence(observed, '/repo/src/config.ts'), true)
    assert.equal(claimHasFileEvidence(observed, '/repo/src/other.ts'), false)
  })

  it('matches verification_fact claims too', () => {
    const vf = claim({
      kind: 'verification_fact',
      evidence: [{ id: 'v1', kind: 'test', summary: 'test passed', path: '/repo/src/a.test.ts', createdAt: 1 }],
    })

    assert.equal(claimHasFileEvidence(vf, '/repo/src/a.test.ts'), true)
  })

  it('returns false for non-file-evidence claim kinds', () => {
    const uc = claim({ kind: 'user_constraint', evidence: [{ id: 'e1', kind: 'user_message', summary: 'x', path: '/a.ts', createdAt: 1 }] })
    assert.equal(claimHasFileEvidence(uc, '/a.ts'), false)
  })
})

describe('canRecallClaim', () => {
  it('returns true when cwd is not provided (skip recall check)', () => {
    const c = claim({
      evidence: [{ id: 'e1', kind: 'file', summary: 'gone', path: '/nonexistent/file.ts', createdAt: 1 }],
    })
    assert.equal(canRecallClaim(c), true)
  })

  it('returns true when claim has no file evidence', () => {
    const c = claim({
      evidence: [{ id: 'e1', kind: 'user_message', summary: 'just text', createdAt: 1 }],
    })
    assert.equal(canRecallClaim(c, '/any/cwd'), true)
  })

  it('returns false when all evidence files no longer exist', () => {
    const c = claim({
      evidence: [{ id: 'e1', kind: 'file', summary: 'deleted', path: 'nonexistent_abc123.ts', createdAt: 1 }],
    })
    assert.equal(canRecallClaim(c, '/tmp'), false)
  })

  it('returns true when at least one evidence file still exists', () => {
    // 同 #144 的路径反模式：`new URL(...).pathname` 在 Windows 上带前导斜杠（`/D:/...`），
    // 与本地路径拼接会变成 `D:\D:\...`。改用 fileURLToPath，跨平台一致。
    const testDir = dirname(fileURLToPath(import.meta.url))
    const testFile = 'promotion.test.ts'
    const c = claim({
      evidence: [
        { id: 'e1', kind: 'file', summary: 'deleted', path: 'nonexistent_xyz.ts', createdAt: 1 },
        { id: 'e2', kind: 'file', summary: 'exists', path: testFile, createdAt: 1 },
      ],
    })
    assert.equal(canRecallClaim(c, testDir), true)
  })
})

describe('countClaimsByStatus', () => {
  it('counts claims by lifecycle status', () => {
    assert.deepEqual(countClaimsByStatus([
      claim({ id: 'a', status: 'active' }),
      claim({ id: 's', status: 'stale' }),
      claim({ id: 'd', status: 'durable' }),
      claim({ id: 'c', status: 'conflicted' }),
    ]), { active: 1, stale: 1, conflicted: 1, durable: 1, durableCandidate: 0, quarantined: 0, recallBlocked: 0 })
  })

  it('returns zeros for empty array', () => {
    assert.deepEqual(countClaimsByStatus([]), { active: 0, stale: 0, conflicted: 0, durable: 0, durableCandidate: 0, quarantined: 0, recallBlocked: 0 })
  })
})
