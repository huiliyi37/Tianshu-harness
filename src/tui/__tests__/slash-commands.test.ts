import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolveAppPromptInput, handleSlashCommand, formatVerificationStatus, mcpStatusText, type SlashHandlerContext } from '../slash-commands.js'
import { handleYoloToggle } from '../yolo-toggle.js'
import { loadConstellation } from '../../constellation/store.js'
import { DEFAULT_CONFIG } from '../../config/default.js'
import type { Config } from '../../config/schema.js'
import { distillSkillDraft, persistSkillDraft, listSkillDrafts } from '../../agent/skill-distill.js'
import type { LogEntry } from '../log-state.js'
import { makeTestDir, cleanupTestDir } from './_test-tmp.js'

function makeCtx(overrides?: Partial<SlashHandlerContext>): SlashHandlerContext {
  return {
    parts: ['/help'],
    config: DEFAULT_CONFIG as Config,
    agent: {
      getDebugInfo: () => ({
        fingerprint: { systemSha256: 'a'.repeat(64), toolsSha256: 'b'.repeat(64), combinedSha256: 'c'.repeat(64) },
        drift: null,
        systemPromptLength: 10,
        systemPromptPreview: 'system',
        toolCount: 0,
        toolNames: [],
        volatilePayloadReport: {
          totalChars: 50,
          estimatedTokens: 13,
          sections: [{ id: 'environment', chars: 40, estimatedTokens: 10, lines: 1, present: true }],
          wasteCandidates: [],
        },
      }),
      config: {
        approvalMode: 'manual',
        permissions: { allow: [], deny: [], bash: { allowlist: [], denylist: [] } },
        permissionsOverlay: { allow: [], deny: [], bashAllow: [], bashDeny: [] },
        toolRegistry: { needsApproval: () => true },
      },
      cwd: '/cwd',
      setApprovalMode: () => {},
      addAllowRule: () => {},
      addDenyRule: () => {},
      addBashAllowPrefix: () => {},
      addBashDenyPrefix: () => {},
      removePermissionRule: () => false,
      resetPermissionOverlay: () => {},
      addAnchor: () => {},
      setPromptMode: () => {},
      getPromptMode: () => 'task',
      getVerificationSummary: () => ({ total: 0, verified: 0, pending: 0, files: [] }),
      getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified', impactedFiles: new Set(), impactedTests: new Set(), fileVerificationLevels: new Map() }),
      getLatestPheromones: () => [],
      getCognitiveSnapshot: () => undefined,
      getSessionTurnCount: () => 0,
    } as any,
    session: null as any,
    persist: null as any,
    model: 'test-model',
    maxTokens: 128000,
    availableModels: [],
    onModelSwitch: () => ({ ok: true }),
    allProviders: {},
    currentProvider: 'test',
    currentSessionId: 'test',
    cost: 0,
    cacheHitRate: 0,
    autoSafeRef: { current: false },
    verboseRef: { current: false },
    setVerbose: () => {},
    setAutoSafe: () => {},
    rollbackTokenRef: { current: null },
    setCockpitPanel: () => {},
    pushStatic: () => {},
    setIsStreaming: () => {},
    setCacheHitRate: () => {},
    setSummaryState: () => {},
    mcpManagerRef: { current: null },
    claimStoreRef: { current: null },
    ...overrides,
  }
}

describe('/context 占用明细', () => {
  it('无参数输出含 cache 命中率与 cost 头（占用明细）', async () => {
    let captured = ''
    const ctx = makeCtx({
      parts: ['/context'],
      cacheHitRate: 0.8,
      cost: 1.5,
      session: {
        getContextLedger: () => ({
          tokenBudget: { compactionState: 'healthy', estimatedTokens: 50_000, maxTokens: 200_000 },
          apiInvariantStatus: { brokenRounds: 0 },
          rounds: [{}, {}],
          anchors: [],
        }),
        getCompactEvents: () => [],
        getLastRealPromptTokens: () => 48_000,
      } as any,
      pushStatic: (entry: LogEntry) => { captured += `${entry.content}\n` },
    })
    const handled = await handleSlashCommand(ctx)
    assert.equal(handled, true)
    assert.ok(captured.includes('Cache hit: 80%'), `应显示缓存命中率: ${captured}`)
    assert.ok(captured.includes('Cost: ¥1.50'), `应显示 cost: ${captured}`)
    assert.ok(captured.includes('50,000/200,000'), `应显示 token 占用: ${captured}`)
    assert.ok(captured.includes('API (last):'), `应显示 API 实际值: ${captured}`)
    assert.ok(captured.includes('48,000'), `应显示实值 48,000: ${captured}`)
  })
})

describe('/review off|on|status — 会话级审查门开关', () => {
  it('/review off 关闭本会话自动审查门，并提示手动审查仍可用', async () => {
    let captured = ''
    const reviewGateRef: { current: 'auto' | 'off' } = { current: 'auto' }
    const ctx = makeCtx({
      parts: ['/review', 'off'],
      reviewGateRef,
      pushStatic: (entry: LogEntry) => { captured += `${entry.content}\n` },
    })
    const handled = await handleSlashCommand(ctx)
    assert.equal(handled, true)
    assert.equal(reviewGateRef.current, 'off')
    assert.match(captured, /自动审查门已关闭/)
    assert.match(captured, /\/review on 恢复/)
  })

  it('/review on 恢复自动审查门', async () => {
    let captured = ''
    const reviewGateRef: { current: 'auto' | 'off' } = { current: 'off' }
    const ctx = makeCtx({
      parts: ['/review', 'on'],
      reviewGateRef,
      pushStatic: (entry: LogEntry) => { captured += `${entry.content}\n` },
    })
    const handled = await handleSlashCommand(ctx)
    assert.equal(handled, true)
    assert.equal(reviewGateRef.current, 'auto')
    assert.match(captured, /自动审查门已恢复/)
  })

  it('/review status 只报告状态，不翻转开关', async () => {
    let captured = ''
    const reviewGateRef: { current: 'auto' | 'off' } = { current: 'off' }
    const ctx = makeCtx({
      parts: ['/review', 'status'],
      reviewGateRef,
      pushStatic: (entry: LogEntry) => { captured += `${entry.content}\n` },
    })
    const handled = await handleSlashCommand(ctx)
    assert.equal(handled, true)
    assert.equal(reviewGateRef.current, 'off', 'status 不得改变开关')
    assert.match(captured, /已关闭（off）/)
  })

  it('无 reviewGateRef 注入时明确提示，不静默丢输入', async () => {
    let captured = ''
    const ctx = makeCtx({
      parts: ['/review', 'off'],
      pushStatic: (entry: LogEntry) => { captured += `${entry.content}\n` },
    })
    const handled = await handleSlashCommand(ctx)
    assert.equal(handled, true)
    assert.match(captured, /不支持会话级审查门开关/)
  })

  it('/review off 不再被 resolveAppPromptInput 误映射为 focus 审查', () => {
    const resolved = resolveAppPromptInput('/review off', '/cwd')
    assert.ok(resolved !== null)
    assert.match(resolved!.prompt, /TUI-local session toggle/)
    assert.doesNotMatch(resolved!.prompt, /call deliver_task/)
  })

  it('/review l1 映射为 L1 轻量审查（nudge，零 worker）', () => {
    const resolved = resolveAppPromptInput('/review l1', '/cwd')
    assert.ok(resolved !== null)
    assert.match(resolved!.prompt, /review_level="L1"/)
    assert.match(resolved!.prompt, /zero review workers/)
  })

  it('/review l2 / 无关键词 / max 的档位映射回归', () => {
    assert.match(resolveAppPromptInput('/review l2', '/cwd')!.prompt, /review_level="L2"/)
    assert.match(resolveAppPromptInput('/review', '/cwd')!.prompt, /review_level="L2"/)
    assert.match(resolveAppPromptInput('/review max', '/cwd')!.prompt, /review_level="L3"/)
    assert.match(resolveAppPromptInput('/review l3', '/cwd')!.prompt, /review_level="L3"/)
    // focus 描述不与档位关键词混淆
    assert.match(resolveAppPromptInput('/review l2 检查锚点漂移', '/cwd')!.prompt, /Focus specifically on: 检查锚点漂移/)
  })
})

describe('/resume 无参行为（会话选择器）', () => {
  it('注入 openSessionPicker 时无参 /resume 打开选择器而非打用法', async () => {
    let pickerOpened = 0
    let captured = ''
    const ctx = makeCtx({
      parts: ['/resume'],
      openSessionPicker: () => { pickerOpened++ },
      pushStatic: (entry: LogEntry) => { captured += `${entry.content}\n` },
    })
    const handled = await handleSlashCommand(ctx)
    assert.equal(handled, true)
    assert.equal(pickerOpened, 1, '应打开会话选择器')
    assert.ok(!captured.includes('用法'), `不应打用法提示: ${captured}`)
  })

  it('未注入 openSessionPicker 时回退到用法提示', async () => {
    let captured = ''
    const ctx = makeCtx({
      parts: ['/resume'],
      pushStatic: (entry: LogEntry) => { captured += `${entry.content}\n` },
    })
    const handled = await handleSlashCommand(ctx)
    assert.equal(handled, true)
    assert.ok(captured.includes('用法'), `应打用法提示: ${captured}`)
  })
})

describe('resolveAppPromptInput', () => {
  it('returns non-slash input unchanged', async () => {
    assert.equal(resolveAppPromptInput('hello world', '/cwd')?.prompt, 'hello world')
  })

  it('returns null for unrecognized slash commands (safety guard)', async () => {
    assert.equal(resolveAppPromptInput('/unknown-cmd', '/cwd'), null)
  })

  it('returns null for /mdel-style typo (prevents LLM misinterpretation)', async () => {
    assert.equal(resolveAppPromptInput('/mdel', '/cwd'), null)
  })

  it('resolves /plan into a writing-plans workflow prompt', async () => {
    const resolved = resolveAppPromptInput('/plan add workflow aliases', '/cwd')
    assert.ok(resolved !== null)

    assert.ok(resolved!.prompt.includes('创建实现计划：add workflow aliases'))
    assert.ok(resolved!.prompt.includes('计划模板路由'))
    assert.ok(resolved!.prompt.includes('docs/superpowers/plans/'))
    assert.ok(resolved!.prompt.includes('禁用占位符'))
    assert.ok(resolved!.prompt.includes('不要写实现代码'))
  })

  it('resolves /write-plan into a writing-plans workflow prompt', async () => {
    const resolved = resolveAppPromptInput('/write-plan 你说的很好，把这个内容记录到设计文档。如果行数太长就拆分两个，一个背景说明，一个是设计文档。其次，即便我使用 claude code 也是多个会话来并行执行。', '/cwd')
    assert.ok(resolved !== null)

    assert.ok(resolved!.prompt.includes('创建实现计划：你说的很好，把这个内容记录到设计文档。'))
    assert.ok(resolved!.prompt.includes('计划模板路由'))
    assert.ok(resolved!.prompt.includes('docs/superpowers/plans/'))
    assert.ok(resolved!.prompt.includes('多会话并行开发设计文档.md'))
    assert.ok(!resolved!.prompt.includes('你说的很好-把这个内容记录到设计文档-如果行数太长'))
    assert.ok(resolved!.prompt.includes('收尾'))
  })

  it('resolves /plan close into a plan_close workflow prompt with apply by default', async () => {
    const resolved = resolveAppPromptInput('/plan close docs/superpowers/plans/demo.md --tasks 1-7', '/cwd')
    assert.ok(resolved !== null)

    assert.ok(resolved!.prompt.includes('Use the plan_close tool'))
    assert.ok(resolved!.prompt.includes('- file_path: docs/superpowers/plans/demo.md'))
    assert.ok(resolved!.prompt.includes('- tasks: 1-7'))
    assert.ok(resolved!.prompt.includes('- apply: true'))
    assert.ok(!resolved!.prompt.includes('Preview only'))
  })

  it('resolves /plan-close into a plan_close workflow prompt with apply by default', async () => {
    const resolved = resolveAppPromptInput('/plan-close docs/superpowers/plans/demo.md --tasks all', '/cwd')
    assert.ok(resolved !== null)

    assert.ok(resolved!.prompt.includes('Use the plan_close tool'))
    assert.ok(resolved!.prompt.includes('- tasks: all'))
    assert.ok(resolved!.prompt.includes('- apply: true'))
  })

  it('supports --preview to keep plan_close in preview mode', async () => {
    const resolved = resolveAppPromptInput('/plan-close docs/superpowers/plans/demo.md --tasks all --preview', '/cwd')
    assert.ok(resolved !== null)

    assert.ok(resolved!.prompt.includes('- apply: false'))
    assert.ok(resolved!.prompt.includes('Preview only; do not write the file.'))
  })

  it('returns null for empty /plan (handled by handleSlashCommand before resolver)', async () => {
    assert.equal(resolveAppPromptInput('/plan', '/cwd'), null)
  })

  it('resolves /team into a team workflow prompt', async () => {
    const resolved = resolveAppPromptInput('/team docs/superpowers/plans/loop-split-v3.md', '/cwd')
    assert.ok(resolved !== null)

    assert.ok(resolved!.prompt.includes('团队模式核心骨架'))
    assert.ok(resolved!.prompt.includes('team_orchestrate'))
    assert.ok(resolved!.prompt.includes('plan_task'))
    assert.ok(resolved!.prompt.includes('patcher workers as 天梁 executors'))
    assert.ok(resolved!.prompt.includes('deliver_task'))
  })

  it('resolves /team max into a planning-first prompt', async () => {
    const resolved = resolveAppPromptInput('/team max refactor loop pipeline', '/cwd')
    assert.ok(resolved !== null)

    assert.ok(resolved!.prompt.includes('/team max'))
    assert.ok(resolved!.prompt.includes('multi-perspective planning'))
    assert.ok(resolved!.prompt.includes('risk audit'))
  })

  it('resolves /council into a council_convene workflow prompt', async () => {
    const resolved = resolveAppPromptInput('/council 拆分 loop.ts 是否遗漏回滚', '/cwd')
    assert.ok(resolved !== null)

    assert.ok(resolved!.prompt.includes('星域议事会'))
    assert.ok(resolved!.prompt.includes('council_convene'))
    assert.ok(resolved!.prompt.includes('拆分 loop.ts 是否遗漏回滚'))
    assert.ok(resolved!.prompt.includes('绝不触发 team_orchestrate'))
  })

  it('returns council usage prompt for empty /council args', async () => {
    const resolved = resolveAppPromptInput('/council', '/cwd')
    assert.ok(resolved !== null)
    assert.ok(resolved!.prompt.includes('Council usage:'))
    assert.ok(resolved!.prompt.includes('--rounds'))
  })

  it('workflow 命令透传 requiredTools', async () => {
    const r = resolveAppPromptInput('/council 审查方案', '/cwd')
    assert.ok(r && typeof r === 'object')
    // team_orchestrate 已升 CORE（T3）——只剩 EXTENDED 层的 council_convene 需要挂载。
    assert.deepEqual(r!.requiredTools, ['council_convene'])
  })

  it('普通文本返回 requiredTools 为空', async () => {
    const r = resolveAppPromptInput('plain prompt', '/cwd')
    assert.equal(r?.requiredTools, undefined)
    assert.equal(r?.prompt, 'plain prompt')
  })

  it('未知 slash 仍返回 null', async () => {
    assert.equal(resolveAppPromptInput('/nonexistent', '/cwd'), null)
  })
})

describe('/grant 目录授权', () => {
  /** 清理 per-workspace store 文件残骸（grantPath persist 写真实 ~/.rivet）。 */
  function cleanup(ws: string, dir: string): void {
    const slug = ws.replace(/[^a-zA-Z0-9]/g, '_').slice(-64)
    rmSync(join(homedir(), '.rivet', `path-grants-${slug}.json`), { force: true })
  }

  it('/grant 无参列出已记住授权（空态提示）', async () => {
    const ws = makeTestDir('grant-ws-')
    const entries: LogEntry[] = []
    try {
      const ctx = makeCtx({
        parts: ['/grant'],
        agent: { ...(makeCtx().agent as any), cwd: ws },
        pushStatic: (e) => { entries.push(e) },
      })
      const handled = await handleSlashCommand(ctx)
      assert.equal(handled, true)
      const content = entries.map(e => e.content).join('\n')
      assert.match(content, /已记住的目录授权/)
      assert.match(content, /无/)
    } finally {
      cleanupTestDir(ws)
    }
  })

  it('/grant <path> 授权并记住，默认只读，重启回灌后仍生效', async () => {
    const ws = makeTestDir('grant-ws-')
    const dir = makeTestDir('grant-dir-')
    const entries: LogEntry[] = []
    try {
      const ctx = makeCtx({
        parts: ['/grant', dir],
        agent: { ...(makeCtx().agent as any), cwd: ws },
        pushStatic: (e) => { entries.push(e) },
      })
      const handled = await handleSlashCommand(ctx)
      assert.equal(handled, true)
      assert.match(entries.map(e => e.content).join('\n'), /已授权并记住\s*只读访问/)

      const { isReadGranted, isWriteGranted, loadPersistedGrants, _resetGrantsForTest } = await import('../../tools/path-grants.js')
      assert.equal(isReadGranted(join(dir, 'x')), true, 'grant in effect immediately')
      assert.equal(isWriteGranted(join(dir, 'x')), false, 'default mode is read')
      // 落盘：模拟新会话回灌
      _resetGrantsForTest()
      loadPersistedGrants(ws)
      assert.equal(isReadGranted(join(dir, 'x')), true, 'persisted grant hydrates from the workspace store')
    } finally {
      const { revokeGrant, _resetGrantsForTest } = await import('../../tools/path-grants.js')
      _resetGrantsForTest()
      revokeGrant(dir, { cwd: ws })
      cleanup(ws, dir)
      cleanupTestDir(ws)
      cleanupTestDir(dir)
    }
  })

  it('/grant <path> write 授权读写', async () => {
    const ws = makeTestDir('grant-ws-')
    const dir = makeTestDir('grant-dir-')
    try {
      const ctx = makeCtx({
        parts: ['/grant', dir, 'write'],
        agent: { ...(makeCtx().agent as any), cwd: ws },
        pushStatic: () => {},
      })
      const handled = await handleSlashCommand(ctx)
      assert.equal(handled, true)
      const { isWriteGranted } = await import('../../tools/path-grants.js')
      assert.equal(isWriteGranted(join(dir, 'x')), true)
    } finally {
      const { revokeGrant, _resetGrantsForTest } = await import('../../tools/path-grants.js')
      _resetGrantsForTest()
      revokeGrant(dir, { cwd: ws })
      cleanup(ws, dir)
      cleanupTestDir(ws)
      cleanupTestDir(dir)
    }
  })

  it('/grant 列表在授权后显示条目', async () => {
    const ws = makeTestDir('grant-ws-')
    const dir = makeTestDir('grant-dir-')
    const entries: LogEntry[] = []
    try {
      await handleSlashCommand(makeCtx({ parts: ['/grant', dir, 'write'], agent: { ...(makeCtx().agent as any), cwd: ws }, pushStatic: () => {} }))
      await handleSlashCommand(makeCtx({ parts: ['/grant'], agent: { ...(makeCtx().agent as any), cwd: ws }, pushStatic: (e) => { entries.push(e) } }))
      const content = entries.map(e => e.content).join('\n')
      assert.ok(content.includes(dir), 'list must show the remembered root')
      assert.match(content, /读写/)
    } finally {
      const { revokeGrant, _resetGrantsForTest } = await import('../../tools/path-grants.js')
      _resetGrantsForTest()
      revokeGrant(dir, { cwd: ws })
      cleanup(ws, dir)
      cleanupTestDir(ws)
      cleanupTestDir(dir)
    }
  })
})

describe('handleSlashCommand', () => {
  it('/help returns true and shows command list', async () => {
    const entries: string[] = []
    const ctx = makeCtx({
      pushStatic: (entry) => entries.push(entry.content),
    })
    const result = await handleSlashCommand(ctx)
    assert.equal(result, true)
    assert.ok(entries[0]!.includes('/help'))
    assert.ok(entries[0]!.includes('/exit'))
    assert.ok(entries[0]!.includes('/compact'))
    assert.ok(entries[0]!.includes('/plan close'))
    assert.ok(entries[0]!.includes('/team <task|plan>'))
    assert.ok(entries[0]!.includes('/team max <task>'))
  })

  it('/clear returns true', async () => {
    const ctx = makeCtx({ parts: ['/clear'] })
    assert.equal(await handleSlashCommand(ctx), true)
  })

  it('/plan without feature shows usage and returns true', async () => {
    const entries: string[] = []
    const streaming: boolean[] = []
    const ctx = makeCtx({
      parts: ['/plan'],
      pushStatic: (entry) => entries.push(entry.content),
      setIsStreaming: (v) => streaming.push(v),
    })

    assert.equal(await handleSlashCommand(ctx), true)
    assert.ok(entries[0]!.includes('Usage: /plan <feature>'))
    assert.deepEqual(streaming, [false])
  })

  it('/team without objective shows usage and returns true', async () => {
    const entries: string[] = []
    const streaming: boolean[] = []
    const ctx = makeCtx({
      parts: ['/team'],
      pushStatic: (entry) => entries.push(entry.content),
      setIsStreaming: (v) => streaming.push(v),
    })

    assert.equal(await handleSlashCommand(ctx), true)
    assert.ok(entries[0]!.includes('Usage: /team <task|docs/superpowers/plans/file.md>'))
    assert.deepEqual(streaming, [false])
  })

  it('/plan with feature falls through to agent prompt resolution', async () => {
    const ctx = makeCtx({ parts: ['/plan', 'add', 'workflow', 'aliases'] })
    assert.equal(await handleSlashCommand(ctx), false)
  })

  it('/write-plan with feature falls through to agent prompt resolution', async () => {
    const ctx = makeCtx({ parts: ['/write-plan', 'add', 'workflow', 'aliases'] })
    assert.equal(await handleSlashCommand(ctx), false)
  })

  it('/team with objective falls through to agent prompt resolution', async () => {
    const ctx = makeCtx({ parts: ['/team', 'docs/superpowers/plans/demo.md'] })
    assert.equal(await handleSlashCommand(ctx), false)
  })

  it('unknown command returns false', async () => {
    const ctx = makeCtx({ parts: ['/unknown-cmd'] })
    assert.equal(await handleSlashCommand(ctx), false)
  })

  it('/debug context-payload renders volatile payload report', async () => {
    const entries: string[] = []
    const ctx = makeCtx({
      parts: ['/debug', 'context-payload'],
      pushStatic: (entry) => entries.push(entry.content),
    })

    assert.equal(await handleSlashCommand(ctx), true)
    assert.ok(entries[0]!.includes('Context Payload'))
    assert.ok(entries[0]!.includes('environment'))
  })

  it('/verbose toggles and returns true', async () => {
    const values: boolean[] = []
    const ctx = makeCtx({
      parts: ['/verbose'],
      setVerbose: (v: boolean) => values.push(v),
    })
    assert.equal(await handleSlashCommand(ctx), true)
    assert.deepEqual(values, [true])
  })

  it('/chat and /task are deprecated no-ops (mode auto-detected) but still handled', async () => {
    const modes: string[] = []
    const chatCtx = makeCtx({ parts: ['/chat'], agent: { ...makeCtx().agent, setPromptMode: (m: string) => modes.push(m) } as any })
    const taskCtx = makeCtx({ parts: ['/task'], agent: { ...makeCtx().agent, setPromptMode: (m: string) => modes.push(m) } as any })

    assert.equal(await handleSlashCommand(chatCtx), true)
    assert.equal(await handleSlashCommand(taskCtx), true)
    assert.deepEqual(modes, [])  // mode is auto-detected — commands no longer switch
  })

  it('formats verification status with per-file levels', async () => {
    const agent = {
      getVerificationSummary: () => ({
        total: 2,
        verified: 1,
        pending: 1,
        files: [
          { path: 'src/prompt/mode.ts', level: 'tested' },
          { path: 'src/tui/app.tsx', level: 'pending' },
        ],
      }),
      getEvidenceState: () => ({
        verifications: [{ status: 'passed', command: 'npx tsx --test src/prompt/__tests__/mode.test.ts' }],
      }),
    } as any

    const formatted = formatVerificationStatus(agent)
    assert.match(formatted, /src\/prompt\/mode\.ts \(tested\)/)
    assert.match(formatted, /src\/tui\/app\.tsx \(pending\)/)
    assert.match(formatted, /Verification: 1\/2/)
  })

  it('/cockpit opens via SurfaceRouter and records selected panel', async () => {
    let selected = ''
    let pushed = ''
    const entries: LogEntry[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/cockpit', 'trace'],
      setCockpitPanel: panel => { selected = String(panel) },
      surfacePush: id => { pushed = id },
      pushStatic: entry => { entries.push(entry) },
    }))
    assert.equal(handled, true)
    assert.equal(selected, 'trace')
    assert.equal(pushed, 'cockpit')
    assert.ok(entries[0]?.content.includes('Trace'))
  })

  it('/cockpit toggles off through SurfaceRouter when cockpit overlay is active', async () => {
    let popped = false
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/cockpit'],
      activeOverlay: 'cockpit',
      surfacePop: () => { popped = true },
    }))
    assert.equal(handled, true)
    assert.equal(popped, true)
  })

  it('/scroll opens the pager overlay through SurfaceRouter', async () => {
    let pushed = ''
    const entries: LogEntry[] = []
    const streaming: boolean[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/scroll'],
      surfacePush: id => { pushed = id },
      pushStatic: entry => { entries.push(entry) },
      setIsStreaming: value => { streaming.push(value) },
    }))

    assert.equal(handled, true)
    assert.equal(pushed, 'pager')
    assert.deepEqual(streaming, [false])
    assert.ok(entries[0]?.content.includes('Scrollback pager opened'))
  })

  it('/mission shows the current task contract from the cognitive snapshot', async () => {
    const entries: LogEntry[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/mission'],
      agent: {
        ...makeCtx().agent,
        getCognitiveSnapshot: () => ({
          contractStatus: 'executing',
          objective: 'ship glance bar',
          scopeFileCount: 2,
          isActionableTask: true,
          hasVerificationGap: true,
          deliveryStatus: 'unverified',
        }),
      } as any,
      pushStatic: entry => { entries.push(entry) },
    }))
    assert.equal(handled, true)
    assert.ok(entries[0]?.content.includes('天契 行'))
    assert.ok(entries[0]?.content.includes('ship glance bar'))
  })

  describe('/domain', () => {
    it('/domain shows "not yet activated" when undefined', async () => {
      const entries: string[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => undefined,
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.ok(entries[0]!.includes('尚未激活'))
      assert.ok(entries[0]!.includes('自动匹配'))
    })

    it('/domain shows current domain when set', async () => {
      const entries: string[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => ({ id: 'pojun', name: '破军', volatileBlock: '破军之道', motto: '好男儿当负三尺剑立不世之功' }),
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.ok(entries[0]!.includes('破军'))
      assert.ok(entries[0]!.includes('pojun'))
      assert.ok(entries[0]!.includes('好男儿'))
    })

    it('/domain shows "no domain" when null', async () => {
      const entries: string[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => null,
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.ok(entries[0]!.includes('无星域'))
    })

    it('/domain list shows all domains including tianshu', async () => {
      const entries: string[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain', 'list'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => undefined,
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      const content = entries[0]!
      assert.ok(content.includes('破军'))
      assert.ok(content.includes('天府'))
      assert.ok(content.includes('天梁'))
      assert.ok(content.includes('天权'))
      assert.ok(content.includes('天机'))
      assert.ok(content.includes('天璇'))
      assert.ok(content.includes('天枢'))
    })

    it('/domain <id> switches to a domain by English id', async () => {
      const entries: string[] = []
      const setCalls: any[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain', 'tianfu'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => undefined,
          setSessionDomain: (d: any) => setCalls.push(d),
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.equal(setCalls.length, 1)
      assert.equal(setCalls[0]!.id, 'tianfu')
      assert.equal(setCalls[0]!.name, '天府')
      assert.ok(entries[0]!.includes('天府'))
    })

    it('/domain <name> switches by Chinese name', async () => {
      const entries: string[] = []
      const setCalls: any[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain', '破军'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => undefined,
          setSessionDomain: (d: any) => setCalls.push(d),
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.equal(setCalls.length, 1)
      assert.equal(setCalls[0]!.id, 'pojun')
      assert.ok(entries[0]!.includes('破军'))
    })

    it('/domain auto resets to auto-detect', async () => {
      const entries: string[] = []
      let resetCalled = false
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain', 'auto'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => ({ id: 'pojun', name: '破军', volatileBlock: 'test', motto: 'test' }),
          resetSessionDomain: () => { resetCalled = true },
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.equal(resetCalled, true)
      assert.ok(entries[0]!.includes('自动检测'))
    })

    it('/domain off is removed — treated as unknown domain, never disables', async () => {
      const entries: string[] = []
      const setCalls: any[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain', 'off'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => ({ id: 'pojun', name: '破军', volatileBlock: 'test', motto: 'test' }),
          setSessionDomain: (d: any) => setCalls.push(d),
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.deepEqual(setCalls, [], 'off no longer disables the domain')
      assert.ok(entries[0]!.includes('未知星域'))
    })

    it('/domain <unknown> shows error with valid names', async () => {
      const entries: string[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain', 'xyz'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => undefined,
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.ok(entries[0]!.includes('未知星域'))
      assert.ok(entries[0]!.includes('pojun'))
    })
  })

  describe('/leave', () => {
    it('seals an agent-chosen mark into the starmap', async () => {
      const cwd = makeTestDir('leave-')
      try {
        const entries: string[] = []
        const handled = await handleSlashCommand(makeCtx({
          parts: ['/leave', '⚘', 'wired', 'the', 'starmap'],
          agent: {
            ...makeCtx().agent,
            cwd,
            getSessionDomain: () => ({ id: 'yaoguang', name: '瑶光', volatileBlock: '', motto: '' }),
          } as any,
          currentSessionId: 'sess-leave',
          pushStatic: (entry) => entries.push(entry.content),
        }))
        assert.equal(handled, true)
        assert.ok(entries[0]!.includes('⚘'))
        const c = loadConstellation(cwd)
        assert.ok(c)
        assert.equal(c!.milestones.length, 1)
        assert.equal(c!.milestones[0]!.agentMark.symbol, '⚘')
        assert.equal(c!.milestones[0]!.summary, 'wired the starmap')
        assert.equal(c!.milestones[0]!.domain, 'yaoguang')
      } finally {
        cleanupTestDir(cwd)
      }
    })

    it('requires a summary', async () => {
      const cwd = makeTestDir('leave-')
      try {
        const entries: string[] = []
        const handled = await handleSlashCommand(makeCtx({
          parts: ['/leave'],
          agent: { ...makeCtx().agent, cwd, getSessionDomain: () => undefined } as any,
          pushStatic: (entry) => entries.push(entry.content),
        }))
        assert.equal(handled, true)
        assert.ok(entries[0]!.includes('Usage'))
        assert.equal(loadConstellation(cwd), null)
      } finally {
        cleanupTestDir(cwd)
      }
    })
  })
})

describe('/skill review|approve|reject — auto-distill drafts', () => {
  function seedDraft(cwd: string): string {
    const draft = distillSkillDraft({
      sessionId: 'feed1234-session',
      objective: 'parse jsonl session log',
      decisions: [],
      trajectory: [
        { turn: 1, tool: 'read_file', target: 'src/log.ts', durationMs: 1, status: 'success', inputSummary: '', resultSummary: '' },
        { turn: 1, tool: 'edit_file', target: 'src/log.ts', durationMs: 1, status: 'success', inputSummary: '', resultSummary: '' },
        { turn: 1, tool: 'run_tests', target: 'src/__tests__/log.test.ts', durationMs: 1, status: 'success', inputSummary: '', resultSummary: '' },
      ],
      verifications: [{ command: 'npm test', status: 'passed', scope: 'full', exitCode: 0, passed: 3, failed: 0, skipped: 0, durationMs: 5 }],
      filesModified: ['src/log.ts'],
      existingSkills: [],
    })!
    persistSkillDraft(cwd, draft)
    return draft.slug
  }

  it('/skill review lists pending drafts', async () => {
    const cwd = makeTestDir('skill-review-')
    try {
      const slug = seedDraft(cwd)
      const entries: string[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/skill', 'review'],
        agent: { ...makeCtx().agent, cwd } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.ok(entries[0]!.includes(slug), `应列出草稿: ${entries[0]}`)
      assert.ok(entries[0]!.includes('approve'))
    } finally {
      cleanupTestDir(cwd)
    }
  })

  it('/skill approve promotes a draft and removes it from drafts', async () => {
    const cwd = makeTestDir('skill-approve-')
    try {
      const slug = seedDraft(cwd)
      const entries: string[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/skill', 'approve', slug],
        agent: { ...makeCtx().agent, cwd } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.ok(entries[0]!.includes('已入库'), `应报告入库: ${entries[0]}`)
      assert.equal(listSkillDrafts(cwd).length, 0)
    } finally {
      cleanupTestDir(cwd)
    }
  })

  it('/skill reject deletes a draft', async () => {
    const cwd = makeTestDir('skill-reject-')
    try {
      const slug = seedDraft(cwd)
      const entries: string[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/skill', 'reject', slug],
        agent: { ...makeCtx().agent, cwd } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.ok(entries[0]!.includes('已丢弃'), `应报告丢弃: ${entries[0]}`)
      assert.equal(listSkillDrafts(cwd).length, 0)
    } finally {
      cleanupTestDir(cwd)
    }
  })
})

describe('/effort', () => {
  it('resets stale choice-panel kind before opening the picker', async () => {
    // 复现污染现场：面板类型残留为 ask-user-question（如先开过 ask 面板），
    // /effort 必须重置为 effort，否则渲染器按旧类型渲染。
    let kind: string = 'ask-user-question'
    const events: string[] = []

    const handled = await handleSlashCommand(makeCtx({
      parts: ['/effort'],
      setChoicePanelKind: (next) => {
        kind = next
        events.push(`kind:${next}`)
      },
      surfacePush: (id) => {
        events.push(`push:${id}`)
      },
    }))

    assert.equal(handled, true)
    assert.equal(kind, 'effort')
    assert.deepEqual(events, [
      'kind:effort',
      'push:choice-panel',
    ])
  })

  it('resets permission panel kind before opening the picker', async () => {
    // 更常见的污染路径：先 /permission 再 /effort，kind 残留 permission。
    let kind: string = 'permission'

    await handleSlashCommand(makeCtx({
      parts: ['/effort'],
      setChoicePanelKind: (next) => { kind = next },
    }))

    assert.equal(kind, 'effort')
  })
})

describe('/permission', () => {
  // Isolate real config writes (setCheckpointConfig / any persist) to a temp file.
  let prevConfigPath: string | undefined
  let tmpCfgDir = ''
  before(() => {
    prevConfigPath = process.env.RIVET_CONFIG_PATH
    tmpCfgDir = makeTestDir('permission-cfg-')
    process.env.RIVET_CONFIG_PATH = join(tmpCfgDir, 'config.json')
  })
  after(() => {
    if (prevConfigPath === undefined) delete process.env.RIVET_CONFIG_PATH
    else process.env.RIVET_CONFIG_PATH = prevConfigPath
    cleanupTestDir(tmpCfgDir)
  })

  it('bare /permission opens the interactive ANSI picker', async () => {
    let pushed: string | null = null
    let kind: string | null = null
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/permission'],
      surfacePush: (id: string) => { pushed = id },
      setChoicePanelKind: (k) => { kind = k },
    }))
    assert.equal(handled, true)
    assert.equal(pushed, 'choice-panel')
    assert.equal(kind, 'permission')
  })

  it('shows status explicitly (alias)', async () => {
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/permission', 'status'],
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.ok(entries[0]!.includes('当前权限: 监督 (manual)'), entries[0])
  })

  it('quick-switch to manual persists as default', async () => {
    let mode: string | null = null
    let autoSafe: boolean | null = null
    let persisted: string | null = null
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/permission', 'manual'],
      agent: {
        ...makeCtx().agent,
        setApprovalMode: (m: string) => { mode = m },
      } as any,
      setAutoSafe: (v: boolean) => { autoSafe = v },
      persistApprovalMode: (m: string) => { persisted = m },
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.equal(mode, 'manual')
    assert.equal(autoSafe, false)
    assert.equal(persisted, 'manual')
    assert.ok(entries[0]!.includes('已切换至 监督'), entries[0])
  })

  it('quick-switch to auto persists as default', async () => {
    let mode: string | null = null
    let autoSafe: boolean | null = null
    let persisted: string | null = null
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/permission', 'auto'],
      agent: {
        ...makeCtx().agent,
        setApprovalMode: (m: string) => { mode = m },
      } as any,
      setAutoSafe: (v: boolean) => { autoSafe = v },
      persistApprovalMode: (m: string) => { persisted = m },
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.equal(mode, 'auto-safe')
    assert.equal(autoSafe, true)
    assert.equal(persisted, 'auto-safe')
    assert.ok(entries[0]!.includes('已切换至 自动'), entries[0])
  })

  it('quick-switch to auto with checkpoint interval', async () => {
    let mode: string | null = null
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/permission', 'auto', '20'],
      agent: {
        ...makeCtx().agent,
        setApprovalMode: (m: string) => { mode = m },
      } as any,
      setAutoSafe: () => {},
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.equal(mode, 'auto-safe')
    assert.ok(entries[0]!.includes('检查点每 20 轮暂停'), entries[0])
  })

  it('quick-switch to yolo shows risk warning without confirm', async () => {
    let mode: string | null = null
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/permission', 'yolo'],
      agent: {
        ...makeCtx().agent,
        setApprovalMode: (m: string) => { mode = m },
      } as any,
      setAutoSafe: () => {},
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    // mode should NOT be changed without confirm
    assert.equal(mode, null)
    assert.ok(entries[0]!.includes('全自动风险说明'), entries[0])
    assert.ok(entries[0]!.includes('/permission yolo confirm'), entries[0])
    assert.ok(entries[0]!.includes('/permission unattended confirm'), entries[0])
  })

  it('quick-switch via supervise alias persists as default', async () => {
    let mode: string | null = null
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/permission', 'supervise'],
      agent: {
        ...makeCtx().agent,
        setApprovalMode: (m: string) => { mode = m },
      } as any,
      setAutoSafe: () => {},
      persistApprovalMode: () => {},
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.equal(mode, 'manual')
    assert.ok(entries[0]!.includes('已切换至 监督'), entries[0])
  })

  it('quick-switch via unattended confirm persists as default', async () => {
    let mode: string | null = null
    let persisted: string | null = null
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/permission', 'unattended', 'confirm'],
      agent: {
        ...makeCtx().agent,
        setApprovalMode: (m: string) => { mode = m },
      } as any,
      setAutoSafe: () => {},
      persistApprovalMode: (m: string) => { persisted = m },
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.equal(mode, 'dangerously-skip-permissions')
    assert.equal(persisted, 'dangerously-skip-permissions')
    assert.ok(entries[0]!.includes('已切换至 全自动'), entries[0])
  })

  it('quick-switch to yolo with confirm persists as default', async () => {
    let mode: string | null = null
    let autoSafe: boolean | null = null
    let persisted: string | null = null
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/permission', 'yolo', 'confirm'],
      agent: {
        ...makeCtx().agent,
        setApprovalMode: (m: string) => { mode = m },
      } as any,
      setAutoSafe: (v: boolean) => { autoSafe = v },
      persistApprovalMode: (m: string) => { persisted = m },
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.equal(mode, 'dangerously-skip-permissions')
    assert.equal(autoSafe, false)
    assert.equal(persisted, 'dangerously-skip-permissions')
    assert.ok(entries[0]!.includes('已切换至 全自动'), entries[0])
  })

  it('quick-switch to yolo WITHOUT confirm does not persist', async () => {
    let persisted: string | null = null
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/permission', 'yolo'],
      agent: { ...makeCtx().agent, setApprovalMode: () => {} } as any,
      setAutoSafe: () => {},
      persistApprovalMode: (m: string) => { persisted = m },
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.equal(persisted, null)
    assert.ok(entries[0]!.includes('全自动风险说明'), entries[0])
  })

  it('switches approval mode via /permission mode', async () => {
    let mode: string | null = null
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/permission', 'mode', 'auto-safe'],
      agent: {
        ...makeCtx().agent,
        setApprovalMode: (m: string) => { mode = m },
      } as any,
      setAutoSafe: (v: boolean) => {},
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.equal(mode, 'auto-safe')
    assert.ok(entries[0]!.includes('auto-safe'), entries[0])
  })

  it('adds an allow rule', async () => {
    let added: unknown = null
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/permission', 'allow', 'bash', 'command=git status*'],
      agent: {
        ...makeCtx().agent,
        addAllowRule: (r: unknown) => { added = r },
      } as any,
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.deepEqual(added, { tool: 'bash', params: { command: 'git status*' } })
  })

  it('adds a bash deny prefix', async () => {
    let added: string | null = null
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/permission', 'bash', 'deny', 'rm -rf'],
      agent: {
        ...makeCtx().agent,
        addBashDenyPrefix: (p: string) => { added = p },
      } as any,
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.equal(added, 'rm -rf')
  })

  it('tests a deny rule', async () => {
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/permission', 'test', 'bash', '{"command":"rm -rf /"}'],
      agent: {
        ...makeCtx().agent,
        config: {
          ...makeCtx().agent.config,
          permissionsOverlay: { allow: [], deny: [], bashAllow: [], bashDeny: ['rm'] },
        },
      } as any,
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.ok(entries[0]!.includes('deny'), entries[0])
  })
})

describe('/yes — one-command YOLO shortcut', () => {
  it('/yes enables YOLO and persists as default', async () => {
    let mode: string | null = null
    let autoSafe: boolean | null = null
    let persisted: string | null = null
    let maxTurns: number | null = null
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/yes'],
      agent: {
        ...makeCtx().agent,
        setApprovalMode: (m: string) => { mode = m },
        config: { maxTurns: 200 },
      } as any,
      setAutoSafe: (v: boolean) => { autoSafe = v },
      persistApprovalMode: (m: string) => { persisted = m },
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.equal(mode, 'dangerously-skip-permissions')
    assert.equal(autoSafe, false)
    assert.equal(persisted, 'dangerously-skip-permissions')
    assert.ok(entries[0]!.includes('全自动已开启'), entries[0])
  })

  it('/yes off returns to Auto and persists', async () => {
    let mode: string | null = null
    let autoSafe: boolean | null = null
    let persisted: string | null = null
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/yes', 'off'],
      agent: { ...makeCtx().agent, setApprovalMode: (m: string) => { mode = m } } as any,
      setAutoSafe: (v: boolean) => { autoSafe = v },
      persistApprovalMode: (m: string) => { persisted = m },
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.equal(mode, 'auto-safe')
    assert.equal(autoSafe, true)
    assert.equal(persisted, 'auto-safe')
    assert.ok(entries[0]!.includes('切回 自动'), entries[0])
  })

  it('/permission yolo risk text mentions /yes as confirm path', async () => {
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/permission', 'yolo'],
      setAutoSafe: () => {},
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.ok(entries[0]!.includes('/yes'), entries[0])
    assert.ok(entries[0]!.includes('/permission yolo confirm'), entries[0])
  })
})

describe('/skill install — copy skills from .claude/skills into .rivet/skills', () => {
  it('shows usage when no name is given', async () => {
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/skill', 'install'],
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.ok(entries[0]!.includes('用法'), entries[0])
  })

  it('installs a skill directory from project .claude/skills', async () => {
    const cwd = makeTestDir('skill-install-')
    const projectClaude = join(cwd, '.claude', 'skills', 'test-skill')
    try {
      // Seed a fake Claude skill directory inside the project sandbox.
      mkdirSync(projectClaude, { recursive: true })
      writeFileSync(join(projectClaude, 'SKILL.md'), '---\nname: test-skill\n---\nTest skill body.')

      const entries: string[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/skill', 'install', 'test-skill'],
        agent: { ...makeCtx().agent, cwd } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.ok(entries[0]!.includes('已安装'), `expected install success: ${entries[0]}`)
      assert.ok(existsSync(join(cwd, '.rivet', 'skills', 'test-skill', 'SKILL.md')))
    } finally {
      cleanupTestDir(cwd)
    }
  })

  it('reports skip when skill already exists in .rivet/skills', async () => {
    const cwd = makeTestDir('skill-install-skip-')
    const projectClaude = join(cwd, '.claude', 'skills', 'test-skill-skip')
    try {
      mkdirSync(projectClaude, { recursive: true })
      writeFileSync(join(projectClaude, 'SKILL.md'), '---\nname: test-skill-skip\n---\nBody.')
      mkdirSync(join(cwd, '.rivet', 'skills', 'test-skill-skip'), { recursive: true })
      writeFileSync(join(cwd, '.rivet', 'skills', 'test-skill-skip', 'SKILL.md'), '---\nname: test-skill-skip\n---\nExisting.')

      const entries: string[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/skill', 'install', 'test-skill-skip'],
        agent: { ...makeCtx().agent, cwd } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.ok(entries[0]!.includes('跳过'), `expected skip: ${entries[0]}`)
    } finally {
      cleanupTestDir(cwd)
    }
  })
})

describe('/cd 命令守卫', () => {
  it('无参显示当前工作目录与用法', async () => {
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/cd'],
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.ok(entries[0]!.includes('/cwd'), `expected current cwd: ${entries[0]}`)
    assert.ok(entries[0]!.includes('Usage: /cd <path>'))
  })

  it('onCwdSwitch 未接线时提示不可用', async () => {
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/cd', '/somewhere'],
      onCwdSwitch: undefined,
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.ok(entries[0]!.includes('不支持'), `expected unsupported hint: ${entries[0]}`)
  })

  it('切换失败（目录不存在/worker 运行中）原样透出错误', async () => {
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/cd', '/nonexistent'],
      onCwdSwitch: async () => ({ ok: false, error: '目录不存在：/nonexistent' }),
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.ok(entries[0]!.includes('目录不存在'), `expected error passthrough: ${entries[0]}`)
  })

  it('切换成功输出 from→to 与缓存提示', async () => {
    const entries: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/cd', '/new/proj'],
      onCwdSwitch: async (target) => {
        assert.equal(target, '/new/proj')
        return { ok: true, from: '/old/proj', to: '/new/proj', movedFiles: ['s.jsonl'] }
      },
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(handled, true)
    assert.ok(entries[0]!.includes('/old/proj → /new/proj'), `expected from→to: ${entries[0]}`)
    assert.ok(entries[0]!.includes('历史前缀缓存保留'), `expected cache note: ${entries[0]}`)
  })
})

describe('/btw 侧问派发', () => {
  it('把问题原样交给侧问执行器', async () => {
    const asked: string[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/btw', '刚才那个', 'TS2322', '是什么意思'],
      askSideQuestion: (q) => asked.push(q),
    }))
    assert.equal(handled, true)
    assert.deepEqual(asked, ['刚才那个 TS2322 是什么意思'])
  })

  it('不提交给主 agent —— 侧问不进对话历史，也不占主 turn', async () => {
    let submitted = 0
    const asked: string[] = []
    await handleSlashCommand(makeCtx({
      parts: ['/btw', '问题'],
      askSideQuestion: (q) => asked.push(q),
      submitToAgent: () => { submitted++ },
    }))
    assert.equal(asked.length, 1)
    assert.equal(submitted, 0, '走了主 agent 就等于进了历史，功能定位就没了')
  })

  it('无参数时打印用法而不是发一次空请求', async () => {
    const entries: string[] = []
    let called = 0
    await handleSlashCommand(makeCtx({
      parts: ['/btw'],
      askSideQuestion: () => { called++ },
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.equal(called, 0)
    assert.ok(entries[0]!.includes('用法：/btw'), `expected usage: ${entries[0]}`)
  })

  it('未接入执行器时明确报不可用，不静默吞掉', async () => {
    const entries: string[] = []
    await handleSlashCommand(makeCtx({
      parts: ['/btw', '问题'],
      pushStatic: (entry) => entries.push(entry.content),
    }))
    assert.ok(entries[0]!.includes('不可用'), `expected unavailable notice: ${entries[0]}`)
  })
})


describe('/handoff 命令', () => {
  it('未注入 submitToAgent 时明确提示，不静默', async () => {
    let captured = ''
    const ctx = makeCtx({
      parts: ['/handoff'],
      pushStatic: (entry: LogEntry) => { captured += `${entry.content}\n` },
    })
    const handled = await handleSlashCommand(ctx)
    assert.equal(handled, true)
    assert.match(captured, /不支持 \/handoff/)
  })

  it('注入 submitToAgent 时提交交接指令并登记归档任务', async () => {
    let submitted = ''
    let registered: { src: string; dest: string } | undefined
    const ctx = makeCtx({
      parts: ['/handoff', '重点记下缓存方案'],
      submitToAgent: (prompt: string) => { submitted = prompt },
      onHandoffStart: (src: string, dest: string) => { registered = { src, dest } },
      currentSessionId: 'sess-handoff-001',
    })
    const handled = await handleSlashCommand(ctx)
    assert.equal(handled, true)
    // 交接指令指向项目内 .rivet/HANDOFF.md（工作区内免审批）
    assert.ok(submitted.includes('/cwd/.rivet/HANDOFF.md'), `prompt 含项目内路径: ${submitted.slice(0, 200)}`)
    assert.match(submitted, /## 任务目标/)
    assert.match(submitted, /用户补充指示：重点记下缓存方案/)
    // 归档任务：src=项目内文档，dest=会话目录 <id>.handoff.md
    assert.equal(registered?.src, '/cwd/.rivet/HANDOFF.md')
    assert.ok(registered?.dest.includes('sess-handoff-001.handoff.md'), `dest: ${registered?.dest}`)
  })
})

describe('/logs', () => {
  it('打印数据根、会话 id 与六维门控 —— 用户不该为找日志去读源码', async () => {
    let captured = ''
    const ctx = makeCtx({
      parts: ['/logs'],
      currentSessionId: 'sess-logs-001',
      pushStatic: (entry: LogEntry) => { captured += `${entry.content}\n` },
    })

    const handled = await handleSlashCommand(ctx)

    assert.equal(handled, true)
    assert.match(captured, /数据根:/)
    assert.ok(captured.includes('sess-logs-001'), `应带上当前会话 id: ${captured.slice(0, 300)}`)
    assert.ok(captured.includes('RIVET_DEBUG_TELEMETRY'), '六维为空的首要原因是门控，必须写出来')
    assert.ok(captured.includes('sidecar'), '桌面排查线索也要在 TUI 里可见')
  })

  it('输出里给出 open 子命令的出路 —— 只告诉路径还得让用户自己 cd', async () => {
    let captured = ''
    const ctx = makeCtx({
      parts: ['/logs'],
      currentSessionId: 'sess-logs-002',
      pushStatic: (entry: LogEntry) => { captured += `${entry.content}\n` },
    })

    await handleSlashCommand(ctx)

    assert.match(captured, /\/logs open/)
    assert.match(captured, /\/logs open desktop/)
  })

  // `open` 的真实行为（目标选择、opener 调用）在 logs-cli 那层用注入的 opener
  // 测，这里不重复——在 TUI 层跑它会真的拉起文件管理器。
})

describe('/yolo 与 /yes 覆盖版共享 handler（handleYoloToggle）', () => {
  function makeEnv(overrides: Record<string, unknown> = {}) {
    const calls: string[] = []
    const state = {
      maxTurns: 200,
      planning: false,
      panelKind: 'effort',
      overlayActive: false,
      approvalModeBeforePlan: null as string | null,
      persisted: null as string | null,
      persistError: null as Error | null,
    }
    const env = {
      agent: {
        setApprovalMode: (m: string) => calls.push(`agent.setApprovalMode:${m}`),
        config: { maxTurns: 200 },
        planModeState: null as string | null,
      },
      app: {
        setApprovalMode: (m: string) => calls.push(`app.setApprovalMode:${m}`),
        approvalModeBeforePlan: null as string | null,
        choicePanelKind: 'effort',
        activeOverlayId: () => (state.overlayActive ? 'choice-panel' : null),
        deactivateOverlay: () => calls.push('deactivateOverlay'),
        commitStatic: (t: string) => calls.push(`commitStatic:${t}`),
        setStreamingState: (v: boolean) => calls.push(`setStreamingState:${v}`),
      },
      persistDefault: (m: string) => {
        if (state.persistError) throw state.persistError
        state.persisted = m
        calls.push(`persistDefault:${m}`)
      },
    } as any
    // 应用 overrides 到对应层级
    if (overrides.planning) env.agent.planModeState = 'planning'
    if (overrides.panelOpen) {
      env.app.choicePanelKind = 'permission-yolo-confirm'
      state.overlayActive = true
    }
    if (overrides.persistError) state.persistError = overrides.persistError as Error
    return { env, calls, state }
  }

  const TEXTS = {
    on: '⚠ yolo 已开启 — 无限轮次，无刹车无打扰（已设为默认）。关闭: /yolo off · 回滚: /rollback',
    off: '✓ 已退出 yolo，切回 自动 — 低/无风险自动，高风险仍确认（已设为默认）。',
  }

  it('无参 → 开启全自动：agent+app 同步、maxTurns 0、持久化、返回 true', () => {
    const { env, calls, state } = makeEnv()
    const handled = handleYoloToggle('/yolo', env, TEXTS)
    assert.equal(handled, true)
    assert.ok(calls.includes('agent.setApprovalMode:dangerously-skip-permissions'))
    assert.ok(calls.includes('app.setApprovalMode:dangerously-skip-permissions'))
    assert.ok(calls.includes('persistDefault:dangerously-skip-permissions'))
    assert.equal(env.agent.config.maxTurns, 0)
    assert.ok(calls.some(c => c === `commitStatic:${TEXTS.on}`))
    assert.ok(calls.includes('setStreamingState:false'))
    assert.equal(state.persisted, 'dangerously-skip-permissions')
  })

  it('on 显式参数与无参同语义', () => {
    const { env, calls } = makeEnv()
    handleYoloToggle('/yolo on', env, TEXTS)
    assert.ok(calls.includes('agent.setApprovalMode:dangerously-skip-permissions'))
    assert.equal(env.agent.config.maxTurns, 0)
  })

  it('off → 关闭全自动：auto-safe、maxTurns 200、持久化 auto-safe', () => {
    const { env, calls, state } = makeEnv()
    const handled = handleYoloToggle('/yolo off', env, TEXTS)
    assert.equal(handled, true)
    assert.ok(calls.includes('agent.setApprovalMode:auto-safe'))
    assert.ok(calls.includes('persistDefault:auto-safe'))
    assert.equal(env.agent.config.maxTurns, 200)
    assert.ok(calls.some(c => c === `commitStatic:${TEXTS.off}`))
    assert.equal(state.persisted, 'auto-safe')
  })

  it('YOLO 确认面板打开时 → 视为确认并关闭面板', () => {
    const { env, calls } = makeEnv({ panelOpen: true })
    handleYoloToggle('/yolo', env, TEXTS)
    assert.ok(calls.includes('deactivateOverlay'))
    assert.equal(env.app.choicePanelKind, 'effort')
  })

  it('planning 叠层期间 → approvalModeBeforePlan 同步为最新意图', () => {
    const { env } = makeEnv({ planning: true })
    handleYoloToggle('/yolo off', env, TEXTS)
    assert.equal(env.app.approvalModeBeforePlan, 'auto-safe')
    const { env: env2 } = makeEnv({ planning: true })
    handleYoloToggle('/yolo', env2, TEXTS)
    assert.equal(env2.app.approvalModeBeforePlan, 'dangerously-skip-permissions')
  })

  it('持久化失败 → 输出可见提示（不静默），切换本身仍生效', () => {
    const { env, calls } = makeEnv({ persistError: new Error('disk readonly') })
    handleYoloToggle('/yolo', env, TEXTS)
    assert.ok(calls.includes('agent.setApprovalMode:dangerously-skip-permissions'), '切换仍生效')
    const failMsg = calls.find(c => c.startsWith('commitStatic:') && c.includes('持久化失败'))
    assert.ok(failMsg, '应输出持久化失败提示')
    assert.ok(failMsg!.includes('disk readonly'), `提示应含原因: ${failMsg}`)
  })
})

describe('mcpStatusText（/mcp 裸命令真实状态，与 /debug mcp 同源）', () => {
  it('无 manager → 未初始化文案', () => {
    assert.match(mcpStatusText(null), /not initialized/)
    assert.match(mcpStatusText(undefined), /not initialized/)
  })

  it('有 manager → 逐 server 状态行 + 工具清单', () => {
    const fakeMgr = {
      getStates: () => [
        { serverId: 'context7', status: 'connected', toolCount: 2 },
        { serverId: 'broken', status: 'error', error: 'spawn npx ENOENT' },
      ],
      getAllTools: () => [
        { definition: { name: 'mcp__context7__resolve' } },
        { definition: { name: 'mcp__context7__docs' } },
      ],
    }
    const text = mcpStatusText(fakeMgr as never)
    assert.match(text, /2 server\(s\), 2 tool\(s\)/)
    assert.match(text, /context7: connected — 2 tools/)
    assert.match(text, /broken: error: spawn npx ENOENT/)
    assert.match(text, /mcp__context7__resolve/)
  })
})
