import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { overlayFleetStatus, type TeamPanelModel } from '../team-panel-model.js'
import { FleetRegistry } from '../fleet-registry.js'
import { buildTeamPanelLines } from '../format/team-panel.js'

function baseModel(): TeamPanelModel {
  return {
    mode: 'standard',
    currentWave: 0,
    totalWaves: 2,
    dispatched: 2,
    blocked: [],
    waves: [
      { id: 'wave-1', taskIds: ['t1', 't2'], risk: 'low', reason: 'parallel-safe' },
      { id: 'wave-2', taskIds: ['t3'], risk: 'high', reason: 'shared files' },
    ],
    tasks: [
      { id: 't1', title: 'explore', authority: 'pojun', profile: 'explorer', kind: 'explore', dependsOn: [], riskTier: 'low', files: [], status: 'waiting' },
      { id: 't2', title: 'map', authority: 'tianxuan', profile: 'explorer', kind: 'explore', dependsOn: [], riskTier: 'low', files: [], status: 'waiting' },
      { id: 't3', title: 'patch', authority: 'tianliang', profile: 'patcher', kind: 'patch', dependsOn: ['t1'], riskTier: 'high', files: [], status: 'waiting' },
    ],
  }
}

describe('overlayFleetStatus', () => {
  it('upgrades waiting→running and attaches elapsed + activity', () => {
    const fleet = new FleetRegistry()
    fleet.apply({ workOrderId: 'wo_team:t1', parentToolId: 'p1', status: 'running', progressLine: 'editing file' }, 1000)
    const model = overlayFleetStatus(baseModel(), fleet.getWorkers(3000))
    const t1 = model.tasks.find(t => t.id === 't1')!
    assert.equal(t1.status, 'running')
    assert.equal(t1.elapsedMs, 2000)
    assert.equal(t1.activity, 'editing file')
  })

  it('maps passed→done and blocked→blocked', () => {
    const fleet = new FleetRegistry()
    fleet.apply({ workOrderId: 'wo_team:t1', parentToolId: 'p1', status: 'completed' }, 0)
    fleet.apply({ workOrderId: 'wo_team:t2', parentToolId: 'p1', status: 'blocked' }, 0)
    const model = overlayFleetStatus(baseModel(), fleet.getWorkers(10))
    assert.equal(model.tasks.find(t => t.id === 't1')!.status, 'done')
    assert.equal(model.tasks.find(t => t.id === 't2')!.status, 'blocked')
  })

  it('marks a downstream waiting task ready once its deps are done', () => {
    const fleet = new FleetRegistry()
    fleet.apply({ workOrderId: 'wo_team:t1', parentToolId: 'p1', status: 'completed' }, 0)
    const model = overlayFleetStatus(baseModel(), fleet.getWorkers(10))
    const t3 = model.tasks.find(t => t.id === 't3')!
    assert.equal(t3.status, 'waiting')
    assert.equal(t3.activity, 'ready · deps met')
  })

  it('never downgrades an already-advanced status', () => {
    const model = baseModel()
    model.tasks[0]!.status = 'done'
    const fleet = new FleetRegistry()
    fleet.apply({ workOrderId: 'wo_team:t1', parentToolId: 'p1', status: 'running' }, 0)
    const out = overlayFleetStatus(model, fleet.getWorkers(10))
    assert.equal(out.tasks.find(t => t.id === 't1')!.status, 'done')
  })

  it('returns the same model when no workers observed', () => {
    const model = baseModel()
    assert.equal(overlayFleetStatus(model, []), model)
  })
})

describe('buildTeamPanelLines progress + live rows', () => {
  it('renders a group progress bar and per-task live rows', () => {
    const fleet = new FleetRegistry()
    fleet.apply({ workOrderId: 'wo_team:t1', parentToolId: 'p1', status: 'completed' }, 0)
    fleet.apply({ workOrderId: 'wo_team:t2', parentToolId: 'p1', status: 'running', progressLine: 'scanning' }, 0)
    const model = overlayFleetStatus(baseModel(), fleet.getWorkers(2500))
    const plain = buildTeamPanelLines(model, 80).join('\n')
    assert.ok(/\d\/3 完成/.test(plain), `progress bar present: ${plain}`)
    assert.ok(plain.includes('scanning'), 'activity line present')
    assert.ok(plain.includes('ready · deps met'), 'dependency unlock cue present')
  })
})
