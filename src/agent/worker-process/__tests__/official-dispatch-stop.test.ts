import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkerSessionOop } from '../parent.js'
import type { WorkerSessionConfig } from '../../worker-session.js'
import type { ModelSubmission } from '../../../models/model-runtime.js'
import { PromptEngine } from '../../../prompt/engine.js'
import { ToolRegistry } from '../../../tools/registry.js'

test('already canceled worker never prepares authority or starts a process', async () => {
  const controller = new AbortController()
  const reason = new Error('dispatch already stopped')
  controller.abort(reason)
  let spawns = 0
  let preparations = 0
  const config = {
    abortSignal: controller.signal, runtimeDecision: {}, cwd: process.cwd(), order: {},
    promptEngine: new PromptEngine({ model: 'fixture', maxTokens: 100, staticCtx: { tools: [] }, volatileCtx: { cwd: process.cwd() } }),
    toolRegistry: new ToolRegistry(),
    runtimeContext: { provider: { name: 'official', auth: { type: 'tianshu-account' } } },
    runtimeSubmission: { capture: () => { preparations++; throw new Error('unexpected authority preparation') } },
  } as unknown as WorkerSessionConfig
  await assert.rejects(runWorkerSessionOop(config, {
    getMemoryBlock: () => undefined,
    entryOverride: { execArgs: [], script: 'unused' },
    spawnOverride: () => { spawns++; throw new Error('unexpected spawn') },
  }), error => error === reason)
  assert.equal(spawns, 0)
  assert.equal(preparations, 0)
})

test('cancellation during parent preparation fences child startup and reaches model resolver', async () => {
  const controller = new AbortController()
  const reason = new Error('preparation stopped')
  let resolveStarted!: () => void
  const started = new Promise<void>(resolve => { resolveStarted = resolve })
  let finishPreparation!: () => void
  const preparing = new Promise<void>(resolve => { finishPreparation = resolve })
  let receivedSignal: AbortSignal | undefined
  const submission = {
    capture: () => submission,
    resolve: async (input: { signal?: AbortSignal }) => {
      receivedSignal = input.signal
      resolveStarted()
      await preparing
      throw reason
    },
  } as unknown as ModelSubmission
  const provider = { name: 'official', auth: { type: 'tianshu-account' } }
  const config = {
    abortSignal: controller.signal, runtimeDecision: {}, runtimeSubmission: submission,
    runtimeContext: { provider, config: { provider: { providers: {} }, agent: {} } },
  } as unknown as WorkerSessionConfig
  let spawns = 0
  const run = runWorkerSessionOop(config, {
    getMemoryBlock: () => undefined,
    entryOverride: { execArgs: [], script: 'unused' },
    spawnOverride: () => { spawns++; throw new Error('unexpected spawn') },
  })
  await started
  controller.abort(reason)
  finishPreparation()
  await assert.rejects(run, error => error === reason)
  assert.equal(receivedSignal, controller.signal)
  assert.equal(spawns, 0)
})
