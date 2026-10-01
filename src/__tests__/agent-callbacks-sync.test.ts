/**
 * 两份 `AgentCallbacks` 的同步守卫。
 *
 * 背景：`src/agent/loop-types.ts` 是权威定义，`src/tui/engine/app.ts` 另有一份
 * **独立声明**的子集（两者靠一句注释声称对齐）。截至本 PR，两份已漂成 25 : 16
 * 而没有任何测试在守。
 *
 * 为什么 typecheck 抓不到这条：TUI 那份接口是 standalone 的，`bridge.ts` 返回的
 * 对象最终按**结构类型**传给 `loop-types` 的接口——多出的成员完全合法。所以
 * 「TUI 侧写了一个 agent 根本不会触发的回调」在类型上无感，只在运行时表现为
 * 一行永远不出现的提示。本守卫补的正是这个洞。
 *
 * 反向（权威有、TUI 没有）**不是**违例——TUI 是刻意的子集（服务端/无头专属的
 * 回调不必接）。因此不锁反向缺口清单：那会在每次有人加 canonical-only 回调时
 * 误报。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

/** 抽出 `export interface <name> {` 顶层成员名（缩进恰好 2 空格、后跟 `?`/`:`/`(`）。 */
function membersOf(source: string, name: string): string[] {
  const marker = `export interface ${name} {`
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `源文件里找不到 ${marker}`)
  const rest = source.slice(start + marker.length)
  const end = rest.indexOf('\n}')
  assert.ok(end > 0, `${name} 的花括号未闭合（解析假定接口体以行首 } 结束）`)
  const members: string[] = []
  for (const line of rest.slice(0, end).split('\n')) {
    const m = /^ {2}([A-Za-z_][A-Za-z0-9_]*)\??\s*[:(]/.exec(line)
    if (m) members.push(m[1]!)
  }
  return members
}

const canonical = membersOf(
  readFileSync(`${ROOT}agent/loop-types.ts`, 'utf8'),
  'AgentCallbacks',
)
const tuiSide = membersOf(
  readFileSync(`${ROOT}tui/engine/app.ts`, 'utf8'),
  'AgentCallbacks',
)

test('解析本身有效：两边都抽到了成员（防止守卫空转）', () => {
  assert.ok(canonical.length > 15, `权威接口应抽到 >15 个成员，实得 ${canonical.length}`)
  assert.ok(tuiSide.length > 10, `TUI 接口应抽到 >10 个成员，实得 ${tuiSide.length}`)
})

test('TUI 侧的每个回调都必须在 loop-types 的权威接口里存在（不得发明 agent 不会触发的回调）', () => {
  const invented = tuiSide.filter(m => !canonical.includes(m))
  assert.deepEqual(
    invented,
    [],
    `TUI 侧声明了权威接口没有的回调——它们永远不会被触发，对应的提示行永远不出现：\n  ${invented.join('\n  ')}\n`
    + '要么在 loop-types.ts 补上（并在 agent 侧真的发出），要么从 TUI 侧删掉。',
  )
})

test('本功能新增的回调确实两边都在（防「只改了一边」）', () => {
  // onCvmInterception 是 TUI 侧要消费的（bridge 负责转发），因此两处都必须有。
  assert.ok(canonical.includes('onCvmInterception'), 'loop-types.ts 缺 onCvmInterception')
  assert.ok(tuiSide.includes('onCvmInterception'), 'TUI 侧缺 onCvmInterception——bridge 无法转发，提示永不出现')
})
