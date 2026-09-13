import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { evaluateMcpPolicy, type McpCapability } from '../mcp/policy.js'
import type { ContextClaim } from '../context/claims.js'
import type { Sensorium } from './sensorium.js'
import { detectSensitiveGitAdd, AGGREGATE_ADD_MARKER } from '../tools/sensitive-file-detector.js'

export type RiskLevel = 'none' | 'low' | 'medium' | 'high'

export interface RiskAssessment {
  level: RiskLevel
  reasons: string[]
  suggestedAction: string
}

/**
 * Shared dangerous command patterns — single source of truth for both
 * approval-risk and bash.ts requiresApproval().
 *
 * Design principles:
 * - Match dangerous *intent*, not just keywords
 * - Minimize false positives (sudo ls should not trigger)
 * - Catch destructive, irreversible, or privilege-escalating commands
 */
/** Force-push detection pattern — used by assessToolRisk for clearer reason text. */
const FORCE_PUSH_PATTERN = /\bgit\s+push\b[^\n]*\s--force(?:-with-lease)?\b/i

/**
 * Global package installs — mutate the user environment, not the project.
 * npm/pnpm/yarn/bun are only risky when paired with -g/--global (bare install
 * stays auto-safe in SAFE_WRITE_PATTERNS); pip installs to global site-packages
 * unless --user or inside a venv; brew/cargo install always write outside the
 * project. Shared by DANGEROUS_BASH_PATTERNS (manual-mode approval) and
 * RISKY_WRITE_PATTERNS (auto-safe gate) — single source of truth.
 */
const GLOBAL_INSTALL_PATTERNS: ReadonlyArray<Readonly<RegExp>> = [
  // package manager + -g/--global anywhere in the command (covers `npm install -g` and `npm -g install`)
  /\b(?:npm|pnpm|yarn|bun)\b(?=[^\n]*(?:\s(?:-g|--global)\b))[^\n]*\b(?:install|i|add)\b/,
  // pip default-global unless --user or inside a venv (.venv/bin/pip / venv/bin/pip / activate chain)
  /\bpip(?<!\.venv\/bin\/pip)(?<!venv\/bin\/pip)(?<![\s\S]*\bactivate\b)(?:3)?\s+install\b(?![^\n]*(?:\s--user\b))/,
  // homebrew / cargo install — always user-global scope
  /\b(?:brew|cargo)\s+install\b/,
]

// Destructive commands — uses shared pattern list
export const DANGEROUS_BASH_PATTERNS: ReadonlyArray<Readonly<RegExp>> = [
  // rm 递归+强制：合并形态（-rf/-fr）与拆分形态（rm -r -f / --recursive --force，顺序任意）同门禁。
  // 检查窗口止于下一个命令分隔符（;&| 换行），避免 `rm -r build; ls -f` 跨段误报。
  // /i：长旗标按「含 r」「含 f」字符判（--verbose 含 r 会被视为递归旗标）——刻意偏严，
  // 误报只是多一次审批，漏报是静默 rm -rf。
  /\brm\b(?=[^\n;&|]*\s-{1,2}[a-z]*r)(?=[^\n;&|]*\s-{1,2}[a-z]*f)/i,
  // ── Windows 原生 shell 破坏族（本产品主力平台无内核沙箱，rm -rf 的等价命令必须同门禁）──
  // PowerShell Remove-Item -Recurse/-Force（含无歧义缩写 -r/-fo）≈ rm -rf。
  // PS 命令与参数名不区分大小写 → /i。
  /\bremove-item\b(?=[^\n;&|]*\s-{1,2}(?:r(?:ecurse)?|fo(?:rce)?)\b)/i,
  // cmd 递归删除：del /s、rd /s、rmdir /s（开关可分离可乱序：DEL /S /Q）。cmd 大小写不敏感 → /i。
  /\b(?:del|rd|rmdir)\b(?=[^\n;&|]*\s\/s\b)/i,
  // GNU find -delete（含 find / -delete）——批量删除，rm -rf 的搜索形态
  /\bfind\b[^\n|;&]*\s-delete\b/i,
  // shred——不可恢复覆写删除（比 rm 更彻底，直接进最高档）
  /\bshred\b/i,
  // SQL 清表（SECURITY.md 声明 TRUNCATE 受门禁——与既有 DROP TABLE 同档）
  /\btruncate\s+table\b/i,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f\b/,
  /\bgit\s+checkout\s+--(?:\s|$)/,      // discard working-tree changes (panic-chain 事故: checkout -- 不可逆销毁)
  /\bgit\s+restore\b/,                  // discard working-tree / staged changes
  /\bgit\s+stash\b(?!(?:\s+(?:pop|list|show|apply|drop|branch)))/,  // git stash without safe subcommand = destructive clear
  /\bkillall\b/,
  /\bpkill\s+-[9Kf]\b/,               // pkill -9, pkill -KILL, pkill -f (forceful)
  /\bdrop\s+table\b/i,
  /\bsudo\s+(?:rm|chmod|chown|dd|mkfs|mount|umount|systemctl|shutdown|reboot|passwd|user(?:add|del|mod))\b/,  // sudo + destructive subcommand
  /\bchmod\s+(?:777|[0-7]*7[0-7]*7)\b/,  // chmod 777, chmod 757, chmod 737, etc.
  /\bwget\b.*\|\s*(?:sh|bash|zsh|fish)\b/,
  /\bcurl\b.*\|\s*(?:sh|bash|zsh|fish)\b/,
  /\beval\b.*\$[({]/,                   // eval "$(curl ...)" or eval $(...)
  FORCE_PUSH_PATTERN,                         // force push (reference shared for reason detection)
  /\b(?:shutdown|reboot|halt|poweroff)\b/,                    // system control — disruptive even without sudo
  /\bnpm\s+(?:publish|unpublish)\b/,                          // irreversible registry operations
  /\bxargs\b.*\brm\b/,                                        // mass deletion via xargs pipe
  /\bbase64\b[^\n]*\|\s*(?:sh|bash|zsh|fish)\b/,             // obfuscated execution via base64 decode
  ...GLOBAL_INSTALL_PATTERNS,                                  // global package installs — environment-level mutation
]

/**
 * Bash commands with write side effects. These are not always destructive, but
 * they must not be silently auto-approved by sensorium confidence. This is the
 * Phase-1 safety base: deny bash writes by default, then allow explicit
 * user/project/session permission rules to re-enable trusted command shapes.
 */
/**
 * 低风险写命令——在无沙箱环境（Windows 原生）下，auto-safe 模式可自动放行，
 * 避免每次 mkdir/touch/echo>file 都打断用户审批。注意：bash 的写目标不经
 * tool-pipeline 的文件工具路径校验——放行必须叠加 hasOutOfWorkspaceWriteTarget
 * （见 tool-pipeline safeWriteInNoSandbox），目标在 cwd 外时仍回人工审批。
 */
export const SAFE_WRITE_PATTERNS: ReadonlyArray<Readonly<RegExp>> = [
  /\b(?:mkdir|touch|cp)\b/,                          // create/copy — non-destructive
  /(^|[^<])>>?\s*[^&\s]/,                           // output redirection: echo hi > file
  /\|\s*tee\b/,                                      // pipe writes via tee
  /\bsed\b[^\n]*\s-i(?:\b|\s|['"])/,               // sed -i (in-place edit of existing file)
  /\bperl\b[^\n]*\s-pi(?:\b|\s|['"])/,             // perl -pi
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b/, // package install — non-destructive
  /<<[-']?\w*['"]?/,                                // heredoc start (cat > file <<'EOF')
]

/**
 * 风险写命令——即使无沙箱也需审批（可能丢数据 / 改权限 / 影响版本库）。
 */
export const RISKY_WRITE_PATTERNS: ReadonlyArray<Readonly<RegExp>> = [
  /\b(?:rm|mv|truncate|dd)\b/,                       // delete/move — may lose data
  /\b(?:chmod|chown|chgrp)\b/,                       // permission/ownership mutations
  /\bgit\s+(?:add|commit|checkout|switch|restore|reset|clean|merge|rebase|cherry-pick|push|pull)\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:remove|rm|update|upgrade|dedupe)\b/,
  /\brsync\b[^\n]*\s--delete\b/i,                    // rsync --delete —— 目标侧删除（空源目录 = 整目录抹除）
  ...GLOBAL_INSTALL_PATTERNS,                                  // 全局安装——改的是用户环境，auto-safe 不放行
]

/**
 * All write patterns (safe + risky). Used by {@link bashCommandMayWrite} for the
 * "is this a write command at all" check. Kept for backward compat with callers
 * that just need the union (e.g. doom-loop write detection).
 */
export const BASH_WRITE_PATTERNS: ReadonlyArray<Readonly<RegExp>> = [
  ...SAFE_WRITE_PATTERNS,
  ...RISKY_WRITE_PATTERNS,
]

/** Command injection patterns — heredoc abuse, process substitution, shell exploits */
export const INJECTION_PATTERNS: ReadonlyArray<Readonly<RegExp>> = [
  /[<>]\s*\(/,                              // process substitution <(...) or >(...)
  /\bzmodload\b/,                           // zsh module loading
  /\bsysopen\b/,                            // zsh sysopen
  /\bpowershell\s+-enc/i,                   // PowerShell encoded execution
  /\beval\b.*\bexec\b/,                     // eval + exec chain
  /\bsource\b.*\/etc\/|^\.\s+\/etc\//,     // sourcing system config files
  /\benv\b.*\b(?:SHELL|PATH|HOME|LD_PRELOAD|DYLD_INSERT_LIBRARIES)=/, // env var override for privilege escalation
  /\b(?:python|perl|ruby|node)\s+-[ec]\s/, // inline code execution interpreters
  /\bcrontab\b/,                            // cron modification — persistence mechanism
  /\bsystemctl\b.*\b(?:enable|start|stop|restart|mask)\b/, // systemd service manipulation
]

/** Extended destructive commands beyond the base DANGEROUS_BASH_PATTERNS */
export const DESTRUCTIVE_EXTENDED_PATTERNS: ReadonlyArray<Readonly<RegExp>> = [
  /\bdocker\s+(?:rm|rmi)\b/,                // docker container/image removal
  /\bdocker\s+system\s+prune\b/,            // docker system cleanup
  /\bkubectl\s+delete\b/,                   // k8s resource deletion
  /\btruncate\s+-s\s+0\b/,                  // truncate file to zero
  /\bdd\s+if=.*of=\/dev\//,                 // dd writing to device
  /\bmkfs\b/,                               // filesystem formatting
  /\bformat-volume\b/i,                     // PowerShell 卷格式化（mkfs 的 PS 等价；PS 大小写不敏感 → /i）
]

/** Sed bypass detection — sed modifying security-critical files */
export const SED_BYPASS_PATTERNS: ReadonlyArray<Readonly<RegExp>> = [
  /\bsed\b.*\b(?:\/etc\/|\.ssh\/|authorized_keys|shadow|passwd)\b/,
]

/**
 * No-op redirects to /dev/null (`2>/dev/null`, `&>/dev/null`, `>/dev/null`).
 * Stripped before write detection so read-only commands that merely silence
 * output are not misclassified as writes — reliability degraded mode blocks
 * `bash_write`, so a false positive here locks out plain greps.
 */
const DEV_NULL_REDIRECT_PATTERN = /(?:^|\s)(?:\d+|&)?>>?\s*\/dev\/null\b/g

function stripDevNullRedirects(command: string): string {
  return command.replace(DEV_NULL_REDIRECT_PATTERN, ' ')
}

export function bashCommandMayWrite(command: string): boolean {
  const normalized = stripDevNullRedirects(command)
  return BASH_WRITE_PATTERNS.some(pattern => pattern.test(normalized))
}

/**
 * 命令是否只包含安全写（无沙箱时 auto-safe 模式可自动放行）。
 * 命中 RISKY_WRITE_PATTERNS 或 DANGEROUS_BASH_PATTERNS 则返回 false。
 */
export function isSafeWriteOnly(command: string): boolean {
  const normalized = stripDevNullRedirects(command)
  if (RISKY_WRITE_PATTERNS.some(p => p.test(normalized))) return false
  if (DANGEROUS_BASH_PATTERNS.some(p => p.test(normalized))) return false
  return SAFE_WRITE_PATTERNS.some(p => p.test(normalized))
}

/**
 * 无沙箱 auto-safe「安全写」自动放行的第二道闸：命令 token 里只要有一个指向
 * cwd 之外（~ / POSIX 绝对 / Windows 盘符 / $VAR 或 %VAR% 展开 / .. 穿越），
 * 就不能按工作区内写放行。tool-pipeline 的路径校验只覆盖文件工具——bash 的
 * 写目标（重定向、cp/mkdir 参数）不经 validatePathSafe，`echo key >> ~/.ssh/authorized_keys`
 * / `cp payload D:\Startup\x.exe` 若不在此拦下，会在 auto-safe 下零提示执行。
 * token 先剥 /dev/null 静默重定向（与 bashCommandMayWrite 同口径），再按重定向/
 * 管道符切开以覆盖 `echo x>>~/f` 粘接形态；`./out.txt`、`src/x`、裸文件名不受影响。
 */
export function hasOutOfWorkspaceWriteTarget(command: string): boolean {
  for (const token of stripDevNullRedirects(command).split(/\s+/)) {
    for (const raw of token.split(/[<>|;&]+/)) {
      // 剥首尾引号：`>"D:\x\y"` 的目标与 `~/f'` 等引号包裹形态同样要判
      const frag = raw.replace(/^['"]+|['"]+$/g, '')
      if (frag === '') continue
      if (frag.startsWith('~')) return true
      if (frag.startsWith('/') || frag.startsWith('\\')) return true
      if (/^[A-Za-z]:[\\/]/.test(frag)) return true
      // $VAR / ${VAR} 单独或带路径后缀——展开结果位置未知，fail-closed；
      // awk 的 $1 位置参数（数字开头）不在此列，避免误伤常规文本处理
      if (/^\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)(?:[\\/].*)?$/.test(frag)) return true
      if (/%[^%\s]+%/.test(frag)) return true
      // issue #118 — 按路径段判 `..`，不能只判开头：`foo/../../etc/cron.d/x` 以
      // `foo` 开头，而内层 `/` 不在 [<>|;&] 切分集合里，于是整段不被切开 →
      // 中段穿越被判成工作区内写，auto-safe（无沙箱）下越界写零提示放行。
      if (frag.split(/[\\/]/).includes('..')) return true
    }
  }
  return false
}

/** Detect scope-bypassing bash git commands (unscoped add/commit/stash). */
const GIT_BYPASS_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgit\s+add\s+(?:-A\b|--all\b|\.(?:\s|$))/,        // git add -A / --all / .
  /\bgit\s+commit\s+[^\n]*-[a-z]*a/,                  // git commit -a / -am
  /\bgit\s+stash\s*$/,                                 // bare git stash (no pathspec)
  /\bgit\s+stash\s+(?:push\s*)?$/,                     // git stash push (no --)
]

export function bashGitBypassesScope(command: string): boolean {
  return GIT_BYPASS_PATTERNS.some(p => p.test(command.trim()))
}

/** Destructive git actions that can wipe working-tree changes — the panic targets. */
export function isDestructiveGitAction(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === 'git') {
    const action = input.action as string
    return action === 'stash' || action === 'stash_pop'
  }
  // bash path already caught by BASH_WRITE_PATTERNS; listed here for explicit protection-mode gating
  if (toolName === 'bash') {
    const cmd = typeof input.command === 'string' ? input.command : ''
    return /\bgit\s+(?:stash\b|checkout\s|restore\b|reset\b|rm\s)/.test(cmd)
  }
  return false
}

export function requiresBashWriteApproval(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== 'bash') return false
  const command = typeof input.command === 'string' ? input.command : ''
  return bashCommandMayWrite(command)
}

/**
 * Actions whose approval can never be waived in supervised (manual) or default
 * (auto-safe) modes — permissions.allow rules, sensorium auto-approve, and
 * per-app grants cannot bypass them.
 *
 * computer_use js_eval runs arbitrary JS inside the user's real browser
 * (cookies/localStorage/logged-in sessions); browser_adopt takes over an
 * external DevTools endpoint. request_path_access widens the kernel write
 * boundary.
 *
 * YOLO (dangerously-skip-permissions, 桌面端"自治/完全访问") waives this gate
 * entirely — the user explicitly chose maximum autonomy and the safety net is
 * checkpoints + rollback, not prompts. The waiver lives in tool-pipeline.ts
 * (yoloBypassesUnconditional); this predicate stays mode-agnostic.
 *
 * In every case the tool's own requiresApproval() already returns true, but
 * that is only consulted in manual mode — the hard-gate promise for the
 * supervised/default modes is enforced in the pipeline.
 */
export function requiresUnconditionalApproval(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === 'request_path_access') return true
  if (toolName !== 'computer_use') return false
  const action = typeof input.action === 'string' ? input.action : ''
  return action === 'js_eval' || action === 'browser_adopt'
}

/** Confidence thresholds for sensorium-driven adaptive approval. */
export const CONFIDENCE_THRESHOLDS = {
  /** Above this + risk='none'|'low' → eligible for auto-approve */
  autoApproveConfidence: 0.8,
  /** Below this → risk escalated one level */
  escalateConfidence: 0.3,
} as const

export function assessToolRisk(
  toolName: string,
  input: Record<string, unknown>,
  doomLoopLevel: 'none' | 'warn' | 'blocked' = 'none',
  antibodies: ContextClaim[] = [],
  sensorium?: Sensorium,
  /** P2-16: MCP declared capability from tool definition, plumbed through
   *  tool-pipeline.  Falls back to 'unknown' for tools without MCP metadata,
   *  preserving the existing fail-closed behaviour. */
  declaredCapability?: McpCapability,
): RiskAssessment {
  const reasons: string[] = []
  let level: RiskLevel = 'none'

  // Arbitrary-JS / endpoint-takeover surface — double insurance alongside the
  // pipeline's unconditional approval gate (auto-safe asks on high risk even
  // if the hard gate were ever bypassed).
  if (requiresUnconditionalApproval(toolName, input)) {
    reasons.push('arbitrary JS in the user browser / DevTools endpoint takeover')
    level = 'high'
  }

  // Doom loop check. blocked is short-circuited by the pipeline early-return,
  // so destructive-git protection must trigger in the warn window too.
  if (doomLoopLevel === 'warn' || doomLoopLevel === 'blocked') {
    if (isDestructiveGitAction(toolName, input)) {
      reasons.push('保护模式：工具失败率高，破坏性动作需确认')
      level = 'high'
    } else {
      reasons.push(doomLoopLevel === 'blocked' ? 'Agent is in doom loop (repeated identical tool calls)' : 'Agent may be entering doom loop')
      if (level === 'none') level = 'medium'
    }
  }

  // Path traversal
  const targets = [input.file_path, input.path, input.target].filter((v): v is string => typeof v === 'string')
  // Absolute (incl. Windows `C:\`) or any `..` traversal segment (either separator).
  if (targets.some(t => isAbsolute(t) || /(^|[\\/])\.\.([\\/]|$)/.test(t))) {
    reasons.push('absolute path target')
    level = level === 'high' ? 'high' : 'medium'
  }

  // Destructive commands — uses shared pattern list
  if (toolName === 'bash') {
    const cmd = typeof input.command === 'string' ? input.command : ''
    for (const pattern of DANGEROUS_BASH_PATTERNS) {
      if (pattern.test(cmd)) {
        // Distinguish force push for clearer reason
        if (pattern === FORCE_PUSH_PATTERN) {
          reasons.push('force push can overwrite shared remote history')
        } else {
          reasons.push('destructive shell command')
        }
        level = 'high'
        break
      }
    }
    if (cmd.includes('curl') && cmd.includes('|')) {
      reasons.push('Pipe from network')
      level = level === 'high' ? 'high' : 'medium'
    }
    if (bashCommandMayWrite(cmd)) {
      reasons.push('bash command may write to filesystem, package state, or git state')
      if (level === 'none') level = 'medium'
    }
    if (bashGitBypassesScope(cmd)) {
      reasons.push('unscoped git command bypasses scope — use deliver_task or git tool with ownedFiles instead')
      level = 'high'
    }
    // git add 敏感文件硬门（detectSensitiveGitAdd 此前零生产调用点）：命令文本暂存
    // 凭据/密钥文件 → high，auto-safe 也要走审批。聚合形态（. / -A / --all）静态
    // 无法核验暂存文件 → 哨兵项，medium + 建议改用 git 工具（自带敏感文件筛查）。
    // 检测器不抛——不可解析命令只是漏报，不会崩。
    const gitAddHits = detectSensitiveGitAdd(cmd)
    if (gitAddHits.some(h => h !== AGGREGATE_ADD_MARKER)) {
      reasons.push('git add stages credential/key files — prompt hard-gate')
      level = 'high'
    }
    if (gitAddHits.includes(AGGREGATE_ADD_MARKER) && level !== 'high') {
      reasons.push('git add 聚合形态（. / -A / --all）无法静态核验暂存文件——建议改用 git 工具（自带敏感文件筛查）')
      level = 'medium'
    }
    // Command injection detection
    for (const p of INJECTION_PATTERNS) {
      if (p.test(cmd)) {
        reasons.push(`command injection pattern: ${p.source}`)
        level = 'high'
        break
      }
    }
    // Extended destructive command detection
    for (const p of DESTRUCTIVE_EXTENDED_PATTERNS) {
      if (p.test(cmd)) {
        reasons.push(`extended destructive command: ${p.source}`)
        level = level === 'high' ? 'high' : 'medium'
        break
      }
    }
    // Sed bypass on security-critical files
    for (const p of SED_BYPASS_PATTERNS) {
      if (p.test(cmd)) {
        reasons.push('sed bypass on security-critical file')
        level = 'high'
        break
      }
    }
  }

  // Sandbox execution: code runs in Node.js child process with full fs/net/child_process
  // access. Despite the "sandbox" name, this is NOT isolated — treat as arbitrary code execution.
  if (toolName === 'sandbox_exec') {
    reasons.push('arbitrary JavaScript execution — full Node.js process with fs/net/child_process access')
    level = 'high'
  }

  // Write operations
  if (toolName === 'write_file' || toolName === 'edit_file') {
    level = level === 'none' ? 'low' : level
  }

  // export_file：外部导出面。destination/source 任一形似工作区外路径（绝对路径/
  // 盘符/~）即至少 medium——此处无 cwd 可用，按与上面 path-traversal 相同的
  // 绝对路径启发式判；主闸在 pipeline 的 out-of-workspace 路由（pathGrantNeed）。
  if (toolName === 'export_file') {
    const exportTargets = [input.destination_path, input.source_path].filter((v): v is string => typeof v === 'string')
    if (exportTargets.some(p => isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('~'))) {
      reasons.push('export to out-of-workspace path')
      level = level === 'high' ? 'high' : 'medium'
    }
  }

  // Web fetch URL risk
  if (toolName === 'web_fetch') {
    const url = typeof input.url === 'string' ? input.url : ''
    if (url) {
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          reasons.push('non-http URL protocol')
          level = 'high'
        } else if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
          reasons.push('localhost URL target')
          level = level === 'high' ? 'high' : 'medium'
        } else if (isIP(parsed.hostname) > 0) {
          reasons.push('IP literal URL target')
          level = level === 'high' ? 'high' : 'medium'
        }
      } catch {
        reasons.push('malformed URL')
        level = 'medium'
      }
    }
  }

  // Rollback/undo is always high risk
  if (toolName === 'rollback' || toolName === 'undo') {
    reasons.push('state rollback changes working tree')
    level = 'high'
  }

  // MCP tool risk
  const mcpMatch = toolName.match(/^mcp__(.+)__(.+)$/)
  if (mcpMatch) {
    const serverId = mcpMatch[1]!
    reasons.push(`MCP tool from server "${serverId}"`)
    level = level === 'none' ? 'low' : level
    const policy = evaluateMcpPolicy({
      toolName,
      declaredCapability: declaredCapability ?? 'unknown',
      trustedServers: [],
      blockedTools: [],
      allowedTools: [],
      mustConfirmCapabilities: ['write', 'execute', 'network'],
    })
    reasons.push(`MCP policy: ${policy.action} (${policy.reason})`)
    if (policy.action === 'block') level = 'high'
    else if (policy.action === 'confirm' || policy.action === 'require') level = level === 'high' ? 'high' : 'medium'
    if (policy.capability === 'write' || policy.capability === 'execute') {
      reasons.push('MCP write-capable tool')
      level = level === 'high' ? 'high' : 'medium'
    }
  }

  // Antibody boost: raise risk if a failure_pattern claim's evidence mentions this tool
  for (const ab of antibodies) {
    const evidenceSummary = ab.evidence[0]?.summary ?? ''
    if (evidenceSummary.includes(toolName)) {
      reasons.push(`antibody match: ${ab.text.slice(0, 60)}`)
      if (level === 'none') level = 'low'
      break
    }
  }

  // ── Sensorium-driven adaptive confidence ──────────────────────
  if (sensorium) {
    if (sensorium.confidence < CONFIDENCE_THRESHOLDS.escalateConfidence) {
      // Low confidence → escalate risk one level (never downgrade)
      if (level === 'none') { level = 'low'; reasons.push('low sensorium confidence (escalated)') }
      else if (level === 'low') { level = 'medium'; reasons.push('low sensorium confidence (escalated)') }
      else if (level === 'medium') { level = 'high'; reasons.push('low sensorium confidence (escalated)') }
      // 'high' stays 'high'
    }
    // Note: confidence > autoApproveConfidence does NOT downgrade here.
    // The auto-approve decision is made downstream in tool-pipeline.ts
    // based on the combination of risk level + confidence.
  }

  const suggestedAction = level === 'high'
    ? 'Require explicit user approval before execution.'
    : level === 'medium'
      ? 'Show risk context and proceed only in auto-safe/manual modes.'
      : 'No additional approval required.'

  return { level, reasons, suggestedAction }
}
