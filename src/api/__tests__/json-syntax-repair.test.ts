import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { repairJsonSyntax } from '../json-syntax-repair.js'

// F2 白名单外科修复（2026-09-06 审查 infra 故障归因）：
// worker 报告 JSON malformed 的高频根因是字符串值内裸引号（f98bb237 丢 2/6；
// be3489ca6 审查 7/11 salvage）与尾逗号。re-ask 修复已实证无效（2026-07-29：
// 同模型同预算同 prompt = 同失败）——语法错应本地机械修。
// 规则：只做语法级（引号转义/逗号删除），不做语义猜测；修复后必须整体
// JSON.parse 成功才返回；无改动返回 null（调用方跳过重 parse）。

function roundtrip(raw: string): { repaired: string | null; parsedValue: unknown } {
  const repaired = repairJsonSyntax(raw)
  if (repaired === null) {
    try {
      return { repaired: null, parsedValue: JSON.parse(raw) }
    } catch {
      return { repaired: null, parsedValue: undefined }
    }
  }
  return { repaired, parsedValue: JSON.parse(repaired) }
}

describe('repairJsonSyntax', () => {
  it('returns null for already-valid JSON (no redundant re-parse)', () => {
    assert.equal(repairJsonSyntax('{"a": "x", "b": [1, 2]}'), null)
    assert.equal(repairJsonSyntax('{"nested": {"deep": {"k": "v"}}}'), null)
  })

  it('returns null when legitimate escapes are present (escaped quotes untouched)', () => {
    assert.equal(repairJsonSyntax('{"a": "say \\"quoted\\" text"}'), null)
  })

  it('escapes a bare quote inside a Chinese string value', () => {
    const { repaired, parsedValue } = roundtrip('{"content": "他说"好的"然后走了"}')
    assert.ok(repaired !== null, 'bare quotes must be repaired')
    assert.equal((parsedValue as { content: string }).content, '他说"好的"然后走了')
  })

  it('escapes bare quotes inside an English string value', () => {
    const { repaired, parsedValue } = roundtrip('{"summary": "said "hi" and left"}')
    assert.ok(repaired !== null)
    assert.equal((parsedValue as { summary: string }).summary, 'said "hi" and left')
  })

  it('repairs trailing commas before } and ]', () => {
    const { repaired, parsedValue } = roundtrip('{"findings": [{"claim": "a"},], "risks": ["x",]}')
    assert.ok(repaired !== null)
    const v = parsedValue as { findings: unknown[]; risks: string[] }
    assert.equal(v.findings.length, 1)
    assert.deepEqual(v.risks, ['x'])
  })

  it('repairs trailing comma inside nested structures', () => {
    const { repaired, parsedValue } = roundtrip('{"a": {"b": [1, 2,],}, "c": 3,}')
    assert.ok(repaired !== null)
    const v = parsedValue as { a: { b: number[] }; c: number }
    assert.deepEqual(v.a.b, [1, 2])
    assert.equal(v.c, 3)
  })

  it('combines bare-quote escaping and trailing-comma removal in one pass', () => {
    const { repaired, parsedValue } = roundtrip('{"note": "he said "go" now", "tags": ["x",]}')
    assert.ok(repaired !== null)
    const v = parsedValue as { note: string; tags: string[] }
    assert.equal(v.note, 'he said "go" now')
    assert.deepEqual(v.tags, ['x'])
  })

  it('leaves structural quotes alone: closing quote followed by , } ] : or EOF', () => {
    assert.equal(repairJsonSyntax('{"a": "x", "b": "y"}'), null)
    assert.equal(repairJsonSyntax('{"a": {"b": "v"}}'), null)
  })

  it('returns null for truncated strings (missing closing quote) — out of whitelist', () => {
    assert.equal(repairJsonSyntax('{"summary": "abc'), null)
  })

  it('returns null for structural garbage (no whitelisted pattern) — falls through to re-ask/salvage', () => {
    assert.equal(repairJsonSyntax('{"a": }'), null)
    assert.equal(repairJsonSyntax('not json at all'), null)
  })

  it('does not over-escape: quote preceded by backslash (legitimate escape) is skipped', () => {
    // `\\"` 是合法转义序列：扫描器必须跳过反斜杠后的引号
    const { repaired, parsedValue } = roundtrip('{"a": "x\\\\" "y"}')
    // 第一个 "x\\" 的闭合引号后跟空格+引号 → 裸 → 转义 → 值 "x\\" "y"
    assert.ok(repaired !== null)
    const v = parsedValue as { a: string }
    assert.ok(v.a.includes('"'))
  })

  it('integrates after invalid-escape repair: raw backslash then bare quote', () => {
    // parseJsonCandidate 先跑 escape repair（\x → \\x）再跑 syntax repair——此处
    // 直接模拟 escape repair 后的输入（已无非法转义），验证裸引号仍被处理。
    const { repaired, parsedValue } = roundtrip('{"path": "F:\\\\x", "content": "他说"好的""}')
    assert.ok(repaired !== null)
    const v = parsedValue as { path: string; content: string }
    assert.equal(v.path, 'F:\\x')
    assert.equal(v.content, '他说"好的"')
  })
})
