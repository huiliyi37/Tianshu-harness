import type { PostSessionRuntimeHook, PostToolRuntimeHook } from '../runtime-hooks.js'
import type { MeridianIndexer } from '../../repo/meridian-indexer.js'
import { scheduleMeridianBackfill } from '../../repo/meridian-backfill.js'

export interface MeridianHookDeps {
  getIndexer: () => MeridianIndexer | null
  /** 队列项软超时（5s）命中时回调——调用方写遥测（telemetry writer）。 */
  onItemTimeout?: (target: string, kind: PendingIndexKind, timeoutCount: number) => void
  /** 测试/调试覆盖：单项软超时毫秒数，缺省 5000。 */
  itemTimeoutMs?: number
}

/** write/edit 去抖窗口：同 turn 连续写同一文件只触发末次重解析。 */
const WRITE_DEBOUNCE_MS = 500
/** 单项索引软超时：wasm 加载挂起/无界 await 时跳过该项继续 drain。 */
const ITEM_TIMEOUT_MS = 5000

type PendingIndexKind = 'index' | 'invalidate'

interface PendingIndex {
  target: string
  kind: PendingIndexKind
  turn: number
}

/**
 * meridian 索引触发面（2026-09-08 阻塞修复）：
 * - read_file：先 probeFile 走廉价路径（path/可索引校验 + sha256 + needsParse
 *   + hash 未变时 recordAccess），仅 needsParse=true 时才把完整 indexFile 入队。
 * - write/edit：invalidateFile 500ms 去抖合并，队列按 setImmediate 驱动，
 *   每项完成后 setTimeout(0) 让出事件循环。
 * - 冷库（files 表空）read 命中 parse 时额外调度一次 on-demand backfill，
 *   承接「默认无启动回填」下的冷文件解析职责。
 * - postSession flush 未完成队列（best-effort，单文件失败不阻塞）。
 */
export function createMeridianHook(deps: MeridianHookDeps): {
  postTool: PostToolRuntimeHook
  postSession: PostSessionRuntimeHook
} {
  const pending = new Map<string, PendingIndex>()
  let writeTimer: ReturnType<typeof setTimeout> | null = null
  let drainScheduled = false
  let drainPromise: Promise<void> | null = null
  let timeoutCount = 0

  /** 单项软超时：Promise.race 跳过不取消——底层操作继续后台跑，
   *  但 drain 不被无界 await 卡死（与 runtime-hooks runPhase 同策略）。 */
  const runItemWithTimeout = async (item: PendingIndex, operation: Promise<void>): Promise<'done' | 'timeout'> => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), deps.itemTimeoutMs ?? ITEM_TIMEOUT_MS)
      if (timer && typeof timer.unref === 'function') timer.unref()
    })
    try {
      return await Promise.race([operation.then(() => 'done' as const), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const drain = async (): Promise<void> => {
    while (pending.size > 0) {
      const next = pending.entries().next().value
      if (!next) break
      const [key, item] = next as [string, PendingIndex]
      pending.delete(key)
      const indexer = deps.getIndexer()
      if (indexer) {
        try {
          const operation = item.kind === 'index'
            ? indexer.indexFile(item.target, { yieldBetweenImports: true })
            : indexer.invalidateFile(item.target).then(() => {
                indexer.recordEdit(item.target, item.turn)
              })
          // 防超时后底层 promise 的 rejection 变成 unhandled：race 只等首个，
          // 挂起操作继续后台跑，rejection 由这里的 catch 吞掉。
          void operation.catch(() => {})
          const outcome = await runItemWithTimeout(item, operation)
          if (outcome === 'timeout') {
            timeoutCount++
            deps.onItemTimeout?.(item.target, item.kind, timeoutCount)
          }
        } catch { /* 单文件索引失败不阻塞后续队列项 */ }
      }
      // 批间让出（meridian-backfill 同款）：避免连续大文件解析连成超长同步段。
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  }

  const startDrain = (): Promise<void> => {
    if (!drainPromise) {
      drainPromise = drain().finally(() => {
        drainPromise = null
        // drain 期间新入队的项由 setImmediate 再驱动一轮，不丢。
        if (pending.size > 0) scheduleDrain()
      })
    }
    return drainPromise
  }

  const scheduleDrain = (): void => {
    if (drainScheduled) return
    drainScheduled = true
    setImmediate(() => {
      drainScheduled = false
      void startDrain()
    })
  }

  const flush = async (): Promise<void> => {
    if (writeTimer) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
    if (pending.size > 0 || drainPromise) await startDrain()
  }

  const enqueue = (target: string, kind: PendingIndexKind, turn: number): void => {
    const existing = pending.get(target)
    // 同一文件若同时有 read(parse) 与 write，write 是更新的地面真相，invalidate 胜出。
    if (existing && existing.kind === 'invalidate') return
    pending.set(target, { target, kind, turn })

    if (kind === 'invalidate') {
      if (writeTimer) clearTimeout(writeTimer)
      writeTimer = setTimeout(() => {
        writeTimer = null
        scheduleDrain()
      }, WRITE_DEBOUNCE_MS)
      if (writeTimer && typeof writeTimer.unref === 'function') writeTimer.unref()
    } else {
      scheduleDrain()
    }
  }

  return {
    postTool: {
      phase: 'postTool',
      name: 'meridian-index',
      async run(ctx, tool) {
        const indexer = deps.getIndexer()
        if (!indexer) return
        if (!tool.target || !tool.success) return

        if (tool.name === 'read_file') {
          // 廉价路径同步执行；昂贵解析只入队不 await。
          // 兼容未带 probeFile 的测试桩/旧 indexer 实例：缺方法按 skip 处理。
          const probe = typeof indexer.probeFile === 'function' ? indexer.probeFile(tool.target) : 'skip'
          if (probe === 'parse') {
            enqueue(tool.target, 'index', ctx.snapshot.turn)
            if (!indexer.getDb().hasFiles()) {
              scheduleMeridianBackfill(indexer, ctx.snapshot.cwd, { reason: 'read_cold' })
            }
          }
          return
        }

        if (tool.name === 'write_file' || tool.name === 'edit_file') {
          enqueue(tool.target, 'invalidate', ctx.snapshot.turn)
        }
      },
    },
    postSession: {
      phase: 'postSession',
      name: 'meridian-index',
      // flush 预算（runPhase 原生 race 消费）：run 收尾不等无限——正常队列
      // 1s 内完成，3s 是 3× 余量；超预算由 runPhase 放弃等待（timed_out 记
      // 遥测，不再撞 10s 默认边界），drain 继续后台跑（drainPromise 独立，
      // finally 补驱）不丢项。
      budgetMs: 3000,
      async run() {
        await flush()
      },
    },
  }
}
