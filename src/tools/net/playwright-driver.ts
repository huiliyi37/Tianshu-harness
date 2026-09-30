/**
 * playwright-driver — playwright-core 共享加载与 headless chromium 启动。
 *
 * 浏览器依赖统一为 playwright-core（不含浏览器下载逻辑）；chromium 可执行
 * 文件完全交给 playwright-core 内建 registry 解析：
 *   1. PLAYWRIGHT_BROWSERS_PATH env（桌面端 sidecar 指向打包资源目录）
 *   2. 默认缓存目录（CLI：`npx playwright install chromium` 的落地处）
 * 浏览器缺失时抛带国内镜像安装提示的友好错误。
 *
 * 本模块只定义最小结构化接口（Pw*），调用方按需收窄——与
 * browser-debug/driver.ts 的 `as never` 动态加载同风格，避免构建期
 * 解析 playwright-core 的类型。
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

/** playwright-core 模块缺失时的安装引导——区分 CLI 安装用户 / 仓库内开发 / 桌面端。 */
export const PLAYWRIGHT_CORE_INSTALL_HINT = [
  'CLI 安装用户：npm install -g tianshu-harness（重新安装以补齐依赖），',
  '  或当前项目内：npm i playwright-core',
  '  仓库内开发：npm i playwright-core',
  '  桌面端：检查 dist/node_modules/playwright-core 是否完整',
].join('\n')

/** 手动安装命令（含国内镜像 env）——banner 的兜底行复用它，避免文案漂移。 */
/**
 * 内嵌 playwright-core 的版本。就绪检测按这个版本的 browsers.json 推 chromium
 * revision，所以安装也必须钉在同一版本：不带版本的 `npx playwright install`
 * 会拉 registry 最新的 playwright，装出另一个 revision，检测永远报未安装（#102）。
 * 模块缺失时返回 undefined（此时提示的是装 playwright-core，不是装浏览器）。
 */
export function resolvePlaywrightCoreVersion(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url)('playwright-core/package.json') as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/** `npx` 的包 spec：能解析到内嵌版本就钉版本，否则（或显式传 null）退回裸包名。 */
export function playwrightInstallSpec(version: string | null | undefined = resolvePlaywrightCoreVersion()): string {
  return version ? `playwright@${version}` : 'playwright'
}

export const PLAYWRIGHT_MANUAL_INSTALL_HINT =
  `npx ${playwrightInstallSpec()} install chromium` +
  `（国内网络：PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright npx ${playwrightInstallSpec()} install chromium）`

// 两条入口都要给：只装了桌面端的用户没有 `rivet` 命令可敲，只报 CLI 命令等于把他
// 们指向一条走不通的路。
export const PLAYWRIGHT_INSTALL_HINT =
  'chromium 未安装。一键安装：终端 `rivet browser install`（自动带国内镜像），' +
  '或桌面端 设置 → 集成 → 浏览器（截图）里点安装。' +
  `手动：${PLAYWRIGHT_MANUAL_INSTALL_HINT}`

/**
 * 动态 specifier（变量形式），避免 tsc/tsup 构建期静态解析。
 * 返回 unknown——各调用方（render-pool / browser / browser-debug）按自己的
 * Pw* 接口收窄，互不耦合。
 */
export async function loadPlaywrightCore(): Promise<unknown> {
  const specifier = 'playwright-core'
  try {
    return await import(specifier)
  } catch (err) {
    // 模块解析失败 ≠ 浏览器没装。别在这条路径上给 `playwright install` 提示——
    // 打包运行时最常见的成因是 dist/node_modules 暂存残缺（空目录反而遮蔽了仓库
    // 里完整的包），提示装浏览器只会把排查引向错误方向。排查命令留给 CLI banner
    //（formatBrowserMissingBanner），这里只报事实 + 原始错误。
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      '无法加载 playwright-core 模块（不是浏览器缺失）。' +
        `\n（原始错误：${msg.split('\n')[0]}）`,
    )
  }
}

/** 启动错误是否由浏览器可执行文件缺失引起（此时才附安装提示）。 */
export function isBrowserMissingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('Executable') && msg.includes("doesn't exist")
}

/**
 * 系统已安装的 chromium 系浏览器候选路径（按平台；正斜杠统一，Windows 亦接受）。
 * 只收 chromium/Chrome/Brave：Edge 在 Windows 上恒存在，纳入会把「未下载 chromium」
 * 的机器全部判成就绪，背离本模块指向 `rivet browser install` 的引导语义。
 */
function systemChromiumCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  switch (platform) {
    case 'linux':
      return [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/opt/google/chrome/chrome',
        '/usr/bin/brave-browser',
      ]
    case 'darwin':
      return [
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ]
    case 'win32': {
      const pf = env.PROGRAMFILES ?? 'C:/Program Files'
      const pf86 = env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)'
      const local = env.LOCALAPPDATA ?? ''
      return [
        `${local}/Chromium/Application/chrome.exe`,
        `${pf}/Google/Chrome/Application/chrome.exe`,
        `${pf86}/Google/Chrome/Application/chrome.exe`,
        `${local}/Google/Chrome/Application/chrome.exe`,
        `${pf}/BraveSoftware/Brave-Browser/Application/brave.exe`,
      ].filter((p) => !p.startsWith('/'))
    }
    default:
      return []
  }
}

/**
 * 探测系统已安装的 chromium 系浏览器（issue #302）。零副作用——只检查已知路径的
 * 存在性，绝不启动进程。系统装了浏览器而 playwright 下载版缺失时，这张表是
 * 「其实能用」与「提示去下载」之间的判据。
 */
export function findSystemChromium(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return systemChromiumCandidates(platform, env).find((p) => exists(p))
}

export interface ResolvedChromiumBinary {
  /** playwright 下载版 / 系统安装版 / 都没有。 */
  source: 'playwright' | 'system' | 'missing'
  /** source !== 'missing' 时可用的可执行文件路径。 */
  executablePath?: string
  /** playwright 下载版内部：headless 专用 shell 还是完整 chromium（决定启动模式）。 */
  kind?: 'headless-shell' | 'chromium'
}

export interface ResolveChromiumOptions {
  /** 目标是否 headless——headless 时首选 chrome-headless-shell（playwright 的默认）。 */
  headless?: boolean
  /** 路径存在性判定（测试注入）。 */
  exists?: (path: string) => boolean
  /** 系统浏览器探测（测试注入）。 */
  findSystem?: () => string | undefined
}

/**
 * 从完整版 chromium 路径推导 headless shell 的候选路径。
 *
 * playwright 的 `executablePath()` 返回**完整版**（`chromium-<rev>/…/chrome`），但
 * `launch({ headless: true })` 实际执行的是 `chromium_headless_shell-<rev>/…`——两者
 * 是不同的文件（issue #302 同族：探测与启动各看各的）。layout 取自 playwright 自身
 * 的 EXECUTABLE_PATHS 表（`chrome-linux64/chrome` ↔ `chrome-headless-shell-linux64/…`）。
 *
 * 无 `chromium-<rev>` 段（非标准布局 / 系统浏览器路径）时返回 `[]`——调用方据此
 * 退回完整版或系统浏览器，而不是凭空猜路径。
 */
export function headlessShellCandidates(fullPath: string): string[] {
  if (!fullPath) return []
  const sep = fullPath.includes('\\') ? '\\' : '/'
  const parts = fullPath.split(/[\\/]/)
  const idx = parts.findIndex((p) => /^chromium-\d+$/.test(p))
  const revSeg = idx >= 0 ? parts[idx] : undefined
  if (!revSeg) return []
  const rev = revSeg.slice('chromium-'.length)
  const root = parts.slice(0, idx).join(sep)
  const dirName = `chromium_headless_shell-${rev}`

  const layouts: Array<{ dir: string; file: string; platform: 'win' | 'linux' | 'mac' }> = [
    { dir: 'chrome-headless-shell-win64', file: 'chrome-headless-shell.exe', platform: 'win' },
    { dir: 'chrome-headless-shell-linux64', file: 'chrome-headless-shell', platform: 'linux' },
    { dir: 'chrome-linux', file: 'headless_shell', platform: 'linux' }, // arm64 / 老布局
    { dir: 'chrome-headless-shell-mac-x64', file: 'chrome-headless-shell', platform: 'mac' },
    { dir: 'chrome-headless-shell-mac-arm64', file: 'chrome-headless-shell', platform: 'mac' },
  ]
  // 平台相关布局优先——从完整版路径的目录段推断，让首个候选更可能是真命中的那个。
  const seg = parts.slice(0, idx + 2).join('/')
  const inferred: 'win' | 'linux' | 'mac' | undefined =
    /chrome-win|chrome-headless-shell-win/.test(seg) ? 'win'
    : /chrome-linux|chrome-headless-shell-linux/.test(seg) ? 'linux'
    : /chrome-mac|chrome-headless-shell-mac/.test(seg) ? 'mac'
    : undefined
  const ordered = inferred ? [...layouts].sort((a, b) => (a.platform === inferred ? -1 : 0) - (b.platform === inferred ? -1 : 0)) : layouts
  return ordered.map(({ dir, file }) => [root, dirName, dir, file].join(sep))
}

/**
 * 决定这次用哪个 chromium。优先级：
 *   1. headless 目标 + 下载版存在 → headless shell（playwright 的默认执行体）
 *   2. 完整版 chromium 存在 → 完整版（headless 也能跑，issue #302 场景 A 的兜底）
 *   3. 系统安装版 → 系统浏览器（issue #302——装了发行版 chromium 却报未安装）
 *
 * `source='missing'` 时调用方维持原有「未安装」路径（launch 不传 executablePath，
 * 让 playwright 抛标准缺失错误）。探测层与启动层共用本函数，消除
 * 「检测说就绪、启动报缺失」（反之亦然）的不一致。
 */
export function resolveChromiumBinary(
  mod: { chromium: { executablePath(): string } },
  opts: ResolveChromiumOptions = {},
): ResolvedChromiumBinary {
  const exists = opts.exists ?? existsSync
  const findSystem = opts.findSystem ?? (() => findSystemChromium())
  let full: string | undefined
  try {
    const p = mod.chromium.executablePath()
    if (p) full = p
  } catch {
    // executablePath() 在异常配置下会抛——按「下载版不可用」处理，继续找系统浏览器。
  }
  if (opts.headless && full) {
    const shell = headlessShellCandidates(full).find(exists)
    if (shell) return { source: 'playwright', executablePath: shell, kind: 'headless-shell' }
  }
  if (full && exists(full)) return { source: 'playwright', executablePath: full, kind: 'chromium' }
  const system = findSystem()
  return system ? { source: 'system', executablePath: system } : { source: 'missing' }
}

export interface PwRoute {
  abort(errorCode?: string): Promise<void>
  continue(): Promise<void>
}
export interface PwRequest {
  url(): string
}
export type PwRouteHandler = (route: PwRoute, request: PwRequest) => Promise<void>
export interface PwPage {
  goto(url: string, opts: Record<string, unknown>): Promise<unknown>
  url(): string
  content(): Promise<string>
  route(url: string, handler: PwRouteHandler): Promise<void>
  close(): Promise<void>
  /** 以下为 actions 体系（B2）扩展——与真实 playwright Page 签名对齐。 */
  click(selector: string, opts?: Record<string, unknown>): Promise<void>
  fill(selector: string, text: string, opts?: Record<string, unknown>): Promise<void>
  press(selector: string, key: string, opts?: Record<string, unknown>): Promise<void>
  keyboard?: { press(key: string): Promise<void> }
  evaluate(script: string): Promise<unknown>
  waitForSelector(selector: string, opts?: Record<string, unknown>): Promise<unknown>
}
export interface PwContext {
  newPage(): Promise<PwPage>
  close(): Promise<void>
}
export interface PwBrowser {
  newPage(): Promise<PwPage>
  newContext(opts: Record<string, unknown>): Promise<PwContext>
  close(): Promise<void>
  on(event: string, handler: (arg: never) => void): void
  isConnected?(): boolean
}
export interface PwChromium {
  launch(opts: Record<string, unknown>): Promise<PwBrowser>
}

export interface LaunchHeadlessOptions {
  proxy?: { server: string; bypass?: string }
  timeoutMs?: number
}

/**
 * 启动 headless chromium（无显式 executablePath——registry 结合
 * PLAYWRIGHT_BROWSERS_PATH 自动定位，桌面端打包浏览器因此零配置生效）。
 * 浏览器缺失时抛带安装提示的友好错误；其余启动错误原样上抛。
 */
export async function launchHeadlessChromium(opts: LaunchHeadlessOptions = {}): Promise<PwBrowser> {
  const mod = (await loadPlaywrightCore()) as { chromium: PwChromium & { executablePath(): string } }
  // 显式解析要用的二进制（headless 首选 chrome-headless-shell；下载版缺失时回落到
  // 完整版或系统浏览器，issue #302）——与 browser-readiness 的探测同源，消除
  // 「检测说就绪、启动又报缺失」的不一致。
  const binary = resolveChromiumBinary(mod, { headless: true })
  try {
    return await mod.chromium.launch({
      headless: true,
      // 系统版与「完整版兜底」都要显式给路径；headless shell 让 playwright 自己按
      // registry 解析（避免把 shell 路径当成用户提供的陌生可执行文件）。
      ...(binary.executablePath && binary.kind !== 'headless-shell'
        ? { executablePath: binary.executablePath }
        : {}),
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
      ...(opts.proxy ? { proxy: opts.proxy } : {}),
    })
  } catch (err) {
    if (isBrowserMissingError(err)) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`${PLAYWRIGHT_INSTALL_HINT}\n（原始错误：${msg.split('\n')[0]}）`)
    }
    throw err
  }
}
