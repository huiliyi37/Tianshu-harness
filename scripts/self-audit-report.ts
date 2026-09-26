#!/usr/bin/env tsx
/**
 * self-audit-report.ts — 天枢自评测聚合报告。
 *
 * 只读扫描会话目录，输出一份 Markdown 报告：
 * - 静态层：assembly-audit 测试通过情况（通过子进程运行）
 * - 运行时层：advisory 指标（扫描 session JSONL）
 * - 数据层：cache 命中摘要（扫描 cache-log.jsonl + meta.json）
 * - 帧准入：复用 buildAdmissionReport
 * - 近期闭环指标群：advisory 双声源叠发检测
 * - 合理性断言：读数落在已知不可能区间时 fail loud（exit 2），
 *   防止"跑通了但输出假数据"的静默装配断裂（2026-07-21 返工教训）。
 *
 * 数据布局约定（AGENTS.md「Runtime Data Layout」）：
 * - <root>/<sid>.jsonl / <sid>.meta.json —— 会话主体与元数据（同级文件）
 * - <root>/<sid>/cache-log.jsonl、frames.jsonl —— 会话目录内的遥测通道
 * - session JSONL 每行末尾可能带 `|<hash>` 完整性后缀，parse 前须剥离
 *
 * 用法：
 *   npx tsx scripts/self-audit-report.ts                          # 当前项目的会话目录
 *   npx tsx scripts/self-audit-report.ts <sessions-dir>           # 显式指定目录
 *   npx tsx scripts/self-audit-report.ts --quick                  # 跳过慢速扫描（仅 meta + 帧）
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sessionsDir } from '../src/config/paths.js'
import {
  buildAdmissionReport,
  parseFrameLines,
  FRAME_CLASS_KEYS,
  FRAME_CLASS_LABELS,
  type SessionFrames,
} from '../src/agent/frame-replay-report.js'

const ACTIVE_WINDOW_MS = 10 * 60 * 1000
const RECENT_SESSION_LIMIT = 50

const args = process.argv.slice(2)
const quickMode = args.includes('--quick')
const root = args.filter(a => !a.startsWith('--'))[0] ?? sessionsDir(process.cwd())

if (!existsSync(root)) {
  console.error(`会话目录不存在：${root}`)
  process.exit(1)
}

// ── 工具函数 ──

function readJsonSafe(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return null }
}

/** session JSONL 行可能带 `|<hash>` 完整性后缀——先直接 parse，失败再剥后缀重试。 */
function parseSessionLine(line: string): Record<string, unknown> | null {
  try { return JSON.parse(line) } catch { /* try suffix strip */ }
  const sep = line.lastIndexOf('|')
  if (sep <= 0) return null
  try { return JSON.parse(line.slice(0, sep)) } catch { return null }
}

function formatPct(num: number, denom: number): string {
  if (denom === 0) return 'N/A'
  return `${(num / denom * 100).toFixed(1)}%`
}

// ── 会话枚举 ──
// 会话主体（<sid>.jsonl / <sid>.meta.json）是 root 下的同级文件；
// <sid>/ 目录只装遥测通道。两个来源取并集，避免漏掉只有一侧的会话。

const sessionIdSet = new Set<string>()
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (entry.name.startsWith('worker-')) continue
  if (entry.isDirectory()) {
    sessionIdSet.add(entry.name)
  } else if (entry.name.endsWith('.meta.json')) {
    sessionIdSet.add(entry.name.slice(0, -'.meta.json'.length))
  }
}
const sessionIds = [...sessionIdSet]

// 按 meta mtime 排序（无 meta 的回退遥测目录 mtime），取最近 N 个
function sessionMtime(sid: string): number {
  const metaPath = join(root, `${sid}.meta.json`)
  if (existsSync(metaPath)) return statSync(metaPath).mtimeMs
  const dirPath = join(root, sid)
  if (existsSync(dirPath)) return statSync(dirPath).mtimeMs
  return 0
}
sessionIds.sort((a, b) => sessionMtime(b) - sessionMtime(a))

const recentSessions = sessionIds.slice(0, RECENT_SESSION_LIMIT)

// ── 采集 meta.json（root 同级文件，非会话目录内） ──
const metaFiles: Map<string, Record<string, unknown>> = new Map()
for (const sid of recentSessions) {
  const metaPath = join(root, `${sid}.meta.json`)
  if (!existsSync(metaPath)) continue
  const meta = readJsonSafe(metaPath)
  if (meta) metaFiles.set(sid, meta)
}

// ── 采集 cache-log.jsonl（会话目录内） ──
const cacheLogs: { sessionId: string; lines: Array<Record<string, unknown>> }[] = []
if (!quickMode) {
  for (const sid of recentSessions) {
    const cacheLogPath = join(root, sid, 'cache-log.jsonl')
    if (!existsSync(cacheLogPath)) continue
    try {
      const raw = readFileSync(cacheLogPath, 'utf-8')
      const lines = raw.trim().split('\n').map(l => {
        try { return JSON.parse(l) } catch { return null }
      }).filter(Boolean) as Array<Record<string, unknown>>
      if (lines.length > 0) cacheLogs.push({ sessionId: sid, lines })
    } catch { /* skip */ }
  }
}

// ── 采集 advisory 模式（扫描 root 同级的 session JSONL） ──
// advisory 经 system-reminder 注入（appendSystemReminder 追加到 user 消息，
// 流式期间的注入落在下一条 tool result）——不出现在 assistant 正文里。
// 四声源标注核心 marker：
// - `[恢复:` —— failure-taxonomy renderRouteAnnotation 的统一标注
// - `自动恢复建议` —— edit-failure-recovery 的建议正文
// - `【天枢·诊断】` —— error-diagnosis 的 ADVISORY_PREAMBLE
// 噪声防护（本项目自指hazard）：开发会话读写 hook 源码时，tool result /
// assistant 文本里会大量出现同样的 marker 字符串。真实注入的判据是
// marker 位于 <system-reminder>…</system-reminder> 块内部——只统计块内命中。
// 粒度说明：session JSONL 消息行无 turn 字段，按"同一注入消息"聚合
// （AdvisoryBus 同轮 render 会合并进同一条 system-reminder）。
const SR_BLOCK_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function extractSystemReminderText(content: unknown): string {
  const s = typeof content === 'string' ? content : JSON.stringify(content ?? '')
  const blocks = s.match(SR_BLOCK_RE)
  return blocks ? blocks.join('\n') : ''
}

let advisoryMessageTotal = 0
let dualSourceCount = 0
let recoveryAnnotationCount = 0
let recoveryAnnotationTotal = 0
let sessionJsonlScanned = 0

if (!quickMode) {
  for (const sid of recentSessions.slice(0, 20)) {
    const jsonlPath = join(root, `${sid}.jsonl`)
    if (!existsSync(jsonlPath)) continue
    sessionJsonlScanned++
    try {
      const raw = readFileSync(jsonlPath, 'utf-8')
      for (const line of raw.split('\n')) {
        if (!line.includes('system-reminder')) continue
        const msg = parseSessionLine(line)
        if (!msg || (msg.role !== 'user' && msg.role !== 'tool')) continue
        const srText = extractSystemReminderText(msg.content)
        if (!srText) continue

        const hasEditFailure = srText.includes('自动恢复建议')
        const hasErrorDiagnosis = srText.includes('【天枢·诊断】')
        const hasAnnotation = srText.includes('[恢复:')
        if (!hasEditFailure && !hasErrorDiagnosis && !hasAnnotation) continue

        advisoryMessageTotal++
        if (hasEditFailure && hasErrorDiagnosis) dualSourceCount++
        if (hasEditFailure || hasErrorDiagnosis) {
          recoveryAnnotationTotal++
          if (hasAnnotation) recoveryAnnotationCount++
        }
      }
    } catch { /* skip */ }
  }
}

// ── 采集帧准入（会话目录内） ──
const frameSessions: SessionFrames[] = []
let skippedActive = 0
const now = Date.now()

for (const sid of recentSessions) {
  const framesPath = join(root, sid, 'frames.jsonl')
  if (!existsSync(framesPath)) continue
  const stat = statSync(framesPath)
  if (now - stat.mtimeMs < ACTIVE_WINDOW_MS) {
    skippedActive++
    continue
  }
  try {
    const { records, parseWarnings } = parseFrameLines(readFileSync(framesPath, 'utf-8'))
    if (records.length > 0 || parseWarnings > 0) {
      frameSessions.push({ sessionId: sid, records, parseWarnings })
    }
  } catch { /* skip */ }
}

const frameReport = buildAdmissionReport(frameSessions)

// ── 运行 assembly-audit 测试 ──
let assemblyAuditPassed = false
let assemblyAuditOutput = ''
try {
  const result = spawnSync('node', ['--import', 'tsx', 'src/__tests__/assembly-audit.test.ts'], {
    cwd: process.cwd(),
    timeout: 60_000,
    encoding: 'utf-8',
    windowsHide: true,
  })
  assemblyAuditPassed = result.status === 0
  assemblyAuditOutput = (result.stdout + result.stderr).slice(-2000)
} catch {
  assemblyAuditOutput = '(assembly-audit 运行失败)'
}

// ── Cache 指标 ──
// cache-log.jsonl 是多事件混流通道：主请求行（无 event 字段，含
// input/cacheRead/cacheCreate）+ side_path / reclaim_decision / search-pod /
// amnesia_shadow 等事件行。命中率只对主请求行计算，事件行单独计数。
let cacheMainRequests = 0
let cacheHitRequests = 0 // cacheRead > 0
let cacheTotalReadTokens = 0
let cacheTotalCreateTokens = 0
let cacheEventLines = 0

for (const { lines } of cacheLogs) {
  for (const entry of lines) {
    if (typeof entry.event === 'string') {
      cacheEventLines++
      continue
    }
    if (typeof entry.cacheRead !== 'number' && typeof entry.input !== 'number') continue
    cacheMainRequests++
    const read = (entry.cacheRead as number) ?? 0
    const create = (entry.cacheCreate as number) ?? 0
    cacheTotalReadTokens += read
    cacheTotalCreateTokens += create
    if (read > 0) cacheHitRequests++
  }
}

// ── Meta 统计 ──
let totalTurns = 0
let sessionsWithSpec = 0
for (const [, meta] of metaFiles) {
  totalTurns += (meta.turnCount as number) ?? 0
  const spec = meta.llmSpeculationEngine as Record<string, number> | undefined
  if (spec && (spec.fired ?? 0) > 0) sessionsWithSpec++
}

// ── 合理性断言 ──
// 读数落在已知不可能区间 = 大概率是数据通道断裂（字段名/路径/schema 漂移），
// 必须 fail loud 而非静默输出假数据。
const sanityWarnings: string[] = []

if (recentSessions.length > 0 && metaFiles.size === 0) {
  sanityWarnings.push(
    `扫到 ${recentSessions.length} 个会话但 0 个 meta.json —— meta 路径或布局约定漂移（预期 <root>/<sid>.meta.json）`)
}
if (!quickMode) {
  if (cacheMainRequests >= 100 && cacheHitRequests === 0) {
    sanityWarnings.push(
      `${cacheMainRequests} 个主请求 cache 命中数为 0 —— 本项目稳态命中率 95%+，读数为 0 几乎必然是字段名对不上（预期 cacheRead/cacheCreate）`)
  }
  if (cacheLogs.length > 0 && cacheMainRequests === 0) {
    sanityWarnings.push(
      `读到 ${cacheLogs.length} 个 cache-log 但主请求行为 0 —— 主请求行判定条件（无 event 字段 + 有 input/cacheRead）可能失配`)
  }
  if (sessionJsonlScanned === 0 && metaFiles.size > 0) {
    sanityWarnings.push(
      `有 ${metaFiles.size} 个 meta 但 0 个 session JSONL 可读 —— JSONL 路径约定漂移（预期 <root>/<sid>.jsonl）`)
  }
}
if (metaFiles.size > 0 && totalTurns === 0) {
  sanityWarnings.push(
    `${metaFiles.size} 个 meta 累计 turns 为 0 —— turnCount 字段名可能漂移`)
}

// ── 报告输出 ──

console.log('# 天枢自评测报告')
console.log(`生成时间：${new Date().toISOString()}`)
console.log(`扫描目录：${root}`)
console.log(`扫描会话：${recentSessions.length}（跳过活跃帧会话 ${skippedActive}）`)
console.log('')

console.log('## 静态装配审计')
console.log(`assembly-audit: ${assemblyAuditPassed ? '✅ 通过' : '❌ 失败'}`)
if (!assemblyAuditPassed) {
  console.log('```')
  console.log(assemblyAuditOutput)
  console.log('```')
}
console.log('')

console.log('## 运行时层')
console.log(`| 指标 | 值 |`)
console.log(`|------|----|`)
console.log(`| 扫描 session JSONL 数 | ${sessionJsonlScanned} |`)
console.log(`| 含恢复声源的注入消息数 | ${advisoryMessageTotal} |`)
console.log(`| 双声源叠发 (edit-failure + error-diagnosis 同消息) | ${dualSourceCount} |`)
console.log(`| 恢复路由标注覆盖率 | ${formatPct(recoveryAnnotationCount, recoveryAnnotationTotal)} |`)
console.log('')

console.log('## 数据层')
console.log(`| 指标 | 值 |`)
console.log(`|------|----|`)
console.log(`| cache 主请求数 | ${cacheMainRequests} |`)
console.log(`| cache 事件行数 (side_path/reclaim 等) | ${cacheEventLines} |`)
console.log(`| cache 命中请求数 (read > 0) | ${cacheHitRequests} |`)
console.log(`| cache 命中率 | ${formatPct(cacheHitRequests, cacheMainRequests)} |`)
console.log(`| cache read tokens 总计 | ${cacheTotalReadTokens.toLocaleString()} |`)
console.log(`| cache create tokens 总计 | ${cacheTotalCreateTokens.toLocaleString()} |`)
if (cacheTotalReadTokens + cacheTotalCreateTokens > 0) {
  console.log(`| cache 复用率 (read/(read+create)) | ${formatPct(cacheTotalReadTokens, cacheTotalReadTokens + cacheTotalCreateTokens)} |`)
}
console.log(`| 会话总数 (meta) | ${metaFiles.size} |`)
console.log(`| 累计 turns | ${totalTurns} |`)
console.log(`| 有 speculation 活动的会话 | ${sessionsWithSpec} |`)
console.log('')

console.log('## 帧准入')
console.log(`| 指标 | 值 |`)
console.log(`|------|----|`)
console.log(`| 帧记录数 | ${frameReport.recordCount} |`)
console.log(`| parse warnings | ${frameReport.parseWarnings} |`)
console.log(`| degraded 比例 | ${(frameReport.degradedRatio * 100).toFixed(1)}% |`)
console.log(`| divergence 数 | ${frameReport.replay.divergences.length} |`)
console.log(`| hard-line violation 数 | ${frameReport.replay.violations.length} |`)
console.log('')
console.log('### 六类反例覆盖')
for (const key of FRAME_CLASS_KEYS) {
  const mark = frameReport.classCounts[key] > 0 ? '✓' : '✗'
  console.log(`- ${mark} ${FRAME_CLASS_LABELS[key]}: ${frameReport.classCounts[key]}`)
}
console.log('')

console.log('## 近期闭环指标群')
console.log(`| 指标 | 值 |`)
console.log(`|------|----|`)
console.log(`| advisory 双声源叠发 (同消息) | ${dualSourceCount} |`)
console.log(`| 恢复路由标注覆盖率 | ${formatPct(recoveryAnnotationCount, recoveryAnnotationTotal)} |`)
console.log(`| cache 命中率 | ${formatPct(cacheHitRequests, cacheMainRequests)} |`)
console.log('')

if (sanityWarnings.length > 0) {
  console.log('## ⚠ 合理性断言告警')
  console.log('以下读数落在已知不可能区间——大概率是报告脚本自身的数据通道断裂，')
  console.log('而非真实运行时状态。请先修脚本再采信本报告。')
  console.log('')
  for (const w of sanityWarnings) console.log(`- ${w}`)
  console.log('')
  process.exitCode = 2
}

console.log('---')
console.log('报告结束。运行建议：每周一次或大版本前手动执行。')
