import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { latestSessionId } from '../../diagnostics/log-locations.js'
import { evictOldSubagentResults } from '../../agent/worker-result-store.js'
import { SkillRegistry, countInstalledSkills } from '../../skills/skill-loader.js'
import { SkillManagement } from '../../skills/skill-management.js'
import { SkillDrafts } from '../../skills/skill-drafts.js'
import { loadProjectRules } from '../rules-loader.js'
const roots: string[] = []
const root = () => { const p = mkdtempSync(join(tmpdir(), 'metadata-consumers-')); roots.push(p); return p }
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })
const skillText = '---\nname: fixture\ndescription: fixture skill\n---\n\nInspect fixture.\n'
const metadata = Buffer.from([0, 5, 22, 7, 0, 2, 0, 0])
test('latest logs ignore newer AppleDouble worker and main transcripts', () => {
  const p = root()
  writeFileSync(join(p, 'main.jsonl'), '{}\n')
  const old = new Date(Date.now() - 60_000)
  utimesSync(join(p, 'main.jsonl'), old, old)
  for (const n of ['worker-fixture.jsonl', '._worker-fixture.jsonl', '._main.jsonl']) writeFileSync(join(p, n), metadata)
  assert.equal(latestSessionId(p), 'main')
})
test('worker result retention counts only logical result files', () => {
  const p = root()
  for (const n of ['old.json', 'new.json', '._old.json', '._new.json']) writeFileSync(join(p, n), n.startsWith('._') ? metadata : '{}')
  const old = new Date(Date.now() - 60_000)
  utimesSync(join(p, 'old.json'), old, old)
  assert.deepEqual(evictOldSubagentResults(p, 3), [])
  assert.equal(existsSync(join(p, 'old.json')), true)
  assert.deepEqual(evictOldSubagentResults(p, 1), ['old.json'])
  assert.equal(existsSync(join(p, 'new.json')), true)
})
test('skill discovery and installed capacity exclude metadata and review drafts', () => {
  const p = root(), dir = join(p, '.rivet', 'skills')
  mkdirSync(join(dir, '_drafts'), { recursive: true })
  writeFileSync(join(dir, 'fixture.md'), skillText)
  writeFileSync(join(dir, '._fixture.md'), metadata)
  writeFileSync(join(dir, '_drafts', 'SKILL.md'), skillText)
  const result = new SkillRegistry().loadFromDirectory(dir)
  assert.deepEqual(result.loaded, ['fixture'])
  assert.deepEqual(result.errors, [])
  assert.equal(countInstalledSkills(p), 1)
  const management = new SkillManagement(join(p, 'isolated-home'), join(p, 'external-home'))
  assert.deepEqual(management.list(p).errors, [])
})
test('draft listing keeps valid entries beside metadata and invalid draft names', () => {
  const p = root(), management = new SkillManagement(join(p, 'isolated-home'), join(p, 'external-home'))
  const dir = join(management.root({ scope: 'personal' }), '_drafts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'fixture.md'), skillText)
  writeFileSync(join(dir, '._fixture.md'), metadata)
  writeFileSync(join(dir, '.bad.md'), skillText)
  const drafts = new SkillDrafts(management).list({ scope: 'personal' })
  assert.equal(drafts.find(d => d.name === 'fixture')?.content, skillText)
  assert.equal(drafts.some(d => d.name.startsWith('._')), false)
})
test('trusted project rules exclude metadata and binary content', () => {
  const p = root(), dir = join(p, '.rivet', 'rules')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'fixture.md'), 'Keep fixture checks reproducible.')
  writeFileSync(join(dir, '._fixture.md'), metadata)
  writeFileSync(join(dir, 'binary.md'), 'A\0B')
  const original = process.env.RIVET_TRUST_PROJECT
  try {
    process.env.RIVET_TRUST_PROJECT = '1'
    const rules = loadProjectRules(p)
    assert.equal(rules.length, 1)
    assert.equal(rules[0]?.text, 'Keep fixture checks reproducible.')
  } finally {
    if (original === undefined) delete process.env.RIVET_TRUST_PROJECT
    else process.env.RIVET_TRUST_PROJECT = original
  }
})
