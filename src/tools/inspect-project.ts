import { readFile, stat, readdir } from 'node:fs/promises'
import { isFilesystemMetadata } from '../utils/file-metadata.js'
import { join } from 'path'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { relativePosix } from '../path-format.js'
import { classifyPath } from '../context/attention-filter.js'
import { SCAN_EXCLUDE_DIRS } from './scan-excludes.js'

interface PackageJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const EXCLUDE_DIRS = SCAN_EXCLUDE_DIRS

function shouldSkipBroadDiscoveryDir(cwd: string, fullPath: string, name: string): boolean {
  if (EXCLUDE_DIRS.has(name)) return true
  return classifyPath(relativePosix(cwd, fullPath)).silent
}

const FRAMEWORK_HINTS: Array<{ deps: string[]; name: string }> = [
  { deps: ['next'], name: 'Next.js' },
  { deps: ['nuxt'], name: 'Nuxt' },
  { deps: ['@nestjs/core'], name: 'NestJS' },
  { deps: ['vue'], name: 'Vue' },
  { deps: ['react'], name: 'React' },
  { deps: ['express'], name: 'Express' },
  { deps: ['fastify'], name: 'Fastify' },
  { deps: ['hono'], name: 'Hono' },
  { deps: ['svelte'], name: 'Svelte' },
]

const TEST_FRAMEWORKS: Array<{ deps: string[]; name: string }> = [
  { deps: ['vitest'], name: 'vitest' },
  { deps: ['jest'], name: 'jest' },
  { deps: ['mocha'], name: 'mocha' },
]

const LINTERS: Array<{ files: string[]; deps: string[]; name: string }> = [
  { files: ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs'], deps: ['eslint'], name: 'ESLint' },
  { files: ['.prettierrc', '.prettierrc.js', '.prettierrc.json', 'prettier.config.js'], deps: ['prettier'], name: 'Prettier' },
  { files: ['biome.json'], deps: ['@biomejs/biome'], name: 'Biome' },
]

const ENTRY_FILE_NAMES = ['main', 'index', 'app', 'server', 'cli']
const ENTRY_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs']
const ENTRY_DIRS = ['src', 'lib', 'app', 'bin', '']

const CONFIG_FILE_PATTERNS = [
  'DESIGN.md',
  'tsconfig.json', 'tsconfig.*.json',
  'vite.config.ts', 'vite.config.js', 'vite.config.mjs',
  'next.config.ts', 'next.config.js', 'next.config.mjs',
  'tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs',
  'postcss.config.ts', 'postcss.config.js', 'postcss.config.mjs',
  'tsup.config.ts', 'tsup.config.js',
  'webpack.config.ts', 'webpack.config.js',
  'rollup.config.ts', 'rollup.config.js',
  'esbuild.config.ts', 'esbuild.config.js',
  'jest.config.ts', 'jest.config.js',
  'vitest.config.ts', 'vitest.config.js',
]

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

async function detectLanguage(cwd: string): Promise<string> {
  return (await fileExists(join(cwd, 'tsconfig.json'))) ? 'TypeScript' : 'JavaScript'
}

async function detectPackageManager(cwd: string): Promise<string> {
  if (await fileExists(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await fileExists(join(cwd, 'yarn.lock'))) return 'yarn'
  if (await fileExists(join(cwd, 'package-lock.json'))) return 'npm'
  return '未知'
}

function detectFramework(pkg: PackageJson): string | null {
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
  for (const hint of FRAMEWORK_HINTS) {
    if (hint.deps.some((d) => d in allDeps)) return hint.name
  }
  return null
}

function detectTestFramework(pkg: PackageJson): string | null {
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
  for (const hint of TEST_FRAMEWORKS) {
    if (hint.deps.some((d) => d in allDeps)) return hint.name
  }
  // Check scripts.test for node:test usage
  if (pkg.scripts?.test?.includes('node:test') || pkg.scripts?.test?.includes('--test')) {
    return 'node:test'
  }
  return null
}

async function detectLinters(cwd: string, pkg: PackageJson): Promise<string[]> {
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
  const found: string[] = []
  for (const linter of LINTERS) {
    const hasFile = await Promise.all(linter.files.map(f => fileExists(join(cwd, f))))
    if (hasFile.some(Boolean) || linter.deps.some((d) => d in allDeps)) {
      found.push(linter.name)
    }
  }
  return found
}

async function findEntryFiles(cwd: string): Promise<string[]> {
  const entries: string[] = []
  for (const dir of ENTRY_DIRS) {
    const base = dir ? join(cwd, dir) : cwd
    if (dir && !(await fileExists(base))) continue
    for (const name of ENTRY_FILE_NAMES) {
      for (const ext of ENTRY_EXTENSIONS) {
        const fullPath = join(base, name + ext)
        if (await fileExists(fullPath)) {
          entries.push(relativePosix(cwd, fullPath))
        }
      }
    }
  }
  return entries
}

const MAX_TEST_FILES = 50

async function findTestFiles(cwd: string): Promise<string[]> {
  const files: string[] = []

  async function walk(dir: string): Promise<void> {
    if (files.length >= MAX_TEST_FILES) return
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (isFilesystemMetadata(name)) continue
      const fullPath = join(dir, name)
      let s: Awaited<ReturnType<typeof stat>>
      try {
        s = await stat(fullPath)
      } catch {
        continue
      }
      if (s.isDirectory()) {
        if (shouldSkipBroadDiscoveryDir(cwd, fullPath, name)) continue
        await walk(fullPath)
      } else if (s.isFile()) {
        if (files.length >= MAX_TEST_FILES) return
        if (name.includes('.test.') || name.includes('.spec.') || name === '__tests__') {
          files.push(relativePosix(cwd, fullPath))
        }
      }
    }
  }

  await walk(cwd)
  return files
}

async function findConfigFiles(cwd: string): Promise<string[]> {
  const found: string[] = []
  for (const pattern of CONFIG_FILE_PATTERNS) {
    if (pattern.includes('*')) {
      try {
        const names = await readdir(cwd)
        const regexStr = pattern.replace(/\*/g, '[^.]*')
        const regex = new RegExp(`^${regexStr}$`)
        for (const name of names) {
          if (regex.test(name)) {
            found.push(name)
          }
        }
      } catch {
        // skip
      }
    } else {
      if (await fileExists(join(cwd, pattern))) {
        found.push(pattern)
      }
    }
  }
  return found
}

export const INSPECT_PROJECT_TOOL: Tool = {
  definition: {
    name: 'inspect_project',
    description: `分析当前项目并返回摘要：语言、包管理器、scripts、入口文件、测试结构与框架线索。

### 用法
- 首次进入一个项目时用 inspect_project 了解其结构
- 无需参数——作用于当前工作目录
- 返回结构化摘要，便于规划第一次编辑

### 示例
推荐：inspect_project() — 获取项目概览`,
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const cwd = params.cwd

    const pkgPath = join(cwd, 'package.json')
    if (!(await fileExists(pkgPath))) {
      return {
        content: '当前目录未找到 package.json。不是 Node.js 项目。',
        isError: true,
      }
    }

    let pkg: PackageJson
    try {
      pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as PackageJson
    } catch {
      return {
        content: '解析 package.json 失败。',
        isError: true,
      }
    }

    const [language, packageManager, linters, entryFiles, testFiles, configFiles] = await Promise.all([
      detectLanguage(cwd),
      detectPackageManager(cwd),
      detectLinters(cwd, pkg),
      findEntryFiles(cwd),
      findTestFiles(cwd),
      findConfigFiles(cwd),
    ])
    const framework = detectFramework(pkg)
    const testFramework = detectTestFramework(pkg)

    // Build output
    const lines: string[] = []
    lines.push('## 项目摘要')
    lines.push('')
    lines.push(`语言：${language}`)
    lines.push(`包管理器：${packageManager}`)
    if (framework) {
      lines.push(`框架：${framework}（从依赖检测）`)
    }
    if (testFramework) {
      lines.push(`测试框架：${testFramework}`)
    }
    if (linters.length > 0) {
      lines.push(`Linter：${linters.join(', ')}`)
    }

    // Scripts
    const keyScripts = ['build', 'test', 'lint', 'dev', 'start', 'typecheck']
    const scripts = pkg.scripts ?? {}
    const relevantScripts = keyScripts.filter((s) => s in scripts)
    if (relevantScripts.length > 0) {
      lines.push('')
      lines.push('### 脚本')
      for (const s of relevantScripts) {
        lines.push(`- ${s}: ${scripts[s]}`)
      }
    }

    // Entry files
    if (entryFiles.length > 0) {
      lines.push('')
      lines.push('### 入口文件')
      for (const f of entryFiles) {
        lines.push(`- ${f}`)
      }
    }

    // Test structure
    if (testFiles.length > 0) {
      lines.push('')
      lines.push('### 测试结构')
      for (const f of testFiles) {
        lines.push(`- ${f}`)
      }
    }

    // Config files
    if (configFiles.length > 0) {
      lines.push('')
      lines.push('### 配置文件')
      for (const f of configFiles) {
        lines.push(`- ${f}`)
      }
    }

    return { content: lines.join('\n') }
  },

  requiresApproval(): boolean {
    return false
  },

  isConcurrencySafe(): boolean {
    return true
  },

  isEnabled(): boolean {
    return true
  },
}
