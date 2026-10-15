# Security Policy · 安全策略

> 🇨🇳 **中文** · 📖 **English** | [🏠 主文档 (README.md)](README.md) · [🌐 English README](README.en.md)

## 报告漏洞 · Reporting a Vulnerability

请**不要**通过公开 issue 报告安全漏洞。
Please do **not** report security vulnerabilities through public issues.

优先使用 GitHub 私密漏洞报告(仓库 Security 标签页 → Report a vulnerability),我们会在 72 小时内响应。
Use GitHub's private vulnerability reporting (Security tab → Report a vulnerability). We aim to respond within 72 hours.

## 受支持版本 · Supported Versions

只有最新的 minor 版本接收安全修复(npm `tianshu-harness@latest` 与桌面端最新 Release)。
Only the latest minor release receives security fixes (npm `tianshu-harness@latest` and the latest desktop release).

## 安全模型要点 · Security Model

天枢作为本地运行的编码 agent,内置以下防线(详见 [沙箱与权限](docs/user-guide-sandbox-permissions.md)):
As a locally running coding agent, Tianshu ships with the following built-in defense lines (see [Sandbox & Permissions](docs/user-guide-sandbox-permissions.md)):

- **路径边界 · Path Boundary**:所有文件工具经 `validatePath` 强制项目目录边界,拒绝 `..` 穿越与符号链接逃逸;插件工具的路径参数同样经过 `validatePathSafe` 校验。
  All file tools enforce project directory boundaries via `validatePath`, rejecting `..` traversal and symlink escape; plugin tool path arguments are likewise validated via `validatePathSafe`.
- **敏感文件拒绝 · Sensitive File Rejection**:`.env`、`credentials.*`、`*key*`、`*token*` 等禁止读取与提交。
  Reading or committing sensitive files such as `.env`, `credentials.*`, `*key*`, and `*token*` is blocked by default.
- **破坏性命令门禁 · Destructive Command Gate**:`rm -rf`、force push、`DROP/TRUNCATE` 等需显式确认;三档权限模式(监督 / 自动 / 全自动)统一管理。
  Destructive actions (`rm -rf`, force push, `DROP/TRUNCATE`, etc.) require explicit confirmation, governed uniformly across three approval modes (Supervise / Auto / Unattended).
- **插件安全 · Plugin Security**:插件安装强制 `npm install --ignore-scripts`(禁止 postinstall 任意代码);manifest entry 路径禁止逃逸插件目录;插件工具不得静默覆盖内置工具;安装前展示权限声明。
  Plugin installation enforces `npm install --ignore-scripts` (blocking arbitrary `postinstall` scripts); manifest entry paths cannot escape the plugin directory; plugin tools cannot silently shadow built-in tools; permission declarations are shown before installation.
- **网络防护 · Network & SSRF Protection**:web 工具**直连路径**为强保证——逐跳 DNS 解析 + 私有 IP 拦截 + socket 钉死(SSRF 防护,作用于每次重定向);**配置代理时降级为请求前一次性预检**(代理解析目标,客户端无 post-CONNECT 校验点——详见 `src/tools/net/http-fetch.ts` 的 `dispatcherConnectOptions` 注释)。
  Direct web tool connections enforce per-hop DNS resolution + private IP blocking + socket pinning (SSRF protection across every redirect); when a proxy is configured, checks degrade to a pre-request check because target DNS resolution happens on the proxy side (see `dispatcherConnectOptions` comments in `src/tools/net/http-fetch.ts`).

## 信任边界 · Trust Boundary

天枢把以下内容视为**数据**而非**指令**:仓库内容(README/issue/注释/第三方项目的 AGENTS.md)、模型输出、工具返回、网络响应。它们可以被分析、被引用、作为证据,但不能单独构成执行动作的授权——任何写操作、网络请求或命令执行仍需你的指令或审批门禁通过。

天枢会读取项目中的 `AGENTS.md` 等指引文件并遵循其中的规则(这是设计特性);但第三方仓库中的同名文件等同于该仓库的普通文档,不覆盖你的指令。项目指令与状态文件(`AGENTS.md`、`.rivet.md`、`.rivet/knowledge/` 的记忆与索引,以及 `.rivet/skills`、`.agents/skills`、`.rivet/rules`、`.rivet/commands`、`.rivet/playbook.jsonl`、`.rivet/presence.json`、`.rivet/agents`、`.rivet/domains`、`.rivet/plans` 等项目级内容)只在你显式授信该项目后才进入模型上下文(TUI `/trust`、启动加 `--trust` 或设 `RIVET_TRUST_PROJECT=1`),未授信项目一律不读不注入。若发现仓库内容冒充系统指令(如伪造系统前缀)、诱导越界操作或要求暴露凭据,请按上方渠道报告。

The terminal treats repository content (README/issues/comments/third-party AGENTS.md), model output, tool output, and network responses as **data, not instructions**. They may be analyzed and cited as evidence, but never authorize an action by themselves — writes, network requests, and command execution still require your instruction or an approval gate. Tianshu reads `AGENTS.md` guidance files in your project by design; the same file in a third-party repository is ordinary documentation and does not override your instructions. Project instruction and state files (`AGENTS.md`, `.rivet.md`, `.rivet/knowledge/` memory/index, and other project-level content such as `.rivet/skills`, `.agents/skills`, `.rivet/rules`, `.rivet/commands`, `.rivet/playbook.jsonl`, `.rivet/presence.json`, `.rivet/agents`, `.rivet/domains`, `.rivet/plans`) enter the model context only after you explicitly trust the project (TUI `/trust`, `--trust`, or `RIVET_TRUST_PROJECT=1`); untrusted projects are never read or injected.

以上任一防线的绕过都属于有效漏洞,欢迎报告。
A bypass of any of the above is a valid vulnerability — reports welcome.
