/**
 * W4 环境运行时感知 — 目标项目 runtime 版本探测。
 *
 * 失败模式背景：修复在新版运行时正确、在目标环境旧版本上直接崩
 * （如 Python 3.6 enum 类属性、walrus、typing 语法）。模型不知道
 * 目标环境版本时只能按训练常识假设最新版。
 *
 * 缓存影响建模（动手前置，天权评审要求）：
 * - 探测结果按 cwd 进程内记忆化 → 会话内字节恒定 → frozen 前缀稳定
 * - 落点是 `<context>` frozen 块（与 <environment> cwd/os 同类的会话常量位），
 *   不进跨会话共享的 static 系统提示（per-project 字节会毁掉跨会话 static 复用），
 *   也不进每轮重建的 dynamic appendix（无节律信息进 appendix 只添 churn）
 * - 语义不变则字节不变：同一 cwd 重复构建产出 byte-identical 块
 * - 命令探测（python3/node --version）只在对应项目标记文件存在时执行，
 *   一次 spawnSync ≤2s，仅首次构建付费
 *
 * 逃生口：RIVET_RUNTIME_ENV=0 完全禁用。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Injectable command prober (tests inject a fake; default spawns for real). */
export type VersionProbe = (command: string, args: string[]) => string | null

const defaultProbe: VersionProbe = (command, args) => {
  try {
    const r = spawnSync(command, args, { encoding: 'utf-8', timeout: 2000, windowsHide: true })
    if (r.status !== 0) return null
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
    return out || null
  } catch {
    return null
  }
}

function readIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : null
  } catch {
    return null
  }
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? ''
}

/** Extract "Python 3.6.9" → "3.6.9"; "v18.20.0" → "18.20.0". */
function extractVersionNumber(raw: string): string | null {
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(raw)
  return m ? m[1]! : null
}

interface RuntimeLine {
  /** e.g. 'python' */
  name: string
  /** Probed actual version, e.g. '3.6.9' */
  actual?: string
  /** Declared constraint from project files, e.g. '>=3.5' or '3.11' */
  declared?: string
  /** Source of the declared constraint, e.g. '.python-version' */
  declaredSource?: string
}

function detectPython(cwd: string, probe: VersionProbe): RuntimeLine | null {
  const markers = ['setup.py', 'pyproject.toml', 'requirements.txt', 'setup.cfg', 'tox.ini', 'Pipfile']
  const hasProject = markers.some(m => existsSync(join(cwd, m)))
  const pinned = readIfExists(join(cwd, '.python-version'))
  if (!hasProject && !pinned) return null

  const line: RuntimeLine = { name: 'python' }
  if (pinned) {
    line.declared = firstLine(pinned)
    line.declaredSource = '.python-version'
  } else {
    // python_requires from setup.py / setup.cfg, requires-python from pyproject.toml
    for (const [file, re] of [
      ['setup.py', /python_requires\s*=\s*["']([^"']+)["']/],
      ['setup.cfg', /python_requires\s*=\s*(\S+)/],
      ['pyproject.toml', /requires-python\s*=\s*["']([^"']+)["']/],
    ] as const) {
      const content = readIfExists(join(cwd, file))
      const m = content ? re.exec(content) : null
      if (m) {
        line.declared = m[1]!
        line.declaredSource = file
        break
      }
    }
  }
  const probed = probe('python3', ['--version']) ?? probe('python', ['--version'])
  if (probed) {
    const v = extractVersionNumber(probed)
    if (v) line.actual = v
  }
  return line.actual || line.declared ? line : null
}

function detectNode(cwd: string, probe: VersionProbe): RuntimeLine | null {
  const pkgRaw = readIfExists(join(cwd, 'package.json'))
  const nvmrc = readIfExists(join(cwd, '.nvmrc'))
  if (!pkgRaw && !nvmrc) return null

  const line: RuntimeLine = { name: 'node' }
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as { engines?: { node?: string } }
      if (pkg.engines?.node) {
        line.declared = pkg.engines.node
        line.declaredSource = 'package.json engines'
      }
    } catch { /* malformed package.json → no declared constraint */ }
  }
  if (!line.declared && nvmrc) {
    line.declared = firstLine(nvmrc)
    line.declaredSource = '.nvmrc'
  }
  const probed = probe('node', ['--version'])
  if (probed) {
    const v = extractVersionNumber(probed)
    if (v) line.actual = v
  }
  return line.actual || line.declared ? line : null
}

function detectRust(cwd: string): RuntimeLine | null {
  const toolchain = readIfExists(join(cwd, 'rust-toolchain')) ?? readIfExists(join(cwd, 'rust-toolchain.toml'))
  if (!toolchain) return null
  const m = /channel\s*=\s*["']([^"']+)["']/.exec(toolchain)
  const declared = m ? m[1]! : firstLine(toolchain)
  if (!declared) return null
  return { name: 'rust', declared, declaredSource: 'rust-toolchain' }
}

function detectGo(cwd: string): RuntimeLine | null {
  const goMod = readIfExists(join(cwd, 'go.mod'))
  if (!goMod) return null
  const m = /^go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(goMod)
  if (!m) return null
  return { name: 'go', declared: m[1]!, declaredSource: 'go.mod' }
}

function renderLine(l: RuntimeLine): string {
  const parts: string[] = [`${l.name}:`]
  if (l.actual) parts.push(l.actual)
  if (l.declared) parts.push(l.actual ? `(declared ${l.declared} via ${l.declaredSource})` : `declared ${l.declared} via ${l.declaredSource}`)
  return parts.join(' ')
}

/** 版本敏感提醒：目标运行时明显老于当前常识版本时值得点名。 */
function isDated(l: RuntimeLine): boolean {
  const v = l.actual ?? l.declared
  if (!v) return false
  const m = /(\d+)\.(\d+)/.exec(v)
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  if (l.name === 'python') return major < 3 || (major === 3 && minor < 9)
  if (l.name === 'node') return major < 18
  return false
}

/**
 * Build the `<runtime-env>` block for cwd, or null when nothing is detected.
 * Result is memoized per cwd — byte-identical across rebuilds in a session.
 */
const cache = new Map<string, string | null>()

export function detectRuntimeEnvBlock(cwd: string, probe: VersionProbe = defaultProbe): string | null {
  if (process.env['RIVET_RUNTIME_ENV'] === '0') return null
  if (cache.has(cwd)) return cache.get(cwd)!
  const block = buildBlock(cwd, probe)
  cache.set(cwd, block)
  return block
}

/** Test-only: clear the per-cwd memo so fixtures don't leak across cases. */
export function __resetRuntimeEnvCache(): void {
  cache.clear()
}

function buildBlock(cwd: string, probe: VersionProbe): string | null {
  const lines: RuntimeLine[] = []
  const py = detectPython(cwd, probe)
  if (py) lines.push(py)
  const node = detectNode(cwd, probe)
  if (node) lines.push(node)
  const rust = detectRust(cwd)
  if (rust) lines.push(rust)
  const go = detectGo(cwd)
  if (go) lines.push(go)
  if (lines.length === 0) return null

  const rendered = lines.map(renderLine).join('\n')
  const datedNames = lines.filter(isDated).map(l => l.name)
  const caution = datedNames.length > 0
    ? `\n注意：目标环境 ${datedNames.join('/')} 低于当前常识版本。版本敏感构造（enum 类属性、typing/match 语法、walrus、可选链等）以上述版本为准，动手前确认目标版本支持，不凭训练常识假设。`
    : ''
  return `<runtime-env>\n${rendered}${caution}\n</runtime-env>`
}
