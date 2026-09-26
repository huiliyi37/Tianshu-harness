#!/usr/bin/env node
/**
 * R 阶段端到端验证脚本（星域硬化）。
 *
 * 针对一个真实 git 仓库（默认 cangzhe）启动 `rivet serve` sidecar，用真实模型
 * 驱动 agent，逐项验证：
 *   R1  会话登记进 SessionRegistry（registry.db sessions 表）
 *   R3  回滚 preview/execute + git 还原（agent 新建文件被 rollback 移除）
 *   R1' 终态释放 claim
 *   R2  并发写冲突阻断（注入他会话独占 claim → 本会话写同名文件被 fail-closed）
 *   R4/R5 扫描事件流是否出现 decision_shift（简单任务通常不触发，仅信息性报告）
 *
 * 用法：
 *   node scripts/r-e2e.mjs [目标仓库路径]
 *
 * 说明：
 *   - 模型 key 直接读 ~/.rivet/config.json（你现在的配置）。
 *   - desktop 状态（registry.db / sessions）写到临时目录，跑完删除，不污染 ~/.rivet。
 *   - 自动应答审批（approve）与意图预览（continue），无需人工干预。
 *   - 在目标仓库只创建 scratch 文件，结尾用 rollback + git 清理还原。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const REPO = process.argv[2] || '/Users/banxia/app/deepseek-tui/cangzhe'
const PORT = 3199
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = `r-e2e-${Date.now()}`
const SCRATCH_A = 'r-e2e-scratch.txt'      // R3：agent 新建 → 回滚移除
const SCRATCH_B = 'r-e2e-blocked.txt'      // R2：被他会话独占，写入应被阻断
const SCRATCH_T = 'r-e2e-steer.txt'        // T3：运行中 steer 会话的产物

const stateDir = mkdtempSync(join(tmpdir(), 'r-e2e-'))
const registryDbPath = join(stateDir, 'registry.db')

const log = (...a) => console.log(...a)
const ok = (m) => log(`  \x1b[32m✔\x1b[0m ${m}`)
const bad = (m) => log(`  \x1b[31m✖\x1b[0m ${m}`)
const hdr = (m) => log(`\n\x1b[1m${m}\x1b[0m`)

let failures = 0
function check(cond, msg) { if (cond) ok(msg); else { bad(msg); failures++ } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(path, init = {}) {
  const headers = { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) }
  if (init.body) headers['Content-Type'] = 'application/json'
  const res = await fetch(BASE + path, { ...init, headers })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : {} } catch { json = { _raw: text } }
  return { status: res.status, json }
}

const createSession = (cwd, prompt, approvalMode) =>
  api('/sessions', { method: 'POST', body: JSON.stringify({ cwd, prompt, approvalMode }) })

const getEvents = (sid, since = 0) => api(`/sessions/${sid}/events?since=${since}`)

/**
 * 轮询会话事件直到出现 done，同时自动应答审批/意图。返回全部事件。
 */
async function waitDone(sid, timeoutMs = 240000) {
  const start = Date.now()
  let since = 0
  const all = []
  while (Date.now() - start < timeoutMs) {
    const { json } = await getEvents(sid, since)
    const events = json.events || []
    for (const ev of events) {
      all.push(ev)
      since = Math.max(since, ev.seq)
      if (ev.type === 'approval_required') {
        await api(`/sessions/${sid}/interventions/${ev.data.requestId}/answer`,
          { method: 'POST', body: JSON.stringify({ decision: 'approve' }) })
      }
      // intent_note is a non-blocking direction note — nothing to answer.
    }
    if (all.some((e) => e.type === 'done')) return all
    await sleep(800)
  }
  throw new Error(`waitDone timeout for ${sid}`)
}

function openRegistry() {
  const Database = require('better-sqlite3')
  return new Database(registryDbPath)
}

function gitClean() {
  const { spawnSync } = require('node:child_process')
  const scratch = [SCRATCH_A, SCRATCH_B, SCRATCH_T, 'r-e2e-autonomy.txt']
  for (const f of scratch) {
    try { rmSync(join(REPO, f), { force: true }) } catch { /* ignore */ }
  }
  // 还原任何被 agent 改动的已跟踪文件（保守：只 checkout scratch 名，若被跟踪）
  spawnSync('git', ['checkout', '--', ...scratch], { cwd: REPO, windowsHide: true })
}

async function main() {
  if (!existsSync(REPO)) throw new Error(`目标仓库不存在: ${REPO}`)
  if (!existsSync(join(ROOT, 'dist', 'main.js'))) {
    throw new Error('dist/main.js 不存在，请先在 opencode-tui 跑 `npm run build`')
  }
  log(`目标仓库 : ${REPO}`)
  log(`状态目录 : ${stateDir}`)
  log(`端口/令牌: ${PORT} / ${TOKEN}`)

  // 启动 sidecar（模型 key 来自 ~/.rivet/config.json；desktop 状态隔离到临时目录）
  hdr('启动 sidecar')
  const child = spawn('node', ['dist/main.js', 'serve', '--port', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, RIVET_SERVER_TOKEN: TOKEN, RIVET_DESKTOP_DIR: stateDir, RIVET_DESKTOP_SESSION_DIR: join(stateDir, 'sessions') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let serverLog = ''
  child.stdout.on('data', (d) => { serverLog += d })
  child.stderr.on('data', (d) => { serverLog += d })

  // 等待 health
  let up = false
  for (let i = 0; i < 40; i++) {
    try { const { status } = await api('/health'); if (status === 200) { up = true; break } } catch { /* not yet */ }
    await sleep(300)
  }
  if (!up) { log(serverLog); throw new Error('sidecar 未就绪') }
  ok('sidecar 已就绪')
  check(existsSync(registryDbPath), 'R1: registry.db 已创建')

  try {
    // ── R1 + R3：建文件 → 登记 → 预览 → 回滚 → git 还原 ──
    hdr('R3/R1: 让 agent 新建文件，再预览+回滚')
    const r3 = await createSession(REPO,
      `请在仓库根目录创建一个新文件 ${SCRATCH_A}，内容写一行：HELLO-FROM-R-E2E。用 write_file 工具完成，不要做别的。`)
    check(r3.status === 201, `R3: 会话创建 (HTTP ${r3.status})`)
    const sidA = r3.json.id

    // R1：会话应已登记进 registry
    {
      const db = openRegistry()
      const row = db.prepare('SELECT id, cwd, role FROM sessions WHERE id = ?').get(sidA)
      db.close()
      check(row && row.cwd === REPO && row.role === 'standalone',
        `R1: 会话登记入 registry (${row ? row.role : '缺失'})`)
    }

    await waitDone(sidA)
    check(existsSync(join(REPO, SCRATCH_A)), `R3: agent 已创建 ${SCRATCH_A}`)

    // R1'：终态后 claim 应被释放
    {
      const db = openRegistry()
      const claims = db.prepare('SELECT file_path FROM claims WHERE session_id = ?').all(sidA)
      db.close()
      check(claims.length === 0, `R1': 终态释放了会话 claim (剩余 ${claims.length})`)
    }

    // R3：预览
    const prev = await api(`/sessions/${sidA}/rollback/preview`)
    check(prev.status === 200 && prev.json.available === true, 'R3: 回滚预览 available=true')
    check(typeof prev.json.text === 'string' && prev.json.text.includes(SCRATCH_A),
      `R3: 预览文本包含 ${SCRATCH_A}`)
    log(`    预览:\n${(prev.json.text || '').split('\n').map((l) => '      ' + l).join('\n')}`)

    // R3：执行回滚
    const exec = await api(`/sessions/${sidA}/rollback`, {
      method: 'POST', body: JSON.stringify({ confirmationToken: prev.json.confirmationToken }),
    })
    check(exec.status === 200 && exec.json.success === true, `R3: 回滚执行 success (HTTP ${exec.status})`)
    check(!existsSync(join(REPO, SCRATCH_A)), `R3: 回滚后 ${SCRATCH_A} 已被移除`)

    // ── R2：注入他会话独占 claim → 本会话写同名文件应被阻断 ──
    hdr('R2: 并发写冲突阻断')
    {
      const db = openRegistry()
      // 模拟一个"活着的"他会话占用 SCRATCH_B（pid 用当前 sidecar pid 以免被 reap）
      db.prepare('INSERT OR REPLACE INTO sessions (id, pid, cwd, started_at, heartbeat_at, role) VALUES (?,?,?,?,?,?)')
        .run('peer-e2e', child.pid, REPO, new Date().toISOString(), new Date().toISOString(), 'standalone')
      db.prepare('INSERT OR REPLACE INTO claims (session_id, file_path, claim_type, acquired_at) VALUES (?,?,?,?)')
        .run('peer-e2e', SCRATCH_B, 'exclusive', new Date().toISOString())
      db.close()
      ok(`已注入他会话 peer-e2e 对 ${SCRATCH_B} 的独占 claim`)
    }
    const r2 = await createSession(REPO,
      `请用 write_file 工具创建文件 ${SCRATCH_B}，内容写一行：SHOULD-BE-BLOCKED。只做这一件事。`)
    const sidB = r2.json.id
    const evB = await waitDone(sidB)
    const blocked = evB.some((e) =>
      e.type === 'tool_result' && e.data.isError &&
      /阻断|另一个会话/.test(String(e.data.result || '')))
    check(blocked, 'R2: 写入被 fail-closed 阻断（tool_result isError 含"阻断/另一个会话"）')
    check(!existsSync(join(REPO, SCRATCH_B)), `R2: ${SCRATCH_B} 未被写入磁盘`)

    // ── S：自治档 —— 项目内写文件全程无审批事件 ──
    hdr('S: 自治档无审批闭环')
    {
      const SCRATCH_S = 'r-e2e-autonomy.txt'
      try { rmSync(join(REPO, SCRATCH_S), { force: true }) } catch { /* ignore */ }
      const rS = await createSession(REPO,
        `请用 write_file 工具创建文件 ${SCRATCH_S}，内容写一行：AUTONOMY-OK。只做这一件事。`,
        'dangerously-skip-permissions')
      check(rS.status === 201 && rS.json.approvalMode === 'dangerously-skip-permissions',
        `S: 自治会话创建并回显档位 (HTTP ${rS.status})`)
      const sidS = rS.json.id
      const evS = await waitDone(sidS)
      const askedApproval = evS.some((e) => e.type === 'approval_required')
      check(!askedApproval, 'S: 项目内写入全程未触发 approval_required')
      check(existsSync(join(REPO, SCRATCH_S)), `S: agent 已自动写出 ${SCRATCH_S}`)
      try { rmSync(join(REPO, SCRATCH_S), { force: true }) } catch { /* ignore */ }
      // 还原（自治档同样写 checkpoint，回滚可用）
      const pv = await api(`/sessions/${sidS}/rollback/preview`)
      if (pv.json.available && pv.json.confirmationToken) {
        await api(`/sessions/${sidS}/rollback`, {
          method: 'POST', body: JSON.stringify({ confirmationToken: pv.json.confirmationToken }),
        })
      }
    }

    // ── T3：运行中 Steer（运行入队 / idle 409）──
    hdr('T3: 运行中 Steer（运行入队 / idle 409）')
    try { rmSync(join(REPO, SCRATCH_T), { force: true }) } catch { /* ignore */ }
    const rT = await createSession(REPO,
      `请分两步：先用 glob 列出仓库根目录文件，再用 write_file 创建 ${SCRATCH_T} 写一行 STEER-OK。`,
      'dangerously-skip-permissions')
    const sidT = rT.json.id
    // 抓住 running 窗口（出现任意事件且未 done）尝试入队 steering，同时自动应答意图
    let queued = false
    {
      const start = Date.now()
      while (Date.now() - start < 60000) {
        const { json } = await getEvents(sidT, 0)
        const evs = json.events || []
        if (evs.some((e) => e.type === 'done')) break
        if (evs.length > 0) {
          const sres = await api(`/sessions/${sidT}/steer`,
            { method: 'POST', body: JSON.stringify({ text: '保持改动最小，只创建那一个文件' }) })
          if (sres.status === 200 && sres.json.queued) { queued = true; break }
        }
        await sleep(400)
      }
    }
    const evT = await waitDone(sidT)
    if (queued) {
      check(evT.some((e) => e.type === 'steer_queued'),
        'T3: 运行中 POST /steer 入队并回显 steer_queued 事件')
    } else {
      log('    （运行太快，未抓到 running 窗口，跳过入队断言——信息性）')
    }
    // idle 后再 steer 应 409
    const idleSteer = await api(`/sessions/${sidT}/steer`,
      { method: 'POST', body: JSON.stringify({ text: 'x' }) })
    check(idleSteer.status === 409, 'T3: idle 会话 POST /steer 返回 409（提示用 /prompt）')
    // 还原 steer 会话产物
    {
      const pv = await api(`/sessions/${sidT}/rollback/preview`)
      if (pv.json.available && pv.json.confirmationToken) {
        await api(`/sessions/${sidT}/rollback`,
          { method: 'POST', body: JSON.stringify({ confirmationToken: pv.json.confirmationToken }) })
      }
      try { rmSync(join(REPO, SCRATCH_T), { force: true }) } catch { /* ignore */ }
    }

    // ── T1/T2/T4：过程外显事件扫描（信息性，依赖模型行为）──
    hdr('T1/T2/T4: 过程外显事件扫描（信息性）')
    const tScan = [...await getEvents(sidA).then((r) => r.json.events || []), ...evB, ...evT]
    const countType = (t) => tScan.filter((e) => e.type === t).length
    log(`    thinking_delta: ${countType('thinking_delta')}  turn_complete: ${countType('turn_complete')}  checkpoint: ${countType('checkpoint')}`)
    log(`    todo_state: ${countType('todo_state')}  delegation: ${countType('delegation')}`)
    const perWorker = tScan.filter((e) => e.type === 'delegation'
      && (e.data.progressLine != null || ['passed', 'failed', 'blocked', 'escalated'].includes(String(e.data.status))))
    if (perWorker.length > 0) {
      ok(`T4: 捕获到 ${perWorker.length} 条 per-worker 结构化 delegation`)
      for (const d of perWorker.slice(0, 4)) log(`      - ${d.data.workerId} [${d.data.status}] ${d.data.progressLine ?? ''}`)
    } else {
      log('    （未触发子代理委派——简单任务通常不 delegate，属正常）')
    }
    if (countType('turn_complete') > 0) ok('T1: 出现 turn_complete 轮次事件')
    if (countType('todo_state') > 0) ok('T2: 出现 todo_state 任务清单事件')

    // ── R4/R5：扫描 decision_shift（信息性）──
    hdr('R4/R5: 扫描 decision_shift 事件（简单任务通常不触发）')
    const allEv = [...await getEvents(sidA).then((r) => r.json.events || []),
                   ...evB]
    const shifts = allEv.filter((e) => e.type === 'decision_shift')
    log(`    本次出现 decision_shift 事件: ${shifts.length} 个`)
    if (shifts.length > 0) {
      for (const s of shifts) log(`      - [${s.data.source}] ${s.data.reason}`)
      ok('R4/R5: 捕获到改道事件')
    } else {
      log('    （未触发——需要 agent 真陷入停滞才会发出，属正常）')
    }
  } finally {
    hdr('清理')
    gitClean()
    child.kill('SIGTERM')
    await sleep(500)
    try { rmSync(stateDir, { recursive: true, force: true }) } catch { /* ignore */ }
    ok('已停止 sidecar、删除临时状态、还原 scratch 文件')
  }

  hdr(failures === 0 ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m${failures} 项失败\x1b[0m`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  bad(String(err && err.stack || err))
  try { gitClean() } catch { /* ignore */ }
  try { rmSync(stateDir, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(1)
})
