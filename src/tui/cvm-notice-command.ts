/**
 * `/cvm` — CVM 拦截提示的级别开关（issue #247 第 2 条「可配置开关（UI 与 config 均可）」）。
 *
 * config 侧是 `ui.cvmNotices`（启动默认值），这里是运行期切换——与 `/glance`
 * 切换 `ui.glanceDensity` 完全同构。
 *
 * 独立模块而不是写在 `slash-commands.ts` 里：后者是点名巨石（manifest 里只降不升），
 * `/new` 与 `/queue` 出于同一理由各自拆了出去。
 */

import type { TuiApp } from './engine/app.js'
import { CVM_LEVEL_LABELS, cvmNoticeLevelEnabled, type CvmNoticeGate } from '../agent/cvm-notice.js'

/** 档位顺序即 `/cvm` 无参时的循环顺序：由严到宽。 */
const CVM_GATES: readonly CvmNoticeGate[] = ['off', 'intercept', 'warn', 'all']

/** 无参循环的下一档。 */
export function nextCvmGate(current: CvmNoticeGate): CvmNoticeGate {
  return CVM_GATES[(CVM_GATES.indexOf(current) + 1) % CVM_GATES.length]!
}

/** 解析 `/cvm <arg>`；非法或缺省时返回 null（调用方据此走循环档）。 */
export function parseCvmGate(arg: string | undefined): CvmNoticeGate | null {
  const v = arg?.toLowerCase()
  return (CVM_GATES as readonly string[]).includes(v ?? '') ? (v as CvmNoticeGate) : null
}

/**
 * 档位 → 回执文案。
 *
 * 逐档列出**实际放行了哪几级**，而不是只回显档名——`warn` 这个名字看不出它同时
 * 包含更严重的 `intercept`，直接写出来省得用户猜（issue 的「分级」本身就不是
 * 直觉的，见其三档表）。
 */
export function describeCvmGate(gate: CvmNoticeGate): string {
  const shown = (['intercept', 'warn', 'info'] as const)
    .filter(level => cvmNoticeLevelEnabled(gate, level))
    .map(level => CVM_LEVEL_LABELS[level])
  return shown.length === 0
    ? `CVM 拦截提示 → off（全部关闭）`
    : `CVM 拦截提示 → ${gate}（显示：${shown.join(' / ')}）`
}

/**
 * 注册 `/cvm`。busy 时也可用——它只改本地渲染开关，不影响在途 run 的任何行为。
 */
export function registerCvmNoticeCommand(app: TuiApp): void {
  app.registerSlashCommand({
    name: '/cvm',
    description: 'CVM 拦截提示的级别开关（off/intercept/warn/all）',
    immediate: true,
    handler: ({ trimmed }) => {
      const next = parseCvmGate(trimmed.split(/\s+/)[1]) ?? nextCvmGate(app.cvmNoticeGate)
      app.cvmNoticeGate = next
      // 立即写出回执，而不是等下一次拦截——否则用户改了开关却看不到任何反馈。
      app.commitStatic(describeCvmGate(next))
      return true
    },
  })
}
