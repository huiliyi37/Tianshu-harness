import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { listInstallableSkills } from '../skill-loader.js'
import { readPackage } from '../skill-package.js'

test('installable skills exclude metadata in project and global roots while preserving dotfiles', () => {
  const root = mkdtempSync(join(tmpdir(), 'installable-metadata-'))
  const cwd = join(root, 'project'), home = join(root, 'home')
  const local = join(cwd, '.claude', 'skills'), global = join(home, '.claude', 'skills')
  const homeMock = mock.method(os, 'homedir', () => home)
  syncBuiltinESMExports()
  const markdown = (name: string) => `---\nname: ${name}\ndescription: ${name} description\n---\nBody.`
  try {
    mkdirSync(local, { recursive: true }); mkdirSync(global, { recursive: true })
    writeFileSync(join(local, 'shared.md'), markdown('shared'))
    writeFileSync(join(local, '.notes.md'), markdown('dot_notes'))
    writeFileSync(join(local, '._shared.md'), markdown('ghost'))
    mkdirSync(join(local, '._ghost-dir')); writeFileSync(join(local, '._ghost-dir', 'SKILL.md'), markdown('ghost_dir'))
    writeFileSync(join(global, 'global-only.md'), markdown('global_only'))
    writeFileSync(join(global, 'shared.md'), markdown('shared_global'))
    writeFileSync(join(global, '._global-only.md'), markdown('ghost_global'))
    mkdirSync(join(cwd, '.rivet', 'skills'), { recursive: true })
    writeFileSync(join(cwd, '.rivet', 'skills', 'shared.md'), markdown('shared'))
    const rows = listInstallableSkills(cwd)
    assert.deepEqual(rows.map(row => row.name).sort(), ['.notes', 'global-only', 'shared'])
    assert.equal(rows.find(row => row.name === 'shared')?.source, 'project-claude')
    assert.equal(rows.find(row => row.name === 'shared')?.description, 'shared description')
    assert.equal(rows.find(row => row.name === 'shared')?.installed, true)
    assert.equal(rows.find(row => row.name === '.notes')?.installed, false)
    assert.equal(rows.find(row => row.name === 'global-only')?.source, 'global-claude')
  } finally {
    homeMock.mock.restore(); syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})

test('package metadata cannot change resources or fingerprint; legal hidden resources still matter', () => {
  const root = mkdtempSync(join(tmpdir(), 'package-metadata-'))
  try {
    mkdirSync(join(root, 'references')); mkdirSync(join(root, '.notes-dir'))
    writeFileSync(join(root, 'SKILL.md'), '---\nname: metadata-proof\ndescription: Real package\n---\nRead [notes](references/.notes.md).')
    writeFileSync(join(root, 'references', '.notes.md'), 'Hidden notes')
    writeFileSync(join(root, '.notes-dir', 'keep.txt'), 'Hidden directory resource')
    const before = readPackage(root)
    writeFileSync(join(root, '._SKILL.md'), 'Companion one')
    writeFileSync(join(root, 'references', '._notes.md'), 'Companion two')
    writeFileSync(join(root, '.DS_Store'), 'Companion three')
    mkdirSync(join(root, '._metadata-directory')); writeFileSync(join(root, '._metadata-directory', 'payload.txt'), 'Companion descendant')
    const after = readPackage(root)
    assert.equal(after.fingerprint, before.fingerprint)
    assert.deepEqual(before.files.map(file => file.path).sort(), ['.notes-dir/keep.txt', 'SKILL.md', 'references/.notes.md'])
    assert.deepEqual(after.files, before.files)
    assert.equal(readPackage(join(root, 'SKILL.md')).fingerprint, before.fingerprint)
    writeFileSync(join(root, 'references', '.notes.md'), 'Changed hidden notes')
    assert.notEqual(readPackage(root).fingerprint, before.fingerprint)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('package metadata filtering preserves rejection of sensitive resources', () => {
  const root = mkdtempSync(join(tmpdir(), 'package-sensitive-guard-'))
  try {
    writeFileSync(join(root, 'SKILL.md'), '---\nname: safe-package\ndescription: Guard fixture\n---\nBody.')
    // Synthetic sentinel only; the package reader must reject its name before reading it.
    writeFileSync(join(root, '.env'), 'synthetic fixture only')
    assert.throws(() => readPackage(root), /Sensitive files cannot be included/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
