import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
/** src/pro 与 desktop/ 是闭源资产（公开仓不随 sync）：缺失返回 null，契约断言跳过。 */
const maybeSource = (path: string): string | null => {
  try { return source(path) } catch { return null }
}

test('budget reaches the real request builder, transport callbacks and desktop wrapper', () => {
  assert.match(source('../request-context-controller.ts'), /preview: request => .*previewContextRequest/ )
  assert.match(source('../turn-step-producer.ts'), /await this\.self\.prepareBudgetedRequest\(/)
  assert.match(source('../loop-factory.ts'), /recordContextBudget: budget => self\.recordContextBudget\(budget\)/)
  assert.match(source('../loop-factory.ts'), /preserveUserOnError: \(\) => !!self\.config\.promptEngine\.getRequestBudgetPolicy\(\)/)
  assert.match(source('../turn-orchestrator.ts'), /onContextBudget: callbacks\.onContextBudget/)
  assert.match(source('../../server/serve-agent.ts'), /getContextBudget: \(\) => agent\.getContextBudget\(\)/)
  assert.match(source('../../server/session-manager.ts'), /this\.append\(session, 'context_budget'/)
  assert.match(source('../create-agent-config.ts'), /requestBudgetPolicy: primaryClient\.previewContextRequest \? deepSeekBudgetPolicy\(provider\.baseUrl, model\.id, model\.contextWindow\)/)
  assert.match(source('../../api/factory.ts'), /contextWindow: provider\.models\?\.find\(m => m\.id === params\.model\)\?\.contextWindow/)
})

test('manual and isolated entry points use the same budget contract', () => {
  assert.match(source('../../server/serve-agent.ts'), /compactContext: \(\) => agent\.compactContext\(\)/)
  assert.match(source('../../tui/slash-commands.ts'), /ctx\.agent\.compactContext\(\)/)
  // src/pro 与 desktop/ 是闭源资产（公开仓不随 sync）：存在时钉契约，缺失跳过——
  // 硬性 ENOENT 会让公开仓 CI 恒红（2026-09 实测）。
  const proProtocol = maybeSource('../../pro/runtime/protocol.ts')
  if (proProtocol) {
    assert.match(proProtocol, /'getContextBudget'/)
    assert.match(proProtocol, /'compactContext'/)
  }
  const proBackend = maybeSource('../../pro/runtime/backend.ts')
  if (proBackend) assert.match(proBackend, /method === 'switchModel' \|\| method === 'compactContext'/)
  const proEngine = maybeSource('../../pro/runtime/engine.ts')
  if (proEngine) assert.match(proEngine, /'rewindToMessages', 'compactContext'\]\.includes\(method\)/)
  const threadView = maybeSource('../../../desktop/src/surfaces/ThreadView.tsx')
  if (threadView) {
    assert.match(threadView, /await compactSession\(session\.id\)/)
    assert.doesNotMatch(threadView, /onSend\('Context is getting long/)
  }
})
