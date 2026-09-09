import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContextClaimStore } from '../../context/claim-store.js'
import type { EmbeddingProvider } from '../../search/embedding-provider.js'
import { createMemoryTool } from '../../tools/memory.js'
import { appendMemoryEntry } from '../unified-memory.js'
import { resetKnowledgeIndexCache } from '../knowledge-index.js'

const roots: string[] = []

afterEach(() => {
  resetKnowledgeIndexCache()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('memory tool embedding wiring', () => {
  it('uses the configured embedding provider for semantic-only recall', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-memory-tool-'))
    roots.push(cwd)
    appendMemoryEntry(cwd, {
      text: 'Authentication policy requires rotating credentials after a security incident.',
      kind: 'project_rule', confidence: 1, source: 'manual', status: 'verified', tags: [],
    })
    const embedder: EmbeddingProvider = {
      id: 'test-semantic',
      isAvailable: () => true,
      embed: async texts => texts.map(text =>
        /authentication|login/i.test(text) ? [1, 0] : [0, 1]),
    }
    const tool = createMemoryTool({} as ContextClaimStore, {
      sessionId: 'test-session', getTurn: () => 1, cwd, embeddingProvider: embedder,
    })

    const result = await tool.execute({
      input: { action: 'recall', query: 'login' }, toolUseId: 'tool-1', cwd,
    })
    assert.equal(result.isError, undefined)
    assert.match(result.content, /Authentication policy/)
  })
})
