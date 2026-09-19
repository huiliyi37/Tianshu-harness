/**
 * Unified slash command registry — metadata-driven command framework.
 *
 * Replaces the scattered special-case handling in app.ts / SlashRouter with
 * declarative command descriptors:
 *   { name, immediate, handler, overlay?, needsAgent? }
 *
 * Benefits:
 * - app.ts no longer hard-codes /clear, /starmap, /chronicle, /exit.
 * - External SlashRouter can register commands instead of returning a blanket boolean.
 * - Commands declare whether they need an active agent / overlay, enabling uniform
 *   validation and queue routing.
 */

import type { TuiApp } from './engine/app.js'

export interface SlashCommandContext {
  /** The TuiApp instance executing the command */
  app: TuiApp
  /** Full original input (including leading slash) */
  input: string
  /** Normalized input with leading/trailing whitespace trimmed */
  trimmed: string
}

export interface SlashCommand {
  /** Command name with leading slash, e.g. '/help' */
  name: string
  /**
   * 别名：`match()` 命中后归一化到 `name`。别名不进 `list()`，也不参与帮助/
   * 面板生成——它只是「同一命令的另一种输入写法」。
   *
   * 契约：handler 看到的 `parts[0]` 一律是 canonical 名（`execute()` 负责归一化），
   * 因此 handler 无需感知别名存在。
   */
  aliases?: readonly string[]
  /** Short description for command palette / help listings */
  description?: string
  /**
   * If true, the command is executed locally and is never sent to the agent.
   * If false (the default), the handler decides whether to swallow the input
   * or let it fall through to the agent pipeline.
   */
  immediate?: boolean
  /**
   * If true, the command requires an active agent run. When inactive, the
   * command is rejected with a friendly message.
   */
  needsAgent?: boolean
  /**
   * If set, the command opens the named overlay. The registry validates that
   * the overlay exists before executing.
   */
  overlay?: string
  /**
   * Command handler. Return true to indicate the command was consumed.
   * Return false to let the input fall through to the agent as raw text.
   */
  handler: (ctx: SlashCommandContext) => boolean | Promise<boolean>
}

export class SlashCommandRegistry {
  private commands = new Map<string, SlashCommand>()
  /** 别名 → canonical 名。独立于 commands，保证 list()/has() 只见 canonical。 */
  private aliasToCanonical = new Map<string, string>()
  /** 别名登记冲突留痕。刻意不写 stderr——TUI 是纯 ANSI 渲染，渲染期往
   *  stderr 写字会污染画面。冲突由守卫测试断言内置集为空。 */
  private aliasConflicts: string[] = []

  /**
   * Register a command. Overwrites an existing command with the same name.
   *
   * 别名登记遵循「canonical 恒赢」：别名撞已有命令名 → 忽略该别名；同一别名
   * 被两条命令争用 → 先注册者赢。刻意不抛异常——第三方插件的一个坏别名不该
   * 让 CLI 起不来（这是可用性边界，不是安全边界）。
   */
  register(command: SlashCommand): void {
    // 重复 register 同一 canonical 时先清旧别名，避免留下悬空索引。
    this.dropAliasesOf(command.name)
    this.commands.set(command.name, command)

    for (const alias of command.aliases ?? []) {
      if (alias === command.name) continue
      if (this.commands.has(alias)) {
        this.aliasConflicts.push(`别名 ${alias}（属 ${command.name}）与既有命令同名，已忽略`)
        continue
      }
      const owner = this.aliasToCanonical.get(alias)
      if (owner !== undefined && owner !== command.name) {
        this.aliasConflicts.push(`别名 ${alias} 已被 ${owner} 占用，${command.name} 的登记已忽略`)
        continue
      }
      this.aliasToCanonical.set(alias, command.name)
    }
  }

  /** Register multiple commands at once. */
  registerMany(commands: readonly SlashCommand[]): void {
    for (const cmd of commands) this.register(cmd)
  }

  /** Unregister a command by name. 其别名一并回收。 */
  unregister(name: string): void {
    this.dropAliasesOf(name)
    this.commands.delete(name)
  }

  private dropAliasesOf(canonical: string): void {
    for (const [alias, owner] of this.aliasToCanonical) {
      if (owner === canonical) this.aliasToCanonical.delete(alias)
    }
  }

  /** Look up an exact command (canonical name only). */
  get(name: string): SlashCommand | undefined {
    return this.commands.get(name)
  }

  /** Check if a command (or alias) is registered. */
  has(name: string): boolean {
    return this.commands.has(name) || this.aliasToCanonical.has(name)
  }

  /** All registered commands, sorted by name. 只出 canonical。 */
  list(): SlashCommand[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * canonical ∪ 别名。供命令谓词（app.ts 的 getCommandPredicate /
   * getCommandPrefixPredicate）使用——**漏掉别名会让「输入别名」在谓词层被
   * 判为非命令**，别名等于没接。
   */
  listNames(): string[] {
    return [...this.commands.keys(), ...this.aliasToCanonical.keys()]
  }

  /** 别名登记冲突留痕（守卫测试用）。 */
  getAliasConflicts(): readonly string[] {
    return this.aliasConflicts
  }

  /**
   * Find the best matching command for an input string.
   * 顺序：精确 canonical → 精确别名 → `canonical + 空格` → `别名 + 空格`。
   */
  match(input: string): SlashCommand | undefined {
    const trimmed = input.trim()
    const exact = this.commands.get(trimmed)
    if (exact) return exact
    const aliased = this.resolveAlias(trimmed)
    if (aliased) return aliased
    for (const [name, cmd] of this.commands) {
      if (trimmed.startsWith(name + ' ')) return cmd
    }
    for (const [alias, canonical] of this.aliasToCanonical) {
      if (trimmed.startsWith(alias + ' ')) {
        const cmd = this.commands.get(canonical)
        if (cmd) return cmd
      }
    }
    return undefined
  }

  private resolveAlias(name: string): SlashCommand | undefined {
    const canonical = this.aliasToCanonical.get(name)
    return canonical === undefined ? undefined : this.commands.get(canonical)
  }

  /**
   * Execute the matching command if any.
   * Returns { handled: true } when a command consumed the input.
   * Returns { handled: false } when no command matched.
   */
  async execute(ctx: SlashCommandContext): Promise<{ handled: boolean }> {
    const cmd = this.match(ctx.trimmed)
    if (!cmd) return { handled: false }

    if (cmd.needsAgent && !ctx.app.busy) {
      ctx.app.commitStatic(`[${cmd.name}] requires an active agent run.`)
      return { handled: true }
    }

    if (cmd.overlay) {
      if (ctx.app.activateOverlay(cmd.overlay)) {
        return { handled: true }
      }
      // Overlay activation failed — let the handler decide.
    }

    // 别名透明化：handler 一律看到 canonical 名。大量 handler 以 parts[0] 分支，
    // 不归一化就会出现「同一个命令换个写法行为不同」。ctx.input 保持原始行不动。
    const handlerCtx = ctx.trimmed === cmd.name ? ctx : { ...ctx, trimmed: canonicalize(ctx.trimmed, cmd.name) }
    const handled = await cmd.handler(handlerCtx)
    return { handled }
  }
}

/** 把输入的首个 token 换成 canonical 名，其余（含空白）原样保留。 */
function canonicalize(trimmed: string, canonical: string): string {
  const m = /^(\S+)([\s\S]*)$/.exec(trimmed)
  return m ? canonical + m[2]! : canonical
}
