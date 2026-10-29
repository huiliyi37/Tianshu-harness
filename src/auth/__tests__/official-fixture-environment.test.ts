import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { officialFixture } from './official-model-auth.test.js'

const accountKeys = ['RIVET_ACCOUNT_API', 'RIVET_ACCOUNT_ANON_KEY'] as const
const snapshot = () => new Map(accountKeys.map(key => [key, process.env[key]]))
const restore = (previous: ReturnType<typeof snapshot>) => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

test('overlapping official fixtures retain their shared synthetic environment until the last close', async () => {
  const previous = snapshot()
  process.env.RIVET_ACCOUNT_API = 'https://operator-fixture.invalid'
  process.env.RIVET_ACCOUNT_ANON_KEY = 'synthetic-operator-sentinel'
  const fixtures: Awaited<ReturnType<typeof officialFixture>>[] = []
  try {
    fixtures.push(await officialFixture(), await officialFixture())
    await fixtures[0]!.close()
    assert.equal(process.env.RIVET_ACCOUNT_API, 'https://account-fixture.invalid')
    await fixtures[1]!.install('A')
    await fixtures[1]!.close()
    assert.equal(process.env.RIVET_ACCOUNT_API, 'https://operator-fixture.invalid')
    assert.equal(process.env.RIVET_ACCOUNT_ANON_KEY, 'synthetic-operator-sentinel')
  } finally {
    await Promise.allSettled(fixtures.map(fixture => fixture.close()))
    restore(previous)
  }
})

test('official fixture setup failure leaves the inherited synthetic environment untouched', async () => {
  const previous = snapshot()
  const createServer = http.createServer
  process.env.RIVET_ACCOUNT_API = 'https://operator-fixture.invalid'
  process.env.RIVET_ACCOUNT_ANON_KEY = 'synthetic-operator-sentinel'
  http.createServer = () => { throw new Error('Synthetic setup failure') }
  syncBuiltinESMExports()
  try {
    await assert.rejects(officialFixture(), /Synthetic setup failure/)
    assert.equal(process.env.RIVET_ACCOUNT_API, 'https://operator-fixture.invalid')
    assert.equal(process.env.RIVET_ACCOUNT_ANON_KEY, 'synthetic-operator-sentinel')
  } finally {
    http.createServer = createServer
    syncBuiltinESMExports()
    restore(previous)
  }
})

test('official fixture close failure still releases the shared environment lease', async () => {
  const previous = snapshot()
  const createServer = http.createServer
  process.env.RIVET_ACCOUNT_API = 'https://operator-fixture.invalid'
  process.env.RIVET_ACCOUNT_ANON_KEY = 'synthetic-operator-sentinel'
  http.createServer = ((...args: Parameters<typeof http.createServer>) => {
    const server = Reflect.apply(createServer, http, args)
    const close = server.close
    Object.defineProperty(server, 'close', { value(...closeArgs: Parameters<typeof server.close>) {
      Reflect.apply(close, server, closeArgs)
      throw new Error('Synthetic close failure')
    } })
    return server
  }) as typeof http.createServer
  syncBuiltinESMExports()
  try {
    const fixture = await officialFixture()
    await assert.rejects(fixture.close(), /Synthetic close failure/)
    assert.equal(process.env.RIVET_ACCOUNT_API, 'https://operator-fixture.invalid')
    assert.equal(process.env.RIVET_ACCOUNT_ANON_KEY, 'synthetic-operator-sentinel')
  } finally {
    http.createServer = createServer
    syncBuiltinESMExports()
    restore(previous)
  }
})
