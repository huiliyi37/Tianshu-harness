import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { InputHandler, type KeyPress } from '../input-handler.js'
import type { ReadStream } from 'node:tty'

/** 最小 stdin mock：满足 InputHandler 构造期调用，并能注入 data。 */
function makeStdin(): ReadStream & { emitData(s: string): void } {
  const ee = new EventEmitter() as unknown as ReadStream & { emitData(s: string): void }
  ;(ee as unknown as { setRawMode: () => void }).setRawMode = () => {}
  ;(ee as unknown as { resume: () => void }).resume = () => {}
  ;(ee as unknown as { pause: () => void }).pause = () => {}
  ;(ee as unknown as { setEncoding: () => void }).setEncoding = () => {}
  ;(ee as { emitData(s: string): void }).emitData = (s: string) => ee.emit('data', s)
  return ee
}

describe('InputHandler · escape timeout dispatch (B1)', () => {
  it('lone ESC dispatches escape after timeout', async () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin, escapeTimeoutMs: 20 })
    let escapes = 0
    handler.onKey('escape', () => { escapes++ })

    stdin.emitData('\x1B')
    assert.equal(escapes, 0, 'no immediate dispatch — still buffered')
    await delay(40)
    assert.equal(escapes, 1, 'escape dispatched after timeout')
    handler.dispose()
  })

  it('ESC followed quickly by [A parses as up (not escape)', async () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin, escapeTimeoutMs: 50 })
    let escapes = 0
    let ups = 0
    handler.onKey('escape', () => { escapes++ })
    handler.onKey('up', () => { ups++ })

    stdin.emitData('\x1B')
    stdin.emitData('[A')
    await delay(80)
    assert.equal(ups, 1, 'arrow up dispatched')
    assert.equal(escapes, 0, 'no spurious escape')
    handler.dispose()
  })

  it('dispose clears a pending escape timer (no late dispatch)', async () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin, escapeTimeoutMs: 20 })
    let escapes = 0
    handler.onKey('escape', () => { escapes++ })
    stdin.emitData('\x1B')
    handler.dispose()
    await delay(40)
    assert.equal(escapes, 0, 'disposed before timer fired')
  })
})

describe('InputHandler · bracketed paste (C1)', () => {
  it('emits paste content without triggering return/submit', async () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    let pasted: string | null = null
    let returns = 0
    handler.onPaste((t) => { pasted = t })
    handler.onKey('return', () => { returns++ })

    stdin.emitData('\x1B[200~line1\nline2\x1B[201~')
    assert.equal(pasted, 'line1\nline2')
    assert.equal(returns, 0, 'no submit during paste')
    handler.dispose()
  })

  it('normalizes CR / CRLF to LF', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    let pasted: string | null = null
    handler.onPaste((t) => { pasted = t })

    stdin.emitData('\x1B[200~a\r\nb\rc\x1B[201~')
    assert.equal(pasted, 'a\nb\nc')
    handler.dispose()
  })

  it('buffers paste across chunks', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    let pasted: string | null = null
    handler.onPaste((t) => { pasted = t })

    stdin.emitData('\x1B[200~hello ')
    assert.equal(pasted, null, 'not emitted until end marker')
    stdin.emitData('world\x1B[201~')
    assert.equal(pasted, 'hello world')
    handler.dispose()
  })

  it('processes a normal key after the paste end marker', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    let pasted: string | null = null
    let returns = 0
    handler.onPaste((t) => { pasted = t })
    handler.onKey('return', () => { returns++ })

    stdin.emitData('\x1B[200~text\x1B[201~\r')
    assert.equal(pasted, 'text')
    assert.equal(returns, 1, 'trailing CR after paste submits')
    handler.dispose()
  })

  it('buffers split paste start marker across chunks', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    let pasted: string | null = null
    let keys = 0
    handler.onPaste((t) => { pasted = t })
    handler.onAnyKey(() => { keys++ })

    stdin.emitData('\x1B[200')
    assert.equal(pasted, null, 'start marker incomplete — no paste')
    assert.equal(keys, 0, 'no spurious keys from partial marker')

    stdin.emitData('~split-start\x1B[201~')
    assert.equal(pasted, 'split-start', 'paste assembled across start-marker boundary')
    assert.equal(keys, 0, 'still no regular keys')
    handler.dispose()
  })

  it('buffers split paste end marker across chunks', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    let pasted: string | null = null
    let returns = 0
    handler.onPaste((t) => { pasted = t })
    handler.onKey('return', () => { returns++ })

    stdin.emitData('\x1B[200~split-end\x1B[201')
    assert.equal(pasted, null, 'end marker incomplete — paste held')

    stdin.emitData('~\r')
    assert.equal(pasted, 'split-end', 'paste closed across end-marker boundary')
    assert.equal(returns, 1, 'trailing CR after paste submits')
    handler.dispose()
  })
})

describe('InputHandler · multi-sequence chunks (领航星 2026-06-11 UX)', () => {
  it('parses two arrow keys in one chunk', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: string[] = []
    handler.onAnyKey((k) => { keys.push(k.name) })

    stdin.emitData('\x1B[A\x1B[B')
    assert.deepEqual(keys, ['up', 'down'], 'each arrow key dispatched separately')
    handler.dispose()
  })

  it('parses escape sequence followed by printable char in one chunk', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: string[] = []
    handler.onAnyKey((k) => { keys.push(k.name) })

    stdin.emitData('\x1B[Aa')
    assert.deepEqual(keys, ['up', 'unknown'], 'arrow key then normal char')
    handler.dispose()
  })
})

describe('InputHandler · surrogate-pair chunk buffering (领航星 2026-06-11 UX)', () => {
  it('assembles a split emoji surrogate pair across two data chunks', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const chars: string[] = []
    handler.onAnyKey((k) => { if (k.char) chars.push(k.char) })

    // 终端流量控制 / 高频输入下，😀 (\uD83D\uDE00) 可能被拆成两段。
    // 旧实现会把第一段当孤立高代理派发，输入框渲染豆腐方块。
    // 新行为：第一段先 buffer，不派发；合并第二段后整体派发。
    stdin.emitData('\uD83D')  // 高代理
    assert.deepEqual(chars, [], 'lone high surrogate must not dispatch')

    stdin.emitData('\uDE00')  // 低代理
    assert.deepEqual(chars, ['\uD83D\uDE00'], 'assembled emoji dispatched as one char')
    handler.dispose()
  })

  it('a normal key after a buffered surrogate still dispatches', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const chars: string[] = []
    handler.onAnyKey((k) => { if (k.char) chars.push(k.char) })

    stdin.emitData('\uD83D')        // buffer
    stdin.emitData('\uDE00a')       // 完成 emoji + 接一个 'a'
    assert.deepEqual(chars, ['\uD83D\uDE00', 'a'])
    handler.dispose()
  })

  it('dispose clears pending surrogate buffer (no late dispatch)', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const chars: string[] = []
    handler.onAnyKey((k) => { if (k.char) chars.push(k.char) })

    stdin.emitData('\uD83D')  // buffered
    handler.dispose()
    // 模拟上游在 dispose 后又来了一段——应当无副作用
    stdin.emitData('\uDE00')
    assert.deepEqual(chars, [])
  })
})

describe('InputHandler · Shift+Tab and Alt+letter (领航星 2026-06-28)', () => {
  it('parses Shift+Tab (\\x1B[Z) as shift_tab', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    handler.onAnyKey((k) => { keys.push(k) })

    stdin.emitData('\x1B[Z')
    assert.equal(keys.length, 1, 'one key dispatched')
    assert.equal(keys[0]!.name, 'shift_tab')
    assert.equal(keys[0]!.shift, true)
    handler.dispose()
  })

  it('parses Shift+Enter modifyOtherKeys (\\x1B[13;2u) as return with shift=true', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    handler.onAnyKey((k) => { keys.push(k) })

    stdin.emitData('\x1B[13;2u')
    assert.equal(keys.length, 1, 'one key dispatched')
    assert.equal(keys[0]!.name, 'return')
    assert.equal(keys[0]!.shift, true)
    assert.equal(keys[0]!.ctrl, false)
    assert.equal(keys[0]!.meta, false)
    handler.dispose()
  })

  it('Shift+Enter modifyOtherKeys split across chunks assembles correctly', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    handler.onAnyKey((k) => { keys.push(k) })

    stdin.emitData('\x1B[13')
    assert.equal(keys.length, 0, 'incomplete sequence held for more bytes')
    stdin.emitData(';2u')
    assert.equal(keys.length, 1, 'assembled after second chunk')
    assert.equal(keys[0]!.name, 'return')
    assert.equal(keys[0]!.shift, true)
    handler.dispose()
  })

  it('modifyOtherKeys with Alt modifier (\\x1B[13;3u) parses code then meta', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    handler.onAnyKey((k) => { keys.push(k) })

    stdin.emitData('\x1B[13;3u')
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.name, 'return')
    assert.equal(keys[0]!.meta, true, 'modifier 3 = Alt')
    handler.dispose()
  })

  it('non-Enter modifyOtherKeys code (\\x1B[9;2u = Tab+Shift) not dispatched as return', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    handler.onAnyKey((k) => { keys.push(k) })

    stdin.emitData('\x1B[9;2u')
    assert.equal(keys.length, 1)
    assert.notEqual(keys[0]!.name, 'return', 'code 9 is Tab, not Enter')
    handler.dispose()
  })

  it('parses Alt+f (\\x1Bf) as meta=true', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    handler.onAnyKey((k) => { keys.push(k) })

    stdin.emitData('\x1Bf')
    assert.equal(keys.length, 1, 'one key dispatched')
    assert.equal(keys[0]!.char, 'f')
    assert.equal(keys[0]!.meta, true, 'Alt key should set meta=true')
    assert.equal(keys[0]!.ctrl, false)
    handler.dispose()
  })

  it('parses Alt+Shift+F (\\x1BF) as meta=true shift=true', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    handler.onAnyKey((k) => { keys.push(k) })

    stdin.emitData('\x1BF')
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.char, 'F')
    assert.equal(keys[0]!.meta, true)
    assert.equal(keys[0]!.shift, true, 'uppercase implies shift')
    handler.dispose()
  })

  it('Alt+digit parses correctly (\\x1B1 → char=1 meta=true)', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    handler.onAnyKey((k) => { keys.push(k) })

    stdin.emitData('\x1B1')
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.char, '1')
    assert.equal(keys[0]!.meta, true)
    handler.dispose()
  })

  it('Alt+Enter ESC+CR (\\x1B\\x0D) parses as return with meta=true', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    handler.onAnyKey((k) => { keys.push(k) })

    stdin.emitData('\x1B\r')
    assert.equal(keys.length, 1, 'one key dispatched')
    assert.equal(keys[0]!.name, 'return', 'ESC+CR → return')
    assert.equal(keys[0]!.meta, true, 'Alt modifier → meta=true')
    assert.equal(keys[0]!.char, '', 'no printable char for return')
    handler.dispose()
  })
})

describe('InputHandler · kitty CSI-u 全量解码（flag 1 后所有非文本键的编码形态）', () => {
  // start() 发 \x1B[>1u 后，kitty/Ghostty/WezTerm/Alacritty/WT 1.22+ 把所有
  // 不产生文本的键改用 CSI u 编码。旧实现只认 13;2u/9;2u 两形，其余落
  // unknown——Esc/Ctrl+C/Ctrl+P/Ctrl+J 控制面整体失效（2026-09-09 审查 P1）。
  function collect(): { stdin: ReturnType<typeof makeStdin>; handler: InputHandler; keys: KeyPress[] } {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    handler.onAnyKey((k) => { keys.push(k) })
    return { stdin, handler, keys }
  }

  it('Esc (\\x1B[27u) → escape（非 unknown）', () => {
    const { stdin, handler, keys } = collect()
    stdin.emitData('\x1B[27u')
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.name, 'escape')
    handler.dispose()
  })

  it('Ctrl+C (\\x1B[99;5u) → ctrl_c 且 ctrl=true（打断链路保命键）', () => {
    const { stdin, handler, keys } = collect()
    stdin.emitData('\x1B[99;5u')
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.name, 'ctrl_c')
    assert.equal(keys[0]!.ctrl, true)
    handler.dispose()
  })

  it('Ctrl+J (\\x1B[106;5u) → ctrl_j（换行提示承诺的键位）', () => {
    const { stdin, handler, keys } = collect()
    stdin.emitData('\x1B[106;5u')
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.name, 'ctrl_j')
    assert.equal(keys[0]!.ctrl, true)
    handler.dispose()
  })

  it('Ctrl+P (\\x1B[112;5u) → ctrl_p（命令面板）', () => {
    const { stdin, handler, keys } = collect()
    stdin.emitData('\x1B[112;5u')
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.name, 'ctrl_p')
    handler.dispose()
  })

  it('Ctrl+I (\\x1B[105;5u) → tab——CTRL_CODES 单源映射自动对齐历史同码语义', () => {
    const { stdin, handler, keys } = collect()
    stdin.emitData('\x1B[105;5u')
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.name, 'tab')
    assert.equal(keys[0]!.ctrl, true)
    handler.dispose()
  })

  it('Ctrl+M (\\x1B[109;5u) → return（Enter 与 Ctrl+M 同键）', () => {
    const { stdin, handler, keys } = collect()
    stdin.emitData('\x1B[109;5u')
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.name, 'return')
    handler.dispose()
  })

  it('Backspace (\\x1B[127u) → backspace', () => {
    const { stdin, handler, keys } = collect()
    stdin.emitData('\x1B[127u')
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.name, 'backspace')
    handler.dispose()
  })

  it('Ctrl+Shift+A (\\x1B[97;6u) → ctrl_a 且 shift=true（mods 6 = shift+ctrl）', () => {
    const { stdin, handler, keys } = collect()
    stdin.emitData('\x1B[97;6u')
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.name, 'ctrl_a')
    assert.equal(keys[0]!.ctrl, true)
    assert.equal(keys[0]!.shift, true)
    handler.dispose()
  })

  it('修饰位含 Alt（\\x1B[99;7u = ctrl+alt+c）→ meta=true', () => {
    const { stdin, handler, keys } = collect()
    stdin.emitData('\x1B[99;7u')
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.name, 'ctrl_c')
    assert.equal(keys[0]!.ctrl, true)
    assert.equal(keys[0]!.meta, true)
    handler.dispose()
  })
})

describe('InputHandler · CPR（cursor position report）通道', () => {
  it('\\x1B[{row};{col}R 路由给 onCpr，不产生按键', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    const reports: Array<[number, number]> = []
    handler.onAnyKey((k) => { keys.push(k) })
    handler.onCpr((row, col) => { reports.push([row, col]) })

    stdin.emitData('\x1B[24;80R')
    assert.deepEqual(reports, [[24, 80]])
    assert.equal(keys.length, 0, 'CPR 不应作为按键派发')
    handler.dispose()
  })

  it('跨 chunk 拆分的 CPR 序列缓冲后完整解析', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const reports: Array<[number, number]> = []
    handler.onCpr((row, col) => { reports.push([row, col]) })

    stdin.emitData('\x1B[24;')
    assert.equal(reports.length, 0, '未完整序列不应提前解析')
    stdin.emitData('8R')
    assert.deepEqual(reports, [[24, 8]])
    handler.dispose()
  })

  it('夹在按键流中的 CPR 只消费不派发，前后按键不受影响', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    const reports: Array<[number, number]> = []
    handler.onAnyKey((k) => { keys.push(k) })
    handler.onCpr((row, col) => { reports.push([row, col]) })

    stdin.emitData('a\x1B[10;5Rb')
    assert.deepEqual(reports, [[10, 5]])
    assert.equal(keys.length, 2)
    assert.equal(keys[0]!.char, 'a')
    assert.equal(keys[1]!.char, 'b')
    handler.dispose()
  })
})

describe('InputHandler · kitty 能力查询回包通道', () => {
  it('\\x1B[?<flags>u 路由给 onKittyFlags，不作为按键派发', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    const flagsSeen: number[] = []
    handler.onAnyKey((k) => { keys.push(k) })
    handler.onKittyFlags((f) => { flagsSeen.push(f) })

    stdin.emitData('\x1B[?1u')
    assert.deepEqual(flagsSeen, [1], '回包 flags 应路由到专用通道')
    assert.equal(keys.length, 0, '能力回包不是用户按键')
    handler.dispose()
  })

  it('夹在按键流中的回包只消费不派发，前后按键不受影响', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    const flagsSeen: number[] = []
    handler.onAnyKey((k) => { keys.push(k) })
    handler.onKittyFlags((f) => { flagsSeen.push(f) })

    stdin.emitData('a\x1B[?1ub')
    assert.deepEqual(flagsSeen, [1])
    assert.equal(keys.length, 2)
    assert.equal(keys[0]!.char, 'a')
    assert.equal(keys[1]!.char, 'b')
    handler.dispose()
  })
})

describe('InputHandler · 粘贴控制符过滤（P1-3）', () => {
  it('剥离 ESC 与 C0 控制符，保留 \\n \\t 与 CJK', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    let pasted: string | null = null
    handler.onPaste((t) => { pasted = t })

    stdin.emitData('\x1B[200~a\x1B[31m红\x07b\n\ttail\x01\x1B[201~')
    assert.equal(pasted, 'a[31m红b\n\ttail', 'ESC/\\x07/\\x01 被剥离，ESC 后的 [31m 退化为纯文本')
    handler.dispose()
  })
})

describe('InputHandler · 不完整 CSI 超时兜底（P1-4）', () => {
  it('半个 CSI 超时后按 unknown 消费首字节，后续按键不卡死', async () => {
    const stdin = makeStdin()
    // 不完整 CSI 走独立的 partialSequenceTimeoutMs（默认 500ms，与 ESC 响应速度解耦）
    const handler = new InputHandler({ stdin, escapeTimeoutMs: 20, partialSequenceTimeoutMs: 20 })
    const keys: KeyPress[] = []
    handler.onKey('*', (k) => keys.push(k))

    stdin.emitData('\x1B[')
    await delay(50)
    const tombstone = keys.filter(k => k.raw === '\x1B')
    assert.equal(tombstone.length, 1, '滞留的半个 CSI 超时被消费（ESC 墓碑）')

    stdin.emitData('x')
    await delay(10)
    assert.ok(keys.some(k => k.char === 'x'), '后续普通按键不被卡死')
    handler.dispose()
  })

  it('正常分 chunk 的完整序列不误触发兜底', async () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin, escapeTimeoutMs: 50, partialSequenceTimeoutMs: 50 })
    const keys: KeyPress[] = []
    handler.onKey('*', (k) => keys.push(k))

    stdin.emitData('\x1B[')
    stdin.emitData('A') // 方向键序列分两块背靠背到达
    await delay(80)
    assert.ok(keys.some(k => k.name === 'up'), '完整序列解析为 up')
    assert.ok(!keys.some(k => k.raw === '\x1B' && k.name === 'unknown'), '不得产生 ESC 墓碑')
    handler.dispose()
  })

  it('不完整 CSI 的兜底超时与 ESC 响应速度解耦（默认值分离）', async () => {
    const stdin = makeStdin()
    // 只给 ESC 20ms，partial 用默认 500ms：半截 CSI 在 ESC 超时窗口内不该被腰斩。
    const handler = new InputHandler({ stdin, escapeTimeoutMs: 20 })
    const keys: KeyPress[] = []
    handler.onKey('*', (k) => keys.push(k))

    stdin.emitData('\x1B[')
    await delay(60) // 远超 escapeTimeoutMs，但远小于 partialSequenceTimeoutMs
    assert.equal(keys.length, 0, `ESC 超时不应触发 CSI 兜底: ${JSON.stringify(keys)}`)

    stdin.emitData('A') // 慢到达的后半截仍应拼成完整序列
    await delay(10)
    assert.ok(keys.some(k => k.name === 'up'), '延迟到达的序列仍正确解析为 up')
    handler.dispose()
  })
})

/**
 * CPR（cursor position report）是终端对 DSR `\x1B[6n` 探针的自动回吐，不是用户
 * 按键。它一旦被超时兜底腰斩，残体绝不能退化成可打印字符——那正是用户在输入框里
 * 看到 `[66;` 的成因（按 ESC 打断时 handleAbort 会重绘并新发探针，与按键撞车）。
 */
describe('InputHandler · CPR 残体不泄漏进按键流', () => {
  it('被截断的 CPR 超时后整段丢弃，不产生任何按键', async () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin, escapeTimeoutMs: 20, partialSequenceTimeoutMs: 20 })
    const keys: KeyPress[] = []
    handler.onKey('*', (k) => keys.push(k))

    stdin.emitData('\x1B[66;') // CPR 少了结尾的 R
    await delay(50)
    assert.equal(keys.length, 0, `CPR 残体不得产生按键: ${JSON.stringify(keys.map(k => k.char || k.name))}`)

    stdin.emitData('x')
    await delay(10)
    assert.deepEqual(keys.map(k => k.char), ['x'], '丢弃残体后后续按键正常')
    handler.dispose()
  })

  it('多种截断位置都不泄漏（\\x1B[66 / \\x1B[66; / \\x1B[66;1）', async () => {
    for (const partial of ['\x1B[66', '\x1B[66;', '\x1B[66;1']) {
      const stdin = makeStdin()
      const handler = new InputHandler({ stdin, escapeTimeoutMs: 20, partialSequenceTimeoutMs: 20 })
      const keys: KeyPress[] = []
      handler.onKey('*', (k) => keys.push(k))

      stdin.emitData(partial)
      await delay(50)
      assert.equal(keys.length, 0, `${JSON.stringify(partial)} 泄漏了按键: ${JSON.stringify(keys.map(k => k.char || k.name))}`)
      handler.dispose()
    }
  })

  it('完整 CPR 仍走 cpr 通道且不产生按键', async () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin, escapeTimeoutMs: 20, partialSequenceTimeoutMs: 20 })
    const keys: KeyPress[] = []
    const cprs: Array<[number, number]> = []
    handler.onKey('*', (k) => keys.push(k))
    handler.onCpr((row, col) => cprs.push([row, col]))

    stdin.emitData('\x1B[66;1R')
    await delay(10)
    assert.deepEqual(cprs, [[66, 1]], 'CPR 正常上报')
    assert.equal(keys.length, 0, 'CPR 不产生按键')
    handler.dispose()
  })
})
