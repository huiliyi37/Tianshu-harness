import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GREETING_LLM_TIMEOUT_MS,
  generateGreetingLlm,
  greetingTimeSlot,
  pickGreetingTemplate,
} from '../greeting.js'

// ── 时段分区 ─────────────────────────────────────────────────────────

test('时段分区边界:5 晨 / 11 午 / 14 午後 / 18 晚 / 23 深夜', () => {
  assert.equal(greetingTimeSlot(5), 'morning')
  assert.equal(greetingTimeSlot(10), 'morning')
  assert.equal(greetingTimeSlot(11), 'noon')
  assert.equal(greetingTimeSlot(13), 'noon')
  assert.equal(greetingTimeSlot(14), 'afternoon')
  assert.equal(greetingTimeSlot(17), 'afternoon')
  assert.equal(greetingTimeSlot(18), 'evening')
  assert.equal(greetingTimeSlot(22), 'evening')
  assert.equal(greetingTimeSlot(23), 'night')
  assert.equal(greetingTimeSlot(0), 'night')
  assert.equal(greetingTimeSlot(4), 'night')
})

test('算法模板:任何小时都有非空短文案(≤25 字)', () => {
  for (const hour of [0, 5, 9, 11, 14, 18, 23]) {
    const t = pickGreetingTemplate(hour)
    assert.ok(t.length > 0, `hour=${hour} 有文案`)
    assert.ok(t.length <= 25, `hour=${hour} 模板过长:${t}`)
  }
})

test('语气池(主题风格化):playful/tech 各时段非空 ≤25 字,且与 default 池有实差', () => {
  for (const voice of ['playful', 'tech'] as const) {
    for (const hour of [5, 9, 12, 15, 20, 23]) {
      const t = pickGreetingTemplate(hour, voice)
      assert.ok(t.length > 0, `${voice} hour=${hour} 有文案`)
      assert.ok(t.length <= 25, `${voice} hour=${hour} 过长:${t}`)
    }
    // 差异抽查:default 池抽样 20 次近似其全集,voice 抽样 12 次——若 voice 池
    // 被误抄成 default(复制回归),voice 样本必全落在 default 集内,断言可抓。
    const defaultSet = new Set(Array.from({ length: 20 }, () => pickGreetingTemplate(9)))
    const voiceSamples = Array.from({ length: 12 }, () => pickGreetingTemplate(9, voice as 'playful' | 'tech'))
    assert.ok(voiceSamples.some((t) => !defaultSet.has(t)), `${voice} 池与 default 池应有差异文案`)
  }
})

// ── LLM 生成(mock fetch) ────────────────────────────────────────────

interface FetchArgs { url: string; init: RequestInit }

function stubFetch(impl: (args: FetchArgs) => Promise<Response> | Response): void {
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    impl({ url: String(input), init: init ?? {} })) as typeof fetch
  ;(globalThis as { __origFetch?: typeof fetch }).__origFetch = orig
}

function restoreFetch(): void {
  const orig = (globalThis as { __origFetch?: typeof fetch }).__origFetch
  if (orig) globalThis.fetch = orig
}

const okJson = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } })

test('LLM 成功:返回 content trim', async () => {
  stubFetch(() => okJson({ choices: [{ message: { content: '  晚上好，今天想修点什么？  ' } }] }))
  try {
    const r = await generateGreetingLlm('https://api.example.com/v1', 'k', 'flash', 20, 'zh-CN', { timeoutMs: 100 })
    assert.equal(r, '晚上好，今天想修点什么？')
  } finally {
    restoreFetch()
  }
})

test('LLM 非 2xx / 缺 choices / 空 content / 超长 → null', async () => {
  stubFetch(() => new Response('denied', { status: 401 }))
  try {
    assert.equal(await generateGreetingLlm('u', 'k', 'm', 9, 'zh-CN', { timeoutMs: 100 }), null, '非 2xx')
  } finally {
    restoreFetch()
  }
  stubFetch(() => okJson({}))
  try {
    assert.equal(await generateGreetingLlm('u', 'k', 'm', 9, 'zh-CN', { timeoutMs: 100 }), null, '缺 choices')
  } finally {
    restoreFetch()
  }
  stubFetch(() => okJson({ choices: [{ message: { content: '   ' } }] }))
  try {
    assert.equal(await generateGreetingLlm('u', 'k', 'm', 9, 'zh-CN', { timeoutMs: 100 }), null, '空 content')
  } finally {
    restoreFetch()
  }
  stubFetch(() => okJson({ choices: [{ message: { content: '长'.repeat(60) } }] }))
  try {
    assert.equal(await generateGreetingLlm('u', 'k', 'm', 9, 'zh-CN', { timeoutMs: 100 }), null, '超长弃用(>50)')
  } finally {
    restoreFetch()
  }
})

test('LLM 网络异常:静默 null + onError 回调', async () => {
  stubFetch(() => { throw new Error('ECONNRESET') })
  let seen: unknown = null
  try {
    const r = await generateGreetingLlm('u', 'k', 'm', 9, 'zh-CN', { timeoutMs: 100, onError: (e) => { seen = e } })
    assert.equal(r, null)
    assert.ok(seen instanceof Error && seen.message === 'ECONNRESET', 'onError 收到原始异常')
  } finally {
    restoreFetch()
  }
})

test('LLM 超时:abort 后 null(可测性:参数化 timeoutMs)', async () => {
  stubFetch(({ init }) => new Promise<Response>((_resolve, reject) => {
    // 尊重调用方 AbortSignal——abort 时 reject,不真等 3s
    init.signal?.addEventListener('abort', () => reject(new Error('Aborted')))
  }))
  try {
    const t0 = Date.now()
    const r = await generateGreetingLlm('u', 'k', 'm', 9, 'zh-CN', { timeoutMs: 80 })
    assert.equal(r, null, '超时返回 null')
    assert.ok(Date.now() - t0 < GREETING_LLM_TIMEOUT_MS, '参数化超时生效,未等默认 3s')
  } finally {
    restoreFetch()
  }
})

test('请求体:model/messages/max_tokens/temperature 契约锁定', async () => {
  let captured: FetchArgs | null = null
  stubFetch((args) => { captured = args; return okJson({ choices: [{ message: { content: '早安' } }] }) })
  try {
    await generateGreetingLlm('https://api.example.com/v1', 'secret-key', 'deepseek-v4-flash', 8, 'zh-CN', { timeoutMs: 100 })
    // 注:captured 仅在 stub 闭包内赋值,TS 保留初始 null 窄化——读取需非空断言(探针实证)。
    assert.equal(captured!.url, 'https://api.example.com/v1/chat/completions')
    const body = JSON.parse(String(captured!.init.body)) as {
      model: string; max_tokens: number; temperature: number; messages: Array<{ role: string; content: string }>
    }
    assert.equal(body.model, 'deepseek-v4-flash')
    assert.equal(body.max_tokens, 64)
    assert.equal(body.temperature, 0.9)
    assert.equal(body.messages[0]?.role, 'system')
    assert.ok(body.messages[0]?.content.includes('8点左右'), 'system prompt 带时段')
    assert.equal((captured!.init.headers as Record<string, string>)['Authorization'], 'Bearer secret-key')
  } finally {
    restoreFetch()
  }
})

// ── 出站身份头(OpenCode Go 强制 x-opencode-session) ──────────────
// 欢迎语走 chat/completions,漏会话头会被上游 400;此处静默降级成模板池,
// 用户侧只看到"问候语永远是那几句",不会看到报错——所以必须有断言钉住。

test('欢迎语请求带出站身份头:OpenCode Go 的会话头与专属 UA', async () => {
  const seen: Record<string, string>[] = []
  stubFetch(({ init }) => {
    seen.push((init.headers ?? {}) as Record<string, string>)
    return okJson({ choices: [{ message: { content: '晚上好' } }] })
  })
  try {
    const r = await generateGreetingLlm('https://opencode.ai/zen/go/v1', 'sk-k', 'deepseek-v4-flash', 20, 'zh-CN', { timeoutMs: 100 })
    assert.equal(r, '晚上好')
    assert.equal(seen[0]?.['x-opencode-session'], 'tianshu-greeting')
    assert.match(seen[0]?.['User-Agent'] ?? '', /^tianshu-tui\//)
  } finally {
    restoreFetch()
  }
})

test('非 OpenCode 端点不受影响:欢迎语不带该头', async () => {
  const seen: Record<string, string>[] = []
  stubFetch(({ init }) => {
    seen.push((init.headers ?? {}) as Record<string, string>)
    return okJson({ choices: [{ message: { content: '你好' } }] })
  })
  try {
    await generateGreetingLlm('https://api.deepseek.com/v1', 'k', 'm', 9, 'zh-CN', { timeoutMs: 100 })
    assert.equal(seen[0]?.['x-opencode-session'], undefined)
  } finally {
    restoreFetch()
  }
})
