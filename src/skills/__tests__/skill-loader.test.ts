import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { SkillRegistry, parseSkillMarkdown, listSkillFiles, importSkillsIntoRivet, listInstallableSkills, countInstalledSkills, seedBundledSkillsFrom, loadProjectSkills, writeSkill, readSkillContent, uninstallSkill, retireMatchingSkillCopies, skillRegistry } from '../skill-loader.js'
import { readFileSync } from 'node:fs'
import { validatePathSafe } from '../../tools/path-validate.js'

describe('skill-loader', () => {
  it('parses frontmatter and triggers', () => {
    const content = `---
name: tdd
description: Test-driven development workflow
triggers: [TDD, test-first]
---

Follow red-green-refactor.`
    const skill = parseSkillMarkdown(content, 'tdd.md')
    assert.equal(skill.name, 'tdd')
    assert.equal(skill.triggers.length, 2)
    assert.ok(skill.triggers.some(t => t.test('use TDD here')))
  })

  it('parses CRLF line endings and UTF-8 BOM (Windows desktop)', () => {
    // Windows 桌面版：git autocrlf 检出 / 记事本保存的技能文件带 CRLF 和 BOM，
    // LF-only 的 frontmatter regex 曾让 .rivet/skills/ 全部报
    // "missing YAML frontmatter"。
    const lf = `---
name: win-skill
description: works on windows
---

Body line.`
    const crlf = lf.replace(/\n/g, '\r\n')
    const skill = parseSkillMarkdown('\uFEFF' + crlf, 'win-skill.md')
    assert.equal(skill.name, 'win-skill')
    assert.equal(skill.description, 'works on windows')
    assert.equal(skill.body, 'Body line.')
  })

  it('loadProjectSkills reports errors for a malformed .rivet/skills entry', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-loadproj-'))
    const broken = join(cwd, '.rivet', 'skills', 'broken')
    mkdirSync(broken, { recursive: true })
    // No YAML frontmatter → parseSkillMarkdown throws → captured in errors[].
    writeFileSync(join(broken, 'SKILL.md'), 'Just prose, no frontmatter.')

    const { loaded, errors } = loadProjectSkills(cwd)
    assert.ok(errors.some((e) => e.includes('broken')), `errors should mention broken: ${JSON.stringify(errors)}`)
    assert.ok(!loaded.includes('broken'), 'malformed skill must not be reported as loaded')
  })

  it('loads skills from directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-skills-'))
    writeFileSync(join(dir, 'review.md'), `---
name: review
description: Code review skill
triggers: ["review", "审查"]
---

Review carefully.`, 'utf-8')

    const reg = new SkillRegistry()
    const result = reg.loadFromDirectory(dir)
    assert.deepEqual(result.loaded, ['review'])
    assert.ok(reg.match('please review this code').length >= 1)
  })

  it('loads directory skills alongside flat skills, recording skillDir', () => {
    const root = mkdtempSync(join(tmpdir(), 'rivet-skills-dir-'))
    // flat skill — no skillDir
    writeFileSync(join(root, 'flat.md'), `---
name: flat
description: flat skill
---

Flat body.`, 'utf-8')
    // directory skill with sub-files — skillDir recorded
    const myDir = join(root, 'myskill')
    mkdirSync(join(myDir, 'references'), { recursive: true })
    mkdirSync(join(myDir, 'scripts'), { recursive: true })
    writeFileSync(join(myDir, 'SKILL.md'), `---
description: a directory skill
---

Router body.`, 'utf-8')
    writeFileSync(join(myDir, 'references', 'a.md'), 'ref a', 'utf-8')
    writeFileSync(join(myDir, 'scripts', 'run.py'), 'print(1)', 'utf-8')

    const reg = new SkillRegistry()
    const res = reg.loadFromDirectory(root)
    assert.ok(res.loaded.includes('flat'))
    assert.ok(res.loaded.includes('myskill'))

    const flat = reg.get('flat')!
    assert.equal(flat.skillDir, undefined)

    const dirSkill = reg.get('myskill')!
    assert.equal(dirSkill.skillDir, myDir)
    assert.equal(dirSkill.body, 'Router body.')
    assert.equal(dirSkill.description, 'a directory skill')
  })

  it('listSkillFiles enumerates sub-files but excludes SKILL.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'rivet-skill-files-'))
    const myDir = join(root, 'pdf')
    mkdirSync(join(myDir, 'references'), { recursive: true })
    mkdirSync(join(myDir, 'scripts'), { recursive: true })
    writeFileSync(join(myDir, 'SKILL.md'), '---\ndescription: x\n---\n\nbody', 'utf-8')
    writeFileSync(join(myDir, 'references', 'a.md'), 'a', 'utf-8')
    writeFileSync(join(myDir, 'scripts', 'run.py'), 'x', 'utf-8')

    const files = listSkillFiles(myDir)
    const paths = files.map(f => f.path)
    assert.ok(paths.includes('references/'))
    assert.ok(paths.includes('references/a.md'))
    assert.ok(paths.includes('scripts/run.py'))
    assert.ok(!paths.includes('SKILL.md'))
  })

  it('importSkillsIntoRivet copies a project .claude skill into .rivet/skills (idempotent)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-import-'))
    const srcDir = join(cwd, '.claude', 'skills', 'foo')
    mkdirSync(join(srcDir, 'references'), { recursive: true })
    writeFileSync(join(srcDir, 'SKILL.md'), '---\ndescription: foo\n---\n\nbody', 'utf-8')
    writeFileSync(join(srcDir, 'references', 'r.md'), 'r', 'utf-8')

    const res = importSkillsIntoRivet(cwd, ['foo'])
    assert.deepEqual(res.copied, ['foo'])
    assert.deepEqual(res.skipped, [])
    assert.ok(existsSync(join(cwd, '.rivet', 'skills', 'foo', 'SKILL.md')))
    assert.ok(existsSync(join(cwd, '.rivet', 'skills', 'foo', 'references', 'r.md')))

    // second run is a no-op (does not overwrite local copy)
    const again = importSkillsIntoRivet(cwd, ['foo'])
    assert.deepEqual(again.copied, [])
    assert.deepEqual(again.skipped, ['foo'])
  })

  it('importSkillsIntoRivet reports missing skills as errors', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-import-miss-'))
    const res = importSkillsIntoRivet(cwd, ['nope'])
    assert.deepEqual(res.copied, [])
    assert.equal(res.errors.length, 1)
    assert.match(res.errors[0]!, /nope: not found/)
  })

  it('listInstallableSkills enumerates project .claude candidates and flags installed', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-installable-'))
    // Two project .claude skills; one is already copied into .rivet/skills.
    const mkSkill = (root: string, name: string, desc: string) => {
      const dir = join(root, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\nbody`, 'utf-8')
    }
    mkSkill(join(cwd, '.claude', 'skills'), 'alpha', 'alpha skill')
    mkSkill(join(cwd, '.claude', 'skills'), 'beta', 'beta skill')
    // A directory entry without SKILL.md must be ignored.
    mkdirSync(join(cwd, '.claude', 'skills', 'not-a-skill'), { recursive: true })
    // beta is already installed under .rivet/skills.
    mkSkill(join(cwd, '.rivet', 'skills'), 'beta', 'beta skill')

    const list = listInstallableSkills(cwd)
    const alpha = list.find((s) => s.name === 'alpha')
    const beta = list.find((s) => s.name === 'beta')
    assert.ok(alpha, 'alpha should be listed')
    assert.equal(alpha!.source, 'project-claude')
    assert.equal(alpha!.description, 'alpha skill')
    assert.equal(alpha!.installed, false)
    assert.equal(beta!.installed, true)
    assert.equal(list.find((s) => s.name === 'not-a-skill'), undefined)
  })

  it('countInstalledSkills counts dir + flat skills under .rivet/skills', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-count-'))
    assert.equal(countInstalledSkills(cwd), 0) // missing dir → 0
    const rivet = join(cwd, '.rivet', 'skills')
    // directory skill with SKILL.md
    mkdirSync(join(rivet, 'dir-skill'), { recursive: true })
    writeFileSync(join(rivet, 'dir-skill', 'SKILL.md'), '---\nname: dir-skill\n---\nbody', 'utf-8')
    // flat skill
    writeFileSync(join(rivet, 'flat.md'), '---\nname: flat\n---\nbody', 'utf-8')
    // directory WITHOUT SKILL.md → not counted
    mkdirSync(join(rivet, 'empty-dir'), { recursive: true })
    assert.equal(countInstalledSkills(cwd), 2)
  })

  it('Tier-3 sub-files of a .rivet/skills directory skill are readable (path boundary)', () => {
    // A directory skill lives under cwd/.rivet/skills — its sub-files must pass
    // the read boundary so the model can actually open what <skill-files> lists.
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-tier3-'))
    const skillDir = join(cwd, '.rivet', 'skills', 'pdf')
    mkdirSync(join(skillDir, 'references'), { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\ndescription: x\n---\n\nbody', 'utf-8')
    writeFileSync(join(skillDir, 'references', 'api.md'), 'api', 'utf-8')

    const reg = new SkillRegistry()
    reg.loadFromDirectory(join(cwd, '.rivet', 'skills'))
    const def = reg.get('pdf')!
    const sub = join(def.skillDir!, 'references', 'api.md')

    // both absolute and as the model would receive it from <skill-files>
    assert.equal(validatePathSafe(cwd, sub, 'read').ok, true)
    // boundary still bites for escapes
    assert.equal(validatePathSafe(cwd, '../../etc/passwd', 'read').ok, false)
  })

  it('seeds bundled skills (dir + flat + sub-files) into .rivet/skills', () => {
    const src = mkdtempSync(join(tmpdir(), 'rivet-bundled-'))
    // directory skill with a sub-file
    mkdirSync(join(src, 'brainstorming'), { recursive: true })
    writeFileSync(join(src, 'brainstorming', 'SKILL.md'), '---\ndescription: bs\n---\nbody', 'utf-8')
    writeFileSync(join(src, 'brainstorming', 'helper.md'), 'helper ref', 'utf-8')
    // flat skill
    writeFileSync(join(src, 'research-spec.md'), '---\nname: research-spec\ndescription: rs\n---\nbody', 'utf-8')

    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    const seeded = seedBundledSkillsFrom(src, cwd).sort()
    assert.deepEqual(seeded, ['brainstorming', 'research-spec'])

    const skillsDir = join(cwd, '.rivet', 'skills')
    // dir skill + its sub-file land inside the workspace (model-readable)
    assert.ok(existsSync(join(skillsDir, 'brainstorming', 'SKILL.md')))
    assert.ok(existsSync(join(skillsDir, 'brainstorming', 'helper.md')))
    assert.ok(existsSync(join(skillsDir, 'research-spec.md')))
  })

  it('seed is idempotent — existing project skills are not overwritten', () => {
    const src = mkdtempSync(join(tmpdir(), 'rivet-bundled-'))
    mkdirSync(join(src, 'brainstorming'), { recursive: true })
    writeFileSync(join(src, 'brainstorming', 'SKILL.md'), '---\ndescription: bundled\n---\nBUNDLED', 'utf-8')
    writeFileSync(join(src, 'research-spec.md'), '---\nname: research-spec\ndescription: bundled\n---\nBUNDLED', 'utf-8')

    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    const skillsDir = join(cwd, '.rivet', 'skills')
    // project already customized both (dir form + flat form)
    mkdirSync(join(skillsDir, 'brainstorming'), { recursive: true })
    writeFileSync(join(skillsDir, 'brainstorming', 'SKILL.md'), 'PROJECT', 'utf-8')
    writeFileSync(join(skillsDir, 'research-spec.md'), 'PROJECT', 'utf-8')

    const seeded = seedBundledSkillsFrom(src, cwd)
    assert.deepEqual(seeded, [])
    assert.equal(readFileSync(join(skillsDir, 'brainstorming', 'SKILL.md'), 'utf-8'), 'PROJECT')
    assert.equal(readFileSync(join(skillsDir, 'research-spec.md'), 'utf-8'), 'PROJECT')
  })

  it('seed returns [] when source dir is missing', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    assert.deepEqual(seedBundledSkillsFrom(join(cwd, 'nope'), cwd), [])
  })

  // ── Retired bundled skill cleanup ─────────────────────────────────

  const sha = (content: string) => createHash('sha256').update(content).digest('hex')

  it('retires dir-shaped copy when content matches the repo version', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-retire-'))
    const skillsDir = join(cwd, '.rivet', 'skills')
    mkdirSync(join(skillsDir, 'writing-plans'), { recursive: true })
    writeFileSync(join(skillsDir, 'writing-plans', 'SKILL.md'), 'REPO', 'utf-8')

    const removed = retireMatchingSkillCopies(cwd, [{ name: 'writing-plans', sha256: sha('REPO') }])
    assert.deepEqual(removed, ['writing-plans'])
    assert.ok(!existsSync(join(skillsDir, 'writing-plans')))
  })

  it('keeps user-modified copy when content differs from the repo version', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-retire-'))
    const skillsDir = join(cwd, '.rivet', 'skills')
    mkdirSync(join(skillsDir, 'writing-plans'), { recursive: true })
    writeFileSync(join(skillsDir, 'writing-plans', 'SKILL.md'), 'CUSTOMIZED', 'utf-8')

    const removed = retireMatchingSkillCopies(cwd, [{ name: 'writing-plans', sha256: sha('REPO') }])
    assert.deepEqual(removed, [])
    assert.ok(existsSync(join(skillsDir, 'writing-plans', 'SKILL.md')))
    assert.equal(readFileSync(join(skillsDir, 'writing-plans', 'SKILL.md'), 'utf-8'), 'CUSTOMIZED')
  })

  it('retires flat copy (<name>.md) on hash match', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-retire-'))
    const skillsDir = join(cwd, '.rivet', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(skillsDir, 'research-spec.md'), 'REPO', 'utf-8')

    const removed = retireMatchingSkillCopies(cwd, [{ name: 'research-spec', sha256: sha('REPO') }])
    assert.deepEqual(removed, ['research-spec'])
    assert.ok(!existsSync(join(skillsDir, 'research-spec.md')))
  })

  it('no copy present → nothing removed', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-retire-'))
    const removed = retireMatchingSkillCopies(cwd, [{ name: 'writing-plans', sha256: sha('REPO') }])
    assert.deepEqual(removed, [])
  })

  // ── Desktop CRUD primitives ──────────────────────────────────────

  it('writeSkill creates a directory skill and validates frontmatter', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-write-'))
    const content = `---
name: my-skill
description: created from the desktop editor
---

Do the thing.`
    const { path } = writeSkill('my-skill', content, cwd, 'project')
    assert.ok(path.endsWith(join('.rivet', 'skills', 'my-skill', 'SKILL.md')))
    assert.ok(existsSync(path))
    assert.equal(readFileSync(path, 'utf-8'), content)
  })

  it('writeSkill overwrites an existing skill (edit semantics, unlike install)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-write-edit-'))
    const dir = join(cwd, '.rivet', 'skills', 'editskill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: editskill\ndescription: v1\n---\n\nbody v1', 'utf-8')

    const updated = `---
name: editskill
description: v2
---

body v2`
    writeSkill('editskill', updated, cwd, 'project')
    assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf-8'), updated)
  })

  it('writeSkill throws on malformed frontmatter (route layer surfaces as 400)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-write-bad-'))
    assert.throws(
      () => writeSkill('bad', 'no frontmatter here', cwd, 'project'),
      /missing YAML frontmatter/,
    )
    // nothing was written
    assert.ok(!existsSync(join(cwd, '.rivet', 'skills', 'bad')))
  })

  it('uninstallSkill removes a directory skill and reports wasDir', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-uninstall-dir-'))
    const dir = join(cwd, '.rivet', 'skills', 'goner')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: goner\n---\nbody', 'utf-8')

    const res = uninstallSkill('goner', cwd)
    assert.equal(res.removed, true)
    assert.equal(res.wasDir, true)
    assert.ok(!existsSync(dir))
  })

  it('uninstallSkill removes a flat skill', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-uninstall-flat-'))
    const skillsDir = join(cwd, '.rivet', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(skillsDir, 'flat.md'), '---\nname: flat\n---\nbody', 'utf-8')

    const res = uninstallSkill('flat', cwd)
    assert.equal(res.removed, true)
    assert.equal(res.wasDir, false)
    assert.ok(!existsSync(join(skillsDir, 'flat.md')))
  })

  it('uninstallSkill returns removed:false for a missing/global/builtin skill', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-uninstall-miss-'))
    const res = uninstallSkill('never-existed', cwd)
    assert.equal(res.removed, false)
    assert.equal(res.wasDir, false)
  })

  it('project skill overrides a same-named user-level (global-rivet) skill by load order', () => {
    // loadFromDirectory registers later calls last, so "project wins" is just
    // load ORDER. Verify with a standalone registry to avoid polluting the
    // process-wide singleton.
    const globalDir = mkdtempSync(join(tmpdir(), 'rivet-prio-global-'))
    const projectDir = mkdtempSync(join(tmpdir(), 'rivet-prio-project-'))
    writeFileSync(join(globalDir, 'shared.md'), '---\nname: shared\ndescription: GLOBAL\n---\nglobal body', 'utf-8')
    writeFileSync(join(projectDir, 'shared.md'), '---\nname: shared\ndescription: PROJECT\n---\nproject body', 'utf-8')

    const reg = new SkillRegistry()
    reg.loadFromDirectory(globalDir, 'global-rivet')
    reg.loadFromDirectory(projectDir, 'rivet')
    const skill = reg.get('shared')!
    assert.equal(skill.description, 'PROJECT')
    assert.equal(skill.source, 'rivet')
  })

  // ── .agents/skills 自动扫描（issue #100，2026-09-12） ──

  const writeAgentSkill = (root: string, name: string, body: string) => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${body}\n---\n\n${body}\n`, 'utf-8')
  }

  it('项目级 .agents/skills 自动装载（source=project-agents，目录形态保留 skillDir）', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-agents-proj-'))
    writeAgentSkill(join(cwd, '.agents', 'skills'), 'agents-proj-probe', 'from project agents dir')

    const { loaded } = loadProjectSkills(cwd)
    assert.ok(loaded.includes('agents-proj-probe'), `loaded should include agents skill: ${JSON.stringify(loaded)}`)
    const skill = skillRegistry.get('agents-proj-probe')!
    assert.equal(skill.source, 'project-agents')
    assert.equal(skill.skillDir, join(cwd, '.agents', 'skills', 'agents-proj-probe'), '目录形态保留子文件按需读取')
  })

  it('五层优先级链：global-agents < global-rivet < project-agents < project-rivet', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-agents-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-agents-cwd-'))
    // 同名技能放满四层——最终赢家必须是项目 .rivet
    writeAgentSkill(join(home, '.agents', 'skills'), 'chain-skill', 'global-agents')
    writeAgentSkill(join(home, '.rivet', 'skills'), 'chain-skill', 'global-rivet')
    writeAgentSkill(join(cwd, '.agents', 'skills'), 'chain-skill', 'project-agents')
    writeAgentSkill(join(cwd, '.rivet', 'skills'), 'chain-skill', 'project-rivet')
    // 只在两个 agents 槽位的技能——项目 .agents 赢用户 .agents
    writeAgentSkill(join(home, '.agents', 'skills'), 'eco-skill', 'global-agents')
    writeAgentSkill(join(cwd, '.agents', 'skills'), 'eco-skill', 'project-agents')
    // 只在用户 .agents 的技能——装载且来源正确
    writeAgentSkill(join(home, '.agents', 'skills'), 'home-only-skill', 'global-agents')

    loadProjectSkills(cwd, { homeDir: home })
    assert.equal(skillRegistry.get('chain-skill')!.bodyPath, join(cwd, '.rivet', 'skills', 'chain-skill', 'SKILL.md'))
    assert.equal(skillRegistry.get('chain-skill')!.source, 'rivet')
    assert.equal(skillRegistry.get('eco-skill')!.bodyPath, join(cwd, '.agents', 'skills', 'eco-skill', 'SKILL.md'))
    assert.equal(skillRegistry.get('eco-skill')!.source, 'project-agents')
    assert.equal(skillRegistry.get('home-only-skill')!.source, 'global-agents')
  })

  it('agents 技能进入 discovery 块且渲染确定（字节稳定=缓存安全）', () => {
    const reg = new SkillRegistry()
    reg.register({ name: 'agents-zeta', description: 'z', triggers: [], body: 'b', source: 'global-agents' })
    reg.register({ name: 'agents-alpha', description: 'a', triggers: [], body: 'b', source: 'project-agents' })
    const b1 = reg.renderDiscoveryBlock()
    const b2 = reg.renderDiscoveryBlock()
    assert.ok(b1 && b1.includes('agents-alpha') && b1.includes('agents-zeta'))
    assert.equal(b1, b2, '同注册表两次渲染必须字节一致（冻结锚之外的 appendix 稳定性）')
    assert.ok(b1!.indexOf('agents-alpha') < b1!.indexOf('agents-zeta'), '按 name 排序，与目录序无关')
  })

})
