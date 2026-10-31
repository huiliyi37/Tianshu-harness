import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProjectRules } from '../rules-loader.js'

// 信任门族（2026-10-07 审计修复）：本文件验「授信项目的规则装载」正常语义；
// 未授信拒绝语义在 src/config/__tests__/project-trust-surface-gates.test.ts 覆盖。
// node:test 文件级进程隔离，此 env 不外泄。
process.env.RIVET_TRUST_PROJECT = '1'

describe('loadProjectRules', () => {
  it('loads .md files from rules directory as project_rule proposals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-rules-'))
    const rulesDir = join(dir, '.rivet', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(join(rulesDir, 'no-force-push.md'), 'Never use git push --force on main branch.')
    writeFileSync(join(rulesDir, 'test-first.md'), 'Always run tests before committing.')

    try {
      const proposals = loadProjectRules(dir)

      assert.equal(proposals.length, 2)
      assert.ok(proposals.every(p => p.kind === 'project_rule'))
      assert.ok(proposals.every(p => p.scope === 'project'))
      assert.ok(proposals.every(p => p.confidence === 1.0))
      assert.ok(proposals.some(p => p.text.includes('Never use git push --force')))
      assert.ok(proposals.some(p => p.text.includes('Always run tests')))
      assert.ok(proposals.every(p => p.tags.includes('project_rule')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns empty array when rules directory does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-norules-'))
    try {
      const proposals = loadProjectRules(dir)
      assert.deepEqual(proposals, [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips non-md files and empty files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-rules-'))
    const rulesDir = join(dir, '.rivet', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(join(rulesDir, 'valid.md'), 'Use TypeScript strict mode.')
    writeFileSync(join(rulesDir, 'readme.txt'), 'This is not a rule.')
    writeFileSync(join(rulesDir, 'empty.md'), '')

    try {
      const proposals = loadProjectRules(dir)
      assert.equal(proposals.length, 1)
      assert.ok(proposals[0]!.text.includes('TypeScript strict mode'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('truncates long rule files to 500 chars', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-rules-'))
    const rulesDir = join(dir, '.rivet', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(join(rulesDir, 'long.md'), 'x'.repeat(1000))

    try {
      const proposals = loadProjectRules(dir)
      assert.ok(proposals[0]!.text.length <= 500)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// 软链逃逸回归（2026-10-31 审计 Finding 1）：readFileSync 跟随软链会把项目外
// 文件读成 confidence 1.0 的 project_rule 注入模型上下文。
describe('loadProjectRules symlink containment', () => {
  /** 项目外目录：与项目目录无关的兄弟 tmp 目录，模拟攻击者放置的机密文件。 */
  function outsideFixture(): { outside: string; secret: string; cleanup: () => void } {
    const outside = mkdtempSync(join(tmpdir(), 'rivet-rules-outside-'))
    const secret = join(outside, 'secret.md')
    writeFileSync(secret, 'OUTSIDE_SECRET_RULE_NEVER_INJECT_THIS.')
    const shared = join(outside, 'shared-rules')
    mkdirSync(shared, { recursive: true })
    writeFileSync(join(shared, 'outside-only.md'), 'OUTSIDE_SHARED_DIR_RULE_NEVER_INJECT_THIS.')
    return { outside, secret, cleanup: () => rmSync(outside, { recursive: true, force: true }) }
  }

  function projectDir(): { dir: string; rulesDir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-rules-'))
    const rulesDir = join(dir, '.rivet', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    return { dir, rulesDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  it('rejects a symlinked .md rule file that resolves outside the project', () => {
    const project = projectDir()
    const outside = outsideFixture()
    try {
      writeFileSync(join(project.rulesDir, 'local.md'), 'LOCAL_RULE_KEPT.')
      symlinkSync(outside.secret, join(project.rulesDir, 'leak.md'))

      const proposals = loadProjectRules(project.dir)

      assert.equal(proposals.length, 1, 'only the regular file may be loaded')
      assert.ok(proposals.some(p => p.text.includes('LOCAL_RULE_KEPT')), 'normal rules still load')
      assert.ok(!proposals.some(p => p.text.includes('OUTSIDE_SECRET')), 'symlinked file content must never enter proposals')
    } finally {
      project.cleanup()
      outside.cleanup()
    }
  })

  it('rejects a rules directory that is itself a symlink to a directory outside the project', () => {
    const project = projectDir()
    const outside = outsideFixture()
    try {
      // 目录级逃逸：整个 .rivet/rules 换成指向项目外的软链
      rmSync(project.rulesDir, { recursive: true, force: true })
      symlinkSync(join(outside.outside, 'shared-rules'), project.rulesDir)

      const proposals = loadProjectRules(project.dir)

      assert.ok(!proposals.some(p => p.text.includes('OUTSIDE_SHARED_DIR')), 'outside dir rules must never enter proposals')
      assert.deepEqual(proposals, [], 'symlinked rules dir must yield no proposals')
    } finally {
      project.cleanup()
      outside.cleanup()
    }
  })

  it('rejects a symlinked file whose real path leaves the project even when the link name looks local', () => {
    const project = projectDir()
    const outside = outsideFixture()
    try {
      // 反向探针：链在项目内、名字无害，但 realpath 在项目外
      symlinkSync(join(outside.outside, 'shared-rules', 'outside-only.md'), join(project.rulesDir, 'README.md'))

      const proposals = loadProjectRules(project.dir)

      assert.deepEqual(proposals, [], 'every candidate must pass the containment check')
    } finally {
      project.cleanup()
      outside.cleanup()
    }
  })

  it('keeps loading normal rule files in a directory with no symlinks', () => {
    const project = projectDir()
    try {
      writeFileSync(join(project.rulesDir, 'a.md'), 'RULE_A.')
      writeFileSync(join(project.rulesDir, 'b.md'), 'RULE_B.')

      const proposals = loadProjectRules(project.dir)

      assert.equal(proposals.length, 2, 'containment check must not break the normal path')
      assert.deepEqual(proposals.map(p => p.text).sort(), ['RULE_A.', 'RULE_B.'])
    } finally {
      project.cleanup()
    }
  })
})
