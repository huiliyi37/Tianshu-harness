import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * npm 全局安装（`npm i -g`，/update 触发）时 postinstall 的执行环境：
 * devDependencies 不安装 → 其 bin 不在 PATH。PATH 只有系统路径 + node 安装目录。
 * 2026-08-14 缺陷：postinstall 首段裸调 patch-package（devDependency），
 * 全局安装 exit 127 整链失败（sh: patch-package: command not found）。
 */
/** 模拟全局安装环境的最小 PATH：node 运行时目录 + 系统目录。
 *  Windows 用原生形式（';' 分隔）供 where.exe 消费；POSIX 供 /bin/sh 消费。 */
function simulateGlobalInstallPath(): string {
  const parts = [dirname(process.execPath)]
  if (process.platform === 'win32') {
    parts.push(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'))
    return parts.join(';')
  }
  for (const p of ['/usr/local/bin', '/usr/bin', '/bin', '/opt/homebrew/bin']) {
    if (!parts.includes(p)) parts.push(p)
  }
  return parts.join(':')
}

/** 命令在该 PATH 下能否解析。
 *  Windows 用 where.exe 的绝对路径（libuv 找它不经 PATH）：sh 的 MSYS PATH
 *  语义在 Windows 上不可靠（实测：Windows 风格拼接令 sh 整体失效；且模拟
 *  PATH 里没有 sh 自身时 execFileSync 找不到 shell，会被吞成假"不可解析"）。
 *  POSIX 用 /bin/sh 绝对路径同理（不依赖模拟 PATH 里有 shell）。 */
function isResolvable(cmd: string, env: NodeJS.ProcessEnv): boolean {
  try {
    if (process.platform === 'win32') {
      const whereExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe')
      execFileSync(whereExe, [cmd], { env, stdio: 'pipe' })
    } else {
      execFileSync('/bin/sh', ['-c', `command -v ${cmd}`], { env, stdio: 'pipe' })
    }
    return true
  } catch {
    return false
  }
}

/**
 * 拆出 postinstall 链中「未被容错保护」的命令。
 * 段含 `||`（如 `node scripts/x.mjs || node -e 1`）左侧失败有恒成功兜底，
 * 命令允许不存在；无 `||` 的段失败会中断整条 `&&` 链，命令必须可解析。
 */
function unguardedCommands(postinstall: string): string[] {
  return postinstall
    .split('&&')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith('(') && s.endsWith(')') ? s.slice(1, -1).trim() : s))
    .filter((s) => !s.includes('||'))
    .map((s) => s.split(/\s+/)[0])
    .filter((c): c is string => Boolean(c))
}

test('postinstall 裸命令在全局安装环境（无 devDeps bin）中必须可解析', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: { postinstall?: string }
  }
  const postinstall = pkg.scripts?.postinstall
  assert.ok(postinstall, 'package.json 必须声明 postinstall')

  const env = { ...process.env, PATH: simulateGlobalInstallPath() }
  for (const cmd of unguardedCommands(postinstall)) {
    const resolvable = isResolvable(cmd, env)
    assert.ok(
      resolvable,
      `postinstall 裸命令 "${cmd}" 在全局安装环境（无 devDeps bin）中不可解析 → npm i -g 将 exit 127`,
    )
  }
})
