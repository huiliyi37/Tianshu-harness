# 开放 issue × main 代码 核对表（2026-09-16）

> 起因：本仓开放 issue 列表与代码状态**明显不同步**——`docs/known-issues/README.md` 自己也写过
> 「2026-08-28 曾有两篇『待修复』实际早已修复/失效，误导了后续排期」。这份表把当前 37 个开放
> issue 逐条对到 `main` 的代码与用例上，供排期/关单参考。
>
> 被测：`6bad94e`（`sync: from dev repo`）/ Windows 11 25H2 / Node v24.19.0 / Git for Windows。

## 一、口径（先读这段）

每条按三层证据判：

1. `main` 上存在**带该号的修复说明注释**（`issue #N`）；
2. 存在**专门用例**（文件名/用例名带该号，或注释指明覆盖该缺陷）；
3. **在本机实跑那些用例**通过。

**引用 ≠ 修完，跑绿 ≠ 功能验收。** 本表只支持"这条要不要继续按『未修』排期"的判断；
真要关单，建议由维护者做一次确认；我没有对任何一条做手工功能复验。

## 二、22 条已在 `main` 落地（建议关闭）

| # | 标题 | `main` 上的落点 | 用例 | 实跑 |
|---|---|---|---|---|
| 115 | `/update` 横幅版本与安装通道不一致 | `src/tui/semver.ts:64`（改用按版本解析，不用 npm `latest`） | `src/tui/__tests__/updater.test.ts:65` | ✅ |
| 116 | SSRF 漏 `::ffff:0:0/96` | `src/tools/net/ssrf.ts`（内嵌 IPv4 拼法一律拒绝） | `ssrf.test.ts:41`、`http-fetch.test.ts:94` | ✅ |
| 117 | `request_path_access` 默认 write 且无上界 | 拒绝文件系统根/系统目录（见用例） | `request-path-access.test.ts:61,77` | ⚠ 1 条红（见第三节） |
| 118 | `approval-risk` 中段 `..` 绕过闸门 | `src/agent/approval-risk.ts:209`（按路径段判 `..`） | `approval-risk.test.ts:771` | ✅ |
| 119 | `import-resource` 子路径 `..` 穿越 | `src/tools/import-resource.ts:63`（容器逃逸判定） | `import-resource.test.ts:55` | ⚠ 1 条红（见第三节） |
| 120 | `recovery-cli` 假定 result 是字符串 | `src/recovery-cli.ts:85`（非字符串兜底序列化） | `recovery-cli.test.ts:102` | ✅ |
| 121 | `compareSemver` 只比 3 段 | `src/tui/semver.ts:80`（比较第 4+ 段） | `updater.test.ts:53` | ✅ |
| 122 | 代理模式 DNS pin 失效 | 代理路径显式断言（见用例） | `http-fetch.test.ts:103,114` | ✅ |
| 123 | oauth 回调 `error` 未转义（XSS） | HTML sink 转义 + 文案路径 | `oauth/connector.test.ts:40`、`request-security.test.ts:315` | ✅ |
| 124 | Win 安装行未加引号 | `src/tui/updater.ts:661`（经 `q()` 包裹） | `updater.test.ts:96` | ✅ |
| 125 | 临时文件清理正则过宽（**误删用户文件**） | `src/fs-atomic.ts:6`（固定标记 `.rivet-atomic-<8hex>.tmp`） | `fs-atomic.test.ts:50`、`startup-cleanup.test.ts:59`（含"旧形态用户文件不得删"回归） | ✅ |
| 135 | `export_file`/`import_resource` 绕过敏感门 | 本地导入经敏感检测（见用例） | `export-file.test.ts:63`、`import-resource.test.ts:30` | ✅ |
| 136 | 敏感文件白名单过宽 + `git add` 聚合盲区 | 白名单收窄（`scripts/`、`fixtures/` 不再整目录放行）+ 聚合形态走哨兵 | `sensitive-file-detector.test.ts:78,80,184` | ✅ |
| 137 | 透传 `NODE_OPTIONS`/`JAVA_TOOL_OPTIONS` | `src/tools/bash.ts:118`（刻意排除） | `bash.test.ts:443` | ✅ |
| 138 | `requestTimeCollapse` 二次复杂度 | `src/prompt/engine.ts:1595`（单遍预建索引） | `request-time-collapse.test.ts:272` | ✅ |
| 139 | 每轮构建多趟线性扫描 | `src/context/rounds.ts:395`（实测注释 + 计数） | `rounds-oai.test.ts:105` | ✅ |
| 145 | 内置 `tianshu-mcp` | `src/mcp/presets.ts:187`（来源可归因） | `mcp-presets.test.ts:99` | ✅ |
| 147 | 缺「默认工作区」 | `src/config/workspace-config.ts`、`workspace-schema.ts`、`default.ts:259` | `config/__tests__/schema.test.ts:478` | ✅ |
| 148 | stdio MCP 退出后不重连、无诊断 | `src/mcp/manager.ts:55`（一句话诊断）+ 重连注册 | `manager-stdio-reconnect.test.ts:44`（专测：degraded → 重连 → 工具面恢复） | ✅ |
| 149 | Windows 下 npx 形态 MCP 启动失败 | `src/mcp/failure-classifier.ts:9`（stderr 细分三根因）、`stdio-env.test.ts:85`（PATHEXT 净化经生产入口）、`scripts/smoke-mcp-presets.ts:4` | `failure-classifier.test.ts:80` | ✅ 但**缺 Windows 实机确认**（本机可补，见第六节） |
| 150 | MCP 预设指向已废弃包 | `src/mcp/presets.ts:97-98`（GitHub 改走官方 remote 端点；Slack **有意留白**并写明理由） | `mcp-presets.test.ts:36,60` | ✅ |

## 三、两条"红"要单独说：都是平台假设，不是未修

| 用例 | 报错 | 归因 |
|---|---|---|
| `import-resource.test.ts:74` | `EPERM: operation not permitted, symlink 'D:\etc' -> ...` | Windows 上建**目录符号链接需要管理员/开发者模式**，用例的夹具就建不起来 —— 与被测缺陷无关 |
| `request-path-access.test.ts:83` | `AssertionError: should refuse /etc/passwd` | 断言按 **POSIX 路径**写：`/etc/passwd` 在 Windows 上不是文件系统根，自然不触发拒绝 —— 平台假设问题 |

两条都属于"**测试在 Windows 上跑不了**"，不是"缺陷还在"。修法通常是：用例加平台守卫，或改用平台无关的
等价路径（`C:\Windows`、`\\?\C:\`），或在 CI 上按平台跳过。**要不要改由你们定，本表只做标注。**

## 四、确实还开着、且与代码无关的

| # | 结论 |
|---|---|
| 140 | **建议直接关闭**：三个子项在 `main` 上都不存在（`package.json` 无 `probe:*` 脚本、全仓 0 处 `parquetjs`、无 `refactor-loop*` 文件） |
| 76 | **建议直接关闭**：`perm-test`（by lanlan0811，正文只有 `perm-test` 三字），是权限测试的残留 |
| 55 / 57 | Ubuntu 中文输入 / Termux `pnpm` 构建 —— **需要对应环境**，本机（Windows）无从复现 |
| 56 / 106 / 162 / 98 / 99 | 桌面端类：#106 的 GPU 识别代码**不在本仓**（全仓仅一处 changelog 提到 `Win32_VideoController`）；#162 的前端词条与 `apply_storage_location` 在本仓也查不到 → 需要桌面端仓 |
| 68 / 70 / 71 / 73 / 146 | 功能/产品类，需要维护者拍板（不在"修 bug"范畴） |
| 153 | 中转 gpt 思考强度 —— 需要**中转 key** 才能复现 |
| 144 | 本体仍未修，阻塞项已解除（Windows 实机通道已就绪，见 `WINDOWS-VERIFICATION-2026-09-16.md` 与 `PLAN-MECHANISM-2026-09-16.md`） |

## 五、顺带发现：**#144 已经有一条可执行规格**

`src/tools/__tests__/bash.test.ts:218`（`BASH_TOOL timeout cleanup`）：

```ts
const command = `nohup node -e "setTimeout(()=>require('fs').writeFileSync(process.argv[1], 'alive'), 300)" "${marker}" >/dev/null 2>&1 & wait`
const result = await BASH_TOOL.execute({ input: { command, timeout: 50 }, ... })
await wait(700)
assert.equal(existsSync(marker), false)   // ← Windows 上这里恒红（true !== false）
```

这条用例**在 Windows 上恒红**（本机实测：`AssertionError: true !== false`，marker 被写出来了＝泄漏本体）。
也就是说修复的验收判据不需要另造：**在 Windows 上把它从红跑成绿，且 macOS/Linux 不回归**即可。
建议把这条用例写进 #144 的验收清单。

## 六、本次实跑数字（两批，均为文件路径子串过滤）

```
A 批 ssrf http-fetch request-path-access approval-risk import-resource sensitive-file
     fs-atomic export-file recovery-cli oauth
   → tests 352 | pass 350 | fail 2   （两条见第三节）

B 批 updater semver bash.test failure-classifier mcp-presets manager-stdio-reconnect
     request-time-collapse rounds-oai workspace
   → tests 266 | pass 255 | fail 9   （8 条在 workspace-guard.test.ts 另一片区、本次未归因；
                                       1 条就是第五节的 #144 规格用例）
```

全量基线另见 `WINDOWS-VERIFICATION-2026-09-16.md`（6556 用例 / 31 失败 / 3.6 min）。

## 七、边界

- **单机单版本**：Windows 11 25H2 + Node 24；未在其他平台复跑，所以"绿"只代表**这台机器上绿**；
- **只跑用例，没做功能复验**：没有手工验证任何一条的行为（例如真的去触发一次 SSRF）；
- **未逐条深挖**：第三节的两条只给归因，没给补丁；第四节的桌面端类只确认了"代码不在本仓"；
- **建议关闭 ≠ 已验收**：最终以维护者确认为准。
