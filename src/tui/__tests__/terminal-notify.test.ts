import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bel,
  notifySequence,
  osc9,
  osc777,
  resolveOscMode,
  sanitizeTerminalText,
  terminalSupportsOsc,
  wrapTmux,
} from '../engine/terminal-notify.js'

const ESC = '\x1b'
const BEL = '\x07'

test('sanitizeTerminalText 剥掉 C0/C1 控制字符（防转义注入）', () => {
  // ESC 与 BEL（都是注入载体）必须消失
  assert.equal(sanitizeTerminalText(`a${ESC}]9;evil${BEL}b`), 'a ]9;evil b')
  assert.equal(sanitizeTerminalText('ok 正常文本'), 'ok 正常文本')
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(sanitizeTerminalText('\x00\x01\x1f\x7f\x80\x9f')))
})

test('osc9 / osc777 / bel 逐字节形态', () => {
  assert.equal(osc9('hi'), `${ESC}]9;hi${BEL}`)
  assert.equal(osc777('标题', '正文'), `${ESC}]777;notify;标题;正文${BEL}`)
  assert.equal(bel(), BEL)
})

test('osc9/osc777 对消息里的 ESC/BEL 消毒后再入序列', () => {
  assert.equal(osc9(`x${ESC}${BEL}`), `${ESC}]9;x  ${BEL}`)
  assert.ok(!osc777(`t${ESC}`, `b${BEL}`).includes(`t${ESC}`))
})

test('wrapTmux 信封形态：ESC Ptmux; ESC 原序列 ESC \\', () => {
  assert.equal(wrapTmux('X'), `${ESC}Ptmux;${ESC}X${ESC}\\`)
})

test('resolveOscMode：off/9/777/both 显式值，其余（含缺省）一律 auto', () => {
  assert.equal(resolveOscMode('off'), 'off')
  assert.equal(resolveOscMode('0'), 'off')
  assert.equal(resolveOscMode('9'), '9')
  assert.equal(resolveOscMode('777'), '777')
  assert.equal(resolveOscMode('both'), 'both')
  assert.equal(resolveOscMode('AUTO'), 'auto')
  assert.equal(resolveOscMode(undefined), 'auto')
  assert.equal(resolveOscMode('wat'), 'auto')
})

test('terminalSupportsOsc：只认已知支持 OSC 的终端白名单', () => {
  assert.equal(terminalSupportsOsc('iTerm.app'), true)
  assert.equal(terminalSupportsOsc('WezTerm'), true)
  assert.equal(terminalSupportsOsc('Konsole'), true)
  assert.equal(terminalSupportsOsc('Apple_Terminal'), false)
  assert.equal(terminalSupportsOsc(undefined), false)
})

test('notifySequence：off 不发；auto 未识别终端不发（绝不盲发）', () => {
  assert.equal(notifySequence({ title: 't', body: 'b' }, { env: { RIVET_NOTIFY_OSC: 'off' } }), '')
  assert.equal(notifySequence({ title: 't', body: 'b' }, { env: { TERM_PROGRAM: 'Apple_Terminal' } }), '')
  assert.equal(notifySequence({ title: 't', body: 'b' }, { env: {} }), '')
})

test('notifySequence：auto + iTerm 发 OSC 9（标题 — 正文合成一段）', () => {
  const seq = notifySequence(
    { title: '天枢 · 任务完成', body: '2m · 1.2k tok' },
    { env: { TERM_PROGRAM: 'iTerm.app' } },
  )
  assert.equal(seq, `${ESC}]9;天枢 · 任务完成 — 2m · 1.2k tok${BEL}`)
})

test('notifySequence：777 与 both 模式', () => {
  assert.equal(
    notifySequence({ title: 't', body: 'b' }, { env: { RIVET_NOTIFY_OSC: '777' } }),
    `${ESC}]777;notify;t;b${BEL}`,
  )
  const both = notifySequence({ title: 't', body: 'b' }, { env: { RIVET_NOTIFY_OSC: 'both' } })
  assert.ok(both.startsWith(`${ESC}]777;notify;t;b${BEL}`), 'both 先发 777')
  assert.ok(both.includes(`${ESC}]9;t — b${BEL}`), 'both 同时发 9（终端只认其一）')
})

test('notifySequence：tmux 内包 passthrough 信封', () => {
  const seq = notifySequence(
    { title: 't', body: 'b' },
    { env: { RIVET_NOTIFY_OSC: '9', TMUX: '/tmp/tmux-1000/default,123,0' } },
  )
  assert.equal(seq, `${ESC}Ptmux;${ESC}${ESC}]9;t — b${BEL}${ESC}\\`)
})
