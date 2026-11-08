/**
 * serve 端点形状探针 —— 实测天枢 serve 的会话接口真实返回形状。
 *
 * 用途：命令层（/sessions、/session、/history 等）实现前，先拿到字段名、类型、
 * since 游标语义与错误码的**实测值**，不许靠推断。输出可原样落档。
 *
 * 用法（需要一个隔离 serve 实例在跑）：
 *   PROBE_BASE=http://127.0.0.1:11801 PROBE_TOKEN=... \
 *   "<天枢 node>" tools/probe-endpoints.mjs > docs/research-notes/serve-endpoints.txt
 *
 * 前置：隔离实例用独立的 RIVET_HOME 起，令牌自设，探针跑完记得回收实例。
 */
const BASE = (process.env.PROBE_BASE ?? 'http://127.0.0.1:11801').replace(/\/+$/, '')
const TOKEN = process.env.PROBE_TOKEN ?? 'cmd-probe-token-2026'
const TAG = '{probe}'
const WS_A = 'D:/path/to/scratch/probe-ws-a'
const WS_B = 'D:/path/to/scratch/probe-ws-b'

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? `Array(${v.length})` : typeof v)
const show = (v, max = 120) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s === undefined ? 'undefined' : s.length > max ? `${s.slice(0, max)}…` : s
}
const line = (s = '') => console.log(s)
const head = (s) => { line(); line(`## ${s}`) }

/** 字段清单：字段名 : 类型 : 示例值，并对多个对象做覆盖度交叉核对。 */
function inventory(objs, label) {
  const keys = [...new Set(objs.flatMap((o) => Object.keys(o ?? {})))].sort()
  line(`${label} 字段清单（${objs.length} 个对象，字段并集 ${keys.length} 个）：`)
  for (const k of keys) {
    const present = objs.filter((o) => o && Object.prototype.hasOwnProperty.call(o, k))
    const sample = present.map((o) => o[k]).find((v) => v !== undefined && v !== null)
    line(`  ${k.padEnd(20)} ${typeOf(sample).padEnd(12)} ${show(sample)}   [${present.length}/${objs.length} 个对象有]`)
  }
  const uniform = objs.every((o) => JSON.stringify(Object.keys(o ?? {}).sort()) === JSON.stringify(keys))
  line(`  字段集合是否一致：${uniform ? '是' : '否（下面逐个列出差异）'}`)
  if (!uniform) objs.forEach((o, i) => line(`    #${i + 1}: ${Object.keys(o ?? {}).sort().join(', ')}`))
}

async function req(method, path, { token = TOKEN, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch { json = null }
  return { status: res.status, json }
}

line(`# serve 端点形状实测`)
line(`时间: ${new Date().toISOString()}`)
line(`实例: ${BASE}  令牌: ${TOKEN.slice(0, 8)}***（自设，非生产凭据）`)

head('[1] POST /sessions —— 建探针会话（入参合法性一并实测）')
const created = []
for (const [cwd, title] of [[WS_A, `${TAG} alpha`], [WS_B, `${TAG} beta`], [null, `${TAG} no-cwd`]]) {
  const reqBody = cwd ? { cwd, title } : { title }
  const r = await req('POST', '/sessions', { body: reqBody })
  line(`请求体: ${show(reqBody)}`)
  line(`响应: HTTP ${r.status} ${show(r.json, 260)}`)
  if (r.json?.id) created.push(r.json.id)
}

head('[2] POST /sessions —— 非法入参的错误码')
for (const bad of [{ cwd: 123, title: 'x' }, { cwd: 'D:/no/such/dir/at/all', title: 'x' }]) {
  const r = await req('POST', '/sessions', { body: bad })
  line(`请求体: ${show(bad)} → HTTP ${r.status} ${show(r.json, 200)}`)
}

head('[3] GET /sessions —— 会话清单')
const list = await req('GET', '/sessions')
line(`HTTP ${list.status}`)
line(`响应外壳: ${show(list.json, 200)}`)
const sessions = Array.isArray(list.json?.sessions) ? list.json.sessions : []
line(`外壳字段: ${Object.keys(list.json ?? {}).join(', ')}（sessions 是数组？${Array.isArray(list.json?.sessions)}，本实例 ${sessions.length} 条）`)
if (sessions.length) inventory(sessions, '会话对象')
const includeArchived = await req('GET', '/sessions?includeArchived=true')
line(`includeArchived=true → HTTP ${includeArchived.status}，条数 ${includeArchived.json?.sessions?.length ?? 'n/a'}`)

const probeId = created[0]
head(`[4] GET /sessions/:id —— 快照（探针会话 ${probeId ?? '(未建成)'}）`)
if (probeId) {
  const snap = await req('GET', `/sessions/${encodeURIComponent(probeId)}`)
  line(`HTTP ${snap.status}`)
  line(`响应: ${show(snap.json, 400)}`)
  if (snap.json) inventory([snap.json], '快照对象')
}

head(`[5] GET /sessions/:id/events —— 响应外壳与事件形状`)
let wireLastSeq = null
if (probeId) {
  const ev0 = await req('GET', `/sessions/${encodeURIComponent(probeId)}/events?since=0`)
  line(`since=0 → HTTP ${ev0.status}`)
  line(`外壳字段: ${Object.keys(ev0.json ?? {}).join(', ')}`)
  const events = Array.isArray(ev0.json?.events) ? ev0.json.events : []
  wireLastSeq = typeof ev0.json?.lastSeq === 'number' ? ev0.json.lastSeq : null
  line(`事件数: ${events.length}  外壳 lastSeq: ${show(ev0.json?.lastSeq)}`)
  if (events.length) {
    inventory(events.slice(0, 3), '事件对象（前 3 条）')
    const dist = {}
    for (const e of events) dist[e.type] = (dist[e.type] ?? 0) + 1
    line(`事件类型分布: ${show(dist)}`)
  }
}

head('[6] since 游标语义（同一会话，改游标看返回如何变）')
if (probeId) {
  const cases = [
    ['since=0', 0],
    ['since=lastSeq', wireLastSeq ?? 0],
    ['since=lastSeq+1000（超界）', (wireLastSeq ?? 0) + 1000],
    ['since=-1', -1],
    ['since=abc（非数字）', 'abc'],
    ['无 since 参数', null],
  ]
  for (const [label, v] of cases) {
    const q = v === null ? '' : `?since=${encodeURIComponent(v)}`
    const r = await req('GET', `/sessions/${encodeURIComponent(probeId)}/events${q}`)
    const n = Array.isArray(r.json?.events) ? r.json.events.length : 'n/a'
    const seqs = Array.isArray(r.json?.events) && r.json.events.length
      ? `seq: ${r.json.events.map((e) => e.seq).join(',')}`
      : ''
    line(`  ${label.padEnd(24)} → HTTP ${r.status}  事件数 ${n}  lastSeq ${show(r.json?.lastSeq)}  ${seqs}`)
  }
}

head('[7] 事件发生后重测游标语义（PROBE_WITH_TURN=1 时执行；上面的游标测量跑在空会话上）')
if (process.env.PROBE_WITH_TURN === '1' && probeId) {
  const p = await req('POST', `/sessions/${encodeURIComponent(probeId)}/prompt`, { body: { prompt: '只回复两个字：通了' } })
  line(`POST /sessions/:id/prompt → HTTP ${p.status} ${show(p.json, 200)}`)
  let lastSeq = 0
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1000))
    const r = await req('GET', `/sessions/${encodeURIComponent(probeId)}/events?since=0`)
    lastSeq = typeof r.json?.lastSeq === 'number' ? r.json.lastSeq : 0
    if (lastSeq > 0) break
  }
  line(`轮询 ${'最多 60s'} 后 lastSeq = ${lastSeq}`)
  const full = await req('GET', `/sessions/${encodeURIComponent(probeId)}/events?since=0`)
  const events = Array.isArray(full.json?.events) ? full.json.events : []
  line(`since=0 → 事件数 ${events.length}，外壳 lastSeq ${show(full.json?.lastSeq)}`)
  if (events.length) {
    const dist = {}
    for (const e of events) dist[e.type] = (dist[e.type] ?? 0) + 1
    line(`事件类型分布: ${show(dist, 300)}`)
    inventory([events[0], events[events.length - 1]], '事件对象（首条与末条）')
    const seqs = events.map((e) => e.seq)
    line(`seq 序列（前 20）: ${seqs.slice(0, 20).join(',')}  最大 ${Math.max(...seqs)}  条数 ${seqs.length}`)
    line(`seq 是否严格递增: ${seqs.every((v, i) => i === 0 || v > seqs[i - 1])}`)
    line(`seq 是否连续无缺口: ${seqs.every((v, i) => i === 0 || v === seqs[i - 1] + 1)}（缺口=被压缩合并过）`)
    const mid = seqs[Math.floor(seqs.length / 2)]
    for (const [label, v] of [['since=0', 0], [`since=${mid}（取中间游标）`, mid], [`since=${Math.max(...seqs)}（取最大）`, Math.max(...seqs)], ['since=1（最小之后）', 1]]) {
      const r = await req('GET', `/sessions/${encodeURIComponent(probeId)}/events?since=${v}`)
      const got = Array.isArray(r.json?.events) ? r.json.events.map((e) => e.seq) : []
      const expectExclusive = seqs.filter((x) => x > v)
      line(`  ${label.padEnd(28)} → 收到 ${got.length} 条  期望(seq>since)=${expectExclusive.length} 条  ${got.length === expectExclusive.length ? '一致 ✓' : '不一致 ✗'}`)
    }
  } else {
    line('！无事件：该实例没有可用的模型凭据，prompt 未产生事件 —— 游标语义仍未证实')
  }
} else {
  line('（跳过：未设 PROBE_WITH_TURN=1）')
}

head('[8] 错误码')
const notFound = await req('GET', '/sessions/does-not-exist-at-all')
line(`GET /sessions/does-not-exist-at-all          → HTTP ${notFound.status} ${show(notFound.json, 160)}`)
const noToken = await req('GET', '/sessions', { token: '' })
line(`GET /sessions（不带令牌）                     → HTTP ${noToken.status} ${show(noToken.json, 160)}`)
const badToken = await req('GET', '/sessions', { token: 'definitely-wrong' })
line(`GET /sessions（错令牌）                       → HTTP ${badToken.status} ${show(badToken.json, 160)}`)
const evNotFound = await req('GET', '/sessions/does-not-exist-at-all/events?since=0')
line(`GET /sessions/<不存在>/events?since=0        → HTTP ${evNotFound.status} ${show(evNotFound.json, 160)}`)
line()
line('（探针结束；本轮只在隔离实例里建了 3 个会话，未触发任何模型调用）')
