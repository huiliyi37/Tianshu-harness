/**
 * issue #235 — 用户空闲探测：解析、null 语义、平台分派。
 *
 * 这层是「用户接管即让出」护栏的数据源，护栏失效的两种方向都在这里钉住：
 *  - 解析把合法值读成 null → 护栏静默失效（该让出时不让出）；
 *  - 把 null 当 0 → 读成「用户刚刚在动」→ 正常自动化被全锁死。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MACOS_IDLE_JXA_SCRIPT,
  parseMacosIdleSeconds,
  parseWindowsIdleMs,
  isUserActive,
  probeUserIdleMs,
} from '../user-idle.js'

// ── 解析 ──────────────────────────────────────────────────────────

test('macOS：秒 → 毫秒，含首尾空白与浮点', () => {
  assert.equal(parseMacosIdleSeconds('0'), 0)
  assert.equal(parseMacosIdleSeconds('1.5'), 1500)
  assert.equal(parseMacosIdleSeconds('  12.345\n'), 12345)
  assert.equal(parseMacosIdleSeconds('0.4'), 400)
})

test('macOS：空产出 / 非数字 / 负值一律 null（不猜值）', () => {
  assert.equal(parseMacosIdleSeconds(''), null)
  assert.equal(parseMacosIdleSeconds('   '), null)
  assert.equal(parseMacosIdleSeconds('not-a-number'), null)
  assert.equal(parseMacosIdleSeconds('-1'), null)
})

test('Windows：毫秒原样，0xFFFFFFFF（API 失败哨兵）与非法值 → null', () => {
  assert.equal(parseWindowsIdleMs('0'), 0)
  assert.equal(parseWindowsIdleMs('4200'), 4200)
  assert.equal(parseWindowsIdleMs(' 99 \n'), 99)
  assert.equal(parseWindowsIdleMs('4294967295'), null) // 0xFFFFFFFF
  assert.equal(parseWindowsIdleMs('0xFFFFFFFF'), null)
  assert.equal(parseWindowsIdleMs('NaN'), null)
  assert.equal(parseWindowsIdleMs(''), null)
  assert.equal(parseWindowsIdleMs('-5'), null)
})

test('部分解析必须被拒——parseInt/parseFloat 会把失败读成有效值', () => {
  // parseInt('0xFFFFFFFF', 10) === 0；parseFloat('2.5abc') === 2.5。若放过，
  // 前者被读成「用户刚刚在动」→ 让出护栏反转成永久让出。
  assert.equal(parseWindowsIdleMs('12abc'), null, '12abc 不得被读成 12')
  assert.equal(parseMacosIdleSeconds('2.5abc'), null, '2.5abc 不得被读成 2.5s')
  assert.equal(parseMacosIdleSeconds('1e3'), null, '科学计数法不是 CGEventSource 的输出形态，拒掉不猜')
})

// ── null 语义（护栏失效方向） ──────────────────────────────────────

test('isUserActive：null = 无法检测 → false（不阻断），绝不当 0 处理', () => {
  assert.equal(isUserActive(null, 1200), false, 'null 必须放行，否则护栏一坏就锁死自动化')
  assert.equal(isUserActive(0, 1200), true, '0 是「用户刚刚在动」，应当让出')
})

test('isUserActive：阈值边界——等于阈值算不算活跃', () => {
  assert.equal(isUserActive(1199, 1200), true)
  assert.equal(isUserActive(1200, 1200), false, '恰好等于阈值视为已空闲够久')
  assert.equal(isUserActive(5000, 1200), false)
})

// ── 平台分派 ──────────────────────────────────────────────────────

test('darwin：走 osascript/JXA 的 CGEventSource，秒值转毫秒', async () => {
  const calls: Array<{ file: string; args: string[] }> = []
  const idle = await probeUserIdleMs({
    platform: 'darwin',
    exec: async (file, args) => {
      calls.push({ file, args })
      return '2.5\n'
    },
  })
  assert.equal(idle, 2500)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.file, 'osascript')
  assert.ok(calls[0]!.args.includes('-l') && calls[0]!.args.includes('JavaScript'))
  const script = calls[0]!.args.join(' ')
  assert.match(script, /CGEventSourceSecondsSinceLastEventType/, '必须真取系统输入事件时间')
  // 事件类型必须是字面量 0xFFFFFFFF：`$.kCGAnyInputEventType` 在 JXA 里是 undefined，
  // 会退化成类型 0 读到另一个时钟（原断言写的是符号常量名——名字在、值不存在，
  // 恰好是这个缺陷的藏身处）。
  assert.match(script, /4294967295/, '「任一输入事件」只能是字面量')
  assert.doesNotMatch(script, /kCGAnyInputEventType/, '求值为 undefined 的符号常量不得出现')
})

test('win32：走 PowerShell + GetLastInputInfo，毫秒原样', async () => {
  const calls: Array<{ file: string; args: string[] }> = []
  const idle = await probeUserIdleMs({
    platform: 'win32',
    exec: async (file, args) => {
      calls.push({ file, args })
      return '3300'
    },
  })
  assert.equal(idle, 3300)
  assert.equal(calls[0]!.file, 'powershell')
  assert.match(calls[0]!.args.join(' '), /GetLastInputInfo/)
})

test('其他平台：显式 null，且不启动任何子进程', async () => {
  let called = false
  const idle = await probeUserIdleMs({
    platform: 'linux',
    exec: async () => {
      called = true
      return '0'
    },
  })
  assert.equal(idle, null)
  assert.equal(called, false, '不支持的平台不该猜一个值，也不该起进程')
})

test('探测失败（超时/命令不存在/非零退出）→ null，绝不抛给调用方', async () => {
  const idle = await probeUserIdleMs({
    platform: 'darwin',
    exec: async () => {
      throw new Error('spawn osascript ENOENT')
    },
  })
  assert.equal(idle, null)
})

test('探测输出非法 → null（护栏宁可不阻断也不误判）', async () => {
  const idle = await probeUserIdleMs({ platform: 'darwin', exec: async () => '' })
  assert.equal(idle, null)
})

// ── 真实探测（不注入 exec） ────────────────────────────────────────
// 上面每一条都注入 exec——它们只证明「解析」对，不证明「脚本跑得起来」。
// 2026-09-21 实测教训：脚本里的 `$.kCGAnyInputEventType` 在 JXA 里是 `undefined`，
// 实参退化成事件类型 0，读到的是**另一个时钟**（同一瞬间 37.137s vs 32.508s），
// 而护栏只在 idle < 阈值时让出——读数偏大 = 该让出时放行 = 护栏静默失效。
// 只断言脚本文本里出现某个常量名，恰好放过了这个缺陷（名字在，值是 undefined）。
describe('真实探测——不起 mock，脚本必须在本机真能取值', () => {
  test(
    'darwin：probeUserIdleMs() 返回有限非负数，而不是 null',
    { skip: process.platform !== 'darwin' ? 'only meaningful on darwin' : false },
    async () => {
      const idle = await probeUserIdleMs()
      assert.ok(
        idle !== null && Number.isFinite(idle) && idle >= 0,
        `探测必须返回有限非负数；实际 ${String(idle)}（null = 护栏静默失效：脚本形态或常量在 JXA 里求值失败，且不会报错）`,
      )
    },
  )

  test('脚本只用 JXA 里真实存在的名字——不得出现求值为 undefined 的符号常量', () => {
    // 本机实测：typeof $.kCGAnyInputEventType === 'undefined'（kCGEventSourceStateHIDSystemState 反而是 '1'）。
    assert.doesNotMatch(MACOS_IDLE_JXA_SCRIPT, /kCGAnyInputEventType/)
    assert.match(MACOS_IDLE_JXA_SCRIPT, /4294967295/, '「任一输入事件」必须写成字面量 0xFFFFFFFF')
    assert.match(MACOS_IDLE_JXA_SCRIPT, /CGEventSourceSecondsSinceLastEventType/)
  })

  test('pro 的 macos driver 复用同一常量——两处脚本不得再分叉', () => {
    const driverSrc = readFileSync(new URL('../../pro/computer-use/macos-driver.ts', import.meta.url), 'utf8')
    assert.match(driverSrc, /\bMACOS_IDLE_JXA_SCRIPT\b/, 'driver 必须引用单源常量')
    assert.doesNotMatch(
      driverSrc,
      /\$\.CGEventSourceSecondsSinceLastEventType\(/,
      'driver 不得内联自己的取数脚本——两侧读同一个时钟是这个护栏的前提',
    )
  })
})
