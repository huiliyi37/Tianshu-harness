import { it } from 'node:test'
import assert from 'node:assert/strict'
import { DecisionShiftDelivery } from '../decision-shift-delivery.js'
import type { OaiChatRequest } from '../../api/oai-types.js'
import type { AgentCallbacks } from '../loop-types.js'

it('only matching non-shadow advice included in a built request confirms a card once', () => {
  let cards = 0, records = 0
  const events: Record<string, unknown>[] = []
  const owner = new DecisionShiftDelivery(() => records++, e => events.push(e))
  const callback = { onDecisionShift: () => cards++ } as unknown as AgentCallbacks
  const payload = { source: 'convergence' as const, reason: 'stalled', methods: [], severity: 'warn' as const }
  const request = (text: string) => ({ messages: [{ role: 'system', content: text }] }) as OaiChatRequest
  let id = owner.register(1, payload, 'distinct guidance')
  assert.equal(owner.confirm([{ candidateId: id }], request('other content'), callback), false)
  id = owner.register(2, payload, 'distinct guidance')
  assert.equal(owner.confirm([{ candidateId: id, shadow: true }], request('distinct guidance'), callback), false)
  id = owner.register(3, payload, 'distinct guidance')
  owner.discard('abort')
  assert.equal(owner.confirm([{ candidateId: id }], request('distinct guidance'), callback), false)
  id = owner.register(4, payload, 'distinct guidance')
  assert.equal(owner.confirm([{ candidateId: id }], request('distinct guidance'), callback), true)
  assert.equal(owner.confirm([{ candidateId: id }], request('distinct guidance'), callback), false)
  assert.equal(cards, 1); assert.equal(records, 1)
  assert.equal(events.at(-1)?.emitted, true)
})

it('warning qualification uses delivered severity and the registration task, and clears explicitly', () => {
  let taskEpoch = 1
  const owner = new DecisionShiftDelivery(() => {}, () => {}, () => taskEpoch)
  const payload = { source: 'convergence' as const, reason: 'stalled', methods: [], severity: 'warn' as const }
  const request = { messages: [{ role: 'system', content: 'guidance' }] } as OaiChatRequest
  const deliver = (severity: 'warn' | 'info') => {
    const id = owner.register(4, { ...payload, severity }, 'guidance')
    assert.equal(owner.confirm([{ candidateId: id }], request, {} as AgentCallbacks), true)
  }
  deliver('info'); assert.equal(owner.warnedEarlier(5), false)
  deliver('warn'); assert.equal(owner.warnedEarlier(4), false)
  assert.equal(owner.warnedEarlier(5), true)
  owner.clearWarning(); assert.equal(owner.warnedEarlier(5), false)
  const old = owner.register(5, payload, 'guidance')
  taskEpoch++
  owner.confirm([{ candidateId: old }], request, {} as AgentCallbacks)
  assert.equal(owner.warnedEarlier(6), false, 'confirmation must not reassign an old warning to the new task')
})
