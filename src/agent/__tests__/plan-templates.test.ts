import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPlanTemplates, getPlanTemplate, savePlanTemplate, formatTemplateList, parseFrontmatter } from '../plan-templates.js'

// ── parseFrontmatter ───────────────────────────────────────────

test('parseFrontmatter: extracts key-value pairs', () => {
  const { meta, body } = parseFrontmatter('---\ndescription: test\nwaves: 3\n---\n# Plan\n- [ ] task')
  assert.equal(meta.description, 'test')
  assert.equal(meta.waves, '3')
  assert.ok(body.includes('# Plan'))
  assert.ok(body.includes('- [ ] task'))
})

test('parseFrontmatter: no frontmatter returns body as-is', () => {
  const { meta, body } = parseFrontmatter('# Just a plan\n- [ ] task')
  assert.deepEqual(meta, {})
  assert.equal(body, '# Just a plan\n- [ ] task')
})

// ── loadPlanTemplates ──────────────────────────────────────────

test('loadPlanTemplates: returns empty array when dir does not exist', () => {
  const templates = loadPlanTemplates(join(tmpdir(), 'does-not-exist-xyz'))
  assert.equal(templates.length, 0)
})

test('loadPlanTemplates: loads project templates from .rivet/plan-templates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plan-templates-'))
  const tplDir = join(dir, '.rivet', 'plan-templates')
  mkdirSync(tplDir, { recursive: true })
  writeFileSync(join(tplDir, 'standard.md'), '---\ndescription: Standard flow\nwaves: 3\n---\n# Standard\n- [ ] step 1')

  try {
    const templates = loadPlanTemplates(dir)
    assert.equal(templates.length, 1)
    assert.equal(templates[0]!.name, 'standard')
    assert.equal(templates[0]!.description, 'Standard flow')
    assert.equal(templates[0]!.estimatedWaves, 3)
    assert.equal(templates[0]!.source, 'project')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadPlanTemplates: parses recommended profiles from frontmatter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plan-templates-'))
  const tplDir = join(dir, '.rivet', 'plan-templates')
  mkdirSync(tplDir, { recursive: true })
  writeFileSync(join(tplDir, 'audit.md'), '---\nprofiles: patcher, code_scout, adversarial_verifier\n---\n# Audit')

  try {
    const templates = loadPlanTemplates(dir)
    assert.deepEqual(templates[0]!.recommendedProfiles, ['patcher', 'code_scout', 'adversarial_verifier'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── getPlanTemplate ────────────────────────────────────────────

test('getPlanTemplate: returns matching template', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plan-templates-'))
  const tplDir = join(dir, '.rivet', 'plan-templates')
  mkdirSync(tplDir, { recursive: true })
  writeFileSync(join(tplDir, 'my-plan.md'), '# My Plan\n- [ ] do something')

  try {
    const tpl = getPlanTemplate(dir, 'my-plan')
    assert.ok(tpl)
    assert.ok(tpl!.content.includes('do something'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getPlanTemplate: returns null for unknown name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plan-templates-'))
  try {
    assert.equal(getPlanTemplate(dir, 'nonexistent'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── savePlanTemplate ───────────────────────────────────────────

test('savePlanTemplate: creates directory and writes file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plan-templates-'))
  try {
    savePlanTemplate(dir, 'new-tpl', '# New Plan\n- [ ] task', 'A new template')
    const loaded = loadPlanTemplates(dir)
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.name, 'new-tpl')
    assert.equal(loaded[0]!.description, 'A new template')
    assert.ok(loaded[0]!.content.includes('# New Plan'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('savePlanTemplate: overwrites existing template', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plan-templates-'))
  try {
    savePlanTemplate(dir, 'existing', '# V1')
    savePlanTemplate(dir, 'existing', '# V2')
    const tpl = getPlanTemplate(dir, 'existing')
    assert.ok(tpl!.content.includes('V2'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── formatTemplateList ─────────────────────────────────────────

test('formatTemplateList: empty array shows helpful message', () => {
  const text = formatTemplateList([])
  assert.ok(text.includes('No plan templates'))
})

test('formatTemplateList: lists templates with source badge', () => {
  const text = formatTemplateList([
    { name: 'standard', description: 'Standard flow', content: '', source: 'project' as const },
    { name: 'quick', description: 'Quick', content: '', source: 'user' as const, estimatedWaves: 1 },
  ])
  assert.ok(text.includes('standard'))
  assert.ok(text.includes('[project]'))
  assert.ok(text.includes('[user]'))
  assert.ok(text.includes('Standard flow'))
})


test('loadPlanTemplates: excludes metadata in both roots and preserves dotfiles and project overrides', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-metadata-project-'))
  const home = mkdtempSync(join(tmpdir(), 'plan-metadata-home-'))
  const previousHome = process.env.RIVET_HOME
  process.env.RIVET_HOME = home
  try {
    const userDir = join(home, 'plan-templates')
    const projectDir = join(cwd, '.rivet', 'plan-templates')
    mkdirSync(userDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(userDir, 'shared.md'), '---\ndescription: user copy\n---\n# User shared')
    writeFileSync(join(userDir, 'user-only.md'), '# User only')
    writeFileSync(join(userDir, '._user-only.md'), '# Metadata user template')
    writeFileSync(join(projectDir, 'shared.md'), '---\ndescription: project copy\nwaves: 2\nprofiles: patcher, code_scout\n---\n# Project shared')
    writeFileSync(join(projectDir, '.notes.md'), '# Ordinary dotfile template')
    writeFileSync(join(projectDir, '._shared.md'), '# Metadata project template')
    writeFileSync(join(projectDir, '.DS_Store'), 'filesystem metadata')
    const templates = loadPlanTemplates(cwd)
    assert.deepEqual(templates.map(t => t.name), ['.notes', 'shared', 'user-only'])
    const shared = getPlanTemplate(cwd, 'shared')!
    assert.equal(shared.source, 'project')
    assert.equal(shared.description, 'project copy')
    assert.equal(shared.content, '# Project shared')
    assert.equal(shared.estimatedWaves, 2)
    assert.deepEqual(shared.recommendedProfiles, ['patcher', 'code_scout'])
    assert.equal(getPlanTemplate(cwd, 'user-only')?.source, 'user')
    assert.equal(getPlanTemplate(cwd, '.notes')?.content, '# Ordinary dotfile template')
    assert.equal(getPlanTemplate(cwd, '._shared'), null)
    assert.equal(getPlanTemplate(cwd, '._user-only'), null)
  } finally {
    if (previousHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previousHome
    rmSync(cwd, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
