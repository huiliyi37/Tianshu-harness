import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { INSPECT_PROJECT_TOOL } from '../inspect-project.js'

test('project test discovery excludes metadata and preserves ordinary hidden tests', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'inspect-metadata-'))
  try {
    writeFileSync(join(cwd, 'package.json'), '{}')
    writeFileSync(join(cwd, '._only.test.ts'), 'metadata')
    writeFileSync(join(cwd, '.notes.test.ts'), '')
    const result = await INSPECT_PROJECT_TOOL.execute({ cwd, input: {}, toolUseId: 'metadata' })
    assert.equal(result.isError, undefined)
    assert.ok(!result.content.includes('._only.test.ts'))
    assert.ok(result.content.includes('.notes.test.ts'))
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('metadata does not consume the project test discovery limit', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'inspect-metadata-cap-'))
  try {
    writeFileSync(join(cwd, 'package.json'), '{}')
    for (let i = 0; i < 60; i++) writeFileSync(join(cwd, `._${String(i).padStart(3, '0')}.test.ts`), 'metadata')
    writeFileSync(join(cwd, 'real.test.ts'), '')
    const result = await INSPECT_PROJECT_TOOL.execute({ cwd, input: {}, toolUseId: 'metadata-cap' })
    assert.ok(result.content.includes('real.test.ts'))
    assert.ok(!result.content.includes('._000.test.ts'))
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
