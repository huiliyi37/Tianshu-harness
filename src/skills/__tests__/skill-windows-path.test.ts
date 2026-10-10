import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { skillPackagePath } from '../skill-package.js'

describe('Windows path compatibility for SKILL.md (#385)', () => {
  it('skillPackagePath returns dirname on both Windows and POSIX separators', () => {
    assert.equal(skillPackagePath('C:\\Users\\test\\.rivet\\skills\\my-skill\\SKILL.md'), 'C:\\Users\\test\\.rivet\\skills\\my-skill')
    assert.equal(skillPackagePath('/home/test/.rivet/skills/my-skill/SKILL.md'), '/home/test/.rivet/skills/my-skill')
    assert.equal(skillPackagePath('C:\\skills\\flat-skill.md'), 'C:\\skills\\flat-skill.md')
  })

  it('basename correctly matches SKILL.md on Windows paths with backslashes', () => {
    const winPath = 'D:\\projects\\demo\\.agents\\skills\\chart\\SKILL.md'
    assert.equal(basename(winPath), 'SKILL.md')
    assert.equal(winPath.endsWith('/SKILL.md'), false, 'POSIX endsWith fails on Windows backslash paths')
  })
})
