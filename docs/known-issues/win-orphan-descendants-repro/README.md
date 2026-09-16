# Windows + Git Bash：命令超时后后台孙进程逃过 `taskkill /T` —— 复现与验证脚本

对应 issue：**[bug] bash 超时后 Windows/Git Bash 环境下后台孙进程未被 taskkill /T 杀死（进程泄漏）**。

> 归属：本套脚本服务于 issue #144，配套追踪档案
> `docs/known-issues/2026-09-15-windows-git-bash-orphan-descendants.md`。
> 仓内副本位于 `docs/known-issues/win-orphan-descendants-repro/`；外链 gist 是同一份内容。
> 命名不带日期前缀，是为了**避免与那份 `.md` 档案同名冲突**（见 `docs/known-issues/README.md` 的命名约定）。
>
> 同目录另有两份记录：
> [`WINDOWS-VERIFICATION-2026-09-16.md`](WINDOWS-VERIFICATION-2026-09-16.md)（实机验证：修前/修后对照 + 全量基线 + 可复用协议）与
> [`PLAN-MECHANISM-2026-09-16.md`](PLAN-MECHANISM-2026-09-16.md)（四种修复形态的机制层实测判定，含 `plan-probes/` 下的可复跑探针）。
> 外链 gist 是同一份内容的**扁平副本**（没有目录结构）；以仓内这份为准。

这套脚本只做三件事：**复现现象**、**量化代价**、**验证候选方案**。它不含修复补丁。

---

## 一句话结论（脚本能验证的部分）

| 结论 | 由哪个脚本产出 |
|---|---|
| `taskkill /F /T` **杀不掉** MSYS 后台孙进程，打点仍在增长 | `repro.cjs` |
| 不带 `/F` 的 `taskkill /T` 对 console 子进程是 **no-op**，白等 3 秒才落 `/F` | `port-release.cjs` |
| MSYS 侧按 PID `kill -9` **能**回收（机制本身有效） | `repro.cjs` / `matrix.cjs` |
| 但「先杀壳、再按根枚举」**拿不到根** —— 壳的 PID 已从进程表消失 | `matrix.cjs` 的 S2 |
| 作业对象：进程**出生即在作业里**才有效；**spawn 之后再 assign 追不上** | `job-object.cjs` |

---

## 判据：打点，不看进程表

每个被测命令都是一棵「`bash -c` → `nohup node` 后台打点」的树，node 每 250ms 往 `marker` 文件追加一个字节。

**判据只有一条**：`taskkill` / `kill` 之后，marker 的长度还在不在增长。

```js
const ticks = (f) => fs.statSync(f).size        // 增长 = 还活着；不变 = 已停
```

为什么不用 `ps`：实测中按 `ps` 文本解析判断"是否残留"本身就会出错（见下面的安全条款第 2、3 条）。打点是唯一不受解析误差影响的信号。

---

## 环境要求

- Windows（实测 Windows 11，`DisplayVersion 25H2`）
- **Git for Windows**（用它的 MSYS bash）
- Node.js ≥ 18（实测 v24）
- PowerShell 5.1（`job-object.ps1` 用，走 `Add-Type` 调 Win32 API）

可覆盖的变量：

| 变量 | 默认 | 用途 |
|---|---|---|
| `BASH_PATH` | `C:\Program Files\Git\bin\bash.exe` | 指定 bash |
| `POWERSHELL` | `powershell` | 指定 PowerShell |
| `PORT` | `34567` | 端口释放实验用 |
| `CANARY_PATTERN` | `bash.exe` | 金丝雀匹配的进程名 |
| `DRY` | 空 | 设 `1` 时只列出「准备杀谁」，不动手 |

---

## 快速开始

```bash
node repro.cjs          # ① 复现泄漏 + 事后清扫
node matrix.cjs         # ② 四场景矩阵（S1 趁壳活着回收 / S2 事后清扫 / S3 并发隔离 / S4 秒退兜底）
node job-object.cjs     # ③ 作业对象正反例
node port-release.cjs   # ④ 端口释放窗口（#159 的原始观测）

DRY=1 node matrix.cjs   # 动手之前先看一眼准备杀谁（推荐先跑这个）
```

文件清单：

| 文件 | 作用 |
|---|---|
| `lib.cjs` | 公共部分：bash 定位、打点判据、严格枚举 + 归属校验的回收封装 |
| `tree.sh` | 严格解析的进程枚举（`--pid <msys_pid>` / `--match <pattern>`） |
| `guard.sh` | 归属安全校验（第二道闸，见安全条款） |
| `repro.cjs` | 最小复现 + 事后清扫 |
| `matrix.cjs` | 四场景矩阵 + 金丝雀误伤检测 |
| `job-object.ps1` / `job-object.cjs` | 作业对象正反例（`inside` / `assign`） |
| `port-release.cjs` | 端口占用窗口对比 |

---

## 实测记录

以下都是本机实跑输出（Windows 11 25H2 + Git for Windows + Node v24.19.0）。

**① 泄漏复现（`repro.cjs`）**

```
t≈0.9s   : 打点 = 2  （后台 node 已在写）
现状杀法 : taskkill /F /T（rc=0）
杀之后   : 打点 5 → 8  → 仍在增长 = **泄漏已复现** | 残留 1
事后清扫 : 按 marker 指纹枚举 → 命中 1 个（PID 668, node.exe）→ GUARD 通过
结果     : 打点 13 → 13 → 已停 ✓ | 残留 0 | 金丝雀 5 → 5 ✓ 未误伤
```

**② 四场景矩阵（`matrix.cjs`）**

```
S1 趁壳还活着回收（--pid，自报 $$）      : 收集 2 个（壳 + node）→ 打点 6 → 6 已停 ✓ | 残留 0 | 杀掉 2
S2 壳已死之后清扫（token 找不到 → marker）: token 指纹 NOROOT → marker 指纹命中 1 个 → 打点 11 → 11 已停 ✓ | 杀掉 1
S3 并发隔离                              : A 8 → 8 已停 ✓，B 13 → 16 仍在写 ✓（未受影响）| 金丝雀 5 → 5
S4 壳秒退（命令不存在）                   : 两条指纹都 NOROOT → 放弃、不做 kill、残留 0、金丝雀不变 ✓
```

**③ 作业对象正反例（`job-object.cjs`）**

```
正例 inside : set_info=True self_assign=True spawned_bash_pid=53372
              杀之前打点 4 → 终止后 打点 4 → 4  STOPPED（打点已停 ✓）
              事后清扫 0 个残留（作业已经把整棵树收干净了）
反例 assign : assigned=True pid=55068 err=0（分配成功、无报错）
              终止后 打点 8 → 14 → 18  STILL_WRITING（那个 node 没进作业）
              事后清扫 1 个残留（靠方案 3 才收掉）
```

正例里 keeper 自己也在作业中，`TerminateJobObject` 会**连它一起杀掉**，所以它的 `after_ticks` 永远不会打印 —— 裁定必须由驱动侧（Node）做。

**④ 端口释放窗口（`port-release.cjs`）**

```
A 现状（/T → 等 3000ms → /F /T）: 端口释放于 t=4073ms → 锁窗口 4.1s
B 本改动（直接 /F /T）           : 端口释放于 t=925ms  → 锁窗口 0.9s
差值 3.1s —— 就是不带 /F 那段纯空转的代价
```

---

## 安全条款（用这套脚本前必须一起用）

这几条不是"优化建议"，是**实测踩出来的**：上一版朴素枚举两次把 `init(1)`、无关 shell、以及收集器自己收进了待杀列表。

1. **严格解析**：只接受「UID/PID/PPID 均为纯数字 且 第 5 列是 `HH:MM[:SS]`」的行 —— 挡掉多行命令行产生的续行；
2. **指纹只在命令部分匹配**，不匹配整行 —— 否则续行碎片里的偶然子串也算命中；
3. **排除收集器自己这条链**（`tree.sh` / `guard.sh` / `ps` / `awk`）—— 否则 `--match` 的第一个命中就是"正在执行 `tree.sh` 的那个 bash"；
4. **向上验证**：候选进程的祖先链必须能在 32 步内走到根。目标集是"祖先链通到 root"，不是"父节点是成员"的传递闭包 —— 后者实测会把无关 shell 卷进来（MSYS 的 PID 会复用、父链会断）；
5. **保护条款：永不杀调用链的祖先** —— 防止回收动作把调用方自己杀掉。实测发生过一次（枚举把调用方的 shell 带进了列表，guard 没拦住，因为它是"可追溯"的）；
6. **校验不过就整批放弃**，退回 `taskkill` 兜底 —— 宁漏不误杀。

`tree.sh` 决定**杀谁**，`guard.sh` 决定**能不能动手**，两者缺一不可。

---

## 已知边界（这套方法做不到的事）

- **壳已死之后，指纹只能靠 argv**：壳死后它的 PID 从进程表消失（实测 `--pid` 直接 NOROOT），而 token 通常只存在于**壳**的命令行里 —— 所以事后清扫只能退回到"命令自身的 argv 指纹"（本套用 marker 路径）找到**那个 leaf**，找不到就只能放弃。**这正是方案 3 的结构性弱点，也是作业对象那条路更干净的原因。**
- **完全依赖 MSYS 自己的进程记账**：Win32 父链在 `nohup` 处断开，MSYS 侧记账是完整的（所以 `ps -ef` 里 node 的 PPID 是对的）；如果哪天 MSYS 记账也不准，这条路不成立。
- **MSYS 进程组不可用**：外层 bash 的 `PGID=0`、进程基本各自成组，"`kill -- -PGID` 整组回收"实测走不通（那一段探针未收录本套，结论见 issue 讨论）。
- **方案 1（原生小模块做"作业内 spawn"）没有实现**：本套只有作业对象的正反例验证，没有 `CreateJobObject + CREATE_SUSPENDED + Assign + ResumeThread` 的原生实现。
- **作业对象 inside 形态的代价**：helper 必须**拥有 spawn**，而 bash 工具依赖 Node 侧直读 stdio 与退出码 —— 落地时要设计 stdio/退出码的中转，本套脚本用"写临时 .sh 再执行"绕开了 `Start-Process` 的引号问题，但没有解决 stdio 中转。
- **没有 Windows 实机就无从验证**：这些结论全部来自 Windows 实机；macOS/Linux 上跑不了（也不该改 Windows 分支）。
