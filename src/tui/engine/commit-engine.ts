/**
 * T9 CommitEngine — 将已确定的格式化内容写入终端 scrollback。
 *
 * 核心原则：
 * - 只做 append-only `stdout.write()`，不跟踪已写入内容的位置。
 * - 进入 scrollback 的内容不可被擦除、不可被重绘。
 * - 替代 Ink 的 `<Static>` 组件语义，但无需 high-water index 追踪。
 *
 * 与现有的 `committed-log.ts` 的关系：
 * - `committed-log.ts` 作为数据层保留（LogEntry 存储 + dedup），
 *   CommitEngine 是其消费端——将 LogEntry 格式化后写入 stdout。
 * - 阶段 1 会提取格式化函数，届时 CommitEngine 调用这些函数。
 */

import type { WriteStream } from 'node:tty'
import { ANSI, enforceTextContract } from './ansi.js'
import { createRingBuffer, type RingBuffer } from '../ring-buffer.js'

/** Scrollback buffer 默认行数上限（长会话防内存无限增长）。 */
const DEFAULT_SCROLLBACK_MAX_LINES = 1000

export interface CommittedEntry {
  /** 原始文本内容（不含 ANSI 序列） */
  text: string
  /** 可选：已格式化的 ANSI 字符串。如果提供，直接使用此值。 */
  ansi?: string
  /** 可选：在条目后追加一个空行作为分隔 */
  trailingNewline?: boolean
}

export interface CommitEngineOptions {
  stdout: WriteStream
  /** 是否在每次 write 后立即 drain */
  flush?: boolean
  /** Scrollback buffer 行数上限（超出后丢弃最旧条目）。默认 1000。 */
  scrollbackMaxLines?: number
}

export class CommitEngine {
  private stdout: WriteStream
  private flush: boolean
  /**
   * Scrollback buffer: 累积所有已提交文本，供 pager overlay 读取。
   * 使用 RingBuffer 封顶——长会话下无界 string[] 会持续增长，
   * 超过上限后最旧条目被自动丢弃（保留最近的，匹配 pager 实际可见范围）。
   */
  private buffer: RingBuffer<string>

  constructor(options: CommitEngineOptions) {
    this.stdout = options.stdout
    this.flush = options.flush ?? false
    const cap = options.scrollbackMaxLines ?? DEFAULT_SCROLLBACK_MAX_LINES
    this.buffer = createRingBuffer<string>(Math.max(1, cap))
  }

  /** 返回 scrollback 完整文本（各条目以换行符连接，封顶后只含最近 N 条）。 */
  getContent(): string {
    return this.buffer.items().join('\n')
  }

  /**
   * 将一条已提交条目写入终端 scrollback。
   *
   * 写入策略：完整的 ANSI 行 + 换行符。终端驱动负责将已显示内容
   * 推入 scrollback buffer。
   *
   * 即使 live region 在底部显示，此写入也发生在 live region 的
   * 重绘区域之前（cursor save 之前），因此天然按时间顺序排列。
   */
  write(entry: CommittedEntry): void {
    // entry.text 的契约是「不含机动 ANSI 序列」——但契约此前只写在注释里，生产者
    // 侧没有强制，模型输出/工具输出/网页正文里的 OSC/CSI 原样进 scrollback
    // （OSC 52 覆写系统剪贴板、CSI 清屏/踢出 alt-screen）。在唯一汇聚点兜底
    // 执行契约：剥 OSC + 非 SGR 的 CSI + 控制字符，放行 SGR 纯样式（生产侧
    // 经此通道传 formatMarkdown/color() 的自产样式，剥了 scrollback 全褪色）。
    let content = entry.ansi ?? enforceTextContract(entry.text)
    if (!content.endsWith('\n')) content += '\n'
    if (entry.trailingNewline) content += '\n'
    this.buffer.push(content.trimEnd())
    this.stdout.write(content)
  }

  /**
   * 批量写入多条已提交条目。
   * 在同一帧中连续写入，减少系统调用次数。
   */
  writeBatch(entries: readonly CommittedEntry[]): void {
    let buf = ''
    for (const entry of entries) {
      const content = entry.ansi ?? entry.text
      const line = content + (content.endsWith('\n') ? '' : '\n') + (entry.trailingNewline ? '\n' : '')
      this.buffer.push(line.trimEnd())
      buf += line
    }
    this.stdout.write(buf)
  }

  /**
   * 写入原始 ANSI 字符串（不追加换行）。
   * 用于需要精确控制格式的场景（如分隔线、缩进）。
   */
  writeRaw(ansi: string): void {
    this.stdout.write(ansi)
  }

  /**
   * 写入一条水平分隔线。
   * 宽度 = 终端列数 或 指定宽度。
   */
  writeSeparator(width?: number): void {
    const w = width ?? this.stdout.columns
    this.stdout.write(`${ANSI.DIM}${'─'.repeat(w)}${ANSI.RESET}\n`)
  }

  /**
   * 确保输出已刷新到终端。
   */
  drain(): void {
    if (this.flush) {
      // stdout 在 TTY 模式下通常不需要手动 drain，
      // 但提供此方法作为显式刷新点。
    }
  }
}
