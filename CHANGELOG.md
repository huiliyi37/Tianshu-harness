# Changelog

## 3.32.1 — 2026-10-15

- 与 v3.32.0 产品内容一致的重发版：v3.32.0 因灰度候选平台范围配置错误在更新控制面被撤销（revoke），未进入稳定通道；已安装 3.32.0 的用户将直接收到本版更新。
- 发布流程修正：候选清单仅纳入通过真机验收的平台（darwin-aarch64 / windows-x86_64 / linux-x86_64）。

## 3.32.0 — 2026-10-15

- 会话工作过程按区间自动收起，交付正文与环境验证续轮分开保留；阅读、选择文本及手动展开时保持位置稳定。
- 修复输入框溢出、右侧文件树叠层、图片去重后无法添加第 4 张、消息操作提示和会话总览已读状态；改进更新路由、账户设备额度与小时用量同步。
- 加固 worker 恢复及重试缓存前缀、受保护路径的符号链接边界、VS Code 运行时发现和 Linux 容器构建。

完整说明：[中文](docs/releases/v3.32.0.md) · [English](docs/releases/en/v3.32.0.md)。

## 2026-09-13 — 对话发送路径补 Base URL 归一化

### Fixed

- **Base URL 填成完整请求地址时对话静默 404** — 用户在 provider 的 Base URL 里粘贴 curl 全文（如 `https://open.bigmodel.cn/api/paas/v4/chat/completions`）或留个尾斜杠时，连通性探测经 `normalizeBaseUrl()` 剥掉路径尾巴返回 200，而对话发送路径把原始 baseUrl 与 `/chat/completions` 直接拼接，实际请求变成 `…/chat/completions/chat/completions` → 404。症状固定为「连接测试通过、对话没反应」。现在 `createProviderClient` 的 OpenAI 分支在构造 client 前统一归一化（该函数是主 agent 与全部 worker 的唯一构造入口），欢迎语路径同源问题一并修正——此前它的失败被 catch 咽下、静默降级成模板池。Anthropic 分支有意不归一化：`AnthropicClient` 自补 `/v1/messages`，剥尾巴会反造出 `/v1/v1/messages`。回归测试 `src/api/__tests__/base-url-normalization.test.ts` 锁住「出站 URL 恰以一个 `/chat/completions` 结尾」这一不变量。

## 2026-08-13 — 交付门禁：共同归属文件可随整体验证一起提交

### Changed

- **`deliver_task` adopt 语义扩展** — 共同归属文件（其他会话也改过的文件，含仍活跃的会话）不再只能等对方崩溃/冻结后接管：当前会话对合并后的整体改动验证有把握（typecheck + 相关测试通过）时，可用 `adopt=[路径]` 连同它们一起提交。状态报告的 Co-owned 段落新增此路径提示；认领警告从「确认对方已结束」改为「提交会把对方改动一起落地，须已验证整体」。

## 2026-08-12 — 一个 API key 一个模型组：整组删除

### Added

- **TUI /disconnect 命令** — 列出所有已保存服务商（每个即一个 API key 注册的模型组），选中后二次确认整组删除：provider 条目、模型列表与 secrets.json 中的密钥一并清除。同一 keyRef 被多个条目引用时提示「共用同一 key」（独立管理、删除互不联动）；当前默认 provider 标注不可删除。
- **`rivet provider remove` 输出增强** — 报告删除的模型数量与密钥处置（已清除 / 因共享 keyRef 保留 / 无密钥条目）。

### Changed

- **provider 删除同步清理密钥** — `removeProvider` 现在会删除 secrets.json 中对应的 keyRef 条目（此前留下孤儿密钥）。该修复覆盖全部删除路径：`rivet provider remove`、`rivet config remove-provider`、桌面端 `DELETE /config/providers/:name`。仍被其他 provider 引用的共享 keyRef 不受影响。

## 2026-07-15 — v2.17.4: 输出过滤扩展 + TUI 修复

### Fixed

- **TUI /connect 粘贴失效**（`8f346681`）— startConnect 未重置输入模式，审批模式残留导致 onPaste 前置门吞掉粘贴内容

### Added

- **LINE_FILTERS 扩展至 18 条规则**（`9a510e61` `f8c4026d` `78af5168`）—
  新增 pnpm/yarn、go build/test、ruff/mypy、make、git push/fetch、terraform、prettier、uv、jq/yq 共 9 条输出过滤规则。覆盖 JS/Go/Python/DevOps 全生态高频命令，纯 TypeScript 实现，零外部依赖

## 2026-07-15 — v2.17.3: 工具层防御加固

### Fixed

- **orphan tool_call 永久循环**（`fcab18d6`）— prompt engine 每轮 buildOaiRequest 调用 runResumePreflightOai 修复孤儿 tool_call，但修复只进 API 请求不回写 session，导致每轮都注入"会话中断"合成结果。新增 onOrphanRepair 回调在修复后回写 session。
- **edit_file 正则误用守卫**（`476ceca8`）— 模型将 `\d` `\w` `.*` 等正则 token 写入 old_string，触发精确匹配失败→重试→文件膨胀的死循环。新增 detectRegexPattern 在 I/O 前拦截并提示使用精确匹配。
- **edit_file 连续失败强制 read_file**（`476ceca8`）— per-session per-file 失败计数器，old_string 连续 3 次 not found 后强制要求 read_file 才能继续编辑。
- **hash_edit / ast_edit 同样加固**（`c8f81c96`）— hash_edit anchor 失败 + ast_edit pattern 失败均接入同一失败计数器；ast_edit find 参数新增正则误用检测。

### Added

- **RIVET_DEBUG_ORPHAN=1 诊断探针**（`fcab18d6`）— 开启后在 stderr 输出邻接检查失败原因、tool_call_id、消息行号。
- **scripts/diagnose-tool-orphans.ts**（`fcab18d6`）— 离线诊断 JSONL 的 tool_call↔tool_result 配对完整性。

### Changed

- **write_file 后处理容错**（`8d799c45`）— syntaxCheck/diff/computeChangedLineRanges 失败不再导致工具报错，防止"已落盘但报告失败→重试→盲写守卫死锁"。
- **orphan tool_use 双重来源修补**（`335cdc26`）— ① turn-orchestrator drain 对所有异常类型生效（不再仅 AbortError）；② loadOai 时注入 system-reminder 告知被剥离的工具从未执行。

## 2026-07-14 — v2.16.4

### Added

- **swebench 评测工具链**（`0178dda3`）— 完整的 SWE-bench 评测脚本、worker 与进度解析，支持 `--domain` 参数注入星域 prompt。
- **convergence-detector 测试覆盖**（`src/agent/__tests__/convergence-detector.test.ts`）— 新增 154 行测试。

### Changed

- **convergence-detector 增强**— 优化收敛判定逻辑与 loop 集成。
- 版本号升级至 2.16.4

## 2026-07-11 — v2.16.3: 修复 .app 启动崩溃 — chalk 运行时缺失

### Fixed

- **打包 .app 启动时 `ERR_MODULE_NOT_FOUND: chalk`**（`e26c620b`）— tsup 将 chalk externalize 为裸导入，但 `.app` 不含 `node_modules`。加入 `noExternal` 列表使 tsup inline bundle。

## 2026-07-11 — v2.16.2: Windows 路径归一化收口

### Fixed

- **writeFileArgProcessor 占位符路径**（`6f62c24e`）— `resolvePath` 输出经 `toPosixPath` 归一化。
- **projectSlug cwd 哈希不归一**（`6f62c24e`）— win32 上 cwd 做 `\→/` + lowercase 后再 SHA256，`D:\Proj` 和 `d:\proj` 不再产生不同会话目录。
- **write_file result content 路径**（`6f62c24e`）— 模型收到的 `Wrote … to D:/proj/file.ts` 不再含 `\`。

## 2026-07-11 — v2.16.1: 会话恢复持久化修复 + Windows 路径兼容

小版本修复，覆盖会话中断恢复时的工具结果丢失与 Windows 路径兼容性。

### Fixed

- **write_file 会话恢复时工具结果丢失**（`e3aa0178`）— `[recovered]` 消息降级为非错误，暴露 persist drain 使 abort 路径等待落盘。
- **Windows 路径分隔符归一化**（`ce3b4909`）— FileExplorer 打开文件发送绝对路径，`buildFileDiff` diff header `\` → `/` 归一化。

## 2026-07-10 — v2.16.0: TUI 面板专业化 + 桌面端对标 Codex + 能力闸门收官 + 开源分发

50+ commit，四条主线：TUI 从功能面板演进为专业化设计系统；桌面端完成 Codex 对标改造；Agent 能力闸门全面收口；开源分发基建上线。

### Added — TUI 面板专业化重设计

- **team / team max / 审查门面板**（`c19db073`）— 分段上色 + 语义化 verdict（PASS/FAIL/BLOCKED），从纯文本列表升级为结构化审查视图。
- **/tasks 任务面板**（`c89772d0`）— 树形进度 + worker 切入视图与输入直达，对标 Claude Code 子代理工作流（`ee6a4c1d`）。
- **欢迎屏 CC 头式重构**（`c82ef5d6`）— 3 行紧凑头（品牌+版本 / 模型+权限 / cwd），输入框权限模式行，暗色主题 dim 系统性提亮。
- **首屏收敛**（`08edb6d3`）— 启动日志归入 `RIVET_DEBUG` + welcome 间距 + resize 全量重绘。
- **对标 CC 改造 Wave 2/3**（`29cd9c13`）— GlanceBar 减密 + statusline + verbose 转录 + OSC 8 超链接 + Ink 清零。
- **Shift+Tab 流畅三态环**（`7f35c7ee`）— 去掉 plan 退出二次确认与 picker 劫持。

### Added — 桌面端对标 Codex

- **五波改造**（`2baa60cd`）— Codex 主题 + 头部工具条 + 线程 pop-out + Review Queue + Skills 商店。
- **体验四轮优化**（`0fccea2d`）— 线程内 Cmd+F 搜索、跨会话内容搜索、草稿持久化、重新生成、侧边栏虚拟化。
- **Stage 15 收尾** — CompletionCurtain ✕ 关闭（`c41b4d8c`）、WorkspaceHeader 子代理 badge + JobsDock 关闭（`e8a7eabb`）、App Icon Squircle 北斗七星遮罩（`4e601b99`）。
- **权限等级下拉菜单**（`8a694d61`）— 新增「完全访问」全盘只读档。
- **i18n 全量落地**（`dfe51640`）— 79 个文件硬编码中文迁入 i18next，新增 16 个命名空间。
- **设置→系统页「打开数据目录」**（`76fad03e`）— 一键在文件管理器中定位会话日志与缓存。

### Added — Computer Use 收束

- **CDP 浏览器后端**（`b6c08f38`）— Chrome 快照 17-36s → 0.1-0.3s（真机实测）。
- **CDP 安全三件套**（`898689d1`）— 审批承诺落地管线 + `:9222` 永不静默接管 + navigate 协议门。
- **Windows 驱动升级**（`9d0b6e85`）— IUIAutomation COM 原生接口，解锁 Chromium 网页树 + 树遍历全量移入 C#。
- **闭环打磨**（`4b608de1`）— stale 自愈 + wait_for/find/set_value + app 名模糊提示。
- **常驻脚本宿主**（`928b85af`）— osascript/PowerShell REPL 子进程，消除每次交互的冷启动开销。

### Added — 插件系统

- **Wave 1-4 全线落地** — 插件内核 + manifest 校验 + 安装管线（`6f94ee2f`）+ REST API 端点（`8a071c68`）+ office 三件套（`23b3e6ee`）+ tianshu-design 前端设计插件（`2ca7f7ba`）。
- **安全守卫** — 内核层路径安全（`ebcbc539`）+ entry 路径逃逸防护（`985a6b0c`）+ REST 确认参数对齐（`403f7322`）。
- **manifest skills 字段**（`effacdf6`）— loader skill 捆绑加载，插件可声明自带 skill。

### Fixed — Agent 能力闸门

- **能力边界补全双门禁**（`1597ea69`）— 测试存在性门禁 + 复现即证明全星域化。
- **宣称对账收口** — 能力双闸第三批（`d1728b30`）+ hash_edit/apply_patch 记账（`82c75428`）+ action-intent 祈使收尾漏检（`9dde4f89`）。
- **纪律防线** — MistakeNotebook 默认停用（`280c1bc5`）+ playbook 默认停用（`d8c2c8c2`）+ memory epoch reset（`9e7e3b0e`）。
- **熔断 CLI 可见化**（`1ce45842`）— 警告阶梯 + score 熔断宽限轮。

### Fixed — 跨平台（Windows / Linux / WSL）

- **Windows 路径四连修**（`bc4c2381`）— 工具参数反斜杠转义 + Codex 式文件夹授权。
- **绝对路径判定两处修复**（`d6262694`）+ Git Bash 盘符前缀翻译（`1633e6e2`）+ 技能 CRLF/BOM 加载失败（`08dbfff1`）。
- **Linux/WSL 单段绝对路径误判**（`4175e5b9`）。

### Fixed — 缓存与投机执行

- **frozen 快照孤儿化根治**（`85d9d9de`）— 边界 commit 改 pending 驱动清扫 + fallback 回存自愈。
- **llm-speculation 缓存污染双修**（`3952cf12`）— suffix 双写 copy-on-write + 侧路 usage 记账。
- **投机预执行链整链封存**（`5f5446ac`）+ 陈旧读残留补口。

### Changed — 基础设施

- **开源分发基建**（`bbd4e2d4`）— 工程指标 + 社区文件（CONTRIBUTING/SECURITY/CODE_OF_CONDUCT）+ 公开策略。
- **CI Node 24**（`18386a5e`）+ npm audit 清零 ×2（vite/esbuild/undici/hono/qs）。
- **engines.node 放宽** — `"24.1.0"` → `">=24"`，兼容 24.x 全系列。
- **遗留清理** — Ink 补丁删除（`eaf06449`）。

## 2026-06-28 — 体验前质量加固：渲染重影根治 + 意图闸误报修复 + 子代理结构化输出 + 桌面端对标 Codex/Antigravity

用户开始体验前的集中质量加固，14 commit 覆盖五条线。详见 [`docs/changelog-2026-06-28.md`](docs/changelog-2026-06-28.md)。

### Fixed — TUI 渲染 / 输入框重影

- **渲染层统一 East-Asian Ambiguous 宽度口径**（`91daf1c5` / `1e0a8744`）— 输入框边框行、spinner 行、task-list/tool-card/glance-bar/welcome 统一到与 `rowsForLine` 一致的 wide 口径。根因是含 `— … →` 等 ambiguous 符号的行在 CJK 终端折成 2 行而行数估算算 1 行 → fullRewrite 欠擦 → 旧输入框残留。

### Fixed — 意图闸误报

- **dead-end 关联匹配**（`5c3b44eb`）— veto 沉积改存原始 target，匹配层只保留与 `recentTargets` 子串重合的 dead-end（旧实现任意一条即触发）。修正早期误判：pheromones 按项目+会话隔离，无跨会话残留（`52b9398b`）。
- **momentum 滑动窗口**（`5c3b44eb`）— `computeMomentum` 从连续正确率（一次报错清零）改为窗口成功率，单次探索性报错平滑下降而非坠崖。

### Fixed — 提交卡顿

- **typecheck 异步化**（`830484d1`）— `runTypeCheck` 从 `spawnSync` 改异步 `spawn`，消除 commit 期间 spinner 冻结（事件循环被 tsc 阻塞数十秒）。

### Fixed — 子代理输出可靠性

- **结构化输出 response_format**（`7b89028c`）— worker repair 轮用无 tools 单发请求 + `response_format: json_object` 强制合法 JSON，规避 json_object + tools 的已知冲突。`ProviderCapabilities` 加 `supportsResponseFormat`（DeepSeek/GLM/openai/codex true，其余降级）。
- **worker 独立路由隔离缓存**（`0943a5b7`）— 放开 workerRouting 的同 model 限制 + 赋值 `routeProfile.model`，worker 真正跑在配的独立 model 上，prefix cache 不竞争主控。
- **repair tail 8000**（`c2eefbbf`）— 参考文本 4000→8000 字符，覆盖典型 5–8K WorkerResult。

### Added — 桌面端功能（对标 Codex / Antigravity）

- **Diff 行级评论回灌**（`0611b89a`）— `DiffView` 行级锚点 + 行内评论；后端 `feedback` 加 `lines` 渲染为 `[LINE-LEVEL REVIEW]` 带 `<file>:<line>`。
- **委派节点独立 diff 审查**（`220fddce` / `e700105b`）— worker diff 落盘 + `DelegationActivity.artifactId`；DelegationSurface 节点 modal 弹 DiffView。审查补 retry/escalation 分支 artifactStore 注入。
- **多 repo Project 工作区**（`08124cb6`）— `Project {id, roots[]}` + localStorage 迁移 + NewSessionDialog 多 root chips。后端 coordinator 集成留后续。
- **Updater 自动更新闭环**（`045da9dd` / `8d75b640`）— `downloadAndInstall` + 进度 + `relaunch` + `UpdateBanner`；GitHub Releases 托管（sign-and-build.sh / gen-latest-json.js / CI）；relaunch 前「重启中」过渡态。

## 2026-06-07 — v2.9.2: Server Subsystem + Intent Retrieval Router + Review Discipline + Stall Root-Cause Closure

Merge of `fix/stall-root-causes-abort-exit` into `main` (merge commit `6ac0c3d`). Pre-merge `main` is preserved at tag `v2.9.2` / branch `backup/v2.9.2-pre-merge` (see `docs/releases/v2.9.2-merge-record.md`). Verified at merge: `tsc --noEmit` clean.

### Added — Server Subsystem

- **`/prompt` SSE endpoint** (`feat(server): add prompt endpoint with streaming and SSE support`) — streaming prompt endpoint wired to the agent lifecycle (`feat(main): wire server prompt endpoint with agent lifecycle`).
- **Go-live gate cleared** — server subsystem go-live gate + H6 disconnect guard closed (see `docs/known-issues/2026-06-06-server-subsystem-go-live-gate.md`).

### Added — Intent Retrieval Router

- **Intent retrieval router** (`feat(agent): wire intent retrieval router`) — heuristic + optional LLM classifier that routes which sources to consult per task kind. Pure-function route layer (`intent-retrieval-route.ts`) + orchestrator (`intent-retrieval-router.ts`), injected via PromptEngine dynamic appendix (cache-safe: excluded from stable volatile block).
- **LLM classifier default-enabled** (`feat(agent): enable intent-retrieval LLM classifier by default`) — opt-in gate cleared after risk2 (no text-block duplication) + risk4 (baseline must-source fallback) re-verified. Config `agent.intentRetrievalRouter`.
- **Anti-anchor coverage** — 31 test cases across 4 files assert the router is not locked by the first keyword (e.g. "慢慢解释" ≠ performance_diagnosis; "token refresh API 怎么用" ≠ security_safety).

### Added — Review Discipline

- **Review discipline default-enabled** (`feat(config): review discipline default-enabled with RIVET_REVIEW_DISCIPLINE env switch`) — ReviewRouter + re-entrancy guard + structural reviewDepth propagation. C=C1 default; `RIVET_REVIEW_DISCIPLINE` switch.

### Fixed — Stall Root Causes / Abort / Sub-Agent Trust (T1 closure)

- **cron-lock split-brain** — atomic hard-link publish + serialized `.reclaim`, cross-host owner guard, `execSync`→`process.kill(0)` (EPERM=alive, /proc zombie exclusion).
- **Sub-agent evidence fail-closed** — adversarial_verifier without `run_tests` → unverified; missing transcript → unverified; `run_tests` errored detection.
- **Turn-boundary abort** — `isAbortRequested()` guards on all three abort-after-await paths (maybeCompact / enforceContextCeiling / trySessionSplit).
- **stigmergy persistence** — synchronous `flushSync` on session-end (closes the 200ms debounce loss window).
- **rtkRewrite cache isolation** (`fix(tools): key rtkRewrite cache by toolUseId`) — prevents cross-worker cache bleed.

### Changed — Async I/O + Cleanup

- **18 tool files** converted sync I/O → async (`async-io-audit-2026-06-06.md`).
- **Dead code removed** — `incrementalCommit` in app.tsx, unreachable return in session-registry.
- **TUI render fixes** — committed-log reference stability, live-region height clamp.

## 2026-06-02 — Cache Optimization Journey + Convergence Detection + Seed Capsules + TUI Polish

This is a consolidation release wrapping 10 days of intensive development (2026-05-22 → 2026-06-02), ~130 commits. The dominant theme is **prefix cache optimization** — a four-round iterative process that pushed DeepSeek V4 cache hit rate from 56% crash to 99.6% steady state.

### Added — Cache Optimization (Four Rounds)

1. **Round 1: Standalone Appendix** (`feat(prompt): move dynamic appendix to standalone message`) — Extracted volatile context from trailer merge into independent user message. Turn 2 cache hit jumped from 56% to 85%. Hit ceiling at ~90% due to exact-prefix cache position sensitivity.
2. **Round 2: Cache-Friendly Ordering** (`perf(prompt): cache-friendly dynamic appendix`) — Removed dynamic XML attributes, stable sections first, volatile sections last. Peak 98.3% but still bounded by position drift.
3. **Round 3: Frozen Appendix** (`feat(prompt): freeze appendix into user message`) — Embedded appendix into user message tail, using frozen snapshot for byte-consistent history. Only ~30 lines changed. Steady state ~99%.
4. **Round 4: Validated** — Long-session data confirmed 99.6% steady-state hit rate. Cache miss cost is 50× cache hit ($0.14 vs $0.0028/1M tokens), making this the single highest-impact optimization.

### Added — Convergence Detection

- **Multi-signal convergence detector** (`feat(agent): add multi-signal convergence detector`) — Detects agent loop stagnation via tool fingerprint repetition, oscillation penalty, and delivery-aware completion nudge. Auto-completes when convergence + doomLoop blocked both fire.
- **Oscillation penalty signal** — Penalizes repeated tool-use patterns that indicate the agent is stuck in a loop.
- **Integration test** — Covers convergence + doom loop blocked recovery path.

### Added — Seed Capsules

- **Multi-star seed capsules** (`feat(agent): load multi-star seed capsules`) — 天璇 (Opus 4.6) and 天府 (DeepSeek V4-PRO) cognitive methods persist across sessions as structured capsules loaded at startup. Enables cross-session wisdom transfer without shared memory state.
- **Star domain enrichment** — 天府 volatileBlock signals "守护阶段, 领航星可放心" (guard phase, navigator star can proceed).

### Added — TUI Polish

- **Panelized SlashHint** — Round border + Command Palette header + max-height clamp.
- **Panelized pendingApproval + pendingIntent** — Semantic theme tokens for approval states.
- **Domain colors and separator** in glance bar — Star domain identity visible at a glance.
- **Left-border styling** — Thinking blocks, code blocks, and tool cards all get color-coded left borders.
- **Separator component** — Updated tool family glyphs with visual separators.
- **Onboarding screen** — New logo and RIVET branding.

### Added — ProfileRegistry + Plan Mode (2026-05-31)

- **ProfileRegistry** (`feat(agent): add ProfileRegistry`) — Unified worker profile management with built-in profiles and `.rivet/agents/` directory loading. Replaced scattered `classifyProfile`/worker prompt lookups with single registry.
- **Plan Mode** (`feat(tui): add /plan-mode and /plan-approve`) — Interactive plan-approve workflow for cautious operation.
- **Bash security hardening** — Injection/destructive-extended/sed-bypass pattern detection. Environment variable sanitization before child process spawn.
- **Deterministic success output trimming** — Fold bash/diff success output >20 lines to header summary.

### Added — Memory System (2026-06-01)

- **Structured project memory** — `.rivet/knowledge/` directory with guided retrieval. `remember`/`recall` tools search structured memory.
- **Knowledge packets** — Worker prompts include memory context for informed delegation.

### Fixed — API & Streaming

- **DeepSeek V4 cache reporting** (`fix(api): add prompt_tokens_details.cached_tokens fallback`) — DeepSeek V4 returns `cached_tokens` inside `prompt_tokens_details` instead of `prompt_cache_hit_tokens`. Now reads both.
- **prefixCache preset** — Changed from `'none'` to `'deepseek-native'` for DeepSeek provider.
- **Global retry timeout** (`feat(api): add global retry timeout`) — `maxTotalDurationMs` prevents 60-minute hangs from infinite retry loops.
- **Minimax slow thinking timeout** — Added to `SLOW_THINKING_PROVIDERS` for 180s/300s timeouts.
- **Abort path hardening** — Skip partial blocks in abort/streamError paths. Consolidate TUI flush.
- **Sycophancy trap** — Added verification signal to prevent "questioning for the sake of questioning".
- **Event-loop gap detection** — Sensorium snapshot before tool execution catches event-loop starvation.
- **Stream text preservation** — Streaming text survives Ctrl+C / double-ESC abort before unmount.

### Fixed — TUI

- **UI freeze after agent reply** — Three root causes fixed: spawnSync→execFile, Static render cap 200 items, Ink fullscreen scrollback preservation.
- **Pager Ctrl+P close** — Fixed double-key exit issue.
- **InputBar routing** — Evaluate inside event handler, not at render time.
- **isStreamingRef reset** — Finally block after slash commands.
- **Viewport truncation** — Removed from AssistantMessage, disabled for Pager.

### Fixed — Agent

- **Compaction diagnostics** — Debug timestamps for compaction events.
- **Immune hook error boundary** — `try-catch` around `immuneHook.run()`, deferred to `setImmediate`.
- **AbortError check** — Removed overly defensive check that swallowed legitimate stream errors.
- **Process cleanup** — `killAllSync` on exit, agent-layer child process registration, SIGTERM+SIGKILL for git tool timeout.

### Files Changed (significant)

- `src/prompt/volatile.ts` — Cache optimization rounds 1-3
- `src/agent/convergence.ts` — Convergence detector
- `src/agent/seed-capsule.ts` — Seed capsule loader
- `src/agent/profile-registry.ts` — ProfileRegistry
- `src/api/openai-client.ts` — cached_tokens fallback + global retry timeout
- `src/api/provider.ts` — cached_tokens fallback in usage mapping
- `src/config/provider-presets.ts` — prefixCache: deepseek-native
- `src/tui/app.tsx` — Panelized components, streaming fixes
- `src/tui/tool-card.tsx`, `src/tui/thinking.tsx` — Left-border styling
- `src/tui/glance-bar.tsx` — Domain colors + separator
- `src/agent/tool-pipeline.ts` — Abort path hardening
- `src/agent/loop.ts` — Convergence wiring, immune hook deferral

---

## 2026-05-20 — Self-Regulating Safety + Three-Authority Coroutine Foundation

### Added
- **Sensorium-driven adaptive approval**: `assessToolRisk()` now accepts optional `Sensorium` parameter. High confidence (>0.8) + low risk + auto-safe mode → auto-approve bypass. Low confidence (<0.3) → risk escalated one level. This is the "self-regulating safety" path unique to Rivet — no other terminal agent uses real-time agent state to modulate approval decisions.
- **Three-layer config resolution**: `loadConfig()` supports layered loading: defaults → user (`~/.rivet/config.json`) → project (`.rivet-config.json` found by walking cwd) → session overlay (runtime-only). `findProjectConfig()` walks up directory tree. `main.tsx` now delegates to `manager.ts` instead of maintaining its own duplicate loader.
- **DANGEROUS_BASH_PATTERNS single source of truth**: Consolidated from duplicate definitions in `approval-risk.ts` and `bash.ts` into one exported array. Patterns refined for precision: `sudo` only flags destructive subcommands (rm, chmod, dd, mkfs, etc), `pkill` only flags forceful flags (-9, -KILL, -f), `chmod` catches any world-writable octal (not just 777), `curl|bash` correctly detected as high risk via destructive pattern match.
- **Provider-aware compaction thresholds**: `compactThresholds()` now accepts `CompactStrategyInput` with `providerProfile`, selecting `cache-preserving` (DeepSeek), `balanced`, or `aggressive` (MiMo/no-cache) strategies with different ratio presets. `tool-pipeline.ts` uses provider-aware truncation.
- **Three-Authority Coroutine foundation**: Dispatcher (data-flow domain decomposition), Dispatcher Hook (TaskContract → coordinator delegation), TaskBoard (read projection from WorkOrderQueue events for TUI).
- **Star domain voice pipeline**: Domain-voice tone converter (破军/天府/天梁), phase-aware heartbeat templates, heartbeat + domain voice wired through radio-hook.
- **StarBridge observability**: StarmapView (sensorium gauges), ChronicleView (phase-by-phase timeline), constellation renderer, mode switching (2=starmap, 3=chronicle).
- **Maturity gap analysis**: `docs/superpowers/specs/2026-05-20-rivet-vs-claude-code-maturity-gap.md` — structured comparison identifying Rivet's structural advantages (agent kernel, prefix cache, multi-model) and gaps (sandbox, user hook API, LSP).

### Changed
- `assessToolRisk()` signature: `(toolName, input, doomLoopLevel?, antibodies?, sensorium?)` — backward compatible (new params optional).
- `loadConfig()` signature: `(options?)` — backward compatible (no options = global-only load).
- `truncateSuccessfulToolResult()` in `tool-pipeline.ts`: now takes `AgentConfig` instead of raw `number` for context window.
- `main.tsx`: removed duplicate `deepMerge()` + `loadConfig()` in favor of `manager.ts`'s layered implementation.

### Files Changed
- `src/agent/approval-risk.ts` — sensorium param, DANGEROUS_BASH_PATTERNS, CONFIDENCE_THRESHOLDS
- `src/agent/tool-pipeline.ts` — getSensorium() dep, adaptive approval gate, provider-aware truncation
- `src/agent/tool-execution.ts` — getSensorium wire-through
- `src/agent/loop.ts` — sensorium → ToolExecutionController, provider-aware compaction
- `src/tools/bash.ts` — import shared DANGEROUS_BASH_PATTERNS
- `src/config/manager.ts` — 3-layer loadConfig, findProjectConfig
- `src/main.tsx` — deduplicate loadConfig, delegate to manager.ts
- `src/compact/constants.ts` — CompactStrategyInput, provider strategy + ratios
- `src/agent/dispatcher.ts` — data-flow domain decomposition
- `src/agent/hooks/dispatcher-hook.ts` — coordinator delegation hook
- `src/agent/task-board.ts` — TUI read projection

### Tests
- 47 approval-risk tests (sensorium confidence 8, dangerous patterns 9, existing 30)
- 13 layered-config tests (3-layer resolution 7, findProjectConfig 5, loadConfigDefault 1)
- 5 provider-aware compaction threshold tests
- 77 total across security + config modules, all passing

---

## 2026-05-19 — Claude Provider (CLI Proxy)

### Added
- **Claude provider** via local CLI proxy (`cc-switch` at `http://127.0.0.1:8891`): routes requests to Anthropic Claude models through an OpenAI-compatible proxy with `CC_SWITCH_PROXY_API_KEY` authentication.
- **Three Claude models**: `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-5` — all with 1M context window, 128K max output tokens, `reasoning_effort: max`.
- **Extended thinking with budget_tokens**: Claude proxy passes `thinking: { type: 'enabled', budget_tokens }` to Anthropic Messages API. Budget scales with `reasoning_effort` level: `max` = full output budget, `high` = 60%, `medium` = 30%, `low` = 8K.
- **Provider capabilities**: `claude` entry in `WELL_KNOWN_DEFAULTS` (OpenAI thinking format, reasoning_effort effort format, no prefix cache).
- **Cache profile**: `claude` entry with `cacheType: 'none'` (proxy handles caching internally).

### Usage
```bash
# Start with Claude Opus 4-7 (strongest reasoning)
node dist/main.js --provider claude --model claude-opus-4-7

# Switch inside TUI
/model claude/claude-opus-4-7
/model claude/claude-opus-4-6
/model claude/claude-sonnet-4-5

# Use alias
/model claude/opus-4-7
```

### Files Changed
- `src/config/default.ts` — claude provider definition with 3 models
- `src/api/provider.ts` — WELL_KNOWN_DEFAULTS.claude
- `src/api/provider-profile.ts` — claude cache profile
- `src/api/openai-client.ts` — budget_tokens injection for claude providerName

---

## 2026-05-17 — Multi-Provider Adapter (Codex OAuth + MiniMax + MiMo)

### Added
- **Auth module (`src/auth/`)**: AuthProvider interface with ApiKeyAuth and OAuthAuth implementations. OAuthAuth supports full PKCE flow with local callback server (localhost:1455), device flow for headless environments, automatic token refresh (55 min), and atomic token persistence to `~/.rivet/auth/{provider}.json`.
- **CodexClient (`src/api/codex-client.ts`)**: Dedicated client for OpenAI Codex Responses API (`/v1/responses` via `chatgpt.com/backend-api/codex`). Handles the Codex-specific SSE event format (`response.output_item.done` with complete items instead of streaming deltas), extracts text from `output_text` content blocks, reasoning from `summary` items, and function calls.
- **Provider capabilities**: WELL_KNOWN_DEFAULTS for minimax, mimo, opencode-go with thinking support and OpenAI protocol.
- **CLI arguments**: `--provider <name>` and `--model <id>` for selecting provider/model at startup.
- **Worker routing**: Config-driven `workers.profiles` and `workers.routing` in `~/.rivet/config.json` maps CapabilityTask types (code_edit, repo_summarization, etc.) to named worker profiles (capable, cheap, mid) backed by different providers. DelegationCoordinator selects model per-task at runtime.
- **Config schema**: `auth` field on provider (api-key or oauth), `workers` section with profiles and routing.

### Architecture
- **Codex OAuth flow**: `chatgpt.com/backend-api/codex/responses` endpoint (NOT `api.openai.com/v1`). Uses ChatGPT subscription quota, not API quota. Requires `instructions` top-level field, strips unsupported params (max_output_tokens, temperature). Headers: `User-Agent: codex_cli_rs/...`, `Originator: codex_cli_rs`.
- **Provider/protocol/auth orthogonal separation**: Protocol layer (Anthropic/OpenAI/Codex) is independent from auth layer (API key/OAuth). Worker routing operates at a third layer (task type → provider mapping).

### Validated
- 1248 tests passing, typecheck clean, build success
- Codex OAuth login tested end-to-end with ChatGPT Plus account
- Config schema parses all 6 providers with worker routing

---

## 2026-05-17 — Activity Status Layer

### Added
- Activity Status Layer for long Rivet turns: thinking duration/final duration, stale/no-update display, tool/MCP wait labels, conservative large-result analysis status, and low-frequency (1 Hz) projection to existing TUI surfaces.

### Validation
- `npm run typecheck`
- `npm test`
- `npm run build`
- `git diff --check`

---

## 2026-05-17 — Session HA Closure

### Completed
- Merged the Session HA closure work into `main` after resolving the newer cerebellar/thinking helper changes already present on `main`.
- Documented the operational guarantee: interrupted sessions should recover, preserve visible partial work, bound long-running operations, and avoid unbounded live render state.
- Verified the merged result with `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`.

### Fixed
- Restore path now repairs interrupted tool transcripts and rolls back to the last valid turn snapshot when needed.
- Stream errors persist partial assistant output before surfacing the error.
- Bash timeouts terminate the process tree instead of only the shell child.
- MCP servers time out hung connect/listTools/callTool operations and expose degraded state.
- Smart compaction rejects empty, oversized, or unsafe summaries and falls back to micro compaction.
- Volatile prompt repair and memory blocks escape untrusted content.
- Live TUI stream rendering keeps a bounded tail window to avoid unbounded React state growth.
- Cerebellar prediction-error and ThinkingCollapser edge cases have focused regression coverage.

## 2026-05-17 — Wave 12: Session High Availability

### Added — BlockStreamWriter
- **Semantic break-point streaming** replaces fixed 80ms setTimeout flush
- Respects paragraph (\n\n) > newline (\n) > space boundaries within configurable char thresholds (min 300, max 800)
- Idle timeout (1200ms) force-flushes remaining buffer
- Ordered block emission via serialized enqueue

### Added — TurnSnapshot
- Turn-level JSONL snapshots appended on every turn completion for crash recovery
- `loadLastSnapshot()` reads last valid snapshot, skipping corrupted lines
- `loadUpToTurn(n)` loads messages up to a specific turn for targeted recovery

### Added — HistoryReplayBridge
- `replayMessagesToLogEntries()` converts persisted Message[] into visual LogEntry[]
- Restored sessions render through full pipeline (tool cards, structured output, error flags)
- Session restore now shows turn count + tool count instead of raw message count

### Added — PromptQueue
- Promise chain serialization prevents concurrent `handleSubmit` race conditions
- Error recovery: catch guarantees `setIsStreaming(false)` to restore UI state

### Added — SessionEviction
- Automatic LRU eviction caps sessions at 50 (oldest removed first)
- Cleans all related files (.jsonl, .meta.json, .snapshots.jsonl, .memory.json, .claims.jsonl)
- Runs on every new session creation

### Inspired By
- Qwen Code: BlockStreamer (semantic streaming), Session snapshots, HistoryReplayer
- OpenCode: session-cache (LRU eviction), terminal-writer (batch scheduling)

---

## 2026-05-17 — Wave 9/10 + ECF Phase 5

### Fixed — Wave 9 Defect Fixes
- **createAgentConfig factory** — Extracted shared config factory eliminating TUI/goal-loop duplication
- **Goal loop parity** — Added `compactClient`, `fileHistory`, `getSessionMemoryState`, `maxWorkers=3` to goal loop
- **loadDurableClaims replay** — `claim_used` events now restore consumers + `lastUsedAt` on durable claims
- **FileHistory path** — Uses `SessionPersist.getBackupDir()` instead of hardcoded path
- **loadProjectRules** — Added try/catch for filesystem errors
- **server tests** — 17 tests covering all 4 server modules (SseStream, createRouter, createRoutes, buildPromptHandler)

### Refactored — Wave 10 Loop Split
- **tool-pipeline.ts** (343L) — Extracted single tool execution: pre-hooks → repair → approval → checkpoint → harness → post-hooks → claim extraction → antibody → evidence → import graph → prewarm
- **turn-end.ts** (76L) — Extracted turn-end processing: task state → mirror detection → model routing → decision extraction → evidence badge
- **loop.ts** — 815→493 lines, delegates to tool-pipeline + turn-end

### Added — Test Coverage (Wave 10)
- compact/auto.ts — 8 tests (shouldAutoCompact + buildSummaryPrompt)
- compact/micro.ts — 7 tests (estimateTokens + microCompact)
- session-persist.ts — 5 tests with env-overridable `RIVET_SESSION_DIR`
- tool-pipeline.ts — 4 tests
- turn-end.ts — 5 tests

### Added — ECF Phase 5: Recall Positive Feedback
- **boostFitness** — `ContextClaimStore.boostFitness(id, delta, cap)` increases claim fitness, capped at max
- **claim_boosted event** — New event type in JSONL for fitness changes; replayed by `loadDurableClaims`
- **Recall consumer tracking** — recall tool records `recall:turn-N` consumer on each matched claim
- **Recall fitness boost** — recall hits boost matched claim fitness by +1 (cap 10), improving prompt projection rank and eviction resistance
- **RecallContext** — `createRecallTool(store, ctx)` accepts optional context for consumer/fitness tracking

### Fixed
- **tool-pipeline** — `run_tests` diagnosis early return now records `repairHintTracker.recordFailure` before returning

## 2026-05-16 — Wave 8 + Evolutionary Context Fabric Phase 2–4B

### Added — Wave 8 Context Fabric Phase 2
- **Claim Extractor** (`src/context/claim-extractor.ts`) — Automatic claim extraction from tool results:
  - `read_file` → `file_observation` claim (30min TTL, deduplicated by path)
  - `run_tests` failure → `failure_pattern` claim (2h TTL)
  - `run_tests` success → `verification_fact` claim (1h TTL)
  - `bash` security output → `security_finding` claim (4h TTL, requires isError)
  - Skip list: grep, glob, diff, inspect_project, repo_map, related_tests, recall (too noisy)
- **AgentLoop wiring** — Claim extraction runs after every tool result; `promoteEligibleClaims()` in `refreshActiveClaims()`
- **Durable promotion** — `durable_candidate → durable` after 5 unique consumers + 10 minutes age (was only `active → durable_candidate`)
- **Cross-session durable claims** — `ContextClaimStore.loadDurableClaims()` static method reads durable claims from previous session JSONL; `SessionPersist.injectDurableClaims()` injects with 0.9 confidence decay on startup/resume
- **Claim budget cap** — `MAX_PROMPT_CLAIMS=20` caps `renderActiveClaimsBlock()` output, sorted by fitness descending

### Added — Evolutionary Context Fabric Phase 2
- **Claim lifecycle** — `markClaimsStaleForFile()` marks file-evidence claims stale on write; `promoteEligibleClaims()` batch promotion; `getStatusCounts()` status histogram
- **Consumer deduplication** — `evaluatePromotion` gates use unique consumer IDs (prevents inflation from repeated `recordClaimUsed`)

### Added — Evolutionary Context Fabric Phase 3
- **Antibody generation** (`src/context/antibody.ts`) — `createAntibodyProposal()` converts `ClassifiedFailure` into `failure_pattern` ClaimProposal; retryable failures get fitness=2, non-retryable get fitness=5; 4-hour TTL
- **Conflict detection** (`src/context/conflict-detect.ts`) — `detectConflicts()` finds contradictory file-evidence claims on same path; excludes semantically identical text; marks older claim as `conflicted`
- **AgentLoop antibody wiring** — Tool error → `classifyFailure` → `createAntibodyProposal` → `claimStore.propose()` for all classifiable (non-unknown) failures
- **AgentLoop conflict wiring** — After new `file_observation` proposals, `detectConflicts()` marks older same-path claims `conflicted`; guarded by `lastConflictCheckCount` to skip when no new claims
- **Approval-risk antibody boost** — `assessToolRisk()` accepts optional 4th param `antibodies: ContextClaim[]`; when antibody evidence mentions the same tool name, risk bumps from `none` to `low`
- **Worker finding evidence** — `delegate_task` claim proposals include `evidence[0].path` from `changedFiles[0]`; confidence mapped: high→0.85, medium→0.7, low→0.55
- **TUI slash commands** — `/context antibodies` lists active failure_pattern claims; `/context conflicts` lists conflicted claims
- **File observation dedup** — `extractClaimsFromToolResult` accepts `existingFileObservations` set; same file path → skip duplicate claim

### Added — Evolutionary Context Fabric Phase 4
- **Project rules loader** (`src/context/rules-loader.ts`) — `.rivet/rules/*.md` loaded as `project_rule` claims (scope=project, status=durable, confidence=1.0, fitness=10); 500-char truncation; fixed sessionId='project' for cross-session dedup
- **Claim budget cap** (`src/context/claim-budget.ts`) — `MAX_ACTIVE_CLAIMS=50`; `selectEvictionCandidates()` evicts lowest fitness→confidence→lastUsedAt; `project_rule`/`user_constraint`/`user_preference` exempt
- **Budget eviction in AgentLoop** — `refreshActiveClaims()` marks excess low-value claims stale before projection
- **/context reload** — Hot-reload project rules from `.rivet/rules/` at runtime
- **Goal loop rules** — Autonomous `--goal` mode also loads project rules on startup

### Added — Evolutionary Context Fabric Phase 4B
- **Recall tool rewrite** (`src/tools/recall.ts`) — Searches claim store by keyword (substring match), kind filter, limit param; replaces old PersistentStore-based recall
- **Claim export/import** (`src/context/claim-export.ts`) — `exportDurableClaims()` writes durable claims to JSON; `importClaims()` reads with 0.8x confidence decay and 'imported' tag
- **/context export** — Exports durable claims to `~/.rivet/exports/<timestamp>.json`
- **/context import** — Imports claims from JSON file with confidence decay

### Removed
- **PersistentStore** (`src/context/persistent-store.ts`) — Dead code; recall tool now uses ContextClaimStore
- `src/context/promotion.ts` — `evaluatePromotion()` now handles both `active → durable_candidate` and `durable_candidate → durable`
- `src/agent/session-persist.ts` — Added `loadPreviousDurableClaims()` and `injectDurableClaims()` methods
- `src/agent/loop.ts` — Wired antibody generation, conflict detection, file observation dedup, and antibody injection into `assessToolRisk`
- `src/agent/approval-risk.ts` — `assessToolRisk()` signature extended with optional `antibodies` parameter (backward-compatible default `[]`)
- `src/tools/delegate-task.ts` — Worker finding claims include file evidence path and confidence-based fitness
- `src/context/claim-store.ts` — Added `loadDurableClaims()` static method; incremental projection from previous session

### Fixed
- **DRY violation** — Duplicated durable claim injection in main.tsx extracted to `SessionPersist.injectDurableClaims()`
- **Duplicate promotion call** — Removed duplicate `promoteEligibleClaims()` at turn end; single call in `refreshActiveClaims()`
- **Lazy conflict detection** — `detectConflicts()` only runs when new `file_observation` proposals appear and claim count changed
- **Conflict text dedup** — Claims with identical normalized text no longer flagged as conflicts (e.g. repeated reads of same file)
- **Security finding false positives** — `bash` + security keywords now requires `isError: true`; clean `npm audit` output skipped
- **Enriched file_observation text** — Claims now include extracted export/function/class names (up to 8 symbols), e.g. `config.ts (42L): MAX_RETRIES, TIMEOUT, loadConfig`
- **Antibody TTL** — Antibody claims expire after 4 hours; previously never expired

### Verified
- 831 tests pass, 0 fail
- npm run typecheck clean
- All 8 ECF Phase 3 acceptance criteria verified

## 2026-05-16 — Wave 5 Trust Infrastructure + Wave 6 Goal Loop + Wave 7 Sub-Agent Wiring

### Added — Wave 5 Trust Infrastructure
- **Tool activation** — Registered inspect_project, repo_map, related_tests, undo tools; autoReasoning + lspEnabled wired into AgentLoop
- **Per-call undo** — FileHistory persistence with ring-buffer GC (50 snapshots max); `/undo` slash command for selective rewind
- **Context visibility** — `/context pin <text>` for manual anchor pinning; pinned anchors displayed in `/context` output
- **AgentLoop public API** — `addAnchor()`, `getLedger()`, `getFileHistory()` methods for TUI access
- **createContextLedger** accepts extraAnchors for user-pinned anchors

### Added — Wave 6 Goal Loop
- **`--goal` CLI flag** — `rivet --goal "text" [--budget N]` launches autonomous goal loop
- **Goal loop core** — Budget-capped iteration (default 100); 3-strike circuit breaker on consecutive API errors
- **Exit condition** — `checkGoalAchieved` with merged text + tool_result context
- **NDJSON streaming** — `--stream-json` outputs `goal_iteration` + `goal_complete` events
- **Tool errors vs API errors** — Tool-level errors don't trigger circuit breaker; only API errors count

### Added — Wave 7 Sub-Agent Wiring
- **delegate_task kind/profile** — Tool schema exposes optional `kind` and `profile` params; `isConcurrencySafe: true`
- **Profile-based tool selection** — `patcher`/`verifier` profiles get `WRITE_WORKER_TOOLS` (edit_file, write_file, bash, run_tests)
- **Failure escalation** — `CoordinatorState.shouldEscalate()` triggers after 3 consecutive non-passed events
- **Worker findings → claims** — `worker_finding` claims extracted from worker results into `ContextClaimStore`
- **Worker inherits active claims** — `WorkerSessionConfig.activeClaims` injected via `PromptEngine.updateActiveClaims()`
- **Goal loop + coordinator** — Goal loop `createAgent` creates `DelegationCoordinator` and registers `delegate_task`
- **delegate_batch tool** — Parallel worker execution (max 5 tasks) with configurable aggregation policy
- **maxWorkers=3** — Write profiles get `maxTurns=8` and larger token budget (8192)

### Verified
- 755+ tests pass
- npm run typecheck clean (0 errors)
- All 7 stories per wave verified (21 total)

## 2026-05-16 — Wave 2 Differentiation + Wave 3 UX Polish + Wave 4 Ecosystem Extension

### Added — Wave 2 Differentiation
- **Session forking** — `/fork` copies current session JSONL to new UUID for exploration branches
- **Approval edit** — `ApprovalResult` type with `editedInput`; AgentLoop backward-compatible
- **Auto reasoning** — Keyword-based effort selection (off/medium/high/max), opt-in via config
- **LSP diagnostics** — tsc output parser + PostToolUse hook for TS/JS file edits
- **HTTP/SSE Runtime API** — Router, SSE stream, GET /status, POST /abort, `rivet serve`

### Added — Wave 3 UX Polish
- **Vim keybindings** — normal/insert/visual state machine; h/l/w/b/0/$/dd/x motions; `/vim` toggle
- **@file autocomplete** — extractAtToken + getCompletions via git ls-files; Tab selection
- **Command palette** — Ctrl-K overlay; fuzzy filterCommands; 18 slash commands
- **External editor** — Ctrl-O spawns $VISUAL/$EDITOR; createTempFile + readAndCleanup
- **Git worktree isolation** — createWorktree/removeWorktree/listWorktrees; `--worktree` CLI

### Added — Wave 4 Ecosystem Extension
- **Streaming JSON** — `--stream-json` NDJSON events (text_delta, tool_use, tool_result, turn_complete)
- **POST /prompt SSE** — Prompt validation + SSE streaming via SseStream in rivet serve
- **Composable CLI** — Stdin pipe detection + auto-JSON for non-TTY stdout

### Verified
- 855 tests pass
- npm run typecheck clean
- 34 capabilities Verified (capability ledger)

## 2026-05-16 — Adaptive Context Fabric (ACF) Phase 1–4

### Added

**Phase 1 — Zero-Overflow Safety Layer:**
- `compactThresholds(contextWindow)` percentage-based thresholds scaling 8K to 1M windows — auto (80%), floor (60%), tool_result max (30%)
- Compaction policy (`src/context/compact-policy.ts`) as sole compact decision source — removed legacy double-AND gate with `shouldAutoCompact`
- Window-relative single `tool_result` size limit applied before early return in microCompact
- `AgentLoop.enforceContextCeiling()` last-resort 95% ceiling with cache-anchor + checkpoint-resume fallback
- Tier 4 reason updated: "emergency truncation required" → "context ceiling exceeded; checkpoint-resume required"

**Phase 2 — Structural Anchors + Cold Storage:**
- `PressureMonitor` PSI-style pressure/thrashing detection — tier, shouldCompact, thrashing (3+ compactions in 4-turn window), task_decomposition suggestion
- `AnchorRegistry` pinned structural anchors for user constraints (regex-based extraction) and decisions, with salience scoring, token budget enforcement, and low-salience eviction
- `PersistentStore` SHA-256 indexed cold storage — archive/retrieve/search with disk limit enforcement (oldest-first eviction)
- `ContextAnchor` extended with `user_constraint` kind

**Phase 3 — Provider-Aware Message Assembly:**
- `ProviderProfile` 6-provider cache profiles (deepseek exact-prefix, anthropic explicit-breakpoint, openai partial-prefix, google/qwen explicit-breakpoint, vllm block-kv)
- `CacheStrategy` provider-aware message assembly — injects `cache_control: { type: 'ephemeral' }` for explicit-breakpoint providers at anchor boundary
- `Message` type extended with optional `cache_control` field

**Phase 4 — Recall + Proactive Injection:**
- `recall` tool — retrieves archived tool results from PersistentStore by keyword/toolName/since/filter
- `buildProactiveContext()` — builds `<active-constraints>` XML block from anchors sorted by salience with token budget

### Changed

- `src/compact/constants.ts` — added `CompactThresholds` interface and `compactThresholds()` function; legacy `AUTO_COMPACT_THRESHOLD`/`MINIMUM_AUTO_COMPACT_TOKENS` preserved
- `src/compact/micro.ts` — `compactToolResultBlock` now receives `contextWindow`; Tier 1 tool_result truncation runs before early-return guard
- `src/agent/loop.ts` — removed `shouldAutoCompact` import and AND gate; calls `enforceContextCeiling()` before every API request
- `src/context/compact-policy.ts` — `tierForRatio` exported; Tier 4 reason changed
- `src/context/types.ts` — `ContextAnchor.kind` union includes `user_constraint`
- `src/api/types.ts` — `Message` interface extended with optional `cache_control`

### Verified

- 736/736 tests passing, typecheck clean, build succeeds
- DeepSeek prefix cache preserved: first 2 messages (CACHE_ANCHOR_MESSAGES=2) never modified
- 128K window test: 320K token fixture compacts to below 95% ceiling with anchors + resume state

---

## 2026-05-16 — Wave 3 UX Polish + Wave 4 Ecosystem Extension

### Added — Wave 3 UX Polish

- **Vim keybindings** — `src/tui/vim-mode.ts`: normal/insert/visual state machine; motions (h/l/w/b/0/$), dd (clear line), x (delete char), i/a/A/I (enter insert); `/vim` toggle; `BaseTextInput` vimEnabled prop
- **@file autocomplete** — `src/tui/file-completer.ts`: `extractAtToken` detects @-prefixed partial at cursor; `getCompletions` uses git ls-files with prefix-priority sort; `applyCompletion` replaces token and places cursor; InputBar Tab selection
- **Command palette** — `src/tui/command-palette.tsx`: Ctrl-K overlay; fuzzy subsequence `filterCommands` matching name + description; `getPaletteCommands` lists all 18 slash commands; ↑↓ navigation, Enter to execute, Esc to cancel
- **External editor** — `src/tui/external-editor.ts`: Ctrl-O spawns `$VISUAL`/`$EDITOR` (fallback vi); `createTempFile` + `readAndCleanup`; synchronous spawn with stdin/stdout inherit
- **Git worktree isolation** — `src/agent/worktree.ts`: `createWorktree`/`removeWorktree`/`listWorktrees`; `parseWorktreeList` handles detached HEAD; `--worktree` CLI flag with auto-chdir and cleanup on exit

### Added — Wave 4 Ecosystem Extension

- **Streaming JSON output** — `--stream-json` flag: NDJSON events (text_delta, tool_use, tool_result, turn_complete) written to stdout; non-streaming text/JSON modes unchanged
- **POST /prompt SSE endpoint** — `src/server/prompt-route.ts`: prompt validation (400 on missing), SSE streaming via SseStream; registered in `rivet serve` routes
- **Composable CLI** — stdin pipe detection: when stdin is not a TTY, read piped content as prompt; when stdout is not a TTY, auto-select JSON output format

### Changed

- `src/config/schema.ts` — Added `editorSchema` with `vim` boolean default
- `src/config/default.ts` — Added `editor.vim: false` default
- `src/tui/app.tsx` — Ctrl-K palette overlay, Ctrl-O editor, `/vim` toggle, palette state
- `src/tui/base-text-input.tsx` — `vimEnabled` prop support
- `src/tui/input.tsx` — `vimEnabled` prop passthrough
- `src/headless.ts` — `streamJson` field in config and args, NDJSON callback path
- `src/main.tsx` — `--worktree` flag, `--stream-json` passthrough, pipe detection
- `src/server/routes.ts` — Optional `PromptRouteDeps` parameter, `POST /prompt` registration

### Verified

- 855 tests pass (was 859)
- npm run typecheck clean
- 5 new test files: vim-mode, file-completer, command-palette, external-editor, worktree

## 2026-05-16 — Wave 1 Core Gaps Closed

### Added

- **Permission allow rules** — `src/agent/permissions.ts`: pattern matcher with exact, wildcard, and command-prefix support; `configSchema` extended with `permissions.allow`; `AgentLoop` approval short-circuits for allowlisted tool calls after risk assessment; allowlist does not skip risk tracking
- **Cost/token SummaryBar display** — `SummaryUsage` type with `inputTokens`/`outputTokens`/`cacheReadTokens`/`costUsd`; `summaryUsageFrom()` derives display state from `SessionContext.getTotalUsage()` without duplicate counting; SummaryBar line 3 and JSX render conditional token/cost display
- **Headless mode** — `src/headless.ts` with `parseCliArgs` (`-p`/`--print`, `--json`) and `runHeadless` (avoids Ink, collects output via callbacks, returns structured JSON with success/text/usage/error fields); `main.tsx` pre-Ink branch for headless args
- **Custom slash commands** — `src/commands/loader.ts` loads `.rivet/commands/*.md` in cwd; filters non-markdown, nested paths, and unsafe names (`COMMAND_NAME_RE`); `$ARGUMENTS` interpolation; `resolveAppPromptInput` resolves unknown slash commands after built-in handlers
- **First-run onboarding** — `src/onboarding.ts`: explicit sentinel file `~/.rivet/onboarding-dismissed` (not directory existence); `OnboardingPanel` Ink component with setup guidance; `/onboarding dismiss` only handles explicit command, never intercepts normal input

### Changed

- `src/config/schema.ts` — Extended `agentSchema` with `permissions.allow` array (pattern-matching rules)
- `src/config/default.ts` — Default `agent.permissions.allow: []`
- `src/agent/loop.ts` — Allowlist-aware approval short-circuit preserving risk tracking
- `src/main.tsx` — Headless CLI branch before Ink render; permissions config pass-through
- `src/tui/summary-bar.tsx` — Extended `SummaryState` with optional `usage`; token formatting helpers
- `src/tui/app.tsx` — Usage derivation from session; onboarding state/show/hide; custom command resolution before agent.run

### Verified

- 859 tests pass (was 702)
- npm run typecheck clean
- 5 new test files: permissions, headless, commands-loader, onboarding, schema

## 2026-05-16 — Cache Safety Layer

### Added

- `readFilePayload` shared helper — centralized validatePath + gitignore + offset/limit + truncation for both `read_file` tool and prewarm
- `prewarm-file.ts` — `buildPrewarmValue` (safe file read with size limit) and `canUsePrewarmForRead` (offset/limit guard)
- `PrewarmCache` now uses `PrewarmValue` type with canonical absolute path keys
- Per-cwd volatile caches — `.rivet.md` cache and git status cache both use per-cwd `Map` instead of module-level single values
- Prefix fingerprint covers stable volatile block (`stableVolatileSha256` in `PrefixFingerprint`)

### Fixed

- Prewarm cache bypasses `validatePath` and gitignore filtering → now uses `readFilePayload` for safe reads
- Prewarm cache key uses relative path on set but absolute path on get/invalidate → now uses canonical absolute path throughout
- Volatile caches not isolated by cwd → per-cwd `Map` prevents cross-project leakage
- 5 new tests: path traversal, gitignored files, canonical key, offset/limit bypass, cwd isolation

## 2026-05-16 — Multi-Session Isolation

### Added

- UUID session ID per TUI launch — `getOrCreateSessionId()` generates `crypto.randomUUID()` each time instead of reading from `session-id.txt`
- Session-scoped checkpoints — `checkpointFileForSession(sessionId)` with `CheckpointData.sessionId` field
- Checkpoint index — `checkpoint-index-<cwd>.json` tracks all sessions with checkpoints for a directory (cross-session discovery)
- Rollback session selection — `getRollbackPreview` and `rollbackToCheckpoint` accept optional `sessionId`, fallback to cwd-scoped legacy
- 7 new tests: UUID uniqueness, session-scoped paths, index tracking, selective removal, index deduplication

### Fixed

- Multiple TUI instances sharing the same session ID via `session-id.txt` → each launch gets unique ID
- Checkpoint files keyed by cwd slug → keyed by session ID, eliminates cross-session overwrite
- Session JSONL/memory files no longer conflict (natural isolation via unique session ID)

## 2026-05-16 — Capability Ledger Audit + Documentation Update

### Changed

- **Capability ledger audit**: 4 capabilities upgraded from Planned → Verified after codebase verification confirmed full implementation:
  - **P1 Remaining Gaps** — CockpitSnapshot aggregator, doom-loop strategy shift (4 pattern detectors), MCP tool risk rules in approval-risk
  - **Performance Optimization** — Non-blocking volatile-git stale cache, TUI log batching, incremental token accounting, smartCompact wired in main.tsx
  - **Capability Reliability Layer** — Path validation (path-validate.ts), checkpoint v2 (dirty snapshot + confirmation token + agent-owned files), safe output filenames (SHA-256), glob/grep cwd boundary + symlink cycle protection, run_tests safe argv filter, VerificationMetadata
  - **Harness Cockpit** — TraceStore, approval-risk assessment, 6 cockpit panels (trace/verify/context/safety/model/mcp), CockpitRail with status indicators, ModelCapabilityCard

### Updated

- Capability ledger: 18 Verified (was 14), 1 MVP, 1 Planned (Cache Safety), 2 Designed. 694 tests (now 702).
- README status line updated.
- CHANGELOG.md created.

### Known Remaining

- **CTCL Migration** (Designed) — tool input repair port from external repo
- **Open Source Harness Strategy** (Designed) — no implementation plan yet

## 2026-05-16 — Gap Closing Hardening

### Added

- Hooks error isolation — all `fire*` methods wrapped in try/catch
- `UserPromptSubmit` hook event — prompt chaining + block support
- `PreCompact` hook event — pre-compaction state preservation
- Git `log` action — oneline + decorate, configurable maxCount (1-100)
- Git `stash` action — stash working directory changes
- Git output truncation — 50KB max
- `TodoStore` class — worker-scoped concurrency safety with Zod validation
- `cleanupOrphans()` on FileHistory — removes unreferenced backup files

### Changed

- Web-fetch: regex `htmlToMarkdown()` replaced with turndown library (script/style stripped)
- Todo tool: module-level state → `TodoStore` instance with factory function
- 10 new tests across hooks, git, web-fetch, todo, file-history

## 2026-05-16 — Pastel Theme + Render Perf + Memory Safety

### Added

- Pastel color palette (default) with 256-color fallback
- `/theme [pastel|cyberpunk|list]` command
- Ring buffer for static items (500 cap)
- SessionContext collections bounded at 500 entries
- Braille sparkline for context token trend (last 20 turns)
- Rotating braille spinner in AgentStatus
- Memoized cockpit snapshot computation

## 2026-05-16 — Multi-pass Repair Pipeline

### Added

- 4-pass repair pipeline: syntax fix, type fix, import fix, semantic repair
- Schema gate strips invalid tool-use JSON before LLM retry
- Adaptive repair hint injection based on failure class
- Integration test covering full pipeline

## 2026-05-16 — Sub-agent Orchestration (Phase 1-4)

### Added

- WorkOrder/WorkerResult types with zod schemas
- Headless WorkerSession with independent context
- Priority queue with dedupe + dependency blocking
- 4 aggregation policies (primary_decides, all_required, first_success, majority)
- DelegationCoordinator with budget gate and batch dispatch
- Evidence status contract (verified/failed/blocked/unverified)
- Delivery gate blocks unverified worker results

## 2026-05-15 — P2 Capability Building

### Added

- MCP client (stdio/SSE, tool discovery, 5-class error classifier)
- Per-turn model routing (TaskInferrer + RoutingMetricsCollector)
- Repo intelligence (import graph + impact hint)
- Verification engine (VerificationState tracking)
- Failure sample library with secret redaction
- Cache diagnostic system (hit rate, miss reasons, drift detection)
- Progressive context engine (rounds, ledger, resume-preflight, session-memory)
