import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildFileContextRoutes, cachedProjectFiles } from '../file-context-routes.js'
const auth = { authorization: 'Bearer file-context-test' }

test('workspace browse/search is authenticated, filtered and sandboxed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'file-context-'))
  const outside = mkdtempSync(join(tmpdir(), 'file-context-outside-'))
  try {
    mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'node_modules')); mkdirSync(join(root, 'ignored'))
    writeFileSync(join(root, '.gitignore'), 'ignored/\n')
    writeFileSync(join(root, 'docs', '需求.md'), 'content')
    writeFileSync(join(root, 'deploy.sh'), 'echo hi')
    writeFileSync(join(root, 'app.min.js'), 'generated')
    writeFileSync(join(root, 'node_modules', 'hidden.md'), 'hidden')
    writeFileSync(join(root, 'ignored', 'hidden.md'), 'hidden')
    // Windows 上 dir symlink 需开发者模式/管理员（普通权限恒 EPERM，与防护逻辑
    // 无关）；junction 无需特权、同样呈报 isSymbolicLink=true，逃逸防护语义等价。
    symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const handler = buildFileContextRoutes('file-context-test', () => [root])['GET /workspace/file-context']!
    assert.equal((await handler(undefined, { cwd: root }, {})).status, 401)
    const browse = await handler(undefined, { cwd: root }, auth)
    assert.equal(browse.status, 200)
    const rows = (browse.body as { items: { path: string }[] }).items
    assert.ok(rows.some(r => r.path === 'docs'))
    assert.ok(rows.some(r => r.path === 'deploy.sh'))
    assert.ok(!rows.some(r => /node_modules|ignored|escape|app.min/.test(r.path)))
    const search = await handler(undefined, { cwd: root, q: '需求' }, auth)
    assert.ok((search.body as { items: { path: string }[] }).items.some(i => i.path === 'docs/需求.md'))
    assert.equal((await handler(undefined, { cwd: root, path: '../' }, auth)).status, 403)
    assert.equal((await handler(undefined, { cwd: root, path: 'escape' }, auth)).status, 403)
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})
test('search reaches files beyond the former 2000-file cap; refresh invalidates cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'file-context-large-'))
  try {
    for (let i = 0; i < 2001; i++) writeFileSync(join(root, `a${String(i).padStart(4, '0')}.md`), '')
    writeFileSync(join(root, 'zz-final.sh'), 'echo marker')
    const handler = buildFileContextRoutes('file-context-test', () => [root])['GET /workspace/file-context']!
    const res = await handler(undefined, { cwd: root, q: 'zz-final.sh' }, auth)
    assert.deepEqual((res.body as { items: unknown[] }).items, [{ path: 'zz-final.sh', kind: 'file' }])
    writeFileSync(join(root, 'new.md'), '')
    assert.equal((await cachedProjectFiles(root)).includes('new.md'), false)
    assert.equal((await cachedProjectFiles(root, true)).includes('new.md'), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('未知工作区 cwd 被 403 拒绝（#221 同族加固）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'file-context-known-'))
  const evil = mkdtempSync(join(tmpdir(), 'file-context-evil-'))
  try {
    writeFileSync(join(root, 'ok.md'), 'ok')
    writeFileSync(join(evil, 'secret.md'), 'secret')
    // 只注册 root 为已知工作区
    const handler = buildFileContextRoutes('file-context-test', () => [root])['GET /workspace/file-context']!
    // 已知工作区：200
    assert.equal((await handler(undefined, { cwd: root }, auth)).status, 200)
    // 未知工作区：403，即使目录真实存在
    const res = await handler(undefined, { cwd: evil }, auth)
    assert.equal(res.status, 403)
    // 未传 knownWorkspaces（默认空）：一律 403
    const strict = buildFileContextRoutes('file-context-test')['GET /workspace/file-context']!
    assert.equal((await strict(undefined, { cwd: root }, auth)).status, 403)
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(evil, { recursive: true, force: true }) }
})
