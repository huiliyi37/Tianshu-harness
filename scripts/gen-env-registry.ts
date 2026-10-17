#!/usr/bin/env tsx
/**
 * gen-env-registry.ts — 从源码自动生成 src/config/env-registry.ts。
 *
 * 扫描所有 RIVET_* 引用（三种模式），提取变量名、引用文件、默认值（若可推断）。
 * 产出按字母排序的注册表。
 *
 * 幂等性与人工内容：name/defaultHint/files 每次全量重算；description 是
 * 人工维护字段——重新生成时从既有 env-registry.ts 读回并按 name 保留，
 * 不会被覆盖清空。变量从源码消失时其条目（含 description）一并移除。
 *
 * 用法：npx tsx scripts/gen-env-registry.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { globSync } from 'node:fs'
import type { EnvRegistryEntry } from '../src/config/env-registry-types.js'

const SRC_ROOT = join(process.cwd(), 'src')

type EnvEntry = Omit<EnvRegistryEntry, 'description'>

function collectEnvVars(): Map<string, EnvEntry> {
  const map = new Map<string, EnvEntry>()
  const files = globSync('src/**/*.ts', { ignore: ['src/**/*.d.ts'] })

  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    const relPath = relative(SRC_ROOT, file).replace(/\\/g, '/')

    // 四种引用模式（与 assembly-audit.test.ts 的 collectRivetVars 对齐）：
    // 1. process.env.RIVET_*（直接）
    // 2. process.env['RIVET_*']（括号形式——同一语义，OCR 易漏；见下方 bracket 注释）
    // 3. env.RIVET_*（解构后的 env 对象）
    // 4. envInt/envStr/envBool('RIVET_*')（辅助函数）
    const patterns = [
      /process\.env\.(RIVET_[A-Z_]+)/g,
      // 括号形式与点号形式是同一引用。此前只认点号：写 `process.env['RIVET_X']`
      // 的变量会被判定为「registry 有条目但源码无引用」（audit 假红），同时
      // 反向漏登记。仓库里这种写法有几十处（platform/bootstrap/skill-loader…）。
      /process\.env\[\s*['"](RIVET_[A-Z_]+)['"]\s*\]/g,
      /\benv\.(RIVET_[A-Z_]+)\b/g,
      /\b(?:envInt|envStr|envBool)\s*\(\s*'(RIVET_[A-Z_]+)'\)/g,
    ]

    for (const pattern of patterns) {
      let m
      while ((m = pattern.exec(content)) !== null) {
        const name = m[1]!
        const idx = m.index

        // 提取默认值
        const ctxStart = Math.max(0, idx - 60)
        const ctxEnd = Math.min(content.length, idx + m[0].length + 60)
        const ctx = content.slice(ctxStart, ctxEnd)

        let defaultHint = ''
        const defaultMatch = ctx.match(new RegExp(`${name.replace(/_/g, '_')}[^=]*[?][?]\\s*([^,\\n;)]+)`))
        if (defaultMatch) {
          defaultHint = defaultMatch[1]!.trim().slice(0, 40)
        }

        const existing = map.get(name)
        if (existing) {
          if (!existing.files.includes(relPath)) {
            existing.files.push(relPath)
          }
          if (!existing.defaultHint && defaultHint) {
            existing.defaultHint = defaultHint
          }
        } else {
          map.set(name, { name, files: [relPath], defaultHint })
        }
      }
    }
  }

  return map
}

/**
 * 从既有 env-registry.ts 读回人工维护的 description（按 name 索引）。
 * 解析用与 assembly-audit 同款的正则配对，不 import 目标文件——生成器
 * 必须能在目标文件损坏/半成品时照常运行。
 */
function readExistingDescriptions(regPath: string): Map<string, string> {
  const map = new Map<string, string>()
  if (!existsSync(regPath)) return map
  try {
    const content = readFileSync(regPath, 'utf8')
    const entryPattern = /name:\s*'(RIVET_[A-Z_]+)'[\s\S]*?description:\s*'((?:[^'\\]|\\.)*)'/g
    let m
    while ((m = entryPattern.exec(content)) !== null) {
      if (m[2]) map.set(m[1]!, m[2])
    }
  } catch { /* 目标文件不可读时从零生成 */ }
  return map
}

function generateRegistry(entries: EnvEntry[], descriptions: Map<string, string>): string {
  const lines: string[] = [
    `/** RIVET_* 环境变量注册表（自动生成于 ${new Date().toISOString()}，共 ${entries.length} 个变量）。`,
    ' * name/defaultHint/files 由 scripts/gen-env-registry.ts 生成；description 人工维护，重生成时按 name 保留。',
    ' * 默认值提示来自源码 ??/||；引用路径相对 src/；assembly-audit.test.ts 双向校验完整性。',
    ' */',
    "import type { EnvRegistryEntry } from './env-registry-types.js'",
    "export type { EnvRegistryEntry } from './env-registry-types.js'",
    `export const ENV_REGISTRY: EnvRegistryEntry[] = [`,
  ]

  for (const entry of entries) {
    const filesLiteral = entry.files.map(f => `'${f}'`).join(', ')
    const desc = descriptions.get(entry.name) ?? ''
    lines.push(`  {`)
    lines.push(`    name: '${entry.name}',`)
    lines.push(`    defaultHint: '${entry.defaultHint.replace(/'/g, "\\'")}',`)
    lines.push(`    files: [${filesLiteral}],`)
    lines.push(`    description: '${desc}',`)
    lines.push(`  },`)
  }

  lines.push(']')
  lines.push('')
  return lines.join('\n')
}

// ── main ──

const map = collectEnvVars()
const entries = [...map.values()].sort((a, b) => a.name.localeCompare(b.name))

const outPath = join(SRC_ROOT, 'config', 'env-registry.ts')
const descriptions = readExistingDescriptions(outPath)
const output = generateRegistry(entries, descriptions)
writeFileSync(outPath, output, 'utf8')

const preserved = entries.filter(e => descriptions.get(e.name)).length
console.log(`Generated ${outPath} with ${entries.length} entries (${preserved} descriptions preserved).`)
