/**
 * 命令面守卫测试（P0 棘轮）。
 *
 * 拦的是「文档承诺了、实现没有」这一类 bug——它**没有外显信号**：用户照
 * /help 敲命令，命令没注册就静默穿透成普通消息发给模型，界面上看不出任何异常。
 * 已发生两起：/goal-cancel（help 有、注册名是 /cancel-goal）、/rollback
 * （注册了但 handler 是 `return false` 空壳，还在 yolo 告警里被当安全网推荐）。
 *
 * 纯源码静态扫描，不 import TUI 模块——避免把重依赖拖进测试，也保证扫描的是
 * 真实声明文本而不是某个装配路径的运行时投影。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { COMMAND_CATALOG, REGISTERED_COMMAND_META } from '../command-catalog.js'
import { getPaletteCommands } from '../command-palette.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf-8')

/** help 文本里的命令引用。排除集必须含 CJK——`字符/token` 这类斜杠不是命令，
 *  而 CJK 不在 \w 里，漏掉就会把它误当命令名。 */
const HELP_TOKEN_RX = /(?<![\w/.\-\u4e00-\u9fff\u3000-\u303f])(\/[a-z][a-z0-9-]{1,24})(?![\w/-])/g
/** `name: '/x'` 声明。 */
const NAME_RX = /\bname:\s*['"](\/[a-z0-9-]+)['"]/g
/** `aliases: ['/a', '/b']` 声明。 */
const ALIASES_RX = /aliases:\s*\[([^\]]*)\]/g
/** `register("/x"` / `registerWorkflow("/x")` 等命令式注册。 */
const REGISTER_RX = /[A-Za-z]*[Rr]egister[A-Za-z]*\(\s*['"](\/[a-z0-9-]+)['"]/g

const collect = (src: string, rx: RegExp): string[] => {
  const out: string[] = []
  for (const m of src.matchAll(new RegExp(rx.source, rx.flags))) out.push(m[1]!)
  return out
}

/** 扫描命令声明源，产出 canonical 集与别名集。 */
function scanDeclarations() {
  const sources = ['src/tui/slash-commands.ts', 'src/tui/engine/app.ts'].map(read)
  const canonical = new Set<string>()
  const aliases = new Set<string>()

  for (const src of sources) {
    for (const n of collect(src, NAME_RX)) canonical.add(n)
    for (const n of collect(src, REGISTER_RX)) canonical.add(n)
    for (const m of src.matchAll(new RegExp(ALIASES_RX.source, ALIASES_RX.flags))) {
      for (const a of collect(m[1]!, /['"](\/[a-z0-9-]+)['"]/g)) aliases.add(a)
    }
  }
  return { canonical, aliases }
}

test('守卫：/help 里引用的每个命令都必须已注册（或是已声明的别名）', () => {
  const { canonical, aliases } = scanDeclarations()
  const help = read('src/tui/format/help-text.ts')
  const referenced = [...new Set(collect(help, HELP_TOKEN_RX))].sort()
  const known = new Set([...canonical, ...aliases])

  const ghosts = referenced.filter(c => !known.has(c))
  assert.deepEqual(
    ghosts, [],
    `这些命令在 /help 里有文案但没有注册实现（用户照敲会被静默当普通消息发给模型）：${ghosts.join(', ')}`,
  )
  // 扫描本身要有效——防止正则写坏导致「零引用即通过」的假绿。
  assert.ok(referenced.length > 50, `help 命令引用扫描疑似失效，只抽到 ${referenced.length} 条`)
})

test('守卫：内置集的别名不得与任何 canonical 名冲突', () => {
  const { canonical, aliases } = scanDeclarations()

  const collisions = [...aliases].filter(a => canonical.has(a)).sort()
  assert.deepEqual(
    collisions, [],
    `别名与既有命令同名（registry 会忽略该别名，等于别名失效）：${collisions.join(', ')}`,
  )
})

test('守卫：注册的每条命令都必须出现在命令目录里（否则面板/补全看不见它）', () => {
  const { canonical, aliases } = scanDeclarations()
  const inCatalog = new Set<string>([...REGISTERED_COMMAND_META.map(c => c.name), ...aliases])

  const invisible = [...canonical].filter(n => !inCatalog.has(n)).sort()
  assert.deepEqual(
    invisible, [],
    `这些命令已注册但不在命令目录里 —— Ctrl+P 面板与 / 补全都以目录为唯一来源，`
    + `用户无法发现它们（只能靠背出全名）：${invisible.join(', ')}`,
  )
  assert.ok(canonical.size > 80, `注册声明扫描疑似失效，只抽到 ${canonical.size} 条`)
})

test('守卫：目录里每条命令都必须出现在 /help 里（面板与帮助不得单向缺失）', () => {
  const help = read('src/tui/format/help-text.ts')
  const inHelp = new Set(collect(help, HELP_TOKEN_RX))

  const undocumented = REGISTERED_COMMAND_META.filter(c => !inHelp.has(c.name)).map(c => c.name).sort()
  assert.deepEqual(
    undocumented, [],
    `这些命令在面板里能搜到、但 /help 里查不到（两个发现渠道应等价）：${undocumented.join(', ')}`,
  )
})

test('守卫：命令目录自身不得有重名或空描述', () => {
  const names = COMMAND_CATALOG.map(c => c.name)
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  assert.deepEqual(dupes, [], `命令目录有重名条目：${dupes.join(', ')}`)

  const empty = COMMAND_CATALOG.filter(c => !c.description?.trim()).map(c => c.name)
  assert.deepEqual(empty, [], `这些条目缺描述（面板里会显示空白）：${empty.join(', ')}`)

  const missing = COMMAND_CATALOG.filter(c => !c.name.startsWith('/')).map(c => c.name)
  assert.deepEqual(missing, [], `目录条目必须带前导斜杠：${missing.join(', ')}`)
})

test('守卫：面板必须包含目录里的每一条（面板 = 目录 + 界面动作）', () => {
  const paletteNames = new Set(getPaletteCommands().map(c => c.name))
  const missing = COMMAND_CATALOG.filter(c => !paletteNames.has(c.name)).map(c => c.name)
  assert.deepEqual(missing, [], `目录条目没进面板：${missing.join(', ')}`)
})

test('守卫：面板顺序 = 目录顺序（人工编排，重排会改用户肌肉记忆）', () => {
  const palette = getPaletteCommands().filter(c => c.name.startsWith('/'))
  assert.deepEqual(
    palette.map(c => c.name), COMMAND_CATALOG.map(c => c.name),
    '面板必须原序展开目录——曾用一次性脚本核对过与迁移前逐条一致，此处锁死不再重排',
  )
})

test('守卫：/rollback 必须接真实检查点实现，不得是穿透空壳', () => {
  const src = read('src/tui/slash-commands.ts')
  const block = /\{\s*(?:\/\/[^\n]*\n\s*)*name:\s*['"]\/rollback['"][\s\S]*?\n  \},/.exec(src)
  assert.ok(block, '未找到 /rollback 定义块')

  // 空壳的签名是 handler 恒 return false（等于把 "/rollback" 这行字发给模型）。
  assert.doesNotMatch(block[0], /return\s+false\s*\n\s*\},?\s*$/m, '/rollback handler 疑似又是空壳')
  assert.match(block[0], /rollbackToCheckpoint/, '/rollback 必须调用 rollbackToCheckpoint')
  assert.match(block[0], /getRollbackPreview/, '/rollback 必须走 getRollbackPreview 两阶段')
})
