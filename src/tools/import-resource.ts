import { stat, lstat, symlink, mkdir, cp, readFile, rm, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve, extname, sep } from 'path'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ArtifactStore } from '../artifact/store.js'
import { expandHome } from '../platform.js'
import { relativePosix } from '../path-format.js'
import { httpFetchGuarded, type HttpFetchResult } from './net/http-fetch.js'

type HttpFetchFn = (url: string, ...rest: unknown[]) => Promise<HttpFetchResult>
let httpFetchForTests: HttpFetchFn | null = null

/** @internal 测试注入点——生产路径保持 null。 */
export function setHttpFetchForTests(fn: HttpFetchFn | null): void {
  httpFetchForTests = fn
}
import { extractDocumentText, isExtractableDocument, EXTRACTION_CAVEAT } from './doc-extract.js'
import { cloneWithFallback } from './github-mirror-fallback.js'
import { loadConfig } from '../config/manager.js'

const IMPORT_DIR = '.rivet/external'
const PREVIEW_BYTES = 4000

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonl', '.json5',
  '.md', '.mdx', '.txt', '.rst', '.adoc',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.scala', '.c', '.cpp', '.h', '.hpp',
  '.sh', '.bash', '.zsh', '.fish',
  '.css', '.scss', '.less', '.html', '.htm', '.svg',
  '.xml', '.csv', '.tsv',
  '.sql', '.graphql', '.proto',
  '.lock', '.log',
  '.patch', '.diff',
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico'])

function isTextFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  if (TEXT_EXTENSIONS.has(ext)) return true
  const name = basename(filePath).toLowerCase()
  return ['makefile', 'dockerfile', 'license', 'readme', 'changelog', '.gitignore', '.npmrc'].includes(name)
}

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase())
}

/** Parse a GitHub URL into owner/repo and optional subpath. */
export function parseGitHubUrl(url: string): { owner: string; repo: string; subpath?: string; ref?: string } | null {
  const cleaned = url.replace(/^https?:\/\//, '').replace(/\.git$/, '')
  const match = cleaned.match(/^github\.com\/([^/]+)\/([^/]+?)(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?$/)
  if (!match) return null
  const [, owner, repo, , ref, subpath] = match
  if (!owner || !repo) return null
  return { owner, repo, ref: ref ?? undefined, subpath: subpath || undefined }
}

/** Validate a git ref (branch/tag/commit) supplied by the model/URL before it
 *  reaches `git clone --branch` / `git checkout`. The refs are passed as
 *  `execFile` args (no shell), so the real risk is git *option injection*: a
 *  ref like `--upload-pack=…` would be parsed as an option. Reject anything
 *  starting with `-`, plus whitespace/control and the characters git itself
 *  forbids in ref names (`~^:?*[\`). Returns true when the ref is safe. */
export function isSafeGitRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > 255) return false
  if (ref.startsWith('-')) return false
  if (/[\s\x00-\x1f\x7f~^:?*[\\]/.test(ref)) return false
  return true
}

async function ensureImportDir(cwd: string): Promise<string> {
  const dir = join(cwd, IMPORT_DIR)
  await mkdir(dir, { recursive: true })
  return dir
}

function simpleHash(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Generate target name preserving file extension: `name-hash.ext` */
function importTargetName(source: string): string {
  const raw = basename(source).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
  const ext = extname(raw)
  const base = ext ? raw.slice(0, -ext.length) : raw
  const hash = simpleHash(source).toString(36)
  return ext ? `${base}-${hash}${ext}` : `${raw}-${hash}`
}

async function buildResult(
  source: string,
  localPath: string,
  cwd: string,
  stats: { type: 'file' | 'directory'; size?: number; files?: number },
  artifactStore?: ArtifactStore,
): Promise<{ content: string; uiContent: string }> {
  const relPath = relativePosix(cwd, localPath)
  let header = `已导入：${source}\n本地路径：${relPath}\n类型：${stats.type}`
  if (stats.size !== undefined) header += `\n大小：${(stats.size / 1024).toFixed(1)} KB`
  if (stats.files !== undefined) header += `\n文件数：约 ${stats.files}`

  let preview = ''
  if (stats.type === 'file' && isTextFile(localPath)) {
    try {
      const content = await readFile(localPath, 'utf-8')
      preview = content.length > PREVIEW_BYTES
        ? `\n\n── 预览（前 ${PREVIEW_BYTES} 字符）──\n${content.slice(0, PREVIEW_BYTES)}\n...（共 ${content.length} 字符）`
        : `\n\n── 内容 ──\n${content}`
    } catch { /* binary / unreadable */ }
  } else if (stats.type === 'file' && isExtractableDocument(localPath)) {
    // Binary office document (PDF/DOCX/PPTX/…) — extract text via system
    // toolchains so the content is usable as context, not just a blob on disk.
    // Fail-open: extraction failure keeps the import and surfaces install advice.
    const extraction = await extractDocumentText(localPath)
    if (extraction.ok) {
      const marked = `${EXTRACTION_CAVEAT}\n\n${extraction.text}`
      let artifactNote = ''
      if (artifactStore) {
        try {
          const artifactId = await artifactStore.save({
            tool: 'import_resource',
            target: source,
            rawContent: marked,
            summary: `从 ${basename(localPath)} 抽取文本（${extraction.engine}）— ${extraction.text.length} 字符`,
            sections: [],
          })
          artifactNote = `\n完整抽取文本：read_section(artifactId="${artifactId}")\n[artifact:${artifactId}]`
        } catch { /* artifact persistence is best-effort */ }
      }
      const truncated = extraction.text.length > PREVIEW_BYTES
      const body = truncated
        ? `${extraction.text.slice(0, PREVIEW_BYTES)}\n...（共 ${extraction.text.length} 字符）`
        : extraction.text
      preview = `\n\n── 抽取文本（引擎：${extraction.engine}）──\n${EXTRACTION_CAVEAT}\n${body}${artifactNote}`
    } else {
      preview = `\n\n（已导入二进制文档。${extraction.suggestion}）`
    }
  } else if (stats.type === 'file' && isImageFile(localPath)) {
    preview = '\n\n（图片文件——已导入但无法以文本查看。可用 file_info 查看元数据。）'
  }

  return {
    uiContent: header + preview,
    content: `${header}${preview}\n\n该资源现可通过项目内路径访问：${relPath}\n请使用 read_file、grep、glob 配合此路径。`,
  }
}

export const IMPORT_RESOURCE_TOOL: Tool = {
  definition: {
    name: 'import_resource',
    description:
      '把外部资源导入项目工作区，供其他工具访问。' +
      '\n\n支持：' +
      '\n- 本地文件路径（绝对路径）：/tmp/design.png, ~/Desktop/spec.pdf' +
      '\n- 本地目录：/path/to/external/project' +
      '\n- GitHub 仓库：github.com/user/repo, https://github.com/user/repo' +
      '\n- HTTP/HTTPS URL：下载对应内容' +
      '\n\n导入后，资源位于项目内的 .rivet/external/ 路径下。' +
      '\n其他工具（read_file、grep、glob）即可正常访问。' +
      '\n因会访问项目外部资源，需要审批。',
    input_schema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: '要导入的资源。可以是本地绝对路径、GitHub URL 或 HTTP/HTTPS URL。',
        },
        ref: {
          type: 'string',
          description: 'GitHub 仓库专用：要检出的 branch、tag 或 commit。默认使用默认分支。',
        },
      },
      required: ['source'],
    },
  },

  async execute(params: ToolCallParams) {
    const rawSource = (params.input.source as string)?.trim()
    if (!rawSource) return { content: '错误：source 为必填项', isError: true }

    const importDir = await ensureImportDir(params.cwd)

    const gh = parseGitHubUrl(rawSource)
    if (gh) return await handleGitHubImport(params.cwd, importDir, gh, params.input.ref as string | undefined)

    if (/^https?:\/\//i.test(rawSource)) return await handleUrlImport(params.cwd, importDir, rawSource, params.artifactStore)

    return handleLocalImport(params.cwd, importDir, rawSource, params.artifactStore)
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

async function handleLocalImport(cwd: string, importDir: string, source: string, artifactStore?: ArtifactStore): Promise<{ content: string; uiContent: string; isError?: boolean }> {
  const expanded = expandHome(source)
  const resolved = resolve(expanded)

  try {
    await lstat(resolved)
  } catch {
    return { content: `错误：路径不存在：${resolved}`, isError: true, uiContent: `未找到：${resolved}` }
  }

  const ls = await lstat(resolved)
  const targetName = importTargetName(resolved)
  const targetPath = join(importDir, targetName)

  try { await rm(targetPath, { recursive: true, force: true }) } catch { /* not existing is fine */ }

  if (ls.isDirectory()) {
    await symlink(resolved, targetPath, 'junction')
    const result = await buildResult(source, targetPath, cwd, { type: 'directory', files: await countFiles(resolved, 3) })
    return { ...result, content: result.content + '\n\n（以 junction 链接——未复制到磁盘）' }
  }

  try {
    await symlink(resolved, targetPath, 'file')
  } catch {
    await cp(resolved, targetPath, { force: true })
  }

  return await buildResult(source, targetPath, cwd, { type: 'file', size: (await stat(resolved)).size }, artifactStore)
}

async function handleGitHubImport(
  cwd: string,
  importDir: string,
  gh: { owner: string; repo: string; ref?: string; subpath?: string },
  explicitRef?: string,
): Promise<Pick<ToolResult, 'content' | 'uiContent' | 'isError' | 'errorKind'>> {
  const ref = explicitRef ?? gh.ref
  if (ref !== undefined && !isSafeGitRef(ref)) {
    return {
      content: `错误：无效的 git ref "${ref}"。branch/tag/commit 不得以 "-" 开头，也不得包含空白或控制字符。`,
      isError: true,
      uiContent: `无效 ref：${ref}`,
    }
  }
  const repoUrl = `https://github.com/${gh.owner}/${gh.repo}.git`
  const targetName = importTargetName(`${gh.owner}/${gh.repo}`)
  const targetPath = join(importDir, targetName)
  let mirrorNotice: string | undefined

  const execAsync = (cmd: string, args: string[], opts: { cwd?: string; timeout: number }) =>
    new Promise<void>((resolveExec, reject) => {
      execFile(cmd, args, { ...opts, windowsHide: true }, (err) => err ? reject(err) : resolveExec())
    })

  if (existsSync(join(targetPath, '.git'))) {
    try { await execAsync('git', ['pull', '--ff-only'], { cwd: targetPath, timeout: 30_000 }) } catch { /* offline */ }
  } else {
    try { await rm(targetPath, { recursive: true, force: true }) } catch { /* not existing is fine */ }
    try {
      const mirrorConfig = loadConfig({ cwd }).mirrors
      const decision = await cloneWithFallback({
        originalUrl: repoUrl,
        config: mirrorConfig,
        cwd,
        cloneFn: async (url, timeoutMs) => {
          const args = ['clone', '--depth', '1']
          if (ref) args.push('--branch', ref)
          args.push('--', url, targetPath)
          await execAsync('git', args, { timeout: timeoutMs })
        },
        fallbackTimeoutMs: mirrorConfig.fallbackTimeoutSec * 1000,
        fallbackMemoryMinutes: mirrorConfig.fallbackMemoryMinutes,
      })
      if (decision.reason !== 'direct' && decision.mirrorId) {
        const mirrorName = decision.mirrorId
        mirrorNotice = `[mirror] 已通过 ${mirrorName} 镜像拉取（直连失败）`
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        return { content: `错误：未安装 git 或不在 PATH 中——无法 clone ${repoUrl}。请安装 git 后重试。`, isError: true, uiContent: `未找到 git`, errorKind: 'missing_dep' }
      }
      const msg = err instanceof Error ? err.message : String(err)
      // ENOENT might be buried in the aggregate error message
      if (msg.includes('ENOENT')) {
        return { content: `错误：未安装 git 或不在 PATH 中——无法 clone ${repoUrl}。请安装 git 后重试。`, isError: true, uiContent: `未找到 git`, errorKind: 'missing_dep' }
      }
      return { content: `clone ${repoUrl} 时出错：${msg}`, isError: true, uiContent: `克隆失败：${gh.owner}/${gh.repo}` }
    }
  }

  if (ref && existsSync(join(targetPath, '.git'))) {
    // ref is validated (no leading `-`); trailing `--` disambiguates it from any
    // pathspec so git treats it strictly as a revision.
    try { await execAsync('git', ['checkout', ref, '--'], { cwd: targetPath, timeout: 10_000 }) } catch { /* shallow */ }
  }

  const effectivePath = gh.subpath ? join(targetPath, gh.subpath) : targetPath

  // 路径穿越防护：GitHub URL 的 subpath 由模型/用户构造，可能含 `..` 越过
  // targetPath（如 `blob/main/../../etc/passwd`）。必须与文件工具同款容器内约束，
  // 拒绝任何逃出 targetPath 的解析结果，避免读工作区外任意文件。
  if (gh.subpath) {
    const resolvedTarget = resolve(targetPath)
    const resolvedEff = resolve(effectivePath)
    const within = resolvedEff === resolvedTarget || resolvedEff.startsWith(resolvedTarget + sep)
    if (!within) {
      return { content: `错误：子路径 '${gh.subpath}' 试图越出仓库目录，已拒绝。`, isError: true, uiContent: `非法子路径` }
    }
  }

  if (gh.subpath && !existsSync(effectivePath)) {
    return { content: `错误：在 ${gh.owner}/${gh.repo} 中未找到子路径 '${gh.subpath}'`, isError: true, uiContent: `未找到子路径：${gh.subpath}` }
  }

  let ls: Awaited<ReturnType<typeof lstat>> | undefined
  if (existsSync(effectivePath)) {
    try { ls = await lstat(effectivePath) } catch { /* ignore */ }
  }
  const result = await buildResult(
    `github.com/${gh.owner}/${gh.repo}${gh.subpath ? `/${gh.subpath}` : ''}`,
    effectivePath,
    cwd,
    { type: ls?.isDirectory() ? 'directory' : ls?.isFile() ? 'file' : 'directory', files: await countFiles(targetPath, 3) },
  )
  if (mirrorNotice) {
    result.content = `${mirrorNotice}\n${result.content}`
  }
  return result
}

async function handleUrlImport(cwd: string, importDir: string, url: string, artifactStore?: ArtifactStore): Promise<{ content: string; uiContent: string; isError?: boolean }> {
  let filename: string
  try {
    const parsed = new URL(url)
    filename = basename(parsed.pathname) || 'downloaded-content'
  } catch { filename = 'downloaded-content' }

  const targetName = importTargetName(url) + '_' + filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const targetPath = join(importDir, targetName)

  try {
    const fetchFn = httpFetchForTests ?? httpFetchGuarded
    const { status, bytes } = await fetchFn(url, undefined, { timeoutMs: 60_000 })
    if (status >= 400) {
      return { content: `下载 ${url} 时出错：HTTP ${status}`, isError: true, uiContent: `下载失败：${url}` }
    }
    if (bytes.length === 0) {
      return { content: `错误：从 ${url} 下载得到空文件`, isError: true, uiContent: `空下载：${url}` }
    }
    await writeFile(targetPath, bytes)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: `下载 ${url} 时出错：${msg}`, isError: true, uiContent: `下载失败：${url}` }
  }

  let s: Awaited<ReturnType<typeof stat>>
  try {
    s = await stat(targetPath)
  } catch {
    return { content: `错误：从 ${url} 下载得到空文件`, isError: true, uiContent: `空下载：${url}` }
  }
  if (s.size === 0) {
    return { content: `错误：从 ${url} 下载得到空文件`, isError: true, uiContent: `空下载：${url}` }
  }

  return await buildResult(url, targetPath, cwd, { type: 'file', size: s.size }, artifactStore)
}

async function countFiles(dir: string, maxDepth: number): Promise<number> {
  if (maxDepth <= 0) return 1
  try {
    let count = 0
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      count += entry.isDirectory() ? await countFiles(join(dir, entry.name), maxDepth - 1) : 1
    }
    return count
  } catch { return 1 }
}
