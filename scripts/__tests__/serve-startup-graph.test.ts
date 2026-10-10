/**
 * serve 启动模块图门禁：listen 之前静态可达的图里不得混入 agent 内核 / TUI。
 *
 * 背景：sidecar 启动时 `early-routing.ts` 才 `await import('../server/serve.js')`，
 * 设计意图是 agent 内核（serve-agent）等 listen 之后再延迟加载。但只要静态边
 * （session-routes → slash-commands、session-manager → coordinator、
 * plugin-session-cache → default-registry/plugin-loader）存在，esbuild 就会把
 * 整个 agent/TUI 图打进 serve 的 chunk 闭包，延迟加载形同虚设。
 *
 * 失败时打印完整父链，按两种失效方向处理：
 * - 正当增长：调高 REACHABLE_LIMIT 并在提交信息/计划里写明原因；
 * - 新引入通往 agent 或 tui 的静态边：改成动态 `await import()`（参照
 *   src/cli/early-routing.ts 的延迟加载模式），或仅类型使用写 `import type`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeStaticImportGraph, formatBytes, type StaticImportGraph } from '../static-import-graph.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ENTRY = 'src/server/serve.ts'

/** 计划点名的 8 个重模块：serve 启动静态图里绝不该可达。 */
const FORBIDDEN_HEAVY = [
  'src/bootstrap.ts',
  'src/agent/loop.ts',
  'src/agent/worker-session.ts',
  'src/tui/engine/app.ts',
  'src/tui/slash-commands.ts',
  'src/tools/default-registry.ts',
  'src/agent/coordinator.ts',
  'src/plugins/plugin-loader.ts',
] as const

/**
 * 切链后实测约 383（1084 → 383，见计划文档）。
 *
 * 2026-10-05 复测 452：从切链基线到 10-05 的密集开发（HEAD~300→HEAD 共 300 提交）
 * 累积了 ~54 条 server/api 内部新增边（profile-routes、session-browser、goal-snapshot、
 * store-lock 等），逐提交摊平约 0.2 模块/提交——属正常的路由/工具增长，不是某一次
 * 「把半张 agent 图拉回来」。同期的 FORBIDDEN_HEAVY 8 个重模块不可达守卫仍为绿，
 * 未出现 agent 内核整体回流。故上调上限至 480（452 + ~6% 余量）。
 *
 * 再次触顶时的处置顺序：先确认 FORBIDDEN_HEAVY 仍全绿且新增边不是通往 agent/tui
 * 的大块子树（用 why(parent) 看父链），再决定调上限或把该边改动态 `await import()`。
 *
 * 2026-10-07 复测 489（**代为登记**，非本会话改动）：10-05→10-07 的技能管理统一
 * （skill-management-routes / skill-management-compat 静态链，4940f9c94 等）与其余
 * server 面增长把图推到 489；jszip/yaml 随之静态进图。父链核对（why）确认增长来自
 * server 路由/兼容层，FORBIDDEN_HEAVY 8 模块仍全绿、无 agent/tui 内核回流。
 * 上限 → 500（489 + ~2% 余量）。若技能管理后续把静态边改动态 import，应回调本值。
 * 2026-10-09：500→510——file-context 路由加工作区守卫（安全修复，#221 同族），
 * 引入 workspace-guard → project-trust 链，实测 504。FORBIDDEN_HEAVY 仍全绿。
 * 2026-10-10：510→525（代为登记，对齐实测 512，非本会话增长）——10-09 后 server 面
 * 路由/会话演进新增 ~8 条边；FORBIDDEN_HEAVY 8 模块全绿、无 agent/tui 回流。
 * 收编 Windows 审计补丁包（20261009）P2-04 同项：公开仓按 ce4b60a 实测 504 调
 * 500→520，dev 按本仓实测另调。
 */
const REACHABLE_LIMIT = 525

/**
 * 启动图允许静态出现的 bare 包（tsup 会按入口可达性把它们打进 chunk）。
 * 与图做**集合相等**检查，不是子集：包退出图时也要从清单删掉，否则旧条目会给
 * 它日后的回归留后门。新增/退出都必须同步本清单并写明理由。
 * 当前清单：chalk（theme/ansi）、diff（cpu-tasks）、undici（api/mcp/http）、zod（config 族）、
 * jszip / yaml（2026-10-07 代为登记：技能管理路由 skill-management-routes 静态链引入，
 * 供 zip 技能导入导出与 SKILL.md 元数据解析）。
 */
const ALLOWED_STARTUP_PACKAGES = ['chalk', 'diff', 'undici', 'zod', 'jszip', 'yaml'] as const

let cached: StaticImportGraph | null = null
function serveGraph(): StaticImportGraph {
  cached ??= analyzeStaticImportGraph({ root: ROOT, entry: ENTRY })
  return cached
}

test('serve 启动静态图：8 个 agent/TUI 重模块不可达（失败时打印完整链路）', () => {
  const g = serveGraph()
  const violations = FORBIDDEN_HEAVY.filter((m) => g.modules.has(resolve(ROOT, m)))
  const details = violations
    .map((m) => `\n  ✗ ${m}\n      ${g.why(m).join('\n    → ')}`)
    .join('')
  assert.equal(
    violations.length,
    0,
    `serve 启动静态图混入了 ${violations.length} 个重模块：${details}\n\n` +
      '修法：把这条边改成函数内 `await import()`（参照 src/cli/early-routing.ts），' +
      '纯类型使用改 `import type`；不要用调高模块数上限来放行（那等于接受 agent 内核回到启动图）。',
  )
})

test(`serve 启动静态图：可达模块数 ≤ ${REACHABLE_LIMIT}`, () => {
  const g = serveGraph()
  assert.ok(
    g.modules.size <= REACHABLE_LIMIT,
    `serve 可达 ${g.modules.size} 个模块 / ${formatBytes(g.bytes)}，超过上限 ${REACHABLE_LIMIT}。\n` +
      '若为正当增长：调高 REACHABLE_LIMIT 并写明原因；\n' +
      '若新增了通往 agent 或 tui 的边：改成动态 import（否则 listen 前的启动图又被拉大）。',
  )
})

test('serve 启动静态图：unresolved 必须为空（解析失败的子树会静默掉出图）', () => {
  const g = serveGraph()
  assert.deepEqual(
    g.unresolved,
    [],
    `有 ${g.unresolved.length} 个 specifier 解析失败——它后面的整棵子树会从图中消失，门禁数字失真：\n  ${g.unresolved.join('\n  ')}`,
  )
})

test('serve 启动静态图：bare 包集合 = 允许清单（新增/退出都要求同步账本）', () => {
  const g = serveGraph()
  const actual = [...g.packages.keys()].sort()
  const expected = [...ALLOWED_STARTUP_PACKAGES].sort()
  assert.deepEqual(
    actual,
    expected,
    `serve 启动图 bare 包集合与清单不一致：\n  实际 ${actual.join(', ') || '(空)'}\n  清单 ${expected.join(', ') || '(空)'}\n` +
      '新增包：确认它该静态进 listen 前的 chunk 后加进 ALLOWED_STARTUP_PACKAGES 并写明理由，否则改动态 import；\n' +
      '已退出的包：从清单删掉——只做子集检查会让旧条目给未来的回归开后门。',
  )
})
