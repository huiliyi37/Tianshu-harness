import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectTranscriptCandidates, buildDeepRecallPrompt,
  parseDeepRecallOutput, renderDeepRecallText,
} from '../deep-recall.js'

let sessionDir: string

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'rivet-deep-recall-'))
  return () => rmSync(sessionDir, { recursive: true, force: true })
})

function seedSession(id: string, messages: Array<{ role: string; content: string }>, ageHours = 1): void {
  const path = join(sessionDir, `${id}.jsonl`)
  writeFileSync(path, messages.map(m => JSON.stringify(m)).join('\n'))
  const at = new Date(Date.now() - ageHours * 3_600_000)
  utimesSync(path, at, at)
}

describe('deep recall', () => {
  it('collects scored quote windows across sessions with caps', () => {
    seedSession('s-new', [
      { role: 'user', content: 'prefix cache 的命中率为什么掉了' },
      { role: 'assistant', content: '因为 system prompt 在请求间发生了字节级变化，冻结锚被破坏' },
    ], 1)
    seedSession('s-old', [
      { role: 'user', content: 'prefix cache 命中率 掉了 修复记录' },
      { role: 'tool', content: 'prefix cache' }, // 非对话行不选
    ], 10)
    const candidates = collectTranscriptCandidates(sessionDir, 'prefix cache 命中率')
    assert.ok(candidates.length >= 2)
    assert.ok(candidates.every(c => c.quote.length > 0 && c.score > 0))
    // 总字符封顶 + 候选上限。
    const capped = collectTranscriptCandidates(sessionDir, 'prefix cache 命中率', { maxCandidates: 1, maxTotalChars: 200 })
    assert.equal(capped.length, 1)
    assert.ok(capped[0]!.quote.length <= 340)
  })

  it('returns nothing for termless queries or empty dirs', () => {
    seedSession('s-1', [{ role: 'user', content: 'hello world' }])
    assert.deepEqual(collectTranscriptCandidates(sessionDir, '，，'), [])
    assert.deepEqual(collectTranscriptCandidates(join(sessionDir, 'missing'), 'cache'), [])
  })

  it('parses distilled output strictly and fails closed', () => {
    const ok = parseDeepRecallOutput(JSON.stringify({
      answer: '命中率下降源于冻结锚被破坏',
      evidence: [{ sessionId: 's-1', quote: 'system prompt 在请求间发生了字节级变化' }],
      uncertainties: ['未确认是哪次提交引入'],
      confidence: 0.8,
    }))
    assert.ok(ok)
    assert.equal(ok.evidence.length, 1)
    assert.equal(ok.confidence, 0.8)

    // 围栏包裹也接受；结构缺失 fail-closed。
    assert.ok(parseDeepRecallOutput('```json\n{"answer":"a","evidence":[],"uncertainties":[],"confidence":0.5}\n```'))
    assert.equal(parseDeepRecallOutput('{"evidence":[]}'), null)
    assert.equal(parseDeepRecallOutput('not json at all'), null)
    // evidence 字段畸形逐条跳过，answer 有效仍采信。
    const partial = parseDeepRecallOutput('{"answer":"a","evidence":[{"sessionId":1,"quote":"x"}],"uncertainties":[],"confidence":9}')
    assert.ok(partial)
    assert.equal(partial!.evidence.length, 0)
    assert.equal(partial!.confidence, 0.5)
  })

  it('renders compact model-visible output with evidence pointers', () => {
    const text = renderDeepRecallText({
      answer: '把 appendix 移到字节稳定区后命中率恢复',
      evidence: [{ sessionId: 's-1', quote: 'appendixDelta 逐字节稳定' }],
      uncertainties: [],
      confidence: 0.75,
    })
    assert.match(text, /答案：/)
    assert.match(text, /\[s-1\]/)
    assert.match(text, /resume/)
  })

  it('prompt embeds candidates and the strict JSON contract', () => {
    const prompt = buildDeepRecallPrompt('cache 命中率', [
      { sessionId: 's-1', quote: 'frozen anchor broken', score: 3 },
    ])
    assert.match(prompt, /frozen anchor broken/)
    assert.match(prompt, /sessionId=s-1/)
    assert.match(prompt, /"answer"/)
    assert.match(prompt, /逐字/)
  })
})
