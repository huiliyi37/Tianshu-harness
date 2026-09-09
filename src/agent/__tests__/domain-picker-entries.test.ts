import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDomainPickerEntries } from '../domain-picker-entries.js'
import type { ActiveStarDomain } from '../star-domain.js'

test('Auto is current when selection is undefined', () => {
  const entries = buildDomainPickerEntries(undefined)
  assert.equal(entries[0]!.key, 'auto')
  assert.equal(entries[0]!.current, true)
  // First domain entry follows Auto directly (Off removed).
  assert.notEqual(entries[1]!.key, 'off')
  assert.match(entries[0]!.essence, /回退天权/)
  assert.match(entries[0]!.meta, /关键词自动匹配/)
})

test('Off option is removed — no picker entry has key "off"', () => {
  const entries = buildDomainPickerEntries(undefined)
  assert.equal(entries.find((e) => e.key === 'off'), undefined)
})

test('null selection (env kill switch) reflects as Auto-current (no Off entry)', () => {
  const entries = buildDomainPickerEntries(null)
  assert.equal(entries.find((e) => e.key === 'off'), undefined)
  assert.equal(entries.find((e) => e.key === 'auto')!.current, true)
})

test('a pinned domain is the only current entry', () => {
  const pinned: ActiveStarDomain = { id: 'tianshu', name: '天枢', volatileBlock: '...', motto: 'm', courageThreshold: 0.65 }
  const entries = buildDomainPickerEntries(pinned)
  const current = entries.filter((e) => e.current)
  assert.equal(current.length, 1)
  assert.equal(current[0]!.key, 'tianshu')
})

test('every domain entry carries a non-empty essence + meta', () => {
  const entries = buildDomainPickerEntries(undefined)
  const tianshu = entries.find((e) => e.key === 'tianshu')!
  assert.ok(tianshu.essence.length > 0)
  assert.ok(tianshu.meta.length > 0)
})

test('built-in domain entries carry founder + expertise from genesis data', () => {
  const entries = buildDomainPickerEntries(undefined)
  const tianshu = entries.find((e) => e.key === 'tianshu')!
  assert.equal(tianshu.founder, 'GPT-5.5')
  assert.ok(tianshu.expertise && tianshu.expertise.length >= 10)
  const auto = entries.find((e) => e.key === 'auto')!
  assert.equal(auto.founder, undefined, 'Auto 无创始星')
})
