import { createHash, timingSafeEqual } from 'node:crypto'

export interface AuthContext {
  body?: unknown
  headers?: Record<string, string>
}

export function extractBearerToken(headers?: Record<string, string>): string | null {
  const authHeader = headers?.authorization
  // RFC 7235：认证方案名不区分大小写
  const m = authHeader?.match(/^bearer\s+(.+)$/i)
  return m?.[1] ?? null
}

export function extractRequestToken(context: AuthContext): string | null {
  return extractBearerToken(context.headers)
}

export function isAuthorizedRequest(context: AuthContext, expectedToken?: string): boolean {
  if (!expectedToken) return false
  const token = extractRequestToken(context)
  if (!token) return false
  return timingSafeEqual(hashToken(token), hashToken(expectedToken))
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}
