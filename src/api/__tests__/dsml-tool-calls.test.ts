import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { recoverDsmlToolCallsFromContent, type DsmlToolUseBlock } from '../dsml-tool-calls.js'

// 竖线是 U+FF5C 全角字符（线上抓样如此）；半角 | 也要容忍。
const V = '\uFF5C'
const block = (inner: string) => `<${V}DSML${V}tool_calls>\n${inner}\n</${V}DSML${V}tool_calls>`
const invoke = (name: string, params: string) => `<${V}DSML${V}invoke name="${name}">\n${params}\n</${V}DSML${V}invoke>`
const param = (name: string, value: string, asString = true) =>
  `<${V}DSML${V}parameter name="${name}" string="${asString}">${value}</${V}DSML${V}parameter>`

function collect(text: string) {
  const blocks: DsmlToolUseBlock[] = []
  const remaining = recoverDsmlToolCallsFromContent(text, b => blocks.push(b))
  return { blocks, remaining }
}

describe('recoverDsmlToolCallsFromContent', () => {
  it('returns null and emits nothing when no DSML tool_calls marker is present', () => {
    const { blocks, remaining } = collect('普通回答，没有任何标记。')
    assert.equal(remaining, null, 'null 让调用方保持原文不变')
    assert.equal(blocks.length, 0)
  })

  it('does not fire on prose that只 mentions the marker without a complete invoke', () => {
    const { blocks, remaining } = collect(`我们讨论一下 <${V}DSML${V}tool_calls> 这个格式。`)
    assert.equal(remaining, null, '复述标记不等于发起调用')
    assert.equal(blocks.length, 0)
  })

  it('parses a well-formed block and strips only the markup region', () => {
    const { blocks, remaining } = collect(`前言。\n${block(invoke('read_file', param('file_path', '/tmp/a')))}`)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0]!.name, 'read_file')
    assert.deepEqual(blocks[0]!.input, { file_path: '/tmp/a' })
    assert.equal(remaining, '前言。', '周边散文保留，不连坐丢失')
  })

  it('tolerates half-width pipes', () => {
    const text =
      '<|DSML|tool_calls><|DSML|invoke name="grep"><|DSML|parameter name="pattern" string="true">foo</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>'
    const { blocks } = collect(text)
    assert.equal(blocks.length, 1)
    assert.deepEqual(blocks[0]!.input, { pattern: 'foo' })
  })

  it('keeps unparsable non-string parameters as raw text', () => {
    const { blocks } = collect(block(invoke('grep', param('max_results', 'not-json', false))))
    assert.deepEqual(blocks[0]!.input, { max_results: 'not-json' })
  })

  it('strips to end of text when the closing marker is missing', () => {
    const { blocks, remaining } = collect(`前言。\n<${V}DSML${V}tool_calls>\n${invoke('read_file', param('file_path', '/tmp/a'))}`)
    assert.equal(blocks.length, 1)
    assert.equal(remaining, '前言。')
  })

  it('emits distinct ids for parallel invokes', () => {
    const { blocks } = collect(block(`${invoke('read_file', param('file_path', '/a'))}\n${invoke('grep', param('pattern', 'x'))}`))
    assert.equal(blocks.length, 2)
    assert.deepEqual(blocks.map(b => b.name), ['read_file', 'grep'])
    assert.notEqual(blocks[0]!.id, blocks[1]!.id)
  })
})

// Treating Markdown literals as protocol must emit no actionable calls.
for (const wrapper of [
  (s: string) => 'Example:\n```xml\n' + s + '\n```',
  (s: string) => 'Example:\n~~~xml\n' + s + '\n~~~',
  (s: string) => '> ' + s.replaceAll('\n', '\n> '),
  (s: string) => 'Example: `' + s.replaceAll('\n', ' ') + '`',
]) {
  it('preserves a complete DSML example quoted as Markdown', () => {
    const literal = wrapper(block(invoke('fictional_write', param('path', 'example.txt'))))
    const { blocks, remaining } = collect(literal)
    assert.deepEqual(blocks, [])
    assert.equal(remaining, null)
  })
}

it('only parses invokes inside actionable envelopes and preserves literal examples and intervening prose', () => {
  const example = '```xml\n' + block(invoke('fictional_example', '')) + '\n```'
  const outside = invoke('fictional_outside', '')
  const input = example + '\n' + block(invoke('fictional_first', '')) + '\nkeep this prose\n' + outside + '\n' + block(invoke('fictional_second', ''))
  const { blocks, remaining } = collect(input)
  assert.deepEqual(blocks.map(b => b.name), ['fictional_first', 'fictional_second'])
  assert.equal(remaining, example + '\n\nkeep this prose\n' + outside)
})
