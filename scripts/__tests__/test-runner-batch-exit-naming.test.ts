/**
 * 批退出码非零时必须**点名该批** —— 来自 PR #177（yeshilei-QWQ）的可诊断性补强。
 *
 * ## 事故形态
 *
 * CI 上出现过 `合计：17980 条（pass 17968 / fail 0）· 3 批` 却整体 exit 1，整份日志里
 * 一条 ✖ / AssertionError 都没有 —— 知道红了，但不知道**谁**红的。
 *
 * ## 盲区在哪
 *
 * `scripts/run-node-tests.ts` 的批次循环里，`if (out.code !== 0) worstExit = out.code`
 * 只记下非零码，从不点名是哪一批；而 `失败批末帧` 只重放带 `failing tests:` 的批。
 * 「非零退出但没有失败用例」的批在 test-child-guard.ts 里是**真实存在**的两条判失败路径：
 *
 * - `!summarySeen`（子进程非零退出、压根没出汇总）→ 沿用子进程码或兜到 1；
 * - `killed === 'hard'`（总时长失控）→ 即使已见汇总也判 1。
 *
 * 这两条路径的批 `out.fail` 记 0，因此没有末帧、没有 ✖ 明细，日志里只剩「整体 exit 1」。
 * runBatch 的 fail-closed 警告虽有文案，但同样**不带批号**——多批日志里仍然定位不到。
 *
 * ## 这里锁什么
 *
 * `out.code !== 0` 分支必须把批号、退出码与该批自身的 tests/pass/fail（含「未出汇总」标记）
 * 摆出来；同时判定语义 `worstExit = out.code` 不得被顺手改掉（点名只加观测，不动判定）。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RUNNER = join(repoRoot, 'scripts', 'run-node-tests.ts')

/**
 * 截出 `if (out.code !== 0) { ... }` 分支体（两空格缩进的闭合花括号为界）。
 * 导出供 RED 自检脚本对历史版本复算——断言必须能对旧代码打红。
 */
export function extractExitBranch(source: string): string {
  // 行尾归一：windows-smoke runner 以 CRLF 检出（Git for Windows 的 core.autocrlf
  // 默认为开，本仓无 .gitattributes 兜底），而下面按 `\n` 锚定的正则要求闭合花括号
  // 紧跟 `\n`——在 CRLF 的 `}\r\n` 处失配，windows-smoke 因此恒红（ubuntu 的 LF
  // 检出通过，故 ci(24) 无此红）。归一后两端同判，判定不变量不变。
  const norm = source.replace(/\r\n?/g, '\n')
  const matched = norm.match(/\n {2}if \(out\.code !== 0\) \{([\s\S]*?)\n {2}\}\n/)
  assert.ok(
    matched,
    'run-node-tests.ts 里找不到 `if (out.code !== 0) {` 分支——'
      + '要么判定逻辑被重写（请同步本测试的不变量），要么缩进变了（正则失配）。',
  )
  return matched[1]!
}

/** 校验点名不变量。导出以便对历史版本复算 RED。 */
export function assertBatchExitNaming(source: string): void {
  const branch = extractExitBranch(source)

  assert.match(
    branch,
    /worstExit = out\.code/,
    '非零退出分支必须保留 `worstExit = out.code`：点名只是加观测，判定语义不得被改。',
  )
  assert.match(
    branch,
    /console\.log\(/,
    '非零退出却只记 worstExit，不点名该批 —— 多批日志里「谁红的」又变成猜。'
      + '（CI 曾出现 `fail 0` 而整体 exit 1、日志零线索，PR #177 修的就是这个盲区。）',
  )
  assert.match(
    branch,
    /批 \$\{batchIdx \+ 1\}\/\$\{batches\.length\} 退出码 \$\{out\.code\}/,
    '点名行必须含「批 N/M 退出码 X」——只有批号+码才能在多批日志里定位到具体那一批。',
  )
  for (const field of ['out.tests', 'out.pass', 'out.fail']) {
    assert.ok(
      branch.includes(field),
      `点名行必须报出该批自己的 ${field}：fail 0 而码非零正是需要被一眼看出的签名。`,
    )
  }
  assert.ok(
    branch.includes("out.complete ? '' : ' · 未出汇总'"),
    '点名行必须标注「未出汇总」：没有汇总的批 tests/pass/fail 记 0，不标注会被误读成「跑了 0 条」。',
  )
}

describe('批退出码点名的可诊断性护栏（PR #177）', () => {
  const source = readFileSync(RUNNER, 'utf8')

  test('非零退出分支点名该批（批号 / 退出码 / 该批计数 / 未出汇总）', () => {
    assertBatchExitNaming(source)
  })

  test('判定语义唯一且未被复制成第二处赋值', () => {
    const assignments = source.match(/worstExit = out\.code/g) ?? []
    assert.equal(
      assignments.length,
      1,
      `\`worstExit = out.code\` 应恰好出现 1 次，实际 ${assignments.length} 次——`
        + '多处赋值意味着有点名漂移，非零退出的批可能又漏网。',
    )
    const branchHeads = source.match(/if \(out\.code !== 0\)/g) ?? []
    assert.equal(
      branchHeads.length,
      1,
      `\`if (out.code !== 0)\` 应恰好 1 处，实际 ${branchHeads.length} 处——新增的判定点必须一并点名。`,
    )
  })
})
