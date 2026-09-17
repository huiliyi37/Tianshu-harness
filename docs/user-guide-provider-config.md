# Provider 配置用户手册

> 本文档面向最终用户，解释如何使用 Rivet（天枢）配置模型 Provider。

---

## 什么是 Provider？

Provider 是「模型接入点」——你告诉天枢从哪里调用模型、用什么认证方式、支持哪些能力。

天枢内置了以下 Provider 预设，开箱即用：

| Provider | 对应模型 | 协议 | 认证方式 | Context Window | 特点 |
|----------|----------|------|----------|----------------|------|
| `deepseek` | DeepSeek V4 Pro / Flash | OpenAI-compatible | API Key | 1M tokens | 原生前缀缓存，Cache Hit 可达 90%+ |
| `opencode-go` | DeepSeek / MiMo / GLM / Kimi 等开源模型 | OpenAI-compatible | API Key | 1M tokens | OpenCode Go 订阅服务，首月 $5，每月 $10 |
| `opencode-go-anthropic` | Qwen / MiniMax 等开源模型 | Anthropic Messages | API Key | 1M tokens | OpenCode Go 的 Anthropic 协议端点，支持 cache_control |
| `glm` | 智谱 GLM-5.3 / GLM-5.3-Flash / GLM-5.2 | OpenAI-compatible | API Key | 1M tokens | 支持 thinking |
| `mimo` | 小米 MiMo-v2.5-Pro | OpenAI-compatible | API Key | 1M tokens | 支持 thinking，prefix cache |
| `minimax` | MiniMax M3 / M2.7 | OpenAI-compatible | API Key | 204.8K tokens | 需过滤 `top_k/metadata/cache_control` 参数 |
| `codex` | GPT-5.6 (ChatGPT 订阅) | Codex Responses | OAuth PKCE | 1M tokens | 使用 ChatGPT 订阅（非 API 计费），自动 token 刷新 |

> 📌 上表 `codex` 行为**预设默认**（直连 ChatGPT OAuth）。本机实际已把 codex 改走本地
> **cliproxy 账号池**（GPT-5.5 / `claude-opus-4-5`）——配置、排障、账号池维护与自动刷新
> 见 [`docs/codex-cliproxy-account-pool.md`](./codex-cliproxy-account-pool.md)。

---

## 配置方式概览

### 方式一：TUI `/connect`（推荐首次使用）

运行：

```bash
rivet
```

首次没有可用 API Key 时，天枢先显示主界面，再自动打开 `/connect`。在该界面选择内置 Provider 或自定义 OpenAI-compatible 服务，按步骤完成认证和模型选择；配置成功后会直接切换到可用会话。

之后随时在 TUI 输入 `/connect` 添加或更新 Provider。`rivet config` 只显示脚本化配置命令帮助，不再启动 readline 交互向导。

### 方式二：命令行脚本化配置

适合 CI/CD、环境变量自动化、容器化部署等场景。

#### `rivet config setup <provider>`

按内置预设创建或更新 Provider：

```bash
# 使用环境变量配置 DeepSeek
rivet config setup deepseek --key-env DEEPSEEK_API_KEY --default

# 使用内联 Key 配置 GLM
rivet config setup glm --key sk-xxxx --default

# 配置 MiMo 并指定自定义 URL
rivet config setup mimo --key-env MIMO_API_KEY --url https://token-plan-sgp.xiaomimimo.com/v1

# 配置 MiniMax 指定模型参数
rivet config setup minimax --key-env MINIMAX_API_KEY --model MiniMax-M2.8 --alias m28 --context-window 300000 --max-tokens 64000 --default

# 配置 Codex（OAuth，无需 API Key）
rivet config setup codex --default
```

支持的 flags：

| Flag | 说明 | 示例 |
|------|------|------|
| `--key <key>` | 内联 API Key（敏感） | `--key sk-xxxx` |
| `--key-env <env>` | API Key 环境变量名 | `--key-env DEEPSEEK_API_KEY` |
| `--url <url>` | 自定义 Base URL | `--url https://api.example.com/v1` |
| `--model <id>` | 模型 ID | `--model deepseek-v4-pro` |
| `--alias <name>` | 模型别名 | `--alias v4-pro` |
| `--context-window <n>` | Context Window 大小 | `--context-window 1000000` |
| `--max-tokens <n>` | 最大输出 Tokens | `--max-tokens 163000` |
| `--default` | 同时设为默认 Provider | `--default` |

#### `rivet config set-url <provider> <url>`

重写 Provider 的 Base URL：

```bash
rivet config set-url deepseek https://api.deepseek.com/v1
rivet config set-url mimo https://token-plan-sgp.xiaomimimo.com/v1
```

#### `rivet config set-model <provider> <id> [context-window] [max-tokens] [alias]`

设置 Provider 的首选模型：

```bash
# 最小参数
rivet config set-model deepseek deepseek-v4-flash

# 完整参数
rivet config set-model minimax MiniMax-M2.8 300000 64000 m28
```

#### `rivet config set-key <provider> <key>`

直接写入 API Key（保存在 `~/.rivet/config.json`，会覆盖环境变量）：

```bash
rivet config set-key deepseek sk-xxxx
```

#### `rivet config set-key-env <provider> <env-var>`

指定 API Key 从环境变量读取（推荐，Key 不落地）：

```bash
rivet config set-key-env deepseek DEEPSEEK_API_KEY
rivet config set-key-env minimax MINIMAX_API_KEY
```

#### `rivet config set-default <provider>`

切换默认 Provider：

```bash
rivet config set-default mimo
```

#### `rivet config providers`

查看所有 Provider 及其状态：

```bash
rivet config providers
```

输出示例：

```
Providers:
  deepseek (default)
    baseUrl: https://api.deepseek.com/v1
    apiKey: env(DEEPSEEK_API_KEY)
    models: v4-pro, v4-flash
  glm
    baseUrl: https://open.bigmodel.cn/api/coding/paas/v4
    apiKey: env(ZHIPU_API_KEY)
    models: glm
  mimo
    baseUrl: https://token-plan-sgp.xiaomimimo.com/v1
    apiKey: env(MIMO_API_KEY)
    models: mimo-pro, mimo
  minimax
    baseUrl: https://api.minimaxi.com/v1
    apiKey: (not set)
    models: minimax
  codex
    baseUrl: https://chatgpt.com/backend-api/codex
    apiKey: oauth
    models: codex
```

#### `rivet config show`

打印完整配置 JSON（可用于调试）：

```bash
rivet config show | jq '.provider'
```

### 方式三：手动编辑 JSON 文件

配置文件位于 `~/.rivet/config.json`。**配置文件只需要写你想覆盖的部分**，其余使用内置默认值。

```json
{
  "provider": {
    "default": "deepseek",
    "providers": {
      "minimax": {
        "apiKeyEnv": "MINIMAX_API_KEY",
        "models": [
          {
            "id": "MiniMax-M2.7",
            "alias": "minimax",
            "contextWindow": 204800,
            "maxTokens": 64000
          }
        ]
      }
    }
  }
}
```

也可以添加自定义 Provider：

```json
{
  "provider": {
    "providers": {
      "my-openai": {
        "name": "my-openai",
        "apiKeyEnv": "MY_OPENAI_KEY",
        "baseUrl": "https://api.openai.com/v1",
        "protocol": "openai",
        "capabilities": {
          "cacheControl": false,
          "stripParams": [],
          "toolJsonBug": false,
          "prefixCache": "none",
          "prefixCompletion": false
        },
        "thinking": "enabled",
        "maxTokens": 128000,
        "models": [
          {
            "id": "gpt-4.1",
            "contextWindow": 200000,
            "maxTokens": 64000
          }
        ],
        "unsupported": []
      }
    }
  }
}
```

---

## 各 Provider 详解

### DeepSeek（默认）

**推荐场景**：通用编程任务、长会话、追求极致性价比。

DeepSeek V4 Pro 支持原生前缀缓存，在长时间对话中 Cache Hit 可达 90%+，显著降低 API 成本。

```bash
rivet config setup deepseek --key-env DEEPSEEK_API_KEY --default
```

可选模型：
- `deepseek-v4-pro`（默认）：完整 thinking，`reasoningEffort: max`
- `deepseek-v4-flash`：快速响应，`reasoningEffort: high`

> **配置参数**：上下文 1000000（1M tokens），最大输出 384000（384K tokens）。请照[官方文档](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)的真实值填写，填小了会导致推理被截断、agent 频繁停止。

### OpenCode Go（开源模型订阅服务）

**推荐场景**：一站式接入多个开源编程模型，无需分别申请各厂商 API Key。

OpenCode Go 是 [OpenCode](https://opencode.ai) 提供的低成本订阅服务（首月 $5，之后每月 $10），提供经过测试和基准评估的开源编程模型的稳定访问。模型托管在美国、欧盟和新加坡。

#### 预设（推荐）

CLI 与桌面端都已内置两个预设，无需手写配置：

```bash
rivet config setup opencode-go --key sk-xxxx --default          # OpenAI 协议（DeepSeek/GLM/Kimi/MiMo）
rivet config setup opencode-go-anthropic --key sk-xxxx          # Anthropic 协议（Qwen/MiniMax）
```

桌面端在「服务商」页的未配置预设卡片里同样能找到这两项。

#### 上游强制的请求头（天枢自动注入）

OpenCode Go 要求客户端表明自身身份，否则请求会被拒：

| 要求 | 天枢的实现 |
|------|-----------|
| 不得使用通用 SDK / HTTP 库名作为 UA | 统一发送 `tianshu-tui/<version>` |
| 每次对话在 `x-opencode-session` 中带稳定会话 ID | 会话 ID 自动注入；缺会话上下文的内部调用（goal 判定、headless 委派）使用进程级稳定 ID |

**缺失 `x-opencode-session` 会直接失败**（实测，2026-09）：

```
HTTP 400 {"type":"error","error":{"type":"MissingSessionID",
  "message":"...Request is missing x-opencode-session and cannot be routed efficiently..."}}
```

该头对 `/v1/chat/completions` 与 `/v1/messages` 两个端点都强制要求。注入按 baseUrl host 判定（`opencode.ai` 及其子域），因此无论 Provider 条目叫什么名字都能生效——包括手工配置的 `name: "anthropic"` 形态。

#### 两个 Provider 条目

由于 OpenCode Go 的不同模型使用不同 API 协议，天枢需要配置两个 Provider 条目：

| Provider Key | 协议 | 端点 | 适用模型 |
|--------------|------|------|----------|
| `opencode-go` | OpenAI Chat Completions | `/v1/chat/completions` | DeepSeek V4 Pro/Flash, MiMo-V2.5/V2.5-Pro, GLM-5.2, Kimi K2.5/K2.6 |
| `opencode-go-anthropic` | Anthropic Messages | `/v1/messages` | Qwen3.5/3.6/3.7, MiniMax M2.5/M2.7 |

> **注意**：手工配置时 `name` 可设为 `"anthropic"`（schema 会据此默认 `protocol: "anthropic"`），也可自行命名并显式写 `protocol: "anthropic"`。两种方式都会路由到 `/v1/messages`；内置预设采用后者。

#### 配置方法

**方式一：交互式向导**

```bash
rivet config setup opencode-go --key sk-xxxx --default
```

**方式二：手动编辑 `~/.rivet/config.json`**

```json
{
  "provider": {
    "default": "opencode-go",
    "providers": {
      "opencode-go": {
        "name": "opencode-go",
        "apiKey": "sk-xxxx",
        "baseUrl": "https://opencode.ai/zen/go/v1",
        "protocol": "openai",
        "capabilities": {
          "cacheControl": false,
          "stripParams": ["top_k", "metadata", "service_tier", "cache_control"],
          "prefixCache": "none"
        },
        "thinking": "enabled",
        "maxTokens": 64000,
        "models": [
          { "id": "deepseek-v4-pro", "alias": "go-ds4p", "contextWindow": 1000000, "maxTokens": 64000, "reasoningEffort": "max" },
          { "id": "deepseek-v4-flash", "alias": "go-ds4f", "contextWindow": 1000000, "maxTokens": 64000, "reasoningEffort": "high" },
          { "id": "mimo-v2.5-pro", "alias": "go-mimo", "contextWindow": 1000000, "maxTokens": 64000, "reasoningEffort": "max" },
          { "id": "glm-5.2", "alias": "go-glm", "contextWindow": 1000000, "maxTokens": 64000, "reasoningEffort": "high" },
          { "id": "kimi-k2.6", "alias": "go-kimi", "contextWindow": 1000000, "maxTokens": 64000, "reasoningEffort": "high" }
        ],
        "unsupported": ["stream_options"]
      },
      "opencode-go-anthropic": {
        "name": "anthropic",
        "apiKey": "sk-xxxx",
        "baseUrl": "https://opencode.ai/zen/go/v1",
        "protocol": "openai",
        "capabilities": {
          "cacheControl": true,
          "stripParams": [],
          "prefixCache": "anthropic-cache-control"
        },
        "thinking": "enabled",
        "maxTokens": 64000,
        "models": [
          { "id": "qwen3.7-max", "alias": "go-qwen", "contextWindow": 1000000, "maxTokens": 64000, "reasoningEffort": "high" },
          { "id": "qwen3.6-plus", "alias": "go-qwen36", "contextWindow": 1000000, "maxTokens": 64000, "reasoningEffort": "high" },
          { "id": "minimax-m2.7", "alias": "go-mm27", "contextWindow": 204800, "maxTokens": 64000 },
          { "id": "minimax-m2.5", "alias": "go-mm25", "contextWindow": 204800, "maxTokens": 64000 }
        ],
        "unsupported": []
      }
    }
  }
}
```

#### 使用限制

| 周期 | 额度 |
|------|------|
| 每 5 小时 | $12 |
| 每周 | $30 |
| 每月 | $60 |

额度以美元计价，不同模型消耗不同（如 MiMo-V2.5 便宜，允许更多请求；GLM-5.1 较贵，允许较少请求）。

#### 当前可用模型（2026-06）

| 模型 | 协议 | 模型 ID |
|------|------|---------|
| DeepSeek V4 Pro | OpenAI | `deepseek-v4-pro` |
| DeepSeek V4 Flash | OpenAI | `deepseek-v4-flash` |
| MiMo-V2.5 | OpenAI | `mimo-v2.5` |
| MiMo-V2.5-Pro | OpenAI | `mimo-v2.5-pro` |
| GLM-5.2 | OpenAI | `glm-5.2` |
| Kimi K2.5 | OpenAI | `kimi-k2.5` |
| Kimi K2.6 | OpenAI | `kimi-k2.6` |
| Qwen3.7 Max | Anthropic | `qwen3.7-max` |
| Qwen3.6 Plus | Anthropic | `qwen3.6-plus` |
| Qwen3.5 Plus | Anthropic | `qwen3.5-plus` |
| MiniMax M2.7 | Anthropic | `minimax-m2.7` |
| MiniMax M2.5 | Anthropic | `minimax-m2.5` |

完整模型列表可通过 API 查询：

```bash
curl https://opencode.ai/zen/go/v1/models \
  -H "Authorization: Bearer $OPENCODE_GO_KEY"
```

#### 验证连通性

```bash
# OpenAI 协议模型
curl https://opencode.ai/zen/go/v1/chat/completions \
  -H "Authorization: Bearer $OPENCODE_GO_KEY" \
  -H "Content-Type: application/json" \
  -H "User-Agent: my-coding-agent/1.0" \
  -H "x-opencode-session: local-probe-1" \
  -d '{"model":"deepseek-v4-pro","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'

# Anthropic 协议模型
curl https://opencode.ai/zen/go/v1/messages \
  -H "x-api-key: $OPENCODE_GO_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -H "User-Agent: my-coding-agent/1.0" \
  -H "x-opencode-session: local-probe-1" \
  -d '{"model":"qwen3.7-max","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
```

#### 路由原理

天枢的 `factory.ts` 按 Provider 配置的 `protocol` 字段决定使用哪个 HTTP Client：

- `protocol: 'openai'` → `OpenAIClient` → 请求 `/v1/chat/completions`
- `protocol: 'anthropic'` → `AnthropicClient` → 请求 `/v1/messages`

预设 `opencode-go-anthropic` 显式写了 `protocol: "anthropic"`。手工配置时把 `name` 设为 `"anthropic"` 同样有效（schema 对名为 anthropic 的条目默认 protocol 为 anthropic），但显式 `protocol` 字段更不容易误配。

---

### GLM（智谱）

**推荐场景**：需要中文理解强化的任务。

```bash
rivet config setup glm --key-env ZHIPU_API_KEY
```

可选模型：
- `glm-5.3`：文本旗舰，1M 上下文 / 128K 输出（Coding Plan 已上线）
- `glm-5.3-flash`：原生多模态，1M 上下文（视觉 Coding）
- `glm-5.2`（默认）：1M 上下文，视觉支持

注意：GLM 不支持 `stream_options` 参数，配置中会自动添加 `unsupported: ["stream_options"]`。

### MiMo（小米）

**推荐场景**：需要超长 Context（1M tokens）且追求 prefix cache 的任务。

```bash
rivet config setup mimo --key-env MIMO_API_KEY --default
```

小米 MiMo 支持类似 DeepSeek 的前缀缓存策略 `prefixCache: deepseek-native`。

### MiniMax

**推荐场景**：MiniMax 自有模型接入。

```bash
rivet config setup minimax --key-env MINIMAX_API_KEY
```

注意：MiniMax 需要过滤 `top_k`、`metadata`、`service_tier`、`cache_control` 参数，配置中已自动处理。

### Codex（GPT-5.6 via ChatGPT 订阅）

**推荐场景**：已订阅 ChatGPT Plus，想用 GPT-5.6 而不想额外付费。

**不需要 API Key**，使用 OAuth PKCE 认证：

```bash
rivet config setup codex --default
rivet config login codex   # 打开浏览器完成 OAuth 授权（TUI 会话内则用 /login）
```

认证流程：
1. `rivet config setup codex` 写入预设配置；`rivet config login codex`（或 TUI 内 `/login`）打开浏览器授权
2. 完成 ChatGPT OAuth 登录
3. Token 自动保存到 `~/.rivet/auth/codex.json`
4. 每 55 分钟自动刷新 Token

---

## 重试与速率限制

天枢对可重试的 API 错误（限流、超时、网络抖动、服务端 5xx）自动重试。默认策略开箱可用；
`provider.providers.<name>` 下的 `retry` 块用于按服务商精调——**全部可选，未配置时行为与默认完全一致**。

### 默认重试策略（按错误类别）

| 错误类别 | 触发 | 默认重试次数 | 默认等待 |
|---|---|---|---|
| `rate_limit` | HTTP 429 | 5 | 2000ms |
| `overloaded` | 529 / 503 / 425 / 文案匹配 | 3 | 3000ms |
| `server_error` | 500 / 502 / 其他 5xx | 3 | 2000ms |
| `timeout` | 408 / ETIMEDOUT / ECONNRESET / EPIPE 等 | 3 | 2000–3000ms |
| `stream_parse` | SSE 解析失败 | 2 | 1000ms |
| `unknown` | 兜底 | 2 | 2000ms |
| `image_strip` | 413 / 图片处理失败 | 1（只剥离一次） | 0 |
| `auth_error` / `client_error` / `context_overflow` | 401/403/404/其他 4xx | 0（不重试） | — |

未配置时的等待 = 上表固定值 + 0–50% 抖动；服务端返回 `Retry-After` 响应头时以服务端为准
（固定 + 抖动，不做指数放大）。

### 配置示例

```json
{
  "provider": {
    "providers": {
      "deepseek": {
        "maxRetries": 8,
        "retry": {
          "maxTotalDurationMs": 600000,
          "backoff": { "baseDelayMs": 1000, "maxDelayMs": 10000, "jitterRatio": 0.3 },
          "overrides": { "rate_limit": { "maxRetries": 8, "retryDelayMs": 5000 } },
          "rateLimit": { "requestsPerSecond": 5, "burst": 10 }
        }
      }
    }
  }
}
```

### 字段说明

**`retry.maxTotalDurationMs`** — 单次请求（含全部重试）的总时长预算。默认 glm 20 分钟、其余服务商 10 分钟。

**`retry.backoff`** — 一旦配置，**所有可重试类别**改用统一的指数退避曲线：
`等待 = min(base × 2^(第几次重试−1), maxDelayMs) + 抖动`，其中 base 取该类别自己的等待基准
（`overrides.<类别>.retryDelayMs`，未设置则用分类器默认值），抖动 = `random() × jitterRatio × 等待上限`。
- `baseDelayMs`：仅当类别没有自己的基准（如 image_strip 的 0）时作为兜底起点，默认 1000
- `maxDelayMs`：单次等待封顶，默认 30000
- `jitterRatio`：抖动比例 0–2，默认 0.5

**`retry.overrides.<类别>`** — 按错误类别覆盖（类别名拼错会在加载配置时直接报错，不会静默失效）：
- `maxRetries`：该类别的重试上限（0–20）。**显式值不再被该类别默认值向下夹取**——想把 429 从 5 次调到 8 次，写这里即可
- `retryDelayMs`：该类别的等待基准（ms）。配置了 `backoff` 时，它是指数退避的起点

**`retry.rateLimit`** — 客户端令牌桶限速（默认关闭）。适合免费额度 / 共享配额的廉价服务商被多个 worker 同时打满的场景：
- `requestsPerSecond`：稳态速率
- `burst`：瞬时突发额度，默认 = ceil(requestsPerSecond)

同一进程内**同 provider 的所有请求共享一只桶**（含 subagent / team wave 派发的请求）；
worker 是独立进程、各有自己的桶，跨进程限速不在覆盖范围。

### 与 `maxRetries` 的关系

`provider.providers.<name>.maxRetries`（0–20，TUI `/connect`「高级设置」中可调）是**全局上限**：

| 配置组合 | 生效的重试上限 |
|---|---|
| 只设 `maxRetries` | 所有类别都用它（类别默认值被覆盖） |
| 只设 `retry.overrides.<类别>.maxRetries` | 用类别值 |
| 两者都设 | 取两者较小值 |
| 都不设 | 上表的类别默认值（默认行为） |

> 历史提示：在 `retry` 块出现之前，`maxRetries` 会被类别默认值（如 429 的 5）向下夹取——
> 把它从 10 调到 20 对 429 并不生效。该问题已修复。

---

## 配置优先级

天枢使用四层配置合并，**高优先级覆盖低优先级**：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1（最高） | 命令行 `--provider` / `--model` | 临时覆盖，不保存 |
| 2 | 项目配置 `.rivet-config.json` | 项目级别覆盖，在当前目录及父目录查找 |
| 3 | 用户配置 `~/.rivet/config.json` | 个人配置，通过 CLI 或手动编辑 |
| 4（最低） | 内置默认值 | `src/config/provider-presets.ts`，不可修改 |

例如：在项目目录创建 `.rivet-config.json` 可以让项目使用不同的默认模型，而不影响其他项目。

---

## 环境变量

每个 Provider 的 API Key 可以通过对应的环境变量提供：

| Provider | 环境变量 |
|----------|----------|
| deepseek | `DEEPSEEK_API_KEY` |
| opencode-go | `OPENCODE_GO_KEY` |
| opencode-go-anthropic | `OPENCODE_GO_KEY` |
| glm | `ZHIPU_API_KEY` |
| mimo | `MIMO_API_KEY` |
| minimax | `MINIMAX_API_KEY` |
| claude | `CLAUDE_API_KEY` |
| kimi | `KIMI_API_KEY` |

如果使用 `--key-env` 配置，系统会在运行时从环境变量读取 Key，而不是从配置文件读取。这样 Key 不会写入磁盘，更安全。

---

## 常见问题

### Q: 提示 "Provider not found"

确保 Provider 名称拼写正确，或使用 `rivet config providers` 查看可用 Provider 列表。如果是自己添加的 Provider，需要先通过 `setup` 或配置文件创建。

### Q: API Key 认证失败

1. 检查 Key 是否正确（环境变量是否设置、内联 Key 是否完整）
2. 检查 Base URL 是否正确（特别是使用代理或自定义端点时）
3. 使用 `rivet config show` 查看实际使用的配置
4. 测试 Key 是否有效：`curl -H "Authorization: Bearer $DEEPSEEK_API_KEY" https://api.deepseek.com/v1/models`

### Q: Codex OAuth Token 过期

Token 每 55 分钟自动刷新。如果长时间未使用导致过期，重新运行即可：

```bash
rivet --provider codex
```

浏览器会弹出重新授权。

### Q: 如何切换 Provider？

在 TUI 中使用 `/model <name>` 命令切换模型：

```bash
/model v4-pro      # 切换到 DeepSeek V4 Pro
/model glm         # 切换到 GLM
/model codex        # 切换到 Codex
/model list        # 查看所有可用模型
```

或启动时指定：

```bash
rivet --provider mimo --model mimo-v2.5-pro
```

### Q: 如何完全重置配置？

删除用户配置文件，天枢将恢复使用内置默认值：

```bash
rm ~/.rivet/config.json ~/.rivet/secrets.json ~/.rivet/provider-keys.json
rivet config providers  # 应该只显示内置 Provider
```

三个文件缺一不可：`config.json` 是 provider / 模型 / `keyRef` 指针；`secrets.json` 是 `keyRef → 明文密钥`（0600 权限）；`provider-keys.json` 是多 key 池（每个 key 的模型归属与凭据槽）。**只删 `config.json` 会留下密钥材料**——下次重新 `--connect` 同名 provider 时可能命中旧密钥，表现为「刚配的新 key 却被忽略」。

同理，**备份或迁移到新机器时这三个文件要一起带走**；只备份 `config.json` 的典型症状是「配置都在，但每个 provider 都 401」（指针带过去了，明文没带）。多 key 池为什么单独成文件、为什么不放在 `config.json` 里，见 [故障排查 · API key / 认证失败](guides/troubleshooting.md#3-api-key--认证失败)。

---

## 配置示例

### 最小配置（仅 API Key）

```json
{
  "provider": {
    "default": "deepseek",
    "providers": {
      "deepseek": {
        "apiKeyEnv": "DEEPSEEK_API_KEY"
      }
    }
  }
}
```

### 多 Provider 配置

```json
{
  "provider": {
    "default": "deepseek",
    "providers": {
      "deepseek": {
        "apiKeyEnv": "DEEPSEEK_API_KEY"
      },
      "minimax": {
        "apiKeyEnv": "MINIMAX_API_KEY"
      },
      "codex": {}
    }
  }
}
```

### 自定义模型配置

```json
{
  "provider": {
    "providers": {
      "deepseek": {
        "apiKeyEnv": "DEEPSEEK_API_KEY",
        "models": [
          {
            "id": "deepseek-v4-pro",
            "alias": "v4-pro",
            "contextWindow": 1000000,
            "maxTokens": 163000,
            "reasoningEffort": "max"
          },
          {
            "id": "deepseek-v4-flash",
            "alias": "v4-flash",
            "contextWindow": 1000000,
            "maxTokens": 163000,
            "reasoningEffort": "high"
          },
          {
            "id": "deepseek-coder",
            "alias": "coder",
            "contextWindow": 1000000,
            "maxTokens": 8192,
            "reasoningEffort": "medium"
          }
        ]
      }
    }
  }
}
```

---

## 子代理 / 审查模型路由

主会话和子代理（review worker、探索 worker、补丁 worker 等）可以用**不同的 provider + model**。最典型的用途：主会话用重型模型（GLM-5.2 / DeepSeek Pro），子代理用便宜快的 Flash。

> **为什么要分开路由**：GLM / Kimi / Codex 这类 `prefixCache: "none"` 的 provider 没有 Rivet 侧前缀缓存，缓存完全依赖服务端隐式匹配。当子代理用**同一个 provider + 同一个 API Key** 发请求时，它不同的 prompt 会淘汰主会话的服务端缓存，导致主会话下一轮 `cacheRead` 归零、整段重算（提交后审查阶段尤其明显，表现为长时间卡在「提交后审查启动中」）。把子代理路由到**另一个 provider** 即可让它的缓存足迹和主会话彻底解耦。

有两套独立的配置块，按用途选：

| 配置块 | 作用对象 | 路由键 | 跨 provider |
|--------|----------|--------|:-----------:|
| `agent.review` | deliver_task 提交后审查 + 各级 review/verify/patch worker | worker profile 名（`reviewer` 等） | ✅ |
| `workers` | 通用能力任务子代理（探索/编辑/诊断/重构等） | 能力任务名（`code_edit` 等） | ✅ |

两者都遵循同一条**静默回退规则**：如果配置的 provider 不在 `provider.providers` 里、或 model 不在该 provider 的 `models` 列表里、或该 provider 的 API Key 解析不到，则该项**静默回退到主会话模型**（不会报错）。配 `RIVET_DEBUG=1` 启动可在日志看到 `[review-override]` / `[worker-model]` 的路由命中或跳过原因。

### `agent.review` —— 审查 worker 模型路由

```json
{
  "agent": {
    "review": {
      "profiles": {
        "reviewer":             { "provider": "deepseek", "model": "deepseek-v4-flash" },
        "adversarial_verifier": { "provider": "deepseek", "model": "deepseek-v4-flash" },
        "verifier":             { "provider": "deepseek", "model": "deepseek-v4-flash" },
        "patcher":              { "provider": "deepseek", "model": "deepseek-v4-flash" }
      },
      "skipAuto": true,
      "mechanicalFastPath": true
    }
  }
}
```

- **`profiles`**：按 worker profile 名指定 `{ provider, model }`，命中**所有携带该 profile 的子代理**（不止提交后审查——见下文「council / team 覆盖」）。提交后自动审查（`deliver_task` commit）实际用的是 **`reviewer`** 这个 profile，所以只想让提交审查走 Flash，配 `reviewer` 一项即可；要把对抗验证（L2）、补丁建议也一并下放就把 `adversarial_verifier` / `verifier` / `patcher` 也配上。
  - **键名不做注册表校验**：profile 名是自由字符串，写错（如把 `reviewer` 拼成 `reviewr`）**不会报错，也不会回退**——只是永远匹配不到任何 worker，等于**静默失效**。常用的有效 profile：`reviewer` / `adversarial_verifier` / `verifier` / `patcher` / `council_expert` / `code_scout` / `doc_scout`。配 `RIVET_DEBUG=1` 可在日志看 `[review-override] active` / `[worker-model] review-override` 确认是否真的命中。
- **`skipAuto`**（默认 `true`）：关闭 `deliver_task` 的提交后自动审查（等价于环境变量 `RIVET_REVIEW_DISCIPLINE=0`，但限本配置文件）。**开箱默认即关闭**——审查靠用户手动 `/review [max]` 或外部会话；想恢复自动审查设为 `false`。
- **`mechanicalFastPath`**（默认 `true`）：纯文档 / 纯重命名变更跳过审查 worker 和未验证 RED 闸门。

### `workers` —— 通用子代理能力路由

`workers` 是顶层配置块（不在 `agent` 下）。它分两步：先在 `profiles` 里定义命名档位 → `{ provider, model }`，再在 `routing` 里把**能力任务**映射到档位名。

```json
{
  "workers": {
    "profiles": {
      "cheap-flash": { "provider": "deepseek", "model": "deepseek-v4-flash" },
      "capable":     { "provider": "deepseek", "model": "deepseek-v4-pro" }
    },
    "routing": {
      "repo_summarization":     "cheap-flash",
      "code_edit":              "cheap-flash",
      "test_failure_diagnosis": "cheap-flash",
      "risky_refactor":         "cheap-flash"
    }
  }
}
```

- **`routing` 的键**只能是这 5 个能力任务：`repo_summarization`、`code_edit`、`test_failure_diagnosis`、`compaction`、`risky_refactor`。值是 `profiles` 里的档位名。
- **`routing` 的值**必须是 `workers.profiles` 里已定义的档位名。内置默认已经把上面 4 个任务都指向 `cheap-flash`（即 DeepSeek Flash），所以**主会话用 DeepSeek 时，子代理默认就已经在用 Flash 了**——通常无需额外配置；只有改用别的档位（如自定义 provider）时才需要覆盖。
- 内置档位：`cheap`(MiniMax) / `cheap-flash`(DeepSeek Flash) / `capable`(DeepSeek Pro) / `mimo` / `mimo-pro` / `mimo-ultra`，可直接引用或在 `profiles` 里覆盖。

### council 议事会 / team 编队的覆盖

`council_convene`（议事会）和 `team_orchestrate` / team_max（编队）派出的子代理,和上面两套配置**走完全相同的派发链**（`coordinator.delegateBatch → runtimeFactory`）,所以路由配置对它们**自动生效**,跨 provider 缓存隔离一样适用——「GLM 主控 + Flash 子代理」无需为它们额外操作。

两条路由键如何落到 council/team 的每个 worker（`order.kind` 经 `mapWorkOrderKindToCapabilityTask` 映射为能力任务）：

| 调用方 | `order.kind` | `workers.routing` 键（能力任务） | `agent.review.profiles` 键（profile） |
|--------|--------------|--------------------------------|--------------------------------------|
| 议事会席位 | `plan` | `code_edit` | `council_expert` |
| team 规划扇出 | `plan` | `code_edit` | （planner） |
| team 编码 | `patch_proposal` | `risky_refactor` | `patcher` |
| team 审查 | `review` | `risky_refactor` | `reviewer` |
| team 验证 | `verify` | `test_failure_diagnosis` | `adversarial_verifier` |
| team 侦察 | `code_search` | `repo_summarization` | `code_scout` / `doc_scout` |

**优先级**：`agent.review.profiles[profile]` > `workers.routing[task]` > 内置启发式。即 profile 覆盖会盖过任务路由。

两个务必知道的点：

1. **路由按任务 / profile,不区分调用方。** `agent.review.profiles["patcher"]` 会**同时**影响 `deliver_task` 审查和 team 编码（都是 `patcher`）；`workers.routing["code_edit"]` 会**同时**影响议事会席位和 team 规划。无法只改其中一方——要单独控制某一类,用它**独有**的 profile 键（议事会用 `council_expert`,侦察用 `code_scout` / `doc_scout`）。
2. **议事会的 tier 护栏不绑定真实派发。** 议事会内部 `routeCouncilSeat` 的「天府席位强制 strong」等护栏只写遥测,**不影响实际选型**。因此若你把 `workers.routing["code_edit"]` 指向 Flash 省缓存,**议事会席位也会一起掉到 Flash**。要「议事会保持强模型、其余子代理走 Flash」,就用 profile 覆盖（它优先级更高）：

```json
{
  "workers": { "routing": { "code_edit": "cheap-flash" } },
  "agent": { "review": { "profiles": {
    "council_expert": { "provider": "deepseek", "model": "deepseek-v4-pro" }
  } } }
}
```

> 桌面端「集成 → 子代理 / 审查模型路由」面板的「按 profile 覆盖子代理模型」一节已列出 `council_expert` / `code_scout` / `doc_scout`,上述配方可直接在 UI 完成,无需手改 JSON。

### 异构议事会：每个席位用不同的强模型（一人一席）

`council_expert` 这个 profile 覆盖是**全席统一**的——所有席位都拿同一个模型。如果你想要「天权席位用 DeepSeek Pro、天府席位用 GLM」这种**跨模型议事会**（不同模型 = 不同视角,议事质量更高,且各跑各的服务端缓存、互不挤兑),用 **`agent.council.seats`** 给每个席位单独指定 `provider` + `model`：

```json
{
  "agent": {
    "council": {
      "seats": [
        { "authority": "tianquan", "charter": "架构与正确性", "provider": "deepseek", "model": "deepseek-v4-pro" },
        { "authority": "tianfu",   "charter": "风险与边界",   "provider": "glm",      "model": "glm-4.6" },
        { "authority": "tianxuan", "charter": "实现可行性",   "provider": "deepseek", "model": "deepseek-v4-pro" }
      ]
    }
  }
}
```

要点：

- **provider 必须在 `provider.providers` 里存在,model 必须在该 provider 的 `models` 列表里**;凭据缺失或拼错时该席位**静默回退会话模型**(和其它路由层规则一致,`RIVET_DEBUG=1` 看 `[worker-model] modelOverride` 日志确认是否命中)。
- **`provider` 与 `model` 必须成对**——只写一个视为未配置,该席位走默认路由。
- **优先级最高**:`agent.council.seats[].provider/model` > `agent.review.profiles["council_expert"]` > `workers.routing["code_edit"]` > 内置启发式。所以一旦给席位配了 provider/model,上面那套全席统一的 `council_expert` 覆盖对该席位不再生效。
- **席位数即并行 worker 数**:配 3 个席位就并发派 3 个子代理,各自独立 provider/model/缓存。
- **`authority` 必须是星域 id**(内置 10 个:`tianshu` / `pojun` / `tianfu` / `tianliang` / `tianquan` / `tianji` / `tianxuan` / `fu` / `wenqu` / `yaoguang`,或已加载的自定义域)。非星域 authority 会让该席位**无工具(fail-closed)且无认知注入**,席位形同失明——务必从建议列表里选。
- **每席 `authority` 不可重复**。议事会按 authority 绑定结果,重复会导致丢席 + 重复计票,`council_convene` 会直接报错拒绝(fail-loud)。要「同一视角对比两个模型」目前不支持,请用不同星域。

### 上下文压缩走廉价模型（`compact.provider` + `compact.model`）

上下文压缩（把变长的历史蒸馏成摘要）本身是一次**一次性、无工具**的纯总结任务，没必要用主力贵模型来做——而且压缩请求和主对话的前缀不同，在主 provider 上跑还会**挤掉主对话的热前缀缓存**（GLM/DeepSeek 缓存争抢卡顿的诱因之一）。把它路由到一个便宜模型（如 Flash），用独立 provider/client = 独立服务端缓存，既省钱又不碰主缓存：

```json
{
  "compact": {
    "enabled": true,
    "provider": "deepseek",
    "model": "deepseek-v4-flash"
  }
}
```

- **必须同时设 `provider` + `model`** 才生效。只写 `model`（旧默认行为）不会路由——压缩仍用会话主模型，保持向后兼容。
- **静默回退**：`provider` 不存在 / 模型不在该 provider 的 models 列表 / 无凭据 → 自动退回主模型，不报错（和 `agent.review`、议事会席位同一套规则）。
- **不会压得太狠**：一旦走专用廉价压缩模型，摘要输出预算自动放宽（≈2×），优先保留决策/文件/错误等细节而非过度压缩——Flash 很便宜，多花几 KB 摘要比丢上下文划算。
- 这条只管**压缩**，和上面的子代理/审查路由是两套独立机制；可以「主控 GLM + 压缩 Flash + 子代理 Flash」三者各自配置、互不影响。

> 压缩还有几个**自动生效**的相关行为（专用压缩模型时放宽摘要预算、摘要迭代无损合并、空闲期提前压缩），以及空闲压缩的开关环境变量，详见 [`compaction-tuning.md`](./compaction-tuning.md)。

### 完整示例：主会话 GLM，子代理全部走 DeepSeek Flash

仓库根目录的 [`config.example.json`](../config.example.json) 就是这个场景的可直接复制模板：主会话 GLM-5.2，提交后审查、team 侦察和通用子代理任务都路由到 DeepSeek Flash，从而不再竞争 GLM 的服务端缓存；同时把 `council_expert` 单独留在 DeepSeek Pro，演示「议事会保强、其余走 Flash」的 profile 覆盖配方。复制到 `~/.rivet/config.json`，确保 `ZHIPU_API_KEY` 和 `DEEPSEEK_API_KEY` 两个环境变量都已设置即可。

---

## 生图（文生图）

注册一个 OpenAI 形态的文生图端点（SiliconFlow / OpenAI Images 等），agent 即可用 `generate_image` 工具出图。

- **独立用途槽 `agent.imageGenModel`**——`provider.default` 与 `agent.defaultModel` **完全不动**，前缀缓存锚定不受影响。未配置时工具根本不进工具表，对不启用该功能的用户零影响。
- **只回路径、不回字节**：图片落盘后只把本地文件路径写回对话，**base64 绝不进上下文**（返回类型里就没有 base64 字符串），也绝不进错误文案。
- **桌面端**：设置 → 生图模型——端点注册、**真实出图真测**（会消耗一次生成额度）、已注册生图模型的下拉快选。**注册后当前会话即时生效**，不必新开会话。
- 尺寸字段名可配（OpenAI 发 `size`、SiliconFlow 发 `image_size`），常见响应形状自动适配；ComfyUI 原生 API 暂不支持（它是「提交 workflow → 轮询 history → 取 `/view`」三步链路，需先在本机装 OpenAI 兼容桥接插件）。

配置示例（`~/.rivet/config.json`）：

```jsonc
{
  "agent": {
    "imageGenModel": {
      "provider": "siliconflow-image",  // 独立注册的 provider，不影响 provider.default
      "model": "black-forest-labs/FLUX.2-pro",
      "size": "1024x1024",              // 默认尺寸（可选）
      "sizeField": "image_size"         // OpenAI 发 size，SiliconFlow 发 image_size（可选）
    }
  }
}
```

## 调试

查看完整配置：

```bash
rivet config show | jq
```

查看 Provider 详情：

```bash
rivet config providers
```

测试 Provider 连接（用 curl）：

```bash
# DeepSeek
curl https://api.deepseek.com/v1/models \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY"

# GLM
curl https://open.bigmodel.cn/api/coding/paas/v4/models \
  -H "Authorization: Bearer $ZHIPU_API_KEY"
```

---

## 参考链接

- 实现计划：[Provider 配置模式优化实现计划](./plans/2026-05-28-设计一下我们模型接入的provider的模式配置优化-比如初始化的时候-输入-r.md)
- Provider 预设源码：src/config/provider-presets.ts
- 配置管理器：src/config/manager.ts
- TUI Provider 接入流程：src/tui/connect-flow.ts
- Provider 探测：src/api/provider-probe.ts