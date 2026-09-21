/**
 * sidecar CORS 白名单。
 *
 * 白名单是 fail-closed 的安全刹车（Bearer token 若泄入网页可达上下文，通配 `*`
 * 会把它交给任意站点读取）——所以默认**只反射已知 webview 来源**，未知来源不下发
 * CORS 头。新增的 env 追加口只用于开发（把非默认端口的 vite dev 加进来），
 * 未设置时行为与从前完全一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allowedCorsOrigin } from '../cors.js'

test('反射已知 webview 来源', () => {
  assert.equal(allowedCorsOrigin({ origin: 'tauri://localhost' }), 'tauri://localhost')
  assert.equal(allowedCorsOrigin({ origin: 'http://tauri.localhost' }), 'http://tauri.localhost')
  assert.equal(allowedCorsOrigin({ origin: 'http://localhost:5273' }), 'http://localhost:5273')
})

test('未知来源不下发 CORS 头（fail-closed）', () => {
  assert.equal(allowedCorsOrigin({ origin: 'http://localhost:5374' }), undefined)
  assert.equal(allowedCorsOrigin({ origin: 'https://evil.example' }), undefined)
})

test('无 Origin 头（Rust 壳 / CLI）不下发 CORS 头', () => {
  assert.equal(allowedCorsOrigin({}), undefined)
})

test('env 追加口：设置后额外来源被反射', () => {
  const env = { RIVET_DEV_CORS_ORIGINS: 'http://localhost:5374,http://localhost:5375' }
  assert.equal(allowedCorsOrigin({ origin: 'http://localhost:5374' }, env), 'http://localhost:5374')
  assert.equal(allowedCorsOrigin({ origin: 'http://localhost:5375' }, env), 'http://localhost:5375')
  // 不在追加列表里的仍然拒绝
  assert.equal(allowedCorsOrigin({ origin: 'http://localhost:5376' }, env), undefined)
})

test('env 追加口：未设置时保持原有白名单（默认行为不变）', () => {
  assert.equal(allowedCorsOrigin({ origin: 'http://localhost:5374' }, {}), undefined)
  assert.equal(allowedCorsOrigin({ origin: 'http://localhost:5273' }, {}), 'http://localhost:5273')
})

test('env 追加口：空白项与多余分隔符被忽略，不产生空串白名单', () => {
  const env = { RIVET_DEV_CORS_ORIGINS: '  http://localhost:5374 , , ' }
  assert.equal(allowedCorsOrigin({ origin: 'http://localhost:5374' }, env), 'http://localhost:5374')
  assert.equal(allowedCorsOrigin({ origin: '' }, env), undefined)
})
