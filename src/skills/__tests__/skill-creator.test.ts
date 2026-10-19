import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SkillRegistry, registerBuiltinSkills } from '../skill-loader.js'
import { resolveAppPromptInput } from '../../tui/prompt-input-resolver.js'
import { SKILL_TOOL } from '../../tools/skill.js'
import type { ToolCallParams } from '../../tools/types.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('creation requests discover the built-in without eagerly injecting its instructions', () => {
  const registry = new SkillRegistry()
  registerBuiltinSkills(registry)
  const creator = registry.get('skill-creator')!
  assert.equal(creator.builtIn, true)
  for (const request of ['帮我创建一个写周报的技能', '请编写一个 skill', 'create a reusable reporting skill', 'write a skill', '/skill skill-creator']) {
    assert.ok(registry.match(request).some(s => s.name === creator.name), request)
    assert.match(registry.renderDiscoveryBlock(request)!, /name="skill-creator"/)
  }
  assert.ok(!registry.match('install a skill from GitHub').some(s => s.name === creator.name))
  assert.ok(!registry.renderDiscoveryBlock('创建技能')!.includes('## Understand and confirm'))
})

test('explicit invocation carries the user goal through the existing prompt resolver', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'skill-creator-prompt-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const registry = new SkillRegistry()
  registerBuiltinSkills(registry)
  const result = resolveAppPromptInput('/skill skill-creator 帮我按公司模板写周报', cwd, undefined, undefined, registry)!
  assert.equal(result.skillInvoked, 'skill-creator')
  assert.match(result.prompt, /帮我按公司模板写周报/)
  assert.ok(result.prompt.includes(registry.get('skill-creator')!.body))
})

test('on-demand skill tool loads creation guidance and preserves completion lifecycle', async () => {
  const registry = new SkillRegistry()
  registerBuiltinSkills(registry)
  let invoked: string | undefined
  let completed: string | undefined
  const params = {
    input: { name: 'skill-creator' }, cwd: process.cwd(), toolUseId: 'creator-test', skillRegistry: registry,
    onSkillInvoked: (name: string) => { invoked = name },
    onSkillCompleted: (name: string) => { completed = name },
  } as ToolCallParams
  const result = await SKILL_TOOL.execute(params)
  assert.ok(!result.isError)
  assert.equal(invoked, 'skill-creator')
  assert.match(result.content, /personal or project scope/)
  assert.match(result.content, /description tells the model WHEN/)
  assert.match(result.content, /rivet skills draft <name> --file/)
  assert.match(result.content, /Do not call approve without explicit approval/)
  assert.match(result.content, /NOT been saved or installed/)
  assert.match(result.content, /NEW sessions/)
  await SKILL_TOOL.execute({ ...params, input: { name: 'skill-creator', complete: true } })
  assert.equal(completed, 'skill-creator')
})
