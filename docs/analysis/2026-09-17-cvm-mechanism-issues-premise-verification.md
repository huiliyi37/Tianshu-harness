---
title: CVM 机制讨论四条 issue 的前提验证（#170–#173）
type: analysis
status: draft
date: 2026-09-17
related: []
---

# CVM 机制讨论四条 issue 的前提验证（#170–#173）

> 结论先行：四条「机制讨论」的**事实前提基本站得住**（逐条带行号可复核），但其中两条对自己的**现状描述偏保守**——仓里已有的等价物比它们以为的多；另有一条的一处前提（"effort routing 是固定启发式"）**不成立**。

本文是**贡献者提供的前提验证**，不是维护者结论。验证快照 `main@f843d87`，方法分三层：
真模块 import 读数（比 grep 硬）、仓内自带套件、以及一条新增的 loop 级端到端表征测试。
四条 issue 都在正文里明确邀请纠错（"如果这个机制其实已有实现而我没找到，请直接指出"），本文即对该邀请的兑现。

## 结论

1. **#173 的现状描述最扎实，两条承重断言经端到端验证成立**：纪律重锚确实每 15 次工具调用无条件提交，且 6 个变体全部是【天梁】——破军会话同样收到交付纪律。新增测试 `src/agent/__tests__/discipline-reanchor-domain-independence.test.ts` 把它从"读源码推断"变成"一条可执行断言"。
2. **#171 的现状描述全对**（16 域、破军 0.25 / 太一 0.95、活引用、T7 的 ±0.15 与 cap 0.79 精确命中），**但有一处前提不成立**：effort routing 并非固定启发式，仓里已有 LinUCB bandit 在自适应它。
3. **#170 的缺口判断成立**（hook 的 block/gate 形态确无行为签名核销，"伪 expect 禁止"逐字命中源码注释），**但"不是新建度量体系"低估了等价物**——`bandit-promotion` + `gated-influence-evaluation` 已经把"效果档案 → 晋升/降级"做出来了，只是没覆盖 hook 形态。
4. **#172 的两句引用逐字命中**；但"审批路径上是否已有独立第二意见"两次不同广度的搜索都没找到，**未穷尽，标为疑问而非结论**。
5. 四条**共同缺同一件东西**：只论证"为什么该做"，没论证"为什么现在、越界的代价是什么"。而仓里恰有三处是被刻意推迟或封顶的（见下），说明维护者对"让机器自己调自己"有既定保守口径。

## 证据

### 三层验证手段

**① 真模块探针**（本地一次性脚本，未入库——等价于下面几行：直接 import 生产模块读值，非 grep）

```ts
Object.entries(STAR_DOMAINS).map(([id, d]) => [id, d.courageThreshold])  // 16 个域
disciplineReanchorEntry()                                               // ×500，统计变体集合
DISCIPLINE_REANCHOR_INTERVAL; CONSTITUTIONAL_PRIORITY                   // 直接读常量
```

```
【星域数】16（StarDomainId 是 16 成员联合类型，域数受类型强制）
【最低】pojun = 0.25   【最高】taiyi = 0.95
【去重后的阈值集合】0.25, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 0.95
【DISCIPLINE_REANCHOR_INTERVAL】15
【CONSTITUTIONAL_PRIORITY】0.9
【disciplineReanchorEntry 500 次抽到 6 个不同变体】
【其中含「【天梁】」的】6 / 6      【不含「【天梁】」的】0 []
```

**② 仓内自带套件（12 个相关套件）**

```
ℹ tests 237   ℹ pass 237   ℹ fail 0
```

覆盖 `advisory-bus` / `advisory-readback` / `advisory-holdout` / `advisory-expect-coverage` / `advisory-lift-consumer` / `advisory-lifecycle` / `bandit-promotion` / `gated-influence-evaluation` / `discipline-eligibility` / `domain-advisory-tone` / `star-domain-registry` / `courage-hook`。

**③ 新增 loop 级端到端表征测试**（真 `AgentLoop` + mock stream client，不需 API key）

```
▶ 纪律重锚与星域解耦（issue #173 表征）
  ✔ 第 14 次不提交、第 15 次提交一次——钉住 DISCIPLINE_REANCHOR_INTERVAL 边界
  ✔ 破军会话（低勇气阈值域）收到的仍是【天梁】交付纪律
  ✔ 两端星域（破军 0.25 / 太一 0.95）拿到的是同一套纪律文本
ℹ tests 3   ℹ pass 3   ℹ fail 0
```

> ⚠ 该文件钉的是**当时的行为**，不是对它的背书。若 #173 被接受（纪律文本按（星域, 任务类型）二元组取材），这些断言应随之**重写**，而不是被当作回归。它的用途是给那次讨论一个可执行的锚点。

### 逐条对应

| issue | 断言 | 验证结果 |
|---|---|---|
| #171 | `courageThreshold` 每域静态、运行中活引用 | ✅ `star-domain-data.ts:61` 起 16 域；`courage-hook.ts:97` 活引用；`loop-factory.ts:690` 逐字命中 |
| #171 | 16 域，破军 0.25 → 太一 0.95 | ✅ 运行时读数（上表） |
| #171 | T7 让采纳数据在 ±0.15 内调优先级、上限 0.79 | ✅ `advisory-bus.ts:339` `DEFAULT_EFFICACY_PRIORITY_SPAN = 0.15`、`:345` `EFFICACY_PRIORITY_CAP = 0.79` |
| #171 | effort routing 判据是**固定启发式** | ❌ **不成立**，见下 |
| #170 | 只有带 expect 谓词的条目参与采纳统计 | ✅ `advisory-bus.ts:22` / `:871` / `:1139`（"必须带 expect 谓词"）、`advisory-readback.ts:10`、`loop.ts:683` / `:769`、`turn-orchestrator.ts:1081` |
| #170 | courage 的风险臂因伪 expect 禁止被排除 | ✅ `courage-hook.ts:111-118`，注释原文含"伪 expect 禁止"：constitutional 臂带 `expect: { kind: 'tool_appears', … }`，risk 臂刻意不带 |
| #170 | "72 个 hook" | ◐ `src/agent/hooks/*.ts` = **74** 个（差 2，或为"已注册"口径，未核） |
| #173 | 六个重锚变体全是【天梁】 | ✅ `advisory-bus.ts:202` 起 `DISCIPLINE_VARIANTS` 六条；运行时 500 次抽样 6/6 |
| #173 | `loop.ts` 每 15 次工具调用无条件提交 | ✅ `loop.ts:1198-1202`（`recordToolHistory` 内只有计数器，无域条件）；端到端测试通过 |
| #173 | 自主判断型星域 advisory 预算降为 1 | ✅ `advisory-bus.ts:143` `SELF_DIRECTED_DOMAIN_BUDGET = 1`（对 `:141` `MAX_ADVISORIES_PER_TURN = 3`） |
| #173 | `domain-advisory-tone.ts` 16 域仅 1 词条 | ✅ 全文件 63 行，只有天权条目 |
| #173 | `IntentTaskKind` 12 值、无数据分析/文档/运维 | ✅ `intent-retrieval-route.ts:14-26` 恰 12 值，全代码类 |
| #173 | `loop.ts:2074` 工程任务才注入并行调研情报 | ✅ `isEngineeringTask = requiresEngineeringDiscipline ?? isContractActionable` 门控 `plan-scout-parallel` |
| #172 | `approval-risk.ts` 两句注释 | ✅ `:21` `Match dangerous *intent*, not just keywords`；`:50` `误报只是多一次审批，漏报是静默 rm -rf。` |

### 两处对 issue 现状描述的修正

**(a) #171："effort routing 也是固定启发式"不成立。**
仓里有整套 LinUCB bandit：`linucb-bandit.ts`、`model-tier-bandit.ts`、`team-scheduler-bandit.ts`、`adaptive-routing.ts`，`bandit:reasoning_effort` 状态持久化（`loop.ts:2420`、`session-memory-warmup.ts:44`），且 `effort_bandit` 本身就是一个 gated influence source（`gated-influence-audit.ts:7`）。
即**证据早就在喂 effort 本身**，不只是喂排序优先级（#171 原话"把证据喂养参数从排序优先级延伸到触发阈值"）。这削弱了新颖性主张，但**加强了可行性**：插槽是现成的。
同理"起步形态：shadow 模式"也不是新设计——`bandit-promotion.ts` 就是"统一 bandit shadow→gated 晋升闸"，四档 `off/shadow/auto/forced`，false-green 自动降回 shadow。新阈值应默认接这个闸。

**(b) #170："不是新建度量体系"低估了等价物。**
`gated-influence-evaluation.ts` 已产出 per-source 效果档案 —— `InfluenceEvaluationMetrics` 含 `totalShadowSamples` / `gateOpenCount` / `appliedCount` / `vetoCounts` / `averageRewardByCandidate` / `falseGreenRate` / `scopeLeakRate` / `ruleAgreementRate` / `regretEstimate`，并给出**四态建议** `keep_shadow_only` / `allow_manual_opt_in` / `allow_limited_default_on` / `disable_and_investigate`。
这与 #170 提议的"hook 效果档案 + 晋升/降频"是同构的，只是覆盖面不同：`GatedInfluenceSource` 现为 6 值（`team_scheduler_bandit` / `model_tier_bandit` / `model_routing` / `plan_cache_advisory` / `physarum_supervision` / `effort_bandit`），**确无 hook**。
此外仓里还有：`create-runtime-hooks.ts:836` 的 async-copilot hook 已具备"可行性双闸门 + 自我淘汰降频"；`immune-adaptive.ts` 的 affinity maturation + memory decay。所以零星防线**并非全无退役机制**——"没有任何机制回答『这道门禁还在挣它的位置吗』"这句偏强。

## 根因分析

四条提议的偏差方向一致：**对"从零开始"的低估**。因果链是——

直接原因：四条都以"读源码 + 关键词定位"建立现状，而机制的落点常在不同名的文件里（`bandit-promotion` / `gated-influence-evaluation` / `immune-adaptive` 都不是从 hook 或 advisory 的名字出发能找到的），于是"没想到去找"变成"以为不存在"。

系统性根因：仓里对"让机器自己调自己"有**既定的保守口径**，而提议没有正面回应它。三处证据：

1. `advisory-bus.ts:373`「**本轮只度量不自动退役**；lift 数据积累后再做规则退役。」——退役是**刻意的推迟决策**，不是遗漏。advisory 自己的自动退役都还没开。
2. `advisory-bus.ts:1087` / `:1099`——cap 0.79 的存在理由是不击穿 `CONSTITUTIONAL_PRIORITY(0.9)` 的豁免线（注释："不进 clamp——否则 CONSTITUTIONAL_PRIORITY(0.9) 会被压到 0.79"）。即早有人为"自适应不得越过某条线"立了先例。
3. `bandit-promotion.ts` 默认 `shadow`、永不自动 `apply`，直到证据达标。

因此这些提议的**真正待答问题不是"机制该怎么建"，而是"越界的下界不变量是什么、以及为什么现在就该开"**。#171 自己引了七杀误读 `courageThreshold` 语义的教训并主张"判据先立"——这是四条里唯一主动设限的地方，方向正确；另外三条尚未给出同类不变量。

## 未闭合 / 未验证

- **真模型会话级**未验证（本环境未配 API key）。已验证到 loop 级端到端为止；模型行为不属机制验证范围。
- #170 的"72 个 hook"计数口径未核（实测 74 个文件）。
- "courage 风险臂"在账本里的**具体归属**未逐行确认（但 `courage-hook.ts:111-118` 的伪 expect 注释逐字命中，方向确定）。
- #172 的"审批路径无独立第二意见"：两次不同广度的搜索均未命中（全仓 `second opinion|独立审计|llm audit|audit.*approval` 只命中 `src/tools/syntax-check.ts`；`destructive-gate.ts` / `attack-case.ts` 零处调模型），**但未穷尽**，不作为"不存在"的结论。
- 四条均**未做性能/成本测量**（如 #172 的审计延迟、#170 的账本开销）。

## 行动项

- [ ] #170：把 hook 的 block/gate 形态纳入 `GatedInfluenceSource` 并复用 `bandit-promotion` 的晋升闸，而不是新造并行的"hook 效果档案"
- [ ] #171：自适应阈值默认接 `bandit-promotion` 的 `shadow` 档；先立"不可越界的下界不变量"（对应 cap 0.79 的先例）
- [ ] #173：给出 `IntentTaskKind` 分类轴扩张的代价评估——它下游挂着 intent router → retrieval route → `discipline-eligibility` → plan-mode 门控链
- [ ] 需维护者表态：`advisory-bus.ts:373` 的"只度量不自动退役"是否仍为现行口径；若是，#170 应先回答"为什么 hook 先于 advisory 开自动退役"
