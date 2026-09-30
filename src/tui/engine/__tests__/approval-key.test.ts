/**
 * T9 审批按键测试。
 *
 * Bug：审批模式下 Enter 既经 onAnyKey 落入 inputLine 触发 submit，
 * 又经 mode-bound approval:return 触发 approve —— 双触发，且会把输入框里的文本误提交。
 *
 * 契约：审批模式下按键只解析审批动作——↑↓ 移动光标、Enter 按光标行分发
 * （批准/拒绝/编辑/解释风险），y/n/e/^E 直达键与光标确认等价，
 * 绝不落入 inputLine（不提交、不污染输入框）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn } from './_harness.js'

function makeApp(cwd?: string) {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80, rows: 24, modelName: 'test',
    cwd,
  })
  return { app, out, stdin }
}

const tick = () => new Promise(r => setTimeout(r, 10))

test('审批模式 Enter → 仅 approve 一次，不提交输入框（无双触发）', async () => {
  const { app, stdin } = makeApp()
  let submitCount = 0
  app.onSubmit(() => { submitCount++ })
  // 输入框里有残留文本，审批态 Enter 不应误提交它
  app.setInput('SHOULD_NOT_SUBMIT')

  let resolved: unknown = Symbol('unset')
  void app.callbacks.onApprovalRequired!('1', 'Bash', { command: 'ls' }).then(r => { resolved = r })

  stdin.dataHandler!('\r') // approval 模式下回车（光标默认在「批准」）
  await tick()

  assert.deepEqual(resolved, { approved: true }, '应 approve 一次')
  assert.equal(submitCount, 0, '审批态 Enter 不应提交输入框文本')
})

test('审批模式 n → deny', async () => {
  const { app, stdin } = makeApp()
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onApprovalRequired!('1', 'Bash', { command: 'ls' }).then(r => { resolved = r })
  stdin.dataHandler!('n')
  await tick()
  assert.equal(resolved, false, 'n 应 deny')
})

test('审批模式 y → approve', async () => {
  const { app, stdin } = makeApp()
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onApprovalRequired!('1', 'Bash', { command: 'ls' }).then(r => { resolved = r })
  stdin.dataHandler!('y')
  await tick()
  assert.deepEqual(resolved, { approved: true }, 'y 应 approve')
})

test('审批模式 e → 不是 approve（假 edit 已移除，按键被吞）', async () => {
  const { app, stdin } = makeApp()
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onApprovalRequired!('1', 'Bash', { command: 'ls' }).then(r => { resolved = r })
  stdin.dataHandler!('e')
  await tick()
  // 旧实现 e===approve 是误导性假动作；现在 e 被吞，审批仍 pending（resolved 保持哨兵 symbol）
  assert.ok(typeof resolved === 'symbol', 'e 不应 resolve 审批（仍 pending）')
})

test('审批模式 ↓ + Enter → 光标分发到「拒绝」', async () => {
  const { app, stdin } = makeApp()
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onApprovalRequired!('1', 'Bash', { command: 'ls' }).then(r => { resolved = r })
  stdin.dataHandler!('\x1B[B') // ↓ → 拒绝
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(resolved, false, '光标第 2 行 Enter 应 deny')
})

test('审批模式 ↓↑ + Enter → 光标回到「批准」', async () => {
  const { app, stdin } = makeApp()
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onApprovalRequired!('1', 'Bash', { command: 'ls' }).then(r => { resolved = r })
  stdin.dataHandler!('\x1B[B') // ↓ → 拒绝
  stdin.dataHandler!('\x1B[A') // ↑ → 批准
  stdin.dataHandler!('\r')
  await tick()
  assert.deepEqual(resolved, { approved: true }, '光标回到第 1 行 Enter 应 approve')
})

test('审批模式 ↓↓ + Enter → 进入编辑模式（仍 pending，输入行装入 JSON）', async () => {
  const { app, stdin } = makeApp()
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onApprovalRequired!('1', 'Bash', { command: 'ls' }).then(r => { resolved = r })
  stdin.dataHandler!('\x1B[B') // ↓ → 拒绝
  stdin.dataHandler!('\x1B[B') // ↓ → 编辑 JSON
  stdin.dataHandler!('\r')
  await tick()
  assert.ok(typeof resolved === 'symbol', '进入编辑模式不 resolve 审批')
})

test('审批模式光标环绕：↑ 从「批准」绕到末行「解释风险」', async () => {
  const { app, stdin } = makeApp()
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onApprovalRequired!('1', 'Bash', { command: 'ls' }).then(r => { resolved = r })
  stdin.dataHandler!('\x1B[A') // ↑ 环绕 → 末行「解释风险」（请求风险解释，不 resolve）
  stdin.dataHandler!('\r')
  await tick()
  assert.ok(typeof resolved === 'symbol', '解释风险只拉取解释，不 resolve 审批')
})

test('审批模式请求风险解释后光标收敛——不越界成死键', async () => {
  const { app, stdin } = makeApp()
  // 永不返回的解释器：pending 态持续，选项收缩为 3 行的窗口被钉住
  app.setRiskExplainer(() => new Promise(() => {}))
  void app.callbacks.onApprovalRequired!('1', 'Bash', { command: 'ls' })
  stdin.dataHandler!('\x1B[A') // ↑ 环绕 → 末行「解释风险」(index 3)
  stdin.dataHandler!('\r')       // Enter 请求解释 → 选项 4 → 3
  await tick()
  const ctrl = (app as unknown as {
    approvalIntentController: { approvalOptionIndex: number; riskExplainPending: boolean }
  }).approvalIntentController
  assert.equal(ctrl.riskExplainPending, true, '解释请求应在途')
  assert.ok(ctrl.approvalOptionIndex <= 2, `光标越界：index=${ctrl.approvalOptionIndex}（3 行选项应为 0-2）`)
})

// ── 「批准并记住此目录」选项（工作区外路径审批） ─────────────────────────

test('工作区外 write_file 审批：显示记住选项，r 键直达批准并记住', async () => {
  const { app, stdin } = makeApp('/workspace')
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onApprovalRequired!('1', 'write_file', { file_path: '/tmp/out.txt' }).then(r => { resolved = r })
  const ctrl = (app as unknown as { approvalIntentController: { showRememberOption: boolean } }).approvalIntentController
  await tick()
  assert.equal(ctrl.showRememberOption, true, '工作区外路径审批必须显示记住选项')
  stdin.dataHandler!('r')
  await tick()
  assert.deepEqual(resolved, { approved: true, remember: true }, 'r 键 = 批准并记住')
})

test('工作区内 write_file 审批：不显示记住选项，r 键被吞', async () => {
  // 「工作区内」判定需平台原生路径（win: C:\workspace）：POSIX 假路径 '/workspace'
  // 与 resolve 产物（带盘符 C:\workspace）前缀不匹配，会把工作区内误判成工作区外
  // （isPathUnder 的平台化只覆盖分隔符、不覆盖盘符）。
  const wsCwd = resolve('/workspace')
  const { app, stdin } = makeApp(wsCwd)
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onApprovalRequired!('1', 'write_file', { file_path: join(wsCwd, 'src', 'a.ts') }).then(r => { resolved = r })
  const ctrl = (app as unknown as { approvalIntentController: { showRememberOption: boolean } }).approvalIntentController
  await tick()
  assert.equal(ctrl.showRememberOption, false, '工作区内审批无记住选项')
  stdin.dataHandler!('r')
  await tick()
  assert.ok(typeof resolved === 'symbol', '无记住选项时 r 键应被吞（不 resolve）')
})

test('记住选项下 ↑ 从「批准」环绕到末行「解释风险」（5 项选项表）', async () => {
  const { app, stdin } = makeApp('/workspace')
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onApprovalRequired!('1', 'write_file', { file_path: '/tmp/out.txt' }).then(r => { resolved = r })
  const ctrl = (app as unknown as { approvalIntentController: { approvalOptionIndex: number } }).approvalIntentController
  await tick()
  stdin.dataHandler!('\x1B[A') // ↑ 环绕 → index 4（记住场景：批准/拒绝/编辑/记住/解释风险）
  await tick()
  assert.equal(ctrl.approvalOptionIndex, 4, '5 项选项表末行是解释风险')
  stdin.dataHandler!('\r')
  await tick()
  assert.ok(typeof resolved === 'symbol', '解释风险只拉取解释，不 resolve 审批')
})

test('记住选项下 ↓↓ 光标到「批准并记住」行，Enter 批准并记住', async () => {
  const { app, stdin } = makeApp('/workspace')
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onApprovalRequired!('1', 'write_file', { file_path: '/tmp/out.txt' }).then(r => { resolved = r })
  const ctrl = (app as unknown as { approvalIntentController: { approvalOptionIndex: number } }).approvalIntentController
  await tick()
  stdin.dataHandler!('\x1B[B') // ↓ → 拒绝
  stdin.dataHandler!('\x1B[B') // ↓ → 编辑
  stdin.dataHandler!('\x1B[B') // ↓ → 批准并记住
  await tick()
  assert.equal(ctrl.approvalOptionIndex, 3)
  stdin.dataHandler!('\r')
  await tick()
  assert.deepEqual(resolved, { approved: true, remember: true }, 'index 3 Enter = 批准并记住')
})

test('记住选项下请求风险解释后光标收敛不越界（5 项 → 4 项）', async () => {
  const { app, stdin } = makeApp('/workspace')
  app.setRiskExplainer(() => new Promise(() => {}))
  void app.callbacks.onApprovalRequired!('1', 'write_file', { file_path: '/tmp/out.txt' })
  stdin.dataHandler!('\x1B[A') // ↑ 环绕 → index 4（解释风险）
  stdin.dataHandler!('\r')       // 请求解释 → 选项 5 → 4
  await tick()
  const ctrl = (app as unknown as {
    approvalIntentController: { approvalOptionIndex: number; riskExplainPending: boolean; showRememberOption: boolean }
  }).approvalIntentController
  assert.equal(ctrl.riskExplainPending, true)
  assert.equal(ctrl.showRememberOption, true, '记住选项保留')
  assert.ok(ctrl.approvalOptionIndex <= 3, `光标越界：index=${ctrl.approvalOptionIndex}（4 行选项应为 0-3）`)
})
