/**
 * TTY 门之前的 CLI 早期路由——单一事实源。
 *
 * 背景（2026-09-16 P0-2 CLI 启动优化）：`config / provider / serve /
 * sessions(--list) / browser / logs / web` 这些子命令本来在 main() 里、TTY 门
 * 与 bootstrap 之前就要返回，但它们仍要先为 main.ts 顶部 87 个静态 import
 * 付整张依赖图（实测 8.3MB / 114 chunks）的解析与求值成本。
 *
 * 现在拆成两段复用：
 *   - `src/cli/entry.ts`（package.json `bin.rivet`）：先启用 V8 编译缓存，
 *     处理 --help/--version；其余参数交给本模块；未命中才动态 import main。
 *   - `src/main.ts`（直跑 dist/main.js / tsx 开发入口）：main() 开头同样调用
 *     `routeEarlyCli`，保证两条入口行为逐字一致。
 *
 * 纪律：本模块只允许轻量静态依赖（node: 内置 + 同目录叶子）。子命令处理器
 * 全部走函数内动态 import，否则 launcher 的快速路径又会把重物拉回来。
 * 路由顺序必须与原先 main() 中的顺序一致（config 优先于 --list 等）。
 */

export interface EarlyCliHandlers {
  storage: (args: string[]) => Promise<{ output: string; exitCode: number }>
  skills: (args: string[]) => Promise<{ output: string; exitCode: number }>
  config: (args: string[]) => Promise<void> | void
  provider: (args: string[]) => Promise<void> | void
  serve: (args: string[]) => Promise<void> | void
  sessions: () => Promise<string> | string
  browser: (args: string[]) => Promise<number>
  logs: (args: string[]) => Promise<{ output: string; exitCode: number }>
  web: (args: string[]) => Promise<number>
}

export interface EarlyCliIO {
  stdout: (text: string) => void
  stderr: (text: string) => void
  exit: (code: number) => void
}

export interface EarlyCliRouteOptions {
  cwd?: string
  /** 子命令处理器覆盖（测试注入 fake；缺省走真实动态 import）。 */
  handlers?: Partial<EarlyCliHandlers>
  /** 输出/退出覆盖（测试注入；缺省 process.stdout/stderr/exit）。 */
  io?: Partial<EarlyCliIO>
}

/** 真实处理器：每个分支的 import 都发生在函数体内，保持 launcher 静态图轻量。 */
export function createEarlyCliHandlers(cwd: string = process.cwd()): EarlyCliHandlers {
  return {
    storage: async args => (await import('./storage-cli.js')).runStorageCLI(args),
    skills: async (args) => {
      const { runSkillsCLI } = await import('./skills-cli.js')
      return runSkillsCLI(args, { cwd })
    },
    config: async (args) => {
      const { runConfigCLI } = await import('../config/manager.js')
      await runConfigCLI(args)
    },
    provider: async (args) => {
      const { runProviderCLI } = await import('../config/provider-cli.js')
      await runProviderCLI(args)
    },
    serve: async (args) => {
      const { serveCommand } = await import('../server/serve.js')
      await serveCommand(args)
    },
    sessions: async () => {
      const { SessionPersist } = await import('../agent/session-persist.js')
      return SessionPersist.formatSessionList(cwd)
    },
    browser: async (args) => {
      const { runBrowserCLI } = await import('./browser-cli.js')
      return runBrowserCLI(args)
    },
    logs: async (args) => {
      const { runLogsCLI } = await import('../diagnostics/logs-cli.js')
      return runLogsCLI(args, { cwd })
    },
    web: async (args) => {
      const { runWebCLI } = await import('./web-cli.js')
      return runWebCLI(args)
    },
  }
}

/**
 * `--profile` / `--trust` / `--untrust` 的早期副作用（原先在 main.ts 模块顶层）。
 * 必须在任何 loadConfig 之前完成。重复调用幂等。
 *
 * @param hooks 测试注入（避免真实写用户配置）；缺省动态 import 真实实现。
 */
export interface EarlyCliEnvHooks {
  trustProject?: (cwd: string) => void
  untrustProject?: (cwd: string) => void
}

export async function applyEarlyCliEnv(
  args: readonly string[],
  hooks: EarlyCliEnvHooks = {},
): Promise<void> {
  const profileIdx = args.indexOf('--profile')
  const profile = profileIdx >= 0 ? args[profileIdx + 1] : undefined
  if (profile !== undefined && !profile.startsWith('-')) {
    process.env.RIVET_PROFILE = profile
  }

  const wantTrust = args.includes('--trust')
  const wantUntrust = args.includes('--untrust')
  if (!wantTrust && !wantUntrust) return

  const trustFn = hooks.trustProject
    ?? (await import('../config/project-trust.js')).trustProject
  const untrustFn = hooks.untrustProject
    ?? (await import('../config/project-trust.js')).untrustProject
  if (wantTrust) trustFn(process.cwd())
  if (wantUntrust) untrustFn(process.cwd())
}

/**
 * 命中早期子命令则执行并返回 true；否则返回 false（调用方继续 TUI/headless）。
 * 路由顺序与 2026-09-16 之前 main() 内联顺序逐条对齐。
 */
export async function routeEarlyCli(
  rawArgs: readonly string[],
  options: EarlyCliRouteOptions = {},
): Promise<boolean> {
  const args = [...rawArgs]
  const handlers: EarlyCliHandlers = { ...createEarlyCliHandlers(options.cwd), ...options.handlers }
  const io: EarlyCliIO = {
    stdout: text => { process.stdout.write(text) },
    stderr: text => { process.stderr.write(text) },
    exit: code => { process.exit(code) },
    ...options.io,
  }

  if (args[0] === 'storage') {
    const { output, exitCode } = await handlers.storage(args.slice(1))
    ;(exitCode === 0 ? io.stdout : io.stderr)(output + '\n')
    if (exitCode !== 0) io.exit(exitCode)
    return true
  }

  if (args[0] === 'account' || args[0] === 'model') {
    const { runOfficialModelCLI } = await import('./official-model-cli.js')
    const { output, exitCode } = await runOfficialModelCLI(args, { write: line => io.stdout(line + '\n') })
    if (output) (exitCode === 0 ? io.stdout : io.stderr)(output + '\n')
    if (exitCode !== 0) io.exit(exitCode)
    return true
  }
  if (args[0] === 'skills') {
    const { output, exitCode } = await handlers.skills(args.slice(1))
    ;(exitCode === 0 ? io.stdout : io.stderr)(output + '\n')
    if (exitCode !== 0) io.exit(exitCode)
    return true
  }
  if (args[0] === 'config') {
    await handlers.config(args.slice(1))
    return true
  }
  if (args[0] === 'provider') {
    await handlers.provider(args.slice(1))
    return true
  }
  if (args[0] === 'serve') {
    await handlers.serve(args.slice(1))
    return true
  }
  if (args[0] === 'sessions' || args.includes('--list')) {
    io.stdout((await handlers.sessions()) + '\n')
    return true
  }
  if (args[0] === 'browser') {
    const code = await handlers.browser(args.slice(1))
    if (code !== 0) io.exit(code)
    return true
  }
  if (args[0] === 'logs') {
    const { output, exitCode } = await handlers.logs(args.slice(1))
    ;(exitCode === 0 ? io.stdout : io.stderr)(output + '\n')
    if (exitCode !== 0) io.exit(exitCode)
    return true
  }
  if (args[0] === 'web') {
    const code = await handlers.web(args.slice(1))
    if (code !== 0) io.exit(code)
    return true
  }
  return false
}
