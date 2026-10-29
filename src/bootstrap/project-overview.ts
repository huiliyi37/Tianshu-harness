/**
 * project-overview.ts — 新对话开场的项目全貌扫描 + .rivet.md 自动维护段（2026-10-21）。
 *
 * 全新对话（非交接续接）第一次运行前，确定性地扫一遍工作区：技术栈与命令、目录地图、
 * 入口文件、测试布局、README 摘要、最近活跃区域。结果写进 .rivet.md 里一段由标记包住的
 * 「自动维护」区——标记以外的内容（用户手写）一字不动；内容没变就不写盘。
 *
 * 设计约束：
 *  - 零模型调用：只读文件系统 + 一次异步 git log，扫描有文件数与时间上限，不阻塞事件循环
 *    （单进程 sidecar 里同步 spawn 曾导致整机卡顿，见 git-state-stamp.ts）。
 *  - 幂等：同一工作区状态重复执行结果逐字节相同；签名不变时直接跳过（不扫、不写）。
 *  - 不触碰 AGENTS.md：那是项目自己的纪律文件，只维护 .rivet.md 的自动段。
 *  - 签名状态存在用户数据目录（<RIVET_HOME>/overview/），不往项目里多放文件；.rivet.md 存在后
 *    needsTemplatesInit 自然为假，旧的「是否创建模板」提示不再出现。
 */
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { rivetHome, projectSlug } from '../config/paths.js'
import { detectProjectFingerprint, type ProjectFingerprint } from '../repo/project-fingerprint.js'
import { gitStateStamp } from '../tools/git-state-stamp.js'
import { spawnGit } from '../tools/spawn-git.js'
import { SCAN_EXCLUDE_DIRS } from '../tools/scan-excludes.js'
import { isFilesystemMetadata } from '../utils/file-metadata.js'
import { RIVET_MD_PATH } from './project-templates.js'

export const OVERVIEW_BEGIN = '<!-- tianshu:overview:begin — 由天枢自动维护，手改会在下次更新时被覆盖 -->'
export const OVERVIEW_END = '<!-- tianshu:overview:end -->'
/** 工作区还没有 .rivet.md 时新建的开头：一句说明，不放空的 Stack / Conventions 占位——
 *  这个文件每次开新对话都会读进上下文，空字段只是噪音（概况段已含技术栈与命令）。 */
export const AUTO_RIVET_MD_HEAD = '# 项目说明\n\n<!-- 天枢每次开新对话都会读取本文件。下方标记段由天枢自动维护；本项目的约定（代码风格、不能改动的目录等）写在标记段以外，天枢不会改动。 -->\n'

function stateFile(cwd: string): string { return join(rivetHome(), 'overview', `${projectSlug(cwd)}.json`) }
/** 扫描上限：文件数与目录深度。超大仓库只取前若干层的结构性信息，足够定位。 */
const MAX_FILES = 6000
const MAX_DEPTH = 6
const MAX_MODULES = 24
const MAX_TESTS_LISTED = 12
const README_CHARS = 240
const MAX_README_SECTIONS = 8
const EXTRA_SKIP = new Set(['.rivet', '.cache', 'coverage', '.venv', 'venv', '.idea', '.vscode', '.turbo', 'out', 'vendor'])

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#', '.cpp': 'C++', '.c': 'C', '.h': 'C/C++',
  '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.vue': 'Vue', '.svelte': 'Svelte', '.css': 'CSS', '.scss': 'CSS', '.html': 'HTML', '.sql': 'SQL', '.sh': 'Shell',
}
const ENTRY_NAMES = new Set(['main', 'index', 'app', 'server', 'cli', 'entry', '__main__', 'manage', 'lib'])
const TEST_RE = /(^|[\\/])(__tests__|tests?|spec)([\\/]|$)|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|^test_.*\.py$/i

export interface OverviewScan {
  files: number
  truncated: boolean
  languages: Array<{ name: string; files: number }>
  modules: Array<{ dir: string; files: number }>
  entries: string[]
  tests: { count: number; dirs: string[] }
  readme?: string
  /** README 的二级标题（文档里写了哪些主题），最多 8 个。 */
  readmeSections: string[]
  recent: string[]
  fingerprint: ProjectFingerprint
  scripts: Record<string, string>
}

/** 有界遍历：按目录层级广度优先，命中上限即停（truncated=true）。 */
async function walk(cwd: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  let queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }]
  while (queue.length > 0) {
    const next: typeof queue = []
    for (const { rel, depth } of queue) {
      let names: string[]
      try { names = (await readdir(join(cwd, rel))).sort() } catch { continue }
      for (const name of names) {
        if (isFilesystemMetadata(name)) continue
        const childRel = rel ? `${rel}/${name}` : name
        let s: Awaited<ReturnType<typeof stat>>
        try { s = await stat(join(cwd, childRel)) } catch { continue }
        if (s.isDirectory()) {
          if (SCAN_EXCLUDE_DIRS.has(name) || EXTRA_SKIP.has(name) || name.startsWith('.git')) continue
          if (depth + 1 < MAX_DEPTH) next.push({ rel: childRel, depth: depth + 1 })
        } else if (s.isFile()) {
          files.push(childRel)
          if (files.length >= MAX_FILES) return { files, truncated: true }
        }
      }
    }
    queue = next
  }
  return { files, truncated: false }
}

/** 最近 30 次提交里改得最多的顶层目录（异步 git，10s 超时；非 git 仓库返回空）。 */
function recentAreas(cwd: string): Promise<string[]> {
  return new Promise(resolve => {
    let out = ''
    let done = false
    const finish = (v: string[]) => { if (!done) { done = true; resolve(v) } }
    try {
      const child = spawnGit(['log', '-n', '30', '--name-only', '--pretty=format:'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } finish([]) }, 10_000)
      child.stdout?.on('data', (d: Buffer) => { if (out.length < 400_000) out += d.toString('utf8') })
      child.on('error', () => { clearTimeout(timer); finish([]) })
      child.on('close', code => {
        clearTimeout(timer)
        if (code !== 0) return finish([])
        const counts = new Map<string, number>()
        for (const line of out.split('\n')) {
          const f = line.trim()
          if (!f) continue
          const parts = f.split('/')
          const area = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts.length === 2 ? parts[0]! : '(根目录)'
          counts.set(area, (counts.get(area) ?? 0) + 1)
        }
        finish([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([a]) => a))
      })
    } catch { finish([]) }
  })
}

/** 按句截断：上限内最后一个句末标点处断开；整段没有句末标点才硬截并补省略号。 */
function clipSentence(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max)
  const cut = Math.max(...['。', '！', '？', '. ', '! ', '? '].map(p => head.lastIndexOf(p)))
  if (cut >= 40) return head.slice(0, cut + 1).trim()
  return `${head.replace(/[\s.。…]+$/, '')}…`
}

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, '')
/** 行内标记去掉：链接只留文字、图片整段去掉、粗体去星号；反引号保留（命令和文件名靠它认）。 */
const inlineText = (s: string): string => stripTags(s
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1'))
  .replace(/\*\*(.+?)\*\*/g, '$1')
  .replace(/\s+/g, ' ')
  .trim()
/** 标题开头的表情和符号（🚀 快速开始）去掉；目录本身不算章节。 */
const headingText = (s: string): string => inlineText(s).replace(/\s*\{#[^}]*\}$/, '').replace(/^[^\p{L}\p{N}`]+/u, '')
const TOC_HEADING = /^(目录|目錄|索引|table of contents|contents|toc)$/i
/** 只有链接、徽章和分隔符的行（语言切换、官网/文档导航条），不是项目介绍。 */
function isNavLine(line: string): boolean {
  if (!/<a\b|<img\b|\]\(/i.test(line) && !/^[·•|]|[·•|]$/.test(stripTags(line).trim())) return false
  const rest = stripTags(line
    .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ''))
  return /^[\s·•|/,\-–—]*$/.test(rest) || /^[·•|]|[·•|]$/.test(rest.trim())
}
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/
/** 段内软换行：两侧都是中日文字时直接相连，否则补一个空格（和 Markdown 渲染一致）。 */
const joinLines = (lines: string[]): string => lines.reduce((acc, l) =>
  !acc ? l : acc + (CJK.test(acc.at(-1)!) && CJK.test(l[0]!) ? '' : ' ') + l, '')

/**
 * README 摘要：标题 + 第一段说明文字（按句截断），二级标题另列成「README 章节」。
 * 整份 README 压成一行时标题、列表、命令会糊成一串，模型读不出哪句是项目介绍。
 * 居中排版的 README 常用 <h1> 和成排的徽章/导航链接，标题照认，徽章和导航行跳过。
 */
export function summarizeReadme(raw: string): { summary?: string; sections: string[] } {
  const lines = raw
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, inner: string) => {
      const text = stripTags(inner).replace(/\s+/g, ' ').trim()
      return text ? `\n${'#'.repeat(Number(n))} ${text}\n` : '\n'
    })
    .split('\n')
    .map(l => l.trim())
  let title: string | undefined
  const sections: string[] = []
  const para: string[] = []
  let paraDone = false
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line)
    // Setext 标题：上一行是单行「段落」，这一行全是 = 或 -。
    const setext = /^(={3,}|-{3,})$/.test(line) && para.length === 1 && !paraDone ? (line[0] === '=' ? 1 : 2) : 0
    const rawHeading = heading?.[2] ?? (setext ? para.pop() : undefined)
    const text = rawHeading === undefined ? undefined : headingText(rawHeading)
    const level = heading ? heading[1]!.length : setext
    if (text !== undefined) {
      if (level === 1 && !title && text) title = text
      else if (level === 2 && text && !TOC_HEADING.test(text) && sections.length < MAX_README_SECTIONS) sections.push(text)
      if (para.length > 0) paraDone = true
      continue
    }
    const quoted = line.replace(/^>\s?/, '')
    const prose = isNavLine(quoted) ? '' : inlineText(quoted)
    if (!prose || /^[-=*_]{3,}$|^\||^[-*+]\s|^\d+[.)]\s|^\[[^\]]+\]:\s/.test(prose)) {
      if (para.length > 0) paraDone = true
      continue
    }
    if (!paraDone) para.push(prose)
  }
  const first = joinLines(para).replace(/\s+/g, ' ').trim()
  const lead = first ? clipSentence(first, README_CHARS) : ''
  const summary = title && lead ? `${title} — ${lead}` : (title ?? (lead || undefined))
  return { summary, sections }
}

async function readReadme(cwd: string): Promise<{ summary?: string; sections: string[] }> {
  for (const name of ['README.md', 'README.zh-CN.md', 'README', 'readme.md', 'README.rst', 'README.txt']) {
    try {
      const parsed = summarizeReadme(await readFile(join(cwd, name), 'utf8'))
      if (parsed.summary || parsed.sections.length > 0) return parsed
    } catch { /* try next */ }
  }
  return { sections: [] }
}

function readScripts(cwd: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
    const out: Record<string, string> = {}
    for (const key of ['dev', 'start', 'build', 'test', 'lint', 'typecheck', 'check']) {
      const v = pkg.scripts?.[key]
      if (typeof v === 'string' && v.trim()) out[key] = v.trim()
    }
    return out
  } catch { return {} }
}

export async function scanProjectOverview(cwd: string): Promise<OverviewScan> {
  const [{ files, truncated }, recent, readme] = await Promise.all([walk(cwd), recentAreas(cwd), readReadme(cwd)])
  const langCount = new Map<string, number>()
  const moduleCount = new Map<string, number>()
  const entries: string[] = []
  const testFiles: string[] = []
  const testDirs = new Map<string, number>()
  for (const f of files) {
    const lang = LANG_BY_EXT[extname(f).toLowerCase()]
    if (lang) langCount.set(lang, (langCount.get(lang) ?? 0) + 1)
    const parts = f.split('/')
    const mod = parts.length >= 3 && ['src', 'lib', 'packages', 'apps', 'app', 'crates', 'internal', 'pkg', 'cmd'].includes(parts[0]!)
      ? `${parts[0]}/${parts[1]}`
      : parts.length >= 2 ? parts[0]! : undefined
    if (mod) moduleCount.set(mod, (moduleCount.get(mod) ?? 0) + 1)
    const base = parts[parts.length - 1]!.replace(/\.[^.]+$/, '')
    if (parts.length <= 3 && ENTRY_NAMES.has(base) && lang && !TEST_RE.test(f)) entries.push(f)
    if (TEST_RE.test(f) && lang) {
      testFiles.push(f)
      const dir = parts.slice(0, -1).join('/') || '(根目录)'
      testDirs.set(dir, (testDirs.get(dir) ?? 0) + 1)
    }
  }
  return {
    files: files.length,
    truncated,
    languages: [...langCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([name, n]) => ({ name, files: n })),
    modules: [...moduleCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_MODULES).sort((a, b) => a[0].localeCompare(b[0])).map(([dir, n]) => ({ dir, files: n })),
    entries: entries.sort().slice(0, 10),
    tests: { count: testFiles.length, dirs: [...testDirs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_TESTS_LISTED).map(([d]) => d) },
    readme: readme.summary,
    readmeSections: readme.sections,
    recent,
    fingerprint: detectProjectFingerprint(cwd),
    scripts: readScripts(cwd),
  }
}

/** 渲染自动维护段（不含首尾标记）。只写事实，不写推测。 */
export function renderOverview(scan: OverviewScan): string {
  const lines: string[] = ['## 项目概况（自动维护）', '']
  if (scan.readme) lines.push(`简介：${scan.readme}`, '')
  const langs = scan.languages.map(l => `${l.name} ${l.files}`).join('、')
  lines.push(`- 规模：${scan.files}${scan.truncated ? '+' : ''} 个文件${langs ? `；语言（文件数）：${langs}` : ''}`)
  const fp = scan.fingerprint
  const cmds: string[] = []
  for (const [k, v] of Object.entries(scan.scripts)) cmds.push(`${k} → \`${v}\``)
  if (cmds.length === 0) {
    if (fp.buildCommand) cmds.push(`构建 → \`${fp.buildCommand}\``)
    if (fp.testCommand && fp.hasTestInfra) cmds.push(`测试 → \`${fp.testCommand}\``)
  }
  if (cmds.length > 0) lines.push(`- 常用命令：${cmds.join('；')}`)
  if (scan.entries.length > 0) lines.push(`- 入口：${scan.entries.map(e => `\`${e}\``).join('、')}`)
  lines.push(scan.tests.count > 0
    ? `- 测试：${scan.tests.count} 个测试文件，主要在 ${scan.tests.dirs.slice(0, 6).map(d => `\`${d}\``).join('、')}`
    : '- 测试：未发现测试文件')
  if (scan.recent.length > 0) lines.push(`- 最近活跃：${scan.recent.map(r => `\`${r}\``).join('、')}`)
  if (scan.readmeSections.length > 0) lines.push(`- README 章节：${scan.readmeSections.join('、')}`)
  if (scan.modules.length > 0) {
    lines.push('', '### 目录地图', '')
    for (const m of scan.modules) lines.push(`- \`${m.dir}/\` — ${m.files} 个文件`)
  }
  return lines.join('\n')
}

/** 把自动段写进 .rivet.md 正文：已有标记段则原位替换，否则追加在末尾。标记外内容不动。 */
export function upsertOverviewSection(body: string, section: string): string {
  const block = `${OVERVIEW_BEGIN}\n${section}\n${OVERVIEW_END}`
  const begin = body.indexOf(OVERVIEW_BEGIN)
  const end = body.indexOf(OVERVIEW_END)
  if (begin >= 0 && end > begin) return body.slice(0, begin) + block + body.slice(end + OVERVIEW_END.length)
  return `${body.trimEnd()}\n\n${block}\n`
}

/** 便宜的变化签名：git 状态戳 + 顶层目录项与清单文件的 mtime。不变就不扫。 */
export function overviewSignature(cwd: string): string {
  const parts: string[] = [gitStateStamp(cwd) ?? 'nogit']
  try {
    for (const name of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'README.md', '.']) {
      try { parts.push(`${name}:${statSync(join(cwd, name)).mtimeMs}`) } catch { parts.push(`${name}:-`) }
    }
  } catch { /* keep partial */ }
  return parts.join('|')
}

function readState(cwd: string): { signature?: string; section?: string } {
  try { return JSON.parse(readFileSync(stateFile(cwd), 'utf8')) as { signature?: string; section?: string } } catch { return {} }
}

/**
 * 天枢自己生成的项目概况（取自用户数据目录里的副本，而非仓库内的 .rivet.md）。
 * 未授信项目的 .rivet.md 不进上下文（仓库内容可被他人篡改，含伪造的自动段标记），
 * 但这份副本是本机扫描的产物，可以安全注入——未授信项目也能拿到项目全貌。
 */
export function ownProjectOverview(cwd: string): string | undefined {
  const section = readState(cwd).section
  return section ? `${OVERVIEW_BEGIN}
${section}
${OVERVIEW_END}` : undefined
}

/** 像项目的目录才扫：有 git 仓库或常见清单文件。临时目录 / 家目录这类不扫，也不往里写 .rivet.md。 */
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'CMakeLists.txt', 'Makefile', '.rivet.md', 'AGENTS.md']
export function looksLikeProject(cwd: string): boolean {
  return PROJECT_MARKERS.some(m => existsSync(join(cwd, m)))
}

/** 同步、便宜：像项目的工作区、且概况缺失或已过期时为真（调用方据此决定是否值得等扫描）。 */
export function overviewNeedsRefresh(cwd: string): boolean {
  try {
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory() || !looksLikeProject(cwd)) return false
    if (!existsSync(join(cwd, RIVET_MD_PATH))) return true
    return readState(cwd).signature !== overviewSignature(cwd)
  } catch { return false }
}

export interface RefreshResult { status: 'written' | 'unchanged' | 'skipped'; reason?: string }

const inflight = new Map<string, Promise<RefreshResult>>()

/**
 * 刷新工作区的项目概况段。并发安全：同一 cwd 同时只跑一份。失败一律吞掉返回 skipped——
 * 这是锦上添花的上下文，绝不阻断会话。
 */
export function refreshProjectOverview(cwd: string, opts: { force?: boolean } = {}): Promise<RefreshResult> {
  const running = inflight.get(cwd)
  if (running) return running
  const job = (async (): Promise<RefreshResult> => {
    try {
      if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) return { status: 'skipped', reason: 'no-workspace' }
      if (!looksLikeProject(cwd)) return { status: 'skipped', reason: 'not-a-project' }
      const signature = overviewSignature(cwd)
      const rivetPath = join(cwd, RIVET_MD_PATH)
      if (!opts.force && existsSync(rivetPath) && readState(cwd).signature === signature) return { status: 'unchanged' }
      const scan = await scanProjectOverview(cwd)
      const current = existsSync(rivetPath) ? readFileSync(rivetPath, 'utf8') : AUTO_RIVET_MD_HEAD
      const section = renderOverview(scan)
      const next = upsertOverviewSection(current, section)
      const unchanged = next === current && existsSync(rivetPath)
      if (!unchanged) writeFileSync(rivetPath, next, 'utf8')
      // 签名在写盘之后计算：.rivet.md 的写入会改变工作区目录的 mtime，按写后状态记，下次才判得出「没变」。
      mkdirSync(join(rivetHome(), 'overview'), { recursive: true })
      writeFileSync(stateFile(cwd), JSON.stringify({ signature: overviewSignature(cwd), updatedAt: new Date().toISOString(), section }) + '\n', 'utf8')
      return { status: unchanged ? 'unchanged' : 'written' }
    } catch (e) {
      return { status: 'skipped', reason: e instanceof Error ? e.message : String(e) }
    } finally {
      inflight.delete(cwd)
    }
  })()
  inflight.set(cwd, job)
  return job
}
