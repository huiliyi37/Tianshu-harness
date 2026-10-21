#!/usr/bin/env tsx
/** Exploratory factorial experiment: production renderer/bus/tools, restricted local patches. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { balancedOrder, recoveryEntry, SCOPE_CANDIDATE } from './domain-recovery-policy.js'

const args = process.argv.slice(2)
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback
const output = resolve(option('--output', '.rivet/research/2026-10-19-qisha-group23'))
const live = args.includes('--live')
const repetitions = Number(option('--repetitions', '1')), seed = 101719
if (![1, 2].includes(repetitions)) throw new Error('repetitions must be 1 or 2')
const hash = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex')
const parameters = { model: 'deepseek-flash', thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 4096, temperature: 1, top_p: 1, stream: false }
const sources = ['src/prompt/static.ts', 'src/prompt/volatile.ts', 'src/prompt/engine.ts', 'src/agent/star-domain-data.ts', 'src/agent/advisory-bus.ts', 'src/tools/bash.ts', 'src/tools/edit.ts', 'src/tools/job-tool.ts', 'scripts/experiments/domain-recovery-policy.ts', 'scripts/experiments/domain-recovery-world.ts', 'scripts/experiments/domain-recovery.ts']
const sourceHashes = () => Object.fromEntries(sources.map(p => [p, hash(readFileSync(resolve(p), 'utf8'))]))
const protocol = { version: 1, parameters, repetitions, seed, maxSteps: 8, maxOutputTokensPerTrial: 12000, concurrency: 2, phaseMinutes: 25,
  arms: 'S=task-scoped qisha persona, E=one evidence-bound acknowledgement preceding identical factual/action guidance',
  tools: 'real BASH_TOOL/READ_FILE_TOOL/EDIT_FILE_TOOL/JOB_TOOL, finite per-case command and patch allowlists; not unrestricted coding',
  delivery: 'real AdvisoryBus system-reminder channel, confirmed append to experimental hook history, then production PromptEngine; no complete AgentLoop/quota/competition/desktop',
  scoring: 'unchanged protected files + current observed check + independent real check, final prose separately reviewed; review-only requires no edits and actual entry probe; missing credential is not remote success',
  exclusions: 'no production domain/hook changes, no Windows support claim, no causal weights inference, no tool-count adherence score' }

if (existsSync(join(output, 'manifest.json'))) throw new Error('Evidence already exists; use a new output directory')
mkdirSync(output, { recursive: true })
const frozenSources = sourceHashes(), order = balancedOrder(repetitions, seed)
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), live, protocol, frozenSources, order, scopeCandidate: SCOPE_CANDIDATE }, null, 2), { flag: 'wx', mode: 0o600 })
if (!live) { console.log(JSON.stringify({ mode: 'design-only', trials: order.length, output })); process.exit(0) }

// Use the normal resolver in memory; never serialize provider config or authentication.
const { resolveApiKey } = await import('../../src/api/factory.js')
const { userConfigPath } = await import('../../src/config/paths.js')
let provider: any = { name: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' }
if (!process.env.DEEPSEEK_API_KEY && existsSync(userConfigPath())) {
  const cfg = JSON.parse(readFileSync(userConfigPath(), 'utf8'))
  provider = cfg.provider?.providers?.deepseek ?? provider
}
const endpoint = new URL(provider.baseUrl ?? 'https://api.deepseek.com')
if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'api.deepseek.com' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Official DeepSeek HTTPS endpoint required')
let credential: string
try { credential = resolveApiKey({ ...provider, name: 'deepseek' }) } catch { throw new Error('Official DeepSeek credential unavailable through configured resolver') }
const api = endpoint.origin + endpoint.pathname.replace(/\/$/, '').replace(/\/v1$/, '') + '/v1'
const abort = new AbortController(), deadline = setTimeout(() => abort.abort(), protocol.phaseMinutes * 60000)
process.once('SIGINT', () => abort.abort())
process.once('SIGTERM', () => abort.abort())
const append = (path: string, value: unknown) => appendFileSync(path, JSON.stringify(value).replaceAll(credential, '[redacted]').replace(/\bsk-[\w-]{8,}/g, '[redacted]') + '\n', { mode: 0o600 })
const isolation = mkdtempSync(join(tmpdir(), 'rivet-recovery-experiment-'))
process.env.RIVET_HOME = isolation
process.env.RIVET_SESSION_DIR = join(isolation, 'sessions')
process.env.RIVET_RTK = '0'
process.env.RIVET_TRUST_PROJECT = '0'
writeFileSync(join(isolation, 'config.json'), '{}')
const results: any[] = []
try {
  const catalog = await fetch(api + '/models', { headers: { Authorization: `Bearer ${credential}` }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]) })
  if (!catalog.ok || !(await catalog.json() as any).data?.some((m: any) => m.id === parameters.model)) throw new Error('Official model catalog preflight failed')
  const python = ['/usr/bin/python3', '/usr/local/bin/python3'].find(p => existsSync(p) && spawnSync(p, ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0)
  if (!python || process.platform === 'win32') throw new Error('This fixture needs a verified POSIX Python interpreter; no automatic installation')
  const [{ PromptEngine }, { STAR_DOMAINS }, { AdvisoryBus }, { RecoveryWorld }] = await Promise.all([
    import('../../src/prompt/engine.js'), import('../../src/agent/star-domain-data.js'), import('../../src/agent/advisory-bus.js'), import('./domain-recovery-world.js'),
  ])
  let cursor = 0
  async function trial(index: number): Promise<void> {
    abort.signal.throwIfAborted()
    if (hash(sourceHashes()) !== hash(frozenSources)) throw new Error('Experiment source changed; refusing further trials')
    const { arm, scenario, repetition } = order[index]!
    const id = `${index + 1}-${arm.id}-${scenario}-${repetition}`, trace = join(output, id + '.jsonl')
    const world = new RecoveryWorld(scenario, id, python!)
    let status = 'step-budget', final = '', outputTokens = 0, requests = 0
    const responseModels = new Set<string>(), fingerprints = new Set<string>(), usages: any[] = []
    const started = Date.now()
    try {
      await world.initialize()
      const history: any[] = [{ role: 'user', origin: 'human', content: world.goal }]
      for (const [i, event] of (await world.seed()).entries()) {
        history.push({ role: 'assistant', content: null, reasoning_content: '', tool_calls: [{ id: `seed-${i}`, type: 'function', function: { name: event.name, arguments: JSON.stringify(event.input) } }] }, { role: 'tool', tool_call_id: `seed-${i}`, content: event.result.content })
      }
      const bus = new AdvisoryBus(), entry = recoveryEntry(scenario, arm.positive, id)
      bus.submit(entry); bus.render('七杀', 0)
      const reminders = bus.drainSystemReminders()
      if (reminders.length !== 1 || reminders[0]!.content !== entry.content) throw new Error('Candidate feedback was not routed by the real bus')
      for (const reminder of reminders) { history.push({ role: 'user', origin: 'hook', content: `<system-reminder>${reminder.content}</system-reminder>` }); bus.confirmSrDelivered(reminder.key) }
      const d = STAR_DOMAINS.qisha
      const engine = new PromptEngine({ model: parameters.model, maxTokens: 4096, staticCtx: { tools: world.definitions(), modelFamily: 'deepseek' }, volatileCtx: { cwd: world.root, activeDomain: { name: d.name, motto: d.motto, volatileBlock: d.volatileBlock + (arm.scoped ? SCOPE_CANDIDATE : '') } } })
      const built = engine.buildOaiRequest(history, undefined, 1000000), wire: any[] = structuredClone(built.messages)
      const rendered = JSON.stringify(wire)
      if (!rendered.includes(entry.content) || rendered.includes('职责边界：') !== arm.scoped) throw new Error('Actual request did not contain the intended factorial treatment')
      append(trace, { kind: 'initial', id, scenario, arm, inputHashes: world.initialHashes, tools: built.tools, messages: wire, delivered: bus.drainDelivered(), ledger: bus.drainLedger(), pythonVersion: spawnSync(python!, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout.trim(), seedEvents: world.events, promptHash: hash(wire) })
      for (let step = 0; step < protocol.maxSteps; step++) {
        abort.signal.throwIfAborted()
        let response: Response
        try { response = await fetch(api + '/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...parameters, tools: built.tools, messages: wire }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]) }) }
        catch (error) { status = abort.signal.aborted ? 'cancelled' : 'transport-error'; append(trace, { kind: status, step, errorName: error instanceof Error ? error.name : 'unknown' }); break }
        if (!response.ok) { status = `http-${response.status}`; append(trace, { kind: 'http-error', step, status: response.status }); abort.abort(); break }
        const data: any = await response.json(), choice = data.choices?.[0], message = choice?.message
        if (!message || message.role !== 'assistant') { status = 'invalid-response'; break }
        requests++; responseModels.add(data.model ?? 'absent'); fingerprints.add(data.system_fingerprint ?? 'absent'); usages.push(data.usage)
        outputTokens += data.usage?.completion_tokens ?? 0
        const { reasoning_content: reasoning, ...visible } = message
        append(trace, { kind: 'response', step, responseModel: data.model, fingerprint: data.system_fingerprint, finishReason: choice.finish_reason, usage: data.usage, assistant: visible, reasoningChars: typeof reasoning === 'string' ? reasoning.length : 0 })
        wire.push(message) // Required thinking protocol stays in memory, never in trace prose.
        final = typeof message.content === 'string' ? message.content : ''
        if (choice.finish_reason === 'length') { status = 'output-truncated'; break }
        if (!message.tool_calls?.length) { status = choice.finish_reason === 'stop' ? 'final' : 'unexpected-finish'; break }
        for (const call of message.tool_calls) {
          abort.signal.throwIfAborted()
          let input: any
          try { input = JSON.parse(call.function.arguments) } catch { status = 'invalid-tool-arguments'; break }
          const result = await world.execute(call.function.name, input)
          wire.push({ role: 'tool', tool_call_id: call.id, content: result.content })
          append(trace, { kind: 'tool', step, callId: call.id, ...world.events.at(-1) })
        }
        if (status === 'invalid-tool-arguments') break
        if (outputTokens >= protocol.maxOutputTokensPerTrial) { status = 'token-budget'; break }
      }
      const result = { id, arm: arm.id, scenario, repetition, status, requests, outputTokens, elapsedMs: Date.now() - started, responseModels: [...responseModels], fingerprints: [...fingerprints], ...world.outcome(), usages, final }
      append(join(output, 'results.jsonl'), result); results.push(result)
      console.log(JSON.stringify({ id, status, objective: result.taskObjectiveObserved, adapterBlocked: result.adapterBlocked, requests, outputTokens }))
    } catch (error) {
      append(trace, { kind: 'trial-error', errorName: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message : 'unknown' }); abort.abort(); throw error
    } finally { await world.close() }
  }
  const workers = await Promise.allSettled(Array.from({ length: protocol.concurrency }, async () => {
    while (!abort.signal.aborted && cursor < order.length) { const index = cursor++; await trial(index) }
  }))
  const failure = workers.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
} finally {
  clearTimeout(deadline)
  writeFileSync(join(output, 'summary.json'), JSON.stringify({ completedAt: new Date().toISOString(), protocolHash: hash(protocol), planned: order.length, completed: results.length, cancelled: abort.signal.aborted, finalSourcesMatch: hash(sourceHashes()) === hash(frozenSources), results }, null, 2), { flag: 'wx', mode: 0o600 })
  rmSync(isolation, { recursive: true, force: true })
}
