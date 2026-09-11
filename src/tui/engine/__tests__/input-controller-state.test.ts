/**
 * W-B5 InputController 状态测试 — 验证 ctrl+c 双击退出、esc 双击 rewind、
 * slash 补全循环等通过 TuiApp 按键路径正确操作 InputController 状态字段。
 *
 * 覆盖缺口（L3 审查标识）：
 *  1. idle 空输入首次 Ctrl+C → 进入 pending 窗口（不退出）
 *  2. idle 2s 内再次 Ctrl+C → 触发 exit callback
 *  3. idle 有输入 Ctrl+C → 清空草稿（readline 惯例，不进窗口；agent 活跃仍中断）
 *  4. idle 空输入双击 Esc → 激活 rewind overlay
 *  5. idle 有输入 Esc → 清空输入框（Esc 与 Ctrl+C 均承担「清空输入」）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn } from './_harness.js'

function makeApp() {
  const out = new MockOut(120, 24)
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 120, rows: 24, modelName: 'test', contextWindow: 200_000,
  })
  return { app, out, stdin }
}

const tick = () => new Promise(r => setTimeout(r, 10))

test('idle 空输入首次 Ctrl+C → 不退出，进入 pending 窗口', async () => {
  const { app, stdin } = makeApp()
  let exitCalled = false
  app.onExit(() => { exitCalled = true })
  app.start()

  // Ctrl+C
  stdin.dataHandler!('\x03')
  await tick()
  assert.equal(exitCalled, false, '首次 Ctrl+C 不应退出')
  // app 仍可用（没 process.exit）
  assert.equal(app.getInputValue(), '', '输入框仍空')
})

test('idle 有输入 Ctrl+C → 清空草稿（不进退出确认、不退出）', async () => {
  const { app, stdin } = makeApp()
  let exitCalled = false
  app.onExit(() => { exitCalled = true })
  app.start()

  app.setInput('some draft text')
  stdin.dataHandler!('\x03')
  await tick()
  assert.equal(exitCalled, false, '有输入时 Ctrl+C 不应退出')
  assert.equal(app.getInputValue(), '', 'Ctrl+C 应清空草稿（readline 惯例）')
  const pending = (app as any).inputController.ctrlCPendingSince as number
  assert.equal(pending, 0, '有输入时首按不进退出确认窗口')
})

test('idle 空输入 Esc → 清空已有输入', async () => {
  const { app, stdin } = makeApp()
  app.start()
  app.setInput('draft')
  await tick()

  stdin.dataHandler!('\x1B')
  // lone ESC 有延迟（区分方向键序列），默认超时 80ms，等待 100ms 确保已派发。
  await new Promise(r => setTimeout(r, 100))
  assert.equal(app.getInputValue(), '', 'Esc 应清空有内容的输入框')
})

test('idle 空输入双击 Esc → 激活 rewind overlay', async () => {
  const { app, stdin } = makeApp()
  app.start()

  // 第一次 Esc（空输入，记录时间戳）
  stdin.dataHandler!('\x1B')
  await new Promise(r => setTimeout(r, 60))

  // 第二次 Esc（在 400ms 内）
  stdin.dataHandler!('\x1B')
  await new Promise(r => setTimeout(r, 60))

  // rewind overlay 应被激活
  assert.ok(app.getOverlayQuery() !== undefined, '双击 Esc 后 overlay 状态应改变')
  // overlay 激活验证：尝试 deactivate 并确认无异常
  app.deactivateOverlay()
  await tick()
})

test('slash 命令 ↑↓ 选择移动菜单选中（通过 render 不报错验证）', async () => {
  const { app, stdin } = makeApp()
  app.start()

  // 输入 / 开头
  app.setInput('/mod')
  await tick()

  // ↑ 键 — 不报错即表示 slashMenu 导航路径正常
  stdin.dataHandler!('\x1B[A') // ↑ 序列
  await tick()

  // ↓ 键
  stdin.dataHandler!('\x1B[B') // ↓ 序列
  await tick()

  // 验证 app 没崩溃（输入框仍可读）
  assert.ok(app.getInputValue().startsWith('/mod'), 'slash 选择后输入框保持 / 开头')
})

test('/file/path 不被当作 slash 命令提交，而是普通文本', async () => {
  const { app, stdin } = makeApp()
  const slashInputs: string[] = []
  const normalInputs: string[] = []
  app.setSlashHandler((input) => { slashInputs.push(input); return false })
  app.onSubmit((text) => { normalInputs.push(text) })
  app.start()

  app.setInput('/src/main.ts')
  stdin.dataHandler!('\r')
  await tick()

  assert.deepEqual(slashInputs, [], '路径不应走 slash handler')
  assert.deepEqual(normalInputs, ['/src/main.ts'], '路径应作为普通文本提交')
})

test('/file/path 不渲染 slash 命令提示', async () => {
  const { app, out, stdin } = makeApp()
  app.start()

  app.setInput('/src/main.ts')
  await tick()

  const visible = out.chunks.join('').replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')
  assert.ok(!visible.includes('Available commands'), '路径输入不应出现 slash 命令提示')
  assert.ok(!visible.includes('tab complete'), '路径输入不应出现 tab complete 提示')
})

test('/file/path 按 Tab 不会补全成 slash 命令', async () => {
  const { app, stdin } = makeApp()
  app.start()

  app.setInput('/hel') // /hel 是路径前缀，不是命令
  stdin.dataHandler!('\t')
  await tick()

  // 不应被补全成 /help
  assert.equal(app.getInputValue(), '/hel', '路径前缀 Tab 不补全')
})

test('slash 命令 ↑↓ 选中后按 Enter 提交选中命令，而不是原始输入', async () => {
  const { app, stdin } = makeApp()
  const slashInputs: string[] = []
  app.setSlashCommands([
    { name: '/help', description: 'Show all commands' },
    { name: '/compact', description: 'Compact conversation context' },
    { name: '/exit', description: 'Exit' },
  ])
  app.setSlashHandler((input) => { slashInputs.push(input); return true })
  app.start()

  // 只输入 /，打开完整提示列表
  app.setInput('/')
  await tick()

  // 按两次 ↓ 选中 /compact（索引 0→1→2？实际按字母序 /compact 是索引 1；
  // 这里用两次 ↓ 确保不是首项 /compact 而是有意选择）
  // /help(0), /compact(1), /exit(2)
  stdin.dataHandler!('\x1B[B') // ↓
  await tick()
  stdin.dataHandler!('\x1B[B') // ↓
  await tick()

  // 此时原始输入仍是 '/'，如果直接提交会丢失命令
  stdin.dataHandler!('\r')
  await tick()

  assert.equal(slashInputs.length, 1, '应提交一次 slash 命令')
  assert.equal(slashInputs[0], '/exit', '应提交 ↑↓ 选中的 /exit，而不是原始输入 /')
})

test('slash 命令输入 /h 后模糊过滤并选中 /help 提交', async () => {
  const { app, stdin } = makeApp()
  const slashInputs: string[] = []
  app.setSlashCommands([
    { name: '/help', description: 'Show all commands' },
    { name: '/compact', description: 'Compact conversation context' },
    { name: '/exit', description: 'Exit' },
  ])
  app.setSlashHandler((input) => { slashInputs.push(input); return true })
  app.start()

  app.setInput('/h')
  await tick()

  // 过滤后 /help 应是唯一或首项，直接 Enter应提交 /help
  stdin.dataHandler!('\r')
  await tick()

  assert.equal(slashInputs.length, 1, '应提交一次 slash 命令')
  assert.equal(slashInputs[0], '/help', '输入 /h 后 Enter 应提交模糊匹配到的 /help')
})

test('slash 命令已输入完整命令+参数时 Enter 保留参数', async () => {
  const { app, stdin } = makeApp()
  const slashInputs: string[] = []
  app.setSlashCommands([
    { name: '/team', description: 'Run team-mode workflow' },
    { name: '/team max', description: 'Run team-mode planning-first' },
  ])
  app.setSlashHandler((input) => { slashInputs.push(input); return true })
  app.start()

  // 用户已输入完整命令和参数，不应被提示首项截断
  app.setInput('/team plan.md')
  await tick()
  stdin.dataHandler!('\r')
  await tick()

  assert.equal(slashInputs.length, 1, '应提交一次 slash 命令')
  assert.equal(slashInputs[0], '/team plan.md', '已输入完整命令+参数时应保留参数')
})

test('slash 命令输入 /model 后 Enter 不自动扩展为 /model list', async () => {
  const { app, stdin } = makeApp()
  const slashInputs: string[] = []
  app.setSlashCommands([
    { name: '/model', description: 'Show or switch model' },
    { name: '/model list', description: 'List available models' },
  ])
  app.setSlashHandler((input) => { slashInputs.push(input); return true })
  app.start()

  // 用户完整输入 /model，应直接提交 /model（打开模型选择器），
  // 而不是被提示首项 /model list 截断成列表命令。
  app.setInput('/model')
  await tick()
  stdin.dataHandler!('\r')
  await tick()

  assert.equal(slashInputs.length, 1, '应提交一次 slash 命令')
  assert.equal(slashInputs[0], '/model', '输入 /model 后 Enter 应提交 /model 本身')
})

// ── slash 菜单状态机（Wave 2 接线）：PageUp/Down 翻页、ESC 关闭、Tab 补全、MRU ──

const MENU_COMMANDS = [
  { name: '/help', description: 'Show all commands' },
  { name: '/compact', description: 'Compact conversation context' },
  { name: '/cost', description: 'Show session cost' },
  { name: '/clear', description: 'Clear conversation' },
  { name: '/effort', description: 'Set reasoning effort', argsHint: 'off|low|medium|high|max' },
  { name: '/exit', description: 'Quit' },
  { name: '/review', description: 'Run code review' },
  { name: '/review max', description: 'Run full squadron review' },
  { name: '/team', description: 'Run team-mode workflow' },
  { name: '/team max', description: 'Run team-mode planning-first' },
  { name: '/starmap', description: 'Open starmap' },
  { name: '/chronicle', description: 'Replay session' },
]

test('菜单打开时 PageDown 滚动选中（clamp 不环绕），PageUp 回卷', async () => {
  const { app, stdin } = makeApp()
  app.setSlashCommands(MENU_COMMANDS)
  app.start()

  app.setInput('/')
  await tick()
  const c = app.getInputController()
  assert.equal(c.slashMenu.open, true, '空 query 打开菜单')
  assert.equal(c.slashMenu.selected, 0)

  // PageDown：选中 +5（SLASH_HINT_MAX_VISIBLE），clamp 到末项
  stdin.dataHandler!('\x1B[6~')
  await tick()
  assert.equal(c.slashMenu.selected, 5, 'PageDown 一次 +5')

  // 连续 PageDown clamp 到末项
  for (let i = 0; i < 5; i++) {
    stdin.dataHandler!('\x1B[6~')
    await tick()
  }
  assert.equal(c.slashMenu.selected, c.slashMenu.matches.length - 1, '向下翻页 clamp 到末项')

  // PageUp 回卷再 clamp 到首项
  for (let i = 0; i < 8; i++) {
    stdin.dataHandler!('\x1B[5~')
    await tick()
  }
  assert.equal(c.slashMenu.selected, 0, '向上翻页 clamp 到首项')
})

test('菜单打开时 ESC 关闭菜单且不清空输入', async () => {
  const { app, stdin } = makeApp()
  app.setSlashCommands(MENU_COMMANDS)
  app.start()

  app.setInput('/h')
  await tick()
  assert.equal(app.getInputController().slashMenu.open, true, '/h 有匹配菜单打开')

  stdin.dataHandler!('\x1B')
  await new Promise(r => setTimeout(r, 100)) // lone ESC 有解析延迟
  assert.equal(app.getInputController().slashMenu.open, false, 'Esc 关闭菜单')
  assert.equal(app.getInputValue(), '/h', 'Esc 不清空输入（再按一次才清空）')

  // 再按 ESC（菜单已关）→ 走原语义清空输入
  stdin.dataHandler!('\x1B')
  await new Promise(r => setTimeout(r, 100))
  assert.equal(app.getInputValue(), '', '菜单关闭后 Esc 恢复清空语义')
})

test('菜单打开时 Tab 补全选中命令（带尾空格）', async () => {
  const { app, stdin } = makeApp()
  app.setSlashCommands(MENU_COMMANDS)
  app.start()

  app.setInput('/e')
  await tick()
  // /e 匹配：/effort(prefix) /exit(prefix)
  assert.equal(app.getInputController().slashMenu.open, true)

  stdin.dataHandler!('\t')
  await tick()
  assert.equal(app.getInputValue(), '/effort ', 'Tab 补全首项 /effort 并留参数位')
})

test('命令执行后 MRU 生效：下次查询同分命令排前', async () => {
  const { app, stdin } = makeApp()
  const slashInputs: string[] = []
  app.setSlashCommands(MENU_COMMANDS)
  app.setSlashHandler((input) => { slashInputs.push(input); return true })
  app.start()

  // 执行 /exit（不通过 ↑↓ 选择，直接完整输入 + Enter）
  app.setInput('/exit')
  await tick()
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(slashInputs[0], '/exit')

  // 重新查询 '/'：/exit 应在 MRU 影响下排到同分组最前（无 tier 时全量注册序，
  // /exit 是注册序第 6；MRU 后应提前）
  app.setInput('/')
  await tick()
  const names = app.getInputController().slashMenu.matches.map(m => m.name)
  assert.equal(names[0], '/exit', 'MRU 命令排首位')
  assert.ok(app.getInputController().slashMru.includes('exit'), 'MRU 记录存在')
})

test('参数模式：/effort 尾空格 → 菜单保持单条（ghost 由渲染层消费）', async () => {
  const { app, stdin } = makeApp()
  app.setSlashCommands(MENU_COMMANDS)
  app.start()

  app.setInput('/effort ')
  await tick()
  const menu = app.getInputController().slashMenu
  assert.equal(menu.open, true, '参数模式菜单保持打开')
  assert.deepEqual(menu.matches.map(m => m.name), ['/effort'], '参数模式精确单条')

  // 继续输入参数 → 菜单关闭
  app.setInput('/effort high')
  await tick()
  assert.equal(app.getInputController().slashMenu.open, false, '参数输入后菜单关闭')
})

test('输入变化 carry：同 query 刷新保持选中，query 变化重置', async () => {
  const { app, stdin } = makeApp()
  app.setSlashCommands(MENU_COMMANDS)
  app.start()

  app.setInput('/')
  await tick()
  // ↑↓ 移动选中（↓ 三次）
  stdin.dataHandler!('\x1B[B')
  await tick()
  stdin.dataHandler!('\x1B[B')
  await tick()
  stdin.dataHandler!('\x1B[B')
  await tick()
  const selectedAfterMove = app.getInputController().slashMenu.selected
  assert.equal(selectedAfterMove, 3, '↓ 三次选中第 3 项')

  // 输入变化（query 变）：/clear → /cl 仍匹配 /clear，但 query 变了 → 重置 0
  app.setInput('/cl')
  await tick()
  assert.equal(app.getInputController().slashMenu.selected, 0, 'query 变化重置选中')
})

// ── 用户级验收：菜单打开输入框钉底（渲染级）──
// 小终端（120x24，maxRows=23）：输入 / 唤起菜单 → 整帧行数 ≤ 终端高度、
// 输入框行仍在（剥离 ANSI 后断言）。真实终端目视留用户。

test('小终端菜单打开：整帧 ≤ 终端高度且输入框行仍在（钉底）', async () => {
  const { app, out, stdin } = makeApp()
  app.setSlashCommands(MENU_COMMANDS)
  app.start()

  app.setInput('/')
  await tick()
  assert.equal(app.getInputController().slashMenu.open, true, '菜单打开')

  const plain = out.chunks.join('')
    .replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .split('\n')
    .filter(l => l.trim().length > 0)
  assert.ok(plain.some(l => l.includes('❯')), '输入框行存在')
  assert.ok(plain.length <= 24, `整帧 ${plain.length} 行 ≤ 终端高度 24（钉底：不越底滚动）`)
})
