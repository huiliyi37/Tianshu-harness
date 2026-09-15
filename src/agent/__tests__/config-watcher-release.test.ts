/**
 * config 热载 watcher 的释放回归。
 *
 * 背景：sidecar 空闲回收（releaseAgent → s.agent.shutdown()）丢弃 AgentLoop
 * 时，configWatcher 必须被 close——否则每次回收漏 2-3 个 fs.watch 句柄，句柄
 * 经 onHooksChange 闭包钉住整个旧 AgentLoop 对象图。TUI /model·/resume·/cd
 * 三路径已显式 close；serve 释放链由 ManagedAgent.shutdown 补齐。
 *
 * 为什么不数 process.getActiveResourcesInfo()：darwin 的 fs.watch 走 FSEvents
 * 且本处 persistent:false，句柄不进资源清单（Linux inotify 才以 FSWatcher 形
 * 态可见）——OS 计数在这台仪器上跨平台不可复现。改用 node:test 的
 * mock.method 包住**真实 handle 的真 close**（原方法照跑、调用被计数）：钉的
 * 是真正的回归面——close 被调、字段置空、重复调用幂等。
 */
import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { ToolRegistry } from '../../tools/registry.js'
import { PromptEngine } from '../../prompt/engine.js'
import type { StreamClient } from '../../api/stream-client.js'

/** 本套用例只验证 watcher 生命周期，永远不 run() —— client 仅满足必填类型 */
const deadClient: StreamClient = {
  stream: async () => { throw new Error('this test must not stream') },
}

const tempDirs: string[] = []
const savedEnv: Record<string, string | undefined> = {}

/** 隔离配置环境：RIVET_HOME + 项目 .rivet-config.json 各一份 → watcher 真实注册 */
function makeLoopWithConfigEnv(): { loop: AgentLoop; cwd: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'rivet-cw-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-cw-cwd-'))
  tempDirs.push(home, cwd)
  writeFileSync(join(home, 'config.json'), '{}\n')
  writeFileSync(join(cwd, '.rivet-config.json'), '{}\n')
  for (const k of ['RIVET_HOME', 'RIVET_CONFIG_PATH', 'RIVET_CONFIG_WATCH', 'RIVET_PROFILE']) {
    savedEnv[k] = process.env[k]
  }
  process.env.RIVET_HOME = home
  delete process.env.RIVET_CONFIG_PATH
  delete process.env.RIVET_CONFIG_WATCH
  delete process.env.RIVET_PROFILE

  const loop = new AgentLoop({
    client: deadClient,
    promptEngine: new PromptEngine({
      model: 'deepseek-v4-pro',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd },
    }),
    toolRegistry: new ToolRegistry(),
    maxTurns: 1,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    fsWatcherEnabled: false,
    // headless 未设 → 非 headless → 必装 configWatcher（loop.ts 装配门）
  }, new SessionContext(), cwd)
  return { loop, cwd, cleanup: () => loop.stopConfigWatcher() }
}

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k]
  for (const d of tempDirs.splice(0).reverse()) rmSync(d, { recursive: true, force: true })
})

describe('config watcher release on discard', () => {
  it('非 headless AgentLoop 必装 configWatcher；stopConfigWatcher 调真 close 并置空', () => {
    const { loop, cleanup } = makeLoopWithConfigEnv()
    try {
      assert.ok(loop.configWatcher, '非 headless 必装 configWatcher')
      const closeSpy = mock.method(loop.configWatcher!, 'close')
      loop.stopConfigWatcher()
      assert.equal(closeSpy.mock.callCount(), 1, 'stopConfigWatcher 必须恰好 close 一次（真实 close 照跑）')
      assert.equal(loop.configWatcher, null, 'close 后句柄字段置空')
    } finally {
      cleanup()
    }
  })

  it('stopConfigWatcher 幂等：字段已空时不再触 handle.close（bootstrap+shutdown 双调安全）', () => {
    const { loop } = makeLoopWithConfigEnv()
    loop.stopConfigWatcher() // 第一次（模拟 bootstrap switch 路径已关）
    const handle = loop.configWatcher
    assert.equal(handle, null)
    // 第二次（模拟 shutdown 再关）：守卫短路，不抛错
    assert.doesNotThrow(() => loop.stopConfigWatcher())
    assert.equal(loop.configWatcher, null)
  })
})
