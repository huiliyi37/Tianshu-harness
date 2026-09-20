---
title: 真实会话数据佐证与指标观测 Harness
type: reference
status: active
date: 2026-08-28
tags: [cache, cvm, stigmergy, telemetry, observability]
---

# 真实会话数据佐证与指标观测 Harness

> README 简介里有三个大宣称：**前缀缓存命中率 95–99%**、**认知虚拟机（CVM）实时纠偏**、**信息素（Stigmergy）记忆**。
> 本文回答一个问题：这些是真机制还是宣传词？
> 做法：拿 5 个**真实工程会话**（修 bug、做功能、执行重构计划——不是演示脚本）的落盘日志逐条佐证，原始日志行照贴，每个聚合数字都附复算命令。
> 数据来自本仓库自举开发（用天枢开发天枢），采样区间 2026-08-09 ~ 08-26，文件路径已脱敏为仓库相对路径，不含任何对话正文。

## 读数据之前，先理解四件事

**① 前缀缓存是什么，为什么值钱。** DeepSeek API 会缓存每次请求的前缀：下一个请求如果前缀字节一致，一致部分按「缓存命中」计费——v4-flash 刊例价命中 **¥0.02/百万 tokens**，未命中 **¥1/百万**，差 50 倍。天枢把系统提示词 + 工具定义冻结成字节稳定的前缀，让每次请求尽量落在缓存上。**命中率不是性能指标，是直接的账单折扣。**

**② 星域是什么。** 星域 = 一套可切换的**认知纪律**，不是角色扮演皮肤。16 个内置域各是一种工程方法论的封装，进入某个域后有三样东西真实改变：**系统提示词**（该域的方法论）、**工具白名单**（worker 工具与域 `toolWhitelist` 求交集，太一域内置 14 件最小工具档）、**决策阈值**（`courageThreshold` 敢动手的门槛：破军 0.25 最敢闯、太一 0.95 最审慎、瑶光 0.7 要证据）。新会话默认钉定**启明**（全景洞察、根因推演），不自动切换；默认域设为 `auto` 才按任务关键词路由（池内为天权/开阳/瑶光/天梁 + 自定义域，太一等特化域只能手动 `/domain <name>`）。下文样本会话的「星域」列，就是该会话钉定的域——注意它的工具轨迹如何带上该域的纪律印记。

**③ CVM 是什么。** 认知虚拟机：运行时的一层拦截器，横跨 5 个生命周期阶段、按需装配 60+ hook 模块。它盯着模型的行为——改了文件没跑验证就想交付（验证债务）、重复调用同一工具空转（doom loop）、门禁规则被绕过——发现就注入纠偏。每一次拦截都在遥测里留台账。

**④ 信息素是什么。** 借鉴生物信息素的记忆机制：agent 的行为足迹（这个文件改过了、那个测试跑过了、这条死路别走了）作为标记落在文件上，带强度和**半衰期**（文件级 7 天），用得多的文件越来越熟，陈旧标记自动消失——不用手工维护记忆文件。

## 一、样本会话总览

五个会话，全部是 2026 年 8 月在本仓库上的真实工程任务：

| 会话 | 工程任务 | 星域 | 模型 | 时长 | 工具调用 | API 请求 | input tokens | 命中率 | 实际成本 | 无缓存成本 |
|------|---------|------|------|------|---------|---------|-------------|--------|---------|-----------|
| `c9774121` | 接手崩溃会话，执行「捆绑技能原生集成」重构计划 | 七杀 | v4-pro | 4.2 h | 430 | 412 | 116.2 M | 99.6% | ¥5.02 | ¥349.52 |
| `506a5e86` | 开源插件化：梳理本体可插件化模块并落地 | 瑶光 | v4-flash | 2.7 h | 414 | 348 | 89.0 M | 99.6% | ¥2.46 | ¥89.39 |
| `c170a6b1` | CLI 核心链路工程（bash 工具/hooks/compact/config） | 太一 | v4-flash | 18.9 h | 385 | 391 | 138.0 M | 99.6% | ¥3.56 | ¥138.43 |
| `11bf99ff` | 桌面端写文件服务中断的根因排查与修复 | 瑶光 | v4-flash | 8.3 h | 609 | 621 | 259.6 M | 99.3% | ¥7.63 | ¥260.31 |
| `766a0961` | 桌面端「运行时与关于」卡顿 + 版本显示修复 | 太一 | v4-flash | 3.4 h | 251 | 229 | 42.0 M | 99.5% | ¥1.29 | ¥42.32 |
| **合计** | — | — | — | 37.4 h | — | **2,001** | **644.8 M** | — | **¥19.96** | **¥879.97** |

成本按官方刊例估算（v4-pro：命中 ¥0.025/M、input ¥3/M、output ¥6/M；v4-flash：命中 ¥0.02/M、input ¥1/M、output ¥2/M；各会话按其 cache-log 逐请求记录的实际模型计费，公式与复算命令见文末「复算本文数字」）。

**怎么读这张表**：五个会话合计 6.45 亿 input tokens，如果每个 token 都按未命中计费是 ¥880，实际只花了 ¥20——**97.7% 的账单被前缀缓存吃掉了**。这就是「命中率 95–99%」换算成钱之后的样子。任务越重（`11bf99ff` 8.3 小时根因排查、2.6 亿 tokens），缓存省得越狠。

## 二、主样本解剖：`c9774121` 的四小时

把总览表第一行拆开看。这个会话是五个样本里证据链最完整的：有计划文档、有交付记录、有 git 提交三点对齐。

### 2.1 任务与证据链

- **任务**：上一个会话崩溃了，留下一份未执行完的重构计划 `docs/plans/2026-08-25-bundled-skills-native-integration.md`（把 writing-plans/executing-plans 等捆绑技能消融为原生提示块，三项技能撤出默认分发）。用户让新会话**接手续作**。
- **星域**：七杀（肃秋剪枝官——精简冗余、清理死代码的认知纪律）。任务是「瘦身」，域是「剪枝」，正好对口。
- **证据链**：会话内首次 `deliver_task`（交付工具）调用发生在 **22:54:59**（本地时间，下同）；**31 秒后** git 落地 commit `13a9861d9`（22:55:30），提交主题正是「捆绑技能瘦身为原生集成」。计划 → 交付 → 提交，三点成线，`git log` 可复核。全程共 **23 次 deliver_task**（分波交付，每波过交付门禁）。

### 2.2 缓存：上下文涨 15 倍，命中率不降反升

每个 API 请求落一行 `cache-log.jsonl`。会话的第一行和最后一行原样照贴（删了几个次要字段）：

```json
{"turn":0,"model":"deepseek-v4-pro","input":34389,"cacheRead":23808,"cacheCreate":10581,"hitRate":"69.2%","output":477}
{"turn":15,"model":"deepseek-v4-pro","input":510876,"cacheRead":510720,"cacheCreate":156,"hitRate":"100.0%","output":579}
```

**逐子会话命中表**。「子会话」= 轮次计数重置的区间：四小时里发生了 15 次（压缩、边界切换都会重置），每个新区间的第一个请求要重建一次前缀：

| 子会话 | 请求数 | 首轮命中 | 稳态命中 | input 范围 |
|--------|-------|---------|---------|-----------|
| 1 | 7 | 69.2% | 91.6–98.9% | 34K→46K |
| 2 | 84 | 83.3% | 95.5–99.9% | 56K→124K |
| 3 | 2 | 94.0% | 97.1% | 133K→136K |
| 4 | 16 | 94.0% | 99.2–99.9% | 145K→162K |
| 5 | 8 | 94.9% | 98.9–99.9% | 170K→179K |
| 6 | 22 | 95.4% | 98.5–99.9% | 188K→210K |
| 7 | 10 | 95.6% | 93.3–99.9% | 219K→250K |
| 8 | 23 | 96.6% | 99.4–100% | 259K→276K |
| 9 | 51 | 95.3% | 99.4–100% | 289K→317K |
| 10 | 25 | 97.3% | 99.7–100% | 327K→338K |
| 11 | 17 | 97.3% | 99.7–100% | 347K→356K |
| 12 | 75 | 97.6% | 99.7–100% | 364K→402K |
| 13 | 20 | 97.8% | 99.4–100% | 411K→423K |
| 14 | 33 | 97.9% | 99.8–100% | 432K–452K |
| 15 | 19 | 98.3% | 94.8–100% | 460K→512K |

**这张表读出三个结论**：

1. **首轮命中逐段爬升**（69% → 83% → 94% → … → 98%）。会话越往后，服务商缓存里已有的前缀越多，子会话切换后的重建只需要补增量，不再是大面积 miss。
2. **input 从 34K 涨到 512K**——四小时里上下文膨胀 15 倍，稳态命中反而从 92–99% 升到 99.7–100%。前缀缓存工程的核心承诺正是这条：**上下文变长不摧毁命中率**。
3. **15 次前缀重建的总代价只有 383K cacheCreate**（占 116.2M 总 input 的 0.33%）。重建便宜，所以敢在边界主动压缩，而不是硬撑着一个又臭又长的前缀。

### 2.3 工具轨迹：422 次调用在干什么

`tool-result-trace.jsonl` 逐次调用落行（trace 口径 422 条；`meta.json` 记 430 次，差额为未落 trace 的调用）。分布（前七名覆盖 94%）：

```
143 bash        76 grep        68 edit_file    58 read_file
 23 deliver_task  18 job        11 todo         6 run_tests
（另有 write_file×4 / plan×4 / glob×4 / git×2 等，合计 422 条）
```

开头 40 步的真实轨迹：

```
read_file → git → grep ×12 → read_file → read_file → todo → bash → bash
→ grep ×4 → todo → bash → read_file → grep → read_file → grep → grep
→ read_file → edit_file → bash → bash → grep → glob → grep → bash → read_file → read_file
```

**怎么读**：先 `read_file` 读计划文档、`git` 查工作区状态，然后 **12 连 grep 全域侦察**（七杀域的取证纪律：剪枝前先搞清每个技能的每一处引用），再列 `todo`、逐波 `edit_file` 改代码、`run_tests` 验证、`deliver_task` 交付。68 次 edit_file 是真改代码，23 次 deliver_task 是分波过门禁——这不是聊天，是施工。

### 2.4 信息素：42 条行为标记

会话结束时的 `pheromones.json` 共 42 条，分布与含义：

| 信号 | 数量 | 含义 |
|------|------|------|
| `well-tested` | 28 | 该文件有测试覆盖/刚跑过验证 |
| `fragile` | 7 | 该文件脆弱易碎，改动要格外小心 |
| `dead-end` | 2 | 此路不通，别再往这个方向试 |
| `entry-point` | 1 | 关键入口文件 |
| virtue-signal | 4 | 对模型良好行为的正向标记（见下） |

文件级样本（半衰期 7 天，`halfLife` 单位毫秒）：

```json
{"path":"src/prompt/engine.ts","signal":"well-tested","strength":0.6,"halfLife":604800000}
{"path":"src/tui/command-palette.ts","signal":"fragile","strength":0.8,"halfLife":604800000}
```

四条 virtue-signal（半衰期 14 天）是这套机制里最有意思的部分——**不只记错误，也记美德**：

| 信号 | 场景 |
|------|------|
| `independent-judgment` | 模型在置信度充足时选择质疑而非附和——仁者必有勇 |
| `proactive-verification` | 模型在无人要求时主动运行测试——义之所在，不待人言 |
| `strategic-awareness` | 模型在重复操作后觉察并调整策略——知止不殆 |
| `cache-loyalty` | 模型保护了前缀缓存的连续性——信者，天枢之本也 |

### 2.5 CVM：84 次认知拦截与 219 次体检

`sensorium.jsonl` 里的认知遥测（本会话计数）：

- **`cvm-vector-decision` × 84** —— CVM 的拦截台账：`gate-blocked` × 63（门禁拦截，如改动未验证就想交付）、`verification-debt` × 21（验证债务：检测到「改了文件 + 交付未验证」的状态并注入纠偏）。实录一条：

```json
{"kind":"cvm-vector-decision","turn":24,"mode":"shadow","classification":"verification-debt","ruleId":"CV1","facts":{"filesModified":1,"deliveryStatus":"unverified"}}
```

- **`vitals-lite` × 219** —— 定期认知体检：六维状态（动量/压力/置信/验证覆盖/复杂度/新鲜度）+ doom-loop 等级。本会话压力值 0.16–0.46，上下文占用 30–51%，**doom-loop 等级 219 次快照全程 `none`**——四小时工程没有出现一次重复空转。
- **`runtime-hook-health` × 36** —— 每个 hook 的耗时体检：最慢的 `meridian-index`（仓库索引钩子）26 次超慢阈值——hook 开销可见、可归因，不会无声拖慢循环。

## 三、其余四个样本的亮点

- **`766a0961`**（太一域，修桌面端 UI bug）：工具轨迹里 `browser_debug` × 41——改完界面自己截图、比对、再改的**视觉验证闭环**，不靠嘴说「修好了」。
- **`c170a6b1`**（太一域，18.9 小时）：五样本里最长会话。太一域只装配 14 件最小工具，照样撑完 138M input 的长程工程——最小工具集不是玩具。
- **`11bf99ff`**（瑶光域，8.3 小时）：最大体量样本：621 次 API 请求、2.6 亿 input tokens、`bash` × 388——一场根因排查马拉松，无缓存要 ¥260，实际 ¥7.63。
- **`506a5e86`**（瑶光域）：`edit_file` × 76 + `write_file` × 27 的重度改造型工程，会话沉积 32 条信息素。

## 四、观测 Harness：自己怎么看这些数据

### 数据落点（每会话一套）

会话目录：`~/.rivet/sessions/<项目slug>/<会话id>/`（Windows：`%LOCALAPPDATA%\.rivet`；`RIVET_SESSION_DIR` 可覆盖）。不用记路径——`rivet logs` 或 TUI 里 `/logs` 直接打出本会话全部落点。

| 文件 | 内容 | 门控 |
|------|------|------|
| `<id>.jsonl` | 对话主体（含每轮 `usage` 的 cache_read/cache_create）。**注意：zstd 压缩存储**，直接 cat 是乱码，`zstd -dc <file>` 解压阅读 | 始终 |
| `<id>.meta.json` | 元数据：模型、星域、轮次、tokenUsage、守门统计 | 始终 |
| `<id>/cache-log.jsonl` | 逐请求缓存指标（含 side_path 侧路成本） | 始终（有 usage 才落行） |
| `<id>/tool-result-trace.jsonl` | 逐工具调用轨迹 | 始终 |
| `<id>/pheromones.json` | 会话内信息素 | 有沉积才写 |
| `<id>/sensorium.jsonl` | CVM 拦截台账、hook 健康、认知体检 | 轻量行默认开；全量需 `RIVET_DEBUG_TELEMETRY`（任意非空） |
| `<id>/frames.jsonl` | 认知帧（相位、策略） | 默认开；`RIVET_FRAME_TELEMETRY=0` 关 |
| `<id>.frozen.json` | 冻结前缀快照（resume 缓存继承） | 每个 user 边界 + shutdown |
| `<id>.handoff.md` | 交接文档（shutdown 兜底摘要 / `/handoff` 精写） | 会话结束或手动 |

### 会话内实时观测

- **GlanceBar 状态栏** —— 输入框上方实时显示缓存命中率、上下文占比、本轮成本
- **`/debug cache`** —— 命中率、未命中原因分析、每回合缓存历史
- **`/logs`** —— 本会话全部数据落点（含写入门控说明）
- **`/cockpit`** —— 8 面板全屏：doom-loop 等级、验证交付状态、缓存与投机预读统计、MCP、advisory

### 分析脚本（仓库 `scripts/`，全部 `npx tsx` 直跑）

| 脚本 | 用途 |
|------|------|
| `verify-cache-hit-rate.ts` | 模拟 5 轮对话，实测逐轮命中率（需 `DEEPSEEK_API_KEY`） |
| `verify-summary-cache-hit-rate.ts` | 压缩摘要侧路（生产形态）的缓存命中率 |
| `audit-usage-ledgers.ts` | 双账本对账：meta.tokenUsage vs cache-log（`--slug <项目名>` 限定） |
| `analyze-output-tokens.ts` | output token 分解：钱花在哪类输出上 |
| `analyze-compact-events.ts` | 压缩事件审计：每次上下文压缩是否必要、成本多少 |
| `prefix-budget.ts` | 前缀预算审计：主控注意力分配在哪个提示块 |
| `self-audit-report.ts` | 只读扫描会话目录，聚合输出 Markdown 自评测报告（`--quick` 跳慢速扫描） |
| `quality-baseline.ts` | 从会话 jsonl 计算行为指标基线（质量探针） |

### 遥测开关

| 变量 | 作用 |
|------|------|
| `RIVET_DEBUG_TELEMETRY` | 任意非空开全量 `sensorium.jsonl`；字面 `1` 额外拉起 TUI perf 行 |
| `RIVET_TELEMETRY_LITE=0` | 连 vitals-lite 轻量行一起关（默认开） |
| `RIVET_FRAME_TELEMETRY=0` | 关认知帧 `frames.jsonl` |
| `RIVET_SESSION_DIR` | 搬走整棵会话树 |

### 复算本文数字

```bash
cd ~/.rivet/sessions/<slug>/<sessionId>

# 总体命中率（cache-inclusive 口径）
jq -s 'map(select(.event == null)) | (map(.cacheRead)|add) / (map(.input)|add)' cache-log.jsonl

# 成本估算（刊例：v4-flash 命中 ¥0.02/input ¥1/output ¥2；v4-pro 命中 ¥0.025/input ¥3/output ¥6，单位 ¥/M tokens）
# 实际成本 = cacheRead×命中价 + (input−cacheRead)×input价 + output×output价
jq -s 'map(select(.event == null)) |
  (if .[0].model == "deepseek-v4-pro" then {r:0.025, i:3, o:6} else {r:0.02, i:1, o:2} end) as $p |
  ((map(.cacheRead)|add)*$p.r + (map(.input-.cacheRead)|add)*$p.i + (map(.output)|add)*$p.o) / 1000000' cache-log.jsonl

# 工具调用分布
jq -r '.name' tool-result-trace.jsonl | sort | uniq -c | sort -rn

# CVM 拦截计数与分类
jq -r 'select(.kind=="cvm-vector-decision") | .classification' sensorium.jsonl | sort | uniq -c

# 阅读对话主体（zstd 压缩）
zstd -dc <id>.jsonl | less
```

## 五、口径与局限

- **命中率** = `cacheRead / input`（cache-inclusive），与官方账单口径一致。
- **成本是刊例估算**，非账单实扣：不含优惠、赠送额度与阶梯价；cacheWrite 与未命中 input 同价（flash ¥1/M、pro ¥3/M），公式中合并计算。各会话按 cache-log 的**请求级 model 字段**判定模型（`meta.json` 的 model 字段可能是会话后期改过的，以请求记录为准——主样本 `c9774121` 全程 v4-pro）。
- **样本是快照**（2026-08）：不同任务/模型/时长的命中率会浮动，「稳态 95–99%」是长会话经验区间，冷启动短会话会低。
- 信息素为**会话内**作用域；跨会话共享知识在项目内 `.rivet/knowledge/memory.jsonl`。
- 本文只引用遥测与计数字段，不含对话正文；主对话 `.jsonl` 为 zstd 压缩存储，本文撰写时未解压引用。
- 样本会话 ID 已做短缩（前 8 位）；这些数字的价值在于「可复算」而非「永远如此」——「观测 Harness」一节长期有效。
