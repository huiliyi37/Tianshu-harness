import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writePlan, readPlan, readPlanSync, stripPlanChrome, listPlans, listPlansSync, approvePlan, rejectPlan, deletePlan, slugify, stripPlanStatusMarkers, resolvePlanOptionLabel, stripCopiedTitleSuffix, resolvePlanRef, isDraftSlug, type PlanDocument } from '../plan-store.js'
import { checked, checkedAt } from '../../utils/guard.js'

describe('slugify', () => {
  it('converts spaces and special chars to hyphens', () => {
    assert.equal(slugify('Fix memory leak in loop.ts'), 'fix-memory-leak-in-loop-ts')
  })

  it('preserves Chinese characters', () => {
    assert.equal(slugify('修复 内存泄露'), '修复-内存泄露')
  })

  it('trims leading/trailing hyphens', () => {
    assert.equal(slugify('  hello world!  '), 'hello-world')
  })

  it('truncates to 80 chars', () => {
    const long = 'a'.repeat(100) + '-b'.repeat(50)
    const result = slugify(long)
    assert.ok(result.length <= 80)
  })

  it('returns "plan" for input with no valid chars', () => {
    assert.equal(slugify('!!!'), 'plan')
  })
})

describe('plan-store CRUD', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-plan-test-'))
    return {
      dir,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    }
  }

  it('writePlan creates file and returns relative path', async () => {
    const { dir, cleanup } = setup()
    try {
      const relPath = await writePlan(dir, 'fix-bug', '# Fix Bug\n\nDescription here.')
      assert.equal(relPath, '.rivet/plans/fix-bug.md')
      assert.ok(existsSync(join(dir, '.rivet/plans/fix-bug.md')))
    } finally {
      cleanup()
    }
  })

  it('readPlan returns parsed document', async () => {
    const { dir, cleanup } = setup()
    try {
      await writePlan(dir, 'my-plan', '# My Plan\n\nSome content.')
      const plan = await readPlan(dir, 'my-plan')
      assert.ok(plan)
      assert.equal(checked(plan).title, 'My Plan')
      assert.equal(checked(plan).status, 'submitted')
      assert.equal(checked(plan).slug, 'my-plan')
    } finally {
      cleanup()
    }
  })

  it('listPlans returns sorted by creation time', async () => {
    const { dir, cleanup } = setup()
    try {
      await writePlan(dir, 'plan-b', '# B')
      await new Promise(r => setTimeout(r, 50))
      await writePlan(dir, 'plan-a', '# A')
      const plans = await listPlans(dir)
      assert.equal(plans.length, 2)
      // Most recent first
      assert.equal(checkedAt(plans, 0).slug, 'plan-a')
      assert.equal(checkedAt(plans, 1).slug, 'plan-b')
    } finally {
      cleanup()
    }
  })

  it('approvePlan marks plan as approved', async () => {
    const { dir, cleanup } = setup()
    try {
      await writePlan(dir, 'my-plan', '# My Plan\n\nContent.')
      const approved = await approvePlan(dir, 'my-plan')
      assert.ok(approved)
      assert.equal(checked(approved).status, 'approved')
    } finally {
      cleanup()
    }
  })

  it('rejectPlan marks plan as rejected without deleting it', async () => {
    const { dir, cleanup } = setup()
    try {
      await writePlan(dir, 'doomed-plan', '# Doomed Plan\n\nContent.')
      const rejected = await rejectPlan(dir, 'doomed-plan')
      assert.ok(rejected)
      assert.equal(checked(rejected).status, 'rejected')
      // File is kept on disk so the agent can revise it in place.
      const reread = await readPlan(dir, 'doomed-plan')
      assert.ok(reread)
      assert.equal(checked(reread).status, 'rejected')
    } finally {
      cleanup()
    }
  })

  it('rejectPlan returns null for non-existent plan', async () => {
    const { dir, cleanup } = setup()
    try {
      assert.equal(await rejectPlan(dir, 'ghost'), null)
    } finally {
      cleanup()
    }
  })

  it('deletePlan removes file', async () => {
    const { dir, cleanup } = setup()
    try {
      await writePlan(dir, 'temp-plan', '# Temp')
      assert.ok(await deletePlan(dir, 'temp-plan'))
      const plan = await readPlan(dir, 'temp-plan')
      assert.equal(plan, null)
    } finally {
      cleanup()
    }
  })

  it('readPlan returns null for non-existent plan', async () => {
    const { dir, cleanup } = setup()
    try {
      const plan = await readPlan(dir, 'nonexistent')
      assert.equal(plan, null)
    } finally {
      cleanup()
    }
  })

  // Plan-mode 工作草稿（draft-<ts>.md）不是已提交计划——泄漏进列表会以
  // "Untitled Plan" 待审 chip 的形态出现在 TUI/桌面（2026-07-04 缺陷）。
  it('listPlans and listPlansSync skip plan-mode draft files', async () => {
    const { dir, cleanup } = setup()
    try {
      await writePlan(dir, 'real-plan', '# Real Plan\n\nBody.')
      await writePlan(dir, 'draft-1751600000000', '')
      await writePlan(dir, 'draft-1751600000001', '# Growing Draft\n\nnot submitted yet')
      const plans = await listPlans(dir)
      assert.deepEqual(plans.map(p => p.slug), ['real-plan'])
      const sync = listPlansSync(dir)
      assert.deepEqual(sync.map(p => p.slug), ['real-plan'])
    } finally {
      cleanup()
    }
  })

  it('listPlans returns empty for no plans', async () => {
    const { dir, cleanup } = setup()
    try {
      const plans = await listPlans(dir)
      assert.deepEqual(plans, [])
    } finally {
      cleanup()
    }
  })

  it('plan status is parsed from content markers', async () => {
    const { dir, cleanup } = setup()
    try {
      await writePlan(dir, 'exec-plan', '> **Status: EXECUTED** — 2026-01-01\n\n# Exec')
      const plan = await readPlan(dir, 'exec-plan')
      assert.equal(checked(plan).status, 'executed')
    } finally {
      cleanup()
    }
  })

  // 2026-07-03 缺陷复盘: markPlanStatus 回写时未透传 options,
  // 批准/驳回会把多方案 frontmatter 永久抹掉,导致 selectedApproach 校验形同虚设。
  it('approvePlan preserves options frontmatter', async () => {
    const { dir, cleanup } = setup()
    try {
      const options = [
        { label: 'A (Recommended)', description: 'fast' },
        { label: 'B', description: 'safe' },
      ]
      await writePlan(dir, 'multi', '# Multi\n\nBody.', options)
      const approved = await approvePlan(dir, 'multi')
      assert.deepEqual(checked(approved).options, options)
      const reread = await readPlan(dir, 'multi')
      assert.deepEqual(checked(reread).options, options)
      assert.equal(checked(reread).status, 'approved')
    } finally {
      cleanup()
    }
  })

  it('rejectPlan preserves options frontmatter', async () => {
    const { dir, cleanup } = setup()
    try {
      const options = [{ label: 'X', description: 'only' }, { label: 'Y', description: 'alt' }]
      await writePlan(dir, 'multi-rej', '# Multi\n\nBody.', options)
      const rejected = await rejectPlan(dir, 'multi-rej')
      assert.deepEqual(checked(rejected).options, options)
    } finally {
      cleanup()
    }
  })
})

describe('isDraftSlug', () => {
  it('matches the createActivePlanDraftPath shape (draft-<timestamp>)', () => {
    assert.equal(isDraftSlug('draft-1751600000000'), true)
    assert.equal(isDraftSlug('draft-1'), true)
  })

  it('rejects real plan slugs, even draft-prefixed titles', () => {
    assert.equal(isDraftSlug('fix-memory-leak'), false)
    assert.equal(isDraftSlug('draft-proposal-for-cache'), false)
    assert.equal(isDraftSlug('draft-'), false)
    assert.equal(isDraftSlug('draft-123x'), false)
  })
})

describe('stripPlanStatusMarkers', () => {
  it('removes approve/reject status lines so resubmission is not stuck rejected', () => {
    const content = '> **Status: REJECTED** — 2026-07-03T00:00:00.000Z\n\n# Plan\n\nrevised body\n'
    const stripped = stripPlanStatusMarkers(content)
    assert.ok(!stripped.includes('Status: REJECTED'))
    assert.ok(stripped.startsWith('# Plan'))
  })

  it('removes stacked markers from repeated approve/reject cycles', () => {
    const content =
      '> **Status: REJECTED** — 2026-07-01\n\n> **Status: APPROVED** — 2026-07-02\n\n# Plan\n\nbody\n'
    const stripped = stripPlanStatusMarkers(content)
    assert.ok(!stripped.includes('Status:'))
    assert.ok(stripped.startsWith('# Plan'))
  })

  it('leaves regular blockquotes untouched', () => {
    const content = '# Plan\n\n> **Note:** this is a design note\n'
    assert.equal(stripPlanStatusMarkers(content), content)
  })
})

describe('resolvePlanOptionLabel', () => {
  const options = [
    { label: 'Big Bang (Recommended)', description: 'all at once' },
    { label: 'Incremental', description: 'step by step' },
  ]

  it('matches exact label', () => {
    assert.equal(resolvePlanOptionLabel(options, 'Incremental'), 'Incremental')
  })

  it('matches case-insensitively and returns canonical label', () => {
    assert.equal(resolvePlanOptionLabel(options, 'incremental'), 'Incremental')
  })

  it('tolerates omitting the (Recommended) suffix', () => {
    assert.equal(resolvePlanOptionLabel(options, 'big bang'), 'Big Bang (Recommended)')
  })

  it('returns undefined for unknown labels', () => {
    assert.equal(resolvePlanOptionLabel(options, 'YOLO'), undefined)
  })

  it('returns undefined when a bare label is ambiguous', () => {
    const ambiguous = [
      { label: 'Fast (v1)', description: 'a' },
      { label: 'Fast (v2)', description: 'b' },
    ]
    assert.equal(resolvePlanOptionLabel(ambiguous, 'fast'), undefined)
  })
})

describe('stripCopiedTitleSuffix', () => {
  it('strips a copied " — title" suffix, keeping the slug', () => {
    assert.equal(
      stripCopiedTitleSuffix('权限入口三档统一-manual-auto-yolo — 权限入口三档统一：Manual / Auto / YOLO'),
      '权限入口三档统一-manual-auto-yolo',
    )
  })

  it('returns the trimmed input when no separator is present', () => {
    assert.equal(stripCopiedTitleSuffix('  fix-bug  '), 'fix-bug')
  })
})

describe('resolvePlanRef', () => {
  function plan(slug: string, title: string): PlanDocument {
    return { slug, title, content: '', path: `.rivet/plans/${slug}.md`, createdAt: new Date(), status: 'submitted' }
  }
  const plans = [
    plan('fix-memory-leak', 'Fix Memory Leak'),
    plan('权限入口三档统一-manual-auto-yolo', '权限入口三档统一：Manual / Auto / YOLO'),
    plan('add-caching-layer', 'Add Caching Layer'),
  ]

  it('matches by exact slug', () => {
    const r = resolvePlanRef(plans, 'add-caching-layer')
    assert.equal(r.kind, 'match')
    assert.equal(r.kind === 'match' && r.plan.slug, 'add-caching-layer')
  })

  it('matches by slugified title', () => {
    const r = resolvePlanRef(plans, 'Fix Memory Leak')
    assert.equal(r.kind, 'match')
    assert.equal(r.kind === 'match' && r.plan.slug, 'fix-memory-leak')
  })

  it('tolerates a copied " — title" suffix', () => {
    const r = resolvePlanRef(plans, '权限入口三档统一-manual-auto-yolo — 权限入口三档统一：Manual / Auto / YOLO')
    assert.equal(r.kind, 'match')
    assert.equal(r.kind === 'match' && r.plan.slug, '权限入口三档统一-manual-auto-yolo')
  })

  it('matches by unique slug prefix', () => {
    const r = resolvePlanRef(plans, 'fix-mem')
    assert.equal(r.kind, 'match')
    assert.equal(r.kind === 'match' && r.plan.slug, 'fix-memory-leak')
  })

  it('reports ambiguity when a prefix hits multiple plans', () => {
    const r = resolvePlanRef([plan('add-a', 'A'), plan('add-b', 'B')], 'add-')
    assert.equal(r.kind, 'ambiguous')
    assert.deepEqual(r.kind === 'ambiguous' && r.slugs, ['add-a', 'add-b'])
  })

  it('returns none for unmatched input', () => {
    assert.equal(resolvePlanRef(plans, 'nonexistent-plan').kind, 'none')
  })
})

describe('readPlanSync', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-plan-test-'))
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  it('reads a written plan synchronously with parsed fields', async () => {
    const { dir, cleanup } = setup()
    try {
      await writePlan(dir, 'sync-plan', '# Sync Plan\n\nBody.', [{ label: 'A', description: 'a' }])
      const doc = readPlanSync(dir, 'sync-plan')
      assert.ok(doc, 'readPlanSync 应读到刚写入的计划')
      assert.equal(doc!.title, 'Sync Plan')
      assert.equal(doc!.status, 'submitted')
      assert.deepEqual(doc!.options, [{ label: 'A', description: 'a' }])
      assert.equal(doc!.path, '.rivet/plans/sync-plan.md')
    } finally {
      cleanup()
    }
  })

  it('returns null for missing slug', () => {
    const { dir, cleanup } = setup()
    try {
      assert.equal(readPlanSync(dir, 'no-such-plan'), null)
    } finally {
      cleanup()
    }
  })
})

describe('stripPlanChrome', () => {
  it('strips leading frontmatter, Status/Model markers; keeps body separators and blank lines', () => {
    const content = [
      '---',
      'rivet-options: [{"label":"a"}]',
      '---',
      '> **Model: deepseek-v4 (strong)**',
      '',
      '> **Status: REJECTED — 2026-08-18**',
      '# Title',
      '',
      '正文第一段。',
      '',
      '---',
      '',
      '第二段（正文分隔线保留）。',
    ].join('\n')
    const lines = stripPlanChrome(content)
    assert.deepEqual(lines, [
      '',
      '# Title',
      '',
      '正文第一段。',
      '',
      '---',
      '',
      '第二段（正文分隔线保留）。',
    ])
  })

  it('leaves plain content untouched when no chrome exists', () => {
    assert.deepEqual(stripPlanChrome('# 只有正文\n\nline'), ['# 只有正文', '', 'line'])
  })
})

describe('plan slug 路径穿越防护 (isSafeFileName 门)', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-plan-test-'))
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  it('rejectPlan 拒绝穿越 slug：返回 null 且盘外文件不变', async () => {
    const { dir, cleanup } = setup()
    try {
      const victim = join(dir, 'victim.md')
      const { writeFileSync, readFileSync } = await import('node:fs')
      writeFileSync(victim, 'precious')
      const rejected = await rejectPlan(dir, '../../victim')
      assert.equal(rejected, null)
      assert.equal(readFileSync(victim, 'utf-8'), 'precious')
    } finally {
      cleanup()
    }
  })

  it('readPlan / readPlanSync 对穿越 slug 返回 null', async () => {
    const { dir, cleanup } = setup()
    try {
      assert.equal(await readPlan(dir, '../secret'), null)
      assert.equal(readPlanSync(dir, '..\\secret'), null)
    } finally {
      cleanup()
    }
  })

  it('writePlan 对穿越 slug fail-closed（抛错，不落盘）', async () => {
    const { dir, cleanup } = setup()
    try {
      await assert.rejects(() => writePlan(dir, '../../evil', '# evil'))
      assert.ok(!existsSync(join(dir, 'evil.md')))
    } finally {
      cleanup()
    }
  })

  it('deletePlan 对穿越 slug 返回 false，不删盘外文件', async () => {
    const { dir, cleanup } = setup()
    try {
      const victim = join(dir, 'keep.md')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(victim, 'keep me')
      assert.equal(await deletePlan(dir, '../../keep'), false)
      assert.ok(existsSync(victim))
    } finally {
      cleanup()
    }
  })

  it('正常 slug 不受影响', async () => {
    const { dir, cleanup } = setup()
    try {
      await writePlan(dir, '正常计划-01', '# 标题\n\n正文')
      const doc = await readPlan(dir, '正常计划-01')
      assert.ok(doc)
      assert.equal(doc!.title, '标题')
      assert.equal(await deletePlan(dir, '正常计划-01'), true)
    } finally {
      cleanup()
    }
  })
})


describe('plan status commit boundary', () => {
  for (const decide of [approvePlan, rejectPlan]) {
    it(`${decide.name} rechecks cancellation immediately before writing`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'rivet-plan-cancel-'))
      try {
        await writePlan(dir, 'pending', '# Pending\n\nReview a reversible change.')
        let live = true
        let checks = 0
        const result = await decide(dir, 'pending', undefined, () => {
          checks++
          if (checks === 1) queueMicrotask(() => { live = false })
          return live
        })
        assert.equal(result, null)
        assert.equal((await readPlan(dir, 'pending'))?.status, 'submitted')
        assert.ok(checks >= 2)
      } finally { rmSync(dir, { recursive: true, force: true }) }
    })
  }
  it('preserves edits made between the revision check and status write', async () => {
    const { planRevision } = await import('../plan-revision.js')
    const { writeFileSync, readFileSync } = await import('node:fs')
    const dir = mkdtempSync(join(tmpdir(), 'rivet-plan-concurrent-'))
    try {
      await writePlan(dir, 'pending', '# Pending\n\nOriginal change.')
      const before = (await readPlan(dir, 'pending'))!
      const changed = '# Pending\n\nNew content from another session.'
      let checks = 0
      const result = await approvePlan(dir, 'pending', planRevision(before.content), () => {
        if (++checks === 1) queueMicrotask(() => writeFileSync(join(dir, '.rivet/plans/pending.md'), changed))
        return true
      })
      assert.equal(result, null)
      assert.equal(readFileSync(join(dir, '.rivet/plans/pending.md'), 'utf8'), changed)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})


it('ignores AppleDouble sidecars in asynchronous and synchronous plan lists', async () => {
  const { writeFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plan-metadata-'))
  try {
    await writePlan(dir, 'real-plan', '# Real plan\n\nKeep this document.')
    writeFileSync(join(dir, '.rivet/plans/._real-plan.md'), '# Metadata is not a plan')
    assert.deepEqual((await listPlans(dir)).map(p => p.slug), ['real-plan'])
    assert.deepEqual(listPlansSync(dir).map(p => p.slug), ['real-plan'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
