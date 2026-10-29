import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function productionSwitch(dependencies: Record<string, unknown>) {
  const filename = new URL('../bootstrap/official-runtime-switch.ts', import.meta.url)
  const source = ts.createSourceFile(filename.pathname, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'switchPreparedAgentRuntime')
  assert.ok(declaration, 'the real interactive switch must prepare an account-bound runtime')
  const compiled = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const exports: Record<string, (...argumentsList: any[]) => Promise<any>> = {}
  runInNewContext(compiled, { exports, preparedSwitchIntents: new WeakMap(), ...dependencies })
  return exports.switchPreparedAgentRuntime!
}

test('the actual interactive switch awaits official preparation and retains the BYOK path', async () => {
  const calls: string[] = []
  const official = { auth: { type: 'tianshu-account' } }
  const preparedConfig = { current: 'prepared' }
  const context = { config: { current: 'saved' } }
  const switchRuntime = productionSwitch({
    resolveProviderForModel: () => ({ provider: official }),
    isOfficialProvider: (provider: typeof official) => provider.auth.type === 'tianshu-account',
    prepareRuntimeContext: async () => { calls.push('prepare'); await Promise.resolve(); return { config: preparedConfig } },
    switchAgentRuntime: (current: typeof context) => { calls.push('switch'); assert.equal(current.config, preparedConfig); return { ok: true } },
  })
  assert.equal((await switchRuntime(context, 'published-model', 'official')).ok, true)
  assert.deepEqual(calls, ['prepare', 'switch'])
  let preparations = 0
  const byok = productionSwitch({
    resolveProviderForModel: () => ({ provider: {} }),
    isOfficialProvider: () => false,
    prepareRuntimeContext: async () => { preparations++; return {} },
    switchAgentRuntime: () => ({ ok: true }),
  })
  assert.equal((await byok(context, 'local-model')).ok, true)
  assert.equal(preparations, 0)
})

test('the actual interactive switch does not swap a runtime after account preparation fails', async () => {
  class OfficialError extends Error { code = 'account_changed' }
  let swaps = 0
  const context = { config: { current: 'unchanged' } }
  const original = context.config
  const switchRuntime = productionSwitch({
    resolveProviderForModel: () => ({ provider: {} }),
    isOfficialProvider: () => true,
    prepareRuntimeContext: async () => { throw new OfficialError() },
    switchAgentRuntime: () => { swaps++; return { ok: true } },
    OfficialError,
  })
  const result = await switchRuntime(context, 'published-model')
  assert.equal(result.ok, false)
  assert.equal(result.error, 'account_changed')
  assert.equal(swaps, 0)
  assert.equal(context.config, original)
})

test('a delayed official selection cannot overwrite a newer BYOK selection', async () => {
  let release!: (value: unknown) => void
  const pending = new Promise(resolve => { release = resolve })
  const selections: string[] = []
  const original = { current: 'saved' }
  const context = { config: original }
  const switchRuntime = productionSwitch({
    resolveProviderForModel: (_context: unknown, modelId: string) => ({ provider: { official: modelId === 'official' } }),
    isOfficialProvider: (provider: { official: boolean }) => provider.official,
    prepareRuntimeContext: () => pending,
    switchAgentRuntime: (_context: unknown, modelId: string) => { selections.push(modelId); return { ok: true } },
  })
  const first = switchRuntime(context, 'official')
  assert.equal((await switchRuntime(context, 'byok')).ok, true)
  release({ config: { current: 'stale-official' } })
  assert.equal((await first).ok, false)
  assert.deepEqual(selections, ['byok'])
  assert.equal(context.config, original)
})
