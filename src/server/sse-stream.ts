import type { ServerResponse } from 'node:http'
import { TIANSHU_PROTOCOL_HEADER, TIANSHU_PROTOCOL_VERSION } from './delegation-protocol.js'

export class SseStream {
  private res: ServerResponse
  private _closed = false
  private onDead?: () => void

  /**
   * @param onDead invoked ONCE when the stream dies because the peer went away
   * (a write threw). Lets the owner tear down its side (unsubscribe listeners,
   * stop keepalive timers) immediately instead of waiting for — or missing —
   * the response 'close' event. Not invoked on a local, intentional close().
   */
  constructor(res: ServerResponse, onDead?: () => void, corsOrigin?: string) {
    this.res = res
    this.onDead = onDead
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // CORS: the SSE response takes over `res` (handled:true), bypassing the
      // router's header logic in index.ts — so it must set the same
      // Access-Control-Allow-Origin the REST responses do (webview 来源反射，
      // 见 cors.ts). Without it, the Tauri webview (origin tauri://localhost,
      // cross-origin to 127.0.0.1:<port>) blocks the stream and the client
      // loops forever on "reconnecting" while plain GETs keep working.
      ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      // E4 — protocol version (SSE bypasses router header merge).
      [TIANSHU_PROTOCOL_HEADER]: String(TIANSHU_PROTOCOL_VERSION),
    })
    // Force the response headers out immediately. Without this, Node buffers the
    // 200 + headers until the first res.write() — but a freshly-caught-up idle
    // session has nothing to write (no replay events, no live events until the
    // next run). The frontend's `await fetch(...)` then blocks waiting for the
    // response head, the SSE `onOpen` never fires, streamStatus stays
    // 'connecting', and the skeleton placeholder shows until its 6s timeout.
    // flushHeaders() sends the head now so the client knows the stream is live.
    res.flushHeaders()
  }

  send(event: string, data: unknown): void {
    if (this.isClosed()) return
    // A peer that has already gone away makes `res.write` throw (EPIPE/
    // ERR_STREAM_DESTROYED). Treat that as a close rather than crashing the
    // server: a dead viewer must never take down the process.
    try {
      this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      if (this.res.destroyed || this.res.writableEnded) this.markDead()
    } catch {
      this.markDead()
    }
  }

  /** Transition to closed because the peer is gone; fire onDead exactly once. */
  private markDead(): void {
    if (this._closed) return
    this._closed = true
    const cb = this.onDead
    this.onDead = undefined
    try {
      cb?.()
    } catch {
      // owner cleanup must never crash the write path
    }
  }

  /**
   * Heartbeat as an SSE comment line (`: ...`). EventSource clients silently
   * ignore comments, but the byte keeps intermediaries (proxies, load
   * balancers) from reaping an otherwise idle connection — and surfaces a dead
   * socket so we can stop the keepalive timer.
   */
  ping(): void {
    if (this.isClosed()) return
    try {
      this.res.write(': ping\n\n')
      if (this.res.destroyed || this.res.writableEnded) this.markDead()
    } catch {
      this.markDead()
    }
  }

  /** True once the stream has been closed (locally or by a dead peer). */
  isClosed(): boolean {
    if (this.res.destroyed || this.res.writableEnded) this.markDead()
    return this._closed
  }

  onResponseClose(cleanup: () => void): void {
    this.res.on('close', () => { cleanup(); this.close() })
  }

  close(): void {
    if (this.isClosed()) return
    this._closed = true
    try {
      this.res.write('event: done\ndata: {}\n\n')
    } catch {
      // socket already gone — nothing to flush
    }
    try {
      this.res.end()
    } catch {
      // response already ended
    }
  }
}
