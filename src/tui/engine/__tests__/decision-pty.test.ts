import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { withPtyFixture } from './_pty-fixture.js'

for (const renderer of ['classic', 'fullscreen']) test(`POSIX PTY ${renderer}: actual tools, choices, multi-answer, Unicode paste, resize and restoration`,
  { skip: process.platform === 'win32', timeout: 25_000 }, async () => {
    const fixture = `
      const { TuiApp } = await import(${JSON.stringify(new URL('../app.js', import.meta.url).href)});
      const { DEFAULT_FRONTEND_PREFERENCES } = await import(${JSON.stringify(new URL('../../frontend-preferences.js', import.meta.url).href)});
      const { attachDecisionSession } = await import(${JSON.stringify(new URL('../../decision-session.js', import.meta.url).href)});
      const { PLAN_TOOL } = await import(${JSON.stringify(new URL('../../../tools/plan.js', import.meta.url).href)});
      const { ASK_USER_QUESTION_TOOL } = await import(${JSON.stringify(new URL('../../../tools/ask-user-question.js', import.meta.url).href)});
      const { mkdtemp, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { writeSync } = await import('node:fs');
      const signalReady = text => writeSync(2, text);
      const cwd = await mkdtemp(join(tmpdir(), 'decision-pty-'));
      const app = new TuiApp({ stdin: process.stdin, stdout: process.stdout, modelName: 'decision-pty' });
      const agent = { cwd, setActivePlan(p) { if (p.selectedApproach !== '扩展方案') throw new Error('wrong approach'); }, exitPlanMode() {} };
      app.setFrontendPreferences({ ...DEFAULT_FRONTEND_PREFERENCES, renderer: ${JSON.stringify(renderer)} });
      attachDecisionSession(app, () => agent);
      let count = 0;
      const timer = setTimeout(() => { app.dispose(); process.exit(7); }, 16000);
      app.onSubmit(text => {
        if (++count === 1) {
          if (!text.includes('Selected approach: 扩展方案')) throw new Error('wrong kickoff');
          app.callbacks.onTurnComplete({}, 1, true);
          void ASK_USER_QUESTION_TOOL.execute({ cwd, toolUseId: 'question', input: { questions: [
            { prompt: '多选', allow_multiple: true, options: [{ label: 'A', recommended: true, recommendation_reason: '满足目标' }, { label: 'B' }] },
            { prompt: '补充' }
          ] }, onAskUserQuestion: info => agent.onAskUserQuestionRequested(info) }).then(() => setImmediate(() => signalReady('QUESTION_READY\\n')));
        } else {
          if (count !== 2 || text !== '多选 → A；B\\n补充 → 你好 🎉\\nsecond') throw new Error('wrong answers: ' + text);
          signalReady('ANSWER_ACCEPTED\\n');
          setTimeout(() => { app.dispose(); clearTimeout(timer); void rm(cwd, { recursive: true, force: true }); }, 50);
        }
      });
      app.start(); await app.frontend.ready;
      if (${JSON.stringify(renderer)} === 'fullscreen' && !app.frontend.isFullscreen) throw new Error('fullscreen not active');
      const body = ['## 需求提炼', '恢复用户决策卡片，批准后执行已选方案。', '## 根因分析', '请求与渲染状态耦合导致问题。',
        '## 实现方案', '拆分请求生命周期与展示状态。', '\x60\x60\x60mermaid', 'flowchart TD', 'A --> B', '\x60\x60\x60',
        '## 反证复现', '用真实按键验证非推荐方案准确执行。', '## 验证', '检查卡片可见、提交一次和终端恢复。'].join('\\n');
      await PLAN_TOOL.execute({ cwd, toolUseId: 'plan', input: { action: 'submit', title: 'PTY Plan', plan: body, options: [
        { label: '最小方案', description: '较少改动', recommended: true, recommendation_reason: '符合目标且风险低' },
        { label: '扩展方案', description: '额外扩展' }
      ] }, onPlanSubmitted: info => agent.onPlanApprovalRequested(info) });
      setImmediate(() => signalReady('PLAN_READY\\n'));
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
    if select.select([master], [], [], .05)[0]: output.extend(os.read(master, 65536))
def wait_for(marker):
    deadline = time.monotonic() + 12
    while marker not in output and time.monotonic() < deadline and child.poll() is None: drain()
    assert marker in output, f'missing {marker!r}; exit={child.poll()}; output={bytes(output[-2500:])!r}'
try:
    wait_for(b'PLAN_READY')
    assert '计划审批'.encode() in output and '扩展方案'.encode() in output, 'action card must be visible'
    os.write(master, b'\x1b[B\r')
    wait_for(b'QUESTION_READY')
    os.write(master, b' \x1b[B \r\r')
    time.sleep(.15)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 10, 40, 0, 0))
    child.send_signal(signal.SIGWINCH)
    time.sleep(.15)
    os.write(master, '\x1b[200~你好 🎉\r\nsecond\x1b[201~'.encode())
    time.sleep(.15)
    for _ in range(4): drain()
    assert b'ANSWER_ACCEPTED' not in output and child.poll() is None, 'paste must not auto-submit'
    os.write(master, b'\r\x1b[D\x1b[C\r')
    wait_for(b'ANSWER_ACCEPTED')
    deadline = time.monotonic() + 5
    while child.poll() is None and time.monotonic() < deadline: drain()
    assert child.wait(timeout=2) == 0, f'child failure: {bytes(output[-2500:])!r}'
    for _ in range(4): drain()
    assert b'\x1b[?25h' in output and b'\x1b[?2004l' in output, 'terminal modes must restore'
    if sys.argv[2] == 'fullscreen': assert b'\x1b[?1049h' in output and b'\x1b[?1049l' in output
    mask = termios.ICANON | termios.ECHO
    assert before[3] & mask == termios.tcgetattr(slave)[3] & mask, 'PTY must return to cooked mode'
finally:
    if child.poll() is None: child.kill(); child.wait()
    os.close(master); os.close(slave)
`
    await withPtyFixture(fixture, (argv, options) => { try {
      execFileSync('python3', ['-c', python, JSON.stringify(argv), renderer],
        { ...options, timeout: 22_000, stdio: 'pipe' })
    } catch (error) { throw new Error((error as { stderr?: Buffer }).stderr?.toString() ?? String(error)) } })
  })
