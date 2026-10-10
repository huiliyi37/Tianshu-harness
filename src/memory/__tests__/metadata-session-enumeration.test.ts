import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectTranscriptCandidates } from '../deep-recall.js'
import { collectBackfillCandidates, runMemoryBackfill, loadBackfillLedger } from '../backfill.js'

const HOUR = 3_600_000
const metadata = Buffer.from([0, 5, 22, 7, 0, 2, 0, 0, ...Array(24).fill(0)])
const message = JSON.stringify({ role: 'user', content: 'traceanchor ' + 'synthetic historical evidence '.repeat(12) }) + '\n'

function writeAt(dir: string, name: string, content: string | Buffer, at: number): void {
  const file = join(dir, name)
  writeFileSync(file, content)
  utimesSync(file, at / 1000, at / 1000)
}

function seedMetadata(dir: string, count: number, at: number): void {
  for (let i = 0; i < count; i++) writeAt(dir, `._history-${i}.jsonl`, metadata, at)
}

test('Binary metadata cannot occupy the default twenty-session deep recall limit; ordinary hidden transcripts remain eligible', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-metadata-recall-'))
  try {
    writeAt(dir, 'real-session.jsonl', message, Date.UTC(2020, 0, 1))
    writeAt(dir, '.notes.jsonl', message, Date.UTC(2020, 0, 2))
    seedMetadata(dir, 21, Date.UTC(2021, 0, 1))
    const candidates = collectTranscriptCandidates(dir, 'traceanchor')
    console.log(JSON.stringify({ subject: 'deep-recall', sessionIds: candidates.map(candidate => candidate.sessionId) }))
    assert.deepEqual(candidates.map(candidate => candidate.sessionId).sort(), ['.notes', 'real-session'])
    assert.deepEqual(collectTranscriptCandidates(dir, 'traceanchor', { maxSessions: 1 }).map(candidate => candidate.sessionId), ['.notes'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Backfill filters binary metadata before its five-session limit and stale ledger admission without excluding ordinary hidden files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-metadata-backfill-'))
  const now = Date.now()
  try {
    writeAt(dir, 'real-session.jsonl', message, now - 6 * HOUR)
    writeAt(dir, '.notes.jsonl', message, now - 5 * HOUR)
    writeAt(dir, 'old-session.jsonl', message, now - 20 * 24 * HOUR)
    writeAt(dir, '._old-session.jsonl', metadata, now - 20 * 24 * HOUR)
    seedMetadata(dir, 6, now - 2 * HOUR)
    const selected = collectBackfillCandidates(dir, undefined, { version: 1, sessions: {} }, now)
    console.log(JSON.stringify({ subject: 'backfill-admission', sessionIds: selected.candidates.map(candidate => candidate.sessionId), staleIds: selected.staleIds }))
    assert.deepEqual(selected.candidates.map(candidate => candidate.sessionId), ['.notes', 'real-session'])
    assert.deepEqual(selected.staleIds, ['old-session'])
    assert.deepEqual(collectBackfillCandidates(dir, undefined, { version: 1, sessions: {} }, now, 1).candidates.map(candidate => candidate.sessionId), ['.notes'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Real transcript backfill processes legitimate history immediately and writes no metadata session ledger entries', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'memory-metadata-backfill-run-'))
  const dir = join(cwd, 'sessions')
  mkdirSync(dir)
  const now = Date.now()
  const prompts: string[] = []
  try {
    writeAt(dir, 'real-session.jsonl', message, now - 6 * HOUR)
    writeAt(dir, 'real-second.jsonl', message, now - 5 * HOUR)
    seedMetadata(dir, 6, now - 2 * HOUR)
    const result = await runMemoryBackfill({
      cwd, sessionDir: dir,
      complete: async prompt => {
        prompts.push(prompt)
        return JSON.stringify({ summary: 'Synthetic historical evidence was reviewed for a deterministic metadata exclusion regression.', procedures: [] })
      },
    })
    const ledgerIds = Object.keys(loadBackfillLedger(cwd).sessions).sort()
    console.log(JSON.stringify({ subject: 'backfill-run', result, promptCount: prompts.length, ledgerIds }))
    assert.equal(result.processed, 2)
    assert.equal(prompts.length, 2)
    assert.deepEqual(ledgerIds, ['real-second', 'real-session'])
    assert.ok(prompts.every(prompt => !prompt.includes('._history-')))
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
