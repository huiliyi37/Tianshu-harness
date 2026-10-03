import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AGENTS_MD_TEMPLATE,
  RIVET_MD_TEMPLATE,
  hasTemplatesSentinel,
  needsTemplatesInit,
  applyProjectTemplates,
  recordTemplatesDecision,
  readTemplatesSentinel,
} from '../project-templates.js'

/** Fallback temp dir for sandboxed environments where os.tmpdir() is read-only. */
function sandboxTmpDir(): string {
  const sys = tmpdir()
  try {
    mkdtempSync(join(sys, 'probe-'))
    return sys
  } catch {
    const local = join(process.cwd(), '.test-tmp')
    if (!existsSync(local)) mkdirSync(local, { recursive: true })
    return local
  }
}

const tempDirs: string[] = []

function mkEmptyProject(): string {
  const dir = mkdtempSync(join(sandboxTmpDir(), 'project-templates-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('AGENTS_MD_TEMPLATE', () => {
  it('covers universal disciplines (高危命令 / 安全 / 执行纪律)', () => {
    assert.match(AGENTS_MD_TEMPLATE, /高危命令/, 'missing 高危命令 discipline')
    assert.match(AGENTS_MD_TEMPLATE, /Agent 安全保护/, 'missing Agent 安全保护')
    assert.match(AGENTS_MD_TEMPLATE, /通用执行纪律/, 'missing 通用执行纪律')
  })

  it('names the specific dangerous commands that must require confirmation', () => {
    for (const cmd of ['git stash', 'git reset --hard', 'git push -f', 'rm -rf']) {
      assert.ok(AGENTS_MD_TEMPLATE.includes(cmd), `template missing rule for: ${cmd}`)
    }
  })

  it('is between 30 and 120 lines (universal, not the full 天枢 AGENTS.md)', () => {
    const lines = AGENTS_MD_TEMPLATE.split('\n').length
    assert.ok(lines >= 30, `template too short: ${lines} lines`)
    assert.ok(lines <= 120, `template too long: ${lines} lines — keep it universal, not 天枢-specific`)
  })
})

describe('RIVET_MD_TEMPLATE', () => {
  it('is a short project metadata placeholder (under 30 lines)', () => {
    const lines = RIVET_MD_TEMPLATE.split('\n').length
    assert.ok(lines <= 30, `RIVET_MD_TEMPLATE too long: ${lines} lines — should be a thin placeholder`)
    assert.ok(lines >= 5, `RIVET_MD_TEMPLATE too short: ${lines} lines`)
  })

  it('leaves clear placeholders for the project owner to fill', () => {
    assert.match(RIVET_MD_TEMPLATE, /# Project|# 项目|Project Name|项目名称/)
  })
})

describe('needsTemplatesInit', () => {
  it('returns true on a fresh empty project (no files, no sentinel)', () => {
    const cwd = mkEmptyProject()
    assert.equal(needsTemplatesInit(cwd), true)
    assert.equal(hasTemplatesSentinel(cwd), false)
  })

  it('returns false when both .rivet.md and AGENTS.md already exist', () => {
    const cwd = mkEmptyProject()
    writeFileSync(join(cwd, '.rivet.md'), '# existing')
    writeFileSync(join(cwd, 'AGENTS.md'), '# existing')
    assert.equal(needsTemplatesInit(cwd), false)
  })

  it('returns false when only .rivet.md exists (user kept just one)', () => {
    const cwd = mkEmptyProject()
    writeFileSync(join(cwd, '.rivet.md'), '# existing')
    assert.equal(needsTemplatesInit(cwd), false)
  })

  it('returns false when only AGENTS.md exists (user kept just one)', () => {
    const cwd = mkEmptyProject()
    writeFileSync(join(cwd, 'AGENTS.md'), '# existing')
    assert.equal(needsTemplatesInit(cwd), false)
  })

  it('returns false when sentinel already exists (already asked once)', () => {
    const cwd = mkEmptyProject()
    recordTemplatesDecision(cwd, 'declined')
    assert.equal(needsTemplatesInit(cwd), false)
  })

  it('returns false when both sentinel and AGENTS.md exist', () => {
    const cwd = mkEmptyProject()
    writeFileSync(join(cwd, 'AGENTS.md'), '# existing')
    recordTemplatesDecision(cwd, 'created')
    assert.equal(needsTemplatesInit(cwd), false)
  })

  it('returns false when directory does not exist on disk', () => {
    const missing = join(sandboxTmpDir(), `project-templates-missing-${Date.now()}`)
    assert.equal(needsTemplatesInit(missing), false)
  })
})

describe('applyProjectTemplates', () => {
  it('throws descriptive error when directory does not exist on disk', () => {
    const missing = join(sandboxTmpDir(), `project-templates-missing-${Date.now()}`)
    assert.throws(
      () => applyProjectTemplates(missing, { agentsMode: 'overwrite' }),
      /Workspace directory does not exist/,
    )
  })

  it('on empty project, default mode: writes .rivet.md and AGENTS.md', () => {
    const cwd = mkEmptyProject()
    const result = applyProjectTemplates(cwd, { agentsMode: 'overwrite' })
    assert.equal(result.created.includes('.rivet.md'), true)
    assert.equal(result.created.includes('AGENTS.md'), true)
    assert.equal(existsSync(join(cwd, '.rivet.md')), true)
    assert.equal(existsSync(join(cwd, 'AGENTS.md')), true)
    assert.equal(result.skipped.length, 0)
  })

  it('writes the exact template content for .rivet.md', () => {
    const cwd = mkEmptyProject()
    applyProjectTemplates(cwd, { agentsMode: 'overwrite' })
    const written = readFileSync(join(cwd, '.rivet.md'), 'utf-8')
    assert.equal(written, RIVET_MD_TEMPLATE)
  })

  it('writes the exact template content for AGENTS.md in overwrite mode', () => {
    const cwd = mkEmptyProject()
    applyProjectTemplates(cwd, { agentsMode: 'overwrite' })
    const written = readFileSync(join(cwd, 'AGENTS.md'), 'utf-8')
    assert.equal(written, AGENTS_MD_TEMPLATE)
  })

  it('append mode preserves existing AGENTS.md content and appends template', () => {
    const cwd = mkEmptyProject()
    const existing = '# My Custom Rules\n- Use pnpm, not npm\n'
    writeFileSync(join(cwd, 'AGENTS.md'), existing)
    const result = applyProjectTemplates(cwd, { agentsMode: 'append' })
    assert.equal(result.appended.includes('AGENTS.md'), true)
    assert.equal(result.created.includes('AGENTS.md'), false)
    const written = readFileSync(join(cwd, 'AGENTS.md'), 'utf-8')
    assert.ok(written.startsWith(existing), 'existing rules must come first')
    assert.ok(written.includes('高危命令'), 'template content must be appended')
  })

  it('skip mode leaves existing AGENTS.md untouched', () => {
    const cwd = mkEmptyProject()
    const existing = '# Untouched\n'
    writeFileSync(join(cwd, 'AGENTS.md'), existing)
    const result = applyProjectTemplates(cwd, { agentsMode: 'skip' })
    assert.equal(result.skipped.includes('AGENTS.md (already exists)'), true)
    const written = readFileSync(join(cwd, 'AGENTS.md'), 'utf-8')
    assert.equal(written, existing)
  })

  it('appends to existing AGENTS.md even when only one of the two files exists', () => {
    const cwd = mkEmptyProject()
    writeFileSync(join(cwd, 'AGENTS.md'), '# Pre-existing\n')
    const result = applyProjectTemplates(cwd, { agentsMode: 'append' })
    assert.equal(result.created.includes('.rivet.md'), true)
    assert.equal(result.appended.includes('AGENTS.md'), true)
  })

  it('preserves original mtime/ownership of untouched files (skip mode)', () => {
    const cwd = mkEmptyProject()
    writeFileSync(join(cwd, 'AGENTS.md'), '# Keep me\n')
    const beforeStat = statSync(join(cwd, 'AGENTS.md'))
    applyProjectTemplates(cwd, { agentsMode: 'skip' })
    const afterStat = statSync(join(cwd, 'AGENTS.md'))
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, 'skip mode must not touch file mtime')
  })
})

describe('recordTemplatesDecision + readTemplatesSentinel', () => {
  it('persists decision in .rivet/.templates-init-sentinel and reads it back', () => {
    const cwd = mkEmptyProject()
    recordTemplatesDecision(cwd, 'created', { created: ['AGENTS.md', '.rivet.md'], appended: [] })
    const read = readTemplatesSentinel(cwd)
    assert.ok(read, 'sentinel should exist after record')
    assert.equal(read!.decision, 'created')
    assert.deepEqual(read!.created, ['AGENTS.md', '.rivet.md'])
    assert.deepEqual(read!.appended, [])
  })

  it('records declined decision without created files', () => {
    const cwd = mkEmptyProject()
    recordTemplatesDecision(cwd, 'declined')
    const read = readTemplatesSentinel(cwd)
    assert.equal(read!.decision, 'declined')
  })

  it('records skipped (e.g. user typed later / saw banner but did not act)', () => {
    const cwd = mkEmptyProject()
    recordTemplatesDecision(cwd, 'skipped')
    const read = readTemplatesSentinel(cwd)
    assert.equal(read!.decision, 'skipped')
  })

  it('sentinel location is under .rivet/, not project root', () => {
    const cwd = mkEmptyProject()
    recordTemplatesDecision(cwd, 'created')
    assert.equal(existsSync(join(cwd, '.rivet', '.templates-init-sentinel')), true)
    // no sentinel files at project root
    assert.equal(existsSync(join(cwd, '.templates-init-sentinel')), false)
  })

  it('overwrites previous sentinel (only latest decision is remembered)', () => {
    const cwd = mkEmptyProject()
    recordTemplatesDecision(cwd, 'declined')
    recordTemplatesDecision(cwd, 'created', { created: ['.rivet.md'], appended: [] })
    const read = readTemplatesSentinel(cwd)
    assert.equal(read!.decision, 'created')
  })
})
