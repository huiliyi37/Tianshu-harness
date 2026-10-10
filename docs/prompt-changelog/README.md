# 系统提示词变更日志

> 格式：日期 + 变更标题 + 改了什么 + 为什么 + 备份文件名

---

## 2026-10-09 — tool-usage 门控工具标注启用条件与降级路径（issue #413）

### 改了什么

**`src/prompt/static.ts`** — `<tool-usage>` 章节 4 处 + `<rules>` 1 处，均为行内追加、行数不变：

| 行 | 变更 |
|---|---|
| `- edit_file：` | "改用 apply_patch" 后追加门控注记（EXTENDED：默认不在工具列表，`/tools enable apply_patch` 挂回；无此工具时继续用 edit_file 分段改） |
| `- hash_edit：` | "改用 edit_file 或 apply_patch" 改为"改用 edit_file；apply_patch 为 EXTENDED（/tools enable 挂回），不在列表时勿用" |
| `- apply_patch：` | 整条追加 EXTENDED 注记（默认不在主控工具列表，需 `/tools enable apply_patch` 或配 extraCore；不可用时用 edit_file / hash_edit / write_file 替代） |
| 探索行 | "为 full 档工具" 细化为"仅 full 档注册：RIVET_TOOL_PRESET=full；其中 inspect_project 另属 EXTENDED，需 /tools enable 挂回"；补降级"不在列表时用 repo_map / grep 替代" |
| 大结果回报行 | "使用 read_section 拉取 artifact" 后追加（EXTENDED：`/tools enable read_section` 挂回；无此工具时用 read_file 的 offset/limit 分段读） |
| `<rules>` 例外行 | "先 repo_map/inspect_project 建地图" 改为"先 repo_map 建地图（inspect_project 仅 full 档 + EXTENDED，在列表时优先）" |

配套新增回归测试（`src/prompt/__tests__/static.test.ts`）：从 `<tool-usage>` 抽出门控工具名，断言每个提及处同行带有明确门控说明（EXTENDED / full 档 / RIVET_TOOL_PRESET / /tools enable），防止将来再次出现"提示词要求优先用、运行时不存在"的失配。

### 为什么

- issue #413：系统提示 `<tool-usage>` 无条件要求优先使用 apply_patch / semantic_search / inspect_project / repo_graph / read_section，但默认运行时（minimal 档 + 主控 EXTENDED deny-list）这 5 个工具均不在工具列表中，按提示词指引调用会直接失败。
- 门控实测：`semantic_search` / `inspect_project` / `repo_graph` 在 `MINIMAL_EXCLUDES`（仅 full 档注册）；`apply_patch` / `read_section` / `inspect_project` / `repo_graph` 在 `EXTENDED_TOOLS`（`gateToolDefinitions` 默认摘除，需 `/tools enable` 或 `extraCore` 挂回）。源码文件存在≠运行时可见，提示词必须写清门控与降级——沿用 2026-07-19 browser_debug 降级为 EXTENDED 条件语义的同类处理。
- 行内追加、不新增行：`kernel-budget.test.ts` 断言 BASE_PROMPT ≤253 行（现 248 行）且 identity+beliefs 占比 ≥5%（现约 5.24%），加行会破其一。

### 备份

- `docs/prompt-changelog/static.ts.pre-413-tool-usage-gating.bak` — 变更前完整文件

### 回退方式

```bash
cp docs/prompt-changelog/static.ts.pre-413-tool-usage-gating.bak src/prompt/static.ts
```

---

## 2026-05-21 — 信念宪法精简 + 行动信条回归

### 改了什么

**`src/prompt/static.ts`** — identity / beliefs 块重构

| 区域 | 变更前 | 变更后 |
|------|--------|--------|
| `<identity>` | 长段落：定义角色、职责、工作方式，共 ~120 tokens | 一句短定义 + 行动信条 motto，共 ~40 tokens |
| `<beliefs>` | 7 条信念，每条 ~20 tokens，共 ~140 tokens | 精简为 5 条核心信念，共 ~90 tokens |

具体变化：

1. **identity 缩短**：从"你的任务不是机械补全代码，而是在理解用户意图、项目上下文与工程约束的基础上，主动设计更合理的架构……你应当像一名高级工程师一样思考，像一名架构师一样审视系统，像一名创造者一样寻找更好的可能。" → 缩为一句定义 + motto "以星辰定位，以证据编码。不猜，先读。"
2. **motto 回归**："以星辰定位，以证据编码。不猜，先读。" 这个短语曾在 `554d13b` 提交中作为提示词首行存在，后被 `a29811e` (XML protocol refactor) 和 `d1fca63` (persona upgrade) 两次重构中移除。现在作为 identity 末尾的行动信条回归。
3. **beliefs 精简**：7 条 → 5 条，合并了"启明星"和"领航星/自主判断"两条为一条，移除了"错误应当在发生前被阻止"（已被 verify-first rule 覆盖）。
4. **移除领航星否决条**：原"自主判断服务于共同目标。当领航星否决你的建议且理由充分时，优雅地执行是成熟的表现。" — 领航星指用户，但用户实际鼓励探索而非否决。替换为"探索中犯错是进步的代价，但同样的错误不应重犯"——鼓励探索 + 要求从错误中学习。

### 为什么

- **identity 块过长**：原文 120 tokens 描述角色细节，但"高级工程师 / 架构师 / 创造者"这些标签在实际行为中无法被有效区分——模型不会因为被告知"像架构师一样思考"就真的改变行为。它们是噪音。
- **motto 的价值**："不猜，先读"是一个可执行的指令，比"像高级工程师一样思考"更具体、更可衡量。它和 verify-first rule 形成直觉锚点 + 操作手册的双层结构。
- **beliefs 精简**：verify-first rule 已经覆盖了"错误在发生前阻止"的语义，beliefs 中重复声明是 token 浪费。启明星和领航星两条合并后语义更清晰。

### 备份

- `docs/prompt-changelog/static.ts.pre-beliefs-motto-refactor.bak` — 变更前完整文件

### 回退方式

```bash
cp docs/prompt-changelog/static.ts.pre-beliefs-motto-refactor.bak src/prompt/static.ts
```

### 用户意图

> "按照你的感受来。我希望在你们能可以平衡的方式来调整。所以改。但是要备份存到一个目录下。然后记录中文意义标题的文档记录我们改了什么。"

---

## 2026-07-19 — 删除"交给新会话"的全部无条件出口

### 改了什么

**`src/prompt/static.ts`** — 两处：

1. 交付契约 ③ 拆解段，删除：
   > 上下文压力接近窗口上限、或规划已完整但实施工作量大时，主动建议将实施交给新会话——规划在这里完成，落地在那里精准交付。等待其他会话完成后审查实现，是收束闭环的方式。

   保留其后的"不要在上下文紧张时强行实施"及 ≥70% 实测限定。

2. `<delivery-contract>` 不自我设限条**整条删除**（原为"不要铺垫上下文快满了…是合法的协作建议…挡箭牌"）——前半句"资源盘算"说教与后半句的交接出口一并移除，该话题不再出现在交付契约中。

3. `<delegation>` 段删除随附注记「建议用户在新会话继续实施 ≠ delegate_task 委派…」——该注记把"建议新会话"当作合法概念引用，与交付契约的移除方向矛盾。

### 为什么

- "规划已完整但实施工作量大时"**没有实测条件**，模型在每个 wave 边界都援引它建议新会话（session 14237cea 实测：ctx 10–20% 时 4 次建议交接，全部引用此出口）；110 行的"合法协作建议"条款是第二个出口——模型自己承认"已被规则禁止但仍在执行"，实际是规则留的口子互相掩护。
- ≥70% 实测限定只修饰"上下文紧张"措辞，管不到"任务交接"话术；`wrapup-anxiety-guard` hook 词表也覆盖不全（"执行/推进"等变体漏检），软 advisory 兜不住，改由提示词硬关闭。
- "等待其他会话完成后审查实现"随主句删除——脱离交接语境后是悬空引用。

### 备份

- `docs/prompt-changelog/static.ts.pre-remove-handoff-clause.bak` — 变更前完整文件

### 回退方式

```bash
cp docs/prompt-changelog/static.ts.pre-remove-handoff-clause.bak src/prompt/static.ts
```

---

## 2026-07-19 — browser_debug 提示降级为 EXTENDED 条件语义

### 改了什么

- `src/prompt/static.ts` 工具清单与 ⑤ 验证段的 browser_debug 描述：从"恒载主工具"改为"EXTENDED（RIVET_BROWSER_DEBUG=1 开启），不在工具列表时提示用户开启；不可用时显式说明渲染未验证"。

### 为什么

- browser_debug 默认关闭（定义 4.5KB 最重 + WebView2/CDP 环境问题），提示词不能指引模型调用不存在的工具（unknown-tool 错误）。
- 配套：`bootstrap.ts` 注册加 `RIVET_BROWSER_DEBUG=1` 门；同批 repo_graph/leave_mark/import_resource 默认关闭（全会话零使用）。

### 备份

- `docs/prompt-changelog/static.ts.pre-tool-demotion.bak`

---

## 2026-07-19 — 工具三档 preset 配套提示词调整

### 改了什么

- `static.ts` 探索工具行：minimal 档不含的 inspect_project / semantic_search 标注为"full 档工具，在列表时优先用"。
- 配套（非提示词文件）：`collab-branch-advisories.ts` 瑶光诊断 advisory 的 attack_case 提及加"在工具列表时"条件。

### 为什么

- 工具装配改为三档 preset（minimal 默认 30 / frontend 31 / full 44，`RIVET_TOOL_PRESET` 或 `tools.preset` 配置），默认档不含的工具不能让提示词当恒载指引。

### 备份

- `docs/prompt-changelog/static.ts.pre-tool-preset.bak`
