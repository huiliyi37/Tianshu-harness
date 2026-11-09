import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasOverlappingFiles,
  parseTeamTaskDrafts,
  parseTeamTasks,
  buildUnifiedTeamPlan,
  type TeamTaskDraft,
  type TeamTask,
} from '../team-plan.js'

describe('parseTeamTaskDrafts', () => {
  it('parses loop-split style Step sections', () => {
    const tasks = parseTeamTaskDrafts(`
### 推荐的提取顺序

**Step 6a: \`initializeRun()\`（~103 行）**
- 修改：\`src/agent/loop.ts\`
- 测试：npm exec -- tsx --test src/agent/__tests__/loop.test.ts

**Step 6b: \`runCompaction(turn, compactFailures)\`（~80 行）**
- 修改：src/agent/compaction-controller.ts
- 验证：npx tsc --noEmit
`)

    assert.equal(tasks.length, 2)
    assert.equal(tasks[0]!.id, 'Step 6a')
    assert.match(tasks[0]!.title, /initializeRun/)
    assert.deepEqual(tasks[0]!.files, ['src/agent/loop.ts', 'src/agent/__tests__/loop.test.ts'])
    // Implementation tasks are ALWAYS patcher, even when body mentions tests
    assert.equal(tasks[0]!.profile, 'patcher')
    assert.equal(tasks[0]!.kind, 'patch_proposal')
    // Verification commands are captured separately
    assert.ok(tasks[0]!.verification.some(line => line.includes('npm exec')))
    assert.equal(tasks[1]!.id, 'Step 6b')
    assert.deepEqual(tasks[1]!.files, ['src/agent/compaction-controller.ts'])
    assert.equal(tasks[1]!.profile, 'patcher')
  })

  it('classifies review and verification tasks by title', () => {
    const tasks = parseTeamTaskDrafts(`
### Task 1: 实现 parser
修改 src/agent/team-plan.ts
验证：npx tsc --noEmit

### Task 2: Review Squadron 审查
审查 src/agent/team-plan.ts

### Task 3: 验证
验证所有变更
`)

    // Implementation task with verification in body → still patcher
    assert.equal(tasks[0]!.profile, 'patcher')
    assert.equal(tasks[0]!.kind, 'patch_proposal')
    assert.ok(tasks[0]!.verification.some(v => v.includes('npx tsc')))

    // Title contains "审查" → reviewer
    assert.equal(tasks[1]!.profile, 'reviewer')
    assert.equal(tasks[1]!.kind, 'review')

    // Title is purely "验证" → adversarial_verifier
    assert.equal(tasks[2]!.profile, 'adversarial_verifier')
    assert.equal(tasks[2]!.kind, 'verify')
  })

  it('does not reclassify implementation tasks that mention tests in body', () => {
    const tasks = parseTeamTaskDrafts(`
### T1: Extract loop helper
修改 src/agent/loop.ts
运行测试：npm exec -- tsx --test src/agent/__tests__/loop.test.ts
`)

    assert.equal(tasks[0]!.profile, 'patcher')
    assert.equal(tasks[0]!.kind, 'patch_proposal')
    assert.ok(tasks[0]!.verification.length > 0, 'verification commands captured')
  })

  it('returns empty list for documents without task headings', () => {
    assert.deepEqual(parseTeamTaskDrafts('# Design only\nNo tasks yet.'), [])
  })

  it('detects overlapping file scopes', () => {
    const [a, b, c] = parseTeamTaskDrafts(`
### T1: edit A
修改 src/a.ts
### T2: edit A again
修改 src/a.ts
### T3: edit B
修改 src/b.ts
`)

    assert.equal(hasOverlappingFiles(a!, b!), true)
    assert.equal(hasOverlappingFiles(a!, c!), false)
  })
})

describe('parseTeamTasks', () => {
  it('enriches drafts with dependencies and risk tier', () => {
    const tasks = parseTeamTasks(`
### T1: Setup auth schema
修改 src/config/schema.ts
depends on: none

### T2: Implement login
修改 src/auth/login.ts
depends: T1
`)

    assert.equal(tasks.length, 2)
    assert.equal(tasks[0]!.id, 'T1')
    assert.equal(tasks[0]!.riskTier, 'high')
    assert.deepEqual(tasks[0]!.dependsOn, [])
    assert.deepEqual(tasks[0]!.touchSet, ['src/config/schema.ts'])

    assert.equal(tasks[1]!.id, 'T2')
    assert.equal(tasks[1]!.riskTier, 'high') // auth/login triggers high risk
    assert.deepEqual(tasks[1]!.dependsOn, ['T1'])
    assert.deepEqual(tasks[1]!.touchSet, ['src/auth/login.ts'])
  })

  it('extracts dependencies from Chinese and English patterns', () => {
    const tasks = parseTeamTasks(`
### T1: Base
修改 src/base.ts

### T2: Build on T1
修改 src/next.ts
依赖 T1

### T3: Build on T1 and T2
修改 src/final.ts
depends on: T1, T2
`)

    assert.deepEqual(tasks[0]!.dependsOn, [])
    assert.deepEqual(tasks[1]!.dependsOn, ['T1'])
    assert.deepEqual(tasks[2]!.dependsOn, ['T1', 'T2'])
  })

  it('classifies medium risk for refactor tasks', () => {
    const tasks = parseTeamTasks(`
### T1: Refactor loop
Refactor src/agent/loop.ts
`)

    assert.equal(tasks[0]!.riskTier, 'medium')
  })

  it('returns empty array for no-task documents', () => {
    assert.deepEqual(parseTeamTasks('Just a plan, no tasks.\n## Introduction'), [])
  })
})

describe('buildUnifiedTeamPlan', () => {
  it('builds a plan with verification gates and risks from tasks', () => {
    const tasks = parseTeamTasks(`
### T1: Security fix
修改 src/auth.ts
验证：npx tsc --noEmit

### T2: Add tests
修改 src/__tests__/auth.test.ts
`)
    const plan = buildUnifiedTeamPlan('Fix auth', 'standard', tasks, {
      nonGoals: ['TUI panel'],
    })

    assert.equal(plan.mission, 'Fix auth')
    assert.equal(plan.mode, 'standard')
    assert.equal(plan.tasks.length, 2)
    assert.equal(plan.nonGoals.length, 1)
    assert.equal(plan.nonGoals[0], 'TUI panel')

    // T1 is high risk (auth in title/file), T2 also contains auth in path
    assert.equal(plan.risks.length, 2)
    assert.equal(plan.risks[0]!.severity, 'high')
    assert.equal(plan.risks[1]!.severity, 'high')

    // Verification gate from T1
    assert.equal(plan.verification.length, 1)
    assert.equal(plan.verification[0]!.taskId, 'T1')
    assert.ok(plan.verification[0]!.command.includes('npx tsc'))

    // Groups and decisions start empty
    assert.deepEqual(plan.groups, [])
    assert.deepEqual(plan.decisions, [])
  })
})

describe('extractFiles — malformed input hardening', () => {
  it('splits backtick-wrapped multi-paths instead of one malformed entry', () => {
    // Regression: `src/a.ts, src/b.ts` used to be captured whole, producing a
    // bogus file "src/a.ts, src/b.ts" that defeated file-overlap serialization.
    const drafts = parseTeamTaskDrafts('## T1: change `src/foo.ts, src/bar.ts` together')
    assert.deepEqual(drafts[0]!.files, ['src/foo.ts', 'src/bar.ts'])
  })

  it('keeps bare paths clean and strips trailing punctuation', () => {
    const drafts = parseTeamTaskDrafts('## T1: edit src/foo.ts, then src/bar.ts.')
    assert.deepEqual(drafts[0]!.files, ['src/foo.ts', 'src/bar.ts'])
  })
})

describe('extractVerification — prose vs command', () => {
  it('does NOT collect bare prose mentions of 测试/验证', () => {
    // Regression: 测试/验证 had no word boundary, so narrative sentences became
    // fake VerificationGates with non-runnable commands.
    const drafts = parseTeamTaskDrafts('## T1: 实现登录\n需要测试整个流程的鲁棒性')
    assert.deepEqual(drafts[0]!.verification, [])
  })

  it('still collects real command lines and backtick code spans', () => {
    const drafts = parseTeamTaskDrafts('## T1: 实现\n运行 npm test\n跑一下 `tsc --noEmit`')
    assert.equal(drafts[0]!.verification.length, 2)
    assert.ok(drafts[0]!.verification.some(v => v.includes('npm test')))
    assert.ok(drafts[0]!.verification.some(v => v.includes('tsc --noEmit')))
  })

  it('parses conditional dependency edges（收编 #6 语法）', () => {
    const tasks = parseTeamTasks(`
### T1: 重构
Refactor src/agent/loop.ts
### T2: 测试
测试覆盖 src/agent/loop.ts
依赖 T1(onFailure:skip)
### T3: 文档
更新 docs
依赖 T1(onFailure:alternate:T2)
### T4: 独立
独立任务
`)
    assert.equal(tasks.length, 4)
    assert.deepEqual(tasks[0]!.dependsOn, [])
    // skip 边 → 对象
    assert.deepEqual(tasks[1]!.dependsOn, [{ dependsOn: 'T1', onFailure: 'skip' }])
    // alternate 边 → 对象（含 alternateOrderId）
    assert.deepEqual(tasks[2]!.dependsOn, [{ dependsOn: 'T1', onFailure: 'alternate', alternateOrderId: 'T2' }])
    // 纯字符串保持向后兼容
    assert.deepEqual(tasks[3]!.dependsOn, [])
  })

  it('mixes plain and conditional deps in one line（收编 #6 兼容）', () => {
    const tasks = parseTeamTasks(`
### T1: 基础
Base task
### T2: 依赖
依赖 T1, T3(onFailure:skip)
### T3: 备选
Alternate task
`)
    const t2 = tasks.find(t => t.id === 'T2')!
    assert.deepEqual(t2.dependsOn, ['T1', { dependsOn: 'T3', onFailure: 'skip' }])
  })

  it('filters out Chinese placeholder dependencies like 无, 无依赖, - (issue #562)', () => {
    const tasks = parseTeamTasks(`
### T1: add mul to a
- 文件: a.py, tests/test_a.py
- 依赖: 无
- 验收: python3 -m pytest tests/test_a.py -q

### T2: add slugify to b
- 文件: b.py, tests/test_b.py
- 依赖: -
- 验收: python3 -m pytest tests/test_b.py -q
`)
    assert.equal(tasks.length, 2)
    assert.deepEqual(tasks[0]!.dependsOn, [])
    assert.deepEqual(tasks[1]!.dependsOn, [])
  })

  it('captures root-level files and explicit 文件/files lines (issue #562)', () => {
    const drafts = parseTeamTaskDrafts(`
### T1: add mul to a
- 文件: a.py, tests/test_a.py
- 验收: python3 -m pytest tests/test_a.py -q

### T2: modify main with backtick \`calc.py\`
- touch: \`main.go\`
`)
    assert.equal(drafts.length, 2)
    assert.deepEqual(drafts[0]!.files, ['a.py', 'tests/test_a.py'])
    assert.ok(drafts[1]!.files.includes('calc.py'))
    assert.ok(drafts[1]!.files.includes('main.go'))
  })
})
