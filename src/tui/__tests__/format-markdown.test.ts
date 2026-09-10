import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatMarkdown, parseBlocks, parseInline, hasMarkdown, guessLang, keywordsForLang } from '../format/markdown.js'
import { getTheme, THEMES } from '../theme.js'

const theme = getTheme()

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('hasMarkdown', () => {
  it('detects bold', () => assert.ok(hasMarkdown('**bold**')))
  it('detects code', () => assert.ok(hasMarkdown('`code`')))
  it('detects fence', () => assert.ok(hasMarkdown('```\ncode\n```')))
  it('detects headers', () => assert.ok(hasMarkdown('# Title')))
  it('detects lists', () => assert.ok(hasMarkdown('- item')))
  it('returns false for plain text', () => assert.equal(hasMarkdown('plain text'), false))
})

describe('parseInline', () => {
  it('parses bold', () => {
    const segs = parseInline('hello **world** here')
    assert.equal(segs.length, 3)
    assert.equal(segs[1]!.bold, true)
    assert.equal(segs[1]!.text, 'world')
  })

  it('parses italic', () => {
    const segs = parseInline('hello *world* here')
    assert.equal(segs[1]!.italic, true)
  })

  it('parses inline code', () => {
    const segs = parseInline('use `const` keyword')
    assert.equal(segs[1]!.code, true)
    assert.equal(segs[1]!.text, 'const')
  })

  it('parses links as underline', () => {
    const segs = parseInline('[click me](url)')
    assert.equal(segs[0]!.underline, true)
    assert.equal(segs[0]!.text, 'click me')
  })
})

describe('parseBlocks', () => {
  it('parses headers', () => {
    const blocks = parseBlocks('# Title\n\nbody')
    assert.equal(blocks[0]!.type, 'header')
    assert.equal(blocks[0]!.level, 1)
  })

  it('parses code blocks', () => {
    const blocks = parseBlocks('```ts\nconst x = 1\n```')
    assert.equal(blocks[0]!.type, 'code')
    assert.equal(blocks[0]!.language, 'ts')
  })

  it('parses lists', () => {
    const blocks = parseBlocks('- one\n- two')
    assert.equal(blocks[0]!.type, 'list')
    assert.equal(blocks[0]!.items!.length, 2)
  })

  it('parses blockquotes', () => {
    const blocks = parseBlocks('> quoted')
    assert.equal(blocks[0]!.type, 'blockquote')
  })

  it('parses paragraphs', () => {
    const blocks = parseBlocks('hello world')
    assert.equal(blocks[0]!.type, 'paragraph')
  })

  it('handles CJK header without space (non-advancing guard)', () => {
    const blocks = parseBlocks('#标题\n\n内容')
    assert.ok(blocks.length > 0)
    assert.equal(blocks[0]!.type, 'paragraph')
  })
})

describe('guessLang', () => {
  it('detects TypeScript', () => assert.equal(guessLang('import { foo } from "bar"'), 'typescript'))
  it('detects Python', () => assert.equal(guessLang('def foo():\n    pass'), 'python'))
  it('detects Go', () => assert.equal(guessLang('package main\nfunc main() {'), 'go'))
  it('detects Rust', () => assert.equal(guessLang('fn main() {\n    let mut x = 1;'), 'rust'))
  it('detects bash', () => assert.equal(guessLang('#!/bin/bash\nif true; then'), 'bash'))
})

describe('keywordsForLang', () => {
  it('returns JS keywords for typescript', () => {
    const config = keywordsForLang('typescript')
    assert.ok(config)
    assert.ok(config.keywords.has('const'))
  })

  it('returns null for unknown lang', () => {
    assert.equal(keywordsForLang('unknownlang'), null)
  })

  it('marks SQL as case insensitive', () => {
    const config = keywordsForLang('sql')
    assert.ok(config)
    assert.equal(config.caseInsensitive, true)
  })
})

describe('formatMarkdown', () => {
  it('renders plain text as-is', () => {
    const lines = formatMarkdown({ text: 'hello', columns: 80 }, theme)
    assert.equal(lines.length, 1)
    assert.equal(lines[0], 'hello')
  })

  it('行内代码取 theme.inlineCode——cyberpunk 下是冰蓝而非 secondary 品红粉', () => {
    // 锁死 markdown.ts 的 `seg.code ? theme.inlineCode : ''`：改回直接吃 secondary
    // 会让 cyberpunk 正文整屏发红（2026-09 实锤），此断言即反证。
    const out = formatMarkdown({ text: 'run `npm test` now', columns: 80 }, THEMES.cyberpunk.truecolor).join('')
    assert.ok(out.includes('38;2;122;162;247'), `inlineCode 冰蓝在场:${JSON.stringify(out)}`)
    assert.ok(!out.includes('38;2;255;92;138'), '正文不含 secondary 品红粉')
  })

  it('renders bold text with ANSI', () => {
    const lines = formatMarkdown({ text: 'hello **world**', columns: 80 }, theme)
    const line = lines[0]!
    assert.ok(line.includes('world'))
  })

  it('renders code blocks without copy-blocking borders', () => {
    const lines = formatMarkdown({ text: '```\ncode\n```', columns: 80 }, theme)
    const plain = lines.map(l => stripAnsi(l))
    // 语言标签 + 代码内容仍在
    assert.ok(plain.some(l => l.includes('code')), 'code content present')
    assert.ok(plain.some(l => /code/.test(l)), 'language label present')
    // 不含会污染选区复制的 box-drawing 边框字符
    assert.ok(!plain.some(l => l.includes('┌')), 'no top-left border')
    assert.ok(!plain.some(l => l.includes('└')), 'no bottom-left border')
    assert.ok(!plain.some(l => l.startsWith('│')), 'no left vertical bar on code lines')
  })

  it('renders headers with glyphs', () => {
    const lines = formatMarkdown({ text: '# Title', columns: 80 }, theme)
    assert.ok(stripAnsi(lines[0]!).includes('▌'))
    assert.ok(stripAnsi(lines[0]!).includes('Title'))
  })

  it('renders lists with diamond bullets', () => {
    const lines = formatMarkdown({ text: '- item1\n- item2', columns: 80 }, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('◇')))
    assert.ok(lines.some(l => stripAnsi(l).includes('item1')))
  })

  it('renders blockquotes with left bar + italic', () => {
    const lines = formatMarkdown({ text: '> quoted text', columns: 80 }, theme)
    assert.ok(stripAnsi(lines[0]!).includes('▎'), 'left accent bar')
    assert.ok(stripAnsi(lines[0]!).includes('quoted text'))
    assert.ok(lines[0]!.includes('\x1B[3m'), 'quote body is italic')
  })

  it('renders horizontal rules', () => {
    const lines = formatMarkdown({ text: '---', columns: 40 }, theme)
    const plain = stripAnsi(lines[0]!)
    assert.ok(plain.includes('─'))
    assert.ok(plain.length >= 36)
  })

  it('handles numbered-line tool output', () => {
    const text = '   1│ import { foo } from "bar"\n   2│ const x = 1'
    const lines = formatMarkdown({ text, columns: 80, language: 'typescript' }, theme)
    assert.ok(lines[0]!.includes('│'))
    assert.ok(lines[0]!.includes('import'))
  })

  it('returns empty for falsy text', () => {
    assert.deepEqual(formatMarkdown({ text: '', columns: 80 }, theme), [])
  })

  it('syntax highlights code blocks', () => {
    const lines = formatMarkdown({ text: '```ts\nconst x = 1\n```', columns: 80 }, theme)
    // Should have ANSI escape sequences (color) for keyword 'const'
    const codeLine = lines.find(l => stripAnsi(l).includes('const'))
    assert.ok(codeLine)
    assert.ok(/\x1B\[/.test(codeLine!), 'has ANSI color on keyword')
  })

  it('显式标记与高亮 Git 提交标签行 (⎇ commit hash + files + diff)', () => {
    const lines = formatMarkdown({ text: '95454cd0 — 5 files, +70/-4。', columns: 80 }, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('⎇ 95454cd0')))
    assert.ok(lines.some(l => stripAnsi(l).includes('+70')))
  })

  it('显式标识与高亮代码行首圈号序号 (①, ②)', () => {
    const lines = formatMarkdown({ text: '```bash\n①git push origin main\n②npm publish\n```', columns: 80 }, theme)
    const line1 = lines.find(l => stripAnsi(l).includes('git push'))
    assert.ok(line1)
    assert.ok(line1.includes('\x1B['), '圈号序号带有 ANSI 醒目色彩')
  })

  it('醒目标记主控回复末尾提问 (⚡ 是否执行？)', () => {
    const text = '本地已就绪。需要你确认：\n\n是否执行？'
    const lines = formatMarkdown({ text, columns: 80 }, theme)
    const lastLine = lines[lines.length - 1]
    assert.ok(lastLine)
    assert.ok(stripAnsi(lastLine).includes('⚡ 是否执行？'))
  })

  it('陈述句以「需要/确认」开头但不是提问——不加 ⚡', () => {
    for (const text of ['需要我可以继续。', '确认无误。', '是否如此已核实，没问题。']) {
      const lines = formatMarkdown({ text, columns: 80 }, theme)
      const lastLine = lines[lines.length - 1]
      assert.ok(!stripAnsi(lastLine!).includes('⚡'), `误染：${text}`)
    }
  })

  it('提问行加 ⚡ 时行内既有格式不被剥掉', () => {
    const text = '要执行 `rm -rf build` 吗？'
    const lines = formatMarkdown({ text, columns: 80 }, theme)
    const lastLine = lines[lines.length - 1]!
    assert.ok(stripAnsi(lastLine).includes('⚡'))
    // 行内的代码段仍带着自己的 ANSI 颜色（整行去色重染会把它剥成纯文本）
    assert.ok(lastLine.replace(/\x1b\[0?m/g, '').includes('\x1b['), '行内代码高亮应保留')
  })
})
