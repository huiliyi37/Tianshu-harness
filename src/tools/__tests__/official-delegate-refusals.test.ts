import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegateTaskTool } from '../delegate-task.js'
import { createDelegateBatchTool } from '../delegate-batch.js'
import { OfficialError } from '../../models/official-contract.js'
import { deriveWorkOrderId, type DelegationRequest } from '../../agent/coordinator.js'

for (const mode of ['single', 'batch'] as const) {
  for (const code of ['pricing_changed', 'account_changed'] as const) {
    test(`${mode} delegate retains ${code} identity and emits a terminal before refusing`, async () => {
      const refusal = new OfficialError(code, 409, false)
      const dispatch = async (request: DelegationRequest, onOrderCreated?: (orderId: string) => void): Promise<never> => {
        const workOrderId = deriveWorkOrderId(request.parentTurnId ?? 'official-worker') ?? 'official-worker'
        onOrderCreated?.(workOrderId)
        request.onActivity?.({ workOrderId, profile: 'code_scout', kind: 'text', detail: 'started' })
        throw refusal
      }
      const tool = mode === 'single'
        ? createDelegateTaskTool({ delegate: (request, _signal, onOrderCreated) => dispatch(request, onOrderCreated) })
        : createDelegateBatchTool({ delegateBatch: async requests => dispatch(requests[0]!) })
      const events: Array<{ status: string }> = []
      const task = { objective: 'Inspect the fixture and retain originating authority', profile: 'code_scout' }
      await assert.rejects(tool.execute({
        input: mode === 'single' ? task : { tasks: [task] },
        toolUseId: `official-${mode}-${code}`, cwd: '/synthetic',
        onWorkerActivity: event => { events.push({ status: event.status }) },
      }), error => error === refusal)
      if (mode === 'single') assert.ok(events.some(event => event.status === 'running'))
      assert.equal(events.at(-1)?.status, 'blocked')
      const settledCount = events.length
      await new Promise<void>(resolve => setTimeout(resolve, 150))
      assert.equal(events.length, settledCount)
    })
  }
}
