import test from 'node:test'
import assert from 'node:assert/strict'

test('宿主外调用 defineTianshuPlugin 抛错', async () => {
  const { defineTianshuPlugin } = await import('../tpi.js')
  assert.throws(() => defineTianshuPlugin({ id: 'x' }), /not running inside Tianshu/)
})

test('宿主存在时转发给 globalThis.__tianshuTPI', async () => {
  const { defineTianshuPlugin } = await import('../tpi.js')
  const seen = []
  globalThis.__tianshuTPI = { defineTianshuPlugin: (s) => { seen.push(s); return { ok: true } } }
  try {
    const out = defineTianshuPlugin({ id: 'x' })
    assert.deepEqual(out, { ok: true })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].id, 'x')
  } finally {
    delete globalThis.__tianshuTPI
  }
})
