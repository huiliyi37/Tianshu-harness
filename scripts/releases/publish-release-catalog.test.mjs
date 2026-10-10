import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { delimiter, dirname, join } from 'node:path'

// scripts/releases/ -> 仓库根
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = 'scripts/releases/publish-release-catalog.sh'

function resolveBash() {
  if (process.platform !== 'win32') return 'bash'
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
  if (existsSync(gitBash)) return gitBash
  const localBash = join(process.env.LOCALAPPDATA || '', 'Programs\\Git\\bin\\bash.exe')
  if (existsSync(localBash)) return localBash
  return 'bash'
}
const BASH = resolveBash()

const run = (args = [], env) => spawnSync(BASH, [SCRIPT, ...args], { cwd: root, encoding: 'utf8', env: env ?? process.env, windowsHide: true })

/** 造一个假的 gh 隔离网络；stub 只影响前置检查。 */
function withStubGh(body) {
  const dir = mkdtempSync(join(tmpdir(), 'prc-stub-'))
  const f = join(dir, 'gh')
  writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`)
  try { chmodSync(f, 0o755) } catch {}
  return { website: dir.replace(/\\/g, '/'), env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` }, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// release 存在、isDraft 可配、资产齐（含 latest.json 三平台引用的文件名）。
const stubGh = isDraft => `
if [ "$1" = release ] && [ "$2" = view ]; then
  case "$*" in
    *--json\\ isDraft*) echo ${isDraft} ;;
    *--json\\ assets*) printf '%s\\n' Tianshu_3.29.2_aarch64.app.tar.gz Tianshu_3.29.2_aarch64.dmg Tianshu_3.29.2_x64.app.tar.gz Tianshu_3.29.2_x64.dmg Tianshu_3.29.2_x64-setup.exe ;;
  esac
  exit 0
fi
exit 0
`

test('publish-release-catalog.sh 语法正确', () => {
  const r = spawnSync(BASH, ['-n', SCRIPT], { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr)
})

test('未知参数以退出码 2 拒绝（不静默吞掉）', () => {
  const r = run(['--nope'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /未知参数/)
})

// 核心安全不变量：dry run 是纯读——不得上传 OSS、不得生成/提交 catalog、不得发布。
// 用各下游步骤自身的输出指纹当探针（dry-run 的计划文本刻意不含这些串）：
//   upload-update-to-oss.sh -> "==> 同步"
//   generate-catalog.mjs    -> "Validated v"
//   publish-routing.mjs     -> "Published v"
test('默认 dry-run 不执行任何写或对外步骤', () => {
  const r = run([])
  assert.ok(!r.stdout.includes('==> 同步'), 'dry-run 不得运行 upload-update-to-oss.sh')
  assert.ok(!r.stdout.includes('Validated v'), 'dry-run 不得运行 generate-catalog.mjs')
  assert.ok(!r.stdout.includes('Published v'), 'dry-run 不得运行 publish-routing.mjs')
})

// 前置不齐必须 fail-closed（非 0 退出 + 明确提示），齐备则停在 DRY RUN——两种情况都不得对外发布。
test('前置检查 fail-closed：不齐则非 0 退出，齐则停在 DRY RUN', () => {
  const r = run([])
  if (r.status === 0) {
    assert.match(r.stdout, /DRY RUN/)
  } else {
    assert.equal(r.status, 1)
    assert.match(r.stderr, /✗/)
  }
})

// draft release 不会被 releases/latest 解析——catalog 传上去客户端也读不到，必须拦下。
test('release 仍是 draft 时 fail-closed', () => {
  const s = withStubGh(stubGh('true'))
  try {
    const r = run(['--website', s.website], s.env)
    assert.notEqual(r.status, 0, 'draft release 应被拦截')
    assert.match(r.stderr, /draft/)
    assert.ok(!r.stdout.includes('DRY RUN'), 'draft 不得放行到发布流程')
  } finally { s.cleanup() }
})

// 前置全过（stub 假装 release 已发布、资产齐）时，dry-run 应停在 DRY RUN 且零副作用。
test('前置全过时停在 DRY RUN 且不触发任何写/对外步骤', () => {
  const s = withStubGh(stubGh('false'))
  try {
    const r = run(['--website', s.website], s.env)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /DRY RUN/)
    assert.ok(!r.stdout.includes('==> 同步'))
    assert.ok(!r.stdout.includes('Validated v'))
    assert.ok(!r.stdout.includes('Published v'))
  } finally { s.cleanup() }
})

// 不加 --with-atomgit 时必须显式告警——否则 atomgit 这条国内分流会被静默排除（本轮真踩过）。
test('默认不加 --with-atomgit 时显式告警 AtomGit 未纳入', () => {
  const s = withStubGh(stubGh('false'))
  try {
    const r = run(['--website', s.website], s.env)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /AtomGit 源未纳入/)
  } finally { s.cleanup() }
})
