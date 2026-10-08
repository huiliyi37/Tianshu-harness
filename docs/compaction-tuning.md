# 上下文压缩调优（Compaction Tuning）

上下文压缩负责在会话变长时把历史蒸馏成摘要，避免撞上下文窗口、同时尽量保住前缀缓存。本文汇总三个面向用户/运维的调优杠杆，以及它们各自的取舍。

> 压缩的内部机制（五级阶梯、`turn===0` 边界纪律、1M 窗口跳过、provider 策略比率）见 `CLAUDE.md` 与 `src/compact/`、`src/agent/compact-boundary-coordinator.ts`。本文只讲**怎么配、何时生效、代价是什么**。

---

## 1. 把压缩路由到廉价模型（`compact.provider` + `compact.model`）

压缩是一次**一次性、无工具**的纯总结任务。用主力贵模型来做既费 token，又因为压缩请求的前缀和主对话不同而**挤掉主对话的热前缀缓存**（GLM/DeepSeek 缓存争抢卡顿的诱因之一）。把它路由到便宜模型（如 Flash，官方 ID `deepseek-flash`；旧别名 `deepseek-v4-flash` 亦兼容），用独立 provider/client = 独立服务端缓存：

```json
{
  "compact": {
    "enabled": true,
    "provider": "deepseek",
    "model": "deepseek-flash"
  }
}
```

- **必须同时设 `provider` + `model`** 才生效。只写 `model`（旧默认）不路由，压缩仍用会话主模型，向后兼容。
- **静默回退**：provider 不存在 / 模型不在该 provider 的 models 列表 / 无凭据 → 自动退回主模型，不报错（规则同 `agent.review`、议事会席位）。
- 这条只管**压缩**，与子代理/审查路由是两套独立机制，可「主控 GLM + 压缩 Flash + 子代理 Flash」三者各自配置。

完整说明见 [`user-guide-provider-config.md`](./user-guide-provider-config.md) 的「上下文压缩走廉价模型」一节。

---

## 2. 摘要不压太狠（generous 预算，自动）

一旦走专用廉价压缩模型（即上面配了 `compact.provider`），摘要输出预算自动放宽 **≈2×**（1M 窗口 8K→16K 字、partial 5K→10K）。Flash 很便宜，宁可多留决策/文件/错误等细节，也不过度压缩——多花几 KB 摘要前缀，换不丢上下文。

- 无需额外配置：检测到专用压缩 client 即自动开启 generous。
- 用主模型压缩时（未配 `compact.provider`）维持基础预算，避免在贵模型上写超长摘要。
- 实现：`summaryOutputBudgetChars(contextWindow, { generous })`（`src/compact/constants.ts`）。

---

## 3. 摘要迭代合并（无损保留旧摘要，自动）

多轮压缩若每次从头重写，容易漂移、丢早期决策。现在 `llmCompact` / `tryPartialCompact` 会扫描待压缩区是否已含上一次压缩摘要（`<compact-summary>` / `<partial-compact-summary>` / `<session-handoff>` / `<checkpoint-resume>` 标记）；命中则在压缩 prompt 加「**无损保留既有摘要全部信息，再合并新消息**」指令。

- 无需配置，检测到既有摘要自动启用。
- 目的：长会话多次压缩后，早期的关键决策/文件/错误/待办不被「重新总结」抹掉。

---

## 4. 空闲期压缩（idle compaction，默认开启）

过去压缩只在活跃 loop 的 turn 边界进行，于是下一条大消息触发全量压缩时用户会卡。现在每次 `run()` 结束后会 debounce **12s** 触发一次 **turn-0 等价**的压缩（复用完整 boundary 阶梯 + 清算被推迟的 `pendingStaleCompact` / `pendingHeapCompact`），把这次同步全量压缩的延迟挪出**下一轮关键路径**。

行为要点：

- **只是提前、不是额外**：仅在本就该压缩时动手（有 deferred 工作，或 ratio ≥ 0.5）；缓存重建在下一轮本来也会发生，净效果是把延迟挪到空闲。配了杠杆 1 的廉价压缩模型时，这些后台 LLM 调用也是廉价的。
- **绝不与活跃 turn 抢 session**：新 `run()` 开始前先取消并 await 收敛在途空闲压缩（专用 AbortController 可中断压缩 LLM 流）。
- **进程友好**：定时器 `unref`，不会因等待空闲压缩而阻止 TUI/sidecar 退出。
- sidecar `switchModel` 热切换 / `shutdown` 会取消旧 loop 的空闲定时器，避免与共享 SessionContext 的新 loop 竞态。

### 环境变量

| 变量 | 默认 | 作用 |
|------|------|------|
| `RIVET_IDLE_COMPACTION` | 开启 | 设为 `0` 关闭空闲期压缩 |
| `RIVET_IDLE_COMPACTION_MS` | `12000` | 空闲触发前的 debounce 毫秒数 |

worker 子会话（`compact.enabled: false`）天然不触发空闲压缩。

---

## 速查

| 杠杆 | 配置 | 默认 | 代价 / 取舍 |
|------|------|------|-------------|
| 压缩走廉价模型 | `compact.provider` + `compact.model` | 关（用主模型） | 省主模型 token、护主缓存；需便宜模型有凭据 |
| 放宽摘要预算 | 自动（随杠杆 1） | 随杠杆 1 | 摘要更全 vs 多几 KB 前缀 |
| 摘要迭代合并 | 自动 | 开 | 长会话不丢早期决策 |
| 空闲期压缩 | `RIVET_IDLE_COMPACTION` / `_MS` | 开 / 12s | 把全量压缩延迟挪出下一轮 |
