/**
 * server-approval.ts — MCP **连接级**审批存储（issue #215）。
 *
 * 与工具调用级的 `createMcpConnectorConsent`（wrapper.ts:26）是两层不同的门：
 * 那道门在工具**首次 execute** 时自动授予（wrapper.ts:27 `grantConsent`），门的是
 * 「用不用这个连接器的工具」，拦不住「把 server 拉起来」这件事本身。一个 stdio
 * MCP server 在连接瞬间就会执行它配置的 `command`（npx/uvx/任意可执行文件）并把
 * `env` 注入子进程——等同于「在本机跑一段写在配置里的代码」。SECURITY.md 的信任
 * 边界要求在用户显式授权前不执行仓库内容；连接级审批是这个边界在 MCP 上的对应物。
 *
 * 因此本 store 门的是 **spawn 之前**（manager 的 `_connectAndDiscover` 入口，
 * `initialize` / `reconcileFromConfig` / REST 热加三个入口共用同一道门）。
 *
 * 键用**指纹**（`mcpServerFingerprint`）而不是 serverId：审批语义是「我批准这条
 * **命令**」，不是「我批准这个 serverId」。若按 id 记，改掉 command/args/cwd/env
 * 键名/url 之后旧审批仍然生效——等于给未来任意命令留了一个永久后门。
 *
 * 决策持久化在 `<rivetHome>/mcp-approvals.json`（按指纹键控，永不写进仓库目录，
 * 0o600）。`rivetHome()` 尊重 RIVET_HOME，测试据此注入临时 home。
 *
 * 无交互 UI 时 **fail-open**（用户拍板，issue #215）——见 `mcpApprovalInteractive()`。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rivetHome } from '../config/paths.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import type { McpServerConfig } from './config.js'

/** 连接级审批的三态判定。 */
export type McpApprovalDecision = 'approved' | 'awaiting' | 'denied'

/**
 * 待批准连接的 server 摘要——供 UI（`GET /mcp/status.pendingApproval`）消费。
 *
 * **只含 env 的键名**：值一律遮蔽。MCP env 里多是 API key / token，把它们
 * 回传到面板等于把凭据搬到另一个出口；审批只需要让用户看清「会跑什么命令、
 * 会注入哪些变量」，不需要看见值。
 */
export interface McpPendingApproval {
  serverId: string
  /** command+args+cwd+env 键名+url 的 sha256（审批键）。 */
  fingerprint: string
  /** stdio（有 command）或 remote（有 url）。 */
  source: 'stdio' | 'remote'
  command?: string
  args?: string[]
  cwd?: string
  /** env 变量**键名**（已排序）。 */
  envKeys: string[]
  url?: string
}

interface ApprovalEntry {
  serverId: string
  /** 批准/拒绝时间（ISO 字符串）。 */
  at: string
}

interface ApprovalStore {
  /** fingerprint → 批准记录。 */
  approved: Record<string, ApprovalEntry>
  /** fingerprint → 拒绝记录。 */
  denied: Record<string, ApprovalEntry>
}

function approvalStorePath(): string {
  return join(rivetHome(), 'mcp-approvals.json')
}

function readApprovalStore(): ApprovalStore {
  try {
    const raw = JSON.parse(readFileSync(approvalStorePath(), 'utf-8')) as Partial<ApprovalStore>
    if (raw && typeof raw === 'object') {
      return {
        approved: raw.approved && typeof raw.approved === 'object' ? raw.approved : {},
        denied: raw.denied && typeof raw.denied === 'object' ? raw.denied : {},
      }
    }
  } catch {
    // 缺失/坏文件按「未审批」处理——fail-closed（无记录 = 待批准）。
  }
  return { approved: {}, denied: {} }
}

function writeApprovalStore(store: ApprovalStore): void {
  const dir = rivetHome()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileAtomicSync(approvalStorePath(), JSON.stringify(store, null, 2) + '\n')
}

/**
 * 一个 server 配置的连接审批指纹。
 *
 * 覆盖「拉起这个 server 会实际执行/连到的一切」：command、args、cwd、env 的
 * **键名**（值不参与——改一个 secret 的值不该逼用户重新审批）、url。任一项变化
 * ⇒ 指纹变化 ⇒ 视为新 server，需重新审批。
 */
export function mcpServerFingerprint(cfg: McpServerConfig): string {
  const payload = JSON.stringify({
    command: cfg.command ?? null,
    args: cfg.args ?? null,
    cwd: cfg.cwd ?? null,
    envKeys: cfg.env ? Object.keys(cfg.env).sort() : [],
    url: cfg.url ?? null,
  })
  return createHash('sha256').update(payload).digest('hex')
}

/** 查询某配置是否已获批 / 被拒 / 待批（**不含** fail-open 判定）。 */
export function checkMcpServerApproval(cfg: McpServerConfig): McpApprovalDecision {
  const fp = mcpServerFingerprint(cfg)
  const store = readApprovalStore()
  if (Object.prototype.hasOwnProperty.call(store.approved, fp)) return 'approved'
  if (Object.prototype.hasOwnProperty.call(store.denied, fp)) return 'denied'
  return 'awaiting'
}

/**
 * 是否存在「可批准 MCP 连接的交互界面」。
 *
 * 用户已拍板（issue #215）：**无交互 UI 时 fail-open——照跑不拦**。判据可覆盖：
 *   1. `RIVET_MCP_APPROVAL=gate` → 强制门生效（接入审批 UI 的宿主必须显式设置；
 *      见下「为什么」）。
 *   2. `RIVET_MCP_APPROVAL=open` → 强制 fail-open（CI / 无头脚本 / 测试）。
 *   3. 未显式指定 → 看 stdout 是否 TTY：只有真正的交互终端才有地方弹提示，
 *      否则（headless / `-p` / 管道重定向 / 桌面 sidecar）一律 fail-open。
 *
 * 为什么 fail-open 而不是 fail-closed：这道门的目标是「让用户**知情地**授权一次
 * spawn」。没有 UI 时没有人能看见、也没有人能回应这个提示，fail-closed 会把所有
 * CLI 一次性脚本、CI、桌面冷启动全部焊死——代价远大于收益。反过来，接入交互审批
 * UI 的宿主必须显式设 `RIVET_MCP_APPROVAL=gate`，否则门不生效——这是**有意**的：
 * 没有 UI 就不该拦。未来若误删这段判定导致「等待审批」永远吊住，回头读这里。
 */
export function mcpApprovalInteractive(): boolean {
  const mode = process.env.RIVET_MCP_APPROVAL
  if (mode === 'gate') return true
  if (mode === 'open') return false
  return Boolean(process.stdout.isTTY)
}

let failOpenNoticed = false
function notifyFailOpenOnce(): void {
  if (failOpenNoticed) return
  failOpenNoticed = true
  console.error(
    '[rivet] 检测到无交互 UI（headless / 非 TTY / RIVET_MCP_APPROVAL=open），' +
    'MCP 连接级审批门 fail-open——服务器照常启动、不拦截。' +
    '需要审批拦截时设 RIVET_MCP_APPROVAL=gate 并在有 TTY 的界面中操作。',
  )
}

/**
 * 解析一个 server 配置是否允许连接——**生产入口**（manager 的
 * `_mcpApprovalDecision` 委托到这里）。
 */
export function resolveMcpApproval(cfg: McpServerConfig): McpApprovalDecision {
  if (!mcpApprovalInteractive()) {
    notifyFailOpenOnce()
    return 'approved'
  }
  return checkMcpServerApproval(cfg)
}

/** 批准某配置的连接（幂等；会清掉同指纹的拒绝记录）。 */
export function approveMcpServer(cfg: McpServerConfig): void {
  const fp = mcpServerFingerprint(cfg)
  const store = readApprovalStore()
  delete store.denied[fp]
  store.approved[fp] = { serverId: cfg.command ?? cfg.url ?? fp, at: new Date().toISOString() }
  writeApprovalStore(store)
}

/** 拒绝某配置的连接（幂等；会清掉同指纹的批准记录）。 */
export function denyMcpServer(cfg: McpServerConfig): void {
  const fp = mcpServerFingerprint(cfg)
  const store = readApprovalStore()
  delete store.approved[fp]
  store.denied[fp] = { serverId: cfg.command ?? cfg.url ?? fp, at: new Date().toISOString() }
  writeApprovalStore(store)
}

/** 清掉某配置的审批记录（approve/deny 都清，回到待批准）。用于「撤销」。 */
export function forgetMcpServerApproval(cfg: McpServerConfig): void {
  const fp = mcpServerFingerprint(cfg)
  const store = readApprovalStore()
  const hadApproved = Object.prototype.hasOwnProperty.call(store.approved, fp)
  const hadDenied = Object.prototype.hasOwnProperty.call(store.denied, fp)
  if (!hadApproved && !hadDenied) return
  delete store.approved[fp]
  delete store.denied[fp]
  writeApprovalStore(store)
}
