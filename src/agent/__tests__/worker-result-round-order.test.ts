import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listPersistedResultRounds } from '../worker-result-store.js'
import { orderFileKey } from '../../utils/safe-path.js'

test('同 mtime 的归档轮次不随目录枚举顺序变化', t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'rivet-round-order-'))
  const dir = join(home, '.rivet', 'subagents')
  fs.mkdirSync(dir, { recursive: true })
  const key = orderFileKey('batch:0')
  const nonces = ['Z9', 'a1', 'a_2']
  const savedAt = new Date('2020-01-01T00:00:00.000Z')
  for (const nonce of nonces) {
    const path = join(dir, `${key}.${nonce}.json`)
    fs.writeFileSync(path, '{}')
    fs.utimesSync(path, savedAt, savedAt)
  }
  const readdir = fs.readdirSync
  let reverse = false
  t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof fs.readdirSync>) => {
    const entries = readdir(...args)
    return String(args[0]) === dir && reverse ? entries.slice().reverse() : entries
  })
  syncBuiltinESMExports()
  try {
    const forwards = listPersistedResultRounds('batch:0', home)
    reverse = true
    const backwards = listPersistedResultRounds('batch:0', home)
    assert.deepEqual(forwards.map(round => round.nonce), nonces)
    assert.deepEqual(backwards, forwards)
    assert.deepEqual(forwards.map(round => round.savedAt), nonces.map(() => savedAt.getTime()))
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
