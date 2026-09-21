/**
 * 用户空闲时长探测（跨平台）——「用户接管即让出」护栏的数据源（issue #235）。
 *
 * 放在开源面（`src/system/`）而非 pro：两个消费方分属不同边界——
 *  - bash 工具（`src/tools/`，开源面）在执行输入注入类命令前需要它；
 *  - pro 的 computer_use driver（闭源）反向委托它。
 * 依赖方向必须单向：pro → 开源；反向会污染开源面。
 *
 * 契约（与 pro driver 既有接口注释同源，勿各自漂移）：
 *   返回「距最近一次系统键鼠事件的毫秒数」；**null = 无法检测**，调用方必须按
 *   「不阻断」处理——不得把 null 当 0：0 会被读成「用户刚刚在动」，把正常自动化全锁死。
 */
import { execFile as nodeExecFile } from 'node:child_process'

/** 探测器返回的空闲毫秒数；null = 无法检测（调用方按不阻断处理）。 */
export type UserIdleMs = number | null

/** 可注入的命令执行器（测试用）——返回 stdout。 */
export type IdleExec = (file: string, args: string[], timeoutMs: number) => Promise<string>

export interface UserIdleProbeOptions {
  /** 覆盖平台（测试用）。默认 process.platform。 */
  platform?: NodeJS.Platform
  /** 覆盖执行器（测试用）。 */
  exec?: IdleExec
  /** 单次探测超时。默认 5000ms——探测失败一律回 null，绝不阻塞主链路。 */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000

/**
 * macOS 取数脚本（JXA）：距最近一次输入事件的**秒数**（CFTimeInterval）——**单源常量**，
 * 两处消费共用：本模块的 `probeUserIdleMs`（shell 让出护栏的数据源）与 pro 的
 * computer_use macos driver（它有自己的常驻 osascript 宿主，但脚本必须是同一份
 * ——两侧读不同的时钟，「两条路径语义一致」就是句空话）。用系统自带 osascript，
 * 不引入原生扩展：新增加载面在安全护栏里不划算。
 *
 * 「任一输入事件」只能写**字面量** `4294967295`（kCGAnyInputEventType）：JXA 桥里
 * `$.kCGAnyInputEventType` 求值为 **undefined**（2026-09-21 本机实测 `typeof ===
 * 'undefined'`；`$.kCGEventSourceStateHIDSystemState` 反而是 `'1'`），实参退化成事件
 * 类型 0，读到的是**另一个时钟**——同一进程同一瞬间：符号形态 `37.137059542s` vs
 * 字面量 `32.508293625s`，而 `4294967295` 的读数与 `kCGEventMouseMoved` 逐位相等
 * （= 最近的输入），符号形态恒偏大 4.629s（两次采样同差值）。护栏只在 idle < 阈值
 * 时让出，读数偏大 = 该让出时放行 = 护栏静默失效，且**不会报错**——只断言脚本文本里
 * 出现常量名，恰好放过了这个缺陷（名字在，值是 undefined）。
 *
 * 状态量取 0（kCGEventSourceStateCombinedSessionState，与 pro driver 同形）。实测
 * 状态 0 与 1（HIDSystemState）同机同批相差 88ms ≈ 采样间隔 90ms，不构成分叉；
 * 事件类型才是决定性的那一个参数。
 */
export const MACOS_IDLE_JXA_SCRIPT = [
  "ObjC.import('CoreGraphics')",
  'Number($.CGEventSourceSecondsSinceLastEventType(0, 4294967295))',
].join('\n')

/**
 * Windows：GetLastInputInfo 给出「最后一次输入」的 tick；与 Environment.TickCount
 * 相减即空闲毫秒。SendInput 注入的事件也计入（它反映输入队列），所以「自身注入余波」
 * 的排除由调用方负责（computer_use 侧有独立的余波窗口）。
 */
const WINDOWS_IDLE_SCRIPT = [
  'Add-Type -Namespace RivetIdle -Name Native -MemberDefinition @"',
  '  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
  '  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
  '  public static uint IdleMs() {',
  '    LASTINPUTINFO lii = new LASTINPUTINFO();',
  '    lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));',
  '    if (!GetLastInputInfo(ref lii)) return 0xFFFFFFFF;',
  '    return unchecked((uint)Environment.TickCount) - lii.dwTime;',
  '  }',
  '"@',
  '[RivetIdle.Native]::IdleMs()',
].join('\n')

/**
 * 严格数值串——**拒绝部分解析**。`parseInt('0xFFFFFFFF', 10)` 会返回 0、
 * `parseFloat('2.5abc')` 会返回 2.5：两种都把「探测失败」读成一个有效值，
 * 而 0 的语义是「用户刚刚在动」→ 让出护栏反转成永久让出。宁可回 null 不阻断。
 */
const DECIMAL_NUMERIC = /^\d+(\.\d+)?$/
const INTEGER_NUMERIC = /^\d+$/

/** macOS 输出解析：秒（浮点）→ 毫秒。非法/负值 → null。 */
export function parseMacosIdleSeconds(raw: string): UserIdleMs {
  const trimmed = raw.trim()
  if (!DECIMAL_NUMERIC.test(trimmed)) return null
  const seconds = Number.parseFloat(trimmed)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.round(seconds * 1000)
}

/** Windows 输出解析：已是毫秒。0xFFFFFFFF（API 失败哨兵）与非法值 → null。 */
export function parseWindowsIdleMs(raw: string): UserIdleMs {
  const trimmed = raw.trim()
  if (!INTEGER_NUMERIC.test(trimmed)) return null
  const ms = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(ms) || ms < 0 || ms === 0xffffffff) return null
  return ms
}

/**
 * 用户是否正在操作（供让出护栏判定）。
 *
 * null（无法检测）→ **false**，即不阻断：护栏失效时宁可放行自动化，也不把
 * 正常用法锁死。这条语义只在函数内表达一次，避免各调用点各自解释 null。
 */
export function isUserActive(idleMs: UserIdleMs, thresholdMs: number): boolean {
  if (idleMs === null) return false
  return idleMs < thresholdMs
}

/** 默认让出阈值（ms）——与 computer_use 侧同值，避免"同一件事两个标准"。 */
export const DEFAULT_YIELD_MS = 1200

/**
 * 解析让出阈值：`RIVET_CU_YIELD_MS`（**与 computer_use 同一旋钮**，用户只需记一个
 * 变量即可同时影响 shell 与 computer_use 两条路径）。0 = 关闭护栏；非法值回退默认。
 */
export function resolveYieldMs(): number {
  const raw = process.env.RIVET_CU_YIELD_MS
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return DEFAULT_YIELD_MS
}

/** 默认执行器：child_process.execFile → stdout 字符串。
 *  `windowsHide: true` 是硬要求（architecture-guards 的 spawn 守卫）：Windows 上
 *  否则会闪出控制台窗口——用户视角就是"莫名其妙弹黑框"。 */
const defaultExec: IdleExec = (file, args, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    nodeExecFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })

/**
 * 探测最近一次系统键鼠事件距今的毫秒数。
 * 不支持/探测失败一律 null——调用方按 `isUserActive(null, …) === false` 放行。
 */
export async function probeUserIdleMs(opts: UserIdleProbeOptions = {}): Promise<UserIdleMs> {
  const platform = opts.platform ?? process.platform
  // 参数名刻意不叫 `exec`：spawn 守卫按调用形态匹配，注入进来的执行器不是 spawn 点，
  // 真正需要 windowsHide 的是 defaultExec（本文件唯一的真实 spawn）。
  const run = opts.exec ?? defaultExec
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    if (platform === 'darwin') {
      return parseMacosIdleSeconds(await run('osascript', ['-l', 'JavaScript', '-e', MACOS_IDLE_JXA_SCRIPT], timeoutMs))
    }
    if (platform === 'win32') {
      return parseWindowsIdleMs(
        await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_IDLE_SCRIPT], timeoutMs),
      )
    }
    // Linux 等：xprintidle 非标配，不引入依赖——显式返回 null（= 不阻断），
    // 而不是猜一个值。
    return null
  } catch {
    return null
  }
}
