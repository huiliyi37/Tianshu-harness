import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatMemoryOverview, searchMemory, type SlashHandlerContext } from '../slash-commands.js'

test('memory overview and search exclude metadata before limits and preserve dotfile knowledge', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'memory-metadata-'))
  const previousCwd = process.cwd()
  const dir = join(cwd, '.rivet', 'knowledge')
  const ctx = {
    persist: { loadMemory: () => ({ entries: [{ id: 'm1', text: 'sessionneedle' }] }) },
    agent: { getLatestPheromones: () => [{ path: 'guide', signal: 'pheromoneneedle', strength: 1 }] },
  } as unknown as SlashHandlerContext
  try {
    mkdirSync(dir, { recursive: true }); process.chdir(cwd)
    writeFileSync(join(dir, '.notes.md'), 'realneedle hidden knowledge')
    for (let i = 0; i < 6; i++) writeFileSync(join(dir, `note-${i}.md`), 'realneedle real knowledge')
    for (let i = 0; i < 9; i++) writeFileSync(join(dir, `._metadata-${i}.md`), 'ghostneedle metadata-only knowledge')
    writeFileSync(join(dir, '.DS_Store'), 'ghostneedle')
    const overview = formatMemoryOverview(ctx)
    assert.match(overview, /项目知识 \(7 篇\)/)
    assert.match(overview, /• \.notes\.md/)
    assert.match(overview, /• note-5\.md/)
    assert.doesNotMatch(overview, /\._|\.DS_Store/)
    assert.equal(searchMemory(ctx, 'ghostneedle'), 'No memory found for "ghostneedle".')
    assert.equal(searchMemory(ctx, 'realneedle').match(/knowledge:/g)?.length, 7)
    assert.match(searchMemory(ctx, 'realneedle'), /knowledge:\.notes\.md/)
    assert.match(searchMemory(ctx, 'sessionneedle'), /session:m1/)
    assert.match(searchMemory(ctx, 'pheromoneneedle'), /pheromone:guide/)
    writeFileSync(join(dir, 'zz-extra-1.md'), 'realneedle extra')
    writeFileSync(join(dir, 'zz-extra-2.md'), 'realneedle extra')
    const capped = formatMemoryOverview(ctx)
    assert.match(capped, /项目知识 \(8 篇\)/)
    assert.doesNotMatch(capped, /zz-extra-2\.md/)
  } finally { process.chdir(previousCwd); rmSync(cwd, { recursive: true, force: true }) }
})
