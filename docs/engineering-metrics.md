# 工程质量指标 · Engineering Metrics

> 数据截至 **2026-08-28**，基于开发仓库实测，复现命令见文末。
> Data as of **2026-08-28**, measured on the development repository. Reproduction commands at the bottom.
>
> 本仓库 2026-05-15 建仓，main 累计 **6,178** 次提交（全分支 7,333），平均每天约 59 次——行数每天都在动，这里的数字是**量级快照**，跑命令复现时差几百行是正常的，不必对齐到个位。

## 核心指标 · Key Metrics

| 指标 Metric | 数值 Value |
|------|------|
| 版本 Version | **3.8.0**（`package.json`） |
| CLI 源码 (TypeScript, 不含测试) | **1,078 文件 / 257,623 行** |
| CLI 测试代码 | **1,361 文件 / 256,001 行** |
| 测试 : 源码 行数比 | **≈ 0.99 : 1** |
| 测试用例 · 静态声明 | **16,471**（`test(` + `it(` 计数） |
| 测试用例 · 执行态 | 复现命令见文末（全量分批跑约 30 分钟级；上次全量实测 2026-07-26 为 13,125 / 2,251 suites，与静态口径同量级互证） |
| 桌面端源码 (React + Tauri) | **299 文件 / 64,283 行** |
| 运行时 Hook 模块 (`src/agent/hooks/*.ts`) | **72** |
| 内置工具模块 (`src/tools/`, 含子目录) | **161**（preset 四档装配 30 / 31 / 51 / 14；其余 EXTENDED / 装配注入） |
| 星域 | **16**（`src/agent/star-domain-data.ts`） |
| 建仓日期 | **2026-05-15**（105 天） |
| 累计提交（main） | **6,178**（全分支 7,333） |
| 类型检查 | `tsc --noEmit` strict + `noUncheckedIndexedAccess` |

> 测试用例总数随套件演进，README 的「16,000+」是数量级声明而非单次锁死数字。两种口径都要会看：**静态口径**数源码里 `test(` / `it(` 的声明数；**执行态口径**跑 `npm test` 并把各批小计求和——runner 分批 spawn，输出末尾那行 `tests N` 只是最后一批，直接引用会严重少计。命令见文末。
>
> 文件数口径：上表的 **1,361** 是 `git ls-files` 口径（`.test.ts` + `__tests__/` 全部 TypeScript），其中 `__tests__/` 下有若干不被 runner 直接执行的 fixture / helper 文件。「跑了多少文件」与「测试目录有多少文件」是两个不同问题，复现时注意区分。

## 迭代里程碑 · Growth Milestones

四个可复现的时间切片。取样点：首次留下规模记录的 `18366754`（2026-06-02）、`5cf06afc`（2026-07-15）、2026-07-26 快照、当前 HEAD（2026-08-28）。

| 指标 | 2026-06-02 | 2026-07-15 | 2026-07-26 | 2026-08-28 | 87 天增幅 |
|------|-----------|-----------|-----------|-----------|----------|
| 版本 | — | 2.19.3 | 2.28.0 | **3.8.0** | — |
| 源码 文件 / 行 | 443 / 57,606 | 841 / 179,095 | 931 / 207,930 | **1,078 / 257,623** | ×4.5 行 |
| 测试 文件 / 行 | 446 / 56,849 | 1,003 / 166,921 | 1,134 / 198,484 | **1,361 / 256,001** | ×4.5 行 |
| 测试 : 源码 | ≈0.99 : 1 | ≈0.93 : 1 | ≈0.95 : 1 | **≈0.99 : 1** | 维持近 1:1 |
| 测试用例（静态声明） | 3,926 | — | 12,981 | **16,471** | ×4.2 |
| 桌面端 文件 / 行 | — | 154 / 34,601 | 204 / 44,317 | **299 / 64,283** | — |
| Hook 模块 | 19 | 62 | 68 | **72** | ×3.8 |
| 累计提交（main） | 1,485 | 4,228 | 4,825 | **6,178** | +4,693 |
| TUI 渲染路径 | Ink 6 (React) | 纯 ANSI | 纯 ANSI | **纯 ANSI** | 整层置换 |

两点值得单独说明：

**测试比例没有被规模稀释。** 源码涨到 4.5 倍的同时测试涨了 4.5 倍，比值始终在 0.93–0.99 之间。规模扩张期最常见的退化是测试增速掉队，这里没有发生。

**TUI 渲染路径在此期间整层置换。** 2026-06-02 时是 Ink 6（React for Terminal），现为自研纯 ANSI 引擎（`src/tui/engine/`），React 渲染路径已完全退役。因此跨越该窗口的历史文档若描述 TUI 技术栈，一律以本表为准。

> 口径说明：各历史列均用同一条 `git ls-tree` 命令在对应提交上回算（见文末「里程碑回算」），保证可比。
>
> ⚠️ 本表 2026-07-26 修订前的旧数字（825 / 173,374 等）系统性偏低，原因是当时的复现命令用了 `git ls-files 'src/**/*.ts'`——git pathspec 的 `**` 要求至少一层中间目录，**该 glob 漏掉了 `src/` 根下的 9 个文件，其中包括入口 `main.ts` 和 `bootstrap.ts`**。少算约 4,600 行源码。文末命令已改用 `src` 目录 pathspec，不再依赖 `**` 语义。引用旧版本文档数字时请注意这一点。

## 为什么这些数字重要 · Why It Matters

**测试纪律接近 1:1。** 编码 agent 的核心逻辑（多轮循环、工具流水线、上下文压缩）以难测著称，开源 agent 项目普遍测试覆盖很薄。本项目测试与源码近等量，覆盖 agent 循环、runtime hook 流水线、前缀缓存字节稳定性、压缩边界、工具执行、TUI 渲染引擎等核心路径——changelog 里的事故修复通常带回归测试。

**Nearly 1:1 test-to-source ratio.** Agent core logic is notoriously hard to test. This project pairs ~256k lines of tests with ~258k lines of CLI source, covering the agent loop, runtime-hook pipeline, prefix-cache byte stability, compaction boundaries, tool execution, and the ANSI rendering engine. The ratio has held between 0.93:1 and 0.99:1 while the codebase grew ~4.5x in 87 days.

**前缀缓存是被工程化的成本指标。** DeepSeek V4 对缓存未命中按命中的至多 50 倍计费。冻结前缀、增量附录字节稳定、请求确定性序列化、压缩只在用户边界重写历史。长会话稳态命中率实测 95–99%。

**Prefix-cache hit rate is engineered as a first-class cost metric.** Frozen prefixes, byte-stable delta appendices, deterministic request serialization, and boundary-only history rewrites deliver a measured 95–99% steady-state hit rate on long sessions.

## 同类项目规模参考 · Ecosystem Context

> 以下为 2026 年 7 月上旬 GitHub 公开数据快照，仅供规模参考，会随时间变化。各项目定位不同，不构成能力对比。

| 项目 | Stars | 语言 | 许可 | 备注 |
|------|-------|------|------|------|
| opencode | ~183k | TypeScript | MIT | Anomaly 团队,460+ 贡献者,模型无关 |
| Claude Code | ~137k | 闭源核心 | 闭源 | Anthropic 官方,仓库为插件/文档 |
| Codex CLI | ~95k | Rust | Apache-2.0 | OpenAI 官方,~70 crate 工作区 |
| Cline | ~62k | TypeScript | 开源 | VS Code 扩展,500 万+ 安装 |
| aider | ~46k | Python | Apache-2.0 | 个人项目,680 万+ pip 安装 |
| **天枢 Tianshu** | 早期 | TypeScript | Apache-2.0 | 个人项目,DeepSeek 前缀缓存深度优化 |

天枢在社区规模上是早期项目;上表想说明的是另一件事:**在工程纪律维度(测试:源码 ≈ 1:1、事故驱动的回归测试文化、字节级缓存稳定性工程),本项目对标的是第一梯队标准,而非早期项目的常见水位。**

## 复现方法 · How to Reproduce

在仓库根目录执行:

```bash
# 测试用例总数 · 执行态口径
# 注意：runner 为绕开 Windows 命令行长度上限而分批 spawn（scripts/run-node-tests.ts），
# 每批各打一份 "ℹ tests N" 小计且没有总计行——直接看输出末尾会严重少计，必须求和。
npm test 2>&1 | grep -E '^. (tests|pass|fail) ' | awk '{a[$2]+=$3} END {for (k in a) print k, a[k]}'

# 测试用例总数 · 静态口径（声明数，秒级返回，用于日常对表）
git ls-files -- src | grep -E '\.test\.ts$' | xargs grep -cE '^\s*(await )?(test|it)\(' | awk -F: '{s+=$NF} END {print s}'

# 源码 / 测试 文件数与行数
# 用 src 目录 pathspec，不要用 'src/**/*.ts'——git 的 ** 要求至少一层中间目录，
# 会静默漏掉 src/ 根下的 main.ts / bootstrap.ts 等 9 个文件（约 4,600 行）。
git ls-files -- src | grep -E '\.tsx?$' | grep -v '__tests__\|\.test\.\|\.spec\.' | xargs wc -l | tail -1
git ls-files -- src | grep -E '(\.test\.ts$|__tests__/)' | xargs wc -l | tail -1

# 只要文件数
git ls-files -- src | grep -E '\.tsx?$' | grep -v '__tests__\|\.test\.\|\.spec\.' | wc -l
git ls-files -- src | grep -E '(\.test\.ts$|__tests__/)' | wc -l

# 桌面端
git ls-files -- desktop | grep -E '\.tsx?$' | grep -v '__tests__\|\.test\.' | xargs wc -l | tail -1

# Hook 模块数
ls src/agent/hooks/*.ts | grep -v '\.test\.' | wc -l

# 类型检查
npm run typecheck

# 前缀缓存命中率实测（需 DEEPSEEK_API_KEY）
npm exec -- tsx scripts/verify-cache-hit-rate.ts

# 里程碑回算（把 <commit> 换成历史提交，用于复核上方里程碑表）
git ls-tree -r --name-only <commit> -- src | grep -E '\.tsx?$' | grep -v '__tests__\|\.test\.\|\.spec\.' | wc -l
git ls-tree -r --name-only <commit> -- src | grep -E '(\.test\.ts$|__tests__/)' \
  | while read f; do git show "<commit>:$f"; done | wc -l
git rev-list --count <commit>
```

> 注意：`git ls-files` 读的是索引 + 工作树。多会话并行开发时，别的会话未暂存的删除会让 `wc -l` 报 `No such file or directory` 并少算该文件行数——量指标前先 `git status` 确认工作树干净，或改用上面的 `git ls-tree` 快照口径。
