/**
 * GatewayConnection — pure protocol-layer WebSocket lifecycle.
 *
 * Owns: WebSocket connection, heartbeat, reconnect, IDENTIFY/RESUME, event
 * dispatch.
 *
 * Does NOT own: token caching (delegated via callbacks), session persistence
 * (delegated via callbacks), business policies, message queueing.
 *
 * All state injected through the constructor — no module-level globals.
 */

import WebSocket from "ws";
import type { GatewayAccount, InteractionEvent, Logger, WSPayload } from "../types.js";
import { decodeGatewayMessageData } from "./codec.js";
import { FULL_INTENTS, GatewayOp, RATE_LIMIT_DELAY } from "./constants.js";
import { dispatchEvent, type InboundMessage } from "./event-dispatcher.js";
import { ReconnectState } from "./reconnect.js";

/** Persisted session info for RESUME after reconnection. */
export interface PersistedSession {
  sessionId: string;
  lastSeq: number | null;
}

/** Hooks for session persistence (optional). */
export interface SessionPersistencePort {
  load: () => PersistedSession | null;
  save: (session: PersistedSession) => void;
  clear: () => void;
}

export interface GatewayConnectionOptions {
  account: GatewayAccount;
  abortSignal: AbortSignal;
  log?: Logger;

  /** User-Agent header sent on the WebSocket upgrade request. */
  userAgent?: string | (() => string);

  /** Resolve a fresh access_token for IDENTIFY / RESUME. */
  getAccessToken: () => Promise<string>;
  /** Force-clear any cached token (called when 4004 invalid token). */
  clearTokenCache?: () => void;
  /** Request the WebSocket gateway URL from the QQ Open Platform. */
  getGatewayUrl: (accessToken: string) => Promise<string>;

  /** Optional: persist session id + last seq across process restarts. */
  session?: SessionPersistencePort;

  /** Custom intent mask. Defaults to FULL_INTENTS. */
  intents?: number;

  // ---- Event handlers ----
  onReady?: (data: unknown) => void;
  onResumed?: (data: unknown) => void;
  onError?: (error: Error) => void;
  onMessage: (msg: InboundMessage) => void | Promise<void>;
  onInteraction?: (event: InteractionEvent) => void | Promise<void>;
  onRawEvent?: (type: string, data: unknown) => void | Promise<void>;
}

/** Pure-protocol gateway connection. */
export class GatewayConnection {
  private isAborted = false;
  private currentWs: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private isConnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldRefreshToken = false;

  private readonly reconnect: ReconnectState;
  private readonly opts: GatewayConnectionOptions;
  private readonly resolveUserAgent: () => string;

  constructor(opts: GatewayConnectionOptions) {
    this.opts = opts;
    this.reconnect = new ReconnectState(opts.account.accountId, opts.log);
    const ua = opts.userAgent ?? "qqbot-nodejs/unknown";
    this.resolveUserAgent = typeof ua === "function" ? ua : () => ua;
  }

  /** Start the connection loop. Resolves when abortSignal fires. */
  async start(): Promise<void> {
    this.restoreSession();
    this.registerAbortHandler();
    await this.connect();
    return new Promise<void>((resolve) => {
      this.opts.abortSignal.addEventListener("abort", () => resolve());
    });
  }

  // ============ Session persistence ============

  private restoreSession(): void {
    const saved = this.opts.session?.load();
    if (saved) {
      this.sessionId = saved.sessionId;
      this.lastSeq = saved.lastSeq;
      this.opts.log?.info?.(
        `[${this.opts.account.accountId}] Restored session: sessionId=${saved.sessionId}, lastSeq=${saved.lastSeq}`,
      );
    }
  }

  private saveCurrentSession(): void {
    if (!this.sessionId || !this.opts.session) {
      return;
    }
    this.opts.session.save({
      sessionId: this.sessionId,
      lastSeq: this.lastSeq,
    });
  }

  // ============ Abort + cleanup ============

  private registerAbortHandler(): void {
    this.opts.abortSignal.addEventListener("abort", () => {
      this.isAborted = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.cleanup();
    });
  }

  private cleanup(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (
      this.currentWs &&
      (this.currentWs.readyState === WebSocket.OPEN ||
        this.currentWs.readyState === WebSocket.CONNECTING)
    ) {
      this.currentWs.close();
    }
    this.currentWs = null;
  }

  // ============ Reconnect ============

  private scheduleReconnect(customDelay?: number): void {
    if (this.isAborted || this.reconnect.isExhausted()) {
      this.opts.log?.error(
        `[${this.opts.account.accountId}] Max reconnect attempts reached or aborted`,
      );
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const delay = this.reconnect.getNextDelay(customDelay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isAborted) {
        void this.connect();
      }
    }, delay);
  }

  // ============ Connect ============

  private async connect(): Promise<void> {
    const { log, account } = this.opts;

    if (this.isConnecting) {
      log?.debug?.(`[${account.accountId}] Already connecting, skip`);
      return;
    }
    this.isConnecting = true;

    try {
      this.cleanup();
      if (this.shouldRefreshToken) {
        log?.debug?.(`[${account.accountId}] Refreshing token...`);
        this.opts.clearTokenCache?.();
        this.shouldRefreshToken = false;
      }

      const accessToken = await this.opts.getAccessToken();
      log?.info(`[${account.accountId}] ✅ Access token obtained`);
      const gatewayUrl = await this.opts.getGatewayUrl(accessToken);
      log?.info(`[${account.accountId}] Connecting to ${gatewayUrl}`);

      const ws = new WebSocket(gatewayUrl, {
        headers: { "User-Agent": this.resolveUserAgent() },
      });
      this.currentWs = ws;

      ws.on("open", () => {
        log?.info(`[${account.accountId}] WebSocket connected`);
        this.isConnecting = false;
        this.reconnect.onConnected();
      });

      ws.on("message", async (data) => {
        try {
          const rawData = decodeGatewayMessageData(data);
          const payload = JSON.parse(rawData) as WSPayload;
          const { op, d, s, t } = payload;

          if (s) {
            this.lastSeq = s;
            this.saveCurrentSession();
          }

          switch (op) {
            case GatewayOp.HELLO:
              this.handleHello(ws, d, accessToken);
              break;

            case GatewayOp.DISPATCH: {
              log?.debug?.(
                `[${account.accountId}] Dispatch event: t=${t} payload=${previewPayload(d)}`,
              );
              const result = dispatchEvent(t ?? "", d, account.accountId, log);
              if (result.action === "ready") {
                this.sessionId = result.sessionId;
                this.saveCurrentSession();
                this.opts.onReady?.(result.data);
              } else if (result.action === "resumed") {
                (this.opts.onResumed ?? this.opts.onReady)?.(result.data);
                this.saveCurrentSession();
              } else if (result.action === "interaction") {
                // Interaction 有 handler → 调用；否则 fallback 到 rawEvent
                if (this.opts.onInteraction) {
                  void Promise.resolve(this.opts.onInteraction(result.event));
                } else if (this.opts.onRawEvent) {
                  void Promise.resolve(this.opts.onRawEvent(payload.t!, payload.d));
                }
              } else if (result.action === "message") {
                void Promise.resolve(this.opts.onMessage(result.msg));
              } else if (result.action === "raw") {
                if (this.opts.onRawEvent) {
                  void Promise.resolve(this.opts.onRawEvent(result.type, result.data));
                }
              }
              break;
            }

            case GatewayOp.HEARTBEAT_ACK:
              break;

            case GatewayOp.RECONNECT:
              this.cleanup();
              this.scheduleReconnect();
              break;

            case GatewayOp.INVALID_SESSION: {
              const canResume = d as boolean;
              if (!canResume) {
                this.sessionId = null;
                this.lastSeq = null;
                this.opts.session?.clear();
                this.shouldRefreshToken = true;
              }
              this.cleanup();
              this.scheduleReconnect(3000);
              break;
            }
          }
        } catch (err) {
          log?.error(
            `[${account.accountId}] Message parse error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });

      ws.on("close", (code, reason) => {
        log?.info(`[${account.accountId}] WebSocket closed: ${code} ${reason.toString()}`);
        this.isConnecting = false;
        this.handleClose(code);
      });

      ws.on("error", (err) => {
        log?.error(`[${account.accountId}] WebSocket error: ${err.message}`);
        this.opts.onError?.(err);
      });
    } catch (err) {
      this.isConnecting = false;
      const errMsg = err instanceof Error ? err.message : String(err);
      log?.error(`[${account.accountId}] Connection failed: ${errMsg}`);
      if (errMsg.includes("Too many requests") || errMsg.includes("100001")) {
        this.scheduleReconnect(RATE_LIMIT_DELAY);
      } else {
        this.scheduleReconnect();
      }
    }
  }

  // ============ Protocol handlers ============

  private handleHello(ws: WebSocket, d: unknown, accessToken: string): void {
    const intents = this.opts.intents ?? FULL_INTENTS;
    if (this.sessionId && this.lastSeq !== null) {
      ws.send(
        JSON.stringify({
          op: GatewayOp.RESUME,
          d: {
            token: `QQBot ${accessToken}`,
            session_id: this.sessionId,
            seq: this.lastSeq,
          },
        }),
      );
    } else {
      ws.send(
        JSON.stringify({
          op: GatewayOp.IDENTIFY,
          d: {
            token: `QQBot ${accessToken}`,
            intents,
            shard: [0, 1],
          },
        }),
      );
    }

    const interval = (d as { heartbeat_interval: number }).heartbeat_interval;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ op: GatewayOp.HEARTBEAT, d: this.lastSeq }));
      }
    }, interval);
  }

  private handleClose(code: number): void {
    const action = this.reconnect.handleClose(code, this.isAborted);

    if (action.clearSession) {
      this.sessionId = null;
      this.lastSeq = null;
      this.opts.session?.clear();
    }
    if (action.refreshToken) {
      this.shouldRefreshToken = true;
    }

    this.cleanup();

    if (action.fatal) {
      return;
    }
    if (action.shouldReconnect) {
      this.scheduleReconnect(action.reconnectDelay);
    }
  }
}

/**
 * Serialize a gateway event payload for debug logging.
 *
 * JSON-stringifies the payload; returns `"(non-serializable)"` for cyclic
 * or otherwise unserializable values so logging never throws.
 */
function previewPayload(data: unknown): string {
  if (data === undefined) return "undefined";
  if (data === null) return "null";
  try {
    const s = JSON.stringify(data);
    return s === undefined ? "(non-serializable)" : s;
  } catch {
    return "(non-serializable)";
  }
}
