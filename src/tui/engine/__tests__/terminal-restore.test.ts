/**
 * 崩溃路径的终端状态还原。
 *
 * 契约：
 * - 未捕获同步异常会跳过 shutdown()/dispose()，此时 process.on('exit') 兜底钩子
 *   调 restoreTerminalSync() 仍必须关掉 bracketed paste 并恢复光标——否则用户被
 *   留在需要 `tput reset` 的终端里（症状：粘贴时出现字面 ^[[200~）。
 * - 幂等：dispose() 已还原过就不再重发。
 * - 备用屏只在 overlay 确实激活时才退出：无条件发 ?1049l 会让部分终端跳到陈旧的
 *   保存光标位置。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { withPtyFixture } from './_pty-fixture.js'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn } from './_harness.js'
import { DEFAULT_FRONTEND_PREFERENCES } from '../../frontend-preferences.js'

test('restoration returns the TTY to cooked mode before dispose', () => {
  const input = new MockIn()
  const modes: boolean[] = []
  input.setRawMode = ((raw: boolean) => { modes.push(raw); return input }) as typeof input.setRawMode
  const app = new TuiApp({ stdin: input as unknown as ReadStream, stdout: new MockOut() as unknown as WriteStream, cols: 80, rows: 24 })
  app.setFrontendPreferences({ ...DEFAULT_FRONTEND_PREFERENCES, renderer: 'classic' })
  try { app.start(); app.restoreTerminalSync(); assert.equal(modes.at(-1), false) }
  finally { app.dispose() }
})

test('POSIX PTY: bracketed Unicode paste, resize and alternate-screen cleanup', { skip: process.platform === 'win32', timeout: 20_000 }, async () => {
  const fixture = `
    process.stderr.write('PTY_BOOT\\n');
    const { TuiApp } = await import(${JSON.stringify(new URL('../app.js', import.meta.url).href)});
    const { DEFAULT_FRONTEND_PREFERENCES } = await import(${JSON.stringify(new URL('../../frontend-preferences.js', import.meta.url).href)});
    process.stderr.write('PTY_MODULES_READY\\n');
    const app = new TuiApp({ stdin: process.stdin, stdout: process.stdout, cols: 80, rows: 24, modelName: 'pty-test' });
    app.setFrontendPreferences({ ...DEFAULT_FRONTEND_PREFERENCES, renderer: 'fullscreen' });
    const timer = setTimeout(() => { app.dispose(); process.exit(7); }, 12000);
    app.onSubmit(text => {
      app.dispose(); clearTimeout(timer);
      if (text !== '你好 🎉\\nsecond') process.exitCode = 8;
    });
    app.start();
  `
  const python = String.raw`
import os, sys, json, subprocess, termios, fcntl, struct, select, time, signal
master, slave = os.openpty()
before = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
env = os.environ.copy()
for key in ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'TMUX', 'STY']: env.pop(key, None)
env['TERM'] = 'xterm-256color'
env['TERM_PROGRAM'] = 'Apple_Terminal' if sys.platform == 'darwin' else 'rivet-pty'
child = subprocess.Popen(json.loads(sys.argv[1]), stdin=slave, stdout=slave, stderr=slave, env=env)
output = bytearray()
def drain():
    if select.select([master], [], [], .05)[0]:
        output.extend(os.read(master, 65536))
try:
    deadline = time.monotonic() + 10
    while b'\x1b[?1049h' not in output and time.monotonic() < deadline and child.poll() is None:
        drain()
    assert b'\x1b[?1049h' in output, f'fullscreen must enter actual PTY; exit={child.poll()}; output={bytes(output[-2000:])!r}'
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 40, 0, 0))
    child.send_signal(signal.SIGWINCH)
    time.sleep(.25)
    os.write(master, '\x1b[200~你好 🎉\r\nsecond\x1b[201~'.encode())
    time.sleep(.1)
    assert child.poll() is None, 'paste must not auto-submit'
    os.write(master, b'\r')
    deadline = time.monotonic() + 5
    while child.poll() is None and time.monotonic() < deadline:
        drain()
    assert child.wait(timeout=2) == 0, 'Unicode draft must submit exactly once'
    for _ in range(4): drain()
    assert b'\x1b[?1049l' in output and b'\x1b[?25h' in output and b'\x1b[?2004l' in output, 'terminal modes must restore'
    after = termios.tcgetattr(slave)
    mask = termios.ICANON | termios.ECHO
    assert before[3] & mask == after[3] & mask, 'PTY must return to cooked mode'
finally:
    if child.poll() is None: child.kill(); child.wait()
    os.close(master); os.close(slave)
`
  await withPtyFixture(fixture, (argv, options) => execFileSync('python3', ['-c', python, JSON.stringify(argv)], { ...options, timeout: 18_000, stdio: 'pipe' }))
})

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80, rows: 24, modelName: 'test',
  })
  app.setFrontendPreferences({ ...DEFAULT_FRONTEND_PREFERENCES, renderer: 'classic' })
  return { app, out }
}

const countOf = (out: MockOut, seq: string) =>
  out.chunks.filter(c => c.includes(seq)).length

test('崩溃路径：未走 dispose 时 restoreTerminalSync 仍关闭 paste 并恢复光标', () => {
  const { app, out } = makeApp()
  app.start()
  out.chunks.length = 0

  // 模拟 uncaughtException 之后的 process.on('exit')：dispose 从未被调用。
  app.restoreTerminalSync()

  assert.ok(out.chunks.some(c => c.includes('\x1B[?2004l')), '必须关闭 bracketed paste')
  assert.ok(out.chunks.some(c => c.includes('\x1B[?25h')), '必须恢复硬件光标')
})

test('幂等：dispose 已还原后，兜底钩子再调不重发', () => {
  const { app, out } = makeApp()
  app.start()
  app.dispose()
  const afterDispose = countOf(out, '\x1B[?2004l')
  assert.equal(afterDispose, 1, 'dispose 还原一次')

  app.restoreTerminalSync()
  assert.equal(countOf(out, '\x1B[?2004l'), afterDispose, '兜底钩子不得重发')
})

test('多次调用只还原一次', () => {
  const { app, out } = makeApp()
  app.start()
  out.chunks.length = 0

  app.restoreTerminalSync()
  app.restoreTerminalSync()
  app.restoreTerminalSync()

  assert.equal(countOf(out, '\x1B[?2004l'), 1)
  assert.equal(countOf(out, '\x1B[?25h'), 1)
})

test('overlay 未激活时不发 ?1049l（避免跳到陈旧的保存光标位）', () => {
  const { app, out } = makeApp()
  app.start()
  out.chunks.length = 0

  app.restoreTerminalSync()

  assert.equal(countOf(out, '\x1B[?1049l'), 0, '没有备用屏就不该退出备用屏')
})
