# Credits ledger（署名台账）

本文件由 `scripts/credit-contributors.sh` 追加维护，随 sync 推送到公开仓。

**为什么需要它**：GitHub 仓库的 Contributors 面板只统计「**非空提交 + 提交的 author 字段
是本人账号关联邮箱**」——空提交与 `Co-authored-by` 都不计入（依据 GitHub 文档
*Viewing a project's contributors*：`Merge commits and empty commits aren't counted as
contributions for this graph`；`including commit co-authors` 仅 GHES 版本成立）。

因此对每位还没有出现在 Contributors 名单里的外部贡献者，**按 PR 逐个**在此追加一行，
每行是一笔由该贡献者作为 `author` 的提交（committer 保持仓库维护者）——一笔提交对应
他的一个增量。完整名单与人工描述见 [CONTRIBUTORS.md](CONTRIBUTORS.md)，流程说明见
[EXTERNAL-PRS.md](EXTERNAL-PRS.md)。

格式：`## @login` 小节 + `- #<PR> <标题>（状态）` 行，由脚本自动追加；已有行不要手工改
（要调整措辞就改脚本模板后重跑）。

## @EarthxxRhythm

署名：EarthxxRhythm <68267496+EarthxxRhythm@users.noreply.github.com>

- #234 fix(prompt): 未受信项目的 AGENTS.md / .rivet.md 不再注入（issue #218）（CLOSED）
- #233 fix(agent): 不可信来源的工具结果加「数据非指令」结构定界（issue #217）（CLOSED）
- #232 fix(plugins): permissions 声明如实标注为非强制（issue #216）（CLOSED）
- #231 feat(mcp): MCP 服务器连接级审批门（issue #215）（CLOSED）
- #229 fix(tools): browser 工具加逐请求防护，重定向/iframe/子资源不再绕过 allowlist（issue #213）（CLOSED）
- #228 fix(web-fetch): 渲染路径用进程内 pin 代理钉住 DNS，关闭 rebinding 窗口（issue #212）（CLOSED）
- #227 fix(config): 搜索 API key 迁到 secrets-store，config.json 不再落明文（issue #220）（CLOSED）
- #226 fix(server): project 路由的 cwd 必须在册（issue #221）（CLOSED）
- #225 fix(tui): live 流式区套用终端文本契约（issue #222）（CLOSED）
- #224 fix(config): scratchDir 必须落在数据根内（issue #223）（CLOSED）
- #210 fix(server): reject path traversal in skills/install names[] (#207)（CLOSED）

## @Eason412

署名：Eason412 <250286526+Eason412@users.noreply.github.com>

- #32 sync: 发布 v2.29.0 公开运行时与委派恢复修复（CLOSED）
- #31 feat(tui): 终端内联图片渲染（kitty/iTerm2 协议 + 统一 main commit 队列）（CLOSED）
- #29 fix(tui): 打开推理强度选择器前重置面板类型（CLOSED）

## @HarriethWiKk

署名：HarriethWiKk <67490182+HarriethWiKk@users.noreply.github.com>

- #154 fix(config)!: 模型 alias 体系废弃——一律按原 ID 保存与展示（CLOSED）
- #38 Feature/provider onboarding stack（CLOSED）
- #36 Test/full suite stability（CLOSED）
- #33 Fix/security and test wsl2（MERGED）
- #25 fix(pointer-guard): 拦截 apply-patch 指针交叉 echo 到写入工具（前缀入列 + 渲染补机器 tag）（CLOSED）
- #5 tui: overlay subtle style overhaul — remove emojis, compact layout, thin borders（CLOSED）
- #2 fix: 修复 FallbackStreamClient 中死代码导致的 fallback 失效（CLOSED）
- #1 Wsl兼容问题（CLOSED）

## @jian-in

署名：jian-in <267224531+jian-in@users.noreply.github.com>

- #201 feat(mcp): add health check and circuit breaker for MCP servers（CLOSED）

## @jiangsx496

署名：jiangsx496 <298945509+jiangsx496@users.noreply.github.com>

- #64 Update website credit to remove developer's namedocs: credit original…（MERGED）
- #7 feat(website): rewrite with Vue 3 + Vite, replace Next.js version（CLOSED）
- #3 fix(edit/hash-edit): 写入后 syntaxCheck/diff 异常不再导致工具报错（CLOSED）

## @KinoGao

署名：KinoGao <71637313+KinoGao@users.noreply.github.com>

- #26 feat: 完善 Galaxy 与 Starflow 的 EP-DP 编排（CLOSED）
- #24 feat: improve Galaxy and Starflow EP-DP orchestration（CLOSED）
- #17 feat: starflow 星流五阶段全链路编排 + galaxy 执行流程修复（CLOSED）
- #14 feat: galaxy 星河集群（MoE 多维派发）与执行流程修复（CLOSED）

## @L4XB

署名：L4XB <103962359+L4XB@users.noreply.github.com>

- #109 fix(browser): pin the chromium install to the embedded playwright-core version（CLOSED）

## @lei454577-web

署名：lei454577-web <290313748+lei454577-web@users.noreply.github.com>

- #160 docs: add SolidWorks COM integration notes（MERGED）

## @LinHoMo

署名：LinHoMo <135706031+LinHoMo@users.noreply.github.com>

- #143 chore: 清理悬空 probe:* 脚本、废弃依赖 parquetjs 与一次性脚本残留（CLOSED）
