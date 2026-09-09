import { type Readable, type Writable } from 'node:stream'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

export interface RpcClient {
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  notify(method: string, params?: Record<string, unknown>): void
  onNotification(method: string, handler: (params: Record<string, unknown>) => void): void
  /** Reject every in-flight request. Used on process exit/error so no caller waits forever. */
  abortAllPending(error: Error): void
  dispose(): void
}

export interface RpcClientOptions {
  /** Default per-request timeout. Requests are never allowed to pend forever. */
  requestTimeoutMs?: number
}

export const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 45_000

export function encodeMessage(msg: JsonRpcMessage): string {
  const body = JSON.stringify(msg)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

const CRLFCRLF = Buffer.from('\r\n\r\n')

export function decodeMessages(input: string | Buffer): { messages: JsonRpcMessage[]; rest: string } {
  const messages: JsonRpcMessage[] = []
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')
  let offset = 0

  while (true) {
    const headerEnd = buf.indexOf(CRLFCRLF, offset)
    if (headerEnd === -1) break

    const header = buf.subarray(offset, headerEnd).toString('utf8')
    const lengthMatch = /^Content-Length: (\d+)/m.exec(header)
    if (!lengthMatch) {
      offset = headerEnd + 4
      continue
    }

    const contentLength = parseInt(lengthMatch[1]!, 10)
    const bodyStart = headerEnd + 4
    if (buf.length - bodyStart < contentLength) break

    const body = buf.subarray(bodyStart, bodyStart + contentLength).toString('utf8')
    try {
      messages.push(JSON.parse(body) as JsonRpcMessage)
    } catch {
      // Skip malformed message
    }
    offset = bodyStart + contentLength
  }

  const rest = buf.subarray(offset).toString('utf8')
  return { messages, rest }
}

export function createRpcClient(
  readable: Readable,
  writable: Writable,
  options: RpcClientOptions = {},
): RpcClient {
  const defaultTimeoutMs = options.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS
  let nextId = 1
  type Pending = {
    resolve(v: unknown): void
    reject(e: Error): void
    timer: ReturnType<typeof setTimeout> | null
  }
  const pending = new Map<number, Pending>()
  const notificationHandlers = new Map<string, Array<(params: Record<string, unknown>) => void>>()
  let buffer = Buffer.alloc(0)

  const settle = (id: number, fn: (p: Pending) => void): void => {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (p.timer !== null) clearTimeout(p.timer)
    fn(p)
  }

  const abortAllPending = (error: Error): void => {
    const all = [...pending.values()]
    pending.clear()
    for (const p of all) {
      if (p.timer !== null) clearTimeout(p.timer)
      p.reject(error)
    }
  }

  readable.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    const { messages, rest } = decodeMessages(buffer)
    buffer = Buffer.from(rest, 'utf8')

    for (const msg of messages) {
      if ('id' in msg && 'result' in msg && !('method' in msg)) {
        settle(msg.id, p => p.resolve(msg.result))
      } else if ('id' in msg && 'error' in msg && !('method' in msg)) {
        settle(msg.id, p => p.reject(new Error(msg.error!.message)))
      } else if ('method' in msg && !('id' in msg)) {
        const handlers = notificationHandlers.get(msg.method)
        if (handlers) {
          for (const h of handlers) h((msg as JsonRpcNotification).params ?? {})
        }
      }
    }
  })

  // Transport death must never leave callers waiting: stdin/stdout close (or
  // error) is the RPC-level equivalent of the process exit handled by the
  // LSP manager, and covers cases where the manager missed the proc event.
  const transportDead = (label: string, err?: Error): void => {
    const detail = err ? `: ${err.message}` : ''
    abortAllPending(new Error(`LSP transport ${label}${detail}`))
  }
  readable.on('error', (err: Error) => transportDead('read error', err))
  writable.on('error', (err: Error) => transportDead('write error', err))
  readable.on('close', () => transportDead('closed'))
  writable.on('close', () => transportDead('closed'))

  return {
    request(method, params, timeoutMs = defaultTimeoutMs) {
      const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : defaultTimeoutMs
      return new Promise((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            reject(new Error(`LSP request ${method} timed out after ${effectiveTimeout / 1000}s`))
          }
        }, effectiveTimeout)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
        try {
          writable.write(encodeMessage(msg))
        } catch (err) {
          settle(id, p => p.reject(err instanceof Error ? err : new Error(String(err))))
        }
      })
    },
    notify(method, params) {
      const msg: JsonRpcNotification = {
        jsonrpc: '2.0' as const,
        method,
        params,
      }
      writable.write(encodeMessage(msg))
    },
    onNotification(method, handler) {
      const existing = notificationHandlers.get(method)
      if (existing) {
        existing.push(handler)
      } else {
        notificationHandlers.set(method, [handler])
      }
    },
    abortAllPending,
    dispose() {
      abortAllPending(new Error('LSP RPC client disposed'))
      notificationHandlers.clear()
      readable.removeAllListeners('data')
      readable.removeAllListeners('error')
      readable.removeAllListeners('close')
      writable.removeAllListeners('error')
      writable.removeAllListeners('close')
    },
  }
}
