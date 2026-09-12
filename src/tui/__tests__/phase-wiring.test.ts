import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { phaseStatusLabel } from '../phase-status.js'

/**
 * 接线守卫。
 *
 * phaseStatusLabel 是纯函数测试——它证明不了「这个 phase 有没有被分派过」。
 * 2026-09-11 审查实证：'image-stripped' 有 case、有生产端（turn-orchestrator
 * 的 onPhaseChange），但 src/tui/engine/app.ts 的分派分支不含它，提示被静默
 * 丢弃，而 phase-status.test.ts 仍 16/16 全绿。
 *
 * 这里把「静态警告行」这条链的两端钉在一起：app.ts 必须分派，phaseStatusLabel
 * 必须给得出文案——任一端断裂都变红。
 */
const APP_SRC = readFileSync(join(process.cwd(), 'src/tui/engine/app.ts'), 'utf8')
const STATIC_WARNING_PHASES = ['stop-reason', 'convergence-warning', 'image-stripped'] as const

describe('onPhaseChange 静态警告行的接线', () => {
  for (const phase of STATIC_WARNING_PHASES) {
    it(`app.ts 分派 '${phase}'`, () => {
      assert.ok(
        APP_SRC.includes(`'${phase}'`),
        `phase '${phase}' 在 app.ts 的 onPhaseChange 里没有任何分支——它会被静默丢弃`,
      )
    })

    it(`'${phase}' 有可渲染的文案映射`, () => {
      assert.notEqual(
        phaseStatusLabel(phase, { reason: '测试原因' }),
        null,
        `${phase} 缺 phaseStatusLabel 映射（null 会让 commitStatic 变成空操作）`,
      )
    })
  }
})
