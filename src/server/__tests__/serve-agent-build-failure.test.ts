import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

/**
 * 半建的会话不能把 stores 留在迟绑定表里：之后的查询会把它当成已建好，极限思考面板就会读到
 * 「既无控制器也无原因」，误报「当前安装包未包含极限思考能力」（实机出现过）。
 *
 * 只把 buildManagedAgent 里「登记 stores → 解析模型 → 装配」这一段原样抽出来执行，重型装配换成可控替身。
 */
type Entry = { stores: unknown; cwd: string; currentModelRef?: () => string }
type Spec = { provider: { name: string }; model: { id: string }; keyId?: string }

function buildSlice(): (deps: {
  table: Map<string, Entry>
  stores: unknown
  preferredModelId?: string
  resolvePreferred?: (ctx: unknown, id: string, reload?: unknown) => Spec | null
  resolveInitial?: () => Spec
  assemble?: (spec: Spec) => unknown
}) => { agent: unknown } {
  const source = readFileSync(new URL('../serve-agent.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('serve-agent.ts', source, ts.ScriptTarget.Latest, true)
  const fn = parsed.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'buildManagedAgent')
  assert.ok(fn && ts.isFunctionDeclaration(fn) && fn.body)
  const body = fn.body.statements
  const start = body.findIndex(s => ts.isExpressionStatement(s) && s.getText(parsed).startsWith('sessionStoresById.set('))
  const tryAt = body.findIndex(s => ts.isTryStatement(s))
  assert.ok(start > 0 && tryAt > start, 'stores 登记之后，模型解析与装配必须包在 try 里')
  const code = ts.transpileModule(`${body.slice(start, tryAt + 1).map(s => s.getText(parsed)).join('\n')}\nreturn { agent }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const run = new Function('sessionStoresById', 'stores', 'cwd', 'sessionId', 'preferredModelId', 'ctx', 'reload',
    'resolveModelSpecWithReload', 'resolveInitialSpec', 'assembleAgentLoop', 'approvalMode', 'registry', 'shared', 'allowedTools', 'prepared', code)
  return (deps) => run(deps.table, deps.stores, '/w', 's1', deps.preferredModelId, {}, undefined,
    deps.resolvePreferred ?? (() => null),
    deps.resolveInitial ?? (() => ({ provider: { name: 'fixture' }, model: { id: 'default' } })),
    (_ctx: unknown, _cwd: string, _id: string, _stores: unknown, spec: Spec) => (deps.assemble ?? (() => ({ built: spec.model.id })))(spec),
    'normal', undefined, undefined, undefined, undefined) as { agent: unknown }
}

test('a throwing assembly drops the half-built stores entry and rethrows the real error', () => {
  const slice = buildSlice()
  const table = new Map<string, Entry>()
  assert.throws(() => slice({ table, stores: {}, assemble: () => { throw new Error('pinned skills unreadable') } }), /pinned skills unreadable/)
  assert.equal(table.has('s1'), false)
  assert.throws(() => slice({ table, stores: {}, resolveInitial: () => { throw new Error('no provider configured') } }), /no provider configured/)
  assert.equal(table.has('s1'), false, 'a model-resolution failure is cleaned up the same way')
})

test('a newer entry registered meanwhile survives an older build failing', () => {
  const slice = buildSlice()
  const table = new Map<string, Entry>()
  const newer = { stores: { newer: true }, cwd: '/w' }
  assert.throws(() => slice({ table, stores: {}, assemble: () => { table.set('s1', newer); throw new Error('late failure') } }))
  assert.equal(table.get('s1'), newer)
})

test('a successful build keeps the entry and reports the live model', () => {
  const slice = buildSlice()
  const table = new Map<string, Entry>()
  const stores = {}
  const { agent } = slice({ table, stores, preferredModelId: 'm1',
    resolvePreferred: (_ctx, id) => ({ provider: { name: 'fixture' }, model: { id }, keyId: 'k' }) })
  assert.deepEqual(agent, { built: 'm1' }, 'model affinity: builds on the preferred model')
  assert.equal(table.get('s1')?.stores, stores)
  assert.equal(table.get('s1')?.currentModelRef?.(), 'fixture:k:m1')
})
