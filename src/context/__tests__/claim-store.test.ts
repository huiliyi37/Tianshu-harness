import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextClaimStore } from '../claim-store.js'
import type { ClaimProposal } from '../claims.js'
import { SessionPersist } from '../../agent/session-persist.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-claims-'))
}

function proposal(text = 'Do not repeat failed Read calls'): ClaimProposal {
  return {
    kind: 'user_constraint',
    scope: 'session',
    text,
    confidence: 0.9,
    fitness: 5,
    source: { actor: 'user', sessionId: 'session-123', turn: 1, eventId: 'turn-1:user-input' },
    evidence: [{ id: 'e1', kind: 'user_message', summary: text, createdAt: 10 }],
    createdAt: 10,
    tags: ['anchor', 'user_constraint'],
  }
}

test('proposes a claim by appending a JSONL event and projecting current claims', async () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')

    const claim = store.propose(proposal())
    const claims = store.listClaims()

    assert.equal(claim.status, 'active')
    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.text, 'Do not repeat failed Read calls')

    await store.flushWrites() // write-behind：原始文件断言前先排空写链
    const raw = readFileSync(store.path, 'utf-8')
    assert.match(raw, /"type":"claim_proposed"/)
    assert.match(raw, /Do not repeat failed Read calls/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replays claim status transitions from JSONL', async () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const claim = store.propose(proposal())

    store.updateClaimStatus(claim.id, 'stale', 'evidence expired')

    await store.flushWrites() // write-behind：重载前先排空写链
    const reloaded = new ContextClaimStore(dir, 'session-123')
    const claims = reloaded.listClaims()

    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.status, 'stale')
    assert.equal(claims[0]?.counterevidence[0]?.summary, 'evidence expired')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('proposing the same semantic claim is idempotent and preserves status transitions', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const first = store.propose(proposal('Always run tests before done'))
    store.updateClaimStatus(first.id, 'quarantined', 'superseded by counterevidence')
    const repeated = store.propose({
      ...proposal('  always   run tests BEFORE done  '),
      source: { actor: 'user', sessionId: 'session-123', turn: 2, eventId: 'turn-2:user-input' },
      evidence: [{ id: 'e2', kind: 'user_message', summary: 'Always run tests before done', createdAt: 20 }],
      createdAt: 20,
    })

    assert.equal(repeated.id, first.id)
    assert.equal(store.listClaims().length, 1)
    assert.equal(store.listClaims()[0]?.status, 'quarantined')
    assert.equal(store.exportSession().match(/claim_proposed/g)?.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('filters active claims and excludes quarantined claims', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const active = store.propose(proposal('Keep this active'))
    const quarantined = store.propose(proposal('Do not project this'))
    store.updateClaimStatus(quarantined.id, 'quarantined', 'counter evidence')

    const activeClaims = store.listActiveClaims()

    assert.deepEqual(activeClaims.map(c => c.id), [active.id])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('cached projections are invalidated after appended events', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const claim = store.propose(proposal('Cache this claim'))

    assert.equal(store.listClaims()[0]?.status, 'active')
    store.updateClaimStatus(claim.id, 'stale', 'cache must refresh')

    const claims = store.listClaims()
    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.status, 'stale')
    assert.equal(claims[0]?.counterevidence[0]?.summary, 'cache must refresh')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('active claim listing excludes expired claims at the supplied time', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const durable = store.propose(proposal('Keep this claim'))
    const expired = store.propose({ ...proposal('Drop this expired claim'), expiresAt: 20 })

    assert.deepEqual(store.listActiveClaims(19).map(c => c.id), [durable.id, expired.id])
    assert.deepEqual(store.listActiveClaims(20).map(c => c.id), [durable.id])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ignores invalid JSONL lines while preserving valid events', async () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const claim = store.propose(proposal())
    await store.flushWrites() // write-behind：落盘后再注入坏行
    writeFileSync(store.path, `${readFileSync(store.path, 'utf-8')}not json\n`, 'utf-8')

    const reloaded = new ContextClaimStore(dir, 'session-123')

    assert.equal(reloaded.listClaims()[0]?.id, claim.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('records prompt consumers without changing prompt eligibility', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const claim = store.propose(proposal())

    store.recordClaimUsed(claim.id, {
      consumerId: 'turn-2:prompt',
      consumerKind: 'prompt',
      usedAt: 20,
    })

    const [used] = store.listActiveClaims()
    assert.equal(used?.lastUsedAt, 20)
    assert.deepEqual(used?.consumers, [{ id: 'turn-2:prompt', kind: 'prompt', usedAt: 20 }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lists claims with file evidence and summarizes lifecycle statuses', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const fileClaim = store.propose({
      ...proposal('Observed config'),
      kind: 'file_observation',
      evidence: [{ id: 'f1', kind: 'file', summary: 'config', path: '/repo/src/config.ts', createdAt: 10 }],
    })
    const active = store.propose(proposal('Keep active'))
    store.updateClaimStatus(active.id, 'durable', 'user confirmed')

    assert.deepEqual(store.listClaimsByFileEvidence('/repo/src/config.ts').map(c => c.id), [fileClaim.id])
    assert.deepEqual(store.getStatusCounts(), {
      active: 1,
      stale: 0,
      conflicted: 0,
      durable: 1,
      durableCandidate: 0,
      quarantined: 0,
      recallBlocked: 0,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('promotes eligible claims by appending status transition events', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const claim = store.propose(proposal('Project this claim repeatedly'))
    for (const turn of [1, 2, 3]) {
      store.recordClaimUsed(claim.id, { consumerId: `turn-${turn}:prompt`, consumerKind: 'prompt', usedAt: turn })
    }

    const promoted = store.promoteEligibleClaims(4)

    assert.deepEqual(promoted.map(c => c.id), [claim.id])
    assert.equal(store.listClaims()[0]?.status, 'durable_candidate')
    assert.match(store.exportSession(), /claim_status_changed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('marks claims with matching file evidence as stale', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const fileClaim = store.propose({
      ...proposal('Observed file'),
      kind: 'file_observation',
      evidence: [{ id: 'f1', kind: 'file', summary: 'file', path: '/repo/src/a.ts', createdAt: 10 }],
    })

    const updated = store.markClaimsStaleForFile('/repo/src/a.ts', 'file modified')

    assert.deepEqual(updated.map(c => c.id), [fileClaim.id])
    assert.equal(store.listClaims()[0]?.status, 'stale')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SessionPersist creates a claim store for the current session id', () => {
  const persist = new SessionPersist('session-claims-test', process.cwd())
  const store = persist.createClaimStore()

  assert.match(store.path, /session-claims-test\.claims\.jsonl$/)
})

test('loadDurableClaims returns only durable claims from a session file', async () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-old')
    const active = store.propose(proposal('Active claim'))
    const durable = store.propose(proposal('Durable claim'))
    store.updateClaimStatus(durable.id, 'durable_candidate', 'promoted')
    store.updateClaimStatus(durable.id, 'durable', 'promotion threshold met')

    await store.flushWrites() // write-behind：跨实例读盘前先排空写链
    const loaded = ContextClaimStore.loadDurableClaims(dir, 'session-old')
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.text, 'Durable claim')
    assert.equal(loaded[0]!.status, 'durable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadDurableClaims returns empty for nonexistent session', () => {
  const dir = tempDir()
  try {
    const loaded = ContextClaimStore.loadDurableClaims(dir, 'nonexistent')
    assert.equal(loaded.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('boostFitness increases fitness by delta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-boost-'))
  try {
    const store = new ContextClaimStore(dir, 'session-1')
    const claim = store.propose({
      kind: 'file_observation',
      scope: 'session',
      text: 'config uses port 3000',
      confidence: 0.7,
      fitness: 3,
      source: { actor: 'tool', sessionId: 'session-1', turn: 1, eventId: 'e1' },
      evidence: [{ id: 'ev1', kind: 'tool_result', summary: 'x', createdAt: Date.now() }],
      createdAt: Date.now(),
      tags: ['test'],
    })

    const updated = store.boostFitness(claim.id, 2, 10)

    assert.equal(updated!.fitness, 5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('boostFitness caps fitness at max value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-boost-'))
  try {
    const store = new ContextClaimStore(dir, 'session-1')
    const claim = store.propose({
      kind: 'file_observation',
      scope: 'session',
      text: 'high fitness claim',
      confidence: 0.7,
      fitness: 9,
      source: { actor: 'tool', sessionId: 'session-1', turn: 1, eventId: 'e2' },
      evidence: [{ id: 'ev2', kind: 'tool_result', summary: 'x', createdAt: Date.now() }],
      createdAt: Date.now(),
      tags: ['test'],
    })

    const updated = store.boostFitness(claim.id, 5, 10)

    assert.equal(updated!.fitness, 10)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('boostFitness returns null for nonexistent claim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-boost-'))
  try {
    const store = new ContextClaimStore(dir, 'session-1')
    const result = store.boostFitness('nonexistent', 1, 10)
    assert.equal(result, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('caps consumers array per claim at MAX_CONSUMERS (50)', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const claim = store.propose(proposal('Consumer cap test'))

    // Record 60 usage events
    for (let i = 0; i < 60; i++) {
      store.recordClaimUsed(claim.id, {
        consumerId: `turn-${i}:prompt`,
        consumerKind: 'prompt',
        usedAt: Date.now() + i,
      })
    }

    const claims = store.listActiveClaims()
    const updated = claims.find(c => c.id === claim.id)!
    assert.ok(updated.consumers.length <= 50, `consumers length ${updated.consumers.length} should be <= 50`)
    // Most recent consumers should be kept
    assert.equal(updated.consumers[updated.consumers.length - 1]!.id, 'turn-59:prompt')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('evicts stale claims beyond MAX_ACTIVE_CLAIMS (50)', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')

    // Create 55 active claims with distinct createdAt
    for (let i = 0; i < 55; i++) {
      store.propose({ ...proposal(`Claim ${i}`), createdAt: i * 1000 })
    }

    const active = store.listActiveClaims()
    // After eviction, should be <= 50
    assert.ok(active.length <= 50, `active claims ${active.length} should be <= 50`)
    // Oldest claims (lowest createdAt) should be evicted — Claim 0..4 gone, Claim 5 first remaining
    assert.equal(active[0]!.text, 'Claim 5')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
