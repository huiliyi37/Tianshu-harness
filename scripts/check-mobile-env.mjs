#!/usr/bin/env node
/**
 * 移动端安装环境守卫（postinstall 第一步，2026-09-05）。
 *
 * 背景（issue #55 同期的移动端调研）：手机端两类环境——
 *   1. 裸 Termux（bionic，process.platform === 'android'）：必需原生依赖
 *      `@ast-grep/napi` 与 `esbuild` 没有 android 平台二进制，npm 会静默跳过，
 *      安装「成功」但运行必坏。此类环境必须 fail-loud 并指引 proot-distro。
 *   2. proot-distro（glibc arm64，platform === 'linux'）：官方支持路径，依赖
 *      按 linux-arm64 正常解析；ripgrep 缺失时 grep 工具族如实降级，此处仅提醒。
 *
 * 逃生口：RIVET_ALLOW_MOBILE_INSTALL=1 时裸 Termux 也放行（降级为醒目警告），
 * 供实验环境自担风险继续安装。
 */
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

function detectRipgrep() {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * @param {object} [input] 测试注入点
 * @param {string} [input.platform] process.platform
 * @param {string} [input.arch] process.arch
 * @param {Record<string, string|undefined>} [input.env] process.env
 * @param {boolean} [input.hasRg] ripgrep 是否在 PATH
 * @returns {{ level: 'ok'|'warn'|'fatal', messages: string[] }}
 */
export function evaluateMobileInstallEnv(input = {}) {
  const platform = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  const env = input.env ?? process.env
  const hasRg = input.hasRg ?? detectRipgrep()

  if (platform === 'android') {
    const guidance = [
      '检测到裸 Termux 环境（Android bionic）。',
      'tianshu-tui 的必需原生依赖（@ast-grep/napi / esbuild）没有 Android 平台二进制，npm 会静默跳过它们——装完运行必坏。',
      '官方支持路径是 proot-distro（glibc 发行版）：',
      '  pkg install proot-distro && proot-distro install ubuntu && proot-distro login ubuntu',
      '  （容器内）apt install -y curl ripgrep，安装 Node >= 24，然后 npm i -g tianshu-tui',
      '沙箱/LSP/语音等能力在容器内会自动降级，不影响核心功能。',
    ]
    if (env.RIVET_ALLOW_MOBILE_INSTALL === '1') {
      return {
        level: 'warn',
        messages: ['RIVET_ALLOW_MOBILE_INSTALL=1：跳过裸 Termux 拦截，继续安装（运行时大概率损坏，自担风险）。', ...guidance],
      }
    }
    return { level: 'fatal', messages: guidance }
  }

  const warnings = []
  if (platform === 'linux' && arch === 'arm64' && !hasRg) {
    warnings.push('未检测到 ripgrep——grep/glob 工具族将不可用。安装：Debian/Ubuntu（proot 容器内）apt install -y ripgrep；Arch pacman -S ripgrep。')
  }
  return { level: warnings.length > 0 ? 'warn' : 'ok', messages: warnings }
}

function main() {
  const result = evaluateMobileInstallEnv()
  if (result.level === 'ok') return
  const log = result.level === 'fatal' ? console.error : console.warn
  for (const line of result.messages) log(line)
  if (result.level === 'fatal') process.exit(1)
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly || process.env.RIVET_MOBILE_GUARD_FORCE_RUN === '1') main()
