/**
 * Worker-thread entry for CPU-bound diff tasks.
 *
 * Bundled by tsup as a separate entry (`dist/cpu-worker.js`) so the main
 * thread can spawn it via `new Worker(path)`.  The task registry maps string
 * keys to the pure functions in cpu-tasks.ts; the main thread sends
 * `{ id, task, args }` and the worker replies `{ id, ok, result }` (or
 * `{ id, ok: false, error }` on failure).
 *
 * No process/env access, no fs, no tui — pure computation only.
 */

import { parentPort } from 'node:worker_threads'
// @ts-ignore — tsx dev worker uses .ts extension; tsup bundles this file separately
import { diffUnifiedRaw, diffStructuredRaw, diffLinesRaw, parseEventsJsonlRaw, parseEventsTailRaw, esbuildTransformRaw, astScanRaw, astEditComputeRaw } from './cpu-tasks.ts'

type TaskFn = (...args: any[]) => unknown

const tasks: Record<string, TaskFn> = {
  diffUnifiedRaw: diffUnifiedRaw as TaskFn,
  diffStructuredRaw: diffStructuredRaw as TaskFn,
  diffLinesRaw: diffLinesRaw as TaskFn,
  parseEventsJsonlRaw: parseEventsJsonlRaw as TaskFn,
  parseEventsTailRaw: parseEventsTailRaw as TaskFn,
  esbuildTransformRaw: esbuildTransformRaw as TaskFn,
  astScanRaw: astScanRaw as TaskFn,
  astEditComputeRaw: astEditComputeRaw as TaskFn,
}

parentPort?.on('message', (msg: { id: number; task: string; args: unknown[] }) => {
  const fn = tasks[msg.task]
  if (!fn) {
    parentPort?.postMessage({ id: msg.id, ok: false, error: `unknown task: ${msg.task}` })
    return
  }
  // 任务可以是同步纯函数或 async（esbuildTransformRaw）——统一 Promise 化。
  Promise.resolve()
    .then(() => fn(...(msg.args as [any, any, any, any])))
    .then((result) => {
      parentPort?.postMessage({ id: msg.id, ok: true, result })
    })
    .catch((err) => {
      parentPort?.postMessage({
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    })
})
