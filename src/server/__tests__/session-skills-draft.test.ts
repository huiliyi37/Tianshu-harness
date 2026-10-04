import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import { resolveAppPromptInput, resolveBareSkillPrompt } from '../../tui/prompt-input-resolver.js'
import { resolveChildEntry } from '../../agent/worker-process/parent.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class MockAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  runPrompts: string[] = []
  enabledTools: string[] = []
  run(p: string, cb: AgentCallbacks) {
    this.runPrompts.push(p)
    this.callbacks = cb
    return Promise.resolve()
  }
  abort() {}
  enableTool(name: string) {
    this.enabledTools.push(name)
    return { status: 'mounted', cacheImpact: 'none' } as const
  }
  switchModel(m: string) { return m }
  listArtifacts() { return [] }
  readArtifact() { return Promise.resolve(null) }
  getMessages() { return [] }
  replaceMessages() {}
  rewindToMessages() {}
}

function createTestEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'skills-draft-test-'))
  const skillsDir = join(dir, '.rivet', 'skills')
  mkdirSync(skillsDir, { recursive: true })

  writeFileSync(
    join(skillsDir, 'project-test-skill.md'),
    `---
name: project-test-skill
description: A custom project skill for draft testing
triggers:
  - test skill
---
# Custom Skill Body
Do something useful.`,
    'utf-8',
  )

  const agents: MockAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new MockAgent()
      agents.push(a)
      return a
    },
    defaultCwd: dir,
  })

  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { dir, manager, agents, router }
}

test('resolveAppPromptInput & resolveBareSkillPrompt load project skills for cwd', () => {
  const { dir } = createTestEnv()
  try {
    const bare = resolveBareSkillPrompt('/project-test-skill', dir)
    assert.ok(bare, 'should resolve bare skill prompt from cwd')
    assert.match(bare, /\[Skill loaded: project-test-skill\]/)
    assert.match(bare, /Custom Skill Body/)

    const appPrompt = resolveAppPromptInput('/project-test-skill run my task', dir)
    assert.ok(appPrompt, 'should resolve app prompt input')
    assert.match(appPrompt.prompt, /\[Skill loaded: project-test-skill\]/)
    assert.match(appPrompt.prompt, /User task: run my task/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GET /skills and GET /sessions/:draft/skills return project skills before session creation', async () => {
  const { dir, router } = createTestEnv()
  try {
    // 1. Root GET /skills
    const rootRes = await router('GET', '/skills', {}, AUTH)
    assert.equal(rootRes.status, 200)
    const rootBody = rootRes.body as { skills: Array<{ name: string }> }
    assert.ok(rootBody.skills.some((s) => s.name === 'project-test-skill'))

    // 2. Draft / new / default session IDs return skills
    for (const draftId of ['draft', 'new', 'default']) {
      const draftRes = await router('GET', `/sessions/${draftId}/skills`, {}, AUTH)
      assert.equal(draftRes.status, 200, `GET /sessions/${draftId}/skills should succeed`)
      const draftBody = draftRes.body as { skills: Array<{ name: string }> }
      assert.ok(draftBody.skills.some((s) => s.name === 'project-test-skill'))
    }

    // 3. Non-existent non-draft session still returns 404
    const ghostRes = await router('GET', '/sessions/ghost/skills', {}, AUTH)
    assert.equal(ghostRes.status, 404)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /sessions resolves slash command and expands project skills', async () => {
  const { dir, router, agents } = createTestEnv()
  try {
    // Palette slash command not mappable to agent prompt returns 400
    const forkRes = await router('POST', '/sessions', { cwd: dir, prompt: '/fork test' }, AUTH)
    assert.equal(forkRes.status, 400)

    // Valid slash command for a project skill
    const createRes = await router('POST', '/sessions', { cwd: dir, prompt: '/project-test-skill execute plan' }, AUTH)
    assert.equal(createRes.status, 201)

    assert.equal(agents.length, 1)
    assert.equal(agents[0]!.runPrompts.length, 1)
    const prompt = agents[0]!.runPrompts[0]!
    assert.match(prompt, /\[Skill loaded: project-test-skill\]/)
    assert.match(prompt, /User task: execute plan/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveChildEntry resolves child script in dev or bundled environment', () => {
  const entry = resolveChildEntry()
  assert.ok(entry, 'resolveChildEntry must return entry')
  assert.match(entry.script, /child\.(ts|js)$/)
})
