import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeToolEvent } from '../../agent/runtime-hooks.js'
import {
  isImportantOperation, buildCapturePrompt, parseCaptureOutput, applyCaptureVerdicts, autoCaptureEnabled,
} from '../auto-capture.js'
import { readMemoryEntries } from '../unified-memory.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const root = () => { const d = mkdtempSync(join(tmpdir(), 'rivet-auto-cap-')); roots.push(d); return d }

const tool = (partial: Partial<RuntimeToolEvent>): RuntimeToolEvent => ({
  name: 'write_file', success: true, ...partial,
})

describe('auto-capture 记忆形成', () => {
  it('pre-filters important operations (code write / failure / test) and drops noise', () => {
    assert.ok(isImportantOperation(tool({ name: 'write_file', target: 'src/agent/loop.ts' }), '/p'))
    assert.ok(isImportantOperation(tool({ name: 'write_file', target: 'src/agent/loop.ts', isError: true, failureClass: 'type_error', resultContent: 'TypeError: x' }), '/p'))
    assert.ok(isImportantOperation(tool({ name: 'run_tests', success: true, resultContent: '7 passed' }), '/p'))
    assert.equal(isImportantOperation(tool({ name: 'read_file', target: 'src/agent/loop.ts' }), '/p'), null)
    // 非代码目标文件不沉淀
    assert.equal(isImportantOperation(tool({ name: 'write_file', target: 'package-lock.json' }), '/p'), null)
  })

  it('judges candidacy and parses model verdicts', () => {
    const candidates = [
      { tool: 'write_file', success: true, summary: '改 src/agent/loop.ts', result: 'written' },
    ]
    const prompt = buildCapturePrompt(candidates)
    assert.match(prompt, /CANDIDATES/)
    const raw = '[{"index":0,"worth":true,"summary":"loop 新增意图门控","kind":"decision","confidence":0.9,"topic":"loop"}]'
    const verdicts = parseCaptureOutput(raw, candidates.length)
    assert.equal(verdicts?.length, 1)
    assert.equal(verdicts![0]!.worth, true)
    assert.equal(verdicts![0]!.kind, 'decision')
    // 结构性意外 → fail-closed null
    assert.equal(parseCaptureOutput('not json', 1), null)
  })

  it('writes only worth candidates, skipping empty summaries (fail-closed writes)', () => {
    const cwd = root()
    const candidates = [
      { tool: 'write_file', success: true, summary: '改 src', result: 'written' },
    ]
    const verdicts = [
      { index: 0, worth: true, summary: '实现了意图门控 STM', kind: 'decision' as const, confidence: 0.9 },
    ]
    const written = applyCaptureVerdicts(cwd, 'session-1', candidates, verdicts)
    assert.equal(written, 1)
    const entries = readMemoryEntries(cwd)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.source, 'auto-capture')
    assert.match(entries[0]!.text, /意图门控 STM/)

    const noWrite = applyCaptureVerdicts(cwd, 'session-1', candidates, [
      { index: 0, worth: true, summary: '  ', kind: 'failure_pattern' as const, confidence: 0.8 },
    ])
    assert.equal(noWrite, 0)
  })

  it('enabled by default, opt-out via env', () => {
    assert.equal(autoCaptureEnabled(undefined), true)
    assert.equal(autoCaptureEnabled('off'), false)
    assert.equal(autoCaptureEnabled('0'), false)
  })
})
