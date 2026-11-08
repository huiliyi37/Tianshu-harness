#!/usr/bin/env node
/**
 * 探针：用真实会话事件档复算 lib/transcript.mjs 的还原结果（小类 11 的真实验证一半）。
 *
 * 用法（Windows node）：
 *   node tools/probe-transcript.mjs <events.jsonl 绝对路径> [--tail N] [--show N]
 *
 * 单测覆盖的是构造出来的形状。真实档里还有：读取期压缩合并、窗口起点非 1、
 * 宿主注入前缀、queue_pending 这类 steer 输入、回合中间起窗。这些只有真档量得出来。
 * 本探针**只读不写**，可反复重跑；产物由调用方重定向到 docs/research-notes/。
 */
import { readFileSync } from 'node:fs'
import { formatHistory, reconstructMessages, takeLast } from '../lib/transcript.mjs'

const argv = process.argv.slice(2)
const file = argv.find((a) => !a.startsWith('--'))
const numArg = (flag, dflt) => {
  const i = argv.indexOf(flag)
  if (i < 0) return dflt
  const n = Number.parseInt(argv[i + 1], 10)
  return Number.isFinite(n) ? n : dflt
}
const TAIL = numArg('--tail', 3)
const SHOW = numArg('--show', 6)

if (!file) {
  console.error('用法: node tools/probe-transcript.mjs <events.jsonl 绝对路径> [--tail N] [--show N]')
  process.exit(2)
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

const raw = readFileSync(file, 'utf8')
const lines = raw.split(/\r?\n/).filter((l) => l.trim())
const all = []
let badLines = 0
for (const line of lines) {
  try {
    all.push(JSON.parse(line))
  } catch {
    badLines += 1
  }
}

// 可选区间切片：用来复算「接口返回的压缩窗口」那一段（接口窗口 = 磁盘档的某个尾部区间，
// 差别只在 delta 是否被读取期合并；合并保序且不改文本，故还原出的文本序列应当一致）。
const SINCE = numArg('--since', null)
const UNTIL = numArg('--until', null)
const events = all.filter((e) => {
  if (!Number.isFinite(e?.seq)) return true
  if (SINCE !== null && e.seq < SINCE) return false
  if (UNTIL !== null && e.seq > UNTIL) return false
  return true
})

const byType = new Map()
for (const e of events) byType.set(e?.type, (byType.get(e?.type) ?? 0) + 1)

const seqs = events.map((e) => e?.seq).filter((n) => Number.isFinite(n))
const seqMin = Math.min(...seqs)
const seqMax = Math.max(...seqs)
const sorted = [...new Set(seqs)].sort((a, b) => a - b)
let gaps = 0
for (let i = 1; i < sorted.length; i += 1) if (sorted[i] !== sorted[i - 1] + 1) gaps += 1

const t0 = Date.now()
const r = reconstructMessages(events)
const elapsed = Date.now() - t0
const tail = takeLast(r.messages, TAIL)

const out = []
const P = (s = '') => out.push(s)

P('# 真实事件档复算 · lib/transcript.mjs')
P(`时间: ${new Date().toISOString()}`)
P(`档: ${file}`)
P(`参数: tail=${TAIL} show=${SHOW} since=${SINCE ?? '不限'} until=${UNTIL ?? '不限'}`)
P('')
P('## [1] 输入规模')
P(`行数（非空）: ${lines.length}   成功解析: ${all.length}   用于还原: ${events.length}   解析失败: ${badLines}`)
P(`seq 范围: ${seqMin} .. ${seqMax}   去重后条数: ${sorted.length}   连续段缺口数: ${gaps}`)
P(`事件类型分布: ${JSON.stringify(Object.fromEntries([...byType.entries()].sort((a, b) => b[1] - a[1])))}`)
P('')
P('## [2] 还原结果总览')
P(`windowStart: ${r.windowStart}   消息总数: ${r.total}   首段为残段被丢弃: ${r.droppedHead}`)
P(`耗时: ${elapsed} ms`)
const counts = {}
for (const m of r.messages) counts[m.role] = (counts[m.role] ?? 0) + 1
P(`角色分布: ${JSON.stringify(counts)}`)
const notes = {}
for (const m of r.messages) if (m.note) notes[m.note] = (notes[m.note] ?? 0) + 1
P(`带标注的消息: ${JSON.stringify(notes)}`)
P('')
P('## [3] assistant 文本长度 Top 5（含 seq 段）')
r.messages
  .filter((m) => m.role === 'assistant')
  .sort((a, b) => b.text.length - a.text.length)
  .slice(0, 5)
  .forEach((m, i) => P(`  #${i + 1}  ${m.text.length} 字  seq ${m.fromSeq}..${m.toSeq}  ${clip(m.text, 60)}`))
P('')
P('## [4] queue_pending（steer 输入）与最终序列的对照')
const queued = events.filter((e) => e?.type === 'queue_pending')
P(`queue_pending 事件: ${queued.length} 条`)
const allText = r.messages.map((m) => m.text).join('\n')
let hit = 0
queued.slice(0, SHOW).forEach((e, i) => {
  const t = String(e.data?.text ?? '').trim()
  const found = Boolean(t) && (allText.includes(t) || r.messages.some((m) => m.text.includes(t.slice(0, 40))))
  if (found) hit += 1
  P(`  #${i + 1} seq ${e.seq}  ${found ? '已进入还原序列 ✓' : '未在序列中找到 ⚠'}  ${clip(t, 70)}`)
})
if (queued.length > SHOW) P(`  （仅列前 ${SHOW} 条）`)
P(`前 ${Math.min(SHOW, queued.length)} 条中命中: ${hit}`)
P('')
P('## [5] 尾部取样（/history 默认取最近 3 条）')
tail.messages.forEach((m, i) => {
  P(`  [${i + 1}] ${m.role}${m.note ? `(${m.note})` : ''}  ${m.text.length} 字  seq ${m.fromSeq}..${m.toSeq}`)
  P(`      ${clip(m.text, 200)}`)
})
P(`truncated=${tail.truncated}  total=${tail.total}`)
P('')
P('## [6] 还原不变量自检')
const emptyAssistant = r.messages.filter((m) => m.role === 'assistant' && !m.text).length
const emptyUser = r.messages.filter((m) => m.role === 'user' && !m.text).length
const seqMonotonic = r.messages.every((m, i) => i === 0 || m.fromSeq >= r.messages[i - 1].toSeq)
const stripped = r.messages.filter((m) => /^\[(排队跟进|续跑)\]/.test(m.text)).length
P(`  空文本消息: assistant ${emptyAssistant} / user ${emptyUser}（都应为 0）`)
P(`  消息 fromSeq 单调不倒退: ${seqMonotonic ? '是 ✓' : '否 ✗'}`)
P(`  残留宿主注入前缀的消息: ${stripped}（应为 0）`)
P('')
P('（探针结束；只读，未写入任何文件）')

// ── /history 的 QQ 侧真实文本（命令层端到端：还原 → 取尾 → 排版）──
const FORMAT = (() => {
  const i = argv.indexOf('--format')
  if (i < 0) return []
  return String(argv[i + 1] ?? '')
    .split(',')
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0)
})()
for (const n of FORMAT) {
  const tailN = takeLast(r.messages, n)
  P('')
  P(`## [/history ${n}] 命令层实际会发出的文本（共 ${r.total} 条中取尾 ${n} 条）`)
  P('----8<---- 以下为 QQ 侧文本 ----')
  P(formatHistory({
    messages: tailN.messages,
    truncated: tailN.truncated,
    total: tailN.total,
    droppedHead: r.droppedHead,
    limitNote: null,
  }))
  P('---->8---- 文本结束 ----')
}

P('（探针结束；只读，未写入任何文件）')

process.stdout.write(`${out.join('\n')}\n`)
