/**
 * 事件还原探针 —— 验证「事件流 → 用户/助手消息序列」是否可行。
 *
 * 需要隔离 serve 实例（自设令牌）。会真实跑两轮对话（消耗模型 token）。
 * 输出：还原出的序列、与实况的逐条对照、事件类型普查、窗口边界观测。
 *
 * 用法：PROBE_BASE=http://127.0.0.1:11803 PROBE_TOKEN=... "<天枢 node>" tools/probe-reconstruct.mjs
 */
const BASE = (process.env.PROBE_BASE ?? 'http://127.0.0.1:11803').replace(/\/+$/, '')
const TOKEN = process.env.PROBE_TOKEN ?? ''
const WS = 'D:/path/to/scratch/recon-ws'
const line = (s = '') => console.log(s)

// ── 还原原型（本小类只做可行性验证，正式实现属后续小类）──────────
export function reconstructMessages(events) {
  const out = []
  let cur = null
  const flush = () => { if (cur && cur.text) out.push(cur); cur = null }
  for (const e of events ?? []) {
    if (e?.type === 'user') {
      const t = e.data?.text
      if (typeof t === 'string' && t) { flush(); out.push({ role: 'user', text: t, fromSeq: e.seq, toSeq: e.seq }) }
    } else if (e?.type === 'text_delta') {
      const t = e.data?.text
      if (typeof t === 'string' && t) {
        if (!cur) cur = { role: 'assistant', text: '', fromSeq: e.seq, toSeq: e.seq }
        cur.text += t; cur.toSeq = e.seq
      }
    } else if (e?.type === 'turn_complete') {
      flush()
    }
  }
  flush()
  return out
}

const req = async (m, p, { token = TOKEN, body } = {}) => {
  const r = await fetch(BASE + p, {
    method: m,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let j = null; try { j = await r.json() } catch { /* 空体 */ }
  return { status: r.status, json: j }
}

/** 发一轮并等到回合终结，返回该轮之后的完整事件流。 */
async function turn(id, prompt, timeoutMs = 120000) {
  const before = await req('GET', `/sessions/${id}/events?since=0`)
  const baseSeq = before.json?.lastSeq ?? 0
  const sent = await req('POST', `/sessions/${id}/prompt`, { body: { prompt } })
  if (sent.status !== 200) line(`  ！prompt 返回 HTTP ${sent.status}：${JSON.stringify(sent.json).slice(0, 300)}`)
  const t0 = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 1200))
    const page = await req('GET', `/sessions/${id}/events?since=${baseSeq}`)
    const events = (page.json?.events ?? []).filter((e) => e.seq > baseSeq)
    const final = events.find((e) => e.type === 'turn_complete' && e.data?.isFinal !== false)
    if (final && Date.now() - t0 > 3000) return { sent: sent.status, baseSeq, events, elapsedMs: Date.now() - t0 }
    if (Date.now() - t0 > timeoutMs) return { sent: sent.status, baseSeq, events, elapsedMs: Date.now() - t0, timedOut: true }
  }
}

line('# 事件还原可行性实测')
line(`时间 ${new Date().toISOString()}  实例 ${BASE}  令牌 ${TOKEN.slice(0, 6)}***`)
line()

line('## [1] 建会话并跑真实两轮对话')
const created = await req('POST', '/sessions', { body: { cwd: WS, title: '{recon} 还原对照' } })
const id = created.json?.id
line(`POST /sessions → HTTP ${created.status}  id=${id}`)
line('  （等 2s 让会话就绪：实测刚建完立刻 prompt 会撞上竞态，返回 400）')
await new Promise((r) => setTimeout(r, 2000))
const prompts = ['请只回复四个字：第一轮好', '请只回复四个字：第二轮好']
const rounds = []
for (const p of prompts) {
  const r = await turn(id, p)
  rounds.push(r)
  const txt = (r.events ?? []).filter((e) => e.type === 'text_delta').map((e) => e.data.text).join('')
  line(`  发「${p}」→ HTTP ${r.sent}，${r.elapsedMs}ms，本轮事件 ${r.events.length} 条，回复文本 ${JSON.stringify(txt)}`)
}
line()

line('## [2] 拉完整事件流并还原')
const full = await req('GET', `/sessions/${id}/events?since=0`)
const events = full.json?.events ?? []
line(`since=0 → HTTP ${full.status}，事件 ${events.length} 条，外壳 lastSeq ${full.json?.lastSeq}`)
const dist = {}
for (const e of events) dist[e.type] = (dist[e.type] ?? 0) + 1
line(`事件类型分布: ${JSON.stringify(dist)}`)
const seqs = events.map((e) => e.seq)
line(`seq 范围 ${Math.min(...seqs)}..${Math.max(...seqs)}  严格递增 ${seqs.every((v, i) => i === 0 || v > seqs[i - 1])}  连续无缺口 ${seqs.every((v, i) => i === 0 || v === seqs[i - 1] + 1)}`)
const reconstructed = reconstructMessages(events)
line(`还原出 ${reconstructed.length} 条消息`)
for (const m of reconstructed) line(`   ${m.role.padEnd(9)} seq ${m.fromSeq}-${m.toSeq}  ${JSON.stringify(m.text.slice(0, 60))}`)
line()

line('## [3] 与对话实况逐条对照')
const expectedRoles = ['user', 'assistant', 'user', 'assistant']
let pass = 0
for (let i = 0; i < expectedRoles.length; i += 1) {
  const got = reconstructed[i]
  const roleOk = got?.role === expectedRoles[i]
  let textOk = roleOk
  let note = ''
  if (roleOk && got.role === 'user') { textOk = got.text === prompts[i >> 1]; note = textOk ? '与发送内容一致 ✓' : `期望 ${JSON.stringify(prompts[i >> 1])}` }
  else if (roleOk) { note = '非空 + 顺序正确' ; textOk = typeof got.text === 'string' && got.text.length > 0 }
  line(`  #${i + 1} 期望 ${expectedRoles[i].padEnd(9)} 实得 ${String(got?.role).padEnd(9)} ${textOk ? '✓' : '✗'}  ${note}`)
  if (textOk) pass += 1
}
line(`  逐条对照通过 ${pass}/${expectedRoles.length}`)
line()

line('## [4] 压缩合并的观测（把一份真实生产会话搬进来量）')
const list = await req('GET', '/sessions')
const prod = (list.json?.sessions ?? []).find((s) => s.id === '2026092356ddae79dff4')
if (prod) {
  const ev = await req('GET', '/sessions/2026092356ddae79dff4/events?since=0')
  const pe = ev.json?.events ?? []
  const pseq = pe.map((e) => e.seq)
  const pdist = {}
  for (const e of pe) pdist[e.type] = (pdist[e.type] ?? 0) + 1
  line(`  会话 lastSeq（元数据） = ${prod.lastSeq}`)
  line(`  实际收到事件 ${pe.length} 条，seq 范围 ${Math.min(...pseq)}..${Math.max(...pseq)}`)
  line(`  → 缺口 = lastSeq - 最大 seq = ${prod.lastSeq - Math.max(...pseq)}；起点偏移 = 最小 seq - 1 = ${Math.min(...pseq) - 1}`)
  line(`  类型分布: ${JSON.stringify(pdist)}`)
  line(`  是否存在名为 compacted/merged 的事件: ${Object.keys(pdist).some((k) => /compact|merge/i.test(k))}`)
  const rec = reconstructMessages(pe)
  const users = rec.filter((m) => m.role === 'user')
  line(`  还原结果: 共 ${rec.length} 条（user ${users.length} / assistant ${rec.length - users.length}）`)
  line(`  user 文本: ${JSON.stringify(users.map((m) => m.text.slice(0, 24)))}`)
} else {
  line('  （未找到搬入的生产会话）')
}
line()
line('（探针结束；真实对话两轮，其余为只读读取）')
