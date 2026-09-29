/**
 * 天枢 serve 会话客户端 —— 桌面端原生会话通道（W5 改造核心）。
 *
 * 背景与实测依据（2026-09-24，test-serve 隔离实例实测）：
 * - 插件与 serve 同进程运行 → 可读 process.env.RIVET_SERVER_TOKEN 与 --port（argv）
 * - POST /sessions {cwd,title}                → 201 {id,status,lastSeq,...}（桌面端可见的会话）
 * - GET  /sessions/:id                        → 会话快照（含 lastSeq 游标）
 * - POST /sessions/:id/prompt {prompt}        → 200（异步启动；回复从事件流获取）
 * - GET  /sessions/:id/events?since=N         → {events:[{seq,ts,type,data}]}
 * - 回复文本 = type===text_delta 的 data.text 拼接
 * - 回合终结 = turn_complete 且 data.isFinal !== false；到达后留 grace 宽限
 *   （天枢可能在同一 prompt 下开启"自动补救轮"，宽限期内出现新文本则撤销完成、
 *   继续收集，直至再次终结——实测 probe2 的行为）
 *
 * 非 serve 环境（TUI/headless：无 token 或无 --port）→ available=false，
 * 调用方降级到 headless 通道。
 */

const DEFAULT_GRACE_MS = 3000
const DEFAULT_POLL_MS = 1200
const DEFAULT_TIMEOUT_MS = 180_000

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

// ── 纯函数区（单元测试覆盖）─────────────────────────────────────

/**
 * 从 argv 里解析 serve 端口；非法/缺省返回 null。两种写法都认：`--port N` / `--port=N`。
 *
 * 只接受「独立成元素」的 flag：headless 路径会把用户消息正文作为一个 argv 元素传进来
 * （`main.js -p <消息> --json`），若扫描其它元素的前缀，一条正文形如 `--port=27015 …`
 * 的消息就会被当成本机 serve 端口。另要求 argv 里确有 `serve` 子命令，双重排除。
 */
export function parseServerPort(argv) {
  if (!Array.isArray(argv) || !argv.includes('serve')) return null
  const idx = argv.indexOf('--port')
  let raw = idx >= 0 ? argv[idx + 1] : undefined
  if (raw === undefined) {
    const inline = argv.find((a) => typeof a === 'string' && /^--port=\d+$/.test(a))
    raw = inline?.slice('--port='.length)
  }
  const port = Number.parseInt(raw, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

/** 探测 serve 环境：token（env）+ 端口（argv）。 */
export function probeServerEnv(env = process.env, argv = process.argv) {
  const token = typeof env?.RIVET_SERVER_TOKEN === 'string' && env.RIVET_SERVER_TOKEN.trim()
    ? env.RIVET_SERVER_TOKEN.trim()
    : null
  const port = parseServerPort(argv)
  return { available: Boolean(token && port), token, port }
}

/**
 * 回合累积器（纯逻辑：喂事件、问完成）。
 * - seq 去重（轮询可能重叠）
 * - 宽限期内出现新文本 → 撤销终结（补救轮）
 * - turn_complete 缺 isFinal 字段时宽容视为终结；isFinal===false 不计
 */
export class TurnAccumulator {
  #seen = new Set()
  #parts = []
  #lastSeq = 0
  #finalSeenAt = null
  #graceMs
  // 交互事件（等待用户选择）：提问卡片与审批请求
  #questions = []
  #approvals = new Map() // requestId -> { requestId, toolName, input }
  #approvalSeenAt = null

  constructor({ graceMs = DEFAULT_GRACE_MS } = {}) {
    this.#graceMs = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : DEFAULT_GRACE_MS
  }

  feed(events, nowMs = Date.now()) {
    for (const ev of Array.isArray(events) ? events : []) {
      if (!ev || typeof ev.seq !== 'number' || this.#seen.has(ev.seq)) continue
      this.#seen.add(ev.seq)
      if (ev.seq > this.#lastSeq) this.#lastSeq = ev.seq

      if (ev.type === 'text_delta') {
        const text = typeof ev.data?.text === 'string' ? ev.data.text : ''
        if (text) {
          this.#parts.push(text)
          this.#finalSeenAt = null // 新内容 → 尚未真正终结
        }
      } else if (ev.type === 'turn_complete' && ev.data?.isFinal !== false) {
        this.#finalSeenAt = nowMs
      } else if (ev.type === 'user_question') {
        // 提问卡片：回合以「交回控制权」方式结束，问题与选项需转发给用户
        this.#questions.push(ev.data ?? {})
      } else if (ev.type === 'approval_required') {
        // 审批请求：回合就此挂起，等用户批准 / 拒绝
        const requestId = typeof ev.data?.requestId === 'string' ? ev.data.requestId : null
        if (requestId) {
          this.#approvals.set(requestId, {
            requestId,
            toolName: ev.data?.toolName ?? null,
            input: ev.data?.input ?? null,
          })
          if (this.#approvalSeenAt === null) this.#approvalSeenAt = nowMs
        }
      } else if (ev.type === 'approval_resolved') {
        const requestId = typeof ev.data?.requestId === 'string' ? ev.data.requestId : null
        if (requestId) this.#approvals.delete(requestId)
        if (this.#approvals.size === 0) this.#approvalSeenAt = null
      }
    }
    return this
  }

  text() {
    return this.#parts.join('')
  }

  lastSeq() {
    return this.#lastSeq
  }

  /** 本回合出现的提问卡片（user_question 载荷）。 */
  questions() {
    return [...this.#questions]
  }

  /** 仍未解决的审批请求（approval_required 未配 approval_resolved）。 */
  pendingApprovals() {
    return [...this.#approvals.values()]
  }

  /** 首次观察到未决审批的时刻（ms）；没有未决项时为 null。观察窗计时用。 */
  pendingSince() {
    return this.#approvalSeenAt
  }

  isComplete(nowMs = Date.now()) {
    return this.#finalSeenAt !== null && nowMs - this.#finalSeenAt >= this.#graceMs
  }
}

// ── 客户端（IO 区）──────────────────────────────────────────────

export class ServeSessionClient {
  #baseUrl
  #token
  #fetch
  #requestTimeoutMs

  constructor({ token, port, fetchImpl, requestTimeoutMs = 15_000 } = {}) {
    if (!token || !port) throw new TypeError('ServeSessionClient 需要 token 与 port')
    this.#token = token
    this.#baseUrl = `http://127.0.0.1:${port}`
    this.#fetch = fetchImpl ?? globalThis.fetch
    this.#requestTimeoutMs = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
      ? requestTimeoutMs
      : 15_000
  }

  get available() {
    return true
  }

  get baseUrl() {
    return this.#baseUrl
  }

  /** 单次请求封顶（默认 15s）：socket 不响应时不能把整条会话线一起拖住。 */
  async #request(method, path, body, timeoutMs = this.#requestTimeoutMs) {
    const response = await this.#fetch(this.#baseUrl + path, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const json = await response.json().catch(() => null)
    return { status: response.status, json }
  }

  /** 创建会话（桌面端原生）。返回 { id, ... }（含 lastSeq）。 */
  async createSession({ cwd, title } = {}) {
    const { status, json } = await this.#request('POST', '/sessions', { cwd, title })
    if (status !== 200 && status !== 201) {
      const error = new Error(`createSession 失败（HTTP ${status}）: ${json?.error ?? ''}`)
      error.code = 'create-failed'
      throw error
    }
    return json
  }

  /** 会话清单（桌面端会话目录里的那一份）。 */
  async listSessions({ includeArchived = false } = {}) {
    const { status, json } = await this.#request(
      'GET',
      includeArchived ? '/sessions?includeArchived=true' : '/sessions',
    )
    if (status !== 200) {
      const error = new Error(`会话清单失败（HTTP ${status}）`)
      error.code = 'sessions-failed'
      throw error
    }
    return Array.isArray(json?.sessions) ? json.sessions : []
  }

  /** 会话快照（含 lastSeq 游标）；只有 404 才算「会话已消失」返回 null。 */
  async getSession(id) {
    const { status, json } = await this.#request('GET', `/sessions/${encodeURIComponent(id)}`)
    if (status === 404) return null
    if (status !== 200) {
      // 500/401 等是暂时性故障：不能当成会话消失，否则调用方会清掉持久绑定
      const error = new Error(`会话快照失败（HTTP ${status}）: ${json?.error ?? ''}`)
      error.code = 'snapshot-failed'
      throw error
    }
    return json
  }

  /** 向会话发送消息（异步启动；回复经事件流获取）。 */
  async promptSession(id, prompt) {
    const { status, json } = await this.#request(
      'POST',
      `/sessions/${encodeURIComponent(id)}/prompt`,
      { prompt },
      DEFAULT_TIMEOUT_MS, // 服务端可能阻塞到本轮 settle，给它整轮预算
    )
    if (status === 404) {
      const error = new Error('Session not found')
      error.code = 'session-not-found'
      throw error
    }
    if (status !== 200) {
      const error = new Error(`prompt 失败（HTTP ${status}）: ${json?.error ?? ''}`)
      error.code = 'prompt-failed'
      throw error
    }
    return { ok: true }
  }

  /** 拉取 since 之后的事件。非 200 抛出（轮询循环会记录它，别把 401/500 吞成「没有新事件」）。 */
  async fetchEvents(id, since = 0) {
    const { status, json } = await this.#request(
      'GET',
      `/sessions/${encodeURIComponent(id)}/events?since=${Number(since) || 0}`,
    )
    if (status !== 200) {
      const error = new Error(`事件流失败（HTTP ${status}）: ${json?.error ?? ''}`)
      error.code = 'events-failed'
      throw error
    }
    return json ?? { events: [] }
  }

  /**
   * 回答干预请求（审批）：向挂起的会话提交批准 / 拒绝。
   * - 404「Pending intervention not found」→ code=intervention-not-found
   *   （多半已在桌面端处理过；调用方应清理本地等待态）
   * - 其它非 200 → code=answer-failed
   */
  async answerIntervention(id, requestId, { decision = 'approve' } = {}) {
    const { status, json } = await this.#request(
      'POST',
      `/sessions/${encodeURIComponent(id)}/interventions/${encodeURIComponent(requestId)}/answer`,
      { decision },
    )
    if (status === 404) {
      const error = new Error('Pending intervention not found')
      error.code = 'intervention-not-found'
      throw error
    }
    if (status !== 200) {
      const error = new Error(`回答失败（HTTP ${status}）: ${json?.error ?? ''}`)
      error.code = 'answer-failed'
      throw error
    }
    return { ok: true }
  }

  /**
   * 等待回合回复。
   * - 只收 `seq > since` 的事件：本轮回复就是基线之后的内容，这一步不外包给服务端过滤。
   * - 事件按 seq 增量拉取，因此轮询期间的单次网络抖动不致命：记下错误继续轮询，
   *   抖动过去后照旧补齐（否则一次 DNS 抖动就会毁掉整轮回复）。
   * - 一路失败到 deadline 时，把最后一次错误随结果带出，供调用方分辨
   *   「连接中断」与「回合迟迟不结束」。
   * @returns {Promise<{text: string, lastSeq: number, timedOut: boolean, error: Error|null}>}
   */
  async waitForReply(id, {
    since = 0,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    graceMs = DEFAULT_GRACE_MS,
    pollMs = DEFAULT_POLL_MS,
  } = {}) {
    const acc = new TurnAccumulator({ graceMs })
    const baseline = Number(since) || 0
    const deadline = Date.now() + timeoutMs
    let lastError = null
    for (;;) {
      try {
        const page = await this.fetchEvents(id, Math.max(baseline, acc.lastSeq()))
        const fresh = (page?.events ?? []).filter(
          (ev) => !(Number.isFinite(ev?.seq) && ev.seq <= baseline),
        )
        acc.feed(fresh, Date.now())
        lastError = null
      } catch (error) {
        lastError = error
      }
      if (acc.isComplete(Date.now())) {
        return {
          text: acc.text(),
          lastSeq: acc.lastSeq(),
          timedOut: false,
          error: null,
          questions: acc.questions(),
          needInput: null,
        }
      }
      // 审批挂起：先给桌面端留观察窗（graceMs 内可能就被人处理掉），仍未解决就交回调用方转发 QQ
      const pending = acc.pendingApprovals()
      if (pending.length > 0) {
        const seenAt = acc.pendingSince()
        if (seenAt !== null && Date.now() - seenAt >= graceMs) {
          return {
            text: acc.text(),
            lastSeq: acc.lastSeq(),
            timedOut: false,
            error: null,
            questions: acc.questions(),
            needInput: { approvals: pending },
          }
        }
      }
      if (Date.now() >= deadline) {
        return {
          text: acc.text(),
          lastSeq: acc.lastSeq(),
          timedOut: true,
          error: lastError,
          questions: acc.questions(),
          needInput: null,
        }
      }
      await sleep(pollMs)
    }
  }
}

/** 运行环境探测 → 客户端（不可用时返回 null）。 */
export function createServeClientIfAvailable({
  env = process.env,
  argv = process.argv,
  fetchImpl,
} = {}) {
  const probe = probeServerEnv(env, argv)
  if (!probe.available) return null
  try {
    return new ServeSessionClient({ token: probe.token, port: probe.port, fetchImpl })
  } catch {
    return null
  }
}
