# 工程质量指标 · Engineering Metrics

> [🏠 返回主文档](../README.md) · [🌐 English README](../README.en.md) · [🏗️ 架构总览](./architecture-overview.md)
>
> 基线切片截至 **2026-09-30（v3.27.0）**，同时附 **2026-10-14（v3.31.0）** 最新仓库复测快照。复现命令见文末。
> Baseline milestone slice as of **2026-09-30 (v3.27.0)**, alongside the latest **2026-10-14 (v3.31.0)** HEAD snapshot. Reproduction commands at the bottom.
>
> 本仓库 2026-05-15 建仓。行数每天都在随迭代演进，这里的数字是**量级快照**，跑命令复现时差几百行是正常的，不必对齐到个位。2026-09-30 这一列为四舍五入记录；2026-10-14（v3.31.0）为当前公开仓实测值。

## 核心指标 · Key Metrics

| 指标 Metric | 2026-09-30 基线 (`v3.27.0`) | 2026-10-14 最新 (`v3.31.0`) |
|------|------|------|
| 版本 Version | **3.27.0**（`package.json`） | **3.31.0**（`package.json`） |
| `src/` 源码 (TypeScript, 不含测试) | **约 1,256 文件 / 30 万行**（最大的 `agent/` 有 483 个文件） | **1,475 文件 / 约 29.5 万行** |
| `src/` 测试代码 | **约 1,592 文件 / 31 万行** | **1,875 文件 / 约 31.9 万行** |
| 测试 : 源码 行数比 | **约 1 : 1** | **约 1.08 : 1（维持近 1 : 1）** |
| 测试用例 · 静态声明 | **19,462**（`test(` + `it(` 计数；README 徽章取下限 **19,000+**） | **21,514**（`test(` + `it(` 静态计数） |
| 测试用例 · 执行态 | 复现命令见文末（全量分批跑约 30 分钟级；2026-07-26 实测为 13,125 / 2,251 suites） | 复现命令见文末（`npm test` 分批汇总） |
| `desktop/src` | **约 450 文件 / 9.6 万行**（React），另有约 **1.1 万行** Rust | 桌面端已迁入独立闭源构建线（见 `EXTERNAL-PRS.md`） |
| `vscode-extension/src` | **17 文件 / 约 2,700 行** | **32 文件 / 约 4,500 行** |
| 运行时 Hook 模块 (`src/agent/hooks/*.ts`) | **75** | **75** |
| 内置工具模块 (`src/tools/`, 含子目录) | **161**（2026-08-28 计数；preset 四档装配 30 / 31 / 51 / 14；其余 EXTENDED / 装配注入） | **preset 四档装配 30 / 31 / 51 / 14**（minimal / frontend / full / taiyi） |
| 星域 (`STAR_DOMAINS`) | **16** | **16** |
| 建仓日期 | **2026-05-15**（138 天 @ 09-30） | **2026-05-15**（152 天 @ 10-14） |
| 累计提交（HEAD） | **8,008**（当天记录；全分支复测 8,969；近 30 天 1,769） | 见开发主仓（公开仓为同步投影） |
| 类型检查 | `tsc --noEmit` strict + `noUncheckedIndexedAccess` | `tsc --noEmit` strict + `noUncheckedIndexedAccess` |

> 测试用例总数随套件演进，README 的「19,000+」是数量级声明而非单次锁死数字（截至 `v3.31.0` 静态声明已达 **21,514**）。两种口径都要会看：**静态口径**数源码里 `test(` / `it(` 的声明数；**执行态口径**跑 `npm test` 并把各批小计求和——runner 分批 spawn，输出末尾那行 `tests N` 只是最后一批，直接引用会严重少计。命令见文末。
>
> 文件数口径：2026-08-28 那一列的 **1,361** 是 `git ls-files` 口径（`.test.ts` + `__tests__/` 全部 TypeScript），其中 `__tests__/` 下有若干不被 runner 直接执行的 fixture / helper 文件。「跑了多少文件」与「测试目录有多少文件」是两个不同问题，复现时注意区分。2026-09-30 的 **约 1,592** 是同一类文件的四舍五入记录，不是当天重新 `wc` 到个位。

## 迭代里程碑 · Growth Milestones

六个时间切片。前四列取样点：首次留下规模记录的 `18366754`（2026-06-02）、`5cf06afc`（2026-07-15）、2026-07-26 快照、2026-08-28。2026-09-30 列是四舍五入记录；2026-10-14 列是 `v3.31.0` 当前快照。

| 指标 | 2026-06-02 | 2026-07-15 | 2026-07-26 | 2026-08-28 | 2026-09-30 | 2026-10-14 | 增幅（自 06-02） |
|------|-----------|-----------|-----------|-----------|-----------|-----------|----------|
| 版本 | — | 2.19.3 | 2.28.0 | 3.8.0 | **3.27.0** | **3.31.0** | — |
| 源码 文件 / 行 | 443 / 57,606 | 841 / 179,095 | 931 / 207,930 | 1,078 / 257,623 | **约 1,256 / 30 万** | **1,475 / ~29.5 万** | 约 ×5.1 行 |
| 测试 文件 / 行 | 446 / 56,849 | 1,003 / 166,921 | 1,134 / 198,484 | 1,361 / 256,001 | **约 1,592 / 31 万** | **1,875 / ~31.9 万** | 约 ×5.6 行 |
| 测试 : 源码 | ≈0.99 : 1 | ≈0.93 : 1 | ≈0.95 : 1 | ≈0.99 : 1 | **约 1 : 1** | **≈1.08 : 1** | 维持近 1:1 |
| 测试用例（静态声明） | 3,926 | — | 12,981 | 16,471 | **19,462** | **21,514** | ×5.5 |
| 桌面端 文件 / 行 | — | 154 / 34,601 | 204 / 44,317 | 299 / 64,283 | **约 450 / 9.6 万**（`desktop/src`）+ Rust 约 1.1 万行 | 独立闭源构建线 | 口径不同，不算倍数 |
| VS Code 插件 | — | — | — | — | **17 / 约 2,700** | **32 / 约 4,500** | — |
| Hook 模块 | 19 | 62 | 68 | 72 | **75** | **75** | ×3.9 |
| 累计提交（HEAD） | 1,485 | 4,228 | 4,825 | 6,178 | **8,008** | 8,000+ | +6,500+ |
| TUI 渲染路径 | Ink 6 (React) | 纯 ANSI | 纯 ANSI | 纯 ANSI | **纯 ANSI** | **纯 ANSI** | 整层置换 |

两点值得单独说明：

**测试比例没有被规模稀释。** 从 2026-06-02 到本次快照，源码行数约增至 5.2 倍，测试约增至 5.5 倍，比值始终在 1:1 附近（早期切片 0.93–0.99，本次约 1:1）。规模扩张期最常见的退化是测试增速掉队，这里没有发生。

桌面端前四列是 `git ls-files -- desktop` 的 ts/tsx（不含测试）。2026-09-30 列改记 `desktop/src` 的 React 行数，并把 Rust 单独写出，所以不与前几列相减算倍数。

**TUI 渲染路径在此期间整层置换。** 2026-06-02 时是 Ink 6（React for Terminal），现为自研纯 ANSI 引擎（`src/tui/engine/`），React 渲染路径已完全退役。因此跨越该窗口的历史文档若描述 TUI 技术栈，一律以本表为准。

> 口径说明：各历史列均用同一条 `git ls-tree` 命令在对应提交上回算（见文末「里程碑回算」），保证可比。
>
> ⚠️ 本表 2026-07-26 修订前的旧数字（825 / 173,374 等）系统性偏低，原因是当时的复现命令用了 `git ls-files 'src/**/*.ts'`——git pathspec 的 `**` 要求至少一层中间目录，**该 glob 漏掉了 `src/` 根下的 9 个文件，其中包括入口 `main.ts` 和 `bootstrap.ts`**。少算约 4,600 行源码。文末命令已改用 `src` 目录 pathspec，不再依赖 `**` 语义。引用旧版本文档数字时请注意这一点。

## 为什么这些数字重要 · Why It Matters

**测试纪律接近 1:1。** 编码 agent 的核心逻辑（多轮循环、工具流水线、上下文压缩）以难测著称，开源 agent 项目普遍测试覆盖很薄。本项目测试与源码近等量，覆盖 agent 循环、runtime hook 流水线、前缀缓存字节稳定性、压缩边界、工具执行、TUI 渲染引擎等核心路径——changelog 里的事故修复通常带回归测试。

**Nearly 1:1 test-to-source ratio.** Agent core logic is notoriously hard to test. This project pairs ~310k lines of tests with ~300k lines of `src/` source, covering the agent loop, runtime-hook pipeline, prefix-cache byte stability, compaction boundaries, tool execution, and the ANSI rendering engine. The ratio has stayed near 1:1 (earlier slices sat between 0.93:1 and 0.99:1) while source lines grew about 5.2× in 120 days from the 2026-06-02 baseline.

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
