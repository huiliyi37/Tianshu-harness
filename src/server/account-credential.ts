/**
 * 账户类查询（余额 / 平台摘要 / 成本）的凭据解析——多 key 池感知（issue #392）。
 *
 * 旧行为：`GET /config/balance` 等三条路由只读默认 provider 的顶层 apiKey/apiKeyEnv。
 * A′ 迁移后的多 key provider 顶层槽位全空（凭据在 keys[].keyRef → secrets.json），
 * 余额查询恒 null；未迁移形态下又永远只查同一个账户——第二个 key 的余额无从得知。
 *
 * 解析规则：
 * - 显式 keyId → 该 key 的三槽（keyRef/apiKey/apiKeyEnv，经 tryResolveCredentialKey，
 *   与请求端同链，含 `<PROVIDER>_API_KEY` 环境回退）；找不到 → 400（fail-closed，
 *   不悄悄回落到别的 key——查错账户比报错更糟）。'default' 是合法池 id（存量
 *   迁移的首个 key）；仅当 provider 无池时它指顶层三槽（对齐 pro
 *   provider-usage 服务的无池 keyId 约定）。
 * - 省略 keyId → 顶层三槽优先（未迁移形态的历史行为）；顶层落空且 keys 池非空
 *   （A′ 迁移形态）→ 回退 defaultKeyOf(provider)——多 key 用户至少能查到主 key。
 * - provider 省略 → 默认 provider；显式给的 provider 不存在 → 400。
 */
import type { Config, ProviderConfig } from '../config/schema.js'
import { defaultKeyOf, DEFAULT_KEY_ID } from '../config/provider-keys.js'
import { tryResolveCredentialKey } from '../api/factory.js'

export interface AccountCredential {
  /** undefined 仅出现在「隐式默认 provider 不存在」——路由据此返回 null 数据。 */
  provider?: ProviderConfig
  apiKey?: string
  /** 实际命中的 keyId（显式传入或池回退命中）；顶层槽形态为 undefined。 */
  keyId?: string
  /** 命中 key 的展示名（池成员才有）——路由回显给客户端确认账户身份。 */
  label?: string
}

export function resolveAccountCredential(
  cfg: Config,
  providerName?: string,
  keyId?: string,
): AccountCredential | { error: string } {
  const name = providerName ?? cfg.provider.default
  const provider = cfg.provider.providers[name]
  if (!provider) {
    // 隐式默认缺失维持旧行为的「空数据」；显式指定不存在是调用方错误。
    return providerName === undefined ? {} : { error: `provider "${name}" not found` }
  }
  const resolve = (slots: { keyRef?: string; apiKey?: string; apiKeyEnv?: string }) =>
    tryResolveCredentialKey({ name, ...slots })
  if (keyId !== undefined) {
    // 池非空时按 id 查找——'default' 也是合法池 id（存量迁移的首个 key 就叫
    // 'default'，见 provider-keys.ts DEFAULT_KEY_ID）。池为空时 'default' 指顶层
    // 三槽（对齐 pro provider-usage 服务对无池 provider 的 keyId 约定）。
    if (provider.keys?.length) {
      const key = provider.keys.find(k => k.id === keyId)
      if (!key) return { error: `key "${keyId}" not found on provider "${name}"` }
      return { provider, apiKey: resolve(key), keyId, ...(key.label ? { label: key.label } : {}) }
    }
    return keyId === DEFAULT_KEY_ID
      ? { provider, apiKey: resolve(provider) }
      : { error: `provider "${name}" has no key pool (keyId "${keyId}")` }
  }
  // A′ 迁移形态（keys 池非空且顶层槽位未显式配置）：回退 defaultKeyOf(provider)
  // 必须先于顶层空槽的 `<NAME>_API_KEY` 环境回退，避免宿主环境遗留的未关联 key 劫持用户显式配置的池主 key。
  if (provider.keys?.length && !provider.keyRef && !provider.apiKey && !provider.apiKeyEnv) {
    const fallback = defaultKeyOf(provider)
    if (fallback) return { provider, apiKey: resolve(fallback), keyId: fallback.id, ...(fallback.label ? { label: fallback.label } : {}) }
  }
  const topLevel = resolve(provider)
  if (topLevel) return { provider, apiKey: topLevel }
  const fallback = defaultKeyOf(provider)
  if (fallback) return { provider, apiKey: resolve(fallback), keyId: fallback.id, ...(fallback.label ? { label: fallback.label } : {}) }
  return { provider }
}
