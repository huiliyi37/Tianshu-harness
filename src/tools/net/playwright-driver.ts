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
}

/**
 * 决定这次用哪个 chromium：playwright 下载版优先（registry 版本受控），缺失时
 * 退回系统安装版（issue #302——Linux 用户装了发行版 chromium 却被报未安装）。
 * source='missing' 时调用方维持原有「未安装」路径（launch 不传 executablePath，
 * 让 playwright 抛标准缺失错误）。
 */
export function resolveChromiumBinary(
  mod: { chromium: { executablePath(): string } },
  findSystem: () => string | undefined = () => findSystemChromium(),
): ResolvedChromiumBinary {
  try {
    const pwPath = mod.chromium.executablePath()
    if (pwPath && existsSync(pwPath)) return { source: 'playwright', executablePath: pwPath }
  } catch {
    // executablePath() 在异常配置下会抛——按「下载版不可用」处理，继续找系统浏览器。
  }
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
  // playwright 下载版优先；缺失时系统安装版兜底（issue #302）——否则「检测说就绪、
  // 启动又报缺失」的不一致会把用户引向错误方向。
  const binary = resolveChromiumBinary(mod)
  try {
    return await mod.chromium.launch({
      headless: true,
      ...(binary.source === 'system' && binary.executablePath ? { executablePath: binary.executablePath } : {}),
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
