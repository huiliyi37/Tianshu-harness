/**
 * issue #559 — Android 内嵌 payload 下 `LD_LIBRARY_PATH` 必须传递给 bash 工具子进程。
 *
 * 症状：内核本体由客户端启动（客户端已设 `LD_LIBRARY_PATH=$PREFIX/lib`），但 bash
 * 工具 fork 出的子进程丢掉该变量后，`nativeLibraryDir` 里的 node 找不到
 * `libz.so.1`（系统只提供 `libz.so`），报
 * `CANNOT LINK EXECUTABLE "node": library "libz.so.1" not found`。
 *
 * 边界：只放行 `LD_LIBRARY_PATH`。`LD_PRELOAD` / `LD_AUDIT` 可在子进程启动即注入
 * 任意代码，必须继续剥离。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { sanitizeEnv } from '../sanitize-env.js'

describe('sanitizeEnv: LD_LIBRARY_PATH 继承（issue #559）', () => {
  it('保留父进程已有的 LD_LIBRARY_PATH', () => {
    const result = sanitizeEnv({ PATH: '/bin', LD_LIBRARY_PATH: '/data/data/app/files/usr/lib' })
    assert.equal(result.LD_LIBRARY_PATH, '/data/data/app/files/usr/lib')
  })

  it('大小写变体同样保留（Windows/Android 混合环境）', () => {
    const result = sanitizeEnv({ PATH: '/bin', ld_library_path: '/opt/lib' })
    assert.equal(result.ld_library_path, '/opt/lib')
  })

  it('父进程没有该变量时不凭空造出来', () => {
    const result = sanitizeEnv({ PATH: '/bin' })
    assert.equal(Object.hasOwn(result, 'LD_LIBRARY_PATH'), false)
  })

  it('LD_PRELOAD 仍然剥离（启动即执行任意 so）', () => {
    const result = sanitizeEnv({ PATH: '/bin', LD_LIBRARY_PATH: '/opt/lib', LD_PRELOAD: '/tmp/evil.so' })
    assert.equal(Object.hasOwn(result, 'LD_PRELOAD'), false)
    assert.equal(result.LD_LIBRARY_PATH, '/opt/lib')
  })

  it('同族的 LD_AUDIT / DYLD_INSERT_LIBRARIES 一并剥离', () => {
    const result = sanitizeEnv({
      PATH: '/bin',
      LD_LIBRARY_PATH: '/opt/lib',
      LD_AUDIT: '/tmp/audit.so',
      DYLD_INSERT_LIBRARIES: '/tmp/inject.dylib',
    })
    assert.equal(Object.hasOwn(result, 'LD_AUDIT'), false)
    assert.equal(Object.hasOwn(result, 'DYLD_INSERT_LIBRARIES'), false)
    assert.equal(result.LD_LIBRARY_PATH, '/opt/lib')
  })

  it('其它任意 LD_* 变量仍被剥离（不做前缀放行）', () => {
    const result = sanitizeEnv({ PATH: '/bin', LD_SOMETHING_UNLISTED: 'x' })
    assert.equal(Object.hasOwn(result, 'LD_SOMETHING_UNLISTED'), false)
  })

  it('NODE_OPTIONS 仍剥离（issue #137 逻辑未被本次改动放宽）', () => {
    const result = sanitizeEnv({ PATH: '/bin', NODE_OPTIONS: '--require /tmp/evil.js' })
    assert.equal(Object.hasOwn(result, 'NODE_OPTIONS'), false)
  })
})

describe('sanitizeEnv: 真实子进程环境（issue #559 冒烟）', () => {
  // 生产路径（src/tools/bash.ts:570）就是把这棵 env 直接交给 spawn；这里用同一个
  // 函数产出 env 并真实执行子进程，确认「子进程能看到 LD_LIBRARY_PATH、看不到
  // LD_PRELOAD」——不是只看 sanitizeEnv 的返回值。
  it('spawn 出的子进程环境里 LD_LIBRARY_PATH 在、LD_PRELOAD 不在', { skip: process.platform === 'win32' ? 'POSIX only' : false }, () => {
    const parentEnv: NodeJS.ProcessEnv = {
      ...process.env,
      LD_LIBRARY_PATH: '/data/data/app/files/usr/lib',
      LD_PRELOAD: '/tmp/evil.so',
    }
    const env = sanitizeEnv(parentEnv) as Record<string, string>
    const stdout = execFileSync('/bin/sh', ['-c', 'printf "%s|%s" "${LD_LIBRARY_PATH-unset}" "${LD_PRELOAD-unset}"'], {
      env,
      encoding: 'utf8',
    })
    const [libPath, preload] = stdout.split('|')
    assert.equal(libPath, '/data/data/app/files/usr/lib')
    assert.equal(preload, 'unset')
  })
})
