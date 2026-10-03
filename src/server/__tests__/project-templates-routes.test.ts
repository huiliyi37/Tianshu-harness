/**
 * issue #221 —— `/project-templates/*` 的 cwd 必须在册。
 *
 * `POST /project-templates/apply` 会往 cwd 铺 AGENTS.md / .rivet.md 模板。此前
 * cwd 不校验是否属于已注册工作区，任意目录都能被铺上模板（跨项目提示注入投毒）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildProjectTemplatesRoutes } from '../project-templates-routes.js'

const TOKEN = 'project-templates-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

test('未注册工作区的 cwd 一律 403，在册的照常（issue #221）', async () => {
  const known = mkdtempSync(join(tmpdir(), 'rivet-tpl-known-'))
  const outside = mkdtempSync(join(tmpdir(), 'rivet-tpl-outside-'))
  try {
    const router = createRouter(buildProjectTemplatesRoutes(TOKEN, () => [known]))

    const status = await router('GET', `/project-templates/status?cwd=${encodeURIComponent(outside)}`, {}, AUTH)
    assert.equal(status.status, 403, '未注册目录的 status 必须被拒')

    const apply = await router('POST', '/project-templates/apply', { cwd: outside, agentsMode: 'overwrite' }, AUTH)
    assert.equal(apply.status, 403, '未注册目录不得被铺模板')
    assert.ok(!existsSync(join(outside, 'AGENTS.md')), '被拒的 apply 不得留下文件')

    const ok = await router('GET', `/project-templates/status?cwd=${encodeURIComponent(known)}`, {}, AUTH)
    assert.equal(ok.status, 200, '在册工作区照常')
  } finally {
    rmSync(known, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('已注册但在磁盘上不存在的工作区（被删/被移），status 与 apply 均返回 404 且不崩溃', async () => {
  const missing = join(tmpdir(), `rivet-tpl-missing-${Date.now()}`)
  // missing 目录从未创建或已被删除，但属于 knownWorkspaces（如历史会话遗留 cwd）
  const router = createRouter(buildProjectTemplatesRoutes(TOKEN, () => [missing]))

  const status = await router('GET', `/project-templates/status?cwd=${encodeURIComponent(missing)}`, {}, AUTH)
  assert.equal(status.status, 404, '不存在的工作区 status 必须返回 404')
  assert.equal((status.body as { error: string }).error, 'Workspace directory does not exist')

  const apply = await router('POST', '/project-templates/apply', { cwd: missing, agentsMode: 'overwrite' }, AUTH)
  assert.equal(apply.status, 404, '不存在的工作区 apply 必须返回 404，不得抛未捕获 ENOENT 崩溃')
  assert.equal((apply.body as { error: string }).error, 'Workspace directory does not exist')
})

