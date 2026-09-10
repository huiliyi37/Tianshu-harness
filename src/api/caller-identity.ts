/**
 * 出站身份头 —— 所有直发上游的路径共用这一处实现。
 *
 * 背景（实测，2026-09）：OpenCode Go 强制 `x-opencode-session`，缺头直接
 * 400 MissingSessionID；文档同时要求 UA 表明客户端自身身份、不得用 SDK/HTTP
 * 库名。provider client（openai-client / anthropic-client）经 factory 注入这些
 * 头，但**绕过 client 的裸 fetch 会漏**——连接探测与欢迎语生成就是这种路径，
 * 症状是「模型列表/测试都能过，一发消息就报错」。
 *
 * 因此身份头的构造收口到这里：任何直发上游的请求都调它，别再各写一份。
 */
import { randomUUID } from 'node:crypto'
import { resolveProviderWire, type ProviderWireConfig } from './provider-catalog.js'

/**
 * 进程级稳定兜底会话 ID：调用方确实没有会话上下文时用它。
 * 不选每请求随机——上游拿这个值做路由/缓存亲和，随机值等于每次都是新对话；
 * 而完全不发头会被 400。两害相权取稳定常量。
 * 有真实会话 ID 的路径（主会话 / worker 会话）必须显式传入，不要依赖它。
 */
export const PROCESS_SESSION_ID = `tianshu-${randomUUID()}`

/**
 * 身份头：UA（wire 声明时）+ 会话头（wire 声明了 header 名时）。
 * 未声明会话头的普通 provider 保持原行为——带 sessionId 才发默认头名。
 */
export function callerIdentityHeaders(
  wire: ProviderWireConfig | undefined,
  sessionId?: string,
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (wire?.userAgent) headers['User-Agent'] = wire.userAgent
  if (wire?.sessionHeader) {
    headers[wire.sessionHeader] = sessionId ?? PROCESS_SESSION_ID
  } else if (sessionId) {
    headers['X-Request-Session'] = sessionId
  }
  return headers
}

/** 便捷形态：按 provider name + baseUrl 解析 wire 后取身份头（host 规则只需 baseUrl）。 */
export function providerIdentityHeaders(
  providerName: string | undefined,
  baseUrl: string | undefined,
  sessionId?: string,
): Record<string, string> {
  return callerIdentityHeaders(resolveProviderWire(providerName ?? '', baseUrl), sessionId)
}
