import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SerplyBackend } from '../serply.js'

const SERPLY_BODY = {
  results: [
    { title: 'Alpha', link: 'https://alpha.example', description: 'a-desc' },
    { title: '', link: 'https://no-title.example', description: 'skipped' },
    { title: 'Beta', link: 'https://beta.example' },
  ],
}

describe('SerplyBackend', () => {
  it('is unavailable without an API key', () => {
    assert.equal(new SerplyBackend(async () => new Response(''), undefined).isAvailable(), false)
    assert.equal(new SerplyBackend(async () => new Response(''), '').isAvailable(), false)
  })

  it('is available with a key', () => {
    assert.equal(new SerplyBackend(async () => new Response(''), 'key').isAvailable(), true)
  })

  it('GETs q + num with X-Api-Key and parses results', async () => {
    let calledUrl = ''
    let headers: Record<string, string> = {}
    const backend = new SerplyBackend(async (url, init) => {
      calledUrl = url
      headers = (init?.headers ?? {}) as Record<string, string>
      return new Response(JSON.stringify(SERPLY_BODY), { status: 200 })
    }, 'serply-key')

    const results = await backend.search('rust async', 3, new AbortController().signal)

    assert.equal(calledUrl, 'https://api.serply.io/v1/search?q=rust+async&num=3')
    assert.equal(headers['X-Api-Key'], 'serply-key')
    assert.deepEqual(results, [
      { title: 'Alpha', url: 'https://alpha.example', snippet: 'a-desc' },
      { title: 'Beta', url: 'https://beta.example', snippet: '' },
    ])
  })

  it('caps num at 10', async () => {
    let calledUrl = ''
    const backend = new SerplyBackend(async (url) => {
      calledUrl = url
      return new Response('{}', { status: 200 })
    }, 'k')
    assert.deepEqual(await backend.search('x', 25, new AbortController().signal), [])
    assert.match(calledUrl, /[?&]num=10$/)
  })

  it('throws on non-ok HTTP', async () => {
    const backend = new SerplyBackend(async () => new Response('', { status: 401 }), 'k')
    await assert.rejects(() => backend.search('x', 3, new AbortController().signal), /HTTP 401/)
  })
})
