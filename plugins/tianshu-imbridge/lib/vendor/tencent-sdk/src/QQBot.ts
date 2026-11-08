/**
 * High-level facade for the QQ Open Platform Node.js SDK.
 *
 * 这是大部分用户的主要入口。它把协议层（HTTP / WebSocket / 媒体上传 / 流式
 * 消息）组合成一个清晰的「机器人客户端」对象，类似 `@line/bot-sdk` 或
 * `@larksuiteoapi/node-sdk` 在其他平台上的角色。
 *
 * Example:
 * ```ts
 * import { QQBot } from "@tencent-connect/qqbot-nodejs";
 *
 * const bot = new QQBot({
 *   appId: process.env.QQBOT_APP_ID!,
 *   appSecret: process.env.QQBOT_APP_SECRET!,
 * });
 *
 * bot.on("message", async (ctx, msg) => {
 *   await bot.sendText(msg.replyTarget, `Echo: ${msg.content}`);
 * });
 *
 * await bot.start();
 * ```
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  createMiddlewareContext,
  runMiddlewareChain,
  type Middleware,
  type MiddlewareContext,
} from "./middleware/types.js";
import { ApiClient } from "./protocol/api/api-client.js";
import { ChunkedMediaApi } from "./protocol/api/media-chunked.js";
import { MediaApi } from "./protocol/api/media.js";
import { MessageApi } from "./protocol/api/messages.js";
import { TokenManager } from "./protocol/api/token.js";
import { GatewayConnection, type SessionPersistencePort } from "./protocol/gateway/gateway-connection.js";
import type { InboundMessage } from "./protocol/gateway/event-dispatcher.js";
import { WebhookTransport } from "./protocol/transport/webhook.js";
import type { EventTransport, WebhookServerAdapter } from "./protocol/transport/types.js";
import {
  MediaFileType,
  type ChatScope,
  type Credentials,
  type GatewayAccount,
  type InlineKeyboard,
  type InteractionEvent,
  type Logger,
  type MessageResponse,
  type UploadMediaResponse,
} from "./protocol/types.js";
import { LARGE_FILE_THRESHOLD, sanitizeFileName } from "./protocol/utils/file-utils.js";
import { UploadCache } from "./protocol/utils/upload-cache.js";
import { StreamSession, type StreamSessionOptions } from "./streaming.js";

// ============ Public types ============

/** QQ Open Platform message type codes (msg_type). */
export const MsgType = {
  /** Plain text. */
  TEXT: 0,
  /** Markdown. */
  MARKDOWN: 2,
  /** Ark template message. */
  ARK: 3,
  /** Embed message. */
  EMBED: 4,
  /** Rich media (image/video/voice/file). */
  MEDIA: 7,
} as const;
export type MsgType = (typeof MsgType)[keyof typeof MsgType];

/** Universal message send options — supports all QQ platform message types. */
export interface SendMessageOptions {
  /** Target peer. When `msgId` is present → reply; otherwise → proactive. */
  target: ReplyTarget;
  /** Message type (auto-detected if omitted). */
  msgType?: MsgType;
  /** Plain text content. */
  content?: string;
  /** Markdown payload (msg_type=2). */
  markdown?: { content: string; custom_template_id?: string; params?: Array<{ key: string; values: string[] }> };
  /** Ark template payload (msg_type=3). */
  ark?: { template_id: number; kv: Array<{ key: string; value?: string; obj?: unknown[] }> };
  /** Embed payload (msg_type=4). */
  embed?: Record<string, unknown>;
  /** Rich media reference (msg_type=7, from uploadMedia response). */
  media?: { file_info: string };
  /** Inline keyboard (buttons). */
  keyboard?: InlineKeyboard;
  /** Message reference (quote/reply). */
  messageReference?: { message_id: string };
  /** Pass-through extra fields (for new platform features not yet typed). */
  extra?: Record<string, unknown>;
}

/** API Gateway interface — call any QQ Open Platform REST API. */
export interface ApiGateway {
  /**
   * Authenticated GET request.
   * @param query — values are auto-stringified (numbers accepted).
   */
  get<T = unknown>(path: string, query?: Record<string, string | number | boolean>): Promise<T>;
  /** Authenticated POST request. */
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  /** Authenticated PUT request. */
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  /** Authenticated PATCH request. */
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  /** Authenticated DELETE request. */
  delete<T = unknown>(path: string): Promise<T>;
  /** Get the current valid access token (for advanced/custom usage). */
  getToken(): Promise<string>;
}

/** Resolved peer for outbound messages. */
export interface ReplyTarget {
  /** "c2c" for private chat, "group" for group chat. */
  scope: ChatScope;
  /** User openid (c2c) or group openid (group). */
  targetId: string;
  /** Inbound message id — used to associate the reply with the trigger. */
  msgId?: string;
}

export interface QQBotOptions {
  /** QQ Open Platform AppID. */
  appId: string;
  /** QQ Open Platform AppSecret. */
  appSecret: string;
  /** Stable account identifier used for logging / session persistence. */
  accountId?: string;
  /** Whether the bot has markdown permission. Defaults to false. */
  markdownSupport?: boolean;
  /** Logger. Defaults to a no-op logger. */
  logger?: Logger;
  /** User-Agent header. Defaults to `qqbot-nodejs/<version>`. */
  userAgent?: string;
  /** Override the QQ Open Platform API base URL (mostly for tests). */
  baseUrl?: string;
  /** Override the token endpoint base URL. Defaults to `https://bots.qq.com`. */
  tokenBaseUrl?: string;
  /** Optional session persistence (e.g. file-backed). */
  sessionPersistence?: SessionPersistencePort;
  /** Custom intent mask. Defaults to FULL_INTENTS (group + c2c + interaction). */
  intents?: number;
  /** Override the upload cache. Defaults to a private in-memory cache. */
  uploadCache?: UploadCache;

  /**
   * Event transport mode.
   * - `"websocket"` (default): long-lived WS connection with heartbeat/RESUME.
   * - `"webhook"`: QQ POSTs events to your HTTPS endpoint.
   * - Custom `EventTransport` instance for advanced use.
   */
  transport?: "websocket" | "webhook" | EventTransport;

  /**
   * Token prefetch strategy at startup.
   * - `"sync"` (default): Await token fetch before accepting traffic.
   *   Provides fail-fast semantics — credential errors surface immediately.
   * - `"async"`: Start accepting traffic immediately; token is fetched in
   *   the background. Faster startup but first requests may fail if token
   *   is not yet available.
   */
  tokenPrefetch?: "sync" | "async";

  /** Webhook-specific options (only used when `transport: "webhook"`). */
  webhook?: {
    /** Port to listen on. Defaults to 8080. */
    port?: number;
    /** Path to listen on. Defaults to "/". */
    path?: string;
    /** Bring your own HTTP server adapter (Express/Fastify/Koa). */
    server?: WebhookServerAdapter;
  };
}

/** Lightweight context for interaction events (pre-reserved for future middleware). */
export interface InteractionContext {
  /** The QQBot instance. */
  readonly bot: QQBot;
  /** The interaction event. */
  readonly event: InteractionEvent;
  /** Per-request state slot (for future middleware to share data). */
  state: Record<string, unknown>;
  /** Timestamp when the SDK received this event. */
  readonly receivedAt: number;
}

/** Lightweight context for raw gateway events (pre-reserved for future middleware). */
export interface RawEventContext {
  /** The QQBot instance. */
  readonly bot: QQBot;
  /** Gateway event type string (e.g. "GUILD_CREATE", "FRIEND_ADD"). */
  readonly eventType: string;
  /** Raw event data from the platform. */
  readonly data: unknown;
  /** Per-request state slot (for future middleware to share data). */
  state: Record<string, unknown>;
  /** Timestamp when the SDK received this event. */
  readonly receivedAt: number;
}

/** Built-in event names. */
export type QQBotEventMap = {
  ready: (data: unknown) => void;
  resumed: (data: unknown) => void;
  error: (err: Error) => void;
  message: (ctx: MiddlewareContext, msg: QQBotInboundMessage) => void | Promise<void>;
  interaction: (ctx: InteractionContext, event: InteractionEvent) => void | Promise<void>;
  /**
   * Raw gateway event pass-through for any event not handled by SDK internals.
   *
   * Covers all platform events (guild/group/friend lifecycle, reactions, etc.)
   * without SDK needing explicit support. New platform events are immediately
   * available here with zero SDK changes.
   *
   * @example
   * ```ts
   * bot.on('rawEvent', (ctx) => {
   *   if (ctx.eventType === 'FRIEND_ADD') {
   *     const e = ctx.data as { openid: string; timestamp: string };
   *     console.log('New friend:', e.openid);
   *   }
   * });
   * ```
   */
  rawEvent: (ctx: RawEventContext) => void | Promise<void>;
};

/**
 * Augmented inbound message with a ready-to-use `replyTarget`.
 */
export interface QQBotInboundMessage extends InboundMessage {
  /** The peer this message originated from — pass to `bot.sendText`/`bot.sendFile`. */
  replyTarget: ReplyTarget;
}

// ============ QQBot class ============

const noopLogger: Logger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};

/**
 * High-level QQ Open Platform client.
 *
 * Owns an isolated stack of low-level primitives (token manager, HTTP
 * client, message API, media APIs, gateway connection) per bot instance,
 * so multiple bots can run concurrently without sharing global state.
 */
export class QQBot {
  // Public protocol primitives — exposed for advanced users.
  readonly tokenManager: TokenManager;
  readonly apiClient: ApiClient;
  readonly messageApi: MessageApi;
  readonly mediaApi: MediaApi;
  readonly chunkedMediaApi: ChunkedMediaApi;

  private readonly opts: QQBotOptions;
  private readonly logger: Logger;
  private readonly creds: Credentials;
  private readonly account: GatewayAccount;
  private readonly userAgent: string;
  private readonly uploadCache: UploadCache;
  private readonly middlewares: Middleware[] = [];
  private readonly handlers: { [K in keyof QQBotEventMap]: Set<QQBotEventMap[K]> } = {
    ready: new Set(),
    resumed: new Set(),
    error: new Set(),
    message: new Set(),
    interaction: new Set(),
    rawEvent: new Set(),
  };

  private gateway: GatewayConnection | null = null;
  private abortController: AbortController | null = null;
  private _apiGateway: ApiGateway | null = null;

  constructor(options: QQBotOptions) {
    if (!options.appId) {
      throw new Error("QQBot: appId is required");
    }
    if (!options.appSecret) {
      throw new Error("QQBot: appSecret is required");
    }
    this.opts = options;
    this.logger = options.logger ?? noopLogger;
    this.userAgent = options.userAgent ?? `qqbot-nodejs/0.1.0 (Node/${process.versions.node})`;
    this.creds = {
      appId: options.appId,
      clientSecret: options.appSecret,
    };
    this.account = {
      accountId: options.accountId ?? options.appId,
      appId: options.appId,
      clientSecret: options.appSecret,
      markdownSupport: options.markdownSupport === true,
    };

    this.uploadCache = options.uploadCache ?? new UploadCache({ logger: this.logger });

    this.apiClient = new ApiClient({
      logger: this.logger,
      userAgent: this.userAgent,
      baseUrl: options.baseUrl,
    });
    this.tokenManager = new TokenManager({
      logger: this.logger,
      userAgent: this.userAgent,
      baseUrl: options.tokenBaseUrl,
    });
    this.messageApi = new MessageApi(this.apiClient, this.tokenManager, {
      markdownSupport: options.markdownSupport === true,
      logger: this.logger,
    });

    const cacheAdapter = {
      computeHash: (data: string) => this.uploadCache.computeHash(data),
      get: (hash: string, scope: string, targetId: string, fileType: number) =>
        this.uploadCache.get(hash, scope as ChatScope, targetId, fileType),
      set: (
        hash: string,
        scope: string,
        targetId: string,
        fileType: number,
        fileInfo: string,
        fileUuid: string,
        ttl: number,
      ) =>
        this.uploadCache.set(
          hash,
          scope as ChatScope,
          targetId,
          fileType,
          fileInfo,
          fileUuid,
          ttl,
        ),
    };

    this.mediaApi = new MediaApi(this.apiClient, this.tokenManager, {
      logger: this.logger,
      uploadCache: cacheAdapter,
      sanitizeFileName,
    });
    this.chunkedMediaApi = new ChunkedMediaApi(this.apiClient, this.tokenManager, {
      logger: this.logger,
      uploadCache: cacheAdapter,
      sanitizeFileName,
    });
  }

  // ============ Public getters ============

  /** The QQ Open Platform AppID this bot is bound to. */
  get appId(): string {
    return this.creds.appId;
  }

  /** The stable account id (defaults to appId). */
  get accountId(): string {
    return this.account.accountId;
  }

  // ============ Event listeners ============

  on<K extends keyof QQBotEventMap>(event: K, handler: QQBotEventMap[K]): this {
    this.handlers[event].add(handler);
    return this;
  }

  off<K extends keyof QQBotEventMap>(event: K, handler: QQBotEventMap[K]): this {
    this.handlers[event].delete(handler);
    return this;
  }

  // ============ Middleware ============

  /**
   * Register an inbound middleware. Middlewares run in registration order
   * before the `message` event listeners; calling `ctx.stop()` (or simply
   * not calling `next()`) short-circuits the chain — including the final
   * `message` listener.
   *
   * @example
   * ```ts
   * import { accessPolicy, mentionGate } from "@tencent-connect/qqbot-nodejs";
   * bot.use(accessPolicy({ group: { mode: "allowlist", allow: [...] } }));
   * bot.use(mentionGate());
   * bot.on("message", async (ctx, msg) => {  ... });
   * ```
   */
  use(...middleware: Middleware[]): this {
    for (const mw of middleware) {
      if (typeof mw !== "function") {
        throw new Error("QQBot.use: middleware must be a function");
      }
      this.middlewares.push(mw);
    }
    return this;
  }

  /** Read the registered middleware chain (for diagnostics). */
  getMiddlewares(): readonly Middleware[] {
    return this.middlewares;
  }

  private async emit<K extends keyof QQBotEventMap>(
    event: K,
    ...args: Parameters<QQBotEventMap[K]>
  ): Promise<void> {
    for (const handler of this.handlers[event]) {
      try {
        await Promise.resolve((handler as (...a: unknown[]) => unknown)(...args));
      } catch (err) {
        this.logger.error?.(
          `[qqbot] handler for "${String(event)}" threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ============ Lifecycle ============

  /**
   * Start receiving events from QQ Open Platform.
   *
   * - **WebSocket mode** (default): connects to the WS gateway with heartbeat/RESUME.
   * - **Webhook mode**: starts an HTTP server to receive POST callbacks.
   *
   * Resolves when {@link stop} or the abort signal terminates the connection.
   */
  async start(externalSignal?: AbortSignal): Promise<void> {
    if (this.gateway) {
      throw new Error("QQBot: already started");
    }
    this.abortController = new AbortController();
    if (externalSignal) {
      if (externalSignal.aborted) {
        this.abortController.abort();
      } else {
        externalSignal.addEventListener("abort", () => this.abortController?.abort(), {
          once: true,
        });
      }
    }

    const transportMode = this.opts.transport ?? "websocket";

    if (transportMode === "webhook") {
      await this.startWebhook();
    } else if (transportMode === "websocket") {
      await this.startWebSocket();
    } else {
      // Custom EventTransport instance
      const custom = transportMode as EventTransport;
      await custom.start();
    }

    // Cleanup
    this.tokenManager.stopBackgroundRefresh(this.creds.appId);
    this.gateway = null;
    this.abortController = null;
  }

  /** Stop the transport and background refreshers. */
  stop(): void {
    this.abortController?.abort();
    this.tokenManager.stopBackgroundRefresh(this.creds.appId);
    this.gateway = null;
    this.abortController = null;
  }

  // ============ Token initialization ============

  /**
   * Initialize token based on the configured prefetch strategy.
   *
   * - `"sync"` (default): awaits the first token fetch, providing fail-fast
   *   semantics so credential errors surface at startup.
   * - `"async"`: fires the token fetch in the background and starts the
   *   background refresher immediately — trades fail-fast for faster startup.
   */
  private async initToken(): Promise<void> {
    const mode = this.opts.tokenPrefetch ?? "sync";

    if (mode === "sync") {
      await this.tokenManager.getAccessToken(this.creds.appId, this.creds.clientSecret);
    } else {
      // Fire-and-forget: fetch token in background, log errors but don't block startup.
      this.tokenManager.getAccessToken(this.creds.appId, this.creds.clientSecret).catch((err) => {
        this.logger.error?.(`[qqbot] async token prefetch failed: ${err}`);
        void this.emit("error", err instanceof Error ? err : new Error(String(err)));
      });
    }

    this.tokenManager.startBackgroundRefresh(this.creds.appId, this.creds.clientSecret);
  }

  // ============ Transport: WebSocket ============

  private async startWebSocket(): Promise<void> {
    await this.initToken();

    this.gateway = new GatewayConnection({
      account: this.account,
      abortSignal: this.abortController!.signal,
      log: this.logger,
      userAgent: this.userAgent,
      intents: this.opts.intents,
      session: this.opts.sessionPersistence,
      getAccessToken: () =>
        this.tokenManager.getAccessToken(this.creds.appId, this.creds.clientSecret),
      clearTokenCache: () => this.tokenManager.clearCache(this.creds.appId),
      getGatewayUrl: () => this.messageApi.getGatewayUrl(this.creds),
      onReady: (data) => {
        this.logger.info?.(`[qqbot] gateway READY`);
        void this.emit("ready", data);
      },
      onResumed: (data) => {
        this.logger.info?.(`[qqbot] gateway RESUMED`);
        void this.emit("resumed", data);
      },
      onError: (err) => {
        void this.emit("error", err);
      },
      onMessage: (raw) => this.handleInboundMessage(raw),
      onInteraction: (event) => {
        const ctx: InteractionContext = { bot: this, event, state: {}, receivedAt: Date.now() };
        void this.emit("interaction", ctx, event);
      },
      onRawEvent: (type, data) => {
        const ctx: RawEventContext = { bot: this, eventType: type, data, state: {}, receivedAt: Date.now() };
        void this.emit("rawEvent", ctx);
      },
    });

    await this.gateway.start();
  }

  // ============ Transport: Webhook ============

  private async startWebhook(): Promise<void> {
    await this.initToken();

    const webhook = new WebhookTransport(
      {
        appId: this.creds.appId,
        appSecret: this.creds.clientSecret,
        port: this.opts.webhook?.port,
        path: this.opts.webhook?.path,
        server: this.opts.webhook?.server,
        accountId: this.account.accountId,
        log: this.logger,
        abortSignal: this.abortController!.signal,
      },
      {
        onReady: (data) => {
          this.logger.info?.(`[qqbot] webhook READY`);
          void this.emit("ready", data);
        },
        onResumed: (data) => {
          void this.emit("resumed", data);
        },
        onError: (err) => {
          void this.emit("error", err);
        },
        onMessage: (raw) => this.handleInboundMessage(raw),
        onInteraction: (event) => {
          const ctx: InteractionContext = { bot: this, event, state: {}, receivedAt: Date.now() };
          void this.emit("interaction", ctx, event);
        },
      },
    );

    await webhook.start();
  }

  // ============ Shared inbound message handler ============

  private async handleInboundMessage(raw: InboundMessage): Promise<void> {
    const replyTarget = this.deriveReplyTarget(raw);
    if (!replyTarget) {
      this.logger.debug?.(`[qqbot] inbound message has no reply target — skipping`);
      return;
    }
    const augmented: QQBotInboundMessage = { ...raw, replyTarget };

    const ctx = createMiddlewareContext({
      bot: this,
      message: augmented,
      log: this.logger,
    });

    // Koa-style: compose middleware chain with emit as the final downstream.
    const downstream: Middleware = async () => {
      await this.emit("message", ctx, ctx.message);
    };
    const chain: Middleware[] = [...this.middlewares, downstream];

    try {
      await runMiddlewareChain(chain, ctx);
    } catch (err) {
      this.logger.error?.(
        `[qqbot] middleware chain threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      void this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ============ Message sending ============

  /**
   * Universal message send — supports all QQ Open Platform message types.
   *
   * This is the most flexible sending method. It accepts the full parameter
   * set of POST `/v2/users/{openid}/messages` or `/v2/groups/{group_openid}/messages`.
   * Use it when the convenience helpers (sendText, sendMarkdown, etc.) don't
   * cover your use case.
   *
   * `msg_type` is auto-detected if not specified:
   * - markdown field present → 2 (Markdown)
   * - ark field present → 3 (Ark)
   * - embed field present → 4 (Embed)
   * - media field present → 7 (Rich media)
   * - otherwise → 0 (Text)
   *
   * @example Send a keyboard message
   * ```ts
   * await bot.send({
   *   target: msg.replyTarget,
   *   msgType: MsgType.MARKDOWN,
   *   markdown: { content: '# Hello' },
   *   keyboard: { content: { rows: [...] } },
   * });
   * ```
   *
   * @example Send a proactive message (no msgId)
   * ```ts
   * await bot.send({
   *   target: { scope: 'c2c', targetId: openid },
   *   content: 'Hello from bot!',
   * });
   * ```
   */
  async send(opts: SendMessageOptions): Promise<MessageResponse> {
    const body: Record<string, unknown> = {};
    if (opts.target.msgId) body.msg_id = opts.target.msgId;
    if (opts.msgType !== undefined) body.msg_type = opts.msgType;
    if (opts.content !== undefined) body.content = opts.content;
    if (opts.markdown) body.markdown = opts.markdown;
    if (opts.ark) body.ark = opts.ark;
    if (opts.embed) body.embed = opts.embed;
    if (opts.media) body.media = opts.media;
    if (opts.keyboard) body.keyboard = opts.keyboard;
    if (opts.messageReference) body.message_reference = opts.messageReference;
    if (opts.extra) Object.assign(body, opts.extra);
    return this.messageApi.sendRaw(opts.target.scope, opts.target.targetId, this.creds, body);
  }

  /**
   * Send a text message to a C2C user or group (smart mode).
   *
   * **Difference from `send()`**:
   * - `sendText` auto-selects msg_type based on `markdownSupport` config
   *   (markdown bots automatically send as msg_type=2).
   * - `send()` is explicit mode — you control msg_type directly.
   *
   * When `target.msgId` is present the message is treated as a reply
   * (tied to the inbound message lifecycle); otherwise it is treated as
   * a proactive push.
   */
  async sendText(target: ReplyTarget, content: string): Promise<MessageResponse> {
    if (target.msgId) {
      return this.messageApi.sendMessage(target.scope, target.targetId, content, this.creds, {
        msgId: target.msgId,
      });
    }
    return this.messageApi.sendProactiveMessage(
      target.scope,
      target.targetId,
      content,
      this.creds,
    );
  }

  /** Send a text message with an inline keyboard. */
  async sendTextWithKeyboard(
    target: ReplyTarget,
    content: string,
    inlineKeyboard: InlineKeyboard,
  ): Promise<MessageResponse> {
    return this.messageApi.sendMessage(target.scope, target.targetId, content, this.creds, {
      msgId: target.msgId,
      inlineKeyboard,
    });
  }

  /**
   * Send a Markdown message (msg_type=2).
   *
   * @example
   * ```ts
   * await bot.sendMarkdown(msg.replyTarget, '# Hello **world**');
   * await bot.sendMarkdown(msg.replyTarget, '# Click below', {
   *   keyboard: { content: { rows: [...] } },
   * });
   * ```
   */
  async sendMarkdown(
    target: ReplyTarget,
    content: string,
    opts?: { keyboard?: InlineKeyboard },
  ): Promise<MessageResponse> {
    return this.send({
      target,
      msgType: MsgType.MARKDOWN,
      markdown: { content },
      keyboard: opts?.keyboard,
    });
  }

  /**
   * Recall (delete) a previously sent message.
   *
   * @example
   * ```ts
   * const sent = await bot.sendText(target, 'oops');
   * await bot.recallMessage(target, sent.id);
   * ```
   */
  async recallMessage(target: ReplyTarget, messageId: string): Promise<void> {
    return this.messageApi.recallMessage(target.scope, target.targetId, messageId, this.creds);
  }

  /**
   * Send a wakeup/recall message (C2C only, 30-day window).
   *
   * After a user initiates a conversation, the bot can send periodic
   * recall messages within 30 days using `is_wakeup: true`.
   * Platform enforces frequency limits.
   *
   * @example
   * ```ts
   * await bot.sendWakeup({ scope: 'c2c', targetId: openid }, '你有新消息!');
   * ```
   */
  async sendWakeup(target: ReplyTarget, content: string): Promise<MessageResponse> {
    if (target.scope !== "c2c") {
      throw new Error("sendWakeup is only supported for C2C targets");
    }
    return this.send({ target, content, extra: { is_wakeup: true } });
  }

  /**
   * Send a message to a guild text channel.
   *
   * @example
   * ```ts
   * await bot.sendChannelMessage(channelId, '频道消息', { msgId });
   * ```
   */
  async sendChannelMessage(
    channelId: string,
    content: string,
    opts?: { msgId?: string; keyboard?: InlineKeyboard; messageReference?: string },
  ): Promise<MessageResponse> {
    const body: Record<string, unknown> = { content };
    if (opts?.msgId) body.msg_id = opts.msgId;
    if (opts?.keyboard) body.keyboard = opts.keyboard;
    if (opts?.messageReference) body.message_reference = { message_id: opts.messageReference };
    return this.messageApi.sendChannelMessageRaw(channelId, this.creds, body);
  }

  /**
   * Send a direct message (DM) in a guild.
   *
   * @example
   * ```ts
   * await bot.sendDmMessage(guildId, '私信内容', { msgId });
   * ```
   */
  async sendDmMessage(
    guildId: string,
    content: string,
    opts?: { msgId?: string },
  ): Promise<MessageResponse> {
    const body: Record<string, unknown> = { content };
    if (opts?.msgId) body.msg_id = opts.msgId;
    return this.messageApi.sendDmMessageRaw(guildId, this.creds, body);
  }

  /** Send a typing indicator (C2C only). */
  async sendTyping(target: ReplyTarget, durationSec = 30): Promise<{ refIdx?: string }> {
    if (target.scope !== "c2c") {
      throw new Error("sendTyping is only supported for C2C targets");
    }
    return this.messageApi.sendInputNotify({
      openid: target.targetId,
      creds: this.creds,
      msgId: target.msgId,
      inputSecond: durationSec,
    });
  }

  /** Acknowledge an INTERACTION_CREATE event. */
  async acknowledgeInteraction(
    interactionId: string,
    code = 0,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.messageApi.acknowledgeInteraction(interactionId, this.creds, code, data);
  }

  // ============ API Gateway ============

  /**
   * Open Platform API Gateway — call any QQ Open Platform REST API with
   * automatic token injection and refresh.
   *
   * This is the "escape hatch" for any API not wrapped by a dedicated method.
   * All requests are authenticated, rate-limit aware, and return structured errors.
   *
   * @example List guilds
   * ```ts
   * const guilds = await bot.api.get('/users/@me/guilds');
   * ```
   *
   * @example Create an announcement
   * ```ts
   * await bot.api.post(`/guilds/${guildId}/announces`, {
   *   message_id: msgId, channel_id: channelId,
   * });
   * ```
   *
   * @example Get a raw access token
   * ```ts
   * const token = await bot.api.getToken();
   * ```
   */
  get api(): ApiGateway {
    if (this._apiGateway) return this._apiGateway;
    this._apiGateway = {
      get: <T = unknown>(path: string, query?: Record<string, string | number | boolean>) =>
        this.apiRequest<T>("GET", path, undefined, query),
      post: <T = unknown>(path: string, body?: unknown) =>
        this.apiRequest<T>("POST", path, body),
      put: <T = unknown>(path: string, body?: unknown) =>
        this.apiRequest<T>("PUT", path, body),
      patch: <T = unknown>(path: string, body?: unknown) =>
        this.apiRequest<T>("PATCH", path, body),
      delete: <T = unknown>(path: string) =>
        this.apiRequest<T>("DELETE", path),
      getToken: () =>
        this.tokenManager.getAccessToken(this.creds.appId, this.creds.clientSecret),
    };
    return this._apiGateway;
  }

  private async apiRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean>,
  ): Promise<T> {
    const token = await this.tokenManager.getAccessToken(
      this.creds.appId,
      this.creds.clientSecret,
    );
    let fullPath = path;
    if (query && Object.keys(query).length > 0) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
      fullPath = `${path}?${params.toString()}`;
    }
    return this.apiClient.request<T>(token, method, fullPath, body ?? undefined);
  }

  // ============ Streaming ============

  /**
   * Open a C2C stream session for incremental output.
   *
   * @returns A {@link StreamSession} — call `update(fullText)` repeatedly,
   * then `complete()` when finished.
   */
  openStream(opts: {
    target: ReplyTarget;
    eventId?: string;
    throttleMs?: number;
  }): StreamSession {
    if (opts.target.scope !== "c2c") {
      throw new Error("Streaming is only supported for C2C targets");
    }
    if (!opts.target.msgId) {
      throw new Error("Streaming requires target.msgId from the inbound message");
    }
    const sessionOptions: StreamSessionOptions = {
      openid: opts.target.targetId,
      msgId: opts.target.msgId,
      creds: this.creds,
      eventId: opts.eventId,
      throttleMs: opts.throttleMs,
      logger: this.logger,
    };
    return new StreamSession(this.messageApi, sessionOptions);
  }

  // ============ Media ============

  /**
   * Upload media (image / voice / video / file) to a target. Automatically
   * dispatches to the chunked-upload path when the source exceeds
   * {@link LARGE_FILE_THRESHOLD} bytes.
   */
  async uploadMedia(opts: {
    target: ReplyTarget;
    fileType: MediaFileType;
    /** Mutually exclusive: pass exactly one source. */
    url?: string;
    fileData?: string;
    buffer?: Buffer;
    localPath?: string;
    fileName?: string;
    /** Whether to let the server send the message immediately. */
    srvSendMsg?: boolean;
    onProgress?: (uploaded: number, total: number) => void;
  }): Promise<UploadMediaResponse> {
    const sources = [opts.url, opts.fileData, opts.buffer, opts.localPath].filter(
      (v) => v !== undefined,
    );
    if (sources.length === 0) {
      throw new Error("uploadMedia: one of url/fileData/buffer/localPath is required");
    }
    if (sources.length > 1) {
      throw new Error("uploadMedia: provide exactly one source");
    }

    const size = await this.computeSourceSize(opts);
    const useChunked = size !== null && size >= LARGE_FILE_THRESHOLD;

    // Auto-fill fileName from localPath or URL when not explicitly provided
    const fileName = opts.fileName
      ?? (opts.localPath ? path.basename(opts.localPath) : undefined)
      ?? (opts.url ? decodeURIComponent(path.basename(new URL(opts.url).pathname)) || undefined : undefined);

    if (useChunked && (opts.localPath || opts.buffer)) {
      const source = opts.localPath
        ? { kind: "localPath" as const, path: opts.localPath, size: size! }
        : {
            kind: "buffer" as const,
            buffer: opts.buffer!,
            fileName,
          };
      return this.chunkedMediaApi.uploadChunked({
        scope: opts.target.scope,
        targetId: opts.target.targetId,
        fileType: opts.fileType,
        source,
        creds: this.creds,
        fileName,
        onProgress: opts.onProgress
          ? (p) => opts.onProgress!(p.uploadedBytes, p.totalBytes)
          : undefined,
      });
    }

    return this.mediaApi.uploadMedia(
      opts.target.scope,
      opts.target.targetId,
      opts.fileType,
      this.creds,
      {
        url: opts.url,
        fileData: opts.fileData,
        buffer: opts.buffer,
        localPath: opts.localPath,
        srvSendMsg: opts.srvSendMsg,
        fileName,
      },
    );
  }

  /**
   * Upload + send a media message to a C2C user or group.
   */
  async sendMedia(opts: {
    target: ReplyTarget;
    fileType: MediaFileType;
    url?: string;
    fileData?: string;
    buffer?: Buffer;
    localPath?: string;
    fileName?: string;
    /** Optional caption (sent as the `content` field). */
    content?: string;
    onProgress?: (uploaded: number, total: number) => void;
  }): Promise<{ upload: UploadMediaResponse; message: MessageResponse | undefined }> {
    const upload = await this.uploadMedia({ ...opts, srvSendMsg: false });
    const message = await this.mediaApi.sendMediaMessage(
      opts.target.scope,
      opts.target.targetId,
      upload.file_info,
      this.creds,
      {
        msgId: opts.target.msgId,
        content: opts.content,
      },
    );
    return { upload, message };
  }

  /** Convenience: upload + send an image. */
  async sendImage(
    target: ReplyTarget,
    source: { url?: string; buffer?: Buffer; localPath?: string },
    opts?: { content?: string; onProgress?: (uploaded: number, total: number) => void },
  ): Promise<{ upload: UploadMediaResponse; message: MessageResponse | undefined }> {
    return this.sendMedia({
      target,
      fileType: MediaFileType.IMAGE,
      ...source,
      content: opts?.content,
      onProgress: opts?.onProgress,
    });
  }

  /** Convenience: upload + send a video. */
  async sendVideo(
    target: ReplyTarget,
    source: { url?: string; buffer?: Buffer; localPath?: string },
    opts?: { content?: string; onProgress?: (uploaded: number, total: number) => void },
  ): Promise<{ upload: UploadMediaResponse; message: MessageResponse | undefined }> {
    return this.sendMedia({
      target,
      fileType: MediaFileType.VIDEO,
      ...source,
      content: opts?.content,
      onProgress: opts?.onProgress,
    });
  }

  /** Convenience: upload + send a voice message. */
  async sendVoice(
    target: ReplyTarget,
    source: { url?: string; buffer?: Buffer; localPath?: string },
    opts?: { onProgress?: (uploaded: number, total: number) => void },
  ): Promise<{ upload: UploadMediaResponse; message: MessageResponse | undefined }> {
    return this.sendMedia({
      target,
      fileType: MediaFileType.VOICE,
      ...source,
      onProgress: opts?.onProgress,
    });
  }

  /** Convenience: upload + send a generic file (for users with file-message permission). */
  async sendFile(
    target: ReplyTarget,
    source: { url?: string; buffer?: Buffer; localPath?: string },
    opts?: {
      fileName?: string;
      content?: string;
      onProgress?: (uploaded: number, total: number) => void;
    },
  ): Promise<{ upload: UploadMediaResponse; message: MessageResponse | undefined }> {
    return this.sendMedia({
      target,
      fileType: MediaFileType.FILE,
      ...source,
      fileName: opts?.fileName,
      content: opts?.content,
      onProgress: opts?.onProgress,
    });
  }

  // ============ Internal ============

  private deriveReplyTarget(raw: InboundMessage): ReplyTarget | null {
    if (raw.kind === "c2c") {
      return { scope: "c2c", targetId: raw.senderId, msgId: raw.messageId };
    }
    if (raw.kind === "group" && raw.groupOpenid) {
      return { scope: "group", targetId: raw.groupOpenid, msgId: raw.messageId };
    }
    // Guild / DM 暂时没有 channel-level 的 c2c/group 等价。SDK 选择忽略
    // 这两类消息（业务侧仍然可以通过 raw 字段自己处理）。
    return null;
  }

  private async computeSourceSize(opts: {
    url?: string;
    fileData?: string;
    buffer?: Buffer;
    localPath?: string;
  }): Promise<number | null> {
    if (opts.buffer) {
      return opts.buffer.length;
    }
    if (opts.localPath) {
      try {
        const stat = await fs.promises.stat(opts.localPath);
        return stat.size;
      } catch {
        return null;
      }
    }
    if (opts.fileData) {
      // base64 length → byte length estimate.
      return Math.floor((opts.fileData.length * 3) / 4);
    }
    // url upload — server-side size, can't know up-front.
    return null;
  }
}
