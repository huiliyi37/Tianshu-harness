import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCapabilities, resolveEffortChoices, normalizeReasoningEffort } from '../provider.js'

describe('model-aware reasoning effort choices', () => {
  it('shows only distinct DeepSeek effort levels', () => {
    assert.deepEqual(resolveEffortChoices('deepseek', {}).map(c => c.id), ['off', 'low', 'high', 'max'])
    assert.equal(normalizeReasoningEffort('medium', resolveCapabilities('deepseek')), 'high')
  })

  it('does not offer an Off level that Grok maps to Low and labels its highest wire level', () => {
    const choices = resolveEffortChoices('grok', {})
    assert.deepEqual(choices.map(c => c.id), ['low', 'medium', 'high', 'max'])
    assert.equal(choices.at(-1)!.label, 'XHigh')
    assert.equal(normalizeReasoningEffort('off', resolveCapabilities('grok')), 'low')
  })

  it('resolves model overrides over provider defaults', () => {
    assert.deepEqual(resolveEffortChoices('deepseek', {}, { effortCap: { off: 'none', low: 'high', medium: 'high', max: 'high' } }).map(c => c.id), ['off', 'high'])
    assert.deepEqual(resolveEffortChoices('deepseek', {}, { effortFormat: 'none' }), [])
  })

  it('disables controls when thinking is disabled or the protocol has no live effort channel', () => {
    assert.deepEqual(resolveEffortChoices('deepseek', { thinking: 'disabled' }), [])
    assert.deepEqual(resolveEffortChoices('custom', {}), [])
    assert.deepEqual(resolveEffortChoices('deepseek', { protocol: 'anthropic' }), [])
  })

  it('uses the actual Responses channel even when a custom provider lacks OpenAI chat defaults', () => {
    assert.deepEqual(resolveEffortChoices('custom', { protocol: 'openai-responses' }).map(c => c.id), ['low', 'medium', 'high', 'max'])
  })

  it('keeps native Gemini budget controls, including the real zero-budget Off option', () => {
    assert.deepEqual(resolveEffortChoices('gemini', { protocol: 'gemini' }).map(c => c.id), ['off', 'low', 'medium', 'high', 'max'])
    assert.deepEqual(resolveEffortChoices('gemini', { protocol: 'gemini', thinking: 'disabled' }), [])
  })
})
