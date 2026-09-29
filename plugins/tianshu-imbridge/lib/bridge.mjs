/**
 * 消息桥：QQ 消息 → 天枢 → 回复 QQ。双模式（W5 改造）：
 *
 * ① serve 原生会话模式（优先）：当插件运行在 serve 进程内（可拿到 token+端口），
 *    每个 QQ 对话线绑定一个「桌面端原生会话」——首条消息创建会话（桌面端列表可见）、
 *    后续消息走该会话的 prompt，回复经事件流（text_delta + turn_complete）收集。
 *    行为与 dsh-im 的会话绑定同构：一条对话线 = 一个持久会话。
 * ② headless 降级模式：非 serve 环境（TUI/独立运行）沿用 headless 调用
 *    （每会话独立 cwd + 客户端历史注入；见 history.mjs / tianshu.mjs）。
 *
 * 依赖全部注入，便于测试：
 * - call / historyStore：headless 路径
 * - serveClient / sessionMap：serve 路径
 * - send / ensureDir：公共
 * - onCommand：命令层（`/` 开头且形状合法的消息交给它，不送模型、不动绑定）
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { formatPrompt } from './history.mjs'
import { firstUseHint, parseCommand } from './command.mjs'
import { planReply } from './reply.mjs'

/** 会话标识：私聊=c2c:<senderId>；群=group:<groupOpenid>（dsh-im 同款口径）。 */
export function conversationKey(message) {
  if (message?.kind === 'group') {
    return `group:${message?.groupOpenid ?? message?.senderId ?? 'unknown'}`
  }
  return `c2c:${message?.senderId ?? 'unknown'}`
}

/** 会话键 → 文件系统安全的稳定目录名（headless 模式的隔离目录用）。 */
export function conversationDirName(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 16)
}

/** 由首条消息生成会话标题（桌面端列表可读）。 */
export function sessionTitleFor(content) {
  const flat = String(content ?? '').replace(/\s+/g, ' ').trim()
  return flat ? `QQ: ${flat.slice(0, 30)}` : 'QQ 对话'
}

/** 按 key 串行的轻量任务队列（前序失败不阻塞后续）。 */
export class MessageQueue {
  #chains = new Map()

  run(key, task) {
    const prev = this.#chains.get(key) ?? Promise.resolve()
    const next = prev.then(task, task)
    // 存"吞错版"防止链断；返回原文给调用方感知失败。
    this.#chains.set(key, next.then(() => undefined, () => undefined))
    return next
  }
}

// ── 交互闭环：审批回决与提问回答的文本处理（纯函数，单测覆盖）──

const APPROVE_WORDS = new Set(['批准', '同意', '允许', '通过', '确认', '可以', 'approve', 'ok'])
const DENY_WORDS = new Set(['拒绝', '驳回', '不同意', '不许', '取消', 'deny', 'reject'])

/**
 * 「批准 / 拒绝」词表解析：去掉句尾标点后整句精确匹配（不做包含匹配，
 * 免得把普通聊天里顺带的词误当决定）。不在词表内返回 null。
 */
export function parseApprovalReply(content) {
  const t = String(content ?? '').trim().replace(/[。.!！,，、~～]+$/u, '').toLowerCase()
  if (!t) return null
  if (APPROVE_WORDS.has(t)) return 'approve'
  if (DENY_WORDS.has(t)) return 'deny'
  return null
}

/**
 * 提问回答的编号翻译：单问题、且回复是纯数字（可逗号/空格分隔）时，
 * 把 1/2/3 换成选项原文。越界、多问题、非数字一律原样返回（交给模型自己理解）。
 */
export function translateAnswer(content, interactions) {
  const flat = []
  for (const x of Array.isArray(interactions) ? interactions : []) {
    for (const q of x?.questions ?? []) flat.push(q)
  }
  if (flat.length !== 1) return content
  const options = Array.isArray(flat[0]?.options) ? flat[0].options : []
  if (options.length === 0) return content
  const tokens = String(content ?? '').trim().split(/[\s,，、;；]+/).filter(Boolean)
  if (tokens.length === 0 || !tokens.every((t) => /^\d+$/.test(t))) return content
  const picked = []
  for (const t of tokens) {
    const i = Number(t) - 1
    if (i < 0 || i >= options.length) return content
    picked.push(options[i])
  }
  return picked.join('\n')
}

/** 提问卡片 → QQ 文本（问题 + 编号选项 + 作答提示）。 */
export function formatQuestionCard(interactions) {
  const flat = []
  for (const x of Array.isArray(interactions) ? interactions : []) {
    for (const q of x?.questions ?? []) flat.push(q)
  }
  const lines = ['📋 天枢在问您：']
  let allowMultiple = false
  for (const q of flat) {
    lines.push('', `「${q?.prompt ?? ''}」`)
    ;(q?.options ?? []).forEach((opt, i) => lines.push(`  ${i + 1}. ${opt}`))
    if (q?.allowMultiple) allowMultiple = true
  }
  lines.push('')
  if (flat.length <= 1) {
    lines.push(allowMultiple
      ? '（可回复一个或多个编号，如 1,3；也可直接文字回复）'
      : '（回复编号作答，如 1；也可直接文字回复）')
  } else {
    lines.push('（请按题目逐条作答；也可直接文字回复）')
  }
  return lines.join('\n')
}

/** 审批请求 → QQ 文本（工具名 + 命令/参数；超长截断并标注）。 */
export function formatApprovalCard(approval) {
  const input = approval?.input ?? {}
  let detail
  if (typeof input?.command === 'string' && input.command.trim()) {
    const cmd = input.command.trim()
    detail = cmd.length > 1800
      ? `命令：\n${cmd.slice(0, 1800)}\n…（已截断，完整内容见电脑端）`
      : `命令：\n${cmd}`
  } else {
    let raw = ''
    try { raw = JSON.stringify(input) ?? '' } catch { raw = String(input) }
    detail = `参数：${raw.length > 600 ? `${raw.slice(0, 600)}…` : raw}`
  }
  return [
    '⚠️ 天枢请求您的批准：',
    '',
    `工具：${approval?.toolName ?? '未知'}`,
    detail,
    '',
    '（回复「批准」或「拒绝」继续；到电脑端处理也可以）',
  ].join('\n')
}

export class ImBridge {
  #workspaceRoot
  #workspaceOverride
  #logger
  #call
  #send
  #ensureDir
  #historyStore
  #serveClient
  #sessionMap
  #onCommand
  #commandHints
  #queue = new MessageQueue()
  // 审批等待态：key → { sessionId, baseSeq, pending: [approval...] }
  #interaction = new Map()
  // 最近一次提问卡片：key → { sessionId, questions }（被回答一次即消费）
  #lastQuestions = new Map()
  // 命令口径与模型回复口径分开记账，互不串账（replies=模型回复，commandReplies=命令回执）
  #stats = {
    handled: 0,
    failed: 0,
    replies: 0,
    serveSessionsCreated: 0,
    commands: 0,
    commandReplies: 0,
    commandsFailed: 0,
  }

  constructor({
    workspaceRoot,
    workspaceOverride,
    logger,
    call,
    send,
    ensureDir,
    historyStore,
    serveClient,
    sessionMap,
    onCommand,
    commandHints,
  }) {
    if (!workspaceRoot) throw new TypeError('ImBridge 需要 workspaceRoot')
    if (typeof call !== 'function') throw new TypeError('ImBridge 需要 call 注入')
    if (typeof send !== 'function') throw new TypeError('ImBridge 需要 send 注入')
    this.#workspaceRoot = workspaceRoot
    this.#workspaceOverride = typeof workspaceOverride === 'string' && workspaceOverride.trim()
      ? workspaceOverride.trim()
      : null
    this.#logger = logger ?? {}
    this.#call = call
    this.#send = send
    this.#ensureDir = ensureDir ?? (() => {})
    this.#historyStore = historyStore ?? null
    this.#serveClient = serveClient ?? null
    this.#sessionMap = sessionMap ?? null
    this.#onCommand = typeof onCommand === 'function' ? onCommand : null
    this.#commandHints = commandHints ?? null
  }

  get stats() {
    return { ...this.#stats }
  }

  /** 当前模式：serve-native（桌面端原生会话）或 headless（降级）。 */
  get mode() {
    return this.#serveClient?.available ? 'serve-native' : 'headless'
  }

  /** 处理一条入站消息（同会话串行）。 */
  async handle(message) {
    const content = typeof message?.content === 'string' ? message.content.trim() : ''
    const target = message?.replyTarget
    if (!content || !target) return undefined

    const key = conversationKey(message)
    this.#stats.handled += 1

    return this.#queue.run(key, async () => {
      try {
        // 命令层接缝：命令形状的消息交给注入的处理器，不送模型、不动绑定。
        // `text` 类零改动走原路径；命令层未接线时命令暂时按普通消息处理（留一行警告，不静默）。
        const parsed = parseCommand(content)
        // 显式两态：将来 parseCommand 若新增 kind，必须在此被有意接纳，不得默默进命令层
        if (parsed.kind === 'command' || parsed.kind === 'unknown') {
          if (this.#onCommand) {
            this.#stats.commands += 1
            const chunks = []
            try {
              await this.#onCommand({
                message,
                parsed,
                target,
                key,
                // 回执先收集、处理器返回后统一发送：这样「首次使用」提示才能挂在末尾，
                // 一条命令仍只算一次分片发送（commandReplies 口径不变）。
                reply: async (text) => { chunks.push(String(text ?? '')) },
              })
              const body = chunks.filter((t) => t.trim()).join('\n\n')
              // 处理器没有回执就什么都不发：提示不单独成条（空回执的语义保持原样）
              if (body) await this.#sendChunks(target, `${body}${this.#commandHint(parsed)}`, 'commandReplies')
              else this.#logger.warn?.(`[bridge] 命令 ${parsed.name ?? parsed.word} 没有回执`)
            } catch (error) {
              // 处理器抛错：只回一句人话，不冒泡（外层 catch 是给模型路径用的，不能借道）
              this.#stats.commandsFailed += 1
              const label = parsed.kind === 'command' ? parsed.name : parsed.word
              this.#logger.error?.(`[bridge] 命令处理失败（${label}）: ${error?.message ?? error}`)
              try {
                // 已产出的回执不丢；走分片，避免绕过 4500 字与被动条数上限
                const body = chunks.filter((t) => t.trim()).join('\n\n')
                const text = [body, `（命令执行出错：${error?.message ?? error}）`].filter(Boolean).join('\n\n')
                await this.#sendChunks(target, text, 'commandReplies')
              } catch { /* 尽力而为 */ }
            }
            return
          }
          this.#logger.warn?.(
            `[bridge] 命令层未接线，按普通消息处理：${content.replace(/\s+/g, ' ').slice(0, 40)}`,
          )
        }
        if (this.#serveClient?.available) {
          await this.#handleServe({ key, target, content })
        } else {
          await this.#handleHeadless({ key, target, content })
        }
      } catch (error) {
        this.#stats.failed += 1
        this.#logger.error?.(`[bridge] 处理失败: ${error?.message ?? error}`)
        try {
          await this.#send(target, `（内部错误：${error?.message ?? error}）`)
        } catch { /* 尽力而为 */ }
      }
    })
  }

  /**
   * 命令回执末尾的提示行。
   * - 首次用到某条命令（由注入的 commandHints 记忆）→ 附该命令的用法两行，并记下「已教过」；
   * - 之后只附一行「/help 看全部命令」；
   * - 未知命令（它回的就是帮助本身）不再叠加。
   * 未注入记忆时按「已教过」处理：只留一行，免得每条回执都复述用法。
   */
  #commandHint(parsed) {
    if (parsed?.kind !== 'command' || !parsed.name) return ''
    const hints = this.#commandHints
    if (hints && typeof hints.has === 'function' && typeof hints.mark === 'function'
      && !hints.has(parsed.name)) {
      hints.mark(parsed.name)
      const first = firstUseHint(parsed.name)
      if (first) {
        return `\n\n—— 第一次用到 /${parsed.name}，用法放这儿：\n${first}\n（以后只附一行提示；/help 看全部命令）`
      }
    }
    return '\n\n（/help 看全部命令）'
  }

  // ── serve 原生会话路径 ───────────────────────────────────────

  async #handleServe({ key, target, content }) {
    const cwd = this.#workspaceOverride || this.#workspaceRoot
    this.#ensureDir(cwd)

    // ① 审批等待态：把「批准 / 拒绝」解释成决定，不送模型
    const waiting = this.#interaction.get(key)
    if (waiting) {
      await this.#handleApprovalReply({ key, target, waiting, content })
      return
    }

    // ② 上一条是提问卡片时，做编号 → 选项原文的翻译（消费一次即失效）
    const pendingQuestion = this.#lastQuestions.get(key)
    if (pendingQuestion) {
      this.#lastQuestions.delete(key)
      content = translateAnswer(content, pendingQuestion.questions)
    }

    let sessionId = this.#sessionMap?.get(key) ?? null
    let fresh = false
    if (!sessionId) {
      sessionId = await this.#createServeSession(key, cwd, content)
      fresh = true
    }

    // 基线游标：prompt 之前始终取一次快照（避免把历史 text_delta 当新回复）。
    // 沿用旧会话时若快照缺 lastSeq，退回 0 会把上一轮内容重放进聊天窗口，故直接报错；
    // 刚建的新会话退回 0 是安全的（新会话不该有事件）。
    // 快照拿不到（500/401）会抛错，交由外层上报，持久绑定保持不动。
    let baseSeq = 0
    const snapshot = await this.#serveClient.getSession(sessionId)
    if (!snapshot) {
      // 陈旧映射（会话确已被删除）→ 重建，游标回到 0
      this.#sessionMap?.del?.(key)
      sessionId = await this.#createServeSession(key, cwd, content)
      fresh = true
    } else if (Number.isFinite(snapshot.lastSeq)) {
      baseSeq = snapshot.lastSeq
    } else if (!fresh) {
      throw new Error('会话快照缺少 lastSeq：拒绝从 0 起算（会把历史重放进 QQ）')
    }

    this.#logger.info?.(`[bridge] serve → 会话 ${String(sessionId).slice(0, 14)}（${content.length} 字）`)
    try {
      await this.#serveClient.promptSession(sessionId, content)
    } catch (error) {
      if (error?.code === 'session-not-found') {
        this.#sessionMap?.del?.(key)
        sessionId = await this.#createServeSession(key, cwd, content)
        baseSeq = 0 // 新会话 seq 从头开始；沿用旧游标会让事件被 e.seq > since 全部过滤
        await this.#serveClient.promptSession(sessionId, content)
      } else {
        this.#stats.failed += 1
        await this.#send(target, `（天枢呼叫失败：${error?.message ?? '未知错误'}）`)
        this.#stats.replies += 1
        return
      }
    }

    const reply = await this.#serveClient.waitForReply(sessionId, { since: baseSeq })
    await this.#deliverServeReply({ key, target, sessionId, reply })
  }

  /** 统一投递：审批挂起 → 转发审批卡片；否则发文本 +（若有）提问卡片。 */
  async #deliverServeReply({ key, target, sessionId, reply }) {
    // 审批挂起：记录等待态并把请求转发到 QQ（回复「批准 / 拒绝」继续）
    const approvals = reply?.needInput?.approvals ?? []
    if (approvals.length > 0) {
      this.#interaction.set(key, { sessionId, baseSeq: reply.lastSeq, pending: [...approvals] })
      const first = approvals[0]
      const more = approvals.length > 1 ? `，另有 ${approvals.length - 1} 条排队` : ''
      const body = [reply?.text, formatApprovalCard(first)]
        .filter((t) => String(t ?? '').trim())
        .join('\n\n')
      await this.#sendChunks(target, body)
      this.#logger.info?.(
        `[bridge] serve 待批准：${first.toolName ?? '?'}（${String(first.requestId).slice(0, 14)}…${more}）`,
      )
      return
    }

    const text = reply?.text ?? ''
    const questions = reply?.questions ?? []
    const card = questions.length > 0 ? formatQuestionCard(questions) : ''
    if (!text && !card) {
      this.#stats.failed += 1
      const reason = reply?.error
        ? `（天枢连接中断：${reply.error?.message ?? reply.error}）`
        : reply?.timedOut
          ? '（天枢回合超时，稍后再发一条试试）'
          : '（天枢返回了空内容）'
      this.#logger.warn?.(`[bridge] serve 空回复已兜底：${reason}`)
      await this.#send(target, reason)
      this.#stats.replies += 1
      return
    }
    const parts = []
    if (text) {
      parts.push(reply?.timedOut ? `${text}\n\n（这条可能不完整：天枢回合未结束就超时了）` : text)
    } else if (reply?.timedOut) {
      parts.push('（天枢回合超时，稍后再发一条试试）')
    }
    if (card) parts.push(card)
    await this.#sendChunks(target, parts.join('\n\n'))
    if (card) this.#lastQuestions.set(key, { sessionId, questions })
    this.#logger.info?.(
      `[bridge] serve ← 回复已发送（${text.length} 字${card ? '，含提问卡片' : ''}${reply?.timedOut ? '，超时截断' : ''}）`,
    )
  }

  /** 审批等待态的回复处理：解析决定 → 提交 → 继续收尾。 */
  async #handleApprovalReply({ key, target, waiting, content }) {
    const decision = parseApprovalReply(content)
    if (!decision) {
      await this.#send(target, '（天枢正在等待您对先前请求的批准：回复「批准」或「拒绝」即可继续；到电脑端处理也可以。）')
      return
    }
    const current = waiting.pending[0]
    try {
      await this.#serveClient.answerIntervention(waiting.sessionId, current.requestId, { decision })
    } catch (error) {
      if (error?.code === 'intervention-not-found') {
        // 已失效（多半已在电脑端处理过）：清等待态，提示重发
        this.#interaction.delete(key)
        await this.#send(target, '（这条批准请求已失效：可能已在电脑端处理过。直接再发一条消息即可查看进展。）')
      } else {
        await this.#send(target, `（提交${decision === 'approve' ? '批准' : '拒绝'}失败：${error?.message ?? '未知错误'}；可重试，或到电脑端处理。）`)
      }
      return
    }
    waiting.pending.shift()
    await this.#send(target, decision === 'approve'
      ? '（已批准 ✓ 天枢继续执行…）'
      : '（已拒绝，天枢会调整做法，随后向您汇报。）')
    this.#logger.info?.(`[bridge] serve 已${decision === 'approve' ? '批准' : '拒绝'}（${String(current.requestId).slice(0, 14)}…）`)
    if (waiting.pending.length > 0) {
      // 还有下一个要批：把下一张卡片顶上
      await this.#sendChunks(target, formatApprovalCard(waiting.pending[0]))
      return
    }
    this.#interaction.delete(key)
    // 该回合还没结束：继续收集后续输出并投递
    const reply = await this.#serveClient.waitForReply(waiting.sessionId, { since: waiting.baseSeq })
    await this.#deliverServeReply({ key, target, sessionId: waiting.sessionId, reply })
  }

  async #createServeSession(key, cwd, content) {
    const session = await this.#serveClient.createSession({ cwd, title: sessionTitleFor(content) })
    const id = session?.id
    if (!id) throw new Error('createSession 未返回会话 id')
    this.#sessionMap?.set?.(key, id)
    this.#stats.serveSessionsCreated += 1
    this.#logger.info?.(`[bridge] serve 新建会话 ${String(id).slice(0, 14)}（${key}）`)
    return id
  }

  // ── headless 降级路径（原逻辑）───────────────────────────────

  async #handleHeadless({ key, target, content }) {
    const cwd = this.#workspaceOverride || join(this.#workspaceRoot, conversationDirName(key))
    this.#ensureDir(cwd)
    const history = this.#historyStore?.get(key) ?? []
    const prompt = formatPrompt(content, history)
    this.#logger.info?.(`[bridge] headless → 天枢调用（${key}，${content.length} 字，历史 ${history.length} 条）`)
    const result = await this.#call({ cwd, prompt })
    if (!result?.ok) {
      this.#stats.failed += 1
      await this.#send(target, `（天枢呼叫失败：${result?.error ?? '未知错误'}）`)
      this.#stats.replies += 1
      return
    }
    this.#historyStore?.appendTurn(key, content, result.text ?? '')
    const text = result.text ?? ''
    if (!text) {
      await this.#send(target, '（天枢返回了空内容）')
      this.#stats.replies += 1
      return
    }
    await this.#sendChunks(target, text)
    this.#logger.info?.('[bridge] headless ← 回复已发送')
  }

  // ── 公共：分片发送 ──────────────────────────────────────────

  /**
   * 分片发送（模型回复与命令回执共用同一套规则：4500 字/片、被动条数上限）。
   * @param {'replies'|'commandReplies'} counter 计入哪个口径，两者互不串账
   * @returns {Promise<number>} 实际发出的片数
   */
  async #sendChunks(target, text, counter = 'replies') {
    const { chunks } = planReply(text, { scope: target.scope })
    if (chunks.length === 0) return 0
    for (const chunk of chunks) {
      await this.#send(target, chunk)
      this.#stats[counter] += 1
    }
    return chunks.length
  }
}
