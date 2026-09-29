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
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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

process.env.RIVET_HOME = homeA
delete process.env.TIANSHU_IM_QQ_APPID
delete process.env.TIANSHU_IM_QQ_SECRET
delete process.env.RIVET_SERVER_TOKEN

const { tools } = await import('../index.js')
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
