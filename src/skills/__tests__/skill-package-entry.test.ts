import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
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

test('skill package total size limit is 100MB: 33MB resource loads, 101MB resource is rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-package-limit-'))
  try {
    // 稀疏文件：lstat 报告完整大小，但不实际占磁盘；超限文件在读内容前就抛错，开销极小。
    const makePkg = (name: string, bytes: number) => {
      const pkg = join(root, name)
      mkdirSync(join(pkg, 'assets'), { recursive: true })
      writeFileSync(join(pkg, 'SKILL.md'), '---\nname: big\ndescription: Big\n---\nBody')
      const big = join(pkg, 'assets', 'big.bin')
      writeFileSync(big, '')
      truncateSync(big, bytes)
      return pkg
    }
    // 33MB 在旧 32MB 上限下会被拒，现在应正常读入。
    const ok = readPackage(makePkg('ok', 33 * 1024 * 1024))
    assert.equal(ok.files.some(f => f.path === 'assets/big.bin'), true)
    // 101MB 超过 100MB 上限，应在读内容前抛错。
    assert.throws(() => readPackage(makePkg('over', 101 * 1024 * 1024)), /exceeds resource limits/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
