import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { orderDispatchKey } from '../coordinator.js'
import { createReadOnlyWorkOrder } from '../work-order.js'

describe('Coordinator batch concurrency isolation (#429)', () => {
  it('orderDispatchKey differentiates top-level batches with identical order.id', () => {
    // Two concurrent top-level delegate_batch calls
    const order1 = createReadOnlyWorkOrder({
      id: 'batch:0',
      parentTurnId: 'toolu_batch_AAA:batch:0',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Search A',
      scope: {},
    })

    const order2 = createReadOnlyWorkOrder({
      id: 'batch:0',
      parentTurnId: 'toolu_batch_BBB:batch:0',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Search B',
      scope: {},
    })

    // order.id is stable for dependsOn / fleet UI
    assert.equal(order1.id, 'batch:0')
    assert.equal(order2.id, 'batch:0')

    // orderDispatchKey must be unique per batch invocation
    const key1 = orderDispatchKey(order1)
    const key2 = orderDispatchKey(order2)
    assert.equal(key1, 'toolu_batch_AAA:batch:0')
    assert.equal(key2, 'toolu_batch_BBB:batch:0')
    assert.notEqual(key1, key2, 'concurrent top-level batches must not share the same dispatch key')
  })
})
