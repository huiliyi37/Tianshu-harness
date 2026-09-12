#!/usr/bin/env node
/**
 * assert-runtime-imports.js — fail the build when dist/ bundles contain bare
 * imports that the packaged sidecar cannot resolve.
 *
 * 运行时机：Tauri beforeBuildCommand 链中，stage-runtime-deps 之后、
 * obfuscate-runtime 之前。dist/ 里出现 allowlist 之外的裸导入 = 纯 JS 依赖
 * 没被 tsup 内联 —— 打包后必崩 ERR_MODULE_NOT_FOUND（v2.27.0 pixelmatch
 * 事故，2026-08-02）。宁可构建失败，不发残包。
 *
 * 用法: node scripts/assert-runtime-imports.js [distDir]
 */
import { join, relative } from 'node:path'
import { readFileSync } from 'node:fs'
import { scanDist } from './runtime-import-scan.js'
import { verifyStagedRuntime } from './staged-runtime-verify.js'

const repoRoot = join(import.meta.dirname, '..')
const distDir = process.argv[2] ?? join(repoRoot, 'dist')

// dist/ 独立分发后没有上级 package.json，缺失 "type":"module" 声明时 Node 按
// CommonJS 解析 ESM bundle，sidecar 启动即 SyntaxError（2026-09-11 Windows 现场）。
let distPkgType = null
try {
  distPkgType = JSON.parse(readFileSync(join(distDir, 'package.json'), 'utf8')).type
} catch { /* 缺失/损坏按未声明处理 */ }
if (distPkgType !== 'module') {
  console.error('✗ assert-runtime-imports: dist/package.json 缺失或未声明 "type":"module"——打包后 sidecar 启动即崩')
  console.error('  修复：node scripts/stage-runtime-deps.js（会在 dist/ 落最小 package.json）')
  process.exit(1)
}

// Specifier allowlisting only proves an import *may* resolve; it says nothing
// about whether staging actually put the package on disk. Check the payload
// first — a skeleton-only dist passes every specifier check (2026-08-03).
const staged = verifyStagedRuntime(distDir)
if (!staged.ok) {
  console.error('✗ assert-runtime-imports: dist/node_modules staging 不完整——拒绝发残包')
  for (const p of staged.problems) console.error(`  ${p}`)
  console.error('  修复：node scripts/pack-native.js && node scripts/stage-runtime-deps.js')
  process.exit(1)
}

const violations = await scanDist(distDir)
if (violations.size > 0) {
  console.error('✗ assert-runtime-imports: dist/ 含无法随包解析的裸导入（纯 JS 依赖未内联？）')
  for (const [file, specs] of violations) {
    console.error(`  ${relative(distDir, file)}: ${[...specs].join(', ')}`)
  }
  console.error('  修复：把包加入 tsup.config.ts noExternal 内联，或加入 stage-runtime-deps ROOTS 随包分发。')
  process.exit(1)
}
console.log(
  staged.skipped
    ? '✅ assert-runtime-imports: dist/ 所有导入均可随包解析（未 stage node_modules，跳过载荷校验）'
    : '✅ assert-runtime-imports: dist/ 所有导入均可随包解析，staged 载荷非空',
)
