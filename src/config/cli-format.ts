/**
 * Config CLI 输出格式化 — ANSI 着色 + Unicode 框线。
 *
 * 纯函数集合：接收数据 → 返回格式化字符串。TTY 检测由调用方传入 `useColor`；
 * useColor=false 时框线降级 ASCII、颜色无操作（chalk.level=0 终端的自然行为，
 * ansi.ts 的 color() 在 level 0 时返回纯文本，但为了保证无 ANSI 逃逸，本模块
 * 在 useColor=false 也显式走纯文本分支）。
 */

import { color } from '../tui/engine/ansi.js'
import type { ProviderConfig } from './schema.js'
import type { McpServerConfig } from '../mcp/config.js'
import { contractModels } from './contract-models.js'

// ── 颜色常量（chalk 命名色，ansi.ts 的 NAMED_FG_CODES 覆盖） ──

const KEY_COLOR = 'cyan'           // 键名
const URL_COLOR = 'green'          // URL / 命令
const PROTOCOL_COLOR = 'blue'      // 协议
const KEYREF_COLOR = 'yellow'      // API key 引用（***abcd / env var 名）
const MODEL_COLOR = 'white'        // 模型列表（核心关注信息）
const THINKING_COLOR = 'magenta'   // thinking 开关
const SUCCESS_COLOR = 'green'      // 成功标记 / 状态 ok
const ERROR_COLOR = 'red'          // 错误标记
const MUTED_COLOR = 'gray'         // 置灰
const HEADER_COLOR = 'cyan'        // 标题/ID

// ── 框线字符 ──

const BOX = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│',
} as const

const BOX_ASCII = {
  tl: '+', tr: '+', bl: '+', br: '+',
  h: '-', v: '|',
} as const

interface BoxChars {
  tl: string; tr: string; bl: string; br: string;
  h: string; v: string;
}

// ── 公共工具 ──

export interface FormatOpts {
  useColor: boolean
  /** 可用宽度，默认 80 */
  width?: number
}

function box(opts: FormatOpts): BoxChars {
  return opts.useColor ? BOX : BOX_ASCII
}

function c(text: string, fgColor: string, opts: FormatOpts, style?: { bold?: boolean; dim?: boolean }): string {
  if (!opts.useColor) return text
  return color(text, fgColor, style)
}

function dim(text: string, opts: FormatOpts): string {
  return c(text, MUTED_COLOR, opts, { dim: true })
}


/** 保守的显示宽度（不依赖完整 Unicode 宽度表，只处理常见情况）。 */
function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    // CJK 统一表意文字 + 全角符号
    if ((cp >= 0x4E00 && cp <= 0x9FFF) ||
        (cp >= 0x3400 && cp <= 0x4DBF) ||
        (cp >= 0xF900 && cp <= 0xFAFF) ||
        (cp >= 0xFF01 && cp <= 0xFF60) ||
        (cp >= 0x3000 && cp <= 0x303F)) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}


// ── 格式化函数 ──

/**
 * 格式化区段标题。
 * 输出形如 `── Section Name ──`。
 */
export function formatSectionHeader(title: string, opts: FormatOpts): string {
  const b = box(opts)
  const inner = ` ${title} `
  const sideLen = Math.max(4, Math.floor(((opts.width ?? 80) - displayWidth(inner)) / 2))
  const left = b.h.repeat(sideLen)
  const right = b.h.repeat(Math.max(0, (opts.width ?? 80) - displayWidth(inner) - sideLen))
  return dim(left + inner + right, opts)
}

/**
 * 格式化键值对。
 * 输出形如 `  key: value`，键名着色加粗，值保持默认色。
 */
export function formatKeyValue(key: string, value: string, opts: FormatOpts, indent = 2): string {
  const prefix = ' '.repeat(indent)
  return `${prefix}${c(key, KEY_COLOR, opts, { bold: true })}: ${c(value, MODEL_COLOR, opts)}`
}

/**
 * 格式化成功确认消息。绿色 ✔ 前缀。
 */
export function formatSuccess(msg: string, opts: FormatOpts): string {
  return `${c('✔', SUCCESS_COLOR, opts, { bold: true })} ${msg}`
}

/**
 * 格式化错误消息。红色 ✘ 前缀。
 */
export function formatError(msg: string, opts: FormatOpts): string {
  return `${c('✘', ERROR_COLOR, opts, { bold: true })} ${c(msg, ERROR_COLOR, opts)}`
}

/**
 * 格式化单个 provider 信息卡。
 *
 * 输出：
 *   ┌─ provider-name ────────────────┐
 *   │  baseUrl: https://...          │
 *   │  apiKey:  ***abcd (inline)     │
 *   │  models:  v4-pro, v4-flash     │
 *   └────────────────────────────────┘
 */
export function formatProviderCard(
  name: string,
  provider: ProviderConfig,
  keyStatus: { source: 'inline' | 'env' | 'none'; ref: string },
  isDefault: boolean,
  opts: FormatOpts,
): string {
  const w = opts.width ?? 80
  const b = box(opts)
  const lines: string[] = []

  // 标题行：provider 名称 + 默认标记
  const titleText = isDefault ? `${name} (default)` : name
  const title = c(titleText, HEADER_COLOR, opts, { bold: true })
  const titleLen = displayWidth(titleText)  // 着色不计宽度
  const fillLen = Math.max(2, w - titleLen - 2)
  lines.push(`${b.tl}${b.h} ${title} ${b.h.repeat(fillLen)}${b.tr}`)

  // 内容区缩进 & 工具
  const indent = ` ${b.v}  `
  const blank = indent  // 空行保持边框竖线
  const key = (k: string) => c(k, KEY_COLOR, opts, { bold: true })

  // ── 连接信息 ──
  lines.push(blank)
  lines.push(`${indent}${key('baseUrl')}: ${c(provider.baseUrl, URL_COLOR, opts)}`)
  lines.push(`${indent}${key('protocol')}: ${c(provider.protocol ?? 'openai', PROTOCOL_COLOR, opts)}`)

  // ── 认证 ──
  const ks = keyStatus
  let keyLine: string
  switch (ks.source) {
    case 'inline':
      keyLine = `${c(ks.ref, KEYREF_COLOR, opts)} ${c('(inline)', SUCCESS_COLOR, opts)}`
      break
    case 'env':
      keyLine = `${c(ks.ref, KEYREF_COLOR, opts)} ${c('(env)', SUCCESS_COLOR, opts)}`
      break
    default:
      keyLine = c('(not set)', MUTED_COLOR, opts, { dim: true })
  }
  lines.push(`${indent}${key('apiKey')}: ${keyLine}`)

  // ── 模型 ──
  const models = contractModels(provider).map(m => m.id).join(', ')
  lines.push(`${indent}${key('models')}: ${c(models, MODEL_COLOR, opts)}`)

  if (provider.thinking) {
    lines.push(`${indent}${key('thinking')}: ${c(provider.thinking, THINKING_COLOR, opts)}`)
  }

  // 底边（含底 padding）
  lines.push(blank)
  lines.push(`${b.bl}${b.h.repeat(w - 2)}${b.br}`)

  // 卡片间额外空行
  return lines.join('\n') + '\n'
}

/**
 * 格式化单个 MCP 服务器行。紧凑一行式（列表项）。
 */
export function formatMcpServerRow(
  id: string,
  server: McpServerConfig,
  opts: FormatOpts,
): string {
  const b = box(opts)
  const prefix = ` ${b.v} `
  const idColored = c(id, HEADER_COLOR, opts, { bold: true })
  const type = server.command
    ? `${c('stdio', KEY_COLOR, opts)}: ${c(server.command, URL_COLOR, opts)}`
    : `${c('sse', KEY_COLOR, opts)}: ${c(server.url ?? '', URL_COLOR, opts)}`
  const disabledTag = server.disabled ? ` ${c('[disabled]', MUTED_COLOR, opts, { dim: true })}` : ''
  return `${prefix} ${idColored}: ${type}${disabledTag}`
}

/**
 * 格式化 MCP 服务器列表（含卡片框线）。
 */
export function formatMcpServerList(
  servers: Record<string, McpServerConfig>,
  opts: FormatOpts,
): string {
  const entries = Object.entries(servers)
  if (entries.length === 0) {
    return dim('No MCP servers configured.', opts)
  }
  const w = opts.width ?? 80
  const b = box(opts)
  const lines: string[] = []

  // 顶部边框
  const headerText = ' MCP Servers '
  const header = c(headerText, HEADER_COLOR, opts, { bold: true })
  const fillLen = Math.max(2, w - displayWidth(headerText) - 2)
  lines.push(`${b.tl}${b.h} ${header} ${b.h.repeat(fillLen)}${b.tr}`)

  // 服务器行
  for (const [id, server] of entries) {
    lines.push(formatMcpServerRow(id, server, opts))
  }

  // 底部边框
  lines.push(`${b.bl}${b.h.repeat(w - 2)}${b.br}`)

  return lines.join('\n')
}
