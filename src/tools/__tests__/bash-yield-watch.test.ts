/**
 * issue #235 期望行为 1 的执行期半边（收编公开仓 PR #257，判定层按本仓实测重写）。
 *
 * 既有 `maybeYieldForUserActivity` 只在**执行前**判定一次（用户刚在操作 → 跳过）。
 * 但 issue 现象 1 说的是「自动化**运行期间**操作者的鼠标/键盘被反复夺取」——
 * 命令一旦开跑就没有检查点。本模块补执行期这一段：周期性探测，用户接管即回调
 * （调用方负责终止进程树）。
 *
 * ⚠ 覆盖面**不是**整张 `AVAILABILITY_HAZARD_PATTERNS`，只有其中的「纯前台抢占」
 * 子集（见 `FOREGROUND_ONLY_HAZARD_PATTERNS`）。理由是本仓实测的物理事实：
 * 合成键鼠事件会重置系统的「最近输入」计时器，所以对自身在注入的命令，idle 探测
 * 读到的小值来自命令自己——若给它开监控，护栏会把正常干活的命令杀掉并给出错误
 * 归因（"你在 67ms 前开始操作本机"）。本文件前两组用例把这条不变量钉死。
 *
 * 覆盖面之外还有一层零误杀的兜底：命中**任意**危害签名的命令在跑够
 * `DEFAULT_INTERRUPT_HINT_MS` 后往 UI 推一行中断入口提示（含持续注入类——
 * 它们靠用户按键而非探测信号脱身）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_INTERRUPT_HINT_MS,
  DEFAULT_YIELD_WATCH_MS,
  executionYieldMessage,
  interruptHintMessage,
  resolveYieldWatchMs,
  shouldWatchExecution,
  startInterruptHint,
  startYieldWatch,
} from '../bash-yield.js'
import { matchesAvailabilityHazard } from '../bash-yield.js'
import type { UserIdleMs } from '../../system/user-idle.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 真实形态载荷（与审批门同源的写法），不是编造的片段。
const PWSH_FOREGROUND = `powershell -c "[DllImport('user32.dll')] static extern bool SetForegroundWindow(IntPtr h); [W]::SetForegroundWindow($h)"`
const PWSH_BRING = `powershell -c "[DllImport('user32.dll')] static extern bool BringWindowToTop(IntPtr h)"`
const VBS_APPACTIVATE = `cscript //nologo wake.vbs -- AppActivate(1234)`
const PWSH_APPACTIVATE = `powershell -NoProfile -Command "[Microsoft.VisualBasic.Interaction]::AppActivate(1234)"`

const FRONT_PUSH = [PWSH_FOREGROUND, PWSH_BRING, VBS_APPACTIVATE, PWSH_APPACTIVATE]

const PWSH_MOUSE_EVENT = `powershell -c "[DllImport('user32.dll')] static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); mouse_event(1,0,0,0,0)"`
const PWSH_KEYBD_EVENT = `powershell -c "[DllImport('user32.dll')] static extern void keybd_event(byte b,byte s,uint f,UIntPtr e)"`
const PWSH_SENDINPUT = `powershell -c "[DllImport('user32.dll')] static extern uint SendInput(uint n,INPUT[] p,int s); SendInput(1,$i,40)"`
const OSA_KEYSTROKE = `osascript -e 'tell application "System Events" to keystroke "v"'`
const OSA_KEYCODE = `osascript -e 'tell application "System Events" to key code 36'`
const PY_CTYPES = `python3 -c "import ctypes; ctypes.windll.user32.SendInput(1, p, 40)"`
const PY_AUTOGUI = `python3 -c "import pyautogui; pyautogui.click()"`
const XDOTOOL = `xdotool key Return`

const INPUT_SYNTHESIS = [
  PWSH_MOUSE_EVENT,
  PWSH_KEYBD_EVENT,
  PWSH_SENDINPUT,
  OSA_KEYSTROKE,
  OSA_KEYCODE,
  PY_CTYPES,
  PY_AUTOGUI,
  XDOTOOL,
]

/** 抢前台 + 投按键的混合脚本——issue #235 的实际形态。 */
const MIXED_FOREGROUND_AND_INPUT = `powershell -c "[DllImport('user32.dll')] static extern bool SetForegroundWindow(IntPtr h); static extern void SendInput(uint n,INPUT[] p,int s); SendInput(1,$i,40)"`

// ── 覆盖面：只对「纯前台抢占」启用（核心不变量） ────────────────────

test('shouldWatchExecution：纯前台抢占 → 启用（不合成输入，idle 如实反映真人）', () => {
  for (const cmd of FRONT_PUSH) {
    assert.equal(shouldWatchExecution(cmd), true, `应启用执行期监控：${cmd.slice(0, 60)}`)
  }
})

test('shouldWatchExecution：合成键鼠类 → 不启用（自身注入污染 idle，开了就是误杀）', () => {
  // 反证：若本判定回落到整张 AVAILABILITY_HAZARD_PATTERNS，这些断言会全红。
  // 实测依据（2026-09-22 本机）：静默基线 idle 216020→219715ms，一次 CGEventPost 后读到 67ms。
  for (const cmd of INPUT_SYNTHESIS) {
    assert.equal(shouldWatchExecution(cmd), false, `不得给自身注入的命令开监控：${cmd.slice(0, 60)}`)
  }
})

test('shouldWatchExecution：抢前台 + 投按键的混合脚本 → 不启用（含注入原语即排除）', () => {
  assert.equal(shouldWatchExecution(MIXED_FOREGROUND_AND_INPUT), false)
})

test('shouldWatchExecution：普通命令 → 不启用（不建调度，不探测）', () => {
  for (const cmd of ['npm test', 'ls -la src/', 'git status', `grep -rn "SetForegroundWindow" src/`]) {
    assert.equal(shouldWatchExecution(cmd), false, cmd)
  }
})

test('shouldWatchExecution：归一化视图对齐审批门（引号拼接/转义不漏）', () => {
  // 与 approval-risk 的 testBoth 同源：归一化后含 SetForegroundWindow( / BringWindowToTop(
  assert.equal(shouldWatchExecution(String.raw`powershell -c 'SetForeground"Window($h)'`), true)
  assert.equal(shouldWatchExecution(String.raw`powershell -c 'Bring\WindowToTop($h)'`), true)
})

test('不变量：执行期监控覆盖面 ⊆ 审批门的危害面（监控不得比审批门更宽）', () => {
  // 若白名单里混进了不在危害表里的原语，监控会在审批门没判定危害的命令上启用——
  // 用户从未被告知这类命令有可用性风险，却可能被它中止。
  for (const cmd of FRONT_PUSH) {
    assert.equal(matchesAvailabilityHazard(cmd), true, `白名单载荷必须同时是危害类：${cmd.slice(0, 60)}`)
  }
})

// ── 旋钮 ────────────────────────────────────────────────────────────

test('resolveYieldWatchMs：默认值与 0=关闭', () => {
  const saved = process.env['RIVET_CU_YIELD_WATCH_MS']
  const savedYield = process.env['RIVET_CU_YIELD_MS']
  try {
    delete process.env['RIVET_CU_YIELD_WATCH_MS']
    // 阈值钉在默认 1200（< 3000 默认间隔），clamp 不变量不影响本组断言（见下条用例）。
    delete process.env['RIVET_CU_YIELD_MS']
    assert.equal(resolveYieldWatchMs(), DEFAULT_YIELD_WATCH_MS)
    process.env['RIVET_CU_YIELD_WATCH_MS'] = '0'
    assert.equal(resolveYieldWatchMs(), 0)
    process.env['RIVET_CU_YIELD_WATCH_MS'] = 'abc'
    assert.equal(resolveYieldWatchMs(), DEFAULT_YIELD_WATCH_MS, '非法值回退默认')
    process.env['RIVET_CU_YIELD_WATCH_MS'] = '-5'
    assert.equal(resolveYieldWatchMs(), DEFAULT_YIELD_WATCH_MS, '负值回退默认')
  } finally {
    if (saved === undefined) delete process.env['RIVET_CU_YIELD_WATCH_MS']
    else process.env['RIVET_CU_YIELD_WATCH_MS'] = saved
    if (savedYield === undefined) delete process.env['RIVET_CU_YIELD_MS']
    else process.env['RIVET_CU_YIELD_MS'] = savedYield
  }
})

test('resolveYieldWatchMs：WATCH_MS < YIELD_MS 时 clamp 到阈值——批准点击不得落在首个探测窗口内', () => {
  // 复审 b5bfe8100 确认的误杀组合：执行期监控没有批准豁免窗（APPROVAL_GRACE_MS 只罩
  // 执行前判定），首个探测点在 intervalMs 之后；批准点击是键鼠事件、把 idle 清零，而
  // 监控起点必然在批准之后——点击在首次探测时的年龄 ≥ intervalMs。intervalMs < 阈值时
  // 点击年龄必 < 阈值 → 误判「用户接管」，刚批准的命令开跑即被杀。不变量：有效间隔
  // ≥ 阈值（0=显式关闭 除外，clamp 不得把它重新打开）。
  const savedWatch = process.env['RIVET_CU_YIELD_WATCH_MS']
  const savedYield = process.env['RIVET_CU_YIELD_MS']
  try {
    process.env['RIVET_CU_YIELD_WATCH_MS'] = '500'
    process.env['RIVET_CU_YIELD_MS'] = '1200'
    assert.equal(resolveYieldWatchMs(), 1200, '有效间隔不得小于让出阈值')
    assert.equal(resolveYieldWatchMs(1200), 1200, '显式阈值参数同样约束')

    process.env['RIVET_CU_YIELD_WATCH_MS'] = '3000'
    assert.equal(resolveYieldWatchMs(1200), 3000, '间隔已 ≥ 阈值时保留用户配置')

    // 默认间隔也被阈值抬升：YIELD=5000 配默认 3000 是同一个误杀形态。
    delete process.env['RIVET_CU_YIELD_WATCH_MS']
    process.env['RIVET_CU_YIELD_MS'] = '5000'
    assert.equal(resolveYieldWatchMs(), 5000, '默认间隔同样受不变量约束')

    // 阈值 0（让出护栏整体关闭）不产生 clamp；调用方本来也不会建监控。
    process.env['RIVET_CU_YIELD_MS'] = '0'
    process.env['RIVET_CU_YIELD_WATCH_MS'] = '500'
    assert.equal(resolveYieldWatchMs(), 500)

    // 0 = 显式关闭执行期监控：clamp 不得违背用户意图把它重新打开。
    process.env['RIVET_CU_YIELD_MS'] = '1200'
    process.env['RIVET_CU_YIELD_WATCH_MS'] = '0'
    assert.equal(resolveYieldWatchMs(), 0, '显式关闭必须保留')
  } finally {
    if (savedWatch === undefined) delete process.env['RIVET_CU_YIELD_WATCH_MS']
    else process.env['RIVET_CU_YIELD_WATCH_MS'] = savedWatch
    if (savedYield === undefined) delete process.env['RIVET_CU_YIELD_MS']
    else process.env['RIVET_CU_YIELD_MS'] = savedYield
  }
})

// ── 执行期监控 ──────────────────────────────────────────────────────

test('执行期：用户接管（idle < 阈值）→ 触发 onYield 且只触发一次', async () => {
  const seen: UserIdleMs[] = []
  let probes = 0
  const stop = startYieldWatch({
    probe: async () => { probes++; return 50 },
    thresholdMs: 1200,
    intervalMs: 10,
    onYield: (idle) => seen.push(idle),
  })
  await sleep(80)
  stop()
  const probesAtStop = probes
  assert.equal(seen.length, 1, '只回调一次')
  assert.equal(seen[0], 50)
  await sleep(40)
  assert.equal(probes, probesAtStop, '触发后不再探测')
})

test('执行期：用户空闲（idle >= 阈值）→ 不触发，持续探测', async () => {
  const seen: UserIdleMs[] = []
  let probes = 0
  const stop = startYieldWatch({
    probe: async () => { probes++; return 5000 },
    thresholdMs: 1200,
    intervalMs: 10,
    onYield: (idle) => seen.push(idle),
  })
  await sleep(80)
  stop()
  assert.equal(seen.length, 0)
  assert.ok(probes >= 2, `应重复探测，实得 ${probes}`)
})

test('执行期：探测无法进行（null）→ 不触发（护栏失效不该成为新的失败点）', async () => {
  const seen: UserIdleMs[] = []
  const stop = startYieldWatch({
    probe: async () => null,
    thresholdMs: 1200,
    intervalMs: 10,
    onYield: (idle) => seen.push(idle),
  })
  await sleep(60)
  stop()
  assert.equal(seen.length, 0)
})

test('执行期：探测抛错 → 吞掉并按 null 处理，不让护栏成为故障点', async () => {
  const seen: UserIdleMs[] = []
  const stop = startYieldWatch({
    probe: async () => { throw new Error('powershell 起不来') },
    thresholdMs: 1200,
    intervalMs: 10,
    onYield: (idle) => seen.push(idle),
  })
  await sleep(60)
  stop()
  assert.equal(seen.length, 0)
})

test('执行期：stop() 后不再探测（命令已结束，不许残留调度）', async () => {
  let probes = 0
  const stop = startYieldWatch({
    probe: async () => { probes++; return 9999 },
    thresholdMs: 1200,
    intervalMs: 10,
    onYield: () => {},
  })
  await sleep(40)
  stop()
  const atStop = probes
  await sleep(60)
  assert.equal(probes, atStop, 'stop 后不得再探测')
})

test('执行期：intervalMs <= 0 → 不建调度（旋钮关闭路径）', async () => {
  let probes = 0
  const stop = startYieldWatch({
    probe: async () => { probes++; return 10 },
    thresholdMs: 1200,
    intervalMs: 0,
    onYield: () => { throw new Error('不该触发') },
  })
  await sleep(60)
  stop()
  assert.equal(probes, 0)
})

test('执行期：thresholdMs <= 0（让出护栏整体关闭）→ 不建调度，不白付探测开销', async () => {
  // 用户按 RIVET_CU_YIELD_MS=0 关掉让出护栏时，执行期不该还在每 3s 起一个子进程。
  let probes = 0
  const stop = startYieldWatch({
    probe: async () => { probes++; return 10 },
    thresholdMs: 0,
    intervalMs: 10,
    onYield: () => { throw new Error('不该触发') },
  })
  await sleep(60)
  stop()
  assert.equal(probes, 0)
})

// ── 文案 ────────────────────────────────────────────────────────────

test('executionYieldMessage：说清"已跑过一部分"与"副作用不回滚"，并给出两条继续路径', () => {
  const msg = executionYieldMessage(50, 3000, 'partial output')
  assert.match(msg, /\[让出·执行中\]/)
  assert.match(msg, /已经跑过一部分/)
  assert.match(msg, /不会自动回滚/)
  assert.match(msg, /RIVET_CU_YIELD_WATCH_MS=0/, '必须给出关闭执行期监控的旋钮')
  assert.match(msg, /computer_use/, '必须给出合规替代通道')
  assert.match(msg, /partial output/, '保留终止前的部分输出')
})

test('executionYieldMessage：无部分输出时不追加空段', () => {
  const msg = executionYieldMessage(null, 3000, '')
  assert.match(msg, /未知/)
  assert.ok(!msg.includes('终止前的部分输出'))
})

test('interruptHintMessage：给出在输入被占用时仍可触达的中断入口', () => {
  const msg = interruptHintMessage()
  assert.match(msg, /Esc/)
  assert.match(msg, /⌘⇧Esc/)
  assert.match(msg, /Ctrl\+Alt\+Esc/, 'Windows 热键不同，必须一并给出')
})

// ── 中断提示（零误杀的兜底层） ──────────────────────────────────────

test('中断提示：命令跑够 delayMs 后回调一次', async () => {
  let hints = 0
  const stop = startInterruptHint({ delayMs: 10, onHint: () => { hints++ } })
  await sleep(60)
  stop()
  assert.equal(hints, 1)
})

test('中断提示：命令提前结束（stop）→ 不回调', async () => {
  let hints = 0
  const stop = startInterruptHint({ delayMs: 40, onHint: () => { hints++ } })
  await sleep(10)
  stop()
  await sleep(60)
  assert.equal(hints, 0)
})

test('中断提示：delayMs <= 0 → 不建调度；重复 stop 幂等', async () => {
  let hints = 0
  const stop = startInterruptHint({ delayMs: 0, onHint: () => { hints++ } })
  stop()
  stop()
  await sleep(30)
  assert.equal(hints, 0)
  assert.ok(DEFAULT_INTERRUPT_HINT_MS > 0)
})
