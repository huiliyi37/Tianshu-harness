/** Environment variable prefixes that should be preserved for child processes. */
const SAFE_ENV_PREFIXES = [
  'PATH', 'HOME', 'PWD', 'NODE_ENV', 'TERM', 'LANG', 'LC_', 'XDG_', 'EDITOR', 'VISUAL', 'PAGER', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'COLOR', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  // Windows-critical: without SystemRoot the child process cannot load system
  // DLLs, causing cmd.exe / powershell.exe to exit(0) with zero output.
  'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA', 'PUBLIC', 'HOMEDRIVE', 'ALLUSERSPROFILE', 'PROCESSOR_',
  // Toolchain vars: builds (maven/gradle/java/go/rust/android) and version
  // managers rely on these; stripping them broke `mvn`/`java` when launched from
  // a GUI with a minimal env. None contain sensitive keywords, so the KEY/TOKEN/
  // SECRET filter below still removes anything genuinely secret.
  'JAVA_HOME', 'JDK_HOME', 'JRE_HOME', 'CLASSPATH',
  'MAVEN_', 'M2_', 'M2', 'GRADLE_', 'ANT_HOME',
  'GOPATH', 'GOROOT', 'GOBIN', 'GO111MODULE', 'GOFLAGS', 'GOPROXY',
  'CARGO_HOME', 'RUSTUP_HOME',
  'ANDROID_', 'NVM_DIR', 'PYENV', 'SDKMAN_DIR',
  'DOTNET_', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_',
  'PNPM_HOME', 'VOLTA_HOME', 'FNM_DIR', 'MISE_', 'ASDF_', 'RBENV_ROOT', 'GEM_',
  // 注意：NODE_OPTIONS / JAVA_TOOL_OPTIONS 刻意排除（issue #137）——
  // 它们可在子进程启动时注入 --require/-javaagent 任意代码，构成环境污染
  // 攻击面；不含 KEY/TOKEN/SECRET 关键词，敏感过滤兜不住，必须显式剥离。
  'NODE_PATH', 'KUBECONFIG', 'DOCKER_HOST',
  // Android 内嵌 payload（issue #559）：随包 node 二进制位于 nativeLibraryDir，
  // 其 ELF 依赖写的是 `libz.so.1`，而该系统只提供无版本后缀的 `libz.so`——只有
  // 父进程（客户端启动内核时）注入的 `LD_LIBRARY_PATH=$PREFIX/lib` 能补上。之前
  // 它不在白名单里，于是 bash 工具 fork 出的子进程丢失该变量，`node`/`npm` 全部
  // 报 `CANNOT LINK EXECUTABLE "node": library "libz.so.1" not found`。
  // 放行理由：不是新增能力，只是让子进程继承父进程**已有**的变量（同用户、同进程
  // 权限，无提权面）；动态链接器在查找路径时本就不区分「谁设置的值」。
  // 刻意只放行这一个变量——`LD_PRELOAD`/`LD_AUDIT` 见下方 ALWAYS_STRIPPED_ENV。
  'LD_LIBRARY_PATH',
] as const

/**
 * Keywords that indicate a sensitive env var — vars containing these substrings are stripped.
 */
const SENSITIVE_ENV_KEYWORDS = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'AUTH', 'PRIVATE'] as const

/**
 * 启动即执行类变量：无论 `SAFE_ENV_PREFIXES` 将来怎么放宽，这些都必须剥离
 * （与 `src/mcp/stdio-env.ts` 的 `CODE_EXEC_ENV_VARS`、bash 路径的 issue #137
 * 硬化对齐）。
 *
 * `LD_PRELOAD` 能加载任意 .so 并在子进程启动瞬间执行代码，攻击面与
 * `NODE_OPTIONS=--require` 同级；`LD_AUDIT` / `DYLD_INSERT_LIBRARIES` 同理。
 * 它们不含 KEY/TOKEN/SECRET 关键词，敏感关键词过滤兜不住，必须显式拉黑。
 * 这也是 issue #559 只放行 `LD_LIBRARY_PATH` 而不放行 `LD_` 前缀的原因：
 * 前缀放行会把整个 `LD_*` 家族一起打开。
 */
const ALWAYS_STRIPPED_ENV = [
  'LD_PRELOAD', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
] as const

/** Strip sensitive environment variables before passing to child processes. */
export function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const clean: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    // 先拉黑再查白名单：白名单将来放宽也不会漏掉启动即执行类变量。
    if ((ALWAYS_STRIPPED_ENV as readonly string[]).includes(upper)) continue
    const isSensitive = SENSITIVE_ENV_KEYWORDS.some(kw => upper.includes(kw))
    if (isSensitive) continue
    const isSafe = SAFE_ENV_PREFIXES.some(prefix => upper.startsWith(prefix))
    if (isSafe) {
      clean[key] = value
    }
  }
  return clean
}
