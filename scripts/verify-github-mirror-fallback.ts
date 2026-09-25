#!/usr/bin/env tsx
/**
 * GitHub 镜像自动回退 — 真实网络端到端验证脚本
 *
 * 验证 cloneWithFallback 在真实网络下的行为：
 *   A. 直连可达 → reason: direct
 *   B. 模拟直连失败 → fallback 到镜像站，reason: fallback
 *   C. 记忆生效 → 第二次跳过直连，reason: memory
 *
 * 用法：
 *   ./node_modules/.bin/tsx scripts/verify-github-mirror-fallback.ts
 *
 * 可选环境变量：
 *   GITHUB_TEST_REPO — 测试用的 github 仓库（owner/repo），默认 sindresorhus/is-plain-obj
 *   GITHUB_TEST_REF  — 可选分支/tag，默认不指定
 *
 * 需要网络访问 github.com 或镜像站之一。不依赖 API key。
 * 失败场景标红但不中断，输出汇总表供人工判断。
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloneWithFallback, clearMirrorMemory } from '../src/tools/github-mirror-fallback.js'
import type { MirrorsConfig } from '../src/config/schema.js'

const TEST_REPO = process.env.GITHUB_TEST_REPO ?? 'sindresorhus/is-plain-obj'
const TEST_REF = process.env.GITHUB_TEST_REF // optional
const REPO_URL = `https://github.com/${TEST_REPO}.git`

const BASE_CONFIG: MirrorsConfig = {
  enabled: false,
  preset: 'default',
  github: 'default',
  npm: 'default',
  pypi: 'default',
  go: 'default',
  rust: 'default',
  autoFallback: true,
  fallbackMemoryMinutes: 10,
  fallbackTimeoutSec: 30,
}

interface ScenarioResult {
  name: string
  ok: boolean
  reason?: string
  mirrorId?: string
  elapsedMs: number
  detail: string
}

/** Run a real `git clone --depth 1` into a fresh temp dir. Throws on failure. */
function realClone(url: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = mkdtempSync(join(tmpdir(), 'rivet-verify-mirror-'))
    const args = ['clone', '--depth', '1']
    if (TEST_REF) args.push('--branch', TEST_REF)
    args.push('--', url, target)
    execFile('git', args, { timeout: timeoutMs, windowsHide: true }, (err) => {
      // Cleanup regardless of outcome.
      try { rmSync(target, { recursive: true, force: true }) } catch { /* best-effort */ }
      if (err) reject(err)
      else resolve()
    })
  })
}

async function runScenario(name: string, fn: () => Promise<ScenarioResult>): Promise<ScenarioResult> {
  const start = Date.now()
  try {
    const r = await fn()
    return { ...r, elapsedMs: Date.now() - start }
  } catch (err) {
    return {
      name,
      ok: false,
      elapsedMs: Date.now() - start,
      detail: `Exception: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function main() {
  console.log(`\n🔍 GitHub 镜像回退验证 — repo: ${TEST_REPO}\n`)
  const results: ScenarioResult[] = []

  // ── Scenario A: direct reachable ──────────────────────────────────
  results.push(await runScenario('A. 直连可达', async () => {
    clearMirrorMemory()
    const decision = await cloneWithFallback({
      originalUrl: REPO_URL,
      config: BASE_CONFIG,
      cwd: process.cwd(),
      cloneFn: (url, t) => realClone(url, t),
    })
    const ok = decision.reason === 'direct'
    return {
      name: 'A. 直连可达',
      ok,
      reason: decision.reason,
      mirrorId: decision.mirrorId,
      elapsedMs: 0,
      detail: ok
        ? `直连成功，无回退`
        : `预期 direct 但得到 ${decision.reason}${decision.mirrorId ? ` (${decision.mirrorId})` : ''}`,
    }
  }))

  // ── Scenario B: simulate direct failure → fallback to mirror ──────
  results.push(await runScenario('B. 直连失败→镜像回退', async () => {
    clearMirrorMemory()
    const decision = await cloneWithFallback({
      originalUrl: REPO_URL,
      config: BASE_CONFIG,
      cwd: process.cwd(),
      // Simulate github.com being blocked: direct URL throws, mirrors use real clone.
      cloneFn: async (url, timeoutMs) => {
        if (url.includes('github.com')) {
          throw new Error('simulated block: github.com unreachable')
        }
        await realClone(url, timeoutMs)
      },
    })
    const ok = decision.reason === 'fallback' && !!decision.mirrorId
    return {
      name: 'B. 直连失败→镜像回退',
      ok,
      reason: decision.reason,
      mirrorId: decision.mirrorId,
      elapsedMs: 0,
      detail: ok
        ? `回退到 ${decision.mirrorId} 成功（试过失败: ${decision.triedFailures.map((f) => f.mirrorId).join(', ')}）`
        : `预期 fallback，得到 ${decision.reason}`,
    }
  }))

  // ── Scenario C: memory hit (immediately after B) ─────────────────
  results.push(await runScenario('C. 记忆生效', async () => {
    // Do NOT clearMirrorMemory — B should have seeded it.
    const start = Date.now()
    const decision = await cloneWithFallback({
      originalUrl: REPO_URL,
      config: BASE_CONFIG,
      cwd: process.cwd(),
      cloneFn: async (url, timeoutMs) => {
        if (url.includes('github.com')) {
          throw new Error('simulated block: github.com unreachable')
        }
        await realClone(url, timeoutMs)
      },
    })
    const elapsed = Date.now() - start
    const ok = decision.reason === 'memory' && !!decision.mirrorId
    return {
      name: 'C. 记忆生效',
      ok,
      reason: decision.reason,
      mirrorId: decision.mirrorId,
      elapsedMs: elapsed,
      detail: ok
        ? `记忆命中 ${decision.mirrorId}，跳过直连（${elapsed}ms）`
        : `预期 memory，得到 ${decision.reason}`,
    }
  }))

  // ── Summary table ─────────────────────────────────────────────────
  console.log('\n┌──────────────────────────┬────────┬──────────┬─────────────┬──────────────────────────────────┐')
  console.log('│ 场景                     │ 结果   │ reason   │ mirror      │ 说明                             │')
  console.log('├──────────────────────────┼────────┼──────────┼─────────────┼──────────────────────────────────┤')
  for (const r of results) {
    const name = r.name.padEnd(22).slice(0, 22)
    const status = (r.ok ? '✅ pass' : '❌ FAIL').padEnd(6)
    const reason = (r.reason ?? '-').padEnd(8)
    const mirror = (r.mirrorId ?? '-').padEnd(11)
    const detail = r.detail.slice(0, 32).padEnd(32)
    console.log(`│ ${name} │ ${status} │ ${reason} │ ${mirror} │ ${detail} │`)
  }
  console.log('└──────────────────────────┴────────┴──────────┴─────────────┴──────────────────────────────────┘')

  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} 场景通过`)
  if (passed < results.length) {
    console.log('\n⚠️  未全部通过。常见原因：')
    console.log('   - A 失败：当前网络无法直连 github.com（这正是回退功能的存在意义，B/C 仍应通过）')
    console.log('   - B/C 失败：所有镜像站都不可达，或镜像站返回了非预期内容')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('\n💥 脚本异常退出:', err)
  process.exit(1)
})
