import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { pruneStaleCliCompileCaches } from '../compile-cache.js'

test('filesystem metadata cannot evict the two most recent real cache entries', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rivet-cache-metadata-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const current = join(root, '3.29.2')
  const recent = join(root, '3.29.1')
  const older = join(root, '3.29.0._suffix')
  const stale = join(root, '3.28.0')
  const legacy = join(root, 'v24.18.0-arm64-deadbeef-501')
  for (const [index, path] of [stale, older, recent, current, legacy].entries()) {
    mkdirSync(path)
    writeFileSync(join(path, 'cache.bin'), `cache-${index}`)
    const timestamp = new Date(Date.UTC(2020, 0, 1, 0, index))
    utimesSync(path, timestamp, timestamp)
  }

  for (const name of ['._3.29.2', '._3.29.1', '.DS_Store']) {
    const path = join(root, name)
    writeFileSync(path, 'filesystem metadata')
    const timestamp = new Date(Date.UTC(2030, 0, 1))
    utimesSync(path, timestamp, timestamp)
  }
  mkdirSync(join(root, '._metadata'))
  writeFileSync(join(root, '._metadata', 'extra'), 'filesystem metadata')

  pruneStaleCliCompileCaches(root, current, 2)

  assert.equal(existsSync(current), true, 'current cache must survive pruning')
  assert.equal(existsSync(recent), true, 'metadata must not consume a recent-cache slot')
  assert.equal(existsSync(older), true, 'a normal name containing ._ still occupies a real-cache slot')
  assert.equal(readFileSync(join(recent, 'cache.bin'), 'utf8'), 'cache-2')
  assert.equal(readFileSync(join(older, 'cache.bin'), 'utf8'), 'cache-1')
  assert.equal(existsSync(stale), false, 'the third oldest real cache exceeds the quota')
  assert.equal(existsSync(legacy), false, 'legacy Node cache layout remains unconditionally removed')
})
