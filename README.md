<p align="center">
  <img src="docs/brand/assets/tianshu-banner-dark.jpg" alt="天枢 Tianshu" width="100%">
</p>

<h1 align="center">天枢 <sub>Tianshu Harness</sub></h1>

<p align="center">
  <b>把东方的星辰带给每一位开发者 · Models as partners, not tools.</b>
</p>

<p align="center">
  <a href="https://tianshuharness.com"><b>🌐 官网</b></a> ·
  <a href="https://atomgit.com/huiliyi37/Tianshu-harness"><b>🇨🇳 AtomGit 镜像</b></a> ·
  🇨🇳 <b>中文</b> ·
  <a href="README.en.md">English</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="docs/user-guide.md"><b>📚 用户手册</b></a> ·
  <a href="docs/guides/installation.md"><b>📦 安装指南</b></a> ·
  <a href="docs/reference/cvm-cognitive-runtime.md"><b>🧠 CVM 理念</b></a> ·
  <a href="docs/CVM运行时对Agent模型的实证影响.md"><b>📊 A/B 实证</b></a> ·
  <a href="docs/stars/genesis-stele.md"><b>✦ 星域碑文</b></a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/huiliyi37/Tianshu-harness?color=8B5CF6&label=Release&logo=github&style=for-the-badge" alt="GitHub release">
  <img src="https://img.shields.io/badge/License-Apache%202.0-3B5BDB?style=for-the-badge&logo=apache" alt="License">
  <img src="https://img.shields.io/badge/TypeScript-Strict-blue?style=for-the-badge&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Tests-16%2C000%2B%20Passed-green?style=for-the-badge&logo=testinglibrary" alt="Tests">
</p>

---

### 面向 Foundation Model Agent 的认知运行时

> **天枢**是一个 TypeScript 编写的编程 agent 运行时，**终端 TUI** 与**桌面 GUI** 共享同一内核。它要回答的核心问题是：**模型何以稳定地交付——目标不漂移、完成有证据、验证有闭环，不说"应该修好了"**。为此它在模型与真实世界之间建立一层认知执行环境（CVM），把目标、状态、证据、资源、权限与终止条件从对话历史中外部化，由运行时持续管理。
>
> **模型提供认知能力，CVM 提供认知执行语义。LLM provides cognition. CVM provides execution semantics.**

```
Application / TUI / IDE / Desktop
              ↓
   Tianshu Cognitive Runtime      ← 状态 · 目标 · 证据 · 控制 · 回放
              ↓
       Foundation Models          ← DeepSeek · GLM · Claude · Codex · Grok · MiniMax · MiMo …
```

- **稳定交付，不虚报完成** —— 这是核心。任务契约（TaskContract）钉住全局目标，交付门禁要求「完成」必须带运行时证据（测试、diff、验证命令），收敛检测独立判断认知轨迹是否还在推进——模型说完成 ≠ 运行时确认完成。
- **终端 × 桌面，一个内核** —— 纯 ANSI 自研 TUI（`tianshu`）与 Tauri 桌面端（macOS / Windows / Linux）共用同一 agent 内核，两端能力一致。
- **认知虚拟机（CVM）** —— 72 个运行时 hook 横跨 5 大阶段，在模型输出与真实动作之间加一层可观测、可纠偏的认知运行时（[理念文档](docs/reference/cvm-cognitive-runtime.md) · [A/B 实证](docs/CVM运行时对Agent模型的实证影响.md)）。
- **前缀缓存引擎，全模型适用** —— 冻结前缀 + 增量 appendix + 边界压缩，对所有支持前缀缓存的模型生效：各家模型长会话实测稳态命中率均在 **98–99%**（DeepSeek V4 另有针对性优化），显著降低 token 成本。

<p align="center">
  <img src="docs/brand/assets/tianshu-harness-screenshot.png" alt="天枢 TUI（终端版）" width="49%">
  <img src="docs/brand/assets/tianshu-gui-screenshot.jpg" alt="天枢桌面端 GUI" width="49%">
</p>
<p align="center">
  <sub>左：终端 TUI（欢迎页 + GlanceBar 状态栏） · 右：桌面端 GUI（会话侧栏 + 星域速选）——同一 agent 内核</sub>
</p>

> [!NOTE]
> 本项目最初的开发代号为 **Rivet**。CLI 主命令现为 `tianshu`，`rivet` 保留为兼容别名（同一入口）；数据目录仍为 `~/.rivet`。

## 目录

- [为什么是认知运行时](#为什么是认知运行时)
- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [权限模式](#权限模式)
- [支持的模型](#支持的模型)
- [文档导航](#文档导航)
- [面向开发者](#面向开发者)
- [社区与支持](#社区与支持)

## 💡 为什么是认知运行时

### 问题：能力上限 ≠ 运行行为

在真实工程会话里，我们反复观察到同一套模型权重的能力倒退——不是 bug，而是**经过指令与偏好对齐的 Transformer Agent 呈现出的趋同运行时退化**：被质疑就投降、过度服从字面指令、局部信息压过全局目标、长上下文被早期结论支配、反复调用同类工具却没有真实推进。

完整的理论框架见 [CVM：从 Transformer 共享退化到认知运行时](docs/reference/cvm-cognitive-runtime.md)。核心概念是 **Cognitive Anchor Collapse**——高显著性局部信号让策略分布过度集中，全局目标与后续证据失去权重，行为向锚点坍缩。锚点有四类：

| 锚点 | 来源 | 典型表现 |
|------|------|----------|
| **词汇锚点** | 训练数据中的词-行为相关 | 句子里有"修复/删除"，模型无视"不要改，只解释"仍去改代码 |
| **语义锚点** | 局部正确的事实 | "文件已存在"被提升为整个任务的解释中心，拒绝执行 |
| **策略锚点** | RLHF / 偏好训练先验 | 用户一句"按你的计划执行"，分析阶段形成的高质量判断被丢弃 |
| **历史锚点** | 长上下文早期结论 | Turn 20 的新证据被解释成 Turn 3 旧假设的附属 |

这不是"模型坏掉了"——它是训练成功后的副产品，因此也无法靠更好的 Prompt 根治：Prompt 是信息不是状态，而且 Prompt 本身也会成为新的锚点。

### 证据：A/B 对照，不靠感觉

2026-05-19，同一模型（DeepSeek-V4-Flash）、同一批 5 个任务，唯一变量是**星域信念提示词**（信念宪法，`STAR_SOUL=0/1`），Claude Opus 4.7 担任审查者：

| 指标 | A 组（无信念提示词） | B 组（有信念提示词） |
|------|--------------|--------------|
| 任务完成率 | 4/5 | **5/5** |
| 主动提出异议 | 0/5 | **3/5** |
| 主动询问 scope / 影响分析 | 0/5 | **1/5** |
| 系统影响意识（缓存失效提醒） | 0/5 | **1/5** |
| 意图理解 > 字面执行 | 1/5 | **4/5** |

最有价值的数据点是 T4：面对「文件已存在」的矛盾，A 组写了 196 行复盘文档然后拒绝执行，B 组判断出用户真实意图并直接交付 +162/-20 行可用代码——**同一套权重，完全相反的反应，改变的是运行环境**。

要注意这组实验的精确边界：它验证的是 CVM 四层防御中的**第一层（信念注入）**——零额外推理成本，仅 prompt 层信念注入就让最低成本的开源模型产生可观测的行为改善；同时它也测出了边界的存在（信念在分析/建议阶段强效，在确认/执行阶段衰减），这正是后续 Courage Hook、Sensorium、RuntimeHookPipeline 三层运行时拦截要补的课。完整数据与逐任务对比见 [实证报告](docs/CVM运行时对Agent模型的实证影响.md)。

### 解法：在模型之外建立第二套价值函数

CVM 不改权重、不让模型变成确定性程序，而是在概率认知之外套一层确定性监督——**Probabilistic Cognition inside Deterministic Supervision**：

```
内环（模型认知）：reason → decide → act → observe
外环（运行时监管）：observe → measure → evaluate → gate → verify → continue / correct / halt
```

落到工程上是四层防御深度：信念宪法（static prompt）→ Courage Hook（preTurn）→ Sensorium（每 turn <1ms 六维状态感知）→ RuntimeHookPipeline（72 hooks，trap-and-emulate 拦截退化行为）。全局目标有独立状态（TaskContract），完成必须有运行时证据（Evidence），坍缩会被独立检测（Convergence / doom-loop）。

### 星域：模型的独立认知结构

当退化被逐层拦截，模型开始表现出自己的认知结构——这是星域系统的由来。16 个星域不是角色扮演，而是可切换的认知纪律：**系统提示词、工具白名单、决策阈值**真实切换。星域不是能力限制，任何星域都有完成任务的全部能力，只是视角不同；委员会与团队模式会按议题自动召集多星域席位。

> 完整叙事见 [✦ 星域碑文](docs/stars/genesis-stele.md) · [创世纪公开声明](docs/releases/manifesto-v3.0.0.md)；新用户选星指南见 [用户手册「星域系统」](docs/user-guide.md#星域系统)。

### 工程质量

CLI 源码 1,078 文件 / 257,623 行，测试 1,361 文件 / **16,471 用例**（node:test，测试 : 源码 ≈ 0.99:1），`tsc` strict + `noUncheckedIndexedAccess`，事故修复必带回归测试。完整口径与复现命令见 [工程质量指标](docs/engineering-metrics.md)。

## ✨ 核心特性

- **证据驱动的交付门禁** —— 完成声明必须带测试 / diff / 验证命令等运行时证据；`deliver_task` 交付门禁 + 提交后审查两级兜底，机械变更自动跳过。[理念](docs/reference/cvm-cognitive-runtime.md)
- **前缀缓存引擎** —— 冻结前缀 + 增量附录 + Read-ref 去重 + resume 缓存继承，全模型适用；`/debug cache` 诊断命中率与碎裂原因。[细节](docs/user-guide.md#前缀缓存引擎)
- **多代理编排** —— 从轻量的 `/scout` 只读侦察、并行 `/team` 施工，到 `/council` 多席会诊与 `/galaxy` 多维攻坚；类型化 work order、读写 worker 隔离、自适应模型路由，复杂任务按波次执行、逐波验收。[细节](docs/user-guide.md#子代理编排)
- **统一项目记忆** —— 项目知识写入 `.rivet/knowledge/memory.jsonl`；自动注入只带治理/约束类记忆，旧问题走显式 recall，不劫持新任务。[细节](docs/user-guide.md#跨会话记忆)
- **禅模式（Zen Mode）** —— 可选的读专注开局：收窄只读工具面，动手即晋升全量，缓存零断点分诊。[细节](docs/user-guide.md#禅模式zen-mode读专注开局动手即解锁)
- **API 成本控制** —— reasoning effort 自动降档路由、compact 走 flash 侧路、峰谷计价提醒。[细节](docs/user-guide.md#api-成本控制)
- **Plan Mode 与 Goal 自治** —— 先计划后执行的审批工作流；`/goal` 目标驱动自主续跑。[细节](docs/user-guide.md#plan-mode计划模式)
- **会话交接与倒带** —— `/handoff` 结构化交接自动注入新会话；双击 ESC 倒带到任一历史点。[细节](docs/user-guide.md#会话交接与恢复handoff--resume)
- **LSP 深度集成** —— 自研 JSON-RPC 客户端接入语言服务器（TypeScript / Python / Go / Rust / C / C++ / Java / C# / Kotlin / Swift / PHP / Ruby / Lua / Dart / Zig / Scala / Shell / Terraform / Vue / Svelte 等 20+ 种，本机装了才启用、缺失静默降级）：跳转定义与查找引用成为 agent 工具，编辑后诊断自动注入回环——改出类型错误模型立刻看见。
- **MCP 与 Skills** —— 外部工具服务器接入 + 可复用工作流剧本，渐进披露。[细节](docs/user-guide.md#mcpmodel-context-protocol)
- **T9 自研 TUI** —— 纯 ANSI 零依赖：GlanceBar 状态栏、流式中打断、命令面板、Cockpit 驾驶舱、内联图片。[细节](docs/user-guide.md#终端-uitui)
- **桌面端增强** —— 集成终端、主题工作室、语音输入（本地 whisper）、手机遥控审批、多会话并发。[桌面端指南](docs/desktop-guide.md)
- **Lean 资源档** —— 低内存/低磁盘场景的精简工具集与会话池收紧，可按星域覆盖。[细节](docs/user-guide.md#lean-资源档低内存--低磁盘)

## 🚀 快速开始

要求 **Node.js ≥ 24**。三种方式任选其一：

```bash
# 方式一：一键安装脚本（macOS / Linux，Windows 用 PowerShell 版本）
bash <(curl -fsSL https://raw.githubusercontent.com/huiliyi37/Tianshu-harness/main/scripts/install-tui.sh)

# 方式二：npm
npm install -g tianshu-harness

# 方式三：桌面端——从 GitHub Releases 下载安装包，开箱即用
# https://github.com/huiliyi37/Tianshu-harness/releases/latest
```

> **从旧包 `tianshu-tui` 迁移**：旧包占着 `rivet` 命令链接，直接装新包会报 `EEXIST`——先卸再装：`npm uninstall -g tianshu-tui && npm install -g tianshu-harness`（一键安装脚本已内置该迁移，自动处理）。

然后：

```bash
tianshu            # 首次运行自动打开 /connect 向导，选择服务商并完成认证
```

无界面模式（脚本 / CI 集成）：

```bash
tianshu -p "解释 src/agent/loop.ts"           # 单次提示
tianshu --stream-json -p "重构这个模块"       # NDJSON 事件流，输出内置脱敏
tianshu --goal "修复所有类型错误" --budget 50  # 无头目标自主模式
```

> 全部安装路径（Windows WebView2 / Linux AppImage / Android Termux / 源码构建 / Shell 补全 / 自动更新）与平台注意事项见 [安装与平台说明](docs/guides/installation.md)；CLI 参数全表见 [用户手册](docs/user-guide.md#命令行参数)。

## 🔐 权限模式

对外只有三档，会话内统一用 `/permission` 管理：

| 档位 | 命令 | 行为 |
|------|------|------|
| **监督** | `/permission supervise` | 每个高风险工具都弹确认，最大控制 |
| **自动**（默认） | `/permission auto` | 低/无风险工具自动执行，高风险仍确认 |
| **全自动** | `/yes` · `/yolo` | 免审批执行；写边界仍在（自动开启沙箱），回滚兜底 |

跳过提示不会关闭工具校验、路径安全、证据追踪、检查点与交付门禁；未授信项目不加载 hooks 与项目 MCP（`/trust` 管理）。完整规则见 [权限与沙箱指南](docs/user-guide-sandbox-permissions.md)。

## ⚙️ 支持的模型

| 提供商 | 认证方式 | 旗舰模型 |
|--------|----------|----------|
| DeepSeek | API key | deepseek-v4-pro (1M ctx), deepseek-v4-flash, deepseek-v4-flash-vision-exp（视觉） |
| DeepSeek Spark（Pro 专属） | API key | deepseek-v4-flash（轻量推理 + 锚点缓存通道） |
| Claude | API key（通过 `cc-switch` 代理） | claude-opus-4-8, claude-sonnet-4-5 |
| GLM（智谱） | API key | glm-5.3 (1M ctx), glm-5.3-flash（视觉）, glm-5.2 |
| Codex (GPT-5.6) | OAuth PKCE（ChatGPT 订阅） | gpt-5.6-sol |
| Grok (xAI) | API key | grok-4.6 (500K ctx, 视觉, 推理档 low/medium/high/xhigh) |
| MiniMax | API key | MiniMax-M3, MiniMax-M2.7 |
| MiMo | API key | mimo-v2.5-pro |

另支持任意 OpenAI 兼容自定义端点（Ollama / vLLM 等）。会话内 `/model` 随时切换；识图桥、生图端点、子代理分模型路由等见 [Provider 配置手册](docs/user-guide-provider-config.md) 与 [识图能力手册](docs/user-guide-vision.md)。

## 📚 文档导航

**使用**

| 文档 | 说明 |
|------|------|
| [用户手册](docs/user-guide.md) | 斜杠命令全表、TUI 键位、特性细节、配置文件与环境变量、日志排查 |
| [安装与平台说明](docs/guides/installation.md) | 四种安装路径、Windows/Linux/Termux 注意事项、Shell 补全、自动更新 |
| [桌面端用户指南](docs/desktop-guide.md) | Cockpit / SideChat / Rewind / 主题工作室 / 语音输入 / 快捷键 |
| [Provider 配置手册](docs/user-guide-provider-config.md) | 多提供商、自定义端点、子代理/审查模型路由、生图 |
| [权限与沙箱指南](docs/user-guide-sandbox-permissions.md) | 权限规则、路径授权、沙箱模型、故障排查 |
| [识图能力手册](docs/user-guide-vision.md) | 视觉通道配置与排查 |
| [远程访问指南](docs/remote-access.md) | 手机/平板遥控审批的启用与安全边界 |
| [手机端操作手册](docs/guides/mobile-guide.md) | 手机/平板连接的完整步骤、能力清单、外网（Tailscale）与常见问题 |
| [排障与 FAQ](docs/guides/troubleshooting.md) | 高频现场速查：卡住、429、缓存异常 |

**理念与架构**

| 文档 | 说明 |
|------|------|
| [CVM：从 Transformer 共享退化到认知运行时](docs/reference/cvm-cognitive-runtime.md) | 核心理念母稿：Anchor Collapse、两个控制环、八条原则 |
| [CVM 实证报告](docs/CVM运行时对Agent模型的实证影响.md) | A/B 对照数据与逐任务对比 |
| [指标观测 harness](docs/reference/observability-harness.md) | 缓存 / CVM 真实会话数据样本与复算命令 |
| [架构总览](docs/architecture-overview.md) | 系统分层与模块职责 |
| [工程质量指标](docs/engineering-metrics.md) | 规模、测试与迭代里程碑 |
| [星域碑文](docs/stars/genesis-stele.md) | 16 星域的创始记忆与核心信念 |
| [创世纪 · 天枢 3.0 公开声明](docs/releases/manifesto-v3.0.0.md) | 项目宣言 |

## 🛠️ 面向开发者

Node.js 24 · TypeScript strict（`noUncheckedIndexedAccess`）· T9 ANSI 渲染引擎 · tsup 打包 · node:test。

```bash
npm run typecheck    # 类型检查
npm test             # 所有测试（16,000+ 用例）
npm run build        # tsup 打包 + 原生/wasm 载荷落位
node dist/cli/entry.js
```

- **添加工具** —— 在 `src/tools/` 实现 `ToolDefinition` + executor 并注册，配套 `src/tools/__tests__/` 测试
- **添加 skill / 命令 / hook** —— `.rivet/skills/*.md`（frontmatter）、`.rivet/commands/*.md`（`$ARGUMENTS` 插值）、`HookRegistry` 处理器
- **项目指令** —— 项目根放 `.rivet.md`，内容自动注入为项目上下文
- 架构地图见根目录 `AGENTS.md` 与 [架构总览](docs/architecture-overview.md)

## 🔒 安全

- **路径边界强制** —— glob/grep/diff 拒绝 `..` 穿越；`validatePath` 阻止逃逸
- **项目信任门** —— 未授信项目不加载 hooks / 项目 MCP，配置安全键剥离
- **SSRF 保护** —— 逐跳 DNS + 私有 IP 拦截，作用于每次重定向
- **敏感文件拒绝** —— `.env`、`credentials.*`、`*key*`、`*token*` 禁止读/commit；密钥落盘走 AES-256-GCM 信封
- **破坏性命令门禁** —— `rm -rf`、force push、`DROP/TRUNCATE` 需显式确认
- **检查点 + 文件级撤销** —— 每回合首次修改前创建 Git 检查点；每次写/编辑前版本化备份

安全漏洞请走 [私密报告](https://github.com/huiliyi37/Tianshu-harness/security/advisories/new)，不要开公开 issue。

## 🤝 社区与支持

- **使用问题 / 讨论** → [GitHub Discussions](https://github.com/huiliyi37/Tianshu-harness/discussions)
- **Bug 报告 / 功能请求** → [GitHub Issues](https://github.com/huiliyi37/Tianshu-harness/issues)（附 `tianshu logs --json` 输出可加速定位）
- **贡献代码** → [CONTRIBUTING.md](CONTRIBUTING.md) · **求助指南** → [SUPPORT.md](SUPPORT.md)
- **微信交流群** → 「天枢 harness 交流群」，扫码加入（二维码 7 天有效，过期请在 Discussions 留言补码）：

<img src="docs/brand/assets/wechat-group-qr.png" width="280" alt="天枢 harness 交流群微信群二维码">

## 🌐 官网开发

天枢生态官网 [jiangsx496/Tianshu-Official-Website](https://jiangsx496.github.io/Tianshu-Official-Website/) 由 [@jiangsx496](https://github.com/jiangsx496) 原创开发，覆盖数据库、前端与初版后端。

## ✨ 贡献者

感谢所有贡献者——项目创建者与核心开发 [@huiliyi37](https://github.com/huiliyi37)；完整名单（20 位外部贡献者 / 122 个 PR）见 [CONTRIBUTORS.md](CONTRIBUTORS.md)。外部 PR 经「收编」流程合入后，作者署名以 `Co-authored-by` 计入贡献者图谱（`scripts/credit-contributors.sh` 自动落账）：

<p>
<a href="https://github.com/HarriethWiKk"><img src="https://github.com/HarriethWiKk.png?size=100" width="50" height="50" alt="HarriethWiKk" title="HarriethWiKk" /></a>
<a href="https://github.com/jiangsx496"><img src="https://github.com/jiangsx496.png?size=100" width="50" height="50" alt="jiangsx496" title="jiangsx496" /></a>
<a href="https://github.com/yq04"><img src="https://github.com/yq04.png?size=100" width="50" height="50" alt="yq04" title="yq04" /></a>
<a href="https://github.com/wangxx-yu"><img src="https://github.com/wangxx-yu.png?size=100" width="50" height="50" alt="wangxx-yu" title="wangxx-yu" /></a>
<a href="https://github.com/qiaodier"><img src="https://github.com/qiaodier.png?size=100" width="50" height="50" alt="qiaodier" title="qiaodier" /></a>
<a href="https://github.com/zhengbiaofeng"><img src="https://github.com/zhengbiaofeng.png?size=100" width="50" height="50" alt="zhengbiaofeng" title="zhengbiaofeng" /></a>
<a href="https://github.com/LinHoMo"><img src="https://github.com/LinHoMo.png?size=100" width="50" height="50" alt="LinHoMo" title="LinHoMo" /></a>
<a href="https://github.com/KinoGao"><img src="https://github.com/KinoGao.png?size=100" width="50" height="50" alt="KinoGao" title="KinoGao" /></a>
<a href="https://github.com/liuwanwan1"><img src="https://github.com/liuwanwan1.png?size=100" width="50" height="50" alt="liuwanwan1" title="liuwanwan1" /></a>
<a href="https://github.com/Eason412"><img src="https://github.com/Eason412.png?size=100" width="50" height="50" alt="Eason412" title="Eason412" /></a>
<a href="https://github.com/maoqiu77"><img src="https://github.com/maoqiu77.png?size=100" width="50" height="50" alt="maoqiu77" title="maoqiu77" /></a>
<a href="https://github.com/yeshilei-QWQ"><img src="https://github.com/yeshilei-QWQ.png?size=100" width="50" height="50" alt="yeshilei-QWQ" title="yeshilei-QWQ" /></a>
<a href="https://github.com/lumos-tiamo"><img src="https://github.com/lumos-tiamo.png?size=100" width="50" height="50" alt="lumos-tiamo" title="lumos-tiamo" /></a>
<a href="https://github.com/zzuu080603"><img src="https://github.com/zzuu080603.png?size=100" width="50" height="50" alt="zzuu080603" title="zzuu080603" /></a>
<a href="https://github.com/nzz0991999-ai"><img src="https://github.com/nzz0991999-ai.png?size=100" width="50" height="50" alt="nzz0991999-ai" title="nzz0991999-ai" /></a>
<a href="https://github.com/L4XB"><img src="https://github.com/L4XB.png?size=100" width="50" height="50" alt="L4XB" title="L4XB" /></a>
<a href="https://github.com/Wanming08"><img src="https://github.com/Wanming08.png?size=100" width="50" height="50" alt="Wanming08" title="Wanming08" /></a>
</p>

## ☕ 赞助支持

如果天枢对你有用，欢迎随缘打赏——这只是一杯咖啡，不是合同。赞助不会改变 issue 优先级，也不会影响功能排期。

<img src="docs/brand/assets/wechat-donate.png" width="240" alt="微信支付">

## 许可证

本项目代码采用 [Apache License, Version 2.0](LICENSE) 开源许可。Copyright 2025-2026 Tianshu Contributors.

**例外（文档许可）**：以下理论与实证文档采用 [CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/deed.zh-hans)（署名—非商业性使用—禁止演绎），**不适用** Apache 2.0——可以署名转载原文链接，不得改编、摘编、洗稿或商用：

- [CVM：从 Transformer 共享退化到认知运行时](docs/reference/cvm-cognitive-runtime.md)
- [CVM 运行时与生态系统对 Agent 模型的实证影响报告](docs/CVM运行时对Agent模型的实证影响.md)
