/**
 * verify-source-budgets — 行数棘轮账本的独立校验 + 用量报告。
 *
 * 与 architecture-guards 的分工：guards 在 npm test 里执法（表内超 ceiling /
 * 表外超红线翻红）；本脚本面向人（`--list` 用量表）与脚本链（无参 = 校验
 * 账本自身健康：条目文件存在 + 不超 ceiling）。增长纪律见 manifest 头注释。
 *
 * 用法：
 *   npx tsx scripts/verify-source-budgets.ts           # 校验（CI/脚本链）
 *   npx tsx scripts/verify-source-budgets.ts --list    # 用量表（人看）
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = resolve(repoRoot, 'scripts/source-budgets.manifest.json')

interface BudgetSpec { ceiling: number; note?: string }
interface Manifest {
  redline: number
  budgets: Record<string, BudgetSpec>
}

function loadManifest(): Manifest {
  const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest
  if (typeof raw.redline !== 'number' || typeof raw.budgets !== 'object' || raw.budgets === null) {
    console.error('✗ manifest 结构不完整（需 redline + budgets）')
    process.exit(1)
  }
  return raw
}

/** 物理行数（与 structure-gate.countPhysicalLines 同口径：按换行计）。 */
function lineCount(absPath: string): number {
  const content = readFileSync(absPath, 'utf-8')
  const segments = content.split('\n').length
  return content.endsWith('\n') ? segments - 1 : segments
}

function main(): void {
  const listMode = process.argv.includes('--list')
  const manifest = loadManifest()

  // git ls-files 豁免已删除但未 prune 的条目（stash/分支切换瞬态）。
  const tracked = new Set(
    (() => {
      try {
        return execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
          .split('\n')
          .filter(Boolean)
      } catch {
        return []
      }
    })(),
  )

  const rows: Array<{ file: string; lines: number; ceiling: number }> = []
  const missing: string[] = []
  const over: Array<{ file: string; lines: number; ceiling: number }> = []

  for (const [file, spec] of Object.entries(manifest.budgets)) {
    const abs = resolve(repoRoot, file)
    if (!existsSync(abs)) {
      if (tracked.has(file)) missing.push(file)
      continue
    }
    const lines = lineCount(abs)
    rows.push({ file, lines, ceiling: spec.ceiling })
    if (lines > spec.ceiling) over.push({ file, lines, ceiling: spec.ceiling })
  }

  if (listMode) {
    console.log(`# source budgets（redline=${manifest.redline}，entries=${rows.length}）\n`)
    console.log('  用量   ceiling  用量%  文件')
    for (const r of [...rows].sort((a, b) => b.lines - a.lines)) {
      const pct = Math.round((r.lines / r.ceiling) * 100)
      const bar = pct >= 95 ? '⚠' : ' '
      console.log(`${String(r.lines).padStart(6)}  ${String(r.ceiling).padStart(8)}  ${String(pct).padStart(3)}%${bar}  ${r.file}`)
    }
    process.exit(0)
  }

  let failed = false
  if (missing.length > 0) {
    console.error(`✗ 账本条目文件缺失（拆分/改名/删除须同 PR 更新 manifest）：\n${missing.map(f => `  ${f}`).join('\n')}`)
    failed = true
  }
  if (over.length > 0) {
    console.error(`✗ 超 ceiling（增长须同 PR 改 manifest 并说明理由；沿接缝拆分而不是继续膨胀）：\n${over.map(r => `  ${r.file}: ${r.lines} > ${r.ceiling}`).join('\n')}`)
    failed = true
  }
  if (failed) process.exit(1)
  console.log(`✓ source budgets: ${rows.length} 条目全部健康（redline=${manifest.redline}）`)
}

main()
