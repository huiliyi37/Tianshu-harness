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
    re: /\.env(?:\.(?:local|production|staging|development|prod|staging|dev))?$/,
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

/** 匹配前归一化：反斜杠→正斜杠（Windows 分隔符统一可比）、小写化（大小写不敏感）。 */
function normalizeForMatch(inputPath: string): string {
  return inputPath.replace(/\\/g, '/').toLowerCase()
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
export function detectSensitiveGitAdd(command: string): string[] {
  // 匹配 `git add <file>` — 提取文件参数（PowerShell/cmd 命令名不区分大小写 → /gi）
  // 来源：prompt security 段 "发现此类文件出现在 git add 中时中止"
  const gitAddRe = /git\s+add\s+(.+)/gi
  const sensitiveFiles: string[] = []
  let sawAggregate = false

  let match: RegExpExecArray | null
  while ((match = gitAddRe.exec(command)) !== null) {
    const args = match[1]!.trim()
    // 拆分空格分隔的参数（简化处理，不处理引号边界情况）
    const files = args.split(/\s+/)
    for (const f of files) {
      if (f === '.' || f === './') { sawAggregate = true; continue }
      if (f === '-A' || f === '-a' || f === '--all') { sawAggregate = true; continue }
      if (f.startsWith('-')) continue
      const result = detectSensitiveFile(f)
      if (result.sensitive) sensitiveFiles.push(f)
    }
  }

  if (sawAggregate) sensitiveFiles.push(AGGREGATE_ADD_MARKER)
  return sensitiveFiles
}
