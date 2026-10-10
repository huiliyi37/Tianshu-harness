import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FetchCache, normalizeCacheUrl, formatCacheAge } from '../fetch-cache.js'
import { isFilesystemMetadata } from '../../../utils/file-metadata.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fetch-cache-test-'))
}

describe('normalizeCacheUrl', () => {
  it('小写 host、去默认端口、保留 query', () => {
    assert.equal(
      normalizeCacheUrl('HTTPS://Example.COM:443/docs?a=1'),
      'https://example.com/docs?a=1',
    )
  })

  it('去非 SPA hash，保留 #/ 与 #!/ 路由', () => {
    assert.equal(normalizeCacheUrl('https://ex.com/p#section'), 'https://ex.com/p')
    assert.equal(normalizeCacheUrl('https://ex.com/p#/spa/route'), 'https://ex.com/p#/spa/route')
    assert.equal(normalizeCacheUrl('https://ex.com/p#!/old'), 'https://ex.com/p#!/old')
  })

  it('非法 URL 原样返回', () => {
    assert.equal(normalizeCacheUrl('not-a-url'), 'not-a-url')
  })
})

describe('FetchCache', () => {
  it('写入后可读回；variant 区分条目', async () => {
    const dir = tempDir()
    try {
      const cache = new FetchCache(dir)
      await cache.write('https://ex.com/a', 'e1', {
        url: 'https://ex.com/a',
        markdown: '内容 A',
        via: '',
        status: 200,
      })
      const hit = await cache.read('https://ex.com/a', 'e1')
      assert.equal(hit?.markdown, '内容 A')
      const miss = await cache.read('https://ex.com/a', 'e0')
      assert.equal(miss, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('规范化后等价 URL 命中同一条目', async () => {
    const dir = tempDir()
    try {
      const cache = new FetchCache(dir)
      await cache.write('https://EX.com:443/docs#sec', 'e1', {
        url: 'https://EX.com:443/docs#sec',
        markdown: '文档',
        via: '',
        status: 200,
      })
      const hit = await cache.read('https://ex.com/docs', 'e1')
      assert.equal(hit?.markdown, '文档')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('TTL 过期判 miss', async () => {
    const dir = tempDir()
    try {
      let now = 1_000_000
      const cache = new FetchCache(dir, { maxAgeMs: 1000, now: () => now })
      await cache.write('https://ex.com/', 'e1', { url: 'https://ex.com/', markdown: '旧', via: '', status: 200 })
      now += 500
      assert.ok(await cache.read('https://ex.com/', 'e1'))
      now += 1000
      assert.equal(await cache.read('https://ex.com/', 'e1'), undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maxAgeMs: 0 禁读但仍写（调高可复活）', async () => {
    const dir = tempDir()
    try {
      const cache = new FetchCache(dir, { maxAgeMs: 0 })
      await cache.write('https://ex.com/', 'e1', { url: 'https://ex.com/', markdown: '存', via: '', status: 200 })
      assert.equal(await cache.read('https://ex.com/', 'e1'), undefined)
      // 同一目录换大 maxAge 的实例可复活
      const revived = new FetchCache(dir, { maxAgeMs: 999_999 })
      assert.equal((await revived.read('https://ex.com/', 'e1'))?.markdown, '存')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sweep 清理过期条目，保留新鲜条目', async () => {
    const dir = tempDir()
    try {
      let now = 1_000_000
      const cache = new FetchCache(dir, { maxAgeMs: 1000, now: () => now })
      await cache.write('https://ex.com/old', 'e1', { url: 'https://ex.com/old', markdown: '旧', via: '', status: 200 })
      now += 500
      await cache.write('https://ex.com/fresh', 'e1', { url: 'https://ex.com/fresh', markdown: '新', via: '', status: 200 })
      now += 800 // old 过期（1300 > 1000），fresh 未过期（800 < 1000）
      await cache.sweep()
      const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !isFilesystemMetadata(f))
      assert.equal(files.length, 1)
      assert.ok(await cache.read('https://ex.com/fresh', 'e1'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('损坏条目按 miss 处理', async () => {
    const dir = tempDir()
    try {
      const cache = new FetchCache(dir)
      await cache.write('https://ex.com/', 'e1', { url: 'https://ex.com/', markdown: '好', via: '', status: 200 })
      // 写入损坏内容覆盖
      const { writeFileSync } = await import('node:fs')
      const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !isFilesystemMetadata(f))
      assert.equal(files.length, 1, 'corrupt the actual application cache entry')
      writeFileSync(join(dir, files[0]!), 'not-json{{{')
      assert.equal(await cache.read('https://ex.com/', 'e1'), undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('formatCacheAge', () => {
  it('分钟/小时/天分级', () => {
    const now = 10_000_000_000
    assert.equal(formatCacheAge(now - 5 * 60_000, now), '5 分钟')
    assert.equal(formatCacheAge(now - 3 * 3_600_000, now), '3 小时')
    assert.equal(formatCacheAge(now - 2 * 86_400_000, now), '2 天')
  })
})
