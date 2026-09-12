import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ConnectFlow, suggestProviderName } from '../connect-flow.js'
import { PROVIDER_PRESETS, providerPresetKeys } from '../../config/provider-presets.js'
import { matchModelId } from '../../api/model-id-matcher.js'
import type { ProbeReport } from '../../api/provider-probe.js'
import type { ConnectDraft } from '../connect-draft.js'

function report(overrides: Partial<ProbeReport> = {}): ProbeReport {
  return {
    models: [],
    modelsOk: true,
    completionOk: true,
    hints: {},
    errors: [],
    ...overrides,
  }
}

/** Drive the DIY flow to the probe request and return it. */
function toProbe(flow: ConnectFlow, { url = 'https://api.example.com/v1', key = 'sk-x' } = {}) {
  flow.submitChoice('custom')
  flow.submitChoice('openai')
  flow.submitInput(url)
  const result = flow.submitInput(key)
  assert.equal(result.kind, 'probe')
  if (result.kind !== 'probe') throw new Error('unreachable')
  assert.equal(flow.view().kind, 'busy')
  return result
}

/** D2：把未知模型补参表单步走完（默认数字 + 指定模板），直到离开补参队列。 */
function answerUnknownModels(flow: ConnectFlow, template: 'generic' | 'reasoning' = 'generic', applyRest = false): void {
  while (flow.view().kind === 'form' && /模型补参/.test(flow.view().title)) {
    if (template === 'reasoning') flow.toggleAdvancedField('template')
    if (applyRest) flow.toggleAdvancedField('applyRest')
    assert.equal(flow.submitAdvancedForm().kind, 'next')
  }
}

test('provider step lists built-in presets plus a custom option', () => {
  const flow = new ConnectFlow()
  const view = flow.view()
  assert.equal(view.kind, 'choice')
  const ids = (view.options ?? []).map(o => o.id)
  assert.ok(ids.includes('deepseek'))
  assert.ok(ids.includes('custom'))
  // Recommended preset (deepseek) sorts first.
  assert.equal(view.options?.[0]?.id, 'deepseek')
  assert.equal(view.options?.[0]?.recommended, true)
  // Preset options expose their base URL as the description.
  const deepseek = view.options?.find(o => o.id === 'deepseek')
  assert.match(deepseek?.description ?? '', /^https?:\/\//)
})

test('A1: pasted full request URL is normalized — probe and commit use the base (DIY)', () => {
  const flow = new ConnectFlow()
  const probe = toProbe(flow, { url: 'https://api.example.com/v1/chat/completions' })
  assert.equal(probe.baseUrl, 'https://api.example.com/v1')
  flow.applyProbe(report({ models: ['some-model'] }))
  assert.match(flow.view().subtitle ?? '', /已规范化/)
  flow.submitChoice('continue')
  flow.confirm()
  answerUnknownModels(flow)
  flow.submitChoice('none')
  flow.submitInput('example-com')
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind === 'commit' && result.commit.mode === 'custom') {
    assert.equal(result.commit.baseUrl, 'https://api.example.com/v1')
  }
})

test('A1: preset endpoint step normalizes a pasted models URL before probing', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('deepseek')
  flow.submitInput('sk-test')
  const probe = flow.submitInput('https://api.deepseek.com/v1/models')
  assert.equal(probe.kind, 'probe')
  if (probe.kind === 'probe') assert.equal(probe.baseUrl, 'https://api.deepseek.com/v1')
})

test('A2: preset half-pass (completion ok, models failed) shows the report page first', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('deepseek')
  flow.submitInput('sk-test')
  flow.submitInput('')
  // 百炼按量计费形态：/models 400 降级，补全通——不能静默进模型步。
  const after = flow.applyProbe(report({ models: [], modelsOk: false, completionOk: true }))
  assert.equal(after.kind, 'next')
  assert.match(flow.view().title, /连通性测试/)
  const cont = flow.submitChoice('continue')
  assert.equal(cont.kind, 'next')
  assert.match(flow.view().title, /选择要添加的模型/)
})

test('preset path: 6 steps — key → endpoint → connectivity → models → capability → save', () => {
  const flow = new ConnectFlow()
  assert.equal(flow.submitChoice('deepseek').kind, 'next')
  const keyView = flow.view()
  assert.equal(keyView.kind, 'input')
  assert.equal(keyView.masked, true)
  assert.equal(keyView.stepLabel, '步骤 2 / 6')

  // [2/6] Endpoint confirm: official URL prefilled, Enter accepts, fires probe.
  assert.equal(flow.submitInput('sk-test-123').kind, 'next')
  const urlView = flow.view()
  assert.equal(urlView.kind, 'input')
  assert.match(urlView.title, /服务地址/)
  assert.equal(urlView.defaultValue, PROVIDER_PRESETS.deepseek.provider.baseUrl)
  assert.equal(urlView.stepLabel, '步骤 2 / 6')
  const probe = flow.submitInput('')
  assert.equal(probe.kind, 'probe')
  if (probe.kind !== 'probe') return
  assert.equal(probe.baseUrl, PROVIDER_PRESETS.deepseek.provider.baseUrl)
  assert.equal(probe.apiKey, 'sk-test-123')
  assert.equal(probe.probeModel, 'deepseek-v4-flash')

  // [3/6] Connectivity report — right after the probe (narrative order).
  assert.equal(flow.applyProbe(report({ models: ['deepseek-v4-pro'], latencyMs: 132 })).kind, 'next')
  const reportView = flow.view()
  assert.match(reportView.title, /连通性测试通过/)
  assert.equal(reportView.stepLabel, '步骤 3 / 6')
  const texts = (reportView.report ?? []).map(l => l.text)
  assert.ok(texts.some(t => /✔ 1\/3 检查端点连通性/.test(t)), 'checklist line 1')
  assert.ok(texts.some(t => /✔ 2\/3 获取模型列表（1 个）/.test(t)), 'checklist line 2')
  assert.ok(texts.some(t => /✔ 3\/3 发送最小推理请求（首字节 132ms）/.test(t)), 'checklist line 3')

  // [4/6] Model selection — preset templates checked by default.
  assert.equal(flow.submitChoice('continue').kind, 'next')
  const modelsView = flow.view()
  assert.equal(modelsView.kind, 'multi-choice')
  assert.equal(modelsView.stepLabel, '步骤 4 / 6')
  // 选项 = 预设模板 ∪ 探测新发现。模板列表随版本增删（2026-09 退役 v4-pro /
  // vision-exp），从 preset 现值推导而非钉死——c6537d191 的语义化先例。
  // 探测到的 v4-pro 官方档已退役、沦为「发现项」，但仍被别名表认识（代理
  // fleet preset 仍携带），故非聚合 preset 下同样默认勾选。
  const templateIds = PROVIDER_PRESETS.deepseek.provider.models.map(m => m.id)
  assert.deepEqual(modelsView.options?.map(o => o.label), [...templateIds, 'deepseek-v4-pro'])
  assert.deepEqual(modelsView.options?.map(o => o.checked), modelsView.options?.map(() => true))
  assert.match(modelsView.options?.[0]?.description ?? '', /预设/)

  // [5/6] Capability check — measured rows + metadata inferences.
  assert.equal(flow.confirm().kind, 'next')
  const capView = flow.view()
  assert.match(capView.title, /能力检测/)
  assert.equal(capView.stepLabel, '步骤 5 / 6')
  const caps = (capView.report ?? []).map(l => l.text)
  assert.ok(caps.some(t => /✔ Chat Completion（实测）/.test(t)), 'completion row')
  assert.ok(caps.some(t => /✔ 流式输出 SSE（实测）/.test(t)), 'streaming row')
  assert.ok(caps.some(t => /✔ Tool Calling/.test(t)), 'tool calling row')
  assert.ok(caps.some(t => /满足 coding agent 的基本要求/.test(t)), 'verdict row')

  // [6/6] Save confirm with the capability-check summary.
  assert.equal(flow.submitChoice('continue').kind, 'next')
  const confirmView = flow.view()
  assert.match(confirmView.title, /确认保存/)
  assert.equal(confirmView.stepLabel, '步骤 6 / 6')
  assert.match(confirmView.subtitle ?? '', /凭证校验通过/)
  assert.match(confirmView.subtitle ?? '', /secrets\.json/)

  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit') return
  assert.equal(result.commit.mode, 'preset')
  if (result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.providerName, 'deepseek')
  assert.equal(result.commit.setup.preset, 'deepseek')
  assert.equal(result.commit.setup.apiKey, 'sk-test-123')
  assert.equal(result.commit.setup.makeDefault, true)
  // Template ModelConfig objects carried through (1M context preserved).
  const pro = result.commit.setup.models?.find(m => m.id === 'deepseek-v4-pro')
  assert.equal(pro?.contextWindow, 1_000_000)
})

test('preset path: failed probe shows a structured report with causes and advice', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('deepseek')
  flow.submitInput('sk-bad')
  flow.submitInput('')
  flow.applyProbe(report({ models: [], modelsOk: false, completionOk: false, errors: ['Authentication failed (HTTP 401).'] }))
  const view = flow.view()
  assert.equal(view.kind, 'choice')
  assert.match(view.title, /连通性测试未通过/)
  assert.equal(view.stepLabel, '步骤 3 / 6')
  const texts = (view.report ?? []).map(l => l.text)
  assert.ok(texts.some(t => /✘ 1\/3 检查端点连通性/.test(t)))
  assert.ok(texts.some(t => /Authentication failed/.test(t)), 'error line present')
  assert.ok(texts.some(t => /可能原因/.test(t)))
  assert.ok(texts.some(t => /API Key 无效/.test(t)))
  assert.ok(texts.some(t => /建议操作/.test(t)))
  assert.deepEqual((view.options ?? []).map(o => o.id), ['rekey', 'edit-url', 'save-anyway'])
  assert.equal(view.options?.[0]?.recommended, true)

  // Save anyway → confirm step flagged as unprobed.
  const flow2 = new ConnectFlow()
  flow2.submitChoice('deepseek')
  flow2.submitInput('sk-bad')
  flow2.submitInput('')
  flow2.applyProbe(report({ models: [], modelsOk: false, completionOk: false, errors: ['boom'] }))
  assert.equal(flow2.submitChoice('save-anyway').kind, 'next')
  assert.match(flow2.view().subtitle ?? '', /探测未完全通过/)
  assert.equal(flow2.submitChoice('save').kind, 'commit')

  // Rekey returns to the key step with the previous key prefilled.
  assert.equal(flow.submitChoice('rekey').kind, 'next')
  assert.match(flow.view().title, /API 密钥/)
  assert.equal(flow.takeRestoredInput(), 'sk-bad')

  // Edit-url returns to the endpoint-confirm step with the URL prefilled.
  const flow3 = new ConnectFlow()
  flow3.submitChoice('deepseek')
  flow3.submitInput('sk-bad')
  flow3.submitInput('')
  flow3.applyProbe(report({ models: [], modelsOk: false, completionOk: false, errors: ['boom'] }))
  assert.equal(flow3.submitChoice('edit-url').kind, 'next')
  assert.match(flow3.view().title, /服务地址/)
  assert.equal(flow3.takeRestoredInput(), PROVIDER_PRESETS.deepseek.provider.baseUrl)
})

test('preset path: empty key is rejected without leaving the step', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('glm')
  const result = flow.submitInput('   ')
  assert.equal(result.kind, 'error')
  assert.equal(flow.view().kind, 'input')
})

test('oauth preset commits immediately without asking for a key', () => {
  const flow = new ConnectFlow()
  const result = flow.submitChoice('codex')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit') return
  assert.equal(result.commit.mode, 'preset')
  if (result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.apiKey, undefined)
  assert.match(result.summary, /OAuth|login|登录/i)
  assert.equal(result.commit.needsLogin, true, 'OAuth 预设带 needsLogin——connectExec 据此跳过热切换并指引 /login')
})

test('diy path: url → key emits a probe request (empty key allowed for local endpoints)', () => {
  const flow = new ConnectFlow()
  const probe = toProbe(flow)
  assert.equal(probe.baseUrl, 'https://api.example.com/v1')
  assert.equal(probe.apiKey, 'sk-x')
  assert.equal(probe.protocol, 'openai')

  const local = new ConnectFlow()
  local.submitChoice('custom')
  local.submitChoice('openai')
  local.submitInput('http://127.0.0.1:11434/v1')
  const localProbe = local.submitInput('')
  assert.equal(localProbe.kind, 'probe')
  if (localProbe.kind === 'probe') assert.equal(localProbe.apiKey, undefined)
})

test('diy path rejects a non-url base address', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('custom')
  flow.submitChoice('openai')
  const result = flow.submitInput('not-a-url')
  assert.equal(result.kind, 'error')
  assert.equal(flow.view().title, '输入服务商 API 地址')
})

test('diy path: probed models become a multi-select with metadata backfill', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  const applied = flow.applyProbe(report({
    models: ['deepseek-v4-pro', 'totally-new-model'],
    hints: { reasoningSplit: true },
  }))
  assert.equal(applied.kind, 'next')
  assert.match(flow.view().title, /连通性测试/)
  assert.equal(flow.submitChoice('continue').kind, 'next')
  const view = flow.view()
  assert.equal(view.kind, 'multi-choice')
  assert.equal(view.options?.length, 2)
  // All models checked by default.
  assert.deepEqual(view.options?.map(o => o.checked), [true, true])
  // Known model shows its canonical match; unknown shows the TODO hint.
  assert.match(view.options?.[0]?.description ?? '', /deepseek-v4-pro/)
  assert.match(view.options?.[1]?.description ?? '', /未知模型/)

  // Toggle one off.
  assert.equal(flow.toggle('0').kind, 'next')
  assert.deepEqual(flow.view().options?.map(o => o.checked), [false, true])

  // Empty-after-toggle guard only fires when nothing is checked.
  flow.toggle('1')
  const empty = flow.confirm()
  assert.equal(empty.kind, 'error')
  flow.toggle('1')

  const confirmed = flow.confirm()
  assert.equal(confirmed.kind, 'next')
  answerUnknownModels(flow, 'reasoning')

  // Thinking question — hint pre-recommends the split option.
  const thinkingView = flow.view()
  assert.equal(thinkingView.kind, 'choice')
  const split = thinkingView.options?.find(o => o.id === 'split')
  assert.equal(split?.recommended, true)
  assert.equal(flow.submitChoice('split').kind, 'next')

  // Provider name — blank uses the host-derived default; then the confirm gate.
  const nameView = flow.view()
  assert.equal(nameView.kind, 'input')
  assert.equal(nameView.defaultValue, 'example-com')
  const named = flow.submitInput('')
  assert.equal(named.kind, 'next')
  assert.match(flow.view().title, /确认保存/)
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') return
  assert.equal(result.commit.providerName, 'example-com')
  assert.equal(result.commit.baseUrl, 'https://api.example.com/v1')
  assert.equal(result.commit.apiKey, 'sk-x')
  assert.equal(result.commit.makeDefault, true)
  assert.equal(result.commit.models.length, 1)
  const model = result.commit.models[0]!
  // RAW endpoint id kept as the config id; alias-table metadata backfilled.
  assert.equal(model.id, 'totally-new-model')
  // Unknown model picks up the thinking answer.
  assert.deepEqual(model.capabilities, { reasoningSplit: true })
})

test('diy path: known model backfills contextWindow and keeps its own capabilities', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: ['deepseek-v4-pro'] }))
  flow.submitChoice('continue')
  flow.confirm()
  flow.submitChoice('split')
  assert.equal(flow.submitInput('my-relay').kind, 'next')
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') return
  assert.equal(result.commit.providerName, 'my-relay')
  const model = result.commit.models[0]!
  assert.equal(model.id, 'deepseek-v4-pro')
  // 回填值来自别名表元数据，而别名表由全仓 preset 合成、随版本增删演化
  // （v4-pro 官方档 2026-09 退役后，首个携带者变为代理 fleet 的 64K 档）——
  // 断言「回填发生且等于别名表现值」，不钉死具体数字。
  const known = matchModelId('deepseek-v4-pro').entry
  assert.ok(known, 'deepseek-v4-pro 应仍被别名表认识（某 preset 携带）')
  assert.equal(model.contextWindow, known.metadata.contextWindow)
  assert.equal(model.maxTokens, known.metadata.maxTokens)
})

test('diy path: probe with no models but working completion falls back to manual entry', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: [], modelsOk: false, errors: ['models endpoint 404'] }))
  assert.match(flow.view().title, /连通性测试/)
  assert.equal(flow.submitChoice('continue').kind, 'next')
  const view = flow.view()
  assert.equal(view.kind, 'input')
  assert.match(view.title, /输入模型型号/)

  assert.equal(flow.submitInput('my-model-v1').kind, 'next')
  assert.equal(flow.submitChoice('none').kind, 'next')
  assert.equal(flow.submitInput('my-relay').kind, 'next')
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') return
  // Manual path ships a bare id — registerProvider materializes sizes.
  assert.deepEqual(result.commit.models, [{ id: 'my-model-v1' }])
})

test('diy path: total probe failure offers manual entry or going back', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: [], modelsOk: false, completionOk: false, errors: ['auth-failed'] }))
  const view = flow.view()
  assert.equal(view.kind, 'choice')
  assert.match(view.subtitle ?? '', /auth-failed/)

  // back → url step
  assert.equal(flow.submitChoice('back').kind, 'next')
  assert.equal(flow.view().title, '输入服务商 API 地址')
})

test('diy path: probeFailed (network error) routes to the probe-failed choice', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  const result = flow.probeFailed('fetch timeout')
  assert.equal(result.kind, 'next')
  const view = flow.view()
  assert.equal(view.kind, 'choice')
  assert.match(view.subtitle ?? '', /fetch timeout/)
  // manual → model entry
  assert.equal(flow.submitChoice('manual').kind, 'next')
  assert.equal(flow.view().kind, 'input')
})

test('diy path: preset name is rejected at the name step', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: ['some-model'] }))
  flow.submitChoice('continue')
  flow.confirm()
  answerUnknownModels(flow)
  flow.submitChoice('none')
  const result = flow.submitInput('deepseek')
  assert.equal(result.kind, 'error')
  assert.match((result as { message: string }).message, /内置服务商/)
})

test('diy path: invalid provider name characters rejected', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: ['some-model'] }))
  flow.submitChoice('continue')
  flow.confirm()
  answerUnknownModels(flow)
  flow.submitChoice('none')
  const result = flow.submitInput('My Provider!')
  assert.equal(result.kind, 'error')
})

test('suggestProviderName derives a slug from the host', () => {
  assert.equal(suggestProviderName('https://api.example.com/v1'), 'example-com')
  assert.equal(suggestProviderName('http://127.0.0.1:3000/v1'), '127-0-0-1')
  assert.equal(suggestProviderName('not a url'), 'custom')
  // Host is lowercased by the URL parser, so mixed case normalizes too.
  assert.equal(suggestProviderName('https://API.Example.COM/v1'), 'example-com')
  // Port never leaks into the slug (hostname excludes it).
  assert.equal(suggestProviderName('http://localhost:11434/v1'), 'localhost')
  // Multi-level subdomains keep everything after api.
  assert.equal(suggestProviderName('https://api.gw.example.co.uk/v1'), 'gw-example-co-uk')
  // Host without the api. prefix passes through as-is.
  assert.equal(suggestProviderName('https://relay.internal.lan/v1'), 'relay-internal-lan')
})

test('add-model option is hidden when no providers are configured', () => {
  const flow = new ConnectFlow()
  const ids = (flow.view().options ?? []).map(o => o.id)
  assert.ok(!ids.includes('existing'), 'no configured providers → no add-model option')
})

test('add-model option appears when providers exist', () => {
  const flow = new ConnectFlow([{ name: 'deepseek', label: 'DeepSeek', modelCount: 2 }])
  const ids = (flow.view().options ?? []).map(o => o.id)
  assert.ok(ids.includes('existing'))
})

test('add-model path: pick provider → model → context → vision commits add-model', () => {
  const flow = new ConnectFlow([
    { name: 'deepseek', label: 'DeepSeek', modelCount: 2 },
    { name: 'glm', label: 'GLM', modelCount: 3 },
  ])
  // provider step → add-model branch
  assert.equal(flow.submitChoice('existing').kind, 'next')
  const pickView = flow.view()
  assert.equal(pickView.kind, 'choice')
  assert.equal(pickView.title, '为哪个服务商添加模型？')
  const pickIds = (pickView.options ?? []).map(o => o.id)
  assert.deepEqual(pickIds, ['deepseek', 'glm'])

  // pick the provider → straight to model id (no URL step)
  assert.equal(flow.submitChoice('glm').kind, 'next')
  assert.equal(flow.view().title, '输入模型型号')
  assert.equal(flow.view().stepLabel, '步骤 1 / 3')

  assert.equal(flow.submitInput('glm-vision-x').kind, 'next')
  assert.equal(flow.view().stepLabel, '步骤 2 / 3')
  assert.equal(flow.submitInput('131072').kind, 'next')
  assert.equal(flow.view().stepLabel, '步骤 3 / 3')

  // vision choice ends the flow — no API key step for an existing provider
  const result = flow.submitChoice('yes')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit') return
  assert.equal(result.commit.mode, 'add-model')
  if (result.commit.mode !== 'add-model') return
  assert.equal(result.commit.providerName, 'glm')
  assert.equal(result.commit.model.id, 'glm-vision-x')
  assert.equal(result.commit.model.contextWindow, 131072)
  assert.equal(result.commit.model.maxTokens, 64000)
  assert.equal(result.commit.model.supportsVision, true)
  assert.match(result.summary, /glm.*glm-vision-x/)
})

test('add-model path: vision "no" leaves supportsVision absent', () => {
  const flow = new ConnectFlow([{ name: 'deepseek', modelCount: 1 }])
  flow.submitChoice('existing')
  flow.submitChoice('deepseek')
  flow.submitInput('text-only-x')
  flow.submitInput('')
  const result = flow.submitChoice('no')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'add-model') return
  assert.equal(result.commit.model.supportsVision, undefined)
})

test('add-model path: unknown provider choice is rejected', () => {
  const flow = new ConnectFlow([{ name: 'deepseek', modelCount: 1 }])
  flow.submitChoice('existing')
  const result = flow.submitChoice('ghost')
  assert.equal(result.kind, 'error')
  assert.equal(flow.view().kind, 'choice')
})

// ── draft save/restore ──

function draft(overrides: Partial<ConnectDraft> = {}): ConnectDraft {
  return {
    version: 1,
    savedAt: Date.now(),
    phase: 'diy-url',
    collected: {},
    ...overrides,
  }
}

test('draft: valid draft opens the resume prompt; resume restores the key step', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'preset-apikey',
    collected: { presetKey: 'deepseek' },
    pendingInput: 'sk-half',
  }))
  const view = flow.view()
  assert.equal(view.kind, 'choice')
  assert.match(view.title, /上次的配置进度/)
  assert.match(view.subtitle ?? '', /输入 API 密钥/)
  assert.ok(flow.draftPromptPending())
  assert.ok((view.options ?? []).some(o => o.id === 'resume'))

  const result = flow.submitChoice('resume')
  assert.equal(result.kind, 'next')
  assert.equal(flow.view().kind, 'input')
  assert.equal(flow.view().masked, true)
  assert.equal(flow.takeRestoredInput(), 'sk-half')
  assert.equal(flow.takeRestoredInput(), undefined) // read-once
  assert.equal(flow.submitInput('sk-test-123').kind, 'next')
  const probe = flow.submitInput('')
  assert.equal(probe.kind, 'probe')
  assert.equal(flow.applyProbe(report()).kind, 'next')      // [3/6] report
  assert.equal(flow.submitChoice('continue').kind, 'next')  // [4/6] models
  assert.equal(flow.confirm().kind, 'next')                 // [5/6] capability
  assert.equal(flow.submitChoice('continue').kind, 'next')  // [6/6] confirm
  const commit = flow.submitChoice('save')
  assert.equal(commit.kind, 'commit')
  if (commit.kind !== 'commit' || commit.commit.mode !== 'preset') return
  assert.equal(commit.commit.setup.apiKey, 'sk-test-123')
})

test('draft: diy-models resume recomputes matcher results and keeps checkbox state', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'diy-models',
    collected: {
      baseUrl: 'https://api.example.com/v1',
      keyRef: 'diy-pending',
      probedSelection: [
        { rawId: 'deepseek-v4-pro', checked: true },
        { rawId: 'mystery-x', checked: false },
      ],
    },
  }), 'sk-x')
  flow.submitChoice('resume')
  const view = flow.view()
  assert.equal(view.kind, 'multi-choice')
  assert.equal(view.options?.[0]?.label, 'deepseek-v4-pro')
  assert.equal(view.options?.[0]?.checked, true)
  assert.equal(view.options?.[1]?.label, 'mystery-x')
  assert.equal(view.options?.[1]?.checked, false)
  assert.match(view.options?.[1]?.description ?? '', /未知模型/)
})

test('draft: transient probe phases resume at the address step — Enter re-fires the probe', () => {
  // 探测中/失败/报告页都是瞬态——恢复到触发探测的地址步（预填地址），
  // 回车直接再探测；密钥已随 keyRef 恢复，不让用户重输。
  for (const phase of ['diy-probing', 'diy-probe-failed', 'probe-report'] as const) {
    const flow = new ConnectFlow([], draft({
      phase,
      collected: { baseUrl: 'https://api.example.com/v1', keyRef: 'diy-pending' },
    }), 'sk-x')
    flow.submitChoice('resume')
    const view = flow.view()
    assert.match(view.title, /API 地址/, phase)
    assert.equal(flow.takeRestoredInput(), 'https://api.example.com/v1', phase)
    const probe = flow.submitInput('https://api.example.com/v1')
    assert.equal(probe.kind, 'probe', phase)
    if (probe.kind === 'probe') assert.equal(probe.apiKey, 'sk-x', phase)
  }
})

test('probe-failed back → address step prefilled; resubmit re-probes without re-entering the key', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.probeFailed('boom')
  flow.submitChoice('back')
  assert.match(flow.view().title, /API 地址/)
  assert.equal(flow.takeRestoredInput(), 'https://api.example.com/v1')
  const probe = flow.submitInput('https://api.example.com/v1')
  assert.equal(probe.kind, 'probe')
  if (probe.kind === 'probe') assert.equal(probe.apiKey, 'sk-x')
})

test('vision real-test success shows the model answer and the image ground truth', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe({
    models: ['glm-4v-flash'],
    modelsOk: true,
    completionOk: true,
    hints: {},
    errors: [],
    visionTested: true,
    visionAnswer: '一张红色的正方形图片',
    probedModel: 'glm-4v-flash',
  })
  const view = flow.view()
  const text = view.report?.map(l => l.text).join('\n') ?? ''
  assert.match(text, /视觉真测/, '3/3 步应改称视觉真测')
  assert.match(text, /一张红色的正方形图片/, '展示模型回答')
  assert.match(text, /纯红色正方形/, '展示图片真相供用户核对')
})

test('probe-report completion failure offers 换个模型重探; vision ids sort first and pick re-fires the probe', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe({
    models: ['agnes-random-text', 'glm-5.2'],
    modelsOk: true,
    completionOk: false,
    hints: {},
    errors: ['HTTP 404 from https://api.example.com/v1 — model id does not exist'],
  })
  const report = flow.view()
  assert.ok(report.options?.some(o => o.id === 'reprobe-pick'), '补全失败且有模型列表 → 提供换模型重探')
  flow.submitChoice('reprobe-pick')
  const pick = flow.view()
  assert.match(pick.title, /选择重探用的模型/)
  assert.equal(pick.options?.[0]?.id, 'glm-5.2', '别名表认识的视觉档排最前')
  const probe = flow.submitChoice('glm-5.2')
  assert.equal(probe.kind, 'probe')
  if (probe.kind === 'probe') assert.equal(probe.probeModel, 'glm-5.2')
})

test('draft: reprobe-pick is transient — toDraft maps it back to probe-report', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe({ models: ['m1'], modelsOk: true, completionOk: false, hints: {}, errors: ['boom'] })
  flow.submitChoice('reprobe-pick')
  const snap = flow.toDraft()
  assert.ok(snap)
  assert.equal(snap.phase, 'probe-report')
})

test('draft: diy-models without a stored selection falls back to the key step', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'diy-models',
    collected: { baseUrl: 'https://api.example.com/v1', keyRef: 'diy-pending' },
  }), 'sk-x')
  flow.submitChoice('resume')
  assert.match(flow.view().title, /API Key/)
})

test('draft: capability/ask-default/confirm restore to the exact saved step', () => {
  const collected = {
    presetKey: 'deepseek',
    keyRef: 'deepseek',
    probedSelection: [{ rawId: 'deepseek-v4-pro', checked: true }],
  }
  const cap = new ConnectFlow([], draft({ phase: 'capability', collected }), 'sk-x')
  cap.submitChoice('resume')
  assert.match(cap.view().title, /能力检测/)
  assert.equal(cap.view().stepLabel, '步骤 5 / 6')

  const ask = new ConnectFlow([], draft({ phase: 'ask-default', collected }), 'sk-x')
  ask.submitChoice('resume')
  assert.match(ask.view().title, /设为默认/)

  const conf = new ConnectFlow([], draft({ phase: 'confirm', collected }), 'sk-x')
  conf.submitChoice('resume')
  assert.match(conf.view().title, /确认保存/)
  assert.equal(conf.view().stepLabel, '步骤 6 / 6')
})

test('draft: preset confirm without models (skip-probe) still restores to confirm', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'confirm',
    collected: { presetKey: 'deepseek', keyRef: 'deepseek' },
  }), 'sk-x')
  flow.submitChoice('resume')
  assert.match(flow.view().title, /确认保存/)
})

test('draft: diy confirm restores exactly when name + models survive', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'confirm',
    collected: {
      baseUrl: 'https://api.example.com/v1',
      keyRef: 'diy-pending',
      providerName: 'my-relay',
      probedSelection: [{ rawId: 'm1', checked: true }],
      makeDefault: false,
    },
  }), 'sk-x')
  flow.submitChoice('resume')
  assert.match(flow.view().title, /确认保存/)
  // 无现存默认服务商（needsDefaultAsk false）——back 直接回命名步。
  const back = flow.submitChoice('back')
  assert.equal(back.kind, 'next')
  assert.match(flow.view().title, /起个名字/)
})

test('draft: diy-name without a thinking answer slides down to the thinking step', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'diy-name',
    collected: { baseUrl: 'https://api.example.com/v1', keyRef: 'diy-pending', modelId: 'some-model' },
  }), 'sk-x')
  flow.submitChoice('resume')
  assert.match(flow.view().title, /深度思考/)
})

test('draft: unknown or OAuth preset key is rejected wholesale', () => {
  for (const presetKey of ['no-such-preset', 'codex']) {
    const flow = new ConnectFlow([], draft({ phase: 'preset-apikey', collected: { presetKey } }))
    assert.equal(flow.draftRejected, true, presetKey)
    assert.match(flow.view().title, /连接模型服务商/)
  }
})

test('draft: add-model resume rejects when the provider was deleted meanwhile', () => {
  const stale = new ConnectFlow([], draft({
    phase: 'diy-context',
    collected: { existingProvider: 'gone', modelId: 'm' },
  }))
  assert.equal(stale.draftRejected, true)
  const valid = new ConnectFlow([{ name: 'kept', modelCount: 1 }], draft({
    phase: 'diy-context',
    collected: { existingProvider: 'kept', modelId: 'm' },
  }))
  assert.equal(valid.draftRejected, false)
  valid.submitChoice('resume')
  assert.match(valid.view().title, /上下文长度/)
})

test('draft: discard returns to the provider list and flags wasDraftDiscarded', () => {
  const flow = new ConnectFlow([], draft({ pendingInput: 'https://half' }))
  assert.ok(flow.draftPromptPending())
  const result = flow.submitChoice('discard')
  assert.equal(result.kind, 'next')
  assert.ok(flow.wasDraftDiscarded())
  assert.equal(flow.hasProgress(), false)
  assert.match(flow.view().title, /连接模型服务商/)
})

test('draft: no progress before the key is saved — pre-key Esc is a pure cancel', () => {
  const flow = new ConnectFlow()
  assert.equal(flow.hasProgress(), false)
  assert.equal(flow.toDraft(), undefined)
  flow.submitChoice('custom')
  flow.submitChoice('openai')
  flow.submitInput('https://api.example.com/v1') // URL 步——仍未存密钥
  assert.equal(flow.hasProgress(), false, '密钥保存前不落草稿')
  assert.equal(flow.toDraft(), undefined)
  flow.submitInput('sk-x') // 密钥提交 → 探测 busy
  assert.equal(flow.hasProgress(), true)
  assert.ok(flow.toDraft())
})

test('keyless DIY: submitting an empty key is progress and address retries skip the key step', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('custom')
  flow.submitChoice('openai')
  flow.submitInput('http://127.0.0.1:11434/v1')
  const firstProbe = flow.submitInput('')
  assert.equal(firstProbe.kind, 'probe')
  assert.equal(flow.hasProgress(), true, '明确提交空密钥后已经越过凭证门槛')
  const snap = flow.toDraft()
  assert.ok(snap)
  assert.equal(snap.collected.authConfirmed, true)
  assert.equal(snap.collected.keyRef, undefined)

  flow.probeFailed('offline')
  flow.submitChoice('back')
  const retry = flow.submitInput('http://127.0.0.1:11434/v1')
  assert.equal(retry.kind, 'probe', '修改地址后直接重探，不重新进入密钥步')
  if (retry.kind === 'probe') assert.equal(retry.apiKey, undefined)
})

test('draft: keyless DIY transient phases restore to address and re-probe without a secret ref', () => {
  for (const phase of ['diy-probing', 'diy-probe-failed', 'probe-report'] as const) {
    const flow = new ConnectFlow([], draft({
      phase,
      collected: { baseUrl: 'http://127.0.0.1:11434/v1', authConfirmed: true },
    }))
    flow.submitChoice('resume')
    assert.match(flow.view().title, /API 地址/, phase)
    assert.equal(flow.takeRestoredInput(), 'http://127.0.0.1:11434/v1', phase)
    const probe = flow.submitInput('http://127.0.0.1:11434/v1')
    assert.equal(probe.kind, 'probe', phase)
    if (probe.kind === 'probe') assert.equal(probe.apiKey, undefined, phase)
  }
})

test('draft: preset step 2 (API key) has no draft; endpoint step (post-key) does', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('deepseek')
  assert.match(flow.view().title, /API 密钥/)
  assert.equal(flow.view().stepLabel, '步骤 2 / 6')
  assert.equal(flow.hasProgress(), false)
  assert.equal(flow.toDraft(), undefined)
  flow.submitInput('sk-test')
  const snap = flow.toDraft()
  assert.ok(snap)
  assert.equal(snap.phase, 'preset-endpoint')
})

test('draft: toDraft snapshots progress, carries pending input, drops transient fields', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.probeFailed('boom')
  const snap = flow.toDraft('partial')
  assert.ok(snap)
  assert.equal(snap.phase, 'diy-probe-failed')
  assert.equal(snap.collected.baseUrl, 'https://api.example.com/v1')
  // 草稿永不落明文密钥——keyRef 由 app 层在落盘前挂载。
  assert.equal('apiKey' in snap.collected, false)
  assert.equal(snap.pendingInput, 'partial')
  assert.equal('probeError' in snap.collected, false)
  // JSON 序列化安全（草稿要落盘）。
  JSON.parse(JSON.stringify(snap))
})

test('draft: toDraft from diy-models stores only the checkbox selection', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: ['deepseek-v4-pro', 'other-model'] }))
  flow.submitChoice('continue')
  flow.toggle('1') // uncheck the second
  const snap = flow.toDraft()
  assert.ok(snap)
  assert.deepEqual(snap.collected.probedSelection, [
    { rawId: 'deepseek-v4-pro', checked: true },
    { rawId: 'other-model', checked: false },
  ])
  assert.equal('probedModels' in snap.collected, false)
})

test('provider step lists the new spec presets (kimi/openai/volc/ollama) + compat entry', () => {
  const flow = new ConnectFlow()
  const view = flow.view()
  const ids = (view.options ?? []).map(o => o.id)
  for (const expected of ['kimi', 'openai', 'volc', 'ollama', 'openai-compat', 'custom']) {
    assert.ok(ids.includes(expected), `missing option: ${expected}`)
  }
  // 免密钥 preset 的描述标注「免密钥」。
  const ollama = view.options?.find(o => o.id === 'ollama')
  assert.match(ollama?.description ?? '', /免密钥/)
})

test('kimi preset: key → endpoint → probe → report → models → capability → commit', () => {
  const flow = new ConnectFlow()
  const afterPick = flow.submitChoice('kimi')
  assert.equal(afterPick.kind, 'next')
  assert.equal(flow.view().kind, 'input')
  assert.equal(flow.submitInput('sk-moon-123').kind, 'next')
  const probe = flow.submitInput('')
  assert.equal(probe.kind, 'probe')
  assert.equal(flow.applyProbe(report()).kind, 'next')
  assert.match(flow.view().title, /连通性测试/)
  assert.equal(flow.submitChoice('continue').kind, 'next')
  if (flow.view().kind === 'multi-choice') {
    assert.equal(flow.confirm().kind, 'next')
    assert.match(flow.view().title, /能力检测/)
    assert.equal(flow.submitChoice('continue').kind, 'next')
  }
  assert.match(flow.view().title, /确认保存/)
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit') return
  assert.equal(result.commit.mode, 'preset')
  if (result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.providerName, 'kimi')
  assert.equal(result.commit.setup.apiKey, 'sk-moon-123')
})

test('openai-compat choice routes into the DIY url step', () => {
  const flow = new ConnectFlow()
  const result = flow.submitChoice('openai-compat')
  assert.equal(result.kind, 'next')
  assert.match(flow.view().title, /API 地址/)
})

test('B3: custom entry asks the wire protocol first (step 1 / 9)', () => {
  const flow = new ConnectFlow()
  assert.equal(flow.submitChoice('custom').kind, 'next')
  const view = flow.view()
  assert.equal(view.kind, 'choice')
  assert.match(view.title, /协议/)
  assert.equal(view.stepLabel, '步骤 1 / 9')
  assert.deepEqual(view.options?.map(o => o.id), ['openai', 'anthropic'])
  assert.equal(flow.submitChoice('ghost').kind, 'error')
  assert.equal(flow.submitChoice('openai').kind, 'next')
  assert.equal(flow.view().stepLabel, '步骤 2 / 9')
})

test('B3: anthropic protocol flows through probe and commit', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('custom')
  flow.submitChoice('anthropic')
  assert.match(flow.view().subtitle ?? '', /Anthropic/)
  flow.submitInput('https://api.anthropic.com')
  const probe = flow.submitInput('sk-ant-x')
  assert.equal(probe.kind, 'probe')
  if (probe.kind !== 'probe') return
  assert.equal(probe.protocol, 'anthropic')
  flow.applyProbe(report({ models: ['claude-sonnet-4-5'] }))
  flow.submitChoice('continue')
  flow.confirm()
  flow.submitChoice('none')
  flow.submitInput('anthropic-relay')
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') return
  assert.equal(result.commit.protocol, 'anthropic')
})

test('B3: diy-url draft keeps the chosen protocol on resume', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'diy-url',
    collected: { protocol: 'anthropic' },
  }))
  flow.submitChoice('resume')
  assert.match(flow.view().title, /API 地址/)
  assert.match(flow.view().subtitle ?? '', /Anthropic/)
  flow.submitInput('https://api.anthropic.com')
  const probe = flow.submitInput('sk-ant-x')
  assert.equal(probe.kind, 'probe')
  if (probe.kind === 'probe') assert.equal(probe.protocol, 'anthropic')
})

// ── C1: 默认服务商替换确认（仅当已有「另一个」默认时询问）──

function diyToName(flow: ConnectFlow): void {
  toProbe(flow)
  flow.applyProbe(report({ models: ['some-model'] }))
  flow.submitChoice('continue')
  flow.confirm()
  answerUnknownModels(flow)
  flow.submitChoice('none')
}

test('C1: another default exists → ask-default gate before confirm (yes replaces)', () => {
  const flow = new ConnectFlow([], undefined, undefined, 'deepseek')
  diyToName(flow)
  flow.submitInput('my-relay')
  assert.match(flow.view().title, /设为默认/)
  assert.match(flow.view().subtitle ?? '', /deepseek/)
  assert.equal(flow.submitChoice('yes').kind, 'next')
  assert.match(flow.view().title, /确认保存/)
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') return
  assert.equal(result.commit.makeDefault, true)
})

test('C1: answering no keeps the existing default on commit', () => {
  const flow = new ConnectFlow([], undefined, undefined, 'deepseek')
  diyToName(flow)
  flow.submitInput('my-relay')
  assert.equal(flow.submitChoice('no').kind, 'next')
  assert.match(flow.view().title, /确认保存/)
  assert.match(flow.view().subtitle ?? '', /保留现有默认/)
  const result = flow.submitChoice('save')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') throw new Error('expected custom commit')
  assert.equal(result.commit.makeDefault, false)
})

test('C1: confirm back returns to the question, then further back to naming', () => {
  const flow = new ConnectFlow([], undefined, undefined, 'deepseek')
  diyToName(flow)
  flow.submitInput('my-relay')
  flow.submitChoice('yes')
  assert.match(flow.view().title, /确认保存/)
  assert.equal(flow.submitChoice('back').kind, 'next')
  assert.match(flow.view().title, /设为默认/)
  assert.equal(flow.submitChoice('back').kind, 'next')
  assert.match(flow.view().title, /起个名字/)
  assert.equal(flow.takeRestoredInput(), 'my-relay')
})

test('C1: no existing default → straight to confirm, silently default', () => {
  const flow = new ConnectFlow()
  diyToName(flow)
  flow.submitInput('my-relay')
  assert.match(flow.view().title, /确认保存/)
  const result = flow.submitChoice('save')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') throw new Error('expected custom commit')
  assert.equal(result.commit.makeDefault, true)
})

test('C1: reconfiguring the provider that is already default skips the question', () => {
  const flow = new ConnectFlow([], undefined, undefined, 'deepseek')
  flow.submitChoice('deepseek')
  flow.submitInput('sk-x')
  flow.submitInput('')
  flow.applyProbe(report({ models: ['deepseek-v4-pro'] }))
  flow.submitChoice('continue')
  flow.confirm()
  flow.submitChoice('continue')
  assert.match(flow.view().title, /确认保存/)
})

test('C2: WorkspaceId template step carries the console path hint', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('dashscope')
  flow.submitChoice('payg')
  flow.submitInput('sk-x')
  assert.match(flow.view().subtitle ?? '', /业务空间/)
  const blocked = flow.submitInput('')
  assert.equal(blocked.kind, 'error')
  if (blocked.kind === 'error') assert.match(blocked.message, /业务空间/)
})

test('ollama keyless: pick → endpoint confirm (prefilled, editable) → probe', () => {
  const flow = new ConnectFlow()
  const result = flow.submitChoice('ollama')
  assert.equal(result.kind, 'next')
  const view = flow.view()
  assert.equal(view.kind, 'input')
  assert.match(view.title, /服务地址/)
  assert.equal(view.defaultValue, 'http://127.0.0.1:11434/v1')
  // Enter accepts the prefilled address and fires the probe without a key.
  const probe = flow.submitInput('')
  assert.equal(probe.kind, 'probe')
  if (probe.kind !== 'probe') return
  assert.equal(probe.baseUrl, 'http://127.0.0.1:11434/v1')
  assert.equal(probe.apiKey, undefined)
  assert.equal(flow.view().kind, 'busy')
})

test('ollama keyless: edited endpoint address is probed and committed', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('ollama')
  const probe = flow.submitInput('http://192.168.1.50:11434/v1')
  assert.equal(probe.kind, 'probe')
  if (probe.kind !== 'probe') return
  assert.equal(probe.baseUrl, 'http://192.168.1.50:11434/v1')
  flow.applyProbe(report({ models: ['qwen3:8b'] }))
  flow.submitChoice('continue')
  flow.confirm()
  flow.submitChoice('none')
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.baseUrl, 'http://192.168.1.50:11434/v1')
})

test('ollama keyless: probe success → report → models → thinking → confirm → preset commit', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('ollama')
  flow.submitInput('')
  flow.applyProbe(report({ models: ['qwen3:8b', 'llama3.1'] }))
  assert.match(flow.view().title, /连通性测试/)
  assert.equal(flow.submitChoice('continue').kind, 'next')
  assert.equal(flow.view().kind, 'multi-choice')
  const confirmed = flow.confirm()
  assert.equal(confirmed.kind, 'next')
  answerUnknownModels(flow)
  assert.equal(flow.submitChoice('none').kind, 'next')
  assert.match(flow.view().title, /确认保存/)
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit') return
  assert.equal(result.commit.mode, 'preset')
  if (result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.providerName, 'ollama')
  assert.equal(result.commit.setup.preset, 'ollama')
  assert.deepEqual(result.commit.setup.models?.map(m => m.id), ['qwen3:8b', 'llama3.1'])
  // D2：llama3.1 不在别名表——补参（默认窗口/输出）落进 commit；
  // qwen3:8b 走 L2 归一命中 qwen3 条目，直接用别名表元数据。
  assert.equal(result.commit.setup.models?.[1]?.contextWindow, 131_072)
  assert.equal(result.commit.setup.models?.[1]?.maxTokens, 32_768)
  assert.equal(result.commit.setup.apiKey, undefined)
})

test('ollama keyless: probe without model list → manual model → preset commit', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('ollama')
  flow.submitInput('')
  flow.applyProbe(report({ models: [] }))
  assert.match(flow.view().title, /连通性测试/)
  assert.equal(flow.submitChoice('continue').kind, 'next')
  assert.equal(flow.view().kind, 'input') // diy-model
  flow.submitInput('qwen3:latest')
  assert.equal(flow.submitChoice('none').kind, 'next')
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit') return
  assert.equal(result.commit.mode, 'preset')
  if (result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.providerName, 'ollama')
  assert.deepEqual(result.commit.setup.models?.map(m => m.id), ['qwen3:latest'])
})

test('confirm back: DIY returns to naming with the name prefilled', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: ['deepseek-v4-pro'] }))
  flow.submitChoice('continue')
  flow.confirm()
  flow.submitChoice('none')
  flow.submitInput('my-relay')
  assert.match(flow.view().title, /确认保存/)
  assert.equal(flow.submitChoice('back').kind, 'next')
  assert.match(flow.view().title, /起个名字/)
  assert.equal(flow.takeRestoredInput(), 'my-relay')
  // Re-submit lands back on confirm; save still commits the same config.
  assert.equal(flow.submitInput('my-relay').kind, 'next')
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') return
  assert.equal(result.commit.providerName, 'my-relay')
})

test('draft: preset transient phases resume at the endpoint step; Enter re-probes with restored key', () => {
  for (const phase of ['preset-probing', 'probe-report'] as const) {
    const flow = new ConnectFlow([], draft({
      phase,
      collected: { presetKey: 'deepseek', keyRef: 'deepseek' },
    }), 'sk-saved')
    flow.submitChoice('resume')
    const view = flow.view()
    assert.equal(view.kind, 'input', phase)
    assert.match(view.title, /服务地址/, phase)
    const probe = flow.submitInput('')
    assert.equal(probe.kind, 'probe', phase)
    if (probe.kind === 'probe') assert.equal(probe.apiKey, 'sk-saved', phase)
  }
})

test('draft: keyless (ollama) drafts resume at the endpoint step and re-probe keyless', () => {
  for (const phase of ['preset-endpoint', 'preset-probing', 'probe-report'] as const) {
    const flow = new ConnectFlow([], draft({
      phase,
      collected: { presetKey: 'ollama' },
    }))
    flow.submitChoice('resume')
    const view = flow.view()
    assert.equal(view.kind, 'input', phase)
    assert.match(view.title, /服务地址/, phase)
    const probe = flow.submitInput('')
    assert.equal(probe.kind, 'probe', phase)
    if (probe.kind === 'probe') {
      assert.equal(probe.apiKey, undefined, phase)
      assert.equal(probe.baseUrl, 'http://127.0.0.1:11434/v1', phase)
    }
  }
})

test('draft: preset confirm without a selection is the skip-probe path — resumes at confirm', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'confirm',
    collected: { presetKey: 'deepseek', keyRef: 'deepseek' },
  }), 'sk-saved')
  flow.submitChoice('resume')
  assert.match(flow.view().title, /确认保存/)
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.apiKey, 'sk-saved')
})

test('draft: preset-endpoint resume keeps the edited URL and restored key', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'preset-endpoint',
    collected: { presetKey: 'deepseek', keyRef: 'deepseek', baseUrl: 'https://relay.example.com/v1' },
    pendingInput: 'https://relay.example.com/v1',
  }), 'sk-saved')
  flow.submitChoice('resume')
  assert.match(flow.view().title, /服务地址/)
  assert.equal(flow.takeRestoredInput(), 'https://relay.example.com/v1')
  const probe = flow.submitInput('https://relay.example.com/v1')
  assert.equal(probe.kind, 'probe')
  if (probe.kind === 'probe') {
    assert.equal(probe.baseUrl, 'https://relay.example.com/v1')
    assert.equal(probe.apiKey, 'sk-saved')
  }
})

test('draft: resuming past the key step keeps the restored key through commit', () => {
  const collected = {
    presetKey: 'deepseek',
    keyRef: 'deepseek',
    probedSelection: [{ rawId: 'deepseek-v4-pro', checked: true }],
  }
  // preset-models → 恢复到模型步，confirm 进能力检测后保存。
  const models = new ConnectFlow([], draft({ phase: 'preset-models', collected }), 'sk-saved')
  models.submitChoice('resume')
  assert.match(models.view().title, /选择要添加的模型/)
  assert.equal(models.confirm().kind, 'next')
  assert.equal(models.submitChoice('continue').kind, 'next')
  const mCommit = models.submitChoice('save')
  assert.equal(mCommit.kind, 'commit')
  if (mCommit.kind === 'commit' && mCommit.commit.mode === 'preset') {
    assert.equal(mCommit.commit.setup.apiKey, 'sk-saved')
  }
  // capability → 精确恢复到能力检测步（步骤号与存档时一致）。
  const cap = new ConnectFlow([], draft({ phase: 'capability', collected }), 'sk-saved')
  cap.submitChoice('resume')
  assert.match(cap.view().title, /能力检测/)
  assert.equal(cap.submitChoice('continue').kind, 'next')
  const cCommit = cap.submitChoice('save')
  assert.equal(cCommit.kind, 'commit')
  if (cCommit.kind === 'commit' && cCommit.commit.mode === 'preset') {
    // 回归点：恢复链跳过密钥步时 commit 必须仍带密钥，否则 provider 落盘无凭证。
    assert.equal(cCommit.commit.setup.apiKey, 'sk-saved')
  }
})

test('draft: DIY confirm phase resumes at the confirm step; name round-trips via back', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'confirm',
    collected: {
      baseUrl: 'https://api.example.com/v1',
      keyRef: 'diy-pending',
      providerName: 'my-relay',
      probedSelection: [{ rawId: 'deepseek-v4-pro', checked: true }],
    },
  }), 'sk-x')
  flow.submitChoice('resume')
  assert.match(flow.view().title, /确认保存/)
  flow.submitChoice('back')
  assert.match(flow.view().title, /起个名字/)
  assert.equal(flow.takeRestoredInput(), 'my-relay')
})

// 规格守卫：目标方案要求「凭证 > 探测 > 保存确认」——任何带密钥的 preset
// 都不允许从密钥步直接 commit（历史 bug：曾静默直存，跳过探测与确认）。
test('spec guard: no keyed preset commits straight from the key step', () => {
  for (const key of providerPresetKeys) {
    const preset = PROVIDER_PRESETS[key]
    if (preset.provider.auth?.type === 'oauth' || preset.keyless) continue
    const flow = new ConnectFlow()
    assert.equal(flow.submitChoice(key).kind, 'next', key)
    const billingMode = preset.billingModes?.find(m => !m.baseUrl.includes('{')) ?? preset.billingModes?.[0]
    if (preset.billingModes && preset.billingModes.length > 0) {
      assert.equal(flow.submitChoice(billingMode!.id).kind, 'next', `${key} billing step`)
    }
    assert.equal(flow.submitInput('sk-guard').kind, 'next', `${key} skipped endpoint confirm`)
    const endpointInput = billingMode && billingMode.baseUrl.includes('{')
      ? billingMode.baseUrl.replace('{WorkspaceId}', 'ws-guard')
      : ''
    const result = flow.submitInput(endpointInput)
    assert.notEqual(result.kind, 'commit', `${key} committed without probe/confirm`)
    assert.equal(result.kind, 'probe', key)
    // 探测通过 → 报告 → 模型 → 能力检测 → 确认步，全程无自动落盘。
    assert.equal(flow.applyProbe(report()).kind, 'next', key)
    assert.match(flow.view().title, /连通性测试/, key)
    assert.equal(flow.submitChoice('continue').kind, 'next', key)
    if (flow.view().kind === 'multi-choice') {
      // 聚合平台默认全不选——先全选再确认，走通后续步骤。
      if (preset.aggregator) assert.equal(flow.toggleAllModels().kind, 'next', `${key} select-all`)
      assert.equal(flow.confirm().kind, 'next', key)
      assert.match(flow.view().title, /能力检测/, key)
      assert.equal(flow.submitChoice('continue').kind, 'next', key)
    }
    assert.match(flow.view().title, /确认保存/, key)
  }
})

test('draft: preset-models resume rebuilds the selection and commits it', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'preset-models',
    collected: {
      presetKey: 'deepseek',
      keyRef: 'deepseek',
      probedSelection: [
        { rawId: 'deepseek-v4-pro', checked: true },
        { rawId: 'deepseek-v4-flash', checked: false },
      ],
    },
  }), 'sk-saved')
  flow.submitChoice('resume')
  const view = flow.view()
  assert.equal(view.kind, 'multi-choice')
  assert.equal(view.stepLabel, '步骤 4 / 6')
  assert.equal(view.options?.[0]?.label, 'deepseek-v4-pro')
  assert.equal(view.options?.[0]?.checked, true)
  assert.equal(view.options?.[1]?.checked, false)
  // Save walks capability → confirm → commit.
  assert.equal(flow.confirm().kind, 'next')
  assert.match(flow.view().title, /能力检测/)
  assert.equal(flow.submitChoice('continue').kind, 'next')
  assert.match(flow.view().title, /确认保存/)
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'preset') return
  assert.deepEqual(result.commit.setup.models?.map(m => m.id), ['deepseek-v4-pro'])
})

test('confirm back: preset returns to capability, then to model selection', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('deepseek')
  flow.submitInput('sk-x')
  flow.submitInput('')
  flow.applyProbe(report({ models: ['deepseek-v4-pro'] }))
  flow.submitChoice('continue')
  flow.confirm()
  flow.submitChoice('continue')
  assert.match(flow.view().title, /确认保存/)
  assert.equal(flow.submitChoice('back').kind, 'next')
  assert.match(flow.view().title, /能力检测/)
  assert.equal(flow.submitChoice('back').kind, 'next')
  assert.equal(flow.view().kind, 'multi-choice')
  assert.equal(flow.view().stepLabel, '步骤 4 / 6')
  // Re-walk and save still commits the same config.
  assert.equal(flow.confirm().kind, 'next')
  flow.submitChoice('continue')
  assert.equal(flow.submitChoice('save').kind, 'commit')
})

// ── billing-mode step (dashscope: 按量计费 / token plan) ──

const PAYG_URL = 'https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'

test('dashscope: 7 steps — billing → key → endpoint({WorkspaceId}) → report → models → capability → save', () => {
  const flow = new ConnectFlow()
  assert.equal(flow.submitChoice('dashscope').kind, 'next')

  // [2/7] Billing mode selection.
  const billingView = flow.view()
  assert.equal(billingView.kind, 'choice')
  assert.match(billingView.title, /计费模式/)
  assert.equal(billingView.stepLabel, '步骤 2 / 7')
  assert.deepEqual(billingView.options?.map(o => o.id), ['payg', 'token-plan'])
  assert.equal(billingView.options?.[0]?.recommended, true)
  assert.equal(flow.submitChoice('ghost').kind, 'error') // unknown mode rejected
  assert.equal(flow.submitChoice('payg').kind, 'next')

  // [3/7] Key step.
  assert.equal(flow.view().stepLabel, '步骤 3 / 7')
  assert.equal(flow.submitInput('sk-bailian').kind, 'next')

  // [3/7] Endpoint prefilled from the payg template — placeholder must be replaced.
  const urlView = flow.view()
  assert.equal(urlView.stepLabel, '步骤 3 / 7')
  assert.equal(urlView.defaultValue, 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
  assert.match(urlView.subtitle ?? '', /WorkspaceId/)
  const blocked = flow.submitInput('') // Enter keeps the unfilled template
  assert.equal(blocked.kind, 'error')
  assert.match(blocked.kind === 'error' ? blocked.message : '', /WorkspaceId/)
  const probe = flow.submitInput(PAYG_URL)
  assert.equal(probe.kind, 'probe')
  if (probe.kind !== 'probe') return
  assert.equal(probe.baseUrl, PAYG_URL)
  assert.equal(probe.apiKey, 'sk-bailian')

  // [4/7] report → [5/7] models → [6/7] capability → [7/7] confirm.
  assert.equal(flow.applyProbe(report({ models: ['qwen3.8-max'] })).kind, 'next')
  assert.equal(flow.view().stepLabel, '步骤 4 / 7')
  assert.equal(flow.submitChoice('continue').kind, 'next')
  assert.equal(flow.view().stepLabel, '步骤 5 / 7')
  assert.equal(flow.confirm().kind, 'next')
  assert.equal(flow.view().stepLabel, '步骤 6 / 7')
  assert.equal(flow.submitChoice('continue').kind, 'next')
  const confirmView = flow.view()
  assert.match(confirmView.title, /确认保存/)
  assert.equal(confirmView.stepLabel, '步骤 7 / 7')

  // Commit carries the billing-mode baseUrl override.
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.baseUrl, PAYG_URL)
  assert.equal(result.commit.setup.preset, 'dashscope')
})

test('dashscope: token plan prefills its own endpoint and commits it', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('dashscope')
  flow.submitChoice('token-plan')
  flow.submitInput('sk-bailian')
  const urlView = flow.view()
  assert.equal(urlView.defaultValue, 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
  assert.doesNotMatch(urlView.subtitle ?? '', /WorkspaceId/)
  const probe = flow.submitInput('') // Enter accepts the token-plan URL
  assert.equal(probe.kind, 'probe')
  if (probe.kind !== 'probe') return
  assert.equal(probe.baseUrl, 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
  flow.applyProbe(report({ models: ['qwen3.8-max'] }))
  flow.submitChoice('continue')
  flow.confirm()
  flow.submitChoice('continue')
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.baseUrl, 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
})

test('draft: dashscope key-step draft without a billing mode resumes at the billing step', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'preset-apikey',
    collected: { presetKey: 'dashscope', keyRef: 'dashscope' },
  }), 'sk-saved')
  flow.submitChoice('resume')
  assert.match(flow.view().title, /计费模式/)
  assert.equal(flow.view().stepLabel, '步骤 2 / 7')
})

test('draft: dashscope billing + edited URL round-trips and keeps the override on commit', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('dashscope')
  flow.submitChoice('payg')
  flow.submitInput('sk-bailian')
  flow.submitInput(PAYG_URL)
  const saved = flow.toDraft()
  assert.equal(saved?.collected.billingMode, 'payg')
  assert.equal(saved?.collected.baseUrl, PAYG_URL)

  const restored = new ConnectFlow([], draft({
    phase: 'preset-endpoint',
    collected: { presetKey: 'dashscope', billingMode: 'payg', keyRef: 'dashscope', baseUrl: PAYG_URL },
  }), 'sk-saved')
  restored.submitChoice('resume')
  assert.match(restored.view().title, /服务地址/)
  const probe = restored.submitInput(PAYG_URL)
  assert.equal(probe.kind, 'probe')
  restored.applyProbe(report({ models: ['qwen3.8-max'] }))
  restored.submitChoice('continue')
  restored.confirm()
  restored.submitChoice('continue')
  const result = restored.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.baseUrl, PAYG_URL)
})

test('billing step is skipped for presets without billingModes (deepseek stays 6 steps)', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('deepseek')
  assert.match(flow.view().title, /API 密钥/)
  assert.equal(flow.view().stepLabel, '步骤 2 / 6')
})

test('quota-exhausted probe errors get account-level guidance, not key advice', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('dashscope')
  flow.submitChoice('token-plan')
  flow.submitInput('sk-x')
  flow.submitInput('')
  flow.applyProbe(report({
    models: [],
    modelsOk: false,
    completionOk: false,
    errors: ['Quota/billing problem (HTTP 403). — server said: {"code":"AllocationQuota.FreeTierOnly","message":"Free quota exhausted."}'],
  }))
  const texts = (flow.view().report ?? []).map(l => l.text)
  assert.ok(texts.some(t => /免费额度已用完/.test(t)), 'quota cause present')
  assert.ok(!texts.some(t => /重新输入 API Key/.test(t)), 'misleading key advice dropped')
})

// ── D1 聚合平台多选：默认全不选 / 搜索 / 全选 ─────────────────────

/** Drive an aggregator preset (siliconflow) to the models multi-choice step. */
function siliconflowToModels(flow: ConnectFlow, discovered: string[] = []): void {
  flow.submitChoice('siliconflow')
  flow.submitInput('sk-sf')
  flow.submitInput('')
  flow.applyProbe(report({ models: [...PROVIDER_PRESETS.siliconflow.provider.models.map(m => m.id), ...discovered] }))
  assert.equal(flow.submitChoice('continue').kind, 'next')
  assert.equal(flow.view().kind, 'multi-choice')
}

test('D1: aggregator preset defaults ALL models to unchecked (template + discovered)', () => {
  const flow = new ConnectFlow()
  siliconflowToModels(flow, ['vendor/mystery-model'])
  const view = flow.view()
  assert.deepEqual(view.options?.map(o => o.checked), view.options?.map(() => false))
  assert.match(view.subtitle ?? '', /聚合平台/)
  // 非聚合 preset 不受影响——模板默认勾选。
  const plain = new ConnectFlow()
  plain.submitChoice('deepseek')
  plain.submitInput('sk-x')
  plain.submitInput('')
  plain.applyProbe(report({ models: ['deepseek-v4-pro'] }))
  plain.submitChoice('continue')
  // 与上半的聚合「全不勾」对称：非聚合 preset 模板 ∪ 发现项全默认勾。
  // 个数随 preset 增删变化（模板数 + 1 个发现项），钉长度语义不钉死数组。
  const plainOpts = plain.view().options ?? []
  assert.equal(plainOpts.length, PROVIDER_PRESETS.deepseek.provider.models.length + 1)
  assert.deepEqual(plainOpts.map(o => o.checked), plainOpts.map(() => true))
})

test('D1: aggregator with nothing checked cannot confirm (guarded error)', () => {
  const flow = new ConnectFlow()
  siliconflowToModels(flow)
  const res = flow.confirm()
  assert.equal(res.kind, 'error')
  assert.match(res.kind === 'error' ? res.message : '', /至少勾选一个模型/)
})

test('D1: type-to-search filters options but ids keep mapping to real indexes', () => {
  const flow = new ConnectFlow()
  siliconflowToModels(flow, ['vendor/mystery-model'])
  const total = flow.view().options?.length ?? 0
  assert.ok(total >= 6)
  assert.equal(flow.view().filter, '')
  assert.equal(flow.view().optionTotal, total)

  for (const ch of 'mystery') flow.typeModelFilter(ch)
  const filtered = flow.view()
  assert.equal(filtered.filter, 'mystery')
  assert.deepEqual(filtered.options?.map(o => o.label), ['vendor/mystery-model'])
  assert.equal(filtered.optionTotal, total)
  // id 仍是原数组下标——toggle 按 id 打到正确条目。
  const id = filtered.options?.[0]?.id
  assert.notEqual(id, '0')
  assert.equal(flow.toggle(id!).kind, 'next')
  assert.equal(flow.view().options?.[0]?.checked, true)

  flow.backspaceModelFilter()
  assert.equal(flow.view().filter, 'myster')
  flow.clearModelFilter()
  assert.equal(flow.view().filter, '')
  assert.equal(flow.view().options?.length, total)
})

test('D1: Ctrl+A select-all toggles everything; with a filter it only touches matches', () => {
  const flow = new ConnectFlow()
  siliconflowToModels(flow, ['vendor/mystery-model'])
  const total = flow.view().options?.length ?? 0

  // 带过滤的全选：只勾匹配项。
  for (const ch of 'mystery') flow.typeModelFilter(ch)
  assert.equal(flow.toggleAllModels().kind, 'next')
  assert.equal(flow.view().options?.[0]?.checked, true)
  flow.clearModelFilter()
  const checkedCount = () => (flow.view().options ?? []).filter(o => o.checked).length
  assert.equal(checkedCount(), 1)

  // 空过滤全选：全部勾上；再来一次全部取消。
  assert.equal(flow.toggleAllModels().kind, 'next')
  assert.equal(checkedCount(), total)
  assert.equal(flow.toggleAllModels().kind, 'next')
  assert.equal(checkedCount(), 0)

  // 过滤无匹配 → 报错而不是乱勾。
  for (const ch of 'zzz-no-such') flow.typeModelFilter(ch)
  const res = flow.toggleAllModels()
  assert.equal(res.kind, 'error')
})

test('D1: DIY models step also supports search and select-all', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: ['alpha-one', 'beta-two'] }))
  flow.submitChoice('continue')
  assert.equal(flow.view().kind, 'multi-choice')
  // DIY 探测默认全勾——先手动全取消，再验证过滤全选只勾匹配项。
  flow.toggle('0')
  flow.toggle('1')
  flow.typeModelFilter('beta')
  assert.deepEqual(flow.view().options?.map(o => o.label), ['beta-two'])
  flow.toggleAllModels()
  flow.clearModelFilter()
  assert.deepEqual(flow.view().options?.map(o => [o.label, o.checked]), [['alpha-one', false], ['beta-two', true]])
})

test('D1: filter is transient — confirm resets it and keeps only picked models', () => {
  const flow = new ConnectFlow()
  siliconflowToModels(flow)
  flow.toggleAllModels()
  flow.typeModelFilter('GLM')
  assert.ok((flow.view().options?.length ?? 0) > 0)
  assert.equal(flow.confirm().kind, 'next')
  assert.match(flow.view().title, /能力检测/)
  // 回到模型步（capability → back）时过滤器已清。
  flow.submitChoice('back')
  assert.equal(flow.view().filter, '')
})

// ── D2 未知模型高级选项（补参）─────────────────────────────────────

test('D2: DIY unknown model single-step form — arranged fields, values land in commit', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: ['acme/x-9000'] }))
  flow.submitChoice('continue')
  assert.equal(flow.confirm().kind, 'next')

  const formView = flow.view()
  assert.equal(formView.kind, 'form')
  assert.match(formView.title, /模型补参/)
  assert.match(formView.subtitle ?? '', /acme\/x-9000/)
  const fields = formView.fields ?? []
  assert.deepEqual(fields.map(f => f.id), ['contextWindow', 'maxTokens', 'template'])
  assert.equal(fields[0]!.value, '131072', '窗口默认值预填')
  // 单个未知模型没有 applyRest 字段。
  assert.ok(!fields.some(f => f.id === 'applyRest'))

  // 非数字与超窗都有守卫。
  flow.editAdvancedField('contextWindow', 'abc')
  assert.equal(flow.submitAdvancedForm().kind, 'error')
  flow.editAdvancedField('contextWindow', '200000')
  flow.editAdvancedField('maxTokens', '999999')
  assert.equal(flow.submitAdvancedForm().kind, 'error')
  flow.editAdvancedField('maxTokens', '') // 空 = 默认 32768
  flow.toggleAdvancedField('template')    // → reasoning
  assert.equal(flow.submitAdvancedForm().kind, 'next')
  assert.match(flow.view().title, /深度思考/) // diy-thinking

  flow.submitChoice('none')
  flow.submitInput('acme-relay')
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') return
  const model = result.commit.models[0]!
  assert.equal(model.id, 'acme/x-9000')
  assert.equal(model.contextWindow, 200_000)
  assert.equal(model.maxTokens, 32_768)
  assert.deepEqual(model.capabilities, { reasoningSplit: true })
})

test('KB: 半已知模型进补参表单——已知 ctx 预填、模板预置推理（kimi-k2.6）', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: ['kimi-k2.6'] }))
  flow.submitChoice('continue')
  assert.equal(flow.confirm().kind, 'next')

  const form = flow.view()
  assert.equal(form.kind, 'form')
  assert.match(form.subtitle ?? '', /官方规格不完整/)
  const fields = form.fields ?? []
  assert.equal(fields[0]!.value, '262144', 'KB 已知窗口预填')
  assert.equal(fields[1]!.value, '32768', '官网未公布最大输出 → 默认值待确认')
  assert.match(fields[2]!.value, /推理/, 'KB reasoningSplit → 模板预置推理')

  assert.equal(flow.submitAdvancedForm().kind, 'next')
  flow.submitChoice('none')
  flow.submitInput('kimi-relay')
  const result = flow.submitChoice('save')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') throw new Error('expected custom commit')
  const model = result.commit.models[0]!
  assert.equal(model.id, 'kimi-k2.6')
  assert.equal(model.contextWindow, 262_144)
  assert.equal(model.maxTokens, 32_768)
  assert.deepEqual(model.capabilities, { reasoningSplit: true })
})

test('KB: 完全已知模型（glm-4.6）免补参，元数据直达 commit', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: ['glm-4.6', 'mystery-z'] }))
  flow.submitChoice('continue')
  assert.equal(flow.confirm().kind, 'next')
  // glm-4.6 命中知识库（ctx/max 齐全）不进队列；mystery-z 未知进表单。
  assert.match(flow.view().subtitle ?? '', /mystery-z/)
  answerUnknownModels(flow)
  flow.submitChoice('none')
  flow.submitInput('glm-relay')
  const result = flow.submitChoice('save')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') throw new Error('expected custom commit')
  const glm = result.commit.models.find(m => m.id === 'glm-4.6')!
  assert.equal(glm.contextWindow, 204_800, 'KB 窗口直接落盘')
  assert.equal(glm.maxTokens, 131_072, 'KB 最大输出直接落盘')
  assert.deepEqual(glm.capabilities, { reasoningSplit: true }, 'KB reasoning 直接落盘')
})

test('D2: applyRest stamps the same override onto all remaining unknowns', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: ['uno-unknown', 'dos-unknown', 'tres-unknown'] }))
  flow.submitChoice('continue')
  flow.confirm()
  const form = flow.view()
  const applyRest = (form.fields ?? []).find(f => f.id === 'applyRest')
  assert.ok(applyRest, '其余 2 个未知 → 出现 applyRest 字段')
  assert.match(applyRest!.label, /其余 2 个/)
  flow.toggleAdvancedField('applyRest')
  assert.equal(flow.submitAdvancedForm().kind, 'next')
  // 队列一次清空——直接到思考步，不再逐个补参。
  assert.match(flow.view().title, /深度思考/)
  flow.submitChoice('none')
  flow.submitInput('bulk')
  const result = flow.submitChoice('save')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') throw new Error('expected custom commit')
  for (const m of result.commit.models) {
    assert.equal(m.contextWindow, 131_072)
    assert.equal(m.maxTokens, 32_768)
    assert.equal(m.capabilities, undefined, 'generic 模板不带 reasoningSplit')
  }
})

test('D2: preset path also stops at advanced steps for discovered unknowns', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('deepseek')
  flow.submitInput('sk-x')
  flow.submitInput('')
  flow.applyProbe(report({ models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'brand-new-mystery'] }))
  flow.submitChoice('continue')
  // 只勾新发现的未知模型（探测发现的未知项默认不勾——显式勾上）。
  // 按 label/id 操作而非数字索引——预设模型列表随版本增删（2026-09-10 增 deepseek-flash）。
  const view = flow.view()
  const mysteryOpt = (view.options ?? []).find(o => o.label === 'brand-new-mystery')
  assert.ok(mysteryOpt)
  assert.equal(mysteryOpt!.checked, false)
  for (const o of view.options ?? []) {
    if (o.label !== 'brand-new-mystery' && o.checked) flow.toggle(o.id)
  }
  flow.toggle(mysteryOpt!.id)
  assert.equal(flow.confirm().kind, 'next')
  assert.match(flow.view().title, /模型补参/)
  answerUnknownModels(flow)
  // preset 路径补参完回能力检测步。
  assert.match(flow.view().title, /能力检测/)
})

test('D2: backFromAdvanced returns to model selection, edits discarded', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: ['acme/x-9000'] }))
  flow.submitChoice('continue')
  flow.confirm()
  flow.editAdvancedField('contextWindow', '99999')
  flow.editAdvancedField('maxTokens', '8192')
  assert.equal(flow.backFromAdvanced().kind, 'next')
  assert.equal(flow.view().kind, 'multi-choice')
  // 重新确认走默认补参——99999 没被记住。
  assert.equal(flow.confirm().kind, 'next')
  assert.match(flow.view().subtitle ?? '', /acme\/x-9000/)
  assert.equal((flow.view().fields ?? [])[0]!.value, '131072')
})

test('D2: draft saved on an advanced step downgrades to the models step', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: ['acme/x-9000'] }))
  flow.submitChoice('continue')
  flow.confirm()
  flow.editAdvancedField('contextWindow', '50000')
  const draft = flow.toDraft('12')
  assert.ok(draft)
  assert.equal(draft!.phase, 'diy-models')
  // 半途数字不落盘，勾选集保留。
  assert.ok(!JSON.stringify(draft).includes('50000'))
  assert.deepEqual(draft!.collected.probedSelection, [{ rawId: 'acme/x-9000', checked: true }])
})

// ── 高级设置（OPT-003）：confirm 步可选入口 + 循环子菜单 ──

/** Drive the deepseek preset path to the confirm step. */
function toConfirmPreset(): ConnectFlow {
  const flow = new ConnectFlow()
  assert.equal(flow.submitChoice('deepseek').kind, 'next')
  assert.equal(flow.submitInput('sk-test-123').kind, 'next')
  const probe = flow.submitInput('')
  assert.equal(probe.kind, 'probe')
  if (probe.kind !== 'probe') throw new Error('unreachable')
  assert.equal(flow.applyProbe(report({ models: ['deepseek-v4-pro'] })).kind, 'next')
  assert.equal(flow.submitChoice('continue').kind, 'next') // [4/6] models
  assert.equal(flow.confirm().kind, 'next')                // [5/6] capability
  assert.equal(flow.submitChoice('continue').kind, 'next') // [6/6] confirm
  return flow
}

test('advanced: confirm step exposes the optional entry; submenu lists 4 knobs unset', () => {
  const flow = toConfirmPreset()
  const confirmView = flow.view()
  assert.ok((confirmView.options ?? []).some(o => o.id === 'advanced' && !o.recommended))

  assert.equal(flow.submitChoice('advanced').kind, 'next')
  const menu = flow.view()
  assert.equal(menu.kind, 'choice')
  assert.match(menu.title, /高级设置/)
  // 步数标签不变——高级设置不是新步骤。
  assert.equal(menu.stepLabel, '步骤 6 / 6')
  const opts = menu.options ?? []
  assert.deepEqual(opts.map(o => o.id), ['requestTimeoutMs', 'maxRetries', 'temperature', 'proxy', 'done'])
  assert.match(opts[0]!.description ?? '', /未设置/)
  assert.match(opts[3]!.description ?? '', /未设置/)
  assert.equal(opts[4]!.recommended, true)
})

test('advanced: values round-trip into the menu and are forwarded to the commit', () => {
  const flow = toConfirmPreset()
  flow.submitChoice('advanced')

  assert.equal(flow.submitChoice('requestTimeoutMs').kind, 'next')
  assert.equal(flow.view().kind, 'input')
  assert.equal(flow.takeRestoredInput(), '') // 未设置 → 空预填
  assert.equal(flow.submitInput('300000').kind, 'next')

  assert.equal(flow.submitChoice('temperature').kind, 'next')
  assert.equal(flow.submitInput('0').kind, 'next')

  assert.equal(flow.submitChoice('proxy').kind, 'next')
  assert.equal(flow.submitInput('http://127.0.0.1:7890').kind, 'next')

  const menu = flow.view()
  assert.match(menu.options?.[0]?.description ?? '', /300000 ms/)
  assert.match(menu.options?.[2]?.description ?? '', /^0$/)
  assert.match(menu.options?.[3]?.description ?? '', /127\.0\.0\.1:7890/)

  assert.equal(flow.submitChoice('done').kind, 'next')
  assert.equal(flow.view().title.match(/确认保存/) !== null, true)
  assert.match(flow.view().subtitle ?? '', /已调 3 项高级设置/)

  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'preset') return
  assert.deepEqual(result.commit.setup.advanced, {
    requestTimeoutMs: 300000,
    temperature: 0,
    proxy: 'http://127.0.0.1:7890',
  })
})

test('advanced: empty input clears a knob and the commit drops the advanced block', () => {
  const flow = toConfirmPreset()
  flow.submitChoice('advanced')
  flow.submitChoice('maxRetries')
  assert.equal(flow.submitInput('0').kind, 'next')
  assert.match(flow.view().options?.[1]?.description ?? '', /^0 次$/)
  // 再进子步：预填当前值；空回车清除。
  flow.submitChoice('maxRetries')
  assert.equal(flow.takeRestoredInput(), '0')
  assert.equal(flow.submitInput('').kind, 'next')
  assert.match(flow.view().options?.[1]?.description ?? '', /未设置/)
  flow.submitChoice('done')
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.advanced, undefined)
})

test('advanced: invalid inputs are rejected with guidance, staying on the input step', () => {
  const flow = toConfirmPreset()
  flow.submitChoice('advanced')

  flow.submitChoice('requestTimeoutMs')
  const badTimeout = flow.submitInput('abc')
  assert.equal(badTimeout.kind, 'error')
  if (badTimeout.kind === 'error') assert.match(badTimeout.message, /正整数毫秒数/)
  assert.equal(flow.view().kind, 'input')
  assert.equal(flow.submitInput('-5').kind, 'error')

  flow.submitInput('60000') // 合法值收尾，回菜单
  flow.submitChoice('maxRetries')
  const badRetries = flow.submitInput('21') // 上限放宽到 0–20（issue #75）；21 仍非法
  assert.equal(badRetries.kind, 'error')
  if (badRetries.kind === 'error') assert.match(badRetries.message, /0–20/)
  flow.submitInput('')

  flow.submitChoice('temperature')
  const badTemp = flow.submitInput('3')
  assert.equal(badTemp.kind, 'error')
  if (badTemp.kind === 'error') assert.match(badTemp.message, /0–2/)
  flow.submitInput('')

  flow.submitChoice('proxy')
  const badProxy = flow.submitInput('not a url')
  assert.equal(badProxy.kind, 'error')
  if (badProxy.kind === 'error') assert.match(badProxy.message, /代理地址/)
  flow.submitInput('')
})

test('advanced: draft saved on an advanced phase downgrades to the confirm step', () => {
  const flow = toConfirmPreset()
  flow.submitChoice('advanced')
  flow.submitChoice('requestTimeoutMs')
  const draft = flow.toDraft('12')
  assert.ok(draft)
  assert.equal(draft!.phase, 'confirm')
  // 半途输入不落盘。
  assert.ok(!JSON.stringify(draft).includes('advanced-request-timeout'))
})

test('E3: probe modelInfos materialize specs for discovered models — no D2 manual fill', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({
    models: ['acme/x-9000'],
    modelInfos: {
      'acme/x-9000': { contextWindow: 1_000_000, maxOutputTokens: 131_072, maxReasoningTokens: 262_144 },
    },
  }))
  flow.submitChoice('continue')
  // 确认勾选后直接进思考步——端点元数据已给出规格，不进未知模型补参队列。
  assert.equal(flow.confirm().kind, 'next')
  assert.equal(flow.view().kind, 'choice')
  assert.match(flow.view().title, /思考|推理/)
  flow.submitChoice('none')
  flow.submitInput('acme')
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') return
  const model = result.commit.models.find(m => m.id === 'acme/x-9000')
  assert.equal(model?.contextWindow, 1_000_000)
  assert.equal(model?.maxTokens, 131_072)
  assert.deepEqual(model?.capabilities, { reasoningSplit: true })
})
