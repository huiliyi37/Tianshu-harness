/**
 * 更新闸回归：sidecar 重启后（新 FileSessionPersistence 实例）对存量会话的
 * flushThrough 不得死等本进程写链——内存水位只覆盖本进程写入，盘上高水位
 * 早已达标的会话必须立即确认，否则 175 个存量会话会在 30s 更新预算里全军覆没
 *（桌面端 3.29.0/3.29.1 实测：「重启并更新」恒报「未能确认保存完成」）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileSessionPersistence } from '../session-persistence.js'

test('flushThrough accepts on-disk high-water for sessions this instance never wrote', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flush-through-'))
  try {
    const a = new FileSessionPersistence(dir)
    a.appendEvent('s1', { seq: 1, ts: 1, type: 'status', data: { status: 'idle' } })
    a.appendEvent('s1', { seq: 2, ts: 2, type: 'status', data: { status: 'idle' } })
    assert.equal(await a.flushThrough('s1', 2), 2)

    const b = new FileSessionPersistence(dir)
    const t = Date.now()
    const r = await b.flushThrough('s1', 2, AbortSignal.timeout(5_000))
    assert.ok(r >= 2)
    assert.ok(Date.now() - t < 1_000, `修复前此处死等到超时（实测 ${Date.now() - t}ms）`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
