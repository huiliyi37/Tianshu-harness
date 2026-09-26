#!/usr/bin/env tsx
/**
 * Task A · 多 tool turn 长任务（基础验证）
 *
 * 模拟模型自动跑 10+ 个 tool calls 的场景。
 * 直接使用 OpenAI 格式发送给 DeepSeek API（绕过 PromptEngine 的 Anthropic 格式转换）。
 * 验证：每个 tool turn 的 cache hit rate 是否稳定在 80%+。
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-xxx ./node_modules/.bin/tsx scripts/verify-task-a-multi-tool.ts
 */

import { ArtifactStore } from '../src/artifact/store.js'
import { SessionStateManager } from '../src/agent/session-state.js'
import { summarizeFileContent, summarizeGrepResult } from '../src/artifact/summarize.js'
import { stableStringify } from '../src/api/stable-json.js'
import { readFileSync, existsSync, mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'

const API_KEY = process.env.DEEPSEEK_API_KEY
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
if (!API_KEY) { console.error('❌ DEEPSEEK_API_KEY required'); process.exit(1) }

const CWD = process.cwd()

// ── Setup ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a coding assistant. Use the provided tools to explore the codebase. Be concise. Call one tool at a time.`

const TOOLS = [
  { type: 'function', function: { name: 'grep', description: 'Search files by pattern', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern', 'path'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } },
  { type: 'function', function: { name: 'read_section', description: 'Read lines from a previously loaded artifact', parameters: { type: 'object', properties: { artifact_id: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['artifact_id', 'start_line', 'end_line'] } } },
]

const artifactDir = mkdtempSync(join(tmpdir(), 'rivet-task-a-'))
const artifactStore = new ArtifactStore(artifactDir, 'task-a-session')
const sessionState = new SessionStateManager('task-a-session')

// ── Tool execution ──────────────────────────────────────────────

async function executeGrep(pattern: string, path: string): Promise<string> {
  const absPath = path.startsWith('/') ? path : join(CWD, path)
  return new Promise((resolve) => {
    const child = execFile('grep', ['-rn', pattern, absPath], { encoding: 'utf-8', timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error && !stdout) {
        resolve('No matches found.')
        return
      }

      const lines = stdout.split('\n').filter(Boolean).slice(0, 30)
      resolve(lines.length > 0 ? `${lines.join('\n')}\n` : 'No matches found.')
    })

    child.on('error', () => resolve('No matches found.'))
  })
}

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'grep') {
    const raw = await executeGrep(input.pattern as string, input.path as string)
    const { summary } = summarizeGrepResult(raw, input.pattern as string)
    const artifactId = await artifactStore.save({ tool: 'grep', target: input.path as string, rawContent: raw, summary, sections: [] })
    return `[artifact:${artifactId}] ${summary}\nUse read_section to expand.`
  }
  if (name === 'read_file') {
    const filePath = input.file_path as string
    const absPath = filePath.startsWith('/') ? filePath : join(CWD, filePath)
    if (!existsSync(absPath)) return `Error: File not found: ${absPath}`
    const stat = statSync(absPath)
    if (stat.isDirectory()) return `Error: ${absPath} is a directory, not a file.`
    if (stat.size > 100_000) return `Error: File too large (${stat.size} bytes). Use grep to find specific content.`
    const raw = readFileSync(absPath, 'utf-8')
    const { summary, sections } = summarizeFileContent(raw, filePath)
    const artifactId = await artifactStore.save({ tool: 'read_file', target: filePath, rawContent: raw, summary, sections })
    sessionState.trackFileRead(filePath, artifactId)
    return `[artifact:${artifactId}] ${summary}\nUse read_section("${artifactId}", startLine, endLine) to expand.`
  }
  if (name === 'read_section') {
    const content = await artifactStore.readLines(input.artifact_id as string, input.start_line as number, input.end_line as number)
    return content ?? `Error: Artifact not found: ${input.artifact_id}`
  }
  return 'Unknown tool'
}

// ── OpenAI-format message management ────────────────────────────

type OaiMessage = { role: string; content?: string | null; tool_calls?: any[]; tool_call_id?: string }
const messages: OaiMessage[] = []

interface TurnStats { turn: number; toolCalls: number; inputTokens: number; cacheHit: number; cacheMiss: number; hitRate: string }
const allStats: TurnStats[] = []

// Track frozen volatile suffix per user-message index (mimics engine.ts cachedFreshForUser)
const frozenUserSuffixes = new Map<number, string>()

async function callApi(turnLabel: number): Promise<{ text: string; toolCalls: any[] | null; stats: TurnStats }> {
  const stateBlock = sessionState.renderForVolatile()

  // Mimic Rivet's cachedFreshForUser: freeze suffix on first send of each user msg.
  const apiMessages: typeof messages = []
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') { lastUserIdx = i; break }
  }

  if (lastUserIdx >= 0 && !frozenUserSuffixes.has(lastUserIdx)) {
    frozenUserSuffixes.set(lastUserIdx, stateBlock)
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    const suffix = frozenUserSuffixes.get(i)
    if (msg.role === 'user' && suffix) {
      apiMessages.push({ ...msg, content: `${msg.content}\n\n<context-update>\n${suffix}\n</context-update>` })
    } else {
      apiMessages.push(msg)
    }
  }

  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: stableStringify({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...apiMessages],
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 2048,
      stream: false,
    }),
  })

  if (!response.ok) throw new Error(`API ${response.status}: ${(await response.text()).slice(0, 300)}`)

  const data = await response.json() as any
  const usage = data.usage
  const hit = usage.prompt_cache_hit_tokens ?? 0
  const miss = usage.prompt_cache_miss_tokens ?? 0
  const total = hit + miss
  const hitRate = total > 0 ? (hit / total * 100).toFixed(1) : '0.0'

  const choice = data.choices[0]
  return {
    text: choice.message.content ?? '',
    toolCalls: choice.message.tool_calls ?? null,
    stats: { turn: turnLabel, toolCalls: choice.message.tool_calls?.length ?? 0, inputTokens: usage.prompt_tokens, cacheHit: hit, cacheMiss: miss, hitRate: `${hitRate}%` },
  }
}

// ── Main loop ───────────────────────────────────────────────────

async function main() {
  console.log('🔧 Task A · 多 tool turn 长任务验证')
  console.log(`   Artifact dir: ${artifactDir}`)
  console.log('')

  const TASK = `用 grep 搜索 ${CWD}/src/agent/ 下所有用到 EvidenceTracker 的地方，然后逐个读取对应文件的前 30 行（用 read_file），最后告诉我谁是真正的核心 caller。每次只调用一个工具。`

  messages.push({ role: 'user', content: TASK })

  let turnCount = 0
  const MAX_TURNS = 15

  while (turnCount < MAX_TURNS) {
    turnCount++
    process.stdout.write(`  Turn ${turnCount}: `)

    const { text, toolCalls, stats } = await callApi(turnCount)
    allStats.push(stats)

    if (!toolCalls || toolCalls.length === 0) {
      console.log(`text response (${text.length} chars) — hit: ${stats.hitRate}`)
      messages.push({ role: 'assistant', content: text })
      break
    }

    console.log(`${toolCalls.length} tool call(s) — hit: ${stats.hitRate}`)

    // Add assistant message with tool_calls
    messages.push({ role: 'assistant', content: null, tool_calls: toolCalls })

    // Execute each tool and add role=tool response
    for (const tc of toolCalls) {
      const name = tc.function.name
      const input = JSON.parse(tc.function.arguments)
      const result = await executeTool(name, input)
      messages.push({ role: 'tool', content: result, tool_call_id: tc.id })
      process.stdout.write(`    → ${name}(${JSON.stringify(input).slice(0, 60)}) = ${result.slice(0, 80)}...\n`)
    }

    await new Promise(r => setTimeout(r, 800))
  }

  // ── Results ─────────────────────────────────────────────────

  console.log('')
  console.log('┌──────┬───────┬────────────┬───────────┬───────────┬──────────┐')
  console.log('│ Turn │ Tools │ Input Tkns │ Cache Hit │ Cache Miss│ Hit Rate │')
  console.log('├──────┼───────┼────────────┼───────────┼───────────┼──────────┤')
  for (const s of allStats) {
    console.log(`│  ${String(s.turn).padStart(2)}  │   ${String(s.toolCalls).padStart(2)}  │ ${String(s.inputTokens).padStart(10)} │ ${String(s.cacheHit).padStart(9)} │ ${String(s.cacheMiss).padStart(9)} │ ${s.hitRate.padStart(8)} │`)
  }
  console.log('└──────┴───────┴────────────┴───────────┴───────────┴──────────┘')

  if (allStats.length >= 3) {
    const recent3 = allStats.slice(-3)
    const totalHit = recent3.reduce((s, r) => s + r.cacheHit, 0)
    const totalMiss = recent3.reduce((s, r) => s + r.cacheMiss, 0)
    const avgRate = (totalHit / (totalHit + totalMiss) * 100).toFixed(1)
    console.log(`\n📊 Recent 3 turns 平均命中率: ${avgRate}%`)
    console.log(`📦 Artifacts stored: ${artifactStore.list().length}`)
    console.log(`📋 SessionState files tracked: ${Object.keys(sessionState.getSnapshot().fileIndex).length}`)

    // Measure tool_result sizes
    const toolMsgs = messages.filter(m => m.role === 'tool')
    const avgToolLen = toolMsgs.length > 0 ? Math.round(toolMsgs.reduce((s, m) => s + (m.content?.length ?? 0), 0) / toolMsgs.length) : 0
    console.log(`📏 Avg tool_result size: ${avgToolLen} chars (~${Math.round(avgToolLen / 4)} tokens)`)

    const rate = parseFloat(avgRate)
    if (rate >= 90) console.log('\n✅ 优秀 — artifact ref + append-only 工作正常')
    else if (rate >= 80) console.log('\n✅ 良好 — 缓存稳定')
    else if (rate >= 60) console.log('\n⚠️ 合格 — 可能有优化空间')
    else console.log('\n❌ 异常 — artifact ref 可能未生效，检查 tool_result 大小')
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
