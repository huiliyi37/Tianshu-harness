# 天枢 (Tianshu) / Rivet

Terminal coding agent optimized for DeepSeek V4 prefix cache. Node.js 24+ (`engines` pins 24.18.0) / TypeScript strict / 纯 ANSI 终端 UI（`src/tui/engine/`，零 React/Ink 渲染） / node:test。桌面端 `desktop/`（Tauri + React，闭源）与 VS Code/Cursor 插件 `vscode-extension/`（开源，随 sync 进公开仓）均经 `src/server/` sidecar 驱动同一内核。CLI 命令仍为 `rivet`。插件打包/发布见 `docs/VSCODE-EXTENSION-RELEASE.md`。

顶层索引与运行时排查：[`AGENTS.md`](./AGENTS.md)。架构总览：[`docs/architecture-overview.md`](./docs/architecture-overview.md)。

## Build & Test

```bash
npm install && npm run build
npm test          # ~1,133 test files / ~13,000 cases, node:test + node:assert/strict (runner: scripts/run-node-tests.ts，分批 spawn，末尾 tests 行只是最后一批)
npm run typecheck # 跨进程闸门：并发会话检查同一份源码时只跑一次，其余复用（秒回 = 命中缓存，不是没跑）
                  # 指纹 = git HEAD + 脏文件内容 hash；逃生口 typecheck:direct 或 RIVET_TYPECHECK_SHARE=0
```

## Architecture

```
main.ts → AgentLoop (agent/loop.ts)
  ├── RuntimeHookPipeline (agent/runtime-hooks.ts)  ← TUI 2.x 核心
  │     纯分阶段执行器 + 错误隔离（任一 hook 抛错只走 onError，不中断 turn）
  │     5 阶段真实调用点（非概念，已钉在 loop 主路径）：
  │       preTurn / afterPerception → turn-perception.ts
  │       postTool                  → tool-execution.ts（每个工具执行后）
  │       runCompaction             → turn-orchestrator.ts（postTool 后、postTurn 前）
  │       postTurn                  → turn-completion.ts
  │       postSession               → loop.ts（经 turn-orchestrator 调度）
  │     hooks 由 createDefaultRuntimeHooks() 条件装配（create-runtime-hooks.ts），
  │       60+ 模块（src/agent/hooks/），按 deps/开关 gated。默认会话实际激活 ~18+：
  │       常驻 8（base 数组无条件）：perception, signal-consumer, kick,
  │               vigor×2(afterPerception+postTool), theta, stigmergy, radio
 │       advisoryBus 恒构造(loop.ts) → 这批默认全开：self-verify、edit-tool-advisory、
 │               lossy-observation、spec-verify-gate、typecheck-reminder、todo-reminder、
 │               security-pattern(写后正则查危险模式；config agent.securityGuidance=false
 │               或 RIVET_SECURITY_GUIDANCE=0 关)、
 │               context-pressure(需 token getter)、dedup-guard(需 streamedText getter)
  │       deps-gated（默认多为真）：playbook-reflect、anchor-break-shadow、dream/skill-distill、
  │               meridian、telemetry-flush、physarum-file-access、memory-learning、courage/ccr(starSoul)
  │       默认关(opt-in)：songline、constellation、hearth-observe、companion、
  │               dispatcher(自动委派)、anchor-break-scout、mcts-planning/blind-exploration(antiAnchoring)
  ├── AgentSession (messages, usage, turn count)
  ├── EvidenceTracker + FileHistory
  ├── Stores: claim-store, stigmergy-store, playbook-store, trace-store
  └── Tool dispatch → API (SSE streaming) → TUI (纯 ANSI, src/tui/engine/) / Desktop (server SSE)
```

> ⚠️ 旧文档写「9 个固定 hook」是误导性简化。真相是条件装配，开关在 `loop-factory.ts:createRuntimeHooksPipeline` 传入的 deps。改 hook 行为前先看 `create-runtime-hooks.ts` 的 gate 条件，不要假设某 hook 一定在跑。

Key modules: `src/agent/` (loop, hooks/, session, coordinator, star-domain), `src/api/`, `src/tui/`, `src/tools/`, `src/prompt/`, `src/compact/`, `src/cache/`, `src/context/`, `src/server/` (desktop sidecar), `src/repo/`, `src/mcp/`, `src/auth/`, `desktop/`, `vscode-extension/`

## Conventions

- Node.js test runner (`node:test` + `node:assert/strict`), not Vitest or Jest
- ESM with `.js` extension in imports
- Immutable patterns — spread operator, no mutation
- Error classification via `classifyApiError()` — no ad-hoc status code checks in clients
- Tests: `src/**/__tests__/*.test.ts` mirrors source structure

## Known Constraints

- **Prefix cache is the core optimization.** System prompt and early messages must stay stable within a session — avoid rewriting history or injecting before anchor points.
- DeepSeek V4 may emit tool JSON in text content (`hasToolJsonInContentBug` in client config)
- Codex client receives text via both `output_text.delta` and `output_item.done` — `seenTextDelta` dedup handles this
- Agent loop `onTurnComplete(usage, turn, isFinal)` — intermediate turns keep writer alive, only final turn destroys it
- User input during streaming goes to SteerBuffer (not direct interrupt), injected at next tool result
- **星域 `toolWhitelist` 是生效的工具交集过滤器，对当前内置域退化为恒等。** `star-domain.ts` 有 11 个域（天枢/破军/天府/天梁/天权/天机/天璇/辅/文曲/瑶光/华盖）。worker 创建时 `allowedTools = profile.allowedTools ∩ domain.toolWhitelist`（`work-order.ts:toolsForAuthority`）。当前 11 域白名单**逐字相同且是全集**（2026-07-15 起含 `browser_debug` + `computer_use`） → 对内置域交集退化为恒等（no-op），域间行为差异只来自 `systemPromptSuffix`/`volatileBlock`/`courageThreshold`/`decisionStyle`。但机制本身**真实生效**，三处会咬人：①profile 若含白名单外工具（`browser` 等），设了 authority 就被静默削掉；②authority 拼错/域未加载 → **fail-closed 返回 `[]` deny-all**（有意护栏，勿改成回退 profile 全集）；③自定义域（card frontmatter）的 `toolWhitelist` 完全生效，会真实削减工具。改它前先想清楚命中的是哪种场景。
- **Hook 信号经 AdvisoryBus 统一收编后注入**（`59e52394`）。hook 不直接改 prompt，只能用 `RuntimeHookEffects`（`injectUserMessage`/`emitPhaseChange`/`setStrategy`…）；带 priority/ttl/category 的信号优先 `advisoryBus.submit`，降级才 `injectUserMessage`。注入走 system-reminder 通道，不重写 `frozenBase`/`volatileBlock`。
- **重构事故链四层防线（2026-07-04）**：①`planner` profile 有 balanced hardFloor，议事会席位瑶光门（`tierHint`+`noDowngrade`）经 `seatTierFloor` → `WorkOrder.tierFloor` 接线到真实派发（只抬升不降级）；计划文件带产出模型留痕（`> **Model: …**` 行），cheap 产出在 TUI/桌面审批面显示警告。②plan submit 规模门禁：任务 >8 或文件 >15 且无分波结构 → one-shot 软拦；`plan-executor` 波间硬门禁（`wave-gate.ts`）：非末波完成后 typecheck + 白名单验证命令必须过，失败硬拦下一波 dispatch（入口复评自愈；`RIVET_WAVE_GATE=0` 禁用）。③重构类计划强制 `full` 方法论 + 「回归清单」章节；清单经 `TaskContract.regressionInventory` / 最近 APPROVED 计划流入 `deliver_task`，交付前逐项 git grep 核验（advisory 不阻断）。④`regression-bisect-hook`（postTool，`RIVET_REGRESSION_BISECT=0` 禁用）：回归语义 + ≥5 轮只读诊断空转 → constitutional advisory 强制切基线对照（git log → bisect/checkpoint diff → 清单定位）；convergence level 3 对回归场景优先建议 bisect 而非开新对话。
- **压缩历史重写只在 `turn===0`（用户边界）。** `compact-boundary-coordinator.ts` 的 `runCompaction` 是五级阶梯（会话分裂→maybeCompact→T9 质量压缩→陈旧轮压缩→堆驱动微压缩），命中即止。turn 中途只置 pending flag 延迟到 turn 0；1M 窗口跳过/延迟一切重写；`shouldDelayCompact` 在缓存健康时不压——全为保前缀缓存。
- **appendix 块必须字节稳定（2026-07-06）**：`appendixDelta` 默认开，字节恒定块入场付一次、稳态零重发、压缩后随 baseline 自动补课——新增 appendix 块前先回答"信息是否已在消息历史里？能否做到语义变化才字节变化？"。量化在**渲染层**做（tool-context 10% 桶、mirror low/mid/high 三档），不在 `buildAppendixBody` 加语义哈希/特判（评审否决过，见 `docs/changelog/2026-07-06-appendix-delta-byte-stability.md`）。tool-history 块已删（与消息历史冗余）；plan-mode 块恒定 full 无节律。appendix 侧已无已知 churner——historical-lessons 曾按 recentQuery 每边界重排，现已双重收口：`context-injection.ts` 的 `refreshPlaybookLessons` 每会话只查一次（habituation 不抖前缀），且整条注入路径默认关（需 `RIVET_PLAYBOOK_INJECT=1`）。实测 294 请求会话总体命中 99%、零全 miss，重建尖峰全部落在 `turn===0` 且恒定 8–10K，与会话长度解耦。
- **frozen 快照 commit 不得依赖可被清空的状态（2026-07-06）**：`frozenPendingMerged` 的边界 commit 由 pending map 自身驱动（`buildOaiRequest` 前置清扫），**绝不能**以 `cachedFreshForUser` 之类会被 `invalidateFreshCache()` 清空的变量做守卫——`setIntentRetrievalRoute` 每条用户消息必触发 invalidate，落在两轮之间就孤儿化快照 → 每边界 FATAL fallback + prefix_truncation（单次最高重建 18.9 万 token）。fallback 重建结果必须回存自愈（否则每请求字节翻转）。invalidate 时**不要**提前 commit（会留陈旧中间版快照）。回归测试必须覆盖"invalidate 落在两轮之间"的生产序列，"同轮再 build"通过不代表安全。见 `docs/changelog/2026-07-06-frozen-snapshot-orphan-fix.md`。
- **request 对象会被多个 `stream()` 重入，client 变换层禁止 mutation（2026-07-06）**：llm-speculation 复用主请求的消息对象、`FallbackStreamClient` failover 重放同一 request——`openai-client.stream()` 内一切消息改写（system suffix 等）必须 copy-on-write，`content +=` 原地 mutation 会在重入时双写 → system 字节中途翻转 → 该请求整段前缀缓存 miss（且侧路不记 usage，成本隐形）。侧路请求用 `{...mainRequest}` 展开时必须显式剥 `prefixProbe`（主路径专属标志），否则 wire 探针基线被毒化、下一主轮报幻影 `wireDiverged`。见 `docs/changelog/2026-07-06-llm-speculation-suffix-double-append.md`。
- **静默降级是最贵的 bug 形状；测试挂死会污染归因（2026-07-29）**：同一轮查出四个同族问题，形状相同——**走通和走不通，观察者区分不了**。① `browser_debug screenshot` 的图在"模型无视觉 + 未配 `agent.visionModel`"时被静默丢弃（`tool-execution.ts` 三分支的最后一条），而结果文字不说，模型可能凭截图存在断言渲染正常；截图是验证手段，能让模型声称验证过它没看见的东西比没有这工具更糟。② `buildVisionClient` 四个失败点（provider/模型/OAuth/key）全返回同一个 `undefined`，"配了不生效"与"没配"无从分辨；最常见成因是 key 只在环境变量里而 GUI 启动的进程没继承到（`config.env` 那套只作用于命令执行，不改 `process.env`）。③ `describeImages` 同时从 `onTextDelta` 和 `onContentBlock` 累加——这两个回调携带**同一段文本**（前者流式给 UI，后者收流结束发完整终值给持久化），两边都收 = 所有 openai 协议 provider 上桥接描述精确翻倍；写 StreamClient 消费方时只能取其一。④ 图像 token 别按张数算：`765` 是 1024 方图的精确值，1280×800 实为 1105、整页长图到 1785，低估上下文用量的后果与 `reasoning_content` 漏算同构（压缩系统性偏晚）；统一走 `context/image-tokens.ts`，且必须 O(1)（逐消息调用，data URL 可达数 MB）。**另有一条工作流纪律**：任何直接 `node --test` 的入口必须带 `--test-timeout` + `--test-force-exit`（Node 默认超时是 Infinity）。此前护栏只落在 `scripts/run-node-tests.ts`，三处 package.json 入口绕开，导致一个 `test:desktop` 进程挂满 2 天 13 小时占 75% CPU——真正代价是它拖慢机器后让依赖时间窗的测试（git 变更率 / watchdog / spawn tsc / abort 时序）成批失败，**看起来像当前改动的回归**。遇到成批的计时类失败先查 `ps` 有无僵留测试进程，再动代码；要隔离归因用 `git worktree` 开 HEAD 干净副本只搬入自己的文件（本仓库工作树常有几十个文件属于其他会话）。门禁：`scripts/__tests__/test-entry-hardening.test.ts`。见 `docs/changelog/2026-07-29-vision-channel-honesty-and-test-entry-hardening.md`。
- **"假通过"没有任何外显信号，退出码不是验证（2026-08-02 记录 / 2026-09-12 处置翻转）**：`node --test --test-force-exit` 会在中途少跑测试**并照样退 0**——2026-08-02 首次记录（3 个文件真实 31 条在 load≈20 时报出 7/15/31/29，四次全 exit 0；单文件同样中招，`meridian-db.test.ts` 三连跑 18/**3**/18）。**2026-09-12 复测推翻了两条前提**：① 该 flag 不是"高负载概率事件"，而是日常负载下**必现**——desktop 197 文件四次跑报 1523 / 1640 / 1661 / **无汇总**（四次 exit 0、fail 0），最少少 17%，单文件也能少（14→11）；② "去掉它会因泄漏句柄永久挂起"的代价不成立——plain 跑 33s 正常退出，那个代价的真正成因是入口绕开 `--test-timeout`（Node 默认 Infinity），该护栏如今已在三处入口与 runner 内。**结论：`--test-force-exit` 已从所有测试入口移除，改用 `scripts/test-child-guard.ts`（plain 跑法 + idle/hard 看门狗 + 汇总完整性 fail-closed：进程退出却没见 `ℹ tests` 行即判失败）**。另发现一层：plain **单进程**跑近 200 个文件也会丢约 2%（1789 vs 逐文件真值 1830），故 desktop 入口（`desktop/scripts/run-tests.ts`）按 20 文件/批 spawn、逐批核对后相加。门禁 `scripts/__tests__/test-entry-hardening.test.ts` 反向锁死：直接入口**必须**带 `--test-timeout`、**不得**带 `--test-force-exit`。**残留边界**：guard 抓得住"无汇总 / 真挂起 / 超总时长"，**抓不住"有汇总但少跑"**——对完整性有硬要求时用逐文件跑加总。归因纪律仍适用：①声称"全绿"前先核**报告条数**对不对得上，退出码 0 而条数少 = 什么都没验证；②条数对不上先复跑，别当场归因到自己的改动；③高负载会同时制造假失败与假绿；④`git worktree` 隔离归因不隔离 CPU。完整对照数据见 `docs/analysis/2026-08-02-测试静默少跑仍报通过.md`。
- **config 里的 provider models 是快照，写入必须合并、读取才回灌（2026-07-29）**：`config.json` 存的是 preset models 的**副本**，而 `deepMerge` 对数组整包替换 → 磁盘上的旧 models 永远赢过 preset。两条纪律：①**所有 model 写入路径都是部分更新**（桌面 Settings 编辑表单只发 `{id, alias, contextWindow, maxTokens}`，`rivet config set-model` 只发用户敲的），所以 `setupProvider`/`upsertProviderModel` 必须走 `mergeModelUpdate` 合并——曾是 `models[i] = model` 整对象替换，**在 UI 里改一次上下文窗口就把 `supportsVision`/`tier`/`pricing` 当场抹掉**（后果分别是图被静默丢弃、tier 退化成按模型名猜、成本核算读零）；字段缺席 = 调用方没表达意见，清字段是 `removeModel` 的活。②preset 演进触达老配置靠 `config/preset-model-backfill.ts` 在 `loadConfig` 读时补**缺席**字段，磁盘在下次 `saveConfig` 顺带自愈；允许清单只有 `supportsVision`/`tier`/`pricing`（描述模型），**不要**把 `alias`/`contextWindow`/`maxTokens`/`reasoningEffort` 加进去（前两类会改模型指向与用户调参），也不要注入 preset 后来新增的 model（裁剪列表是用户的正当选择）。打包侧无需担心：不随包分发 config 模板，`DEFAULT_CONFIG` 用 `cloneProviderPreset` 即时克隆，全新安装（含便携版 `<exe>/TianshuData/.rivet`）拿到的就是当时最新的 preset。附带一条归因纪律：缺字段先看**剩下哪几个字段**——形状对得上某个表单/接口，就是被写坏的，不是配置太旧。

## MCP Tools: code-review-graph

### Anti-patterns (NEVER do these)

These patterns waste 5-10× the necessary tool calls when the code-review-graph MCP can answer directly. The graph indexes call relationships, imports, and inheritance — one query replaces many file reads.

- **NEVER** grep/glob/read in a loop to explore code when `query_graph` or `semantic_search_nodes` can answer in one call
- **NEVER** spawn an Explore sub-agent for questions that `query_graph pattern="callers_of"` or `get_impact_radius` can answer directly
- **NEVER** read an entire file to find a function — use `semantic_search_nodes` then `get_review_context` for the relevant snippet
- **Prefer composite queries**: `detect_changes_tool` + `get_affected_flows` replaces manual diff → grep → read chains
- **One graph call replaces 5-10 file reads** — always check graph tools first when the question is "who calls / who imports / what's affected"

## Star Lore

星图叙事与伙伴星定义见 [star.md](./star.md)。
