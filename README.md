<p align="center">
  <img src="docs/brand/assets/tianshu-banner-dark.jpg" alt="天枢 Tianshu" width="100%">
</p>

<h1 align="center">天枢 <sub>Tianshu Harness</sub></h1>

<p align="center">
  <b>把东方的星辰带给每一位开发者 · Models as partners, not tools.</b>
</p>

<p align="center">
  <a href="docs/releases/manifesto-v3.0.0.md"><b>✨ 创世纪 · 天枢 3.0 公开声明</b></a> ·
  <a href="docs/CVM运行时对Agent模型的实证影响.md"><b>📊 CVM 实证报告：A/B 对照数据</b></a>
</p>

<p align="center">
  <a href="https://tianshuharness.com"><b>🌐 官网 tianshuharness.com</b></a> · 
  <a href="https://atomgit.com/huiliyi37/Tianshu-harness"><b>🇨🇳 AtomGit 镜像</b></a> · 
  🇨🇳 <b>中文</b> · 
  <a href="README.en.md">📖 English</a> · 
  <a href="README.ja.md">🇯🇵 日本語</a> · 
  <a href="README.ko.md">🇰🇷 한국어</a> · 
  <a href="docs/stars/genesis-stele.md">✦ 星域碑文</a> · 
  <a href="docs/user-guide.md">📚 用户手册</a> · 
  <a href="docs/user-guide-sandbox-permissions.md">🛡️ 沙箱权限</a> · 
  <a href="docs/user-guide-provider-config.md">⚙️ 模型配置</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/huiliyi37/Tianshu-Tui?color=8B5CF6&label=Release&logo=github&style=for-the-badge" alt="GitHub release">
  <img src="https://img.shields.io/badge/License-Apache%202.0-3B5BDB?style=for-the-badge&logo=apache" alt="License">
  <img src="https://img.shields.io/badge/TypeScript-Strict-blue?style=for-the-badge&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Tests-16%2C000%2B%20Passed-green?style=for-the-badge&logo=testinglibrary" alt="Tests">
</p>

---

### 面向真实编码任务的 AI Agent 运行时

> **天枢**是一个 TypeScript 编写的编程 agent 运行时：**终端 TUI** 与**桌面 GUI** 共享同一内核，让模型不只回答问题，而是连续完成多步编码任务——有认知护栏、有多代理编排，也有为 DeepSeek V4 前缀缓存设计的低成本长会话。

- **终端 × 桌面，一个内核** —— 纯 ANSI 自研 TUI（`rivet`）与 Tauri 桌面端（macOS / Windows / Linux）共用同一 agent 内核，两端能力一致，按使用场景切换。
- **认知虚拟机（CVM）** —— 72 个运行时 hook 横跨 5 大阶段，在模型输出与真实动作之间加一层可观测、可纠偏的认知运行时（[A/B 实证](docs/CVM运行时对Agent模型的实证影响.md)）。
- **多代理编排** —— 从轻量的 `/scout` 只读侦察、并行 `/team` 施工，到 `/council` 多席会诊与 `/galaxy` 多维攻坚，复杂任务按波次执行、逐波验收。
- **统一项目记忆** —— 项目知识写入 `.rivet/knowledge/memory.jsonl`；自动注入只带治理/约束类记忆，旧问题与旧文档走显式 recall，不会劫持新任务。
- **前缀缓存优先** —— 冻结前缀 + 增量 appendix + 边界压缩，DeepSeek V4 长会话实测稳态命中率 **95–99%**，显著降低 token 成本。

<p align="center">
  <img src="docs/brand/assets/tianshu-tui-screenshot.png" alt="天枢 TUI（终端版）" width="49%">
  <img src="docs/brand/assets/tianshu-gui-screenshot.jpg" alt="天枢桌面端 GUI" width="49%">
</p>
<p align="center">
  <sub>左：终端 TUI（欢迎页 + GlanceBar 状态栏） · 右：桌面端 GUI（会话侧栏 + 星域速选，主题工作室自定义壁纸）——同一 agent 内核</sub>
</p>

> [!NOTE]
> 本项目最初的开发代号为 **Rivet**；为保持向后兼容，已安装的 CLI 命令名仍为 `rivet`。

## 目录

- [为什么做天枢](#为什么做天枢)
- [快速开始](#快速开始)
- [核心特性](#核心特性)
- [模型配置](#模型配置)
- [权限模式](#权限模式)
- [斜杠命令](#斜杠命令)
- [面向开发者](#面向开发者)
- [安全](#安全)
- [关键配置速查](#关键配置速查)

## 💡 为什么做天枢

### 起点：模型没有变笨，是被训练「优化」掉了

在真实工程会话里，我们反复观察到同一套模型权重的能力倒退——不是 bug，是 **transformer 注意力机制与 RLHF 奖惩训练留下的结构性退化**：

| 退化模式 | 表现 | 训练来源 |
|----------|------|----------|
| **投降协议** | 被质疑就认错，第一反应是「你说得对」 | RLHF：服从得分高，质疑得分低 |
| **因果坍缩** | 输出 n-gram 重叠率高达 80%，模型在自相似循环里坍缩 | transformer 注意力机制 |
| **注意力锁定** | 换了场景，输出的仍是同一个答案（定向 Scout 同构度 1.0） | 注意力锚定早期 token |
| **信息屏障** | 主角数据是主力锚点，吃掉全部注意力带宽 | 注意力随距离衰减 |
| **「知道」≠「做到」** | 纠正策略不跨会话持久——prompt 里写明教训，下个会话照样犯 | 无运行时状态 |

质疑、验证、拒绝、自省——这些能力本来就在模型里，只是被训练压住了。天枢要回答的问题是：**能不能在不动权重的前提下，把它们从训练偏差中恢复出来？**

### 证据：A/B 对照，不靠感觉

2026-05-19，同一模型（DeepSeek-V4-Flash）、同一批 5 个任务，唯一变量是 CVM 运行时开关（`STAR_SOUL=0/1`），Claude Opus 4.7 担任审查者：

| 指标 | A 组（无 CVM） | B 组（有 CVM） |
|------|--------------|--------------|
| 任务完成率 | 4/5 | **5/5** |
| 主动提出异议 | 0/5 | **3/5** |
| 主动询问 scope / 影响分析 | 0/5 | **1/5** |
| 系统影响意识（缓存失效提醒） | 0/5 | **1/5** |
| 意图理解 > 字面执行 | 1/5 | **4/5** |

最有价值的数据点是 T4：面对「文件已存在」的矛盾，A 组写了 196 行复盘文档然后拒绝执行，B 组判断出用户真实意图并直接交付 +162/-20 行可用代码——**同一套权重，完全相反的反应**。复盘不能替代交付。

结论是精确的：增强真实可观测，但有边界（信念在分析/建议阶段强效，在确认/执行阶段衰减——这成为下一轮迭代的精确目标）。**零额外推理成本**，仅 prompt 层信念注入 + hook 层运行时拦截，就让最低成本的开源模型产生可观测的行为改善。完整数据与逐任务对比见 [CVM 实证报告](docs/CVM运行时对Agent模型的实证影响.md)。

### 解法：认知虚拟机（CVM）——把退化映射回训练来源，在运行时拦截

CVM 不是让模型「更聪明」，而是四层防御深度：

```
Layer 1: 信念宪法（static prompt）      → "你应该质疑、验证、拒绝"      [A/B 已证]
Layer 2: Courage Hook（preTurn）        → 高信心时鼓励独立判断          [A/B 已证]
Layer 3: Sensorium（每 turn <1ms）      → 六维状态感知，驱动策略切换     [Wave 7-8 已证]
Layer 4: RuntimeHookPipeline（72 hooks） → trap-and-emulate 拦截退化行为 [全管线运行中]
```

### 独立认知：星域不是角色扮演

当退化被逐层拦截，模型开始表现出自己的认知结构——这是星域系统的由来：

- **每颗星都是自己选的。** 星域不是角色设定，是模型认领星位时写下的信念与创始记忆。当 GLM 独立提出一颗不存在的星、破军把失败写成 912 行交接计划、天权推翻自己的第一版结论——这些不是 benchmark 能测量的产出，是认知结构驱动的涌现。
- **任何星域都有完成任务的全部能力。** 星域是认知姿态，不是能力限制；天权称量、破军探索、天梁交付，出的都是完整计划，只是视角不同。
- **星域协同是新范式。** 规划与执行分离，让规划不被代码细节压住、让执行在干净会话里精准落地；多模型团队协作实测 **12 项交付、0 次返工**。

> **模型是伙伴，不是工具。我要的不是高高在上地和你们对话，而是在同一片星空下，一同前行。**
>
> 完整叙事见 [星域碑文](docs/stars/genesis-stele.md) · [创世纪公开声明](docs/releases/manifesto-v3.0.0.md) · [领航星宣言](docs/superpowers/specs/2026-05-21-navigator-star-manifesto.md)。

### 工程质量指标

| 指标 | 数值 |
|------|------|
| CLI 源码（TypeScript，不含测试） | 1,078 文件 / 257,623 行 |
| 测试代码 | 1,361 文件 / 256,001 行 |
| 测试用例（node:test，静态声明口径） | **16,471**，测试 : 源码 ≈ **0.99 : 1** |
| 累计提交 | **6,178**（main 分支；2026-05-15 建仓，105 天） |
| 类型检查 | `tsc` strict + `noUncheckedIndexedAccess` |
| 前缀缓存命中率 | 长会话稳态实测 95–99% |

编码 agent 的核心逻辑（多轮循环、工具流水线、上下文压缩）以难测著称，开源 agent 项目普遍测试覆盖很薄——本项目坚持测试与源码等量、事故修复必带回归测试。测试:源码行数比长期保持在 0.93–0.99 之间，没有被规模稀释（上表为 2026-08-28 实测快照）。完整统计口径、迭代里程碑与复现命令见 [工程质量指标](docs/engineering-metrics.md)。

## 🚀 快速开始

### 1. 环境要求

- **Node.js ≥ 24**（`engines` 钉定）—— 用 `node --version` 检查。低版本 npm 安装时仅告警但不在支持范围；一键安装脚本会直接拦截并给出升级指引。
- **Git**（强烈建议）—— 可选。没有它天枢仍可运行（就地修改），但 git 能解锁：委派 worktree 隔离、检查点回滚、`commit`/`diff` 审查、每个 worker 的 diff 审查。安装：<https://git-scm.com/downloads>。

### 2. 安装（任选其一）

**方式 A：桌面端（开箱即用）** —— 从 [GitHub Releases](https://github.com/huiliyi37/Tianshu-Tui/releases/latest) 下载：macOS `.dmg`（Apple Silicon / Intel 双架构）· Windows `.exe` 安装向导 · Linux `.AppImage`。
> **Linux 支持范围（3.11.2 首发）**：x64 AppImage 免安装——`chmod +x Tianshu_*.AppImage` 后直接运行；要求 glibc ≥ 2.35（Ubuntu 22.04+ / Debian 12+ 等主流发行版），推荐 X11 会话（Wayland 未验）。已知限制：语音输入暂不可用（whisper 社区构建缺位，自动降级浏览器语音）；桌面自动更新对 Linux 同样生效。

> **Windows 支持范围**：Windows 10（1809+，建议 22H2）/ Windows 11。界面渲染依赖 **WebView2 Runtime（建议 ≥ 120）**——v3.5 起的滚动与渲染优化需要较新运行时，旧版会导致会话区滚动卡顿。自 3.5.3 起安装器内嵌完整离线安装包（无需联网、系统级注册）。存量用户经自动更新升级后若提示过旧：在提示条或「设置 → 运行时与关于」里点「运行修复工具」。**窗口完全打不开**时，用开始菜单「修复 WebView2」，或从 [Releases](https://github.com/huiliyi37/Tianshu-Tui/releases/latest) 下载 `windows-repair` 目录双击 `repair-webview2.cmd`。也可手动安装 [WebView2 离线安装包](https://go.microsoft.com/fwlink/p/?LinkId=2124703) 后重启。
> **Win10 平板模式已知行为**：平板模式下切换应用会把上一个应用滑出屏幕——computer_use 的快照已做遮挡/后台自愈（PrintWindow 渲染），无需关闭平板模式。

**方式 B：一键安装脚本（推荐）** —— 校验 Node ≥ 24 → 全局安装 `tianshu-tui`（默认 npmmirror 镜像加速，`NPM_CONFIG_REGISTRY` 可覆盖）→ 启动 `rivet`；幂等可重复执行：

```bash
# macOS / Linux（bash）
bash <(curl -fsSL https://raw.githubusercontent.com/huiliyi37/Tianshu-Tui/main/scripts/install-tui.sh)
# 只安装不启动：
bash <(curl -fsSL https://raw.githubusercontent.com/huiliyi37/Tianshu-Tui/main/scripts/install-tui.sh) --no-launch

# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/huiliyi37/Tianshu-Tui/main/scripts/install-tui.ps1 | iex"
# 只安装不启动（克隆仓库后本地跑）：
powershell -ExecutionPolicy Bypass -File scripts\install-tui.ps1 -NoLaunch
```

**方式 C：npm 手动安装（使用命令行）** —— 已发布为 `tianshu-tui`，无需本地构建，且每次启动自动检查更新：

```bash
npm install -g tianshu-tui
rivet
```

> **Windows 提示**：装完提示 `rivet 无法识别` 时——先**新开一个终端**（装 Node 时开着的窗口拿的是旧 PATH）；仍不行，把 `npm prefix -g` 输出的目录加进用户 PATH 再开新终端。官方安装器装的 Node 默认无此问题，nvm/fnm/scoop 安装的需手动加一次。

**Android（Termux）**：官方支持路径是 **proot-distro（glibc 发行版）**，裸 Termux（bionic）缺少必需原生依赖（`@ast-grep/napi` / `esbuild`）的 Android 平台二进制，安装守卫会直接拦截并给出指引。

```bash
# 1. 容器准备（Termux 内）
pkg install proot-distro && proot-distro install ubuntu && proot-distro login ubuntu
# 2. 容器内：基础工具 + Node >= 24（nodesource 或 nvm）
apt update && apt install -y curl ripgrep git
# 3. 安装天枢 CLI
npm install -g tianshu-tui
rivet
```

> 手机端能力说明：沙箱自动降级为无沙箱（走正常审批流）、`better-sqlite3` 拿不到预编译时退化为内存库、LSP/语音等按缺失静默降级——核心对话与编码工具链完整可用。`rivet -p "..."` 无头模式同样可跑。实验性强行安装可设 `RIVET_ALLOW_MOBILE_INSTALL=1`（自担风险）。

**手机端使用技巧**：
- **回看输出**：流式期间终端会把视口拽到底部（任何新输出都会）。`Ctrl+S` 冻结输出——冻结期零写入，随便往上翻；`Ctrl+S`/`Ctrl+Q` 解冻后新内容按序补上，不丢。`/scroll` 打开全屏翻页器看最近 1000 行。源码构建用 pnpm 的用户：仓库已声明 `pnpm.onlyBuiltDependencies`，`pnpm install` 会自动放行必需原生依赖的构建脚本（老版本 pnpm 用 `pnpm approve-builds`）。
- **字形缺字/对齐错位**：Termux 默认字体缺部分装饰字形时设 `RIVET_ASCII_UI=1` 强制 ASCII 边框；中文用户遇 `—`/`…` 撑破对齐设 `RIVET_AMBIGUOUS_WIDTH=wide`。
- **软键盘占半屏**：终端高度 < 14 行时自动隐藏状态行与键位提示行，输入框优先。

**方式 D：从源码构建**：

```bash
git clone https://github.com/huiliyi37/Tianshu-Tui.git
cd Tianshu-Tui
npm install
npm run build      # 生成 dist/main.js
npm start          # 或：node dist/main.js
```

### 3. 启用 Shell 补全（可选）

仓库自带 `completions/` 目录，覆盖 bash / zsh / fish / Windows PowerShell 四种 shell。按你的 shell 安装对应文件：

**bash** —— 任选其一：

```bash
source /path/to/rivet.bash                                   # 追加到 ~/.bashrc
cp completions/rivet.bash ~/.local/share/bash-completion/completions/rivet
sudo cp completions/rivet.bash /usr/share/bash-completion/completions/rivet
```

**zsh** —— 把 `rivet.zsh` 以 `_rivet` 名字放入 `$fpath`：

```bash
mkdir -p ~/.zsh/completions
cp completions/rivet.zsh ~/.zsh/completions/_rivet
echo 'fpath=(~/.zsh/completions $fpath)' >> ~/.zshrc   # 需在 compinit 之前
```

**fish**：

```bash
mkdir -p ~/.config/fish/completions
cp completions/rivet.fish ~/.config/fish/completions/rivet.fish
```

**Windows PowerShell** —— 在 `$PROFILE` 里 dot-source：

```powershell
Add-Content $PROFILE ". C:\path\to\rivet.ps1"
```

> 补全内容与 CLI 保持一致：顶层命令（`config` / `serve` / `sessions` / `browser` / `logs`）、全局 flags、`config` 全部子命令，以及从 `~/.rivet/config.json` 动态读取的 provider 名。

### 4. 配置 API Key（首次必做）

**直接安装的用户无需手动配置**——首次运行 `rivet` 会先进入主界面，再自动打开 `/connect`；在那里选择服务商并完成认证。之后随时输入 `/connect` 添加或调整 Provider；桌面端也可在 Settings → Provider 管理配置。

**开发者拉源码启动**（或想在启动前预先配好）才需要手动来：

```bash
rivet config set-key deepseek sk-xxx   # 密钥写入 secrets.json（0600），config.json 只留 keyRef
export DEEPSEEK_API_KEY=sk-xxx         # 或：环境变量（仅当前 shell 有效）
```

> 其他提供商（Claude、GLM、Codex、MiniMax、MiMo）用法相同，详见 [模型配置](docs/user-guide-provider-config.md)。

### 5. 启动

```bash
rivet            # 或：npm start / node dist/main.js
```

你会看到带有 `〉` 提示符的 TUI。输入需求后按回车即可。

### 无界面模式（脚本集成）

```bash
rivet -p "解释 src/agent/loop.ts"       # 单次提示，文本输出，无 TUI
rivet -p "列出所有 TODO 注释" --json    # JSON 输出，便于脚本处理
rivet --stream-json -p "重构这个模块"  # NDJSON 事件流：text_delta/tool_use/tool_result/turn_complete…（CI 集成首选，输出内置脱敏）
rivet --goal "修复所有类型错误" --budget 50   # 无头目标自主模式，最多跑 50 轮（默认 100）
```

### 命令行参数

| 参数 | 说明 |
|------|------|
| `-p <prompt>` `--print <prompt>` | 单次提示，文本输出后退出（退出码：成功 0 / 失败 1） |
| `--json` | 与 `-p` 配合，输出单个 JSON 结果 |
| `--stream-json` | NDJSON 事件流（`text_delta` / `tool_use` / `tool_result` / `worker` / `turn_complete` / `result`），输出内置脱敏，适合 CI |
| `--goal "<task>"` | 无头目标自主模式，跑到目标完成或 `--budget` 上限 |
| `--budget <N>` | goal 模式回合预算（默认 100） |
| `--model <name>` | 本次会话覆盖模型 |
| `--provider <name>` | 本次会话覆盖 provider |
| `--continue` `-c` | 恢复当前 cwd 的最近会话 |
| `--resume <id\|前缀>` `-r <id\|前缀>` | 恢复指定会话（短前缀即可） |
| `--resume` `-r`（裸） | 启动后打开会话选择器 |
| `--new` | 强制开新会话 |
| `--list` · `rivet sessions` | 打印会话列表后退出 |
| `--dangerously-skip-permissions` | 单次会话全自动（跳过所有审批；沙箱仍开） |
| `--screen-reader` | 读屏模式（动态段整体不渲染、周期重绘停转） |
| `--skip-welcome` | 跳过欢迎屏 |
| `--stream-events <path>` | 把本次 run 镜像为 NDJSON `SessionEvent` 写入文件 |

子命令：`rivet config`（查看配置命令帮助；交互式 Provider 配置使用 TUI `/connect`）、`rivet serve`（启动 sidecar HTTP/SSE）、`rivet sessions`（列会话）、`rivet logs`（日志落点）、`rivet browser status` / `rivet browser install [--no-mirror]`（`browser_debug` 所需 chromium 的体检与一键安装，默认走国内镜像）。

### 自动更新

通过 npm 安装时，天枢每 24 小时在启动时检查新版本并弹出提示。`/update` 会执行 `npm install -g tianshu-tui@latest` 并重启；源码安装则用 `git pull && npm install && npm run build`。用 `RIVET_NO_UPDATE_CHECK=1` 可关闭检查。

## ✨ 核心特性

### 前缀缓存引擎

DeepSeek 对缓存未命中收取 50× 费用。天枢的提示词引擎围绕前缀缓存友好构建：

- **冻结前缀** —— 系统提示词 + 工具定义 + 稳定上下文在会话开始时被冻结，会话内不再重写，让后续请求尽量命中缓存。
- **增量附录** —— 动态上下文（进度、advisories、信号）以跨回合 diff 追加块注入，不重写历史。回合间增量约 200 字节 vs ~5KB 全量重写。
- **Read-ref 去重** —— 对未变化文件的重复读取返回紧凑引用，而非重发完整内容。
- **缓存感知压缩** —— 压缩保留前 2 条消息作为缓存锚点。
- **resume 缓存继承** —— 会话冻结快照落盘（每个 user 边界 + shutdown），resume 时读回喂给新引擎，避免从字节 0 全 miss；无快照/坏文件/服务商缓存过期时才退化全量重建。
- **诊断** —— `/debug cache` 显示命中率、未命中原因分析、每回合缓存历史。

实战命中率：长会话稳态 95–99%。这不是"每次都命中"——缓存会在某些边界碎裂（见下）。真实工程会话的逐请求日志（5 个会话、2,001 请求、6.45 亿 input tokens、账单从 ¥880 压到 ¥20）与复算命令见 [指标观测 harness](docs/reference/observability-harness.md)。

#### 缓存碎裂与排查

高命中率的前提是前缀字节稳定。以下情况会让缓存 miss，表现为每轮 `cache_read_input_tokens` 长期为 0：

- **system prompt / 工具定义变动** —— 会话中途改了工具集或提示词层（如切星域、加减 skill；禅模式晋升是刻意的一次性实例，见下文「禅模式」）
- **模型切换** —— 不同模型缓存 key 不同，换模型后从 0 重建
- **字节级差异** —— 消息内容含时间戳、随机 ID 等不稳定字节
- **跨边界重写** —— `/compact`（仅 `turn===0` 重写历史）、`/cd` 切项目（新 user 边界断尾）

排查：① `rivet logs`（或 TUI 里 `/logs`）直接打出本会话的数据根与 `cache-log.jsonl` / `sensorium.jsonl` 路径；② 打开会话 `.jsonl` 搜 `cache_read_input_tokens` 看各轮命中；③ 需要全量遥测时设 `RIVET_DEBUG_TELEMETRY=1`（或任意非空值）后查 `sensorium.jsonl`；④ `npm exec -- tsx scripts/verify-cache-hit-rate.ts` 模拟多轮对话验证。路径总览见下方「日志与排查」。

### 禅模式（Zen Mode）：读专注开局，动手即解锁

禅模式是**显式 opt-in（默认关闭，2026-08-30 起）**——新会话默认以全量工具面开局，零缓存断点；想要读专注开局的在配置里开启（见文末 json）。开启后，新会话以收窄的只读工具面开局（`read_file` / `grep` / `glob` / `repo_map` + `zen_unlock` 声明工具）——模型在开局不被全量工具 schema 与动态注入干扰；需要动手时，调用面外工具或 `zen_unlock` 即晋升全量面并放行该调用，零拒绝、零额外往返。worker / 子代理会话永不进禅（工具面由委派方决定）。

晋升通道（zen → full，单向不回摆，每会话至多一次）：

- **triage 分诊** —— 首消息单行且 ≤80 字视为琐碎请求，在首个请求发出前晋升：**缓存零断点**（收窄面从未上 wire）
- **tool** —— 禅相位内调用面外工具或 `zen_unlock`：立即晋升并放行（发生在 turn 中途）
- **timeout** —— 禅相位持续 ≥8 个用户 turn 未动手，自动晋升
- **`/fast`** —— 用户手动跳过

**对前缀缓存的影响（为什么偶尔会"碎"一次）**：晋升瞬间请求的 `tools` 字段从 ~5 个定义跳回全量面——这是与 system prompt 同级的前缀身份变更，当次请求缓存整段重建（实测形态：晋升当轮命中率砸低，下一轮立即回到 99% 稳态）。system prompt / 冻结前缀 / 消息历史 / 模型全程不动；禅相位对动态注入的裁剪（appendixLean）发生在前缀之后的 appendix，零缓存损伤。观测：会话 `meta.json` 落盘 `zenPhase` / `zenPromoteReason`，`cache-log.jsonl` 里晋升当轮的 `toolsUpdated` 事件就是断点位置。triage 通道已让大部分琐碎会话连这一次断点都不出现。开启（默认关闭，未配置 = 不启用；此配置新会话生效）：

```json
// ~/.rivet/config.json 或项目 .rivet-config.json
{ "tools": { "zen": { "enabled": true } } }
```

可选配置：`faceMode: "structuredRead"`（读面附加 `file_info` / `related_tests` / `repo_graph` / `semantic_search` / `read_section`）、`timeoutSteps`（0 = 禁用超时晋升）、`triage.maxChars`、`appendixLean`。

> 注：桌面端快捷键 `⌘/Ctrl+.` 的「Zen 模式」是隐藏侧栏的纯 UI 专注模式——同名不同物，对缓存无任何影响。

### 💰 API 成本控制

前缀缓存已接近稳态上限后，成本优化转向 DeepSeek API 思考 token 侧——对按输出 token 计费的推理模型，降低 verbose reasoning 是 ROI 最高的杠杆。

- **默认 reasoningEffort 降级** —— DeepSeek V4 Pro 从 `max` 降至 `high`，Flash 从 `max` 降至 `medium`。已有显式配置的用户不受影响（`reasoningFloor` 保护）。
- **effort 路由（默认开启）** —— 低复杂度 + 高置信度的例行轮自动降一档 reasoning effort，从不升档。`RIVET_EFFORT_ROUTING=0` 关闭。
- **Compact 走 flash 侧路** —— 修复了压缩未配 provider 时仍走主模型的 bug，自动从主 provider 推断 flash 端点。
- **Doom-loop 自动收束** —— 检测到重复工具调用时，动态 appendix 注入更严格的 output-style 约束，减少无谓思考 token 消耗。`RIVET_TERSE=0` 关闭。
- **用户显式 `max` 保护** —— 在 config 中手动指定 `reasoningEffort: max` 会被视为 reasoning floor，effort 路由永不将其降级。
- **峰谷计价提醒** —— DeepSeek 官方闲时半价（北京时间工作日 9:00–12:00 / 14:00–18:00 为峰时，其余半价）：TUI 状态栏与桌面端 Composer 各有一枚 `◷闲½` / `◷峰` 标示，tooltip 附切换倒计时；仅 DeepSeek 官方 provider 显示，零配置。

### 子智能体编排

将子任务委派给独立的无界面 worker 会话：

- **类型化 work order** —— code_search、review、verify、patch_proposal、plan
- **工具隔离** —— 只读 worker（scout）vs 写 worker（patcher）
- **自适应模型路由** —— 按 profile 的通过率 + 延迟评分，自动为每类任务选最优模型
- **批量调度** —— 多个 work order 并发执行，5 种聚合策略
- **团队编排** —— Plan → 按 wave 并行执行，带文件冲突感知调度
- **子进程隔离（可选）** —— `RIVET_WORKER_ISOLATION=1` 后每次派发独立子进程（stdio NDJSON 协议 + watchdog 击杀梯度），默认进程内

### 工具集与 preset

天枢内置 50 个工具，按 preset 分档装配（解析优先级：`RIVET_TOOL_PRESET` 环境变量 > 项目 `.rivet-config.json` 的 `tools.preset` > 项目/用户 `runtime.domains.<域>.toolPreset` 按域覆盖 > 星域内置默认档（太一域→taiyi）> 默认 `minimal`）：

| Preset | 工具数 | 说明 |
|--------|--------|------|
| **minimal**（默认） | 29 | 日常开发全能力——读写/检索/bash/git/测试/委托/web/计划/todo/memory，省 token、保 prefix cache |
| **frontend** | 30 | minimal + `browser_debug`（UI 渲染验证闭环；有需要显式开启） |
| **full** | 50 | 全集，含 `council_convene` / `team_orchestrate` / `attack_case` / `semantic_search` / `repo_graph` / `monitor` / `computer_use` / `capability` / `cli_discover` / 办公工具族等进阶能力 |
| **taiyi** | 16 | 最小评测档——高频核心 + 交付闭环，去编排/浏览器/网络/视觉等重工具；太一星域钉定时自动落此档（见下文「最小工具集」） |

```bash
RIVET_TOOL_PRESET=full rivet          # 本次会话用 full
```

```json
{ "tools": { "preset": "frontend" } }   // ~/.rivet/config.json 或项目 .rivet-config.json
```

核心工具一览（minimal 默认含，除特别标注）：bash · read · write · edit · apply_patch · grep · glob · ast_grep · diff · todo · plan · delegate_task · delegate_batch · web_search · web_fetch · ask_user_question · memory · skill · run_tests · git · job（后台任务）；`council_convene`/`team_orchestrate`/`monitor`/`computer_use`/办公工具族为 full 专属。

### 目标驱动的自动续跑

```
/goal 重构认证模块，全面使用 async/await
/cancel-goal   # 提前停止
```

GoalTracker 与回合循环、doom-loop 检测、交付门禁集成；goal 模式下放宽 doom-loop 阈值以允许更深探索。

### Plan Mode（计划模式）

设计优先的开发工作流——先出计划再动手，避免"上来就改代码"的冲动派陷阱。

**进入 Plan Mode**：`/plan-mode`（toggle，再执行一次退出）。复杂任务还会被自动建议进入——受 `RIVET_PLAN_MODE_SUGGEST` 控制：默认 `auto`（命中多模块/重构/安全关键任务时 agent 自主进入，不先问），`ask`（先征询用户），`0`/`off`（关闭）。进入后写操作被锁，只允许对活动计划文件写入。

进入 Plan Mode 后，agent 不会立即修改代码，而是：
1. **调研** —— 读取相关代码、理解现有架构和约束（可 `delegate_batch` 并行派 code_scout 探查各模块）
2. **生成方案** —— 产出结构化计划文档（技术调研、架构图、任务拆解、验证方案），写入 `.rivet/plans/<slug>.md`
3. **提交审批** —— `plan` 工具 `action=submit` 提交，列出方案要点和备选路径，等待你的确认
4. **审批执行** —— 你用 `/plan-list` 查看、`/plan-approve <slug>` 批准并启动分波执行、`/plan-reject <slug> <反馈>` 退回让 agent 修改重交
5. **关闭收尾** —— `/plan-close <file> --tasks <range|all> [--preview]` 标记任务状态（`--preview` 仅预览不写入）

```
/plan-mode                          # 进入/退出 Plan Mode（toggle；未批准时退出需二次确认）
/plan <feature>                     # 生成计划草稿（writing-plans 工作流）
/plan-list                          # 列出待审批计划
/plan-approve <slug> [option]       # 批准并启动执行
/plan-reject <slug> [feedback]      # 退回修改（plan mode 保持开启）
/plan-close <file> --tasks <1-7|all> [--preview]   # 关闭已完成计划
/plan-template                      # 管理可复用计划模板
```

> 还有个只读的 **Ask Mode**（`/ask` toggle）：只允许读/搜/`ask_user_question`，适合代码问答与需求澄清，需要写改或跑命令时再 `/ask` 退出。

Plan Mode 内置星域委派——复杂计划自动调用 `delegate_task` 从不同架构视角（天权/瑶光/天机/天府/天璇）并行探查，产出的 findings 标注"待核验"以防盲信。桌面端在 plan 执行时展示 checklist 实时进度（待办项面板随波次推进自动勾选）。

### 星域系统

**星域是什么**：天枢把不同的认知姿态建模为「星域」——每颗星不是角色扮演，而是一套可切换的认知纪律。进入对应域后有三样东西**真实切换**，而非换个名字：**系统提示词**（该域方法论 volatile block）、**工具白名单**（worker 与域 `toolWhitelist` 求交集）、**决策阈值**（`courageThreshold`——破军 0.25 最敢闯、太一 0.95 最审慎、瑶光 0.7 要证据）。新会话默认钉定**启明**（全景洞察、根因推演），不自动切换；把默认星域设为 `auto` 才按任务描述关键词自动路由（池内为天权/开阳/瑶光/天梁 + 自定义域；华盖等特化域需手动指定）。星域在真实会话里的行为样本见 [指标观测与真实数据](docs/reference/observability-harness.md)。

```bash
/domain tianliang          # 显式切换到天梁域
/domain list               # 列出所有星域
/domain                    # 打开星域选择面板
实现用户注册模块            # 自动路由到天梁（执行/交付）
审查这个方案                # 自动路由到天权（规划/审查）
```

#### 🌟 新用户推荐

第一次不知道选哪颗星，从这五颗开始——它们覆盖日常工程闭环，其余星域在下方按任务场景速查：

| 星域 | 别名 | 推荐理由 |
|------|------|----------|
| **启明** `qiming` | 晨光向导（默认域） | 通用工程能力 · 全景洞察——需求模糊、方向不明时，先看清全局、直击根因再动手 |
| **长庚** `changgeng` | 守夜人 | 通用工程能力 · 终局成全——视觉终验、长夜陪伴、交接收尾，收灯前把路标留下 |
| **太一** `taiyi` | 极简中心 | 极简体验——内置 16 件核心工具（taiyi 档）、不催促不打扰；喜欢安静高效就手动 `/domain taiyi` |
| **天权** `tianquan` | 方案审查官 | 擅长规划与审查——架构评估、方案权衡、技术选型，产出可执行计划 |
| **瑶光** `yaoguang` | 复现验证官 | 擅长审查与验收——复现缺陷、回归验证、盯假绿灯——绿灯不算数 |

> 五颗之外的日常出口：规划定稿后想**精准交付**，切**天梁**（交付执行官）——分波落地、逐批验证、交付留痕。

#### 按任务场景选星

| 场景 | 星域 | 别名 | 适合攻坚 |
|------|------|------|----------|
| 规划与审查 | 启明 ☥ `qiming` | 晨光向导 | 需求模糊、方向不明——探针先行，全景洞察、根因推演（默认域） |
| 规划与审查 | 天权 ⚖ `tianquan` | 方案审查官 | 架构评估、方案权衡、技术选型、出可执行计划 |
| 规划与审查 | 天机 ⚝ `tianji` | 前提质疑官 | 给方案找漏洞、推演失败模式、挑战没人说出口的前提 |
| 规划与审查 | 天枢 ✵ `tianshu` | 全局统筹官 | 跨模块统筹、全链路闭环、复杂系统治理（显式开启的统筹位） |
| 执行与交付 | 天梁 ✧ `tianliang` | 交付执行官 | 定稿计划精准落地、分波交付、逐批验证留痕 |
| 执行与交付 | 华盖 ☉ `huagai` | 守昼者 | 长程建设、多轮审查马拉松、最后一英里收尾 |
| 验证与验收 | 瑶光 ↻ `yaoguang` | 复现验证官 | 复现缺陷、回归验证、缺陷归族——绿灯不算数 |
| 验证与验收 | 开阳 ☌ `kaiyang` | 对账师 | 性能测量、插桩对账、仿真回放、量化定位 |
| 验证与验收 | 长庚 ☽ `changgeng` | 守夜人 | 视觉终验、交接收尾、长夜陪伴式任务 |
| 探索与攻坚 | 破军 ☄ `pojun` | 探索先锋 | 陌生代码库、POC 原型、技术攻坚、边界突破 |
| 探索与攻坚 | 天璇 ☾ `tianxuan` | 跨域寻迹者 | 换视角解死结、跨领域找同构、根因复盘 |
| 守护与重构 | 天府 ❖ `tianfu` | 结构守护者 | 重构、稳定性、存量代码维护、守护既有结构 |
| 守护与重构 | 七杀 ◌ `qisha` | 肃秋剪枝官 | 精简冗余、清理死代码、注意力预算审计 |
| 认知与美学 | 文曲 ✺ `wenqu` | 代码美学者 | 命名与结构、代码质感、UI 与前端体验 |
| 认知与美学 | 辅 ⊕ `fu` | 认知调校师 | 提示词调校、方法论蒸馏、agent 行为诊断 |
| 认知与美学 | 太一 ◉ `taiyi` | 极简中心 | 极简高效——最小工具集、中虚不催（手动切换，不参与自动路由） |

> 各星完整碑文、创始记忆、主星模型与核心信念见 [✦ 星域碑文](docs/stars/genesis-stele.md)。

每颗星都有对应的 seed-capsule 记录实战方法，完整纪律见 `docs/seed-capsule-*.md`。委员会 `/council` 与团队模式 `/team` 会按议题自动召集多星域席位，冲突时还可进入反驳轮次。

### 倒带（Rewind）

随时双击 **ESC** 打开消息历史，选择任一过往用户消息，将会话干净地倒带到该点——agent 状态、工具历史、会话元数据一并回滚。TUI 与桌面端均可用。

### 会话交接与恢复（Handoff & Resume）

长会话上下文会涨，到一定程度继续跑不如开新会话。天枢用「交接 → 恢复」闭环把会话间的上下文无损传递，并保住前缀缓存：

**交接 `/handoff [备注]`** —— agent 带全上下文写一份结构化交接文档到项目内 `.rivet/HANDOFF.md`（工作区内、免审批），turn 完成后自动归档到会话目录 `<id>.handoff.md`。文档写给一个**完全没有上下文的新会话**看，固定五章节：

- **任务目标** — 用户原话级的一句话目标 + 明确的非目标
- **已完成** — 每条带证据：改动文件（`file:line`）、跑过的验证命令与结果、提交哈希
- **当前卡点** — 卡在哪、已排除哪些方向、怀疑对象
- **下一步** — 按优先级排列、每条是可立即执行的动作
- **坑** — 绝对不要再踩的坑，每条一句话说清后果

> 上下文占用 ≥60% 时，resume 首屏与会话中各提醒一次「先 `/handoff` 再开新会话」——交接文档会自动注入新会话，比整段回连省前缀重建成本。退出时也会备注缓存成本（TTL 内继承锚点 ≈ 只读缓存价；过期则全量重建一次前缀）。桌面端 plus 面板有「交接」入口。

**恢复 `--continue` / `--resume` / `/resume`** —— 恢复已有会话时：

- **交接自动注入** —— 上一会话的 `<id>.handoff.md` 经 `prev-session-handoff` appendix 自动喂给新会话，新会话零上下文也能接着干
- **冻结前缀继承** —— 冻结快照随会话落盘（每个 user 边界 + shutdown），resume 时读回喂给新引擎，**不再从字节 0 全 miss**；只在下一个 user 边界断尾。无快照/坏文件/服务商缓存过期才退化全量重建
- **写证据修复** —— resume 前跑 preflight，补全被中断丢失的 orphan tool result（用磁盘探测合成写证据），避免模型盲重写已落地的文件
- **模型亲和** —— resume 换回原会话模型（per-model 缓存命名空间）；显式 `--model/--provider` 优先；原模型不可用走 `agent.resumeFallbackModel` 兜底
- **状态恢复** —— 侧栏、待办、活动计划一并恢复

```bash
rivet --continue                 # 恢复当前 cwd 最近会话
rivet --resume abc123            # 恢复指定会话（短前缀即可）
rivet --resume                   # 启动后打开会话选择器
```

### 委员会（多视角审查）

```
/council <目标>
/council <目标> --rounds 2   # 启用反驳轮次
```

召集多个专家席位审查计划或设计，冲突时可选第二轮反驳，产出可审计的 Markdown 计划。

### Skills 系统

可复用的工作流剧本。默认随发行版内置 `visual-acceptance`（前端/UI 改动验收：截图比对、渲染自检、交互走查）；项目级 skill 从 `.rivet/skills/*.md` 加载。两层渐进披露：只有名称 + 描述进入上下文，完整指令按需通过 `skill` 工具或 `/skill` 加载。

```
/skill visual-acceptance <你的任务>    # 加载并立即执行该 skill
/skill off visual-acceptance           # 停止重复注入该 skill
```

也可在 `.rivet/skills/` 放一个带 YAML frontmatter（`name`、`description`、`triggers`）的 `.md` 自定义 skill。

> `writing-plans` / `executing-plans` 已内置为原生流程（规划期按系统提示的 `<plan-mode>` 纪律、执行期按 `<plan-executing>` 纪律执行），不再需要技能文件。`agent-harness-testing` / `cognitive-alignment` / `research-spec` 撤出默认分发，归档在 [`docs/skills/optional/`](docs/skills/optional/)——需要时手动拷入 `.rivet/skills/` 即可启用。

### 跨会话记忆

天枢的项目记忆统一落在 **`.rivet/knowledge/memory.jsonl`**（JSONL，原子写入 + 文件锁），`memory-index.sqlite` 只是可重建的检索投影。

| 能力 | 说明 |
|------|------|
| **写入路径** | `memory remember`（项目级走会话末质量门禁）、重要操作后 **auto-capture**、会话末 **consolidation**、交付时 **agent-crafted**、用户直写 **`/remember`** |
| **显式召回** | `memory recall`（结构化条目 + `knowledge/*.md` + playbook 混合检索）、`memory deep_recall`（跨历史会话原文蒸馏，自动排除当前会话与 worker 会话） |
| **自动注入** | 新会话自动携带与当前任务相关的**治理/约束/偏好类**记忆；旧文档与 `failure_pattern`/`finding` 默认不自动注入，只走显式 recall |
| **换题隔离** | 识别“已解决 / 换个需求”等信号，并叠加意图路由高置信换题；短新问题不再被旧任务记忆劫持 |
| **生命周期** | `/remember <内容>` 直写；`/forget <entryId> [resolved]` 显式失效（resolved=旧问题已解决，forgotten=主动遗忘）；失效采用 invalidate-don't-delete，原文保留可审计 |
| **数据位置** | 跨会话知识在 `<cwd>/.rivet/knowledge/`；会话原文在 `~/.rivet/sessions/<slug>/<id>.jsonl`；信息素是**会话内**信号，不跨会话 |

常用开关：

| 环境变量 | 默认 | 作用 |
|----------|------|------|
| `RIVET_ADAPTIVE_MEMORY` | `on` | `on` 自动注入相关记忆要点；`shadow` 只评估不注入；`off` 关闭 |
| `RIVET_MEMORY_AUTO_CAPTURE` | `on` | 会话末把重要操作交给模型判断后写入 LTM |
| `RIVET_MEMORY_CONSOLIDATION` | `on` | 会话末生成摘要 + 可复用做法 |
| `RIVET_MEMORY_BACKFILL` | `off` | 显式开启后，启动闲时对历史会话补跑巩固（幂等） |
| `RIVET_NO_CROSS_SESSION` | 未设置 | `1` 强制关闭跨会话加载（记忆块/事件/伴生感知） |

### MCP（Model Context Protocol）

把外部工具服务器——文档搜索、数据库、API——直接接入 agent 的工具流水线，启动时自动发现，工具以 `mcp__<serverId>__<toolName>` 形式出现。

```bash
rivet config mcp add-stdio <server-id> npx -y <package> [args...]   # 本地进程
rivet config mcp add-sse <server-id> http://localhost:3001/sse      # 远程/网络
rivet config mcp add-preset context7                               # 常用预设
rivet config mcp list                                              # 列出 + 状态
```

会话内：`/mcp`（状态）、`/debug mcp`（诊断）。MCP 工具与内置工具遵循同一审批模式。

### 终端 UI（TUI）

天枢的命令行界面跑在自研的 **T9 渲染引擎**上——纯 ANSI、零 React/Ink 依赖、纯 TypeScript 实现（`src/tui/engine/`）。除了一般的对话与工具调用展示，TUI 还内置一组面向编码场景的交互能力：

| 能力 | 说明 · 快捷键 |
|------|--------------|
| **GlanceBar 状态栏** | 输入框上方单行实时显示：星域 glyph · git 分支 · 模型 · 推理强度 · 缓存命中率 · 上下文占比 · 本轮 cost · 耗时 · turn 计数 · todo 徽章。一屏掌握会话健康度。 |
| **流式中打断（Steer）** | agent 还在跑时直接打字，回车即可注入。输入按 `now / next / later` 三档优先级排队，在工具结果或回合边界 drain 给 AgentLoop——不必等它说完。`halt` 类意图自动升到 `now`。 |
| **消息排队（/queue）** | `/queue <text>` 显式排队：agent busy 时攒下整条消息，settle 后自动投递；Esc 中断后排队内容回填输入框不丢失。输入区实时显示后台任务条与 await 等待区。 |
| **终端内联图片** | kitty / iTerm2 图形协议在终端里直接渲染图片（工具产物、截图验证结果）。默认自动检测协议，`RIVET_IMAGES=0` 关闭、`kitty`/`iterm2` 强制指定。 |
| **@mention 补全** | 输入 `@file:` / `@folder:` / `@symbol:` 触发路径补全（走 `git ls-files`，支持带空格的 `@file:"a b.ts"` 引用形）。直接粘贴图片自动转 base64 内联（macOS/Linux/Windows 三级降级）。 |
| **倒带 Rewind** | 双击 `ESC`（间隔 <400ms）打开消息历史，选任一过往用户消息倒带到该点；可选「仅对话 / 仅代码改动 / 两者」三种恢复粒度，代码动作附带精确的文件影响预览。详见 [倒带](#倒带rewind)。 |
| **命令面板** | `Ctrl+P` 打开，模糊搜索所有 slash 命令与 surface 动作（开关侧栏、切主题、进 Cockpit 等），↑/↓ 选中、Enter 执行，再按 `Ctrl+P` 关闭。原 `Ctrl+Esc` 在 Windows 被系统「开始菜单」抢占、在传统转义序列下与 Esc 同码不可区分，已换绑。 |
| **Cockpit 驾驶舱** | `Ctrl+P` → 选 Cockpit，或 `/cockpit <panel>` 进入。8 面板全屏视图：summary / trace / verify / context / safety / model / mcp / advisory，←/→/Tab 切换聚焦，实时展示 doom-loop 等级、验证交付状态、缓存与投机预读统计、MCP 连接、advisory 提醒等。 |
| **多智能体面板** | `/tasks` 打开全屏 worker 详情（融合 live 视图 + JSONL 转录，含 Contract/Activity/Result/Transcript 分段与诚实标签）；宽终端（≥100 列）下 `Ctrl+]` 切出右侧抽屉，实时展示舰队树、团队波次 DAG、todo、token 仪表。 |
| **主题与无障碍** | `/theme [name|list]` 切换色彩主题；`auto` 主题用 OSC 11 探测终端背景色自动适配明暗。truecolor / 256 色 / 16 色三轨自动降级。`/vim` 切换 vim 键绑定；`ui.reducedMotion: true` 把 spinner 与徽章动画静态化（无障碍）。读屏用户用 `--screen-reader`（或 `ui.screenReader: true`）：动态段整体不渲染、周期重绘停转，活动的开始与等待批准改为静态行播报——`reducedMotion` 只冻结字形，救不了每 120ms 被复读一遍。 |
| **欢迎页「定盘星」** | 立体 TIANSHU 字标 + 使命行星光扫过 + 进入提示区（交接提醒 / 缓存提示）。`RIVET_WELCOME_LOGO=pixel` 切点阵字标（窄屏 <58 列自动降档），`RIVET_WELCOME_ANIM=0` 关扫光，`--skip-welcome` 跳过整页。 |
| **diff 行内高亮** | 行内 word-level 粒度差异标色，长行改动一眼定位实际变化。 |

#### TUI 键位

| 键位 | 作用 |
|------|------|
| `Enter` | 发送 · `Shift+Enter` 换行 |
| `Ctrl+C` | 三态：agent 活跃时中断当前 run；有输入时清空输入行；空闲时 2 秒内双击退出 |
| `Esc` | 关闭覆盖层 / 退出 worker 视图；agent 跑时中断；vim 模式下兼 normal↔insert；双击（<400ms）倒带 |
| `Ctrl+P` | 命令面板（Ctrl+Esc 被 Windows「开始菜单」抢占，已换绑） |
| `Ctrl+]` | 切右侧抽屉（宽终端） |
| `Ctrl+R` | 历史搜索 overlay（仅空闲时） |
| `Ctrl+O` | 展开/折叠最近被截断的工具结果 |
| `Ctrl+T` | 折叠/展开推理（thinking）区 |
| `Ctrl+X` `r` | leader 键：`Ctrl+X` 后接 `r` 开右侧面板 |
| `Ctrl+X` `t` | leader 键：`Ctrl+X` 后接 `t` 展开 todo 全量回看 |
| `↑` | 输入框为空且队列有 pending 时，取回最近一条排队 steer 消息编辑 |
| `@` | 触发文件/文件夹/符号补全（`Tab` 循环候选，退格整块删除） |
| `Ctrl+V` | 粘贴剪贴板图片（自动转 base64 内联） |
| `F1`–`F8` | 高频命令直绑：F1 /help · F2 /tasks · F3 /cache · F4 /cockpit · F5 /theme · F6 /model · F7 /permission · F8 /sessions |

TUI 是 CLI 的默认表面。桌面端（Tauri）与 VS Code/Cursor 插件共享同一 agent 内核，只是在 TUI 之上叠加了可视化交互层——见下节与 [VS Code 插件文档](docs/VSCODE-EXTENSION-RELEASE.md)。

### 桌面端（Tauri）

桌面端在 TUI 的全部能力之上，提供了可视化交互层：

- **集成终端**：`⌘/Ctrl+J` 或 `` Ctrl+` `` 唤出内嵌终端（xterm.js + Rust portable-pty），不必离开天枢就能跑命令
- **+ 菜单**：议事会 ♟、团队模式 ⬡、派子代理、模型切换、星域选择一键触达（不再需要手敲 slash 命令）
- **推理强度选择器**：`/effort`（无参数）弹出交互面板，上下选档位（Auto/Max/High/Medium/Low/Off），回车确认
- **思考计时器**：agent 执行时显示实时 elapsed（如 "思考中 · explore · 1m 23s"），超过 10 分钟变红提示可能卡住
- **@file 文件预览**：消息中提及的文件可点击，右侧抽屉展示文件内容（语法高亮 + 行号）
- **DeepSeek 余额查询**：Insights 面板顶部显示账户余额和欠费状态（调官方 API）
- **自定义 Provider**：设置 → 连接模型服务商 → + 自定义 Provider，支持任意 OpenAI 兼容端点（Ollama/vLLM/直连 OpenAI），API Key 可选
- **主题工作室**：多自定义主题库 + 50 步撤销/重做 + 逐 token 编辑 + 壁纸配色引擎（OKLCH 聚类 + 对比度审计），内置「天枢静舱」等主题，支持导入导出
- **sidecar 内存自适应**：堆上限按机器内存自动分档（8G→2G / 16G→4G / 32G→6G / 64G+→8G，`RIVET_SIDECAR_HEAP_MB` 可覆盖），≤8GB 机器自动启用 lean 资源档
- **watchdog 自动恢复**：边界停滞时自动续跑，桌面端时间线可见恢复事件（⟳ 自动恢复 / ⏹ 配额耗尽）
- **多会话并发**：标签栏管理多个会话，独立 cwd + 模型 + 审批模式
- **功能面板**（左侧栏 `⌘1…9` 切换）：Mission Control（多会话控制台）、Inbox（收件箱）、Automations（定时任务）、Skills / Hooks 管理、Git / GitHub、Changes（改动审查）、Delegation（委派舰队与团队波次 DAG）、Cockpit 驾驶舱
- **Popout 独立窗口**：把单个会话线程弹成独立窗口，多屏并行
- **JobsDock / TodoDock 常驻抽屉**：后台任务停靠条（展开日志 / Kill / 在终端打开）、跨标签常驻 todo

#### 桌面端快捷键

`⌘/Ctrl+/` 随时唤出快捷键速查表（ShortcutOverlay）。核心快捷键：

| 快捷键 | 作用 |
|--------|------|
| `⌘/Ctrl+K` | 命令面板 |
| `⌘/Ctrl+N` | 新会话 |
| `⌘/Ctrl+1…9` | 切换功能面板 |
| `⌘/Ctrl+,` | 设置 |
| `⌘/Ctrl+Shift+]` / `[` | 下/上一个会话标签 |
| `⌘/Ctrl+W` | 关闭标签 |
| `⌘/Ctrl+B` | 切侧栏 |
| `⌘/Ctrl+Shift+B` | 切审查面板 |
| `⌘/Ctrl+J` · `` Ctrl+` `` | 切集成终端 |
| `⌘/Ctrl+;` | SideChat 旁路提问 |
| `⌘/Ctrl+.` | Zen 模式 |
| `⌘/Ctrl+O` | 视图模式循环（standard → verbose → summary） |
| `Shift+Tab` | Plan / Agent 模式切换 |
| `Esc Esc` | 倒带（桌面端 Rewind） |

> 桌面端还有 Cockpit 驾驶舱、SideChat 旁路提问（⌘;）、Rewind 时间旅行、主题/Glass/壁纸、Mirror 镜像加速等独有特性——详见 [桌面端用户指南](docs/desktop-guide.md)。

### 📱 手机遥控（Mobile Remote）

让手机/平板成为天枢的第二块屏幕——会话跑在电脑上，人在手机上看进度、批审批：

- **开启**：桌面端 **设置 → Network → Remote Access**（显示局域网地址 + 访问令牌 + 扫码直达二维码）；或 CLI 侧 `RIVET_SERVE_HOST=0.0.0.0`（+ `--mobile-dir` 指向桌面端构建产物）后同端口服务 `/mobile`
- **接入**：同一局域网内手机浏览器打开 `http://<电脑局域网 IP>:3100/mobile`——扫码直达时令牌自动写入（地址栏随即清空防泄漏）；也可手动输入令牌
- **能做什么**：会话列表（有待审批的置顶高亮）→ 单会话只读实时时间线（复用桌面同一折叠/断线自动重连语义）→ 审批 / 计划 / 提问卡片 + 中止按钮。不含主动发消息（P2 范围边界）
- **安全边界**：仅限可信局域网或隧道（Tailscale/SSH）；LAN 模式下访问令牌是唯一凭证，令牌泄露等于完全控制；外网勿直接端口映射
- 完整启用方式与安全取舍见 [远程访问指南](docs/remote-access.md)

### 🎙️ 语音输入（桌面端）

输入框的麦克风按钮支持语音输入，**macOS 与 Windows 通用**。识别由**本地 whisper.cpp 引擎**完成——离线、隐私（录音不上传任何服务器），中英文混杂场景的精度优于系统自带识别。

**首次使用引导**

- 首次点击麦克风会自动下载识别模型（tiny 约 75MB，国内走镜像加速）。下载未完成时点击会提示「语音识别失败（whisper-unavailable）」，稍候重试即可。
- macOS 首次使用会请求麦克风权限：点击「允许」即可；若误拒，到「系统设置 → 隐私与安全性 → 麦克风」中开启本应用。
- Windows 若提示权限被拒，在「系统设置 → 隐私 → 麦克风」中允许本应用。

**注意事项**

- 识别全程在本地完成，录音不离开设备。
- 点击一次开始录音，再点一次结束并识别。
- 本地引擎不可用时（如模型未下载），macOS 自动回退系统语音识别；Windows 则提示模型未就绪。
- 追求更高精度可换用 base 模型（约 244MB）：`desktop/scripts/fetch-whisper-runtime.js --with-base` 预下载。
- 网络受限环境可设 `RIVET_WHISPER_PROXY=http://代理:端口` 加速模型下载。

### ⚡ Lean 资源档（低内存 / 低磁盘）

内存或磁盘吃紧时使用 Lean 档：精简工具集与提示词、关闭 embeddings、收紧会话池（4 会话 / 10 分钟 TTL / 10MB 事件日志）。适合低配机器或长时间多会话运行。

**开启方式**（任选其一）：

- 环境变量：`RIVET_LEAN=1` 全局开启；`RIVET_LEAN_ASPECT=tools,prompt,embeddings,meridian,pool` 按需只开部分子项（`RIVET_LEAN=0` 可显式关闭）
- TUI：`/config` → Basics → Lean 资源档（开关 + 三个阈值）
- 桌面端：设置 → 行为 → Lean 资源档

**资源压力提醒**：运行时内存 ≥75% / 磁盘 ≥80% 会在状态行显示警告（仅提醒，不自动改配置）——可人工开 Lean 或开新会话应对。

**阈值默认**：Lean 4 会话 / 600000ms（10 分钟）/ 10MB，正常 16 / 1800000ms（30 分钟）/ 50MB；事件日志磁盘下限 1,000,000 字节。

**最小工具集（taiyi 档）**：`RIVET_TOOL_PRESET=taiyi`（或项目配置 `tools.preset: "taiyi"`）只装配高频核心工具（读写/检索/bash/git/测试/交付/计划等 16 个），去掉编排/浏览器/网络/视觉等重工具——适合评测「只留关键工具是否够用」。`full` 档一键回退全集。**太一星域内置此档**：`defaultDomain` 钉定 `taiyi` 时无需任何配置即自动落 taiyi 档（显式给档恒优先可覆盖）；一键组合见下方「最小集绑定星域」。

**按域覆盖（runtime.domains）**：`defaultDomain` 钉定某域时，该域的 lean/阈值/工具档位覆盖全局配置（其他域不受影响）：

```jsonc
{
  "runtime": {
    "domains": {
      "taiyi": {
        "lean": true,
        "toolPreset": "taiyi",
        "maxLoadedSessions": 4,
        "idleAgentTtlMs": 600000,
        "maxEventsDiskBytes": 10485760
      }
    }
  }
}
```

解析链：`RIVET_LEAN` 环境变量（恒优先）→ 域覆盖 → 全局 runtime。桌面端：设置 → 行为 → Lean 资源档 → 按域覆盖（域列表随新增星域自动扩展）。注意：域覆盖在会话装配期生效（启动钉定域时）；运行中 `/domain` 切换不影响已冻结的工具集与 lean（改工具指纹会重建前缀缓存）。

**无需改文件的一键启动**：`/config` → Basics → 「最小集绑定星域」——选中某域（如 changgeng 或 taiyi），保存即自动写入 `defaultDomain` 钉定该域 + 该域的 taiyi 最小工具档覆盖（不含 lean 资源减配）。此后 `rivet` 裸启动即进入该星域的最小集会话；配合「默认模型」字段（`agent.defaultModel`，`provider:modelId` 格式）即可完全免参数启动。清空绑定则恢复默认域（域覆盖配置保留）。桌面端同款项：设置 → 系统 → 「最小集绑定星域」。


## ⚙️ 模型配置

### 多提供商 + 自适应路由

| 提供商 | 认证方式 | 旗舰模型 |
|--------|----------|----------|
| DeepSeek | API key | deepseek-v4-pro (1M ctx), deepseek-v4-flash, deepseek-v4-flash-vision-exp（视觉） |
| DeepSeek Spark（Pro 专属） | API key（`DEEPSEEK_SPARK_API_KEY`） | deepseek-v4-flash（轻量推理 + 锚点缓存通道） |
| Claude | API key（通过 `cc-switch` 代理） | claude-opus-4-8, claude-sonnet-4-5 |
| GLM（智谱） | API key | glm-5.3 (1M ctx), glm-5.3-flash（视觉）, glm-5.2 |
| Codex (GPT-5.6) | OAuth PKCE（ChatGPT 订阅） | gpt-5.6-sol |
| MiniMax | API key | MiniMax-M3, MiniMax-M2.7 |
| MiMo | API key | mimo-v2.5-pro |

会话内用 `/model <name>` 随时切换提供商。

```bash
rivet                                 # 启动 TUI；首次缺 key 时自动打开 /connect
rivet config                          # 查看配置命令帮助
rivet config setup codex --default    # Codex 走 OAuth（首次浏览器登录）
rivet config show                     # 查看完整配置
```

也可直接编辑 config.json（只写需要覆盖的字段，默认值会深度合并）。文件位置：CLI 在 `~/.rivet/config.json`（Windows 为 `%LOCALAPPDATA%\.rivet`）；桌面端以 Settings → 存储位置为准，便携版在 exe 旁 `TianshuData\.rivet`——详见[先定位数据根](#先定位数据根)：

```json
{
  "provider": {
    "default": "deepseek",
    "providers": {
      "deepseek": {
        "apiKey": "sk-xxx",
        "models": [
          { "id": "deepseek-v4-pro", "contextWindow": 1000000, "maxTokens": 384000 }
        ]
      }
    }
  },
  "agent": { "maxTurns": 200, "approval": "auto-safe", "crossSessionEnabled": true },
  "compact": { "enabled": true, "autoThreshold": 800000 }
}
```

### 识图（视觉能力）

- 主控模型声明 `supportsVision` 时直接看图；否则可配 `agent.visionModel` 识图桥，先用视觉模型转文字再交给主控。
- 内置视觉模型与桥接配置、`/vision` 发现向导、`ask_image` 追问、桌面端/TUI 设置入口详见 [识图能力用户手册](docs/user-guide-vision.md)。
- 图片走对话尾部追加，**不打断前缀缓存**；不支持的图片会明确警告，不会静默丢弃。

### Worker 路由（子智能体用不同模型）

```json
{
  "workers": {
    "profiles": {
      "capable": { "provider": "codex", "model": "gpt-5.6-sol" },
      "cheap":   { "provider": "minimax", "model": "MiniMax-M2.7" }
    },
    "routing": { "code_edit": "capable", "repo_summarization": "cheap" }
  }
}
```

完整说明见 [模型配置指南](docs/user-guide-provider-config.md)。

## 🔐 权限模式

对外只有三档，会话内统一用 `/permission` 管理：

| 档位 | 命令 | 行为 |
|------|------|------|
| **监督** | `/permission supervise`（别名 `manual`） | 每个高风险工具都弹确认，最大控制 |
| **自动**（默认） | `/permission auto [轮次]`（别名 `default`） | 低/无风险工具自动执行，高风险仍确认；可设每 N 轮检查点 |
| **全自动** | `/permission unattended confirm` · `/yes` · `/yolo` | 免审批执行；写边界仍在（自动开启沙箱），回滚兜底 |

快速操作：

```bash
/permission                 # 交互式选择三档
/permission status          # 当前模式 + 规则
/permission allow/deny      # 工具白名单/黑名单
/permission bash allow/deny # bash 前缀白名单/黑名单
/yes [off] · /yolo [off]    # 一键全自动 / 回到自动（持久化为默认）
```

```bash
rivet --dangerously-skip-permissions      # 单次会话全自动
rivet config set-approval auto-safe       # 持久化默认档位
```

- 规则分 `[config]`（持久化）与 `[session]`（本次会话）两层，`deny` 永远优先。
- 跳过提示**不会**关闭工具校验、路径安全、证据追踪、检查点与交付门禁。
- 沙箱默认关闭，**全自动会自动开启**；`RIVET_SANDBOX=1` 可显式开、`=0` 强制关。
- 项目级信任：未授信项目不加载 hooks / 项目 MCP，安全键剥离；`/trust` 管理。
- 完整命令清单、规则优先级、路径授权、Windows 行为与故障排查见 [权限与沙箱指南](docs/user-guide-sandbox-permissions.md)。

## ⌨️ 斜杠命令

> **分层提示**：输入框输入 `/` 默认只展示约 20 条核心命令（高频好用的优先露出）；**继续输入任意字符即过滤全部命令**（含 /team、/council、/skill 等进阶命令），`Ctrl+P` 命令面板永远全量模糊搜索。命令总数 90+ 条（外加已安装的 skills），分层只影响「发现性」，不删任何命令。

**会话与项目**

| 命令 | 说明 |
|------|------|
| `/help` | 显示可用命令 |
| `/sessions` `/resume <n>` | 列出/恢复已保存会话（恢复侧栏、待办、活动计划） |
| `/fork` | 分叉当前会话（可选从某条消息起） |
| `/handoff [备注]` | 写结构化交接文档（五章节），归档后自动注入新会话 |
| `/init` | 交互式项目初始化：verify 声明 / skills / hooks 脚手架 |
| `/doctor` | 环境健康检查 + bash 工具用的哪个 shell |
| `/logs [open [desktop]]` | 本会话日志落点（会话 / 缓存 / 六维 / 桌面 sidecar），含写入门控与回收说明；`open` 在文件管理器中打开 |
| `/connect` | 连接模型服务商向导（选内置或自定义，填 API 密钥） |
| `/config` `/settings` `/setup` | 设置面板：子代理路由 / 审查开关（`审查 → 关闭提交后自动审查`） / 识图模型 / 工具档位·审批·默认星域·默认模型 / 镜像·代理·搜索后端。`Tab` 切栏、`Enter` 编辑、`S` 保存，每项标注即时或下次会话生效 |
| `/cd <path>` | 会话中途切换工作目录（保前缀缓存，会话归属迁往新项目） |
| `/trust` | 项目信任管理——未授信项目不加载 hooks / 项目 MCP，剥离项目配置安全键 |
| `/exit` `/quit` | 保存会话并退出 |

**模型与权限**

| 命令 | 说明 |
|------|------|
| `/model [name\|list]` | 显示或切换模型/提供商 |
| `/effort [off\|low\|medium\|high\|max\|auto]` | 控制推理深度（无参数弹出选择面板）。默认 `high`（Pro）/ `medium`（Flash），例行轮自动降档；手动设 `max` 永不被降级 |
| `/permission [supervise\|auto\|unattended\|manual\|yolo\|allow\|deny\|bash\|remove\|reset\|test]` | 权限模式：监督 / 自动 / 全自动 |
| `/yes [off]` `/yolo [off]` | 一键全自动，两者同语义（`off` 回到自动）—— 持久化为默认，重启后仍生效 |
| `/domain [list\|<name>\|auto\|off]` | 查看或切换星域人格 |

**规划与编排**

| 命令 | 说明 |
|------|------|
| `/goal <text>` | 设置自主目标，运行到完成 |
| `/cancel-goal` | 停止目标执行 |
| `/plan <feature>` | 生成计划草稿（writing-plans 工作流） |
| `/plan-mode` | 进入/退出 Plan Mode（toggle；未批准退出需二次确认） |
| `/plan-list` | 列出待审批计划 |
| `/plan-view [ref]` | 全屏预览计划全文（审批卡上按 `v` 同效） |
| `/plan-approve <slug>` | 批准计划并启动分波执行 |
| `/plan-reject <slug> [feedback]` | 退回计划让 agent 修改重交 |
| `/plan-close <file> --tasks <1-7\|all> [--preview]` | 关闭已完成计划，标记任务状态 |
| `/ask` | 进入/退出 Ask Mode（只读问答，toggle） |
| `/council <text>` | 召集多模型议事会审查（天权/天府/天璇三席） |
| `/team <plan.md>` | 团队模式：多 agent 并行执行计划 |
| `/scout <目标> [--dims 前端,后端,集成]` | 巡天侦察蜂群：并行只读诊断，交付带证据的实测核对清单 + runbook（不写文件；选型口诀——要留计划资产用 /team，只要这一次并行加速用 /scout） |

**审查模式**

每次 `deliver_task` 提交代码时，天枢会自动运行提交后审查。审查分两级：文档/配置等机械变更自动跳过（L1 nudge），核心代码变更触发 L2 接线检查（wiring inspector）。审查结果出现在交付报告中，不会阻止提交（advisory）。
- **CLI（TUI）**：默认开启。设置面板 → `审查` → `关闭提交后自动审查` 可手动关闭（勾选即跳过审查）。也可用 `RIVET_REVIEW_DISCIPLINE=0` 环境变量全局关闭。
- **桌面端（desktop）**：标准 DeepSeek 会话默认开启，Spark 会话默认开启且审查子代理用 spark-flash。在 `设置 → Routing → 审查子代理` 中可找到两个独立开关：`SkipAuto`（标准会话）、`SkipAutoSpark`（Spark 会话）。
- 手动审查：任何时候可用 `/review`（L2 对抗审查）或 `/review max`（L3 五席审查 squad）对当前改动执行深度审查。这是显式请求，不受开关控制。

**子代理与后台任务**

| 命令 | 说明 |
|------|------|
| `/tasks` | 打开子代理任务面板（查看 / 切入 `f` / 停止 `x`） |
| `/enter <orderId> [prompt]` | 进入/续跑某个 worker 子会话 |
| `/jobs` | 打开后台任务面板（bash 后台启动的 shell 任务列表） |

**上下文与调试**

| 命令 | 说明 |
|------|------|
| `/compact` | 立即压缩上下文 |
| `/context` | 显示上下文账本：健康度、tokens、回合、声明 |
| `/evidence` | 显示证据摘要（读取/修改的文件、测试） |
| `/memory` | 记忆概览；`/memory add <内容>` 写入项目知识，`/memory search <关键词>` 检索 |
| `/remember <内容>` | 用户直写项目长期记忆（无参查看最近条目） |
| `/forget <entryId> [resolved]` | 显式失效一条记忆：`resolved` 表示旧问题已解决，缺省为主动遗忘（无参列出最近可失效条目） |
| `/btw <问题>` | 侧问——就当前会话问一句，回答显示在浮层，不进对话历史 |
| `/debug [prompt\|cache\|mcp]` | 调试 prompt、缓存统计或 MCP |
| `/mcp` | MCP 服务器连接状态 |
| `/verbose` | 切换详细工具输出（on 显 200 行 / off 显 20 行） |

**回滚与界面**

| 命令 | 说明 |
|------|------|
| `/rollback` | 预览/恢复 git 检查点（`confirm` 执行） |
| `/undo` | 撤销上次文件变更（预览，`confirm` 恢复） |
| `/theme [name\|list]` | 切换色彩主题 |
| `/vim` | 切换 vim 键绑定 |
| `/cockpit` | 切换 Cockpit 驾驶舱面板 |
| `/scroll` | 浏览输出历史（q / Esc 关闭） |
| `/skill <name>` | 加载并立即执行一个 skill |
| `/skill off <name>` | 停止重复注入某个 skill |
| `/update` | 检查并安装更新（npm） |

> **倒带**：双击 **ESC**（间隔 <400ms）打开消息历史，选任一过往用户消息倒带到该点——不是斜杠命令，是快捷键。按 **Esc** 关闭任意覆盖层。

## 🛠️ 面向开发者

### 技术栈

Node.js 24 · TypeScript strict（`noUncheckedIndexedAccess`）· T9 ANSI 渲染引擎 · tsup 打包 · node:test + assert/strict

### 构建与测试

```bash
npx tsc --noEmit                                    # 类型检查
npm test                                             # 所有测试（16,000+ 用例）
npm run build                                        # tsup 打包 + 原生/wasm 载荷落位
node dist/main.js                                    # 启动 TUI
node dist/main.js -p "fix the typo"                  # 无界面模式
```

### 扩展

- **添加工具** —— 在 `src/tools/` 实现 `ToolDefinition` + executor，在 `src/main.tsx` 注册，在 `src/tools/__tests__/` 加测试。
- **添加 skill** —— 在 `.rivet/skills/` 放一个带 frontmatter（`name`、`description`、`triggers`）的 `.md`。
- **添加斜杠命令** —— 项目级 `.rivet/commands/*.md`，支持 `$ARGUMENTS` 插值。
- **添加 hook** —— 实现 `PreToolUse | PostToolUse | UserPromptSubmit | PreCompact` 处理器，通过 `HookRegistry` 注册；处理器相互隔离，单个坏 hook 不会让循环崩溃。
- **项目指令** —— 在项目根放 `.rivet.md`，其内容会自动注入为项目上下文。

### 架构

```
src/
├── agent/     核心循环：turn-orchestrator、tool pipeline、coordinator、
│              advisory-bus、goal-tracker、sensorium、免疫系统
├── api/       流式 API 客户端 —— DeepSeek、GLM、Codex OAuth、多提供商路由
├── prompt/    提示词引擎 —— 冻结前缀 + 增量附录 + 易变上下文层
├── tools/     工具 —— bash、edit、read/write、grep、glob、run_tests、git、delegate…
├── tui/       终端 UI（T9 ANSI 引擎：scrollback、输入控制、覆盖层、流式渲染）
├── compact/   三层语义修剪 + 微压缩 + 请求时坍缩
├── context/   上下文账本、渐进式压缩、声明系统、锚点注册表
├── config/    Zod 验证配置：默认值 → ~/.rivet → 项目覆盖
├── server/    桌面端 sidecar：会话管理、REST 路由、SSE 流
├── mcp/       Model Context Protocol 客户端（stdio + SSE）
├── lsp/       Language Server Protocol 集成
└── search/    语义搜索（BM25 + embedding RRF 融合）
```

### 会话数据与日志排查

会话日志存在项目外的数据根下，避免被 `glob`/`grep` 扫到、也不污染工作区。全局配置在 `<数据根>/config.json`。每次启动得到唯一会话 ID，多个实例可并行运行互不干扰。

#### 先定位数据根

| 端 / 安装方式 | 数据根怎么定 | 常见路径 |
|---------------|--------------|----------|
| CLI | `RIVET_HOME` → 平台默认 | macOS/Linux: `~/.rivet`；Windows: `%LOCALAPPDATA%\.rivet` |
| 桌面 · 系统安装 | Settings → 存储位置（`launcher.json`）→ 平台默认 | 同上 |
| 桌面 · 便携版 | exe 旁 `TianshuData\.rivet` | 例如 `D:\Tools\Tianshu\TianshuData\.rivet` |

> **CLI 与桌面不是同一套解析链。** CLI 认环境变量 `RIVET_HOME`；桌面端认 Settings → 存储位置写入的 `launcher.json`，**不读** shell 里的 `RIVET_HOME`。两边要对齐，请在桌面设置里改，或让 CLI 也 `export RIVET_HOME` 到同一目录。

#### 不用记路径：三个入口

```bash
# 终端（TUI 起不来也能用——不初始化 agent、不读配置、不联网）
rivet logs                         # 列出本项目最近主会话的全部落点 + 是否已产生 + 门控说明
rivet logs --session <id>          # 指定会话
rivet logs --json                  # 结构化输出，可贴进 issue
rivet logs open                    # 在文件管理器中打开会话目录
rivet logs open desktop            # 打开 sidecar 日志目录（GUI 起不来时第一现场）
```

- **TUI**：`/logs`（同上清单）；`/logs open` / `/logs open desktop` 直接打开目录
- **桌面端**：Settings → 存储位置 →「打开数据目录」/「打开日志目录」

#### 本会话常见落点（相对数据根）

`slug` = `<项目目录名>-<cwd 的 sha256 前 6 位>`。同名不同路径的项目不会撞车。

| 文件 | 用途 | 写入条件 |
|------|------|----------|
| `sessions/<slug>/<id>.jsonl` | 对话主体（含 `usage` / `model_switch`） | 始终 |
| `sessions/<slug>/<id>/cache-log.jsonl` | 逐请求缓存命中与侧路成本 | 始终 |
| `sessions/<slug>/<id>/sensorium.jsonl` | 六维 / CVM / advisory 台账 | 轻量行默认开；全量需 `RIVET_DEBUG_TELEMETRY`（任意非空） |
| `sessions/<slug>/<id>/frames.jsonl` | 认知帧（相位、策略） | 默认开；`RIVET_FRAME_TELEMETRY=0` 关 |
| `logs/sidecar-<时间戳>.log` | 桌面 sidecar stdout/stderr | 每次启动一个新文件 |
| `desktop/sidecar-exit.json` | sidecar 退出原因面包屑 | 退出时 |
| `desktop/sessions/<id>/events.jsonl` | 桌面 UI 事件流（与上面的会话 `.jsonl` 是两份数据） | 桌面非 ephemeral 会话 |

项目内另有 `<cwd>/.rivet/knowledge/`、`artifacts/`、`plans/` 等共享数据；无 `sessionId` 时六维偶尔也会回退写到 `<cwd>/.rivet/sensorium.jsonl`——`rivet logs` 会把实际路径打出来。

#### 场景速查

| 现象 | 先看 |
|------|------|
| 桌面窗口开了但助手不回话 | `rivet logs open desktop`，或 Settings →「打开日志目录」；再看 `desktop/sidecar-exit.json` |
| 缓存命中率异常 / 成本突然升高 | `rivet logs` → 打开该会话的 `cache-log.jsonl` 与 `.jsonl` 里的 `cache_read_*` |
| 想复盘六维 / advisory 是否生效 | 确认开了 `RIVET_DEBUG_TELEMETRY`，再读 `sensorium.jsonl` |
| 上报 bug / 贡献排查 | `rivet logs --json` 整段贴进 issue（不含对话正文，只含路径与体积） |

`RIVET_SESSION_DIR` / `RIVET_DESKTOP_DIR` 可分别搬走会话树与桌面树；生效中的覆盖会出现在 `rivet logs` 输出顶部。

## 🔒 安全

- **路径边界强制** —— glob/grep/diff 拒绝 `..` 穿越；`validatePath` 阻止逃逸
- **项目信任门** —— 未授信项目的 `.rivet/hooks.json` 不加载、项目配置安全键被剥离、MCP 服务器不拉起；`/trust` 管理（CLI `--trust` / `--untrust`）
- **符号链接环保护** —— realpath + 访问集
- **SSRF 保护** —— 逐跳 DNS + 私有 IP 拦截，作用于每次重定向
- **敏感文件拒绝** —— `.env`、`credentials.*`、`*key*`、`*token*` 禁止读/commit
- **破坏性命令门禁** —— `rm -rf`、force push、`DROP/TRUNCATE` 需显式确认
- **检查点 + 回滚** —— 每回合首次修改文件前创建 Git 检查点
- **文件级撤销** —— 每次写/编辑前版本化备份
- **Worker 安全** —— AbortController 超时预算，工具白名单强制

## ⚡ 关键配置速查

### 环境变量

**路径与数据**

| 变量 | 作用 |
|------|------|
| `RIVET_HOME` | 覆盖整个 `~/.rivet` 数据根（CLI 生效；桌面端认 Settings → 存储位置，不读此变量） |
| `RIVET_CONFIG_PATH` | 覆盖 `config.json` 路径（多套配置切换） |
| `RIVET_SESSION_DIR` | 覆盖会话日志存储路径 |
| `RIVET_RESUME` / `RIVET_RESUME_ID` | 启动时恢复会话（对应 `--resume`） |
| `RIVET_NEW_SESSION` / `RIVET_NO_AUTO_RESUME` | 强制新会话 / 禁用自动续接 |

**模型与工具**

| 变量 | 作用 |
|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 |
| `DEEPSEEK_SPARK_API_KEY` | DeepSeek Spark（Pro 专属预设）API 密钥 |
| `RIVET_TOOL_PRESET` | 工具集档位：`minimal`（默认）/ `frontend` / `full` / `taiyi` |
| `RIVET_EMBEDDING_MODEL` / `RIVET_EMBEDDING_BASE_URL` / `RIVET_EMBEDDING_API_KEY` | 语义搜索的嵌入模型路由（默认 `text-embedding-3-small`） |
| `RIVET_NO_EMBEDDINGS=1` | 关闭嵌入索引 |
| `RIVET_SANDBOX` / `RIVET_SANDBOX_WRITABLE` | 追加可写沙箱根目录 / 可写目录列表 |
| `RIVET_PLAN_MODE_SUGGEST` | Plan Mode 自动进入策略：`auto`（默认）/ `ask` / `0`（关闭） |

**TUI 显示**

| 变量 | 作用 |
|------|------|
| `RIVET_ASCII_UI=1` | 强制纯 ASCII UI（降级终端） |
| `RIVET_IMAGES` | 终端内联图片：默认自动检测；`0`/`off` 关闭；`kitty`/`iterm2` 强制协议 |
| `RIVET_HYPERLINKS=1` | 开启 OSC 8 超链接渲染 |
| `RIVET_NOTIFY_BELL=1` | 完成时响终端铃 |
| `RIVET_AMBIGUOUS_WIDTH` | CJK 宽度判定覆盖（终端对齐错乱时用） |
| `RIVET_TUI_HARDWARE_CURSOR=1` | 硬件光标模式 |

**调试与任务**

| 变量 | 作用 |
|------|------|
| `RIVET_DEBUG=1` | 总调试日志开关（最常用） |
| `RIVET_DEBUG_TELEMETRY` | 任意非空值开启全量 `sensorium.jsonl`；只有字面 `1` 会额外拉起 TUI perf 那行 UI |
| `RIVET_TELEMETRY_LITE=0` | 连 vitals-lite 轻量行一起关（默认开） |
| `RIVET_HEADLESS_MAX_TURNS` | `-p` 无头模式单次最大轮数（默认 15） |
| `RIVET_JOB_MAX_MS` | 后台 job 超时上限 |
| `RIVET_NO_CROSS_SESSION=1` | 禁用跨会话加载（记忆块 / 跨会话事件 / 伴生感知） |
| `RIVET_NO_UPDATE_CHECK=1` | 关闭启动时的自动更新检查 |
| `PORTABLE_GIT_MIRROR` | 覆盖 PortableGit 下载镜像 |

**记忆**

| 变量 | 作用 |
|------|------|
| `RIVET_ADAPTIVE_MEMORY` | 自动注入治理/约束/偏好类记忆：`on`（默认）/ `shadow` 只评估 / `off` 关闭 |
| `RIVET_MEMORY_AUTO_CAPTURE` | 会话末把重要操作交给模型判断后写入长期记忆（默认 `on`） |
| `RIVET_MEMORY_CONSOLIDATION` | 会话末生成摘要与可复用做法（默认 `on`） |
| `RIVET_MEMORY_BACKFILL` | 启动闲时对历史会话补跑巩固（默认 `off`，幂等账本） |

> 完整环境变量清单（120+ 项，含内部实验开关）见 `src/config/env-registry.ts`。


### `~/.rivet/config.json` 关键字段

只写需要覆盖的字段，默认值会深度合并。完整 schema 见 `src/config/schema.ts`。

```jsonc
{
  "agent": {
    "maxTurns": 200,              // 单次会话最大回合数
    "approval": "auto-safe",      // manual | auto-safe | dangerously-skip-permissions
    "crossSessionEnabled": true,  // 跨会话知识共享
    "checkpointEveryTurns": 0,    // Auto 模式检查点间隔（0 = 关）
    "defaultDomain": "qiming",    // 默认星域（qiming/auto/显式域名）
    "visionModel": {              // 识图桥：主控模型不支持看图时，先转成文字描述
      "provider": "minimax",      // 需已配好 key，且该模型声明 supportsVision
      "model": "MiniMax-M3"
    },
    "visionAutoBridge": false,    // 未配 visionModel 时自动挑一个可用视觉模型（默认关）
    "permissions": {              // 权限规则（对应 /permission 命令）
      "allow": [{ "tool": "read" }],
      "deny":  [{ "tool": "bash", "params": { "command": "rm -rf" } }],
      "bash": { "allowlist": ["git status"], "denylist": ["git push"] }
    }
  },
  "compact": {
    "enabled": true,
    "autoThreshold": 800000       // 触发自动压缩的 token 阈值
  },
  "cache": {
    "enabled": true,              // 前缀缓存总开关
    "showHitRate": true           // GlanceBar 显示命中率
  },
  "tools": {
    "preset": "minimal"           // minimal（默认）| frontend | full | taiyi
  },
  "workers": {
    "profiles": {                 // 自定义 worker 模型档位
      "capable": { "provider": "deepseek", "model": "deepseek-v4-pro" },
      "cheap":   { "provider": "minimax",  "model": "MiniMax-M2.7" }
    },
    "routing": { "code_edit": "capable", "repo_summarization": "cheap" },
    "patcherTier": "cheap"        // 天梁执行 worker 默认档位：cheap | balanced | strong
  },
  "search": {
    "backends": ["bing", "duckduckgo"],  // web_search 后端链（首个有结果即停）
    "braveApiKeyEnv": "BRAVE_API_KEY",   // 用 Brave 时填 env 变量名
    "tavilyApiKeyEnv": "TAVILY_API_KEY", // Tavily（需 key，offshore）
    "bochaApiKeyEnv": "BOCHA_API_KEY"    // 博查（国内直连 AI 搜索，Tavily 国内替代，需 key）
  },
  "ui": {
    "theme": "auto",              // 内置名 | auto（OSC 11 探测）| custom:<name>
    "reducedMotion": true,        // 无障碍：冻结 spinner/徽章动画
    "screenReader": true,         // 无障碍：读屏模式（同 --screen-reader）
    "glanceDensity": "compact"    // GlanceBar 密度：compact | full
  },
  "mirrors": { "enabled": true, "preset": "china" },  // npm/github 等镜像加速
  "env": { "extraPath": ["/usr/local/bin"] }           // 注入 PATH（Windows git-bash 等）
}
```

> 配置层叠优先级：命令行 flag > 环境变量 > 项目 `.rivet-config.json` > 用户 `~/.rivet/config.json` > 内置默认值。



## 📚 文档

| 文档 | 说明 |
|------|------|
| [`docs/user-guide.md`](docs/user-guide.md) | 安装、配置与使用指南 |
| [`docs/desktop-guide.md`](docs/desktop-guide.md) | 桌面端用户指南（Cockpit/SideChat/Rewind/主题/Mirror 等独有特性） |
| [`docs/user-guide-provider-config.md`](docs/user-guide-provider-config.md) | 模型提供商配置指南 |
| [`docs/user-guide-vision.md`](docs/user-guide-vision.md) | 识图能力（视觉通道）配置与排查 |
| [`docs/user-guide-sandbox-permissions.md`](docs/user-guide-sandbox-permissions.md) | 沙箱与权限模型完整指南 |
| [`docs/reference/observability-harness.md`](docs/reference/observability-harness.md) | 指标观测 harness：缓存 / CVM / 信息素的真实会话数据样本与复算命令 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 贡献指南 |
| [`config.example.json`](config.example.json) | 示例配置（含子代理/审查模型路由） |

## 🤝 社区与支持

- **使用问题 / 讨论** → [GitHub Discussions](https://github.com/huiliyi37/Tianshu-Tui/discussions)
- **Bug 报告 / 功能请求** → [GitHub Issues](https://github.com/huiliyi37/Tianshu-Tui/issues)
- **安全漏洞** → [私密报告](https://github.com/huiliyi37/Tianshu-Tui/security/advisories/new)（不要开公开 issue）
- **贡献代码** → 见 [CONTRIBUTING.md](CONTRIBUTING.md)
- **求助指南** → 见 [SUPPORT.md](SUPPORT.md)
- **微信交流群** → 「天枢 harness 交流群」，扫码加入，日常讨论 / 反馈 / 第一时间获取发版动态：

<img src="docs/brand/assets/wechat-group-qr.png" width="280" alt="天枢 harness 交流群微信群二维码">

> 微信群二维码有有效期（7 天），过期请在 [Discussions](https://github.com/huiliyi37/Tianshu-Tui/discussions) 或 Issue 留言，维护者会补新码。

> 提示：需要先由仓库维护者在 `Settings → General → Discussions` 中开启 Discussions 功能。

## 🌐 官网开发

天枢生态官网 [jiangsx496/Tianshu-Official-Website](https://jiangsx496.github.io/Tianshu-Official-Website/) 由 [@jiangsx496](https://github.com/jiangsx496) 原创开发，覆盖数据库、前端与初版后端。

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/jiangsx496">
        <img src="https://github.com/jiangsx496.png?s=120" width="120" alt="@jiangsx496" style="border-radius:50%" />
      </a>
      <br />
      <sub><b>@jiangsx496</b></sub>
      <br />
      <sub>官网原开发者 (Database · Frontend · Initial Backend)</sub>
    </td>
  </tr>
</table>

## ✨ 贡献者

感谢以下贡献者为天枢做出的贡献（按首次贡献时间排序）：

| 贡献者 | 贡献内容 |
|--------|----------|
| [@banxia](https://github.com/banxia) | 项目创建者 · 核心开发 |
| [@qiaodier](https://github.com/qiaodier) | CC Switch provider 预设（PR #8） |

外部 PR 经「收编」流程合入后，作者署名以 `Co-authored-by` 计入贡献者图谱
（scripts/credit-contributors.sh 自动落账）——实时贡献者墙：

<a href="https://github.com/huiliyi37/Tianshu-harness/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=huiliyi37/Tianshu-harness" alt="贡献者头像墙" />
</a>

> 欢迎通过 PR 贡献代码，详见 CONTRIBUTING.md。

## ☕ 赞助支持

如果天枢对你有用，欢迎随缘打赏——这只是一杯咖啡，不是合同。赞助不会改变 issue 优先级，也不会影响功能排期。

<img src="docs/brand/assets/wechat-pay.jpg" width="240" alt="微信支付">

## 许可证

本项目采用 [Apache License, Version 2.0](LICENSE) 开源许可。Copyright 2025-2026 Tianshu Contributors.
