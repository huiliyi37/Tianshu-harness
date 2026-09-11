/**
 * T9 LiveEngine — 管理终端底部动态区域（live region）的增量重绘。
 *
 * 核心机制：
 * - 在渲染 live region 之前，用 `cursor save` 保存滚动位置。
 * - 渲染时：上移到 live region 起始行 → 逐行擦除 + 重写 → 恢复光标。
 * - live region 永远只占底部 N 行（通常 5-20 行），远小于终端高度。
 * - streaming 内容由 BlockStreamWriter 控制，超出的部分已经 commit 到 scrollback。
 *
 * **Display-row awareness**: 所有行数追踪使用 visual display rows（wrapping-aware），
 * 而非 logical line count。一个 200 字符的行在 80 列终端占 3 display rows。
 * cursorUp / erase / lastDisplayRows 全部基于 display rows，防止 wrap 行导致
 * cursor 定位偏差 → ghost 行 / 重复渲染。
 *
 * 与 Ink 的区别：
 * - Ink 在 live region >= terminal rows 时执行 `\x1B[2J` 全屏清屏，
 *   LiveEngine 永远不会触发全屏清屏——live region 被严格限制在底部。
 */

import type { WriteStream } from 'node:tty'
import { ANSI, cursorUp, cursorDown, cursorToCol } from './ansi.js'
import { displayWidth, ambiguousWideEnabled } from '../width.js'

export interface LiveRegionLine {
  /** 该行的 ANSI 格式化文本（包含颜色码） */
  text: string
  /** 可选：截断指示符 */
  truncated?: boolean
  /**
   * 可选：输入框软件光标（█）左侧的 0-based cell 列（2026-07-23 IME 锚定）。
   * 终端 IME 候选窗锚定【硬件光标】而非自绘 █——帧末把硬件光标搬到该行该列，
   * 组词串才会出现在输入框内（kimi-code pi-tui 同款机制，结构字段替代其零宽
   * APC marker：不污染文本、不干扰 displayWidth 行数计量）。normalize/rowBudget
   * 均 {...l} 透传该字段。
   */
  caretCol?: number
}

export interface LiveEngineOptions {
  stdout: WriteStream
  /** 预留行数（输入行等需要始终可见的行） */
  reservedRows?: number
  /** 最大 live region 行数（安全上限，防止意外超屏） */
  maxRows?: number
  /**
   * CPR 探针请求回调（通常写 `\x1B[6n` 到 stdout）。响应经 stdin 回到
   * InputHandler，再喂给 {@link LiveEngine.noteCpr}。提供后启用外来写入检测。
   */
  onProbeRequest?: () => void
  /** 检测到 live region 被外来写入污染（光标偏离驻停点）时回调——调用方应重渲染。 */
  onPolluted?: () => void
}

/**
 * 活动期定高视口：把 `[0, chromeStart)` 的动态段（spinner / thinking / streaming
 * tail / 工具卡片）垫高或截断到**恰好** `budget` display rows。
 *
 * 动机：live region 是 normal flow——thinking/tail 每增减一行，整个区域高度变化，
 * 底部 chrome（输入框）的屏幕 Y 坐标随之跳动（「输入框随思考字符浮动」）。
 * 活动期把动态段高度锁死为预算值后，live region 总高度逐帧恒定 → 输入框不动。
 *
 * 规则：
 * - `budget <= 0`：原样返回（空闲期自然塌回，不垫行）。
 * - 动态段 > budget：从**顶部**截掉最旧行（approval prompt 等关键内容位于动态段
 *   尾部，天然优先保留）。
 * - 动态段 < budget：在动态内容与 chrome 之间垫空行——内容贴上、输入框贴下，
 *   间隙随内容增长自然收窄。
 * - 截断可能因多 display-row 行整行丢弃而低于预算，随后垫空行补齐——
 *   **返回的动态段恒等于 budget display rows**。
 *
 * @param rowsForLine 单行 display rows 度量（wrapping-aware）；默认每行 1 row。
 */
export function padDynamicRegion(
  lines: readonly LiveRegionLine[],
  chromeStart: number,
  budget: number,
  rowsForLine: (text: string) => number = () => 1,
): { lines: LiveRegionLine[]; chromeStart: number } {
  if (budget <= 0) return { lines: lines.slice(), chromeStart }
  const dynamic = lines.slice(0, chromeStart)
  const chrome = lines.slice(chromeStart)

  let rows = 0
  for (const line of dynamic) rows += rowsForLine(line.text)

  let dropUntil = 0
  while (rows > budget && dropUntil < dynamic.length) {
    rows -= rowsForLine(dynamic[dropUntil]!.text)
    dropUntil++
  }
  const kept = dynamic.slice(dropUntil)

  const padCount = Math.max(0, budget - rows)
  const padding: LiveRegionLine[] = Array.from({ length: padCount }, () => ({ text: '' }))

  return {
    lines: [...kept, ...padding, ...chrome],
    chromeStart: kept.length + padCount,
  }
}

export class LiveEngine {
  private stdout: WriteStream
  private reservedRows: number
  private maxRows: number

  /** 上一帧渲染的 display rows（wrapping-aware）。用于计算上移量。 */
  private lastDisplayRows = 0
  /** lineCache 渲染时的终端宽度。resize 检测：宽度变了说明屏上内容已被 reflow。 */
  private lastColumns = 0
  /** 是否已执行过首次渲染（用于判断是否需要 save cursor） */
  private hasRendered = false
  /** live region 行缓存：每行的原始文本（不含 ANSI）用于 diff */
  private lineCache: string[] = []

  /**
   * ambiguous 宽度模式缓存。`ambiguousWideEnabled()` 每次读 `process.env` 并做
   * 字符串比较，而一帧渲染里 rowsForLine 被调数十次（countDisplayRows / canDiff /
   * buildDiff / reconcileWidth），重复读 env 是无谓开销。该值在一次进程中基本不变，
   * 惰性读取一次后缓存即可。
   */
  private ambiguousWideCache: boolean | null = null

  // ── CPR 自愈状态 ──────────────────────────────────────────────
  // 渲染后光标应驻停在 live region 末行末尾。任何外来写入（其他进程写共享
  // TTY、stderr 直写）会移动光标并撑高屏上区域，使 lastDisplayRows 失同步——
  // 之后 cursorUp 回顶量不足，旧帧顶部残留进 scrollback（叠屏/重复帧）。
  // 机制：渲染后（节流）发 CPR 探针记录驻停基线；后续探针响应偏离基线即判污染，
  // 经 onPolluted 通知调用方重渲染，render 开头走恢复路径重锚。
  private onProbeRequest?: () => void
  private onPolluted?: () => void
  /** 最近一次确认的驻停位置（CPR 响应，1-based）。null = 未建立基线。 */
  private cprBaseline: { row: number; col: number } | null = null
  /** 已发出探针但未收到响应（带超时自愈，防终端不应答导致探针停摆）。 */
  private cprProbePending = false
  private lastCprProbeMs = 0
  /** 污染标记：下一帧 render 跳过 H2 短路/diff，走恢复重铺。 */
  private polluted = false
  /** 最近一次探针响应的光标行（恢复路径的爬升上限——绝不爬出视口顶）。 */
  private cprReportRow = 1

  // ── 硬件光标驻停（2026-07-23 IME 锚定；2026-07-24 默认重开）─────────
  // 帧末把（默认隐藏的）硬件光标搬到输入框软件光标 █ 的坐标——终端 IME 候选窗
  // 锚定硬件光标，自绘 █ 它不可见。kimi-code pi-tui 同款机制（tui.ts
  // positionHardwareCursor），适配本引擎 cursor-resident 协议：
  // - parkedRowsUp：驻停点距区域末行的 display rows（无 caret 帧 = 0）。帧首
  //   爬升量必须减去它（光标不在末行尾而在 caret 行）。
  // - parkedCol：驻停放列（0-based cell）；null = 驻停末行尾（历史协议）。
  // - 默认驻停但保持隐藏（单指针视觉）；RIVET_TUI_HARDWARE_CURSOR=1 仅控制
  //   可见性（个别终端光标可见才跟踪 IME）。
  // - CPR 防误判：响应按 probeParked（发针时 rowsUp）折算区域末行；若响应
  //   到达时 rowsUp 已漂移（slash 面板开合等合法几何变化）→ 丢弃本次判定
  //   （2026-07-24 重复行根修——dc572683 曾整体关闭 parking 兜底，此为正修）。
  private parkedRowsUp = 0
  private parkedCol: number | null = null
  /** 发 CPR 探针那一刻的驻停记账——响应按它折算区域末行，防 caret 移动误判污染。 */
  private probeParked: { rowsUp: number; col: number | null } | null = null
  private readonly hardwareCursorVisible = process.env.RIVET_TUI_HARDWARE_CURSOR === '1'

  /** 探针最小间隔：渲染每帧都可能触发，防探针风暴。 */
  private static readonly CPR_PROBE_MIN_INTERVAL_MS = 1000
  /** 探针响应超时：超过即允许重发（兼容不应答 DSR 的环境）。 */
  private static readonly CPR_PROBE_TIMEOUT_MS = 5000

  /** ambiguous 宽度模式（缓存 process.env 读取）。 */
  private ambiguousWide(): boolean {
    if (this.ambiguousWideCache === null) {
      this.ambiguousWideCache = ambiguousWideEnabled()
    }
    return this.ambiguousWideCache
  }

  constructor(options: LiveEngineOptions) {
    this.stdout = options.stdout
    this.reservedRows = options.reservedRows ?? 2
    this.maxRows = options.maxRows ?? 20
    this.onProbeRequest = options.onProbeRequest
    this.onPolluted = options.onPolluted
  }

  // ── CPR 自愈 ──────────────────────────────────────────────────

  /**
   * 暂停 CPR 污染检测。overlay（picker/pager 等）激活期间光标在 alt screen，
   * CPR 响应的位置不代表主屏 live region，若照常比对会误判污染并触发 renderLive
   * 把主屏帧写进 alt screen（picker 残影泄漏回主会话的根因）。
   * 调用方应在 overlay 激活时 suppress，退出时 resume（并作废基线等下一帧重建）。
   */
  private probeSuppressed = false

  /** overlay 激活：暂停探针发送与污染判定。 */
  suppressProbe(): void {
    this.probeSuppressed = true
    this.cprProbePending = false
    this.cprBaseline = null
  }

  /** overlay 退出：恢复检测；基线作废，下一帧/探针重新建立，避免跨 alt screen 误判。 */
  resumeProbe(): void {
    this.probeSuppressed = false
    this.cprBaseline = null
  }

  /**
   * 请求发一次 CPR 探针（受节流与 pending 去重；无 onProbeRequest 时 no-op）。
   * 调用点：render 结束（帧后驻停基线）+ 空闲期定时器（检出 idle 污染）。
   * overlay 激活期间不发（见 suppressProbe）。
   */
  requestProbe(): void {
    if (this.probeSuppressed) return
    if (!this.onProbeRequest) return
    const now = Date.now()
    if (this.cprProbePending && now - this.lastCprProbeMs < LiveEngine.CPR_PROBE_TIMEOUT_MS) return
    if (!this.cprProbePending && now - this.lastCprProbeMs < LiveEngine.CPR_PROBE_MIN_INTERVAL_MS) return
    this.cprProbePending = true
    this.lastCprProbeMs = now
    // 记录发探针瞬间的驻停位置——noteCpr 按它把响应折算回区域末行再判污染。
    this.probeParked = { rowsUp: this.parkedRowsUp, col: this.parkedCol }
    this.onProbeRequest()
  }

  /**
   * 喂入一条 CPR 响应（row/col 1-based，来自 InputHandler 的 onCpr）。
   * 首个响应建立驻停基线；后续响应与基线比对——偏离说明光标被外来写入移动，
   * 标记污染并回调 onPolluted（由调用方触发重渲染走恢复路径）。
   */
  noteCpr(row: number, col: number): void {
    this.cprProbePending = false
    // overlay 激活期间（alt screen）：光标位置不代表主屏 live region，
    // 不判污染也不更新基线，避免退出后用跨 alt screen 的基线误判。
    if (this.probeSuppressed) return
    this.cprReportRow = row
    const probe = this.probeParked
    // rowsUp 漂移丢弃（2026-07-24 重复行根修）：发针后几何合法变化（slash
    // 面板开合/输入框增行）使 caret 之下行数改变，响应无法可靠折算区域末行
    // ——既不判污染也不动基线（误判断曾触发恢复性全量重铺 = 输入框重复行）。
    // rowsUp 稳定时按 FIFO 语义用发针时记账折算，判定与基线照常。
    if (probe && probe.rowsUp !== this.parkedRowsUp) return
    // caret 驻停期间响应的是 caret 坐标：折算回区域末行再与基线比对
    //（发探针时的 parkedRowsUp 记账）；列比对只在驻停末行尾时进行——
    // caret 驻停下列随打字合法变化，比列会误报。
    const regionEndRow = row + (probe?.rowsUp ?? 0)
    const compareCol = probe?.col == null
    // 区域未在屏上（clear/commit 途中）时只更新基线，不判污染。
    if (!this.hasRendered || this.lastDisplayRows === 0) {
      this.cprBaseline = { row: regionEndRow, col }
      return
    }
    if (!this.cprBaseline) {
      this.cprBaseline = { row: regionEndRow, col }
      return
    }
    if (this.cprBaseline.row !== regionEndRow || (compareCol && this.cprBaseline.col !== col)) {
      this.polluted = true
      // 立即采纳新位置为基线：迟到的响应（渲染/commit 交错）不会造成持续误判。
      this.cprBaseline = { row: regionEndRow, col }
      this.onPolluted?.()
      return
    }
    this.cprBaseline = { row: regionEndRow, col }
  }

  /**
   * 更新 live region 行上限（终端 resize 时调用）。
   * maxRows 若大于终端高度，全量重写的 cursorUp 回顶量会超出屏幕导致错位，
   * 因此调用方应传入高度感知的值（如 `min(28, rows - 1)`）。
   */
  setMaxRows(n: number): void {
    this.maxRows = Math.max(1, Math.floor(n))
  }

  // ── Display-row helpers ───────────────────────────────────────

  /** 单个 logical line 占用的 display rows（wrapping-aware）。 */
  private rowsForLine(text: string): number {
    const width = this.stdout.columns || 80
    if (width <= 0) return 1
    // 行数估算必须与终端实际换行一致：CJK 终端把 ambiguous 符号按 2 列渲染，
    // 用 ambiguousAsWide 度量（env 门控，默认 narrow=string-width）避免低估行数。
    const dw = displayWidth(text, { ambiguousAsWide: this.ambiguousWide() })
    if (dw === 0) return 1
    return Math.ceil(dw / width)
  }

  /** 一组 LiveRegionLine 占用的总 display rows。 */
  private countDisplayRows(lines: readonly LiveRegionLine[]): number {
    let total = 0
    for (const line of lines) {
      total += this.rowsForLine(line.text)
    }
    return total
  }

  /**
   * 输入行归一化（2026-07-21 输入框重影修复）。
   *
   * LiveRegionLine 的契约是「单逻辑行」，但上游内容偶发携带嵌入换行——已证实的
   * 泄漏链：worker 多行 summary（review 门 evidence 用 `\n` 拼接）→
   * `progressLine: summary.slice(0, 80)` → FleetRegistry.activity → 舰队面板活动行。
   * 带 `\n` 的行在屏上占多个显示行，而 rowsForLine 基于 displayWidth
   * （string-width 剥控制符，`\n` 计 0 宽）按 1 行计 → lastDisplayRows 低于屏上
   * 实际行数 → 下一帧 cursorUp 回顶不足 → 旧帧顶部（输入框头行+边框）残留进
   * scrollback，正是「输入框重影叠屏」的形态。
   *
   * 处理：`\n` 展开为独立行；`\r`/`\t` 替换为空格（同样是 string-width 计 0 宽
   * 但终端会移动光标/跳列的字符）。内容侧净化（progressSnippet）是第一道防线，
   * 这里是引擎层兜底——任何未来新增的内容路径都不能再破坏行数追踪。
   */
  private normalizeLines(lines: readonly LiveRegionLine[]): readonly LiveRegionLine[] {
    let dirty = false
    for (const l of lines) {
      if (l.text.includes('\n') || l.text.includes('\r') || l.text.includes('\t')) {
        dirty = true
        break
      }
    }
    if (!dirty) return lines
    const out: LiveRegionLine[] = []
    for (const l of lines) {
      const cleaned = l.text.replace(/[\r\t]/g, ' ')
      if (!cleaned.includes('\n')) {
        out.push(cleaned === l.text ? l : { ...l, text: cleaned })
        continue
      }
      for (const seg of cleaned.split('\n')) {
        out.push({ ...l, text: seg })
      }
    }
    return out
  }

  // ── Render ────────────────────────────────────────────────────

  /**
   * resize 协调：终端宽度变化时，已绘制的 live region 内容会被终端按新宽 reflow，
   * 其占用的 display rows 随之改变。但 `lastDisplayRows` 是上一帧在**旧宽度**下数的，
   * 若直接用于 `moveToTop`，cursorUp 量与屏上实际行数不符 → 回顶欠/过 → 旧帧顶部
   * 残留进 scrollback（多份不同宽度的 chrome/面板叠屏，见 resize 回归测试）。
   *
   * 修复：检测到宽度变化时，按**当前宽度**从 `lineCache` 重算 `lastDisplayRows`，
   * 使其与终端 reflow 后的屏上行数一致，再做相对回顶。
   */
  private reconcileWidth(): void {
    const currentColumns = this.stdout.columns || 80
    if (this.hasRendered && this.lastDisplayRows > 0 && currentColumns !== this.lastColumns) {
      this.lastDisplayRows = this.countDisplayRows(this.lineCache.map(text => ({ text })))
    }
    this.lastColumns = currentColumns
  }

  /**
   * 渲染 live region（cursor-resident 协议，对标 aider mdstream / ink createIncremental）。
   *
   * 核心不变量：
   * - 渲染后光标**常驻 live region 最后一行末尾**（尾行不写 `\n`）。
   *   这避免了在终端底部因尾行换行触发滚屏 → 杜绝"贴底每帧滚动"的卡顿。
   * - 增量重绘用**相对光标移动**（cursorUp/cursorDown）回到区域顶，不使用
   *   SAVE/RESTORE 绝对光标——内容滚动后绝对坐标会失效错位。
   * - **行级 diff**：结构未变（行数 + 单显示行）时只重写变化的行，跳过未变行（少闪）。
   * - 整帧用 CSI 2026 同步输出包裹，原子刷新防撕裂。
   *
   * @param lines 要显示的行（含 ANSI 格式化）
   */
  render(lines: readonly LiveRegionLine[], opts?: { reservedTail?: number }): void {
    const bounded = this.applyRowBudget(this.normalizeLines(lines), opts?.reservedTail)
    const parking = this.computeParking(bounded)

    // 恢复重铺：CPR 检出外来写入污染后，不再信任 lastDisplayRows 的屏上假设
    // （H2 短路会被 lineCache 与屏上不符的内容欺骗，diff 会加剧错位）。
    // 爬升量以「追踪行数」与「最近 CPR 报告行」双封顶——绝不爬出视口顶。
    // 外来行撑高区域的行数不可知，顶部残留 ≤δ 行无法避免（相对寻址的固有限制），
    // 但外来文本被擦除、帧重新锚定，后续帧恢复一致。
    if (this.polluted) {
      this.polluted = false
      // resize 与污染判定常并发（reflow 移动光标即触发）：爬升前先按当前宽度从
      // lineCache 重算屏上行数。否则 lastDisplayRows 仍是旧宽度计数，变窄 reflow
      // 把区域撑高后爬升不足，旧帧顶部残留进 scrollback（resize 输入框叠屏）。
      this.reconcileWidth()
      const newDisplayRows = this.countDisplayRows(bounded)
      let body: string
      if (this.hasRendered && this.lastDisplayRows > 0) {
        const climb = Math.min(Math.max(0, this.lastDisplayRows - 1 - this.parkedRowsUp), Math.max(0, this.cprReportRow - 1))
        body = (climb > 0 ? cursorUp(climb) : '') + '\r' + ANSI.ERASE_SCREEN_END + this.buildAppend(bounded)
      } else {
        body = this.buildAppend(bounded)
      }
      this.stdout.write(ANSI.BEGIN_SYNC + ANSI.HIDE_CURSOR + body + this.buildParkSeq(parking) + ANSI.END_SYNC)
      this.lastDisplayRows = newDisplayRows
      this.lineCache = bounded.map(l => l.text)
      this.hasRendered = true
      this.lastColumns = this.stdout.columns || 80
      this.cprBaseline = null // 重锚完成，帧后探针重建基线
      this.setParked(parking)
      this.requestProbe()
      return
    }

    // H2 无变化短路：屏上 live region 内容与本帧逐行完全一致且终端宽度未变 →
    // 无需任何重绘（省去 diff 计算与 stdout 写入）。idle / ticker 空转的主要省功点。
    // 用 lineCache（屏上真实内容的权威记录）比对，天然兼容 clear/reset/overlay 退出：
    // 那些路径会令 lastDisplayRows===0 或 hasRendered===false，不会被误短路。
    const currentColumns = this.stdout.columns || 80
    if (
      this.hasRendered &&
      this.lastDisplayRows > 0 &&
      currentColumns === this.lastColumns &&
      bounded.length === this.lineCache.length &&
      bounded.every((l, i) => l.text === this.lineCache[i])
    ) {
      // 行未变但 caret 移动（纯光标键）：不重绘文字，只把硬件光标搬到新坐标
      // （kimi-code pi-tui 同款——无变化帧也归位光标，几字节零闪烁）。
      // caret 消失（parking=null）的转移走常规路径收敛，不在此处理。
      if (parking) this.reparkIfChanged(parking)
      return
    }

    // resize 检测必须在 reconcileWidth 覆盖 lastColumns 之前取值。
    const widthChanged = this.hasRendered && this.lastDisplayRows > 0 && currentColumns !== this.lastColumns

    this.reconcileWidth()
    const newDisplayRows = this.countDisplayRows(bounded)

    // 首次渲染 或 clear/clearForCommit 之后（lastDisplayRows === 0）：
    // 直接在当前位置 append 输出。尾行不带 `\n`，光标停在最后一行末尾。
    if (!this.hasRendered || this.lastDisplayRows === 0) {
      // 首帧 / clear/overlay 退出后的全量重铺同样用 CSI 2026 包裹，原子刷新
      // 防撕裂（与增量帧一致）。尾行不带 `\n`，光标仍常驻最后一行末尾。
      // 同步隐藏硬件光标，避免 overlay 退出后主屏出现额外闪烁指针。
      this.stdout.write(ANSI.BEGIN_SYNC + ANSI.HIDE_CURSOR + this.buildAppend(bounded) + this.buildParkSeq(parking) + ANSI.END_SYNC)
      this.lastDisplayRows = newDisplayRows
      this.lineCache = bounded.map(l => l.text)
      this.hasRendered = true
      this.setParked(parking)
      this.requestProbe()
      return
    }

    const prevDisplayRows = this.lastDisplayRows

    // 行级 diff 资格：行数相同，且**每行**的显示行数（wrap 高度）新旧一致。
    // 关键不变量：逐行 wrap 高度不变 → 改某行不会让后续行整体上/下移（无级联），
    // 相对光标步进（cursorDown 按显示行数）才能精确对齐。任一行 wrap 高度变化 →
    // 会级联错位，回退全量重写（更稳）。允许多行 wrap 行参与增量。
    //
    // 宽度刚变过（resize）时禁用 diff：屏上旧帧被终端按新宽 reflow，实际布局
    // 与 lineCache 的估算可能不一致（部分终端不 reflow / ambiguous 宽度偏差），
    // 相对步进的增量改写会在错位的行上打补丁 → 旧帧碎片残留叠屏。
    // 全量重写（回顶 + ERASE_SCREEN_END + 重铺）把不确定性收敛到锚点一处。
    const canDiff =
      !widthChanged &&
      bounded.length === this.lineCache.length &&
      bounded.every((l, i) => this.rowsForLine(l.text) === this.rowsForLine(this.lineCache[i]!))

    // 帧首爬升以驻停点为起点：硬件光标模式 caret 驻停时光标不在末行尾
    // （差 parkedRowsUp 行）；软件光标模式下光标始终在末行尾，parkedRowsUp=0。
    const climbRows = prevDisplayRows - this.parkedRowsUp
    const body = canDiff
      ? this.buildDiff(bounded, climbRows)
      : this.buildFullRewrite(bounded, climbRows)

    // 帧首隐藏硬件光标（覆盖 overlay 退出后 SHOW_CURSOR 的间隙、帧内防闪）；
    // 帧末 buildParkSeq 把它搬到输入框软件光标坐标（IME 候选窗锚定硬件光标）。
    this.stdout.write(ANSI.BEGIN_SYNC + ANSI.HIDE_CURSOR + body + this.buildParkSeq(parking) + ANSI.END_SYNC)
    this.lastDisplayRows = newDisplayRows
    this.lineCache = bounded.map(l => l.text)
    this.setParked(parking)
    this.requestProbe()
  }

  /** 从 bounded 行里找 caret 标记行，算驻停点（距末行 display rows + 0-based 列）。 */
  private computeParking(bounded: readonly LiveRegionLine[]): { rowsUp: number; col: number } | null {
    const idx = bounded.findIndex(l => l.caretCol != null)
    if (idx < 0) return null
    let rowsUp = 0
    for (let i = idx + 1; i < bounded.length; i++) rowsUp += this.rowsForLine(bounded[i]!.text)
    return { rowsUp, col: bounded[idx]!.caretCol! }
  }

  /** 帧末驻停序列：末行尾 → caret 坐标（默认驻停但保持隐藏；env 仅控制可见性）。 */
  private buildParkSeq(parking: { rowsUp: number; col: number } | null): string {
    let seq = ''
    if (parking) {
      if (parking.rowsUp > 0) seq += cursorUp(parking.rowsUp)
      seq += cursorToCol(parking.col + 1)
    }
    // 默认隐藏（定位不可见，单指针视觉）；RIVET_TUI_HARDWARE_CURSOR=1 时可见化——
    // 个别终端光标可见才跟踪 IME。无 caret 帧显式 HIDE（防 stray 指针）。
    if (this.hardwareCursorVisible) seq += parking ? ANSI.SHOW_CURSOR : ANSI.HIDE_CURSOR
    return seq
  }

  /** 更新驻停记账（须在 requestProbe 前调用——探针按它折算响应坐标）。 */
  private setParked(parking: { rowsUp: number; col: number } | null): void {
    this.parkedRowsUp = parking?.rowsUp ?? 0
    this.parkedCol = parking?.col ?? null
  }

  /** H2 路径专用：行未变、caret 变了 → 只发重定位序列（不重绘任何文字）。 */
  private reparkIfChanged(parking: { rowsUp: number; col: number }): void {
    if (this.parkedRowsUp === parking.rowsUp && this.parkedCol === parking.col) return
    let seq = ''
    // rowsUp 是「距末行的行数」：新驻停点更高（rowsUp 变大）→ 上移，反之 → 下移。
    const delta = parking.rowsUp - this.parkedRowsUp
    if (delta > 0) seq += cursorUp(delta)
    else if (delta < 0) seq += cursorDown(-delta)
    seq += cursorToCol(parking.col + 1)
    this.stdout.write(ANSI.BEGIN_SYNC + ANSI.HIDE_CURSOR + seq + (this.hardwareCursorVisible ? ANSI.SHOW_CURSOR : '') + ANSI.END_SYNC)
    this.setParked(parking)
    this.requestProbe()
  }

  /**
   * 行预算：内容超过 maxRows 时，**优先保留尾部 chrome**（GlanceBar + 输入框 + 提示），
   * 截断的是中段 dynamic（streaming tail / 工具输出）的较早部分。
   *
   * **预算按 display rows 计量**（非行数）：窄窗口下长正文/长输入折行后，
   * 行数 ≤ maxRows 也可能整帧超出终端高度——全量重写越过屏幕底部触发滚动，
   * 回顶量与屏上实际布局错位，旧帧正文残留并叠印在 chrome 之下
   * （小窗口打字时正文"泄露"到输入框底下的根因）。不变量：整帧恒 ≤ maxRows
   * display rows（= min(28, rows-1)），重写永不越底。
   *
   * - 全帧 display rows ≤ maxRows：全部保留。
   * - 未指定 reservedTail：按预算保留前若干行。
   * - 指定 reservedTail：尾部 N 行恒保留；剩余预算从 dynamic 段尾部回填。
   *   若 chrome 本身已超 maxRows，仍全部显示——宁可超行，也不能让输入框消失。
   */
  private applyRowBudget(lines: readonly LiveRegionLine[], reservedTail?: number): LiveRegionLine[] {
    if (this.countDisplayRows(lines) <= this.maxRows) return lines.slice()
    if (reservedTail === undefined || reservedTail <= 0) {
      const kept: LiveRegionLine[] = []
      let rows = 0
      for (const line of lines) {
        const r = this.rowsForLine(line.text)
        if (rows + r > this.maxRows) break
        kept.push(line)
        rows += r
      }
      return kept
    }
    const tail = Math.min(reservedTail, lines.length)
    const tailLines = lines.slice(lines.length - tail)
    const tailRows = this.countDisplayRows(tailLines)
    const budget = this.maxRows - tailRows
    if (budget <= 0) return tailLines.slice()
    const dynamic = lines.slice(0, lines.length - tail)
    const kept: LiveRegionLine[] = []
    let rows = 0
    for (let i = dynamic.length - 1; i >= 0; i--) {
      const r = this.rowsForLine(dynamic[i]!.text)
      if (rows + r > budget) break
      kept.unshift(dynamic[i]!)
      rows += r
    }
    return [...kept, ...tailLines]
  }

  /** Append 路径：行间 `\n`，尾行不带 `\n`（光标常驻最后一行末尾）。 */
  private buildAppend(bounded: readonly LiveRegionLine[]): string {
    let out = ''
    for (let i = 0; i < bounded.length; i++) {
      out += bounded[i]!.text
      if (i < bounded.length - 1) out += '\n'
    }
    return out
  }

  /** 相对光标回到 live region 顶部显示行（光标当前在最后一个显示行）。 */
  private moveToTop(prevDisplayRows: number): string {
    return prevDisplayRows > 1 ? cursorUp(prevDisplayRows - 1) : ''
  }

  /**
   * 全量重写：回顶 → 擦到屏幕末（覆盖旧的所有显示行，含 wrap）→ 重写全部行。
   * 尾行不带 `\n`，光标停在最后一行末尾。
   */
  private buildFullRewrite(bounded: readonly LiveRegionLine[], prevDisplayRows: number): string {
    let out = this.moveToTop(prevDisplayRows)
    out += '\r' + ANSI.ERASE_SCREEN_END
    for (let i = 0; i < bounded.length; i++) {
      out += bounded[i]!.text
      if (i < bounded.length - 1) out += '\n'
    }
    return out
  }

  /**
   * 行级 diff（结构未变 + 每行 wrap 高度未变时调用，见 canDiff）：
   * 回顶后逐行处理——变化行清除其全部显示行后重写；未变行只按显示行数 cursorDown 跳过。
   * 不写任何 `\n`（cursorDown 在底行会被 clamp，不触发滚屏）。
   *
   * 光标步进不变量：每次迭代开始时光标位于「逻辑行 i 的首个显示行」，
   * 处理结束时（cursorDown 之前）位于「逻辑行 i 的最后一个显示行」，
   * 再 cursorDown(1) 进入下一逻辑行首行。变化行与未变行两条分支都满足该不变量。
   */
  private buildDiff(bounded: readonly LiveRegionLine[], prevDisplayRows: number): string {
    let out = this.moveToTop(prevDisplayRows)
    for (let i = 0; i < bounded.length; i++) {
      const text = bounded[i]!.text
      const rows = this.rowsForLine(text) // == rowsForLine(lineCache[i])，canDiff 已保证
      out += '\r'
      if (this.lineCache[i] !== text) {
        // 变化行：先擦除其占用的全部显示行（含 wrap 续行），再写入新内容。
        // 仅擦首行会让旧的 wrap 续行残留为 ghost。
        out += ANSI.ERASE_LINE
        for (let k = 1; k < rows; k++) {
          out += cursorDown(1) + '\r' + ANSI.ERASE_LINE
        }
        if (rows > 1) out += cursorUp(rows - 1) // 回到本行首行再写
        out += text // 自动 wrap 至 rows 个显示行，光标落在最后一个显示行末
      } else if (rows > 1) {
        // 未变的多行 wrap 行：不重写，仅下移到其最后一个显示行。
        out += cursorDown(rows - 1)
      }
      if (i < bounded.length - 1) out += cursorDown(1)
    }
    return out
  }

  /**
   * 清空 live region（擦除但不回滚 scrollback）。
   * 用于流式输出完成、切换到新 turn 时。
   *
   * 光标常驻协议下，光标在最后一个显示行——回顶后擦到屏幕末，光标停在
   * 区域起始处。后续 append/commit 从这里开始写，干净无空白带。
   */
  clear(): void {
    this.reconcileWidth()
    if (this.lastDisplayRows === 0) return
    this.stdout.write(ANSI.HIDE_CURSOR + this.moveToTop(this.lastDisplayRows - this.parkedRowsUp) + '\r' + ANSI.ERASE_SCREEN_END)
    this.lastDisplayRows = 0
    this.lineCache = []
    this.setParked(null)
    // 区域已离屏：污染标记随帧状态一起作废（noteCpr 此时只更新基线不判污染）。
    this.polluted = false
  }

  /**
   * 擦除 live region 并把光标停在其起始行——为向 scrollback commit 内容腾位。
   *
   * 正确的 mid-stream commit 协议：
   *   live.clearForCommit() → commit.write(...) → live.render(...)
   *
   * cursor-resident 协议下与 clear() 行为一致（光标都回到区域起始处）。
   */
  clearForCommit(): void {
    this.clear()
  }

  /**
   * 渲染单行动态文本（如 streaming 行、thinking 指示器）。
   * 简化版：擦除上一帧内容 → 写入新内容。
   */
  renderLine(text: string): void {
    this.render([{ text }])
  }

  /** 重置渲染状态（用于 rewind 等需要全量重绘的场景） */
  reset(): void {
    this.lastDisplayRows = 0
    this.lineCache = []
    this.hasRendered = false
    this.setParked(null)
  }
}

/**
 * 推理区显示行预算（display rows）——thinking 段在 live 区的高度上限。
 *
 * 矮终端（rows<=16）两档收缩（2026-09-11 用户反馈「回复被顶到上一屏」：
 * thinking 段 + 流式尾部吃满 live 高水位，跨轮不缩使历史只剩约 1 行可见）：
 * 流式期（phase=streaming，用户此刻在看回复）压到 1 行；其余时相下限 2。
 * rows>=18 时 floor(rows/6)>=3 不触发下限，大屏预算不变。
 */
export function thinkingRowBudgetFor(rows: number, phase: string, maxRows: number): number {
  const r = rows || 24
  if (r <= 16 && phase === 'streaming') return 1
  return Math.max(2, Math.min(maxRows, Math.floor(r / 6)))
}
