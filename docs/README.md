# 天枢文档规范

> 本文件是 docs/ 文档库的总纲：文档类型、目录地图、命名规范、frontmatter 标准、索引用法。
> 索引不手维护——[INDEX.md](INDEX.md) / [docs.json](docs.json) / [MINDMAP.md](MINDMAP.md) 均由 `scripts/docs-index.ts` 生成。

## 核心理念

1. **元数据内嵌、索引生成**——元数据写在每篇文档头部的 frontmatter 里，索引是构建产物，可随时重建（借 KEP/PEP 范式）。手维护的总索引必然腐烂。
2. **一篇文档只属一类**——spec 写 What/Why、design 写 How+权衡、plan 做执行追踪、analysis 做事后归因。写混了说明该拆（防 blur，借 Diátaxis）。
3. **superseded 不删档**——被取代的文档标记状态并指向替代者，它曾是决策这件事本身仍有价值（借 ADR）。
4. **升级不推翻**——既有的日期前缀、blockquote 元信息头、teamtask 边界 README、briefs 分层索引等约定全部保留；新文档在此之上补 frontmatter 即可被机器索引。

## 文档类型（受控 `type` 枚举）

| type | 职责（一句话） | 落点目录 | 命名 |
|------|--------------|---------|------|
| `plan` | 执行计划：任务分解 + checkbox 追踪 | `plans/` | `YYYY-MM-DD-主题.md` |
| `spec` | 事前规格：做什么/为什么（需求 + 验收标准） | `specs/` | `YYYY-MM-DD-主题.md` |
| `design` | 事前权衡：怎么做（trade-off + 备选方案） | `design/` | `YYYY-MM-DD-主题.md` |
| `decision` | 决策记录：为什么选这条路（ADR 五段式） | `decisions/` | `NNNN-标题.md`（单调递增、不复用） |
| `analysis` | 事后归因：分析 / 复盘 / handoff | `analysis/` | `YYYY-MM-DD-主题.md` |
| `research` | 外部调研：竞品 / 技术 / 生态 | `research/` | `YYYY-MM-DD-主题.md` |
| `changelog` | 变更记录（发生了什么） | `changelog/` | `YYYY-MM-DD-主题.md` |
| `issue` | 单点问题追踪 | `known-issues/` | `YYYY-MM-DD-主题.md` |
| `release` | 版本发布说明 | `releases/` | `v2.x.y.md`（语义命名） |
| `guide` | 手册指南（用户 / 开发者） | `guides/` | 语义命名，无日期前缀 |
| `reference` | 架构参考 / 长期有效资料 | `reference/` | 语义命名，无日期前缀 |

边界判断（一文档一类型，混淆时按此分流）：

- 「要不要做、做成什么样」→ `spec`；「怎么实现、为什么这么实现」→ `design`；「下一步谁做什么」→ `plan`
- 「为什么选了 A 不选 B」的单点决策 → `decision`（不从属任何 feature，长期有效）
- 「发生了什么、根因是什么」→ `analysis`；「改了哪些东西」→ `changelog`
- 「外面世界怎么样」→ `research`；「我们自己怎么用」→ `guide` / `reference`

## 目录地图

新文档落点为上表目录。历史保留区不动，由 INDEX 统一逻辑视图：

| 目录 | 定位 |
|------|------|
| `plans/` `specs/` `decisions/` `guides/` `reference/` | 新规范落点（各带边界 README） |
| `design/` `analysis/` `research/` `changelog/` `known-issues/` `releases/` | 既有目录，沿用 |
| `superpowers/` | 历史主仓（plans 339 / specs 212 等），保留不动；新文档请用顶层对应目录 |
| `teamtask/` | 系统级收束专项（自带边界 README） |
| `stars/` | 星域档案（自带命名公约） |
| `brand/` `dev/` `prompt-changelog/` `prompt-versions/` `cache-baseline/` | 专项资料区 |
| `tasks/` `reviews/` `sessions/` | 历史散点区，不再新增，新文档去对应类型目录 |
| `archive/` | 归档区（见下文归档规则） |
| `_templates/` | 各类型模板 |
| 顶层散落文件 | 历史遗留，不再新增；新文档一律进类型目录 |

工具草稿区（`.rivet/plans/`、`.cursor/plans/`、`.zcode/plans/`）是各 agent 工具的运行时产物，**不改其行为**；定稿后的晋升路径：按命名规范移入对应 docs 类型目录 + 补 frontmatter。

## 命名规范

- **带时间性的类型**（plan / spec / design / analysis / research / changelog / issue）：`YYYY-MM-DD-主题.md`，日期为创建日。排序友好，且是索引的日期兜底来源
- **长期有效的类型**（release / guide / reference / decision）：语义命名（`v2.23.0.md`、`user-guide.md`、`0007-cache-freeze.md`）
- 英文部分用 kebab-case；中文文件名允许（既有 15% 为中文名），但不要中英混杂造词
- 避免空格；避免 `副本`、`final`、`v2-final` 这类后缀——迭代用 `supersedes` 表达

## Frontmatter 标准

新文档在文件顶部写 YAML frontmatter（模板见 `_templates/`）：

```yaml
---
title: 文档标题             # 必填
type: plan                  # 必填，受控枚举（见上表）
status: draft               # 必填，见状态机
date: 2026-07-27            # 必填，YYYY-MM-DD
updated: 2026-07-27         # 可选
related: [../specs/xxx.md]  # 可选，关联文档（相对路径或仓库根相对路径）
supersedes: ../plans/yyy.md # 可选，本文档取代的旧文档
tags: [cache, hooks]        # 可选
---
```

**状态机**：`draft`（起草）→ `active`（进行中/生效中）→ `accepted`（已定稿）→ `done`（已完成）；终态 `deprecated`（不再推荐）/ `superseded`（已被取代，配 `superseded` 方的 `supersedes` 字段互指）。decision 类额外遵循 ADR 纪律：编号单调递增不复用，`superseded` 不删档。

**与存量惯例的兼容**：索引生成器三级兜底——frontmatter 优先；无 frontmatter 时用文件名日期前缀 + blockquote 元信息头（`> 日期：` / `> 状态：`）+ 首个 H1。存量文档不强制补 frontmatter，顺手时补录即可。注意：`type` 字段是规范 frontmatter 的 schema 标记，`npm run docs:check` 只校验含 `type` 的文档（Cursor plan 等外来 schema 不受影响）。

## 引用与关联

- 文档间引用优先用**相对路径 markdown 链接**（GitHub/IDE 可点击）；反引号纯路径仍允许（agent grep 场景），二者并存
- 关联关系进 frontmatter `related` / `supersedes` 字段（机器可建关联图），正文链接给人类
- 引用代码用 `` `src/path/file.ts:42` `` 格式（精确、可导航）

## 索引与思维导图

```bash
npm run docs:index   # 重新生成 INDEX.md / docs.json / MINDMAP.md
npm run docs:check   # 校验 frontmatter 合法性 + 文档卫生检查（只校验不生成）
```

- **[INDEX.md](INDEX.md)** — 全量索引，按 type 分组、日期倒序，含状态列
- **[docs.json](docs.json)** — 机读索引，供脚本/工具消费（如"列出所有 status=active 的 plan"）
- **[MINDMAP.md](MINDMAP.md)** — 思维导图大纲。VSCode markmap 插件直接打开，或 `npx markmap-cli docs/MINDMAP.md` 渲染成交互式 HTML；每个分组仅展开最近 20 篇防爆炸

三件套已提交进仓库方便 GitHub 浏览；内容过期时跑 `npm run docs:index` 重建即可，不要手工编辑（文件头有生成标记）。

### 子集检出（公开仓）下的索引

三件套是在**开发仓的完整 docs 树**上生成的，随同步进入本仓。若本仓只带了 docs/ 的一个子集
（公开仓即如此），会出现两件看起来矛盾的事，但都不是文档写错了：

- `INDEX.md` / `docs.json` 的篇数远大于本仓的实际文件数（索引登记 1000+ 篇，本仓可能只有一百多）；
- 部分 `related` / `supersedes` 指向的文档不在本仓。

处置口径：**在子集检出上不要重建索引**——`npm run docs:index` 会把同步来的条目砍掉，
并与下次同步来回打架。`npm run docs:check` 已按子集口径区分两类问题：

| 情形 | 判定 |
|------|------|
| schema 违规（type / status / date 枚举、必填字段、日期格式） | ✗ 错误，非零退出 |
| `related`/`supersedes` 指向**本仓索引登记过、但未随本仓分发**的文档 | ⚠ 提示，不计错误 |
| `related`/`supersedes` 指向**索引里也没有**的路径 | ✗ 错误（放宽只针对「已知但未分发」，不是取消校验） |

需要重建索引时，请在**文档树完整**的仓库里做；子集检出上只看不写用 `npm run docs:check`。

## 归档规则

- `deprecated` / `superseded` 状态的文档满一个版本周期后，移入 `archive/`（保留原文件名，frontmatter 不动）
- `archive/` 不参与索引；移动时在原文档的 `related` 文档里更新链接
- 不确定是否该归档 → 只改 `status`，不动位置

## 写新文档的流程

1. 判断类型（一文档一类型，拿不准看边界判断节）
2. 从 `_templates/` 复制对应模板到对应目录，按命名规范改名
3. 填 frontmatter（`type`/`status`/`date` 必填）
4. 写完跑 `npm run docs:index` 更新索引，`npm run docs:check` 确认校验通过
