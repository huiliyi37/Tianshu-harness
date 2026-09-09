import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContextLedger } from '../../context/types.js'
import { buildVolatileBlock, buildStableVolatileBlock, buildLatestTurnVolatileBlock, buildDynamicAppendix, buildDynamicAppendixParts, appendixBlockName, assignSalience, selectTopKBlocks, renderPlanMethodologyAdvisory, renderPlanExecutingBlock, renderPermissionNote, stripFirstMarkdownTable, windowsShellNote, type VolatileContext, type SalientBlock } from '../volatile.js'
import { setTargetConventions, getShellCommand } from '../../platform.js'

/** Fallback temp dir for sandboxed environments where os.tmpdir() is read-only. */
function sandboxTmpDir(): string {
  const sys = tmpdir()
  try {
    mkdtempSync(join(sys, 'probe-'))
    return sys
  } catch {
    const local = join(process.cwd(), '.test-tmp')
    if (!existsSync(local)) mkdirSync(local, { recursive: true })
    return local
  }
}

function ledger(): ContextLedger {
  return {
    sessionId: 'test',
    transcriptPath: '',
    rounds: [],
    anchors: [],
    workingSet: [],
    compactedSpans: [],
    sessionMemory: null,
    tokenBudget: { estimatedTokens: 1200, maxTokens: 10000, warningThreshold: 5000, compactionState: 'healthy' },
    apiInvariantStatus: { totalRounds: 3, okRounds: 3, repairedRounds: 0, brokenRounds: 0, orphanToolUse: [], orphanToolResult: [] },
  }
}

describe('renderPlanExecutingBlock — native executing-plans replacement', () => {
  it('carries the six execution disciplines in a <plan-executing> block', () => {
    const block = renderPlanExecutingBlock()
    assert.match(block, /^<plan-executing>/)
    assert.match(block, /<\/plan-executing>$/)
    assert.match(block, /执行前三查/)
    assert.match(block, /逐波执行/)
    assert.match(block, /测试失败三分/)
    assert.match(block, /阶段检查点/)
    assert.match(block, /偏离即记录/)
    assert.match(block, /完成报告四要素/)
  })

  it('renders into the dynamic appendix via ctx.planExecutingBlock', () => {
    const ctx: VolatileContext = { cwd: '/tmp/test', planExecutingBlock: renderPlanExecutingBlock() }
    const appendix = buildDynamicAppendix(ctx)
    assert.match(appendix, /<plan-executing>/)
    // Absent when not mounted
    const none = buildDynamicAppendix({ cwd: '/tmp/test' })
    assert.ok(!none.includes('<plan-executing>'))
  })
})

describe('windowsShellNote — guidance follows the resolved shell', () => {
  it('Git Bash note advertises POSIX commands, not PowerShell', () => {
    const note = windowsShellNote('bash')
    assert.match(note, /Git Bash/)
    assert.match(note, /2>\/dev\/null/)
    assert.doesNotMatch(note, /\$env:/)
  })

  it('PowerShell note carries PS syntax cheatsheet', () => {
    const note = windowsShellNote('powershell')
    assert.match(note, /PowerShell/)
    assert.match(note, /\$env:NAME/)
    assert.match(note, /2>\$null/)
    assert.match(note, /\$LASTEXITCODE/)
  })

  it('cmd note uses cmd idioms', () => {
    const note = windowsShellNote('cmd')
    assert.match(note, /cmd\.exe/)
    assert.match(note, /%VAR%/)
    assert.match(note, /2>nul/)
  })

  it('sh (Unix) injects nothing', () => {
    assert.equal(windowsShellNote('sh'), '')
  })
})

describe('environment platform hint (target vs host)', () => {
  const restore = () => setTargetConventions('auto', 'auto')

  it('auto: platform = real host, no host attr, no platform-note', () => {
    restore()
    const block = buildStableVolatileBlock({ cwd: '/repo' })
    assert.match(block, new RegExp(`<environment platform="${process.platform}"`))
    assert.doesNotMatch(block, / host="/)
    assert.doesNotMatch(block, /<platform-note>/)
  })

  it('cross-target: emits target platform + host attr + advisory note', () => {
    // Pick a target different from the host so the divergence branch fires.
    const target = process.platform === 'win32' ? 'macos' : 'windows'
    const expectedPlatform = target === 'windows' ? 'win32' : 'darwin'
    setTargetConventions(target, 'auto')
    try {
      const block = buildStableVolatileBlock({ cwd: '/repo' })
      assert.match(block, new RegExp(`<environment platform="${expectedPlatform}" host="${process.platform}"`))
      assert.match(block, /<platform-note>/)
    } finally {
      restore()
    }
  })

  it('win32 目标平台注入 path-style-note（反斜杠路径指引），非 Windows 不注入', () => {
    setTargetConventions('windows', 'auto')
    try {
      const block = buildStableVolatileBlock({ cwd: '/repo' })
      assert.match(block, /<path-style-note>/)
      assert.match(block, /反斜杠/)
    } finally {
      restore()
    }
    if (process.platform !== 'win32') {
      const block = buildStableVolatileBlock({ cwd: '/repo' })
      assert.doesNotMatch(block, /<path-style-note>/)
    }
  })

  it('shell-note 跟随真实解析出的 shell（与 windowsShellNote 一致）', () => {
    // The note now keys on the actually-resolved shell (getShellCommand().kind,
    // process-cached), NOT on process.platform — so mutating process.platform no
    // longer flips it. Assert the integration matches the pure function on this
    // host: Unix(sh) → no note; Windows → the kind's note is present verbatim.
    restore()
    const block = buildStableVolatileBlock({ cwd: '/repo' })
    const expected = windowsShellNote(getShellCommand().kind)
    if (expected) {
      assert.ok(block.includes(expected))
    } else {
      assert.doesNotMatch(block, /<shell-note>/)
    }
  })
})

describe('volatile context layers', () => {
  it('renders environment, ledger, working set, and memory as stable XML sections', () => {
    const block = buildVolatileBlock({
      cwd: '/repo',
      rivetMd: 'Use TDD.',
      gitStatus: 'M src/main.tsx',
      workingSet: ['src/main.tsx'],
      contextLedger: ledger(),
      sessionMemoryBlock: '<session-memory session_id="s1"><entry id="m1" created_at="1" source="manual">Keep rounds safe.</entry></session-memory>',
    })

    assert.match(block, /<context>/)
    assert.match(block, /<environment/)
    // contextLedger is harness-only — no longer rendered in the LLM prompt (direction A)
    assert.doesNotMatch(block, /<context-ledger/)
    assert.match(block, /<working-set>/)
    assert.match(block, /<session-memory/)
    assert.match(block, /<git-status>/)
    assert.match(block, /<project-instructions>/)
  })

  it('omits sections when no data is provided', () => {
    const block = buildVolatileBlock({ cwd: '/repo' })

    assert.match(block, /<context>/)
    assert.match(block, /<environment/)
    assert.doesNotMatch(block, /<working-set>/)
    assert.doesNotMatch(block, /<context-ledger/)
    assert.doesNotMatch(block, /<session-memory>/)
  })

  it('does not inject project knowledge files into prompt context', () => {
    const cwd = mkdtempSync(join(sandboxTmpDir(), 'volatile-knowledge-'))
    try {
      const knowledgeDir = join(cwd, '.rivet', 'knowledge')
      mkdirSync(knowledgeDir, { recursive: true })
      writeFileSync(
        join(knowledgeDir, 'project-memory.md'),
        '### Curated Memory\nProject memory should be recalled on demand.\n',
        'utf-8',
      )

      const block = buildLatestTurnVolatileBlock({ cwd })

      assert.doesNotMatch(block, /<project-memory>/)
      assert.doesNotMatch(block, /Project memory should be recalled on demand/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('renders declared verify commands from .rivet-config.json as <verify-commands>', () => {
    const cwd = mkdtempSync(join(sandboxTmpDir(), 'volatile-verify-'))
    // 信任门预存债收口：项目层 verify 键未授信即剥离（project-trust.ts）。
    // 本用例测渲染不测信任——显式授信后按原意图断言。
    const prevTrust = process.env.RIVET_TRUST_PROJECT
    process.env.RIVET_TRUST_PROJECT = '1'
    try {
      writeFileSync(
        join(cwd, '.rivet-config.json'),
        JSON.stringify({ verify: { test: 'cargo test', build: 'cargo build' } }),
        'utf-8',
      )
      const block = buildStableVolatileBlock({ cwd })
      assert.match(block, /<verify-commands source="\.rivet-config\.json">/)
      assert.match(block, /test: cargo test/)
      assert.match(block, /build: cargo build/)
    } finally {
      if (prevTrust === undefined) delete process.env.RIVET_TRUST_PROJECT
      else process.env.RIVET_TRUST_PROJECT = prevTrust
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('omits <verify-commands> when nothing is declared', () => {
    const cwd = mkdtempSync(join(sandboxTmpDir(), 'volatile-no-verify-'))
    try {
      const block = buildStableVolatileBlock({ cwd })
      assert.doesNotMatch(block, /<verify-commands/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('permission note — approval mode surfaced to the model', () => {
  const unattended = { cwd: '/repo', approvalMode: 'dangerously-skip-permissions' } as VolatileContext

  it('renders the note for the unattended level', () => {
    const note = renderPermissionNote('dangerously-skip-permissions')
    assert.match(note, /^<permission-note>/)
    assert.match(note, /工作区外路径/)
    assert.match(note, /request_path_access/)
  })

  it('renders nothing for modes that still ask', () => {
    for (const mode of ['manual', 'auto-safe', 'auto-accept', undefined] as const) {
      assert.equal(renderPermissionNote(mode), '', `mode=${String(mode)} must render no note`)
    }
  })

  it('lands in the dynamic appendix, never the frozen prefix', () => {
    // approvalMode flips mid-session (live setApprovalMode) — it must stay out of
    // the exact-prefix frozen base or every toggle would shatter the cache.
    assert.match(buildDynamicAppendix(unattended), /<permission-note>/)
    assert.doesNotMatch(buildStableVolatileBlock(unattended), /<permission-note>/)
  })

  it('is byte-constant across renders for the same mode (cache-safe)', () => {
    assert.equal(buildDynamicAppendix(unattended), buildDynamicAppendix(unattended))
  })
})
      