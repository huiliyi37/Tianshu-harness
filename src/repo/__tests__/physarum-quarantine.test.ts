import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PhysarumEngine } from '../physarum-engine.js'

test('quarantine suppresses evolution before its deadline and automatically expires on the exact turn', () => {
  const graph = new PhysarumEngine(undefined)
  graph.recordFlow('src/a.ts', 'src/b.ts', 1)
  graph.freezeNode('src/a.ts', 2)
  const before = graph.getEdge('src/a.ts', 'src/b.ts')!.weight
  graph.recordFlow('src/a.ts', 'src/b.ts', 2)
  assert.equal(graph.getEdge('src/a.ts', 'src/b.ts')!.weight, before)
  graph.recordFlow('src/a.ts', 'src/b.ts', 3)
  assert.ok(graph.getEdge('src/a.ts', 'src/b.ts')!.weight > before)
})

test('cold-path turn advancement also expires quarantine without another access to that node', () => {
  const graph = new PhysarumEngine(undefined)
  graph.recordFlow('src/a.ts', 'src/b.ts', 1)
  graph.freezeNode('src/a.ts', 2)
  const before = graph.getEdge('src/a.ts', 'src/b.ts')!.weight
  graph.batchEvolve(2)
  assert.equal(graph.getEdge('src/a.ts', 'src/b.ts')!.weight, before)
  graph.batchEvolve(3)
  assert.ok(graph.getEdge('src/a.ts', 'src/b.ts')!.weight < before)
})

test('renewal extends quarantine and a shorter renewal cannot shorten its existing deadline', () => {
  const graph = new PhysarumEngine(undefined)
  graph.recordFlow('src/a.ts', 'src/b.ts', 1)
  graph.freezeNode('src/a.ts', 2)
  graph.recordFlow('src/a.ts', 'src/b.ts', 2)
  graph.freezeNode('src/a.ts', 4)
  graph.freezeNode('src/a.ts', 1)
  const before = graph.getEdge('src/a.ts', 'src/b.ts')!.weight
  graph.recordFlow('src/a.ts', 'src/b.ts', 5)
  assert.equal(graph.getEdge('src/a.ts', 'src/b.ts')!.weight, before)
  graph.recordFlow('src/a.ts', 'src/b.ts', 6)
  assert.ok(graph.getEdge('src/a.ts', 'src/b.ts')!.weight > before)
})

test('explicit unfreeze immediately resumes evolution', () => {
  const graph = new PhysarumEngine(undefined)
  graph.recordFlow('src/a.ts', 'src/b.ts', 1)
  graph.freezeNode('src/a.ts', 100)
  graph.unfreezeNode('src/a.ts')
  const before = graph.getEdge('src/a.ts', 'src/b.ts')!.weight
  graph.recordFlow('src/a.ts', 'src/b.ts', 2)
  assert.ok(graph.getEdge('src/a.ts', 'src/b.ts')!.weight > before)
})

test('non-positive or non-finite durations do not create a permanent freeze', () => {
  for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const graph = new PhysarumEngine(undefined)
    graph.recordFlow('src/a.ts', 'src/b.ts', 1)
    graph.freezeNode('src/a.ts', duration)
    const before = graph.getEdge('src/a.ts', 'src/b.ts')!.weight
    graph.recordFlow('src/a.ts', 'src/b.ts', 2)
    assert.ok(graph.getEdge('src/a.ts', 'src/b.ts')!.weight > before, `duration ${duration}`)
  }
})
