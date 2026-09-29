import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadQqConfig, maskAppId, pluginDataDir } from '../lib/qq/config.mjs'

test('pluginDataDir: RIVET_HOME 优先', () => {
  assert.equal(pluginDataDir({ RIVET_HOME: 'D:/h/.rivet' }), join('D:/h/.rivet', 'imbridge'))
})

function makeHome(config) {
  const home = mkdtempSync(join(tmpdir(), 'cfg-'))
  const dir = join(home, 'imbridge')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
  return home
}

test('loadQqConfig: 完整配置（含 workspace）', () => {
  const home = makeHome({ appId: '123', appSecret: 'sec', workspace: 'D:/work/place' })
  try {
    const cfg = loadQqConfig({ RIVET_HOME: home })
    assert.equal(cfg.configured, true)
    assert.equal(cfg.appId, '123')
    assert.equal(cfg.workspace, 'D:/work/place')
    assert.equal(cfg.source, 'file')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('loadQqConfig: 无 workspace 时为 null（保持默认隔离行为）', () => {
  const home = makeHome({ appId: '1', appSecret: 's' })
  try {
    const cfg = loadQqConfig({ RIVET_HOME: home })
    assert.equal(cfg.workspace, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('loadQqConfig: 缺失/坏配置的安全路径', () => {
  const home = mkdtempSync(join(tmpdir(), 'cfg-'))
  try {
    const cfg = loadQqConfig({ RIVET_HOME: home })
    assert.equal(cfg.configured, false)
    assert.equal(cfg.workspace, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('maskAppId: 掩码格式', () => {
  assert.equal(maskAppId('1234567890'), '1234…890')
  assert.equal(maskAppId('123'), '12…')
  assert.equal(maskAppId(null), null)
})
