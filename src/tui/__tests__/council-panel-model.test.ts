import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeCouncilPanel,
  decodeCouncilPanel,
  COUNCIL_PANEL_UI_PREFIX,
  type CouncilPanelModel,
} from '../council-panel-model.js'

function model(overrides?: Partial<CouncilPanelModel>): CouncilPanelModel {
  return {
    schemaVersion: 1,
    objective: 'Test council',
    seats: [
      { authority: 'tianquan', status: 'passed', round: 1, modelUsed: 'deepseek-v4' },
      { authority: 'tianji', status: 'passed', round: 1 },
    ],
    verdict: { accepted: 3, rejected: 1, deferred: 0, conflicts: 2 },
    pillarsMode: true,
    ...overrides,
  }
}

// ── encode/decode round-trip ──────────────────────────

test('encode-decode round-trip preserves all fields', () => {
  const m = model()
  const encoded = encodeCouncilPanel(m)
  assert.ok(encoded.startsWith(COUNCIL_PANEL_UI_PREFIX))
  const decoded = decodeCouncilPanel(encoded)
  assert.ok(decoded)
  assert.deepStrictEqual(decoded, m)
})

test('encode produces single-line JSON', () => {
  const encoded = encodeCouncilPanel(model())
  const lines = encoded.split('\n')
  assert.equal(lines.length, 1)
})

// issue #105（收编自公开仓 PR #108）——席位实际命中的模型若已弃用，桌面端/终端
// 必须能显式告警；标记随面板帧往返，不能在中途丢掉。
test('席位 deprecated 标记随面板帧往返', () => {
  const m = model({
    seats: [
      { authority: 'tianquan', status: 'passed', round: 1, modelUsed: 'deepseek-v4-pro', deprecated: true },
      { authority: 'tianji', status: 'passed', round: 1, modelUsed: 'deepseek-v4.1f' },
    ],
  })
  const decoded = decodeCouncilPanel(encodeCouncilPanel(m))
  assert.equal(decoded?.seats[0]?.deprecated, true, '弃用标记必须在往返后保留')
  assert.equal(decoded?.seats[1]?.deprecated, undefined, '未弃用的席位不得被误标')
})

test('decode returns null for empty string', () => {
  assert.equal(decodeCouncilPanel(''), null)
})

test('decode returns null for string without prefix', () => {
  assert.equal(decodeCouncilPanel('some random text'), null)
})

test('decode returns null for malformed JSON after prefix', () => {
  assert.equal(decodeCouncilPanel(`${COUNCIL_PANEL_UI_PREFIX}{not json`), null)
})

// ── torn frame recovery ──────────────────────────────

test('decode recovers from torn tail — returns last intact frame', () => {
  const m1 = model({ sealVersion: 1 })
  const m2 = model({ sealVersion: 2, seats: [{ authority: 'yaoguang', status: 'passed', round: 2 }] })
  const buf = `${encodeCouncilPanel(m1)}\n${encodeCouncilPanel(m2).slice(0, -5)}`
  const decoded = decodeCouncilPanel(buf)
  assert.ok(decoded)
  assert.equal(decoded!.sealVersion, 1)
})

test('decode with prefix in earlier position finds it', () => {
  const m = model()
  const buf = `Some prefix text\n${encodeCouncilPanel(m)}\nMore text`
  const decoded = decodeCouncilPanel(buf)
  assert.ok(decoded)
  assert.deepStrictEqual(decoded, m)
})

test('decode with multiple frames returns last intact one', () => {
  const m1 = model({ sealVersion: 1, verdict: { accepted: 1, rejected: 0, deferred: 0, conflicts: 0 } })
  const m2 = model({ sealVersion: 2, verdict: { accepted: 2, rejected: 0, deferred: 0, conflicts: 0 } })
  const buf = `${encodeCouncilPanel(m1)}\n${encodeCouncilPanel(m2)}`
  const decoded = decodeCouncilPanel(buf)
  assert.ok(decoded)
  assert.equal(decoded!.sealVersion, 2)
})

// ── edge cases ────────────────────────────────────────

test('decode empty seats array', () => {
  const m = model({ seats: [], pillarsMode: false })
  const encoded = encodeCouncilPanel(m)
  const decoded = decodeCouncilPanel(encoded)
  assert.ok(decoded)
  assert.equal(decoded!.seats.length, 0)
})

test('decode with failedSeats and qliphothCount', () => {
  const m = model({ failedSeats: ['tianji'], qliphothCount: 1 })
  const encoded = encodeCouncilPanel(m)
  const decoded = decodeCouncilPanel(encoded)
  assert.ok(decoded)
  assert.deepStrictEqual(decoded!.failedSeats, ['tianji'])
  assert.equal(decoded!.qliphothCount, 1)
})

test('schemaVersion mismatch rejects decode', () => {
  const m = model()
  const encoded = encodeCouncilPanel(m).replace('"schemaVersion":1', '"schemaVersion":2')
  assert.equal(decodeCouncilPanel(encoded), null)
})

// ── PREFIX constant ───────────────────────────────────

test('COUNCIL_PANEL_UI_PREFIX has expected format', () => {
  assert.equal(COUNCIL_PANEL_UI_PREFIX, 'rivet:council-panel:v1:')
  assert.ok(COUNCIL_PANEL_UI_PREFIX.length > 0)
})
