import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { formatModelSwitchFeedback } from '../model-switch-feedback.js'

test('the actual model slash handler waits for preparation before reporting success', async () => {
  const source = ts.createSourceFile('slash-commands.ts', readFileSync(new URL('../slash-commands.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  let handler: ts.MethodDeclaration | undefined
  const inspect = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node) && node.properties.some(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'name' && ts.isStringLiteral(property.initializer) && property.initializer.text === '/model')) {
      handler = node.properties.find(ts.isMethodDeclaration)
    }
    ts.forEachChild(node, inspect)
  }
  inspect(source)
  assert.ok(handler)
  const javascript = ts.transpileModule(`const command = { ${handler.getText(source)} }; exports.run = command.handler`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const exports: { run?: (context: unknown) => Promise<boolean> } = {}
  runInNewContext(javascript, { exports, createLogEntry: (entry: unknown) => entry, formatModelSwitchFeedback })
  let release!: (value: { ok: boolean }) => void
  const pending = new Promise<{ ok: boolean }>(resolve => { release = resolve })
  const output: unknown[] = []
  let stopped = false
  const result = exports.run!({ parts: ['/model', 'official:model'], pushStatic: (entry: unknown) => output.push(entry), setIsStreaming: () => { stopped = true }, onModelSwitch: () => pending })
  try {
    await Promise.resolve()
    assert.equal(output.length, 0, 'must not display a promise as a failed selection')
    assert.equal(stopped, false)
  } finally { release({ ok: true }); await result }
  assert.equal(stopped, false, 'model selection does not unconditionally reset the live streaming UI')
  assert.equal(await result, true)
  assert.match(JSON.stringify(output), /Model → official:model/)
})
