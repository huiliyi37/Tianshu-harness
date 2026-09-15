/**
 * apply_patch 协作式取消（同 bash-abort.test.ts 的契约在 apply_patch 上的对齐）。
 *
 * 病灶：APPLY_PATCH_TOOL.execute 此前不读 params.abortSignal —— tool-pipeline
 * 的 composedSignal（loop 中断 + 工具超时）对 applyPatch 内部已写好的
 * SIGTERM 接线（spawn-git 的 child.kill）从未接线。git apply 挂住
 * （index.lock 竞争 / 慢盘）时：ESC 中断或 120s 工具超时只 reject wrapper，
 * git 孤儿进程继续写工作区（--3way 半套用状态与模型后续动作竞态），
 * patch 临时文件也因 execute 悬空永不清理。
 *
 * 契约（对照 bash-abort）：
 *  - abort 时 git 子进程被 SIGTERM：挂住的 stub apply 进程死掉。
 *  - abort 时 execute 立即 settle（不等超时 reject / 自然结束）。
 *  - 启动前已 aborted 的 signal 同样立即 settle。
 *
 * 用 RIVET_GIT_PATH 注入 stub git（spawn-git.ts 官方测试钩子）：
 * `apply` 参数 → 写哨兵 pid 文件后挂住；其他参数（reset 等）快速退出 0。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APPLY_PATCH_TOOL } from '../apply-patch.js'
import type { ToolCallParams } from '../types.js'

const isWin = process.platform === 'win32'
const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms))

const _savedGitPath = process.env.RIVET_GIT_PATH
let _stubDir: string
let _stubPidFile: string

/** stub git：apply 挂住（追加哨兵 pid —— 多次启动累积，收尸逐个杀）；
 *  其余快速退出 —— 失败分支的 unstagePatchTargets（git reset）因此不会被
 *  同一支 stub 拖住。 */
function writeStubGit(): string {
  const stub = join(_stubDir, 'git-stub.sh')
  writeFileSync(stub, [
    '#!/bin/sh',
    'if [ "$1" = "apply" ]; then',
    `  echo $$ >> '${_stubPidFile}'`,
    '  while :; do sleep 1; done',
    'fi',
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(stub, 0o755)
  return stub
}

/** SIGKILL 全部哨兵 pid —— 红态（修复缺失）下 stub 进程不会被 SIGTERM，
 *  悬空的 execute promise 连同挂住的子进程会拖死 test runner（stdio pipe
 *  未关）。每条测试的 finally 都必须调用，红绿两态都要能干净收场。 */
function reapStubs(): void {
  try {
    for (const line of readFileSync(_stubPidFile, 'utf-8').split('\n')) {
      const pid = Number.parseInt(line.trim(), 10)
      if (Number.isFinite(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* 已死 */ } }
    }
  } catch { /* pid 文件缺失 —— stub 未启动过 */ }
}

before(() => {
  if (isWin) return
  _stubDir = mkdtempSync(join(tmpdir(), 'rivet-apply-abort-stub-'))
  _stubPidFile = join(_stubDir, 'stub.pid')
  process.env.RIVET_GIT_PATH = writeStubGit()
})

after(() => {
  if (isWin) return
  reapStubs() // 兜底：测试内 finally 之外的残留（如 waitStubPid 阶段抛错）
  if (_savedGitPath === undefined) delete process.env.RIVET_GIT_PATH
  else process.env.RIVET_GIT_PATH = _savedGitPath
  rmSync(_stubDir, { recursive: true, force: true })
})

/** 新建文件的 diff：existedBefore=false，绕开 trackFileChange/backup 依赖。 */
const NEW_FILE_DIFF = [
  'diff --git a/new-file.txt b/new-file.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new-file.txt',
  '@@ -0,0 +1 @@',
  '+hello',
  '',
].join('\n')

function makeParams(signal: AbortSignal, cwd: string): ToolCallParams {
  return {
    input: { diff: NEW_FILE_DIFF },
    toolUseId: 'apply-abort-' + Math.random().toString(36).slice(2),
    cwd,
    abortSignal: signal,
  }
}

async function waitStubPid(): Promise<number> {
  for (let i = 0; i < 100; i++) {
    try {
      const lines = readFileSync(_stubPidFile, 'utf-8').split('\n').filter(Boolean)
      if (lines.length > 0) return Number.parseInt(lines[lines.length - 1]!.trim(), 10)
    } catch {
      // pid 文件尚未出现 —— stub apply 还没起
    }
    await sleepMs(50)
  }
  throw new Error('stub apply 进程 5s 内未启动 —— 哨兵 pid 文件未出现')
}

async function waitPidDead(pid: number, budgetMs: number): Promise<boolean> {
  for (let i = 0; i < budgetMs / 50; i++) {
    try { process.kill(pid, 0) } catch { return true }
    await sleepMs(50)
  }
  return false
}

test('abort 时 git 子进程被杀且 execute 立即 settle', { skip: isWin }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-apply-abort-'))
  try {
    const ctrl = new AbortController()
    const p = APPLY_PATCH_TOOL.execute(makeParams(ctrl.signal, cwd))
    const pid = await waitStubPid()

    ctrl.abort()

    // 契约 1：SIGTERM 到达 —— stub apply 进程死（现码：kill 从不被调，此处红）。
    const dead = await waitPidDead(pid, 5_000)
    assert.ok(dead, 'abort 后 5s 内 stub git apply 进程应被 SIGTERM 杀死')

    // 契约 2：execute 落地（现码：applyPatch 悬空，execute 永不 settle，此处红）。
    const result = await Promise.race([
      p,
      sleepMs(5_000).then(() => { throw new Error('execute 未在 abort 后 5s 内 settle —— 信号未级联到 git 子进程') }),
    ])
    // SIGTERM 杀死的 apply → status null → ok:false → 失败分支文案。
    assert.ok(result.isError, '被中断的 apply 应以错误落地')
  } finally {
    reapStubs()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('启动前已 aborted 的 signal 同样立即 settle', { skip: isWin }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-apply-abort-pre-'))
  try {
    const ctrl = new AbortController()
    ctrl.abort()
    const result = await Promise.race([
      APPLY_PATCH_TOOL.execute(makeParams(ctrl.signal, cwd)),
      sleepMs(5_000).then(() => { throw new Error('pre-aborted signal 下 execute 仍挂起') }),
    ])
    assert.ok(result.isError, 'pre-aborted 的 apply 应以错误落地而非挂起')
  } finally {
    reapStubs()
    rmSync(cwd, { recursive: true, force: true })
  }
})
