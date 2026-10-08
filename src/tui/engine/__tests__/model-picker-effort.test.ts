import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp } from './_harness.js'
import type { ModelPickerEntry } from '../../format/overlay.js'

describe('model picker effort navigation & capabilities', () => {
  it('normalizes incompatible draft to defaultEffort on navigation and applies on submit', () => {
    const { app, stdin } = makeApp()
    let submittedProvider = ''
    let submittedModel = ''
    let submittedEffort: string | undefined = undefined

    const entries: ModelPickerEntry[] = [
      { id: 'model-a', provider: 'prov-a', current: true, effortSupported: true },
      {
        id: 'model-b',
        provider: 'prov-b',
        current: false,
        effortSupported: true,
        effortLevels: ['auto', 'low'],
        defaultEffort: 'low',
      },
    ]

    app.setReasoningEffortProvider(() => 'max')
    app.registerOverlays(
      { modelPickerData: () => ({ entries, selectedIndex: 0 }) },
      undefined,
      undefined,
      undefined,
      undefined,
      (provider, modelId, effort) => {
        submittedProvider = provider
        submittedModel = modelId
        submittedEffort = effort
      },
      undefined,
      undefined,
    )

    app.activateOverlay('model-picker')
    stdin.dataHandler!('\x1B[B')
    stdin.dataHandler!('\r')

    assert.equal(submittedProvider, 'prov-b')
    assert.equal(submittedModel, 'model-b')
    assert.equal(submittedEffort, 'low', 'Incompatible draft max must normalize to low and apply at commit')
  })

  it('unsupported model does not step and does not pass stale effort on submit', () => {
    const { app, stdin } = makeApp()
    let submittedEffort: string | undefined = 'initial'

    const entries: ModelPickerEntry[] = [
      { id: 'model-a', provider: 'prov-a', current: true, effortSupported: true },
      { id: 'model-unsupported', provider: 'prov-u', current: false, effortSupported: false },
    ]

    app.setReasoningEffortProvider(() => 'high')
    app.registerOverlays(
      { modelPickerData: () => ({ entries, selectedIndex: 0 }) },
      undefined,
      undefined,
      undefined,
      undefined,
      (_provider, _modelId, effort) => {
        submittedEffort = effort
      },
      undefined,
      undefined,
    )

    app.activateOverlay('model-picker')
    stdin.dataHandler!('\x1B[B')
    stdin.dataHandler!('>')
    stdin.dataHandler!('\r')

    assert.equal(submittedEffort, undefined, 'Unsupported model must not pass effort on submit')
  })

  it('steps with restricted levels and submits with s preserving default behavior', () => {
    const { app, stdin } = makeApp()
    let defaultSavedProvider = ''
    let defaultSavedModel = ''
    let defaultSavedEffort: string | undefined = undefined

    const entries: ModelPickerEntry[] = [
      {
        id: 'model-grok',
        provider: 'grok',
        current: true,
        effortSupported: true,
        effortLevels: ['auto', 'low', 'high', 'max'],
        effortLabels: { max: 'XHigh' },
      },
    ]

    app.setReasoningEffortProvider(() => 'auto')
    app.registerOverlays(
      { modelPickerData: () => ({ entries, selectedIndex: 0 }) },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (provider, modelId, effort) => {
        defaultSavedProvider = provider
        defaultSavedModel = modelId
        defaultSavedEffort = effort
      },
    )

    app.activateOverlay('model-picker')
    stdin.dataHandler!('>')
    stdin.dataHandler!('s')

    assert.equal(defaultSavedProvider, 'grok')
    assert.equal(defaultSavedModel, 'model-grok')
    assert.equal(defaultSavedEffort, 'low')
  })


  it('submits unchanged manual low draft when switching to another supported model with preset high', () => {
    const { app, stdin } = makeApp()
    let submittedProvider = ''
    let submittedModel = ''
    let submittedEffort: string | undefined = undefined

    const entries: ModelPickerEntry[] = [
      { id: 'model-a', provider: 'prov-a', current: true, effortSupported: true },
      {
        id: 'model-b',
        provider: 'prov-b',
        current: false,
        effortSupported: true,
        effortLevels: ['auto', 'low', 'medium', 'high', 'max'],
        defaultEffort: 'high',
      },
    ]

    app.setReasoningEffortProvider(() => 'low')
    app.registerOverlays(
      { modelPickerData: () => ({ entries, selectedIndex: 0 }) },
      undefined,
      undefined,
      undefined,
      undefined,
      (provider, modelId, effort) => {
        submittedProvider = provider
        submittedModel = modelId
        submittedEffort = effort
      },
      undefined,
      undefined,
    )

    app.activateOverlay('model-picker')
    stdin.dataHandler!(String.fromCharCode(27) + '[B')
    stdin.dataHandler!(String.fromCharCode(13))

    assert.equal(submittedProvider, 'prov-b')
    assert.equal(submittedModel, 'model-b')
    assert.equal(submittedEffort, 'low', 'Unchanged manual low draft must be submitted on model switch so preview matches applied effort')
  })

  it('data.effort.value auto overrides metrics actual high and remains auto on switch', () => {
    const { app, stdin } = makeApp()
    let submittedProvider = ''
    let submittedModel = ''
    let submittedEffort: string | undefined = undefined

    const entries: ModelPickerEntry[] = [
      { id: 'model-a', provider: 'prov-a', current: true, effortSupported: true },
      {
        id: 'model-b',
        provider: 'prov-b',
        current: false,
        effortSupported: true,
        defaultEffort: 'high',
      },
    ]

    app.setReasoningEffortProvider(() => 'high')
    app.registerOverlays(
      {
        modelPickerData: () => ({
          entries,
          selectedIndex: 0,
          effort: { value: 'auto', supported: true },
        }),
      },
      undefined,
      undefined,
      undefined,
      undefined,
      (provider, modelId, effort) => {
        submittedProvider = provider
        submittedModel = modelId
        submittedEffort = effort
      },
      undefined,
      undefined,
    )

    app.activateOverlay('model-picker')
    stdin.dataHandler!(String.fromCharCode(27) + '[B')
    stdin.dataHandler!(String.fromCharCode(13))

    assert.equal(submittedProvider, 'prov-b')
    assert.equal(submittedModel, 'model-b')
    assert.equal(submittedEffort, 'auto', 'Auto mode from data.effort.value must override glance metric high and apply on switch')
  })
})
