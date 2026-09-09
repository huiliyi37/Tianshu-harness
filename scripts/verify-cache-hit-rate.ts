#!/usr/bin/env tsx
/**
 * 冰鉴缓存命中率验证脚本
 *
 * 模拟 5 轮对话，记录每轮的 cache hit/miss tokens。
 * 用法：
 *   ./node_modules/.bin/tsx scripts/verify-cache-hit-rate.ts
 *
 * 需要环境变量：
 *   DEEPSEEK_API_KEY — DeepSeek API key
 *   DEEPSEEK_BASE_URL — (可选) 默认 https://api.deepseek.com
 *   DEEPSEEK_MODEL — (可选) 模型名，默认 deepseek-chat（3.15 回流验证用 deepseek-v4-flash）
 */

import { PromptEngine } from '../src/prompt/engine.js'
import { createVolatileSnapshot } from '../src/prompt/volatile-snapshot.js'
import { stableStringify } from '../src/api/stable-json.js'
import type { OaiMessage } from '../src/api/oai-types.js'

const API_KEY = process.env.DEEPSEEK_API_KEY
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'

if (!API_KEY) {
  console.error('❌ 需要设置 DEEPSEEK_API_KEY 环境变量')
  process.exit(1)
}

// ── 工具定义（最小集） ──────────────────────────────────────────

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file',
    input_schema: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'bash',
    description: 'Run a shell command',
    input_schema: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] },
  },
]

const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'

// ── PromptEngine 初始化 ─────────────────────────────────────────

const cwd = process.cwd()
const snapshot = createVolatileSnapshot({ cwd })

const engine = new PromptEngine({
  model: MODEL,
  maxTokens: 1024,
  staticCtx: { tools: TOOLS },
  volatileCtx: snapshot,
})

// ── 模拟对话 ────────────────────────────────────────────────────

interface TurnResult {
  turn: number
  prompt: string
  inputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  hitRate: string
  outputTokens: number
  prefixStable: boolean
}

const results: TurnResult[] = []
const conversationMessages: OaiMessage[] = []

const PROMPTS = [
  '你好，介绍一下你自己',
  '读一下 package.json 的内容',
  '这个项目用了什么技术栈',
  '解释一下 src/prompt/engine.ts 的作用',
  '总结一下我们刚才的对话',
  'src/prompt/volatile-snapshot.ts 的职责是什么',
  'src/cache 目录下有哪些文件',
  'tool-pipeline.ts 的入口怎么找',
  '这个仓库的测试怎么跑',
  'loop.ts 和 coordinator.ts 的分工',
  '怎么看会话的缓存命中率',
  '列出最近 5 个提交',
  'src/tools 下最大的文件是哪个',
  'AGENTS.md 里缓存排查指南讲什么',
  '解释一下 createVolatileSnapshot 的输入',
  'src/server 的入口在哪个文件',
  'describe 一下 block-policy 的三个档位',
  '这个项目用什么测试框架',
  'frozenUserMerged 是做什么的',
  '我们的会话数据存在哪里',
]

const CONTEXT_WINDOW = 128_000

// 上一轮请求各消息的规范化字节（前缀稳定性 = 上一轮消息序列是本轮的字节前缀）
let prevMessageBytes: string[] = []

async function sendTurn(turn: number, userText: string): Promise<TurnResult> {
  // 添加 user 消息
  conversationMessages.push({ role: 'user', content: userText })

  // 构建请求（走生产同一条路径：frozen base + appendixDelta + 边界合并）。
  // DeepSeek 是 OpenAI 兼容端点：system prompt 就在 messages[0]，不做顶层剥离。
  const request = engine.buildOaiRequest(conversationMessages, undefined, CONTEXT_WINDOW)

  // 前缀稳定性：上一轮发出的消息序列必须是本轮的逐字节前缀
  // （前缀缓存命中的充要条件——比对规范化后的每条消息字节）
  const messageBytes = request.messages.map(m => stableStringify(m))
  let prefixStable = true
  if (turn > 1) {
    prefixStable = prevMessageBytes.length < messageBytes.length
      && prevMessageBytes.every((bytes, i) => bytes === messageBytes[i])
  }
  prevMessageBytes = messageBytes

  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: stableStringify({
      model: MODEL,
      messages: request.messages,
      max_tokens: 256,
      stream: false,
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`API ${response.status}: ${err.slice(0, 200)}`)
  }

  const data = await response.json() as {
    choices: Array<{ message: { role: string; content: string } }>
    usage: {
      prompt_tokens: number
      completion_tokens: number
      prompt_cache_hit_tokens?: number
      prompt_cache_miss_tokens?: number
    }
  }

  const usage = data.usage
  const cacheHit = usage.prompt_cache_hit_tokens ?? 0
  const cacheMiss = usage.prompt_cache_miss_tokens ?? 0
  const total = cacheHit + cacheMiss
  const hitRate = total > 0 ? (cacheHit / total * 100).toFixed(1) : '0.0'

  // 添加 assistant 回复到对话
  const assistantText = data.choices[0]?.message?.content ?? ''
  conversationMessages.push({ role: 'assistant', content: assistantText })

  return {
    turn,
    prompt: userText.slice(0, 30),
    inputTokens: usage.prompt_tokens,
    cacheHitTokens: cacheHit,
    cacheMissTokens: cacheMiss,
    hitRate: `${hitRate}%`,
    outputTokens: usage.completion_tokens,
    prefixStable,
  }
}

// ── 主流程 ──────────────────────────────────────────────────────

async function main() {
  console.log('🧊 冰鉴缓存验证 — 5 轮对话测试')
  console.log(`   Provider: DeepSeek (${BASE_URL})`)
  console.log(`   Model: ${MODEL}`)
  console.log(`   Volatile snapshot gitStatus: ${snapshot.gitStatus ? '✅ captured' : '⚠️ empty'}`)
  console.log('')

  for (let i = 0; i < PROMPTS.length; i++) {
    process.stdout.write(`Turn ${i + 1}: "${PROMPTS[i]!.slice(0, 25)}..." `)

    try {
      const result = await sendTurn(i + 1, PROMPTS[i]!)
      results.push(result)
      console.log(
        `→ hit: ${result.cacheHitTokens.toLocaleString()} / miss: ${result.cacheMissTokens.toLocaleString()} ` +
        `= ${result.hitRate} ${result.prefixStable ? '🔒' : '⚠️ prefix changed'}`
      )
    } catch (err) {
      console.log(`→ ❌ ${(err as Error).message}`)
      break
    }

    // 等 1 秒让 DeepSeek 缓存写入
    await new Promise(r => setTimeout(r, 1000))
  }

  // ── 结果表格 ──────────────────────────────────────────────────

  console.log('')
  console.log('┌──────┬────────────────────────────────┬────────────┬───────────┬───────────┬──────────┬────────┐')
  console.log('│ Turn │ Prompt                         │ Input Tkns │ Cache Hit │ Cache Miss│ Hit Rate │ Prefix │')
  console.log('├──────┼────────────────────────────────┼────────────┼───────────┼───────────┼──────────┼────────┤')

  for (const r of results) {
    const prompt = r.prompt.padEnd(30).slice(0, 30)
    const input = r.inputTokens.toLocaleString().padStart(10)
    const hit = r.cacheHitTokens.toLocaleString().padStart(9)
    const miss = r.cacheMissTokens.toLocaleString().padStart(9)
    const rate = r.hitRate.padStart(8)
    const prefix = r.prefixStable ? '  🔒  ' : '  ⚠️  '
    console.log(`│  ${r.turn}   │ ${prompt} │ ${input} │ ${hit} │ ${miss} │ ${rate} │${prefix}│`)
  }

  console.log('└──────┴────────────────────────────────┴────────────┴───────────┴───────────┴──────────┴────────┘')

  // ── 总结 ──────────────────────────────────────────────────────

  if (results.length >= 2) {
    // 主指标 = 收敛段（末 5 轮）累计命中率——短会话早期轮（input 小、单次
    // user 边界注入占比大）会系统性拉低 Turn 2+ 均值；miss 每轮近似恒定、
    // input 线性增长，命中率单调收敛——收敛段才是可跨版本对照的稳态值
    // （v0/v1 基线对照用，2026-09-06）。
    const convergence = results.slice(-5)
    const turn2Plus = results.slice(1)
    const agg = (rs: typeof results) => {
      const totalHit = rs.reduce((s, r) => s + r.cacheHitTokens, 0)
      const totalMiss = rs.reduce((s, r) => s + r.cacheMissTokens, 0)
      return totalHit + totalMiss > 0 ? (totalHit / (totalHit + totalMiss) * 100).toFixed(1) : '0.0'
    }
    const convRate = agg(convergence)
    const totalRate = agg(turn2Plus)
    const allPrefixStable = turn2Plus.every(r => r.prefixStable)

    console.log('')
    console.log(`📊 收敛段(末5轮)命中率: ${convRate}%   |   Turn 2+ 平均: ${totalRate}%`)
    console.log(`🔒 前缀稳定性: ${allPrefixStable ? '全部稳定 ✅' : '存在不稳定 ⚠️'}`)
    console.log(`🎯 对照判据: 收敛段 ≥ 90% (健康) / ≥ 95% (优秀)；v0/v1 对照看 Δ`)

    const rate = parseFloat(convRate)
    if (rate >= 95) console.log('✅ 优秀 — 收敛段命中率 ≥95%，缓存健康')
    else if (rate >= 90) console.log('✅ 健康 — 收敛段命中率 ≥90%')
    else if (rate >= 80) console.log('⚠️ 关注 — 收敛段 ≥80% 但未达健康线，查注入成本')
    else console.log('❌ 偏低 — 收敛段 <80%，缓存可能碎裂或注入异常')
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
