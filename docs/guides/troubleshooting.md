---
title: 排障与 FAQ（高频现场速查）
type: guide
status: active
date: 2026-08-28
tags: [troubleshooting, faq]
related: [../reference/observability-harness.md, ../user-guide-sandbox-permissions.md]
---

# 排障与 FAQ（高频现场速查）

> 按「你看到的现象 → 先看什么 → 怎么修 / 为什么」组织。文中命令均真实存在（TUI 斜杠命令或 `rivet` CLI 子命令）；涉及内部指标的深挖指引给链接，不在这里展开。

## 1. Agent 不回话 / 卡住

**现象**：发出消息后只有 spinner 在转，长时间没有文字输出；或某个工具调用停住不动。

**先看**：

- **等待提示阶梯**：沉默约 15 秒起出现第一档提示（如 `Waiting for response... 20s`；思考、工具执行等阶段阈值略高），继续沉默会升级为 `Still waiting...`，最后一档会明确显示 `No response — Ctrl+C to interrupt`。看到最后一档就别再干等了。
- 按 **Ctrl+C** 中断当前 run（agent 活跃时这是 Ctrl+C 的第一作用）。
- `/doctor` 环境体检：Node / Git / Python 与 bash 工具实际使用的 shell 是否就位。
- `/logs` 列出本会话全部日志落点；`/logs open` 直接打开会话目录。TUI 起不来时在终端跑 `rivet logs`——这条命令不初始化 agent、不读配置、不联网，专为「起不来的时候找日志」设计。
- 桌面端：设置 → 系统 → 存储位置 → 打开日志目录；sidecar 崩溃先看 `sidecar-exit.json`（退出面包屑，崩溃排查第一现场）和日志目录里带时间戳的 sidecar stdout/stderr 文件。

**怎么修 / 为什么**：多数「卡住」是模型侧长思考或工具长执行，阶梯文案会区分（`Long think` 与 `Tool may be stuck`）。Ctrl+C 中断后重发即可；如果每次都卡在同一处，打开 `/logs` 给出的会话目录，看 `<id>.jsonl` 最后一行停在什么动作上。

## 2. 429 / 额度不足 / 余额问题

**现象**：请求失败，报 429、「限流」或「账户余额不足」（DeepSeek 余额不足时报错会附充值入口提示）。

**先看**：

- 错误原文——限流和余额不足是两类问题，提示不同。
- 桌面端 **Insights 面板**可直接查 DeepSeek 余额（成本统计、缓存命中率、余额查询在同一面板）。

**怎么修**：

- 余额不足 → 去服务商控制台充值后重试。
- 纯限流 → 稍等片刻重发；持续 429 用 `/model` 切轻量档模型（如 deepseek-flash）。
- 长期降成本：`/effort` 降推理强度（档位 off/low/medium/high/max/auto，Pro 与 Flash 档模型默认均为 high，例行轮可自动降档）；并关注缓存命中率——命中与未命中的 input 单价差可达 50 倍，见本文第 8 节与 [observability-harness](../reference/observability-harness.md)。

## 3. API key / 认证失败

**现象**：启动或发消息时报认证失败、401、invalid key。

**先看**：`/connect` 打开服务商连接向导重新配置（选内置或自定义服务商，粘贴 API 密钥；支持从中断草稿恢复）。

**怎么修 / 为什么**：

- **在 config.json 里找不到 key 是正常的**：密钥明文只存 `~/.rivet/secrets.json`（0600 权限），配置文件里只有 `keyRef` 引用。
- **备份 / 迁移配置时要连 secrets.json 与 provider-keys.json 一起带走**：只备份 `config.json` 会漏掉密钥材料，换机后表现为「配置还在但每个 provider 都 401」。这三个文件同目录（`RIVET_HOME` 或 `RIVET_CONFIG_PATH` 所在目录），职责分工是——`config.json` 存 provider / 模型 / `keyRef` 指针；`secrets.json` 存 `keyRef → 明文密钥`（0600）；`provider-keys.json` 存多 key 池（每个 key 的模型归属与凭据槽）。
  - 为什么单独成文：多 key 池原本在 `config.json` 里，但旧版 rivet 的 schema 不认识 `keys` 字段，一次无关写入就会静默抹掉整池（`loadConfig` strip + `saveConfig` 原样回写）。移出旧版视野后，冲突从「被缓解」变成「无法发生」——代价就是它落在了原有备份面之外。
  - 只搬 `provider-keys.json` 不搬 `secrets.json` 同样不行：池里存的仍是 `keyRef` 指针，明文在 secrets 侧。
- 也可以走环境变量（如 `export DEEPSEEK_API_KEY=sk-xxx`），仅当前 shell 有效。
- codex 等订阅型服务商走 OAuth 浏览器授权：`/login` 或终端 `rivet config login codex`。
- 配错了想整组清除：`/disconnect`——删除该 provider 条目、其注册的模型列表，并清除托管密钥。

## 4. MCP 连不上

**现象**：配置了 MCP server 但没起来，工具列表里没有 `mcp__` 开头的工具。

**先看**：

- `/mcp` 查看 MCP 状态与可用子命令。
- `/debug mcp` 逐 server 显示连接状态（connected / error + 错误原因）与已注册工具数——server 进程报错（命令不存在、参数错误、环境变量缺失）都显示在这里。
- `/trust status` 查项目授信状态。**未授信项目的项目级配置中 `mcp.servers` 会被整段忽略**（安全键不合并），这是「配了却没拉起」的最常见原因。

**怎么修**：确认项目可信后执行 `/trust` 授信（仅对本机生效、不写回仓库；安全键自下次会话起生效，需重启）。授信后仍连不上，按 `/debug mcp` 的 error 文案修 server 配置本身。

> 完整配置字段（`env` / `timeoutMs` / 代理注入 / 远程型 / `-32000` 排查）见 mcp-servers.md。


## 5. 权限弹窗太频繁

**现象**：几乎每个工具调用都弹确认，打断心流。

**先看**：`/permission`（无参数弹出交互式选择面板）查看当前档位与已有 allow/deny 规则。

**怎么修**：

- 三档统一入口：`/permission supervise`（监督：高风险全弹确认）、`/permission auto`（自动，默认档：低/无风险自动过，高风险仍确认）、`/permission unattended confirm`（全自动：免审批，写沙箱仍开，有 `/rollback` 兜底）。
- 更精细的做法不是升档，而是补规则：给常用安全命令写 allow 规则或 bash 前缀白名单（`bash.allowlist`），命中即跳过审批；deny 规则优先级最高。写法与示例见 [沙箱与权限模型](../user-guide-sandbox-permissions.md)。

## 6. 改坏了想回滚

**现象**：agent 改错了文件，想回到之前的某个状态。

**先看 / 怎么修**（三种机制，按需选）：

- **双击 ESC 倒带**（间隔 <400ms）：打开消息历史，选任一过往用户消息倒带到该点，可选「仅对话 / 仅代码改动 / 两者」三种粒度，代码动作附文件影响预览。TUI 与桌面端均可用。
- `/rollback`：预览/恢复 git 检查点（`confirm` 执行）——适合整段任务级回退。
- `/undo`：文件级版本化。无参数列出最近快照，`/undo preview <n>` 先看会动哪些文件，`/undo <n>` 执行恢复。

## 7. 终端显示异常（乱码 / 对齐错位 / 方块）

**现象**：图标变成方块或问号、表格和边框对不齐、颜色显示异常。

**怎么修**：

- 方块 / 乱字形 → 设 `RIVET_ASCII_UI=1` 强制纯 ASCII UI（降级终端）。
- 中文对齐错位 → 设 `RIVET_AMBIGUOUS_WIDTH` 覆盖 CJK 宽度判定（各终端对宽字符判定不一）。
- 颜色不用手动管：truecolor / 256 色 / 16 色三轨自动降级；`/theme list` 换主题，`/theme auto` 探测终端背景色自动适配明暗。

详见 [用户手册「终端 UI」](../user-guide.md#终端-uitui) 及「环境变量 → TUI 显示」表。

## 8. 缓存命中率掉了 / 成本突然升高

**现象**：GlanceBar 状态栏上的命中率明显低于平时的 95–99% 稳态区间，或单轮成本异常升高。

**先看**：

- `/debug cache`：当前命中率、read/write tokens、成本与缓存折扣。
- 会话目录下 `<id>/cache-log.jsonl`：逐 API 请求的 input / cacheRead / hitRate / model / turn（确切路径用 `/logs` 查）。

**为什么 / 怎么修**：前缀缓存靠「请求前缀字节完全一致」命中，四种常见碎裂原因：

1. **切模型**（`/model`）——缓存按模型命名，换模型等于换一个缓存命名空间；
2. **切星域**（`/domain`）——系统提示词与工具白名单都变，前缀重建；
3. **改工具集**（工具 preset 调整、MCP 工具增减）——工具定义指纹变化；
4. **压缩边界**——上下文压缩重写历史，边界后第一个请求重建前缀（只断一次，随后恢复稳态）。

前三种是有意切换，代价是一次性的，不用修。如果**什么都没切**却持续 miss，才需要深挖：复算命令与计费口径见 [observability-harness](../reference/observability-harness.md) 文末「复算本文数字」。

## 9. Windows 特有问题

**现象 A：提示 WebView2 运行时过旧、会话区滚动卡顿。** 界面渲染依赖 WebView2 Runtime（建议 ≥ 120）。在提示条或「设置 → 运行时与关于」里点「运行修复工具」；窗口完全打不开时，用开始菜单「修复 WebView2」，或从 [Releases](https://github.com/huiliyi37/Tianshu-harness/releases/latest) 下载 `windows-repair` 目录运行 `repair-webview2.cmd`；也可手动安装 WebView2 离线安装包后重启。

**现象 B：shell 命令执行异常。** 桌面版安装包内嵌 PortableGit（完整 Git + Git Bash，开箱即用，不依赖自装 Git；已装系统 Git 时优先用系统版）。CLI 用户自装 Git for Windows 即可获得可靠的 POSIX 命令执行——`/doctor` 会告诉你 bash 工具实际用的是哪个 shell，未用 Git Bash 时会给出警告。

## 10. 桌面端窗口打不开 / 白屏

**先看**：

- sidecar 日志：设置 → 系统 → 存储位置 → 打开日志目录；或在终端跑 `rivet logs open desktop` 直接打开。GUI 启动失败的关键线索在带时间戳的 sidecar stdout/stderr 文件里。
- `sidecar-exit.json`：sidecar 退出面包屑，崩溃排查第一现场（`rivet logs` 的输出里标了它的实际路径）。

**怎么修**：

- 白屏 / 渲染卡顿先查 WebView2 版本并跑修复工具（见第 9 节现象 A）。
- 确认存储位置指向有效目录：设置 → 存储位置里的 `current` 字段是当前实际数据目录。注意桌面端**不读** shell 里的 `RIVET_HOME`，以设置里为准。

## 11. 杀毒软件 / 企业代理拦截（安装与联网）

天枢的 Windows 安装包内嵌 Node 运行时、PortableGit 等可执行文件，安装器又要结束残留进程才能覆盖 `node.exe`——这些形状会被杀毒软件的主防（行为拦截）盯上；HTTPS 还可能被「加密连接扫描」中间人。三类现象的处置各不相同：

**现象 A：安装包被 SmartScreen / 杀毒软件拦下，提示"未知发布者"。** Windows 安装包正在接入 Authenticode 代码签名（见 [`desktop/DISTRIBUTION.md`](../../desktop/DISTRIBUTION.md)「Windows」）；**未签名的版本**只能手动放行一次：

- SmartScreen：点「更多信息」→「仍要运行」。企业策略禁止时需管理员放行。
- 卡巴斯基：「更多」→「添加到排除项」，或在 设置 → 安全 → 威胁与排除 → 管理排除项 里把安装包所在目录加进去；装好后在 设置 → 安全 → [受信任应用程序](https://support.kaspersky.cn/ksv-light-agent/5.2/65921) 里放行 `tianshu-desktop.exe` **和** 安装目录下 `node-runtime\win-x64\tianshu-runtime.exe`（子进程有独立规则；旧安装包宿主名为 `node.exe`）。

**现象 B：双击安装包"没反应"，或覆盖安装报 `Can't write ... node.exe`。** 安装器会先结束占用 `node.exe` 的残留进程（sidecar，以及你在集成终端里跑的 node/npx/tsx）。若杀毒软件拦了这一步，安装就停在无提示状态。处置：先在 受信任应用程序 里放行安装包，或临时暂停防护；也可以先手动退出天枢、关掉用着内置终端的窗口，再安装。诊断日志在 `%TEMP%\tianshu-update-hook.log`。

**现象 C：会话里一发消息就报证书错误**（`UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN` / `unable to get local issuer certificate`）。这是杀毒软件/企业代理的「加密连接扫描」替换了 HTTPS 证书，而天枢的 sidecar 默认只信任内置 CA 列表、不读 Windows 证书存储。先跑 `/doctor` 看「HTTPS 信任链」一节（会列出检出的扫描根证书），然后三选一：

1. 在该软件里排除接口域名（首选，零信任降级）：卡巴斯基 → 设置 → 安全 → 网络设置 → 加密连接扫描 → 管理排除项。
2. `NODE_EXTRA_CA_CERTS=<导出的根证书路径>` 后重启天枢（只多信这一张）。
3. `NODE_OPTIONS=--use-system-ca` 后重启天枢（信任系统 CA 存储里的全部 CA，收敛性最差）。

**现象 D：连接超时 / `ECONNRESET` / 连不上 443。** 多为防火墙的应用程序规则拦了出站（新装的"未知发布者"默认询问或阻止；当前宿主 `tianshu-runtime.exe` 常需单独放行；旧包为 `node.exe`）。放行后仍不通，就走代理：`rivet config set-proxy http://127.0.0.1:7890`（或设置 → 网络），也可在 provider 上单配 `proxy`。

**现象 E：界面能打开、但 agent 完全不可用（发消息没反应），sidecar 日志刷 `integrity-blocked: file_count_mismatch`。** 这是杀毒软件**行为检测**（卡巴斯基 PDM）拦在了 sidecar 的宿主形态上：它把「`node.exe` 执行 `rivet-runtime\cli\entry.js`」判为 `PDM:Trojan.Win32.Generic`，动作是结束进程**并隔离那个脚本文件**。文件没了，壳启动前的完整性自检就会拒绝拉起 sidecar——所以表现是"界面正常但什么都不干"，而且手动把文件还原也没用（sidecar 一执行又会在约 1 秒内被删）。先试 受信任应用程序 里放行安装目录下的 `node-runtime\win-x64\tianshu-runtime.exe`（旧包为 `node.exe`）；企业策略不允许加白时，见 [`docs/known-issues/2026-09-26-windows-kaspersky-sidecar-pdm.md`](../known-issues/2026-09-26-windows-kaspersky-sidecar-pdm.md) 的用户侧规避方案（把 sidecar 宿主换成 electron）——**那是社区用户自建的规避路径、非官方支持**，照做前先读该篇第 5 节的代价（原生模块 ABI 降级等）。

## 12. npm 全局安装 / 升级失败（EEXIST / EPERM）

CLI 通过 `npm install -g tianshu-harness` 安装与升级。若中途失败，日志尾部通常是一行 `npm error code EEXIST`——但**真正的起点往往在更上面**。先分清是下面两种中的哪一种：

**现象 A：从旧包 `tianshu-tui` 迁移时报 `EEXIST: file already exists`**（path 指向 `npm\rivet`）。v3.23.1 之前这个 npm 包叫 `tianshu-tui`，新旧两包都提供 `rivet` 命令，同时存在时 bin 链接互相冲突。先卸旧再装新：

```bash
npm uninstall -g tianshu-tui && npm install -g tianshu-harness
```

一键安装脚本（`install-tui.sh` / `install-tui.ps1`）已内置这一步，会自动检测并处理。

**现象 B：升级同一个包时，上方先出现一串 `npm warn cleanup ... EPERM`，最后才是 `EEXIST`。** Windows 上更常见：npm 要删掉旧版本的安装目录（`%APPDATA%\npm\node_modules\tianshu-harness`）再写入，但目录里的文件被占用删不掉，于是残留下来；紧接着写 `rivet` 命令链接时撞上旧文件。**日志把这两段印开了，容易被当成两件不相干的事——实际是 EPERM 在前、EEXIST 在后，前者是因后者是果。** 占用者通常是还在跑的进程（CLI、桌面端 sidecar、集成终端里的 node/npx/tsx），也可能是杀毒软件的实时扫描。

处置（PowerShell）：

```powershell
# 1) 结束可能占用文件的进程
Get-Process | Where-Object { $_.ProcessName -match 'rivet|tianshu|node' } | Stop-Process -Force -ErrorAction SilentlyContinue
# 2) 删掉残留的命令垫片（EEXIST 的直接原因）
Remove-Item "$env:APPDATA\npm\rivet*","$env:APPDATA\npm\tianshu*" -Force -ErrorAction SilentlyContinue
# 3) 删掉清理失败的残留包目录
Remove-Item "$env:APPDATA\npm\node_modules\tianshu-harness" -Recurse -Force -ErrorAction SilentlyContinue
# 4) 重装
npm install -g tianshu-harness
```

> 第 2、3 步若仍报「文件被占用」，说明占用者不是普通进程：用资源监视器搜 `rivet` 看是谁拿着，或重启后立刻执行（避开杀毒软件启动扫描的窗口）。**不建议改用 `npm install -g tianshu-harness --force`**——它会跳过一批安全检查（npm 自己的措辞是 "overwrite files recklessly"），而这里的失败清掉残留即可解决。

> 成因说明：现象 B 的「EPERM 是因、EEXIST 是果」是对一份 Windows 现场日志的推断（未在受控环境复现）；「清残留 + 重装」这条处置路径本身是 npm 在该报错信息里给出的指引。

## 13. `npm install -g` 报 EACCES（无权限写 `/usr/local`）

**现象**：`npm install -g tianshu-harness`（一键安装脚本同理）中途失败：

```
npm error code EACCES
npm error syscall mkdir
npm error path /usr/local/lib/node_modules/tianshu-harness
npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/tianshu-harness'
```

**先看**：跑 `npm config get prefix`。输出 `/usr/local` 就是这个原因——Node 由官方安装包装的场合，全局目录落在 `/usr/local`（属主 `root:wheel`、权限 755），非 root 用户写不进去。只读确认一眼即可：`ls -ld /usr/local/lib/node_modules` 显示的属主是 `root`。

**怎么修**（任选一种，改完重跑 `npm install -g tianshu-harness`）：

- **把全局目录交给当前用户**（一次 sudo，PATH 与自动更新都不受影响）：

  ```bash
  sudo chown -R "$(whoami)" /usr/local/lib/node_modules /usr/local/bin /usr/local/share/man
  ```

- **不想用 sudo：改用用户级 prefix**（之后要保证 `~/.npm-global/bin` 在 PATH 上）：

  ```bash
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global"
  echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc   # bash 用户改 ~/.bashrc
  source ~/.zshrc && npm install -g tianshu-harness
  ```

- **长期做法**：用 nvm / fnm / volta 装 Node——prefix 天然落在用户目录，不会触发这个问题。

**不要用 `sudo npm install -g`**：装得进去，但 `node_modules` 里的文件归 root；之后 `/update`（内部执行 `npm install -g tianshu-harness@latest`）会再次 EACCES，等于把问题推到下一次升级。

> 一键安装脚本（`scripts/install-tui.sh` / `scripts/install-tui.ps1`）已内置这项预检：全局目录不可写时会在**动手安装之前**直接给出原因与上面的修法，不会再把权限失败说成网络问题。

> 安装时若出现 `N packages have install scripts not yet covered by allowScripts` 的警告，可以忽略：天枢的原生依赖（`esbuild` / `better-sqlite3` / `@ast-grep/*`）都随包附带各平台预编译产物，跳过安装脚本不影响功能（`tianshu --version` 能打印版本即为通过）。

## 还有问题

在终端跑 `rivet logs --json`，把输出的结构化落点清单贴进 issue——它列出所有会话/日志文件的实际路径与写入门控，维护者能据此快速定位。

- Bug 报告 / 功能请求 → [GitHub Issues](https://github.com/huiliyi37/Tianshu-harness/issues)
- 使用问题 / 讨论 → [GitHub Discussions](https://github.com/huiliyi37/Tianshu-harness/discussions)
- 安全漏洞 → 走[私密报告](https://github.com/huiliyi37/Tianshu-harness/security/advisories/new)，不要开公开 issue
