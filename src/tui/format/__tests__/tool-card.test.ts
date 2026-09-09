import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatToolCardLive, formatToolCard, isToolCardTruncated } from '../tool-card.js'
import { getTheme } from '../../theme.js'
import { buildFileDiff } from '../../../tools/edit-diff.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('formatToolCardLive', async () => {
  it('returns a fixed height even without output tail', async () => {
    const lines = formatToolCardLive({
      toolName: 'bash',
      toolInput: { command: 'npm test' },
      outputTail: '',
      columns: 80,
      tailLines: 3,
    }, theme)
    assert.equal(lines.length, 1 + 3, 'header + fixed tail rows')
  })

  it('pads empty tail rows when output is short', async () => {
    const lines = formatToolCardLive({
      toolName: 'bash',
      toolInput: { command: 'echo hi' },
      outputTail: 'hello',
      columns: 80,
      tailLines: 3,
    }, theme)
    assert.equal(lines.length, 1 + 3, 'fixed height')
    const plain = lines.map(stripAnsi)
    assert.ok(plain.some(l => l.includes('hello')), 'content visible')
  })

  it('shows only the last tailLines of output', async () => {
    const output = 'line1\nline2\nline3\nline4'
    const lines = formatToolCardLive({
      toolName: 'bash',
      outputTail: output,
      columns: 80,
      tailLines: 2,
    }, theme)
    const plain = lines.map(stripAnsi)
    assert.ok(plain.some(l => l.includes('line4')), 'last line visible')
    assert.ok(!plain.some(l => l.includes('line1')), 'first line dropped')
  })

  it('accepts pre-split outputTailLines and skips re-splitting outputTail', async () => {
    // live 区每帧渲染时调用方按累加器引用缓存切分结果；预切行必须与 outputTail 路径一致。
    const output = 'line1\nline2\nline3\nline4\n'
    const viaTail = formatToolCardLive({
      toolName: 'bash', outputTail: output, columns: 80, tailLines: 2,
    }, theme).map(stripAnsi)
    const viaLines = formatToolCardLive({
      toolName: 'bash', outputTail: output, outputTailLines: ['line1', 'line2', 'line3', 'line4'], columns: 80, tailLines: 2,
    }, theme).map(stripAnsi)
    assert.deepEqual(viaLines, viaTail)
  })

  it('pre-split empty outputTailLines falls back to the placeholder row', async () => {
    const lines = formatToolCardLive({
      toolName: 'bash', outputTail: '', outputTailLines: undefined, columns: 80, tailLines: 3,
    }, theme)
    assert.equal(lines.length, 1 + 3, 'header + fixed tail rows')
  })

  it('renders a spinner bullet when tick is provided', async () => {
    const lines = formatToolCardLive({
      toolName: 'bash',
      toolInput: { command: 'sleep 1' },
      columns: 80,
      tick: 1,
      tailLines: 3,
    }, theme)
    const header = stripAnsi(lines[0]!)
    assert.ok(header.includes('Run(sleep 1)') || header.includes('bash'), 'title present')
    assert.equal(lines.length, 1 + 3, 'fixed height with spinner')
  })

  // tailLines=0 是并发折叠用的：live 区只给最新一张卡展开输出，其余仅标题行。
  // `slice(-0)` 等价于 `slice(0)`，天真实现会把整个 tail 全量摊开——与意图相反。
  it('tailLines=0 只出标题行，不摊开整个 tail', async () => {
    const lines = formatToolCardLive({
      toolName: 'bash',
      toolInput: { command: 'npm test' },
      outputTail: 'line1\nline2\nline3\nline4\nline5',
      columns: 80,
      tailLines: 0,
    }, theme)
    assert.equal(lines.length, 1, `应只有标题行，实得 ${lines.length} 行: ${lines.map(stripAnsi).join(' | ')}`)
    const plain = stripAnsi(lines[0]!)
    assert.ok(!plain.includes('line1') && !plain.includes('line5'), 'tail 内容不出现')
  })

  it('tailLines=0 且无输出时也不补占位行', async () => {
    const lines = formatToolCardLive({
      toolName: 'read', toolInput: { path: 'a.ts' }, outputTail: '', columns: 80, tailLines: 0,
    }, theme)
    assert.equal(lines.length, 1, '无输出也只有标题行')
  })
})

describe('formatToolCard — inline edit diff (write family + isDiffContent)', async () => {
  it('colors an edit_file uiContent diff and shows the +N −M summary', async () => {
    const diff = await buildFileDiff('src/foo.ts', 'alpha\nbeta\ngamma\n', 'alpha\nBETA\ngamma\n')
    const lines = formatToolCard({
      toolName: 'edit_file',
      content: diff,
      toolInput: { file_path: 'src/foo.ts' },
      elapsedMs: 12,
    }, theme)
    const plain = lines.map(stripAnsi).join('\n')
    assert.match(plain, /diff: \+1 −1/, 'diff stat summary present')
    assert.ok(plain.includes('-beta'), 'removal line rendered')
    assert.ok(plain.includes('+BETA'), 'addition line rendered')
  })

  it('routes apply_patch output through the diff renderer', async () => {
    const diff = 'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n'
    const lines = formatToolCard({
      toolName: 'apply_patch',
      content: diff,
      elapsedMs: 5,
    }, theme)
    const plain = lines.map(stripAnsi).join('\n')
    assert.match(plain, /diff: \+1 −1/)
  })
})

describe('formatToolCard — diff 内联阈值 (adds+dels ≤ 10)', () => {
  it('renders inline diff when adds+dels = 10', () => {
    // 构造恰好 10 行修改 (5 adds + 5 dels)
    const hunks = '@@ -1,5 +1,5 @@'
    const dels = ['-a', '-b', '-c', '-d', '-e']
    const adds = ['+A', '+B', '+C', '+D', '+E']
    const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', hunks, ...dels, ...adds].join('\n')
    const lines = formatToolCard({ toolName: 'edit_file', content: diff }, theme)
    const plain = lines.map(stripAnsi).join('\n')
    assert.match(plain, /diff: \+5 −5/, 'diff stat should be present')
    assert.ok(plain.includes('-a'), 'removal lines rendered inline')
    assert.ok(plain.includes('+A'), 'addition lines rendered inline')
  })

  it('renders summary when adds+dels > 10', () => {
    // 构造 12 行修改 (6 adds + 6 dels)
    const hunks = '@@ -1,6 +1,6 @@'
    const dels = ['-a', '-b', '-c', '-d', '-e', '-f']
    const adds = ['+A', '+B', '+C', '+D', '+E', '+F']
    const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', hunks, ...dels, ...adds].join('\n')
    const lines = formatToolCard({ toolName: 'edit_file', content: diff }, theme)
    const plain = lines.map(stripAnsi).join('\n')
    assert.match(plain, /1 处修改/, 'summary with hunk count')
    assert.match(plain, /\+6 −6/, 'summary with line counts')
    assert.ok(!plain.includes('-a'), 'removal lines NOT rendered inline')
    assert.ok(!plain.includes('+A'), 'addition lines NOT rendered inline')
    assert.match(plain, /ctrl\+o 展开/, 'expand hint present')
  })

  it('isToolCardTruncated returns false for ≤10 changes', () => {
    const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-a\n-b\n-c\n+A\n+B\n+C\n'
    assert.equal(isToolCardTruncated({ toolName: 'edit_file', content: diff }), false)
  })

  it('isToolCardTruncated returns true for >10 changes', () => {
    const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,6 +1,6 @@\n-a\n-b\n-c\n-d\n-e\n-f\n+A\n+B\n+C\n+D\n+E\n+F\n'
    assert.equal(isToolCardTruncated({ toolName: 'edit_file', content: diff }), true)
  })
})

describe('派发预览：字段名必须与 delegate 工具 schema 对齐', async () => {
  // 这里曾读 `task.id` 与 `task.description`，而 delegate_batch 的任务 schema
  // 只有 `objective`（delegate-batch.ts required: ['objective']）。两个字段都不
  // 存在，于是每次批量派发都只渲染出 `• #1 • #2`：逐次一模一样、与真实任务无关。
  const preview = (toolName: string, toolInput: Record<string, unknown>): string =>
    formatToolCard({ toolName, toolInput, content: '', streaming: true }, theme)
      .map(stripAnsi).join('\n')

  it('delegate_batch 渲染每个任务的 objective', async () => {
    const out = preview('delegate_batch', {
      tasks: [{ objective: '审查缓存边界' }, { objective: '补 rewind 回归测试' }],
    })
    assert.match(out, /审查缓存边界/)
    assert.match(out, /补 rewind 回归测试/)
  })

  it('delegate_batch 两次不同派发渲染出不同内容', async () => {
    const a = preview('delegate_batch', { tasks: [{ objective: '审查缓存边界' }] })
    const b = preview('delegate_batch', { tasks: [{ objective: '补 rewind 回归测试' }] })
    assert.notEqual(a, b, '不同任务不得渲染成同一段文本')
  })

  it('objective 尚未流式到达时不报错，也不编造内容', async () => {
    const out = preview('delegate_batch', { tasks: [{}] })
    assert.match(out, /#1/, '编号仍要有，否则用户看不出派了几个')
    assert.doesNotMatch(out, /undefined/)
  })

  it('delegate_task 单任务渲染 objective', async () => {
    const out = preview('delegate_task', { objective: '定位 /tasks 舰队行的渲染函数' })
    assert.match(out, /定位 \/tasks 舰队行的渲染函数/)
  })

  it('delegate_task 参数未成形时退到 profile（schema 里没有 agent 字段）', async () => {
    const out = preview('delegate_task', { profile: 'reviewer' })
    assert.match(out, /reviewer/)
  })
})
