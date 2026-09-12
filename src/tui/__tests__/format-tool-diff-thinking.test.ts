import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatToolCard, formatToolCardLive, isToolCardTruncated, toolCardTitle } from '../format/tool-card.js'
import { formatDiff, isDiffContent } from '../format/diff.js'
import { formatThinking } from '../format/thinking.js'
import { displayWidth } from '../width.js'
import { getTheme } from '../theme.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('formatToolCard (Claude Code ●/⎿ style)', () => {
  it('renders ● header with capitalized verb and arg summary', () => {
    const lines = formatToolCard({
      toolName: 'bash',
      content: 'output',
      toolInput: { command: 'npm test' },
    }, theme)
    assert.ok(lines.length >= 2)
    const header = stripAnsi(lines[0]!)
    assert.ok(header.includes('›'), 'has bullet')
    assert.ok(header.includes('Run(npm test)'), `header: ${header}`)
  })

  it('renders body with ⎿ first-line prefix', () => {
    const lines = formatToolCard({ toolName: 'grep', content: 'match1\nmatch2' }, theme)
    assert.ok(stripAnsi(lines[1]!).includes('⎿'))
    assert.ok(stripAnsi(lines[1]!).includes('match1'))
    assert.ok(!stripAnsi(lines[2]!).includes('⎿'), 'continuation lines have no ⎿')
    assert.ok(stripAnsi(lines[2]!).includes('match2'))
  })

  it('uses error color for isError', () => {
    const lines = formatToolCard({ toolName: 'bash', content: 'fail', isError: true }, theme)
    const headerAnsi = lines[0] ?? ''
    // 测试环境下 theme 可能回退到命名色（无 truecolor 序列），但 header 标题
    // 必然带 bold SGR；只断言存在 ANSI 序列即可
    assert.ok(/\x1B\[/.test(headerAnsi), 'has ANSI SGR codes')
  })

  // 可读性回归：工具输出正文是「数据」(git status / 文件列表 / 命令输出)，
  // 必须用可读的 muted 前景，绝不能用 theme.dim(远星灰，仅装饰用，~2:1 对比度
  // 在墨夜底上几乎不可见)。截图实证 `M CLAUDE.md` 这类数据被 dim 染到看不清。
  it('body content uses readable muted color, NOT decoration-only dim', () => {
    const tc = getTheme(3) // truecolor Tianshu
    const lines = formatToolCard({ toolName: 'bash', content: 'M CLAUDE.md\nM src/foo.ts' }, tc)
    const bodyAnsi = lines.slice(1).join('\n')
    const seq = (hex: string) => {
      const h = hex.replace('#', '')
      return `38;2;${parseInt(h.slice(0, 2), 16)};${parseInt(h.slice(2, 4), 16)};${parseInt(h.slice(4, 6), 16)}`
    }
    assert.ok(stripAnsi(bodyAnsi).includes('M CLAUDE.md'), 'content present')
    // content 文本必须被 muted 包裹，而非 dim。(⎿ 连接符用 dim 是合理装饰，
    // 故只断言 content 文本紧跟的 SGR 是 muted。)
    assert.ok(bodyAnsi.includes(`${seq(tc.muted)}m` + 'M CLAUDE.md'), `content text must use muted ${tc.muted}: ${JSON.stringify(bodyAnsi)}`)
    assert.ok(!bodyAnsi.includes(`${seq(tc.dim)}m` + 'M CLAUDE.md'), `content text must NOT use decoration-only dim ${tc.dim}`)
  })

  it('indents for depth > 0', () => {
    const lines = formatToolCard({ toolName: 'read_file', content: 'data', depth: 2 }, theme)
    assert.ok(stripAnsi(lines[0]!).startsWith('    '))
  })

  it('truncates with `… +N 行 · ctrl+o 展开` marker', () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    const lines = formatToolCard({ toolName: 'bash', content: long, maxLines: 4 }, theme)
    const plain = lines.map(stripAnsi)
    assert.ok(plain.some(l => l.includes('… +46 行 · ctrl+o 展开')), plain.join('|'))
    // 头 4 行保留
    assert.ok(plain.some(l => l.includes('line 0')))
    assert.ok(plain.some(l => l.includes('line 3')))
    assert.ok(!plain.some(l => l.includes('line 4')))
  })

  it('read family uses head+tail preview when truncated', () => {
    const long = Array.from({ length: 60 }, (_, i) => `row ${i}`).join('\n')
    const lines = formatToolCard({ toolName: 'read_file', content: long }, theme)
    const plain = lines.map(stripAnsi)
    assert.ok(plain.some(l => l.includes('row 0')), 'head shown')
    assert.ok(plain.some(l => l.includes('row 59')), 'tail shown')
    assert.ok(plain.some(l => l.includes('ctrl+o 展开')), 'mid marker')
  })

  it('expanded renders all lines without marker', () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const lines = formatToolCard({ toolName: 'bash', content: long, expanded: true }, theme)
    const plain = lines.map(stripAnsi)
    assert.ok(plain.some(l => l.includes('line 29')))
    assert.ok(!plain.some(l => l.includes('ctrl+o')))
  })

  it('edit/write diff content renders via formatDiff (red/green)', () => {
    const diff = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line'
    const lines = formatToolCard({ toolName: 'edit_file', content: diff }, theme)
    const plain = lines.map(stripAnsi)
    assert.ok(plain.some(l => l.includes('+1')), 'diff summary header present')
    assert.ok(plain.some(l => l.includes('+new line')))
  })

  it('shows elapsed when provided', () => {
    const lines = formatToolCard({ toolName: 'bash', content: 'done', elapsedMs: 1500 }, theme)
    assert.ok(stripAnsi(lines[0]!).includes('(1.5s)'))
  })

  it('shows streaming indicator', () => {
    const lines = formatToolCard({ toolName: 'bash', content: '...', streaming: true }, theme)
    assert.ok(stripAnsi(lines[0]!).includes('…'))
  })

  it('shows rawPath when not truncated', () => {
    const lines = formatToolCard({ toolName: 'write_file', content: 'ok', rawPath: '/tmp/foo.ts' }, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('foo.ts')))
  })

  it('empty content shows (无输出)', () => {
    const lines = formatToolCard({ toolName: 'bash', content: '' }, theme)
    assert.ok(stripAnsi(lines[1]!).includes('(无输出)'))
  })

  it('ask_user_question renders fully without truncation', () => {
    const content = 'Which provider do you want?\n\n  1. OpenAI\n  2. Anthropic\n  3. Google\n  4. DeepSeek\n  5. Local'
    const lines = formatToolCard({ toolName: 'ask_user_question', content }, theme)
    const plain = lines.map(stripAnsi)
    // Header uses ? bullet and Ask title
    assert.ok(plain[0]!.includes('?'), 'question bullet')
    assert.ok(plain[0]!.includes('Ask'), 'question title')
    // All 5 options are visible, no truncation marker
    assert.ok(plain.some(l => l.includes('1. OpenAI')))
    assert.ok(plain.some(l => l.includes('5. Local')))
    assert.ok(!plain.some(l => l.includes('ctrl+o 展开')), 'must not be truncated')
  })

  it('uses family-specific default maxLines', () => {
    const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    // run family (bash) defaults to 8 lines
    const bashLines = formatToolCard({ toolName: 'bash', content: long }, theme)
    const bashPlain = bashLines.map(stripAnsi)
    assert.ok(bashPlain.some(l => l.includes('… +4 行 · ctrl+o 展开')), 'bash shows 8 lines')
    // find family (grep) defaults to 6 lines
    const grepLines = formatToolCard({ toolName: 'grep', content: long }, theme)
    const grepPlain = grepLines.map(stripAnsi)
    assert.ok(grepPlain.some(l => l.includes('… +6 行 · ctrl+o 展开')), 'grep shows 6 lines')
    // other family defaults to 4 lines
    const todoLines = formatToolCard({ toolName: 'todo', content: long }, theme)
    const todoPlain = todoLines.map(stripAnsi)
    assert.ok(todoPlain.some(l => l.includes('… +8 行 · ctrl+o 展开')), 'todo shows 4 lines')
  })

  it('explicit maxLines overrides family default', () => {
    const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    const lines = formatToolCard({ toolName: 'bash', content: long, maxLines: 3 }, theme)
    const plain = lines.map(stripAnsi)
    assert.ok(plain.some(l => l.includes('… +9 行 · ctrl+o 展开')), 'explicit maxLines wins')
  })
})

describe('toolCardTitle / isToolCardTruncated', () => {
  it('title falls back to rawPath basename when no input', () => {
    assert.equal(stripAnsi(toolCardTitle('read_file', undefined, '/a/b/main.ts')), 'Read(main.ts)')
  })

  it('title without arg is bare verb', () => {
    assert.equal(stripAnsi(toolCardTitle('run_tests')), 'Test')
  })

  it('isToolCardTruncated matches collapsed render', () => {
    const long = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')
    assert.equal(isToolCardTruncated({ toolName: 'bash', content: long }), true)
    assert.equal(isToolCardTruncated({ toolName: 'bash', content: 'one\ntwo' }), false)
    assert.equal(isToolCardTruncated({ toolName: 'ask_user_question', content: long }), false)
    // run family default is 8 lines, so 9 lines truncates but 7 does not
    assert.equal(isToolCardTruncated({ toolName: 'bash', content: Array.from({ length: 9 }, (_, i) => `l${i}`).join('\n') }), true)
    assert.equal(isToolCardTruncated({ toolName: 'bash', content: Array.from({ length: 7 }, (_, i) => `l${i}`).join('\n') }), false)
  })
})

describe('formatToolCardLive', () => {
  it('renders dim title + last 3 output lines', () => {
    const lines = formatToolCardLive({
      toolName: 'bash',
      toolInput: { command: 'npm test' },
      outputTail: 'a\nb\nc\nd\ne',
      elapsedMs: 3200,
      columns: 80,
    }, theme)
    const plain = lines.map(stripAnsi)
    assert.ok(plain[0]!.includes('● Run(npm test)'))
    assert.ok(plain[0]!.includes('3.2s'))
    assert.equal(plain.length, 4)
    assert.ok(plain[1]!.includes('⎿'))
    assert.ok(plain[1]!.includes('c'))
    assert.ok(plain[3]!.includes('e'))
  })

  it('no output tail renders fixed-height skeleton (title + 3 行 tail 占位)', () => {
    const lines = formatToolCardLive({ toolName: 'grep', columns: 80 }, theme)
    // 固定高度卡片：无输出时补占位行，避免卡片高度随输出跳动（tool-card.ts 注释）
    assert.equal(lines.length, 4)
  })
})

describe('isDiffContent (pure format layer)', () => {
  it('detects unified diff', () => {
    assert.equal(isDiffContent('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b'), true)
  })
  it('rejects plain text', () => {
    assert.equal(isDiffContent('just some\nplain output'), false)
  })
})

describe('formatDiff', () => {
  it('renders diff with summary header', () => {
    const lines = formatDiff({ content: '+added\n-removed\n unchanged' }, theme)
    assert.ok(stripAnsi(lines[0]!).includes('+1'))
    assert.ok(stripAnsi(lines[0]!).includes('−1'))
  })

  it('colors add lines with success color', () => {
    const lines = formatDiff({ content: '+new line' }, theme)
    const addLine = lines.find(l => {
      const plain = stripAnsi(l)
      return plain.startsWith('+') && !plain.startsWith('diff:')
    })
    assert.ok(addLine, 'finds add line')
    assert.ok(/\x1B\[/.test(addLine!), 'add line has ANSI color')
  })

  it('colors del lines with error color', () => {
    const lines = formatDiff({ content: '-old line' }, theme)
    const delLine = lines.find(l => {
      const plain = stripAnsi(l)
      return plain.startsWith('-') && !plain.startsWith('diff:')
    })
    assert.ok(delLine, 'finds del line')
    assert.ok(/\x1B\[/.test(delLine!), 'del line has ANSI color')
  })

  it('truncates long diffs', () => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    const lines = formatDiff({ content: long, maxLines: 30 }, theme)
    // 与其余长输出塌缩共用同一标记（hiddenLinesMarker），不再自造文案。
    assert.ok(lines.some(l => stripAnsi(l).includes('已隐藏 30 行')), `塌缩标记缺失: ${lines.map(stripAnsi).join('|')}`)
  })

  it('renders line-number gutter for hunk-bearing diffs', () => {
    const content = '--- a/x\n+++ b/x\n@@ -10,3 +10,4 @@\n ctx1\n-oldline\n+newline1\n+newline2\n ctx2'
    const lines = formatDiff({ content }, theme).map(stripAnsi)
    // context ctx1 = new line 10；del 显示旧行号 11；两条 add 是新行号 11/12；ctx2 = 13
    assert.ok(lines.some(l => /^\s*10│ ctx1$/.test(l)), `ctx1 gutter: ${JSON.stringify(lines)}`)
    assert.ok(lines.some(l => /^\s*11│-oldline$/.test(l)), 'del shows old-file line number')
    assert.ok(lines.some(l => /^\s*11│\+newline1$/.test(l)), 'add shows new-file line number')
    assert.ok(lines.some(l => /^\s*12│\+newline2$/.test(l)), 'second add increments')
    assert.ok(lines.some(l => /^\s*13│ ctx2$/.test(l)), 'trailing context')
    // hunk 头行留白 gutter
    assert.ok(lines.some(l => /^\s*│@@ -10,3 \+10,4 @@$/.test(l)), 'hunk header has blank gutter')
  })

  it('bare +/- fragments (no hunk) keep gutterless rendering', () => {
    const lines = formatDiff({ content: '+added\n-removed' }, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.startsWith('+added')))
    assert.ok(lines.some(l => l.startsWith('-removed')))
    assert.ok(!lines.some(l => l.includes('│')), 'no gutter without hunk headers')
  })
})

describe('formatDiff inline word highlighting', () => {
  const PAIR = '-const timeout = 5_000\n+const TIMEOUT = 60_000'
  const boldCount = (s: string) => (s.match(/\x1B\[1m/g) ?? []).length
  const findLine = (lines: string[], plainPrefix: string) =>
    lines.find(l => stripAnsi(l).startsWith(plainPrefix))

  it('bolds changed tokens on paired del/add lines (≥2 bold segments, not whole-line bold)', () => {
    const lines = formatDiff({ content: PAIR }, theme)
    const delLine = findLine(lines, '-const')
    const addLine = findLine(lines, '+const')
    assert.ok(delLine, 'finds del line')
    assert.ok(addLine, 'finds add line')
    // 两个差异 token（timeout / 5_000）各一段 bold——若实现退化为整行加粗只会有 1 段
    assert.ok(boldCount(delLine!) >= 2, `del line has per-token bold, got ${boldCount(delLine!)}`)
    assert.ok(boldCount(addLine!) >= 2, `add line has per-token bold, got ${boldCount(addLine!)}`)
  })

  it('bold segments do not alter visible text (stripAnsi identical to whole line)', () => {
    const lines = formatDiff({ content: PAIR }, theme)
    assert.equal(stripAnsi(findLine(lines, '-const')!), '-const timeout = 5_000')
    assert.equal(stripAnsi(findLine(lines, '+const')!), '+const TIMEOUT = 60_000')
  })

  it('unrelated line pairs (word-common < 30%) skip inline highlighting', () => {
    // foo() 与 bar baz qux() 的 \w 实词公共数为 0 → 整行着色，无 bold 段
    const lines = formatDiff({ content: '-foo()\n+bar baz qux()' }, theme)
    const delLine = findLine(lines, '-foo')
    const addLine = findLine(lines, '+bar')
    assert.ok(delLine && addLine, 'finds both lines')
    assert.equal(boldCount(delLine!), 0, 'del line has no bold')
    assert.equal(boldCount(addLine!), 0, 'add line has no bold')
  })

  it('non-adjacent del/add lines do not pair', () => {
    // del 行与 add 行之间隔了 context 行 → 不配对，不加粗
    const lines = formatDiff({ content: '-const timeout = 5_000\n unchanged\n+const TIMEOUT = 60_000' }, theme)
    assert.equal(boldCount(findLine(lines, '-const')!), 0, 'del not paired across context')
    assert.equal(boldCount(findLine(lines, '+const')!), 0, 'add not paired across context')
  })

  it('inlineDiff: false disables highlighting (output matches legacy)', () => {
    const withInline = formatDiff({ content: PAIR }, theme)
    const withoutInline = formatDiff({ content: PAIR, inlineDiff: false }, theme)
    assert.deepEqual(withoutInline.map(stripAnsi), withInline.map(stripAnsi), 'visible text identical')
    assert.equal(boldCount(findLine(withoutInline, '-const')!), 0, 'no bold when disabled')
    // 旧行为 = 整行单段着色：color() 恒以 RESET 结尾 → 每行恰 1 个 RESET
    // （inline 版按 token 拆多段，RESET 数 = 段数）。只查内容行，summary 头也单段。
    for (const l of withoutInline) {
      const plain = stripAnsi(l)
      if (!plain.startsWith('-') && !plain.startsWith('+')) continue
      const resetCount = (l.match(/\x1B\[0m/g) ?? []).length
      assert.equal(resetCount, 1, `legacy line has single color segment, got ${resetCount}: ${plain}`)
    }
  })
})

describe('formatThinking', () => {
  it('returns empty when no text', () => {
    const lines = formatThinking({ text: '', elapsedMs: 5000 }, theme)
    assert.deepEqual(lines, [])
  })

  it('shows status line by default (header defaults to true)', () => {
    const lines = formatThinking({ text: 'thinking…', elapsedMs: 5000 }, theme)
    assert.ok(lines[0]!.includes('凝思中…'))
    assert.ok(lines[0]!.includes('5s'))
  })

  it('hides status line when header: false', () => {
    const lines = formatThinking({ text: 'thinking…', elapsedMs: 5000, header: false }, theme)
    assert.equal(lines.length, 0) // expanded defaults to false, no content
  })

  it('shows expanded content when expanded', () => {
    const lines = formatThinking({
      text: 'line1\nline2\nline3',
      elapsedMs: 5000,
      expanded: true,
    }, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('line1')))
  })

  it('shows long think message after 3 minutes', () => {
    const lines = formatThinking({ text: '…', elapsedMs: 200_000 }, theme)
    assert.ok(stripAnsi(lines[0]!).includes('Ctrl+C'))
  })

  it('produces output for committed thinking (no isStreaming gate)', () => {
    // 核心回归：isStreaming 不存在了，只要有 text + expanded 就应该输出
    const lines = formatThinking({
      text: 'committed thinking text',
      elapsedMs: 10000,
      expanded: true,
    }, theme)
    assert.ok(lines.length > 0, 'committed thinking produces output')
    assert.ok(stripAnsi(lines[0]!).includes('凝思中…'), 'has status header')
  })

  it('shows truncation hint above the tail when text exceeds maxLines', () => {
    const long = Array.from({ length: 20 }, (_, i) => `think line ${i}`).join('\n')
    const lines = formatThinking({
      text: long,
      elapsedMs: 5000,
      expanded: true,
      maxLines: 5,
    }, theme)
    const plain = lines.map(stripAnsi)
    const hintIdx = plain.findIndex(l => l.includes('上方省略 15 行'))
    assert.ok(hintIdx >= 0, `truncation hint missing: ${plain.join('|')}`)
    assert.ok(plain.some(l => l.includes('think line 15')), 'tail of last 5 visible')
    assert.ok(!plain.some(l => l.includes('think line 3')), 'line 3 hidden (not in last 5 of 20)')
    // Hint sits ABOVE the visible tail (hidden lines preceded), not below it.
    const tailIdx = plain.findIndex(l => l.includes('think line 15'))
    assert.ok(hintIdx < tailIdx, 'truncation hint must appear above the tail')
    // Status line still first
    assert.ok(plain[0]!.includes('凝思中…'))
  })

  it('done: header uses past-tense 已推理 for committed scrollback', () => {
    const lines = formatThinking({
      text: 'reasoning\nanalysis\nconclusion',
      elapsedMs: 8000,
      done: true,
      expanded: false,
    }, theme)
    const plain = lines.map(stripAnsi)
    assert.equal(plain.length, 1, 'collapsed commit is a single summary line')
    assert.ok(plain[0]!.includes('已推理'), 'past-tense header')
    assert.ok(plain[0]!.includes('8s'), 'elapsed in summary')
    assert.ok(plain[0]!.includes('3 行'), 'line count in summary')
    assert.ok(!plain[0]!.includes('凝思中'), 'no present-tense wording on a finished block')
    assert.ok(!plain.some(l => l.includes('reasoning')), 'body not written when expanded:false')
  })

  it('header + expanded produce full block for scrollback', () => {
    const lines = formatThinking({
      text: 'reasoning\nanalysis\nconclusion',
      elapsedMs: 5000,
      expanded: true,
      maxLines: 60,
    }, theme)
    const plain = lines.map(stripAnsi)
    assert.ok(plain[0]!.includes('凝思中…'), 'has header')
    assert.ok(plain[0]!.includes('3 行'), 'line count in header')
    assert.ok(plain.some(l => l.includes('reasoning')))
    assert.ok(plain.some(l => l.includes('analysis')))
    assert.ok(plain.some(l => l.includes('conclusion')))
    // No truncation for small content
    assert.ok(!plain.some(l => l.includes('more lines')))
  })

  /**
   * 窄窗口回归：推理文本多是长句，按逻辑行封顶时一行 wrap 成三四个显示行，
   * 8 行逻辑行能占二十个显示行——而 live 区高度峰值会被定高视口固化成输入框
   * 上方的常驻空白。maxRows 按 wrap 后的显示行收口。
   *
   * 2026-09-12 起正文按 wide 上界硬折行输出（CJK 终端 ambiguous 折行导致
   * spinner 残影的根修）：每个输出逻辑行恰占 1 显示行，行数即显示行数；
   * 而 maxLines 路径不折行，rowsOf 仍按 auto-wrap 估算（对照组）。
   */
  describe('maxRows（按显示行封顶，窄窗口）', () => {
    const longLine = (i: number): string => `推理片段 ${i} ` + '这是一段很长的推理文本用于触发折行'.repeat(4)
    const rowsOf = (line: string, columns: number): number =>
      Math.max(1, Math.ceil(displayWidth(stripAnsi(line)) / Math.max(10, columns - 2)))

    it('长句在窄终端下按显示行收口，不超预算', () => {
      const text = Array.from({ length: 12 }, (_, i) => longLine(i)).join('\n')
      const columns = 60
      const body = formatThinking({
        text, elapsedMs: 5000, header: false, expanded: true, maxRows: 4, columns,
      }, theme)
      // 硬折行后每个输出逻辑行恒为 1 显示行（任何终端），行数即显示行数。
      const contentRows = body.filter(l => !stripAnsi(l).includes('上方省略')).length
      assert.ok(contentRows <= 4, `正文显示行数应 ≤ 4，实得 ${contentRows}（${body.length} 个逻辑行）`)
      // 硬折行不变量：每行 ≤ columns-1 wide → 任何终端恰占 1 显示行。
      for (const l of body) {
        assert.ok(
          displayWidth(stripAnsi(l), { ambiguousAsWide: true }) <= columns - 1,
          `输出行超 wide 上界：${stripAnsi(l)}`,
        )
      }
    })

    it('同样的文本按 maxLines 封顶会远超预算（对照）', () => {
      const text = Array.from({ length: 12 }, (_, i) => longLine(i)).join('\n')
      const columns = 60
      const body = formatThinking({
        text, elapsedMs: 5000, header: false, expanded: true, maxLines: 8,
      }, theme)
      const contentRows = body
        .filter(l => !stripAnsi(l).includes('上方省略'))
        .reduce((sum, l) => sum + rowsOf(l, columns), 0)
      assert.ok(contentRows > 8, `逻辑行封顶下显示行数应显著超出，实得 ${contentRows}`)
    })

    it('保留最新内容并给出省略计数', () => {
      const text = Array.from({ length: 10 }, (_, i) => `think ${i}`).join('\n')
      const plain = formatThinking({
        text, elapsedMs: 5000, header: false, expanded: true, maxRows: 3, columns: 80,
      }, theme).map(stripAnsi)
      assert.ok(plain.some(l => l.includes('think 9')), '最新一行保留')
      assert.ok(!plain.some(l => l.includes('think 0')), '最旧一行被省略')
      assert.ok(plain.some(l => l.includes('上方省略')), '给出省略提示')
    })

    it('单行长过预算时仍保留它，不产出空推理区', () => {
      const body = formatThinking({
        text: longLine(1), elapsedMs: 5000, header: false, expanded: true, maxRows: 1, columns: 40,
      }, theme)
      assert.ok(body.length >= 1, '至少保留一行')
      assert.ok(stripAnsi(body.join('')).includes('推理片段 1'), '内容仍在')
    })

    it('不传 maxRows 时行为不变（仍按 maxLines）', () => {
      const text = Array.from({ length: 20 }, (_, i) => `think line ${i}`).join('\n')
      const a = formatThinking({ text, elapsedMs: 5000, expanded: true, maxLines: 5 }, theme)
      const b = formatThinking({ text, elapsedMs: 5000, expanded: true, maxLines: 5, columns: 80 }, theme)
      assert.deepEqual(a, b, '只给 columns 不给 maxRows 不改变行为')
    })
  })
})
