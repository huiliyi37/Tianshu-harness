import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectTerminalProfile, isCapturedPty, resolveTerminalProfile, setActiveTerminalProfile,
  type TerminalAncestor,
} from '../terminal-profile.js'

afterEach(() => setActiveTerminalProfile())

const bridge: TerminalAncestor = { name: 'bridge.exe', commandLine: 'bridge.exe --visible-attach --candidate-type windows-terminal' }
const mux: TerminalAncestor = { name: 'mux.exe', commandLine: 'mux.exe server -s session -L label -- powershell.exe -NoProfile' }

test('CLI mode overrides environment and explicit native prevents host detection', () => {
  assert.equal(resolveTerminalProfile({ args: ['--terminal-mode=native'], env: { RIVET_CAPTURED_PTY: '1' }, platform: 'win32', ancestors: [bridge, mux] }).kind, 'native')
  assert.equal(resolveTerminalProfile({ args: ['--terminal-mode', 'captured-pty'], env: { RIVET_TERMINAL_MODE: 'native' } }).kind, 'captured-pty')
  assert.equal(resolveTerminalProfile({ args: ['--terminal-mode=auto'], env: { RIVET_TERMINAL_MODE: 'native', RIVET_CAPTURED_PTY: '1' } }).kind, 'captured-pty')
})

test('host marker has an explicit opt out and native mode takes priority', () => {
  assert.equal(resolveTerminalProfile({ env: { RIVET_CAPTURED_PTY: '1' } }).kind, 'captured-pty')
  assert.equal(resolveTerminalProfile({ env: { RIVET_CAPTURED_PTY: '0' }, platform: 'win32', ancestors: [bridge, mux] }).kind, 'native')
  assert.equal(resolveTerminalProfile({ env: { RIVET_TERMINAL_MODE: 'native', RIVET_CAPTURED_PTY: '1' } }).kind, 'native')
  assert.equal(resolveTerminalProfile({ env: { RIVET_TERMINAL_MODE: 'captured-pty', RIVET_CAPTURED_PTY: '0' } }).kind, 'captured-pty')
})

test('invalid modes fail visibly and a flag after -- is a prompt argument', () => {
  assert.throws(() => resolveTerminalProfile({ args: ['--terminal-mode', 'typo'], env: {} }), /terminal mode/i)
  assert.throws(() => resolveTerminalProfile({ args: ['--terminal-mode'], env: {} }), /terminal mode/i)
  assert.throws(() => resolveTerminalProfile({ env: { RIVET_TERMINAL_MODE: 'typo' } }), /terminal mode/i)
  assert.equal(resolveTerminalProfile({ args: ['--', '--terminal-mode=captured-pty'], env: {} }).kind, 'native')
})

test('ordinary modern terminals, SSH, tmux and headless consoles stay native', () => {
  for (const env of [{ WT_SESSION: 'real' }, { COLORTERM: 'truecolor' }, { SSH_TTY: 'pty', SSH_CONNECTION: 'remote' }, { TMUX: '/tmp/mux' }, { TERM_PROGRAM: 'vscode' }, {}]) {
    assert.equal(resolveTerminalProfile({ env, platform: 'win32', ancestors: [
      { name: 'OpenConsole.exe', commandLine: 'OpenConsole.exe --headless --resizeQuirk --width 120 --height 30' },
      { name: 'conhost.exe', commandLine: 'conhost.exe --headless --width 120 --height 30' },
    ] }).kind, 'native')
  }
})

test('dedicated bridge and mux must both occur on the supplied Windows ancestor chain', () => {
  assert.equal(resolveTerminalProfile({ env: { WT_SESSION: 'inherited' }, platform: 'win32', ancestors: [bridge, mux] }).kind, 'captured-pty')
  assert.equal(resolveTerminalProfile({ env: {}, platform: 'win32', ancestors: [bridge] }).kind, 'native')
  assert.equal(resolveTerminalProfile({ env: {}, platform: 'win32', ancestors: [mux] }).kind, 'native')
  assert.equal(resolveTerminalProfile({ env: {}, platform: 'linux', ancestors: [bridge, mux] }).kind, 'native')
  assert.equal(resolveTerminalProfile({ env: {}, platform: 'win32', ancestors: [bridge, { name: 'mux.exe', commandLine: 'mux.exe attach -t session' }] }).kind, 'captured-pty')
})

test('broad names, flag substrings and shell command text cannot impersonate bridge evidence', () => {
  for (const commandLine of ['bridge.exe --visible-attachment --candidate-type windows-terminal', 'bridge.exe --visible-attach --candidate-type windows-terminal-other', 'bridge.exe --headless', 'bridge.exe "--visible-attach --candidate-type windows-terminal"']) {
    assert.equal(resolveTerminalProfile({ env: {}, platform: 'win32', ancestors: [{ name: 'bridge.exe', commandLine }, mux] }).kind, 'native')
  }
  assert.equal(resolveTerminalProfile({ env: {}, platform: 'win32', ancestors: [bridge, { name: 'cmd.exe', commandLine: 'cmd.exe /c mux.exe server -s session' }] }).kind, 'native')
  assert.equal(resolveTerminalProfile({ env: {}, platform: 'win32', ancestors: [{ name: 'mux.exe', commandLine: 'mux.exe server -s session --visible-attach --candidate-type windows-terminal' }] }).kind, 'native')
})

test('unbounded ancestor lists and oversized command lines cannot supply capture evidence', () => {
  const shell = { name: 'powershell.exe', commandLine: 'powershell.exe -NoProfile' }
  assert.equal(resolveTerminalProfile({ env: {}, platform: 'win32', ancestors: [...Array(16).fill(shell), bridge, mux] }).kind, 'native')
  assert.equal(resolveTerminalProfile({ env: {}, platform: 'win32', ancestors: [{ ...bridge, commandLine: bridge.commandLine + 'x'.repeat(5000) }, mux] }).kind, 'native')
})

test('detection never exposes ancestor command lines in its reason', () => {
  const result = resolveTerminalProfile({ env: {}, platform: 'win32', ancestors: [bridge, { ...mux, commandLine: mux.commandLine + ' sensitive-argument' }] })
  assert.equal(result.kind, 'captured-pty')
  assert.ok(!JSON.stringify(result).includes('sensitive-argument'))
})

test('active CLI/probe profile applies only to implicit process environment reads', () => {
  setActiveTerminalProfile({ kind: 'captured-pty', reason: 'test' })
  assert.equal(isCapturedPty(), true)
  assert.equal(isCapturedPty(process.env), true)
  assert.equal(isCapturedPty({}), false)
  setActiveTerminalProfile({ kind: 'native', reason: 'test' })
  assert.equal(isCapturedPty({ RIVET_CAPTURED_PTY: '1' }), true)
})

test('explicit mode skips process probing and probing failures retain native behavior', async () => {
  let attempted = false
  const failProbe = async () => { attempted = true; throw new Error('unavailable') }
  assert.equal((await detectTerminalProfile({ env: { RIVET_CAPTURED_PTY: '1' }, platform: 'win32', probeAncestors: failProbe })).kind, 'captured-pty')
  assert.equal(attempted, false)
  assert.equal((await detectTerminalProfile({ env: {}, platform: 'win32', probeAncestors: failProbe })).kind, 'native')
  assert.equal(attempted, true)
})

test('asynchronous probe evidence follows the same pure classification rules', async () => {
  assert.equal((await detectTerminalProfile({ env: {}, platform: 'win32', probeAncestors: async () => [bridge, mux] })).kind, 'captured-pty')
  assert.equal((await detectTerminalProfile({ env: {}, platform: 'win32', probeAncestors: async () => [mux] })).kind, 'native')
})

test('a stalled Windows probe cannot block startup indefinitely', async () => {
  const started = performance.now()
  const result = await detectTerminalProfile({ env: {}, platform: 'win32', timeoutMs: 20, probeAncestors: () => new Promise(() => {}) })
  assert.equal(result.kind, 'native')
  assert.ok(performance.now() - started < 1000)
})
