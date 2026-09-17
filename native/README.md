# native/ — 作业持有者（Windows only，issue #144 本体修复的一部分）

`job-launch.exe` 是一个**极小的原生 helper**，只做一件事：**让它创建的进程"出生就在 Windows 作业对象里"**。
它不替换 `process-kill` 的任何逻辑，只是给 Windows 的 shell 启动路径换一个"持有作业"的父进程。

## 为什么必须原生、且必须由它来 spawn

三步实测（数据见 PR #163 的 `PLAN-MECHANISM-2026-09-16.md`）：

| 事实 | 后果 |
|---|---|
| Git Bash 的 `nohup node &` 逃过 `taskkill /T`（Win32 父链在 `nohup` 处断开） | 超时/中止后后台孙进程继续跑 = 本 issue |
| **事后 assign 无效**：把已经在跑的 MSYS 壳 assign 进作业，它之后 fork 的 node `ours=False anyjob=False` | "先 spawn 再 assign"这条省掉原生的路走不通 |
| **出生即在作业里有效**：挂起 assign（`CREATE_SUSPENDED → Assign → Resume`）后作业里有 5 个进程、一次终止全收 | 需要一个"已经属于作业"的进程来创建 shell —— 而 Node 没有创建作业的 API |

所以只能由 helper 来做：**helper 自建作业 → 自己先入作业 → 再 `CreateProcess` 真正的 shell**。
shell 及其 fork 链天生就是作业成员，终止时只要杀掉 helper，它持有的作业句柄关闭，
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 把整棵树一起带走。

**关键：stdio 零中转。** helper 把**自己继承到的** stdio 句柄（也就是 Node 给的管道）原样交给 shell，
所以 stdout/stderr/退出码/退出事件的语义完全不变，不需要任何中转协议。

## 构建

```bat
cd native && build-windows.bat
```

用 `vswhere` 定位 VS（需要 C++ 工具集）；产出 `job-launch.exe`（约 140 KB）。
**不需要 node-gyp、也不需要和 Node 的 ABI 对齐**——它是个独立进程，不是 addon。

## 接线与部署

- `src/tools/process-kill.ts` 里的 `resolveJobLauncher()` 按顺序找：
  `RIVET_JOB_LAUNCHER` 环境变量 → 从本模块所在目录**逐级上溯**（≤5 跳），每级先看
  `<dir>/native/job-launch.exe`、再看 `<dir>/dist/native/job-launch.exe`（同级 `native/` 优先）；
- 位置探测是**进程级缓存**的：逐级上溯最多 12 次 `existsSync`，而这个函数**每次 spawn 都被
  求值**（`spawnShell` 的默认参数）。实测本机单次 ~1.4ms、一次 spawn ~29ms，属纯常数开销，
  故缓存后有 ~2000× 的下降。代价是一处语义：**运行中才把 helper 编译出来**时要二选一——
  设 `RIVET_JOB_LAUNCHER` 指向它（这条路永远实时读），或调 `invalidateJobLauncherCache()`；
- **解析不到就返回 `null`，`spawnShell` 原样 `spawn`**（fail-open，行为与今天完全一致）；
- 发布时建议按平台预编译（`win32-x64` / `win32-arm64`）随包分发，`.exe` 不进 git。

## 实测（Windows 11 25H2 / Node v24.19.0 / Git for Windows）

**A/B 对照**（同一套泄漏夹具：`nohup node` 每 250ms 打点；判据是打点增长 + 残留进程数）：

| 组 | 做法 | 结果 |
|---|---|---|
| A 现状 | 直接 `spawn` bash，超时后 `taskkill /F /T` | 打点 6 → 10 **仍在写（泄漏）**，残留 1 |
| B 本改动 | helper 持有作业，**只杀 helper 一个进程**（不带 `/T`、不枚举、不看进程表） | 打点 4 → 4 **已停 ✓**，残留 0，金丝雀不变 |

**仓内验收用例**（`src/tools/__tests__/bash.test.ts:218`，就是为本 issue 写的那条，
判据是"命令超时后后台进程不得写出 marker"）：

| 状态 | 结果 |
|---|---|
| helper 不在（走现状） | `tests 69 / pass 68 / fail 1` —— 红的就是那条验收用例 |
| helper 在位 | `tests 69 / pass 69 / fail 0` |

同一批里 `echo hello 返回可见 stdout（Windows detached 回归保护）` 等 68 条全程稳定，
说明接线没有副作用。

## 未覆盖 / 已知边界

- **arm64 未实测**（本机是 x64；源码本身无架构相关代码）；
- **libuv 的非阻塞管道**：本机验证用的是 `CreatePipe` + 线程 pump，语义等价但不是同一条实现；
  集成层（真跑仓内用例）已覆盖，但极端并发下的行为未单独压过；
- **`params.jobs.spawn`**（后台任务那条 spawn 路径）目前**不走** helper，需确认是否要一起覆盖；
- **中止路径语义**：现在是 `killProcessTree(child,'SIGTERM')` → 3s 后 `SIGKILL`；走 helper 时
  第一次 `taskkill /F` 就已经把整棵树带走，"3 秒兜底"实际不再需要（行为上更早收干净）；
- 其他 MSYS/cygwin 版本、以及 `detached: true` 的形态未测（本仓 Windows 上是 `detached: false`；
  detached 会 breakaway 出作业，若将来要用需重新评估）。

## 安全说明

helper 只做四件事：建作业、自己入作业、`CreateProcess` 传入的命令、等它退出并转发退出码。
它**不解析命令行**（argv 原样透传）、**不写文件**、**不联网**；可选的 `--parent-pid` 只用于
"父进程没了就把作业收掉"这一条看门狗逻辑。
