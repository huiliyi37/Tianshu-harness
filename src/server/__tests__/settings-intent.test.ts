import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { buildSettingsIntentRoutes, SETTINGS_INTENT_SCHEMA, type SettingsIntentResponse } from '../settings-intent-route.js'

// POST /settings/intent 端点契约（Wave 3，回流自 3.14alpha 2e0109f63）：
//   命中结构 / 未命中结构 / 空文本 400 / 超长 400 / LLM 异常降级 / 非 JSON 降级 /
//   幻觉 key-value 白名单拒绝 / 鉴权 fail-closed 双向 / 噪音前缀取首个 JSON /
//   schema 双源一致（公开仓无 desktop/ 时自动跳过）

const OPTS = {
  getBaseUrl: () => 'https://example.com/v1',
  getApiKey: () => 'k',
  getModel: () => 'm',
  apiToken: 'token',
}

function stubFetch(json: unknown, ok = true): void {
  globalThis.fetch = (async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => json,
  })) as unknown as typeof fetch
}

async function callIntent(text: unknown): Promise<{ status: number; body: SettingsIntentResponse }> {
  const routes = buildSettingsIntentRoutes(OPTS)
  const handler = routes['POST /settings/intent']!
  return handler({ text }, undefined, { authorization: 'Bearer token' }, undefined) as Promise<{ status: number; body: SettingsIntentResponse }>
}

test('LLM 命中：返回 matched+key+value', async () => {
  stubFetch({ choices: [{ message: { content: '{"matched":true,"key":"fontSize","value":"large"}' } }] })
  const r = await callIntent('把界面字调大点')
  assert.equal(r.status, 200)
  assert.equal(r.body.matched, true)
  assert.equal(r.body.key, 'fontSize')
  assert.equal(r.body.value, 'large')
})

test('凭据按请求求值：启动时无 key、热配后能取到新 key（首启场景）', async () => {
  // 首启无 apiKey 降级启动 → 用户在 Settings 配好 key（ctx 整体替换）——按值捕获
  // 会让兜底永远拿空 key；getter 形态必须每次请求读当前值。
  let apiKey = ''
  let seenAuth: string | null = null
  globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    seenAuth = init?.headers?.Authorization ?? null
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"matched":false,"message":"x"}' } }] }) }
  }) as unknown as typeof fetch
  const routes = buildSettingsIntentRoutes({
    getBaseUrl: () => 'https://example.com/v1',
    getApiKey: () => apiKey,
    getModel: () => 'm',
    apiToken: 'token',
  })
  const handler = routes['POST /settings/intent']!
  await handler({ text: '字号调大' }, undefined, { authorization: 'Bearer token' }, undefined)
  assert.equal(seenAuth, 'Bearer ', '启动时按空 key 发请求')
  apiKey = 'fresh-key'
  await handler({ text: '字号调大' }, undefined, { authorization: 'Bearer token' }, undefined)
  assert.equal(seenAuth, 'Bearer fresh-key', '热配的 key 必须生效，不用重启')
})

test('LLM 未命中：返回 matched:false + message', async () => {
  stubFetch({ choices: [{ message: { content: '{"matched":false,"message":"未找到相关设置"}' } }] })
  const r = await callIntent('今天天气如何')
  assert.equal(r.status, 200)
  assert.equal(r.body.matched, false)
  assert.equal(r.body.message, '未找到相关设置')
})

test('空文本：400 空文本', async () => {
  const r = await callIntent('   ')
  assert.equal(r.status, 400)
  assert.equal(r.body.matched, false)
})

test('LLM 异常：降级 matched:false（不 5xx）', async () => {
  stubFetch({}, false) // !res.ok
  const r = await callIntent('随便说点什么')
  assert.equal(r.status, 200)
  assert.equal(r.body.matched, false)
  assert.ok(r.body.message && r.body.message.length > 0)
})

test('LLM 输出非 JSON：降级 matched:false', async () => {
  stubFetch({ choices: [{ message: { content: '抱歉我不懂' } }] })
  const r = await callIntent('随便说点什么')
  assert.equal(r.status, 200)
  assert.equal(r.body.matched, false)
})

test('LLM 幻觉 key/value：服务端 schema 白名单拒绝（防御纵深）', async () => {
  // key 不在 schema
  stubFetch({ choices: [{ message: { content: '{"matched":true,"key":"nonexistentKey","value":"large"}' } }] })
  const r1 = await callIntent('随便改改')
  assert.equal(r1.body.matched, false)
  // key 在 schema 但 value 不在该 entry 的 values 表
  stubFetch({ choices: [{ message: { content: '{"matched":true,"key":"fontSize","value":"gigantic"}' } }] })
  const r2 = await callIntent('把界面字号拉满')
  assert.equal(r2.body.matched, false)
})

test('鉴权：错误 token 401（直测鉴权分支）', async () => {
  const routes = buildSettingsIntentRoutes(OPTS) // 有 apiToken → 鉴权分支
  const handler = routes['POST /settings/intent']!
  const r = (await handler({ text: '把字调大' }, undefined, { authorization: 'Bearer wrong-token' }, undefined)) as { status: number; body: { error?: string } }
  assert.equal(r.status, 401)
  assert.equal(r.body.error, 'Unauthorized')
})

test('fail-closed：未配置 apiToken 时无 Bearer 一律 401（LLM 端点不裸奔）', async () => {
  const routes = buildSettingsIntentRoutes({ ...OPTS, apiToken: undefined })
  const handler = routes['POST /settings/intent']!
  let llmCalled = false
  globalThis.fetch = (async () => {
    llmCalled = true
    return { ok: true, json: async () => ({}) }
  }) as unknown as typeof fetch
  const r = (await handler({ text: '把字调大' }, undefined, undefined, undefined)) as { status: number }
  assert.equal(r.status, 401)
  assert.equal(llmCalled, false, '未过鉴权绝不触发 LLM 调用')
})

test('fail-closed：未配置 apiToken 时带任意 Bearer 同样 401（无后门）', async () => {
  const routes = buildSettingsIntentRoutes({ ...OPTS, apiToken: undefined })
  const handler = routes['POST /settings/intent']!
  const r = (await handler({ text: '把字调大' }, undefined, { authorization: 'Bearer whatever' }, undefined)) as { status: number }
  assert.equal(r.status, 401)
})

test('文本超长：400 拒绝（不进 LLM）', async () => {
  let llmCalled = false
  globalThis.fetch = (async () => {
    llmCalled = true
    throw new Error('should not reach LLM')
  }) as unknown as typeof fetch
  const r = await callIntent('调'.repeat(201))
  assert.equal(r.status, 400)
  assert.equal(r.body.matched, false)
  assert.equal(llmCalled, false)
})

test('LLM 输出含前缀噪音/多 JSON 对象：取第一个完整对象', async () => {
  // 前缀说明文字 + 两个 JSON 对象 → 取第一个（括号深度扫描，非 lastIndexOf 切片）
  stubFetch({
    choices: [{
      message: {
        content: '好的，我来解析。{"matched":true,"key":"fontSize","value":"large"} 这是补充说明 {"a":1}',
      },
    }],
  })
  const r = await callIntent('把字调大')
  assert.equal(r.status, 200)
  assert.equal(r.body.matched, true)
  assert.equal(r.body.key, 'fontSize')
  assert.equal(r.body.value, 'large')
})

test('能力面裁剪留痕：schema 不含主线尚无 setter 的项（lineHeight / fontSizeOffset）', () => {
  // alpha 有这两项、主线没有（排版三轴 B5/B6 属独立回流候选）。谁把桌面 schema
  // 加回来却忘了同步这里，双源一致性用例会红；这条钉住「裁剪是有意的」。
  const keys = SETTINGS_INTENT_SCHEMA.map((e) => e.key) as readonly string[]
  assert.ok(!keys.includes('lineHeight'), 'main 无行高 setter，端点也不该宣称支持')
  assert.ok(!keys.includes('fontSizeOffset'), 'main 无字号微调 API')
  const fontFamily = SETTINGS_INTENT_SCHEMA.find((e) => e.key === 'fontFamily')!
  assert.ok(!(fontFamily.values as readonly string[]).includes('custom'), 'main 无「任意字体输入」')
  const chatFontSize = SETTINGS_INTENT_SCHEMA.find((e) => e.key === 'chatFontSize')!
  assert.ok(!(chatFontSize.values as readonly string[]).includes('17'), 'main 会话字号无 17px 档')
})

const DESKTOP_SCHEMA_URL = new URL('../../../desktop/src/lib/settings-intent/schema.ts', import.meta.url)

test('SCHEMA 双源一致：server SETTINGS_INTENT_SCHEMA 与 desktop schema.ts key+values 对齐', { skip: !existsSync(DESKTOP_SCHEMA_URL) ? '公开仓无 desktop/（闭源面），双源校验仅在开发仓可执行' : false }, () => {
  // desktop 端 schema.ts 的 key 列表与每个 key 的 values 键集合
  const desktopSrc = readFileSync(DESKTOP_SCHEMA_URL, 'utf8')
  const keyMatches = [...desktopSrc.matchAll(/^\s+key: '([a-zA-Z]+)',/gm)].map((m) => m[1])
  const serverKeys = SETTINGS_INTENT_SCHEMA.map((s) => s.key)
  assert.deepEqual(serverKeys.sort(), [...new Set(keyMatches)].sort(), '两端 key 列表必须一致（新增设置项同步双源）')

  for (const entry of SETTINGS_INTENT_SCHEMA) {
    // desktop 端对应 entry 的 values 对象键（引号键如 '12' 与标识符键如 compact 都收；
    // 提取到 4 空格缩进的 values 闭合——避免非贪婪停在第一个 value 项）
    const block = desktopSrc.match(new RegExp(`key: '${entry.key}',[\\s\\S]*?values: \\{([\\s\\S]*?)\\n    \\},`))?.[1] ?? ''
    const desktopValues = [...block.matchAll(/^\s{4,}(?:'([^']+)'|([a-zA-Z][\w-]*)): \{/gm)].map((m) => m[1] ?? m[2])
    assert.deepEqual(
      [...entry.values].sort(),
      desktopValues.sort(),
      `${entry.key} 的 values 两端必须一致（新增档位同步双源）`,
    )
  }
})
