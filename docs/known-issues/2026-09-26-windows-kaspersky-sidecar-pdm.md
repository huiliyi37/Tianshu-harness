---
title: Windows 卡巴斯基行为检测拦截桌面端 sidecar——node.exe + entry.js 形态被隔离
type: issue
status: active
date: 2026-09-26
related:
  - docs/known-issues/README.md
  - docs/guides/troubleshooting.md
---

# Windows 卡巴斯基拦截桌面端 sidecar（PDM:Trojan.Win32.Generic）

> **来源：社区贡献者 @JakcyLin 的实机复现报告**（公开仓 PR #273，2026-09-26），按 dev 现状收编。
> **状态：🟡 2026-10-07 起 Windows 安装包的 sidecar 宿主文件改为 `tianshu-runtime.exe`，不再以 `node.exe` 启动 `entry.js`。**
> 卡巴斯基是否因此放行，还要在装了卡巴的 Windows 上验证。electron 规避仍不进安装包。
> 影响版本：桌面版 3.25.0 / 3.25.1（Windows x64）起被拦截；改名从下一次 Windows 安装包开始。

## 1. 现象

装有卡巴斯基（KES 企业版）的 Windows 机器上，桌面版安装或自动更新后：

1. 窗口能正常打开、界面可用；
2. 但 **agent 完全不可用**——发消息无响应、侧栏会话无动态，任何需要 sidecar 的功能都死；
3. sidecar 日志（便携布局为 `<exe-dir>\TianshuData\.rivet\logs\sidecar-*.log`）里两类记录循环出现：
   - `integrity-blocked: file_count_mismatch`，差异项**恒为 `-cli/entry.js`**；
   - `child exited: exit code: 1073741845`（`0xC0000409`，子进程启动即退出）；
4. 安装目录里 `rivet-runtime\cli\entry.js` 不存在，而 `integrity.json` 清单的 232 个文件其余 231 个完好；
5. 卡巴报告（行为检测）条目：应用进程 `node.exe`，对象 `node.exe` + `entry.js`，结果"已阻止"；
6. 手动还原文件无效——sidecar 再次执行后约 1 秒内文件又被删，表现为"改了也没用、还原也没用"。

时间线上还有一条关键线索：**首次安装后的前约 10 分钟 sidecar 正常**，之后才开始被拦；
自动升级到新版本问题依旧，且升级器自带的自修复也失败（见 §2.4）。

## 2. 根因与代码侧对应点

### 2.1 直接原因

卡巴斯基行为检测（PDM）对 **"`node.exe` 执行 `entry.js`"这一进程形态**给出
`PDM:Trojan.Win32.Generic`，处置动作是**终止进程 + 隔离该脚本文件**。天枢的 sidecar 正是
「内置 `node-runtime` 启动 `rivet-runtime\cli\entry.js`」，于是每次启动必被拦：

- 文件被隔离 → 壳的启动前完整性自检失败 → 拒绝拉起 sidecar → agent 不可用；
- 抢在自检前还原也没用：子进程执行后约 1 秒被杀、文件再次被隔离，循环往复。

### 2.2 阻断点在本仓代码里的位置（已按 dev 现状核实）

| 环节 | 代码锚点 | 故障时的表现 |
|---|---|---|
| 壳在 `spawn_from_spec` 之前重算 bundle 摘要并验签，`block` 策略下**拒绝拉起 sidecar** | `desktop/src-tauri/src/integrity.rs`（:296 起为「篡改即拒绝拉起」的模式）；摘要算法与 JS 侧逐字节一致 | agent 完全不可用 |
| 校验失败原因枚举 | `src/config/runtime-integrity.ts:73`（`file_count_mismatch`） | 日志里的 reason |
| 差异文件名形态：缺失=前缀 `-`、新增=`+`、内容不同=`~` | `src/config/runtime-integrity.ts` `diffFiles()` | 差异"恒为 `-cli/entry.js`"正对应「单一文件被删」 |
| 桌面 UI 错误码文案 | `desktop/src/locales/zh-CN/shell.json:315`（`integrity-blocked`：安装文件校验失败，请检查更新或重新安装） | 用户侧看到的提示 |
| 覆盖安装前的整体重铺 | `desktop/src-tauri/installer-hooks.nsh` 的 `PurgeStagedRuntimes`（`RMDir /r` node-runtime / rivet-runtime / mobile-web；删不掉只记 `purge INCOMPLETE` 日志，**不中止**） | 见 §2.4 |
| 静默安装的唯一取证点 | `%TEMP%\tianshu-update-hook.log`（`installer-hooks.nsh:140-142` 起 `HookLog`，含 `KILL:` / `WAITLOCK:` 行） | 杀进程三步全败 |
| sidecar 父进程看门狗：连续 3 次探测不到宿主心跳即自退 | `src/server/serve.ts` `ParentWatchdogOptions.maxMisses`（默认 3，`intervalMs` 默认 3000） | 心跳中断 → sidecar 自行退出 |

> 也就是说：**卡巴删的文件正好落在授权完整性信任链的第一环上**——同一份被删文件，
> 既让 sidecar 起不来，也让壳判定"文件被篡改"而主动拒绝拉起，两边都指向"agent 不可用"。

### 2.3 判定与代码内容无关（作者全矩阵对照）

对"是不是某个文件有问题"做了全矩阵实测，**所有组合均被同样拦截**：

| 变量 | 测试值 | 结果 |
|---|---|---|
| node 二进制 | 内置 `node-runtime\win-x64\node.exe` / 系统已签名 node | 均被杀 |
| 入口文件内容 | 官方原版（混淆）/ 去混淆重写的等价干净版 | 均被隔离 |
| 入口文件名 | `entry.js` / 改名 `boot.js` | 均被拦截 |
| 入口文件位置 | `rivet-runtime\cli\` / 同树新目录 / 运行时树之外 | 均被删除 |
| 拉起方 | 桌面进程拉起 / PowerShell 手动拉起 | 均死亡 |
| 代码阶段 | 用 ESM loader hook 把 pro 模块劫持为空模块 | 仍被杀（仅启动变快） |

**结论：拦截跟随"进程形态"而非任何单个文件**——改写、去混淆、改名、换位置都不能规避。
这与 `docs/guides/troubleshooting.md` 第 11 节现象 B 记载的"卡巴对子进程有独立规则"一致。

### 2.4 附带发现：升级器为什么没能自修复

`%TEMP%\tianshu-update-hook.log` 显示，升级时预检的杀进程三步全部失败（`taskkill` 拒绝访问、
`killed=0`），随后 `PurgeStagedRuntimes` 因文件仍被占用而删不干净，覆盖安装写不进去，安装中止——
自修复始终没有机会补回文件。这正是"安装器/更新脚本被主防拦下"在同一条链路里的表现
（现象 B，见 [公开故障排查指南](../guides/troubleshooting.md)）。

> 与作者原稿的表述差异（按本仓代码校正）：`PurgeStagedRuntimes` 是 **无条件整体重铺**
> （为消灭跨版本残留遮蔽，issue #77），并非"检测到结构漂移才触发"；日志里的
> `structure-drift guard` 只是该宏的日志文案。

## 3. 关键对照组（含一处存疑）

- **作者的对照组**：其测试环境里"agent 跑在 electron 主进程内"的构建**从未被拦截**，卡巴报告里
  也从未出现 electron 宿主的条目 → 指向"卡巴只拦 node 脚本宿主形态"。
  ⚠️ **存疑**：本仓桌面端是 Tauri + 系统 WebView，**全仓无 electron 依赖**
  （`package.json` / `desktop/package.json` 均无），不存在"electron 主进程内跑 agent"的官方形态。
  该对照组的构建来源未在 PR 中说明，故其结论（electron 宿主不被拦）按"待复现"对待。
- **可交叉印证的一条**：卡巴每条命中的对象链都是 `node.exe` + `entry.js`，没有出现过其他形态。

## 4. 用户侧规避方案（作者已完整验证，非官方支持路径）

### 4.1 原理

桌面壳本来就支持用环境变量 `RIVET_SIDECAR_CMD` 覆盖 sidecar 的宿主可执行文件
（`desktop/src-tauri/src/lib.rs:2607` 起，最高优先级；见 `desktop/DISTRIBUTION.md:50`、
`desktop/README.md:74`）。把宿主从 `node.exe` 换成 `electron.exe` 并置
`ELECTRON_RUN_AS_NODE=1`，进程形态从"node.exe 执行 entry.js"变为"electron.exe 执行 entry.js"，
electron 在该模式下就是完整 node 运行时，功能不受影响。

### 4.2 部署清单

| 项 | 内容 |
|---|---|
| electron 完整 dist | 任取完整 electron 发行目录（`electron.exe` + `resources` 等，约 366MB；**只拷 exe 不行**，会报 ICU 数据缺失），放固定位置 |
| 用户级环境变量 | `RIVET_SIDECAR_CMD` = 上述 `electron.exe` 路径；`ELECTRON_RUN_AS_NODE` = `1` |
| 文件守护进程 | 常驻脚本每秒检查 `cli\entry.js`，缺失或哈希不符即从内存黄金副本还原（实测 < 0.5 秒）；随开机启动 |
| 探活重启 | 每分钟 `GET /health`，连续失败达阈值后重启桌面（清除进程内的 sidecar 熔断状态） |
| 原版入口文件 | 保持官方 `cli\entry.js` 原位不动、哈希与 `integrity.json` 一致（完整性自检只读不执行） |

### 4.3 验证结果（作者在故障机上实测）

- sidecar 全相位启动：`start → pro-module → rehydrate → routes → listen → host-probes → warm-start → plugins-warm → serve-agent-loaded`；
- `GET /health` 返回 `200 {"ok":true,"version":"3.25.1"}`；
- 卡巴报告零新增命中、隔离区零新增对象、`entry.js` 不再被删；
- 新建会话、会话恢复、历史重放均正常。

### 4.4 残留现象

活动期（新建会话、发起对话）卡巴**仍偶发隔离 `entry.js`**（实测一轮约 4 次）。但运行中的
sidecar 进程不受影响（模块已在内存），守护进程随后即时还原，下次完整性自检即可通过。
该残留可被完整覆盖，不影响使用。

## 5. 该方案的已知代价（照做之前先读）

1. **`better_sqlite3` 原生模块 ABI 不匹配——唯一功能性降级。**
   内置 node 为 24.x（`NODE_MODULE_VERSION` 137），electron 44 要求 149，原生模块加载失败并被容错：
   - 会话注册表自动降级为 JSONL 存储——**会话功能正常**（恢复/重放/新建均验证通过）；
   - MeridianDb 代码索引（仓库符号搜索、跨文件分析）被禁用，日志有明确告警
     （降级路径见 `src/server/serve.ts:743-753`）。
   - 彻底恢复需用 electron 的 ABI 重编译 `better_sqlite3`，再以 `RIVET_SIDECAR_ENTRY` +
     CJS require 钩子把加载重定向到编译产物（安装目录零改动，不影响完整性校验）。
2. **sidecar 会监视父进程心跳**：连续 3 次探测不到宿主即自行退出（`src/server/serve.ts`
   `ParentWatchdogOptions`），故需要 §4.2 的探活机制兜底。
3. **属规避而非根治**：依赖自备 electron dist 与两个环境变量；根治取决于卡巴侧判定更新（KSN）
   或官方提交误报获得白名单。判定一旦放行，把 `RIVET_SIDECAR_CMD` 置空即回到默认形态。

## 6. 官方侧评估（维护者视角）

1. **宿主形态：不把默认宿主改成 electron。** 桌面端是 Tauri，没有 electron。
   2026-10-07 落地的是更小的一刀：Windows 包内 Node 二进制改名为 `tianshu-runtime.exe`
   （`desktop/scripts/fetch-node-runtime.js` 的 `WINDOWS_SIDECAR_HOST`，壳优先启动它）。
   `node` / `npm` 经同目录 `node.cmd` 转到这份文件，进程名不再是 `node.exe`。
   卡巴是否只认文件名、改名后是否放行，尚未在卡巴机器上验证。
2. **`installer-hooks.nsh` 的 purge 语义（原稿建议②）：待评估，需 Windows 实机探针。**
   现状是「杀不掉也照删，删不干净只记日志、安装继续」，于是出现"既没清干净也没装上"的中间态。
   候选方向：`purge INCOMPLETE` 时改为显式失败并给出指引，或降级为"只补缺失文件"。
   改这个文件需要 Windows 机器做探针（文件头记录了 makensis 字面量上限的实测结论，见
   `2026-09-10-windows-installer-file-lock.md`），故不在本篇内动。
3. **厂商白名单**：Kaspersky Allowlist Program 与 Microsoft Defender 误报提交**已在走、每版提交**
   （见 `2026-09-23-windows-antivirus-interception.md` §5），本篇 §2.3 的对照矩阵与 §2.4 的
   `update-hook.log` 是可复用的误报证明材料。
4. **用户侧处置文档化**：`docs/guides/troubleshooting.md` 第 11 节新增现象 E（界面正常但 agent
   完全不可用）指向本篇；本篇 §4 的规避方案**非官方支持路径**，照做前先读 §5 的代价。

## 7. 附录：作者证据索引

| # | 证据 | 说明 |
|---|---|---|
| 1 | `sidecar-*.log` 中 `integrity-blocked: file_count_mismatch`，差异恒为 `-cli/entry.js` | 故障直接现象 |
| 2 | 按 `integrity.json` 全量校验：231/232 匹配，仅缺 `cli/entry.js` | 排除大面积损坏 |
| 3 | 卡巴隔离区对象时间戳与 sidecar 执行时刻逐秒对应 | 确认删除者 |
| 4 | 卡巴报告条目：`node.exe` + `entry.js`，`PDM:Trojan.Win32.Generic`（行为分析） | 判定形态 |
| 5 | §2.3 全矩阵对照（node/内容/文件名/位置/拉起方/代码阶段） | 证明与代码内容无关 |
| 6 | `%TEMP%\tianshu-update-hook.log`：杀进程三步全败、purge 后安装中止 | 自修复失败原因 |
| 7 | electron 宿主下 sidecar 全相位启动 + `/health` 200 + 卡巴零动作 | 方案有效性 |
| 8 | "electron 主进程内 agent"构建长期无拦截 | 对照组（来源未说明，见 §3 存疑） |

## 8. 相关

- 同族问题（安装被拦 / 主防误杀 / 443 中间人）：`2026-09-23-windows-antivirus-interception.md`
- 覆盖安装文件锁与 purge 宏的由来：`2026-09-10-windows-installer-file-lock.md`
- 用户侧四类现象处置：`docs/guides/troubleshooting.md` 第 11 节
- 完整性清单与 block 策略：`src/config/runtime-integrity.ts`、`desktop/src-tauri/src/integrity.rs`

## 7. MCP 启动兼容（2026-10-08）

MCP stdio 的 Windows `node` / `node.exe` / `node.cmd` / `tianshu-runtime.exe`
裸命令统一解析到当前 `process.execPath`，新桌面包即 `tianshu-runtime.exe`。
同目录旧绝对路径 `node.exe` 仅在文件已不存在时迁移；显式外部 Node 路径不覆盖。
`npx/npm` 继续以当前宿主直接执行随包 CLI，PATH 保留宿主目录及系统命令目录，
包内 `node.cmd` 继续负责 npm 安装脚本和 bin shim 的 `node` 调用。

失效方向：仅迁移已确证的 Node 别名和缺失的旧同目录文件，无法识别的路径原样执行，
通过启动 stderr 报告故障，不猜测用户外部运行时。改名兼容不代表网络、代理、
包下载或杀毒软件拦截已被排除；Windows 实机连接及卡巴行为仍需另行验证。
