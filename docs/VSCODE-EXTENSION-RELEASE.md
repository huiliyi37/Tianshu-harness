# VS Code / Cursor 插件 — 打包·发布·部署手册

> 操作资产记录（对齐 `DESKTOP-RELEASE.md` 的定位）。功能迭代史见
> [`docs/changelog/2026-07-23-vscode-extension-p0-p4-iteration.md`](changelog/2026-07-23-vscode-extension-p0-p4-iteration.md)。
> 最后更新：2026-07-23（v0.3.0，未上架）。

## 1. 架构与目录

```
VS Code / Cursor
 ├── extension host（dist/extension.js，node/cjs）
 │    ├── sidecar/launcher.ts      spawn `rivet serve --port 0` + token + 健康检查
 │    ├── sidecar/client.ts        REST + SSE（lastSeq 断线重连）
 │    ├── sidecar/runtime-downloader.ts  自包含运行时自举（E2 ②级）
 │    ├── views/cockpit-provider.ts webview ↔ 宿主 postMessage 桥（token 不进 webview）
 │    ├── views/changes-view.ts    变更审查树 + 原生双栏 diff
 │    ├── views/status-bar.ts      状态栏
 │    ├── delegation/              E4 客户端工具委托（apply_edit / terminal_exec）
 │    └── scm/commit-message.ts    rivet -p 无头生成提交语
 └── webview 座舱（dist/webview.js，browser/iife，React）
      webview-ui/src/{App.tsx, model.ts(reducer), bridge.ts, markdown.ts, styles.ts}
```

- 插件内**零 agent 逻辑**，一切智能在 sidecar（`src/server/` 同一内核）
- 双 bundle 由 `vscode-extension/esbuild.mjs` 出：extension 不压（便于排查栈），
  webview 压（markdown 三件套体积大，minify 后 ~398KB）

## 2. 版本对齐规则（发版第一坑）

三个版本各司其职，**不要混**：

| 版本 | 事实源 | 用途 |
|------|--------|------|
| 扩展版本（0.x.y） | `vscode-extension/package.json` | vsix / 市场版本号 |
| 内核版本（3.x.y） | 根仓 `package.json` | runtime 产物名 + Release tag |
| `RUNTIME_VERSION` 常量 | esbuild 构建时注入**根仓** version | runtime-downloader 拼下载 URL |

`esbuild.mjs` 读 `../package.json` 注入（公开仓构建同样成立，读不到 fail-fast）。
曾因注入扩展自身版本导致首启自举 404（P4/W0 修复，勿回退）。

## 3. 本地构建与打包

```bash
cd vscode-extension
npm ci
npm run typecheck        # tsc --noEmit
npm test                 # node --test tests/*.test.ts（reducer 等纯逻辑）
npm run build            # esbuild 双 bundle → dist/
npm run package          # vsce package --no-dependencies → tianshu-vscode-<ver>.vsix
```

冒烟（真实 sidecar 契约，零模型调用成本）：

```bash
node --import tsx tests/smoke.e2e.mts            # 默认用根仓 dist/main.js（先在根仓 npm run build）
node --import tsx tests/smoke.e2e.mts /abs/path  # cliPath 必须绝对路径（spawn cwd 是临时目录）
```

⚠ 开发机个人 `~/.rivet` 配置里同一 model id 挂多个 provider 时，冒烟的
「exactly one current model」断言会环境性失败。隔离跑法：

```bash
RIVET_HOME=$(mktemp -d)/rivet node --import tsx tests/smoke.e2e.mts
# 需在该 home 放最小 config.json（model 必须含 contextWindow/maxTokens，
# 否则 schema 校验拒启）；首启种子化较慢，健康窗口 20s 偶发超时，重跑即可
```

## 4. 自包含运行时（无 CLI 机器的自举）

- 出包：`bash scripts/build-runtime-bundle.sh [--skip-build]` →
  `out/tianshu-runtime-<内核ver>-<platform>-<arch>.tar.gz` + `.sha256`
- 布局：`bin/rivet[.cmd]`（shim）+ `node/`（独立 Node，复用
  `desktop/scripts/fetch-node-runtime.js`）+ `dist/`（内核 bundle 含
  native/node_modules）+ `version.txt`
- **只为宿主平台出包**——四平台靠 CI matrix（macos-14/13、ubuntu、windows）
  或对应机器手动跑
- 发布位：GitHub Release，tag **`runtime-v<内核ver>`**（资产必须挂在这个
  tag 上，downloader URL 按它拼）
- 下载端点（`runtime-downloader.ts` 顺序尝试）：
  1. `https://update.plotstudio.cn/tianshu/releases/download`（CF Worker 镜像，
     白名单见 `scripts/cloudflare-update-worker/src/worker.js`）
  2. `https://github.com/huiliyi37/Tianshu-harness/releases/download`
- 插件侧三级 CLI 探测：settings `tianshu.cliPath` → PATH 上的 `rivet` →
  globalStorage 缓存的运行时（缺则带进度下载 + sha256 校验 + 解压）

## 5. 发布链路

### 5.1 代码进公开仓（前置）

```bash
bash scripts/sync-to-public.sh   # rsync 工作树 → ~/app/Tianshu
cd ~/app/Tianshu
git add vscode-extension .github/workflows/vscode-extension.yml  # 按需选择性 add
git add -f .github/workflows/vscode-extension.yml  # ⚠ 公开仓 .gitignore 挡 workflow，必须 -f
git commit && git push
```

三个坑：

1. **workflow 被 .gitignore 挡**：`vscode-extension.yml` 不 force-add 就永远
   进不了公开仓（CI 长期没挂上的根因）
2. **sync 是工作树 rsync**：多会话共享工作区时会把其他会话未提交的改动一并
   带过去——公开仓提交前逐文件确认，**不要盲目 `git add -A`**
3. **推送时机跟 dev main 走**：只 sync 已合入 dev main 的内容；分支上的改动
   等合并后再 sync（2026-07-23 曾提前推送 P4，已 revert）

### 5.2 CI 发布（`.github/workflows/vscode-extension.yml`）

| job | 触发 | 做什么 |
|-----|------|--------|
| build | push/PR（paths: vscode-extension/**）+ release | typecheck + test + package，vsix 存 artifact |
| smoke | 同上 | 根仓构建内核 → `tests/smoke.e2e.mts` 真 sidecar 契约 |
| runtime-bundle | release published | 四平台 matrix 出 runtime 包，`gh release upload` 挂 Release |
| publish-vsce | release published | VS Marketplace（需 secret `VSCE_PAT`，未配） |
| publish-ovsx | release published | Open VSX（secret `OVSX_PAT` 已配） |

标准发版流：dev main 合并 → sync + push → 公开仓建 Release
（tag `runtime-v<内核ver>`）→ CI 自动完成 runtime 资产 + 双市场发布。

### 5.3 全本地发布（CI 不可用时的备路）

GitHub billing 锁只停 Actions，Release/API 仍可用：

```bash
# 1. vsix（本机）
cd vscode-extension && npm run package

# 2. runtime 包（每个平台各在对应机器跑一次）
bash scripts/build-runtime-bundle.sh
gh release upload runtime-v<内核ver> out/tianshu-runtime-*.tar.gz{,.sha256} --clobber
# Release 不存在则先: gh release create runtime-v<内核ver> --title runtime-v<内核ver>

# 3. Open VSX（namespace: tianshu，token 在 open-vsx.org 用户设置生成）
npx ovsx publish tianshu-vscode-<ver>.vsix -p <OVSX_PAT>

# 4. VS Marketplace（下一轮，需 Azure DevOps PAT）
npx @vscode/vsce publish --packagePath tianshu-vscode-<ver>.vsix
```

### 5.4 凭据清单

| 凭据 | 放哪 | 状态（2026-07-23） |
|------|------|--------------------|
| `OVSX_PAT` | 公开仓 Actions secret | ✅ 已配（open-vsx.org，namespace `tianshu` 已建） |
| `VSCE_PAT` | 公开仓 Actions secret | ❌ 未配（Marketplace 发布下一轮） |
| `GITHUB_TOKEN` | Actions 内置 | Release 资产上传用 |

## 6. 首启验收清单（发版前必过）

1. 干净机器（无 rivet CLI、无 `~/.rivet`）装 vsix
2. 打开工作区 → 座舱自动自举下载运行时（进度通知 → sha256 校验 → 解压）
3. 无 key → Setup 引导卡出现 → 选 provider + 填 key → 保存放行
4. 发首条消息成功；杀 sidecar 进程验证退避自动重拉（1s/3s/9s ×3）
5. plan mode 会话验证 Plan 审批卡批准/驳回闭环

## 7. 当前状态快照（2026-07-23）

- v0.3.0 vsix 已打包未发布；P4 代码在 dev `pro/p1-mission-identity`（`535521f0`）
- **阻塞**：GitHub 账户 billing 锁 → Actions 全停；解锁无望时走 §5.3 本地路径
- `runtime-v2.20.1` Release 仅 darwin-arm64 资产（GitHub 直连已验证 200；
  CF 镜像端点当时不通，downloader 会自动落到 GitHub）
- 公开仓 main 处于 P3 状态（P4 提前推送已 revert，`2780f8a`）
