import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractPlanPath, parseChecklistItems, parseChecklistSections, createPlanTaskTool } from '../plan-task.js'
import { getTodos, setTodos } from '../todo.js'
import type { TodoItem } from '../todo-store.js'
import type { CoordinatorRun, DelegationCoordinator } from '../../agent/coordinator.js'
import { getWaveResults, clearWaveResults } from '../../agent/wave-results-store.js'
import { deriveTeamGroupId, loadCheckpoint } from '../../agent/wave-checkpoint.js'

// ── extractPlanPath ─────────────────────────────────────────────────

describe('extractPlanPath', () => {
  it('finds .rivet/knowledge path in objective', () => {
    const path = extractPlanPath('执行 .rivet/knowledge/foo.md 中的计划')
    assert.equal(path, '.rivet/knowledge/foo.md')
  })

  it('finds docs/superpowers/plans path in objective', () => {
    const path = extractPlanPath('参考 docs/superpowers/plans/my-plan.md 执行')
    assert.equal(path, 'docs/superpowers/plans/my-plan.md')
  })

  it('finds .rivet/plans path (approved-plan kickoff route)', () => {
    const path = extractPlanPath('开始执行已批准方案「X」(.rivet/plans/my-approved-plan.md)。')
    assert.equal(path, '.rivet/plans/my-approved-plan.md')
  })

  it('finds path in files array when objective has none', () => {
    const path = extractPlanPath('实现缓存预热', ['.rivet/knowledge/bar.md', 'src/foo.ts'])
    assert.equal(path, '.rivet/knowledge/bar.md')
  })

  it('returns null for plain objective without files', () => {
    assert.equal(extractPlanPath('实现缓存预热模块'), null)
  })

  it('returns null when files array has no plan paths', () => {
    assert.equal(extractPlanPath('refactor loop', ['src/agent/loop.ts', 'src/agent/loop.test.ts']), null)
  })
})

// ── parseChecklistItems ─────────────────────────────────────────────

describe('parseChecklistItems', () => {
  it('extracts unchecked items', () => {
    const md = '- [ ] add field to `src/foo.ts`\n- [x] already done\n- [ ] write test in `src/__tests__/foo.test.ts`'
    const items = parseChecklistItems(md)
    assert.equal(items.length, 2)
    assert.equal(items[0]!.text, 'add field to `src/foo.ts`')
    assert.deepEqual(items[0]!.files, ['src/foo.ts'])
    assert.equal(items[1]!.text, 'write test in `src/__tests__/foo.test.ts`')
  })

  it('skips checked items', () => {
    assert.equal(parseChecklistItems('- [x] done item').length, 0)
  })

  it('returns empty for no checklist', () => {
    assert.equal(parseChecklistItems('just text\nmore text').length, 0)
  })

  it('extracts multiple file refs from one item', () => {
    const md = '- [ ] update `src/a.ts` and test in `src/__tests__/a.test.ts`'
    const items = parseChecklistItems(md)
    assert.deepEqual(items[0]!.files, ['src/a.ts', 'src/__tests__/a.test.ts'])
  })

  it('matches non-ts file extensions (json, md, yml)', () => {
    const md = '- [ ] update `desktop/tauri.conf.json` and `docs/plan.md`'
    const items = parseChecklistItems(md)
    assert.deepEqual(items[0]!.files, ['desktop/tauri.conf.json', 'docs/plan.md'])
  })

  it('returns empty array for all-checked checklist', () => {
    const md = '- [x] add field\n- [x] write test\n- [x] run typecheck'
    assert.equal(parseChecklistItems(md).length, 0)
  })
})

// ── parseChecklistSections（章节感知切分，2026-07-26 用户指令）────────────

describe('parseChecklistSections', () => {
  const SECTIONED_MD = `## 分片与任务清单
### Shard A — web_fetch 批量（web-fetch/）
涉及文件：\`src/tools/web-fetch/tool.ts\`、\`src/tools/web-fetch/__tests__/tool.test.ts\`
- [ ] A1. tool.ts 的 input_schema 增加 urls 字段
- [ ] A2. execute 增加批量分支
### Shard B — lenient（tools/ 公共层）
涉及文件：\`src/tools/lenient.ts\`
- [ ] B1. 新建 lenient.ts
## 验证命令（无 checklist 的章节应被跳过）
\`\`\`bash
npx tsc --noEmit
\`\`\`
`

  it('章节结构计划 → 每章节一个分组（含其下 checklist 项 + 章节文件）', () => {
    const sections = parseChecklistSections(SECTIONED_MD)
    assert.equal(sections.length, 2, `期望 2 个章节级分组（Shard A/B），实际 ${sections.length}`)
    const a = sections.find(s => s.heading.includes('Shard A'))
    assert.ok(a, 'Shard A 章节存在')
    assert.equal(a!.items.length, 2, 'Shard A 的 checklist 项归入同一分组')
    assert.deepEqual(
      a!.files,
      ['src/tools/web-fetch/tool.ts', 'src/tools/web-fetch/__tests__/tool.test.ts'],
      '分组 files 继承章节涉及文件（标题/正文/项的反引号路径并集）',
    )
  })

  it('无 H2/H3 章节结构 → 返回空数组（调用方路由 decomposeObjective，不再逐项切）', () => {
    const flat = parseChecklistSections('- [ ] edit `src/a.ts`\n- [ ] edit `src/b.ts`')
    assert.equal(flat.length, 0, '平铺 checklist 不走逐项切分路径')
  })

  it('无 checklist 的章节（验证命令等）被跳过', () => {
    const sections = parseChecklistSections(SECTIONED_MD)
    assert.ok(!sections.some(s => s.heading.includes('验证命令')), '无 checklist 的章节不生成任务')
  })

  it('章节标题含反引号路径 → 并入分组 files', () => {
    const md = '### 重构 `src/agent/loop.ts`\n- [ ] 第一步\n- [ ] 第二步'
    const sections = parseChecklistSections(md)
    assert.equal(sections.length, 1)
    assert.ok(sections[0]!.files.includes('src/agent/loop.ts'), '标题中的反引号路径进入 files')
  })
})

// ── writeTodos injection (multi-session isolation) ──

describe('createPlanTaskTool writeTodos routing', () => {
  it('routes generated todos to the injected writeTodos, not the global defaultStore', async () => {
    setTodos([]) // 清空全局，证明 plan_task 不写全局
    const captured: TodoItem[][] = []
    const tool = createPlanTaskTool({
      getCoordinator: () => null,
      getExecutorDeps: () => ({} as any),
      writeTodos: todos => { captured.push(todos) },
    })

    const res = await tool.execute({
      input: { objective: '实现用户登录与商品列表两个模块', execute: false },
      toolUseId: 'p1',
      cwd: process.cwd(),
    } as any)

    assert.equal(res.isError ?? false, false)
    // 隔离的核心断言：全局 defaultStore 始终为空（写入只去了注入 store）。
    assert.deepEqual(getTodos(), [])
    // 若计划产出了叶子节点，则它们经 writeTodos 落到注入 store。
    if (captured.length > 0) {
      assert.ok(captured[0]!.length > 0)
    }
  })
})

// ── timeoutMs (T2 regression guard) ──

describe('timeoutMs', () => {
  it('execute:true → 600s (aligns with team_orchestrate)', () => {
    const tool = createPlanTaskTool({
      getCoordinator: () => null,
      getExecutorDeps: () => ({} as any),
    })
    assert.equal(typeof tool.timeoutMs, 'function')
    assert.equal(tool.timeoutMs!({ input: { execute: true } } as any), 600_000)
  })

  it('execute:false → 120s (tool default)', () => {
    const tool = createPlanTaskTool({
      getCoordinator: () => null,
      getExecutorDeps: () => ({} as any),
    })
    assert.equal(tool.timeoutMs!({ input: { execute: false } } as any), 120_000)
  })

  it('no execute param → 120s (default)', () => {
    const tool = createPlanTaskTool({
      getCoordinator: () => null,
      getExecutorDeps: () => ({} as any),
    })
    assert.equal(tool.timeoutMs!({ input: {} } as any), 120_000)
  })
})

// ── Integration: parse real plan file ──

describe('integration: parse real plan file', () => {
  it('parses tianshu-omp plan checklist into items with file paths', async (t) => {
    const { readFile } = await import('node:fs/promises')
    const { existsSync } = await import('node:fs')
    const fixture = '.rivet/knowledge/tianshu-omp-convergence-precision-backport.md'
    // fixture 在公开仓同步树缺失（.rivet/knowledge/ 整目录忽略）——不是回归。
    if (!existsSync(fixture)) return t.skip(`${fixture} not in this tree`)
    const content = await readFile(fixture, 'utf-8')
    const items = parseChecklistItems(content)
    // The updated plan has ~12+ checklist items
    assert.ok(items.length >= 8, `expected at least 8 checklist items, got ${items.length}`)
    // Verify key items are captured
    const texts = items.map(i => i.text)
    assert.ok(texts.some(t => t.includes('argsHash')), 'should capture argsHash item')
    assert.ok(texts.some(t => t.includes('oscillation')), 'should capture oscillation item')
    assert.ok(texts.some(t => t.includes('outputTokens')), 'should capture outputTokens item')
  })
})

// ── execute:true 多波驱动（Wave 3A wiring）──────────────────────────────
// plan_task 用共享 executePlanWaves 从 wave 0 自动推进所有可推进波次，而不是
// 只跑 wave 0（旧行为）。三个断言面：多波完整执行、中间波不触发 review、
// 末波结果聚合。

describe('createPlanTaskTool execute:true multi-wave driver', () => {
  // 两个章节任务改同一文件 → groupTeamTasks 同文件写串行 → 2 波。
  // 章节感知切分（2026-07-26 用户指令）下每章节一个任务；同文件仍串行。
  const PLAN_MD = [
    '### Wave 1',
    '- [ ] First edit in `src/a.ts`',
    '### Wave 2',
    '- [ ] Second edit in `src/a.ts`',
  ].join('\n')

  function mkRun(workOrderId: string, packet: string, changedFiles: string[] = []): CoordinatorRun {
    return {
      status: 'completed',
      results: [{
        workOrderId,
        status: 'passed',
        summary: 's',
        findings: [],
        artifacts: [],
        changedFiles,
        risks: [],
        nextActions: [],
        evidenceStatus: 'verified',
      }],
      packet,
    }
  }

  // 写一份 2-item checklist 计划文件到 .rivet/plans/（plan_task 快速路径读取，
  // 路径相对 CWD=仓库根）。唯一文件名避免并发会话/重复运行冲突，测试结束清理。
  function writeWavePlan(): string {
    mkdirSync('.rivet/plans', { recursive: true })
    const name = `.rivet/plans/waves-${process.pid}-${Date.now()}.md`
    writeFileSync(name, PLAN_MD, 'utf-8')
    return name
  }

  it('execute:true 多波完整执行：两波都派发、末波结果聚合返回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-task-waves-'))
    const sessionId = `plan-waves-${Date.now()}`
    const planPath = writeWavePlan()
    const objective = `执行 ${planPath} 计划`
    const batches: Array<{ n: number; packet: string }> = []
    try {
      const tool = createPlanTaskTool({
        getCoordinator: () => ({}) as unknown as DelegationCoordinator,
        getExecutorDeps: () => ({
          delegateBatch: async (requests: Array<{ parentTurnId: string }>) => {
            const wave = batches.length
            batches.push({ n: requests.length, packet: `plan-wave${wave}` })
            return mkRun(`team:P${wave + 1}`, `plan-wave${wave}`)
          },
        }) as any,
      })
      const result = await tool.execute({
        input: { objective, execute: true },
        cwd: dir,
        toolUseId: 'pt-waves',
        sessionId,
      } as any)

      assert.notEqual(result.isError, true, String(result.content))
      // 两波都派发（旧行为只派发 wave 0 → 此处会红）。
      assert.equal(batches.length, 2, 'executePlanWaves 自动推进两波')
      assert.deepEqual(batches.map(b => b.n), [1, 1], '每波一个同文件串行 worker')
      // 末波结果聚合：返回的 run 是聚合视图——packet 取最后一波。
      assert.match(String(result.content), /plan-wave1/, '聚合 packet 取末波')
      assert.doesNotMatch(String(result.content), /plan-wave0/, '中间波 packet 不单独出现在聚合视图')
      // 每波结果独立持久化：store 每波覆盖，末波后是最后一波结果。
      const stored = getWaveResults(sessionId)
      assert.equal(stored?.length, 1)
      assert.equal(stored?.[0]?.workOrderId, 'team:P2', 'wave results store 覆盖为末波结果')
      // 末波全过后 checkpoint 清除（只有走到末波才会清）——证明驱动走到了最后。
      assert.equal(loadCheckpoint(dir, deriveTeamGroupId(objective)), null, '两波全过后 checkpoint 清除')
    } finally {
      clearWaveResults(sessionId)
      rmSync(planPath, { force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('中间波不触发 review：无 delegate 的 deps 下两波仍跑完（reviewGate:false 保持）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-task-noreview-'))
    const sessionId = `plan-noreview-${Date.now()}`
    const planPath = writeWavePlan()
    const objective = `执行 ${planPath} 计划`
    const prevGate = process.env.RIVET_WAVE_GATE
    process.env.RIVET_WAVE_GATE = '0'
    let batchCalls = 0
    try {
      const tool = createPlanTaskTool({
        getCoordinator: () => ({}) as unknown as DelegationCoordinator,
        // 故意不提供 deps.delegate：若 review 被触发（reviewGate 误开，或中间波
        // 被当末波提前 review），requireDelegate 抛错 → executePlanWaves 异常
        // 上抛 → 工具返回 isError。两波结果带 changedFiles 让 review 触发条件
        // （changedFiles>0）成立，证明「有候选也不审」。
        getExecutorDeps: () => ({
          delegateBatch: async () => {
            batchCalls++
            return mkRun('team:P1', 'no-review', ['src/a.ts'])
          },
        }) as any,
      })
      const result = await tool.execute({
        input: { objective, execute: true },
        cwd: dir,
        toolUseId: 'pt-noreview',
        sessionId,
      } as any)

      assert.notEqual(result.isError, true, String(result.content))
      assert.equal(batchCalls, 2, '两波都执行完 = review 从未被派发')
      const stored = getWaveResults(sessionId)
      assert.ok(stored && stored.length === 1, '两波跑完，store 保留末波结果')
    } finally {
      if (prevGate === undefined) delete process.env.RIVET_WAVE_GATE
      else process.env.RIVET_WAVE_GATE = prevGate
      clearWaveResults(sessionId)
      rmSync(planPath, { force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── Integration: 章节感知切分（2026-07-26 用户指令：按章节 wave 切）──────

describe('integration: sectioned plan via plan_task', () => {
  it('章节计划 execute:false → 任务数 = 章节数（不再逐项切碎片）', async () => {
    mkdirSync('.rivet/plans', { recursive: true })
    const name = `.rivet/plans/sections-${process.pid}-${Date.now()}.md`
    writeFileSync(name, [
      '### Shard A',
      '- [ ] edit `src/a.ts`',
      '- [ ] edit `src/a.ts`',
      '### Shard B',
      '- [ ] edit `src/b.ts`',
    ].join('\n'), 'utf-8')
    try {
      const tool = createPlanTaskTool({
        getCoordinator: () => null,
        getExecutorDeps: () => ({} as any),
      })
      const res = await tool.execute({
        input: { objective: `执行 ${name} 计划`, execute: false },
        toolUseId: 'pt-sec',
        cwd: process.cwd(),
      } as any)

      assert.notEqual(res.isError, true, String(res.content))
      // Shard A 的 2 个 checklist 项合并为 1 个任务 → 共 2 个任务（P1/P2），无 P3
      assert.match(String(res.content), /"id":\s*"P1"/, '任务 P1 存在')
      assert.match(String(res.content), /"id":\s*"P2"/, '任务 P2 存在')
      assert.doesNotMatch(String(res.content), /"id":\s*"P3"/, '无逐项碎片任务（2 项同章节不拆开）')
      // P1 的 files 继承章节文件集合
      assert.match(String(res.content), /"files":\s*\[\s*"src\/a\.ts"/, 'P1 files 继承章节文件')
    } finally {
      rmSync(name, { force: true })
    }
  })
})
