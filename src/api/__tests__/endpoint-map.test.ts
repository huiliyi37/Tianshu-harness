import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBaseUrl, resolveProbeEndpoints, PROVIDER_ENDPOINT_MAP, DEFAULT_ENDPOINT_PATHS } from '../endpoint-map.js'

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes', () => {
    assert.equal(normalizeBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1')
  })

  it('strips a pasted chat-completions tail (with and without /v1)', () => {
    assert.equal(normalizeBaseUrl('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1')
    assert.equal(normalizeBaseUrl('https://host.com/chat/completions'), 'https://host.com')
  })

  it('strips models/messages/embeddings tails', () => {
    assert.equal(normalizeBaseUrl('https://host.com/v1/models'), 'https://host.com/v1')
    assert.equal(normalizeBaseUrl('https://host.com/v1/messages'), 'https://host.com/v1')
    assert.equal(normalizeBaseUrl('https://host.com/embeddings'), 'https://host.com')
  })

  // issue #239：Responses 协议 onboarding 时用户最常粘贴完整 /v1/responses。
  // 不剥尾巴，发送路径会拼成 …/responses/responses（404）。
  it('strips a pasted responses tail', () => {
    assert.equal(normalizeBaseUrl('https://api.openai.com/v1/responses'), 'https://api.openai.com/v1')
    assert.equal(normalizeBaseUrl('https://host.com/responses'), 'https://host.com')
  })

  // issue #8：用户注册生图 provider 时，最自然的动作是从 provider 文档复制完整请求
  // URL（如 SiliconFlow 的 …/v1/images/generations）粘进 base URL 字段。若不剥这个
  // 尾巴，后续拼接会得到 …/images/generations/models → 404，而报错只说 "path may be
  // wrong"，用户无法自行定位。
  it('strips a pasted images/generations tail (image-gen provider onboarding)', () => {
    assert.equal(normalizeBaseUrl('https://api.siliconflow.com/v1/images/generations'), 'https://api.siliconflow.com/v1')
    assert.equal(normalizeBaseUrl('https://host.com/images/generations'), 'https://host.com')
  })

  it('leaves clean bases untouched', () => {
    assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1')
    assert.equal(normalizeBaseUrl('http://localhost:3000/api'), 'http://localhost:3000/api')
  })
})

describe('resolveProbeEndpoints', () => {
  it('version-in-base: appends default paths directly', () => {
    const r = resolveProbeEndpoints('https://api.openai.com/v1')
    assert.equal(r.modelsUrl, 'https://api.openai.com/v1/models')
    assert.equal(r.chatUrl, 'https://api.openai.com/v1/chat/completions')
    assert.equal(r.responsesUrl, 'https://api.openai.com/v1/responses')
  })

  it('responses URL shares the same base normalization (issue #239)', () => {
    const r = resolveProbeEndpoints('https://api.openai.com/v1/responses')
    assert.equal(r.responsesUrl, 'https://api.openai.com/v1/responses')
    assert.equal(r.chatUrl, 'https://api.openai.com/v1/chat/completions')
  })

  it('version-less base (oneapi-style): inserts /v1 before the paths', () => {
    const r = resolveProbeEndpoints('http://localhost:3000/api')
    assert.equal(r.modelsUrl, 'http://localhost:3000/api/v1/models')
    assert.equal(r.chatUrl, 'http://localhost:3000/api/v1/chat/completions')
  })

  it('user pasted the full chat URL: never double-appends', () => {
    const r = resolveProbeEndpoints('https://api.openai.com/v1/chat/completions')
    assert.equal(r.base, 'https://api.openai.com/v1')
    assert.equal(r.modelsUrl, 'https://api.openai.com/v1/models')
    assert.equal(r.chatUrl, 'https://api.openai.com/v1/chat/completions')
  })

  it('user pasted a models URL tail: list probe does not hit …/models/models', () => {
    const r = resolveProbeEndpoints('https://host.com/v1/models')
    assert.equal(r.modelsUrl, 'https://host.com/v1/models')
  })

  // issue #8：生图 onboarding 需要探测 /images/generations，必须复用同一套 base
  // 归一化——否则粘贴完整生图 URL 的用户会拿到 …/images/generations/models。
  it('resolves the images endpoint, sharing the same base normalization', () => {
    assert.equal(
      resolveProbeEndpoints('https://api.siliconflow.com/v1').imagesUrl,
      'https://api.siliconflow.com/v1/images/generations',
    )
    assert.equal(
      resolveProbeEndpoints('http://localhost:3000/api').imagesUrl,
      'http://localhost:3000/api/v1/images/generations',
    )
    const pasted = resolveProbeEndpoints('https://api.siliconflow.com/v1/images/generations')
    assert.equal(pasted.base, 'https://api.siliconflow.com/v1')
    assert.equal(pasted.imagesUrl, 'https://api.siliconflow.com/v1/images/generations')
  })

  it('unknown providers fall back to the OpenAI-compatible default', () => {
    const r = resolveProbeEndpoints('https://my-relay.example.com/v1', 'totally-unknown')
    assert.equal(r.chatUrl, 'https://my-relay.example.com/v1/chat/completions')
  })

  it('per-provider overrides win over defaults', () => {
    PROVIDER_ENDPOINT_MAP['override-fixture'] = { models: '/list' }
    try {
      const r = resolveProbeEndpoints('https://host.com/v1', 'override-fixture')
      assert.equal(r.modelsUrl, 'https://host.com/v1/list')
      assert.equal(r.chatUrl, `https://host.com/v1${DEFAULT_ENDPOINT_PATHS.chat}`)
    } finally {
      delete PROVIDER_ENDPOINT_MAP['override-fixture']
    }
  })
})
