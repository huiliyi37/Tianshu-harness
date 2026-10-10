# Credits ledger（署名台账）

本文件是**公开仓那份台账**的初始骨架：dev 仓这份不再随 sync 覆盖公开仓——覆盖会把公开仓
累积的台账打回骨架、触发 credit 台账提交全量重放（见 `scripts/sync-to-public.sh` 里
CREDITS.md 附近的注释）。台账正文由 `scripts/credit-contributors.sh` 在公开仓逐 PR 追加。

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

## @KinoGao

署名：KinoGao <71637313+KinoGao@users.noreply.github.com>

- #26 feat: 完善 Galaxy 与 Starflow 的 EP-DP 编排（CLOSED）
- #24 feat: improve Galaxy and Starflow EP-DP orchestration（CLOSED）
- #17 feat: starflow 星流五阶段全链路编排 + galaxy 执行流程修复（CLOSED）
- #14 feat: galaxy 星河集群（MoE 多维派发）与执行流程修复（CLOSED）

## @L4XB

署名：L4XB <103962359+L4XB@users.noreply.github.com>

- #109 fix(browser): pin the chromium install to the embedded playwright-core version（CLOSED）

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
- #283 fix(config): 删掉示例配置与四语 README 里 schema 不认的 cache 旋钮 + 键存在性守卫（issue #282）（CLOSED）
- #281 fix(platform): 加密连接扫描探测的厂商清单不再被展示上限吞掉（issue #280）（CLOSED）

## @Wanming08

署名：Wanming08 <Wanming08@users.noreply.github.com>

- #152 fix(mcp): guard OAuth token requests against SSRF（CLOSED）

## @jian-in

署名：jian-in <267224531+jian-in@users.noreply.github.com>

- #201 feat(mcp): add health check and circuit breaker for MCP servers（CLOSED）

## @jiangsx496

署名：jiangsx496 <298945509+jiangsx496@users.noreply.github.com>

- #64 Update website credit to remove developer's namedocs: credit original…（MERGED）
- #7 feat(website): rewrite with Vue 3 + Vite, replace Next.js version（CLOSED）
- #3 fix(edit/hash-edit): 写入后 syntaxCheck/diff 异常不再导致工具报错（CLOSED）

## @lei454577-web

署名：lei454577-web <290313748+lei454577-web@users.noreply.github.com>

- #160 docs: add SolidWorks COM integration notes（MERGED）

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

## @yeshilei-QWQ

署名：yeshilei-QWQ <89763253+yeshilei-QWQ@users.noreply.github.com>

- #261 feat(schedule): 定时任务可显式声明审批档位（issue #259）（OPEN）
- #257 feat(bash): 执行期让出——命中注入签名的命令跑到一半用户接管即终止（issue #235）（CLOSED）
- #256 fix: Windows 跨平台语义的五处产品缺陷 + 测试平台假设收口（issue #189）（CLOSED）
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
- #163 docs(known-issues): 补一套 #144 的复现与验证夹具（Windows 实机跑通，含安全条款与边界）（MERGED）
- #159 fix(windows): taskkill 一律带 /F —— 去掉超时/中止路径上 3 秒的纯空转窗口（CLOSED）
- #151 fix(windows): 别名调用绕过 windowsHide 守卫——每次刷新 git 上下文闪控制台窗口（#103 残留）（CLOSED）
- #69 docs(issue-template): Surface 判据引导，减少 TUI/桌面端误标 (#58)（CLOSED）
- #67 fix(server): disk-evidence self-heal for apply_edit delegation stalls (#61)（CLOSED）
- #53 chore: .gitignore 加 .env/.env.*/!.env.example 防护（安全：API key 永不进 git）（MERGED）
- #52 feat: add Windows one-click installer for Tianshu desktop（CLOSED）
- #270 fix(scripts): 安装/构建链的 spawn 补 windowsHide——消除无控制台宿主下的闪窗（OPEN）
- #267 fix(scripts): 注入点申报表在 CRLF 检出下误报——windows-smoke job 长期红的根因（OPEN）

## @yq04

署名：yq04 <143403280+yq04@users.noreply.github.com>

- #66 fix(api): stop sustained DeepSeek reasoning short-line loops（CLOSED）
- #65 docs: 新增《为已有服务商添加模型》指南（以接入 DeepSeek 内测模型为例）（MERGED）
- #50 fix(tui): 排队消息在本轮结束后自动发出，并将 ⏳ 条钉在输入框上（CLOSED）
- #49 fix(tui): 输入框钉住，不随 slash 等 chrome 开合上跳（CLOSED）
- #46 fix(tui): 命令面板视窗跟随选中项；首屏 ctrl+p 与斜杠命令同色（CLOSED）
- #45 feat(tui): slash 提示分层——空 query 只展示核心命令层，继续输入即过滤全量（CLOSED）
- #43 fix(tui): 跨 run 陈旧 todo 清单不再复活显示——「◇ 任务 (5/5) 不更新」的根因与修复（CLOSED）
- #42 fix(tui): Ctrl+C 退出确认窗口支持 Esc/编辑取消，修复幽灵输入与带输入退出（CLOSED）
- #41 fix(tui): 命令面板换绑 Ctrl+P（Ctrl+Esc 在 Windows 被开始菜单抢占且三条送达路径全断）（CLOSED）
- #40 fix(tui): AI 输出中排队消息不再自动注入，输入框贴底（排队语义 + 渲染顺序）（CLOSED）
- #37 fix: 全局安装 postinstall 失败（patch-package）+ 默认星域/模型重启后状态栏不恢复（CLOSED）
- #4 fix: replace interrupt panic with auto-recovered confirmation on write success（CLOSED）

## @zhengbiaofeng

署名：zhengbiaofeng <37176299+zhengbiaofeng@users.noreply.github.com>

- #18 feat: harden MCP, benchmark, memory, and runtime hooks（MERGED）
- #11 fix: improve git detection on Windows for non-standard install paths（MERGED）

## @zzuu080603

署名：zzuu080603 <225036550+zzuu080603@users.noreply.github.com>

- #181 fix(agent,tui,server): 审批门与终端渲染升到语义层——命令归一化双视图判定、text 契约汇聚点兜底、标题落盘剥转义（CLOSED）
- #180 fix(server): 路由参数解码后加文件名包含性守卫——skill/plans/groupId/workerId 四处同族路径穿越封堵（CLOSED）
- #158 fix(tools): apply_patch 接入协作式取消——abort/超时级联 SIGTERM 到 git 子进程（CLOSED）
- #157 fix(serve): ManagedAgent.shutdown 补关 config 热载 watcher——sidecar 释放链补齐（CLOSED）
- #156 fix(serve): 会话释放链统一收割五张会话键控 module store（cron 放大的内存泄漏）（CLOSED）
- #155 perf(session): 会话列表缓存改为增量 upsert——append 路径不再打掉缓存（每 LLM 轮 38×）（CLOSED）
- #134 fix(agent): hash_edit/ast_edit/apply_patch 的编辑接入撤销/回溯/LSP 三处名单——写工具记账以 WRITE_TOOL_NAMES 为单一事实源（CLOSED）
- #133 fix(agent): checkpoint 创建失败不再静默置位——回滚窗丢失对模型与用户可见（CLOSED）
- #132 fix(agent): /cd 换工作区后按新 cwd 重建 FileHistory/claimStore——撤销不再静默失效、往返 /cd 不再砖化（CLOSED）
- #131 fix(agent): 回滚成功后 journal 写失败不再把已成功的恢复误报为失败（CLOSED）
- #130 fix(agent): nullDb 降级桩 run() 报 changes:1——better-sqlite3 缺失时首次独占 claim 不再恒失败（CLOSED）
- #129 fix(agent): durable claims 跨会话继承恒返回空——<id>.claims 附属文件被 listSessions 剥成伪会话且字典序恒大于真 id（CLOSED）
- #128 fix(config): saveConfig 剥掉 profile 临时层——无关设置保存不再把 profile 覆盖值烘焙进全局 config.json（CLOSED）
- #127 fix(config): config-watcher 改 watch 父目录修复首次原子写后永久失聪 + 丢弃 AgentLoop 时关闭僵尸 watcher（CLOSED）
- #112 fix(tools): apply_patch 失败分支回滚 --3way 半套用并清索引毒化——失败不再留下冲突标记/暂存残留/UU 死锁（CLOSED）
- #111 fix(agent): R2 写前独占守卫扩到全部写工具——hash_edit/ast_edit/apply_patch/plan_close 不再绕过跨会话冲突拦截（CLOSED）
- #110 fix(server): sidecar 启动收割崩溃会话的 claims——硬杀后的幽灵独占锁不再永久阻断写入（CLOSED）
- #93 fix(ci): 修复 ubuntu Test 层 30+ 存量红——napi 缺装/注册表失同步/过期测试/清理竞态（CLOSED）
- #90 fix(tui): 剪贴板 TIFF→PNG 转换守卫看注入的 platform——修复 ubuntu CI 持续假红（CLOSED）
- #89 fix(ci): worker-process 测试的 node:events 改静态命名导入——解除 typecheck 全红（CLOSED）
- #88 fix(agent): undo/rewind 不再把「备份读取失败」当成「文件当时不存在」——撤销反向删除既有文件（CLOSED）
- #87 fix(lsp): LSP 服务器崩死后恢复——有界重启 + 重开文档（CLOSED）
- #86 fix(agent): prune 不再删除读不了的 checkpoint——瞬态错误不可逆毁掉回滚点（CLOSED）
- #85 feat(server): 定时任务记住创建时的工作区——多项目 sidecar 下任务不再跑错目录（CLOSED）
- #84 fix(tools): 路径授权表按工作区分域——sidecar 多会话下 A 的批准不再泄漏给 B（CLOSED）
- #83 fix(agent): 运行时 hook 超时后的迟到收尾兜底——孤儿 rejection 不再击穿进程（CLOSED）
- #82 fix(agent): CVM 注入预算裁剪先于送达记账——修复假送达腐蚀习惯化/效能反馈环（CLOSED）
- #81 fix(agent): 会话转录写入失败丢批、flush 竞态击穿落盘屏障（CLOSED）
- #79 fix(worker): Unix 上 OOP worker 以 detached 拉起——让 killProcessTree 组杀真正生效（MERGED）
- #78 fix(worker): OOP worker 结算后摘除 abort 监听——不再把运行闭包钉死在会话信号上（MERGED）

## @elysia395

署名：elysia395 <182482545+elysia395@users.noreply.github.com>

- #271 docs: 补充 dsh-wallpaper-engine 上游署名与 MIT 声明（agent 自定义壁纸功能）（CLOSED）

## @YV3507

署名：YV3507 <184193300+YV3507@users.noreply.github.com>

- #271 dsh-wallpaper-engine 壁纸引擎渲染技术顾问——为「自定义壁纸与分区玻璃」的合成与材质设计提供指导（上游核心开发）

## @yuxilao

署名：yuxilao <50688264+yuxilao@users.noreply.github.com>

- #271 dsh-wallpaper-engine 壁纸引擎渲染技术顾问——为「自定义壁纸与分区玻璃」的合成与材质设计提供指导（上游核心开发）

## @oneincase

署名：oneincase <57388318+oneincase@users.noreply.github.com>

- #271 dsh-wallpaper-engine 壁纸引擎渲染技术顾问——为「自定义壁纸与分区玻璃」的合成与材质设计提供指导（上游核心开发）
## @googio

署名：googio <59339358+googio@users.noreply.github.com>

- #277 feat(search): add Serply web search backend（OPEN）

## @JakcyLin

署名：JakcyLin <11270821+JakcyLin@users.noreply.github.com>

- #273 docs: 新增 Windows 卡巴斯基拦截桌面端 sidecar（PDM:Trojan.Win32.Generic）根因分析与规避方案（CLOSED）

## @lanlan0811

署名：lanlan0811 <258210638+lanlan0811@users.noreply.github.com>

- #297 docs: 新增 tianshu-mcp 操作手册（CLOSED）
- #283 fix(config): 删掉示例配置与四语 README 里 schema 不认的 cache 旋钮 + 键存在性守卫（issue #282）（CLOSED）
- #281 fix(platform): 加密连接扫描探测的厂商清单不再被展示上限吞掉（issue #280）（CLOSED）
- #279 fix(release): package.json 对齐已发布的 3.26.0 + 版本源一致性守卫（OPEN）
- #298 fix(agent): CJK 近重复收敛修复 + 沿接缝拆出重复度度量族（解开 #287 修复撞 max-lines ratchet 的死锁）（OPEN）
- #276 test(server): 钉住 adopt 会话首次打开回放完整历史（issue #274）（OPEN）
- #270 fix(scripts): 安装/构建链的 spawn 补 windowsHide——消除无控制台宿主下的闪窗（CLOSED）
- #268 docs(readme): 补 CVM 拦截台账查看路径——入门路径第 4 步闭环（issue #250）（OPEN）
- #267 fix(scripts): 注入点申报表在 CRLF 检出下误报——windows-smoke job 长期红的根因（CLOSED）
- #299 feat(cache): billedHitRate 接进 /cache 面板——侧路劣化时账单口径可见（CLOSED）
- #295 fix(server): 调度表写操作加锁主校验——非锁主进程建/删任务整表覆写 scheduled_tasks.json（issue #290）（OPEN）
- #294 fix(tools): web-search 相关性 CJK bigram 词元补小写归一——「K线 均线」整批误判跑题（issue #289）（OPEN）
- #293 fix(platform): 加密连接扫描改 X509 解析后匹配 subject——厂商正则扫整段 PEM 生产恒 0 命中（issue #288）（OPEN）
- #292 fix(agent): 收敛检测对中文近重复输出改 n-gram 相似度——CJK 无空格整段一词致 Jaccard=0、双熔断同盲（issue #287）（OPEN）
- #306 fix: Windows 兼容族修复 + 公开仓 CI 恒红收口——8 组缺陷（含复现证据与回归）（CLOSED）

## @KhalilYamber

署名：KhalilYamber <220773268+KhalilYamber@users.noreply.github.com>

- #301 feat(plugin): 新增 tianshu-imbridge —— 手机 QQ 与天枢双向直连（CLOSED）
- #307 fix: Windows 平台测试失败面收口——EPERM 清理竞态/平台路径断言/时序竞态/迁移备份静默失效（第二批，承接 #306）（CLOSED）
- #305 fix(tui): 终端文本契约补裸 CR 与 C1 剥除——再入丢行/行缓冲上界/writeBatch 旁路一并收口（CLOSED）
- #304 fix(cli+auth): 二次 Ctrl+C 强退保险丝 / OAuth 拒存 undefined 凭据 / 过期刷新并发去重（CLOSED）
- #320 fix(tools): 浏览器就绪探测与启动回退系统 Chromium (#302)（CLOSED）

## @Eternal-dream-MAX

署名：Eternal-dream-MAX <130294909+Eternal-dream-MAX@users.noreply.github.com>

- #333 完善 CLI 前端三平台兼容，汇总完整升级与回归（MERGED）
- #330 feat(tui): 升级 CLI 交互、布局与配置流程（MERGED）

## @Lin-Dongg

署名：Lin-Dongg <322679856+Lin-Dongg@users.noreply.github.com>

- #323 fix(api): 补 MiMo v2.6 两条模型元数据——拉取列表后视觉不勾、上下文落默认值（CLOSED）
- #322 fix(api): 视觉判定不再采信 L3 推断值——模糊命中会跨厂商串味（CLOSED）
- #321 fix(cli): headless -p 消费 --continue/--resume——续聊被静默忽略、历史全丢（CLOSED）

## @Ver-zhzh

署名：Ver-zhzh <225828202+Ver-zhzh@users.noreply.github.com>

- #327 fix(security): 敏感文件硬门可被 Windows 8.3 短文件名（ENV~1）绕过（CLOSED）
- #326 fix(security): 敏感文件硬门可被 NTFS ::$DATA 后缀绕过（CLOSED）
- #316 fix(workers): esbuild service 子进程成为永久僵尸（每次写文件 +1）——空闲回收前先停 esbuild 并等其被回收（#315 问题 2）（CLOSED）
- #314 fix(model): 模型 id 自带冒号（cn: 前缀）时 /model 切换、设为默认、headless、serve 全部失效——首段仅在确为 provider 时才当前缀（#313）（CLOSED）
- #312 feat(goal): 上下文接力——goal 模式到达阈值自动交接、开新会话继续（可选，默认关闭）（CLOSED）
- #311 fix(security): 危险命令审批绕过——`git push -f` / `+refspec`、`git clean -fd(x)`、PowerShell `iwr | iex` 免审（CLOSED）
- #310 fix(security): 敏感文件门绕过——`.env.*.local` 叠加后缀漏判、`git add` 引号/全局选项/通配形态漏检（CLOSED）
- #309 fix(agent): import-graph 漏边——父级 `../` 分支正则误写、ESM `.js`→`.ts` 未映射、多行 import / export-from 不识别（CLOSED）
- #331 test: 修三条 Windows 路径分隔符导致的恒红守卫/断言（与是否真违规无关）（CLOSED）
- #329 feat(cvm): CVM 拦截「发生时提示」——分级 + 聚合 + 开关（#247 第 1–3 条）（CLOSED）
- #328 feat(tui): GlanceBar 常驻「本会话 CVM 拦截计数」（#247 补充项）（CLOSED）
- #325 fix(docs): docs:check 不再对「已登记但未随本仓分发」的引用判失败——公开仓子集检出恒红 13 条（issue #176）（CLOSED）
- #319 test: Windows 全量测试失败清零——49 → 1（余 1 为 PR#318 修复对象；含三轮全量 RED→GREEN 证据）（CLOSED）
- #317 fix(net): 系统已装 chromium 被误报"未安装"——探测/启动链补系统浏览器兜底（issue #302）（CLOSED）
- #308 fix: 路径分隔符归一化收口 + 观察项收口——evidence 归一化误写 / Windows 反斜杠泄漏族 / 审批判定 / 测试平台化（第三、四批）（CLOSED）
- #344 fix(server): 内存环两处无界增长收口——delegation 豁免截尾 + 字节预算 (#315)（CLOSED）
- #343 feat(tui): 常驻余额角标——输入区状态行复用官方快照 (#98)（CLOSED）
- #336 补齐 CLI 修复的贡献记录，修复主线对账失败（MERGED）
- #335 修复 CLI 会话交互并恢复终端原生回滚（MERGED）
- #352 fix(repo): 让 Physarum 节点冻结按指定轮次到期（CLOSED）
- #351 perf(repo): 将 Physarum 图缩放复杂度降为线性（CLOSED）
- #350 fix(server): 将路由和请求读取异常限制在单次请求内（CLOSED）
- #349 fix(agent): 取消超时 hook 请求并阻止迟到副作用（CLOSED）
- #348 fix(fs): 原子编辑保留项目文件的执行权限（CLOSED）
- #347 fix(tools): 收口目录 grep 与断链写入的文件访问边界（CLOSED）
- #346 fix(agent): 保留 Bash 验证事实并按文件计算覆盖率（CLOSED）

## @y521188

署名：y521188 <185880799+y521188@users.noreply.github.com>

- #354 fix(mcp): headless loads project MCP config; stdio connect timeout reclassified as protocol（CLOSED）
- #353 fix: 解决会话草稿技能加载、打包子进程回退、事件环内存保护及相关高危缺陷 (#338, #342, #315)（CLOSED）
- #345 fix(server): project-templates 路由补存活目录守卫——防止已删工作区触发 ENOENT 崩溃（CLOSED）
- #341 fix: Windows 全量剩余红清零——跨盘路径判定 + 七条恒红/脆弱断言收口（多轮全量 fail 0 证据）（CLOSED）
- #340 feat: 支持 Google Gemini 原生协议（protocol: 'gemini'）（CLOSED）
- #337 fix(server): test-key 探测透出 inferredIds——L3 推断值不再静默流入默认值（#324）（CLOSED）
- #362 fix(headless): mcpTools 未减内建工具——消除每次启动的「工具注册覆盖」误报（CLOSED）
- #367 fix(tools): esbuild 平台包缺失时不再误报低风险语法提示（CLOSED）
- #360 docs: 新增 tianshu-mcp 操作文档（三步图解快速上手）（CLOSED）
- #371 fix(delivery): 修复非 git 工作区归属误判与交付门虚假 GREEN (#369)（CLOSED）
- #370 fix(galaxy): 拦截丢弃型聚合策略防止维度丢失与虚假通过 (#368)（CLOSED）
- #364 fix(git): support external file diff in changes tab and stabilize Windows test harness（CLOSED）
- #381 fix(config): synchronize DeepSeek connect models with key pools（CLOSED）
- #387 docs: refresh model versions, descriptions and setup examples（OPEN）
- #384 fix(cli): synchronize connect and model across providers and gateways（OPEN）
- #383 fix(tui): align reasoning effort controls with model capabilities（CLOSED）
- #389 fix: 修复 CLI 跨平台生命周期并优化问答与计划预览（OPEN）
- #395 fix(server): 同一 Provider 多 Key 时余额查询按 keyId 独立（CLOSED）
- #393 fix(api): SSE 缺 [DONE] 但有终态 finish_reason 时宽容收尾（CLOSED）
- #391 feat(updater): GitHub API 查版本支持国内代理回退与网络自动检测（CLOSED）
- #396 fix(utils): isSafeFileName 补 Windows 保留设备名——CON/NUL/COM1-9 形态落 Win32 打开设备而非建文件（CLOSED）
- #405 fix(tui): 修复提问卡与计划审批卡被截断（CLOSED）
- #404 fix(shutdown): 退出/注销路径零 spawn taskkill——进程内直杀，消除关机硬错误框（#398）（CLOSED）
- #426 fix(memory): 补齐 13 种常见 token 形态的写入前 scrub 覆盖（CLOSED）
- #425 fix(plan): plan slug 路径穿越——planFilePath 加 isSafeFileName fail-closed 门（CLOSED）
- #424 fix(security): review-job 校验 PR baseRefName 前导横线并补 -- 终止符，堵 git fetch 选项注入（CLOSED）
- #423 fix(security): appendMemoryEntry 写入前 scrub 收口，纯敏感条目丢弃不落盘（CLOSED）
- #421 fix(security): snapshot import 路由加 cwd 沙箱校验（CLOSED）
- #420 fix(approval): 审批 answer 路由 fail-closed + editedInput 重跑 deny/self-kill 门（CLOSED）
- #419 fix(starflow): 预览阶段文案改为未来时态，与实际落盘行为一致（CLOSED）
- #418 fix(tools): memory recall 未授信时明示「未检索」而非裸「未找到」（CLOSED）
- #417 fix(tools): authority 接受中文星名并归一化为规范 id，修正 yuheng 错误示例（CLOSED）
- #409 fix(platform): node-runtime 无真 node 时不抢占 PATH 首位（CLOSED）
- #403 fix(server): 续跑不再把模型 id 的区域前缀误判为 provider 名（CLOSED）
- #410 fix: git 全局参数绕过危险命令审批门；修复 semver prerelease 解析与 Bearer 大小写（CLOSED）
- #406 fix(tui): 优化消息排队与插队引导机制（对齐 Codex CLI 排队契约）（CLOSED）
- #437 fix(cli): 适配远控终端并修复跨平台运行与持久化问题（OPEN）
- #440 fix(mcp): OAuth token 缺失 fail-closed，鉴权 401 归 auth 类——不再静默裸连（OPEN）
- #436 fix(mcp): close 成功才摘除连接登记，杜绝孤儿子进程（OPEN）
