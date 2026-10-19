import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSkillsCLI } from '../skills-cli.js'
import { SkillManagement } from '../../skills/skill-management.js'
import { SkillDrafts } from '../../skills/skill-drafts.js'
import { sessionSkillSnapshot } from '../../skills/session-skill-snapshot.js'
import { createRouter } from '../../server/index.js'
import { buildSkillManagementRoutes } from '../../server/skill-management-routes.js'

// Exercise the trusted project path; production home and sessions are never used.
process.env.RIVET_TRUST_PROJECT = '1'

const markdown = (body = '## Steps\nSummarize the supplied weekly notes.') => `---\nname: weekly-report\ndescription: Use when turning weekly notes into a company report.\n---\n${body}\n`

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'skill-creation-'))
  const cwd = join(root, 'project'), other = join(root, 'other'), home = join(root, 'home'), external = join(root, 'external')
  for (const dir of [cwd, other, home, external]) mkdirSync(dir)
  const management = new SkillManagement(home, external)
  const file = join(cwd, 'draft source.md')
  writeFileSync(file, markdown())
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const run = (args: string[]) => runSkillsCLI(args, { cwd, management })
  return { root, cwd, other, home, file, management, run, drafts: new SkillDrafts(management) }
}

for (const scope of ['personal', 'project'] as const) {
  test(`conversation draft in ${scope} scope stays hidden until approval and leaves existing snapshots unchanged`, async t => {
    const f = fixture(t)
    const context = { scope, cwd: f.cwd }
    const before = sessionSkillSnapshot(f.cwd, undefined, f.management)
    assert.ok(before.get('skill-creator'), 'new built-in must reach session registries')
    const save = await f.run(['draft', 'weekly-report', '--file', 'draft source.md', '--scope', scope, '--json'])
    assert.equal(save.exitCode, 0, save.output)
    assert.deepEqual(JSON.parse(save.output), { name: 'weekly-report', draft: true })
    assert.equal(f.drafts.read(context, 'weekly-report'), markdown())
    const otherScope = scope === 'personal' ? 'project' : 'personal'
    assert.equal(f.drafts.list({ scope: otherScope, cwd: f.cwd }).length, 0)
    assert.ok(!f.management.list(f.cwd).skills.some(s => s.name === 'weekly-report'))
    assert.equal(sessionSkillSnapshot(f.cwd, undefined, f.management).get('weekly-report'), undefined)
    assert.equal(JSON.parse((await f.run(['drafts', '--scope', scope, '--json'])).output)[0].name, 'weekly-report')

    const approved = await f.run(['approve', 'weekly-report', '--scope', scope, '--json'])
    assert.equal(approved.exitCode, 0, approved.output)
    assert.equal(f.drafts.list(context).length, 0)
    assert.equal(before.get('weekly-report'), undefined)
    const next = sessionSkillSnapshot(f.cwd, undefined, f.management)
    assert.match(next.get('weekly-report')!.body, /Summarize the supplied weekly notes/)
    assert.equal(Boolean(sessionSkillSnapshot(f.other, undefined, f.management).get('weekly-report')), scope === 'personal')
  })
}

test('explicit project chooses both input-file resolution and draft destination', async t => {
  const f = fixture(t)
  writeFileSync(join(f.other, 'draft source.md'), markdown('Content from the selected project'))
  const result = await f.run(['draft', 'weekly-report', '--file', 'draft source.md', '--scope', 'project', '--project', f.other])
  assert.equal(result.exitCode, 0, result.output)
  assert.match(f.drafts.read({ scope: 'project', cwd: f.other }, 'weekly-report'), /Content from the selected project/)
  assert.equal(f.drafts.list({ scope: 'project', cwd: f.cwd }).length, 0)
})

test('editing and rejecting a draft never installs it', async t => {
  const f = fixture(t)
  const args = ['draft', 'weekly-report', '--file', f.file, '--scope', 'project']
  assert.equal((await f.run(args)).exitCode, 0)
  writeFileSync(f.file, markdown('Revised instructions'))
  assert.equal((await f.run(args)).exitCode, 0)
  assert.match(f.drafts.read({ scope: 'project', cwd: f.cwd }, 'weekly-report'), /Revised instructions/)
  assert.equal((await f.run(['reject', 'weekly-report', '--scope', 'project'])).exitCode, 0)
  assert.equal(f.drafts.list({ scope: 'project', cwd: f.cwd }).length, 0)
  assert.ok(!f.management.list(f.cwd).skills.some(s => s.name === 'weekly-report'))
  assert.equal(readFileSync(f.file, 'utf8'), markdown('Revised instructions'), 'source is preserved')
})

test('missing arguments, scope and invalid documents cannot create a draft', async t => {
  const f = fixture(t)
  for (const args of [
    ['draft', 'weekly-report', '--file', f.file],
    ['draft', 'weekly-report', '--file', f.file, '--scope', 'global'],
    ['draft', 'weekly-report', '--scope', 'project'],
    ['draft', '--file', f.file, '--scope', 'project'],
    ['draft', 'weekly-report', '--file', '--scope', 'project'],
    ['draft', '../outside', '--file', f.file, '--scope', 'project'],
    ['draft', 'weekly-report', '--file', 'missing.md', '--scope', 'project'],
  ]) {
    assert.equal((await f.run(args)).exitCode, 1, JSON.stringify(args))
  }
  for (const content of [
    'No YAML frontmatter',
    markdown().replace('description: Use when turning weekly notes into a company report.', 'description: ""'),
    markdown().replace('description: Use when turning weekly notes into a company report.', 'description: "   "'),
    markdown('   '),
    '---\nname: weekly-report\nname: duplicate\ndescription: test\n---\nSteps',
  ]) {
    writeFileSync(f.file, content)
    assert.equal((await f.run(['draft', 'weekly-report', '--file', f.file, '--scope', 'project'])).exitCode, 1, content)
  }
  assert.equal(f.drafts.list({ scope: 'project', cwd: f.cwd }).length, 0)
  assert.equal(f.drafts.list({ scope: 'personal' }).length, 0)
  assert.equal(existsSync(join(f.cwd, '.rivet', 'skills', '_drafts')), false)
})

test('invalid replacement leaves a valid draft untouched; approval conflict keeps installed content', async t => {
  const f = fixture(t)
  const args = ['draft', 'weekly-report', '--file', f.file, '--scope', 'project']
  const context = { scope: 'project' as const, cwd: f.cwd }
  assert.equal((await f.run(args)).exitCode, 0)
  writeFileSync(f.file, markdown(''))
  assert.equal((await f.run(args)).exitCode, 1)
  assert.equal(f.drafts.read(context, 'weekly-report'), markdown())
  assert.equal((await f.run(['approve', 'weekly-report', '--scope', 'project'])).exitCode, 0)
  writeFileSync(f.file, markdown('Do not overwrite an installed skill'))
  assert.equal((await f.run(args)).exitCode, 0)
  const conflict = await f.run(['approve', 'weekly-report', '--scope', 'project'])
  assert.equal(conflict.exitCode, 1)
  assert.match(conflict.output, /already exists/)
  assert.equal(f.drafts.list(context).length, 1)
  const skill = f.management.list(f.cwd).skills.find(s => s.name === 'weekly-report')!
  assert.equal(f.management.content(skill.skillId, f.cwd), markdown())
})

test('existing HTTP draft endpoints and CLI share the same review workflow', async t => {
  const f = fixture(t)
  const router = createRouter(buildSkillManagementRoutes('fixture-auth', f.management))
  const headers = { authorization: 'Bearer fixture-auth' }
  const save = { scope: 'project', cwd: f.cwd, content: markdown() }
  assert.equal((await router('PUT', '/skill-drafts/weekly-report', save)).status, 401)
  assert.equal((await router('PUT', '/skill-drafts/weekly-report', save, headers)).status, 200)
  assert.equal(JSON.parse((await f.run(['drafts', '--scope', 'project', '--json'])).output)[0].content, markdown())
  writeFileSync(f.file, markdown('Edited via CLI'))
  assert.equal((await f.run(['draft', 'weekly-report', '--file', f.file, '--scope', 'project'])).exitCode, 0)
  const read = await router('GET', `/skill-drafts/weekly-report?scope=project&cwd=${encodeURIComponent(f.cwd)}`, {}, headers)
  assert.equal(read.status, 200)
  assert.match((read.body as { content: string }).content, /Edited via CLI/)
  assert.equal((await router('POST', '/skill-drafts/weekly-report/approve', { scope: 'project', cwd: f.cwd }, headers)).status, 200)
  assert.ok(f.management.list(f.cwd).skills.some(s => s.name === 'weekly-report'))
})
