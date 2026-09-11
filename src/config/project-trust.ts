/**
 * Project trust —— 项目级配置/hooks 信任门。
 *
 * SECURITY.md 信任边界：仓库内容（含项目内 .rivet/hooks.json 与 .rivet-config.json）
 * 不能单独构成执行动作的授权。项目在用户显式授信（TUI /trust、CLI --trust 或
 * RIVET_TRUST_PROJECT=1）之前，项目级 hooks 不执行、项目级配置中的安全敏感键
 * 被 loadConfig 剥离——fail-closed。授信决策持久化在
 * `<rivetHome>/project-trust.json`（按 realpath 键控，永不写进仓库目录）。
 *
 * RIVET_TRUST_PROJECT 优先级高于信任文件：'1' 视为已授信（CI/无头场景），
 * '0' 强制未授信（审计）。其他值忽略，回落文件判定。
 */

import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { rivetHome } from './paths.js'
import { writeFileAtomicSync } from '../fs-atomic.js'

interface TrustStore {
  /** realpath(项目目录) → 授信时间（ISO 字符串）。 */
  trusted: Record<string, string>
  /** realpath(项目目录) → 关闭启动授信提示的时间（ISO 字符串）。 */
  dismissed: Record<string, string>
}

const ENV_OVERRIDE = 'RIVET_TRUST_PROJECT'

function trustStorePath(): string {
  return join(rivetHome(), 'project-trust.json')
}

function canonicalProjectDir(cwd: string): string {
  try {
    return realpathSync(resolve(cwd))
  } catch {
    return resolve(cwd)
  }
}

function readTrustStore(): TrustStore {
  try {
    const raw = JSON.parse(readFileSync(trustStorePath(), 'utf-8')) as Partial<TrustStore>
    if (raw && typeof raw === 'object') {
      return {
        trusted: raw.trusted && typeof raw.trusted === 'object' ? raw.trusted : {},
        dismissed: raw.dismissed && typeof raw.dismissed === 'object' ? raw.dismissed : {},
      }
    }
  } catch {
    // 缺失/坏文件按未授信处理——fail-closed
  }
  return { trusted: {}, dismissed: {} }
}

function writeTrustStore(store: TrustStore): void {
  const dir = rivetHome()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileAtomicSync(trustStorePath(), JSON.stringify(store, null, 2) + '\n')
}

/** 项目目录是否已被用户授信。env 覆盖优先，其次信任文件。 */
export function isProjectTrusted(cwd: string): boolean {
  const env = process.env[ENV_OVERRIDE]
  if (env === '1') return true
  if (env === '0') return false
  return Object.prototype.hasOwnProperty.call(readTrustStore().trusted, canonicalProjectDir(cwd))
}

/** 授信当前项目（幂等；同时清除"不再提示"标记——重新授信即重新参与启动提示语义）。 */
export function trustProject(cwd: string): void {
  const key = canonicalProjectDir(cwd)
  const store = readTrustStore()
  const hadDismissed = Object.prototype.hasOwnProperty.call(store.dismissed, key)
  if (hadDismissed) delete store.dismissed[key]
  if (Object.prototype.hasOwnProperty.call(store.trusted, key)) {
    if (hadDismissed) writeTrustStore(store)
    return
  }
  store.trusted[key] = new Date().toISOString()
  writeTrustStore(store)
}

/** 撤销授信（幂等；未授信时为 no-op）。 */
export function untrustProject(cwd: string): void {
  const key = canonicalProjectDir(cwd)
  const store = readTrustStore()
  if (!Object.prototype.hasOwnProperty.call(store.trusted, key)) return
  delete store.trusted[key]
  writeTrustStore(store)
}

/** 关闭当前项目的启动授信提示（幂等）。不授信——安全键仍被剥离。 */
export function dismissProjectTrustPrompt(cwd: string): void {
  const key = canonicalProjectDir(cwd)
  const store = readTrustStore()
  if (Object.prototype.hasOwnProperty.call(store.dismissed, key)) return
  store.dismissed[key] = new Date().toISOString()
  writeTrustStore(store)
}

/** 当前项目是否已关闭启动授信提示。 */
export function isTrustPromptDismissed(cwd: string): boolean {
  return Object.prototype.hasOwnProperty.call(readTrustStore().dismissed, canonicalProjectDir(cwd))
}

/** 列出已授信项目（realpath 数组，调试/命令面板用）。 */
export function listTrustedProjects(): string[] {
  return Object.keys(readTrustStore().trusted)
}

/** 单次进程内提示去重——hooks 每事件读取、config 可能 HMR 重载，避免刷屏。 */
const noticed = new Set<string>()
export function notifyUntrustedOnce(kind: 'hooks' | 'config', projectDir: string, strippedKeys?: string[]): void {
  const key = `${kind}:${projectDir}`
  if (noticed.has(key)) return
  noticed.add(key)
  const how = `TUI 执行 /trust 授信（或启动加 --trust / 设 RIVET_TRUST_PROJECT=1）`
  const keyList = strippedKeys && strippedKeys.length > 0
    ? strippedKeys.join('/')
    : 'permissions/mcp/hooks/providers/env/plugins/mirrors/network/fetch/ui.statusLine/agent.approval 等'
  const what = kind === 'hooks'
    ? `检测到项目 hooks（${join(projectDir, '.rivet', 'hooks.json')}），项目未授信，已跳过执行`
    : `检测到项目配置（${join(projectDir, '.rivet-config.json')}），项目未授信，其中安全敏感键（${keyList}）已忽略`
  console.error(`[rivet] ${what}——${how}。信任决策存于 ${trustStorePath()}，绝不写回仓库。`)
}

export const PROJECT_CONFIG_FILE_NAME = '.rivet-config.json'

/** 未授信时从项目层配置剥离的顶层键——任一键都能把 SECURITY.md 声明的
 *  审批/边界/出口控制整体旁路（写盘授权、bash 预授权、静默 YOLO、假 shell、
 *  MCP 拉进程、baseUrl+key 重定向、statusline 命令执行、verify 声明命令执行、
 *  搜索 key 外发、镜像路由安装源、启停已装插件、**MCP 子进程出口改向**、
 *  **web_fetch 正文抽取改向**）。
 *  network 键经 readNetworkConfigSafe → buildStdioChildEnv 把 proxy 注入每个
 *  MCP stdio 子进程的 HTTPS_PROXY/HTTP_PROXY（2026-09 核验补漏）。fetch 键的
 *  jinaBaseUrl 把 web_fetch 每次正文抽取改道 `${base}/${目标URL}`——目标 URL
 *  外发 + 攻击者控制的 markdown 回流 agent 上下文（与 network 同类的出口改向，
 *  2026-09-11 发版审查补漏）。注意 schema
 *  的 permissions 实际嵌在 agent 下（agent.permissions），顶层 permissions 是
 *  不存在的键——保留在集合里仅作纵深。 */
const UNTRUSTED_TOP_LEVEL_KEYS = new Set([
  'permissions', 'mcp', 'hooks', 'env', 'provider', 'providers', 'search', 'verify',
  'plugins', 'mirrors', 'network', 'fetch',
])

/** 未授信时剥离的嵌套键（点路径相对项目层配置根）。 */
const UNTRUSTED_NESTED_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['agent', 'approval'],
  ['agent', 'unsandboxed'],
  // schema 的真实位置：allow/deny 规则、bash 预授权白名单、additionalRead/WriteDirs
  // 常驻目录授权（bootstrap/serve-agent 启动即生效、零审批）都在 agent.permissions 下。
  ['agent', 'permissions'],
  ['ui', 'statusLine'],
  ['skills', 'importFromClaude'],
]

/** 返回剥离后的浅拷贝；原对象不被修改。仅外观/工具选择等非授权键保留。 */
export function stripUntrustedProjectKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (UNTRUSTED_TOP_LEVEL_KEYS.has(key)) continue
    out[key] = value
  }
  for (const [parent, child] of UNTRUSTED_NESTED_KEYS) {
    const node = out[parent]
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      const clone = { ...(node as Record<string, unknown>) }
      delete clone[child]
      out[parent] = clone
    }
  }
  return out
}

/** 列出项目层配置中实际存在、未授信时会被剥离的敏感键（嵌套键报点路径）。 */
export function findSensitiveProjectKeys(raw: Record<string, unknown>): string[] {
  const found: string[] = []
  for (const key of Object.keys(raw)) {
    if (UNTRUSTED_TOP_LEVEL_KEYS.has(key)) found.push(key)
  }
  for (const [parent, child] of UNTRUSTED_NESTED_KEYS) {
    const node = raw[parent]
    if (node && typeof node === 'object' && !Array.isArray(node)
      && Object.prototype.hasOwnProperty.call(node, child)) {
      found.push(`${parent}.${child}`)
    }
  }
  return found
}

export interface ProjectTrustStakes {
  /** 项目配置中实际会被剥离的敏感键（点路径）。 */
  sensitiveKeys: string[]
  /** 是否存在项目级 hooks（.rivet/hooks.json）。 */
  hasHooks: boolean
}

/**
 * 启动授信提示的赌注检测：项目里有没有"未授信就会失效"的东西。
 * 配置文件读失败/无敏感键且无 hooks → 无赌注，不该打扰用户。
 */
export function detectProjectTrustStakes(cwd: string): ProjectTrustStakes {
  let sensitiveKeys: string[] = []
  try {
    const raw: unknown = JSON.parse(readFileSync(join(cwd, PROJECT_CONFIG_FILE_NAME), 'utf-8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      sensitiveKeys = findSensitiveProjectKeys(raw as Record<string, unknown>)
    }
  } catch {
    // 配置文件缺失/坏 JSON → 无配置侧赌注
  }
  return { sensitiveKeys, hasHooks: existsSync(join(cwd, '.rivet', 'hooks.json')) }
}
