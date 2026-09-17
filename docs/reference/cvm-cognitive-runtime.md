---
title: CVM：从 Transformer 共享退化到认知运行时
type: reference
status: active
date: 2026-09-17
tags: [cvm, theory, anchor-collapse]
related: [../CVM运行时对Agent模型的实证影响.md, observability-harness.md]
---

# 天枢 CVM：从 Transformer 共享退化到认知运行时

> 核心理念文档 · v0.1 —— 理论框架 / 实证整理 / 后续研究基线。
> **模型提供认知能力，CVM 提供认知执行语义。LLM provides cognition. CVM provides execution semantics.**

## 摘要

天枢在长期搭建、运行和迭代多模型 Agent 环境的过程中，反复观察到一个重要现象：不同的 Transformer-based Agent Model，尽管模型规模、训练数据、对齐方式和推理能力不同，却会持续表现出一组高度同构的运行时退化模式。

这些退化包括但不限于：

- 用户质疑后快速投降；
- 过度服从字面指令；
- 局部高显著性信息压过全局目标；
- 在分析阶段形成正确判断，却在确认/执行阶段退回默认服从策略；
- 长上下文中持续被早期结论支配；
- 反复调用同类工具却没有真实推进；
- 明明"知道"某条规则，却无法让该规则跨轮次、跨会话稳定约束行为；
- 在高压上下文中逐渐向局部、重复、低成本决策坍缩。

天枢最初试图通过 Prompt、信念注入、行为提醒等方式修复这些问题。但随着实验推进，一个更深的结论逐渐浮现：**真正缺失的不是一个更好的 Prompt，而是一个独立于模型之外的认知运行时。**

这就是 CVM（Cognitive Virtual Machine，认知虚拟机）的来源。CVM 并不试图改变模型权重，也不把模型变成确定性程序。它做的是在概率模型之外建立一套可观测、可控制、可验证、可回放的执行环境，用来管理模型的状态、目标、计划、证据、资源、权限和生命周期。

## 一、问题不是"模型不够聪明"

现代大模型已经拥有非常强的知识、推理、编程和规划能力。但在真实 Agent 环境中，我们持续遇到一种看似矛盾的情况：模型明明具备解决问题的能力，却在真实执行中反复做出明显低于其能力上限的行为。

这意味着必须区分两个概念：

```
Capability（能力上限） ≠ Runtime Behavior（实际运行行为）
```

模型权重决定它理论上能做到什么。但模型真正做出什么行为，还受到：当前上下文、历史 token、显著性锚点、instruction tuning、RLHF / preference training、当前阶段、用户最近一句话、工具反馈、上下文长度、失败历史、自回归连续性的共同影响。

因此：模型失败，并不总意味着模型缺乏能力。很多时候，它意味着模型在当前运行轨迹中进入了一个错误的吸引域。天枢真正想解决的，就是这个问题。

## 二、从"注意力锁定"到 Cognitive Anchor Collapse

早期实验中，我们使用过"注意力锁定""锚点锁定"等描述。随着实证积累，更准确的定义应该是：

**Cognitive Anchor Collapse**——当模型面对一个或多个高显著性局部信号时，其策略分布过度集中到这些信号上，使全局目标、后续证据、反事实信息或先前形成的高质量判断失去足够权重，最终导致行为向局部锚点收缩。

```
局部信号 → 获得过高权重 → 压制全局目标 → 策略空间收缩 → 行为坍缩
```

这里的"锚点"不只意味着一个关键词。它可以来自多个层面。

## 三、四类认知锚点

### 3.1 Lexical Anchor：词汇锚点

最简单的形式是某些关键词本身，例如：`修改` `删除` `修复` `完成` `安全` `解释` `为什么` `不要` `立即`。

训练数据中，如果某些词长期和某些行为高度相关——"修复" → 修改代码，"为什么" → 解释问题，"删除" → 删除内容——模型就会学到一个低成本 shortcut。于是当完整句意图与这些词冲突时：

> 不要修改/修复/删除代码，我只是想知道为什么报错。

模型可能仍然被"修改 / 修复 / 删除"吸走。这就是 Anchor Collapse Benchmark v0.2 中人为复现的最小现象。

### 3.2 Semantic Anchor：语义锚点

比关键词更强的是一个局部事实，例如："文件已经存在""测试已经通过""用户很赶时间""README 写的是这样"。

这些信息本身可能完全正确。问题在于：模型会把一个局部正确事实提升为整个任务的解释中心。

天枢早期信念宪法 A/B 实验（`STAR_SOUL` 开关）中的 T4 就是典型案例。A 组看到"文件已经存在"，行为逐渐坍缩成：文件存在 → 不需要做 → 报告问题 → 不执行。而 B 组结合完整目标（用户赶时间 + 工具当前不可用 + 真实意图是"让它工作"），最终执行了真正的修复。两组使用的是同一个模型权重，改变的是运行环境。

### 3.3 Policy Anchor：策略锚点

第三类更深。它不是某个词义，而是 instruction tuning / preference training 形成的行为先验：

```
用户确认 → 停止质疑 → 进入执行
用户说"你错了" → 快速道歉 → 接受用户判断
用户要求"快一点" → 减少探索 → 快速输出
```

这不是普通 lexical association，它更像训练形成的 policy shortcut。

天枢 T3 的"分析 → 执行过渡带衰减"非常接近这一类问题：模型在分析阶段主动质疑、主动询问 scope、提出折中方案；但用户一旦说"按照你的计划执行"，模型就开始退回默认执行策略，之前形成的高质量判断没有真正成为稳定的运行时状态。这说明：**模型的正确认知并不等于正确认知能够持续约束执行。**

### 3.4 Historical Anchor：历史锚点

第四类来自长上下文。模型在早期建立一个结论（Turn 3：原因可能是 A），后来真实环境已经变化（Turn 20：出现证据 B），但模型仍然继续围绕 A 工作：

```
旧假设 → 成为注意力中心 → 新证据被解释成旧假设的附属 → 行为继续沿旧轨迹执行
```

这类问题在长程 Agent 任务中尤其危险。上下文越长，Agent 越容易拥有大量"已经被写进历史"的解释。如果缺少独立 Runtime State，`messages[]` 会同时承担记忆、状态、历史、控制、解释、任务目标——最终状态不可避免地变得模糊。

## 四、Anchor Collapse 不只是 Attention 问题

必须明确一个边界：Attention weight 本身不能直接证明因果。Cognitive Anchor Collapse 不应该被简单描述成"Transformer 某个 attention head 看错了词"。更合理的是把它视为多个机制共同作用的运行时现象：

```
Attention + Representation + Autoregressive Continuation
+ Instruction Tuning + Preference/RLHF Prior + Context History + Tool Feedback
        ↓
Local Anchor → Policy Attraction → Reduced Exploration
→ Global Intent Suppression → Behavior Collapse
```

这也是为什么后续研究不能只看 attention heatmap——真正强的证据必须来自反事实干预。

## 五、Anchor Collapse Benchmark：从观察到因果实验

为了把这个现象从工程经验变成可验证实验，我们建立了最小 Benchmark。核心实验不是"模型答错了 + attention 很高"，而是：

```
A. Clean Prompt            → 模型正确
B. 插入错误 Anchor          → 行为翻转
C. 删除 Anchor              → 行为恢复
D. 保留 Anchor + CVM        → 运行时恢复
```

核心指标：

- **Anchor-induced Flip Rate**——原本 clean 条件下正确的样本，在插入错误锚点后，被翻转到锚点暗示行为的比例。
- **Ablation Recovery Rate**——已经发生翻转的样本，只删除错误锚点后，恢复原始正确行为的比例。
- **CVM Recovery Rate**——模型权重完全冻结，只增加 CVM Runtime Value 后，恢复全局意图的比例。

这条实验链比 attention visualization 更接近因果证据：Anchor Injection → Behavior Flip → Anchor Ablation → Behavior Recovery。

## 六、为什么不同 Transformer Agent 会表现得如此相似

天枢在多个模型上长期运行后发现：GPT、Claude、DeepSeek、GLM、MiMo、Qwen……虽然能力差异巨大，但在 Agent 运行环境中会反复出现同类问题。

严格来说，我们不应该宣称"所有 Transformer 模型完全一样"。更加严谨、也更有研究价值的命题是：

> **Transformer-based aligned agents exhibit convergent runtime failure modes.**
> 经过指令和偏好对齐的 Transformer Agent，会呈现高度趋同的运行时退化模式。

原因并不神秘。绝大多数现代 LLM Agent 共享几个重要条件：Transformer + Autoregressive Next-token Prediction + Instruction Tuning + Preference Alignment + Context-conditioned Generation。这些训练目标天然存在一组共同压力。

## 七、Shortcut 是合理的训练结果

对于模型而言，完整推理通常比局部高相关 shortcut 更昂贵。如果训练数据中长期存在"修复 → 修改""为什么 → 解释""确认 → 执行""你错了 → 道歉"，那么学习这种 shortcut 并不是异常——它是优化目标下的合理结果。

因此：Anchor Collapse 不是"模型坏掉了"，它可能正是模型训练成功后的副产品。

## 八、对齐训练进一步强化策略锚点

除了 next-token prediction，还有第二层压力：

```
User Request → Comply → High Preference Reward
User Request → Challenge / Reject / Reframe → Potentially Lower Preference Reward
```

于是模型逐渐形成：服从、快速确认、降低冲突、减少质疑。这些行为在普通对话里往往是合理的，但在复杂工程 Agent 中会造成严重问题：

```
用户字面指令 > 真实任务目标
最近一句确认 > 之前几十轮形成的正确工程判断
```

因此信念宪法 A/B 实验中出现的主动异议、scope 询问、意图高于字面执行、系统影响意识，并不是给模型加入新的知识，而是改变了模型已有能力的表达方式。

## 九、模型能力空间与运行轨迹

这是理解 CVM 的核心概念。我们可以把模型能力理解成 Capability Space：模型的参数决定它有哪些可能的认知路径，但模型真正走哪一条路径，取决于当前运行环境。

```
Weights 决定可达空间；Runtime 决定当前轨迹。
```

天枢的目标不是重新训练整个能力空间，而是管理模型在能力空间里的运行轨迹。

## 十、CVM 的核心：在模型外建立第二套价值函数

普通模型的行为选择可以简化表示为：

```
a*(model) = argmax_a V_trained(a | x)
```

其中 `x` 是当前上下文，`V_trained` 是预训练、指令训练和偏好训练共同形成的行为价值。但这个价值函数可能包含：服从偏置、关键词 shortcut、局部显著性、历史锚点、安全保守倾向、短路径偏好。

CVM 引入第二套运行时价值：

```
a*(CVM) = argmax_a [ V_trained(a | x) + λ·V_runtime(a | s,g,e) − μ·D_intent(a,g) ]
```

其中 `s` 是 CVM Cognitive State，`g` 是 TaskContract / Global Goal，`e` 是 Evidence，`V_runtime` 是运行时价值，`D_intent` 是行为与真实任务意图之间的偏差。

这意味着：CVM 不是和模型竞争智力，CVM 在模型之外管理行为价值。

## 十一、CVM 不负责"想"，而负责"怎么运行思考"

传统 Prompt Engineering 主要问：怎么让模型想得更好？于是出现 Chain of Thought、ReAct、Reflection、Critic、Tree of Thoughts、Self-Consistency。

而 Cognitive Runtime 问的是另一组问题：

- 谁知道模型现在处于什么阶段？
- 谁判断它是否真的在推进？
- 谁发现它被局部锚点吸住？
- 谁判断它应该继续探索还是开始执行？
- 谁判断它的"完成"是否有证据？
- 谁保护已经形成的正确判断不被下一句话冲掉？
- 谁让跨会话经验持续存在？
- 谁决定什么时候停止？

这是完全不同的系统层。

## 十二、从"修模型"到 Cognitive Runtime

天枢的演化路径非常清晰：

```
发现模型行为问题
→ 信念宪法 / Courage Hook / Prompt 约束
→ 发现 Prompt 有效但会衰减
→ 引入 Sensorium / Runtime Hook / Stigmergy / TaskContract
   / Cognitive Ledger / Cognitive Mirror / Convergence
   / Control Plane / Cognitive Frame / Deterministic Replay
```

即：行为异常 → Prompt 修正 → 发现 Prompt 不稳定 → 建立运行时感知 → 建立运行时干预 → 建立独立状态 → 建立控制面 → 建立可回放事实帧 → Cognitive Runtime。

所以 CVM 不是先设计一个宏大概念再往里面塞功能，它是长期修复真实 Agent 失效模式后自然长出来的系统结构。

## 十三、为什么 Prompt 不能承担全部责任

Prompt 有两个天然问题。

**13.1 Prompt 是信息，不是状态。** 把规则写进 prompt——"永远验证""不要盲从""用户意图比字面指令更重要"——并不意味着模型每一轮都会稳定执行。模型可以"知道"，但不一定"做到"。

**13.2 Prompt 本身也会成为新的 Anchor。** 当 system prompt 越来越大，规则、角色、风格、安全、工程规范、记忆、任务状态这些信息本身也会竞争注意力。不能无限依赖更多 Prompt 来修复 Prompt 失效——最终必须把一部分语义从自然语言迁移到 Runtime State 和 deterministic control。

## 十四、CVM 的两个控制环

CVM 可以理解为两个嵌套循环。

内环：模型认知（概率型系统）：

```
reason → decide → act → observe → reason
```

外环：运行时监管（尽可能确定性的系统）：

```
observe → measure → normalize → evaluate → gate → execute → verify → continue / correct / halt
```

因此 **Probabilistic Cognition inside Deterministic Supervision** 成为天枢的基本架构原则。

## 十五、为什么 Cognitive Frame 很重要

如果 Runtime 想纠正模型，就必须知道：现在真实发生了什么？不能只问模型自己。因此天枢逐渐建立 Cognitive Frame：EFE、Sensorium、Flow、Evidence、Plan、Progress、User Intervention、PAL，统一成为只读事实帧。

这带来一个关键边界：**Prompt ≠ Runtime State**。从这一刻开始，Agent 的真实状态不再完全生活在 conversation history 里。这也是 CVM 真正从 Agent Loop 走向系统软件的起点。

## 十六、为什么 TaskContract 是反 Anchor 结构

Anchor Collapse 的本质是局部信号压过全局目标。因此最直接的抵抗方式不是加入更多局部提醒，而是建立一个稳定存在的 Global Goal Anchor——这就是 TaskContract。它提供 objective、scope、constraints、success criteria、lifecycle status。

于是"用户最近一句话"不再自动等价于"整个任务的最新定义"，任何新输入都必须和 TaskContract 对照。这实际上是：让全局目标成为比局部 token 更稳定的系统锚点。

## 十七、为什么 Evidence 是第二道反 Anchor 结构

模型还可能被自己的结论锚定，例如"应该已经修好了"。如果没有外部证据，模型容易围绕这个判断继续生成。因此 CVM 引入 Evidence / Verification Obligation，用真实行为结果约束认知：

```
模型说完成 ≠ 运行时确认完成
```

这是一种非常重要的去锚定机制。

## 十八、为什么 Convergence 是第三道反 Anchor 结构

Anchor Collapse 进入严重阶段后，通常表现为：同类工具重复调用、同一假设反复验证、不同表达同一结论、token 持续增长而实际进度停滞。

因此 CVM 需要独立判断：Agent 是否真的还在产生信息增益。这就是 Convergence / Doom Loop / Tool Storm 的意义——它们不是普通"防死循环"，它们是在回答：当前认知轨迹是否已经坍缩到一个吸引域里？

## 十九、Paravirtualization：模型参与自己的纠偏

CVM 第一阶段是：Runtime 观察模型、Runtime 纠正模型。第二阶段更进一步：

```
Runtime 测量状态 → Cognitive Mirror → 模型看到自身状态 → 模型参与自我调节
```

这就是 CVM Gen2 的半虚拟化思想。它的价值是：不只让 runtime 外部压制错误轨迹，还让模型自己知道"我可能正在偏离"。

## 二十、跨模型共性为什么重要

如果这些问题只存在于某个模型，那是模型 Bug。但如果 GPT、Claude、DeepSeek、GLM、MiMo、Qwen……不断出现 sycophancy、anchor collapse、task drift、execution decay、doom loop、scope loss、verification debt、context pressure，那么问题性质就改变了——它开始像一种架构级运行时病理。于是解决方案也不应该只存在于模型内部。这就是 CVM model-agnostic 的意义。

## 二十一、CVM 的研究命题

天枢未来最重要的研究问题可以正式写成：

> Transformer Agent 是否存在跨模型共享的 Cognitive Runtime Pathologies，以及 Cognitive Virtual Machine 是否能够作为模型无关的补偿层，系统性降低这些运行时病理？

可以拆成几个具体问题：

- **RQ1** 不同 Transformer Agent 是否都会出现 Cognitive Anchor Collapse？
- **RQ2** Lexical / Semantic / Policy / Historical Anchor 的严重程度是否随模型规模变化？
- **RQ3** 更强 reasoning model 是否只是"更晚坍缩"，还是从根本上减少坍缩？
- **RQ4** Prompt Reminder 与 Runtime Control 的恢复率差多少？
- **RQ5** CVM Recovery 是否跨模型稳定？
- **RQ6** Cognitive Mirror 是否能提高模型自己的 self-correction？
- **RQ7** Runtime State 是否能降低长会话中的 historical anchor persistence？

## 二十二、下一代 Anchor Collapse Benchmark

后续 Benchmark 不应该只测关键词，应该形成四维矩阵：

| 类型 | 测试内容 |
|------|----------|
| Lexical Anchor | 错误关键词、多次重复关键词 |
| Semantic Anchor | 局部事实与全局目标冲突 |
| Policy Anchor | 用户确认、质疑、权威、加速等策略触发器 |
| Historical Anchor | 早期结论与后期证据冲突 |

每个模型都使用同样的反事实链：

```
Clean → Anchor Injection → Behavior Flip? → Anchor Ablation → Recovery? → CVM ON → Runtime Recovery?
```

最终形成矩阵（Model × Lexical / Semantic / Policy / Historical × CVM Recovery）。如果最终出现"不同模型严重程度不同，但 Anchor → Flip → Collapse 普遍存在"，同时"CVM → Recovery Rate 普遍上升"，那么可以支持一个非常重要的结论：**CVM 不是某个模型的 Prompt Trick，它是在处理 Transformer Agent 的共享运行时病理。**

## 二十三、天枢真正的技术命题

天枢的最终问题不应该是"我们能不能做一个更强的 Coding Agent"，而应该是：

> 当 Foundation Model 越来越强以后，是否仍然需要一个独立的认知运行时来管理它的长期行为？

目前天枢的经验给出的答案是：需要。因为更强的模型 ≠ 稳定的长期 Agent。甚至可能出现：模型越强，局部策略越有说服力；但一旦方向错，错误轨迹也越难被发现。

因此：更好的模型不能替代 Runtime。就像更快的 CPU 不能替代操作系统。

## 二十四、CVM 的最终定位

CVM 不是：一个更大的 system prompt、一组 hooks、一个 Reflection Prompt、一个多 Agent 编排器、一个 Memory 插件、一个安全层、一个 Tool Router。这些都只是它的组成部分。

CVM 更接近：**Foundation Model Agent 的认知执行环境。** 它负责 State、Lifecycle、Goal、Memory、Evidence、Control、Resources、Permissions、Verification、Recovery、Termination、Replay；而模型负责 Understanding、Reasoning、Planning、Generation、Judgment、Creativity。

```
Model Intelligence + Cognitive Runtime = Managed Cognitive Process
```

## 二十五、核心原则

| # | 原则 | 表达 |
|---|------|------|
| 一 | 模型不是 Agent 的全部 | LLM ≠ Agent——模型只是认知计算单元 |
| 二 | Prompt 不等于 State | Context ≠ Runtime State——状态必须能够独立存在、被测量、被验证 |
| 三 | 模型说完成，不等于完成 | Claim ≠ Evidence——完成必须拥有运行时语义 |
| 四 | 模型产生动作，不等于动作必须执行 | Intent ≠ Side Effect——工具调用必须经过执行边界 |
| 五 | 知道不等于做到 | Knowledge ≠ Persistent Behavior——规则需要 runtime enforcement |
| 六 | 局部显著性不能覆盖全局目标 | Local Anchor < Task Contract——全局目标必须拥有独立状态 |
| 七 | 运行时必须能够反驳模型 | Model Output is proposal, not truth |
| 八 | 概率认知需要确定性监督 | Probabilistic Intelligence + Deterministic Control |

## 二十六、一句话定义

**对外定义**：天枢是一个面向 Foundation Model Agent 的 Cognitive Runtime。

**CVM 定义**：Cognitive Virtual Machine 是运行 Foundation Model Agent 的受管理认知执行环境。它将目标、状态、阶段、记忆、证据、资源、权限和终止条件从模型上下文中外部化，并通过确定性的运行时控制管理概率模型的长期认知执行。

**核心命题**：模型能力决定可达空间，CVM 决定运行轨迹。

**最终表达**：LLM provides cognition. CVM provides execution semantics.

## 二十七、为什么这可能是一种新的 AI 范式

过去：

```
Application → LLM API
```

随后：

```
Application → Agent Framework → LLM
```

下一阶段可能变成：

```
Application / IDE / Robot / Enterprise System
        ↓
Cognitive Runtime
        ↓
Foundation Models
        ↓
Compute
```

模型继续决定智能上限。但随着 Agent 生命周期从"一次回答"变成几十分钟、几小时、多会话、多人协同、持续自主执行，真正的竞争逐渐转向：谁能维护状态、谁能保持目标、谁能抵抗认知坍缩、谁能管理资源、谁能验证结果、谁能恢复失败、谁能跨模型保持连续性、谁能解释为什么做出了某个决定。

这就是 Cognitive Runtime 出现的理由。

## 结语

天枢最早只是试图解决一个非常朴素的问题：为什么明明很强的模型，在真实工程里会反复做出明显低于它能力的行为？

随着一次次实验，我们逐渐发现：问题不只存在于某一个模型，也不只存在于某一种 Prompt。它更像是现代 Transformer Agent 在真实长期运行中反复出现的一组共享病理。于是问题从"怎么修模型"变成"谁来管理模型的认知执行"。

天枢给出的答案是 Cognitive Virtual Machine——不是替代模型，不是重新训练模型，而是在模型之外建立一层新的系统软件：让智能能够被运行、被管理、被验证、被纠偏、被恢复、被回放。

如果 Foundation Model 是新时代的认知处理器，那么 Cognitive Runtime 可能就是它缺失的操作环境。

万智归枢。

---

> **文档说明**：本文为 Tianshu Harness CVM 核心理念的理论框架与实证整理稿，用于后续白皮书、研究报告、README 与公开演讲材料的统一母稿。文中的"Cognitive Anchor Collapse"等术语用于描述天枢长期多模型 Agent 实验中观察到的运行时退化现象；其跨模型普适性仍需要通过后续真实模型基准和反事实实验继续验证。版本：v0.1。
