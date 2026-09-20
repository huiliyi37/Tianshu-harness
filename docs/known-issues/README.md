# known-issues/ — 单点问题追踪

本目录收录**单点问题的跟踪档案**：现象、根因、修复方案、状态。一篇一问题（Diátaxis 的 issue 型）。

## 当前未结项（置顶维护）

| 文档 | 一句话 | 状态 |
|------|--------|------|
| [2026-08-05-desktop-scroll-stream-follow.md](2026-08-05-desktop-scroll-stream-follow.md) | 桌面端滚动 S1 修复已落地（`4c952c3a5`）；剩 S2 两候选假设的实机取证 | 代码已修，待 Windows/macOS 实机验收 |
| 2026-08-15-desktop-scroll-timeline-collapse-tug.md | 桌面滚动拉锯：A'/B + 对标三件 + 遗留①均已落地（遗留②症状路径 end-anchor 下已停用）；剩 Windows 真实 WebView2 两档复验 | 代码已修，待 Windows 实机验收 |
| 2026-09-15-windows-git-bash-orphan-descendants.md | Windows+Git Bash 超时后后台孙进程逃过 taskkill /T（issue #144）；PR #159 已消除 3 秒空转（治标），泄漏本体待修 | 🔴 待修复（阻塞于 Windows 实机验证通道） |

> 桌面滚动线（两条）的共同外部依赖：Windows/macOS 实机验收，见
> [2026-08-12-windows-session-stability-refactor.md](2026-08-12-windows-session-stability-refactor.md) 的验收待办——**代码侧无剩余工作，别再按「未修」排期**。

## 近期关闭（2026-08-28 复验关闭潮）

- `volatile-test-hang`：已在 `405fa18b9` + `289c21929` 修复（复验单跑 15/15 绿 <90s）
- `tui-duplicate-render-and-scroll`：Ink 栈已删，已失效
- `2026-07-26-domain-pinning-only-in-tui-main`：钉定已下沉 loop.ts，已修复

## 近期关闭（2026-09-20）

- [2026-09-20-request-body-truncation-hex-escape.md](2026-09-20-request-body-truncation-hex-escape.md)：用户实报 400 `unexpected end of hex escape`——请求体超限被上游按字节截断（4MB 常量声明未接线）。已修：体积护栏 + 全量清洗 + assistant 侧清洗 + 中文指引 + TUI/桌面 UI 提示 + 逼近上限预警；**用户侧原会话未回访确认**，复现手册见该篇「三步定位」。

## 状态口径

每篇开头应有状态行：`🔴 待修复` / `⏳ 待安排` / `🟡 进行中` / `✅ 已修复` / `✅ 已失效`（载体不存在）。
2026-08-28 起新文档建议直接带 frontmatter（`type: issue` + `status`，见 `docs/README.md` 总纲）；
存量篇目多为「状态行」旧式，二者并存合法——但**状态变化时必须更新**（2026-08-28 曾有两篇
「待修复」实际早已修复/失效，误导了后续排期）。

## 写作约定

- 命名 `YYYY-MM-DD-主题.md`（日期前缀排序友好）；零散的机制档案可语义命名
- 现象 → 证据（会话/日志/行号）→ 根因 → 修复方案 → 验证；关闭时写明关闭证据
- 修复落地后把状态改为 ✅ 并在此 README 的未结表移除
