/**
 * `rivet browser` — 浏览器（chromium）就绪检查与一键安装。
 *
 * chromium 被 browser_debug / browser / web-fetch(render) / computer-use 依赖，
 * 下载 ~150MB 不随包分发。此命令让新用户一条命令装好，默认带国内镜像 env，
 * 无需自己记 PLAYWRIGHT_DOWNLOAD_HOST。
 *
 * 子命令：
 *   rivet browser status            探测 chromium 是否就绪（不启动浏览器）
 *   rivet browser install           npx playwright install chromium（默认带国内镜像）
 *   rivet browser install --no-mirror   用官方源（海外网络）
 */
import { spawn } from 'node:child_process'
import { probeChromium, formatBrowserMissingBanner } from '../tools/net/browser-readiness.js'
import { playwrightInstallSpec, resolvePlaywrightCoreVersion } from '../tools/net/playwright-driver.js'

/** 国内镜像 host——与 net/playwright-driver 的 PLAYWRIGHT_INSTALL_HINT 文案同源。 */
export const PLAYWRIGHT_MIRROR_HOST = 'https://registry.npmmirror.com/-/binary/playwright'

const USAGE = [
  'rivet browser — 浏览器（chromium）就绪检查与安装',
  '',
  '  rivet browser status              检查 chromium 是否已就绪',
  '  rivet browser install             安装 chromium（默认带国内镜像加速）',
  '  rivet browser install --no-mirror 用官方源安装（海外网络）',
].join('\n')

export interface BrowserInstallPlan {
  command: string
  args: string[]
  /** 注入到子进程的额外 env（镜像 host）。空对象=用官方源。 */
  env: Record<string, string>
}

/**
 * 组装 `playwright install chromium` 的执行计划（纯函数，供测试直接断言）。
 * 默认注入 npmmirror 镜像 host；--no-mirror 时不注入（走官方源）。
 * Windows 上 npx 是 .cmd shim，用 shell 执行以正确解析。
 */
export function buildInstallPlan(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  playwrightVersion: string | null = resolvePlaywrightCoreVersion() ?? null,
): BrowserInstallPlan {
  const noMirror = args.includes('--no-mirror')
  const env: Record<string, string> = noMirror ? {} : { PLAYWRIGHT_DOWNLOAD_HOST: PLAYWRIGHT_MIRROR_HOST }
  // npx playwright@<内嵌版本> install chromium —— playwright-core 不含下载器，但
  // playwright（meta 包）的 install 子命令会下浏览器到 registry 缓存。版本钉在
  // 内嵌 playwright-core 上：就绪检测按它的 browsers.json 找 revision，不钉版本
  // 时 npx 拉最新 playwright、装出别的 revision，装完仍报未安装（#102）。
  return {
    command: platform === 'win32' ? 'npx.cmd' : 'npx',
    args: [playwrightInstallSpec(playwrightVersion), 'install', 'chromium'],
    env,
  }
}

/** 打印 chromium 就绪状态。返回退出码（就绪 0 / 缺失 1）。 */
export async function runBrowserStatus(
  write: (s: string) => void = (s) => process.stdout.write(s),
): Promise<number> {
  const probe = await probeChromium()
  if (probe.installed) {
    write(`✓ chromium 已就绪\n  ${probe.executablePath}\n`)
    return 0
  }
  write(formatBrowserMissingBanner(probe) + '\n')
  return 1
}

/** 执行 chromium 安装，实时透传子进程输出。返回子进程退出码。 */
export async function runBrowserInstall(
  args: readonly string[],
  write: (s: string) => void = (s) => process.stdout.write(s),
): Promise<number> {
  const plan = buildInstallPlan(args)
  const usingMirror = 'PLAYWRIGHT_DOWNLOAD_HOST' in plan.env
  write(`正在安装 chromium（${usingMirror ? '国内镜像' : '官方源'}）：${plan.command} ${plan.args.join(' ')}\n`)
  return await new Promise<number>((resolve) => {
    const child = spawn(plan.command, plan.args as string[], {
      stdio: 'inherit',
      env: { ...process.env, ...plan.env },
      // Windows 上 npx.cmd 需 shell 解析。
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    child.on('error', (err) => {
      write(`\n安装启动失败：${err.message}\n（确认已安装 Node/npm，且 npx 可用）\n`)
      resolve(1)
    })
    child.on('close', (code) => {
      if (code === 0) write('\n✓ chromium 安装完成。\n')
      else write(`\n安装退出码 ${code ?? '未知'}。国内网络失败可重试，或加 --no-mirror 用官方源。\n`)
      resolve(code ?? 1)
    })
  })
}

/** `rivet browser <sub>` 分发入口（main.ts 调用）。返回进程退出码。 */
export async function runBrowserCLI(
  args: readonly string[],
  write: (s: string) => void = (s) => process.stdout.write(s),
): Promise<number> {
  const sub = args[0]
  if (sub === 'status' || sub === 'check') return runBrowserStatus(write)
  if (sub === 'install') return runBrowserInstall(args.slice(1), write)
  write(USAGE + '\n')
  // 无子命令/未知子命令：打印用法。help 视为成功，未知视为失败。
  return sub === undefined || sub === 'help' || sub === '--help' ? 0 : 1
}
