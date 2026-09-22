import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  enforceRequestBodyLimit,
  formatBodyGuardNotice,
  measureBodyBytes,
  formatDegradeNotice,
  RequestBodyTooLargeError,
  formatByteSize,
  GUARD_KEEP_RECENT_MESSAGES,
  GUARD_MIN_TRUNCATABLE_BYTES,
} from '../request-body-guard.js'

// 请求体体积护栏（4MB）——反证表（每条对着一个偷懒实现）：
//   #1「没超限也顺手改一改」    → 断言返回原引用（字节不变，前缀缓存不受影响）
//   #2「截断把当前任务也削了」  → 断言最近 KEEP_RECENT 条与 system 一字不动
//   #3「截完不标注 / 头尾全丢」 → 断言保头保尾 + 标注里点名"超出传输上限"
//   #4「就地改入参」            → 断言原 messages 未被修改（重入安全）
//   #5「每次截得不一样」        → 两次调用产出逐字节相同的体（缓存安全）
//   #6「削不动也硬发」          → 抛 RequestBodyTooLargeError，中文可行动
//   #7「把 user/assistant 也削」→ 断言只动 tool 角色
//   #6b「30KB 显示成 0.0MB」     → 体积分档：KB 档不得出现 0.0MB（issue #251）
//   #6c「没削过也说已截断」      → 无可截内容时文案不得自相矛盾（issue #251）
//   #6d「只数 content/tool_calls」→ 最大来源按整条消息 JSON 计（issue #251）
//   #6e「清单解释不了总量」      → 单条占比过低时明说体积分散（issue #251）
//   #12「默认替用户猜一个上限」  → 未配置 maxBodyBytes 时不量体/不截断（#251 后续）

// 测试用小上限（逻辑与 4MB 同一路径）：16KB 上限 + 40KB 内容，保证「确实超限」
// 且候选大于 GUARD_MIN_TRUNCATABLE_BYTES（默认 8KB）。
const LIMIT = 16 * 1024

function toolMsg(content: string): Record<string, unknown> {
  return { role: 'tool', tool_call_id: 't', content }
}

function baseBody(toolContents: string[], tail: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    model: 'm',
    messages: [
      { role: 'system', content: 'sys' },
      ...toolContents.map(toolMsg),
      ...tail,
    ],
  }
}

test('#1 未超限：返回原引用，字节与降级清单都不动', () => {
  const body = baseBody(['small output'])
  const out = enforceRequestBodyLimit(body, { limitBytes: LIMIT })
  assert.equal(out.body, body, '未超限必须返回原引用（零拷贝、字节不变）')
  assert.deepEqual(out.degraded, [])
  assert.equal(out.bytes, measureBodyBytes(body))
  assert.ok(out.bytes <= LIMIT)
})

test('#2 超限：只截历史 tool 结果，system 与最近 K 条一字不动', () => {
  const big = 'A'.repeat(40 * 1024)
  const recentSmall = 'B'.repeat(1024)
  const tail: Record<string, unknown>[] = [
    { role: 'user', content: 'current task' },
    toolMsg(recentSmall), // 落在最近 KEEP_RECENT 窗口内 → 不许动
  ]
  const body = baseBody([big], tail)
  assert.ok(measureBodyBytes(body) > LIMIT, '前提：该体确实超限')

  // 4 条消息 + 默认窗口 6 会让整段都不可动——这里显式把窗口收窄到 2，
  // 让"历史"确实是历史（默认窗口的语义由 #2b 单独钉）。
  const out = enforceRequestBodyLimit(body, { limitBytes: LIMIT, keepRecentMessages: 2 })
  assert.ok(out.bytes <= LIMIT, `截断后必须落到上限内，实际 ${out.bytes}`)
  assert.equal(out.degraded.length, 1)
  assert.equal(out.degraded[0]!.messageIndex, 1, '被截的是第 1 条（历史 tool）')

  const msgs = out.body.messages as Record<string, unknown>[]
  assert.equal(msgs[0]!.content, 'sys', 'system 不许动')
  assert.equal(msgs[msgs.length - 1]!.content, recentSmall, `最近 ${GUARD_KEEP_RECENT_MESSAGES} 条内的 tool 结果不许动`)
  assert.equal(msgs[msgs.length - 2]!.content, 'current task', '当前任务文本不许动')
})

test('#2b 最近窗口内的巨大 tool 不可动：宁可抛错也不削当前任务的上下文', () => {
  // 会话只有 2 条（system + 一条刚产生的巨大 tool 输出）：默认窗口把它们全划进
  // "最近"，护栏因此无候选可削 → 抛可行动错误。削它才是真正的坏结果：用户正在
  // 处理的那一步被静默抹掉，模型下一轮就答非所问。
  const body = baseBody(['Z'.repeat(40 * 1024)])
  assert.throws(
    () => enforceRequestBodyLimit(body, { limitBytes: LIMIT }),
    (err: unknown) => err instanceof RequestBodyTooLargeError,
  )
  assert.ok(measureBodyBytes(body) > LIMIT)
})

test('#3 截断保头保尾并在体里留可见标注（不是静默降级）', () => {
  const big = `HEAD-MARKER${'x'.repeat(40 * 1024)}TAIL-MARKER`
  const body = baseBody([big])
  const out = enforceRequestBodyLimit(body, { limitBytes: LIMIT, keepRecentMessages: 0 })
  const content = (out.body.messages as Record<string, unknown>[])[1]!.content as string
  assert.ok(content.startsWith('HEAD-MARKER'))
  assert.ok(content.endsWith('TAIL-MARKER'))
  assert.match(content, /已省略约 \d+KB/)
  assert.match(content, /完整输出仍在会话记录\/artifact 里/, '标注要告诉模型/用户内容去哪了')
  assert.match(formatDegradeNotice(out.degraded), /请求体超限降级：截断 1 条/)
})

test('#4 就地改入参是禁区：原 body 与消息对象都不许被改', () => {
  const big = 'C'.repeat(40 * 1024)
  const body = baseBody([big])
  const originalContent = (body.messages as Record<string, unknown>[])[1]!.content
  enforceRequestBodyLimit(body, { limitBytes: LIMIT, keepRecentMessages: 0 })
  assert.equal((body.messages as Record<string, unknown>[])[1]!.content, originalContent, '入参消息必须原样')
  assert.ok(measureBodyBytes(body) > LIMIT, '原体仍是超限的原体')
})

test('#5 确定性：同一输入两次截断逐字节相同（前缀缓存硬要求）', () => {
  const body = baseBody(['D'.repeat(40 * 1024), 'E'.repeat(20 * 1024)])
  const a = JSON.stringify(enforceRequestBodyLimit(body, { limitBytes: LIMIT, keepRecentMessages: 0 }).body)
  const b = JSON.stringify(enforceRequestBodyLimit(body, { limitBytes: LIMIT, keepRecentMessages: 0 }).body)
  assert.equal(a, b)
})

test('#6 削完仍超限：抛可行动的中文错误并点名最大来源', () => {
  // 一条巨大的 user 消息（不许削）+ 一条可削的 tool → 削完依然超限。
  const body = baseBody(['F'.repeat(40 * 1024)], [{ role: 'user', content: 'G'.repeat(120 * 1024) }])
  assert.throws(
    () => enforceRequestBodyLimit(body, { limitBytes: LIMIT }),
    (err: unknown) => {
      assert.ok(err instanceof RequestBodyTooLargeError)
      assert.match(err.message, /超出传输上限/)
      assert.match(err.message, /\/compact/)
      assert.match(err.message, /中转/)
      assert.ok(err.contributors.length > 0, '要附最大来源清单')
      assert.equal(err.contributors[0]!.role, 'user', '最大来源应是那条不许削的 user 消息')
      return true
    },
  )
})

test('#6b 体积分档：KB 档不再四舍五入成 0.0MB（issue #251）', () => {
  assert.equal(formatByteSize(0), '0B')
  assert.equal(formatByteSize(512), '512B')
  assert.equal(formatByteSize(19_456), '19.0KB')
  assert.equal(formatByteSize(30 * 1024), '30.0KB')
  assert.equal(formatByteSize(4.7 * 1024 * 1024), '4.7MB')
})

test('#6c 无可截内容时不许声称「已截断历史工具输出」（issue #251）', () => {
  // 全是 user（无 tool 可削）→ 必须说「无可截断」，不许说「已截断」。
  const noCandidate = baseBody([], [{ role: 'user', content: 'U'.repeat(120 * 1024) }])
  assert.throws(
    () => enforceRequestBodyLimit(noCandidate, { limitBytes: LIMIT }),
    (err: unknown) => {
      assert.ok(err instanceof RequestBodyTooLargeError)
      assert.match(err.message, /已无可截断的历史工具输出/)
      assert.doesNotMatch(err.message, /已截断历史工具输出/)
      return true
    },
  )

  // 真削过历史 tool 还说超限，才允许说「已截断」。
  const truncated = baseBody(['F'.repeat(40 * 1024)], [{ role: 'user', content: 'G'.repeat(120 * 1024) }])
  assert.throws(
    () => enforceRequestBodyLimit(truncated, { limitBytes: LIMIT, keepRecentMessages: 0 }),
    (err: unknown) => {
      assert.ok(err instanceof RequestBodyTooLargeError)
      assert.match(err.message, /已截断历史工具输出仍超限/)
      return true
    },
  )
})

test('#6d 最大来源按整条消息字节计：reasoning_content 不再漏账（issue #251）', () => {
  const body = baseBody([], [
    { role: 'assistant', content: 'ok', reasoning_content: 'R'.repeat(120 * 1024) },
    { role: 'user', content: 'U'.repeat(60 * 1024) },
  ])
  assert.throws(
    () => enforceRequestBodyLimit(body, { limitBytes: LIMIT }),
    (err: unknown) => {
      assert.ok(err instanceof RequestBodyTooLargeError)
      const [top] = err.contributors
      assert.equal(top!.messageIndex, 1, '带 120KB reasoning_content 的 assistant 必须是最大来源')
      assert.ok(top!.bytes > 120 * 1024, `整条消息（含 reasoning_content）应 >120KB，实际 ${top!.bytes}`)
      assert.match(err.message, /messages\[1\] assistant 12\d\.\dKB/)
      assert.doesNotMatch(err.message, /0\.0MB/)
      return true
    },
  )
})

test('#6e 单条最大不足总量一成：明说「体积分散」而不是给一份解释不了的清单（issue #251）', () => {
  // 复刻 #251 的形状：230+ 条 19KB 消息共 >4MB，单条最大不足 1%。
  const messages: Record<string, unknown>[] = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 230; i++) {
    messages.push({ role: i % 2 ? 'user' : 'assistant', content: 'M'.repeat(19 * 1024) })
  }
  assert.throws(
    () => enforceRequestBodyLimit({ model: 'm', messages }, { limitBytes: 4 * 1024 * 1024 }),
    (err: unknown) => {
      assert.ok(err instanceof RequestBodyTooLargeError)
      assert.match(err.message, /请求体 4\.\dMB 超出传输上限 4\.0MB/)
      assert.match(err.message, /体积分散在多条消息里/)
      assert.match(err.message, /不足 1%/)
      assert.doesNotMatch(err.message, /0\.0MB/)
      return true
    },
  )
})

test('#7 只削 tool：user / assistant 内容一律不动', () => {
  const body = baseBody(
    ['H'.repeat(40 * 1024)],
    [{ role: 'user', content: 'I'.repeat(20 * 1024) }, { role: 'assistant', content: 'J'.repeat(20 * 1024) }],
  )
  // 上限取 56KB：原体 80KB 超限，削掉历史 tool 的 37KB 后 ≈43KB 恰好落进来——
  // 而"不许削的 user+assistant"（40KB）必须原样留下，正是这条要钉的语义。
  const out = enforceRequestBodyLimit(body, { limitBytes: 56 * 1024, keepRecentMessages: 2 })
  const msgs = out.body.messages as Record<string, unknown>[]
  assert.equal(msgs[2]!.content, 'I'.repeat(20 * 1024))
  assert.equal(msgs[3]!.content, 'J'.repeat(20 * 1024))
  assert.ok(out.degraded.every((d) => d.messageIndex === 1))
})

test('#8 小于最小可截体积的 tool 结果不动（省不出多少，徒增缓存扰动）', () => {
  const small = 'K'.repeat(Math.floor(GUARD_MIN_TRUNCATABLE_BYTES / 2))
  // 用极小上限逼出"需要截断"的状态，但候选都太小 → 只能抛错
  assert.throws(() => enforceRequestBodyLimit(baseBody([small]), { limitBytes: 1024 }))
  const out = enforceRequestBodyLimit(baseBody([small]), { limitBytes: LIMIT })
  assert.deepEqual(out.degraded, [])
})

test('#9 逼近上限（未超限）：给出 nearLimit 警示而不是沉默', () => {
  // 1.2MB 体 / 2MB 上限（>50%）：还没到截断线，但第三方中转常有更小的上限——提前提醒。
  const big = 'N'.repeat(1_200_000)
  const body = baseBody([big])
  const out = enforceRequestBodyLimit(body, { limitBytes: 2 * 1024 * 1024 })
  assert.deepEqual(out.degraded, [], '未超限不许截断')
  assert.ok(out.nearLimit, '超过一半上限要给出 nearLimit')
  assert.equal(out.nearLimit!.bytes, out.bytes)
})

test('#10 远低于上限：既无降级也无 nearLimit（不许打扰用户）', () => {
  const out = enforceRequestBodyLimit(baseBody(['tiny']), { limitBytes: 2 * 1024 * 1024 })
  assert.equal(out.nearLimit, undefined)
  assert.deepEqual(out.degraded, [])
})

test('#11 降级通知文案：两种形态都点名下一步动作', () => {
  const degraded = formatBodyGuardNotice({ kind: 'degraded', bytes: 4_400_000, limitBytes: 4_194_304, degradedCount: 3, removedBytes: 120 * 1024 })
  assert.match(degraded, /已截断 3 条历史工具输出/)
  assert.match(degraded, /\/compact/)
  assert.match(degraded, /模型看不到被截断的原文/)

  const near = formatBodyGuardNotice({ kind: 'near-limit', bytes: 2_200_000, limitBytes: 4_194_304 })
  assert.match(near, /接近传输上限/)
  assert.match(near, /中转/)
  assert.match(near, /\/compact/)
})

test('#12 默认不启用护栏：不量体、不截断、原引用直通（issue #251 后续）', () => {
  // 5MB 的体 + 未配置 maxBodyBytes：必须零成本放行，而不是替用户猜一个上限。
  const body = baseBody(['M'.repeat(5 * 1024 * 1024)])
  const out = enforceRequestBodyLimit(body)
  assert.equal(out.body, body, '未配置上限：原引用直通')
  assert.equal(out.bytes, 0, '未启用时不做量体（量体要对整段 body 再 stringify 一遍）')
  assert.equal(out.limitBytes, Number.POSITIVE_INFINITY)
  assert.deepEqual(out.degraded, [])
  assert.equal(out.nearLimit, undefined, '未启用护栏不得产生 near-limit 预警')
})
