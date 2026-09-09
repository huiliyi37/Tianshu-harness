import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { MeridianIndexer } from '../../../repo/meridian-indexer.js'
import { createMeridianHook } from '../meridian-hook.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'

/** meridian-hook 触发面契约：read 廉价路径同步 probe，昂贵解析只入队不 await；
 *  write/edit 去抖合并；冷库 read 调度 on-demand backfill；postSession flush。 */

interface FakeIndexer {
  backfillScheduled: boolean
  probeFile: (target: string) => 'skip' | 'unchanged' | 'parse'
  indexFile: (target: string, options?: { yieldBetweenImports?: boolean }) => Promise<void>
  invalidateFile: (target: string) => Promise<void>
  recordEdit: (target: string, turn: number) => void
  getDb: () => { hasFiles: () => boolean }
  probeCalls: string[]
  indexCalls: string[]
  indexOptions: Array<{ target: string; options?: { yieldBetweenImports?: boolean } }>
  invalidateCalls: string[]
  editCalls: Array<{ target: string; turn: number }>
}

function fakeIndexer(opts: { probe?: 'skip' | 'unchanged' | 'parse'; hasFiles?: boolean; indexImpl?: (target: string) => Promise<void> } = {}): FakeIndexer {
  const fake: FakeIndexer = {
    backfillScheduled: true,
    probeFile: (target) => {
      fake.probeCalls.push(target)
      return opts.probe ?? 'parse'
    },
    indexFile: async (target, options) => {
      fake.indexCalls.push(target)
      fake.indexOptions.push({ target, options })
      await (opts.indexImpl ?? (async () => {}))(target)
    },
    invalidateFile: async (target) => { fake.invalidateCalls.push(target) },
    recordEdit: (target, turn) => { fake.editCalls.push({ target, turn }) },
    getDb: () => ({ hasFiles: () => opts.hasFiles ?? true }),
    probeCalls: [],
    indexCalls: [],
    indexOptions: [],
    invalidateCalls: [],
    editCalls: [],
  }
  return fake
}

function tool(name: string, target = 'src/a.ts'): RuntimeToolEvent {
  return { name, target, success: true }
}

function ctx(turn = 3): RuntimeHookContext {
  return { snapshot: { cwd: mkdtempSync(join(tmpdir(), 'meridian-hook-cwd-')), turn, recentToolHistory: [], sensorium: null, strategy: null, vigor: null, gitChangeRate: 0, season: null }, effects: {} } as unknown as RuntimeHookContext
}

const waitImmediate = () => new Promise<void>(resolve => setImmediate(resolve))
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

describe('createMeridianHook', () => {
  it('read 廉价路径只 probe，不触发昂贵 indexFile（hash 未变/不可索引）', async () => {
    const indexer = fakeIndexer({ probe: 'unchanged' })
    const hook = createMeridianHook({ getIndexer: () => indexer as unknown as MeridianIndexer })
    await hook.postTool.run(ctx(), tool('read_file', 'src/a.ts'))
    assert.deepEqual(indexer.probeCalls, ['src/a.ts'])
    assert.deepEqual(indexer.indexCalls, [], 'unchanged read must not enqueue indexFile')
  })

  it('read 需要解析时入 setImmediate 队列，run 返回不 await 解析完成', async () => {
    const indexer = fakeIndexer({ probe: 'parse', hasFiles: true })
    const hook = createMeridianHook({ getIndexer: () => indexer as unknown as MeridianIndexer })
    await hook.postTool.run(ctx(), tool('read_file', 'src/a.ts'))
    assert.deepEqual(indexer.indexCalls, [], 'indexFile must be deferred to setImmediate')
    await waitImmediate()
    await waitImmediate()
    assert.deepEqual(indexer.indexCalls, ['src/a.ts'])
  })

  it('冷库 read 需要解析时调度 on-demand backfill（read_cold 职责承接）', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-hook-cold-'))
    const indexer = fakeIndexer({ probe: 'parse', hasFiles: false })
    indexer.backfillScheduled = false
    const hook = createMeridianHook({ getIndexer: () => indexer as unknown as MeridianIndexer })
    const hookCtx = ctx()
    hookCtx.snapshot.cwd = cwd
    try {
      await hook.postTool.run(hookCtx, tool('read_file', 'src/a.ts'))
      assert.equal(indexer.backfillScheduled, true, 'cold read must schedule on-demand backfill once')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('read 队列项传入 yieldBetweenImports——1-hop 递归内也能让出事件循环', async () => {
    const indexer = fakeIndexer({ probe: 'parse', hasFiles: true })
    const hook = createMeridianHook({ getIndexer: () => indexer as unknown as MeridianIndexer })
    await hook.postTool.run(ctx(), tool('read_file', 'src/a.ts'))
    await waitImmediate()
    await waitImmediate()
    assert.deepEqual(indexer.indexOptions, [{ target: 'src/a.ts', options: { yieldBetweenImports: true } }])
  })

  it('单项软超时跳过挂起项并继续 drain，超时计数进 onItemTimeout', async () => {
    const indexer = fakeIndexer({
      probe: 'parse',
      hasFiles: true,
      indexImpl: (target) => target === 'src/hang.ts' ? new Promise<void>(() => {}) : Promise.resolve(),
    })
    const timeouts: Array<{ target: string; kind: string; count: number }> = []
    const hook = createMeridianHook({
      getIndexer: () => indexer as unknown as MeridianIndexer,
      itemTimeoutMs: 20,
      onItemTimeout: (target, kind, count) => { timeouts.push({ target, kind, count }) },
    })
    await hook.postTool.run(ctx(), tool('read_file', 'src/hang.ts'))
    await hook.postTool.run(ctx(), tool('read_file', 'src/ok.ts'))
    await waitImmediate()
    // hang 项超时跳过，ok 项仍被处理。
    await new Promise<void>(resolve => setTimeout(resolve, 80))
    assert.deepEqual(indexer.indexCalls, ['src/hang.ts', 'src/ok.ts'])
    assert.deepEqual(timeouts, [{ target: 'src/hang.ts', kind: 'index', count: 1 }])
  })

  it('write/edit 500ms 去抖合并，同 turn 连续写同一文件只 invalidate 一次', async () => {
    const indexer = fakeIndexer()
    const hook = createMeridianHook({ getIndexer: () => indexer as unknown as MeridianIndexer })
    const hookCtx = ctx()
    await hook.postTool.run(hookCtx, tool('write_file', 'src/a.ts'))
    await sleep(150)
    await hook.postTool.run(hookCtx, tool('edit_file', 'src/a.ts'))
    await sleep(650)
    await waitImmediate()
    assert.deepEqual(indexer.invalidateCalls, ['src/a.ts'], 'two writes within debounce window must merge to one invalidate')
    assert.deepEqual(indexer.editCalls, [{ target: 'src/a.ts', turn: hookCtx.snapshot.turn }])
  })

  it('postSession flush 不等 500ms 去抖窗口，立即落未完成 invalidate', async () => {
    const indexer = fakeIndexer()
    const hook = createMeridianHook({ getIndexer: () => indexer as unknown as MeridianIndexer })
    await hook.postTool.run(ctx(), tool('write_file', 'src/a.ts'))
    await hook.postSession.run(ctx())
    assert.deepEqual(indexer.invalidateCalls, ['src/a.ts'])
    assert.deepEqual(indexer.editCalls, [{ target: 'src/a.ts', turn: 3 }])
  })
})
