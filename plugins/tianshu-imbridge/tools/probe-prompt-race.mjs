/**
 * 探针：复核「建会话后立刻 prompt」的 400 竞态（command-mapping.md:42-53 点名项）。
 *
 * 做法：对若干延迟档，各建若干个新会话，建完立刻（按该档延迟）发 prompt，记录 HTTP 状态码。
 * 不消耗模型：隔离实例没有 API key，prompt 若被受理会返回 200 并随后产生 error 事件；
 * 这里只看**受理与否**（400 = 竞态）。
 *
 * 用法：
 *   PROBE_TOKEN=... PROBE_PORT=... "<天枢 node>" tools/probe-prompt-race.mjs
 */
const token = process.env.PROBE_TOKEN?.trim()
const port = Number.parseInt(process.env.PROBE_PORT ?? '', 10)
if (!token || !port) {
  console.error('需要 PROBE_TOKEN 与 PROBE_PORT')
  process.exit(1)
}
const BASE = `http://127.0.0.1:${port}`
const WS = process.env.PROBE_CWD?.trim() ?? 'D:/path/to/scratch/race-ws'
const DELAYS = [0, 50, 200, 500, 1000, 2000]
const ROUNDS = Number.parseInt(process.env.PROBE_ROUNDS ?? '5', 10)

const req = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await r.json() } catch { /* 空体 */ }
  return { status: r.status, json }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = []
const P = (s = '') => out.push(s)

P('# 「建会话后立刻 prompt」竞态复核')
P(`时间: ${new Date().toISOString()}`)
P(`实例: ${BASE}   工作区: ${WS}   每档轮数: ${ROUNDS}`)
P('')
P('| 建会话后延迟 | 400 次数 | 其它状态 | 结论 |')
P('| --- | --- | --- | --- |')

const summary = []
for (const delay of DELAYS) {
  let bad = 0
  const others = new Map()
  for (let i = 0; i < ROUNDS; i += 1) {
    const created = await req('POST', '/sessions', { cwd: WS, title: `{race} delay=${delay} #${i}` })
    if (created.status !== 201 && created.status !== 200) {
      others.set(`create:${created.status}`, (others.get(`create:${created.status}`) ?? 0) + 1)
      continue
    }
    if (delay > 0) await sleep(delay)
    const prompted = await req('POST', `/sessions/${created.json.id}/prompt`, { prompt: 'race probe' })
    if (prompted.status === 400) bad += 1
    else others.set(prompted.status, (others.get(prompted.status) ?? 0) + 1)
  }
  const otherText = [...others.entries()].map(([k, v]) => `${k}×${v}`).join(' ') || '—'
  const verdict = bad === 0 ? '未复现' : `复现 ${bad}/${ROUNDS}`
  P(`| ${delay} ms | ${bad} | ${otherText} | ${verdict} |`)
  summary.push({ delay, bad, total: ROUNDS })
}

P('')
P('## 判定')
const firstClean = summary.find((s) => s.bad === 0)
const zero = summary[0]
if (zero && zero.bad === 0) {
  P('延迟 0ms 档也没有复现 400：本轮未观察到该竞态。')
} else if (firstClean) {
  P(`延迟 0ms 档复现 ${zero.bad}/${zero.total} 次；从 ${firstClean.delay}ms 起未再复现。`)
} else {
  P('所有延迟档都出现过 400 —— 竞态不是「等一会儿就好」，需要重试策略而非单纯等待。')
}
P('')
P('（探针结束；本轮只在隔离实例里建会话，未触发任何模型调用）')

process.stdout.write(`${out.join('\n')}\n`)
process.exitCode = 0
