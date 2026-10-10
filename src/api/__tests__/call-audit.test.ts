import { it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { beginCallAudit, readCallAudit, summarizeCallAudit } from '../call-audit.js'
import { OpenAIClient } from '../openai-client.js'
import { probeProvider } from '../provider-probe.js'
import { fetchWithTimeout } from '../fetch-timeout.js'
import { buildConfigRoutes } from '../../server/config-routes.js'

const home = mkdtempSync(join(tmpdir(), 'call-audit-test-'))
process.env.RIVET_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

it('actual wire, independent probe and non-chat transport have one completed audit each', async () => {
  let completions = 0
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'flash' }, { id: 'pro' }] })); return }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      completions++
      const model = JSON.parse(body).model
      response.setHeader('content-type', 'text/event-stream')
      response.end(`data: ${JSON.stringify({ id: `response-${completions}`, model: `${model}-actual`, system_fingerprint: 'server-fp', choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2, prompt_cache_hit_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  try {
    const client = new OpenAIClient({ baseUrl, apiKey: 'test-placeholder', providerName: 'mock-provider', model: 'flash', maxTokens: 64, sessionId: 'audit-session', maxRetries: 0 })
    await client.stream({ model: 'flash', messages: [{ role: 'user', content: 'private prompt marker' }], stream: true }, { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError: error => { throw error } })
    const main = readCallAudit({ sessionId: 'audit-session' }).calls
    assert.equal(main.length, 1); assert.equal(main[0]?.phase, 'finished'); assert.equal(main[0]?.model, 'flash')
    assert.equal(main[0]?.responseModel, 'flash-actual'); assert.equal(main[0]?.usageKnown, true)
    const report = await probeProvider({ baseUrl, apiKey: 'test-placeholder', providerName: 'mock-provider', probeModel: 'pro', vision: false })
    assert.equal(report.completionOk, true)
    const probe = readCallAudit({ purpose: 'provider_probe' }).calls
    assert.equal(probe.length, 1); assert.equal(probe[0]?.requestId, report.operationId)
    assert.equal(probe[0]?.model, 'pro'); assert.equal(probe[0]?.responseId, 'response-2')
    assert.equal(probe[0]?.usage?.prompt_tokens, 20); assert.equal(probe[0]?.sessionId, undefined)
    const native = await fetchWithTimeout(`${baseUrl}/responses`, { method: 'POST', body: JSON.stringify({ model: 'native' }) })
    assert.match(await native.text(), /hello/)
    assert.equal(readCallAudit({ model: 'native' }).calls[0]?.usageKnown, true)
    const routes = buildConfigRoutes('test-auth')
    const denied = await routes['GET /config/provider-calls']!({}, { model: 'pro' }, {})
    assert.equal(denied.status, 401)
    const allowed = await routes['GET /config/provider-calls']!({}, { model: 'pro' }, { authorization: 'Bearer test-auth' })
    assert.equal(allowed.status, 200); assert.equal((allowed.body as { calls: unknown[] }).calls.length, 1)
    const raw = readFileSync(join(home, 'logs', 'provider-calls.jsonl'), 'utf8')
    assert.doesNotMatch(raw, /private prompt marker|test-placeholder|Bearer/)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
it('finish is idempotent and absent usage remains unknown', () => {
  const audit = beginCallAudit({ model: 'unknown-usage', purpose: 'provider_probe' })
  audit.finish({ status: 'failed', errorName: 'NetworkError' }); audit.finish({ status: 'complete', usage: { input_tokens: 100 } })
  const rows = readCallAudit({ model: 'unknown-usage' }).calls
  assert.equal(rows.length, 1); assert.equal(rows[0]?.usageKnown, false); assert.equal(rows[0]?.status, 'failed')
})

it('retry attempts share a request identity and missing usage is never manufactured', async () => {
  let calls = 0
  const server = createServer((_request, response) => {
    if (++calls === 1) { response.writeHead(503); response.end('unavailable'); return }
    response.setHeader('content-type', 'text/event-stream')
    response.end('data: {"id":"retry-result","model":"flash","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  try {
    const client = new OpenAIClient({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'flash', maxTokens: 64, apiKey: '', maxRetries: 1, sessionId: 'audit-retry' })
    await client.stream({ model: 'flash', messages: [{ role: 'user', content: 'test' }], diagnostics: { purpose: 'worker_execution', workOrderId: 'mock-order', routeReason: 'explicit' } }, { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError: error => { throw error } })
    const rows = readCallAudit({ sessionId: 'audit-retry' }).calls
    assert.equal(rows.length, 2); assert.equal(rows[0]?.requestId, rows[1]?.requestId)
    assert.notEqual(rows[0]?.operationId, rows[1]?.operationId)
    assert.equal(rows.filter(row => row.status === 'failed').length, 1)
    assert.equal(rows.filter(row => row.status === 'complete').length, 1)
    assert.ok(rows.every(row => row.usageKnown === false && row.workOrderId === 'mock-order' && row.routeReason === 'explicit'))
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})


it('readCallAudit paginates with limit/before and reports the filtered total', () => {
  // beginCallAudit 的时间戳是 Date.now() 真值,快速连写会同毫秒撞车导致游标
  // 翻页不确定——直接往日志里写带确定性 t 的行。
  const log = join(home, 'logs', 'provider-calls.jsonl')
  const base = Date.now() - 10_000
  const lines = Array.from({ length: 5 }, (_, index) => JSON.stringify({
    operationId: `paged-${index}`, t: base + index * 1000, phase: 'finished', status: 'complete',
    model: 'paged-model', sessionId: 'paged-session', purpose: 'main_execution',
    usage: { input_tokens: 10 + index, output_tokens: 1 }, usageKnown: true,
  }))
  appendFileSync(log, `${lines.join('\n')}\n`)
  const first = readCallAudit({ model: 'paged-model', limit: 2 })
  assert.equal(first.calls.length, 2); assert.equal(first.total, 5)
  const cursor = first.calls[first.calls.length - 1]!.t
  const rest = readCallAudit({ model: 'paged-model', limit: 10, before: cursor })
  assert.equal(rest.calls.length, 3)
  assert.ok(rest.calls.every(row => row.t < cursor))
  assert.equal(rest.total, 5)
  // 默认上限 100、硬上限 500 的钳制
  assert.equal(readCallAudit({ model: 'paged-model', limit: 9999 }).calls.length, 5)
})

it('summarizeCallAudit folds worker purposes, keeps unattributed rows explicit and never manufactures usage', async () => {
  const since = Date.now()
  const complete = (purpose: string | undefined, model: string, usage?: Record<string, number>) => {
    const audit = beginCallAudit({ purpose, model, sessionId: 'sum-session' })
    audit.finish(usage ? { status: 'complete', usage } : { status: 'failed', errorName: 'Boom' })
  }
  complete('worker_execution', 'sum-flash', { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 })
  complete('worker_finalize', 'sum-flash', { input_tokens: 200, output_tokens: 50 })
  complete('worker_report_repair', 'sum-pro', { input_tokens: 100, output_tokens: 20 })
  complete('llm_speculation', 'sum-flash', { input_tokens: 5000, output_tokens: 10 })
  complete('side_question', 'sum-flash', { input_tokens: 300, output_tokens: 30 })
  complete('risk_explain', 'sum-flash', { input_tokens: 400, output_tokens: 40 })
  complete(undefined, 'sum-flash', { input_tokens: 700, output_tokens: 70 })
  complete('main_execution', 'sum-flash', undefined)

  const summary = summarizeCallAudit({ since, resolvePricing: () => ({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }) })
  const byGroup = new Map(summary.groups.map(group => [group.group, group]))

  const worker = byGroup.get('worker')
  assert.ok(worker, 'worker group exists')
  assert.equal(worker.requests, 3)
  assert.equal(worker.input, 1300); assert.equal(worker.output, 170); assert.equal(worker.cacheRead, 800)
  assert.equal(worker.models.length, 2, 'per-model breakdown splits sum-flash/sum-pro')
  assert.ok(worker.cost > 0 && worker.costKnown)

  assert.equal(byGroup.get('speculation')?.input, 5000)
  assert.equal(byGroup.get('side_question')?.input, 300)
  assert.equal(byGroup.get('risk_explain')?.input, 400)
  assert.equal(byGroup.get('unattributed')?.input, 700)

  const main = byGroup.get('main')
  assert.ok(main, 'main group exists even with usage-less rows')
  assert.equal(main.usageMissing, 1); assert.equal(main.input, 0)
  assert.equal(summary.totals.usageMissing, 1)
  assert.equal(summary.totals.requests, 8)
  assert.equal(summary.totals.input, 7700)

  const unpriced = summarizeCallAudit({ since })
  assert.ok(unpriced.groups.every(group => group.cost === 0 && !group.costKnown))

  // group 过滤:worker 三个 purpose 折叠成一组;无 purpose 行落入 unattributed
  assert.equal(readCallAudit({ sessionId: 'sum-session', group: 'worker' }).calls.length, 3)
  assert.equal(readCallAudit({ sessionId: 'sum-session', group: 'unattributed' }).calls.length, 1)

  const routes = buildConfigRoutes('test-auth')
  const denied = await routes['GET /config/provider-calls/summary']!({}, { days: '1' }, {})
  assert.equal(denied.status, 401)
  const allowed = await routes['GET /config/provider-calls/summary']!({}, { days: '1' }, { authorization: 'Bearer test-auth' })
  assert.equal(allowed.status, 200)
  assert.ok(Array.isArray((allowed.body as { groups: unknown[] }).groups))
})
