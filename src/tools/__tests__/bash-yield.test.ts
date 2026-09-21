/**
 * issue #235 Wave 2 —— shell 侧「用户接管即让出」护栏。
 *
 * RED 前置：`../bash-yield.js` 尚不存在（本文件应先跑红）。
 *
 * 护栏的两条边界同样重要：
 *  - 该拦不拦 → 用户输入被持续抢夺，唯一恢复路径是杀进程（issue 现象 1）；
 *  - 不该拦乱拦 → 普通命令被拖慢或被拒，护栏变成日常摩擦。
 * 因此「未命中签名的命令**连探测都不做**」是硬性性能契约，单独用例钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  APPROVAL_GRACE_MS,
  matchesAvailabilityHazard,
  maybeYieldForUserActivity,
} from '../bash-yield.js'
import { normalizeBashCommand } from '../../agent/approval-risk.js'

/** 与 AVAILABILITY_HAZARD_PATTERNS 同形的真实载荷（P/Invoke 声明 user32）。 */
const HAZARD_POWERSHELL =
  'powershell -c "Add-Type -MemberDefinition \'[DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr h);\'"'
/** xdotool 族（通用输入注入工具）。 */
const HAZARD_XDOTOOL = 'xdotool key ctrl+v'
const SAFE_NPM = 'npm test'
const SAFE_GREP = 'grep -rn mouse_event src/'

test('matchesAvailabilityHazard：注入签名命中，普通命令不误伤', () => {
  assert.equal(matchesAvailabilityHazard(HAZARD_POWERSHELL), true)
  assert.equal(matchesAvailabilityHazard(HAZARD_XDOTOOL), true)
  assert.equal(matchesAvailabilityHazard('osascript -e \'tell application "System Events" to keystroke "v"\''), true)
  assert.equal(matchesAvailabilityHazard(SAFE_NPM), false)
  // 翻源码/检索关键词不是注入：签名要求调用形态或库名，裸关键词不算
  assert.equal(matchesAvailabilityHazard(SAFE_GREP), false, 'grep mouse_event 是读源码，不是注入')
  assert.equal(matchesAvailabilityHazard('git log --oneline -5'), false)
})

test('命中签名 + 用户刚在操作 → 让出（不执行），文案给出下一步', async () => {
  const result = await maybeYieldForUserActivity({
    command: HAZARD_POWERSHELL,
    probe: async () => 120, // 120ms 前有键鼠事件
    thresholdMs: 1200,
  })
  assert.ok(result, '用户活跃时必须让出')
  assert.equal(result!.isError, true)
  assert.match(result!.content, /让出/)
  assert.match(result!.content, /computer_use/, '文案要指向正路：GUI 自动化走 computer_use')
  assert.match(result!.content, /重试|稍后/, '要让用户知道怎么继续')
})

test('命中签名 + 用户空闲够久 → 放行（不拦截）', async () => {
  const result = await maybeYieldForUserActivity({
    command: HAZARD_POWERSHELL,
    probe: async () => 60_000,
    thresholdMs: 1200,
  })
  assert.equal(result, null)
})

test('探测无法进行（null）→ 放行：护栏失效不该成为新的失败点', async () => {
  const result = await maybeYieldForUserActivity({
    command: HAZARD_POWERSHELL,
    probe: async () => null,
    thresholdMs: 1200,
  })
  assert.equal(result, null)
})

test('未命中签名 → 连探测都不做（普通命令零开销）', async () => {
  let probed = false
  const result = await maybeYieldForUserActivity({
    command: SAFE_NPM,
    probe: async () => {
      probed = true
      return 0
    },
    thresholdMs: 1200,
  })
  assert.equal(result, null)
  assert.equal(probed, false, '普通命令不得触发探测——否则每条 shell 都多一次子进程')
})

test('thresholdMs = 0 → 护栏关闭，命中签名也放行', async () => {
  let probed = false
  const result = await maybeYieldForUserActivity({
    command: HAZARD_XDOTOOL,
    probe: async () => {
      probed = true
      return 0
    },
    thresholdMs: 0,
  })
  assert.equal(result, null)
  assert.equal(probed, false, '关闭时也不探测')
})

test('阈值边界：恰好等于阈值算已空闲 → 放行', async () => {
  assert.equal(
    await maybeYieldForUserActivity({ command: HAZARD_XDOTOOL, probe: async () => 1200, thresholdMs: 1200 }),
    null,
  )
  assert.ok(
    await maybeYieldForUserActivity({ command: HAZARD_XDOTOOL, probe: async () => 1199, thresholdMs: 1200 }),
    '1199ms 前有输入 = 用户仍在操作 → 让出',
  )
})

// ── 与审批门同视图（归一化） ──────────────────────────────────────
// 审批门走 testBoth（原始 + 归一化），让出护栏此前只看原始视图。实测命令
// `echo 'osascript to key'stroke v`：审批门判 high「GUI 输入注入」，让出护栏判 false
// ——阈值置顶也照样执行。同一份 pattern 表、两个消费者、两个视图，
// 语义相同的命令在两道门上必须得到同一结论。
test('归一化视图对齐审批门：引号拼接的注入不再漏过让出护栏', async () => {
  const QUOTE_SPLICED = "echo 'osascript to key'stroke v"
  assert.match(normalizeBashCommand(QUOTE_SPLICED), /keystroke/, '归一化后它就是 keystroke 注入')
  assert.equal(matchesAvailabilityHazard(QUOTE_SPLICED), true, '归一化视图命中 = 与审批门同结论')

  const result = await maybeYieldForUserActivity({
    command: QUOTE_SPLICED,
    probe: async () => 120,
    thresholdMs: 1200,
  })
  assert.ok(result, '命中 + 用户刚在操作 → 让出（此前会放行）')
})

test('归一化不得制造新误报：读源码形态仍免让出', () => {
  assert.equal(matchesAvailabilityHazard('rg user32 src/'), false)
  assert.equal(matchesAvailabilityHazard('grep -rn "SetForegroundWindow" src/'), false)
  assert.equal(matchesAvailabilityHazard(SAFE_GREP), false)
})

// ── 批准动作 ≠ 用户正在用本机 ──────────────────────────────────────
// 审批门在 tool-pipeline 里先 await 用户批准、之后才执行工具，而批准是一次键鼠
// 事件：批准 → 探测（实测 234ms 子进程）→ idle ≈ 250ms < 1200ms → 命令被跳过。
// 用户刚批准就被"让出"，且文案让他"停手重试"（重试还得再批准一次）。
test('刚批准的命令不被让出——批准是显式授权，不是「用户正在操作」', async () => {
  const result = await maybeYieldForUserActivity({
    command: HAZARD_XDOTOOL,
    probe: async () => 0, // 探测必然读到"刚刚有输入"，即那次点击
    thresholdMs: 1200,
    approvalGrantedAt: Date.now(),
  })
  assert.equal(result, null, '批准后立即判定必须放行')
})

test('批准豁免窗过期 → 回到正常判定（用户的新操作照样让出）', async () => {
  const result = await maybeYieldForUserActivity({
    command: HAZARD_XDOTOOL,
    probe: async () => 0,
    thresholdMs: 1200,
    approvalGrantedAt: Date.now() - APPROVAL_GRACE_MS - 1,
  })
  assert.ok(result, '窗口外的输入是用户的新操作，必须让出')
})

test('没有 approvalGrantedAt（自动放行/无审批档）→ 不享受豁免窗', async () => {
  const result = await maybeYieldForUserActivity({
    command: HAZARD_XDOTOOL,
    probe: async () => 0,
    thresholdMs: 1200,
  })
  assert.ok(result, '无批准记录时必须按真实读数判定')
})
