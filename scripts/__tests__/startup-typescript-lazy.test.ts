import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeStaticImportGraph } from '../static-import-graph.js'

test('CLI startup does not load the TypeScript compiler before verification needs it', () => {
  const graph = analyzeStaticImportGraph({ entry: 'src/main.ts' })
  assert.equal(graph.packages.has('typescript'), false,
    `TypeScript is statically imported by ${graph.packages.get('typescript')?.join(', ')}`)
})
