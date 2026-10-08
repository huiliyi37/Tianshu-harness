# CTCL — Claude Tool Compatibility Layer

CTCL 是一个本地反向代理，位于 cliproxy 和上游模型 API 之间，负责对开源模型的工具调用输出进行规范化，使其兼容 Claude Code 的严格期望。

## 核心问题

开源模型（DeepSeek、Kimi、GLM、Qwen、MiniMax、MiMo）通过 Anthropic 兼容接口提供服务，但工具调用输出经常不符合 Claude Code 的格式要求。正如 AhmadAwais 的 CommandCodeAI 研究指出：

> "开源模型不擅长工具调用几乎总是 harness 的问题，而不是模型本身的问题"

CTCL 在传输层修复这些问题，无需修改模型或客户端代码。

## 位置与启动

| 项目 | 值 |
|------|------|
| 脚本路径 | `~/bin/claude-tool-compat-layer.mjs` |
| 默认端口 | `8893` |
| 监听地址 | `127.0.0.1` |
| 运行方式 | `node ~/bin/claude-tool-compat-layer.mjs [--port 8893] [--config path/to/models.json]` |

```bash
# 启动
nohup node ~/bin/claude-tool-compat-layer.mjs > /tmp/ctcl.log 2>&1 &

# 健康检查
curl http://127.0.0.1:8893/health

# 运行统计
curl http://127.0.0.1:8893/stats
```

## 架构位置

```
Claude Code → cliproxy (:8891) → CTCL (:8893) → 上游模型 API
                                        ↓
                              deepseek / mimo / kimi / glm / qwen / minimax
```

cliproxy 的 `config.yaml` 中，需要 CTCL 的 provider 将 `base-url` 指向 `http://127.0.0.1:8893/anthropic`：

```yaml
# 示例：DeepSeek Flash 通过 CTCL
- api-key: sk-xxx
  base-url: http://127.0.0.1:8893/anthropic
  models:
    - name: deepseek-flash
      alias: claude-hiku-4

# 示例：MiMo 通过 CTCL
- api-key: tp-xxx
  base-url: http://127.0.0.1:8893/anthropic
  models:
    - name: mimo-v2.5
      alias: claude-sonnet-hiku-4
    - name: mimo-v2.5-pro
      alias: claude-sonnet-4-5
```

不需要 CTCL 的 provider（如直连 Anthropic 或 GLM 官方）直接指向真实 upstream。

## 上游路由

CTCL 维护 alias → upstream 的映射表：

| Alias | Upstream | Host |
|-------|----------|------|
| `claude-sonnet-4-4`, `claude-opus-4-7`, `claude-sonnet-4-6` | mimo | `token-plan-sgp.xiaomimimo.com` |
| `claude-opus-4-3`, `claude-hiku-4` | deepseek | `api.deepseek.com` |
| `claude-sonnet-4-3` | minimax | `api.minimaxi.com` |
| `claude-sonnet-4-5` | kimi | `api.kimi.com` |
| `claude-hiku-4-5`, `claude-opus-4-5`, `claude-sonnet-3-7` | codex-claude-bridge | — |
| `glm-5.1`, `glm-4.7` | glm | `open.bigmodel.cn` |

路由优先级：alias 精确匹配 > URL 路径前缀 > 模型名关键词匹配 > default (deepseek)。

## 四骑士：工具参数修复

CTCL 的核心修复逻辑，按固定顺序执行：

### Fix 1: null → omit

Schema 允许缺省的字段，模型发送了 `null` → 移除该字段。

```json
// Before
{ "file_path": "foo.ts", "offset": null, "limit": null }
// After
{ "file_path": "foo.ts" }
```

同样处理空字符串：非必需字段发送 `""` → 省略。递归处理嵌套对象和数组。

### Fix 2: JSON 字符串 → 数组

模型输出 `'["a","b"]'`（字符串）而非 `["a","b"]`（数组）。

```json
// Before
{ "patterns": "[\"src/**/*.ts\",\"test/**/*.ts\"]" }
// After
{ "patterns": ["src/**/*.ts", "test/**/*.ts"] }
```

### Fix 3: 单对象 → 数组

Schema 期望数组，模型发送 `{ "0": "a", "1": "b" }` → 展开为数组。

### Fix 4: 裸字符串 → 数组

Schema 期望数组，模型发送 `"foo"` → 包装为 `["foo"]`。

**执行顺序很重要**：jsonArrayString 必须在 bareStringWrap 之前，否则 `'["a"]'` 会被包成 `['["a"]']`（双重包装）。

## 其他修复

### Markdown Auto-Link 泄漏

DeepSeek 有时输出 `[path](http://path)` 而非 `path`。CTCL 检测链接文本与 URL 路径匹配时提取纯文本，真实的 markdown 链接保持不变。

### stop_reason 规范化

将非法 stop_reason 修正为标准值（`end_turn` / `max_tokens` / `stop_sequence` / `tool_use`）。

### 引号规范化

修复工具名中的转义引号 `\"` → `"`。

### CCH 剥离（KV Cache 兼容）

Claude Code 在 system message 中注入 `cch=xxx` 字段，每次请求都不同，导致第三方 API 的 prefix cache 100% miss。CTCL 从 system message 中剥离该标记，恢复 ~90% cache hit rate。

参考：linux.do/t/topic/1613608 — 社区根因分析。

### forced tool_choice 降级

DeepSeek 的 Anthropic 兼容端点支持 `tool_choice: {type: 'auto'}` 和 `{type: 'any'}`，但拒绝 `{type: 'tool', name: 'xxx'}`。CTCL 自动降级为 `auto`。

### 无效工具调用抑制

流式响应中，如果工具输入无法解析为 JSON 或缺少必需参数，CTCL 将该工具调用替换为文本提示，避免 Claude Code 崩溃。

## SSE 流式处理

CTCL 对流式响应（`text/event-stream`）做完整处理：

1. 缓冲 `content_block_start`（tool_use 类型）
2. 收集 `input_json_delta` 拼接完整 JSON
3. 在 `content_block_stop` 时执行完整修复链
4. 重新发送规范的 SSE 事件

非流式请求的响应也经过同样的修复。

## 端点

| 路径 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查，返回 `{status: "ok", uptime}` |
| `/stats` | GET | 运行统计（请求数、修复计数、按模型/修复类型分组） |
| `/v1/models` | GET | 静态模型列表 stub，用于 cliproxy 发现 |
| `/anthropic/v1/messages` | POST | 代理主入口 |
| `/{provider}/anthropic/v1/messages` | POST | 带前缀路由 |

## 调试

```bash
# 启用工具流调试日志
CTCL_DEBUG_TOOL_STREAMS=1 node ~/bin/claude-tool-compat-layer.mjs

# 查看运行日志
cat /tmp/ctcl.log

# 查看实时统计
curl http://127.0.0.1:8893/stats
```

自定义上游配置：`--config path/to/models.json`，JSON 格式与 `DEFAULT_UPSTREAMS` 相同。

## 与 Rivet 的关系

Rivet 的 API 客户端层（`src/api/`）已将 CTCL 的核心能力内化：

| CTCL 功能 | Rivet 对应 |
|-----------|-----------|
| SSE 流式解析 | `src/api/sse.ts` |
| tool_use 缓冲 + schema 校验 | `src/api/tool-buffer.ts` |
| 6 种参数修复 | `src/api/tool-fix.ts` |
| forced tool_choice 降级 | `src/api/client.ts` |
| provider 路由 | `src/api/providers.ts` + `src/api/adapters/` |

CTCL 作为独立进程继续服务 cliproxy 场景（非 Rivet 的 Claude Code 使用），Rivet 则内置了等价逻辑。

## 分发

完整分发包（`ctcl-bridge-full-2026-05-17.tar.gz`）包含：

```
bin/claude-tool-compat-layer.mjs       # 主脚本
.cli-proxy-api/config.yaml             # cliproxy 配置示例
bin/log-rotator.sh                     # 日志轮转脚本
Library/LaunchAgents/com.banxia.logrotator.plist  # macOS launchd 配置
```

备份位置：`~/app/rebook/Ebook-v1.0/ctcl-bridge-full-2026-05-17.tar.gz`
