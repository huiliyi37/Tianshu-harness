import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolveMaxTurns, UNLIMITED_TURNS } from '../turn-budget-policy.js'

// 轮次上限策略单点（2026-09-22 收口）。此前这段三元式被抄在 6 处，长出两类静默
// 偏差：①写死 200 覆盖用户配的 agent.maxTurns；②构建期只做「skip → 0」单向联动，
// 会话 override 降回监督/自动时上限收不回来（监督会话静默持有无限轮次）。

describe('resolveMaxTurns', () => {
  it('免审批档 → 无限轮次（0 = 无硬上限）', () => {
    assert.equal(resolveMaxTurns('dangerously-skip-permissions', 200), UNLIMITED_TURNS)
    // 配了 500 也一样——skip 档就是无上限，不受配置值影响。
    assert.equal(resolveMaxTurns('dangerously-skip-permissions', 500), 0)
  })

  it('其它档 → 用户配置值（不再写死 200）', () => {
    assert.equal(resolveMaxTurns('manual', 500), 500)
    assert.equal(resolveMaxTurns('auto-safe', 500), 500)
    assert.equal(resolveMaxTurns('auto-safe', 200), 200)
  })

  it('auto-accept 不是 skip：仍有硬门禁，预算照常生效', () => {
    assert.equal(resolveMaxTurns('auto-accept', 300), 300)
  })

  it('档位缺失（未配置）→ 配置值原样', () => {
    assert.equal(resolveMaxTurns(undefined, 200), 200)
  })

  it('降档能收回上限：构建期全局 skip → 会话 override 自动档', () => {
    // 复现"只升不降"缺陷的判定式：全局档算出 0 之后，会话档必须能把它收回配置值。
    const builtFromGlobalSkip = resolveMaxTurns('dangerously-skip-permissions', 200)
    assert.equal(builtFromGlobalSkip, 0)
    assert.equal(resolveMaxTurns('auto-safe', 200), 200, '监督/自动档不得沿用 0')
  })
})

// 单点化的**回归闸**（2026-09-22 复查）：首轮收口漏了三处用户可触达的改档入口
// （/permission supervise、/permission auto、main.ts 权限面板 / /config 面板），
// 各自把预算写死成 200 或干脆不碰——"单点收口"就成了纸面承诺。这里直接扫源码，
// 让新增改档入口漏接线时红灯可指认。

describe('maxTurns 单点化闸门', () => {
  const repoRoot = new URL('../../../', import.meta.url)
  const read = (rel: string) => readFileSync(new URL(rel, repoRoot), 'utf8')

  it('全仓不得再出现写死 200 的档位联动（legacy 三元式）', () => {
    const files = [
      'src/main.ts', 'src/bootstrap.ts', 'src/server/serve-agent.ts',
      'src/tui/slash-commands.ts', 'src/tui/yolo-toggle.ts',
    ]
    for (const f of files) {
      const src = read(f)
      assert.ok(!/\?\s*0\s*:\s*200/.test(src), `${f}: 仍有 '? 0 : 200' 写死联动——应走 resolveMaxTurns`)
      assert.ok(!/maxTurns\s*=\s*200\b/.test(src), `${f}: 仍有 maxTurns = 200 写死`)
    }
  })

  it('每个改档入口文件都接入 resolveMaxTurns', () => {
    for (const f of [
      'src/main.ts', 'src/bootstrap.ts', 'src/server/serve-agent.ts',
      'src/tui/slash-commands.ts', 'src/tui/yolo-toggle.ts',
    ]) {
      assert.ok(read(f).includes('resolveMaxTurns'),
        `${f}: 有改档入口却未接单点策略——降档收不回上限 / 抹掉用户配置`)
    }
  })

  it('TUI 三档快切与 /permission mode 降档都联动（逐处锚点）', () => {
    const src = read('src/tui/slash-commands.ts')
    for (const anchor of [
      "resolveMaxTurns(tierToMode('supervise')",
      "resolveMaxTurns(tierToMode('auto')",
      "resolveMaxTurns(tierToMode('unattended')",
      "resolveMaxTurns(mode, ctx.config.agent.maxTurns)",
      "resolveMaxTurns(mode, loadConfig().agent.maxTurns)", // /config 面板 onApprovalChange
    ]) {
      assert.ok(src.includes(anchor), `slash-commands 缺锚点: ${anchor}`)
    }
  })
})
