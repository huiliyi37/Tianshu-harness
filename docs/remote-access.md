# Remote Access（远程访问指南）

> P1 Mobile Remote（2026-09-05）：让 `rivet serve` 可以从局域网/手机访问。
> **LAN Direct（2026-10-08，Issue #402）**：同一 Wi-Fi 下桌面端开关 + 手机扫码即连，
> 免装 Tailscale、免账号、数据不出局域网——**手机连接的第一优先路径**；Tailscale 隧道
> 保留为「不在同一网络」的进阶方案。设计依据
> [`docs/design/2026-10-08-issue402-lan-direct-connect.md`](design/2026-10-08-issue402-lan-direct-connect.md)。
> 配套调研：`docs/research/mobile-remote-2026-09.md`（本地归档）。
> 面向使用者的逐步操作手册见 [手机端操作手册](guides/mobile-guide.md)——含直连扫码、HTTPS 隧道与常见问题。

`rivet serve` 默认只监听 `127.0.0.1`（本机回环），Token 门控；桌面内置 sidecar 默认同样固定为回环。手机连接按网络环境二选一：

1. **同一 Wi-Fi 直连（LAN Direct，推荐）**——设置页开启开关，手机扫码即连。零安装、零账号、数据不出局域网；代价是局域网内明文 HTTP（知情取舍，见下文安全边界）。
2. **HTTPS 隧道（Tailscale Serve 等，进阶）**——手机不在同一网络时用。桌面保持回环，远程访问由带可信证书的 HTTPS 隧道承接。

独立 CLI 仍可显式开放监听地址：非回环监听必须提供 TLS 证书和私钥，**除非**显式 opt-in LAN Direct（下节）。

## 同一 Wi-Fi 直连（LAN Direct）

手机与电脑在同一个 Wi-Fi 时，这是最短路径：**桌面端 ≤1 次点击、手机 ≤1 次扫码**。

桌面端 **设置 → 网络 → 远程访问 → 「同一 Wi-Fi 直连」** 开关默认关闭。开启后：

1. 桌面壳让 sidecar 以 `--host 0.0.0.0` 重启，并向 serve 注入 `RIVET_SERVE_LAN_DIRECT=1`——serve 据此放行局域网明文监听（HTTP），同时收紧 Host 白名单（见下节）；
2. 设置页显示二维码 + 链接（`http://<lanIP>:<port>/mobile/#token=<access-token>`）与安全告知；
3. 手机连同一个 Wi-Fi，扫码 → 自动打开 `/mobile` 并同源建连（读完令牌即从地址栏清掉）。

- **链接形态**：`http://<lanIP>:<port>/mobile/#token=<access-token>`——地址即入口，二维码只是把「地址 + 令牌」编码递给手机。端口为桌面端动态端口，二维码与地址列表始终反映当前实际端口；换 Wi-Fi 后 LAN IP 变化，重新扫码即可。
- **关闭开关**：立即回环；已连手机断开；端口不可达。开关状态在桌面端持久化，但**默认关**，且不会被其他环境的遗留变量自动打开。
- **防火墙提示**：首次监听非回环时，Windows/macOS 可能弹出「是否允许入站连接」的系统询问——**请选择允许**，否则手机到不了本机。天枢不自动改防火墙规则（需要管理员权限）。

### 独立 CLI 的 opt-in

桌面端自动完成上述 opt-in；独立 CLI 需要显式开启，且与既有 TLS 检查正交：

```bash
# 显式 opt-in：非回环明文（HTTP）监听，供同网段手机直连
RIVET_SERVE_LAN_DIRECT=1 rivet serve --host 0.0.0.0 --port 3100
```

- 语义：仅环境变量等于字面 `1` 视为开启（不认 `true`/`yes`）；未 opt-in 的非回环明文监听**仍然**抛 `Non-loopback access requires TLS`（独立 CLI 行为不变）。
- 开启时 serve 启动会 `console.warn` 记录「LAN direct plaintext enabled」——明文放行留下可审计痕迹。
- 该变量若被 shell 继承，桌面壳会**显式移除**它：桌面端的直连只由设置页开关驱动，不会因遗留变量静默进入明文模式。

## 不在同一网络：HTTPS 隧道（进阶）

手机不在同一 Wi-Fi（或用移动网络）时，走 HTTPS 隧道——桌面端保持回环监听，远程访问由 Tailscale Serve 等隧道承接，手机拿到的是可信证书的 HTTPS 地址。四步操作（装 Tailscale → 复制运行 `tailscale serve` 命令 → 回填 HTTPS 地址 → 显示令牌扫码）见 [手机端操作手册](guides/mobile-guide.md) 的「不在同一网络」章节；本节只说明服务端侧的形态。

设置页的直连开关与隧道互不排斥：**已保存 HTTPS 隧道地址时，手机会优先使用隧道地址**，移除它后直连地址生效。

## 启用远程监听（TLS / 独立 CLI）

这是**配置 TLS 的独立 CLI**形态——外网/隧道场景用它；同一 Wi-Fi 直连用上节的 opt-in，不需要证书。两种方式等价，任选其一：

```bash
# CLI 参数
rivet serve --host 0.0.0.0 --port 3100 --tls-cert server.crt --tls-key server.key

# 独立 CLI 的环境变量
RIVET_SERVE_HOST=0.0.0.0 rivet serve --port 3100 --tls-cert server.crt --tls-key server.key
```

- `--host 0.0.0.0` 监听所有网卡接口；也可以给具体局域网 IP（`--host 192.168.1.5`）。
- 桌面端默认覆盖子进程的 `RIVET_SERVE_HOST` 并传入 `--host 127.0.0.1`（回环）；开启「同一 Wi-Fi 直连」开关时改传 `--host 0.0.0.0` 并附带 `RIVET_SERVE_LAN_DIRECT=1`（见上节）。旧版文档中的桌面环境变量启用方式已停止使用。设置 → 远程访问会提供指向当前动态端口的 Tailscale Serve 命令；保存 HTTPS 地址后可显示手机连接二维码。

验证是否已对外监听：桌面端 **设置 → Network → Remote Access** 区块会显示模式徽章
（Loopback only / LAN reachable）、局域网访问地址、访问令牌与二维码；或直接请求：

```bash
curl --cacert server.crt -H "Authorization: Bearer <token>" https://<证书对应的主机名>:3100/remote/info
# → {"mode":"lan","listenHost":"0.0.0.0","lanUrls":[{"name":"en0","address":"192.168.1.5"}, ...]}
```

## Host 白名单（可选收紧）

`RIVET_SERVE_HOSTS_ALLOW`（逗号分隔，不带端口）配置后，非回环 Host 只放行白名单内的值：

```bash
RIVET_SERVE_HOSTS_ALLOW=192.168.1.5,my-host.local rivet serve --host 0.0.0.0 --tls-cert server.crt --tls-key server.key
```

语义（三分支，按序判定）：

1. 无 `Host` 头（HTTP/1.0 客户端）与回环形态（`127.0.0.1` / `localhost` / `[::1]`，带或不带端口）恒放行——默认行为；
2. 显式配置了 allowlist：非回环 Host 必须与白名单项精确匹配（比较时忽略端口）；
3. 未配置 allowlist 且监听地址非回环（LAN 模式）：默认允许本机网卡地址及明确的监听地址，未知 Host 拒绝。
   - **LAN Direct 模式下进一步收紧**：默认 allowlist 会剔除公网地址，只保留 RFC1918 私网 / link-local / 回环 / 本机主机名。机器若处于公网 IP 直连场景，公网 Host 也被拒（双保险）；过滤后若 allowlist 为空，任何非回环 Host 一律 403（fail-closed，不是「空名单放行」）。
   - 显式配置的 `RIVET_SERVE_HOSTS_ALLOW` 优先于上述默认过滤——需要放行非默认地址时显式列出即可。

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
https://<隧道地址>/mobile/#token=<access-token>
```

- 扫码直达：页面读取 URL `#token=` → 同源建连（`location.origin`，零 CORS）→
  `history.replaceState` 立即清掉地址栏 token（防止截图/历史记录泄漏）。无 `#token=`
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
RIVET_MOBILE_DIR=<desktop/dist> rivet serve --host 127.0.0.1 --port 3100
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

- **非回环监听默认要求 TLS，Host 校验与 Bearer 门禁同时生效**。桌面内置 HTTP 默认保持本机回环，远程访问由 HTTPS 隧道承接；显式开启 LAN Direct 时才进入局域网明文监听。令牌仍应像密码一样保管，不要截图或写进公开配置。
- **LAN Direct 的明文取舍（知情选择）**：局域网内是明文 HTTP——**知道 Wi-Fi 口令、又能抓到客户端握手的同网者**（如共用网络的同事/访客）原理上可旁读令牌，这是「零安装 + 数据不出局域网」的代价。缓解：开关默认关、令牌为会话级、用完即关闭；不接受该残余风险就不要开启开关。
- **Host allowlist 在 LAN Direct 下收紧**：默认只放行本机私网地址，公网地址被剔除，未知 Host 一律 403——这是挡 DNS rebinding（恶意网页借浏览器打局域网服务）的既有防线，明文模式下不放松。
- **只监听可信网络，公网方向绝不开放**。外网访问请走隧道（Tailscale / SSH -L），不要把 3100 端口直接
  映射到公网；本项目不做云中继、无账号体系，端口暴露的公网服务没有额外防护层。
- **防火墙**：首次监听非回环时系统可能弹出入站询问，请选择允许；天枢不自动修改防火墙规则。
- CORS 不开放跨源：浏览器侧的跨站读取仍被三个已知本地源白名单挡住
  （`tauri://localhost` / `http://tauri.localhost` / `http://localhost:5273`）。
- Token 生命周期 = serve 进程生命周期；sidecar 重启后令牌轮换，旧令牌立即失效。


## 扩展 `/mobile`：自带页面的配置与运维

`/mobile` 前缀本质是一个**静态挂载点**：`RIVET_MOBILE_DIR` 目录下的任何文件都会按路径原样服务
（`/mobile/<相对路径>`，MIME 按扩展名推导，无扩展名白名单）。因此可以**在不修改任何官方文件**的
前提下，往该目录放一个自包含页面，用来补官方页面显式不含的能力（例如「主动发指令」——
见上文 P2 条目里的「显式不含」清单）。

### 最小示例：自带页面发指令

自带页面与 serve **同源**（都是 `http://<host>:<port>`），零 CORS；带上 Bearer 令牌即可直接调
运行时 API：

| 动作 | 路由 | 请求体 |
|---|---|---|
| 列会话 | `GET /sessions` | — |
| **发指令** | `POST /sessions/:id/prompt` | **`{"prompt": "…"}`** |
| 新建会话 | `POST /sessions` | `{"cwd": "…", "prompt": "…"}` |
| 中止 | `POST /sessions/:id/abort` | `{}` |
| 读事件 | `GET /sessions/:id/events?limit=N` | — |

> ⚠ 字段名是 **`prompt`**，不是 `text`。传 `{"text": "…"}` 会得到
> `400 {"error":"Missing or empty \"prompt\" field"}`。

> 附注：v3.23.1 之前，`mobile.html` 入口的打包产物内部 `sendPrompt` 定义发的是 `{text: …}`
> （移动端「问题回复」链路实际会调到它，会 400）——已在本版本修复为 `{prompt: …}`。

### 运维：升级会整体替换该目录

桌面端升级会**整体替换**安装目录下的 `mobile-web/`（见上文「桌面壳集成状态」的资源 staging），
自带页面会被一并抹掉 —— 表现为 `/mobile/<你的文件>` 变 404，而 `/mobile/` 与官方资产仍是 200。

最小恢复方式：**把主副本放在安装目录之外**（升级不会碰到它），升级后重新复制一次。

Windows 上还可以再加一层自动化兜底：一个**当前用户级**计划任务（登录 + 定时触发），worker 先比
SHA256、内容一致就**不写盘**（幂等），因此反复触发也不会产生多余写入或窗口闪烁。

> 注意：若系统把 **Windows Terminal 设为默认终端宿主**，计划任务直接启动 `powershell.exe`
> ——**即使带 `-WindowStyle Hidden`**——每次都会弹出终端窗口（隐藏只是事后生效，窗口已显示过）。
> 需改为经 GUI 子系统宿主启动，例如 `wscript.exe` + `WScript.Shell.Run(cmd, 0, False)`。
