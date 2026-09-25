#!/usr/bin/env tsx
/**
 * Task B · 触发 SessionState 自动追踪（核心验证）
 *
 * 模拟 read → edit → run_tests 链路，每个 tool turn 都改变 sessionState。
 * 直接使用 OpenAI 格式。验证：sessionState 变化不破坏 prefix cache。
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-xxx ./node_modules/.bin/tsx scripts/verify-task-b-session-state.ts
 */

import { ArtifactStore } from '../src/artifact/store.js'
import { SessionStateManager } from '../src/agent/session-state.js'
import { summarizeFileContent } from '../src/artifact/summarize.js'
import { stableStringify } from '../src/api/stable-json.js'
import { readFileSync, existsSync, mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'

const API_KEY = process.env.DEEPSEEK_API_KEY
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
if (!API_KEY) { console.error('❌ DEEPSEEK_API_KEY required'); process.exit(1) }

const CWD = process.cwd()

const SYSTEM_BASE = `You are a coding assistant. Use tools to find TODO/FIXME comments, read files, edit them (dry run), and run tests. Be concise. Call one tool at a time.`

const TOOLS = [
  { type: 'function', function: { name: 'grep', description: 'Search files by pattern', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern', 'path'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Edit a file (dry run mode)', parameters: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'run_tests', description: 'Run test suite', parameters: { type: 'object', properties: { filter: { type: 'string' } }, required: [] } } },
  { type: 'function', function: { name: 'read_section', description: 'Read lines from artifact', parameters: { type: 'object', properties: { artifact_id: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['artifact_id', 'start_line', 'end_line'] } } },
]

const artifactDir = mkdtempSync(join(tmpdir(), 'rivet-task-b-'))
const artifactStore = new ArtifactStore(artifactDir, 'task-b-session')
const sessionState = new SessionStateManager('task-b-session')

// ── Tool execution ──────────────────────────────────────────────

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'grep') {
    const pattern = input.pattern as string
    const path = input.path as string
    const absPath = path.startsWith('/') ? path : join(CWD, path)

    return new Promise((resolve) => {
      const child = execFile('grep', ['-rn', pattern, absPath], { encoding: 'utf-8', timeout: 5000, windowsHide: true }, (error, stdout) => {
        if (error && !stdout) {
          resolve('No matches found.')
          return
        }

        const lines = stdout.split('\n').filter(Boolean).slice(0, 20)
        resolve(lines.length > 0 ? `${lines.join('\n')}\n` : 'No matches found.')
      })

      child.on('error', () => resolve('No matches found.'))
    })
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
  if (name === 'edit_file') {
    sessionState.trackFileModified(input.file_path as string)
    return `[DRY RUN] Would edit ${input.file_path}: replace "${(input.old_string as string).slice(0, 30)}..." → "${(input.new_string as string).slice(0, 30)}..."`
  }
  if (name === 'run_tests') {
    const filter = (input.filter as string) ?? 'all'
    sessionState.recordVerification(filter, 'passed')
    return `Tests passed (${filter}). 2694/2695 pass, 1 skip.`
  }
  if (name === 'read_section') {
    const content = await artifactStore.readLines(input.artifact_id as string, input.start_line as number, input.end_line as number)
    return content ?? `Error: Artifact not found`
  }
  return 'Unknown tool'
}

// ── Message management (OpenAI format) ──────────────────────────

type OaiMsg = { role: string; content?: string | null; tool_calls?: any[]; tool_call_id?: string }
const messages: OaiMsg[] = []

interface TurnStats { turn: number; toolCalls: number; inputTokens: number; cacheHit: number; cacheMiss: number; hitRate: string; stateChars: number }
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
    body: stableStringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: SYSTEM_BASE }, ...apiMessages], tools: TOOLS, tool_choice: 'auto', max_tokens: 2048, stream: false }),
  })

  if (!response.ok) throw new Error(`API ${response.status}: ${(await response.text()).slice(0, 300)}`)
  const data = await response.json() as any
  const usage = data.usage
  const hit = usage.prompt_cache_hit_tokens ?? 0
  const miss = usage.prompt_cache_miss_tokens ?? 0
  const hitRate = (hit + miss) > 0 ? (hit / (hit + miss) * 100).toFixed(1) : '0.0'

  return {
    text: data.choices[0].message.content ?? '',
    toolCalls: data.choices[0].message.tool_calls ?? null,
    stats: { turn: turnLabel, toolCalls: data.choices[0].message.tool_calls?.length ?? 0, inputTokens: usage.prompt_tokens, cacheHit: hit, cacheMiss: miss, hitRate: `${hitRate}%`, stateChars: stateBlock.length },
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('🧪 Task B · SessionState 自动追踪验证')
  console.log(`   验证：sessionState 每轮变化是否破坏 prefix cache`)
  console.log('')

  messages.push({ role: 'user', content: `在 ${CWD}/src/agent/ 里找出 3 个有 TODO 或 FIXME 注释的地方，然后选一个最简单的修掉（dry run），最后跑 test 验证。每次只调用一个工具。` })

  let turnCount = 0
  while (turnCount < 12) {
    turnCount++
    process.stdout.write(`  Turn ${turnCount}: `)
    const { text, toolCalls, stats } = await callApi(turnCount)
    allStats.push(stats)

    if (!toolCalls || toolCalls.length === 0) {
      console.log(`done (${text.length} chars) — hit: ${stats.hitRate} | state: ${stats.stateChars}ch`)
      messages.push({ role: 'assistant', content: text })
      break
    }

    console.log(`${toolCalls.length} tool(s) — hit: ${stats.hitRate} | state: ${stats.stateChars}ch`)
    messages.push({ role: 'assistant', content: null, tool_calls: toolCalls })

    for (const tc of toolCalls) {
      const input = JSON.parse(tc.function.arguments)
      const result = await executeTool(tc.function.name, input)
      messages.push({ role: 'tool', content: result, tool_call_id: tc.id })
      process.stdout.write(`    → ${tc.function.name}: ${result.slice(0, 70)}...\n`)
    }
    await new Promise(r => setTimeout(r, 800))
  }

  // Results
  console.log('')
  console.log('┌──────┬───────┬────────────┬───────────┬───────────┬──────────┬───────────┐')
  console.log('│ Turn │ Tools │ Input Tkns │ Cache Hit │ Cache Miss│ Hit Rate │ State Len │')
  console.log('├──────┼───────┼────────────┼───────────┼───────────┼──────────┼───────────┤')
  for (const s of allStats) {
    console.log(`│  ${String(s.turn).padStart(2)}  │   ${String(s.toolCalls).padStart(2)}  │ ${String(s.inputTokens).padStart(10)} │ ${String(s.cacheHit).padStart(9)} │ ${String(s.cacheMiss).padStart(9)} │ ${s.hitRate.padStart(8)} │ ${String(s.stateChars).padStart(9)} │`)
  }
  console.log('└──────┴───────┴────────────┴───────────┴───────────┴──────────┴───────────┘')

  if (allStats.length >= 3) {
    const recent3 = allStats.slice(-3)
    const totalHit = recent3.reduce((s, r) => s + r.cacheHit, 0)
    const totalMiss = recent3.reduce((s, r) => s + r.cacheMiss, 0)
    const avgRate = (totalHit / (totalHit + totalMiss) * 100).toFixed(1)
    const stateGrew = allStats[allStats.length - 1]!.stateChars > allStats[0]!.stateChars
    console.log(`\n📊 Recent 3 turns 平均命中率: ${avgRate}%`)
    console.log(`📋 SessionState grew: ${allStats[0]!.stateChars} → ${allStats[allStats.length - 1]!.stateChars} chars ${stateGrew ? '✅' : '⚠️ no growth'}`)
    console.log(`   Files: ${Object.keys(sessionState.getSnapshot().fileIndex).length} | Verifications: ${sessionState.getSnapshot().verification.length}`)

    const rate = parseFloat(avgRate)
    if (rate >= 80 && stateGrew) console.log('\n✅ SessionState 变化未破坏 prefix cache')
    else if (rate >= 60) console.log('\n⚠️ 轻微下降 — 检查 sessionState 是否在 tool turn 内刷新')
    else console.log('\n❌ 严重下降 — sessionState 可能在 tool turn 内破坏了 prefix')
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
