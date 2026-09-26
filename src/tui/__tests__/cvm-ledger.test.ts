/**
 * CVM 台账聚合（issue #249）——/debug cvm 的数据层。
 *
 * 复算口径与 docs/reference/observability-harness.md:221 的 jq 命令一致：
 *   jq -r 'select(.kind=="cvm-vector-decision") | .classification' sensorium.jsonl | sort | uniq -c
 * 差别只在 null：jq 会把 classification 为 null 的行输出成字符串 "null"，
 * 这里归入 '(none)' 并显式标注，避免与真实的分类混淆。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeCvmLedger, formatCvmLedgerSummary } from '../format/cvm-ledger.js'

const line = (o: Record<string, unknown>) => JSON.stringify(o)

test('summarizeCvmLedger: 只统计 cvm-vector-decision，按 classification 聚合降序', () => {
  const s = summarizeCvmLedger([
    line({ kind: 'cvm-vector-decision', turn: 1, classification: 'gate-blocked', ruleId: 'CV1' }),
    line({ kind: 'cvm-vector-decision', turn: 2, classification: 'gate-blocked', ruleId: 'CV1' }),
    line({ kind: 'cvm-vector-decision', turn: 3, classification: 'verification-debt', ruleId: 'CV2' }),
    line({ kind: 'vitals-lite', turn: 3 }), // 非 CVM
    line({ kind: 'advisory', key: 'x' }), // 非 CVM
  ])
  assert.equal(s.total, 3, '只数 cvm-vector-decision')
  assert.deepEqual(
    s.byClassification.map((r) => [r.classification, r.count]),
    [
      ['gate-blocked', 2],
      ['verification-debt', 1],
    ],
  )
})

test('summarizeCvmLedger: classification 为 null 归入 (none) 且参与总计', () => {
  const s = summarizeCvmLedger([
    line({ kind: 'cvm-vector-decision', turn: 1, classification: null, ruleId: 'CV3' }),
    line({ kind: 'cvm-vector-decision', turn: 2, classification: 'context-pressure' }),
  ])
  assert.equal(s.total, 2)
  const map = new Map(s.byClassification.map((r) => [r.classification, r.count]))
  assert.equal(map.get('(none)'), 1)
  assert.equal(map.get('context-pressure'), 1)
})

test('summarizeCvmLedger: 空白行跳过；坏 JSON 计入 malformed 且不污染统计', () => {
  const s = summarizeCvmLedger([
    '',
    '   ',
    '{not json',
    line({ kind: 'cvm-vector-decision', classification: 'gate-blocked' }),
  ])
  assert.equal(s.total, 1)
  assert.equal(s.malformed, 1)
})

test('summarizeCvmLedger: 同计数按分类名升序（稳定，非依赖输入顺序）', () => {
  const s = summarizeCvmLedger([
    line({ kind: 'cvm-vector-decision', classification: 'verification-debt' }),
    line({ kind: 'cvm-vector-decision', classification: 'attack-stalled' }),
  ])
  assert.deepEqual(
    s.byClassification.map((r) => r.classification),
    ['attack-stalled', 'verification-debt'],
  )
})

test('formatCvmLedgerSummary: 含中文标签与计数；空台账给出可行动提示', () => {
  const out = formatCvmLedgerSummary(
    summarizeCvmLedger([line({ kind: 'cvm-vector-decision', classification: 'gate-blocked' })]),
  )
  assert.match(out, /gate-blocked/)
  assert.match(out, /门禁拦截/)
  assert.match(out, /×1/)

  const empty = formatCvmLedgerSummary(summarizeCvmLedger([]))
  assert.match(empty, /没有|未发现|空/)
})

test('formatCvmLedgerSummary: 未知分类原样输出标签，不丢数', () => {
  const out = formatCvmLedgerSummary(
    summarizeCvmLedger([line({ kind: 'cvm-vector-decision', classification: 'brand-new-kind' })]),
  )
  assert.match(out, /brand-new-kind/)
})
