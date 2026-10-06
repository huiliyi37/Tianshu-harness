import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { WRITE_FILE_TOOL } from '../../tools/write-file.js'
import { PromptEngine } from '../../prompt/engine.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  withWorkspaceRoots,
  currentWorkspaceRoots,
} from '../../tools/workspace-context.js'
import { validatePathSafe } from '../../tools/path-validate.js'
import { defaultWritableRoots } from '../../tools/sandbox-profile.js'
import { GLOB_TOOL } from '../../tools/glob.js'
import { GREP_TOOL } from '../../tools/grep.js'
import { validateWorkspaceRoots } from '../workspace-roots.js'
import { buildSessionRoutes } from '../session-routes.js'
import { buildWorkspaceRoutes } from '../workspace-route.js'
import { createRouter } from '../index.js'
import {
  RuntimeSessionManager,
  type ManagedAgent,
  type SessionPersistenceAdapter,
} from '../session-manager.js'
import type { SessionRecord } from '../protocol.js'

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'multi-root-'))
  const roots = ['primary', '中文 空格', 'other'].map((name) =>
    join(base, name),
  ) as [string, string, string]
  for (const root of roots) {
    mkdirSync(root)
    writeFileSync(join(root, 'note.txt'), 'multi-root evidence')
  }
  return {
    base,
    roots,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}
test('selected folders validate, canonicalize and reject invalid paths before registration', async () => {
  const f = fixture()
  try {
    assert.deepEqual(
      validateWorkspaceRoots([f.roots[0], f.roots[1], f.roots[0] + '/']),
      f.roots.slice(0, 2),
    )
    assert.throws(
      () => validateWorkspaceRoots([f.roots[0] + '/missing']),
      /missing/,
    )
    assert.throws(() => validateWorkspaceRoots([f.roots[0]], f.roots[1]), /cwd/)
    assert.throws(() => validateWorkspaceRoots(['/etc']), /protected/)
    const router = createRouter(buildWorkspaceRoutes('test-auth'))
    assert.equal(
      (
        await router(
          'POST',
          '/workspace/validate-roots',
          { roots: f.roots },
          {},
        )
      ).status,
      401,
    )
    assert.equal(
      (
        await router(
          'POST',
          '/workspace/validate-roots',
          { roots: f.roots },
          { authorization: 'Bearer test-auth' },
        )
      ).status,
      200,
    )
  } finally {
    f.cleanup()
  }
})
test('same-cwd concurrent sessions isolate extra roots and reject symlink and sensitive escapes', async () => {
  const f = fixture()
  try {
    symlinkSync(f.roots[2], join(f.roots[1], 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const [a, b] = await Promise.all([
      withWorkspaceRoots(f.roots.slice(0, 2), async () => {
        await new Promise((r) => setTimeout(r, 5))
        return [
          validatePathSafe(f.roots[0], join(f.roots[1], 'note.txt'), 'write')
            .ok,
          validatePathSafe(f.roots[0], join(f.roots[2], 'note.txt')).ok,
          validatePathSafe(
            f.roots[0],
            join(f.roots[1], 'escape/new.txt'),
            'write',
          ).ok,
          validatePathSafe(f.roots[0], join(f.roots[1], '.env')).ok,
          defaultWritableRoots({ cwd: f.roots[0] }).includes(f.roots[1]),
        ]
      }),
      withWorkspaceRoots([f.roots[0], f.roots[2]], async () => {
        await Promise.resolve()
        return validatePathSafe(f.roots[0], join(f.roots[1], 'note.txt')).ok
      }),
    ])
    assert.deepEqual(a, [true, false, false, false, true])
    assert.equal(b, false)
    assert.equal(
      validatePathSafe(f.roots[0], join(f.roots[1], 'note.txt')).ok,
      false,
    )
    const read = await withWorkspaceRoots(f.roots.slice(0, 2), () =>
      READ_FILE_TOOL.execute({
        cwd: f.roots[0],
        toolUseId: 'read',
        input: { file_path: join(f.roots[1], 'note.txt') },
      }),
    )
    assert.equal(read.isError, undefined)
    assert.ok(read.content.includes('evidence'))
    const write = await withWorkspaceRoots(f.roots.slice(0, 2), () =>
      WRITE_FILE_TOOL.execute({
        cwd: f.roots[0],
        toolUseId: 'write',
        input: {
          file_path: join(f.roots[1], 'created.txt'),
          content: 'Written by file tool',
        },
      }),
    )
    assert.ok(!write.isError)
    assert.equal(
      readFileSync(join(f.roots[1], 'created.txt'), 'utf8'),
      'Written by file tool',
    )
    const makeEngine = () =>
      new PromptEngine({
        model: 'deepseek-flash',
        maxTokens: 1000,
        staticCtx: { tools: [] },
        volatileCtx: { cwd: f.roots[0] },
      })
    const engine = withWorkspaceRoots(f.roots.slice(0, 2), makeEngine)
    const request = engine.buildOaiRequest([
      { role: 'user', content: 'Inspect all selected folders' },
    ])
    const frozen = engine.exportFrozenSnapshot()
    assert.ok(JSON.stringify(request).includes('workspace_roots'))
    assert.ok(JSON.stringify(request).includes(JSON.stringify(f.roots[1]).slice(1, -1)))
    const again = withWorkspaceRoots(f.roots.slice(0, 2), makeEngine)
    again.buildOaiRequest([
      { role: 'user', content: 'Inspect all selected folders' },
    ])
    assert.equal(
      frozen.frozenBaseHash,
      again.exportFrozenSnapshot().frozenBaseHash,
    )

    const glob = await withWorkspaceRoots(f.roots.slice(0, 2), () =>
      GLOB_TOOL.execute({
        cwd: f.roots[0],
        toolUseId: 'g',
        input: { pattern: '*.txt' },
      }),
    )
    assert.ok(glob.content.includes(join(f.roots[0], 'note.txt')))
    assert.ok(glob.content.includes(join(f.roots[1], 'note.txt')))
    const grep = await withWorkspaceRoots(f.roots.slice(0, 2), () =>
      GREP_TOOL.execute({
        cwd: f.roots[0],
        toolUseId: 's',
        input: { pattern: 'evidence', literal: true },
      }),
    )
    assert.ok(grep.content.includes(f.roots[1]))
    assert.ok(grep.content.includes('note.txt'))
    const explicit = await withWorkspaceRoots(f.roots.slice(0, 2), () =>
      GLOB_TOOL.execute({
        cwd: f.roots[0],
        toolUseId: 'g',
        input: { pattern: '*.txt', path: f.roots[0] },
      }),
    )
    assert.equal(explicit.content, 'note.txt')
  } finally {
    f.cleanup()
  }
})
test('creation consumes roots, desktop save respects them, recovery and agent construction retain them', async () => {
  const f = fixture()
  const records = new Map<string, SessionRecord>()
  const snapshots: string[][] = []
  const persistence: SessionPersistenceAdapter = {
    saveRecord: (r) => records.set(r.id, structuredClone(r)),
    appendEvent: () => {},
    loadAll: () => [],
    loadRecords: () => [...records.values()],
    loadEvents: () => [],
  }
  const createAgent = (cwd?: string): ManagedAgent => {
    snapshots.push([...currentWorkspaceRoots(cwd!)])
    return {
      run: async () => {
        snapshots.push([...currentWorkspaceRoots(cwd!)])
        assert.ok(
          validatePathSafe(cwd!, join(f.roots[1], 'note.txt'), 'write').ok,
        )
      },
      abort: () => {},
      getMessages: () => [],
      replaceMessages: () => {},
      rewindToMessages: () => {},
      listArtifacts: () => [],
      readArtifact: async () => null,
    }
  }
  try {
    const manager = new RuntimeSessionManager({
      defaultCwd: f.roots[0],
      createAgent,
      persistence,
    })
    const router = createRouter(buildSessionRoutes(manager, 'test-auth'))
    const auth = { authorization: 'Bearer test-auth' }
    const created = await router(
      'POST',
      '/sessions',
      { cwd: f.roots[0], workspaceRoots: f.roots.slice(0, 2) },
      auth,
    )
    assert.equal(created.status, 201)
    const rec = created.body as SessionRecord
    assert.deepEqual(rec.workspaceRoots, f.roots.slice(0, 2))
    const path = encodeURIComponent(join(f.roots[1], 'note.txt'))
    const doc = await router(
      'GET',
      `/sessions/${rec.id}/file-document?path=${path}`,
      {},
      auth,
    )
    assert.equal(doc.status, 200)
    const version = (doc.body as { version: string }).version
    assert.equal(
      (
        await router(
          'PUT',
          `/sessions/${rec.id}/file-document`,
          {
            path: join(f.roots[1], 'note.txt'),
            version,
            content: 'Saved in second folder',
          },
          auth,
        )
      ).status,
      200,
    )
    assert.equal(
      readFileSync(join(f.roots[1], 'note.txt'), 'utf8'),
      'Saved in second folder',
    )
    const files = await router('GET', `/sessions/${rec.id}/files`, {}, auth)
    assert.ok(
      (files.body as { files: string[] }).files.includes(
        join(f.roots[1], 'note.txt'),
      ),
    )
    const tree = await router('GET', `/sessions/${rec.id}/list-dir`, {}, auth)
    assert.deepEqual(
      (tree.body as { entries: { path: string }[] }).entries.map((e) => e.path),
      f.roots.slice(0, 2),
    )
    const isolated = manager.createSession({
      cwd: f.roots[0],
      workspaceRoots: [f.roots[0], f.roots[2]],
    })
    assert.equal(
      (
        await router(
          'GET',
          `/sessions/${isolated.id}/file-document?path=${path}`,
          {},
          auth,
        )
      ).status,
      403,
    )
    assert.equal(
      (
        await router(
          'POST',
          '/sessions',
          {
            cwd: f.roots[0],
            workspaceRoots: f.roots.slice(0, 2),
            isolatedWorktree: true,
          },
          auth,
        )
      ).status,
      400,
    )
    assert.equal(
      (
        await router(
          'POST',
          '/sessions',
          { cwd: f.roots[0], workspaceRoots: [join(f.base, 'missing')] },
          auth,
        )
      ).status,
      400,
    )
    const restored = new RuntimeSessionManager({
      defaultCwd: f.roots[0],
      createAgent,
      persistence,
    })
    assert.deepEqual(
      restored.getSession(rec.id)?.workspaceRoots,
      f.roots.slice(0, 2),
    )
    assert.ok(restored.run(rec.id, 'Read the additional folder'))
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.deepEqual(snapshots, [f.roots.slice(0, 2), f.roots.slice(0, 2)])
  } finally {
    f.cleanup()
  }
})
