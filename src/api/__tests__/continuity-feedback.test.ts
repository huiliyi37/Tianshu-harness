import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ContinuationPrefixError, continuityFailureDetails, LocalWorkerPolicyError, proveWirePrefix } from '../continuation-prefix.js'
import { classifyApiError, errorRecoveryGuidance } from '../error-classifier.js'

test('continuity diagnostics identify projection deltas without exposing user content', () => {
  const old = proveWirePrefix({ messages: [{ role: 'user', content: 'private user message' }] }, 'fixture', 'old')
  const next = proveWirePrefix({ messages: [{ role: 'user', content: 'private user message' + 'x'.repeat(50) }] }, 'fixture', 'next')
  const error = new ContinuationPrefixError(0, old, next)
  const details = continuityFailureDetails(error)!
  assert.equal(details.kind, 'projection')
  assert.equal(details.deltaChars, 50)
  assert.equal(details.stage, 'unknown', 'a numeric wire index alone does not prove a projection defect')
  assert.ok(!JSON.stringify(details).includes('private user message'))
  assert.equal(classifyApiError(error).retryable, false)
  assert.match(errorRecoveryGuidance(error), /repair-prefix/)
  assert.doesNotMatch(errorRecoveryGuidance(error), /重发一次/)
  // issue #525：桌面端（sidecar slash 翻译层）不认 /repair-prefix 与 /logs——
  // 指引必须改指桌面端真实存在的入口，而不是让用户照敲一个会被拦截的命令。
  const desktopGuidance = errorRecoveryGuidance(error, 'desktop')
  assert.doesNotMatch(desktopGuidance, /repair-prefix/)
  assert.doesNotMatch(desktopGuidance, /\/logs/)
  assert.match(desktopGuidance, /检查运行环境/)
  assert.match(desktopGuidance, /设置 → 运行时环境 →「检查运行环境」/)
  for (const changed of ['source', 'tools', 'options', 'binding']) {
    assert.equal(continuityFailureDetails(new ContinuationPrefixError(changed, old, next))?.recovery, 'blocked')
  }
  assert.equal(continuityFailureDetails(new LocalWorkerPolicyError('已发布锚点缺失且无法核对原始字节'))?.kind, 'anchor_missing')
})
