import { describe, it, beforeEach, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createWriteEvidenceProbe,
  extractTargetPath,
  findRecentUnrecordedWrites,
  formatBytes,
  formatDiskReconciliationNote,
  formatWriteRecoveryContent,
  isWriteProbeEnabled,
  shouldReconcileDisk,
} from '../write-evidence-probe.js'
import { runResumePreflightOai } from '../resume-preflight.js'
import type { OaiMessage } from '../../api/oai-types.js'

describe('write-evidence-probe', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-write-probe-'))
    delete process.env.RIVET_WRITE_PROBE
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_WRITE_PROBE
  })

  it('extractTargetPath reads file_path from JSON string args', () => {
    assert.equal(
      extractTargetPath('{"file_path":"src/App.tsx","content":"<ptr>"}'),
      'src/App.tsx',
    )
  })

  it('formatBytes renders human sizes', () => {
    assert.equal(formatBytes(512), '512B')
    assert.equal(formatBytes(2048), '2.0KB')
  })

  it('formatWriteRecoveryContent uses disk evidence when file exists', () => {
    const text = formatWriteRecoveryContent('write_file', 'a.ts', { exists: true, bytes: 4096 })
    assert.ok(text.includes('磁盘证据'))
    assert.ok(text.includes('a.ts'))
    assert.ok(text.includes('4.0KB'))
    assert.ok(text.includes('直接继续'))
  })

  it('evidence-confirmed branch leads with calm confirmation, not interrupt panic (PR #4)', () => {
    const text = formatWriteRecoveryContent('write_file', 'a.ts', { exists: true, bytes: 4096 })
    assert.ok(text.startsWith('[auto-recovered] 写入已确认'), `panic-first framing: ${text}`)
    // marker 必须保留在正文——repeat escalation 靠它计数，证据确认的恢复同样是一次宿主中断
    assert.ok(text.includes('会话中断导致工具结果丢失'), 'marker missing — escalation counting would break')
  })

  it('no-evidence branch stays honest — never claims 已确认 without disk evidence', () => {
    const text = formatWriteRecoveryContent('write_file', 'a.ts')
    assert.ok(!text.includes('写入已确认'), `overclaims without evidence: ${text}`)
    assert.ok(text.includes('很可能'))
    assert.ok(text.includes('read_file'))
  })

  it('formatWriteRecoveryContent says safe to retry when file missing', () => {
    const text = formatWriteRecoveryContent('edit_file', 'b.tsx', { exists: false, bytes: 0 })
    assert.ok(text.includes('不存在'))
    assert.ok(text.includes('可安全重试'))
  })

  it('formatWriteRecoveryContent always attributes to host interruption, not tool failure', () => {
    for (const text of [
      formatWriteRecoveryContent('write_file', 'a.ts', { exists: true, bytes: 10 }),
      formatWriteRecoveryContent('edit_file', 'b.tsx', { exists: false, bytes: 0 }),
      formatWriteRecoveryContent('hash_edit', 'c.ts'),
      formatWriteRecoveryContent('bash', undefined),
    ]) {
      assert.ok(text.includes('不是写工具故障'), `missing attribution in: ${text}`)
      assert.ok(text.includes('不要改用 bash 绕过'), `missing anti-workaround hint in: ${text}`)
    }
  })

  it('formatWriteRecoveryContent escalates on repeated recoveries (priorOccurrences >= 2)', () => {
    const first = formatWriteRecoveryContent('write_file', 'a.ts', undefined, 0)
    const third = formatWriteRecoveryContent('write_file', 'a.ts', undefined, 2)
    assert.ok(!first.includes('重复发生'))
    assert.ok(third.includes('重复发生'))
    assert.ok(third.includes('如实报告给用户'))
  })

  it('createWriteEvidenceProbe returns exists+bytes for an on-disk file', () => {
    const rel = 'probe-target.ts'
    writeFileSync(join(tempDir, rel), 'export const x = 1\n', 'utf-8')
    const probe = createWriteEvidenceProbe(tempDir)
    const ev = probe('write_file', { file_path: rel })
    assert.ok(ev)
    assert.equal(ev!.exists, true)
    assert.ok(ev!.bytes > 0)
  })

  it('createWriteEvidenceProbe returns exists:false for a missing file', () => {
    const probe = createWriteEvidenceProbe(tempDir)
    const ev = probe('write_file', { file_path: 'missing.tsx' })
    assert.deepEqual(ev, { exists: false, bytes: 0 })
  })

  it('createWriteEvidenceProbe rejects path escape', () => {
    const probe = createWriteEvidenceProbe(tempDir)
    assert.equal(probe('write_file', { file_path: '../../etc/passwd' }), undefined)
  })

  it('RIVET_WRITE_PROBE=0 disables the probe', () => {
    process.env.RIVET_WRITE_PROBE = '0'
    writeFileSync(join(tempDir, 'on.ts'), 'x', 'utf-8')
    const probe = createWriteEvidenceProbe(tempDir)
    assert.equal(probe('write_file', { file_path: 'on.ts' }), undefined)
    assert.equal(isWriteProbeEnabled(), false)
  })

  it('findRecentUnrecordedWrites surfaces recent disk products the transcript never mentions', () => {
    const now = Date.now()
    mkdirSync(join(tempDir, 'src'), { recursive: true })
    writeFileSync(join(tempDir, 'src/Recent.tsx'), 'export const x = 1\n', 'utf-8')
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{
        id: 'tc_1', type: 'function',
        function: { name: 'write_file', arguments: '{"file_path":"src/Old.tsx"}' },
      }] },
    ]
    const recent = findRecentUnrecordedWrites(tempDir, messages, { now, sinceMs: now - 60_000 })
    assert.equal(recent.length, 1)
    assert.equal(recent[0]!.path, 'src/Recent.tsx')
    const note = formatDiskReconciliationNote(recent, now)
    assert.ok(note!.includes('src/Recent.tsx'))
    assert.ok(note!.includes('read_file'))
    assert.ok(note!.startsWith('<system-reminder>'))
  })

  it('findRecentUnrecordedWrites excludes paths already mentioned by write tools', () => {
    const now = Date.now()
    writeFileSync(join(tempDir, 'Mentioned.ts'), 'x', 'utf-8')
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{
        id: 'tc_2', type: 'function',
        function: { name: 'edit_file', arguments: '{"file_path":"Mentioned.ts"}' },
      }] },
    ]
    assert.deepEqual(
      findRecentUnrecordedWrites(tempDir, messages, { now, sinceMs: now - 60_000 }),
      [],
    )
  })
})

describe('shouldReconcileDisk — 崩溃后对账的单一判据', () => {
  it('cleanExit === false（上次非正常退出）才需要对账', () => {
    assert.equal(shouldReconcileDisk({ cleanExit: false }), true)
  })

  it('正常退出（cleanExit === true）不对账——切换会话不再白付全树扫描', () => {
    assert.equal(shouldReconcileDisk({ cleanExit: true }), false)
  })

  it('无 meta / 缺 cleanExit 字段不对账（新会话、旧记录）', () => {
    assert.equal(shouldReconcileDisk(undefined), false)
    assert.equal(shouldReconcileDisk({}), false)
  })
})

describe('runResumePreflightOai + write probe', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-preflight-probe-'))
    delete process.env.RIVET_WRITE_PROBE
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_WRITE_PROBE
  })

  it('embeds disk evidence in synthetic write-tool result when file exists', () => {
    const rel = 'src/Widget.tsx'
    mkdirSync(join(tempDir, 'src'), { recursive: true })
    writeFileSync(join(tempDir, rel), '<div />', 'utf-8')

    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_w', type: 'function', function: { name: 'write_file', arguments: `{"file_path":"${rel}"}` } },
      ]},
    ]
    const report = runResumePreflightOai(messages, { writeProbe: createWriteEvidenceProbe(tempDir) })
    const toolResult = report.messages.find(
      (m): m is OaiMessage & { role: 'tool'; tool_call_id: string; content: string } =>
        m.role === 'tool' && 'tool_call_id' in m && m.tool_call_id === 'tc_w',
    )
    assert.ok(toolResult)
    const text = String(toolResult.content)
    assert.ok(text.includes('磁盘证据'))
    assert.ok(text.includes(rel))
    assert.ok(text.includes('直接继续'))
  })

  it('reports missing file when probe sees no on-disk target', () => {
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_w', type: 'function', function: { name: 'edit_file', arguments: '{"file_path":"gone.js"}' } },
      ]},
    ]
    const report = runResumePreflightOai(messages, { writeProbe: createWriteEvidenceProbe(tempDir) })
    const toolResult = report.messages.find(
      (m): m is OaiMessage & { role: 'tool'; tool_call_id: string; content: string } =>
        m.role === 'tool' && 'tool_call_id' in m && m.tool_call_id === 'tc_w',
    )
    assert.ok(toolResult)
    const text = String(toolResult.content)
    assert.ok(text.includes('不存在'))
    assert.ok(text.includes('可安全重试'))
  })

  it('escalates synthetic message when history already holds prior recoveries', () => {
    // Two prior synthetic recoveries already in history (properly paired),
    // plus a fresh orphan — the new synthetic result must carry the
    // repeat-escalation paragraph instead of a bare "result lost" line.
    const prior = '会话中断导致工具结果丢失——对 `x.ts` 的写入很可能已经成功执行。'
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'write_file', arguments: '{"file_path":"x.ts"}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_1', content: prior },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_2', type: 'function', function: { name: 'edit_file', arguments: '{"file_path":"x.ts"}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_2', content: prior },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_3', type: 'function', function: { name: 'write_file', arguments: '{"file_path":"y.ts"}' } },
      ]},
    ]
    const report = runResumePreflightOai(messages)
    assert.equal(report.syntheticResultsInserted, 1)
    const toolResult = report.messages.find(
      (m): m is OaiMessage & { role: 'tool'; tool_call_id: string; content: string } =>
        m.role === 'tool' && 'tool_call_id' in m && m.tool_call_id === 'tc_3',
    )
    assert.ok(toolResult)
    const text = String(toolResult.content)
    assert.ok(text.includes('重复发生'))
    assert.ok(text.includes('不是写工具故障'))
  })

  it('evidence-confirmed prior recoveries still count toward escalation (marker 括注)', () => {
    // 平静确认版本（PR #4 采纳后）的历史恢复消息——marker 在括注里，
    // countPriorRecoveries 必须仍能计数，两条历史 + 新 orphan → 升级段出现。
    const prior = formatWriteRecoveryContent('write_file', 'x.ts', { exists: true, bytes: 128 })
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'write_file', arguments: '{"file_path":"x.ts"}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_1', content: prior },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_2', type: 'function', function: { name: 'edit_file', arguments: '{"file_path":"x.ts"}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_2', content: prior },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_3', type: 'function', function: { name: 'write_file', arguments: '{"file_path":"y.ts"}' } },
      ]},
    ]
    const report = runResumePreflightOai(messages)
    assert.equal(report.syntheticResultsInserted, 1)
    const toolResult = report.messages.find(
      (m): m is OaiMessage & { role: 'tool'; tool_call_id: string; content: string } =>
        m.role === 'tool' && 'tool_call_id' in m && m.tool_call_id === 'tc_3',
    )
    assert.ok(toolResult)
    assert.ok(String(toolResult.content).includes('重复发生'))
  })
})
