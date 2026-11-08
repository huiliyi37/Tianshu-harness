/**
 * 插件入口（index.js）测试：im_status 工具的真实执行路径。
 *
 * 背景（2026-09-24）：im_status 曾引用未定义的 sessionMapCache，
 * 因入口零测试覆盖而潜伏（245 例全绿也没拦住）。本文件把入口工具钉住。
 *
 * 环境隔离：必须在导入 index.js 之前完成 ——
 * - RIVET_HOME → 临时目录：不读真实配置、不碰真实数据目录（QQ 保持 not-configured）
 * - 凭据 / serve 环境变量 → 清空：本机残留不影响断言
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// homeA：预置两条绑定（session-map.json），用于断言如实读数
const homeA = mkdtempSync(join(tmpdir(), 'imbridge-entry-a-'))
const dataDirA = join(homeA, 'imbridge')
mkdirSync(dataDirA, { recursive: true })
writeFileSync(join(dataDirA, 'session-map.json'), JSON.stringify({
  'c2c:user-1': 'session-1',
  'c2c:user-2': 'session-2',
}))

// homeB：空目录（无绑定表），用于断言缺文件时的兜底
const homeB = mkdtempSync(join(tmpdir(), 'imbridge-entry-b-'))

// 跑完收摊：两个临时 HOME 是本次运行的产物，别留在盘上（历史上攒了十几个没人管）。
after(() => {
  rmSync(homeA, { recursive: true, force: true })
  rmSync(homeB, { recursive: true, force: true })
})

process.env.RIVET_HOME = homeA
delete process.env.TIANSHU_IM_QQ_APPID
delete process.env.TIANSHU_IM_QQ_SECRET
delete process.env.RIVET_SERVER_TOKEN

const { tools } = await import('../impl.js')
const imStatus = tools.find((t) => t.definition.name === 'im_status')
const callImStatus = async () => JSON.parse((await imStatus.execute()).content)

test('入口: im_status 已注册且 execute 可调用', () => {
  assert.ok(imStatus, 'tools 里应有 im_status')
  assert.equal(typeof imStatus.execute, 'function')
})

test('im_status: execute 不抛错、返回合法 JSON（回归: sessionMapCache 悬空引用）', async () => {
  const payload = await callImStatus()
  assert.equal(payload.plugin, 'tianshu-imbridge')
  assert.equal(typeof payload.mode, 'string')
  assert.equal(payload.serveAvailable, false, '测试进程无 --port，不应误判 serve 可用')
  assert.equal(typeof payload.sessionMapSize, 'number')
})

test('im_status: sessionMapSize 如实反映绑定表落盘条目数', async () => {
  const payload = await callImStatus()
  assert.equal(payload.sessionMapSize, 2)
})

test('im_status: 绑定表缺失时 sessionMapSize 为 0（兜底不炸）', async () => {
  process.env.RIVET_HOME = homeB
  try {
    const payload = await callImStatus()
    assert.equal(payload.sessionMapSize, 0)
  } finally {
    process.env.RIVET_HOME = homeA
  }
})

// ── TPI 1.0 入口（4.0.4）────────────────────────────────────────
// 为什么单独钉：4.0.4 起宿主只认 `export default defineTianshuPlugin(...)`，
// 旧的 `export const tools` 会被判为「not a TPI plugin」而整插件跳过（2026-11-08 实测）。

/** 装一个最小宿主 SDK，让入口模块可以被 import 并断言。 */
async function loadTpiEntry(tag) {
  globalThis.__tianshuTPI = { defineTianshuPlugin: (spec) => spec }
  try {
    return (await import(`../index.js?tpi=${tag}`)).default
  } finally {
    delete globalThis.__tianshuTPI
  }
}

test('TPI 入口: 默认导出插件描述，id 与入口文件一致', async () => {
  const spec = await loadTpiEntry('id')
  assert.equal(spec.id, 'tianshu-imbridge')
  assert.equal(typeof spec.activate, 'function')
})

test('TPI 入口: activate 交出 4 个新契约工具，不残留旧 definition 字段', async () => {
  const spec = await loadTpiEntry('shape')
  const { tools: tpiTools } = spec.activate()
  assert.equal(tpiTools.length, 4)
  assert.deepEqual(tpiTools.map((t) => t.name).sort(),
    ['im_send', 'im_status', 'weixin_bind_start', 'weixin_bind_status'])
  for (const t of tpiTools) {
    assert.equal(typeof t.inputSchema, 'object', `${t.name} 缺 inputSchema`)
    assert.equal(typeof t.execute, 'function', `${t.name} 缺 execute`)
    assert.equal(typeof t.pathParams, 'object', `${t.name} 缺 pathParams`)
    assert.equal('definition' in t, false, `${t.name} 残留旧契约字段`)
  }
})

test('TPI 入口: 执行入口走 execute({args}) 而不是裸参数', async () => {
  const spec = await loadTpiEntry('exec')
  const { tools: tpiTools } = spec.activate()
  const imSend = tpiTools.find((t) => t.name === 'im_send')
  // 无参调用：不应抛错，且应以「需要 text 参数」这种业务错误返回
  const out = await imSend.execute({ args: {} })
  assert.equal(out.isError, true)
  assert.match(out.content, /text/)
})

test('pathParams 守卫: 任何路径类参数都必须登记（S3 不变量）', async () => {
  const spec = await loadTpiEntry('guard')
  const { tools: tpiTools } = spec.activate()
  const PATH_LIKE = new Set([
    'path', 'file_path', 'input_path', 'output_path', 'actual_path', 'reference_path',
    'annotation_path', 'destination_path', 'data_path', 'dataDir', 'dir', 'workspace',
  ])
  for (const t of tpiTools) {
    const props = Object.keys(t.inputSchema?.properties ?? {})
    const declared = new Set(Object.keys(t.pathParams ?? {}))
    for (const key of props) {
      if (!PATH_LIKE.has(key)) continue
      assert.ok(declared.has(key),
        `${t.name} 的路径参数 ${key} 未登记 pathParams —— 内核路径守卫会静默失效`)
    }
  }
})

test('pathParams: 非路径参数不得进入守卫表', async () => {
  const spec = await loadTpiEntry('nonpath')
  const { tools: tpiTools } = spec.activate()
  const imSend = tpiTools.find((t) => t.name === 'im_send')
  assert.deepEqual(imSend.pathParams, {})
})
