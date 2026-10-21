import { realpathSync } from 'fs'
import { execFileSync } from 'child_process'
import { GIT_GLOBAL_OPTS_SRC } from './destructive-patterns.js'

/**
 * 敏感文件检测 — fail-closed 工具层拦截。
 *
 * prompt 约束（AGENTS.md Agent 安全保护，硬闸门）：
 *   不 cat/read/commit .env、credentials.*、*private*key*、*token*、*secret* 等文件。
 *   发现此类文件出现在 git add 或工具输出中时，立即警告用户并中止。
 *
 * 集成现状：validatePathSafe 对原始输入 + resolve + realpath 规范形逐一过本检测
 * （path-validate.ts）；bash.requiresApproval / assessToolRisk / git commit 暂存路径
 * 经 detectSensitiveGitAdd / detectSensitiveFile 走同一门禁。运行时 fail-closed，
 * prompt 约束（AGENTS.md Agent 安全保护，硬闸门）是第一层，这里是第二层。
 *
 * 设计：fail-closed（拒绝并解释），不是 advisory 软提醒。
 *
 * 正则来源（匹配的真实文件名模式）：
 *   `.env` → 项目根目录常见环境变量文件
 *   `credentials.json` / `credentials.yaml` → 云服务凭证
 *   `id_rsa` / `id_ed25519` → SSH 私钥
 *   `*.pem` / `*.key` → TLS/SSL 私钥
 *   `.npmrc` → npm auth token（_authToken=）
 * *   `.pypirc` → PyPI 凭证
 *
 * 白名单（不拦截）：
 *   `.env.example` / `.env.template` / `.env.sample` → 模板文件，无真实凭证
 *   `*.test.ts` / `*.spec.ts` → 测试源码
 *   文档（.md）——不含真实凭证形态的说明文字
 *   合法源码文件（如 auth/token-manager.ts）——按扩展名区分（.ts/.js 不拦截）
 *
 * 注意（2026-09 收紧）：原 `scripts/`、`fixtures/` 目录白名单已移除——目录白名单
 * 会让 scripts/.env、fixtures/credentials.json 等真实凭证形态被整目录放行。
 * fail-closed 优先：该类文件名无论位于哪个目录都拦；凭证生成脚本（gen-creds.ts）
 * 本就不匹配敏感模式，无需目录白名单。
 */

/** 敏感文件名模式 */
const SENSITIVE_FILE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // .env（但不是 .env.example/.template/.sample）
  // 来源：项目根目录 .env 文件，含 API_KEY/DATABASE_URL 等真实凭证
  // 匹配 `.env` 文件本身和 `.env.local` / `.env.production` 等变体
  // 排除 `.env.example` / `.env.template` / `.env.sample`（白名单）
  {
    name: '.env (real)',
    // 后缀可叠加：Next.js/Vite/dotenv-flow 的标准形态 `.env.production.local` /
    // `.env.development.local` / `.env.test.local` 都是真实凭证文件；旧正则只容 0–1 段后缀，
    // 这些形态全部漏判（read_file/export_file/git 暂存门同时失明）。
    re: /\.env(?:\.(?:local|production|prod|staging|development|dev|test|ci))*$/,
  },
  // credentials 文件
  // 来源：credentials.json / credentials.yaml / service-account-credentials.json
  {
    name: 'credentials file',
    re: /(^|\/)credentials\.(?:json|yaml|yml|xml|ini|conf)$/,
  },
  // 私钥文件
  // 来源：id_rsa / id_ed25519 / id_ecdsa — SSH 私钥命名约定
  {
    name: 'SSH private key',
    re: /(^|\/)id_(?:rsa|ed25519|ecdsa|dsa)$/,
  },
  // PKI 私钥
  // 来源：*.pem / *.key — TLS/SSL 私钥通用扩展名
  {
    name: 'PKI private key (.pem/.key)',
    re: /\.(?:pem|key)$/,
  },
  // npm/PyPI 凭证文件
  // 来源：.npmrc 含 _authToken= / .pypirc 含密码
  {
    name: 'package manager credentials',
    re: /(^|\/)(?:\.npmrc|\.pypirc)$/,
  },
  // 通用 secret/token 文件名
  // 来源：secrets.json / tokens.json / auth-tokens.json 等
  // 注意：只匹配 .json/.yaml/.yml/.ini 扩展名，不匹配 .ts/.js（合法源码不拦截）
  {
    name: 'secrets/token file',
    re: /(^|\/)(?:secret[s]?|token[s]?|auth[_-]?token[s]?)\.(?:json|yaml|yml|ini|env)$/,
  },
  // 无扩展名 credentials（basename 精确匹配）——~/.cargo/credentials、~/.gem/credentials
  // 等包管理器/云 CLI 的落盘凭证。带扩展名的源码（credentials.ts）不受影响；
  // 仓库里真叫 credentials 的文件会被拦截读取，与 SECURITY.md 声明的意图一致。
  {
    name: 'credentials (extensionless)',
    re: /(^|\/)credentials$/,
  },
  // .netrc（FTP/HTTP 明文凭证）/ .git-credentials（git credential store 明文 PAT）
  {
    name: '.netrc / .git-credentials',
    re: /(^|\/)(?:\.netrc|\.git-credentials)$/,
  },
  // Android debug.keystore——APK 签名密钥（发布签名身份的调试对映物）
  {
    name: 'Android debug keystore',
    re: /(^|\/)debug\.keystore$/,
  },
]

/** 白名单模式——这些路径即使匹配敏感模式也不拦截 */
const WHITELIST_PATTERNS: RegExp[] = [
  // .env 模板文件（无真实凭证）
  /\.env\.(?:example|template|sample)$/,
  // 测试文件
  /\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/,
  // 文档
  /\.md$/,
]

export interface SensitiveFileResult {
  sensitive: boolean
  patternName?: string
  path: string
}

/** 匹配前归一化：反斜杠→正斜杠（Windows 分隔符统一可比）、小写化（大小写不敏感）、
 *  剥 NTFS 数据流后缀。 */
function normalizeForMatch(inputPath: string): string {
  return stripNtfsStreams(inputPath.replace(/\\/g, '/').toLowerCase())
}

/** 剥每段路径里的 NTFS 备用数据流后缀：`.env::$DATA`、`.env:stream:$DATA` 在 Win32
 *  上打开的就是 `.env`（`::$DATA` 即默认数据流），而 `$` 结尾的敏感正则全部落空——
 *  `read_file('.env::$DATA')` 曾原样读出凭据，realpath 也保留该后缀，各形态都救不回。
 *  盘符段（`c:`）不动。POSIX 上冒号是合法文件名字符，剥掉只影响匹配（宁可多拦）。 */
function stripNtfsStreams(p: string): string {
  return p.split('/').map((seg, i) => (i === 0 && /^[a-z]:$/.test(seg)) ? seg : seg.replace(/:.*$/, '')).join('/')
}

/** 剥尾部空白/点/分隔符：`.env/`、`.env.`、`.env ` 都是 `.env` 的可寻址形态
 * （Win32 打开文件时自动剥掉尾部点与空格，POSIX 忽略尾部分隔符）。只影响匹配。 */
function stripTrailingArtifacts(p: string): string {
  return p.replace(/[\s./]+$/, '')
}

/**
 * 检测路径是否为敏感文件。
 * @param inputPath 输入路径（相对或绝对）；匹配在归一化形式上进行（分隔符统一、
 *   小写、剥尾部修饰），返回值中的 path 保持原样
 * @returns 是否敏感 + 匹配的模式名
 */
export function detectSensitiveFile(inputPath: string): SensitiveFileResult {
  const normalized = normalizeForMatch(inputPath)
  const stripped = stripTrailingArtifacts(normalized)
  // 先检查白名单——白名单优先。归一化与剥尾两种形态都放行：`fixtures/` 目录白名单
  // 依赖尾部斜杠，剥尾后不能反而失去白名单资格。
  for (const re of WHITELIST_PATTERNS) {
    if (re.test(normalized) || re.test(stripped)) return { sensitive: false, path: inputPath }
  }

  for (const { name, re } of SENSITIVE_FILE_PATTERNS) {
    if (re.test(stripped)) {
      return { sensitive: true, patternName: name, path: inputPath }
    }
  }

  return { sensitive: false, path: inputPath }
}

/**
 * detectSensitiveFile + 磁盘规范名复查：文件存在时再用 realpathSync.native 取其
 * 真实长名（展开 Windows 8.3 短名 ENV~1 → .env、CREDEN~1.JSO → credentials.json，
 * 并解析符号链接）再匹配一次。给只拿到裸路径、不经 validatePathSafe 的读路径用
 * （import_resource 本地导入、export_file source_path）。返回 path 保持原输入。
 */
export function detectSensitiveFileOnDisk(inputPath: string): SensitiveFileResult {
  const direct = detectSensitiveFile(inputPath)
  if (direct.sensitive) return direct
  let canonical: string
  try {
    canonical = realpathSync.native(inputPath)
  } catch {
    return direct
  }
  const viaDisk = detectSensitiveFile(canonical)
  return viaDisk.sensitive ? { ...viaDisk, path: inputPath } : direct
}

/**
 * 聚合形态哨兵——`git add .` / `-A` / `--all` 时被暂存的文件无法从命令文本
 * 静态枚举，检测器返回该标记项，由调用方决定处置（审批门 / 风险理由）。
 * 与具体敏感文件名区分开，便于调用方分别措辞。
 */
export const AGGREGATE_ADD_MARKER = '__aggregate_add__'

/**
 * 检测 bash 命令文本中是否包含 git add 敏感文件的操作。
 *
 * 正则来源：匹配 `git add .env` / `git add credentials.json` 等
 * 从命令文本中提取 git add 的参数，检查是否含敏感文件名。
 *
 * 聚合形态（`.`、`./`、`-A`、`--all`）无法静态核验缓存的文件 → 返回
 * [AGGREGATE_ADD_MARKER]。调用方应视为需要人工确认（fail-closed）。
 *
 * @returns 匹配到的敏感文件名数组 + 可能的聚合哨兵项（可能为空）
 */
/**
 * 无法静态枚举暂存内容的参数：工作树根（`.` / `./` / Windows `.\`）、全部（-A/--all）、
 * 已跟踪全部（-u/--update）、pathspec 通配 `*` 与仓库根魔法 pathspec `:/` / `:`。
 */
const AGGREGATE_ARGS = new Set(['.', './', '.\\', '*', ':/', ':', '-A', '-a', '--all', '-u', '--update'])

function stripQuotes(arg: string): string {
  return arg.replace(/^(['"`])(.*)\1$/, '$2')
}

export function detectSensitiveGitAdd(command: string): string[] {
  // 匹配 `git add <file>` — 提取文件参数（PowerShell/cmd 命令名不区分大小写 → /gi）
  // 来源：prompt security 段 "发现此类文件出现在 git add 中时中止"
  // `git -C <dir> add` / `git -c k=v add` 等全局选项形态同样是暂存命令，一并捕获；
  // 语法与 clear 门 / 审批门同源（GIT_GLOBAL_OPTS_SRC，含紧贴与空格分隔值形态）。
  const gitAddRe = new RegExp(String.raw`\bgit${GIT_GLOBAL_OPTS_SRC}\s+add\s+(.+)`, 'gi')
  const sensitiveFiles: string[] = []
  let sawAggregate = false

  let match: RegExpExecArray | null
  while ((match = gitAddRe.exec(command)) !== null) {
    const args = match[1]!.trim()
    // 拆分空格分隔的参数（简化处理，不处理引号内含空格的边界情况）；
    // 单个参数两端的引号必须剥掉——否则 `git add ".env"` / `git add '.env'` 整体绕过检测。
    const files = args.split(/\s+/).map(stripQuotes)
    for (const f of files) {
      if (AGGREGATE_ARGS.has(f)) { sawAggregate = true; continue }
      if (f.startsWith('-')) continue
      const result = detectSensitiveFile(f)
      if (result.sensitive) sensitiveFiles.push(f)
    }
  }

  if (sawAggregate) sensitiveFiles.push(AGGREGATE_ADD_MARKER)
  return sensitiveFiles
}

/**
 * `git commit` 的提交目标解析——bash 侧 commit 硬门的前置。
 *
 * 背景：git 工具的 commit 动作自带敏感文件门（查将要暂存 + 已暂存），但 bash 里
 * 的 `git commit` 没有任何等价检查：`git add -A`（聚合形态免审批）之后或
 * 暂存区本就有敏感文件时，`git commit -m` 在 auto-safe 档静默执行（medium 风险），
 * 凭据直接入库。本解析器把 commit 命令分类，供调用方决定做哪种检查：
 *   - --only / 裸 pathspec：只提交列出的文件 → 按名静态检查即可（实测
 *     `git commit -- b.txt` 只提交 b.txt，已暂存的 a.txt 保持 staged）；
 *   - --include / 无操作数：提交整个暂存区 → 调用方需查 `git diff --cached --name-only`；
 *   - 带 -a/--all：先把已跟踪改动全部暂存 → 另需查工作区脏文件。
 * 与 detectSensitiveGitAdd 同口径：`git -C <dir> commit` 等全局选项形态同样捕获；
 * 混淆形态（`git${IFS}commit`）由调用方做归一化双视图并检。
 */
export interface GitIndexCommit {
  /** 显式文件操作数（pathspec / --only 目标），已剥引号 */
  files: string[]
  /**
   * 是否会提交 index 内容：
   * - 无操作数 / --include / -a：true（整个暂存区入库）；
   * - --only / 裸 pathspec：false（只提交列出的文件）。
   */
  commitsIndex: boolean
  /** -a/--all：提交前先把已跟踪改动全部暂存 */
  stagesAllTracked: boolean
  /** --only/-o 或裸 pathspec：只提交列出的文件，index 其余内容不入库 */
  onlyFiles: boolean
  /** 透传给 git 子命令的仓库定位参数（-C/--git-dir/--work-tree 白名单） */
  repoArgs: string[]
  /** 仓库定位不可靠（GIT_DIR 等环境前缀/无法解析的定位参数）→ 调用方保守要求审批 */
  uncertainRepo: boolean
}

/**
 * 取值型 flag：下一个 token 是它的值，不是文件操作数。
 * 只收「确定取值」的旗标——误把布尔旗标当取值会跳过真正的路径（漏判）；
 * 误把值当路径最多多一次审批。P1-3：`--author`/`--date` 等的值曾被误当成
 * 文件操作数，导致 files 非空后直接跳过暂存区检查。
 */
const COMMIT_VALUE_FLAGS = new Set([
  '-m', '-F', '-C', '-c', '-t',
  '--message', '--file', '--reuse-message', '--reedit-message', '--template',
  '--author', '--date', '--cleanup', '--pathspec-from-file',
  '--fixup', '--squash', '--trailer',
])

function splitCommitArgs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '\\' && i + 1 < s.length) { cur += s[i + 1]!; i++; continue }
    // shell 连接符处截断：后面的已是另一条命令
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '<' || c === '>' || c === '\n' || c === '`') break
    if (c === '$' && s[i + 1] === '(') break
    if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = '' }
      continue
    }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

/**
 * 从 git 全局选项文本中提取仓库定位参数（P1-2）。
 * `git -C <dir>` / `--git-dir=` / `--work-tree=` 改变的是**实际提交目标**，
 * 检查暂存区时必须透传给 git 子命令，否则会查到工具 cwd 的仓库造成漏拦。
 * 只透传定位类白名单（-C/--git-dir/--work-tree）；-c k=v 等不改变仓库定位。
 * 无法可靠解析时 uncertain=true，调用方保守要求审批。
 */
function parseGitRepoArgs(optsText: string): { repoArgs: string[]; uncertain: boolean } {
  const repoArgs: string[] = []
  let uncertain = false
  const tokens = splitCommitArgs(optsText)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '-C') {
      const v = tokens[i + 1]
      if (v === undefined) { uncertain = true; break }
      repoArgs.push('-C', stripQuotes(v))
      i++
      continue
    }
    if (t.startsWith('-C') && t.length > 2) {
      // -C<dir> 紧贴形态
      repoArgs.push('-C', stripQuotes(t.slice(2)))
      continue
    }
    const eq = /^(--git-dir|--work-tree)=(.*)$/.exec(t)
    if (eq) {
      repoArgs.push(`${eq[1]}=${stripQuotes(eq[2]!)}`)
      continue
    }
    if (t === '--git-dir' || t === '--work-tree') {
      const v = tokens[i + 1]
      if (v === undefined || v.startsWith('-')) { uncertain = true; break }
      repoArgs.push(t, stripQuotes(v))
      i++
      continue
    }
    // -c k=v：跳过它的值；--namespace/--no-pager/-p 等不改变仓库定位
    if (t === '-c') { i++; continue }
  }
  return { repoArgs, uncertain }
}

/**
 * `GIT_DIR=` / `GIT_WORK_TREE=` / `GIT_INDEX_FILE=` 环境前缀（P1-2）。
 * 这类前缀改变 git 的实际目标，但不在命令文本的 git 参数里——静态无法可靠
 * 确定目标仓库时必须保守要求审批，不能按"最多多一次审批"处理（失效方向是漏拦）。
 */
function hasUncertainGitEnvPrefix(command: string, matchIndex: number): boolean {
  const before = command.slice(0, matchIndex)
  const m = /(?:^|[;&|]\s*)((?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+)$/.exec(before)
  if (!m) return false
  return /\bGIT_(DIR|WORK_TREE|INDEX_FILE)\b/.test(m[1]!)
}

export function parseGitIndexCommits(command: string): GitIndexCommit[] {
  // 捕获组 1：git 与 commit 之间的全局选项文本（供 parseGitRepoArgs 提取 -C 等定位参数）
  const re = new RegExp(String.raw`\bgit(${GIT_GLOBAL_OPTS_SRC})\s+commit\b`, 'gi')
  const out: GitIndexCommit[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(command)) !== null) {
    const { repoArgs, uncertain } = parseGitRepoArgs(match[1] ?? '')
    const uncertainRepo = uncertain || hasUncertainGitEnvPrefix(command, match.index)
    const args = splitCommitArgs(command.slice(match.index + match[0].length))
    const files: string[] = []
    let stagesAllTracked = false
    let onlyFiles = false
    let includeMode = false
    let seenDashDash = false
    let skipNext = false
    for (const a of args) {
      if (skipNext) { skipNext = false; continue }
      if (seenDashDash) { files.push(stripQuotes(a)); continue }
      if (a === '--') { seenDashDash = true; continue }
      if (a === '--only' || a === '-o') { onlyFiles = true; continue }
      // --include：列出的文件先暂存，但整个 index 照样提交（P1-3）——不置 onlyFiles
      if (a === '--include') { includeMode = true; continue }
      if (COMMIT_VALUE_FLAGS.has(a)) { skipNext = true; continue }
      if (a === '-a' || a === '--all') { stagesAllTracked = true; continue }
      // 合写短旗标（-am / -ca / -ao）：含 a 即 stagesAllTracked；含 o 即 only；
      // 含 m/F/C/c/t 时下一个 token 是它的值（`git commit -am "msg"` 的 "msg"
      // 不是文件操作数；-t 是 --template 的取值形态）
      if (/^-[a-zA-Z]+$/.test(a)) {
        const letters = a.slice(1)
        if (letters.includes('a')) stagesAllTracked = true
        if (letters.includes('o')) onlyFiles = true
        if (/[mFCct]/.test(letters)) skipNext = true
        continue
      }
      if (a.startsWith('-')) continue
      files.push(stripQuotes(a))
    }
    // 裸 pathspec（无 --only/--include）按 --only 语义：只提交列出的文件
    // （实测 `git commit -- b.txt` 不提交已暂存的 a.txt）；
    // --include 即使带 --only 也按提交 index 处理（保守）。
    if (!onlyFiles && !includeMode && files.length > 0) onlyFiles = true
    const commitsIndex = includeMode || !onlyFiles
    out.push({
      files,
      commitsIndex,
      stagesAllTracked,
      onlyFiles: onlyFiles && !includeMode,
      repoArgs,
      uncertainRepo,
    })
  }
  return out
}

/**
 * 去混淆但保留仓库定位参数的归一化视图（P1-2 双视图）。
 * normalizeBashCommand 会剥掉 -C/--git-dir 等全局选项，导致
 * `git${IFS}-C /b commit` 在归一化视图里查错仓库（查工具 cwd 而不是 /b）；
 * 本视图只做去混淆（${IFS}/字符转义/续行），保留定位参数与引号
 * （引号由 splitCommitArgs/parseGitRepoArgs 自行处理）。
 */
function normalizeKeepRepoArgs(command: string): string {
  return command
    .replace(/\\\r?\n/g, ' ')
    .replace(/\$\{IFS\}/gi, ' ')
    .replace(/\\(.)/g, '$1')
}

/**
 * git commit 暂存区硬门的双视图入口：原始视图 + 去混淆保留定位视图并检。
 * 调用方（requiresApproval / pipeline 门）统一走这里，与 #495 的 git add
 * 双视图同口径。
 */
export function gitCommitStagesSensitiveDualView(cwd: string | undefined, command: string): boolean {
  return gitCommitStagesSensitive(cwd, command)
    || gitCommitStagesSensitive(cwd, normalizeKeepRepoArgs(command))
}

/**
 * bash 里 `git commit` 的暂存区敏感文件硬门（P1-1/P1-2/P1-3）。
 *
 * 背景：git 工具的 commit 动作自带敏感文件门，但 bash 里的 `git commit -m`
 * 在 auto-safe 档风险仅 medium，会静默把暂存区已有的敏感文件入库。
 *
 * 检查策略（parseGitIndexCommits 已做语义分类）：
 * 1. 仓库定位不可靠（uncertainRepo，如 GIT_DIR 环境前缀）→ 直接要求审批；
 * 2. --only / 裸 pathspec 纯文件形态：按名静态检查（聚合 pathspec 如 `.`
 *    仍回落到 index 检查——`git commit .` 会卷入未列出的已跟踪改动）；
 * 3. 提交整个暂存区（bare / -m / --amend / --include）：`git diff --cached`
 *    查已暂存；-a/--all 或同命令聚合 add（git add -A）另查工作区脏文件/未跟踪；
 * 4. -C/--git-dir/--work-tree 透传给 git 子命令——查的是**实际提交目标**的
 *    仓库，不是工具 cwd（P1-2：`git -C <B> commit` 在干净仓库 A 里不能查 A）。
 * git 调用失败（非仓库等）按无命中处理：commit 本来也会失败，无凭据入库风险。
 * 检测器 fail-closed 且不抛——不可解析的命令最多漏报，不崩。
 */
export function gitCommitStagesSensitive(cwd: string | undefined, command: string): boolean {
  const commits = parseGitIndexCommits(command)
  if (commits.length === 0) return false
  // P1-2：仓库定位不可靠时保守要求审批（失效方向是漏拦，不能按"最多多一次审批"处理）
  if (commits.some(c => c.uncertainRepo)) return true
  const dir = typeof cwd === 'string' && cwd ? cwd : process.cwd()
  const gitList = (repoArgs: string[], args: string[]): string[] => {
    try {
      return execFileSync('git', [...repoArgs, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
        .toString()
        .split('\0')
        .map(s => s.trim())
        .filter(s => s.length > 0)
    } catch {
      return []
    }
  }
  const hasSensitive = (files: string[]): boolean =>
    files.some(f => detectSensitiveFile(f).sensitive)
  // 同命令内的聚合暂存形态（-A / . / --all）：静态无法核验将暂存什么
  const hasAggregateAdd = detectSensitiveGitAdd(command).includes(AGGREGATE_ADD_MARKER)
  for (const c of commits) {
    const aggregatePathspec = c.files.some(f => AGGREGATE_ARGS.has(f))
    if (c.onlyFiles && !aggregatePathspec) {
      if (hasSensitive(c.files)) return true
      // 目录/通配 pathspec 会选中其中的已跟踪文件；只看操作数字面值会漏掉子文件。
      if (hasSensitive(gitList(c.repoArgs, ['ls-files', '--cached', '-z', '--', ...c.files]))) return true
      continue
    }
    if (c.files.length > 0 && hasSensitive(c.files)) return true
    if (hasSensitive(gitList(c.repoArgs, ['diff', '--cached', '--name-only', '-z']))) return true
    if (c.stagesAllTracked || hasAggregateAdd || aggregatePathspec) {
      // -a/--all：已跟踪改动先暂存再提交；add -A / 聚合 pathspec：未跟踪也收
      const dirty = gitList(c.repoArgs, ['diff', '--name-only', '-z'])
      const untracked = (hasAggregateAdd || aggregatePathspec)
        ? gitList(c.repoArgs, ['ls-files', '--others', '--exclude-standard', '-z'])
        : []
      if (hasSensitive(dirty) || hasSensitive(untracked)) return true
    }
  }
  return false
}
