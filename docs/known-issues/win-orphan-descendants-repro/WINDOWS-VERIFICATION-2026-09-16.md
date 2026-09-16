# Windows 实机验证记录 · 2026-09-16

> 目的：把 `docs/known-issues/README.md` 里 #144 那条「阻塞于 **Windows 实机验证通道**」落到可复用的形式上——
> 一条能跑、能出证据、能反证的通道，而不是一个承诺。

## 0. 环境（单机基线，如实标注）

| 项 | 值 |
|---|---|
| OS | Windows 11（`DisplayVersion 25H2`，build 26200）|
| Shell / bash | Git for Windows 的 MSYS bash（`C:\Program Files\Git\bin\bash.exe`）|
| Node | v24.19.0（仓要求 `>=24`）|
| 被测源码 | commit `6bad94e`（`sync: from dev repo`，本分支只在其上加 docs）|
| 依赖 | 该工作副本已 `npm ci` 过（`node_modules` 现成）|

**单一环境，无跨平台对照**：没在 Linux/macOS 上跑同一套，所以下文任何"失败"都**不能**断言为 Windows 专属。

## 1. 验收：PR #159（`taskkill` 一律带 `/F`）

同一台机器、同一条命令、只切换那两个文件的版本：

```bash
npx tsx scripts/run-node-tests.ts process-kill        # 位置参数是文件路径子串过滤
```

| 版本 | 结果 | 原始输出摘要 |
|---|---|---|
| **修前**（`361e043`，即 `6bad94e` 的上一版） | **tests 2 / pass 0 / fail 2** | 两条断言都期望 `process.kill` 被调用：`actual: []` vs `expected: [[-1234,'SIGTERM']]`；另一条 `actual: []` vs `expected: ['SIGKILL']` —— Windows 上旧实现走 `taskkill` 分支、根本不调 `process.kill`，所以这两条 unix 假设的用例在 Windows 必红 |
| **修后**（`6bad94e`） | **tests 6 / pass 6 / fail 0** | `killProcessTree (unix)` 2/2、`killProcessTree (win32)` 3/3（含「always passes /F」与「不做二次非 /F 优雅阶段」）、`taskkillArgs` 回归护栏 1/1 |

复现方法（两步，只动那两个文件，不改依赖）：

```bash
git checkout 361e043 -- src/tools/process-kill.ts src/tools/__tests__/process-kill.test.ts
npx tsx scripts/run-node-tests.ts process-kill
git checkout HEAD -- src/tools/process-kill.ts src/tools/__tests__/process-kill.test.ts
```

## 2. 基线：全量套件（`npm run test:fast`）

```
ℹ tests 6556 | ℹ pass 6523 | ℹ fail 31 | ℹ skipped 2 | ℹ duration_ms 218764  (~3.6 min)
```

31 条失败分布在 20 个文件，**全部与 #144 的进程回收无关**（属 git/worktree、indexer、session 持久化、hook 管线等子系统）。按形态归成三族（**只做形态归纳，未逐条挖根因**）：

**A. 路径拼接把绝对路径当地名 —— `D:\D:\AIchat\...`**（`scripts/swebench-run.test.ts`，4 条）

```
Error: ENOENT: no such file or directory, mkdir 'D:\D:\AIchat\tianshu-harness-lab\.rivet\test-tmp'
```

**B. 临时目录清理 EPERM**（14 条 EPERM，多处；多数像是**用例体本身通过、teardown 清理失败**）

```
Error: EPERM, Permission denied: \\?\C:\Users\<user>\AppData\Local\Temp\rivet-domain-integration-yxJHvk
```

**C. 会话/消息持久化 ENOENT**（31 条 ENOENT，多为 `...\Temp\rivet-msg-test-*\*.jsonl` 落点不存在）

```
[session-persist] batch flush failed: Error: ENOENT: no such file or directory,
  open '...\Temp\rivet-msg-test-wu9mAh\test-session-oai.jsonl'
```

失败最多的文件（前几名）：`src\agent\__tests__\theta-check.test.ts` 5 条、`scripts\swebench-run.test.ts` 4 条、`src\agent\__tests__\import-graph.test.ts` 3 条，其余 1–2 条散落。

> **计数口径提醒**：B 族这类"teardown 挂了"的失败会把 `fail` 数放大 —— 判读时别把 31 直接当成 31 个功能缺陷。

## 3. 可复用的验证协议（这条通道怎么用）

**你们给三点，我们跑并回证据：**

1. **base commit**（要验的那个 sha + 是干净 main 还是某个分支）；
2. **要看的判据**（例：某个用例由红转绿 / 某个命令的耗时或残留）；
3. **反证条件**（什么情况下判"不通过"——比如"打点仍在增长""残留进程数 > 0"）。

**我们回四样：**

1. 命令原文（可原样复跑）；
2. **原始输出**（不裁剪，含 `ℹ tests/pass/fail` 摘要与失败原文）；
3. **判据结论**（通过/不通过 + 依据）；
4. **边界说明**（本机环境、是否单点场景、有没有被 teardown 之类的噪声放大）。

**约定**：只在这台 Windows 上跑，**不改 `process-kill` 的 Windows 分支**（沿用你们那条纪律）；需要真机复现进程泄漏这类问题时，用同目录的 `win-orphan-descendants-repro/` 那套夹具（打点判据，不看进程表）。

## 4. 边界（这份记录不成立的场合）

- **没有跨平台对照**：31 条失败里哪些是 Windows 专属、哪些在 Linux/macOS 上也红，本机无从判断；
- **单机单一环境**：25H2 + Node 24 + Git for Windows，未覆盖其他版本组合；
- **未逐条 root-cause**：第 2 节只给形态与样例，没给每条失败的根因与修复建议；
- **基线含噪声**：如第 2 节的计数口径提醒；
- 桌面端（`app.tianshu.desktop`）那两条"待 Windows 实机验收"的滚动线**不在本记录范围**（需要真实 WebView2 环境，是另一条通道）。
