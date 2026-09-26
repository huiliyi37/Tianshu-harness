# Windows 卡巴斯基拦截桌面端 sidecar 的完整分析与规避方案

> 影响版本：天枢桌面版 3.25.0 / 3.25.1（Windows x64）
> 判定名称：`PDM:Trojan.Win32.Generic`（卡巴斯基行为检测 / 行为分析）
> 关联：安装器/更新脚本被主防拦截族已知问题（`docs/known-issues/` 下对应篇目）、`docs/guides/troubleshooting.md` 第 11 节
> 性质：已知问题复现报告 + 用户侧完整规避方案（**不需要**给卡巴加白名单、不需要暂停防护）

---

## 一、现象

在装有卡巴斯基（企业版 KES）的 Windows 机器上，天枢桌面版安装或自动更新后出现：

1. 桌面窗口能正常打开，界面可用；
2. 但 agent 完全不可用——发消息无响应、侧边栏会话无动态、任何需要 sidecar 的功能都不可用；
3. 查看 sidecar 日志（`TianshuData\.rivet\logs\sidecar-*.log`）可见两类循环出现的记录：
   - `integrity-blocked: file_count_mismatch`，差异项恒为 `-cli/entry.js`（文件缺失）；
   - `child exited: exit code: 1073741845`（sidecar 子进程启动即退出）；
4. 检查安装目录发现 `rivet-runtime\cli\entry.js` 确实不存在——而完整性清单 `integrity.json` 里 232 个文件其余 231 个全部完好；
5. 卡巴斯基报告（行为检测）中出现大量条目：应用进程 `node.exe`，对象 `node.exe` + `entry.js`，结果"已阻止"；
6. 手动把文件还原后，sidecar 一旦再次执行该文件，文件又在约 1 秒内被删除——表现为"改了也没用、还原也没用"。

时间线上还有一个值得记录的现象：**首次安装后的前约 10 分钟 sidecar 是正常的**，之后才开始被拦截；自动升级到新版本后问题依旧，且升级器自带的自修复也失败（见第二节证据 6）。

## 二、根因

### 2.1 直接原因

卡巴斯基行为检测（PDM）对 **"`node.exe` 执行 `entry.js`" 这一进程形态**给出 `PDM:Trojan.Win32.Generic` 判定，处置动作是**终止进程 + 隔离该脚本文件**。sidecar 的设计正是 `node.exe`（内置 `node-runtime`）启动 `rivet-runtime\cli\entry.js`，因此每次启动必被拦截：

- 文件被隔离 → 桌面启动 sidecar 前的完整性自检失败 → 拒绝拉起 → agent 不可用；
- 即使抢在自检前还原文件，子进程执行该脚本后约 1 秒内即被杀，`entry.js` 再次被隔离，循环往复。

### 2.2 判定与代码内容无关（实测证据）

对"是不是某个文件有问题"做了全矩阵对照，**所有组合均被同样拦截**：

| 变量 | 测试值 | 结果 |
|---|---|---|
| node 二进制 | 内置 `node-runtime\win-x64\node.exe` / 系统已签名 node | 均被杀 |
| 入口文件内容 | 官方原版（混淆）/ 去混淆重写的等价干净版 | 均被隔离 |
| 入口文件名 | `entry.js` / 改名 `boot.js` | 均被拦截 |
| 入口文件位置 | `rivet-runtime\cli\` / 同树新目录 / 运行时树之外的路径 | 均被删除 |
| 拉起方 | 桌面进程拉起 / 从 PowerShell 手动拉起 | 均死亡 |
| 代码阶段 | 用 ESM loader hook 把 pro 模块（`pro\index.js`）劫持为空模块 | 仍被杀（仅启动变快） |

**结论：拦截跟随"进程形态"而非任何单个文件**。改写、去混淆、改名、换位置都不能规避；这与排障文档中"卡巴对子进程有独立规则"的记载一致。

### 2.3 关键对照组

同一台机器上存在两个天然对照：

- **开发态构建**：agent 跑在 electron 主进程内（桌面自身即宿主，不产生 `node.exe` 子进程），**从未被拦截**，功能完全正常；
- **卡巴报告本身**：每一条命中的对象链都是 `node.exe` + `entry.js`，没有出现过 electron 宿主的条目。

两条对照共同指向：**卡巴不拦 electron 宿主形态，只拦 node 脚本宿主形态**。

### 2.4 附带发现（升级器自修复为何也失败）

更新器的预检日志（`%TEMP%\tianshu-update-hook.log`）显示，升级时它检测到 `rivet-runtime` "结构漂移"（因 `entry.js` 已缺失），打算清目录重装，但日志里杀进程三步全部失败（`taskkill` 拒绝访问、`killed=0`），随后安装中止——自修复始终没有机会补回文件。这正是排障文档记载的"安装器/更新脚本被主防拦下"在同一条链路里的表现。

## 三、规避方案（已完整验证）

### 3.1 原理

桌面端本来就支持用环境变量 `RIVET_SIDECAR_CMD` 指定 sidecar 的宿主进程。把宿主从 `node.exe` 换成 `electron.exe` 并置 `ELECTRON_RUN_AS_NODE=1`，sidecar 的进程形态从"node.exe 执行 entry.js"变为"electron.exe 执行 entry.js"——避开卡巴的行为规则，同时 electron 在该模式下就是完整的 node 运行时，功能不受影响。

### 3.2 部署清单

| 项 | 内容 |
|---|---|
| electron 完整 dist | 任取一个完整 electron 发行目录（`electron.exe` + `resources` 等，约 366MB；单独拷贝 exe 不行，会报 ICU 数据缺失），放到一个固定位置 |
| 用户级环境变量 | `RIVET_SIDECAR_CMD` = 上述 `electron.exe` 的路径；`ELECTRON_RUN_AS_NODE` = `1` |
| 文件守护进程 | 一个常驻脚本：每秒检查 `cli\entry.js`，缺失或哈希不符时从内存中的黄金副本立即还原（实测还原耗时 < 0.5 秒）；随开机启动 |
| 探活重启 | 每分钟检查 sidecar 健康（`GET /health`），连续失败达到阈值后重启桌面（清除桌面进程内的 sidecar 熔断状态，该状态只会记忆"放弃拉起"） |
| 原版入口文件 | 保持官方 `cli\entry.js` 原位不动（完整性自检只读取它，不执行；哈希必须与 `integrity.json` 一致） |

### 3.3 验证结果

- sidecar 完整启动：`phase=start → pro-module → rehydrate → routes → listen → host-probes → warm-start → plugins-warm → serve-agent-loaded`；
- `GET /health` 返回 `200 {"ok":true,"version":"3.25.1"}`；
- 持续稳定运行，卡巴报告**零新增命中**、隔离区**零新增对象**、`entry.js` 不再被删；
- 新建会话、会话恢复、历史重放均正常。

### 3.4 需要说明的残留现象

活动期间（新建会话、发起对话时）卡巴**仍会偶发隔离 `entry.js`**（实测一轮使用了约 4 次）。但此时文件只是被删，**运行中的 sidecar 进程不受影响**（模块已在内存），守护进程随后即时还原，桌面下次完整性自检即可通过。因此该残留现象可被完整覆盖，不影响使用。

## 四、方案的小限制

1. **`better_sqlite3` 原生模块 ABI 不匹配（唯一功能性降级）**
   内置 node 为 24.x（`NODE_MODULE_VERSION` 137），electron 44 要求 149，原生模块加载失败并被容错。后果：
   - 会话注册表自动降级为 JSONL 存储——**会话功能正常**（恢复、重放、新建均验证通过）；
   - MeridianDb 代码索引（仓库符号搜索、跨文件分析）被禁用，日志中有明确告警。
   - 彻底恢复方法：用 electron 的 ABI 重新编译 `better_sqlite3`，并通过自定义入口（`RIVET_SIDECAR_ENTRY` + CJS require 钩子）把该模块的加载重定向到编译产物——安装目录内的文件一个字节都不动，完整性校验不受影响。

2. **sidecar 会监视父进程心跳**
   sidecar 连续 3 次探测不到桌面心跳会自行退出（设计行为）。实测桌面侧发生过一次心跳中断（疑似与 sqlite 注册表失败相关），此时需要探活机制重启桌面来恢复。若按第 1 条修好 sqlite，此类中断预计随之减少。

3. **属于规避而非根治**
   方案依赖 electron dist 与两个环境变量；根治取决于卡巴侧判定更新（KSN）或官方提交误报获得白名单。卡巴判定一旦放行，把 `RIVET_SIDECAR_CMD` 置空即可回到官方默认形态，守护进程建议保留。

## 五、给官方的建议

1. **代码级根治（推荐）**：将 sidecar 默认宿主改为 electron（`ELECTRON_RUN_AS_NODE=1`），或在启动时检测到行为检测拦截时自动切换宿主并回退提示。这一改动同时消解本节全部问题，且 electron dist 对桌面端本就是现成依赖。
2. **更新器自修复降级**：预检杀进程失败（主防拦截）时，`structure-drift guard` 应降级为"仅还原缺失/漂移文件"而非整体放弃——本次故障中自修复失败是问题长期化的直接原因。
3. **向卡巴提交误报时的材料**：可附上本报告第二节的行为链证据（命中对象恒为 `node.exe` + `entry.js`、与代码内容无关的对照矩阵），并说明应用已在走 Kaspersky Allowlist Program。
4. **文档**：建议将本文件收录为 `docs/known-issues/` 成员，与安装器拦截篇并列。

---

## 附录：完整证据索引

| # | 证据 | 说明 |
|---|---|---|
| 1 | `sidecar-*.log` 中 `integrity-blocked: file_count_mismatch`，差异恒为 `-cli/entry.js` | 故障直接现象 |
| 2 | 按 `integrity.json` 全量校验：231/232 匹配，仅缺 `cli/entry.js` | 排除大面积损坏 |
| 3 | 卡巴隔离区对象时间戳与 sidecar 执行时刻逐秒对应 | 确认删除者 |
| 4 | 卡巴报告条目：应用进程 `node.exe`，对象 `node.exe`+`entry.js`，`PDM:Trojan.Win32.Generic`（行为分析） | 判定形态 |
| 5 | 第二节全矩阵对照（node/内容/文件名/位置/拉起方/代码阶段） | 证明与代码无关 |
| 6 | `%TEMP%\tianshu-update-hook.log`：杀进程三步全败、purge 后安装中止 | 升级器自修复失败原因 |
| 7 | electron 宿主下 sidecar 全相位启动 + `/health` 200 + 卡巴零动作 | 方案有效性 |
| 8 | dev 构建（electron 进程内 agent）长期无拦截 | 对照组 |
