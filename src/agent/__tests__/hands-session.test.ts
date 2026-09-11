import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { runHandsSession, type HandsSessionConfig } from '../hands-session.js'
import { WorktreeCoordinator } from '../worktree-coordinator.js'
import { createWriteWorkOrder, parseWorkerResult, type WorkOrder } from '../work-order.js'

// These tests cover worktree lifecycle / diff collection, not the W4-D1 write
// gate (temp repos have no tsconfig — the real gate would block on tsc).
// Gate behavior is covered in hands-session-write-gate.test.ts.
process.env.RIVET_WORKER_WRITE_GATE = '0'

function initGitRepo(dir: string, branch = 'main'): void {
  execSync(`git init -b ${branch}`, { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  writeFileSync(join(dir, 'README.md'), '# test\n')
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' })
}

/** Build a minimal write work order for testing. */
function testOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return createWriteWorkOrder({
    parentTurnId: 'turn-1',
    kind: 'patch_proposal',
    profile: 'patcher',
    objective: 'Write a test file',
    scope: { files: ['src/output.ts'] },
    ...overrides,
  })
}

describe('runHandsSession', () => {
  let baseDir: string
  let wtCoordinator: WorktreeCoordinator

  before(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'rivet-hands-base-'))
    initGitRepo(baseDir)
    wtCoordinator = new WorktreeCoordinator(baseDir)
  })

  after(async () => {
    await wtCoordinator.cleanupAll()
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('creates worktree, runs worker, collects diff artifact on completion', async () => {
    const order = testOrder()
    const config: HandsSessionConfig = {
      order,
      wtCoordinator,
      cwd: baseDir,
      maxTurns: 2,
      contextWindow: 128_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      runAgent: async (prompt, _callbacks, workerCwd) => {
        assert.equal(order.workerCwd, workerCwd)
        assert.ok(prompt.includes(`CWD：${workerCwd}`), prompt)
        // Simulate worker writing a file in the worktree it was asked to use
        assert.notEqual(workerCwd, baseDir)
        mkdirSync(join(workerCwd, 'src'), { recursive: true })
        writeFileSync(join(workerCwd, 'src', 'output.ts'), 'export const hello = 1\n')
        execSync('git add -A && git commit -m "worker output"', {
          cwd: workerCwd, stdio: 'pipe',
        })
        return JSON.stringify({
          workOrderId: order.id,
          status: 'passed',
          summary: 'Created src/output.ts',
          findings: [{ claim: 'Created output file', evidence: 'src/output.ts written', confidence: 'high' }],
          artifacts: [],
          changedFiles: ['src/output.ts'],
          risks: [],
          nextActions: [],
          evidenceStatus: 'verified',
        })
      },
    }

    const run = await runHandsSession(config)
    assert.equal(run.result.status, 'passed')
    assert.ok(run.result.changedFiles.includes('src/output.ts'), `changedFiles should include output.ts, got: ${run.result.changedFiles}`)

    // Should have collected a diff artifact
    const diffArtifact = run.result.artifacts.find(a => a.kind === 'diff')
    assert.ok(diffArtifact, `must include a diff artifact, artifacts: ${JSON.stringify(run.result.artifacts.map(a => a.kind))}`)
    assert.ok(diffArtifact!.content.includes('output.ts'), `diff should mention output.ts: ${diffArtifact!.content.slice(0, 300)}`)

    // Worktree should be cleaned up
    assert.equal(wtCoordinator.getActiveCount(), 0)
  })

  it('persists diff via artifactStore and backfills diffArtifactId', async () => {
    const order = testOrder({ id: 'wo-persist-diff' })
    // Mock artifactStore: record saves, return a synthetic id.
    const saved: Array<{ tool: string; target: string; rawContent: string }> = []
    const artifactStore = {
      async save(input: { tool: string; target: string; rawContent: string; summary: string }) {
        saved.push(input)
        return `hands_session:persisted123`
      },
    }
    const config: HandsSessionConfig = {
      order,
      wtCoordinator,
      cwd: baseDir,
      maxTurns: 2,
      contextWindow: 128_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      artifactStore,
      runAgent: async (_prompt, _callbacks, workerCwd) => {
        mkdirSync(join(workerCwd, 'src'), { recursive: true })
        writeFileSync(join(workerCwd, 'src', 'mod.ts'), 'export const x = 2\n')
        execSync('git add -A && git commit -m "worker mod"', { cwd: workerCwd, stdio: 'pipe' })
        return JSON.stringify({
          workOrderId: order.id,
          status: 'passed',
          summary: 'Created mod.ts',
          findings: [],
          artifacts: [],
          changedFiles: ['src/mod.ts'],
          risks: [],
          nextActions: [],
          evidenceStatus: 'verified',
        })
      },
    }

    const run = await runHandsSession(config)
    // diffArtifactId backfilled from the store save result
    assert.equal(run.result.diffArtifactId, 'hands_session:persisted123')
    // store.save was called once with the worker order id as target + diff content
    assert.equal(saved.length, 1)
    assert.equal(saved[0]!.tool, 'hands_session')
    assert.equal(saved[0]!.target, order.id)
    assert.ok(saved[0]!.rawContent.includes('mod.ts'), 'persisted diff should mention the changed file')
  })

  it('degrades gracefully when artifactStore save throws (diffArtifactId undefined)', async () => {
    const order = testOrder({ id: 'wo-persist-fail' })
    const artifactStore = {
      async save() { throw new Error('disk full') },
    }
    const config: HandsSessionConfig = {
      order,
      wtCoordinator,
      cwd: baseDir,
      maxTurns: 2,
      contextWindow: 128_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      artifactStore,
      runAgent: async (_prompt, _callbacks, workerCwd) => {
        mkdirSync(join(workerCwd, 'src'), { recursive: true })
        writeFileSync(join(workerCwd, 'src', 'fail.ts'), 'export const y = 3\n')
        execSync('git add -A && git commit -m "worker fail"', { cwd: workerCwd, stdio: 'pipe' })
        return JSON.stringify({
          workOrderId: order.id, status: 'passed', summary: 'ok', findings: [], artifacts: [],
          changedFiles: ['src/fail.ts'], risks: [], nextActions: [], evidenceStatus: 'verified',
        })
      },
    }

    const run = await runHandsSession(config)
    // 落盘失败不致命：diffArtifactId 未设，但 diff 仍在 artifacts 里
    assert.equal(run.result.diffArtifactId, undefined)
    assert.ok(run.result.artifacts.find(a => a.kind === 'diff'), 'diff still in artifacts as fallback')
  })

  it('runs in-place (no worktree) when git is unavailable — no-git graceful degradation', async () => {
    // Non-git temp dir: createWorktree will throw. hands-session must fall back
    // to running in-place and still complete the task (parity with Claude Code /
    // Codex, which don't require git).
    const nonGitDir = mkdtempSync(join(tmpdir(), 'rivet-nogit-'))
    // A wtCoordinator whose create() always throws, simulating no-git env without
    // needing to actually invoke git on a non-repo.
    const throwingWtCoordinator = {
      create() { throw new Error('failed to create git worktree') },
      remove() {},
      cleanupAll() {},
      getActiveCount() { return 0 },
    } as unknown as WorktreeCoordinator

    try {
      mkdirSync(join(nonGitDir, 'src'), { recursive: true })
      writeFileSync(join(nonGitDir, 'src', 'output.ts'), 'export const x = 1\n')

      const order = testOrder({ id: 'wo-nogit' })
      const config: HandsSessionConfig = {
        order,
        wtCoordinator: throwingWtCoordinator,
        cwd: nonGitDir,
        maxTurns: 2,
        contextWindow: 128_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        runAgent: async (_prompt, _callbacks, workerCwd) => {
          // Should be running in-place: workerCwd === cwd (nonGitDir)
          assert.equal(workerCwd, nonGitDir, 'worker must run in-place when worktree unavailable')
          writeFileSync(join(workerCwd, 'src', 'output.ts'), 'export const x = 2\n')
          return JSON.stringify({
            workOrderId: order.id, status: 'passed', summary: 'updated output.ts',
            findings: [], artifacts: [], changedFiles: ['src/output.ts'],
            risks: [], nextActions: [], evidenceStatus: 'unverified',
          })
        },
      }

      const run = await runHandsSession(config)
      assert.equal(run.result.status, 'passed', 'no-git worker must complete, not fail')
      assert.equal(run.result.summary, 'updated output.ts')
      // File was written in-place
      assert.equal(readFileSync(join(nonGitDir, 'src', 'output.ts'), 'utf8'), 'export const x = 2\n')
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true })
    }
  })

  it('diffs worker changes against the current feature branch when baseRef is not provided', async () => {
    const featureBaseDir = mkdtempSync(join(tmpdir(), 'rivet-hands-feature-base-'))
    initGitRepo(featureBaseDir, 'feature/base')
    const featureCoordinator = new WorktreeCoordinator(featureBaseDir)
    try {
      const order = testOrder({ id: 'wo-feature-base' })
      const config: HandsSessionConfig = {
        order,
        wtCoordinator: featureCoordinator,
        cwd: featureBaseDir,
        maxTurns: 2,
        contextWindow: 128_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        runAgent: async (_prompt, _callbacks, workerCwd) => {
          mkdirSync(join(workerCwd, 'src'), { recursive: true })
          writeFileSync(join(workerCwd, 'src', 'output.ts'), 'export const fromFeature = true\n')
          execSync('git add -A && git commit -m "worker output"', { cwd: workerCwd, stdio: 'pipe' })
          return JSON.stringify({
            workOrderId: order.id,
            status: 'passed',
            summary: 'Created src/output.ts',
            findings: [],
            artifacts: [],
            changedFiles: ['src/output.ts'],
            risks: [],
            nextActions: [],
            evidenceStatus: 'verified',
          })
        },
      }

      const run = await runHandsSession(config)
      const diffArtifact = run.result.artifacts.find(a => a.kind === 'diff')
      assert.ok(diffArtifact, 'must collect diff against feature/base instead of hard-coded main')
      assert.ok(diffArtifact!.content.includes('fromFeature'), diffArtifact!.content)
    } finally {
      await featureCoordinator.cleanupAll()
      rmSync(featureBaseDir, { recursive: true, force: true })
    }
  })

  it('cleans up worktree even on worker failure', async () => {
    const order = testOrder({ id: 'wo-fail' })
    const config: HandsSessionConfig = {
      order,
      wtCoordinator,
      cwd: baseDir,
      maxTurns: 1,
      contextWindow: 128_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      runAgent: async () => {
        throw new Error('Worker crashed')
      },
    }

    await assert.rejects(
      () => runHandsSession(config),
      /Worker crashed/,
    )
    // Worktree must still be cleaned up
    assert.equal(wtCoordinator.getActiveCount(), 0, 'worktree must be cleaned up even on failure')
  })

  it('handles worker returning blocked status (schema repair failure)', async () => {
    const order = testOrder({ id: 'wo-blocked' })
    const config: HandsSessionConfig = {
      order,
      wtCoordinator,
      cwd: baseDir,
      maxTurns: 1,
      contextWindow: 128_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      runAgent: async () => {
        return 'not valid json {{{'
      },
    }

    const run = await runHandsSession(config)
    // Should be blocked due to unparseable result
    assert.equal(run.result.status, 'blocked')
    assert.equal(wtCoordinator.getActiveCount(), 0)
  })
})

describe('runHandsSession — shared-worktree mode', () => {
  let baseDir: string

  before(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'rivet-hands-shared-'))
    initGitRepo(baseDir)
  })

  after(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('runs directly in the shared cwd and never creates a per-worker worktree', async () => {
    // wtCoordinator.create must NOT be called in shared mode — throw if it is.
    const forbiddenWtCoordinator = {
      create() { throw new Error('per-worker worktree must NOT be created in shared mode') },
      remove() {},
      cleanupAll() {},
      getActiveCount() { return 0 },
    } as unknown as WorktreeCoordinator

    const order = testOrder({ id: 'wo-shared-1' })
    const config: HandsSessionConfig = {
      order,
      wtCoordinator: forbiddenWtCoordinator,
      cwd: baseDir,
      sharedWorkspace: true,
      maxTurns: 2,
      contextWindow: 128_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      runAgent: async (_prompt, _callbacks, workerCwd) => {
        // Worker runs in the controller's shared cwd, not an isolated worktree.
        assert.equal(workerCwd, baseDir, 'shared mode must run in the shared cwd')
        writeFileSync(join(workerCwd, 'shared-out.ts'), 'export const a = 1\n')
        return JSON.stringify({
          workOrderId: order.id, status: 'passed', summary: 'wrote shared-out.ts',
          findings: [], artifacts: [], changedFiles: ['shared-out.ts'],
          risks: [], nextActions: [], evidenceStatus: 'verified',
        })
      },
    }

    const run = await runHandsSession(config)
    assert.equal(run.result.status, 'passed')
    // No per-worker isolated diff is collected in shared mode.
    assert.ok(!run.result.artifacts.some(a => a.kind === 'diff'), 'shared mode collects no per-worker diff')
    assert.equal(readFileSync(join(baseDir, 'shared-out.ts'), 'utf8'), 'export const a = 1\n')
  })

  it('parallel shards writing disjoint files in the shared cwd do not stomp each other', async () => {
    mkdirSync(join(baseDir, 'src'), { recursive: true })
    // src/ scope paths aren't materialize-checked, so the worker creates them fresh.
    const mkConfig = (id: string, file: string, body: string): HandsSessionConfig => ({
      order: testOrder({ id, scope: { files: [file] } }),
      wtCoordinator: { create() { throw new Error('no worktree') }, remove() {}, cleanupAll() {}, getActiveCount() { return 0 } } as unknown as WorktreeCoordinator,
      cwd: baseDir,
      sharedWorkspace: true,
      maxTurns: 2,
      contextWindow: 128_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      runAgent: async (_prompt, _callbacks, workerCwd) => {
        writeFileSync(join(workerCwd, file), body)
        return JSON.stringify({
          workOrderId: id, status: 'passed', summary: `wrote ${file}`,
          findings: [], artifacts: [], changedFiles: [file],
          risks: [], nextActions: [], evidenceStatus: 'verified',
        })
      },
    })

    // Two orthogonal shards writing different files concurrently.
    const [runA, runB] = await Promise.all([
      runHandsSession(mkConfig('wo-par-a', 'src/mod-a.ts', 'export const A = 1\n')),
      runHandsSession(mkConfig('wo-par-b', 'src/mod-b.ts', 'export const B = 2\n')),
    ])

    assert.equal(runA.result.status, 'passed')
    assert.equal(runB.result.status, 'passed')
    // Both files landed in the single shared workspace — no stomping.
    assert.equal(readFileSync(join(baseDir, 'src', 'mod-a.ts'), 'utf8'), 'export const A = 1\n')
    assert.equal(readFileSync(join(baseDir, 'src', 'mod-b.ts'), 'utf8'), 'export const B = 2\n')
  })
})


describe('runHandsSession — isolated 策略 fail-closed', () => {
  let baseDir: string

  before(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'rivet-hands-iso-'))
    initGitRepo(baseDir)
  })

  after(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('建树失败时 abstain：不运行 worker、不写主工作树、显式上报', async () => {
    // isolated 策略（decideWorkspaceIsolation → sharedWorkspace: false）下，
    // 建树失败 = 无法在不污染主工作树的前提下执行。fail-open 到 in-place 会让
    // 审查/补丁 worker 静默写进用户的工作树（设计稿 §2.3 失效点、§7 L2）。
    const wtCoordinator = {
      create() { throw new Error('git worktrees unavailable (simulated .git/worktrees lock)') },
      remove() {},
      cleanupAll() {},
      getActiveCount() { return 0 },
    } as unknown as WorktreeCoordinator

    const order = testOrder({ id: 'wo-iso-fail' })
    let workerRan = false
    const config: HandsSessionConfig = {
      order,
      wtCoordinator,
      cwd: baseDir,
      sharedWorkspace: false,
      maxTurns: 2,
      contextWindow: 128_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      runAgent: async (_prompt, _callbacks, workerCwd) => {
        workerRan = true
        writeFileSync(join(workerCwd, 'leaked.ts'), 'export const leaked = 1\n')
        return JSON.stringify({
          workOrderId: order.id, status: 'passed', summary: 'wrote leaked.ts',
          findings: [], artifacts: [], changedFiles: ['leaked.ts'],
          risks: [], nextActions: [], evidenceStatus: 'verified',
        })
      },
    }

    const run = await runHandsSession(config)

    // I1：审查/补丁类 worker 运行期间主工作树完全不可变
    assert.equal(workerRan, false, 'isolated 建树失败时不得运行 worker（fail-closed）')
    assert.equal(existsSync(join(baseDir, 'leaked.ts')), false, '主工作树必须不可变')
    // L2：显式上报 infra 失败，而不是静默降级
    assert.equal(run.result.status, 'blocked')
    assert.match(run.result.summary, /worktree|isolation/i)
  })
})
