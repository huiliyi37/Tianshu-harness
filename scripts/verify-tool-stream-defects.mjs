import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const client = 'src/api/openai-client.ts'
const buffer = 'src/api/openai-tool-call-buffer.ts'
const replay = 'src/api/__tests__/responses-tool-replay.test.ts'
const names = 'src/api/__tests__/openai-client-tool-name.test.ts'
const responses = 'src/api/responses-client.ts'
const codex = 'src/api/codex-client.ts'
const anthropic = 'src/api/anthropic-client.ts'
const nativeReplay = 'src/api/__tests__/anthropic-tool-replay.test.ts'

const mutants = [
  { label: 'raw name concatenation', file: client, test: names, pattern: 'public stream preserves repeated full names',
    change: source => source.replace('if (buf.nameState) {\n            try {', 'if (buf.nameState && false) {\n            try {')
      .replace("buf.function.name = (buf.function.name ?? '') + tc.function.name", "buf.nameState = undefined\n            buf.function.name = (buf.function.name ?? '') + tc.function.name") },
  { label: 'wire declaration disconnected', file: client, test: names, pattern: 'public stream preserves repeated full names',
    change: source => source.replace("!!((body.tools as unknown[] | undefined)?.length),\n        (effectiveBody.tools as OaiChatRequest['tools'])?.map(tool => tool.function.name) ?? [])", "!!((body.tools as unknown[] | undefined)?.length))") },
  { label: 'same-index ID overwritten', file: buffer, test: names, pattern: 'public stream rejects same-index identity collision',
    change: source => source.replace('buf.id !== tc.id', 'false') },
  { label: 'foreign ID attached to sole buffer', file: buffer, test: names, pattern: 'public stream rejects foreign identity continuation',
    change: source => source.replace('if (tc.id !== undefined) {', 'if (tc.id !== undefined) {\n    if (buffers.size === 1) return buffers.keys().next().value') },
  { label: 'empty-name typed header rejected', file: buffer, test: names, pattern: 'index-less identity headers may precede names',
    change: source => source.replace("if (!tc.function?.name && tc.type !== 'function' && buffers.size > 0) rejectIdentity()", 'if (!tc.function?.name) rejectIdentity()') },
  { label: 'completed OpenAI call replay', file: buffer, test: names, pattern: 'completed call replay emits once',
    change: source => source.replace('if (tc.id && completedIds.has(tc.id)) return null', 'if (false) return null') },
  { label: 'premature prefix hint', file: client, test: names, pattern: 'short registered prefixes never fire a premature hint',
    change: source => source.replace('const hintName = buf.nameState ? buf.nameState.hintName : buf.function.name', 'const hintName = buf.function.name') },
  { label: 'premature short-name commit', file: 'src/api/tool-call-name.ts', test: names, pattern: 'a premature finish_reason cannot commit',
    change: source => source.replace('return final || this.hintName === names[0] ? names[0] : undefined', 'return names[0]') },
  ...[[responses, 'ResponsesClient'], [codex, 'CodexClient']].map(([file, name]) => ({
    label: `${name} repeated done event`, file, test: replay, pattern: `${name} emits a completed tool once per call ID`,
    change: source => source.replace('if (emittedCallIds.has(callId)) break', 'if (false) break'),
  })),
  { label: 'malformed snapshot consumes identity', file: responses, test: replay, pattern: 'Responses valid completed snapshot',
    change: source => source.replace('const input = parseToolArguments(args)', 'emittedCallIds.add(callId)\n                const input = parseToolArguments(args)') },
  { label: 'Codex consumer exception swallowed', file: codex, test: replay, pattern: 'Codex tool consumers errors propagate',
    change: source => source.replace("callbacks.onContentBlock({ type: 'tool_use', id: callId, name, input })", "try { callbacks.onContentBlock({ type: 'tool_use', id: callId, name, input }) } catch {}") },
  { label: 'timestamp fallback ID collision', file: responses, test: replay, pattern: 'ResponsesClient gives independent unidentified calls',
    change: source => source.replace('`call_${crypto.randomUUID()}`', '`call_${Date.now()}`') },
  ...[[responses, 'ResponsesClient'], [codex, 'CodexClient']].map(([file, name]) => ({
    label: `${name} missing stable item identity`, file, test: replay, pattern: `${name} uses item identity`,
    change: source => source.replace('(item.id as string) ?? ', ''),
  })),
  { label: 'Anthropic duplicate header clears arguments', file: anthropic, test: nativeReplay, pattern: 'Anthropic repeated tool headers',
    change: source => source.replace('if (previous) break', 'if (false) break')
      .replace("if ([...toolUseBuffer.values()].some(buf => buf.id === id)) throw new ToolNameProtocolError('identity')", '') },
  { label: 'Anthropic completed call replay', file: anthropic, test: nativeReplay, pattern: 'Anthropic completed call replay',
    change: source => source.replace('if (completedToolIds.has(id)) break', 'if (false) break') },
  { label: 'Anthropic conflicting header overwrites identity', file: anthropic, test: nativeReplay, pattern: 'Anthropic colliding identities',
    change: source => source.replace("if (previous && (previous.id !== id || previous.name !== name)) throw new ToolNameProtocolError('identity')", 'if (false) throw new Error()') },
]

for (const mutant of mutants) {
  const path = new URL('../' + mutant.file, import.meta.url)
  const original = readFileSync(path, 'utf8')
  const changed = mutant.change(original)
  assert.notEqual(changed, original, `Mutation anchor missing: ${mutant.label}`)
  try {
    writeFileSync(path, changed)
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-timeout=15000',
      `--test-name-pattern=${mutant.pattern}`, mutant.test], { cwd: root, encoding: 'utf8', timeout: 20000 })
    assert.equal(result.error, undefined, mutant.label)
    const output = result.stdout + result.stderr
    assert.equal(result.status, 1, `${mutant.label} did not turn red\n${output}`)
    assert.ok(output.includes('AssertionError'), `${mutant.label} failed outside its assertions\n${output}`)
    console.log(`RED confirmed: ${mutant.label}`)
  } finally {
    assert.equal(readFileSync(path, 'utf8'), changed, `Concurrent edit detected; refusing to overwrite ${mutant.file}`)
    writeFileSync(path, original)
  }
}
console.log(`Restored ${mutants.length} defects individually; all corresponding tests failed. Source restored.`)
