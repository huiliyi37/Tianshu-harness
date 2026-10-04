/**
 * T9 OverlayEngine — 管理全屏覆盖层的 alternate screen buffer 切换。
 *
 * 核心机制：
 * - 进入 overlay 时：`\x1B[?1049h` 切换到 alternate screen buffer
 * - overlay 内：全屏逐行渲染，用 `cursorTo(1,1)` 定位到顶部
 * - 退出 overlay 时：`\x1B[?1049l` 恢复主屏，scrollback 完整无损
 *
 * Surface 路由逻辑复用现有的 `src/tui/surface/router.ts`（纯逻辑，零依赖）。
 * OverlayEngine 只负责终端 buffer 切换和渲染调度。
 *
 * 支持的 overlay 类型（对应现有 Surface）：
 * - Starmap (星图) — 星君/星域总览
 * - Cockpit (座舱) — 运行时状态仪表盘
 * - Chronicle (编年史) — 会话回放
 * - Pager — 分页查看器
 * - CommandPalette — 命令面板
 */

import type { WriteStream } from 'node:tty'
import { ANSI, ANSI_SEQ_RE, cursorTo } from './ansi.js'

function stripAnsi(s: string): string {
  return s.replace(ANSI_SEQ_RE, '')
}

export type OverlayId = 'starmap' | 'cockpit' | 'chronicle' | 'pager' | 'command-palette' | string
export interface OverlayMenuHit { index: number; workerId?: string }
export type OverlayMenuLines = string[] & { menuRows: Map<number, OverlayMenuHit> }
export function createMenuLines(): OverlayMenuLines { return Object.assign([] as string[], { menuRows: new Map<number, OverlayMenuHit>() }) }

export interface OverlayRenderer {
  /** 渲染 overlay 内容。返回 ANSI 格式化后的行数组。 */
  render(width: number, height: number): string[] & { menuRows?: Map<number, OverlayMenuHit> }
  /**
   * 本帧硬件光标的落点（1-based 行/列）；null = 隐藏硬件光标。
   * 输入类 overlay 用它呈现"格子边界"光标——终端原生光标不占字符格、
   * 不挤压文本，位置由渲染方按显示宽度折算。未提供此方法的 overlay
   * 维持光标隐藏（进 alt screen 时已 HIDE）。
   */
  caret?(width: number, height: number): { row: number; col: number } | null
  /** overlay 激活时的回调 */
  onActivate?(): void
  /** overlay 失活时的回调 */
  onDeactivate?(): void
}

export interface OverlayEngineOptions {
  stdout: WriteStream
  /** 当前终端尺寸获取函数（每次渲染时调用） */
  getSize: () => { cols: number; rows: number }
  /** 进入 alt screen（overlay 激活）时触发——调用方据此暂停主屏污染检测。 */
  onEnterAltScreen?: () => void
  /** 退出 alt screen（overlay 关闭）时触发——调用方据此恢复主屏污染检测。 */
  onExitAltScreen?: () => void
}

export class OverlayEngine {
  private stdout: WriteStream
  private getSize: () => { cols: number; rows: number }
  private onEnterAltScreen?: () => void
  private onExitAltScreen?: () => void
  private active: OverlayId | null = null
  private renderers = new Map<OverlayId, OverlayRenderer>()
  private inAltScreen = false
  private borrowed = false
  /** 上一帧屏上每行内容（权威缓存），用于行级 diff。空 = 需全量重绘。 */
  private lastFrame: string[] = []
  private lastCols = 0
  private lastRows = 0
  private menuRows = new Map<number, OverlayMenuHit>()

  constructor(options: OverlayEngineOptions) {
    this.stdout = options.stdout
    this.getSize = options.getSize
    this.onEnterAltScreen = options.onEnterAltScreen
    this.onExitAltScreen = options.onExitAltScreen
  }

  /** The main fullscreen renderer owns 1049; overlays borrow its grid. */
  setBorrowed(borrowed: boolean): void { this.borrowed = borrowed }

  /**
   * 注册一个 overlay 渲染器。
   * 通常在模块初始化时调用。
   */
  register(id: OverlayId, renderer: OverlayRenderer): void {
    this.renderers.set(id, renderer)
  }

  /** 取消注册 */
  unregister(id: OverlayId): void {
    if (this.active === id) {
      this.deactivate()
    }
    this.renderers.delete(id)
  }

  /**
   * 激活指定 overlay。
   * - 如果已有活跃 overlay，先停用旧的再激活新的。
   * - 自动进入 alternate screen buffer。
   */
  activate(id: OverlayId): boolean {
    const renderer = this.renderers.get(id)
    if (!renderer) return false

    // 停用当前 overlay
    if (this.active !== null) {
      this.deactivateInternal()
    }

    this.active = id
    this.enterAltScreen()
    // 进入 alt screen 后缓存作废 → 首帧全量重绘。
    this.resetFrameCache()
    renderer.onActivate?.()
    this.render()
    return true
  }

  /** 停用当前活跃的 overlay，恢复主屏。 */
  deactivate(): void {
    if (this.active === null) return
    this.deactivateInternal()
  }

  /** 重新渲染当前 overlay（如 resize 后）。 */
  rerender(): void {
    if (this.active === null) return
    this.render()
  }

  /** 当前是否在 overlay 中 */
  isActive(): boolean {
    return this.active !== null
  }

  /** 当前活跃的 overlay ID */
  activeId(): OverlayId | null {
    return this.active
  }

  rowText(row: number): string { return stripAnsi(this.lastFrame[row - 1] ?? '') }
  menuHit(x: number, y: number): OverlayMenuHit | undefined {
    return x >= 1 && x <= this.lastCols && y >= 1 && y <= this.lastRows ? this.menuRows.get(y) : undefined
  }

  // ── internal ─────────────────────────────────────────────────

  private enterAltScreen(): void {
    if (this.inAltScreen) return
    if (!this.borrowed) this.stdout.write(ANSI.ALT_SCREEN_ON)
    this.stdout.write(ANSI.HIDE_CURSOR)
    this.inAltScreen = true
    // 通知调用方：已进入 alt screen，主屏 live region 的光标位置/污染检测应暂停，
    // 否则 CPR 探针会把"光标在 overlay 里"误判为主屏污染，触发 renderLive 把
    // 主屏帧写进 alt screen（picker 残影泄漏回主会话的根因）。
    this.onEnterAltScreen?.()
  }

  private exitAltScreen(): void {
    if (!this.inAltScreen) return
    // 恢复终端默认光标形状（overlay 期间曾切稳态竖条抑制原生闪烁）。
    this.stdout.write(ANSI.CURSOR_SHAPE_DEFAULT)
    this.stdout.write(ANSI.SHOW_CURSOR)
    if (!this.borrowed) this.stdout.write(ANSI.ALT_SCREEN_OFF)
    this.inAltScreen = false
    // 通知调用方：已退出 alt screen 回到主屏，恢复污染检测。
    this.onExitAltScreen?.()
  }

  private deactivateInternal(): void {
    const id = this.active!
    const renderer = this.renderers.get(id)
    renderer?.onDeactivate?.()
    this.active = null
    this.resetFrameCache()
    this.exitAltScreen()
  }

  private resetFrameCache(): void {
    this.lastFrame = []
    this.lastCols = 0
    this.lastRows = 0
    this.menuRows.clear()
  }

  private render(): void {
    const renderer = this.renderers.get(this.active!)
    if (!renderer) return

    const { cols, rows } = this.getSize()
    const lines = renderer.render(cols, rows)

    // 目标帧：定长 rows，超出内容行的位置补空串（与全屏擦除语义一致）。
    const desired: string[] = new Array<string>(rows)
    for (let i = 0; i < rows; i++) {
      desired[i] = i < lines.length && lines[i] !== undefined ? lines[i]! : ''
    }

    // 首帧 / 尺寸变化 / 缓存作废 → 全量重绘（从 (1,1) 逐行擦除+写入）。
    const cacheValid =
      this.lastFrame.length === rows && cols === this.lastCols && rows === this.lastRows
    let body: string
    if (!cacheValid) {
      let out = cursorTo(1, 1)
      for (let i = 0; i < rows; i++) {
        out += ANSI.ERASE_LINE + desired[i]
        if (i < rows - 1) out += '\n'
      }
      body = out
    } else {
      // 行级 diff：只重写变化的行。alt screen 是固定网格（不滚动），
      // 绝对定位 cursorTo(row,1) 安全，未变行直接跳过 → 少擦写、少闪。
      let out = ''
      for (let i = 0; i < rows; i++) {
        if (desired[i] === this.lastFrame[i]) continue
        out += cursorTo(i + 1, 1) + ANSI.ERASE_LINE + desired[i]
      }
      body = out
    }

    this.lastFrame = desired
    this.lastCols = cols
    this.lastRows = rows
    this.menuRows = new Map([...lines.menuRows ?? []].filter(([row]) => row >= 1 && row <= rows))

    // 闪烁帧只改光标可见性、行内容不变——caret 处理必须在"空 diff 短路"
    // 之外执行，否则硬件光标不翻转。
    const caretPos = renderer.caret ? renderer.caret(cols, rows) : undefined
    if (body.length === 0 && caretPos === undefined) return
    // 整帧用 CSI 2026 同步输出包裹，原子刷新——overlay 导航（翻页/回溯）时
    // 逐行擦写不再撕裂/闪烁。
    if (body.length > 0) this.stdout.write(ANSI.BEGIN_SYNC + body + ANSI.END_SYNC)
    if (caretPos !== undefined) {
      // 稳态竖条（DECSCUSR 6）：关掉终端原生闪烁，节奏完全由应用 DECTCEM 控制；
      // 每帧重写幂等无副作用。
      this.stdout.write(caretPos ? cursorTo(caretPos.row, caretPos.col) + ANSI.CURSOR_STEADY_BAR + ANSI.SHOW_CURSOR : ANSI.HIDE_CURSOR)
    }
  }
}
