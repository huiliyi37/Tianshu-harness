import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grantApp, revokeApp, isAppGranted, listGrantedApps, resolveRememberedComputerUseApp } from '../app-grants.js'
import { computerUseGrantsPath } from '../../../config/paths.js'

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'rivet-cu-grants-'))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

test('no grants file → everything denied (fail-closed)', () => {
  assert.equal(isAppGranted('Safari', base), false)
  assert.deepEqual(listGrantedApps(base), [])
})

test('grant → isAppGranted true, case-insensitive', () => {
  grantApp('Safari', { base })
  assert.equal(isAppGranted('Safari', base), true)
  assert.equal(isAppGranted('safari', base), true)
  assert.equal(isAppGranted('SAFARI', base), true)
  assert.equal(isAppGranted('Notes', base), false)
})

test('grant is idempotent — re-grant refreshes timestamp, no duplicate', () => {
  grantApp('Safari', { base, now: () => 1000 })
  grantApp('safari', { base, now: () => 2000 })
  const grants = listGrantedApps(base)
  assert.equal(grants.length, 1)
  assert.equal(grants[0]!.grantedAt, 2000)
})

test('revoke removes the grant', () => {
  grantApp('Safari', { base })
  assert.equal(revokeApp('safari', base), true)
  assert.equal(isAppGranted('Safari', base), false)
  assert.equal(revokeApp('Safari', base), false, 'second revoke is a no-op')
})

test('listGrantedApps sorted newest first', () => {
  grantApp('Old', { base, now: () => 100 })
  grantApp('New', { base, now: () => 200 })
  const grants = listGrantedApps(base)
  assert.deepEqual(grants.map(g => g.app), ['New', 'Old'])
})

test('corrupt grants file → treated as empty (fail-closed), then recoverable', () => {
  writeFileSync(computerUseGrantsPath(base), '{not json', 'utf-8')
  assert.equal(isAppGranted('Safari', base), false)
  grantApp('Safari', { base })
  assert.equal(isAppGranted('Safari', base), true)
})

test('blank app names are never granted', () => {
  grantApp('   ', { base })
  assert.deepEqual(listGrantedApps(base), [])
  assert.equal(isAppGranted('', base), false)
})

test('resolveRememberedComputerUseApp: 顶层 app 优先；单应用 sequence 取 steps；多应用/缺失不记录', () => {
  assert.equal(resolveRememberedComputerUseApp({ action: 'click', app: 'Safari' }), 'Safari')
  assert.equal(resolveRememberedComputerUseApp({
    action: 'sequence',
    steps: [{ action: 'click', app: 'Safari' }, { action: 'type', app: 'safari' }],
  }), 'Safari')
  assert.equal(resolveRememberedComputerUseApp({
    action: 'sequence',
    steps: [{ action: 'click', app: 'Safari' }, { action: 'click', app: 'Notes' }],
  }), undefined, '跨应用不记录')
  assert.equal(resolveRememberedComputerUseApp({
    action: 'sequence',
    steps: [{ action: 'wait', duration_ms: 1 }],
  }), undefined, '步骤无 app 不记录')
  assert.equal(resolveRememberedComputerUseApp(undefined), undefined)
})
