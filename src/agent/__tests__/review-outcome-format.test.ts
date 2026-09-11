import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatReviewOutcomeLines } from '../deliver-task.js'
import type { ReviewOutcome } from '../review-router.js'

// 补丁工产物披露（I2）：隔离模式下补丁工的改动在它自己的 worktree 内，不在主控
// 工作树里——两个 verdict 分支都必须披露，否则「验证通过」会被读成「修复已落地」。

describe('formatReviewOutcomeLines — 补丁工产物披露', () => {
  it('rejected 且带补丁产物：披露文件、摘要，并声明未落入工作树', () => {
    const outcome: ReviewOutcome = {
      tier: 'L2',
      verdict: 'rejected',
      escalated: true,
      evidence: 'counterexample: x',
      patcherArtifacts: [
        { round: 1, changedFiles: ['package.json'], patchSummary: '补了 scripts.test' },
      ],
    }
    const text = formatReviewOutcomeLines(outcome).join('\n')
    assert.match(text, /隔离 worktree/)
    assert.match(text, /package\.json/)
    assert.match(text, /未落入你的工作树/)
    assert.match(text, /补了 scripts\.test/)
  })

  it('verified 且带补丁产物：同样披露（不能读成「修复已落地」）', () => {
    const outcome: ReviewOutcome = {
      tier: 'L2',
      verdict: 'verified',
      evidence: 'ran: npx tsx --test → pass',
      patcherArtifacts: [{ round: 1, changedFiles: ['src/a.ts'] }],
    }
    const text = formatReviewOutcomeLines(outcome).join('\n')
    assert.match(text, /隔离 worktree/)
    assert.match(text, /src\/a\.ts/)
  })

  it('无补丁产物时不产生多余行（无回归噪声）', () => {
    const outcome: ReviewOutcome = { tier: 'L2', verdict: 'verified', evidence: 'ran: ok' }
    const text = formatReviewOutcomeLines(outcome).join('\n')
    assert.ok(!text.includes('隔离 worktree'), text)
  })

  it('只有摘要没有文件名时仍披露轮数', () => {
    const outcome: ReviewOutcome = {
      tier: 'L2',
      verdict: 'rejected',
      escalated: true,
      patcherArtifacts: [{ round: 1, changedFiles: [], patchSummary: '改了内部实现' }],
    }
    const text = formatReviewOutcomeLines(outcome).join('\n')
    assert.match(text, /轮补丁/)
    assert.match(text, /改了内部实现/)
  })

  it('多轮多文件去重后按数量披露', () => {
    const outcome: ReviewOutcome = {
      tier: 'L2',
      verdict: 'rejected',
      escalated: true,
      patcherArtifacts: [
        { round: 1, changedFiles: ['a.ts', 'b.ts'] },
        { round: 2, changedFiles: ['b.ts', 'c.ts'] },
      ],
    }
    const text = formatReviewOutcomeLines(outcome).join('\n')
    assert.match(text, /3 个文件/, text)
  })

  // ── 补丁可取用（本轮修复）：只披露「改了什么」而拿不到补丁时，「手动移植」是死路 ──

  it('带 diffArtifactId：披露可取回的补丁句柄与取用方式', () => {
    const outcome: ReviewOutcome = {
      tier: 'L2',
      verdict: 'rejected',
      escalated: true,
      patcherArtifacts: [
        {
          round: 1,
          changedFiles: ['src/agent/review-router.ts'],
          patchSummary: '抽出纯函数',
          diffArtifactId: 'art_patch_001',
        },
      ],
    }
    const text = formatReviewOutcomeLines(outcome).join('\n')
    assert.match(text, /art_patch_001/, '披露行必须给出补丁的可取回句柄，否则主控无从采纳')
    assert.match(text, /read_section/, '必须写明取用方式（read_section artifactId）')
  })

  it('无 diffArtifactId：不得承诺「手动移植」（无句柄时它做不到）', () => {
    const outcome: ReviewOutcome = {
      tier: 'L2',
      verdict: 'rejected',
      escalated: true,
      patcherArtifacts: [{ round: 1, changedFiles: ['src/a.ts'] }],
    }
    const text = formatReviewOutcomeLines(outcome).join('\n')
    assert.ok(!/手动移植/.test(text), '没有可取回句柄却建议手动移植——主控照着做会发现无从下手')
    assert.match(text, /重新派发/, '无句柄时应指向唯一可行的动作')
  })
})
