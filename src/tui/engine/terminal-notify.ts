/**
 * 终端级桌面通知（计划 C1）——OSC 9 / OSC 777 / BEL 三层适配。
 *
 * 为什么需要：TUI 的终态信号原本只进 scrollback（`✦ Worked for…`），用户离开
 * 终端窗口后什么也收不到；既有 BEL 仅覆盖 worker/job 终态且默认关闭
 * （`RIVET_NOTIFY_BELL=1`）。本模块把「run 终态」升级为终端可转发的系统通知：
 * iTerm2 / WezTerm / Konsole / mintty 等认得 OSC 9，urxvt 与 WezTerm 兼容
 * OSC 777；不认识这些序列的终端（如 Apple Terminal）由 auto 探测拦下——绝不
 * 盲发，避免把转义序列当可见文本打印出来。
 *
 * 序列（ST 用 BEL `\x07` 终止，与 iTerm2 文档一致；ESC 序列以 `\x1b]` 开头）：
 *   OSC 9   : `\x1b]9;{message}\x07`                 iTerm2 / WezTerm / Konsole
 *   OSC 777 : `\x1b]777;notify;{title};{body}\x07`   urxvt / WezTerm 兼容形态
 *   BEL     : `\x07`                                 通用回退（无标题/正文）
 *
 * tmux：`$TMUX` 存在时把序列包进 passthrough 信封
 * （`\x1bPtmux;\x1b{seq}\x1b\\`）。外层 tmux 需 `allow-passthrough on` 才会转发；
 * 不转发也无害——信封本身被 tmux 吃掉，不留残字。
 *
 * 安全：所有进入序列的自由文本先过 `sanitizeTerminalText`——剥掉 C0/C1 控制字符
 * （尤其 `\x1b` 与 `\x07`）。否则错误消息里嵌一个 ESC 就能把「通知」变成任意
 * 转义注入（kitty 通知协议文档对同族问题有明确要求）。
 *
 * env（在 config/env-registry 注册）：`RIVET_NOTIFY_OSC = off | 9 | 777 | both |
 * auto`（缺省 auto）。BEL 仍由既有的 `RIVET_NOTIFY_BELL` 独立控制，二者互不影响。
 */

/** C0（含 ESC/BEL）+ DEL + C1 控制字符——通知文本里出现即可能构成转义注入。 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g

/** 剥掉控制字符（替换为空格保持可读）。通知序列的文本部分永远不含它们。 */
export function sanitizeTerminalText(text: string): string {
  return text.replace(CONTROL_RE, ' ')
}

/** OSC 9 通知：单段消息。 */
export function osc9(message: string): string {
  return `\x1b]9;${sanitizeTerminalText(message)}\x07`
}

/** OSC 777 通知：标题 + 正文（urxvt 扩展，WezTerm 兼容）。 */
export function osc777(title: string, body: string): string {
  return `\x1b]777;notify;${sanitizeTerminalText(title)};${sanitizeTerminalText(body)}\x07`
}

/** 裸 BEL——与 RIVET_NOTIFY_BELL 既有路径同源的通用回退。 */
export function bel(): string {
  return '\x07'
}

/** tmux passthrough：外层 tmux 仅在 allow-passthrough 打开时转发。 */
export function wrapTmux(sequence: string): string {
  return `\x1bPtmux;\x1b${sequence}\x1b\\`
}

export type OscMode = 'off' | '9' | '777' | 'both' | 'auto'

/** 解析 RIVET_NOTIFY_OSC；缺省与未知值一律 auto。 */
export function resolveOscMode(raw: string | undefined): OscMode {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'off':
    case '0':
    case 'none':
      return 'off'
    case '9':
      return '9'
    case '777':
      return '777'
    case 'both':
      return 'both'
    default:
      return 'auto'
  }
}

/**
 * auto 模式的终端启发式：只有已知认 OSC 9/777 的终端才发。
 * 未识别（Apple Terminal / 匿名 TERM）返回 false——宁可少发不盲发。
 */
export function terminalSupportsOsc(termProgram: string | undefined): boolean {
  const tp = (termProgram ?? '').toLowerCase()
  return tp.includes('iterm') || tp.includes('wezterm') || tp.includes('konsole') || tp.includes('mintty')
}

export interface TerminalNotifyDeps {
  /** 注入 env（测试用）；缺省 process.env。 */
  env?: Record<string, string | undefined>
}

export interface TerminalNotifyOptions {
  title: string
  body: string
}

/**
 * 构造通知序列。返回 '' 表示「本终端/本配置不发」——调用方直接 write 安全。
 * 顺序：off → ''；auto 且终端未识别 → ''；both → OSC 777 + OSC 9；其余单发。
 */
export function notifySequence(options: TerminalNotifyOptions, deps: TerminalNotifyDeps = {}): string {
  const env = deps.env ?? process.env
  const mode = resolveOscMode(env.RIVET_NOTIFY_OSC)
  if (mode === 'off') return ''
  if (mode === 'auto' && !terminalSupportsOsc(env.TERM_PROGRAM)) return ''
  const inTmux = Boolean(env.TMUX)
  const wrap = (seq: string): string => (inTmux ? wrapTmux(seq) : seq)
  const composed = `${options.title} — ${options.body}`
  if (mode === '777') return wrap(osc777(options.title, options.body))
  if (mode === 'both') return wrap(osc777(options.title, options.body)) + wrap(osc9(composed))
  return wrap(osc9(composed))
}
