# 求助与支持指南 · Support Guide

> 🇨🇳 **中文** · 📖 **English** | [🏠 主文档 (README.md)](README.md) · [🌐 English README](README.en.md)

感谢使用天枢（Tianshu Harness）！遇到安装、配置或运行问题时，请按以下路径快速定位或获取帮助。
Thank you for using Tianshu Harness! If you run into installation, configuration, or runtime issues, please follow the steps below to diagnose or get support.

---

## 1. 自助排查与文档 · Self-Service & Documentation

在提问或提 Issue 前，建议先运行内置诊断命令并查阅高频排障文档：
Before opening an issue or asking in the community, try the built-in diagnostic commands and check our troubleshooting guides:

```bash
# 终端诊断（TUI 起不来也能用——不初始化 agent、不读配置、不联网）
# Terminal diagnostics (works even if the TUI fails to start — no network or agent init)
tianshu logs                  # 列出最近会话的全部日志路径 / List log paths for the latest session
tianshu logs --json           # 输出脱敏结构化元信息（适合贴入 Issue）/ Redacted JSON metadata for issues
tianshu logs open             # 在文件管理器中打开会话目录 / Open session directory in file manager
tianshu logs open desktop     # 打开桌面端 sidecar 日志目录 / Open desktop sidecar log directory
```

在交互式 TUI 会话内也可直接运行：
Inside an interactive TUI session, you can also run:

- `/doctor` —— 检查运行环境健康度与 `bash` 工具实际调用的 shell / Check environment health and active shell
- `/logs` —— 查看当前会话日志、缓存日志（`cache-log.jsonl`）与 CVM 台账（`sensorium.jsonl`）路径 / Show current session log paths
- `/debug cache` —— 诊断前缀缓存命中率与未命中原因 / Diagnose prefix-cache hit rate and miss reasons
- `/debug mcp` —— 诊断 MCP 服务器连接与工具注册状态 / Diagnose MCP server connections

### 核心手册 · Key Guides

| 文档 · Document | 内容说明 · Description |
|---|---|
| [排障与 FAQ · Troubleshooting & FAQ](docs/guides/troubleshooting.md) | 卡住不回话、429 限流、前缀缓存异常、WebView2/Linux 依赖排查 / Hang, 429 rate-limit, cache miss, and platform fixes |
| [安装与平台说明 · Installation Guide](docs/guides/installation.md) | 桌面端（macOS / Windows / Linux 双架构）、CLI、Termux、Shell 补全 / Desktop & CLI install paths |
| [用户手册 · User Guide](docs/user-guide.md) · [English Guide](README.en.md) | 命令行参数、斜杠命令全表、TUI 键位、配置文件与环境变量 / CLI flags, slash commands, TUI keybindings, config |
| [桌面端用户指南 · Desktop Guide](docs/desktop-guide.md) | Cockpit、SideChat、倒带、主题工作室、本地语音输入、WSL 连接式运行时 / Desktop GUI features |
| [Provider 配置手册 · Provider Config](docs/user-guide-provider-config.md) | 多提供商、自定义端点、子代理与审查模型路由、文生图 / Multi-provider, custom endpoints, routing |
| [权限与沙箱指南 · Sandbox & Permissions](docs/user-guide-sandbox-permissions.md) | 三档权限模式、路径授权、沙箱边界、项目信任门（`/trust`） / Approval tiers, path rules, sandbox |
| [识图能力手册 · Vision Guide](docs/user-guide-vision.md) | 原生视觉模型与识图桥配置 / Native vision & vision bridge setup |
| [手机端操作手册 · Mobile Guide](docs/guides/mobile-guide.md) · [远程访问指南](docs/remote-access.md) | 手机/平板局域网直连与 Tailscale 远程审批 / Mobile & tablet LAN Direct and Tailscale access |

---

## 2. 使用问题与社区交流 · Usage Questions & Community

日常使用问题、配置咨询、工作流经验分享请优先通过社区渠道交流：
For usage questions, configuration help, and workflow discussions, please reach out via our community channels:

- **GitHub Discussions**：[huiliyi37/Tianshu-harness Discussions](https://github.com/huiliyi37/Tianshu-harness/discussions)（提问、讨论、微信群二维码过期留言补码 / Q&A, discussions, WeChat QR refresh requests）
- **Discord 官方交流群**：[加入「天枢 tianshu-harness 官方交流群」](https://discord.gg/XjWTATCHB)（长期有效邀请链接 / Permanent invite link）
- **微信交流群 · WeChat Group**：请前往 [README.md 社区与支持](README.md#-社区与支持) 扫描最新群二维码加入。

---

## 3. Bug 报告与功能请求 · Bug Reports & Feature Requests

确认属于程序缺陷或有明确的功能建议时，请在 [GitHub Issues](https://github.com/huiliyi37/Tianshu-harness/issues) 提交：
For reproducible bugs or feature requests, please open an issue on [GitHub Issues](https://github.com/huiliyi37/Tianshu-harness/issues) and include:

1. **版本与环境 · Environment**：`tianshu --version`、`node --version`、操作系统版本（macOS / Windows / Linux 发行版）及运行表面（CLI TUI / 桌面端 GUI / VS Code 插件）。
2. **日志诊断摘要 · Diagnostic Summary**：附上 `tianshu logs --json` 的输出（仅包含路径与文件体积，**不含**对话正文或 API 密钥 / contains only paths and file sizes, **never** conversation text or API keys）。
3. **复现步骤 · Reproduction Steps**：最小复现步骤、实际表现与预期行为。

---

## 4. 贡献与安全披露 · Contributing & Security

- **代码与文档贡献 · Contributing**：请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与双仓收编说明 [EXTERNAL-PRS.md](EXTERNAL-PRS.md)。
- **安全漏洞报告 · Security Vulnerabilities**：请**不要**通过公开 Issue 报告安全问题。请使用 [GitHub 私密安全通告 · Private Security Advisory](https://github.com/huiliyi37/Tianshu-harness/security/advisories/new)，详见 [SECURITY.md](SECURITY.md)。
