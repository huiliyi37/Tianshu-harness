import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { buildInvocation, parseOutput, resolveRuntimeDir } from '../lib/tianshu.mjs'

test('resolveRuntimeDir: serve 入口（cli/entry.js）→ 运行时根目录', () => {
  assert.equal(resolveRuntimeDir({ argv1: 'D:/t/rivet-runtime/cli/entry.js' }), 'D:/t/rivet-runtime')
})

test('resolveRuntimeDir: TUI/headless 入口（main.js）→ 同级目录', () => {
  assert.equal(resolveRuntimeDir({ argv1: 'D:/t/rivet-runtime/main.js' }), 'D:/t/rivet-runtime')
})

test('resolveRuntimeDir: 反斜杠与相对路径同样处理', () => {
  assert.equal(resolveRuntimeDir({ argv1: 'D:\\t\\rivet-runtime\\cli\\entry.js' }), 'D:/t/rivet-runtime')
  assert.equal(resolveRuntimeDir({ argv1: 'rivet-runtime/main.js' }), 'rivet-runtime')
})

test('buildInvocation: 组装命令、参数与环境（默认新会话）', () => {
  const inv = buildInvocation({
    runtimeDir: 'D:/t/rivet-runtime',
    nodePath: 'D:/t/node.exe',
    homeDir: 'D:/h/.rivet',
    cwd: 'D:/ws/abc',
    prompt: '你好',
    baseEnv: { PATH: 'X', RIVET_HOME: 'SHOULD_BE_OVERWRITTEN' },
  })
  assert.equal(inv.command, 'D:/t/node.exe')
  assert.deepEqual(inv.args, [join('D:/t/rivet-runtime', 'main.js'), '-p', '你好', '--json'])
  assert.equal(inv.options.cwd, 'D:/ws/abc')
  assert.equal(inv.options.env.RIVET_HOME, 'D:/h/.rivet')
  assert.equal(inv.options.env.PATH, 'X')
  assert.equal(inv.options.windowsHide, true)
})

test('buildInvocation: 默认新会话时无 -c / -r', () => {
  const inv = buildInvocation({
    runtimeDir: 'R', nodePath: 'N', homeDir: 'H', cwd: 'C', prompt: 'p',
  })
  assert.ok(!inv.args.includes('-c'))
  assert.ok(!inv.args.includes('-r'))
})

test('parseOutput: 标准成功输出', () => {
  const r = parseOutput('{"success":true,"text":"ok","usage":{"input_tokens":1}}')
  assert.equal(r.ok, true)
  assert.equal(r.text, 'ok')
  assert.equal(r.error, null)
})

test('parseOutput: 前置日志噪声中取 JSON 结果行', () => {
  const out = '[rivet] 检测到项目指令……\n{"success":true,"text":"done"}'
  const r = parseOutput(out)
  assert.equal(r.ok, true)
  assert.equal(r.text, 'done')
})

test('parseOutput: success=false 带错误信息', () => {
  const r = parseOutput('{"success":false,"error":"boom"}')
  assert.equal(r.ok, false)
  assert.equal(r.error, 'boom')
})

test('parseOutput: 无有效 JSON 时给出可读错误', () => {
  const r = parseOutput('garbage output')
  assert.equal(r.ok, false)
  assert.ok(r.error)
})

test('parseOutput: 空输出', () => {
  const r = parseOutput('')
  assert.equal(r.ok, false)
  assert.ok(r.error)
})

test('parseOutput: 逆序扫描——多段 JSON 取最后一条结果行', () => {
  const out = '{"success":true,"text":"first"}\n{"success":true,"text":"second"}'
  const r = parseOutput(out)
  assert.equal(r.text, 'second')
})
