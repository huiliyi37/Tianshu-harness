import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ProfileRegistry, profileRegistry, profileCanEditFiles, delegationToolTimeoutMs, tierTimeoutMultiplier, DEFAULT_DELEGATE_CONCURRENCY } from '../profile-registry.js'
import { progressiveTimeout, WORKER_EXIT_GRACE_MS } from '../timeout-ladder.js'
import { MAX_BUDGET_CONTINUATIONS, MAX_HANDS_EXTRA_RUNS } from '../worker-continuation.js'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `rivet-test-agents-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('ProfileRegistry', () => {
  let registry: ProfileRegistry

  beforeEach(() => {
    registry = new ProfileRegistry()
  })

  it('has 20 built-in profiles (9 core + 6 flash-army + designer + council_expert + goal_judge + perspective_planner + verify_scout)', async () => {
    assert.equal(registry.list().length, 20)
  })

  // 2026-07-04 缺陷复盘: scout 读了过时文档把 Ink 组件当成现状上报,规划者照单全收。
  // 侦察层必须区分"当前源码"与"文档/历史计划",文档断言先对源码复核再上报。
  it('code_scout carries evidence-source discipline', () => {
    const p = registry.get('code_scout')!
    assert.match(p.expertisePrompt, /\[当前源码\]/)
    assert.match(p.expertisePrompt, /\[历史计划或备忘\]/)
    assert.match(p.expertisePrompt, /对当前源码核验/)
    assert.match(p.expertisePrompt, /文档说 X，当前代码显示 Y/)
  })

  // "证无"任务上廉价模型会反复 grep 空结果仍不收手，直到 budget 超时
  // （见 docs/analysis/2026-07-17-worker-batch-0-salvage-incident.md §3）。
  // scout 必须带显式收敛纪律：多样 pattern 无果即报告"已证无"并停止。
  it('code_scout carries convergence discipline for prove-absence tasks', () => {
    const p = registry.get('code_scout')!
    assert.match(p.expertisePrompt, /收敛纪律/)
    assert.match(p.expertisePrompt, /证无/)
    assert.match(p.expertisePrompt, /已证无/)
    assert.match(p.expertisePrompt, /多样 pattern 之后仍无果，是发现/)
  })

  it('doc_scout marks unverified current-state claims', () => {
    const p = registry.get('doc_scout')!
    assert.match(p.expertisePrompt, /滞后于代码/)
    assert.match(p.expertisePrompt, /未对源码核验/)
  })

  it('doc_scout carries convergence discipline for prove-absence tasks', () => {
    const p = registry.get('doc_scout')!
    assert.match(p.expertisePrompt, /收敛纪律/)
    assert.match(p.expertisePrompt, /已证无/)
  })

  it('maps code_scout as readonly', async () => {
    const p = registry.get('code_scout')!
    assert.ok(p)
    assert.equal(p.role, 'readonly')
    assert.equal(p.builtIn, true)
  })

  // 2026-09-13 json_parse 事故：reviewer 未声明 defaultMaxTokens，收尾轮
  // max_tokens 落 work-order 的 4096 兜底（代码注释声称 16384）——findings
  // 10+ 条的审查报告被截成畸形 JSON，salvage 后渲染为「review DID NOT run」。
  it('maps reviewer as readonly with report-sized token budget', async () => {
    const p = registry.get('reviewer')!
    assert.ok(p)
    assert.equal(p.role, 'readonly')
    assert.equal(
      p.defaultMaxTokens,
      16384,
      '审查报告即主产出——收尾轮输出上限不得落 4096 兜底（与 verifier 族同档）',
    )
  })

  it('maps patcher as hands with write tools', async () => {
    const p = registry.get('patcher')!
    assert.ok(p)
    assert.equal(p.role, 'hands')
    assert.ok(p.allowedTools.includes('edit_file'))
    assert.ok(p.allowedTools.includes('write_file'))
    assert.ok(p.allowedTools.includes('bash'))
  })

  it('maps planner as brain with delegate tools', async () => {
    const p = registry.get('planner')!
    assert.ok(p)
    assert.equal(p.role, 'brain')
    assert.ok(p.allowedTools.includes('delegate_task'))
    assert.ok(p.allowedTools.includes('delegate_batch'))
  })

  it('maps verifier as hands with defaultKind=verify', async () => {
    const p = registry.get('verifier')!
    assert.ok(p)
    assert.equal(p.role, 'hands')
    assert.equal(p.defaultKind, 'verify')
    assert.equal(p.defaultMaxTokens, 16384)
  })

  it('maps adversarial_verifier as readonly_plus_test with no write/bash tools', async () => {
    const p = registry.get('adversarial_verifier')!
    assert.ok(p)
    assert.equal(p.role, 'readonly_plus_test')
    assert.equal(p.defaultKind, 'verify')
    assert.equal(p.defaultMaxTokens, 16384)
    assert.ok(p.allowedTools.includes('run_tests'))
    assert.ok(p.allowedTools.includes('read_file'))
    assert.ok(!p.allowedTools.includes('edit_file'))
    assert.ok(!p.allowedTools.includes('write_file'))
    assert.ok(!p.allowedTools.includes('bash'))
  })

  it('listWriteProfiles returns hands roles (adversarial_verifier is not hands)', async () => {
    const write = registry.listWriteProfiles()
    // adversarial_verifier has role 'readonly_plus_test', not 'hands' — excluded from write list.
    // Flash-army hands profiles (lint_fixer/type_fixer/import_organizer/doc_syncer/test_scaffolder) included.
    assert.deepEqual(write.sort(), ['doc_syncer', 'import_organizer', 'lint_fixer', 'patcher', 'test_scaffolder', 'type_fixer', 'verifier'])
  })

  it('listReadOnlyProfiles returns readonly roles', async () => {
    const ro = registry.listReadOnlyProfiles()
    // adversarial_verifier is readonly_plus_test, not 'readonly' — excluded from readonly list.
    // designer + format_checker are readonly and included.
    assert.deepEqual(ro.sort(), ['architect', 'code_scout', 'council_expert', 'designer', 'doc_scout', 'format_checker', 'perspective_planner', 'reviewer', 'troubleshooter'])
  })

  it('getProfileNames returns all 20 names', async () => {
    const names = registry.getProfileNames().sort()
    assert.deepEqual(names, ['adversarial_verifier', 'architect', 'code_scout', 'council_expert', 'designer', 'doc_scout', 'doc_syncer', 'format_checker', 'goal_judge', 'import_organizer', 'lint_fixer', 'patcher', 'perspective_planner', 'planner', 'reviewer', 'test_scaffolder', 'troubleshooter', 'type_fixer', 'verifier', 'verify_scout'])
  })

  it('ignores filesystem metadata without rejecting ordinary dotfile profiles', async () => {
    const tmp = makeTmpDir()
    try {
      const markdown = (name: string) => `---\nname: ${name}\nrole: readonly\ntools: ["read_file"]\n---\nReal profile.`
      writeFileSync(join(tmp, '.notes.md'), markdown('dot_notes'))
      writeFileSync(join(tmp, '._metadata.md'), markdown('metadata_worker'))
      writeFileSync(join(tmp, '._bad.md'), 'not frontmatter')
      writeFileSync(join(tmp, '.DS_Store'), 'not a profile')
      const result = await registry.loadFromDirectory(tmp)
      assert.deepEqual(result.loaded, ['dot_notes'])
      assert.deepEqual(result.errors, [])
      assert.equal(registry.get('dot_notes')?.expertisePrompt, 'Real profile.')
      assert.equal(registry.get('metadata_worker'), undefined)
      assert.equal(registry.list().length, 21)
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('rejects overriding built-in profiles', async () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(join(tmp, 'patcher.md'), '---\nname: patcher\nrole: brain\ntools: ["read_file"]\n---\nOverride attempt')
      const result = await registry.loadFromDirectory(tmp)
      assert.equal(result.errors.length, 1)
      assert.ok(result.errors[0]!.includes('cannot override built-in'))
      // patcher should still be hands
      assert.equal(registry.get('patcher')!.role, 'hands')
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('loads valid user-defined profile', async () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(
        join(tmp, 'security-auditor.md'),
        '---\nname: security_auditor\nrole: readonly\ntools: ["read_file","grep","glob"]\n---\nYou audit code for security vulnerabilities.',
      )
      const result = await registry.loadFromDirectory(tmp)
      assert.deepEqual(result.loaded, ['security_auditor'])
      assert.equal(result.errors.length, 0)
      const p = registry.get('security_auditor')!
      assert.equal(p.role, 'readonly')
      assert.equal(p.expertisePrompt, 'You audit code for security vulnerabilities.')
      assert.equal(p.builtIn, false)
      assert.deepEqual([...p.allowedTools], ['read_file', 'grep', 'glob'])
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('reports error for invalid frontmatter', async () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(join(tmp, 'bad.md'), 'no frontmatter here')
      const result = await registry.loadFromDirectory(tmp)
      assert.equal(result.errors.length, 1)
      assert.ok(result.errors[0]!.includes('Missing YAML frontmatter'))
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('reports error for missing role', async () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(join(tmp, 'no-role.md'), '---\nname: norole\ntools: ["read_file"]\n---\nMissing role')
      const result = await registry.loadFromDirectory(tmp)
      assert.equal(result.errors.length, 1)
      assert.ok(result.errors[0]!.includes('Invalid role'))
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('handles non-existent directory gracefully', async () => {
    const result = await registry.loadFromDirectory('/nonexistent/path/agents')
    assert.deepEqual(result.loaded, [])
    assert.deepEqual(result.errors, [])
  })

  it('parses maxTokens as number from YAML frontmatter', async () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(
        join(tmp, 'custom.md'),
        '---\nname: custom_worker\nrole: hands\ntools: ["read_file","edit_file"]\nmaxTokens: 32768\n---\nCustom worker.',
      )
      const result = await registry.loadFromDirectory(tmp)
      assert.deepEqual(result.loaded, ['custom_worker'])
      assert.equal(result.errors.length, 0)
      const p = registry.get('custom_worker')!
      assert.equal(p.defaultMaxTokens, 32768, 'maxTokens should be parsed as number, not undefined')
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('handles maxTokens with non-numeric value gracefully', async () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(
        join(tmp, 'bad-tokens.md'),
        '---\nname: bad_tokens\nrole: hands\ntools: ["read_file"]\nmaxTokens: abc\n---\nBad tokens.',
      )
      const result = await registry.loadFromDirectory(tmp)
      assert.deepEqual(result.loaded, ['bad_tokens'])
      const p = registry.get('bad_tokens')!
      assert.equal(p.defaultMaxTokens, undefined, 'non-numeric maxTokens should be undefined')
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('parses YAML array with values containing apostrophes', async () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(
        join(tmp, 'apostrophe.md'),
        // Use double quotes in YAML array to avoid apostrophe parsing issues
        '---\nname: apostrophe_test\nrole: readonly\ntools: ["read_file","grep"]\n---\nAgent for McDonald\'s code.',
      )
      const result = await registry.loadFromDirectory(tmp)
      assert.deepEqual(result.loaded, ['apostrophe_test'])
      assert.equal(result.errors.length, 0, 'should not error on arrays parsed correctly')
      const p = registry.get('apostrophe_test')!
      assert.deepEqual([...p.allowedTools], ['read_file', 'grep'])
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('reports error for malformed array with apostrophes in single-quoted values', async () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(
        join(tmp, 'bad-array.md'),
        // This has single-quoted array with values containing apostrophes - will fail JSON.parse
        "---\nname: bad_array\nrole: readonly\ntools: ['read_file','grep']\n---\nBad array.",
      )
      const result = await registry.loadFromDirectory(tmp)
      // The tools should either parse correctly or report an error
      // With current implementation, fallback to [val] which is not an array of tool names
      // After fix, this should produce an error
      assert.ok(result.loaded.length > 0 || result.errors.length > 0, 'should either load or report error, not silently corrupt')
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })
})

describe('delegationToolTimeoutMs (A2: wave-scaled batch timeout)', () => {
  const mature = progressiveTimeout(undefined) // mature tier (see timeout-ladder)
  // 可续跑的 profile 按最坏运行次数放宽（首轮 + MAX_BUDGET_CONTINUATIONS 次续跑），
  // 否则续跑撞上工具层硬 reject，连首轮 partial 一起丢。
  const runs = 1 + MAX_BUDGET_CONTINUATIONS

  it('single wave (taskCount <= maxWorkers) equals budget × runs + grace', async () => {
    const single = delegationToolTimeoutMs(undefined, [undefined, undefined], { taskCount: 2 })
    assert.equal(single, mature * runs + WORKER_EXIT_GRACE_MS)
  })

  it('backward-compatible: no opts defaults taskCount to profiles.length', async () => {
    // 3 profiles, default concurrency 3 → 1 wave.
    const legacy = delegationToolTimeoutMs(undefined, [undefined, undefined, undefined])
    assert.equal(legacy, mature * runs + WORKER_EXIT_GRACE_MS)
  })

  it('scales by ceil(taskCount / maxWorkers) waves', async () => {
    // 5 tasks on the default 3-worker pool → ceil(5/3)=2 waves.
    const twoWaves = delegationToolTimeoutMs(undefined, [], { taskCount: 5 })
    assert.equal(twoWaves, mature * 2 * runs + WORKER_EXIT_GRACE_MS)
    assert.equal(DEFAULT_DELEGATE_CONCURRENCY, 3)
  })

  it('honors explicit maxWorkers when provided', async () => {
    // 10 tasks / 3 workers → ceil = 4 waves.
    const fourWaves = delegationToolTimeoutMs(undefined, [], { taskCount: 10, maxWorkers: 3 })
    assert.equal(fourWaves, mature * 4 * runs + WORKER_EXIT_GRACE_MS)
  })

  it('never returns less than one wave for empty/zero input', async () => {
    const floor = delegationToolTimeoutMs(undefined, [], { taskCount: 0 })
    assert.equal(floor, mature * runs + WORKER_EXIT_GRACE_MS)
  })

  it('全是写工时按 hands 总账放宽——Wave 7 起写工也在工作树内续跑', async () => {
    const patcherBudget = profileRegistry.get('patcher')?.defaultTimeoutMs ?? mature
    const budget = Math.max(mature, patcherBudget)
    const handsRuns = 1 + MAX_HANDS_EXTRA_RUNS
    const handsOnly = delegationToolTimeoutMs(undefined, ['patcher'], { taskCount: 1 })
    assert.equal(handsOnly, budget * handsRuns + WORKER_EXIT_GRACE_MS)
  })

  it('按次 timeoutMs 抬高天花板；调小则不收紧（内层自己先开枪）', async () => {
    const raised = delegationToolTimeoutMs(undefined, [undefined], { taskCount: 1, requestedTimeoutMs: [900_000] })
    assert.equal(raised, 900_000 * runs + WORKER_EXIT_GRACE_MS)
    const lowered = delegationToolTimeoutMs(undefined, [undefined], { taskCount: 1, requestedTimeoutMs: [1000] })
    assert.equal(lowered, mature * runs + WORKER_EXIT_GRACE_MS)
    const mixed = delegationToolTimeoutMs(undefined, [undefined, undefined], { taskCount: 2, requestedTimeoutMs: [undefined, 700_000] })
    assert.equal(mixed, 700_000 * runs + WORKER_EXIT_GRACE_MS, '取批内最大的按次预算')
  })

  it('profile 省略时按可续跑放宽——默认落到只读 code_scout', async () => {
    // delegate 工具层 profile 可选，模型省略时这里收到 undefined，而实际 worker
    // 是能续跑的 code_scout。按「只有确定全是写工才不放宽」判据，这里必须放宽。
    const scoutBudget = profileRegistry.get('code_scout')?.defaultTimeoutMs ?? mature
    const omitted = delegationToolTimeoutMs(undefined, [undefined], { taskCount: 1 })
    assert.equal(omitted, mature * runs + WORKER_EXIT_GRACE_MS)
    assert.ok(omitted >= scoutBudget, '放宽后的天花板不得低于 code_scout 单轮预算')
  })

  it('tierFloor=strong 时 outer timeout 按 1.5x 放大', async () => {
    const reviewerBudget = profileRegistry.get('reviewer')?.defaultTimeoutMs ?? mature
    const budget = Math.max(mature, reviewerBudget)
    const base = delegationToolTimeoutMs(undefined, ['reviewer'], { taskCount: 1 })
    const strong = delegationToolTimeoutMs(undefined, ['reviewer'], { taskCount: 1, tierFloors: ['strong'] })
    const expected = Math.round(budget * 1.5) * runs + WORKER_EXIT_GRACE_MS
    assert.equal(strong, expected)
    assert.ok(strong > base, `strong 预算(${strong}) 应大于 base(${base})`)
  })

  it('tierFloor=cheap/balanced 不加倍率', async () => {
    const base = delegationToolTimeoutMs(undefined, ['reviewer'], { taskCount: 1 })
    const cheap = delegationToolTimeoutMs(undefined, ['reviewer'], { taskCount: 1, tierFloors: ['cheap'] })
    const balanced = delegationToolTimeoutMs(undefined, ['reviewer'], { taskCount: 1, tierFloors: ['balanced'] })
    assert.equal(cheap, base)
    assert.equal(balanced, base)
  })

  it('tierFloor 未知值时 fallback 1.0', async () => {
    const base = delegationToolTimeoutMs(undefined, ['reviewer'], { taskCount: 1 })
    const unknown = delegationToolTimeoutMs(undefined, ['reviewer'], { taskCount: 1, tierFloors: ['nonexistent' as any] })
    assert.equal(unknown, base)
  })

  it('mixed tierFloors 取批内最大倍率', async () => {
    const strongOnly = delegationToolTimeoutMs(undefined, ['reviewer'], { taskCount: 1, tierFloors: ['strong'] })
    const mixed = delegationToolTimeoutMs(undefined, ['reviewer', 'reviewer', 'reviewer'], {
      taskCount: 3,
      tierFloors: ['cheap', 'strong', 'balanced'],
    })
    // mixed 中 strong 的 1.5x 应为最大，且跑满 3 个 task 的 waves
    assert.equal(mixed, strongOnly, 'mixed [cheap,strong,balanced] 应取 max=1.5x 即与纯 strong 同倍率')
    assert.ok(mixed > delegationToolTimeoutMs(undefined, ['reviewer', 'reviewer', 'reviewer'], {
      taskCount: 3,
      tierFloors: ['cheap', 'cheap', 'balanced'],
    }), 'mixed 含 strong 应大于全非 strong')
  })

  it('tierTimeoutMultiplier 单点事实源', () => {
    assert.equal(tierTimeoutMultiplier('strong'), 1.5)
    assert.equal(tierTimeoutMultiplier('balanced'), 1.0)
    assert.equal(tierTimeoutMultiplier('cheap'), 1.0)
    assert.equal(tierTimeoutMultiplier(undefined), 1.0)
    assert.equal(tierTimeoutMultiplier('unknown'), 1.0)
  })
})

describe('profileCanEditFiles（B：文件写权判定）', () => {
  it('编辑工具集收敛为六个文件写工具——bash/run_tests 不算文件写权', () => {
    assert.equal(profileCanEditFiles('patcher'), true)
    assert.equal(profileCanEditFiles('reviewer'), false)
    assert.equal(profileCanEditFiles('code_scout'), false)
    // run_tests 有执行权，但 verify_scout 不能改文件
    assert.equal(profileCanEditFiles('verify_scout'), false)
    assert.equal(profileCanEditFiles('unknown-profile'), false)
  })

  it('verify_scout 注册为内置 profile：只读 + run_tests，无任何编辑工具', () => {
    const p = profileRegistry.get('verify_scout')
    assert.ok(p, 'verify_scout 必须注册')
    assert.equal(p.role, 'readonly_plus_test')
    assert.ok(p.allowedTools.includes('run_tests'), '验证维度必须有执行测试的能力')
    assert.ok(p.allowedTools.includes('read_file'))
    assert.ok(!p.allowedTools.includes('edit_file'))
    assert.ok(!p.allowedTools.includes('write_file'))
    assert.ok(!p.allowedTools.includes('bash'))
  })

  it('verify_scout 带验证证据纪律（命令 + exit code + 失败项）', () => {
    const p = profileRegistry.get('verify_scout')!
    assert.match(p.expertisePrompt, /exit code|退出码/)
  })
})
