/**
 * Ctrl+C pending-exit 确认窗口的取消契约（对齐 Claude Code 的 Ctrl+C 语义）。
 *
 * 背景（fa2c971f0 起，按用户要求恢复清空语义）：空闲态按 Ctrl+C 分两路——
 * - 有输入 → 清空草稿，**不进**退出确认窗口（防误触退出）
 * - 空输入 → 进退出确认窗口，提示行显示在输入框上方；窗口内二次 Ctrl+C 退出，
 *   Esc / 任意编辑键 = 用户继续对话 → 取消确认
 * agent 活跃首按 → interrupt 并并行开窗（卡死逃生通道）。
 *
 * 「有输入清空」那条语义的对照用例在 input-controller-state.test.ts；本文件覆盖
 * 空闲态确认窗口的进出与取消契约。
 *
 * 跨平台：Ctrl+C(0x03) / Esc(0x1B lone) 在 Windows / macOS / Linux 终端的
 * raw mode 下字节送达一致（InputHandler 解析层无平台分支），契约对全平台等效。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp } from './_harness.js'
import { captureLiveFrame } from './_capture-frame.js'
import type { TuiApp } from '../app.js'

function makeStartedApp() {
  const t = makeApp()
  const frame = captureLiveFrame(t.app)
  let exited = false
  t.app.onExit(() => { exited = true })
  const pendingSince = () =>
    (t.app as unknown as { inputController: { ctrlCPendingSince: number } }).inputController.ctrlCPendingSince
  const inputText = () =>
    (t.app as unknown as { inputLine: { value: string } }).inputLine.value
  const lastEscAt = () =>
    (t.app as unknown as { inputController: { lastEscAt: number } }).inputController.lastEscAt
  const plain = () => frame.text()
  return { ...t, exitedRef: () => exited, pendingSince, inputText, lastEscAt, plain }
}
type StartedApp = ReturnType<typeof makeStartedApp>
const CTRL_C = '\x03'
const ESC = '\x1B'
const HINT = '再次按 Ctrl+C 退出'
const INPUT_BORDER = /[─━┄-]{3,}/
const tick = (ms: number) => new Promise(r => setTimeout(r, ms))

test('Esc 取消退出确认：输入框恢复、提示消失、不污染 rewind 计时', async () => {
  const t = makeStartedApp()
  t.stdin.dataHandler!(CTRL_C)
  assert.ok(t.pendingSince() > 0, '第一次 Ctrl+C 进入确认窗口')
  assert.ok(t.plain().includes(HINT), '提示行显示')

  // 按完整可见帧检查消失；行级 diff 可以保留未重写的输入框边框。
  t.out.clear()
  t.stdin.dataHandler!(ESC)
  await tick(120) // lone ESC 经 80ms 超时派发
  assert.equal(t.pendingSince(), 0, 'Esc 取消确认窗口')
  assert.ok(!t.plain().includes(HINT), '取消后的可见帧不再包含提示')
  assert.ok(INPUT_BORDER.test(t.plain()), '输入框始终可见')
  assert.equal(t.lastEscAt(), 0, '取消用的 Esc 不计入双击 rewind 计时')
})

test('编辑键取消确认：打字立即可见，不再幽灵输入', async () => {
  const t = makeStartedApp()
  t.stdin.dataHandler!(CTRL_C)
  assert.ok(t.pendingSince() > 0, '进入确认窗口')
  t.out.clear()
  t.stdin.dataHandler!('a')
  await tick(60) // writeBatcher 异步合帧
  assert.equal(t.pendingSince(), 0, '编辑活动取消确认窗口')
  assert.equal(t.inputText(), 'a', '字符进输入框')
  assert.ok(t.plain().includes('a'), '打的字立即可见（输入框渲染）')
  assert.ok(!t.plain().includes(HINT), '取消后的可见帧不再包含提示')
})

test('有内容首按 Ctrl+C：清空草稿、不进退出确认（fa2c971f0 恢复的清空语义）', async () => {
  const t = makeStartedApp()
  t.stdin.dataHandler!('hi')
  await tick(60)
  t.out.clear()
  t.stdin.dataHandler!(CTRL_C)
  assert.equal(t.exitedRef(), false, '首次 Ctrl+C 不退出')
  assert.equal(t.inputText(), '', '空闲 + 有输入：清空草稿')
  assert.equal(t.pendingSince(), 0, '有输入时不弹退出确认窗')
  assert.ok(!t.plain().includes(HINT), '不显示退出确认提示')
})

test('清空草稿后的下一次 Ctrl+C 才进入确认窗口（清空语义下的重入路径）', async () => {
  const t = makeStartedApp()
  t.stdin.dataHandler!(CTRL_C) // 空输入 → 进窗口
  t.stdin.dataHandler!('hi') // 编辑键取消确认，草稿变 'hi'
  await tick(60)
  assert.equal(t.pendingSince(), 0, '打字已取消确认窗口')
  assert.equal(t.inputText(), 'hi', '字符进输入框')

  t.stdin.dataHandler!(CTRL_C) // 有内容 → 清空草稿，不进窗口
  await tick(30)
  assert.equal(t.exitedRef(), false, '清空动作不退出')
  assert.equal(t.inputText(), '', '第二次 Ctrl+C 清空草稿')
  assert.equal(t.pendingSince(), 0, '有内容时不进确认窗口')

  t.stdin.dataHandler!(CTRL_C) // 空输入 → 进窗口
  await tick(30)
  assert.ok(t.pendingSince() > 0, '草稿清空后的下一次 Ctrl+C 进入确认窗口')
  assert.equal(t.exitedRef(), false, '首次进窗不退出')
})

test('确认窗口内二次 Ctrl+C 退出（无论窗口期输入框是否有内容）', async () => {
  const t = makeStartedApp()
  t.stdin.dataHandler!(CTRL_C)
  await tick(30)
  t.stdin.dataHandler!(CTRL_C)
  await tick(30)
  assert.equal(t.exitedRef(), true, '确认窗口内二次 Ctrl+C 退出')
})

test('Esc 取消后可重新进入确认窗口（循环可用）', async () => {
  const t = makeStartedApp()
  t.stdin.dataHandler!(CTRL_C)
  t.stdin.dataHandler!(ESC)
  await tick(120)
  t.stdin.dataHandler!(CTRL_C)
  assert.ok(t.pendingSince() > 0, '取消后再次 Ctrl+C 重新进入确认窗口')
  assert.ok(t.plain().includes(HINT), '提示行再次显示')
})

// ── 旧定时器残留竞态（app.ts 首按 setTimeout fire-and-forget 的静态反例）──
// 回归：取消后重入的确认窗口，不得被第一次进入时武装的 2s 旧定时器提前截断。
// 时间线（近似）：t=0 首按（旧定时器约 t=2000 到期）→ 编辑键取消（仅复位状态，
// 旧实现不清定时器）→ t≈950 重入（新窗口应到 t≈2950 才自动关）→ t≈2100 断言。
// 旧实现在 t≈2000 把 pending 清零 → 重入窗口只剩 ~50ms（被截断）；修复后旧定时器
// 在取消时即被清理，t≈2100 时重入窗口应仍开着（尚未到 t≈2950 自动到期点）。
test('取消后重入的确认窗口不被旧 2s 定时器截断（回归：旧定时器残留竞态）', async () => {
  const t = makeStartedApp()
  // t≈0：首按，武装 2s 自动取消定时器
  t.stdin.dataHandler!(CTRL_C)
  assert.ok(t.pendingSince() > 0, '首按进入确认窗口')
  // 编辑键取消：pending 复位（旧实现此处不清定时器 → 定时器残留）
  t.stdin.dataHandler!('a')
  assert.equal(t.pendingSince(), 0, '编辑键取消确认窗口')
  // t≈900：旧定时器（t≈2000 到期）尚未触发。有内容时不进窗口，故先清空草稿再重入。
  await tick(880)
  assert.equal(t.pendingSince(), 0, '等待期窗口保持取消态')
  t.stdin.dataHandler!(CTRL_C) // 有内容 'a' → 清空草稿（不进窗口）
  t.stdin.dataHandler!(CTRL_C) // 空输入 → 重入（新窗口应到 t≈2880 才自动关）
  assert.ok(t.pendingSince() > 0, '重入后重新进入确认窗口')
  // t≈2100：已越过旧定时器到期点（t≈2000），但远未到重入窗口自动到期点（t≈2950）
  await tick(1150)
  assert.ok(t.pendingSince() > 0, '重入窗口未被旧定时器提前截断（窗口应延续到重入 +2s）')
  // 窗口仍存活：此刻双击退出必须生效（若被截断，此按会退化成再次重入）
  t.stdin.dataHandler!(CTRL_C)
  await tick(30)
  assert.equal(t.exitedRef(), true, '重入窗口内双击 Ctrl+C 仍退出')
})
