/**
 * CVM 拦截提示的同窗口聚合（issue #247 第 3 条）。
 *
 * issue 原话：「同类拦截聚合：同一会话内、默认 5–10 秒窗口内同类拦截合并为一条
 * （如「CVM 拦截 ×3：验证债务」）。窗口可配置，具体取值由实现定。**聚合是降噪，
 * 不是隐藏。**」
 *
 * 设计约束：
 *
 * - **首条立即出。** 让用户等窗口关闭才知道「拦了一次」，等于把降噪做成了隐藏。
 * - **内部没有定时器。** 时间由调用方以 `now` 注入，因此窗口推进在测试里是确定的
 *   （照 `src/api/openai-client.ts` 的 `decideStreamHardCap` 范式）。刷新节拍由宿主
 *   负责——TUI 侧是 `main.ts` 的一个 unref'd interval。
 * - **不为省行数而吞计数。** 窗口过期但尚未 `takeDue` 时若又来同类，先把旧窗口
 *   结账进 `due` 队列再开新窗，而不是覆盖——覆盖会让 `×N` 少算。
 *
 * 聚合键 = `level:kind`。跨级别不合并：「×3」必须真的是同一件事。
 */

import { formatCvmNoticeLine, type CvmInterceptionNotice, type CvmNoticeLevel } from '../agent/cvm-notice.js'

/** 一条准备渲染的行。`count > 1` 表示它是窗口的合并结果。 */
export interface CvmCoalescedLine {
  text: string
  level: CvmNoticeLevel
  count: number
}

/**
 * 默认聚合窗口。issue 给的是 5–10s 区间且明说「具体取值由实现定」，本 PR 取 8s。
 * ⚠️ 这是**工程判断，未经实测校准**——真实会话的 CVM 触发频率本机造不出来
 * （doc 的 84 次/4h 是别人会话的样本）。因此它可被 `ui.cvmNoticeWindowMs` 覆盖。
 */
export const CVM_NOTICE_WINDOW_MS_DEFAULT = 8000

interface Window {
  firstAt: number
  count: number
  /** 窗口第一条的 notice——合并行要用它重排版（保留 kind/ruleId/mode）。 */
  notice: CvmInterceptionNotice
}

export class CvmNoticeCoalescer {
  private readonly open = new Map<string, Window>()
  private readonly due: CvmCoalescedLine[] = []

  constructor(private readonly windowMs: number) {}

  /**
   * 投递一条通知。
   *
   * @returns 立即渲染的行；`null` = 已被窗口吸收（到期后由 `takeDue` 补合并行）。
   */
  push(notice: CvmInterceptionNotice, now: number): CvmCoalescedLine | null {
    const key = `${notice.level}:${notice.kind}`
    const w = this.open.get(key)
    if (w && now - w.firstAt < this.windowMs) {
      w.count += 1
      return null
    }
    // 窗口已过期但宿主还没来 takeDue：先结账（保留计数），再开新窗。
    if (w) this.close(key, w)
    this.open.set(key, { firstAt: now, count: 1, notice })
    return { text: notice.text, level: notice.level, count: 1 }
  }

  /** 取出所有已到期窗口的合并行。幂等：同一窗口只补发一次。 */
  takeDue(now: number): CvmCoalescedLine[] {
    // 先快照再迭代——close() 会改 open。
    for (const [key, w] of [...this.open]) {
      if (now - w.firstAt >= this.windowMs) this.close(key, w)
    }
    return this.due.splice(0)
  }

  /** 丢弃所有在途窗口（会话结束 / `ui.cvmNotices` 切换时调用）。 */
  clear(): void {
    this.open.clear()
    this.due.length = 0
  }

  /** 结账一个窗口：count > 1 才产生合并行（单条的首行已经渲染过，不重复）。 */
  private close(key: string, w: Window): void {
    this.open.delete(key)
    if (w.count <= 1) return
    this.due.push({
      level: w.notice.level,
      count: w.count,
      text: formatCvmNoticeLine({
        level: w.notice.level,
        kind: w.notice.kind,
        ruleId: w.notice.ruleId,
        mode: w.notice.mode,
        count: w.count,
      }),
    })
  }
}
