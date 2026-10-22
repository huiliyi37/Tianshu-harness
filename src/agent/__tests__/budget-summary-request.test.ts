import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSummaryRequests, summaryRequestFits } from '../budget-summary-request.js'
import { SUMMARY_ENVELOPE_INSTRUCTION } from '../compact-summary-envelope.js'
import { buildContextBudget } from '../../context/request-budget.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { RequestBudgetPolicy } from '../../context/request-budget.js'

const client: StreamClient = { stream: async () => { throw new Error('planning must never dispatch') } }
const policy: RequestBudgetPolicy = { windowTokens: 8192, maxOutputTokens: 4096, transportLimits: 'none' }

for (const [name, text] of [['ASCII', 'x'.repeat(40_000)], ['CJK', '历史'.repeat(20_000)], ['Unicode', '🛰️'.repeat(15_001)]] as const) {
  test(`oversized ${name} text is covered completely by bounded summary requests`, () => {
    const marker = '\n[message:3 role:tool]\n'
    const requests = buildSummaryRequests([{ type: 'text', text: marker + text }], 'small', client, policy)!
    assert.ok(requests.length > 1)
    const fragments: string[] = []
    for (const request of requests) {
      assert.ok(summaryRequestFits(request, client, policy))
      const budget = buildContextBudget(request, policy, { requestId: 'test', revision: 0 })
      assert.ok(budget.inputTokens + request.max_tokens! + budget.safetyMargin <= policy.windowTokens)
      for (const part of request.messages[1]!.content as Array<{ type: 'text'; text: string }>) {
        assert.ok(part.text.startsWith(marker), 'each request retains source provenance')
        assert.doesNotMatch(part.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'each transmitted fragment is valid Unicode')
        fragments.push(part.text.slice(marker.length))
      }
    }
    assert.equal(fragments.join(''), text, 'splitting must neither lose nor duplicate history bytes')
  })
}

test('provider preview overhead participates in chunk planning and final preflight', () => {
  const previewClient: StreamClient = { ...client, previewContextRequest: request => ({ ...request,
    messages: [{ role: 'system', content: 'p'.repeat(12_000) }, ...request.messages],
  }) }
  const requests = buildSummaryRequests([{ type: 'text', text: '\n[message:0 role:assistant]\n' + 'x'.repeat(20_000) }], 'small', previewClient, policy)!
  assert.ok(requests.length > 1)
  for (const request of requests) assert.ok(summaryRequestFits(request, previewClient, policy))
  const changed: StreamClient = { ...client, previewContextRequest: request => ({ ...request, messages: [{ role: 'user', content: 'x'.repeat(40_000) }] }) }
  assert.equal(summaryRequestFits(requests[0]!, changed, policy), false, 'dispatch rechecks a changed preview')
})

test('summary focus is included as user content without changing the envelope instruction', () => {
  const focus = '保留认证复现步骤和未完成测试'
  const requests = buildSummaryRequests([{ type: 'text', text: '\n[message:3 role:tool]\nfailed auth' }], 'small', client, policy, 1024, focus)!
  assert.equal(requests[0]!.messages[0]!.content, SUMMARY_ENVELOPE_INSTRUCTION)
  assert.match(JSON.stringify(requests[0]!.messages[1]!.content), /保留认证复现步骤和未完成测试/)
  assert.match(JSON.stringify(requests[0]!.messages[1]!.content), /\[message:3 role:tool\]/)
})

test('impossible windows, indivisible attachments and excessive chunks fail before any dispatch', () => {
  assert.equal(buildSummaryRequests([{ type: 'text', text: 'hello' }], 'tiny', client, { ...policy, windowTokens: 16 }), undefined)
  assert.equal(buildSummaryRequests([{ type: 'image_url', image_url: { url: 'x'.repeat(41 * 1024 * 1024) } }], 'small', client, policy), undefined)
  assert.equal(buildSummaryRequests(Array.from({ length: 65 }, () => ({ type: 'text' as const, text: 'x'.repeat(20_000) })), 'small', client, policy), undefined)
})
