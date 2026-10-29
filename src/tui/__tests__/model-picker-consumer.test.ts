import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { switchPreparedAgentRuntime, type BootstrapContext } from '../../bootstrap.js'
import { providerSchema } from '../../config/schema.js'
import { formatModelSwitchFeedback } from '../model-switch-feedback.js'

// Execute the actual production callbacks without booting main.ts (which owns process exit).
for (const [name, next] of [['modelPickerExec', 'domainPickerSaveDefaultExec'], ['modelPickerSaveDefaultExec', 'themePickerExec']]) {
  test(`${name} does not interrupt or rebuild the current target before the runtime guard`, async () => {
    const main = readFileSync(new URL('../../main.ts', import.meta.url), 'utf8')
    const body = main.split(`/* ${name}: */`)[1]!.split(`, /* ${next}: */`)[0]!
    const js = ts.transpileModule(`const callback = ${body};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
    const provider = providerSchema.parse({ name: 'fixture', apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'current' }] })
    let aborted = 0, rebuilt = 0, saved = 0
    const messages: string[] = []
    const agent = { abort: () => { aborted++ }, config: { promptEngine: { getModel: () => 'current', exportFrozenSnapshot: () => { rebuilt++; throw new Error('must not rebuild') } } } }
    const ctx = { agent, provider, apiKey: 'fixture-only', config: { provider: { providers: { fixture: provider } } } } as unknown as BootstrapContext
    const invoke = new Function('ctx', 'switchPreparedAgentRuntime', 'applyPickerEffort', 'tuiApp', 'attachJobSubscription', 'formatModelSwitchFeedback', 'setDefaultModelConfig', `${js}\nreturn callback;`)(
      ctx, switchPreparedAgentRuntime, () => {}, { setModelInfo: () => {}, commitStatic: (text: string) => messages.push(text) }, () => {}, formatModelSwitchFeedback, () => { saved++ },
    )
    await invoke('fixture', 'current')
    assert.equal(aborted, 0)
    assert.equal(rebuilt, 0)
    assert.match(messages[0]!, /当前模型保持不变/)
    assert.equal(saved, name === 'modelPickerSaveDefaultExec' ? 1 : 0)
  })
}
