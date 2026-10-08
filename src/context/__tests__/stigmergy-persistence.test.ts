import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import promises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StigmergyStore, type PheromoneDeposit } from '../stigmergy.js'
import { spawnSync } from 'node:child_process'
import { setImmediate as tick } from 'node:timers/promises'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const storeUrl = new URL('../stigmergy.ts', import.meta.url).href
const deposit = (path: string): PheromoneDeposit => ({ path, signal: 'entry-point', strength: 0.5 })
function latch() { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } }

test('flush waits for an already-started debounced publication', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'pheromone-flight-')), path = join(root, 'pheromones.json')
  const store = new StigmergyStore(path), entered = latch(), gate = latch()
  const original = promises.rename
  let calls = 0, settled = false
  let outcome: string | undefined
  promises.rename = async (source, target) => {
    if (target !== path) return original(source, target)
    if (++calls > 1) throw Object.assign(new Error('overlapping publisher'), { code: 'EIO' })
    entered.release(); await gate.promise; return original(source, target)
  }
  syncBuiltinESMExports()
  try {
    await store.deposit(deposit('a.ts')); await entered.promise
    const flushed = store.flush().then(() => { settled = true; outcome = 'saved' }, error => { settled = true; outcome = error.message })
    await tick(); await tick()
    assert.equal(settled, false, 'flush must join the in-flight publication')
    gate.release(); await flushed
    assert.equal(outcome, 'saved')
    assert.equal(JSON.parse(fs.readFileSync(path, 'utf8'))[0].path, 'a.ts')
  } finally {
    gate.release(); await tick(); await tick()
    promises.rename = original; syncBuiltinESMExports(); await store.flush().catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an older publication cannot mark a newer deposit clean', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'pheromone-newer-')), path = join(root, 'pheromones.json')
  const store = new StigmergyStore(path), entered = latch(), gate = latch(), completed = latch()
  const original = promises.rename
  let first = true
  promises.rename = async (source, target) => {
    if (target === path && first) {
      first = false; entered.release(); await gate.promise
      await original(source, target); completed.release(); return
    }
    return original(source, target)
  }
  syncBuiltinESMExports()
  try {
    await store.deposit(deposit('a.ts')); await entered.promise
    await store.deposit(deposit('b.ts'))
    gate.release(); await completed.promise; await tick()
    await store.flush()
    assert.deepEqual(JSON.parse(fs.readFileSync(path, 'utf8')).map((e: PheromoneDeposit) => e.path), ['a.ts', 'b.ts'])
  } finally {
    gate.release(); await tick(); promises.rename = original; syncBuiltinESMExports()
    await store.flush().catch(() => {}); fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an explicitly rejected save keeps its complete entries for a later flush', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'pheromone-save-')), path = join(root, 'pheromones.json')
  const store = new StigmergyStore(path), original = promises.rename
  promises.rename = async (source, target) => {
    if (target === path) throw Object.assign(new Error('synthetic read-only state'), { code: 'EROFS' })
    return original(source, target)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(store.save([{ ...deposit('saved.ts'), depositedAt: 1, halfLife: 604800000 }]), { code: 'EROFS' })
    promises.rename = original; syncBuiltinESMExports()
    await store.flush()
    assert.equal(JSON.parse(fs.readFileSync(path, 'utf8'))[0].path, 'saved.ts')
  } finally {
    promises.rename = original; syncBuiltinESMExports(); await store.flush().catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('all flush callers awaiting one failed publication receive that failure', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'pheromone-awaiters-')), path = join(root, 'pheromones.json')
  const store = new StigmergyStore(path), entered = latch(), gate = latch(), original = promises.rename
  let fail = true
  const pending: Promise<void>[] = []
  promises.rename = async (source, target) => {
    if (target === path && fail) {
      fail = false; entered.release(); await gate.promise
      throw Object.assign(new Error('first publication failed'), { code: 'EROFS' })
    }
    return original(source, target)
  }
  syncBuiltinESMExports()
  try {
    await store.deposit(deposit('accepted.ts'))
    pending.push(store.flush()); await entered.promise
    pending.push(store.flush(), store.flush())
    const settled = Promise.allSettled(pending)
    gate.release()
    const outcomes = await settled
    assert.deepEqual(outcomes.map(result => result.status), ['rejected', 'rejected', 'rejected'])
    for (const result of outcomes) if (result.status === 'rejected') assert.equal(result.reason.code, 'EROFS')
    await store.flush()
    assert.equal(JSON.parse(fs.readFileSync(path, 'utf8'))[0].path, 'accepted.ts')
  } finally {
    gate.release(); await Promise.allSettled(pending)
    promises.rename = original; syncBuiltinESMExports(); await store.flush().catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('permanent background rename failure stays visible, rejects flush, retains recoverable data and never leaks rejection', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'pheromone-error-')), path = join(root, 'pheromones.json')
  const script = `
    import fs from 'node:fs'; import promises from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
    const { StigmergyStore } = await import(${JSON.stringify(storeUrl)});
    const target = process.argv[1], original = promises.rename, errors = [], unhandled = [];
    console.error = (...args) => errors.push(args.join(' ')); process.on('unhandledRejection', error => unhandled.push(error.code));
    let fail = true;
    promises.rename = async (a, b) => { if (b === target && fail) throw Object.assign(new Error('persistent synthetic EROFS'), {code:'EROFS'}); return original(a,b) }; syncBuiltinESMExports();
    const store = new StigmergyStore(target); await store.deposit({path:'pending.ts',signal:'entry-point',strength:0.5});
    await new Promise(r => setTimeout(r, 350));
    let flushError; try {await store.flush()} catch(error) {flushError=error.code}
    fail=false; await store.flush();
    console.log(JSON.stringify({unhandled,errors,flushError,persisted:JSON.parse(fs.readFileSync(target,'utf8'))}));
  `
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, path], { cwd: repo, env: process.env, encoding: 'utf8', timeout: 10_000, windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    const body = JSON.parse(result.stdout.trim())
    assert.deepEqual(body.unhandled, [])
    assert.equal(body.flushError, 'EROFS')
    assert.ok(body.errors.some((line: string) => line.includes('EROFS')), 'background persistence failure must remain diagnostic')
    assert.equal(body.persisted[0].path, 'pending.ts')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
