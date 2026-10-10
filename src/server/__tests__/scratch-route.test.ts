import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isFilesystemMetadata } from '../../utils/file-metadata.js'
import { buildScratchRoutes, type ScratchReport, type ScratchCleanupResult } from '../scratch-cleanup.js'

// 路由层端到端：真实 RIVET_HOME + 真实磁盘，从「隔离根解析」到「删除落盘」
// 全链路，中间层一个都不 mock——路径判定与鉴权的错法只会在这里暴露。

/** 隔离 RIVET_HOME：隔离根落在临时目录，测试不碰真实数据根。 */
async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'scratch-route-'))
  const prev = process.env.RIVET_HOME
  process.env.RIVET_HOME = home
  try {
    await fn(home)
  } finally {
    if (prev === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
}

const TOKEN = 'scratch-route-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

/** Keep this synthetic size fixture limited to its payloads on sidecar-generating filesystems. */
function removeFixtureMetadata(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) removeFixtureMetadata(path)
    else if (entry.isFile() && isFilesystemMetadata(entry.name)) rmSync(path)
  }
}

test('GET /scratch + POST /scratch/cleanup：真实隔离根，只清无会话占用的目录', async () => {
  await withTempHome(async (home) => {
    const root = join(home, 'workspace')
    mkdirSync(join(root, 'busy0001'), { recursive: true })
    writeFileSync(join(root, 'busy0001', 'payload.txt'), 'busy')
    mkdirSync(join(root, 'idle0002'), { recursive: true })
    writeFileSync(join(root, 'idle0002', 'payload.txt'), 'idle')
    removeFixtureMetadata(root)

    const routes = buildScratchRoutes({ listSessions: () => [{ cwd: join(root, 'busy0001') }] }, TOKEN)

    const list = await routes['GET /scratch']!({}, undefined, AUTH, undefined)
    assert.equal(list.status, 200)
    const report = list.body as ScratchReport
    assert.equal(report.root, root, '隔离根取自 RIVET_HOME（走真实配置链路）')
    assert.deepEqual(report.entries.map((e) => e.name).sort(), ['busy0001', 'idle0002'])
    assert.equal(report.inUseCount, 1)

    const clean = await routes['POST /scratch/cleanup']!({}, undefined, AUTH, undefined)
    assert.equal(clean.status, 200)
    const result = clean.body as ScratchCleanupResult
    assert.deepEqual(result.deleted, ['idle0002'])
    assert.equal(result.freedBytes, 4, 'freedBytes 来自真实目录内容')
    // 占用项压根没进请求集合（省略 names = 只清未占用的），因此不进 skipped：
    // 「被跳过的请求项」与「没被请求的占用项」是两件事，后者由 report.inUseCount 呈现。
    assert.deepEqual(result.skipped, [])
    assert.equal(result.deleted.includes('busy0001'), false)
    assert.equal(existsSync(join(root, 'idle0002')), false)
    assert.equal(existsSync(join(root, 'busy0001')), true, '运行中的临时会话目录必须还在')
  })
})

test('POST /scratch/cleanup 指定 names：只删点名的目录', async () => {
  await withTempHome(async (home) => {
    const root = join(home, 'workspace')
    mkdirSync(join(root, 'aaaa0001'), { recursive: true })
    mkdirSync(join(root, 'bbbb0002'), { recursive: true })
    const routes = buildScratchRoutes({ listSessions: () => [] }, TOKEN)

    const clean = await routes['POST /scratch/cleanup']!({ names: ['aaaa0001'] }, undefined, AUTH, undefined)
    assert.deepEqual((clean.body as ScratchCleanupResult).deleted, ['aaaa0001'])
    assert.equal(existsSync(join(root, 'aaaa0001')), false)
    assert.equal(existsSync(join(root, 'bbbb0002')), true)
  })
})

test('未带 Bearer → 401 且不触碰磁盘（fail-closed）', async () => {
  await withTempHome(async (home) => {
    const root = join(home, 'workspace')
    mkdirSync(join(root, 'keepme01'), { recursive: true })
    const routes = buildScratchRoutes({ listSessions: () => [] }, TOKEN)

    const res = await routes['POST /scratch/cleanup']!({}, undefined, {}, undefined)
    assert.equal(res.status, 401)
    assert.equal(existsSync(join(root, 'keepme01')), true)
  })
})

test('隔离根不存在 → 空报告而非 500（用户可能从未用过临时会话）', async () => {
  await withTempHome(async (home) => {
    const routes = buildScratchRoutes({ listSessions: () => [] }, TOKEN)
    const res = await routes['GET /scratch']!({}, undefined, AUTH, undefined)
    assert.equal(res.status, 200)
    const report = res.body as ScratchReport
    assert.equal(report.exists, false)
    assert.equal(report.root, join(home, 'workspace'))
    assert.deepEqual(report.entries, [])
  })
})
