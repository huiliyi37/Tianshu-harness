import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPackage, scanPackages, skillPackagePath } from '../skill-package.js'
import { SkillManagement } from '../skill-management.js'
import { sessionSkillSnapshot } from '../session-skill-snapshot.js'

test('SKILL.md resolves to its package on Windows and POSIX; flat markdown stays flat', () => {
  assert.equal(skillPackagePath('C:\\Users\\user\\.agents\\skills\\recipes\\SKILL.md'), 'C:\\Users\\user\\.agents\\skills\\recipes')
  assert.equal(skillPackagePath('/home/user/.agents/skills/recipes/SKILL.md'), '/home/user/.agents/skills/recipes')
  assert.equal(skillPackagePath('C:\\Users\\user\\.rivet\\skills\\recipes.md'), 'C:\\Users\\user\\.rivet\\skills\\recipes.md')
})

test('directory and SKILL.md entry preserve references without duplicate scan or broken session snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-package-entry-'))
  const home = join(root, 'home'), external = join(root, 'external'), cwd = join(root, 'project')
  const skills = join(external, '.agents', 'skills'), pkg = join(skills, 'recipes')
  mkdirSync(join(pkg, 'references'), { recursive: true })
  mkdirSync(cwd); mkdirSync(home)
  writeFileSync(join(pkg, 'SKILL.md'), '---\nname: recipes\ndescription: Recipes\n---\nRead [recipes](references/lite-recipes.md).')
  writeFileSync(join(pkg, 'references', 'lite-recipes.md'), 'Full recipe')
  writeFileSync(join(skills, 'flat.md'), '---\nname: flat\ndescription: Flat\n---\nFlat body')
  try {
    const directory = readPackage(pkg), entry = readPackage(join(pkg, 'SKILL.md'))
    assert.deepEqual(entry.files, directory.files)
    assert.equal(entry.fingerprint, directory.fingerprint)
    const scan = scanPackages(skills)
    assert.deepEqual(scan.errors, [])
    assert.equal(scan.packages.filter(p => p.definition.name === 'recipes').length, 1)
    const management = new SkillManagement(home, external), catalog = management.list()
    assert.deepEqual(catalog.errors, [])
    assert.equal(catalog.skills.filter(s => s.name === 'recipes').length, 1)
    const registry = sessionSkillSnapshot(cwd, undefined, management)
    assert.equal(registry.get('recipes')?.skillDir, pkg)
    assert.deepEqual(registry.get('recipes')?.files, [{ path: 'references/lite-recipes.md', kind: 'file' }])
    assert.equal(registry.get('flat')?.body, 'Flat body')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('readPackage skips rebuildable Python bytecode caches but keeps real resources', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-package-pyc-'))
  const pkg = join(root, 'py')
  mkdirSync(join(pkg, 'scripts', '__pycache__'), { recursive: true })
  writeFileSync(join(pkg, 'SKILL.md'), '---\nname: py\ndescription: Py\n---\nBody')
  writeFileSync(join(pkg, 'scripts', 'run.py'), 'print(1)')
  writeFileSync(join(pkg, 'scripts', '__pycache__', 'run.cpython-312.pyc'), 'bytecode')
  writeFileSync(join(pkg, 'scripts', 'stray.pyc'), 'bytecode')
  try {
    assert.deepEqual(readPackage(pkg).files.map(f => f.path), ['SKILL.md', 'scripts/run.py'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
