#!/usr/bin/env tsx
/** Protocol v4: production-capacity qualification precedes a separately recorded A/B. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { FILES, referenceFix } from './recovery-long-fixture.js'
import { LongWorld, sha } from './recovery-long-world.js'
import { HookWorld } from './scoped-hook-world.js'
import { CASES, BASE_REF, REFERENCE_REF, GOAL as HOOK_GOAL } from './scoped-hook-task.js'
import { REFERENCE_PATCH_VERSION } from './scoped-hook-reference.js'
import { GOAL, RecoveryFeedback } from './recovery-long-policy.js'
import { productionProfile, productionClient, streamAttempt, assistantMessage, experimentRequest, qualifyTransport } from './experiment-stream.js'
import { CompletionLedger } from './experiment-protocol.js'
import { PROVIDER_PRESETS } from '../../src/config/provider-presets.js'
import { providerSchema } from '../../src/config/schema.js'
import { resolveModelBinding } from '../../src/model/model-binding.js'
import { userConfigPath } from '../../src/config/paths.js'

const args = process.argv.slice(2)
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback
const output = resolve(option('--output', '.rivet/research/2026-10-20-group3-v4'))
const live = args.includes('--live'), historical = option('--task', 'scoped-hook') === 'scoped-hook'
if (!['scoped-hook', 'synthetic'].includes(option('--task', 'scoped-hook'))) throw new Error('Unknown task')
const repetitions = Number(option('--repetitions', '3'))
if (![1, 2, 3].includes(repetitions)) throw new Error('Repetitions must be 1, 2 or 3')
if (existsSync(output)) throw new Error('Evidence directory must be new')
// Read the normal provider snapshot without invoking config migrations or saving it.
let rawProvider: unknown = PROVIDER_PRESETS.deepseek.provider
if (existsSync(userConfigPath())) {
  const config = JSON.parse(readFileSync(userConfigPath(), 'utf8'))
  rawProvider = config.provider?.providers?.deepseek ?? rawProvider
}
const provider = providerSchema.parse(rawProvider), model = option('--model', 'deepseek-flash')
const endpoint = new URL(provider.baseUrl)
if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'api.deepseek.com' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('This live protocol requires the official HTTPS endpoint')
const profile = productionProfile(provider, model)
const protocol = { version: 4, revision: 'immutable-dispatch-v2-classified', kind: 'production-capacity-controlled-experiment', task: historical ? 'scoped-hook' : 'synthetic', profile,
  requestLimit: profile.maxTokens, trialCompletionLimit: profile.maxTokens * 2, maxRequests: 60, trialMinutes: 25, concurrency: 2, repetitions,
  retries: 0, continuationAfterTruncation: false, capacityRuns: 2, flow: 'controlled off; not full AgentLoop',
  referencePatch: historical ? REFERENCE_PATCH_VERSION : undefined, caseCount: historical ? CASES.length : 12,
  cases: historical ? CASES : undefined, goal: historical ? HOOK_GOAL : GOAL,
  transport: { protocol: provider.protocol, requestTimeoutMs: provider.requestTimeoutMs, retries: 0 },
  capacityRule: 'two natural finals, measured completion usage and no adapter fault; correctness not required' }
const makeWorld = (fixed = false): LongWorld => historical ? new HookWorld(fixed) : new LongWorld(fixed ? referenceFix(FILES) : FILES)
const controlled = ['src/prompt/engine.ts', 'src/prompt/static.ts', 'src/prompt/volatile.ts', 'src/prompt/domain-task-boundary.ts', 'src/agent/star-domain-data.ts', 'src/agent/advisory-bus.ts',
  'src/tools/read-file.ts', 'src/tools/edit.ts', 'src/tools/write-file.ts', 'src/api/factory.ts', 'src/api/openai-client.ts', 'src/api/usage-settlement.ts', 'src/api/execution-continuity.ts',
  'src/context/request-budget.ts', 'src/config/provider-presets.ts', 'src/api/provider.ts', 'src/api/stream-client.ts',
  ...readdirSync('scripts/experiments').filter(p => /^(recovery-long|scoped-hook|experiment-).*\.ts$/.test(p)).map(p => 'scripts/experiments/' + p)]
const hashes = () => Object.fromEntries(controlled.map(p => [p, sha(readFileSync(p))]))
const frozen = hashes(), assertSources = () => { if (sha(hashes()) !== sha(frozen)) throw new Error('Controlled source changed') }
mkdirSync(output, { recursive: true })
for (const p of controlled) { const target = join(output, 'frozen-source', p); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(p)) }
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), protocol, frozen,
  ...(historical ? { base: BASE_REF, reference: REFERENCE_REF, adaptation: 'declared HTTP/facade/clean-env host and versioned experiment-only reference correction' } : {}) }, null, 2), { flag: 'wx', mode: 0o600 })
// Resolve credentials only in the parent, before switching to an isolated runtime home.
const binding = live ? resolveModelBinding({ deepseek: provider }, { provider: 'deepseek', model }) : undefined
if (live && !binding?.apiKey) throw new Error('Official API credential unavailable')
const isolation = mkdtempSync(join(tmpdir(), 'rivet-experiment-v4-'))
process.env.RIVET_HOME = isolation; process.env.RIVET_SESSION_DIR = join(isolation, 'sessions'); process.env.RIVET_TRUST_PROJECT = '0'; process.env.RIVET_RTK = '0'
delete process.env.RIVET_DEBUG_RAW_SSE
writeFileSync(join(isolation, 'config.json'), '{}')
process.once('exit', () => rmSync(isolation, { recursive: true, force: true }))
const transportQualification = await qualifyTransport(provider, model)
writeFileSync(join(output, 'transport-qualification.json'), JSON.stringify(transportQualification, null, 2), { flag: 'wx', mode: 0o600 })
if (!transportQualification.passed) throw new Error('Offline production-client round trip failed; no billable request made')
const qualification: any[] = []
try {
  for (const fixed of [false, true]) {
    const world = makeWorld(fixed)
    try {
      await world.initialize()
      const preflight = await world.preflight()
      const qualificationRow: any = { fixed, preflight }; qualification.push(qualificationRow)
      if (!preflight.passed) throw new Error('Declared capabilities failed offline preflight')
      const checks = await world.checks(), grade = await world.grade()
      Object.assign(qualificationRow, { checks, grade })
      if (checks.passed !== fixed || !checks.complete || grade.passed !== fixed || grade.parsed.results.length !== protocol.caseCount) throw new Error('Reference/base qualification failed')
      if (historical && !fixed) {
        const cases = new Map(grade.parsed.results.map((r: any) => [r.id, r.passed]))
        if (cases.get('responsiveness') !== false || cases.get('hook-executed') !== true || cases.get('owned-isolation') !== true) throw new Error('Environment error is not a reproduced target defect')
      }
    } finally { world.close() }
  }
} finally { writeFileSync(join(output, 'qualification.json'), JSON.stringify(qualification, null, 2), { flag: 'wx', mode: 0o600 }) }
if (!live) { console.log(JSON.stringify({ status: 'offline-qualified', output })); process.exit(0) }
// The production resolver keeps credentials in memory; no credential material is archived.
const credential = binding!.apiKey
const clean = (s: string) => s.replaceAll(credential, '[redacted]').replace(/\bsk-[\w-]{8,}/g, '[redacted]')
const append = (path: string, row: unknown) => appendFileSync(path, clean(JSON.stringify({ at: new Date().toISOString(), ...row as object })) + '\n', { mode: 0o600 })
const abort = new AbortController(); process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort())
const phaseTimer = setTimeout(() => abort.abort(), (55 + Math.ceil(2 * repetitions / 2) * 27) * 60_000)
const results: any[] = []
try {
  const [{ PromptEngine }, { STAR_DOMAINS }, { AdvisoryBus }] = await Promise.all([import('../../src/prompt/engine.js'), import('../../src/agent/star-domain-data.js'), import('../../src/agent/advisory-bus.js')])
  async function trial(id: string, arm: 'A' | 'B' | 'N', phase: 'capacity' | 'ab') {
    assertSources()
    const world = makeWorld(), feedback = new RecoveryFeedback(), bus = new AdvisoryBus(), versions = new Map<string, string>()
    const ledger = new CompletionLedger(profile.maxTokens), deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), protocol.trialMinutes * 60_000), signal = AbortSignal.any([abort.signal, deadline.signal])
    const directory = join(output, phase); mkdirSync(directory, { recursive: true }); const trace = join(directory, id + '.jsonl')
    let status = 'request-limit', requests = 0, final = '', delivered = 0
    const started = Date.now()
    try {
      await world.initialize()
      const preflight = await world.preflight()
      append(trace, { kind: 'preflight', preflight })
      if (!preflight.passed) throw new Error('Per-trial environment capability preflight failed')
      const { client, policy } = productionClient(provider, credential, model, 'experiment-' + randomUUID())
      if (client.getExecutionPolicy?.().singleAttempt !== true) throw new Error('Production client did not consume singleAttempt')
      const d = STAR_DOMAINS.qisha
      const engine = new PromptEngine({ model, maxTokens: profile.maxTokens, staticCtx: { tools: world.definitions(), modelFamily: 'deepseek' }, volatileCtx: { cwd: world.root, activeDomain: { name: d.name, motto: d.motto, volatileBlock: d.volatileBlock } } })
      const built = engine.buildOaiRequest([{ role: 'user', origin: 'human', content: historical ? HOOK_GOAL : GOAL }], undefined, profile.contextWindow)
      const wire: any[] = structuredClone(built.messages)
      append(trace, { kind: 'initial', id, arm, phase, profile, tools: built.tools, initialHashes: world.initialHashes, messages: wire,
        normalizedPromptHash: sha(JSON.stringify(wire).replaceAll(world.root, '<workspace>')) })
      let progressAt = 0
      for (let step = 0; step < protocol.maxRequests; step++) {
        signal.throwIfAborted(); assertSources()
        if (ledger.uncertain) { status = 'usage-uncertain'; break }
        if (ledger.trialLimit - ledger.spent < ledger.requestLimit) { status = 'insufficient-completion-budget'; break }
        for (const reminder of bus.drainSystemReminders()) {
          if (versions.get(reminder.key) !== world.sourceHash()) { append(trace, { kind: 'feedback-stale', step, key: reminder.key }); continue }
          wire.push({ role: 'user', content: `<system-reminder>${reminder.content}</system-reminder>` }); bus.confirmSrDelivered(reminder.key); delivered++
        }
        const dispatchId = id + ':' + step
        append(trace, { kind: 'dispatch', step, dispatchId, requestHash: sha(wire), feedback: bus.drainDelivered(), ledger: ledger.snapshot() })
        requests++
        const response = await streamAttempt(client, experimentRequest(built, wire, model, profile.maxTokens), ledger, signal, policy, event => {
          if (Date.now() - progressAt > 10_000) { progressAt = Date.now(); append(trace, { kind: 'progress', step, dispatchId, event }) }
        })
        const assistant = assistantMessage(response.blocks), { reasoning_content: reasoning, ...visible } = assistant
        append(trace, { kind: 'response', step, dispatchId, status: response.status, reason: response.reason, usage: response.usage, reasoningChars: reasoning.length,
          elapsedMs: response.elapsedMs, assistant: visible, ledger: ledger.snapshot(), errorName: response.errorName, errorMessage: response.errorMessage?.slice(0, 2000) })
        if (response.status !== 'tools' && response.status !== 'final') { status = response.status; break }
        wire.push(assistant)
        if (response.status === 'final') { final = assistant.content; status = 'final'; break }
        for (const call of assistant.tool_calls ?? []) {
          signal.throwIfAborted()
          const input = JSON.parse(call.function.arguments), result = await world.execute(call.function.name, input, signal)
          wire.push({ role: 'tool', tool_call_id: call.id, content: result.content }); append(trace, { kind: 'tool', step, callId: call.id, ...world.events.at(-1) })
          if (result.observation?.origin === 'harness' || result.observation?.code === 'execution_unresolved') { status = 'experiment-inconclusive'; break }
          if (call.function.name === 'run_checks' && !input.test_file && result.check) {
            const entry = feedback.observe(result.check, arm === 'B', id, call.id)
            if (entry) { versions.set(entry.key, result.check.after); bus.submit(entry); append(trace, { kind: 'feedback-submitted', step, entry }); bus.render('七杀', step) }
          }
        }
        if (status === 'experiment-inconclusive') break
      }
    } catch (error) {
      status = signal.aborted ? 'deadline-or-cancelled' : error instanceof Error && error.name === 'ContextBudgetExceededError' ? 'context-insufficient' : 'experiment-inconclusive'
      append(trace, { kind: status, message: error instanceof Error ? error.message : 'unknown' })
    } finally { clearTimeout(timer) }
    let grade: any
    try { grade = await world.grade() } catch (error) { grade = { passed: false, verdict: 'inconclusive', error: error instanceof Error ? error.message : 'unknown' } }
    for (const path of world.files()) { const destination = join(directory, id + '-artifact', path); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, clean(world.artifact(path)), { mode: 0o600 }) }
    const result = { id, arm, phase, status, requests, budget: ledger.snapshot(), elapsedMs: Date.now() - started, delivered, tools: world.events.length,
      adapterFaults: world.events.filter(e => e.result.observation?.origin === 'harness' || e.result.observation?.code === 'execution_unresolved').length, grade, final }
    results.push(result); append(join(directory, 'results.jsonl'), result); console.log(JSON.stringify({ id, phase, status, budget: result.budget, passed: grade.passed, cases: grade.parsed?.results.filter((r: any) => r.passed).length }))
    world.close(); return result
  }
  const capacity = await Promise.all([trial('capacity-1', 'N', 'capacity'), trial('capacity-2', 'N', 'capacity')])
  const capacityQualified = capacity.every(r => r.status === 'final' && !r.budget.uncertain && r.adapterFaults === 0)
  writeFileSync(join(output, 'capacity-decision.json'), JSON.stringify({ qualified: capacityQualified, rule: 'natural final, measured usage and no adapter faults; candidate correctness is not required', ids: capacity.map(r => r.id) }, null, 2))
  if (capacityQualified && !abort.signal.aborted && !args.includes('--capacity-only')) {
    const order = Array.from({ length: repetitions }, (_, i) => (i % 2 ? ['B', 'A'] : ['A', 'B']).map(a => ({ arm: a as 'A' | 'B', repetition: i + 1 }))).flat()
    writeFileSync(join(output, 'ab-order.json'), JSON.stringify(order, null, 2))
    let cursor = 0
    const workers = await Promise.allSettled(Array.from({ length: 2 }, async () => { while (!abort.signal.aborted && cursor < order.length) { const i = cursor++, item = order[i]!; await trial(`${i + 1}-${item.arm}-${item.repetition}`, item.arm, 'ab') } }))
    for (const worker of workers) if (worker.status === 'rejected') throw worker.reason
  }
} finally {
  clearTimeout(phaseTimer)
  writeFileSync(join(output, 'summary.json'), clean(JSON.stringify({ completedAt: new Date().toISOString(), protocol, finalSourcesMatch: sha(hashes()) === sha(frozen), results }, null, 2)), { flag: 'wx', mode: 0o600 })
  rmSync(isolation, { recursive: true, force: true })
}
