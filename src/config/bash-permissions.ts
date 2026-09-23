import { loadConfig, saveConfig } from './manager.js'
import { permissionsSchema } from './schema.js'

/**
 * bash 命令白/黑名单的持久化读写（config.agent.permissions.bash）。
 *
 * 与 `src/agent/permissions.ts` 的分工：那边是运行时判定（会话级 overlay +
 * 前缀匹配的 fail-closed 守卫），这边是持久层——写进 config 的前缀对**之后
 * 启动的每个会话**生效，而会话内审批学习的前缀只活在当次会话（自动化任务
 * 每次触发都是新会话，所以那份留不下来）。
 *
 * 子模块化原因：`manager.ts` 是点名巨石（source-budgets ceiling），按接缝外提
 * ——与 `provider-key-store.ts` 同一处理方式。
 */

/** Snapshot of the bash command allow/deny prefixes for the desktop settings UI. */
export function getBashPermissions(): { allowlist: string[]; denylist: string[] } {
  const bash = loadConfig().agent.permissions.bash
  return {
    allowlist: [...bash.allowlist],
    denylist: [...bash.denylist],
  }
}

/**
 * Persist the bash command allow/deny prefixes to the user global config.
 *
 * `allowlist` entries are command prefixes that bypass bash-write approval
 * ("git status" allows "git status --porcelain"); `denylist` entries are always
 * blocked regardless of mode or allowlist (deny always wins). Entries are
 * trimmed and deduplicated; validation via permissionsSchema. Only the `bash`
 * field is touched — sibling fields (directory grants etc.) are preserved.
 *
 * Applies to sessions created after the save (the agent reads
 * `config.agent.permissions` at build time, see `create-agent-config.ts`).
 */
export function setBashPermissions(input: {
  allowlist?: unknown
  denylist?: unknown
}): { allowlist: string[]; denylist: string[] } {
  const cfg = loadConfig()
  const merged: Record<string, unknown> = { ...cfg.agent.permissions }
  const normalize = (v: unknown, field: string): string[] => {
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
      throw new Error(`${field} must be an array of strings`)
    }
    return [...new Set((v as string[]).map(s => s.trim()).filter(Boolean))]
  }
  const bash: Record<string, unknown> = { ...cfg.agent.permissions.bash }
  if (input.allowlist !== undefined) bash.allowlist = normalize(input.allowlist, 'allowlist')
  if (input.denylist !== undefined) bash.denylist = normalize(input.denylist, 'denylist')
  merged.bash = bash
  cfg.agent.permissions = permissionsSchema.parse(merged)
  saveConfig(cfg)
  return {
    allowlist: [...cfg.agent.permissions.bash.allowlist],
    denylist: [...cfg.agent.permissions.bash.denylist],
  }
}

/**
 * Append one prefix to the persistent allowlist — read-modify-write, never
 * clobbers existing entries. Used by the approval card's「永久记住」option: the
 * session-scoped learning in `agent/permissions.ts` does not survive the next
 * session, and automation runs start a fresh one on every fire.
 *
 * `VAR=value`-style leading assignments are skipped — matching strips them
 * before comparison (see `isBashCommandAllowlisted`), so such an entry would be
 * dead on arrival.
 */
export function appendBashAllowPrefix(prefix: string): void {
  const trimmed = prefix.trim()
  if (!trimmed || trimmed.includes('=')) return
  const cur = getBashPermissions()
  if (cur.allowlist.includes(trimmed)) return
  setBashPermissions({ allowlist: [...cur.allowlist, trimmed] })
}
