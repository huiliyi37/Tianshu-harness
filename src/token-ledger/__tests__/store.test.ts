/**
 * TokenLedgerStore 测试：折叠口径、增量游标、截断失效方向、落盘重建。
 * 夹具统一 mkdtemp（仓库外）；每个用例独立的 sessionsRoot/statePath，
 * cache-log 行形态对齐 loop-factory recordTurnCache。
 */
import { test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync, truncateSync, unlinkSync, readdirSync } from 'node:fs'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TokenLedgerStore, ledgerDigest } from '../store.js'
import type { PricingResolver } from '../../cache/usage-aggregator.js'

const T0 = Date.parse('2026-10-10T10:00:00')
const tmpRoots: string[] = []

after(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function mainRow(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    t: T0, turn: 1, model: 'deepseek-flash', provider: 'deepseek',
    input: 1000, cacheRead: 800, cacheCreate: 0, output: 100, hitRate: 80,
    ...over,
  })
}

function sidePathRow(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'side_path', kind: 'speculation', t: T0, model: 'deepseek-flash', provider: 'deepseek',
    input: 200, cacheRead: 0, cacheCreate: 0, output: 50, ...over,
  })
}

function setup(name: string, resolvePricing?: PricingResolver) {
  const base = mkdtempSync(join(tmpdir(), `token-ledger-${name}-`))
  tmpRoots.push(base)
  const sessionsRoot = join(base, 'sessions')
  return {
    sessionsRoot,
    statePath: join(base, 'ledger.json'),
    makeStore: () => new TokenLedgerStore({
      statePath: join(base, 'ledger.json'),
      sessionsRoot,
      ...(resolvePricing ? { resolvePricing } : {}),
      now: () => T0 + 86_400_000,
    }),
  }
}

function writeLog(sessionsRoot: string, relDir: string, lines: string[]): string {
  const dir = join(sessionsRoot, relDir)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'cache-log.jsonl')
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

test('折叠口径：主行 + side_path + retry 计入，非计费行与坏行丢弃', async () => {
  const fx = setup('fold')
  writeLog(fx.sessionsRoot, 'proj-a/sess-1', [
    mainRow(),
    sidePathRow(),
    JSON.stringify({ event: 'stream_attempt_aborted', t: T0, model: 'deepseek-flash', provider: 'deepseek', requestId: 'r1', attemptId: 'a1', input: 500, cacheRead: 0, cacheCreate: 0, output: 0 }),
    JSON.stringify({ event: 'reclaim_decision', t: T0, decided: true }),   // 非计费行
    'not json at all',
  ])

  const store = fx.makeStore()
  const { newRows } = await store.refresh()
  assert.equal(newRows, 3)

  const totals = store.totals()
  assert.equal(totals.requests, 3)
  assert.equal(totals.input, 1000 + 200 + 500)
  assert.equal(totals.output, 150)
  assert.equal(totals.cacheRead, 800)
  assert.equal(totals.cost, 0) // 未注入定价 → 0，不硬造数字

  const records = store.records()
  assert.equal(records.length, 1)
  assert.equal(records[0]!.date, '2026-10-10')
  assert.equal(records[0]!.model, 'deepseek-flash')
  assert.equal(records[0]!.provider, 'deepseek')
})

test('同 attempt 重复行只计一次；无 id 行不去重', async () => {
  const fx = setup('dedupe')
  writeLog(fx.sessionsRoot, 'sess-1', [
    JSON.stringify({ event: 'stream_attempt_aborted', t: T0, model: 'm', requestId: 'r1', attemptId: 'a1', input: 100, cacheRead: 0, cacheCreate: 0, output: 0 }),
    JSON.stringify({ event: 'stream_attempt_aborted', t: T0, model: 'm', requestId: 'r1', attemptId: 'a1', input: 100, cacheRead: 0, cacheCreate: 0, output: 0 }),
    JSON.stringify({ event: 'stream_attempt_aborted', t: T0, model: 'm', input: 100, cacheRead: 0, cacheCreate: 0, output: 0 }),
  ])
  const store = fx.makeStore()
  await store.refresh()
  // 同 (requestId, attemptId) 两行去重计 1，无 id 行不参与去重计 1 → 共 2 行
  assert.equal(store.totals().requests, 2)
  assert.equal(store.totals().input, 200)
})

test('增量游标：重复 refresh 不重算，追加后只折叠新行', async () => {
  const fx = setup('incremental')
  const file = writeLog(fx.sessionsRoot, 'sess-1', [mainRow()])
  const store = fx.makeStore()

  await store.refresh()
  assert.equal(store.totals().requests, 1)

  await store.refresh() // 无新增
  assert.equal(store.totals().requests, 1)

  appendFileSync(file, mainRow({ turn: 2, input: 2000 }) + '\n')
  const { newRows } = await store.refresh()
  assert.equal(newRows, 1)
  assert.equal(store.totals().requests, 2)
  assert.equal(store.totals().input, 3000)
})

test('截断失效方向：文件缩小时不重算旧行（宁可少算）', async () => {
  const fx = setup('truncate')
  const file = writeLog(fx.sessionsRoot, 'sess-1', [mainRow({ input: 1000 }), mainRow({ input: 1000, turn: 2 })])
  const store = fx.makeStore()
  await store.refresh()
  assert.equal(store.totals().input, 2000)

  // 截断（模拟日志被外部清理）：旧行已折叠过，绝不重计
  truncateSync(file, JSON.stringify(mainRow({ input: 9999 })).length + 1)
  await store.refresh()
  assert.equal(store.totals().input, 2000) // 不变：没有 9999，也没有重复 1000

  // 截断后的新追加从新区间继续，正常计入
  appendFileSync(file, '\n' + mainRow({ input: 7, turn: 9 }) + '\n')
  await store.refresh()
  assert.equal(store.totals().input, 2007)
})

test('落盘重建：新实例继承 deviceId / 游标 / 累计，不从零重扫', async () => {
  const fx = setup('persist')
  writeLog(fx.sessionsRoot, 'sess-1', [mainRow()])
  const store1 = fx.makeStore()
  await store1.refresh()
  const deviceId = store1.deviceId
  assert.ok(existsSync(fx.statePath))

  const store2 = fx.makeStore()
  assert.equal(store2.deviceId, deviceId)
  assert.equal(store2.totals().requests, 1)
  const { newRows } = await store2.refresh() // 游标已在 EOF，不重扫
  assert.equal(newRows, 0)
  assert.equal(store2.totals().requests, 1)
})

test('定价注入：按行折叠 cost；缺定价落 0', async () => {
  const fx = setup('pricing', () => ({ input: 2, output: 8, cacheRead: 0.04, cacheWrite: 2 }))
  writeLog(fx.sessionsRoot, 'sess-1', [mainRow({ input: 1_000_000, cacheRead: 500_000, output: 100_000 })])
  const store = fx.makeStore()
  await store.refresh()
  // 未命中 input 500k×2/M=1 + output 100k×8/M=0.8 + cacheRead 500k×0.04/M=0.02
  assert.equal(store.totals().cost, 1.82)
})

test('markPushed 仅 2xx 钉摘要；回执随状态落盘', async () => {
  const fx = setup('digest')
  writeLog(fx.sessionsRoot, 'sess-1', [mainRow()])
  const store = fx.makeStore()
  await store.refresh()
  const digest = store.digest()
  assert.notEqual(digest, ledgerDigest({}))
  assert.equal(store.digest(), digest)

  await store.markPushed({ ok: false, code: 'network', error: 'boom' })
  assert.equal(store.lastPushedDigest, undefined)
  assert.equal(store.lastPushResult?.ok, false)

  await store.markPushed({ ok: true, status: 200 })
  assert.equal(store.lastPushedDigest, digest)
  assert.equal(store.lastPushResult?.ok, true)
  assert.ok(store.lastPushAt)

  const store2 = fx.makeStore()
  assert.equal(store2.lastPushedDigest, digest)
})

test('snapshot 形状：version/deviceId/sentAt/totals/days 齐全且为累计语义', async () => {
  const fx = setup('snapshot')
  writeLog(fx.sessionsRoot, 'sess-1', [mainRow(), sidePathRow()])
  const store = fx.makeStore()
  await store.refresh()
  const snap = await store.snapshot('test-machine')
  assert.equal(snap.version, 2)
  assert.equal(snap.deviceId, store.deviceId)
  assert.equal(snap.deviceName, 'test-machine')
  assert.equal(snap.sentAt, new Date(T0 + 86_400_000).toISOString())
  assert.equal(snap.days.length, 1)
  assert.equal(snap.totals.requests, 2)
  assert.equal(snap.totals.input, 1200)

  // 快照必须可被 JSON 安全序列化（论坛契约）
  const parsed = JSON.parse(JSON.stringify(snap))
  assert.equal(parsed.days[0].model, 'deepseek-flash')
})

test('损坏账本无法恢复设备身份时拒绝重新生成并推送', async () => {
  const fx = setup('corrupt-unknown')
  writeLog(fx.sessionsRoot, 'sess-1', [mainRow()])
  writeFileSync(fx.statePath, '{broken json')
  await assert.rejects(fx.makeStore().refresh(), /identity|身份/i)
  assert.equal(readFileSync(fx.statePath, 'utf8'), '{broken json')
})

test('半行尾部跨refresh与restart完成后恰好计入一次', async () => {
  const fx = setup('partial')
  const file = writeLog(fx.sessionsRoot, 'sess-1', [mainRow()])
  const row = mainRow({ input: 7, turn: 2 })
  appendFileSync(file, row.slice(0, 40))
  const store = fx.makeStore()
  await store.refresh()
  assert.equal(store.totals().input, 1000)
  appendFileSync(file, row.slice(40) + '\n')
  const restarted = fx.makeStore()
  await restarted.refresh()
  await restarted.refresh()
  assert.equal(restarted.totals().input, 1007)
})

test('attempt跨refresh与restart去重；不同会话的相同id独立计费', async () => {
  const fx = setup('dedupe-restart')
  const row = mainRow({ requestId: 'request', attemptId: 'attempt' })
  const file = writeLog(fx.sessionsRoot, 'sess-1', [row])
  const store = fx.makeStore()
  await store.refresh()
  appendFileSync(file, row + '\n')
  await store.refresh()
  appendFileSync(file, row + '\n')
  writeLog(fx.sessionsRoot, 'sess-2', [row])
  const restarted = fx.makeStore()
  await restarted.refresh()
  assert.equal(restarted.totals().requests, 2)
})

test('预加载旧实例和并发refresh不能覆盖已落盘行与回执', async () => {
  const fx = setup('concurrent')
  const file = writeLog(fx.sessionsRoot, 'sess-1', [mainRow()])
  const first = fx.makeStore()
  await first.refresh()
  const stale = fx.makeStore()
  stale.totals()
  await first.markPushed({ ok: true, status: 200 }, first.digest(), 'target')
  appendFileSync(file, mainRow({ input: 7 }) + '\n')
  await Promise.all([first.refresh(), stale.refresh()])
  const latest = fx.makeStore()
  assert.equal(latest.totals().input, 1007)
  assert.equal(latest.lastPushedTargetHash, 'target')
  assert.ok(latest.lastPushedDigest)
})

test('回执确认上传digest而非后来折叠的当前digest', async () => {
  const fx = setup('receipt')
  const file = writeLog(fx.sessionsRoot, 'sess-1', [mainRow()])
  const store = fx.makeStore()
  await store.refresh()
  const uploaded = store.digest()
  appendFileSync(file, mainRow({ input: 7 }) + '\n')
  await store.refresh()
  await store.markPushed({ ok: true, status: 200 }, uploaded, 'target')
  assert.equal(store.lastPushedDigest, uploaded)
  assert.notEqual(store.lastPushedDigest, store.digest())
})

test('identity sidecar让丢失或损坏账本重建仍复用原设备id', async () => {
  const fx = setup('identity')
  writeLog(fx.sessionsRoot, 'sess-1', [mainRow()])
  const store = fx.makeStore()
  await store.refresh()
  const id = store.deviceId
  writeFileSync(fx.statePath, '{broken json')
  const repaired = fx.makeStore()
  await repaired.refresh()
  assert.equal(repaired.deviceId, id)
  assert.equal(repaired.totals().input, 1000)
  const backups = readdirSync(join(fx.statePath, '..')).filter(name => name.startsWith('ledger.json.corrupt-'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(fx.statePath, '..', backups[0]!), 'utf8'), '{broken json')
  unlinkSync(fx.statePath)
  const missing = fx.makeStore()
  await missing.refresh()
  assert.equal(missing.deviceId, id)
  assert.equal(missing.totals().input, 1000)
})

test('无新增日志也持久化安装身份并迁移旧账本identity', async () => {
  const fx = setup('empty-identity')
  const store = fx.makeStore()
  await store.refresh()
  assert.equal(fx.makeStore().deviceId, store.deviceId)
  writeFileSync(fx.statePath, JSON.stringify({ version: 1, deviceId: 'legacy-device', offsets: {}, days: {} }))
  unlinkSync(fx.statePath + '.identity.json')
  await fx.makeStore().refresh()
  unlinkSync(fx.statePath)
  await fx.makeStore().refresh()
  assert.equal(fx.makeStore().deviceId, 'legacy-device')
})

test('snapshot sentAt跨实例、重启和时钟回拨严格递增；旧回执不覆盖新回执', async () => {
  const fx = setup('snapshot-clock')
  const store = fx.makeStore()
  await store.refresh()
  const first = await store.snapshotWithDigest('device')
  const second = await fx.makeStore().snapshotWithDigest('device')
  const rollback = new TokenLedgerStore({ statePath: fx.statePath, sessionsRoot: fx.sessionsRoot, now: () => T0 })
  const third = await rollback.snapshotWithDigest('device')
  assert.ok(first.snapshot.sentAt < second.snapshot.sentAt)
  assert.ok(second.snapshot.sentAt < third.snapshot.sentAt)
  await store.markPushed({ ok: true, status: 200 }, 'new-digest', 'new-target', third.snapshot.sentAt)
  await rollback.markPushed({ ok: true, status: 200 }, 'old-digest', 'old-target', first.snapshot.sentAt)
  assert.equal(fx.makeStore().lastPushedDigest, 'new-digest')
  assert.equal(fx.makeStore().lastPushedTargetHash, 'new-target')
})

test('state持久化失败必须reject且不能保留未落盘累计', async () => {
  const fx = setup('write-error')
  writeLog(fx.sessionsRoot, 'sess-1', [mainRow()])
  const store = fx.makeStore()
  await store.refresh()
  unlinkSync(fx.statePath)
  mkdirSync(fx.statePath)
  await assert.rejects(store.refresh())
})


test('stat之后追加的行不在本批消费，下一次refresh恰好消费一次', async () => {
  const fx = setup('bounded-read')
  const file = writeLog(fx.sessionsRoot, 'sess-1', [mainRow()])
  const original = fs.createReadStream
  let appended = false
  const mocked = mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
    if (!appended && args[0] === file) {
      appended = true
      appendFileSync(file, mainRow({ input: 7 }) + '\n')
    }
    return original(...args)
  })
  syncBuiltinESMExports()
  try {
    const store = fx.makeStore()
    await store.refresh()
    assert.equal(store.totals().input, 1000)
    await store.refresh()
    await store.refresh()
    assert.equal(store.totals().input, 1007)
  } finally { mocked.mock.restore(); syncBuiltinESMExports() }
})

test('旧v1已有游标但无attempt状态，迁移后不重复计费已消费attempt', async () => {
  const fx = setup('legacy-attempts')
  const row = mainRow({ requestId: 'r', attemptId: 'a' })
  const file = writeLog(fx.sessionsRoot, 'sess-1', [row])
  await fx.makeStore().refresh()
  const state = JSON.parse(readFileSync(fx.statePath, 'utf8'))
  delete state.attempts
  writeFileSync(fx.statePath, JSON.stringify(state))
  appendFileSync(file, row + '\n')
  const migrated = fx.makeStore()
  await migrated.refresh()
  assert.equal(migrated.totals().requests, 1)
})

test('真实并发进程共享账本时累计不重计且设备身份一致', async () => {
  const fx = setup('processes')
  writeLog(fx.sessionsRoot, 'sess-1', [mainRow()])
  const source = fileURLToPath(new URL('../store.ts', import.meta.url))
  const run = () => new Promise<string>((resolve, reject) => {
    const script = `import { TokenLedgerStore } from ${JSON.stringify(pathToFileURL(source).href)};
      const store = new TokenLedgerStore(${JSON.stringify({ statePath: fx.statePath, sessionsRoot: fx.sessionsRoot })});
      const deadline = Date.now() + 30_000;
      let snapshot;
      for (;;) {
        try { await store.refresh(); snapshot = await store.snapshot('child'); break; }
        catch (error) {
          if (error.message !== 'Cannot lock token ledger: contended' || Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      console.log(JSON.stringify({ id: snapshot.deviceId, requests: snapshot.totals.requests, at: snapshot.sentAt }));`
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd() })
    let out = ''; let error = ''
    child.stdout.on('data', data => { out += data })
    child.stderr.on('data', data => { error += data })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve(out.trim()) : reject(new Error(error)))
  })
  const results = (await Promise.all([run(), run(), run()])).map(result => JSON.parse(result))
  assert.equal(new Set(results.map(result => result.id)).size, 1)
  assert.equal(new Set(results.map(result => result.at)).size, 3)
  assert.deepEqual(results.map(result => result.requests), [1, 1, 1])
  assert.equal(fx.makeStore().totals().input, 1000)
})

test('非计费事件不会凭相同attemptid吞掉真实计费行', async () => {
  const fx = setup('nonbilled-attempt')
  const file = writeLog(fx.sessionsRoot, 'sess-1', [mainRow({ requestId: 'r', attemptId: 'a' }),
    JSON.stringify({ event: 'reclaim_decision', requestId: 'r', attemptId: 'a', model: 'deepseek-flash', provider: 'deepseek' })])
  const store = fx.makeStore()
  await store.refresh()
  assert.equal(store.totals().requests, 1)
  appendFileSync(file, JSON.stringify({ event: 'reclaim_decision', requestId: 'r2', attemptId: 'a2', model: 'deepseek-flash', provider: 'deepseek' }) + '\n')
  await store.refresh()
  appendFileSync(file, mainRow({ requestId: 'r2', attemptId: 'a2', input: 7 }) + '\n')
  await store.refresh()
  assert.equal(store.totals().input, 1007)
})

test('model为__proto__时仍正常计费且不会修改对象原型', async () => {
  const fx = setup('prototype-model')
  writeLog(fx.sessionsRoot, 'sess-1', [mainRow({ model: '__proto__', provider: undefined, input: 17 })])
  const store = fx.makeStore()
  await store.refresh()
  assert.equal(store.totals().requests, 1)
  assert.equal(store.totals().input, 17)
  assert.equal(store.records()[0]?.model, '__proto__')
  assert.equal(Object.hasOwn(Object.prototype, 'requests'), false)
})


test('原子发布失败会抛出并恢复已落盘累计；恢复后重试不重复计费', async () => {
  const fx = setup('publish-error')
  const file = writeLog(fx.sessionsRoot, 'sess-1', [mainRow()])
  const store = fx.makeStore()
  await store.refresh()
  appendFileSync(file, mainRow({ input: 7 }) + '\n')
  const original = fs.promises.rename
  const mocked = mock.method(fs.promises, 'rename', async (...args: Parameters<typeof fs.promises.rename>) => {
    if (args[1] === fx.statePath) throw Object.assign(new Error('publication denied'), { code: 'EACCES' })
    return original(...args)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(store.refresh(), /publication denied/)
    assert.equal(store.totals().input, 1000)
    assert.equal(fx.makeStore().totals().input, 1000)
  } finally { mocked.mock.restore(); syncBuiltinESMExports() }
  await store.refresh()
  assert.equal(store.totals().input, 1007)
})
