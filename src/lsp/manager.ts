import type { ChildProcess } from 'node:child_process'
import { isAbsolute, resolve as resolvePath, relative as relativePath } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRpcClient, DEFAULT_LSP_REQUEST_TIMEOUT_MS, type RpcClient, type RpcClientOptions } from './rpc.js'
interface Location {
  uri: string
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
}

interface ServerCapabilities {
  definitionProvider?: boolean
  referencesProvider?: boolean
  /** LSP 3.17+: server supports textDocument/diagnostic pull model. */
  diagnosticProvider?: unknown
}

/** Simplified LSP Diagnostic for file-level error reporting. */
export interface LspDiagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  severity: 1 | 2 | 3 | 4  // Error / Warning / Info / Hint
  message: string
  source?: string
}

export interface LspManager {
  initialize(): Promise<void>
  isReady(): boolean
  supportsDefinition(): boolean
  supportsReferences(): boolean
  gotoDefinition(filePath: string, line: number, character: number): Promise<Location[]>
  findReferences(filePath: string, line: number, character: number): Promise<Location[]>
  /** Notify the LSP server that a file was modified on disk (e.g. by edit_file/write_file).
   *  Ensures the LSP's internal state stays in sync for subsequent goto-def / find-refs queries. */
  changeFile(filePath: string): void
  /** T4: file-level diagnostics. Uses pull model (textDocument/diagnostic) if
   *  supported, otherwise falls back to cached publishDiagnostics.
   *  Timeout ~2s; returns empty array on timeout or server unavailability. */
  getFileDiagnostics(filePath: string, timeoutMs?: number): Promise<LspDiagnostic[]>
  dispose(): void
}

type SpawnFn = () => ChildProcess

/** Absolute filesystem path for a possibly-relative file, rooted at cwd.
 *  Cross-platform: handles Windows drive-letter absolute paths correctly. */
function absFromCwd(filePath: string, cwd: string): string {
  return isAbsolute(filePath) ? filePath : resolvePath(cwd, filePath)
}

/** Build an LSP file:// URI for a path. Uses pathToFileURL so Windows yields the
 *  required `file:///C:/...` form (not the invalid `file://C:\...`). */
function fileToUri(filePath: string, cwd: string): string {
  return pathToFileURL(absFromCwd(filePath, cwd)).href
}

/** Convert an LSP file:// URI back to a cwd-relative, forward-slash path. */
function uriToRelPath(uri: string, cwd: string): string {
  let abs: string
  try {
    abs = fileURLToPath(uri)
  } catch {
    abs = uri.replace(/^file:\/\/\/?/, '')
  }
  const rel = relativePath(cwd, abs)
  const out = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs
  return out.split('\\').join('/')
}

function languageId(filePath: string): string {
  if (filePath.endsWith('.tsx')) return 'typescriptreact'
  if (filePath.endsWith('.ts')) return 'typescript'
  if (filePath.endsWith('.jsx')) return 'javascriptreact'
  return 'javascript'
}

export function createLspManager(
  spawnFn: SpawnFn,
  cwd: string,
  rpcOptions: RpcClientOptions = {},
): LspManager {
  let rpc: RpcClient | null = null
  let proc: ChildProcess | null = null
  let capabilities: ServerCapabilities | null = null
  let ready = false
  const openedDocs = new Set<string>()
  /** T4: diagnostic cache keyed by URI, populated from publishDiagnostics notifications. */
  const diagnosticCache = new Map<string, LspDiagnostic[]>()

  /**
   * Ensure the document is opened in the LSP server.
   * Uses a dummy text because TypeScript language server reads from disk
   * and does not rely on the text content from didOpen.
   * Caches opened URIs — only sends didOpen + waits on first access.
   */
  async function ensureDocument(filePath: string): Promise<void> {
    if (!rpc) return
    const absPath = absFromCwd(filePath, cwd)
    const uri = fileToUri(filePath, cwd)
    if (openedDocs.has(uri)) return
    openedDocs.add(uri)
    try {
      rpc.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: languageId(filePath),
          version: 1,
          text: '',
        },
      })
      // Allow server to process the notification
      await new Promise(r => setTimeout(r, 100))
    } catch {
      // Best-effort document registration
    }
  }

  return {
    async initialize() {
      // 全新服务器进程对历史一无所知：崩溃后重新 initialize 必须清掉
      // openedDocs/diagnosticCache，否则 openedDocs 短路 didOpen——新服务器
      // 永远收不到那些文档的打开通知，诊断与定义静默失真。
      openedDocs.clear()
      diagnosticCache.clear()
      try {
        proc = spawnFn()

        // stdin is writable (we send requests), stdout is readable (we receive responses).
        // A failed spawn (ENOENT on desktop's minimal PATH) yields null pipes;
        // throw immediately instead of letting the RPC request hang forever.
        const stdin = proc.stdin
        const stdout = proc.stdout
        if (!stdin || !stdout) {
          throw new Error('LSP server spawn failed: no stdio pipes (check PATH / npx)')
        }

        // Handle stderr — TypeScript language server logs diagnostics here
        if (proc.stderr) {
          proc.stderr.on('data', () => {
            // Silently consume — LSP servers may log diagnostics to stderr
          })
        }

        // 2026-09-08 wedge fix: process death must reject every in-flight
        // RPC request. Merely flipping ready=false left callers (and the
        // tool pipeline awaiting ensure()) waiting on promises that never settle.
        proc.on('error', (err) => {
          ready = false
          rpc?.abortAllPending(err instanceof Error ? err : new Error(String(err)))
        })
        proc.on('exit', (code, signal) => {
          ready = false
          rpc?.abortAllPending(new Error(`LSP server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`))
        })

        rpc = createRpcClient(stdout, stdin, {
          requestTimeoutMs: rpcOptions.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS,
        })

        const initResult = await rpc.request('initialize', {
          processId: process.pid,
          rootUri: pathToFileURL(cwd).href,
          capabilities: {
            textDocument: {
              definition: { linkSupport: false },
              references: {},
            },
          },
        }) as { capabilities: ServerCapabilities }

        capabilities = initResult.capabilities
        rpc.notify('initialized', {})

        // T4: listen for publishDiagnostics to populate the cache
        rpc.onNotification('textDocument/publishDiagnostics', (rawParams: Record<string, unknown>) => {
          const params = rawParams as { uri: string; diagnostics: LspDiagnostic[] }
          if (params?.uri) {
            diagnosticCache.set(params.uri, params.diagnostics ?? [])
          }
        })

        // Wait for server to fully settle after initialization
        await new Promise(r => setTimeout(r, 200))
        ready = true
      } catch {
        ready = false
        try { rpc?.dispose() } catch { /* ignore */ }
        rpc = null
        try { proc?.kill() } catch { /* ignore */ }
        proc = null
      }
    },

    isReady() {
      return ready
    },

    supportsDefinition() {
      return capabilities?.definitionProvider === true
    },

    supportsReferences() {
      return capabilities?.referencesProvider === true
    },

    async gotoDefinition(filePath, line, character) {
      if (!rpc || !ready) return []
      try {
        await ensureDocument(filePath)
        const result = await rpc.request('textDocument/definition', {
          textDocument: { uri: fileToUri(filePath, cwd) },
          position: { line: line - 1, character }, // LSP uses 0-based lines
        })

        if (!result) return []

        const locations = (Array.isArray(result) ? result : [result]) as Location[]
        return locations.map(loc => ({
          ...loc,
          uri: uriToRelPath(loc.uri, cwd),
        }))
      } catch {
        return []
      }
    },

    async findReferences(filePath, line, character) {
      if (!rpc || !ready) return []
      try {
        await ensureDocument(filePath)
        const result = await rpc.request('textDocument/references', {
          textDocument: { uri: fileToUri(filePath, cwd) },
          position: { line: line - 1, character },
          context: { includeDeclaration: false },
        })

        if (!result) return []

        const locations = (Array.isArray(result) ? result : []) as Location[]
        return locations.map(loc => ({
          ...loc,
          uri: uriToRelPath(loc.uri, cwd),
        }))
      } catch {
        return []
      }
    },

    changeFile(filePath) {
      if (!rpc || !ready) return
      const uri = fileToUri(filePath, cwd)
      if (!openedDocs.has(uri)) return // never opened, server has no cached state
      try {
        rpc.notify('textDocument/didChange', {
          textDocument: { uri, version: Date.now() },
          contentChanges: [{ text: '' }],
        })
      } catch {
        // Best-effort: if the notification fails, next LSP query re-reads from disk anyway
      }
    },

    async getFileDiagnostics(filePath, timeoutMs = 2000) {
      if (!rpc || !ready) return []
      const absPath = absFromCwd(filePath, cwd)
      const uri = fileToUri(filePath, cwd)

      try {
        // Prefer pull model (LSP 3.17+ textDocument/diagnostic)
        if (capabilities?.diagnosticProvider) {
          // Pass the timeout into the RPC layer so a hung server also clears
          // its pending entry — Promise.race alone kept the request alive.
          const result = await rpc
            .request('textDocument/diagnostic', { textDocument: { uri } }, timeoutMs)
            .catch(() => null) as { items?: LspDiagnostic[] } | null
          if (result?.items) return result.items
        }

        // Fallback: trigger a didChange with real file content to refresh publishDiagnostics
        await ensureDocument(filePath)
        // Read actual file content — empty text would tell tsserver the file is empty (false green)
        let fileText = ''
        try {
          const { readFileSync } = await import('node:fs')
          fileText = readFileSync(absPath, 'utf-8')
        } catch {
          // File may not exist on disk — use empty text as last resort
        }
        // Clear stale cache BEFORE notify — avoid racing server publishDiagnostics
        diagnosticCache.delete(uri)
        rpc.notify('textDocument/didChange', {
          textDocument: { uri, version: Date.now() },
          contentChanges: [{ text: fileText }],
        })
        // Wait for publishDiagnostics to arrive (server pushes asynchronously)
        await new Promise<void>((resolve) => {
          const start = Date.now()
          const check = () => {
            if (diagnosticCache.has(uri) || Date.now() - start > timeoutMs) {
              resolve()
            } else {
              setTimeout(check, 50)
            }
          }
          check()
        })
        return diagnosticCache.get(uri) ?? []
      } catch {
        return []
      }
    },

    dispose() {
      ready = false
      try { rpc?.dispose() } catch { /* ignore */ }
      try { proc?.kill() } catch { /* ignore */ }
      proc = null
      rpc = null
    },
  }
}
