import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { basename, win32 } from 'node:path'
import { skillPackagePath } from '../skill-package.js'

describe('Windows path compatibility for SKILL.md (#385)', () => {
  it('skillPackagePath returns dirname on both Windows and POSIX separators', () => {
    assert.equal(skillPackagePath('C:\\Users\\test\\.rivet\\skills\\my-skill\\SKILL.md'), 'C:\\Users\\test\\.rivet\\skills\\my-skill')
    assert.equal(skillPackagePath('/home/test/.rivet/skills/my-skill/SKILL.md'), '/home/test/.rivet/skills/my-skill')
    assert.equal(skillPackagePath('C:\\skills\\flat-skill.md'), 'C:\\skills\\flat-skill.md')
  })

  it('SKILL.md 判定须跨平台：POSIX 的 endsWith("/SKILL.md") 在 Windows 反斜杠路径上永不命中', () => {
    const winPath = 'D:\\projects\\demo\\.agents\\skills\\chart\\SKILL.md'
    // win32 命名空间与宿主平台无关——用它断言 Windows 语义，避免「作者机上绿、本机红」。
    assert.equal(win32.basename(winPath), 'SKILL.md')
    assert.equal(basename(winPath) === 'SKILL.md', process.platform === 'win32',
      '原生 basename 只在 Windows 上把 \\ 当分隔符（本断言刻意跟随宿主平台）')
    assert.equal(winPath.endsWith('/SKILL.md'), false, 'POSIX endsWith fails on Windows backslash paths')
    assert.equal(skillPackagePath(winPath), 'D:\\projects\\demo\\.agents\\skills\\chart',
      '唯一真源 skillPackagePath 跨平台可用（skill-import.ts 已改用它）')
  })
})
