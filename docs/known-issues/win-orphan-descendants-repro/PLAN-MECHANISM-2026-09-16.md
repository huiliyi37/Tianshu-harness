# #144 修复路线：机制层实测判定（2026-09-16）

> 目的：把「哪条修复路线真的可行」用 Windows 实机实测钉死——而不是靠文档推断。
> 这是 `docs/known-issues/README.md` 里 #144「阻塞于 Windows 实机验证通道」的那一环。
>
> 被测环境：Windows 11 25H2（build 26200）/ Git for Windows 的 MSYS bash / Node v24.19.0 / MSVC（VS 2022 Build Tools）。

判据统一为**打点文件增长**：命令树是「`bash -c` → `nohup node` 每 250ms 追加一字节」，
`TerminateJobObject` 之后**长度还在不在增长**就是结论（不看进程表，理由见本目录 README 的安全条款）。

---

## 一、四种形态的实测对照

| # | 形态 | 壳在作业里 | 壳 fork 出的**孙进程**在作业里 | `TerminateJobObject` 能否收干净 | 对应路线 |
|---|---|---|---|---|---|
| A | 由**作业成员**创建壳（helper 自入作业 → `Start-Process bash`） | ✅ | ✅ | ✅ 有效（残留 0） | **方案 2**（helper 拥有 spawn） |
| B | **挂起时 assign**：`CreateProcess(CREATE_SUSPENDED)` → `Assign` → `ResumeThread` | ✅ | ✅ | ✅ 有效（`job_members=5`，残留 0） | **方案 1**（作业内 spawn） |
| C | **事后 assign** 一个**已经在跑**的 MSYS 壳 | ✅ `ours=True` | ❌ `ours=False anyjob=False` | ❌ 收不到（打点继续增长） | ✗ 不成立（曾被当作"低成本的方案 1 变体"） |
| D | **事后 assign** 一个普通 Win32 进程（`node.exe`），再由它创建子进程 | ✅ | ✅ `ours=True` | ✅ 有效 | 只说明"先 assign 再让它生孩子"本身没问题 |

**两条关键结论**（都是这次新测出来的）：

1. **方案 1 的机制成立**（B）：挂起 → assign → resume 之后，作业里是 **`[bash, 以及它 fork 出来的 4 个进程]`**，一次 `TerminateJobObject` 全部收走、作业成员归零、打点停止、无残留。也就是说「出生即在作业里」对 MSYS 的 fork 链同样有效——**方案 1 不需要发明什么新机制**。
2. **"事后 assign 省掉原生依赖"这条路不成立**（C）：壳确实进了作业（`ours=True`），但它之后 fork 的 node **不在任何作业里**（`anyjob=False`），终止也收不到。而同样"事后 assign"用在**普通 Win32 进程**上却是有效的（D）——所以差异出在 **MSYS 的 fork**：成员资格必须在该进程**运行起来之前**就位，事后补不回来。

> 补充说明 D 为什么也值得测：它和 B 只差"由谁创建子进程"，用它把"事后 assign 对普通进程是否有效"单独隔离出来，才能把 C 的失败归因到 MSYS 而不是 assign 本身。

---

## 二、怎么复跑

```bash
# B：方案 1 的机制（原生探针，直接 cl 编译，不需要 node-gyp）
cd plan-probes && cmd //c build.bat
./suspended-job.exe <marker> 1500
#   期望：assign_suspended ok=1 / job_members_before_kill=5 / post_kill ... STOPPED

# C：事后 assign 的 MSYS 壳（PowerShell holder + Node 驱动）
node handshake.cjs
#   期望：ASSIGNED ok=True 但 INJOB ... ours=False → 终止后仍在写

# D：事后 assign 的普通进程
node plan1-assume.cjs
#   期望：shim ours=True、子进程 ours=True → 终止后已停
```

复跑时的注意点：

- `handshake.cjs` / `plan1-assume.cjs` 依赖 `holder.ps1`（预热好的作业持有者，Add-Type 编译约 0.8–1.3s）；
- `shim.cjs` 是"先阻塞、被 assign 之后才创建子进程"的中间进程，用来模拟 B 的时序；
- `suspended-job.c` 里 MSYS 命令行与夹具同形（`nohup ... & wait`），换命令形态时判据不变；
- 打完就跑完即删临时目录；三个探针都会在结束时自报残留，残留不为 0 说明没测干净。

原始输出（本次实机）：

```
# B
created_suspended pid=56604
assign_suspended ok=1 err=0
resume ok=1 (prev suspend count=1)
job_members_before_kill=5 [56604,55804,59612,53140,62128] | ticks=4
pre_kill growth: 4 -> 8 (alive)
terminate_job=1 err=0
post_kill ticks=8,8 members=0 -> STOPPED (job object reaped the MSYS tree)

# C
3) ASSIGNED ok=True pid=33596 err=0
   INJOB pid=33340 ours=True anyjob=True          ← 壳：在作业里
   INJOB pid=45316 ours=False anyjob=False        ← 它 fork 的 node：不在任何作业里
5) TERMINATED ok=True err=203
   终止后打点 9 → 14 → 18  **仍在写 ✗ 作业没覆盖到**

# D
3) ASSIGNED ok=True pid=46072 err=0
   shim  : INJOB pid=46072 ours=True anyjob=True
   子进程: INJOB pid=42604 ours=True anyjob=True  ← 先 assign 再生孩子是有效的
5) TERMINATED ok=True err=203
   终止后打点 5 → 5 → 5  **已停 ✓ 作业收住了子孙**
```

---

## 三、对修复路线的影响

1. **方案 1 与方案 2 都可行，方案 1 的机制层已被实测证实**——与你们此前的排序一致（方案 1 优先、方案 2 次选）。
2. **但"不引入原生依赖也能做到方案 1"的想法被否掉了**：C 组实验说明，MSYS 的 fork 不接受事后补的成员资格，所以要么让进程**出生即在作业里**（需要原生 `CreateProcess`），要么让**作业持有者自己去 spawn**（= 方案 2，代价是 stdio/退出码中转）。
3. 因此方案 1 的**最小原生面**可以非常小：只需要「以挂起方式创建进程 → assign 进作业 → resume」这一个能力，其余（读 stdout/stderr、退出码、超时）仍由 Node 的 `child_process` 负责——也就是一个**只暴露这一件事**的 N-API 模块，或者一个只做这件事的极小 helper。**代价仍是打包**：预编译产物 + `optionalDependencies`（加载失败时退回现有 `taskkill /F /T` 路径，fail-open 不改变现状）。
4. 如果你们不愿意引入原生依赖，**方案 2 的复现夹具已经就绪**（A 组：`job-object.ps1` 的 `inside` 模式），可以直接在此基础上做 stdio 中转的设计。

---

## 四、边界

- **单机单版本**：25H2 + 该版本 Git for Windows 的 MSYS；未覆盖其他 MSYS/cygwin 版本、未测 arm64。
- **C 组的失败是"MSYS fork 的行为"**：这里只归因到"成员资格必须在进程运行前就位"，没有深入到 `msys-2.0.dll` 的 fork 实现去取证。
- **B 组是机制验证，不是 addon 实现**：`suspended-job.c` 是独立 exe，不是 Node 可加载的 addon；把它包成 N-API 模块并接进 `process-kill` 的 Windows 分支，是另外的工程工作（也是这个 PR 不包含的部分）。
- **未验证 `CREATE_SUSPENDED` 之外的其他属性组合**（如 `PROC_THREAD_ATTRIBUTE_JOB_LIST`）：后者在 Win10+ 可以让进程带作业出生，可能省掉 assign 这一步——但同样需要原生 `CreateProcess`，对结论（要原生）没有影响。

---

## 五、补测：stdio 管道能不能穿过"挂起创建"（`suspended-pipe.c`）

B 组用的是继承控制台，**没有覆盖 stdio 管道**——而真实 spawn 路径（`src/tools/bash.ts:537`）是
`stdio: ['ignore','pipe','pipe']` + Windows 上 `detached: false`。而"最小原生面"这个设计成立的前提，
正是**挂起创建之后管道照常工作**：能流式读、进程消亡时读端收到 EOF（否则 Node 侧 stream 不 end、
child 不 close、工具 Promise 不 settle）。所以补了这一测。

复跑：

```bash
cd plan-probes && cmd //c build-pipe.bat
./suspended-pipe.exe <marker> 1200
```

实机输出：

```
created_suspended pid=56652 (with pipes wired as std handles)
assign_suspended ok=1
resume ok=1
while_running: stdout=13 bytes stderr=13 bytes | job_members=5 | ticks=3
terminate_job ok=1
after_kill: stdout_eof=1 stderr_eof=1 | pipe closure=OBSERVED (broken pipe)
post_kill ticks=7,7 members=0 | pre_kill growth 3->7
verdict: pipes_survived=YES tree_reaped=YES
```

**结论：管道保真 ✅** —— 挂起创建 + assign + resume 之后 stdout/stderr 正常流式、终止后两个读端都收到
broken pipe、整棵树回收、残留 0。

**一个实现时必须记住的坑**：`CreateProcess` 成功后**必须立刻关掉父进程手里那份写端句柄**。
第一版探针没关，结果 `terminate_job` 明明成功、树也收干净了，但读端**永远等不到 EOF**（最后一个写入者
一直存在）。libuv 在 spawn 之后做的正是这件事；漏掉它就会表现成"杀成功了但流一直不关"。

**仍未覆盖的**（要集成层才能验）：libuv 的非阻塞管道（本测用的是同步 `CreatePipe` + 线程 pump，
语义等价但不是同一条实现）、`params.jobs.spawn` 那条后台任务路径、以及中止路径
（现在是 `SIGTERM` → 3s → `SIGKILL`，作业方案下应换成一次 `TerminateJobObject`）。
