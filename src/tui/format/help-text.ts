/**
 * /help 文本——按意图分组（2026-08-28 重排，原为 slash-commands.ts 内联平铺列表）。
 *
 * 分组设计纪律：
 * - 「多代理协同」置首组——/scout /team /council 等命令名对新用户无自明性，
 *   组首选型口诀承担「什么时候用哪个」的教学职责；
 * - 各条目文案保持与原 HELP_TEXT 一致（去重 /model /domain /compact 的历史重复行）；
 * - 末尾缓存成本块原样保留（DeepSeek V4 成本教育，不改一字）。
 *
 * 独立成文件而非内联 slash-commands.ts：结构门棘轮（该文件 ceiling 4620）要求
 * 巨石只降不升，纯文案沿接缝拆出。
 */
export const HELP_TEXT = `Available commands:

▌▌ 多代理协同（派子代理干活）▌▌

  选型口诀：并行写代码 → /team ｜ 只读体检诊断 → /scout ｜ 方案对抗评审 → /council ｜ 全流程贯通 → /starflow
  分量与开销：/scout 只读最轻；/team 按波次可控；/council 多席模型并行调用、token 开销大，够分量的方案再上；/starflow 最重（评审→施工→攻坚全流水线）——先用 /scout 摸底、由 /team 或 /galaxy 承接，别把 /starflow 当默认起手

/team <task|plan> — Run team-mode workflow through team_orchestrate
/team max <task> — Run team-mode max planning through team_orchestrate
/scout <诊断目标> [--dims 前端,后端,集成] — 巡天侦察蜂群：并行只读诊断，交付实测核对清单（不写文件）
/council <task> [--seats id1,id2,...] [--rounds 1-2] — Convene a star-domain council (single round; --rounds 2 enables a rebuttal round)
/starflow <任务描述> — 星流编排：需求澄清 → council 评审 → team 波次 → galaxy 攻坚 → 交付门禁，可 resume
/galaxy <任务描述> — 星河集群：任务按维度拆解，由不同星域并行执行
/tasks — 子代理任务面板（查看运行中/已完成，切入 f / 停止 x）
/enter <orderId> [prompt] — 恢复一个子代理会话继续跑
/team-resume [groupId] — Resume team execution from wave checkpoint
/config — 子代理模型路由：审查/侦察席可配其他供应商模型（如 DeepSeek Flash 省钱）

▌▌ 计划与目标 ▌▌

/plan <feature> — Create implementation plan
/plan close <file> --tasks <range|all> [--preview] — Close implementation plan tasks
/plan-template [list|<name>|save <name>] — Reusable plan templates
/write-plan — Write current plan to file
/ask — Enter/exit Ask mode (read-only Q&A)
/interview <topic> — Deep interview before coding
/goal <objective> [--max N] [--budget M] [--criteria '["..."]'] — Set autonomous goal
/goal-status — Show current goal state
/goal-pause — Pause active goal
/goal-resume — Resume paused/blocked goal
/goal-cancel — Cancel autonomous goal
/goal-criteria [set '["..."]'] — View or set success criteria
/todo [list|add <content>|done <id>|skip <id>|move <id> up|down] — Manage task list
/plan-mode — 切换计划编写模式（只读，只允许写计划文件）。再次执行退出
/plan-list — 列出待审批的计划文档
/plan-view [slug] — 预览计划文档全文（无参=唯一待审批，否则撰写中草稿）
/plan-approve <slug> [option] — 审批计划并开始执行
/plan-reject <slug> <反馈> — 驳回计划并附反馈让 agent 修改
/plan-close — 预览或应用计划收尾（归档/标记完成）

▌▌ 模型 · 星域 · 权限 ▌▌

/model [name|list] — Show or switch model（无参打开模型选择器）
/domain [list|<name>|auto|off] — Show or switch star domain personality（无参打开星域选择面板）
/capsule [off] <star> — 星域胶囊：把某星完整方法论注入对话（≤2 枚，消息级零缓存代价，同 recall_capsule）
/effort [off|low|medium|high|max] — Set reasoning effort
/permission [supervise|auto|unattended|manual|yolo|allow|deny|bash|remove|reset|test] — 权限模式：监督 / 自动 / 全自动
/grant [path] [read|write] — 授权并记住工作区外目录（无参列出本工作区已记住的授权）
/trust [status|off] — 授信当前项目：项目级 hooks 生效、配置安全键（verify/permissions/mcp…）参与合并（status 查询 · off 撤销；仅本机生效，绝不写回仓库）
/login [provider] — OAuth 登录（codex 等订阅型服务商，浏览器授权；/connect 选 codex 后的下一步）
/disconnect — 断开服务商——整组删除该 key 注册的模型列表并清除密钥
/vision — 配置独立视觉模型（探测 + 真实图片验证后才保存）
/yes — 跳过所有权限确认并持久化为默认；off 退出。与 /yolo 同义，显式输入即视为确认
/yolo — ⚠ 同 /yes——无刹车无打扰模式。仅在你完全信任当前任务时使用

▌▌ 会话与项目 ▌▌

/sessions — List all saved sessions
/fork [name] — Fork current session into a new copy and switch to it
/fork at <N> [name] — Fork from message line N (truncate after)
/branch — Show branch tree (parent + children)
/branch back — Switch back to parent session
/cd [<path>] — 会话中途切换工作目录（无参显示当前目录）；历史前缀缓存保留，会话归属迁往新项目
/init [verify] — 交互式项目初始化（verify 声明 / skills / hooks 脚手架）；verify 子命令直执行声明补缺
/mission — Show current task contract
/constellation [view|init|update <summary>|history|shift <summary>] — Project blueprint & milestone chronicle
/dream — Distill session decisions into project memory
/leave [symbol] <summary> — Leave your mark in the starmap as you depart
/queue <text> — 排队一条消息到下轮（无参预览队列）；busy 时也可攒，回车随下条一并发送
/btw <问题> — 侧问：就当前会话问一句，回答显示在浮层，不进对话历史
/resume [id|序号] — 继续一个历史会话（无参打开选择器；/sessions 看列表）
/remember <要记住的事> — 把一句话写进项目长期记忆（跨会话生效，新会话自动携带）；无参查看最近记忆
/chat — 切换到轻量聊天模式（不走完整 agent 循环，适合简单问答）
/task — 任务模式（已废弃：意图自动检测；子代理面板用 /tasks）
/jobs — 打开后台任务面板（bash 后台启动的 shell 任务列表）
/plugin [list|install|remove|enable|disable|info] — 插件管理
/logout — 登出天枢账号（清除本机 account 凭据；不影响 provider 的 OAuth）

▌▌ 审查与验证 ▌▌

/review — Manually trigger L2 review (single adversarial verifier) on current changes via deliver_task
/review max — Manually trigger L3 review (Review Squadron, 5 inspectors) on current changes via deliver_task
/review off|on|status — 会话级关闭/恢复/查看自动审查门（off 只抑制自动审查省 token，手动 /review 始终可用）
(auto: every non-trivial deliver_task commit runs a single Wiring inspector — short budget, never blocks on infra failure)
/verify — Show verification status
/evidence — Show last turn evidence summary
/undo [<number>|preview <number>] — Undo file changes with preview
/rollback — 检查点回滚（两阶段）：无参预览将还原/删除的文件与被其他会话占用的跳过项，再 /rollback confirm 执行、/rollback cancel 放弃。与 /undo 不同：/undo 按本会话快照撤销，/rollback 回到 git 检查点

▌▌ 上下文 · 诊断 · 环境 ▌▌

/compact [status|llm] — Micro-compact context (/compact status for stats)
/context [pin|claims|antibodies|conflicts|reload|export|import] — Context ledger
/memory [text|add|search|forget] — Session memory entries
/debug [prompt|fingerprint|cache|context-payload|mcp] — Debug info
/mcp — Show MCP server status
/logs [open [desktop]] — 本会话日志落点（会话 / 缓存 / 六维 / 桌面 sidecar），带写入门控与回收策略；open 直接在文件管理器里打开
/sensorium — Show 天枢 3D self-awareness state
/prefix-budget — 前缀预算归因：各块字符/token 占比 + 当前档位
/index — Rebuild codebase index (modules + CLI entries)
/status — Show agent status (model, domain, cache, tokens)
/tools — Show available tools and their descriptions
/doctor — Environment health check (Node/Git/Python/uv) + which shell the bash tool uses
/python [status|setup] — Check Python/uv/Git environment or auto-setup a Python project with uv
/mirror [status|on|off|china|default] — Toggle domestic mirrors for GitHub/npm/pip/go/rust downloads
/workflow [list|<name>|replay <id>] — YAML workflow orchestration + trace replay
/mode — 查看或切换提示词模式（标准/详尽/摘要，影响输出详细度）
/cache — 打开缓存面板（token 消耗 / 命中率 / 缓存省钱 / DeepSeek 官方账单），同 F3
/settings — 设置面板（同 /config）——子代理路由 / 审查子代理 / 识图模型 / 基础项
/setup — 设置面板（同 /config）

▌▌ 界面与其他 ▌▌

/help — Show this help
/theme [graphite|paper|cobalt|gemini|antigravity|slate|ziwei|tianshu|midnight|pastel|cyberpunk|observatory|starfield|claude] — Switch color theme (default: graphite)
/vim — Toggle vim keybindings
/verbose — Toggle verbose tool output
/scroll — Browse session history in pager
/cockpit [summary|trace|verify|context|safety|model|mcp|advisory|off] — Toggle cockpit panel
/pager — 分页浏览历史输出（滚走的内容可回看）
/palette — 打开命令面板（模糊搜索全部命令与界面动作，同 Ctrl+P）
/glance [compact|full] — 切换概览栏密度（单行 / 完整）
/panel [on|off] — 开关右侧面板（无参切换）
/rewind — 打开 rewind 浮层：回退到历史消息点（只回对话 / 只回代码 / 两者）
/starmap — 星图总览浮层 — 看整张星图与你的位置
/chronicle — 阶段传说 — 翻项目里程碑编年史
/zen [on|off|status] — 禅模式：收敛工具面做深度专注（写配置，新会话生效）
/fast — 解除禅模式，恢复全量工具面（/zen 的出口）
/skill [list|install <name>|import <name>|<name>|off <name>|review|approve <name>|reject <name>] — List/load skills; install from .claude/skills; review drafts
/diagram [list|<type>] — Generate a mermaid diagram skeleton (architecture|dataflow|sequence|flowchart|comparison|state)
/clear — Clear screen
/update — Check and install the latest Rivet release
/exit — Exit Rivet
/quit — Exit（/exit 的别名）
Ctrl+C — Interrupt current turn (press twice to exit)
↑ / Ctrl+N — 翻历史命令（单行 ↑ 上一条；多行编辑时方向键只做行间导航，用 Ctrl+R 历史搜索）
Ctrl+P — 命令面板（模糊搜索全部命令与界面动作；Ctrl+Esc 被 Windows「开始菜单」抢占，已换绑）

▌▌ 上下文与缓存（DeepSeek V4 成本关键）▌▌

⚠ 上下文占用直接影响 token 成本——尽早 /handoff 比触发压缩划算得多。

  · 60% 以上 → 建议 /handoff 写交接文档后开新会话（交接自动注入，比续跑省前缀重建成本）
  · 70%-78% → 触发自动压缩，压缩本身 token 支出很高（整段历史重写一次）
  · 80% 以上 → 压缩 + 前缀缓存大概率碎裂，每轮 cache miss，成本数倍
  · 版本升级后请勿连接旧会话——提示词结构变化会让缓存整体碎裂

  会话内切星域 / 改工具集 / 热加载 skill 也会碎缓存。保护缓存就是保护成本。`
