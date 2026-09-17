# 天枢沙箱与权限模型

天枢的权限设计遵循**默认最小权限 + 按操作动态授权**的原则。它通过两层机制保护你的工作区与系统：

1. **内核级命令沙箱** —— 限制 shell 命令的文件系统写范围
2. **工具级审批与路径校验** —— 控制哪些工具、哪些路径、哪些命令可以执行

本文档说明这两层机制的具体限制、配置方式与故障排查。

---

## 1. 内核级命令沙箱

天枢在运行 shell 命令时，会尝试把它包在一个内核级文件系统沙箱里。沙箱的核心目标是：**命令可以读得很宽，但写只能落在工作区 + 临时目录 + 工具缓存里**。

### 1.1 平台后端

| 平台 | 后端 | 是否需要额外安装 |
|------|------|------------------|
| macOS | `sandbox-exec`（Seatbelt） | 系统自带 |
| Linux | `bubblewrap`（优先）/ `firejail` | 建议安装 `bubblewrap` |
| WSL | 复用 Linux 后端 | 建议在 WSL 内安装 `bubblewrap` |
| 原生 Windows | 无轻量级内核 FS 沙箱 | 无需安装，但保护较弱 |

启动时，如果当前平台没有可用后端，天枢会在 stderr 打印警告，例如：

```
[sandbox] 无可用沙箱后端：当前无写边界。Linux 装 bubblewrap，Windows 走 WSL。
```

### 1.2 默认可写范围

沙箱允许写入以下目录：

- 当前工作目录（`cwd`，即你启动天枢的目录）
- 系统临时目录：`/tmp`、`/private/tmp`、`/var/folders`（macOS）
- 常见工具缓存：
  - `~/.npm`、`~/.cache`、`.pnpm-store`、`.yarn`、`.npm-cache`
  - `~/.cargo`、`go`、`~/.rustup`
  - `~/.bun`、`~/.deno`
  - `~/.gradle`、`~/.m2`
  - `~/Library/Caches`（macOS）
- **按工具链画像自动追加**的目录（见 1.3）
- 用户通过审批流程**显式授予**的目录（见第 2 节）

### 1.3 工具链画像（自动预扩）

纯 npm/cargo 项目用上面的静态列表就够了，但真实的构建打包会碰到各生态自己的状态目录。天枢按项目里的标记文件识别工具链，**在命令执行前**就把对应目录加进可写集，避免构建跑到一半才被拦。

| 工具链 | 标记文件 | 追加的可写目录 |
|--------|---------|---------------|
| rust | `Cargo.toml`、`src-tauri/Cargo.toml` | `~/.cargo`、`~/.rustup` |
| xcode | `src-tauri/tauri.conf.json`、`tauri.conf.json`、`Package.swift` | `~/Library/Developer/Xcode/DerivedData`、`~/Library/Developer/CoreSimulator`、`~/Library/MobileDevice/Provisioning Profiles`（仅 macOS） |
| pnpm | `pnpm-lock.yaml`、`pnpm-workspace.yaml` | `~/Library/pnpm`（macOS）、`~/.local/share/pnpm` |
| cocoapods | `Podfile`、`ios/Podfile` | `~/.cocoapods`（仅 macOS） |
| android | `build.gradle`(`.kts`)、`settings.gradle` | `~/.android`、`~/Library/Android/sdk`（macOS） |
| flutter | `pubspec.yaml` | `~/.pub-cache` |
| ruby | `Gemfile` | `~/.gem`、`~/.bundle` |
| php | `composer.json` | `~/.composer`、`~/.config/composer` |
| python | `pyproject.toml`、`requirements.txt`、`setup.py` | `~/.local/lib`、`~/.local/bin` |

不存在的目录会被自动跳过。标记文件按当前工作目录查找，所以在 monorepo 里从仓库根启动、构建子目录里的 Tauri 工程时可能识别不到 —— 那种情况会退化到 2.2 的授权流程，不会硬失败。

### 1.4 扩展可写目录

如果某些命令必须写到工作区外（例如自定义构建目录、全局依赖位置），可以通过环境变量追加：

```bash
export RIVET_SANDBOX_WRITABLE="/opt/my-build:/var/log/my-project"
rivet
```

多个路径用 `:` 分隔（POSIX），Windows 用 `;`。这是临时的（只影响当前进程）；要持久化请用配置里的 `permissions.additionalWriteDirs`（见 2.3）。

### 1.5 开启与关闭沙箱

沙箱**默认关闭**，显式开启：

```bash
RIVET_SANDBOX=1 rivet
```

全自动（`dangerously-skip-permissions`，别名 YOLO）会**自动开启**沙箱 —— 免审批不等于免边界，详见 2.4。

要在任何模式下都强制关闭：

```bash
RIVET_SANDBOX=0 rivet
```

关闭后无写边界，回滚是唯一安全网。**不建议在陌生仓库或不可信输入下关闭**。

> **历史**：默认值于 2026-07-11 由提交 `9a51debd` 从 opt-out 翻转为 opt-in。旧变量 `RIVET_NO_SANDBOX` 自那时起**已无任何作用**，请改用 `RIVET_SANDBOX=0`。

---

## 2. 路径边界与外出授权

除了内核沙箱，所有文件工具（`read_file`、`write_file`、`edit_file`、`glob`、`grep`、`diff` 等）还会经过 `validatePathSafe` 校验。

### 2.1 默认边界

- **默认只能访问项目目录内**的文件
- 使用 `..`、绝对路径指向项目外的路径会被拒绝
- 对路径进行 `realpathSync` 规范化，防止通过符号链接逃逸

### 2.2 外出授权

当 agent 确实需要访问项目外目录时，会弹审批请求。批准后，天枢会记录一个**目录子树授权**：

- `read` 授权：允许读取该目录及其子目录
- `write` 授权：允许读写该目录及其子目录

授权默认仅在**当前会话**生效。如果勾选“记住此授权”，会按工作区持久化到：

```
~/.rivet/path-grants-<slug>.json
```

这个文件按工作区隔离，**不会泄漏到其它项目**。

### 2.3 配置级常驻授权（Codex 式文件夹权限）

如果你长期需要 agent 访问某些工作区外目录（典型场景：在外层目录打开工作区、代码在子目录/兄弟目录；或希望全盘只读），可以在配置的 `agent.permissions` 里声明常驻授权，会话启动时自动生效、无需审批弹窗：

```jsonc
// ~/.rivet/config.json 或项目 .rivet-config.json
{
  "agent": {
    "permissions": {
      // 只读授权：目录及其整个子树可读（写仍会被拦）
      "additionalReadDirs": ["F:/", "~/reference-repos"],
      // 读写授权：目录及其整个子树可读写
      "additionalWriteDirs": ["F:/智慧项目/hardware-saas"]
    }
  }
}
```

- 路径支持绝对路径和 `~` 前缀；Windows 上正斜杠/反斜杠均可
- 写一个盘符根（`"F:/"`）即授权整个盘
- 配置里不存在的路径会被静默跳过（防止拼写错误意外开放未来出现的目录）
- 授权是会话级内存态，配置文件本身就是持久来源——改配置即改授权
- CLI 与桌面端（sidecar）都会在会话创建时加载

### 2.4 全自动与沙箱 —— 免审批不等于免边界

> **语义变更（2026-07-26）**：此前 `dangerously-skip-permissions` 会自动批准外出路径授权、且不开沙箱。现在**反过来**：全自动（别名 YOLO）自动**开启**沙箱，而扩大写边界是唯一幸存的审批。

审批和沙箱是两条独立的轴：**「谁被问」** 和 **「能写到哪」**。把它们混在一起会得到错误的耦合方向：

- **监督 / 自动下**：审批本身就是边界，沙箱只是双保险 —— 边际收益低，而破坏构建的摩擦成本要全额付。所以沙箱默认关。
- **全自动下**：没人盯着，沙箱是**唯一**的边界。所以全自动必须打开沙箱，而不是关掉。

这与 Codex 的做法一致：`--full-auto` = 不问 + workspace-write 沙箱，真正无边界需要另一个刻意更长的 flag。

**全自动下仍会询问的，只有 `request_path_access`**（以及 `computer_use` 的 js_eval / browser_adopt）。理由：全自动的意思是「别再为普通工具调用打扰我」，不是「在没人看着的时候悄悄溶解唯一的边界」。

摩擦量级是**每个工作区外路径每工作区一次**，不是每条命令一次：

- 1.3 的工具链画像已经预先覆盖常见构建路径
- 2.5 的不兼容命令（brew / docker / codesign）走旁路，不会因为写边界失败
- 授权时勾 `remember: true` 会持久化到该工作区，之后不再问

稳态目标：新项目头两次构建至多 1–2 次提示，之后归零；**工作区内的写全程零提示**。

**无人值守场景**（headless / CI）：没有人能回答提示，所以外出授权会 fail-closed。请预先在配置里声明 `permissions.additionalWriteDirs`（见 2.3），不要指望运行时授权。

**真的想裸奔**：`RIVET_SANDBOX=0` 在任何模式下都优先，包括全自动。此时无写边界、无审批，回滚是唯一安全网。

### 2.5 哪些命令不受沙箱保护

有些命令天生就要越界 —— 给它们的路径全部加白等于对所有其它命令取消边界。天枢的做法是：这类命令**跳过文件系统包裹，但强制走审批**，保留「越界要问人」的语义。

| 规则 | 匹配示例 | 原因 |
|------|---------|------|
| `sudo` | `sudo …` | 提权本身即越界 |
| `brew` | `brew install/uninstall/upgrade/link/tap/reinstall` | 写 `/opt/homebrew` 或 `/usr/local` |
| `docker` | `docker`/`podman` + `build/run/compose/push/pull/buildx` | 需写 docker socket，Seatbelt 的 `deny file-write*` 会挡住 |
| `npm-global` | `npm/pnpm/yarn/bun install … -g`（或 `--global`） | 写 node 全局 prefix |
| `codesign` | `codesign`、`security`、`productsign` | 需访问 keychain 与系统信任库 |
| `notarize` | `xcrun notarytool/altool` | 写 Xcode 私有状态目录 |
| `system-update` | `softwareupdate`、`xcode-select`、`xcodebuild -license` | 系统级配置变更 |
| `version-manager` | `nvm/asdf/rbenv/pyenv/sdk` + `install/use/global` | 写自身 HOME 目录树 |

只读调用不受影响（`docker --version` 不匹配，`npm install` 不带 `-g` 也不匹配）。

---

## 3. 审批模式与规则

天枢的审批配置位于 `~/.rivet/config.json` 或项目 `.rivet-config.json` 的 `agent.approval` 字段。

### 3.1 审批模式

| 模式 | 行为 |
|------|------|
| `auto-safe`（默认） | 低风险/无风险工具自动执行；高风险命令弹审批 |
| `manual` | 任何需要审批的工具都弹窗确认 |
| `suggest` | 只给出建议，不阻塞执行 |
| `auto-accept` | 自动批准常规审批请求 |
| `dangerously-skip-permissions` | 跳过所有交互式审批弹窗 |

切换方式：

```bash
# 临时（当前进程）
rivet --dangerously-skip-permissions

# 持久
rivet config set-approval dangerously-skip-permissions

# 恢复默认
rivet config set-approval auto-safe
```

更多细节见 [`docs/dangerously-skip-permissions.md`](dangerously-skip-permissions.md)。

### 3.2 规则优先级

当一条工具调用到达审批 gate 时，判断顺序如下：

1. **`deny` 规则** —— 永远优先，即使 `dangerously-skip-permissions` 也阻断
2. **`bash.denylist` 前缀** —— 按命令前缀永远禁止
3. **`allow` 规则 / `bash.allowlist` 前缀** —— 命中则跳过审批
4. **审批模式 + 风险评级** —— 决定是否弹窗

### 3.3 规则配置示例

```json
{
  "permissions": {
    "allow": [
      { "tool": "bash", "params": { "command": "git status*" } },
      { "tool": "write_file", "params": { "file_path": "docs/*" } }
    ],
    "deny": [
      { "tool": "bash", "params": { "command": "rm -rf *" } }
    ],
    "bash": {
      "allowlist": ["git status", "npm run"],
      "denylist": ["rm -rf", "sudo"]
    }
  }
}
```

> 配置优先级：运行时 CLI 参数 > 项目 `.rivet-config.json` > 用户 `~/.rivet/config.json` > 内置默认值。

### 3.4 bash 写审批的特殊逻辑

当真实内核沙箱**已激活**时，工作区内的 bash 写操作被视为“沙箱 + 回滚”安全，通常不需要再弹审批。只有当：

- 该命令不受沙箱覆盖 —— 原生 Windows、未装 bwrap 的 Linux/WSL、未设 `RIVET_SANDBOX`，**或该命令走了 2.5 的不兼容旁路**
- 命令不在 allowlist
- 且命令具有写副作用

才会触发 bash 写审批。

注意判定是**逐命令**的，不是逐进程：即使沙箱已开，`brew install` 这类旁路命令仍然按「无沙箱」处理并要求审批。

---

## 4. 风险评级

每个工具调用都会经过风险评级：`none | low | medium | high`。

### 4.1 强制 high 风险（会弹审批）

以下命令模式会被判定为高风险：

- `rm -rf` / `rm -fr`
- `git reset --hard`
- `git clean -f`
- `git push --force` / `--force-with-lease`
- `drop table`
- `pkill -9/-KILL/-f`
- `sudo + rm/chmod/chown/dd/mkfs/mount/umount/systemctl/shutdown/reboot/passwd/useradd...`
- `chmod 777` 等全开权限
- `wget/curl ... | sh/bash`
- `shutdown/reboot/halt/poweroff`
- `npm publish/unpublish`
- doom-loop 保护期间的破坏性 git 操作
- 目标路径是绝对路径或包含 `..` 的项目外路径

### 4.2 medium 风险

- 访问项目外绝对路径
- 某些高权限但无直接破坏性的命令

### 4.3 auto-safe 下的自动通过条件

在 `auto-safe` 模式下，如果同时满足：

- sensorium 置信度足够高
- 风险等级为 `none` 或 `low`
- 不是 bash 写操作（或已被 allowlist/沙箱覆盖）

则可以自动批准，无需弹窗。

---

## 5. 其它硬性限制

| 限制 | 说明 |
|------|------|
| `maxTurns` | 默认 50 回合，防止无限循环 |
| SSRF 保护 | 逐跳 DNS + 私有 IP 拦截，作用于每次重定向 |
| 敏感文件拒绝 | `.env`、`credentials.*`、`*key*`、`*token*` 禁止读取/提交 |
| 符号链接环保护 | `realpath` + 访问集，防止循环软链接 |
| 文件级撤销 | 每次写/编辑前创建版本化备份 |
| Git 检查点 | 每回合首次修改前自动创建检查点，可回滚 |
| Worker 隔离 | 子 agent 在独立工作目录/上下文中运行，有工具白名单和超时 |
| 可靠性模式 | 当检测到反复失败/死循环时，会降级为更保守的执行策略 |

---

## 6. 常见场景与配置建议

### 6.1 我信任这个仓库，想减少弹窗

```bash
rivet config set-approval auto-accept
```

这仍会执行 deny 规则、路径校验、风险阻断，只是不弹确认窗。

### 6.2 我需要 agent 写项目外的某个目录

第一次访问该目录时，天枢会弹审批请求，选择“允许并记住”即可。也可以在启动前预授权：

```bash
export RIVET_SANDBOX_WRITABLE="/path/to/dir"
rivet
```

### 6.3 我在原生 Windows 上，想获得真正沙箱

原生 Windows 没有内核 FS 沙箱。建议：

- 在 WSL 中运行天枢（自动复用 Linux bwrap 边界）
- 或接受“回滚兜底”模式，并对高风险操作保持 `manual` 审批

### 6.4 某个命令总被误拦截

检查是否命中了 `DANGEROUS_BASH_PATTERNS`。如果命令确实安全且常用，可以加入 `bash.allowlist`：

```bash
rivet config set bash.allowlist "your-safe-prefix"
```

> 注意：`deny` 规则和 `bash.denylist` 优先级高于 allowlist，无法通过 allowlist 绕过。

---

## 7. 故障排查

### 沙箱看起来没生效

1. 确认已设 `RIVET_SANDBOX=1` —— 沙箱默认关闭，且 `RIVET_NO_SANDBOX` 已退役无效
2. 检查启动日志是否有 `[sandbox]` 警告
3. Linux/WSL 用户检查是否安装了 `bubblewrap`：
   ```bash
   which bwrap
   ```
4. macOS 用户检查 `sandbox-exec` 是否存在：
   ```bash
   which sandbox-exec
   ```

### 构建/打包在沙箱下跑不起来

沙箱拒绝写入时，工具结果里会出现明确的归因，而不是一句裸的 `Operation not permitted`：

```
沙箱写边界拦截（backend=seatbelt）：命令试图写入工作区之外的路径。
被拒路径：
  - /Users/you/Library/Developer/Xcode/DerivedData
继续的唯一正确做法：调用 request_path_access({ path: "...", mode: "write", remember: true })
取得用户授权，批准后原命令直接重跑即可（授权对下一条 bash 立即生效）。
这不是文件权限位问题，也不是代码缺陷 —— 不要用 sudo、chmod、chown 重试…
```

处理顺序：

1. **让 agent 走授权**：它会自己调 `request_path_access`，你批准即可。勾「记住」则该工作区之后不再问。
2. **反复出现同一路径** → 写进配置 `permissions.additionalWriteDirs`（2.3），一劳永逸且能用于无人值守。
3. **不确定要授权哪些路径** → 用 learn 模式摸底（见下）。

授权对**下一条** bash 命令立即生效，不需要重启会话。

### 用 learn 模式摸清一个项目要写哪些路径

```bash
RIVET_SANDBOX=learn rivet
```

learn 模式下，写边界拒绝**不会让命令失败**：天枢记录被拒路径 → 临时授权 → 自动重跑一次，并把观测追加到 `~/.rivet/sandbox-learn.jsonl`。跑完一次完整构建后：

```bash
jq -r '.deniedPaths[]' ~/.rivet/sandbox-learn.jsonl | sort -u
```

把结果写进 `permissions.additionalWriteDirs`，然后切回 `RIVET_SANDBOX=1`。

> ⚠️ **learn 不是生产模式**。命令在被拒之前已产生的副作用（已写的文件、已发出的网络请求）会在重跑时**再来一遍**。虽然限定了最多重试一次、且结果里会显式声明，但涉及非幂等操作（数据库迁移、发布、POST 请求）时不要用。临时授权仅存在于当前会话，不写盘。

### 命令报 “Path outside project directory”

- 如果确实需要访问该路径，在弹窗中选择“允许并记住”
- 或使用 `RIVET_SANDBOX_WRITABLE` 预授权

### 弹窗太多

- 对信任仓库使用 `auto-accept` 模式
- 将常用安全命令加入 `bash.allowlist`
- 确保内核沙箱已激活（macOS/Linux/WSL），这样工作区内 bash 写操作不会反复弹窗

---

## 8. 总结

天枢的沙箱与权限模型可以概括为：

> **默认最小权限，显式动态授权，deny 规则永远优先。**

- 写文件：默认只能写项目目录
- 执行命令：开启沙箱后受内核约束写范围；被拒时给出被拒路径与授权路线，而非裸报错
- 危险命令：无论模式如何，deny 规则和硬编码风险模式都会拦截
- 外出访问：必须经用户授权或显式配置 —— **全自动也不例外**
- 网络：通常放行（build/test/git 需要）

审批和沙箱是两条轴：**「谁被问」和「能写到哪」**。提高审批自动化程度（自动 `auto-safe` → 隐档 `auto-accept` → 全自动 `dangerously-skip-permissions`）不等于放弃写边界 —— 恰恰相反，越自动越需要边界，所以全自动会自动开启沙箱。要减少摩擦，正确的顺序是补 `permissions.additionalWriteDirs` 和 `bash.allowlist`，而不是关沙箱。
