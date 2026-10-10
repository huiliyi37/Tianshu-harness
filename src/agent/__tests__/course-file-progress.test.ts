/**
 * P0 验收矩阵（《收敛阶段补修》§4 表）：文件进展三态 + WRITE_TOOL_NAMES 全族。
 *
 * 口径：
 * - 成功且实际变化才是 changed；no-op（同内容重写）是 unchanged；
 * - dry-run / check-only 预览是 unchanged（确定不写盘）；
 * - 失败 / 自动回滚（isError）不推进 → unknown（不伪装 unchanged）；
 * - 纯删除、批量写入单独覆盖；敏感/项目外路径不参与记账 → unknown；
 * - 缺失判断为 unknown，不伪装 unchanged。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureCourseFileProgress } from '../course-file-progress.js'

function tmp() { return mkdtempSync(join(tmpdir(), 'rivet-fileprogress-')) }

test('WRITE_TOOL_NAMES 全族：真实变化计 changed（edit_file/write_file/hash_edit/ast_edit/apply_patch）', async () => {
  const dir = tmp()
  try {
    const path = join(dir, 'a.ts')
    writeFileSync(path, 'before')

    // edit_file / hash_edit：new_string
    for (const tool of ['edit_file', 'hash_edit']) {
      writeFileSync(path, 'before')
      const mon = await captureCourseFileProgress(tool, { file_path: path, new_string: 'after' }, dir)
      writeFileSync(path, 'after')
      assert.equal((await mon.finish({ isError: false })).outcome, 'changed', tool)
    }
    // write_file：content
    {
      const mon = await captureCourseFileProgress('write_file', { file_path: path, content: 'v2' }, dir)
      writeFileSync(path, 'v2')
      assert.equal((await mon.finish({ isError: false })).outcome, 'changed')
    }
    // ast_edit：dryRun !== false 时返回路径集且会做指纹（缺省=预览，无盘变→unchanged）；
    // 显式 false = 真写
    {
      writeFileSync(path, 'v2')
      const mon = await captureCourseFileProgress('ast_edit', { paths: [path], ops: [{ find: 'v2', replace: 'v3' }], dryRun: false }, dir)
      writeFileSync(path, 'v3')
      assert.equal((await mon.finish({ isError: false })).outcome, 'changed', 'ast_edit 真写')
    }
    // apply_patch：+++ 头路径
    {
      writeFileSync(path, 'v3')
      const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-v3\n+v4\n'
      const mon = await captureCourseFileProgress('apply_patch', { diff }, dir)
      writeFileSync(path, 'v4')
      assert.equal((await mon.finish({ isError: false })).outcome, 'changed', 'apply_patch 修改')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('no-op（同内容重写）是 unchanged；预览（ast_edit 缺省/dryRun、apply_patch check_only）是 unchanged', async () => {
  const dir = tmp()
  try {
    const path = join(dir, 'a.ts')
    writeFileSync(path, 'same')
    const noop = await captureCourseFileProgress('write_file', { file_path: path }, dir)
    writeFileSync(path, 'same')
    assert.equal((await noop.finish({ isError: false })).outcome, 'unchanged')

    // ast_edit 缺省 dryRun（缺省即预览）与显式 true
    for (const input of [{ paths: [path], ops: [] }, { paths: [path], ops: [], dryRun: true }]) {
      const mon = await captureCourseFileProgress('ast_edit', input as Record<string, unknown>, dir)
      assert.equal((await mon.finish({ isError: false })).outcome, 'unchanged', 'ast_edit 预览')
    }
    // apply_patch check_only
    const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-same\n+other\n'
    const checkOnly = await captureCourseFileProgress('apply_patch', { diff, check_only: true }, dir)
    assert.equal((await checkOnly.finish({ isError: false })).outcome, 'unchanged', 'check_only 预览')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('纯删除（apply_patch：+++ /dev/null）计 changed；批量写入单独覆盖', async () => {
  const dir = tmp()
  try {
    const gone = join(dir, 'gone.md')
    writeFileSync(gone, 'bye')
    const delDiff = 'diff --git a/gone.md b/gone.md\ndeleted file mode 100644\n--- a/gone.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n'
    const delMon = await captureCourseFileProgress('apply_patch', { diff: delDiff }, dir)
    rmSync(gone)
    const delFact = await delMon.finish({ isError: false })
    assert.equal(delFact.outcome, 'changed', '纯删除是真实变化')

    // 批量：一个修改 + 一个新增
    const one = join(dir, 'one.ts'); const two = join(dir, 'two.ts')
    writeFileSync(one, 'x')
    const batchDiff = [
      'diff --git a/one.ts b/one.ts', '--- a/one.ts', '+++ b/one.ts', '@@ -1 +1 @@', '-x', '+y',
      'diff --git a/two.ts b/two.ts', '--- /dev/null', '+++ b/two.ts', '@@ -0,0 +1 @@', '+hello',
    ].join('\n')
    const batchMon = await captureCourseFileProgress('apply_patch', { diff: batchDiff }, dir)
    writeFileSync(one, 'y'); writeFileSync(two, 'hello')
    assert.equal((await batchMon.finish({ isError: false })).outcome, 'changed', '批量修改+新增')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('失败/回滚（isError）→ unknown：不推进也不伪装 unchanged', async () => {
  const dir = tmp()
  try {
    const path = join(dir, 'a.ts')
    writeFileSync(path, 'before')
    const mon = await captureCourseFileProgress('edit_file', { file_path: path, new_string: 'after' }, dir)
    writeFileSync(path, 'after') // 模拟部分写入/回滚不彻底——失败仍不推进
    assert.equal((await mon.finish({ isError: true })).outcome, 'unknown')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('敏感文件 / 项目外路径 / 无目标 → unknown（不伪装 unchanged）', async () => {
  const dir = tmp()
  try {
    mkdirSync(join(dir, 'sub'))
    // 敏感：.env 在 cwd 内
    writeFileSync(join(dir, '.env'), 'K=v')
    const envMon = await captureCourseFileProgress('write_file', { file_path: join(dir, '.env') }, dir)
    assert.equal((await envMon.finish({ isError: false })).outcome, 'unknown', '敏感路径不参与记账')

    // 项目外：cwd 用 sub/，文件在父级
    writeFileSync(join(dir, 'outside.ts'), 'x')
    const outMon = await captureCourseFileProgress('write_file', { file_path: join(dir, 'outside.ts') }, join(dir, 'sub'))
    assert.equal((await outMon.finish({ isError: false })).outcome, 'unknown', '项目外不参与记账')

    // 无目标：write_file 缺 file_path
    const noTarget = await captureCourseFileProgress('write_file', {}, dir)
    assert.equal((await noTarget.finish({ isError: false })).outcome, 'unknown', '无目标不伪装 unchanged')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('工具性路径（.rivet/plans/draft-*.md、.rivet/scratch/）不计工作版本变化 → unknown（P2）', async () => {
  const dir = tmp()
  try {
    mkdirSync(join(dir, '.rivet/plans'), { recursive: true })
    mkdirSync(join(dir, '.rivet/scratch'), { recursive: true })
    // 瞬态计划草稿：盘上确有变化，但不是工作产物——不推进工作版本
    const draft = join(dir, '.rivet/plans/draft-123.md')
    writeFileSync(draft, 'v1')
    const draftMon = await captureCourseFileProgress('write_file', { file_path: draft, content: 'v2' }, dir)
    writeFileSync(draft, 'v2')
    assert.equal((await draftMon.finish({ isError: false })).outcome, 'unknown', '草稿不是代码证据')
    // scratch 探针：一次性工具文件
    const probe = join(dir, '.rivet/scratch/probe.ts')
    writeFileSync(probe, 'a')
    const probeMon = await captureCourseFileProgress('write_file', { file_path: probe, content: 'b' }, dir)
    writeFileSync(probe, 'b')
    assert.equal((await probeMon.finish({ isError: false })).outcome, 'unknown', '探针是工具文件')
    // 对照：正式计划文件（非 draft 形状）是工作产物，仍计 changed
    const approved = join(dir, '.rivet/plans/approved-plan.md')
    writeFileSync(approved, 'p1')
    const planMon = await captureCourseFileProgress('write_file', { file_path: approved, content: 'p2' }, dir)
    writeFileSync(approved, 'p2')
    assert.equal((await planMon.finish({ isError: false })).outcome, 'changed', '正式计划文件是工作产物')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
