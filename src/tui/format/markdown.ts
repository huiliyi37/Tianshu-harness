/**
 * T9 纯 ANSI Markdown 格式化器。
 *
 * 从 `markdown-render.tsx` 提取：所有解析逻辑（parseBlocks、parseInline、
 * highlightLine、guessLang、keywordsForLang）保持不变，只将 React 渲染函数
 * 替换为纯 ANSI 字符串构建器。
 *
 * 零 React/Ink 依赖。输出为 ANSI 格式化字符串数组（每行一个元素）。
 */

import { ANSI, color, fg, bg, hyperlink } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { hiddenLinesMarker } from './hidden-lines.js'
import { latexToBlock } from '../pi/latex-block.js'
import { renderMathInText, latexToUnicode } from '../pi/latex-to-unicode.js'
import { proseColumns, wrapReadingText } from './reading-layout.js'
import { renderTable } from './table.js'
import { displayWidth, ambiguousWideEnabled } from '../width.js'

// ── Types ──────────────────────────────────────────────────────

export interface Segment {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  underline?: boolean
  color?: string
  dimmed?: boolean
  /** OSC 8 超链接目标（markdown [text](url)）；不支持的终端纯文本降级。 */
  href?: string
}
export type BlockType = 'paragraph' | 'code' | 'header' | 'list' | 'blockquote' | 'hr' | 'table' | 'math'

export interface Block {
  type: BlockType
  level?: number
  language?: string
  content: string
  items?: string[]
  /** 列表块：标记为 `1. ` 的有序列表。parse 阶段会剥掉标记，不记下来就再也分不出。 */
  ordered?: boolean
  /** 每项原始缩进与标记，保留混合/嵌套列表及起始编号。 */
  itemPrefixes?: string[]
}

// ── Keyword sets (unchanged from markdown-render.tsx) ──────────

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'class', 'new', 'this', 'import', 'export', 'from', 'default', 'async', 'await',
  'try', 'catch', 'throw', 'typeof', 'instanceof', 'switch', 'case', 'break',
  'continue', 'interface', 'type', 'enum', 'extends', 'implements', 'readonly',
  'true', 'false', 'null', 'undefined', 'void', 'delete', 'in', 'of', 'as',
])

const PY_KEYWORDS = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import',
  'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'yield',
  'lambda', 'pass', 'break', 'continue', 'and', 'or', 'not', 'in', 'is',
  'True', 'False', 'None', 'self', 'async', 'await', 'print',
])

const GO_KEYWORDS = new Set([
  'func', 'return', 'if', 'else', 'for', 'range', 'var', 'const', 'type',
  'struct', 'interface', 'package', 'import', 'defer', 'go', 'chan', 'select',
  'case', 'switch', 'default', 'break', 'continue', 'map', 'nil', 'true', 'false',
  'err', 'make', 'append',
])

const RUST_KEYWORDS = new Set([
  'fn', 'let', 'mut', 'pub', 'struct', 'enum', 'impl', 'trait', 'mod', 'use',
  'return', 'if', 'else', 'for', 'while', 'loop', 'match', 'self', 'Self',
  'true', 'false', 'Some', 'None', 'Ok', 'Err', 'async', 'await', 'move',
  'where', 'type', 'const', 'static', 'ref', 'as', 'in',
])

const BASH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case',
  'esac', 'function', 'return', 'exit', 'echo', 'export', 'source', 'alias',
  'local', 'readonly', 'set', 'unset', 'true', 'false',
])

const CPP_KEYWORDS = new Set([
  'alignas', 'alignof', 'and', 'and_eq', 'asm', 'auto', 'bitand', 'bitor',
  'bool', 'break', 'case', 'catch', 'char', 'class', 'compl', 'concept', 'const',
  'const_cast', 'continue', 'default', 'delete', 'do', 'double', 'else', 'enum',
  'explicit', 'export', 'extern', 'false', 'float', 'for', 'friend', 'goto',
  'if', 'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept',
  'not', 'nullptr', 'operator', 'or', 'private', 'protected', 'public',
  'reinterpret_cast', 'return', 'short', 'signed', 'sizeof', 'static',
  'static_cast', 'struct', 'switch', 'template', 'this', 'throw', 'true', 'try',
  'typedef', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void',
  'volatile', 'while',
])

const SQL_KEYWORDS = new Set([
  'select', 'insert', 'update', 'delete', 'from', 'where', 'join', 'left',
  'right', 'inner', 'outer', 'on', 'group', 'by', 'order', 'having', 'limit',
  'offset', 'create', 'table', 'alter', 'drop', 'index', 'view', 'into',
  'values', 'set', 'and', 'or', 'not', 'in', 'is', 'null', 'true', 'false',
  'as', 'distinct', 'count', 'sum', 'avg', 'min', 'max', 'union', 'all',
  'any', 'exists', 'like', 'between', 'case', 'when', 'then', 'else', 'end',
])

const RUBY_KEYWORDS = new Set([
  'alias', 'and', 'begin', 'break', 'case', 'class', 'def', 'do', 'else',
  'elsif', 'end', 'ensure', 'false', 'for', 'if', 'in', 'module', 'next',
  'nil', 'not', 'or', 'redo', 'rescue', 'retry', 'return', 'self', 'super',
  'then', 'true', 'undef', 'unless', 'until', 'when', 'while', 'yield',
])

const PHP_KEYWORDS = new Set([
  'abstract', 'and', 'array', 'as', 'break', 'case', 'catch', 'class',
  'const', 'continue', 'declare', 'default', 'do', 'echo', 'else', 'elsif',
  'extends', 'final', 'finally', 'fn', 'for', 'foreach', 'function', 'global',
  'if', 'implements', 'include', 'instanceof', 'interface', 'isset', 'list',
  'match', 'namespace', 'new', 'or', 'print', 'private', 'protected', 'public',
  'return', 'static', 'switch', 'throw', 'trait', 'try', 'unset', 'use',
  'var', 'while', 'yield', 'true', 'false', 'null',
])

const DOCKERFILE_KEYWORDS = new Set([
  'from', 'run', 'cmd', 'label', 'expose', 'env', 'add', 'copy', 'entrypoint',
  'volume', 'user', 'workdir', 'arg', 'onbuild', 'stopsignal', 'healthcheck', 'shell',
])

export interface LangConfig {
  keywords: Set<string>
  caseInsensitive?: boolean
}

export function keywordsForLang(lang: string): LangConfig | null {
  const l = lang.toLowerCase()
  if (l === 'typescript' || l === 'ts' || l === 'javascript' || l === 'js' || l === 'jsx' || l === 'tsx') return { keywords: JS_KEYWORDS }
  if (l === 'python' || l === 'py') return { keywords: PY_KEYWORDS }
  if (l === 'go' || l === 'golang') return { keywords: GO_KEYWORDS }
  if (l === 'rust' || l === 'rs') return { keywords: RUST_KEYWORDS }
  if (l === 'bash' || l === 'sh' || l === 'shell' || l === 'zsh') return { keywords: BASH_KEYWORDS }
  if (l === 'c' || l === 'cpp' || l === 'cc' || l === 'h' || l === 'hpp') return { keywords: CPP_KEYWORDS }
  if (l === 'java') return { keywords: new Set(['abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null']) }
  if (l === 'sql') return { keywords: SQL_KEYWORDS, caseInsensitive: true }
  if (l === 'ruby' || l === 'rb') return { keywords: RUBY_KEYWORDS }
  if (l === 'php') return { keywords: PHP_KEYWORDS }
  if (l === 'dockerfile' || l === 'docker') return { keywords: DOCKERFILE_KEYWORDS, caseInsensitive: true }
  return null
}

// ── Syntax token colors ───────────────────────────────────────
// 颜色跟随当前主题，保证切换主题时代码块风格一致；无 theme 时回退到原硬编码色。

function getSynColors(theme?: RivetTheme) {
  return {
    keyword: theme?.primary ?? '#d7dce3',
    type: theme?.secondary ?? '#b0b8c4',
    func: theme?.warning ?? '#b0b8c4',
    string: theme?.success ?? '#9aa2b1',
    number: theme?.warning ?? '#9aa2b1',
    punct: theme?.dim ?? '#6e7681',
    comment: theme?.dim ?? '#6e7681',
  }
}

// ── Inline tokenizer ───────────────────────────────────────────

export function parseInline(text: string): Segment[] {
  const segments: Segment[] = []
  let i = 0
  let buf = ''

  const flush = () => {
    if (buf) { segments.push({ text: buf }); buf = '' }
  }

  while (i < text.length) {
    if ((text[i] === '*' && text[i + 1] === '*') || (text[i] === '_' && text[i + 1] === '_')) {
      const delim = text.slice(i, i + 2)
      const end = text.indexOf(delim, i + 2)
      if (end !== -1) { flush(); segments.push({ text: text.slice(i + 2, end), bold: true }); i = end + 2; continue }
    }
    if (text[i] === '*' && text[i + 1] !== '*' && (i === 0 || text[i - 1] !== '*')) {
      const end = text.indexOf('*', i + 1)
      if (end !== -1 && text[end + 1] !== '*' && (end === 0 || text[end - 1] !== '*')) {
        flush(); segments.push({ text: text.slice(i + 1, end), italic: true }); i = end + 1; continue
      }
    }
    if (text[i] === '_' && text[i + 1] !== '_' && (i === 0 || /[a-zA-Z]/.test(text[i - 1] ?? ''))) {
      const end = text.indexOf('_', i + 1)
      if (end !== -1 && text[end + 1] !== '_') {
        flush(); segments.push({ text: text.slice(i + 1, end), italic: true }); i = end + 1; continue
      }
    }
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      if (end !== -1) { flush(); segments.push({ text: text.slice(i + 1, end), code: true }); i = end + 1; continue }
    }
    if (text[i] === '[') {
      const textEnd = text.indexOf(']', i + 1)
      if (textEnd !== -1 && text[textEnd + 1] === '(') {
        const urlEnd = text.indexOf(')', textEnd + 2)
        if (urlEnd !== -1) {
          flush()
          const href = text.slice(textEnd + 2, urlEnd).trim()
          segments.push({ text: text.slice(i + 1, textEnd), underline: true, href: href || undefined })
          i = urlEnd + 1; continue
        }
      }
    }
    buf += text[i]; i++
  }
  flush()
  return segments
}

// ── Block parser ───────────────────────────────────────────────

export function parseBlocks(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    if (line.startsWith('```')) {
      const language = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        codeLines.push(lines[i]!); i++
      }
      blocks.push({ type: 'code', language: language || undefined, content: codeLines.join('\n') })
      i++; continue
    }

    // Display math: $$...$$ (same-line or multi-line) or \[...\]
    if (line.startsWith('$$') || line.startsWith('\\[')) {
      const opener = line.startsWith('$$') ? '$$' : '\\['
      const closer = line.startsWith('$$') ? '$$' : '\\]'
      // Same-line close: $$x^2$$ or \[x^2\]
      if (line.endsWith(closer) && line.length > opener.length) {
        const body = line.slice(opener.length, line.length - closer.length)
        blocks.push({ type: 'math', content: body })
        i++; continue
      }
      // Multi-line: collect until the closing delimiter
      const bodyLines: string[] = []
      i++
      while (i < lines.length && !lines[i]!.includes(closer)) {
        bodyLines.push(lines[i]!); i++
      }
      // Include a partial last line (e.g. trailing text after $$ on close line)
      if (i < lines.length) {
        const closeLine = lines[i]!
        const closeIdx = closeLine.indexOf(closer)
        if (closeIdx > 0) bodyLines.push(closeLine.slice(0, closeIdx))
        i++
      }
      blocks.push({ type: 'math', content: bodyLines.join('\n') })
      continue
    }

    const headerMatch = line.match(/^(#{1,6})\s+(.*)/)
    if (headerMatch) {
      blocks.push({ type: 'header', level: headerMatch[1]!.length, content: headerMatch[2]! })
      i++; continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr', content: '' }); i++; continue
    }

    if (line.startsWith('> ')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i]!.startsWith('> ')) {
        quoteLines.push(lines[i]!.slice(2)); i++
      }
      blocks.push({ type: 'blockquote', content: quoteLines.join('\n') }); continue
    }

    if (/^(\s*[-*]\s|\s*\d+\.\s)/.test(line)) {
      const items: string[] = []
      const itemPrefixes: string[] = []
      let ordered = false
      while (i < lines.length && /^(\s*[-*]\s|\s*\d+\.\s)/.test(lines[i]!)) {
        if (/^\s*\d+\.\s/.test(lines[i]!)) ordered = true
        const prefix = lines[i]!.match(/^\s*[-*]\s|\s*\d+\.\s/)![0].replace(/\t/g, '    ')
        itemPrefixes.push(prefix)
        items.push(lines[i]!.replace(/^\s*[-*]\s|\s*\d+\.\s/, '')); i++
      }
      blocks.push({ type: 'list', content: items.join('\n'), items, ordered, itemPrefixes }); continue
    }

    if (line.includes('|') && i + 1 < lines.length && /^\|?[\s-:|]+\|?$/.test(lines[i + 1]!)) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i]!.includes('|')) {
        tableLines.push(lines[i]!); i++
      }
      blocks.push({ type: 'table', content: tableLines.join('\n') }); continue
    }

    if (line.trim() === '') { i++; continue }

    const paraLines: string[] = []
    while (i < lines.length && lines[i]!.trim() !== '' && !lines[i]!.startsWith('#') && !lines[i]!.startsWith('```') && !lines[i]!.startsWith('> ') && !/^(\s*[-*]\s|\s*\d+\.\s)/.test(lines[i]!)) {
      paraLines.push(lines[i]!); i++
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', content: paraLines.join('\n') })
    } else {
      blocks.push({ type: 'paragraph', content: line }); i++
    }
  }
  return blocks
}

// ── Syntax highlighting ───────────────────────────────────────

export function highlightLine(line: string, keywords: Set<string> | null, caseInsensitive = false, theme?: RivetTheme): Segment[] {
  if (!keywords) return [{ text: line }]

  const SYN = getSynColors(theme)
  const segments: Segment[] = []
  const commentIdx = line.indexOf('//')
  const hashCommentIdx = line.indexOf('#')
  let effectiveCommentIdx = -1
  if (commentIdx !== -1 && (hashCommentIdx === -1 || commentIdx < hashCommentIdx)) effectiveCommentIdx = commentIdx
  else if (hashCommentIdx !== -1) effectiveCommentIdx = hashCommentIdx

  const effectiveLine = effectiveCommentIdx !== -1 ? line.slice(0, effectiveCommentIdx) : line
  const commentPart = effectiveCommentIdx !== -1 ? line.slice(effectiveCommentIdx) : ''

  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\w+\b|\s+|[^\s\w]+)/g
  let match
  while ((match = re.exec(effectiveLine)) !== null) {
    const token = match[0]!
    if (/^\s+$/.test(token)) { segments.push({ text: token }); continue }
    if (/^["'`]/.test(token)) { segments.push({ text: token, color: SYN.string }); continue }
    if (/^[^\s\w]+$/.test(token)) { segments.push({ text: token, color: SYN.punct }); continue }

    const matchToken = caseInsensitive ? token.toLowerCase() : token
    if (keywords.has(matchToken)) {
      segments.push({ text: token, color: SYN.keyword, bold: true })
    } else if (/^\d[\d._]*$/.test(token)) {
      segments.push({ text: token, color: SYN.number })
    } else if (/^[A-Z][a-zA-Z0-9]*$/.test(token)) {
      segments.push({ text: token, color: SYN.type })
    } else if (effectiveLine[match.index + token.length] === '(') {
      segments.push({ text: token, color: SYN.func })
    } else {
      segments.push({ text: token })
    }
  }
  if (commentPart) segments.push({ text: commentPart, color: SYN.comment })
  return segments
}

// ── Language detection ────────────────────────────────────────

export function guessLang(text: string): string | undefined {
  const sample = text.slice(0, 500)
  if (/\bimport\b.*\bfrom\b|export\s+(default|const|function)|=>\s*[{(]|:\s*(string|number|boolean)\b/.test(sample)) return 'typescript'
  if (/\bdef\b|\bclass\b.*:$|import\s+\w+/m.test(sample)) return 'python'
  if (/\bfunc\b|\bpackage\b\s+\w+|:=/.test(sample)) return 'go'
  if (/\bfn\b|\blet\s+mut\b|\bimpl\b/.test(sample)) return 'rust'
  if (sample.startsWith('#!') || /\bfi\b|\bdone\b|\besac\b/.test(sample)) return 'bash'
  return undefined
}

export function hasMarkdown(text: string): boolean {
  return text.includes('**') || text.includes('`') || text.includes('```')
    || /^#{1,6}\s/m.test(text) || /^[-*]\s/m.test(text) || /^>\s/m.test(text)
    // 编号列表：parseBlocks 一直支持它（`\s*\d+\.\s`），但这里漏判 → 编号列表
    // 降级走纯文本快速路径，块结构、留白、序号高亮全部失效。2026-09-26 用户
    // 反馈「分点挤在一起、没有结构」时暴露：交付报告的四项就是这么被吞掉的。
    || /^\s*\d+\.\s/m.test(text)
    || /^(-{3,}|\*{3,}|_{3,})\s*$/m.test(text)
    // Inline/display math delimiters trigger the full parser too.
    || /\$[^\s$]/.test(text) || text.includes('$') || text.includes('\\[') || text.includes('\\(')
    // Markdown links [text](url) — 触发行内解析以渲染 OSC 8 超链接。
    || /\[[^\]]+\]\([^)]+\)/.test(text)
    || /^\s*\|?\s*:?-{3,}:?\s*\|[\s|:-]*$/m.test(text)
}

const NUMBERED_LINE_RE = /^\s*\d+│/

// ── ANSI rendering ────────────────────────────────────────────

function formatSegment(seg: Segment, theme: RivetTheme): string {
  let s = seg.text
  const opts = { bold: seg.bold, italic: seg.italic, underline: seg.underline, dim: seg.dimmed }
  // 水墨原则：强调靠字重(bold/italic)而非满屏着色。显式色 > 行内代码(inlineCode) > 中性前景。
  // 旧实现把所有 bold/em 都染成 primary 微紫 → 正文一片紫；改为中性默认前景。
  // 行内代码取 theme.inlineCode（缺省 = secondary）。**不要直接吃 secondary**：
  // 正文里文件名/函数名/命令出现频率极高，secondary 若是大面积色（cyberpunk 的
  // 品红粉）就会整屏染色——2026-09「正文满屏发红」即此，故拆出独立 token。
  const fgHex = seg.color ?? (seg.code ? theme.inlineCode : '')

  // 使用 color() 包裹，除非是普通文本
  if (seg.color || seg.code || seg.bold || seg.italic || seg.underline || seg.dimmed) {
    s = color(seg.text, fgHex, opts)
  }
  // markdown 链接 → OSC 8 可点击（支持的终端；其余保持下划线纯文本）
  if (seg.href) s = hyperlink(s, seg.href)
  return s
}

function formatInlineToAnsi(segments: Segment[], theme: RivetTheme): string {
  return segments.map(seg => formatSegment(seg, theme)).join('')
}

// ── Git & Code & Prompt Helpers ───────────────────────────────

/**
 * 1. 尝试检测并格式化 Git Commit 提交标签行
 * 示例: "95454cd0  — 5 files, +70/-4。"
 */
export function tryFormatGitCommitLine(line: string, theme: RivetTheme): string | null {
  // 代码块内缩进的提交行要保住前导空白——trim 后不补回，缩进层级被顶格抹平。
  const indent = /^\s*/.exec(line)![0]
  const trimmed = line.trim()
  const gitLineRe = /^(?:commit\s+)?([0-9a-f]{7,40})\s+(—|-|:)\s+(.*)$/i
  const match = gitLineRe.exec(trimmed)
  if (!match) return null

  const [, hash, sep, rest] = match as unknown as [string, string, string, string]
  if (!/\b\d+\s+files?|\+\d+|-\d+|insertions?|deletions?/i.test(rest)) return null

  const hashPart = color(`⎇ ${hash}`, theme.secondary, { bold: true, underline: true })
  const sepPart = color(` ${sep} `, theme.dim)

  const formattedRest = rest
    .replace(/\+(\d+)/g, color('+$1', theme.success, { bold: true }))
    .replace(/-(\d+)/g, color('-$1', theme.error, { bold: true }))
    .replace(/(\d+)(\s+files?)/g, color('$1$2', theme.assistantColor))

  return `${indent}${hashPart}${sepPart}${formattedRest}`
}

/**
 * 2. 高亮行首的代码序号（如 ①-⑩ / ❶-❿ / 1. 2. 等）
 */
export function highlightCodeLineNumber(renderedLine: string, theme: RivetTheme): string {
  const circleNumRe = /^(\s*)([①②③④⑤⑥⑦⑧⑨⑩❶❷❸❹❺❻❼❽❾❿])(\s*.*)$/
  const circleMatch = circleNumRe.exec(renderedLine)
  if (circleMatch) {
    const [, indent, num, rest] = circleMatch as unknown as [string, string, string, string]
    return `${indent}${color(num, theme.warning, { bold: true })}${rest}`
  }

  const digitNumRe = /^(\s*)(\d+[.\)])(\s+.*)$/
  const digitMatch = digitNumRe.exec(renderedLine)
  if (digitMatch) {
    const [, indent, num, rest] = digitMatch as unknown as [string, string, string, string]
    return `${indent}${color(num, theme.warning, { bold: true })}${rest}`
  }

  return renderedLine
}

function formatCodeBlock(language: string | undefined, content: string, columns: number, theme: RivetTheme, fullDocument = false): string[] {
  const lines = content.split('\n')
  const langConfig = language ? keywordsForLang(language) : null
  const keywords = langConfig?.keywords ?? null
  const caseInsensitive = langConfig?.caseInsensitive ?? false

  const MAX_CODE_LINES = fullDocument ? Infinity : 60
  const truncated = lines.length > MAX_CODE_LINES
  const visible = truncated ? lines.slice(0, MAX_CODE_LINES) : lines

  const result: string[] = []

  result.push(color(language || 'code', theme.muted))

  // 代码行直接渲染
  for (const line of visible) {
    const gitFormatted = tryFormatGitCommitLine(line, theme)
    if (gitFormatted) {
      result.push(gitFormatted)
      continue
    }
    const segs = highlightLine(line, keywords, caseInsensitive, theme)
    const ansiLine = formatInlineToAnsi(segs, theme)
    result.push(highlightCodeLineNumber(ansiLine, theme))
  }

  if (truncated) {
    result.push(color(hiddenLinesMarker(lines.length - MAX_CODE_LINES), theme.muted))
  }

  return result
}

function formatBlock(block: Block, columns: number, theme: RivetTheme, fullDocument = false, wrapText = true): string[] {
  const result: string[] = []

  switch (block.type) {
    case 'header': {
      const level = block.level ?? 1
      const colors = [theme.primary, undefined, undefined, theme.secondary, theme.secondary, theme.secondary]
      const headerColor = colors[level - 1]
      result.push(color(block.content, headerColor ?? theme.assistantColor, { bold: true }))
      break
    }
    case 'code':
      result.push(...formatCodeBlock(block.language, block.content, columns, theme, fullDocument))
      break
    case 'math': {
      const mathLines = latexToBlock(block.content)
      if (mathLines.length === 0) {
        result.push(color(latexToUnicode(block.content), theme.assistantColor))
      } else {
        for (const ml of mathLines) {
          result.push(color(ml, theme.assistantColor))
        }
      }
      break
    }
    case 'list': {
      const items = block.items ?? block.content.split('\n')
      items.forEach((item, idx) => {
        const itemAnsi = formatInlineToAnsi(parseInline(item), theme)
        const original = block.itemPrefixes?.[idx] ?? (block.ordered ? `${idx + 1}. ` : '- ')
        const indent = original.match(/^\s*/)![0]
        const marker = original.trim()
        const bullet = /^\d+\.$/.test(marker)
          ? color(marker, theme.warning, { bold: true }) : color('◇', theme.secondary)
        const prefix = `${indent}${bullet} `
        const continuation = ' '.repeat(displayWidth(prefix, { ambiguousAsWide: ambiguousWideEnabled() }))
        const text = `${prefix}${highlightCodeLineNumber(itemAnsi, theme)}`
        result.push(...(wrapText ? wrapReadingText(text, proseColumns(columns), continuation) : [text]))
      })
      break
    }
    case 'blockquote':
      result.push(`${color('▎', theme.secondary)} ${color(block.content, theme.muted, { italic: true })}`)
      break
    case 'hr':
      result.push(color('─'.repeat(Math.max(20, columns - 4)), theme.dim))
      break
    case 'table': {
      const tableLines = block.content.split('\n')
      const dataLines = tableLines.filter(l => !/^\|?[\s-:|]+\|?$/.test(l.trim()))
      const cells = dataLines.map(line => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => formatInlineToAnsi(parseInline(cell.trim().replace(/\\\|/g, '|')), theme)))
      if (wrapText) result.push(...renderTable(cells, columns, theme))
      else {
        // Document previews retain each cell as a logical row, even on narrow screens.
        const [headers = [], ...rows] = cells
        for (const [index, row] of rows.entries()) {
          if (index > 0) result.push('')
          for (const [column, cell] of row.entries()) result.push(`${headers[column] ?? column + 1}: ${cell}`)
        }
        if (!rows.length) result.push(headers.join(' · '))
      }
      break
    }
    case 'paragraph':
    default: {
      const lines = block.content.split('\n')
      for (const line of lines) {
        const gitFormattedLine = tryFormatGitCommitLine(line, theme)
        if (gitFormattedLine) {
          result.push(gitFormattedLine)
        } else {
          const formatted = color(formatInlineToAnsi(parseInline(renderMathInText(line)), theme), theme.assistantColor)
          result.push(highlightCodeLineNumber(formatted, theme))
        }
      }
      break
    }
  }

  return wrapText && ['paragraph', 'blockquote'].includes(block.type)
    ? result.flatMap(line => wrapReadingText(line, proseColumns(columns, 0)))
    : result
}

// ── Public API ─────────────────────────────────────────────────

export interface FormatMarkdownInput {
  text: string
  /** 可选语言提示（用于语法高亮） */
  language?: string
  /** 终端宽度 */
  columns: number
  /** Document viewers retain complete code blocks instead of the inline 60-line excerpt. */
  fullDocument?: boolean
  /** Viewers can wrap logical rows themselves while retaining search/read anchors. */
  wrapText?: boolean
}

/**
 * 将 Markdown 文本格式化为 ANSI 行数组。
 *
 * 这是 `Markdown` React 组件的纯 ANSI 替代。
 * 零 React/Ink 依赖。
 */
export function formatMarkdown(input: FormatMarkdownInput, theme: RivetTheme): string[] {
  if (!input.text) return []

  const result: string[] = []

  // 检测编号行格式（read_file 工具输出）
  if (!hasMarkdown(input.text) && NUMBERED_LINE_RE.test(input.text)) {
    const lang = input.language ?? guessLang(input.text)
    const langConfig = lang ? keywordsForLang(lang) : null
    const keywords = langConfig?.keywords ?? null
    const caseInsensitive = langConfig?.caseInsensitive ?? false

    for (const line of input.text.split('\n')) {
      const pipeIdx = line.indexOf('│')
      if (pipeIdx === -1) { result.push(line); continue }
      const gutter = line.slice(0, pipeIdx + 1)
      const code = line.slice(pipeIdx + 1)
      const segs = highlightLine(code, keywords, caseInsensitive, theme)
      result.push(`${color(gutter, theme.dim)}${formatInlineToAnsi(segs, theme)}`)
    }
    return result
  }

  // 纯文本快速路径
  if (!hasMarkdown(input.text)) {
    for (const line of input.text.split('\n')) {
      const gitFormatted = tryFormatGitCommitLine(line, theme)
      const text = gitFormatted ?? highlightCodeLineNumber(line, theme)
      result.push(...(input.wrapText === false ? [text] : wrapReadingText(text, proseColumns(input.columns, 0))))
    }
  } else {
    // 完整 Markdown 解析
    const blocks = parseBlocks(input.text)
    for (const block of blocks) {
      // 块间留白：标题 / 段落 / 列表 / 代码块互不粘连。**只加在 markdown 路径**——
      // 纯文本快速路径的逐行紧凑排布是刻意的（工具输出与逐行文本撑开会翻倍）。
      if (result.length > 0) result.push('')
      result.push(...formatBlock(block, input.columns, theme, input.fullDocument, input.wrapText))
    }
  }

  // 末尾句检查：若最后一句话以问号收尾（提问探询），前缀 ⚡ 醒目高亮。
  // 只认问号结尾——「需要/确认/是否…」开头的陈述句（"确认无误。"）不是提问，
  // 不能以这些词开头就染。原行保持不动：整行去色重染会把行内既有格式
  // （代码高亮、引用条）一并剥掉，所以只在前面加 ⚡。
  for (let i = result.length - 1; i >= 0; i--) {
    const lineStr = result[i]
    if (!lineStr) continue
    const plainLine = lineStr.replace(/\u001b\[[0-9;]*m/g, '').trim()
    if (!plainLine) continue

    if (/[？?]\s*$/.test(plainLine) && !plainLine.includes('⚡')) {
      result[i] = `${color('⚡', theme.warning, { bold: true })} ${lineStr}`
    }
    break
  }

  return result
}
