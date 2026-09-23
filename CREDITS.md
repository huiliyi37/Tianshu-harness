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
- #142 perf(prompt): requestTimeCollapse 单遍索引化，工具结果折叠 O(n²)→O(n)（CLOSED）
- #141 fix(security): 敏感文件门补齐（export_file/import_resource）、白名单收窄与 NODE_OPTIONS 摘除（CLOSED）
- #126 fix(security): 代码审计加固 — SSRF / 路径穿越 / XSS / 权限 / 版本比较（12 findings，11 已修）（CLOSED）
- #108 fix(council): 议事会席位透明化实际命中模型 + v4pro 弃用标记（#105）（CLOSED）
- #107 fix(council): 议事会席位透明化实际命中模型 + v4pro 弃用标记（#105）（CLOSED）
- #104 fix(windows): 隐藏 GUI 派生的控制台子进程窗口（Fixes #103）（CLOSED）
- #97 feat(api): 可配置重试策略 + 可选客户端限速（provider.providers.<name>.retry）（CLOSED）
- #95 fix(api): implement image_strip auto-recovery — 413/图片拒绝后剥离图片重发一次（CLOSED）
- #16 fix(tui): guard truncate() against max<=1 negative slice index（CLOSED）
- #15 docs(readme): renumber sections to fix duplicate '### 3.' heading（CLOSED）
- #13 Feat rivet shell completions（MERGED）
- #12 feat(completions): add fish and Windows-shell completion scripts（CLOSED）

## @liuwanwan1

署名：liuwanwan1 <243261597+liuwanwan1@users.noreply.github.com>

- #30 chore(install): 安装体积优化——npm 安装体积 ~185MB → 84MB（-54%）（CLOSED）
- #28 fix(updater): 修复 /update 在非 JSON 响应下 unhandled rejection 崩溃（CLOSED）
- #27 fix(agent): DeepSeek effort 映射修复 + 双向 effort 调度 + 缓存预热 + ShadowQueue 校验加固（CLOSED）
- #23 Feat/deepseek v4 flash optimization（CLOSED）
- #22 feat(runtime): 新增 lean 资源档，降低内存与磁盘占用（CLOSED）
- #20 降低 DeepSeek API 成本：默认思考档、effort 路由与 flash 压缩（CLOSED）
- #19 降低 DeepSeek API 成本：默认思考档、effort 路由与 flash 压缩（CLOSED）

## @lumos-tiamo

署名：lumos-tiamo <156174712+lumos-tiamo@users.noreply.github.com>

- #59 cache: add a real, all-in billed-hit-rate regression gate（MERGED）

## @maoqiu77

署名：maoqiu77 <198698497+maoqiu77@users.noreply.github.com>

- #51 feat: 修复会话 Auto 路由并新增星域漂移检测（CLOSED）
- #35 修复：加固运行时正确性与边界场景（CLOSED）
- #34 fix(tui): isolate clipboard fallback tests（CLOSED）

## @moyan3691

署名：moyan3691 <326834146+moyan3691@users.noreply.github.com>

- #214 docs: 新增「自带 /mobile 页面」指南与可运行示例（CLOSED）
- #211 docs(remote-access): 补充 /mobile 静态挂载的扩展方式与 prompt 字段契约（CLOSED）

## @nzz0991999-ai

署名：nzz0991999-ai <224787558+nzz0991999-ai@users.noreply.github.com>

- #91 fix(worker): 单测改用具名导入 node:events——修复 typecheck 红灯（CLOSED）

## @qiaodier

署名：qiaodier <8543606+qiaodier@users.noreply.github.com>

- #8 Dev qiao（CLOSED）

## @sky-mirrors

署名：sky-mirrors <118016577+sky-mirrors@users.noreply.github.com>

- #209 perf(prompt): buildOaiRequest 估算/签名链加消息级缓存（#206 建议 1）（CLOSED）

## @wangxx-yu

署名：wangxx-yu <270384808+wangxx-yu@users.noreply.github.com>

- #6 fix: rescue abandoned tool batch after abort to prevent write_file ghost-abort（CLOSED）

## @Wanming08

署名：Wanming08 <152006802+Wanming08@users.noreply.github.com>

- #152 fix(mcp): guard OAuth token requests against SSRF（CLOSED）

## @yeshilei-QWQ

署名：yeshilei-QWQ <89763253+yeshilei-QWQ@users.noreply.github.com>

- #257 feat(bash): 执行期让出——命中注入签名的命令跑到一半用户接管即终止（issue #235）（OPEN）
- #256 fix: Windows 跨平台语义的五处产品缺陷 + 测试平台假设收口（issue #189）（OPEN）
- #255 feat(tui): /debug cvm —— CVM 拦截台账的查询入口（issue #249）（OPEN）
- #254 docs: 修正 Cockpit 入口说明的三处错误（issue #245）（OPEN）
- #253 docs: 统一前缀缓存命中率对外口径为 95–99%（issue #248）（OPEN）
- #230 fix(ci): 让 main 的 CI 转绿——runner 正则行尾归一 + 跨仓 license/integrity 测试缺文件跳过 + ratchet 账本对齐（CLOSED）
- #205 feat(serve): 发现外部进程新增的会话——多进程共用一个 home 时免重启即可见（CLOSED）
- #204 fix(tools): killAllSync 在 win32 上只发一次 taskkill——同步路径无等待窗口，第二发与第一发逐字相同（issue #185）（CLOSED）
- #202 fix(test): workspace-guard 夹具改用 dirname 推导父目录——Windows 上写死 '/' 致 8 条恒 ENOENT（CLOSED）
- #200 fix(agent): import-graph 的两处 Windows 路径缺陷——绝对路径判据与 index 候选（收 #189 的 U 三簇）（CLOSED）
- #199 fix(hooks): Windows 上按扩展名选解释器——.sh 不再被 cmd「打开」并弹「选取应用」（CLOSED）
- #197 fix(plan): 计划文档的返回路径归一为 POSIX，不再泄漏 Windows 原生分隔符（CLOSED）
- #196 test(server): host-policy 的手写 chunked 解码按字节切，不再多吃多字节字符（CLOSED）
- #195 fix(serve): Windows 打开无关联扩展名的文件退化为定位，不再留下永久「选取应用」对话框（CLOSED）
- #194 fix(agent): meridian 快路径的写工具路径未归一——Windows 上 impact hint 静默全灭（CLOSED）
- #191 fix(repo): meridian 索引器在 Windows 上整体空转——路径前缀守卫用了 POSIX 分隔符（同时是 #189 挂死根因）（MERGED）
- #190 fix(tools): 收口 bash 超时/中止与 monitor 订阅失败的三处生命周期缺陷（#184 #186 #187）（MERGED）
- #183 fix(tools): gitignore 匹配器补根锚定与 ** 语义，收窄树外守卫（MERGED）
- #182 fix(model): 模型名匹配接入别名表——失配不再位置性回退到 models[0]（CLOSED）
- #177 test(runner): 非零退出的批点名——修掉「fail 0 却 exit 1」在日志里零线索的盲区（CLOSED）
- #175 test: 去掉两处依赖墙上时钟精确下界的断言（CI 时序抖动）（CLOSED）
- #174 test(agent): #173 的端到端表征测试 + #170–#173 前提验证记录（CLOSED）
- #169 fix(provider): onboarding 时提示 reasoningEffort 无处可去（#153）（CLOSED）
- #168 fix(pnpm): 补 pnpm-workspace.yaml 构建放行白名单 + 声明幽灵依赖 zod-to-json-schema（#57）（CLOSED）
- #166 feat(windows): 作业持有者 job-launch.exe —— 让 shell 出生即在作业里（issue #144 本体）（CLOSED）
- #165 docs(known-issues): 开放 issue × main 代码核对表 —— 22 条已落地、2 条建议直接关闭（MERGED）
- #164 fix(test): 修掉 Windows 上的 D:\\D:\\ 双前缀路径 —— new URL().pathname 改走 fileURLToPath（MERGED）
