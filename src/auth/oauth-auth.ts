import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { AuthProvider } from './types.js'
import { generatePKCE, buildAuthorizeUrl } from './oauth.js'
import { TokenStore, type TokenData } from './token-store.js'
import { shouldRefresh } from './refresh.js'
import { rivetHome } from '../config/paths.js'

export interface OAuthConfig {
  clientId: string
  tokenEndpoint: string
  authorizeBase?: string
  redirectPort?: number
  authDir?: string
  onUserCode?: (url: string) => void
  fetch?: typeof globalThis.fetch
}

const DEFAULT_REDIRECT_PORT = 1455
const DEFAULT_AUTH_DIR = '.rivet/auth'

/** Hard timeout for token exchange/refresh network calls. Without it a hung
 *  token endpoint would stall auth (and any request that triggers a refresh)
 *  indefinitely. Override with RIVET_OAUTH_TIMEOUT (ms). */
function oauthTimeoutMs(): number {
  const v = Number.parseInt(process.env.RIVET_OAUTH_TIMEOUT ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 30_000
}

/** Cap the error-body read so a hostile/misbehaving endpoint cannot force an
 *  unbounded string into memory just to build an error message. */
async function readErrorBodyCapped(resp: Response, maxBytes = 64 * 1024): Promise<string> {
  try {
    const buf = await resp.arrayBuffer()
    const bytes = new Uint8Array(buf).subarray(0, maxBytes)
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

export class OAuthAuth implements AuthProvider {
  private store: TokenStore
  private config: Required<Pick<OAuthConfig, 'clientId' | 'tokenEndpoint'>> & OAuthConfig
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private server: ReturnType<typeof createServer> | null = null

  constructor(config: OAuthConfig, authDir?: string) {
    this.config = {
      ...config,
      redirectPort: config.redirectPort ?? DEFAULT_REDIRECT_PORT,
      authDir: config.authDir ?? DEFAULT_AUTH_DIR,
      authorizeBase: config.authorizeBase ?? 'https://auth.openai.com/oauth/authorize',
    }
    this.store = new TokenStore(
      // Fallback lands in the platform data root (%LOCALAPPDATA%\.rivet\auth on
      // Windows, ~/.rivet/auth elsewhere). The old process.env.HOME default was
      // unset on native Windows, so login state was silently lost between runs.
      authDir ?? config.authDir ?? join(rivetHome(), 'auth'),
      'codex',
    )
  }

  isAuthenticated(): boolean {
    const token = this.store.load()
    return token !== null && token.expiresAt > Date.now()
  }

  async getHeaders(): Promise<Record<string, string>> {
    let token = this.store.load()
    if (!token) {
      throw new Error(
        'Not authenticated — no stored OAuth token. ' +
        'Run authenticate() first, or if using an API key set "auth": null in the provider config.'
      )
    }

    if (shouldRefresh(token)) {
      token = await this.refreshOnce(token)
    }

    return { 'Authorization': `Bearer ${token.accessToken}` }
  }

  async authenticate(): Promise<void> {
    const pkce = await generatePKCE()
    const state = randomBytes(16).toString('hex')
    const port: number = this.config.redirectPort ?? DEFAULT_REDIRECT_PORT
    const redirectUri = `http://localhost:${port}/auth/callback`

    const authUrl = buildAuthorizeUrl({
      clientId: this.config.clientId,
      codeChallenge: pkce.challenge,
      redirectUri,
      state,
      authorizeBase: this.config.authorizeBase,
    })

    const code = await this.startCallbackServer(port, state, authUrl)
    const tokens = await this.exchangeCode(code, pkce.verifier, redirectUri)
    this.store.save(tokens)
    this.startAutoRefresh()
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  private startCallbackServer(port: number, expectedState: string, authUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false

      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        server.close()
        reject(new Error('OAuth callback timed out after 5 minutes'))
      }, 5 * 60_000)

      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', `http://localhost:${port}`)

        if (url.pathname !== '/auth/callback') {
          res.writeHead(404)
          res.end('Not found')
          return
        }

        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')

        if (returnedState !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<h1>State mismatch — possible CSRF</h1>')
          server.close()
          clearTimeout(timeout)
          settled = true
          reject(new Error('OAuth state mismatch'))
          return
        }

        if (!code) {
          const error = url.searchParams.get('error') ?? 'unknown'
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(`<h1>Authorization failed: ${error}</h1>`)
          server.close()
          clearTimeout(timeout)
          settled = true
          reject(new Error(`OAuth error: ${error}`))
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<h1>Authentication successful — you can close this tab</h1>')
        server.close()
        clearTimeout(timeout)
        settled = true
        resolve(code)
      })

      this.server = server

      // 绑回环：回调监听只需本机浏览器可达。全接口绑定会把 loopback code
      // 交换面暴露给 LAN（state+PKCE 已兜底，此处收紧暴露面）。
      server.listen(port, '127.0.0.1', () => {
        if (this.config.onUserCode) {
          this.config.onUserCode(authUrl)
        } else {
          // Default: print to stderr (non-interactive fallback)
          process.stderr.write(`Open this URL to authenticate:\n${authUrl}\n`)
        }
      })

      server.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(err)
      })
    })
  }

  private async exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<TokenData> {
    const fetchFn = this.config.fetch ?? globalThis.fetch
    const resp = await fetchFn(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }).toString(),
      signal: AbortSignal.timeout(oauthTimeoutMs()),
    })

    if (!resp.ok) {
      const body = await readErrorBodyCapped(resp)
      throw new Error(`Token exchange failed (${resp.status}): ${body}`)
    }

    const data = await resp.json() as Record<string, unknown>
    if (typeof data.error === 'string') {
      throw new Error(`Token exchange error: ${data.error}`)
    }
    // 200 但缺 access_token（代理改写 body/网关错误页）：裸 as 会把 undefined
    // 落盘成加密凭据，此后 isAuthenticated()=true 而 Bearer undefined 吃 401
    // 循环——错误指向完全相反。refreshToken 同款守卫见下。
    if (typeof data.access_token !== 'string' || !data.access_token) {
      throw new Error('Token exchange succeeded (200) but the response has no access_token — refusing to store an undefined credential. Check for a proxy/gateway rewriting the token endpoint response.')
    }

    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
      expiresAt: Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
    }
  }

  /** 在飞刷新的去重句柄（见 refreshOnce）。 */
  private refreshInFlight: Promise<TokenData> | null = null

  /**
   * single-flight 刷新：过期瞬间的并发调用共享同一次网络刷新。不去重时，
   * 并发请求各自打一次 token endpoint（浪费配额），且服务端轮换一次性
   * refresh_token 时交错的 store.save 会互相覆盖——旧 refresh_token 盖掉
   * 新的，下一次刷新直接登出。
   */
  private refreshOnce(token: TokenData): Promise<TokenData> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refreshToken(token)
        .finally(() => { this.refreshInFlight = null })
    }
    return this.refreshInFlight
  }

  private async refreshToken(token: TokenData): Promise<TokenData> {
    if (!token.refreshToken) {
      throw new Error(
        'No refresh token — the stored OAuth token is incomplete or stale. ' +
        'Delete the token file and re-authenticate, or if using an API key set "auth": null in the provider config.'
      )
    }

    const fetchFn = this.config.fetch ?? globalThis.fetch
    const resp = await fetchFn(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        refresh_token: token.refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(oauthTimeoutMs()),
    })

    if (!resp.ok) {
      throw new Error(`Token refresh failed (${resp.status})`)
    }

    const data = await resp.json() as Record<string, unknown>
    if (typeof data.error === 'string') {
      throw new Error(`Token refresh error: ${data.error}`)
    }
    // 同 exchangeCode：200 缺 access_token 时拒绝落盘 undefined（Bearer
    // undefined 的 401 循环比显式报错难排查得多）。
    if (typeof data.access_token !== 'string' || !data.access_token) {
      throw new Error('Token refresh succeeded (200) but the response has no access_token — keeping the previous token. Check for a proxy/gateway rewriting the token endpoint response.')
    }

    const refreshed: TokenData = {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : token.refreshToken,
      expiresAt: Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
    }

    this.store.save(refreshed)
    return refreshed
  }

  private startAutoRefresh(): void {
    // Check every 5 minutes if token needs refresh
    this.refreshTimer = setInterval(async () => {
      const token = this.store.load()
      if (token && shouldRefresh(token)) {
        try {
          await this.refreshOnce(token)
        } catch {
          // Refresh failed — token will expire, user needs to re-auth
        }
      }
    }, 5 * 60_000)

    // Don't keep process alive just for the refresh timer
    if (this.refreshTimer.unref) this.refreshTimer.unref()
  }
}
