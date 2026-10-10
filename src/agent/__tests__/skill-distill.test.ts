import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  distillSkillDraft,
  renderSkillDraftMarkdown,
  persistSkillDraft,
  listSkillDrafts,
  approveSkillDraft,
  rejectSkillDraft,
  type SkillDistillInput,
} from '../skill-distill.js'
import { parseSkillMarkdown, SkillRegistry } from '../../skills/skill-loader.js'
import type { TrajectoryEntry } from '../trajectory.js'
import type { VerificationMetadata } from '../../tools/types.js'

function traj(tool: string, target: string, status: TrajectoryEntry['status'] = 'success'): TrajectoryEntry {
  return { turn: 1, tool, target, durationMs: 1, status, inputSummary: '', resultSummary: '' }
}

function passedVerification(command = 'npm test'): VerificationMetadata {
  return { command, status: 'passed', scope: 'full', exitCode: 0, passed: 5, failed: 0, skipped: 0, durationMs: 10 }
}

function baseInput(overrides: Partial<SkillDistillInput> = {}): SkillDistillInput {
  return {
    sessionId: 'abcd1234-session',
    objective: 'add retry logic to api client',
    decisions: [],
    trajectory: [
      traj('read_file', 'src/api/client.ts'),
      traj('edit_file', 'src/api/client.ts'),
      traj('run_tests', 'src/api/__tests__/client.test.ts'),
    ],
    verifications: [passedVerification()],
    filesModified: ['src/api/client.ts'],
    existingSkills: [],
    ...overrides,
  }
}

describe('distillSkillDraft — eligibility gate', () => {
  it('returns a draft for a verified read→edit→verify session', () => {
    const draft = distillSkillDraft(baseInput())
    assert.ok(draft)
    assert.equal(draft!.steps.length, 3)
    assert.deepEqual(draft!.steps.map(s => s.phase), ['read', 'write', 'verify'])
    assert.ok(draft!.verifiedBy.length >= 1)
  })

  it('returns null when no verification passed (绿非证明)', () => {
    const draft = distillSkillDraft(baseInput({ verifications: [] }))
    assert.equal(draft, null)
  })

  it('returns null when fewer than 3 meaningful steps', () => {
    const draft = distillSkillDraft(baseInput({
      trajectory: [traj('edit_file', 'a.ts'), traj('run_tests', 'a.test.ts')],
    }))
    assert.equal(draft, null)
  })

  it('returns null when an existing skill trigger already covers the objective (dedup)', () => {
    const draft = distillSkillDraft(baseInput({
      existingSkills: [{ name: 'retry-helper', triggers: [/retry/i] }],
    }))
    assert.equal(draft, null)
  })

  it('folds consecutive same-phase tools into single steps', () => {
    const draft = distillSkillDraft(baseInput({
      trajectory: [
        traj('read_file', 'a.ts'),
        traj('grep', 'foo'),
        traj('edit_file', 'a.ts'),
        traj('bash', 'npm run test'),
      ],
    }))
    assert.ok(draft)
    assert.deepEqual(draft!.steps.map(s => s.phase), ['read', 'write', 'verify'])
  })
})

describe('renderSkillDraftMarkdown — round-trip validity', () => {
  it('produces a SKILL.md that parseSkillMarkdown can parse', () => {
    const draft = distillSkillDraft(baseInput())!
    const md = renderSkillDraftMarkdown(draft)
    const def = parseSkillMarkdown(md, `${draft.slug}.md`)
    assert.equal(def.name, draft.slug)
    assert.ok(def.description.length > 0)
    assert.ok(md.includes('skill-draft-key:'))
  })
})

describe('persistSkillDraft / list / approve / reject', () => {
  let cwd: string

  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'skill-distill-')) })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  it('draft-key metadata cannot suppress creation of a real reviewable draft', () => {
    const draft = distillSkillDraft(baseInput())!
    const dir = join(cwd, '.rivet', 'skills', '_drafts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '._missing.md'), renderSkillDraftMarkdown(draft))
    const result = persistSkillDraft(cwd, draft)
    assert.equal(result.written, true)
    assert.equal(result.path, join(dir, `${draft.slug}.md`))
    assert.ok(existsSync(result.path))
    assert.deepEqual(listSkillDrafts(cwd).map(row => row.name), [draft.slug])
    assert.deepEqual(persistSkillDraft(cwd, draft), { written: false, path: result.path })
  })

  it('draft-key dedup still recognizes an ordinary dotfile draft', () => {
    const draft = distillSkillDraft(baseInput())!
    const dir = join(cwd, '.rivet', 'skills', '_drafts')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, '.notes.md')
    writeFileSync(path, renderSkillDraftMarkdown(draft))
    assert.deepEqual(persistSkillDraft(cwd, draft), { written: false, path })
    assert.deepEqual(listSkillDrafts(cwd).map(row => row.name), ['.notes'])
  })

  it('writes a draft under .rivet/skills/_drafts/ and dedups by draft-key', () => {
    const draft = distillSkillDraft(baseInput())!
    const r1 = persistSkillDraft(cwd, draft)
    assert.equal(r1.written, true)
    assert.ok(existsSync(r1.path))
    assert.ok(r1.path.includes(join('.rivet', 'skills', '_drafts')))

    const r2 = persistSkillDraft(cwd, draft)
    assert.equal(r2.written, false) // same draft-key → no re-draft
  })

  it('drafts are NOT loaded into the discovery registry (_drafts isolation)', () => {
    const draft = distillSkillDraft(baseInput())!
    persistSkillDraft(cwd, draft)

    const registry = new SkillRegistry()
    const { loaded } = registry.loadFromDirectory(join(cwd, '.rivet', 'skills'))
    assert.deepEqual(loaded, []) // _drafts skipped → nothing enters the frozen prefix
    assert.equal(registry.list().length, 0)
  })

  it('listSkillDrafts returns name + description', () => {
    const draft = distillSkillDraft(baseInput())!
    persistSkillDraft(cwd, draft)
    const drafts = listSkillDrafts(cwd)
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0]!.name, draft.slug)
    assert.ok(drafts[0]!.description.length > 0)
  })

  it('listSkillDrafts ignores AppleDouble metadata beside a Markdown draft', () => {
    const dir = join(cwd, '.rivet', 'skills', '_drafts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'draft.md'), '---\nname: draft\ndescription: Synthetic draft\n---\nFixture body.\n')
    writeFileSync(join(dir, '._draft.md'), Buffer.from('0005160700020000' + '00'.repeat(18), 'hex'))

    const drafts = listSkillDrafts(cwd)
    assert.deepEqual(drafts.map(draft => draft.name), ['draft'])
    assert.equal(drafts[0]!.description, 'Synthetic draft')
  })

  it('approveSkillDraft moves a valid draft into .rivet/skills/ and it becomes loadable', () => {
    const draft = distillSkillDraft(baseInput())!
    persistSkillDraft(cwd, draft)

    const res = approveSkillDraft(cwd, draft.slug)
    assert.equal(res.ok, true)
    assert.equal(res.skill?.name, draft.slug)
    // draft removed, skill present
    assert.equal(listSkillDrafts(cwd).length, 0)
    assert.ok(existsSync(join(cwd, '.rivet', 'skills', `${draft.slug}.md`)))

    const registry = new SkillRegistry()
    const { loaded } = registry.loadFromDirectory(join(cwd, '.rivet', 'skills'))
    assert.ok(loaded.includes(draft.slug))
  })

  it('approveSkillDraft refuses an invalid-frontmatter draft', () => {
    const dir = join(cwd, '.rivet', 'skills', '_drafts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'broken.md'), 'no frontmatter here\njust text')

    const res = approveSkillDraft(cwd, 'broken')
    assert.equal(res.ok, false)
    assert.match(res.error ?? '', /frontmatter/)
    // draft NOT moved
    assert.ok(existsSync(join(dir, 'broken.md')))
  })

  it('rejectSkillDraft deletes the draft', () => {
    const draft = distillSkillDraft(baseInput())!
    persistSkillDraft(cwd, draft)
    assert.equal(rejectSkillDraft(cwd, draft.slug), true)
    assert.equal(listSkillDrafts(cwd).length, 0)
    assert.equal(rejectSkillDraft(cwd, 'nonexistent'), false)
  })
})

it('skill phase classification shares invocation facts and leaves quoted test searches as reads', () => {
  const draft = distillSkillDraft(baseInput({ trajectory: [traj('read_file', 'a.ts'), traj('edit_file', 'a.ts'), traj('bash', 'rg "npm test" src'), traj('run_tests', 'a.test.ts')] }))
  assert.ok(draft)
  assert.deepEqual(draft.steps.map(step => step.phase), ['read', 'write', 'read', 'verify'])
})
