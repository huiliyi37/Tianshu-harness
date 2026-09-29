import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMMAND_ALIASES, COMMAND_NAMES, COMMAND_USAGE, firstUseHint, helpBody, parseCommand,
} from '../lib/command.mjs'

// ── 词法：标准命令与参数 ──────────────────────────────────────

test('parseCommand: 标准命令无参数', () => {
  assert.deepEqual(parseCommand('/workspacelist'), { kind: 'command', name: 'workspacelist', args: [] })
})

test('parseCommand: 命令带一个参数', () => {
  assert.deepEqual(parseCommand('/workspace 2'), { kind: 'command', name: 'workspace', args: ['2'] })
})

test('parseCommand: 命令带多个参数（逐个切分，不合并）', () => {
  assert.deepEqual(parseCommand('/history 3 extra'), { kind: 'command', name: 'history', args: ['3', 'extra'] })
})

test('parseCommand: 参数里含斜杠或冒号照样原样保留', () => {
  assert.deepEqual(parseCommand('/workspace D:/x/y'), { kind: 'command', name: 'workspace', args: ['D:/x/y'] })
  assert.deepEqual(parseCommand('/workspace \\\\server\\share'), { kind: 'command', name: 'workspace', args: ['\\\\server\\share'] })
})

test('parseCommand: 中文参数不被拆坏', () => {
  assert.deepEqual(parseCommand('/session 我的会话'), { kind: 'command', name: 'session', args: ['我的会话'] })
})

// ── 别名归一 ─────────────────────────────────────────────────

test('parseCommand: 工作区列表的三个别名都归一', () => {
  for (const w of ['/workspacelist', '/wsl', '/workspaces']) {
    assert.equal(parseCommand(w).name, 'workspacelist', w)
  }
})

test('parseCommand: 切换工作区的两个别名都归一', () => {
  for (const w of ['/workspace', '/ws']) {
    assert.equal(parseCommand(w).name, 'workspace', w)
  }
})

test('parseCommand: 会话列表的两个别名都归一', () => {
  for (const w of ['/sessions', '/sessionlist']) {
    assert.equal(parseCommand(w).name, 'sessions', w)
  }
})

test('parseCommand: 别名表与规范名清单同源（不另立一份）', () => {
  for (const name of COMMAND_NAMES) {
    for (const alias of COMMAND_ALIASES[name]) {
      assert.equal(parseCommand(`/${alias}`).name, name, `${alias} → ${name}`)
    }
  }
  assert.deepEqual(
    [...COMMAND_NAMES].sort(),
    ['help', 'history', 'session', 'sessions', 'workspace', 'workspacelist'],
  )
})

// ── 边界：大小写与空白 ───────────────────────────────────────

test('parseCommand: 大小写不敏感（命令词归一为小写）', () => {
  assert.equal(parseCommand('/Sessions').name, 'sessions')
  assert.equal(parseCommand('/HISTORY').name, 'history')
  assert.equal(parseCommand('/Ws').name, 'workspace')
  assert.equal(parseCommand('/WorkSpaceList').name, 'workspacelist')
})

test('parseCommand: 前后空白与多余空格被折叠', () => {
  assert.deepEqual(parseCommand('   /history   3   '), { kind: 'command', name: 'history', args: ['3'] })
})

test('parseCommand: Tab 与换行同样当分隔符', () => {
  assert.deepEqual(parseCommand('/history\t3'), { kind: 'command', name: 'history', args: ['3'] })
  assert.deepEqual(parseCommand('/history\n3'), { kind: 'command', name: 'history', args: ['3'] })
  assert.deepEqual(parseCommand('/workspace\n\n  2 '), { kind: 'command', name: 'workspace', args: ['2'] })
})

test('parseCommand: 空参数与仅有空白的参数都不会造出空字符串', () => {
  assert.deepEqual(parseCommand('/history ') , { kind: 'command', name: 'history', args: [] })
  assert.deepEqual(parseCommand('/history    '), { kind: 'command', name: 'history', args: [] })
})

// ── 边界：不是命令的输入必须仍是 text ────────────────────────

test('parseCommand: 空串与纯空白 → text', () => {
  assert.equal(parseCommand('').kind, 'text')
  assert.equal(parseCommand('   ').kind, 'text')
  assert.equal(parseCommand('\n\t ').kind, 'text')
  assert.equal(parseCommand(undefined).kind, 'text')
  assert.equal(parseCommand(null).kind, 'text')
  assert.equal(parseCommand(123).kind, 'text')
})

test('parseCommand: 裸斜杠 → text（斜杠后有空格就不算命令词）', () => {
  assert.equal(parseCommand('/').kind, 'text')
  assert.equal(parseCommand('/ 你好').kind, 'text')
})

test('parseCommand: 以斜杠开头的路径不能被误判为命令', () => {
  for (const p of ['/home/user/x', '/etc/hosts', '/usr/bin/env python', '/mnt/d/x.txt 看看这个']) {
    assert.equal(parseCommand(p).kind, 'text', p)
  }
})

test('parseCommand: 数字开头、点号开头的词不是命令', () => {
  assert.equal(parseCommand('/1abc').kind, 'text')
  assert.equal(parseCommand('/.hidden').kind, 'text')
})

test('parseCommand: 命令词不在首位就不是命令', () => {
  assert.equal(parseCommand('你好 /workspacelist').kind, 'text')
  assert.equal(parseCommand('请执行 /history').kind, 'text')
})

// ── 未知命令：必须识别为 unknown，不能落成 text ──────────────

test('parseCommand: 未知命令 → unknown（不误判为普通消息）', () => {
  const r = parseCommand('/foo')
  assert.equal(r.kind, 'unknown')
  assert.equal(r.word, 'foo')
  assert.deepEqual(r.args, [])
})

test('parseCommand: 未知命令带参数也照样识别', () => {
  const r = parseCommand('/foo bar baz')
  assert.equal(r.kind, 'unknown')
  assert.deepEqual(r.args, ['bar', 'baz'])
})

test('parseCommand: 形状合法但不在表里（连字符/下划线）→ unknown', () => {
  assert.equal(parseCommand('/my-cmd').kind, 'unknown')
  assert.equal(parseCommand('/my_cmd').kind, 'unknown')
})

test('parseCommand: 原型链上的词不能因查表而变成已知命令', () => {
  // 这五个都以字母开头，形状合法，必须落到 unknown（若查表走原型链，会命中 Object 的成员而误判成命令）
  for (const w of ['/constructor', '/toString', '/valueOf', '/hasOwnProperty', '/isPrototypeOf']) {
    const r = parseCommand(w)
    assert.equal(r.kind, 'unknown', `${w} 应为 unknown，实得 ${r.kind}`)
  }
})

test('parseCommand: 下划线开头的词不是命令形状（含 __proto__）→ text', () => {
  for (const w of ['/__proto__', '/_x', '/__defineGetter__']) {
    assert.equal(parseCommand(w).kind, 'text', w)
  }
})

test('parseCommand: 大小写不同的未知命令也识别为未知', () => {
  assert.equal(parseCommand('/FOO').kind, 'unknown')
  assert.equal(parseCommand('/Foo').word, 'foo')
})

// ── 纯函数性 ─────────────────────────────────────────────────

test('parseCommand: 同一输入多次调用结果一致（幂等、不共享可变状态）', () => {
  const a = parseCommand('/workspace 2')
  const b = parseCommand('/workspace 2')
  assert.deepEqual(a, b)
  a.args.push('污染')            // 改坏第一次的结果，不应影响第二次
  assert.deepEqual(parseCommand('/workspace 2').args, ['2'])
})

test('parseCommand: 返回的 args 与输入无引用关系（改返回值不回流）', () => {
  const src = '/history 3'
  const r = parseCommand(src)
  r.args[0] = '9'
  assert.equal(parseCommand(src).args[0], '3')
})

// ── 命令说明（/help 的唯一文案源）──────────────────────────────

test('COMMAND_USAGE: 每个规范名都有说明，例子就是这条命令', () => {
  for (const name of COMMAND_NAMES) {
    const u = COMMAND_USAGE[name]
    assert.ok(u, `${name} 缺说明`)
    assert.ok(u.summary, `${name} 缺一句话说明`)
    assert.ok(u.example && u.example.startsWith(`/${name}`), `${name} 的例子应当以自身开头`)
  }
})

test('helpBody: 只列已注册的命令（随注册表增长，不虚列）', () => {
  const one = helpBody(['history'])
  assert.match(one, /\/history/)
  assert.ok(!one.includes('/workspacelist'), '没注册的命令不得出现')

  const full = helpBody(COMMAND_NAMES)
  assert.match(full, /【工作区】/)
  assert.match(full, /【帮助】/)
  for (const name of COMMAND_NAMES) assert.ok(full.includes(`/${name}`), `${name} 应出现`)
})

test('helpBody: 单条详情；别名可查；不认识的名字回提示 + 全量清单', () => {
  const detail = helpBody(COMMAND_NAMES, { command: 'history' })
  assert.match(detail, /^\/history \[N\]/)
  assert.ok(!detail.includes('【工作区】'), '单条详情不夹带全量清单')

  const byAlias = helpBody(COMMAND_NAMES, { command: '/ws' })
  assert.match(byAlias, /^\/workspace </, '别名也要能查到')

  const miss = helpBody(COMMAND_NAMES, { command: 'nope' })
  assert.match(miss, /没有这条命令：nope/)
  assert.match(miss, /【工作区】/, '顺带给全量清单')
})

test('firstUseHint: 两行，含用法与例子；未知命令返回 null', () => {
  const hint = firstUseHint('history')
  assert.match(hint, /\/history \[N\]/)
  assert.match(hint, /例：\/history 5/)
  assert.equal(firstUseHint('nope'), null)
})
