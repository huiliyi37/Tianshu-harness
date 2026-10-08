import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEventsTailIndexed, auditEventsSummary } from '../events-summary.js'
import { clearEventsSummaryCache } from '../events-summary-store.js'
import { blockReference, cacheableSource, manifestDigest, sourceStamp, SUMMARY_LIMIT, validateBlock, validateManifest } from '../events-summary-format.js'
import { parseEventsTailRaw } from '../cpu-tasks.js'
import type { BlockSummary, SummaryManifest } from '../events-summary-format.js'

function fixture(count = 1800): { dir: string; file: string; root: string; text: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-summary-'))
  const file = join(dir, 'events.jsonl')
  const text = Array.from({ length: count }, (_, i) => JSON.stringify({
    seq: Math.floor(i / 2), ts: i, type: i === 0 || i === 21 || i === 700 ? 'artifact' : i === 7 || i === 1100 ? 'delegation' : 'text_delta',
    data: { id: 'old-art', text: '行🌌' + 'x'.repeat(600) },
  })).join('\n') + '\n'
  writeFileSync(file, text)
  return { dir, file, root: join(dir, 'events.summary.json'), text, cleanup: () => { clearEventsSummaryCache(file); rmSync(dir, { recursive: true, force: true }) } }
}
const manifest = (root: string): SummaryManifest => JSON.parse(readFileSync(root, 'utf8'))
function saveManifest(root: string, m: SummaryManifest): void {
  m.digest = manifestDigest(m); writeFileSync(root, JSON.stringify(m))
}
const blockFile = (dir: string, digest: string): string => join(dir, 'events.summary-blocks', digest + '.json')

test('persistent summary matches every tail field, selects ordinary counts, and bounds warm/cold parsing', async () => {
  const f = fixture()
  try {
    const first = await readEventsTailIndexed(f.file, 8)
    assert.deepEqual(first.tail, parseEventsTailRaw(f.text, 8))
    assert.equal(first.metrics.mode, 'scan'); assert.equal(first.metrics.rebuilt, true)
    assert.ok((await auditEventsSummary(f.file)).valid)
    for (const capacity of [0, 1, 3, 8, 500, 5000]) {
      const next = await readEventsTailIndexed(f.file, capacity)
      assert.deepEqual(next.tail, parseEventsTailRaw(f.text, capacity))
    }
    const warm = await readEventsTailIndexed(f.file, 8)
    if (cacheableSource(sourceStamp(statSync(f.file, { bigint: true })))) assert.equal(warm.metrics.mode, 'warm')
    assert.ok(warm.metrics.parsedLogBytes < Buffer.byteLength(f.text), 'must skip ordinary head payloads')
    if (warm.metrics.mode === 'warm') assert.ok(warm.metrics.scannedLogBytes < Buffer.byteLength(f.text), 'warm reads must skip raw verification of unread blocks')
    clearEventsSummaryCache(f.file)
    const cold = await readEventsTailIndexed(f.file, 8)
    assert.equal(cold.metrics.mode, 'cold')
    assert.ok(cold.metrics.scannedLogBytes >= Buffer.byteLength(f.text))
    assert.ok(cold.metrics.parsedLogBytes < Buffer.byteLength(f.text))
    const strict = await readEventsTailIndexed(f.file, 8, { strict: true })
    assert.equal(strict.metrics.mode, 'cold', 'strict reads must verify unread raw blocks too')
  } finally { f.cleanup() }
})

test('append extends only sealed summaries; valid EOF and split UTF-8 retain baseline semantics', async () => {
  const f = fixture(800)
  try {
    const eof = JSON.stringify({ seq: 400, ts: 800, type: 'text_delta', data: { text: '🌌汉字'.repeat(30000) } })
    writeFileSync(f.file, '\ufeff' + f.text.replaceAll('\n', '\r\n') + eof)
    await readEventsTailIndexed(f.file, 3)
    const old = manifest(f.root)
    assert.ok(old.coveredBytes < statSync(f.file).size, 'unterminated EOF must remain outside coverage')
    const extra = '\n' + Array.from({ length: 600 }, (_, i) => JSON.stringify({ seq: 401 + i, ts: i, type: 'text_delta', data: { text: '追加' } })).join('\n') + '\n{"seq":'
    appendFileSync(f.file, extra)
    const result = await readEventsTailIndexed(f.file, 3)
    assert.deepEqual(result.tail, parseEventsTailRaw(readFileSync(f.file, 'utf8'), 3))
    assert.equal(result.metrics.mode, 'extended')
    const current = manifest(f.root)
    assert.ok(current.coveredBytes > old.coveredBytes)
    assert.deepEqual(current.blocks.slice(0, old.blocks.length), old.blocks)
    assert.ok((await auditEventsSummary(f.file)).valid)
  } finally { f.cleanup() }
})

test('same-size middle rewrite with restored mtime cannot reuse a stale artifact ID', async () => {
  const f = fixture()
  try {
    await readEventsTailIndexed(f.file, 8)
    const before = statSync(f.file)
    const lines = f.text.split('\n')
    // Block containing event 700 has no delegation and is outside the ordinary window.
    lines[700] = lines[700]!.replace('old-art', 'new-art')
    const changed = lines.join('\n')
    assert.equal(Buffer.byteLength(changed), before.size)
    writeFileSync(f.file, changed); utimesSync(f.file, before.atime, before.mtime)
    const result = await readEventsTailIndexed(f.file, 8)
    assert.deepEqual(result.tail, parseEventsTailRaw(changed, 8))
    assert.equal(result.metrics.mode, 'scan')
    assert.match(result.metrics.validationReason, /hash mismatch|another log generation/)
    assert.deepEqual(result.tail.artifactIds, ['old-art', 'old-art', 'new-art'])
  } finally { f.cleanup() }
})

test('disorder, fractional and negative seqs keep the heap scan contract; zero capacity retains no activity payload', async () => {
  const f = fixture()
  try {
    for (const seq of [-1, 1.5, 1]) {
      writeFileSync(f.file, f.text + JSON.stringify({ seq, ts: 2, type: 'delegation', data: { id: 'late' } }) + '\n')
      const result = await readEventsTailIndexed(f.file, 0)
      assert.equal(result.metrics.mode, 'scan')
      assert.deepEqual(result.tail, parseEventsTailRaw(readFileSync(f.file, 'utf8'), 0))
      assert.equal(result.tail.events.length, 0)
    }
  } finally { f.cleanup() }
})

test('window selection counts ordinary events rather than valid rows in delegation-heavy blocks', async () => {
  const f = fixture()
  try {
    const text = Array.from({ length: 2000 }, (_, i) => JSON.stringify({
      seq: i + 1, ts: i, type: i === 0 || i >= 1600 ? 'delegation' : 'text_delta', data: { text: '' },
    })).join('\n') + '\n'
    writeFileSync(f.file, text)
    await readEventsTailIndexed(f.file, 1101)
    const indexed = await readEventsTailIndexed(f.file, 1101)
    assert.deepEqual(indexed.tail, parseEventsTailRaw(text, 1101))
    assert.equal(indexed.tail.events[1]!.seq, 901)
  } finally { f.cleanup() }
})

test('corrupt, oversize, unknown-version, missing-block and hostile-path indexes fall back and rebuild', async () => {
  const f = fixture()
  try {
    await readEventsTailIndexed(f.file, 8)
    const corruptions = [
      () => writeFileSync(f.root, '{'),
      () => writeFileSync(f.root, 'x'.repeat(1024 * 1024 + 1)),
      () => { const m = manifest(f.root); m.parserVersion = 999; saveManifest(f.root, m) },
      () => { const m = manifest(f.root); m.total++; saveManifest(f.root, m) },
      () => { const m = manifest(f.root); m.blocks[0]!.digest = '../../outside'; saveManifest(f.root, m) },
      () => { const m = manifest(f.root); m.blocks[0]!.end--; saveManifest(f.root, m) },
      () => { const m = manifest(f.root); rmSync(blockFile(f.dir, m.blocks[0]!.digest)) },
      () => { const m = manifest(f.root); writeFileSync(blockFile(f.dir, m.blocks[0]!.digest), '{') },
      () => { const m = manifest(f.root); truncateSync(blockFile(f.dir, m.blocks[0]!.digest), SUMMARY_LIMIT + 1) },
    ]
    for (const corrupt of corruptions) {
      corrupt(); clearEventsSummaryCache(f.file)
      const result = await readEventsTailIndexed(f.file, 8)
      assert.equal(result.metrics.mode, 'scan')
      assert.deepEqual(result.tail, parseEventsTailRaw(f.text, 8))
      assert.ok((await auditEventsSummary(f.file)).valid)
    }
  } finally { f.cleanup() }
})

test('semantic audit detects forged summary metadata even after all sidecar checksums are recomputed', async () => {
  const f = fixture()
  try {
    await readEventsTailIndexed(f.file, 8)
    const m = manifest(f.root)
    const b: BlockSummary = JSON.parse(readFileSync(blockFile(f.dir, m.blocks[0]!.digest), 'utf8'))
    b.artifacts[0]!.id = 'forged-id'
    const ref = blockReference(b)
    writeFileSync(blockFile(f.dir, ref.digest), JSON.stringify(b)); m.blocks[0] = ref; saveManifest(f.root, m)
    const audit = await auditEventsSummary(f.file)
    assert.equal(audit.valid, false); assert.match(audit.reason!, /semantics mismatch/)
    clearEventsSummaryCache(f.file)
    const result = await readEventsTailIndexed(f.file, 8)
    assert.equal(result.metrics.mode, 'scan', 'selected delegation block must also verify semantic metadata')
    assert.deepEqual(result.tail, parseEventsTailRaw(f.text, 8))
  } finally { f.cleanup() }
})

test('a failed semantic audit quarantines an unselected block until the next reader rebuilds', async () => {
  const f = fixture()
  try {
    await readEventsTailIndexed(f.file, 8)
    const m = manifest(f.root)
    const i = m.blocks.findIndex(ref => ref.firstSeq !== null && ref.firstSeq <= 350 && ref.lastSeq! >= 350)
    const b: BlockSummary = JSON.parse(readFileSync(blockFile(f.dir, m.blocks[i]!.digest), 'utf8'))
    assert.equal(b.delegations.length, 0)
    b.artifacts[0]!.id = 'forged-unread-art'
    const ref = blockReference(b)
    writeFileSync(blockFile(f.dir, ref.digest), JSON.stringify(b)); m.blocks[i] = ref; saveManifest(f.root, m)
    assert.equal((await auditEventsSummary(f.file)).valid, false)
    const next = await readEventsTailIndexed(f.file, 8)
    assert.deepEqual(next.tail, parseEventsTailRaw(f.text, 8))
    assert.equal(next.metrics.mode, 'scan')
    assert.ok((await auditEventsSummary(f.file)).valid)
  } finally { f.cleanup() }
})

test('truncation and rename invalidate source generation without changing the existing sparse index', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.dir, 'events.index.jsonl'), 'untouched')
    await readEventsTailIndexed(f.file, 8)
    writeFileSync(join(f.dir, 'replacement'), f.text.slice(f.text.indexOf('\n') + 1))
    renameSync(join(f.dir, 'replacement'), f.file)
    let result = await readEventsTailIndexed(f.file, 8)
    assert.equal(result.metrics.mode, 'scan')
    assert.deepEqual(result.tail, parseEventsTailRaw(readFileSync(f.file, 'utf8'), 8))
    truncateSync(f.file, 0)
    result = await readEventsTailIndexed(f.file, 8)
    assert.deepEqual(result.tail, { events: [], total: 0, diskFirstSeq: 0, lastSeq: 0, artifactIds: [] })
    assert.equal(readFileSync(join(f.dir, 'events.index.jsonl'), 'utf8'), 'untouched')
  } finally { f.cleanup() }
})

test('unwritable cache location cannot fail the original read, and concurrent builders remain equivalent', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.dir, 'events.summary-blocks'), 'not a directory')
    const blocked = await readEventsTailIndexed(f.file, 8)
    assert.deepEqual(blocked.tail, parseEventsTailRaw(f.text, 8))
    assert.equal(blocked.metrics.rebuilt, false); assert.equal(existsSync(f.root), false)
    rmSync(join(f.dir, 'events.summary-blocks'))
    const capacities = [0, 1, 8, 50]
    const results = await Promise.all(capacities.map(k => readEventsTailIndexed(f.file, k)))
    results.forEach((result, i) => assert.deepEqual(result.tail, parseEventsTailRaw(f.text, capacities[i]!)))
    assert.ok((await auditEventsSummary(f.file)).valid)
  } finally { f.cleanup() }
})

test('source stamps with no inode or millisecond precision never allow a warm trust shortcut', () => {
  const fine = { dev: '1', ino: '2', size: '100', mtimeNs: '1000000001', ctimeNs: '2000000001' }
  assert.equal(cacheableSource(fine), true)
  assert.equal(cacheableSource({ ...fine, ino: '0' }), false)
  assert.equal(cacheableSource({ ...fine, mtimeNs: '1000000000' }), false)
  assert.equal(cacheableSource({ ...fine, ctimeNs: '2000000000' }), false)
})

test('raw hashes preserve invalid UTF-8 bytes while replay keeps the baseline replacement decoding', async () => {
  const f = fixture()
  try {
    const raw = Buffer.from(f.text)
    raw[raw.indexOf('xxxxxxxxxxxxxxxx')] = 0xff
    writeFileSync(f.file, raw)
    await readEventsTailIndexed(f.file, 8)
    clearEventsSummaryCache(f.file)
    const cold = await readEventsTailIndexed(f.file, 8)
    assert.equal(cold.metrics.mode, 'cold', 'hashes must use raw bytes, not re-encoded decoded text')
    assert.deepEqual(cold.tail, parseEventsTailRaw(raw.toString('utf8'), 8))
    assert.ok((await auditEventsSummary(f.file)).valid)
  } finally { f.cleanup() }
})

test('block boundary disorder and count overflow are rejected even with a valid manifest digest', async () => {
  const f = fixture()
  try {
    await readEventsTailIndexed(f.file, 8)
    const m = manifest(f.root)
    const bad = structuredClone(m)
    bad.blocks[1]!.firstSeq = 0
    bad.digest = manifestDigest(bad)
    assert.throws(() => validateManifest(bad), /Unordered/)
    const overflow = structuredClone(m)
    overflow.total = Number.MAX_SAFE_INTEGER + 1; overflow.digest = manifestDigest(overflow)
    assert.throws(() => validateManifest(overflow), /count/)
    const block = JSON.parse(readFileSync(blockFile(f.dir, m.blocks[0]!.digest), 'utf8'))
    delete block.artifacts[0].id; block.artifacts[0].length = 1
    assert.throws(() => validateBlock(block, blockReference(block)), /artifact ID/, 'artifact shape cannot be mistaken for a delegation reference')
  } finally { f.cleanup() }
})


test('scan, indexed reload and appended suffix enforce bytes while preserving old worker state', async () => {
  const f=fixture(1300)
  try {
    const rows=Array.from({length:1300},(_,i)=>JSON.stringify({seq:i+1,ts:i,type:i===0?'delegation':'text_delta',data:i===0?{workerId:'w',attemptId:'a',status:'running',objective:'old task'}:{text:'汉字🌌'.repeat(80)}}))
    writeFileSync(f.file,rows.join('\n')+'\n')
    for(let n=0;n<3;n++) {
      const {tail}=await readEventsTailIndexed(f.file,5000,{maxEventBytes:1800})
      assert.ok(tail.events.reduce((sum,e)=>sum+Buffer.byteLength(JSON.stringify(e)),0)<=1800)
      if(n<2) assert.equal(tail.delegationState?.events[0]?.data.objective,'old task')
      if(n===0) clearEventsSummaryCache(f.file)
      if(n===1) appendFileSync(f.file,JSON.stringify({seq:1301,ts:1301,type:'delegation',data:{workerId:'w',attemptId:'a',status:'failed',text:'🌌'.repeat(500)}})+'\n')
    }
    const {tail}=await readEventsTailIndexed(f.file,5000,{maxEventBytes:1800})
    assert.deepEqual(tail.events,[], 'oversized final row establishes an empty replay window')
    assert.deepEqual(tail.delegationState?.events,[])
  } finally {f.cleanup()}
})
