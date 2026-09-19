/**
 * 漂移守卫：TS 常量 ↔ Rust 常量必须一致。
 *
 * 授权链路的常量散落在三种语言/三个位置（TS 验签、Rust 验签+签发校验、
 * Worker 签发）。任何一处改了另一处没跟，后果都是**静默锁死所有付费用户**
 * （验签永远失败 → 全员 Basic）——线上最难排查的一类故障。所以用测试把
 * Rust 源码当文本解析，硬性比对。
 *
 * 这不是「测试实现细节」，而是把「三处必须一致」这条注释变成 CI 门禁。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { INTEGRITY_SIGNING_DOMAIN, LICENSE_PRODUCT, LICENSE_PUBLIC_KEY_B64 } from '../license-keys.js'
import { DEFAULT_CLOCK_SKEW_MS, DEFAULT_OFFLINE_DAYS, DEFAULT_OFFLINE_MS } from '../pro-grant.js'

/** license-server 的 wrangler 配置（服务端下发策略的默认值）。 */
const WRANGLER_TOML = fileURLToPath(new URL('../../../license-server/wrangler.toml', import.meta.url))

const ACTIVATION_RS = fileURLToPath(
  new URL('../../../desktop/src-tauri/src/activation.rs', import.meta.url)
)
const INTEGRITY_RS = fileURLToPath(new URL('../../../desktop/src-tauri/src/integrity.rs', import.meta.url))

/**
 * 跨仓源：activation.rs / integrity.rs 属桌面端仓、wrangler.toml 属许可服务端仓，
 * 只在开发仓的 monorepo 里存在；公共 harness 镜像不含这些目录。缺文件时整组跳过
 * （与 bash-windows-smoke 的 winOnly 口径一致），而不是把「本仓没有」误报成漂移红。
 */
const crossRepoSourcesPresent =
  existsSync(ACTIVATION_RS) && existsSync(INTEGRITY_RS) && existsSync(WRANGLER_TOML)
const skipCrossRepo = crossRepoSourcesPresent
  ? false
  : '本仓无 desktop/src-tauri 与 license-server（跨仓源缺失）——漂移守卫在开发仓 monorepo 生效'

function readRs(path: string): string {
  return readFileSync(path, 'utf8')
}

/** 抓 `const NAME: Type = "value";` 形式的字符串常量。 */
function rsStringConst(source: string, name: string): string {
  const re = new RegExp(`const\\s+${name}\\s*:\\s*&str\\s*=\\s*"([^"]*)"`)
  const value = source.match(re)?.[1]
  assert.ok(value !== undefined, `在 Rust 源码里找不到常量 ${name}（改名了？请同步更新漂移守卫）`)
  return value
}

/** 抓 `const NAME: Type = 123;` 形式的数字常量。 */
function rsNumberConst(source: string, name: string): number {
  const re = new RegExp(`const\\s+${name}\\s*:\\s*\\w+\\s*=\\s*([0-9_]+)\\s*;`)
  const raw = source.match(re)?.[1]
  assert.ok(raw !== undefined, `在 Rust 源码里找不到常量 ${name}（改名了？请同步更新漂移守卫）`)
  return Number(raw.replace(/_/g, ''))
}

describe('授权常量漂移守卫（TS ⇄ Rust）', { skip: skipCrossRepo }, () => {
  it('Ed25519 公钥三处一致：license-keys.ts ↔ activation.rs', () => {
    const rust = rsStringConst(readRs(ACTIVATION_RS), 'PUBLIC_KEY_B64')
    assert.equal(
      rust,
      LICENSE_PUBLIC_KEY_B64,
      '公钥不一致：改私钥/公钥后必须同时更新 activation.rs 的 PUBLIC_KEY_B64 与 license-keys.ts，并重新发布客户端'
    )
    // 顺带确认格式：Ed25519 raw key = 32 字节 → base64 44 字符（含一个 =）
    assert.equal(Buffer.from(LICENSE_PUBLIC_KEY_B64, 'base64').length, 32)
  })

  it('产品标识一致：license-keys.ts ↔ activation.rs ↔ integrity.rs', () => {
    assert.equal(rsStringConst(readRs(ACTIVATION_RS), 'PRODUCT'), LICENSE_PRODUCT)
    assert.equal(rsStringConst(readRs(INTEGRITY_RS), 'EXPECTED_PRODUCT'), LICENSE_PRODUCT)
  })

  it('离线预算与时钟容差一致：pro-grant.ts ↔ activation.rs（不一致 = 付费用户被提前锁死或白送宽限）', () => {
    const rs = readRs(ACTIVATION_RS)
    assert.equal(rsNumberConst(rs, 'DEFAULT_OFFLINE_DAYS') * 86_400_000, DEFAULT_OFFLINE_MS)
    assert.equal(rsNumberConst(rs, 'CLOCK_SKEW_MS'), DEFAULT_CLOCK_SKEW_MS)
    // 兜底常量必须与「天数」自洽（防止有人只改天数忘了派生 ms 值）
    assert.equal(DEFAULT_OFFLINE_MS, DEFAULT_OFFLINE_DAYS * 86_400_000)
  })

  it('服务端默认离线预算 ↔ 客户端兜底一致：wrangler.toml ↔ pro-grant.ts', () => {
    // 两个值语义不同（一个是服务端下发默认，一个是老 token 兜底），但必须对齐：
    // 否则同一张许可证在「服务端在线」与「服务端未升级」两种状态下离线可用时长不同。
    const toml = readFileSync(WRANGLER_TOML, 'utf8')
    const m = toml.match(/^MAX_OFFLINE_DAYS\s*=\s*"([0-9]+)"/m)
    assert.ok(m, 'wrangler.toml 里找不到 MAX_OFFLINE_DAYS')
    assert.equal(Number(m[1]), DEFAULT_OFFLINE_DAYS)
  })

  it('完整性签名域前缀与深度上限一致：runtime-integrity.ts ↔ integrity.rs', () => {
    const rust = readRs(INTEGRITY_RS)
    assert.equal(rsStringConst(rust, 'INTEGRITY_SIGNING_DOMAIN'), INTEGRITY_SIGNING_DOMAIN)
    // MAX_DEPTH 在 TS 侧是私有常量，这里锁 Rust 值 + TS 行为（表驱动测试另有覆盖）。
    assert.equal(rsNumberConst(rust, 'MAX_DEPTH'), 24)
  })
})
