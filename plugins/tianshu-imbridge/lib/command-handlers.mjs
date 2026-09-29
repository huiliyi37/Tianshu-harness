/**
 * 命令处理器注册表 + 分发。
 *
 * 职责边界：解析在 lib/command.mjs（纯函数），接缝在 lib/bridge.mjs 的 handle()（分发、
 * 回执注入、抛错兜底），本文件只放「规范名 → 处理器」的映射与一个薄分发。
 * 处理器拿到的 ctx 由接缝给出：{ message, parsed, target, key, reply }。
 * 每个处理器**必须自行回执**（用 ctx.reply），否则用户看到的是静默。
 */
import {
  formatSessionList, listSessions, parseSessionArgs, resolveSessionTarget, DEFAULT_LIMIT,
} from './sessions.mjs'
import { formatWorkspaceList, listWorkspaces, resolveWorkspaceTarget } from './workspaces.mjs'
import {
  formatHistory, parseHistoryLimit, perMessageChars, reconstructMessages, takeLast,
} from './transcript.mjs'
import { helpBody } from './command.mjs'

/** 造一份处理器表。依赖注入，便于单测（workspace / fsImpl / serveClient / sessionMap 都可替换）。 */
export function createCommandHandlers({ workspace, fsImpl, serveClient, sessionMap } = {}) {
  const handlers = {
    workspacelist: async (ctx) => {
      const r = listWorkspaces({ workspace, fsImpl })
      if (r.error) {
        await ctx.reply(r.error)
        return
      }
      await ctx.reply(formatWorkspaceList(r.names, { root: r.root }).text)
    },

    sessions: async (ctx) => {
      const { workspaceIndex, limit, error } = parseSessionArgs(ctx?.parsed?.args)
      if (error) {
        await ctx.reply(error)
        return
      }
      const r = await listSessions({ serveClient, workspace, workspaceIndex, fsImpl })
      if (r.error) {
        await ctx.reply(r.error)
        return
      }
      const boundId = sessionMap?.get?.(ctx.key) ?? null
      await ctx.reply(formatSessionList(r.items, {
        limit: limit ?? DEFAULT_LIMIT,
        boundId,
        scopeNote: r.scopeNote,
      }).text)
    },

    session: async (ctx) => {
      const target = await resolveSessionTarget(ctx?.parsed?.args?.[0], { serveClient, workspace, fsImpl })
      if (!target.ok) {
        await ctx.reply(target.error)   // 一切失败路径：原绑定逐字节不变
        return
      }
      if (!sessionMap) {
        await ctx.reply('当前无法保存绑定（插件未提供绑定表）。')
        return
      }
      const previous = sessionMap.get(ctx.key)
      sessionMap.set(ctx.key, target.session.id)
      const lines = [
        `已绑定到会话「${target.session.title}」`,
        `工作区：${target.session.workspace}`,
        `会话 ${String(target.session.id).slice(0, 12)}…`,
        '下一条消息将进入该会话。',
      ]
      if (previous && previous !== target.session.id) {
        lines.push(`（原绑定 ${String(previous).slice(0, 12)}… 已被替换）`)
      }
      await ctx.reply(lines.join('\n'))
    },

    /**
     * /history [N] —— 回看当前绑定会话的最近 N 条（默认 3，上限 20）。
     * 取数：GET /sessions/:id/events?since=0 → 还原成消息序列 → 取尾部 N 条。
     * 边界各自一句话：无绑定 / 降级模式 / 会话已不存在 / 事件流读不动 / 会话还是空的。
     * 一切失败路径都**不动绑定**（清理是桥在 404 时的事，命令层不越权）。
     */
    history: async (ctx) => {
      const { limit, note: limitNote } = parseHistoryLimit(ctx?.parsed?.args)
      const boundId = sessionMap?.get?.(ctx.key) ?? null
      if (!boundId) {
        await ctx.reply(
          '这条对话线还没有绑定会话。先随手发一条消息（会自动建会话），'
          + '或用 /sessions 挑一个再 /session N 绑定。',
        )
        return
      }
      if (!serveClient?.available || typeof serveClient.fetchEvents !== 'function') {
        await ctx.reply('当前是降级模式（没有 serve 会话通道），看不到会话历史。')
        return
      }

      let snapshot = { id: boundId }
      if (typeof serveClient.getSession === 'function') {
        try {
          snapshot = await serveClient.getSession(boundId)
        } catch (error) {
          await ctx.reply(`读取会话失败：${error?.message ?? error}（绑定保持原样）`)
          return
        }
        if (!snapshot) {
          await ctx.reply([
            `绑定的会话（${String(boundId).slice(0, 12)}…）在宿主里已经不存在了。`,
            '下一条消息会自动新建一个；也可以用 /sessions 重挑一个再 /session N 绑定。',
          ].join('\n'))
          return
        }
      }

      let page
      try {
        page = await serveClient.fetchEvents(boundId, 0)
      } catch (error) {
        await ctx.reply(`读取事件流失败：${error?.message ?? error}（绑定保持原样）`)
        return
      }

      const view = reconstructMessages(page?.events ?? [])
      if (view.messages.length === 0) {
        await ctx.reply(`「${snapshot.title ?? '这个会话'}」还没有可回看的内容（发一条消息就有了）。`)
        return
      }
      const tail = takeLast(view.messages, limit)
      await ctx.reply(formatHistory({
        messages: tail.messages,
        truncated: tail.truncated,
        total: tail.total,
        droppedHead: view.droppedHead,
        limitNote,
        maxChars: perMessageChars(limit),
      }))
    },

    /**
     * 切换工作区 = 换绑。
     * 做法：**预建**目标工作区的会话并写进绑定表，桥的下一条消息自然复用该会话，
     * cwd 就是目标目录 —— 因此不必改 W5 的桥，也顺带绕开了「建会话后立刻 prompt 撞 400」
     * 那条竞态（建会话发生在命令里，prompt 发生在之后）。
     * 一切失败路径都先回绝、后不动绑定。
     */
    workspace: async (ctx) => {
      const target = resolveWorkspaceTarget(ctx?.parsed?.args?.[0], { workspace, fsImpl })
      if (!target.ok) {
        await ctx.reply(target.error)
        return
      }
      if (!serveClient?.available || !sessionMap) {
        await ctx.reply('当前是降级模式（没有 serve 会话通道），工作区不可切换；绑定保持原样。')
        return
      }
      let id = null
      try {
        const session = await serveClient.createSession({
          cwd: target.path,
          title: `QQ 工作区：${target.name}`,
        })
        id = session?.id ?? null
      } catch (error) {
        await ctx.reply(`切换失败（绑定未改动）：${error?.message ?? error}`)
        return
      }
      if (!id) {
        await ctx.reply('切换失败：宿主没有返回会话 id（绑定未改动）')
        return
      }
      sessionMap.set(ctx.key, id)
      await ctx.reply([
        `已切换到「${target.name}」`,
        `工作区：${target.path}`,
        `下一条消息将在该工作区新建的会话里进行（会话 ${String(id).slice(0, 12)}…）`,
      ].join('\n'))
    },
  }

  // /help 要知道「当前注册了哪些命令」，所以在表建好之后挂上（自引用）
  handlers.help = async (ctx) => {
    await ctx.reply(helpText(handlers, { command: ctx?.parsed?.args?.[0] ?? null }))
  }
  return handlers
}

/**
 * 帮助文案：只列当前已注册的命令，随注册表增长，不另立一份清单。
 * 文案本体在 lib/command.mjs 的 COMMAND_USAGE —— /help 与「首次使用」提示共用同一份。
 */
export function helpText(handlers, { command = null, lead = null } = {}) {
  const body = helpBody(Object.keys(handlers ?? {}), { command })
  return lead ? `${lead}\n\n${body}` : body
}

/**
 * 分发一条已解析的命令。
 * @returns {Promise<boolean>} 是否命中了已注册的处理器
 */
export async function dispatchCommand(ctx, handlers) {
  const name = ctx?.parsed?.kind === 'command' ? ctx.parsed.name : null
  if (name && Object.prototype.hasOwnProperty.call(handlers ?? {}, name)
    && typeof handlers[name] === 'function') {
    await handlers[name](ctx)
    return true
  }
  // 未知命令必须回一句 —— 静默比回错更糟（用户不知道消息有没有被看见）
  await ctx.reply(helpText(handlers, { lead: '不认识的命令。' }))
  return false
}
