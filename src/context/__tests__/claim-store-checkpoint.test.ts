import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ContextClaimStore } from '../claim-store.js'
import { checkpointClaims, type ClaimProposal } from '../claims.js'

function proposal(text: string, eventId: string): ClaimProposal {
  return {
    kind: 'decision',
    scope: 'session',
    text,
    confidence: 0.8,
    fitness: 0.5,
    tags: [],
    evidence: [],
    source: { actor: 'assistant', sessionId: 'test-session', turn: 1, eventId },
    createdAt: Date.now(),
  }
}

describe('ContextClaimStore checkpoint — 溶解即新生', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claim-store-cp-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes snapshot and truncates JSONL while preserving current store state', () => {
    const store = new ContextClaimStore(dir, 'session-1')
    store.propose(proposal('use ESM', 'e1'))
    store.propose(proposal('use strict', 'e2'))

    const result = store.checkpoint(1234)

    assert.equal(result.claimCount, 2)
    assert.ok(existsSync(result.snapshotPath))
    assert.equal(readFileSync(result.truncatedPath, 'utf-8'), '')
    assert.deepEqual(store.listClaims().map(c => c.text).sort(), ['use ESM', 'use strict'])
  })

  it('replays incremental JSONL events after snapshot on reload', async () => {
    const store = new ContextClaimStore(dir, 'session-2')
    store.propose(proposal('before checkpoint', 'e1'))
    store.checkpoint(1234)
    store.propose(proposal('after checkpoint', 'e2'))

    await store.flushWrites() // write-behind：重载前先排空写链
    const reloaded = new ContextClaimStore(dir, 'session-2')
    const texts = reloaded.listClaims().map(c => c.text).sort()

    assert.deepEqual(texts, ['after checkpoint', 'before checkpoint'])
  })

  it('filters stale claims from checkpoint snapshot', () => {
    const store = new ContextClaimStore(dir, 'session-3')
    const alive = store.propose(proposal('alive', 'e1'))
    const stale = store.propose(proposal('stale', 'e2'))
    store.updateClaimStatus(stale.id, 'stale', 'obsolete')

    const result = store.checkpoint(1234)
    const snapshot = JSON.parse(readFileSync(result.snapshotPath, 'utf-8')) as { claims: Array<{ id: string }> }

    assert.deepEqual(snapshot.claims.map(c => c.id), [alive.id])
    assert.deepEqual(store.listClaims().map(c => c.id), [alive.id])
  })

  it('does not double replay JSONL events after snapshot write but before truncate', () => {
    const store = new ContextClaimStore(dir, 'session-crash')
    const claim = store.propose(proposal('crash window claim', 'e1'))
    store.recordClaimUsed(claim.id, { consumerId: 'turn-1:prompt', consumerKind: 'prompt', usedAt: 10 })
    store.updateClaimStatus(claim.id, 'durable', 'promoted')

    const eventsBeforeCrash = store.exportSession()
    const snapshot = checkpointClaims(store.listClaims(), 1234, store.eventCount)
    writeFileSync(join(dir, 'session-crash.claims.snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n')
    // Simulate crash before the JSONL truncate step: events remain on disk.
    writeFileSync(store.path, eventsBeforeCrash)

    const reloaded = new ContextClaimStore(dir, 'session-crash')
    const [replayed] = reloaded.listClaims()

    assert.equal(replayed?.id, claim.id)
    assert.equal(replayed?.consumers.length, 1)
    assert.equal(replayed?.counterevidence.length, 1)
    assert.equal(replayed?.status, 'durable')
  })

  it('auto-checkpoints after a bounded number of appended events', async () => {
    const store = new ContextClaimStore(dir, 'session-auto', { checkpointEveryEvents: 2 })
    store.propose(proposal('first', 'e1'))
    store.propose(proposal('second', 'e2'))

    await store.flushWrites() // write-behind：自动 checkpoint 在写链内按序执行，先排空再断言
    assert.ok(existsSync(join(dir, 'session-auto.claims.snapshot.json')))
    assert.equal(readFileSync(store.path, 'utf-8'), '')
    assert.equal(store.listClaims().length, 2)
  })
})
