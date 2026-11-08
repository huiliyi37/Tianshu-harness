# @tencent-connect/qqbot-nodejs 使用指南

> Tencent QQ 开放平台 Node.js SDK，提供与 QQ 机器人开放平台对接所需的全部协议层能力：
> HTTP REST、WebSocket Gateway、消息收发、媒体上传（含大文件分块）、C2C 流式消息（`stream_messages`）。
>
> 本 SDK 与 [`@line/bot-sdk`](https://github.com/line/line-bot-sdk-nodejs)、
> [`@larksuiteoapi/node-sdk`](https://github.com/larksuite/node-sdk) 这类官方客户端定位一致：
> **只关心协议 + 类型，不携带任何上层业务概念**。

---

## 目录

- [1. 环境要求](#1-环境要求)
- [2. 安装](#2-安装)
- [3. 准备工作](#3-准备工作)
- [4. 快速开始](#4-快速开始)
- [5. 核心概念](#5-核心概念)
- [6. 创建 Bot 实例：`QQBotOptions`](#6-创建-bot-实例qqbotoptions)
- [7. 生命周期管理](#7-生命周期管理)
- [8. 事件监听](#8-事件监听)
- [9. 消息发送](#9-消息发送)
- [10. 媒体上传与发送](#10-媒体上传与发送)
- [11. C2C 流式消息（`stream_messages`）](#11-c2c-流式消息stream_messages)
- [12. 交互事件（按钮）](#12-交互事件按钮)
- [13. 错误处理](#13-错误处理)
- [14. 高级用法](#14-高级用法)
- [15. 协议层 API（`/protocol`）](#15-协议层-apiprotocol)
- [16. 平台限制与最佳实践](#16-平台限制与最佳实践)
- [17. 模块结构](#17-模块结构)
- [18. 内置示例](#18-内置示例)

---

## 1. 环境要求

- Node.js `>= 18`（依赖全局 `fetch` 与 `AbortController`）。
- TypeScript 项目建议 `>= 5.0`，本 SDK 使用 ESM 输出。
- 包是纯 ESM（`"type": "module"`）。如果你的工程是 CJS，请通过动态 `import()` 加载。

## 2. 安装

```bash
pnpm add @tencent-connect/qqbot-nodejs
# 或
npm install @tencent-connect/qqbot-nodejs
# 或
yarn add @tencent-connect/qqbot-nodejs
```

## 3. 准备工作

在 [QQ 开放平台](https://q.qq.com/) 创建机器人后，你会获得两个核心凭证：

- `AppID`
- `AppSecret`

**这两个凭证以构造函数参数形式传入 `QQBot`**，由调用方完全自主决定来源：
配置中心、密钥管理服务（KMS / Vault）、上层框架的注入容器、命令行参数等都可以。

```ts
const bot = new QQBot({
  appId: "你的 AppID",
  appSecret: "你的 AppSecret",
});
```

> ⚠️ 本 SDK **不会**读取任何 `process.env.QQBOT_*` 环境变量。
> 仓库 `examples/` 下的示例使用 `process.env` 仅是为了让 demo 一键就能跑起来，
> 不代表生产建议；接入到自己的服务时请按你的工程规范注入凭证。

> SDK 会自动使用 `appId` + `appSecret` 调用 `https://bots.qq.com/app/getAppAccessToken`
> 获取 `access_token` 并维护其生命周期（缓存 + 提前 5 分钟刷新 + 失效自动重新拉取）。
> 你不需要也不应自行处理 token。

## 4. 快速开始

```ts
import { QQBot } from "@tencent-connect/qqbot-nodejs";

const bot = new QQBot({
  appId: "你的 AppID",          // ← 实例化时传入
  appSecret: "你的 AppSecret",  // ← 实例化时传入
  logger: console,
});

bot.on("ready", () => console.log("connected"));

bot.on("message", async (ctx, msg) => {
  // C2C 私聊回声
  await bot.sendText(msg.replyTarget, `Echo: ${msg.content}`);
});

await bot.start();
```

凭证从哪儿来由你决定，例如从配置文件读取：

```ts
import { readFileSync } from "node:fs";
const { appId, appSecret } = JSON.parse(readFileSync("./qqbot.config.json", "utf8"));
const bot = new QQBot({ appId, appSecret });
```

或是从配置中心 / KMS：

```ts
const { appId, appSecret } = await secretManager.fetch("qqbot/prod");
const bot = new QQBot({ appId, appSecret });
```

运行后，向机器人 C2C 私聊或在群里 @ 它发任意一句话，机器人就会以 `Echo: ...` 回复。

## 5. 核心概念

### 5.1 `QQBot`

**高层 facade**，把协议层（HTTP / WebSocket / 媒体上传 / 流式消息）组合成一个清晰的「机器人客户端」对象。
绝大多数用户只需要这一个类。

### 5.2 `ReplyTarget`

回复目标的统一表示。所有发送类 API 的第一个参数都是 `ReplyTarget`：

```ts
interface ReplyTarget {
  scope: "c2c" | "group";  // 私聊 or 群聊
  targetId: string;        // c2c 时是 user openid；group 时是 group openid
  msgId?: string;          // 关联的入站消息 id（被动回复时必带）
}
```

入站消息会自动附带一个可直接复用的 `replyTarget`：

```ts
bot.on("message", async (ctx, msg) => {
  await bot.sendText(msg.replyTarget, "hi");
});
```

`msgId` 的存在与否决定消息是 **被动回复** 还是 **主动推送**：

| 场景 | `msgId` | 行为 |
| :--- | :--- | :--- |
| 用户发消息后机器人立刻回 | 有 | 被动回复（关联入站消息生命周期） |
| 机器人主动 push 一条消息 | 无 | 主动消息（受 QQ 平台主动消息额度限制） |

### 5.3 `QQBotInboundMessage`

入站消息的统一封装，包含所有协议层信息 + 一个开箱即用的 `replyTarget`。
关键字段：

```ts
interface QQBotInboundMessage {
  kind: "c2c" | "group" | "guild" | "dm";
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
  attachments?: Array<{ content_type: string; url: string; filename?: string; ... }>;
  msgIdx?: string;
  refMsgIdx?: string;
  msgType?: number;
  mentions?: ...;
  replyTarget: ReplyTarget;  // ← 由 SDK 自动派生
}
```

> **注意**：`guild` / `dm` 类型的消息（频道、私信）目前不会派生 `replyTarget`，
> 高层 facade 不处理它们。如果你需要响应频道/频道私信，请使用底层 `MessageApi`。

## 6. 创建 Bot 实例：`QQBotOptions`

```ts
const bot = new QQBot({
  // 必填
  appId: "...",
  appSecret: "...",

  // 可选
  accountId: "my-bot",            // 日志 / session 持久化用的稳定标识符；默认 = appId
  markdownSupport: false,         // 机器人是否拥有 markdown 权限；默认 false
  logger: console,                // 日志器；默认 no-op
  userAgent: "my-app/1.0.0",      // HTTP / WS 的 UA；默认 qqbot-nodejs/<version>
  baseUrl: "https://api.sgroup.qq.com",  // 仅用于测试 mock

  intents: FULL_INTENTS,          // 自定义 intent 掩码；默认 FULL_INTENTS
  sessionPersistence: { ... },    // 跨进程恢复 session；见 §14.1
  uploadCache: new UploadCache(), // 自定义上传缓存；默认 SDK 内部独享一份
});
```

> `markdownSupport` 影响 `sendText` 的请求体。如果你的机器人没有 markdown 权限，
> 务必保持为 `false`，否则 QQ 服务端会以 `40034090` / 渲染失败提示告知。

## 7. 生命周期管理

### 7.1 启动

```ts
await bot.start();                    // 阻塞到 stop() 或外部 abort
await bot.start(externalAbortSignal); // 由调用方控制何时停止
```

`start()` 会：
1. 立刻同步获取一次 `access_token`（暴露认证错误，提前失败）。
2. 启动后台 token 刷新循环。
3. 创建并连接 WebSocket Gateway。
4. 在 abort 之前持续接收事件、自动重连。

### 7.2 停止

```ts
bot.stop();
```

或通过 `AbortController`：

```ts
const ac = new AbortController();
process.on("SIGINT", () => ac.abort());
process.on("SIGTERM", () => ac.abort());
await bot.start(ac.signal);
```

`stop()` / abort 后：关闭 WebSocket、停止心跳与 token 后台刷新、释放定时器。

### 7.3 重连

SDK 自带：

- HEARTBEAT / RESUME / IDENTIFY 完整握手。
- 4004（auth failed）→ 清缓存 token 后重连。
- 4006（invalid session）→ 清 sessionId、丢弃 lastSeq、重新 IDENTIFY。
- 4007（seq out of range）→ 同上。
- 4008（rate limited）→ 等待 60s 再重连。
- 4009（session timeout）→ 当作普通重连。
- 4914 / 4915（intents）→ 视为致命错误，不再重连。
- 退避序列：`1s → 2s → 5s → 10s → 30s → 60s`，最多 100 次。
- "短时间内多次断开" 触发 token 强制刷新。

## 8. 事件监听

```ts
bot.on("ready",       (data) => { /* sessionId / heartbeat 已建立 */ });
bot.on("resumed",     (data) => { /* 重连成功 */ });
bot.on("error",       (err) => { /* 网络 / 协议错误 */ });
bot.on("message",     (ctx, msg) => { /* MiddlewareContext + QQBotInboundMessage */ });
bot.on("interaction", (ctx, event) => { /* InteractionContext + InteractionEvent，按钮回调等 */ });
```

`bot.on()` 返回 `this`，支持链式：

```ts
bot
  .on("ready", () => console.log("✅"))
  .on("message", handleMessage)
  .on("error", console.error);
```

事件回调可以是 `async` 函数，handler 抛错会被 SDK 捕获并打到 `logger.error`，
不会传播为 unhandled rejection。

`bot.off(event, handler)` 可移除监听。

## 9. 消息发送

所有发送类 API 都是 `async`，返回 `MessageResponse`（含 `id`、`timestamp`、`ext_info.ref_idx`）。

### 9.1 文本

```ts
await bot.sendText(target, "hello world");
```

- `target.msgId` 存在 → 走「被动回复」路径，关联入站消息。
- `target.msgId` 不存在 → 走「主动消息」路径（受额度限制）。

### 9.2 带按钮（inline keyboard）的文本

```ts
import type { InlineKeyboard } from "@tencent-connect/qqbot-nodejs";

const keyboard: InlineKeyboard = {
  content: {
    rows: [
      {
        buttons: [
          {
            id: "btn-confirm",
            render_data: { label: "确认", visited_label: "已确认", style: 1 },
            action: { type: 2, permission: { type: 2 }, data: "confirmed" },
          },
        ],
      },
    ],
  },
};

await bot.sendTextWithKeyboard(target, "请确认", keyboard);
```

按钮点击会触发 `interaction` 事件，详见 §12。

### 9.3 输入中提示（C2C only）

```ts
await bot.sendTyping(target, 30);  // 显示 30 秒"输入中"
```

仅在 `target.scope === "c2c"` 时可用。

### 9.4 主动 push（无 `msgId`）

```ts
await bot.sendText({ scope: "c2c", targetId: userOpenid }, "周报来了");
```

主动消息有调用频次/额度限制，请阅读 QQ 开放平台官方文档。

## 10. 媒体上传与发送

QQ 平台的媒体消息流程是：**「上传」+「发送」两步**。SDK 已经把它们包装成了一组对偶 API：

| API | 行为 |
| :--- | :--- |
| `bot.uploadMedia(opts)` | **只上传**，返回 `file_uuid` / `file_info` |
| `bot.sendMedia(opts)` | **上传 + 立刻发送一条媒体消息** |
| `bot.sendImage / sendVoice / sendVideo / sendFile` | `sendMedia` 的便捷别名 |

### 10.1 文件来源（4 选 1）

```ts
{ url: "https://example.com/file.png" }   // 让 QQ 服务端拉取（白名单 host）
{ buffer: Buffer.from(...) }              // 内存中的字节
{ localPath: "/tmp/file.png" }            // 本地文件
{ fileData: "base64string..." }           // 已经是 base64 的字符串
```

> 它们 **互斥**，必须且只能传一个。

### 10.2 大文件分块上传（自动）

当源文件 ≥ `LARGE_FILE_THRESHOLD`（5 MB）时，SDK **自动**走分块上传通路：

```
upload_prepare → PUT 到 COS 预签名 URL → upload_part_finish → complete_upload
```

调用方完全不用感知这个切换，传 `localPath` 或 `buffer` 即可。

`url` / `fileData` 来源不会走分块（`fileData` 走 base64 直传，`url` 走服务端拉取）。

### 10.3 类型与尺寸上限

| 媒体类型 | 枚举值 | 上限 |
| :--- | :--- | ---: |
| `IMAGE` | `MediaFileType.IMAGE` (=1) | 30 MB |
| `VIDEO` | `MediaFileType.VIDEO` (=2) | 100 MB |
| `VOICE` | `MediaFileType.VOICE` (=3) | 20 MB |
| `FILE`  | `MediaFileType.FILE`  (=4) | 100 MB |

可通过 `getMaxUploadSize(fileType)` 程序化查询。

### 10.4 发送图片

```ts
await bot.sendImage(target, { localPath: "/tmp/cat.jpg" });

await bot.sendImage(
  target,
  { url: "https://example.com/cat.jpg" },
  { content: "这是一只猫" },
);
```

### 10.5 发送语音 / 视频 / 文件

```ts
await bot.sendVoice(target, { localPath: "/tmp/voice.silk" });

await bot.sendVideo(target, { buffer: videoBuffer });

await bot.sendFile(
  target,
  { localPath: "/tmp/report.pdf" },
  {
    fileName: "2025-Q4-报告.pdf",   // 仅 FILE 类型有效
    content: "请查收",
    onProgress: (uploaded, total) =>
      console.log(`${uploaded}/${total} (${((uploaded / total) * 100).toFixed(1)}%)`),
  },
);
```

`onProgress` 仅在分块上传路径上会被调用。

### 10.6 只上传不发送

```ts
const upload = await bot.uploadMedia({
  target,
  fileType: MediaFileType.IMAGE,
  buffer: imgBuffer,
  srvSendMsg: false,   // 不要让服务端立刻发送
});

console.log(upload.file_uuid, upload.file_info, upload.ttl);
```

随后你可以用 `file_info` 在 TTL 内多次复用：

```ts
await bot.messageApi.sendMediaMessage(
  target.scope,
  target.targetId,
  upload.file_info,
  bot["creds"],
  { msgId: target.msgId, content: "..." },
);
```

或者直接用底层 `bot.mediaApi.sendMediaMessage(...)`。

### 10.7 上传缓存（去重）

SDK 内置了 LRU + TTL 上传缓存：相同字节内容（按 MD5 hash）+ 相同 `(scope, targetId, fileType)`
在 TTL 内只会真正上传一次，第二次会直接返回已有 `file_info`，省掉一次开销。

可以通过 `uploadCache` 选项替换为自定义实现（共享缓存或持久化）。

## 11. C2C 流式消息（`stream_messages`）

QQ 开放平台只对 **C2C（私聊）** 开放 `stream_messages`，可用于把 LLM 的逐 token 输出
实时回放给用户。

### 11.1 基本用法

```ts
bot.on("message", async (ctx, msg) => {
  if (msg.replyTarget.scope !== "c2c") return;

  const stream = bot.openStream({ target: msg.replyTarget });

  let buffer = "";
  for await (const token of llmStream(msg.content)) {
    buffer += token;
    await stream.update(buffer);   // ← 始终传"截至目前的全文"，不是 delta！
  }
  await stream.complete();          // 标记 input_state = DONE
});
```

### 11.2 关键约束

- `update(fullText)` 必须传 **完整文本**，不是增量。QQ 协议是 `input_mode=replace` 语义。
- 节流间隔默认 `500ms`，最小 `300ms`（QQ 开放平台官方建议）。
- 必须基于一条 **5 分钟内** 的入站消息（`target.msgId` 必填，否则抛错）。
- 一个流会话内的所有帧共享同一个 `msg_seq`，`index` 自增。
- `complete()` 后再调 `update()` 是 no-op；调 `cancel()` 会停止后续自动 flush 但不会发 DONE。

### 11.3 自定义节流

```ts
const stream = bot.openStream({
  target: msg.replyTarget,
  throttleMs: 300,        // 至少 300ms
  eventId: "trace-xyz",   // 默认 = msg.replyTarget.msgId
});
```

### 11.4 配套示例

`examples/send-streaming-100/index.ts`：等用户先发一条触发消息，然后机器人以 ≈2 字/秒
推送 100 字内容，验证整条 `stream_messages` 链路。

## 12. 交互事件（按钮）

按钮被点击时，机器人会收到 `INTERACTION_CREATE` 事件：

```ts
bot.on("interaction", async (ctx, event) => {
  console.log("按钮点击:", event.data.resolved.button_id, event.data.resolved.button_data);

  // QQ 平台要求 5 秒内 ACK
  await bot.acknowledgeInteraction(event.id, 0);  // 0=成功
});
```

`acknowledgeInteraction(id, code)` 的 `code`：

| code | 含义 |
| :---: | :--- |
| 0 | 成功 |
| 1 | 操作失败 |
| 2 | 操作频繁 |
| 3 | 重复操作 |
| 4 | 没有权限 |
| 5 | 仅管理员可操作 |

## 13. 错误处理

### 13.1 `ApiError`

所有 HTTP 调用失败都会抛 `ApiError`：

```ts
import { ApiError } from "@tencent-connect/qqbot-nodejs";

try {
  await bot.sendText(target, "hi");
} catch (err) {
  if (err instanceof ApiError) {
    console.error("HTTP", err.httpStatus, "code", err.bizCode, "path", err.path);
    // err.bizMessage 是 QQ 服务端原始错误信息
  } else {
    throw err;
  }
}
```

字段含义：

| 字段 | 说明 |
| :--- | :--- |
| `httpStatus` | HTTP 状态码（`0` = 网络错误 / 超时） |
| `path` | 请求路径，例如 `/v2/users/{id}/messages` |
| `bizCode` | 业务错误码（`code` 或 `err_code`） |
| `bizMessage` | 服务端原始 message |

### 13.2 `UploadDailyLimitExceededError`

当大文件上传命中 `upload_prepare` 的日额度限制时（错误码 `UPLOAD_PREPARE_FALLBACK_CODE`）会抛出：

```ts
import { UploadDailyLimitExceededError } from "@tencent-connect/qqbot-nodejs";

try {
  await bot.sendFile(target, { localPath: "big.zip" });
} catch (err) {
  if (err instanceof UploadDailyLimitExceededError) {
    // 降级：转发链接 / 让用户改用别的通道 / 排队明天再发
  }
}
```

### 13.3 重试

SDK 已为以下场景内置自动重试，**调用方不需要再包一层 retry**：

- 上传 `POST /files`：3 次指数退避。
- `upload_part_finish`：先快速重试，命中可重试错误码后进入 *持久重试循环*（最长 10 分钟）。
- `complete_upload`：3 次指数退避。
- WebSocket Gateway：完整退避序列 + token 失效处理。

## 14. 高级用法

### 14.1 跨进程恢复 session

通过 `sessionPersistence` 钩子把 `sessionId` 与 `lastSeq` 写入磁盘 / Redis：

```ts
import * as fs from "node:fs";
import { QQBot, type SessionPersistencePort, type PersistedSession }
  from "@tencent-connect/qqbot-nodejs";

const FILE = "/tmp/qqbot-session.json";

const persistence: SessionPersistencePort = {
  load: () => {
    try { return JSON.parse(fs.readFileSync(FILE, "utf8")) as PersistedSession; }
    catch { return null; }
  },
  save: (s) => fs.writeFileSync(FILE, JSON.stringify(s)),
  clear: () => fs.existsSync(FILE) && fs.unlinkSync(FILE),
};

const bot = new QQBot({ appId, appSecret, sessionPersistence: persistence });
```

进程重启后，SDK 会优先尝试 RESUME，避免 IDENTIFY 重新计算 intents。

### 14.2 多 Bot 并存

每个 `QQBot` 实例自带独立的 `TokenManager` / `ApiClient` / `UploadCache` / `GatewayConnection`，
没有任何模块级全局状态，可以放心地在同一进程里跑多个机器人：

```ts
const botA = new QQBot({ appId: "A", appSecret: "..." });
const botB = new QQBot({ appId: "B", appSecret: "..." });

await Promise.all([botA.start(), botB.start()]);
```

### 14.3 自定义 intents

```ts
import { FULL_INTENTS } from "@tencent-connect/qqbot-nodejs/protocol";

const bot = new QQBot({
  appId, appSecret,
  intents: FULL_INTENTS & ~(1 << 26),  // 关掉 INTERACTION
});
```

### 14.4 Logger 接口

```ts
interface Logger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
}
```

可直接传 `console`，也可以适配 pino / winston 等。

### 14.5 检查 token 状态

```ts
const status = bot.tokenManager.getStatus(appId);
// { status: "valid" | "expired" | "refreshing" | "none", expiresAt: ... }
```

## 15. 协议层 API（`/protocol`）

如果你需要 SDK 没暴露的能力（例如自定义 retry policy、自己实现 session 持久化层、
直接发原始 WebSocket 包），可以从子入口直接拿到所有原语：

```ts
import {
  // HTTP
  ApiClient, RequestOptions,
  TokenManager, BackgroundRefreshOptions,
  MessageApi, MediaApi, ChunkedMediaApi,

  // 重试
  withRetry,
  buildPartFinishPersistentPolicy,
  COMPLETE_UPLOAD_RETRY_POLICY,
  UPLOAD_RETRY_POLICY,

  // 路由
  messagePath, mediaUploadPath, streamMessagePath, gatewayPath,
  uploadPreparePath, uploadPartFinishPath, uploadCompletePath,
  channelMessagePath, dmMessagePath, interactionPath,

  // Gateway
  FULL_INTENTS, GatewayOp, GatewayCloseCode, GatewayEvent,
  GatewayConnection, ReconnectState,
  decodeGatewayMessageData,
  dispatchEvent,

  // Utils
  formatDuration, formatErrorMessage, formatFileSize,
  CHUNKED_UPLOAD_MAX_SIZE, LARGE_FILE_THRESHOLD, MAX_UPLOAD_SIZE,
  MEDIA_FILE_TYPE_INFO, getFileTypeName, getMaxUploadSize, sanitizeFileName,
  UploadCache, computeFileHash,
} from "@tencent-connect/qqbot-nodejs/protocol";
```

### 15.1 直接组装一个最小客户端

```ts
import {
  ApiClient, TokenManager, MessageApi, MediaApi,
} from "@tencent-connect/qqbot-nodejs/protocol";

const apiClient = new ApiClient({ logger: console });
const tokenManager = new TokenManager({ logger: console });
const messageApi = new MessageApi(apiClient, tokenManager, { markdownSupport: false });

await messageApi.sendMessage(
  "c2c",
  userOpenid,
  "hello",
  { appId, clientSecret: appSecret },
  { msgId: triggerMsgId },
);
```

这条路径完全不依赖 `QQBot` / `GatewayConnection`，适合 webhook 模式的部署。

### 15.2 频道（Guild）/ 频道私信（DM）

QQ 频道接口在高层 facade 里没有便捷方法（绝大多数官方机器人在群和私聊场景），
请直接用 `MessageApi`：

```ts
await bot.messageApi.sendChannelMessage({
  channelId,
  content: "hi",
  creds: { appId, clientSecret: appSecret },
  msgId: triggerMsgId,
});

await bot.messageApi.sendDmMessage({
  guildId,
  content: "hi",
  creds: { appId, clientSecret: appSecret },
  msgId: triggerMsgId,
});
```

## 16. 平台限制与最佳实践

### 16.1 QQ 平台硬性限制

- `stream_messages` 只支持 C2C 私聊，不支持群聊。
- 流式消息节流不能低于 `300ms`。
- 主动消息有额度，不要把它当推送系统用。
- `markdown` 消息需要审核通过的特殊权限，未审核机器人请保持 `markdownSupport: false`。
- 群里收到的入站消息携带的是 `member_openid`，不是 QQ 号。
- `upload_prepare` 有日额度，命中后会抛 `UploadDailyLimitExceededError`。

### 16.2 推荐做法

- 用 `AbortController` 接管 `bot.start()`，让 SIGINT/SIGTERM 优雅退出。
- 长期运行的服务务必使用 `sessionPersistence`，缩短重启后的恢复时间。
- 大文件用 `localPath`（流式读盘）而不是 `buffer`（一次性占用内存）。
- 业务侧自己做幂等，机器人重连可能造成同一条消息重复回调。
- `logger.debug` 默认会打印请求体，敏感信息已脱敏（`access_token` / `file_data`），
  生产环境关掉 debug 即可。

### 16.3 不推荐的做法

- ❌ 在 `bot.on("message", ...)` 回调里用 `await new Promise(() => {})` 之类阻塞它。
  下一条消息会一直等。
- ❌ 把同一份 `creds` 对象修改后再继续用：SDK 缓存了 token 的 key 是 `appId.trim()`。
- ❌ 用流式消息发"发完一句新一句"的需求 —— 那是 `sendText` 的活，
  `stream_messages` 是 **同一条消息原地不断改写**。

## 17. 模块结构

```
src/
├── QQBot.ts              ← 高层 facade（多数用户用这一个就够了）
├── streaming.ts          ← C2C 流式消息控制器
├── index.ts              ← 公开 API
└── protocol/             ← 协议层（HTTP / WebSocket / 类型）
    ├── api/
    │   ├── api-client.ts         HTTP 客户端
    │   ├── token.ts              access_token 管理
    │   ├── messages.ts           消息发送
    │   ├── media.ts              小文件上传
    │   ├── media-chunked.ts      大文件分块上传
    │   ├── retry.ts              重试引擎
    │   └── routes.ts             路由模板
    ├── gateway/
    │   ├── constants.ts          opcode / intent / close code
    │   ├── codec.ts              消息解码
    │   ├── reconnect.ts          重连状态机
    │   ├── event-dispatcher.ts   事件 → InboundMessage
    │   └── gateway-connection.ts WebSocket 生命周期
    ├── utils/
    │   ├── format.ts             错误/时长/文件大小格式化
    │   ├── file-utils.ts         上传相关常量 + sanitizeFileName
    │   └── upload-cache.ts       file_info TTL 缓存
    ├── types.ts                  全部公共类型 + 错误
    └── index.ts                  protocol 子入口
```

## 18. 内置示例

仓库 `examples/` 下提供 3 个可直接运行的示例：

| 路径 | 说明 |
| :--- | :--- |
| `examples/playground/` | 综合 demo：echo / stream / slow / md / file，命令行交互式切换模式 |
| `examples/middleware/` | 完整 14 层 Koa-style 中间件管线 |
| `examples/webhook/` | Webhook（HTTP 回调）传输模式 |
| `examples/send-plain-100/` | 等触发后向指定用户发一条 100 字普通文本，验证 `messages` 通道 |
| `examples/send-streaming-100/` | 等触发后以 ≈2 字/秒流式推送 100 字，验证 `stream_messages` 通道 |

> 示例代码用 `process.env.QQBOT_APP_ID` / `process.env.QQBOT_APP_SECRET` 读取凭证
> **仅是为了 demo 一键就能跑**，让你不用先写一份配置文件。
> 这不是 SDK 行为，也不是生产建议——
> SDK 自身从不读环境变量，凭证一律通过 `new QQBot({ appId, appSecret })` 传入（见 §3、§4）。

运行 playground（demo 用法，使用环境变量）：

```bash
cd qqbot-nodejs
export QQBOT_APP_ID="..."
export QQBOT_APP_SECRET="..."
pnpm playground
```

示例额外支持的环境变量（同样仅 demo 内部约定，不是 SDK 协议）：

| 变量 | 作用 |
| :--- | :--- |
| `QQBOT_DEBUG=1` | 打印 debug 日志（HTTP body / token 流转等） |
| `QQBOT_MARKDOWN=1` | 在示例中启用 `markdownSupport` |
| `QQBOT_TARGET_OPENID` | `send-*-100` 示例里只接收来自该用户的触发消息 |

---

## License

MIT
