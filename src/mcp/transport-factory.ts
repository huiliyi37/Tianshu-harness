/**
 * MCP Transport Factory
 *
 * Single entry-point for creating MCP transports, abstracting over stdio and
 * remote (Streamable HTTP / SSE) so the manager doesn't branch on URL vs command.
 *
 * Dynamic headers/env callbacks are injection points for OAuth (Wave 2) —
 * `getHeaders()` is called right before connect for URL transports,
 * `getEnv()` for stdio transports.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServerConfig } from './config.js'
import { resolveNpmCliCommand } from '../platform/resolve-node-cli.js'
import { buildStdioChildEnv, type McpNetworkConfig } from './stdio-env.js'

const DEFAULT_MCP_TIMEOUT_MS = 60_000

export type McpTransportType = 'stdio' | 'streamableHttp' | 'sse-legacy'

export interface TransportFactoryOptions {
  /** Called before connect for URL transports — returns headers to merge with config.headers. */
  getHeaders?: () => Promise<Record<string, string>>
  /** Called before spawning for stdio transports — returns env to merge with config.env. */
  getEnv?: () => Promise<Record<string, string>>
  /** Connect timeout (ms). Defaults to 60s when unset. */
  timeoutMs?: number
  /** App-level network proxy (settings `network.proxy`/`network.noProxy`) —
   *  injected into the stdio child env so npx/server downloads can use the
   *  same proxy as the rest of the app. Explicit per-server env always wins. */
  network?: McpNetworkConfig
}

export interface TransportResult {
  client: Client
  transport: { close(): Promise<void>; pid?: number | null; onclose?: () => void }
  transportType: McpTransportType
  /** stdio stderr tail for error attribution (undefined for URL transports). */
  stderrTail?: () => string
  /** Hook for reconnect: re-fetch dynamic headers/env before next connect attempt. */
  refreshAuth?: () => Promise<void>
}

const STDERR_TAIL_MAX = 4_096

function trimStderrTail(chunks: string[]): string {
  let text = chunks.join('').replace(/\s+$/u, '')
  if (text.length > STDERR_TAIL_MAX) text = text.slice(-STDERR_TAIL_MAX)
  return text
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Create an MCP transport for the given server config.
 *
 * - `cfg.command` → stdio transport (StdioClientTransport)
 * - `cfg.url` → remote transport: StreamableHTTPClientTransport preferred;
 *   SSE only when `cfg.transportHint === 'sse'` is explicitly set (automatic
 *   fallback is unreliable — StreamableHTTP and SSE are different protocols
 *   and a 400/405 on the endpoint is not a reliable transport-mismatch signal).
 */

/** Resolve transport type from config without creating a transport.
 *  Exported for testing; production code uses createTransport(). */
export function resolveTransportType(cfg: McpServerConfig): McpTransportType {
  if (cfg.command) return 'stdio'
  if (cfg.transportHint === 'sse') return 'sse-legacy'
  return 'streamableHttp'
}

export async function createTransport(
  cfg: McpServerConfig,
  opts: TransportFactoryOptions = {},
): Promise<TransportResult> {
  const client = new Client(
    { name: 'rivet', version: '0.1.0' },
    { capabilities: {} },
  )

  if (cfg.command) {
    return createStdioTransport(client, cfg, opts)
  } else if (cfg.url) {
    return createRemoteTransport(client, cfg, opts)
  }

  throw new Error('MCP server config must have either "command" (stdio) or "url" (remote)')
}

async function createStdioTransport(
  client: Client,
  cfg: McpServerConfig,
  opts: TransportFactoryOptions,
): Promise<TransportResult> {
  // MCP SDK hardcodes shell:false — rewrite bare npx/npm to node+cli.js so
  // Windows GUI / bundled-node launches don't ENOENT on npx.cmd.
  const resolved = resolveNpmCliCommand(cfg.command!, cfg.args ?? [])
  const bare = cfg.command!.replace(/\\/g, '/').split('/').pop()?.replace(/\.(cmd|bat|exe)$/i, '').toLowerCase()
  const fellBackToBareNpx = (bare === 'npx' || bare === 'npm')
    && resolved.command === cfg.command!

  // Merge static env + dynamic OAuth env, then layer app proxy + node-dir PATH
  // injection. Priority handled inside buildStdioChildEnv: static > dynamic > network.
  const staticEnv = cfg.env as Record<string, string> | undefined
  const dynamicEnv = opts.getEnv ? await opts.getEnv() : {}

  const env = buildStdioChildEnv(staticEnv, dynamicEnv, opts.network, { getDefaultEnvironment })

  const transport = new StdioClientTransport({
    command: resolved.command,
    args: resolved.args,
    env,
    cwd: cfg.cwd,
    stderr: 'pipe',
  })

  // Attach stderr listeners BEFORE connect so early bootstrap errors are kept.
  const stderrChunks: string[] = []
  const stderrStream = transport.stderr as { on?(event: string, cb: (chunk: Buffer | string) => void): void } | null
  if (stderrStream && typeof stderrStream.on === 'function') {
    stderrStream.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      stderrChunks.push(text)
      while (stderrChunks.join('').length > STDERR_TAIL_MAX) stderrChunks.shift()
    })
  }

  try {
    await withTimeout(client.connect(transport), `MCP connect stdio`, opts.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS)
  } catch (err) {
    // Connect failed after transport was constructed — close it to avoid leaking
    // the child process / file descriptors (especially on Windows).
    try { await transport.close() } catch { /* already gone */ }
    if (fellBackToBareNpx) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `${msg} — npx/npm-cli.js was not found next to this Node binary `
        + `(${process.execPath}); packaged builds need fetch-node-runtime to bundle npm`,
      )
    }
    throw err
  }

  return {
    client,
    transport,
    transportType: 'stdio',
    stderrTail: () => trimStderrTail(stderrChunks),
    refreshAuth: opts.getEnv ? async () => {
      // stdio OAuth refresh requires restarting the child process with new env.
      // The caller (manager reconnect) handles the close + re-create cycle.
    } : undefined,
  }
}

async function createRemoteTransport(
  client: Client,
  cfg: McpServerConfig,
  opts: TransportFactoryOptions,
): Promise<TransportResult> {
  const url = new URL(cfg.url!)

  // Merge static + dynamic headers
  const staticHeaders = (cfg.headers ?? {}) as Record<string, string>
  const dynamicHeaders = opts.getHeaders ? await opts.getHeaders() : {}
  const headers = { ...staticHeaders, ...dynamicHeaders }

  // Explicit transport hint: 'sse' forces legacy SSE; otherwise Streamable HTTP.
  const useSse = cfg.transportHint === 'sse'

  if (useSse) {
    const { SSEClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/sse.js'
    ) as typeof import('@modelcontextprotocol/sdk/client/sse.js')
    const transport = new SSEClientTransport(url, {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    })
    try {
      await withTimeout(client.connect(transport), `MCP connect sse-legacy`, opts.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS)
    } catch (err) {
      try { await transport.close() } catch { /* already gone */ }
      throw err
    }
    return {
      client,
      transport,
      transportType: 'sse-legacy',
      refreshAuth: opts.getHeaders ? async () => {
        // SSE transport: auth refresh handled by reconnect cycle
      } : undefined,
    }
  }

  // Default: Streamable HTTP
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  ) as typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
  })
  try {
    await withTimeout(client.connect(transport), `MCP connect streamableHttp`, opts.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS)
  } catch (err) {
    try { await transport.close() } catch { /* already gone */ }
    throw err
  }
  return {
    client,
    transport,
    transportType: 'streamableHttp',
    refreshAuth: opts.getHeaders ? async () => {
      // Streamable HTTP: next connect will call getHeaders() again
    } : undefined,
  }
}
