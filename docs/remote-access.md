# Remote Access（远程访问指南）

> P1 Mobile Remote（2026-09-05）：让 `rivet serve` 可以从局域网/手机访问。
> 配套调研：`docs/research/mobile-remote-2026-09.md`（本地归档）。

`rivet serve` 默认只监听 `127.0.0.1`（本机回环），Token 门控。要把它暴露给同一局域网内的手机/其他设备，需要显式开放监听地址。**默认行为不变**——不设置任何东西时与旧版完全一致。

## 启用远程监听

两种方式等价，任选其一：

```bash
# CLI 参数
rivet serve --host 0.0.0.0 --port 3100

# 环境变量（桌面端/进程管理器场景：env 由父进程继承，无需改启动参数）
RIVET_SERVE_HOST=0.0.0.0 rivet serve --port 3100
```

- `--host 0.0.0.0` 监听所有网卡接口；也可以给具体局域网 IP（`--host 192.168.1.5`）。
- 桌面端（Tauri app 内置 sidecar）：在**启动桌面的进程环境**里设 `RIVET_SERVE_HOST=0.0.0.0`
  即可生效——sidecar 继承父进程环境变量。macOS 从终端启动：
  `RIVET_SERVE_HOST=0.0.0.0 open -a 天枢`；或 `launchctl setenv RIVET_SERVE_HOST 0.0.0.0`
  后重新启动应用（重启后如需清除：`launchctl unsetenv RIVET_SERVE_HOST`）。

验证是否已对外监听：桌面端 **设置 → Network → Remote Access** 区块会显示模式徽章
（Loopback only / LAN reachable）、局域网访问地址、访问令牌与二维码；或直接请求：

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:3100/remote/info
# → {"mode":"lan","listenHost":"0.0.0.0","lanUrls":[{"name":"en0","address":"192.168.1.5"}, ...]}
```

## Host 白名单（可选收紧）

`RIVET_SERVE_HOSTS_ALLOW`（逗号分隔，不带端口）配置后，非回环 Host 只放行白名单内的值：

```bash
RIVET_SERVE_HOSTS_ALLOW=192.168.1.5,my-host.local rivet serve --host 0.0.0.0
```

语义（三分支，按序判定）：

1. 无 `Host` 头（HTTP/1.0 客户端）与回环形态（`127.0.0.1` / `localhost` / `[::1]`，带或不带端口）恒放行——默认行为；
2. 显式配置了 allowlist：非回环 Host 必须与白名单项精确匹配（比较时忽略端口）；
3. 未配置 allowlist 且监听地址非回环（LAN 模式）：放行任意 Host——此时 **Bearer Token 是唯一凭证**。

## /mobile 手机监控+审批页（P2）

同端口静态挂载的轻量手机端（P2 Mobile Remote Wave 2-4）：`desktop/` vite 第三入口
`mobile.html` → `dist/mobile.html`，serve 以 `--mobile-dir`/`RIVET_MOBILE_DIR` 指向该
dist 目录后，在 `/mobile` 前缀下免 Bearer 服务前端资产（**auth 门前精确前缀**，仅静态
文件；API 面 Bearer 门禁与 Host 校验不受影响——未配置 `mobileDir` 时 `/mobile` 直接 404）。
桌面安装版不需要用户自备该目录：打包期 `desktop/scripts/stage-mobile-web.js` 按 vite
manifest（`build.manifest`）取 mobile.html 入站的资源闭包，落盘到
`desktop/src-tauri/resources/mobile-web/`，随 tauri resources 映射为安装目录的
`mobile-web/`，由桌面壳解析注入（见下节）。

URL 形态（桌面端「设置 → Network → Remote Access」二维码载荷）：

```
http://<lan-ip>:<port>/mobile/?token=<access-token>
```

- 扫码直达：页面读取 URL `?token=` → 同源建连（`location.origin`，零 CORS）→
  `history.replaceState` 立即清掉地址栏 token（防止截图/历史记录泄漏）。无 `?token=`
  时回退 localStorage `rivet:mobile:conn`，都无则显示连接配置页（手输 base+token）。
- 页面能力：会话列表（4s 轮询，pendingApprovals>0 置顶高亮）→ 单会话只读时间线
  （复用 `session-event-hub` 折叠/断线重连语义 + SSE 传输注入）+ 审批三卡
  （授权 approve/reject、plan approve/reject、ask_user_question 文本回复）+ 中止按钮。
  显式不含：发消息/steer、历史「加载更早」冷分页、PWA install/离线。
- 安全注意：QR 遮显——token 未点「显示」时二维码不绘制（占位灰块）。扫码直达后
  URL 已清参，令牌仍在 localStorage；「更换连接」即清除。换 serve 实例后旧会话快照
  在 hub LRU 中留存（≤6 空闲）为 P2 已知限制。
- 桌面壳（Rust spawn env）注入 `RIVET_MOBILE_DIR`（见下节「桌面壳集成状态」）；
  未随桌面启动时用 CLI：

```bash
RIVET_MOBILE_DIR=<desktop/dist> rivet serve --host 0.0.0.0 --port 3100
curl -s http://127.0.0.1:3100/mobile/ | head -1   # → <!doctype html>
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/sessions  # 无 token → 401（API 门禁不变）
```

## 桌面壳集成状态与安全边界（务必阅读）

> 桌面壳（`desktop/src-tauri` Rust spawn env）自动注入 `RIVET_MOBILE_DIR`
> （2026-09-05 D2 已落地）：解析优先级 = 显式 env > dev 布局（current_exe 上溯
> 到 `<repo>/desktop/dist`，tauri dev 时构建产物在磁盘）> 打包后
> `Resources/mobile-web` > `Resources/rivet-runtime`。判据 = 目录含
> `mobile.html`；解析不到时 sidecar 不挂 /mobile（404 安全缺省），设置页
> 「远程访问」区块会显示未启用提示并给出 CLI 指引。
>
> v3.19.0 缺陷（2026-09-13 修复）：原解析只认 `Resources/rivet-runtime`，而该
> 路径映射的是仓库根 CLI 产物（`../../dist`）——mobile 页面的产物在
> `desktop/dist`，只被 `frontendDist` 内嵌进 exe 供 webview 使用，从不落盘。
> 于是发布包恒判定「未提供」，Windows/macOS 安装版扫码一律 404。修复 =
> 打包期 stage 到 `resources/mobile-web` 并随包分发；`rivet-runtime` 保留为
> 候选以兼容历史布局。
>
> **发布前自检（四步）**——⓪ 与 ② 已接进四个发布入口（`build-mac.sh`、
> `sign-and-build.sh`、`run-signed-build.mjs`、`build-signed.ps1`）：
>
> ```bash
> # ⓪ 接线契约（构建前，跨平台）：resources 映射 / staging / lib.rs 解析候选三处一致。
> #    这步专挡原始缺陷形态——映射缺失或指错目录时，产物断言看不出来（Windows 侧
> #    只能断言 staging，而 staging 正是 stage 脚本刚写入的地方，与映射解耦）。
> node desktop/scripts/check-mobile-wiring.js
> # ① 构建（beforeBuildCommand 内已含 stage）
> npx tauri build --bundles app --target aarch64-apple-darwin
> # ② 静态断言：产物里到底有没有 mobile 资源（缺文件即红，不必等用户报障）
> node desktop/scripts/assert-mobile-bundle.js <…>/Tianshu.app
> #    也可传 bundle 产物目录（自动下钻其中的 .app）：
> #    node desktop/scripts/assert-mobile-bundle.js src-tauri/target/release/bundle/macos
> #    Windows 装到真机后对安装目录复跑：node desktop/scripts/assert-mobile-bundle.js "$LOCALAPPDATA\Tianshu"
> # ③ 动态验证：这些文件能否被包内 node + 混淆后的 rivet-runtime 真正服务出来
> node desktop/scripts/verify-mobile-served.js <…>/Tianshu.app
> ```
>
> 验证状态（2026-09-13）：macOS 侧已实测——真实 `Tianshu.app` 内
> `Contents/Resources/mobile-web/` 含 10 个文件，用包内 node-runtime 与混淆后的
> rivet-runtime 起 serve（`RIVET_MOBILE_DIR` 指向包内目录）后 `/mobile/` 与全部
> 7 个引用资源均 200，浏览器打开页面渲染出会话列表。**Windows 安装包仍未实测**
> （本机产不出 Windows 产物）：NSIS 安装器行为（含 `installer-hooks.nsh` 的覆盖
> 安装清理）只在真机可见，发布后应在安装版上跑一遍 ②。
>
> ⓪ 这步是审查补出来的：Windows 链原先只断言 staging 目录，**删掉 resources
> 映射它照样全绿**——原始缺陷形态在 Windows 上仍会溜过。现在映射、staging、
> lib.rs 三处任一处脱钩都会在构建前红。尚存的下游盲区（当前产物未触发，记录备查）：
> 闭包收集未覆盖 CSS `url()` 字体、worker chunk 与 `import.meta.glob` 变量路径三类
> 形态；`desktop/public/wallpapers` 不在 resources 内，若 mobile 将来引用
> `--app-wallpaper` 会 404；serve 的 `MOBILE_MIME` 缺 `.woff/.ttf/.wasm`。

- **LAN 模式默认放行任意 Host** 是有意的取舍：DNS-rebinding 防护（限制 Host 头）在
  「局域网 + Bearer 强制」前提下放宽。**Token 泄露 = 完全控制**——请像密码一样保管，
  不要截图、不要写进公开配置。要恢复 Host 层防护就配置 `RIVET_SERVE_HOSTS_ALLOW`。
- **只监听可信网络**。外网访问请走隧道（Tailscale / SSH -L），不要把 3100 端口直接
  映射到公网；本项目不做云中继、无账号体系，端口暴露的公网服务没有额外防护层。
- CORS 不开放跨源：浏览器侧的跨站读取仍被三个已知本地源白名单挡住
  （`tauri://localhost` / `http://tauri.localhost` / `http://localhost:5273`）。
- Token 生命周期 = serve 进程生命周期；sidecar 重启后令牌轮换，旧令牌立即失效。
