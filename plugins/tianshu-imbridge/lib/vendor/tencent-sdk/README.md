# @tencent-connect/qqbot-nodejs

Tencent QQ Open Platform Node.js SDK。提供与 QQ 机器人开放平台对接所需的全部
协议层能力：HTTP REST、WebSocket / Webhook 双传输、Koa-style 中间件管线、
消息收发、媒体上传（含大文件分块）、C2C 流式消息（stream_messages）。

## 安装

```bash
pnpm add @tencent-connect/qqbot-nodejs
# 或
npm install @tencent-connect/qqbot-nodejs
```

## 快速开始

```ts
import { QQBot } from "@tencent-connect/qqbot-nodejs";

const bot = new QQBot({
  appId: process.env.QQBOT_APP_ID!,
  appSecret: process.env.QQBOT_APP_SECRET!,
  logger: console,
});

bot.on("message", async (ctx, msg) => {
  // ctx — Koa-style MiddlewareContext，携带 middleware 注入的数据
  await bot.sendText(msg.replyTarget, `Echo: ${msg.content}`);
});

await bot.start();
```

参考 [examples/](./examples/) 下的完整示例：

| 示例 | 说明 |
|------|------|
| [playground](./examples/playground/) | 核心能力演示（文本、流式、媒体、命令） |
| [middleware](./examples/middleware/) | 完整 14 层 Koa-style 中间件管线 |
| [webhook](./examples/webhook/) | Webhook（HTTP 回调）传输模式 |
| [send-plain-100](./examples/send-plain-100/) | 普通文本发送对照实验 |
| [send-streaming-100](./examples/send-streaming-100/) | 流式消息发送对照实验 |

## 主要能力

### 1. 双传输模式（WebSocket / Webhook）

```ts
// WebSocket（默认）— 长连接 + 心跳 + RESUME
const bot = new QQBot({ appId, appSecret });

// Webhook — HTTP 回调，适合 Serverless / 水平扩展
const bot = new QQBot({
  appId, appSecret,
  transport: "webhook",
  webhook: { port: 8080, path: "/callback" },
});
```

两种模式下中间件、事件监听、消息发送 API 完全一致。

### 2. Koa-style 中间件

SDK 采用洋葱模型中间件，`bot.on("message")` 作为 chain 最内层 downstream：

```ts
import { errorHandler, messageFilter, contentSanitizer, mentionGate } from "@tencent-connect/qqbot-nodejs";

bot.use(errorHandler());
bot.use(messageFilter({ skipSelfEcho: true, dedup: { windowMs: 5000 } }));
bot.use(contentSanitizer({ stripBotMention: true }));
bot.use(mentionGate({ requireMentionInGroup: true }));

// 自定义中间件
bot.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  ctx.log.debug?.(`elapsed: ${Date.now() - start}ms`);
});
```

内置中间件：

| 中间件 | 说明 |
|--------|------|
| `errorHandler` | 统一错误捕获 + 友好回复 |
| `messageFilter` | 过滤 bot 回声 + 消息去重 |
| `rateLimiter` | 三层限流（sender / group / global） |
| `concurrencyGuard` | 同用户/群串行处理（防 stream 并发冲突） |
| `accessPolicy` | 黑白名单 |
| `contentSanitizer` | 去 @marker / face tags / 空白清洗 |
| `mentionGate` | 群聊 @bot 判定 |
| `quoteRef` | 消息索引记录 + 引用消息解析 |
| `historyBuffer` | 群历史缓冲 |
| `envelopeFormatter` | 组装 LLM prompt 上下文（XML tags） |
| `typingIndicator` | C2C 自动 typing |
| `slashCommand` | /cmd 命令框架 |

### 3. 文本消息

```ts
await bot.sendText(target, "hello");
```

### 4. 文件 / 图片 / 语音

`sendImage` / `sendVoice` / `sendVideo` / `sendFile` 是 `sendMedia` 的便捷封装。
当源文件 ≥ 5MB 时自动走分块上传。

```ts
await bot.sendImage(target, { localPath: "/tmp/cat.jpg" });

await bot.sendFile(
  target,
  { buffer: bigBuffer },
  {
    fileName: "report.pdf",
    onProgress: (uploaded, total) => console.log(`${uploaded}/${total}`),
  },
);
```

### 5. C2C 流式消息

```ts
const stream = bot.openStream({ target });
for (const partial of generator) {
  await stream.update(partial);
}
await stream.complete();
```

QQ 开放平台限制：`stream_messages` 仅在 C2C（私聊）开放。

### 6. 事件监听

```ts
bot.on("ready", () => console.log("connected"));
bot.on("resumed", () => console.log("reconnected"));
bot.on("error", (err) => console.error(err));
bot.on("message", (ctx, msg) => { /* C2C / Group / Guild / DM */ });
bot.on("interaction", (ctx, event) => { /* button click etc. */ });
```

### 7. 协议层直接访问

```ts
import {
  ApiClient,
  TokenManager,
  GatewayConnection,
  withRetry,
} from "@tencent-connect/qqbot-nodejs/protocol";
```

## 模块结构

```
src/
├── QQBot.ts                ← 高层 facade
├── streaming.ts            ← C2C 流式消息控制器
├── index.ts                ← 公开 API
├── middleware/              ← Koa-style 中间件
│   ├── types.ts                  中间件类型 + 洋葱执行器
│   ├── error-handler.ts          统一错误捕获
│   ├── message-filter.ts         回声过滤 + 去重
│   ├── rate-limiter.ts           三层限流
│   ├── concurrency-guard.ts     同用户/群串行处理
│   ├── access-policy.ts          黑白名单
│   ├── content-sanitizer.ts      内容清洗
│   ├── mention-gate.ts           @bot 判定
│   ├── quote-ref.ts              引用消息解析 + 消息索引
│   ├── history-buffer.ts         群历史缓冲
│   ├── envelope-formatter.ts     LLM prompt 组装
│   ├── typing-indicator.ts       typing 状态
│   └── slash-command.ts          命令框架
└── protocol/               ← 协议层
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
    ├── transport/
    │   ├── types.ts              EventTransport 接口
    │   ├── webhook.ts            Webhook 传输
    │   ├── webhook-verify.ts     Ed25519 签名验证
    │   └── webhook-server-node.ts  内置 node:http 适配器
    ├── utils/
    │   ├── format.ts             格式化工具
    │   ├── file-utils.ts         文件工具
    │   └── upload-cache.ts       file_info TTL 缓存
    ├── types.ts                  全部公共类型 + 错误
    └── index.ts                  protocol 子入口
```

## License

MIT
