/**
 * switchAgentSession — 运行时会话身份切换的确定性分支测试。
 *
 * 仅覆盖 createAgentRuntime 之前可确定性断言的分支(已在目标会话 / 跨 cwd 拒绝)。
 * 成功路径会整体重建 AgentLoop(重型依赖,与 switchAgentRuntime 同构),由真终端手验覆盖。
 */

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { switchAgentSession, resolveProviderForModel } from '../bootstrap.js'
import type { BootstrapContext } from '../bootstrap.js'
import { SessionPersist } from '../agent/session-persist.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rivet-switch-sess-'))
  process.env.RIVET_SESSION_DIR = dir
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RIVET_SESSION_DIR
  delete process.env.RIVET_TEST_GLM_KEY
})

test('目标会话等于当前会话 → 拒绝,不重建', () => {
  const ctx = { sessionId: 'same-id', cwd: '/proj' } as unknown as BootstrapContext
  const res = switchAgentSession(ctx, 'same-id')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /已经在该会话/)
})

test('跨 cwd 的会话被拒绝载入', () => {
  const target = new SessionPersist('other-cwd-sess', dir)
  target.initMetadata({ cwd: '/some/other/project' })

  const ctx = { sessionId: 'current-id', cwd: '/proj/here' } as unknown as BootstrapContext
  const res = switchAgentSession(ctx, 'other-cwd-sess')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /其他工作目录/)
})

// ── resume 原模型恢复（2026-07-25 缓存亲和硬契约）──────────────────
// fail-closed 判定在 createAgentRuntime 之前，可确定性断言。

const baseProviders = {
  deepseek: {
    name: 'deepseek',
    models: [{ id: 'ds-v4', alias: 'v4', contextWindow: 1000000 }],
    apiKey: 'key-ds',
  },
  glm: {
    name: 'glm',
    models: [{ id: 'glm-5' }],
    apiKeyEnv: 'RIVET_TEST_GLM_KEY',
  },
}

function mkCtx(over: Record<string, unknown> = {}) {
  return {
    sessionId: 'current-id',
    cwd: '/proj/here',
    provider: baseProviders.deepseek,
    apiKey: 'key-ds',
    auth: undefined,
    config: { provider: { providers: baseProviders }, agent: {} },
    ...over,
  } as unknown as BootstrapContext
}

test('原模型不可用且无兜底 → fail-closed 拒绝续跑', () => {
  const target = new SessionPersist('resume-ghost-model', dir)
  target.initMetadata({ cwd: '/proj/here', model: 'ghost-model-x' })

  const res = switchAgentSession(mkCtx(), 'resume-ghost-model')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /ghost-model-x/)
  assert.match(res.error ?? '', /不可用/)
})

test('原模型不可用 + 兜底模型也不可用 → 同样 fail-closed', () => {
  const target = new SessionPersist('resume-ghost-both', dir)
  target.initMetadata({ cwd: '/proj/here', model: 'ghost-model-x' })

  const ctx = mkCtx({ config: { provider: { providers: baseProviders }, agent: { resumeFallbackModel: 'ghost-y' } } })
  const res = switchAgentSession(ctx, 'resume-ghost-both')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /不可用/)
})

// ── resolveProviderForModel：跨 provider 模型 + 凭证解析 ──

test('resolveProviderForModel：同 provider 命中（alias → 规范 id，凭证不动）', () => {
  const ctx = mkCtx()
  const r = resolveProviderForModel(ctx, 'v4')
  assert.ok(r && !('error' in r))
  if (!r || 'error' in r) return
  assert.equal(r.modelId, 'ds-v4')
  assert.equal(r.alias, 'v4')
  assert.equal(r.providerName, 'deepseek')
  assert.equal(r.apiKey, 'key-ds')
  assert.equal(r.provider, baseProviders.deepseek)
  assert.equal(r.contextWindow, 1000000)
})

test('resolveProviderForModel：解析 provider:modelId 前缀（2026-09-08 假阴性回归）', () => {
  const ctx = mkCtx()
  const r = resolveProviderForModel(ctx, 'deepseek:v4')
  assert.ok(r && !('error' in r))
  if (!r || 'error' in r) return
  assert.equal(r.modelId, 'ds-v4')
  assert.equal(r.providerName, 'deepseek')
  assert.equal(r.apiKey, 'key-ds')
})

test('resolveProviderForModel：跨 provider 命中（provider/key 摆正到目标）', () => {
  process.env.RIVET_TEST_GLM_KEY = 'k-glm'
  const ctx = mkCtx()
  const r = resolveProviderForModel(ctx, 'glm-5')
  assert.ok(r && !('error' in r))
  if (!r || 'error' in r) return
  assert.equal(r.providerName, 'glm')
  assert.equal(r.apiKey, 'k-glm')
  assert.equal(r.provider, baseProviders.glm)
})

test('resolveProviderForModel：找到模型但无 API key → error', () => {
  const ctx = mkCtx({
    config: {
      provider: {
        providers: { nokey: { name: 'nokey', models: [{ id: 'm1' }], apiKeyEnv: 'RIVET_TEST_MISSING_KEY' } },
      },
      agent: {},
    },
  })
  const r = resolveProviderForModel(ctx, 'm1')
  assert.ok(r && 'error' in r)
})

test('resolveProviderForModel：模型不存在 → null', () => {
  assert.equal(resolveProviderForModel(mkCtx(), 'no-such-model'), null)
})
