import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 安装脚本的 npm 全局目录预检。
//
// 缺陷背景：官方 Node 安装包把 npm 全局 prefix 放在 /usr/local（属主 root），
// 普通用户执行 `npm install -g` 必然 EACCES。install-tui.sh 原先直接调用
// `npm install -g`，失败后一律 die 成「网络问题可换官方源重跑」——把权限问题
// 误诊为网络问题，用户照做无效。
//
// 这里用 PATH 前置的 stub npm 复现：prefix 指向只读目录、install 失败。
const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, '..', 'install-tui.sh')
const skip = process.platform === 'win32' ? '需要 POSIX shell（Windows 走 install-tui.ps1）' : false

interface Sandbox {
  run: (args?: string[]) => { status: number | null; out: string }
  remainingLogs: () => string[]
  cleanup: () => void
}

type InstallOutcome = 'success' | 'EACCES' | 'EPERM' | 'ETIMEDOUT' | 'ECONNRESET'

function sandbox(
  prefixMode: 'locked' | 'writable',
  outcome: InstallOutcome = prefixMode === 'writable' ? 'success' : 'EACCES',
  logFault?: 'create' | 'tee',
  diagnostic?: { pathComponent?: string; message?: string; legacy?: boolean },
): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'install-tui-preflight-'))
  const stubBin = join(root, 'stub-bin')
  const temporary = join(root, 'tmp')
  const prefix = join(root, diagnostic?.pathComponent ?? (prefixMode === 'locked' ? 'locked-prefix' : 'writable-prefix'))
  const globalModules = join(prefix, 'lib', 'node_modules')
  mkdirSync(stubBin, { recursive: true })
  mkdirSync(temporary)
  mkdirSync(globalModules, { recursive: true })

  // 只替代真实全局安装；实际 shell 的输出、退出和临时文件清理仍参与验证。
  writeFileSync(
    join(stubBin, 'npm'),
    `#!/bin/sh
case "$1" in
  prefix)
    [ "$2" = "-g" ] && { printf '%s\\n' "$STUB_NPM_PREFIX"; exit 0; }
    exit 0 ;;
  ls) exit 1 ;;
  uninstall) exit 0 ;;
  install)
    printf 'npm install progress\\n'
    printf 'npm resolving progress\\n' >&2
    if [ "$STUB_NPM_INSTALL_OUTCOME" = "success" ]; then exit 0; fi
    printf '%s code %s\\n%s path %s/lib/node_modules/tianshu-harness\\n' "$STUB_NPM_LABEL" "$STUB_NPM_INSTALL_OUTCOME" "$STUB_NPM_LABEL" "$STUB_NPM_PREFIX" >&2
    [ -z "$STUB_NPM_MESSAGE" ] || printf '%s message %s\\n' "$STUB_NPM_LABEL" "$STUB_NPM_MESSAGE" >&2
    exit 1 ;;
esac
exit 0
`,
    { mode: 0o755 },
  )

  writeFileSync(join(stubBin, 'tianshu'), `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then printf 'QA version\\n'; exit 0; fi
for log in "$TMPDIR"/tianshu-install.*; do
  [ ! -e "$log" ] || { printf 'installation log leaked before launch\\n' >&2; exit 91; }
done
printf 'QA launched\\n'
`, { mode: 0o755 })
  if (logFault === 'create') {
    writeFileSync(join(stubBin, 'mktemp'), '#!/bin/sh\nprintf "temporary file unavailable\\n" >&2\nexit 1\n', { mode: 0o755 })
  } else if (logFault === 'tee') {
    writeFileSync(join(stubBin, 'tee'), '#!/bin/sh\ncat >/dev/null\nprintf "log write failed\\n" >&2\nexit 1\n', { mode: 0o755 })
  }

  // 只读目录 = 模拟 /usr/local 的权限形状
  if (prefixMode === 'locked') chmodSync(globalModules, 0o555)

  return {
    run(args = ['--no-launch']) {
      const r = spawnSync('/bin/bash', [SCRIPT, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${stubBin}:${process.env.PATH ?? ''}`,
          STUB_NPM_PREFIX: prefix,
          STUB_NPM_INSTALL_OUTCOME: outcome,
          STUB_NPM_LABEL: diagnostic?.legacy ? 'npm ERR!' : 'npm error',
          STUB_NPM_MESSAGE: diagnostic?.message ?? '',
          TMPDIR: temporary,
          NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
        },
      })
      return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
    },
    remainingLogs: () => readdirSync(temporary).filter(name => !name.startsWith('._')),
    cleanup() {
      chmodSync(globalModules, 0o755)
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe('install-tui.sh — npm 全局目录预检', { skip }, () => {
  it('全局目录不可写：明确指出权限原因与修法，不再误诊为网络问题', () => {
    const sb = sandbox('locked')
    try {
      const { status, out } = sb.run()
      assert.notEqual(status, 0, '应非零退出')
      assert.match(out, /不可写/, '脚本自身应点出「全局目录不可写」')
      assert.match(out, /chown|npm-global/, '应给出可操作的修法')
      assert.doesNotMatch(out, /网络问题/, '不应把权限失败误诊为网络问题')
    } finally {
      sb.cleanup()
    }
  })

  it('全局目录可写：不误拦，正常走完安装流程', () => {
    const sb = sandbox('writable')
    try {
      const { status, out } = sb.run()
      assert.equal(status, 0, `可写时应正常结束：\n${out}`)
      assert.doesNotMatch(out, /不可写/, '可写时不应报权限问题')
      assert.match(out, /npm install progress/)
      assert.match(out, /npm resolving progress/)
      assert.deepEqual(sb.remainingLogs(), [], '安装成功后应清理诊断日志')
    } finally {
      sb.cleanup()
    }
  })

  for (const code of ['EACCES', 'EPERM'] as const) {
    it(`可写 prefix 下 npm ${code}：报告权限原因和修法并清理日志`, () => {
      const sb = sandbox('writable', code)
      try {
        const { status, out } = sb.run()
        assert.equal(status, 1, out)
        assert.match(out, new RegExp(`npm error code ${code}`), '保留 npm 原始错误')
        assert.match(out, /权限|不可写/, 'prefix 可写不代表包内路径没有权限错误')
        assert.match(out, /chown|npm-global/, '应给出权限修法')
        assert.doesNotMatch(out, /网络问题/, '权限错误不能误诊为网络')
        assert.deepEqual(sb.remainingLogs(), [], '失败退出也应清理诊断日志')
      } finally { sb.cleanup() }
    })

    it(`旧 npm ERR! code ${code}：仍识别权限原因并清理日志`, () => {
      const sb = sandbox('writable', code, undefined, { legacy: true })
      try {
        const { status, out } = sb.run()
        assert.equal(status, 1, out)
        assert.match(out, new RegExp(`npm ERR! code ${code}`))
        assert.match(out, /权限|不可写/)
        assert.match(out, /chown|npm-global/)
        assert.doesNotMatch(out, /网络问题/)
        assert.deepEqual(sb.remainingLogs(), [])
      } finally { sb.cleanup() }
    })

    it(`ETIMEDOUT 路径含 ${code}：不能把路径当权限错误码`, () => {
      const sb = sandbox('writable', 'ETIMEDOUT', undefined, { pathComponent: code })
      try {
        const { status, out } = sb.run()
        assert.equal(status, 1, out)
        assert.match(out, /npm error code ETIMEDOUT/)
        assert.match(out, new RegExp(`/${code}/lib/node_modules/tianshu-harness`))
        assert.match(out, /网络问题/)
        assert.doesNotMatch(out, /权限|不可写|chown|npm-global/)
        assert.deepEqual(sb.remainingLogs(), [])
      } finally { sb.cleanup() }
    })

    it(`ECONNRESET 正文含 ${code}：不能把正文当权限错误码`, () => {
      const sb = sandbox('writable', 'ECONNRESET', undefined, { message: `upstream ${code} policy text` })
      try {
        const { status, out } = sb.run()
        assert.equal(status, 1, out)
        assert.match(out, /npm error code ECONNRESET/)
        assert.match(out, new RegExp(`npm error message upstream ${code} policy text`))
        assert.match(out, /网络问题/)
        assert.doesNotMatch(out, /权限|不可写|chown|npm-global/)
        assert.deepEqual(sb.remainingLogs(), [])
      } finally { sb.cleanup() }
    })
  }

  it('可写 prefix 下 npm ETIMEDOUT：保留网络建议并清理日志', () => {
    const sb = sandbox('writable', 'ETIMEDOUT')
    try {
      const { status, out } = sb.run()
      assert.equal(status, 1, out)
      assert.match(out, /npm error code ETIMEDOUT/)
      assert.match(out, /网络问题/)
      assert.doesNotMatch(out, /权限|不可写/)
      assert.deepEqual(sb.remainingLogs(), [])
    } finally { sb.cleanup() }
  })

  it('安装成功启动 tianshu 前必须已清理诊断日志', () => {
    const sb = sandbox('writable')
    try {
      const { status, out } = sb.run([])
      assert.equal(status, 0, out)
      assert.match(out, /QA launched/)
      assert.deepEqual(sb.remainingLogs(), [])
    } finally { sb.cleanup() }
  })

  it('诊断日志创建失败：停止安装并给出日志错误', () => {
    const sb = sandbox('writable', 'success', 'create')
    try {
      const { status, out } = sb.run()
      assert.equal(status, 1, out)
      assert.match(out, /诊断日志/)
      assert.doesNotMatch(out, /npm install progress/, '无法捕获诊断时不启动安装')
      assert.deepEqual(sb.remainingLogs(), [])
    } finally { sb.cleanup() }
  })

  it('tee 保存日志失败：不得误报安装成功且须清理临时文件', () => {
    const sb = sandbox('writable', 'success', 'tee')
    try {
      const { status, out } = sb.run()
      assert.equal(status, 1, out)
      assert.match(out, /诊断日志/)
      assert.doesNotMatch(out, /安装完成。下一步/)
      assert.deepEqual(sb.remainingLogs(), [])
    } finally { sb.cleanup() }
  })
})
