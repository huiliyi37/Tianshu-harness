/**
 * 微信通道配置读取（凭据与数据目录）回归测试。
 *
 * 锁住两类东西：
 * - 安全形态：未配置 owner 就是「一律拒收」的前提（判定在 authorization.mjs），
 *   而 token 的展示形态只允许掩码。
 * - 与 QQ 通道**同源**的数据目录：两条通道共用一个 imbridge 目录，
 *   不许各写各的（否则部署时会多出一堆没人认领的目录）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_WEIXIN_BASE_URL,
  loadWeixinConfig,
  maskToken,
  weixinConfigFile,
  weixinStateFile,
  weixinTokenContextFile,
} from '../lib/weixin/config.mjs'
import { pluginDataDir } from '../lib/data-dir.mjs'

function makeHome(config) {
  const home = mkdtempSync(join(tmpdir(), 'wx-cfg-'))
  const dir = join(home, 'imbridge')
  mkdirSync(dir, { recursive: true })
  if (config !== undefined) {
    writeFileSync(join(dir, 'weixin.json'), typeof config === 'string' ? config : JSON.stringify(config))
  }
  return home
}

test('数据目录: 与 QQ 通道同源（同一个 imbridge 目录）', () => {
  const home = 'D:/h/.rivet'
  assert.equal(pluginDataDir({ RIVET_HOME: home }), join(home, 'imbridge'))
  assert.equal(weixinConfigFile({ RIVET_HOME: home }), join(home, 'imbridge', 'weixin.json'))
  assert.equal(weixinStateFile({ RIVET_HOME: home }), join(home, 'imbridge', 'weixin-state.json'))
  assert.equal(
    weixinTokenContextFile({ RIVET_HOME: home }),
    join(home, 'imbridge', 'weixin-tokens.json'),
  )
})

test('loadWeixinConfig: 完整配置（含 workspace）', () => {
  const home = makeHome({
    botToken: 'bot-token-abcdefghijklmn',
    ownerUserId: 'owner@im.wechat',
    workspace: 'D:/work/place',
  })
  try {
    const cfg = loadWeixinConfig({ RIVET_HOME: home })
    assert.equal(cfg.configured, true)
    assert.equal(cfg.botToken, 'bot-token-abcdefghijklmn')
    assert.equal(cfg.ownerUserId, 'owner@im.wechat')
    assert.equal(cfg.workspace, 'D:/work/place')
    assert.equal(cfg.baseUrl, DEFAULT_WEIXIN_BASE_URL)
    assert.equal(cfg.enabled, true)
    assert.equal(cfg.source, 'file')
    assert.equal(cfg.configError, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('loadWeixinConfig: 未配置 token → configured=false，且不抛错', () => {
  const home = makeHome({ ownerUserId: 'owner@im.wechat' })
  try {
    const cfg = loadWeixinConfig({ RIVET_HOME: home })
    assert.equal(cfg.configured, false)
    assert.equal(cfg.botToken, null)
    assert.equal(cfg.ownerUserId, 'owner@im.wechat')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('loadWeixinConfig: 未配置 owner → ownerUserId=null（安全默认的输入条件）', () => {
  const home = makeHome({ botToken: 'tk' })
  try {
    assert.equal(loadWeixinConfig({ RIVET_HOME: home }).ownerUserId, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('loadWeixinConfig: baseUrl 可覆盖，非法值回落默认（结尾斜杠归一）', () => {
  const home = makeHome({ botToken: 'tk', baseUrl: 'https://example.test/ilink/' })
  try {
    assert.equal(loadWeixinConfig({ RIVET_HOME: home }).baseUrl, 'https://example.test/ilink')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  const home2 = makeHome({ botToken: 'tk', baseUrl: 42 })
  try {
    assert.equal(loadWeixinConfig({ RIVET_HOME: home2 }).baseUrl, DEFAULT_WEIXIN_BASE_URL)
  } finally {
    rmSync(home2, { recursive: true, force: true })
  }
})

test('loadWeixinConfig: workspace 留空为 null（保持按会话隔离）', () => {
  const home = makeHome({ botToken: 'tk', workspace: '   ' })
  try {
    assert.equal(loadWeixinConfig({ RIVET_HOME: home }).workspace, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('loadWeixinConfig: enabled=false 被如实带出', () => {
  const home = makeHome({ botToken: 'tk', enabled: false })
  try {
    assert.equal(loadWeixinConfig({ RIVET_HOME: home }).enabled, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('loadWeixinConfig: 环境变量优先于文件（便于临时测试）', () => {
  const home = makeHome({ botToken: 'file-token', ownerUserId: 'file-owner@im.wechat' })
  try {
    const cfg = loadWeixinConfig({
      RIVET_HOME: home,
      TIANSHU_IM_WEIXIN_TOKEN: 'env-token',
      TIANSHU_IM_WEIXIN_OWNER: 'env-owner@im.wechat',
    })
    assert.equal(cfg.botToken, 'env-token')
    assert.equal(cfg.ownerUserId, 'env-owner@im.wechat')
    assert.equal(cfg.source, 'env')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('loadWeixinConfig: 只有 env token 时 source=env；只有文件时 source=file；都没有 none', () => {
  assert.equal(loadWeixinConfig({ RIVET_HOME: '/nonexistent-rivet-home-x' }).source, 'none')
  const home = makeHome()
  try {
    assert.equal(loadWeixinConfig({ RIVET_HOME: home }).source, 'none')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('loadWeixinConfig: 坏 JSON → 不抛错，configError 说明原因，configured=false', () => {
  const home = makeHome('{ 这不是 JSON')
  try {
    const cfg = loadWeixinConfig({ RIVET_HOME: home })
    assert.equal(cfg.configured, false)
    assert.match(cfg.configError, /weixin\.json/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('maskToken: 只露头尾，短值不整段泄露', () => {
  assert.equal(maskToken('abcdefghijklmnop'), 'abcd…nop')
  assert.equal(maskToken('short'), 'sh…')
  assert.equal(maskToken(''), null)
  assert.equal(maskToken(null), null)
  assert.equal(maskToken(12345), null)
})

test('凭据零泄漏: 配置对象整体序列化时不出现完整 token', () => {
  const home = makeHome({ botToken: 'SUPER-SECRET-TOKEN-0123456789', ownerUserId: 'o@im.wechat' })
  try {
    const cfg = loadWeixinConfig({ RIVET_HOME: home })
    // 连接层需要拿到真 token 才能发请求；这里锁的是「掩码函数不会把全量吐出去」
    assert.equal(JSON.stringify({ masked: maskToken(cfg.botToken) }).includes('SECRET-TOKEN-01'), false)
    assert.equal(maskToken(cfg.botToken).endsWith('789'), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
