/**
 * QQ 侧命令解析（纯函数：无 IO、无依赖）。
 *
 * 词法规则：消息去掉首尾空白并按空白切分，**首个词**形如 `/单词`（`/` + 字母开头 +
 * 字母/数字/下划线/连字符，且词内不含第二个 `/`）才算命令。这条限制是为了不误伤
 * 以斜杠开头的路径：`/home/user/x`、`/etc/hosts` 一律仍按普通消息处理。
 *
 * 三态返回（调用方据此分流）：
 *   { kind: 'command', name, args }  已知命令，name 是归一后的规范名，别名已折叠
 *   { kind: 'unknown', word, args }  命令形状但不在命令表里 —— 调用方**应回一条帮助**，
 *                                    不能当普通消息送给模型（否则用户看到的是模型的困惑）
 *   { kind: 'text' }                 不是命令，原样走既有路径
 *
 * 依据：docs/command-mapping.md 的命令集与 dsh-im 的别名划分（只借形，实现自写）。
 */

/** 别名 → 规范名。查找一律走 hasOwn，避免 `constructor`/`__proto__` 这类词走原型链。 */
const ALIASES = Object.freeze({
  workspacelist: 'workspacelist',
  wsl: 'workspacelist',
  workspaces: 'workspacelist',
  workspace: 'workspace',
  ws: 'workspace',
  sessions: 'sessions',
  sessionlist: 'sessions',
  session: 'session',
  history: 'history',
  help: 'help',
  h: 'help',
})

/** 规范名清单（帮助文案用）。 */
export const COMMAND_NAMES = Object.freeze([...new Set(Object.values(ALIASES))])

/** 规范名 → 建议的别名展示（帮助文案用），保持与 ALIASES 同源不另立一份。 */
export const COMMAND_ALIASES = Object.freeze(
  Object.fromEntries(
    COMMAND_NAMES.map((name) => [
      name,
      Object.keys(ALIASES).filter((alias) => ALIASES[alias] === name),
    ]),
  ),
)

/** 命令形状：单个词，`/` + 字母开头，词内不再出现 `/`。 */
const COMMAND_SHAPE = /^\/[A-Za-z][A-Za-z0-9_-]*$/

/**
 * 解析一条入站消息。
 * @param {string} text
 * @returns {{kind:'command',name:string,args:string[]}
 *   | {kind:'unknown',word:string,args:string[]}
 *   | {kind:'text'}}
 */
export function parseCommand(text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (!trimmed) return { kind: 'text' }

  const tokens = trimmed.split(/\s+/)
  const head = tokens[0]
  if (!COMMAND_SHAPE.test(head)) return { kind: 'text' }

  const word = head.slice(1).toLowerCase()
  const args = tokens.slice(1)
  if (!Object.prototype.hasOwnProperty.call(ALIASES, word)) {
    return { kind: 'unknown', word, args }
  }
  return { kind: 'command', name: ALIASES[word], args }
}

// ── 命令说明（唯一文案来源：/help 卡片与「首次使用」提示都取这里）────

/**
 * 规范名 → 说明。params 用中括号表可选、尖括号表必填；example 是可直接照抄的一行。
 * detail 讲边界与限制。帮助卡片与首次提示都从这里生成，不另立一份文案。
 */
export const COMMAND_USAGE = Object.freeze({
  workspacelist: {
    params: '',
    summary: '列出可选工作区（编号就是 /workspace 的取值）',
    example: '/workspacelist',
  },
  workspace: {
    params: '<编号|绝对路径>',
    summary: '切换工作区：在目标工作区预建会话并换绑，下一条消息进新会话',
    example: '/workspace 2',
    detail: '失败时只回绝，绑定保持原样；降级模式（没有 serve 通道）下不可用。',
  },
  sessions: {
    params: '[工作区编号] [--limit N]',
    summary: '列出会话（标题与编号；默认 10 条，最多 30 条）',
    example: '/sessions --limit 5',
  },
  session: {
    params: '<编号|会话 ID>',
    summary: '把这条对话线绑定到指定会话',
    example: '/session 3',
    detail: '编号与 /sessions 的清单同源同序；目标不存在时报错，原绑定不动。',
  },
  history: {
    params: '[N]',
    summary: '回看当前绑定会话的最近 N 条消息（默认 3，上限 20）',
    example: '/history 5',
    detail: '数量在插件本地校验，非法值按默认 3 条并在正文说明。单条默认最多 800 字；'
      + '条数多时自动压缩每条（总量压在约 1.2 万字内），超出即截断并注明原字数。',
  },
  help: {
    params: '[命令名]',
    summary: '看命令说明；不带参数看全部',
    example: '/help history',
  },
})

/** 帮助卡片的分组与展示顺序；不在表里的命令归到「其他」。 */
export const COMMAND_GROUPS = Object.freeze([
  { title: '工作区', names: ['workspacelist', 'workspace'] },
  { title: '会话', names: ['sessions', 'session'] },
  { title: '历史', names: ['history'] },
  { title: '帮助', names: ['help'] },
])

/** 命令的书写形式（含参数占位）。 */
export function usageLine(name) {
  const u = COMMAND_USAGE[name]
  if (!u) return null
  return u.params ? `/${name} ${u.params}` : `/${name}`
}

/** 单条命令的说明行（数组；未知命令返回空数组）。 */
export function describeCommand(name, { aliases = COMMAND_ALIASES } = {}) {
  const u = COMMAND_USAGE[name]
  if (!u) return []
  const alias = (aliases?.[name] ?? []).filter((a) => a !== name)
  const lines = [`${usageLine(name)} — ${u.summary}`]
  lines.push(alias.length
    ? `  别名：${alias.map((a) => `/${a}`).join('、')}    例：${u.example}`
    : `  例：${u.example}`)
  if (u.detail) lines.push(`  ${u.detail}`)
  return lines
}

function helpList(available, aliases) {
  const lines = ['天枢 QQ 命令（由插件直接处理，不经过模型）']
  for (const group of COMMAND_GROUPS) {
    const names = group.names.filter((n) => available.has(n))
    if (!names.length) continue
    lines.push('', `【${group.title}】`)
    for (const name of names) lines.push(...describeCommand(name, { aliases }))
  }
  const extra = [...available].filter((n) => !COMMAND_GROUPS.some((g) => g.names.includes(n)))
  if (extra.length) {
    lines.push('', '【其他】')
    for (const name of extra.sort()) lines.push(...describeCommand(name, { aliases }))
  }
  return lines
}

/**
 * 帮助正文。names 是**已注册**的规范名（只列真正可用的命令，随注册表增长）。
 * command 非空时给单条详情；名字不认识则回一句提示 + 全量清单。
 */
export function helpBody(names, { command = null, aliases = COMMAND_ALIASES } = {}) {
  const available = new Set((Array.isArray(names) ? names : []).filter((n) => COMMAND_USAGE[n]))
  const word = command === null || command === undefined ? '' : String(command).trim()
  if (word) {
    const bare = word.replace(/^\//, '').toLowerCase()
    const canonical = Object.prototype.hasOwnProperty.call(ALIASES, bare) ? ALIASES[bare] : null
    if (canonical && available.has(canonical)) return describeCommand(canonical, { aliases }).join('\n')
    return [`没有这条命令：${word}`, '', ...helpList(available, aliases)].join('\n')
  }
  return helpList(available, aliases).join('\n')
}

/** 「第一次用到这条命令」时随回执附上的两行提示。 */
export function firstUseHint(name) {
  const u = COMMAND_USAGE[name]
  if (!u) return null
  return [`${usageLine(name)} · ${u.summary}`, `例：${u.example}`].join('\n')
}
