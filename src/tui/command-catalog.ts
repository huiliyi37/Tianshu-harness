/**
 * 命令目录 —— 命令元数据的**唯一事实源**。
 *
 * 存在的理由：此前元数据散在四处（`TUI_SLASH_COMMANDS` 数组、`register()` 调用、
 * `command-palette.ts` 的硬编码数组、`paletteExec` 的 name→overlay 分支）各自漂移，
 * 后果是 35 条已注册命令不在 Ctrl+P 面板里（而面板与 `/` 补全都以它为唯一来源），
 * 且 `/help` 与面板双向不对称（`/resume` 在面板不在帮助、`/todo` 反之）。
 * 收敛到本文件后，面板与 `/` 补全、`/help` 都从同一份数据派生。
 *
 * 纪律：
 * - **零依赖**。桌面 sidecar（`src/server/session-routes.ts`）用它校验 slash 命令，
 *   不能把 TUI 依赖拖过去——这是它独立成文件、而不是并进 `slash-commands.ts` 的原因。
 * - **只放元数据，不放 handler**。handler 留在 `slash-commands.ts`，按 name 装配。
 * - **数组顺序 = 面板顺序**，人工编排，不要按字母或分类重排。
 * - 新增命令必须同时进这里，守卫测试 `src/tui/__tests__/slash-command-guards.test.ts`
 *   会拦双向缺口。
 */

export interface CommandMeta {
  /** 命令名（含前导斜杠）。 */
  name: string
  description: string
  /** 已生效的键位提示，渲染为 ` [x]`。**只填真的能按的键**。 */
  hotkey?: string
  /** 参数提示（ghost text）：见 format/slash-hint.ts 的 slashArgsHint。 */
  argsHint?: string
  /** 核心层标记：输入恰好 `/`（空 query）时只展示核心层；多打一个字符即过滤全量。 */
  tier?: 'core'
  /** 展示用子命令提示（如 `/model list`）：不注册、不参与 /help 覆盖校验，
   *  只在面板与补全里做第二层可发现性。 */
  displayOnly?: true
}

/** 界面动作（`__surface:` 前缀）——不是 slash 命令，面板里与命令混排。 */
export interface SurfaceEntry {
  name: string
  description: string
  category: 'surface'
}

export const SURFACE_ENTRIES: readonly SurfaceEntry[] = [
  { name: '__surface:cockpit', description: 'Cockpit — trace / verify / context', category: 'surface' },
  { name: '__surface:pager', description: 'Scrollback — browse session history', category: 'surface' },
  { name: '__surface:starmap', description: 'Starmap — 星图总览', category: 'surface' },
  { name: '__surface:chronicle', description: 'Chronicle — 阶段传说', category: 'surface' },
]

/** 全部命令元数据。顺序即面板顺序（人工编排，勿重排）。 */
export const COMMAND_CATALOG: readonly CommandMeta[] = [
  { name: '/help', description: '显示所有命令及用法说明', tier: 'core', hotkey: 'F1' },
  { name: '/yolo', description: '⚠ yolo 模式（跳过所有权限确认并持久化为默认）。与 /yes 同义；off 退出。仅在你完全信任当前任务时使用', tier: 'core' },
  { name: '/yes', description: '⚠ 同 /yolo——跳过所有权限确认并持久化为默认；off 退出。显式输入即视为确认', argsHint: 'off', tier: 'core' },
  { name: '/btw', description: '侧问 — 就当前会话问一句，不进对话历史', argsHint: '<问题>' },
  { name: '/queue', description: '排队一条消息到下轮——busy 时也可攒，回车随下条一并发送（无参预览队列）', argsHint: '<text>', tier: 'core' },
  { name: '/compact', description: '压缩上下文：汇总工具输出、折叠已结讨论、保留关键决策。过半时主动用比等自动压缩更省 token', tier: 'core' },
  { name: '/connect', description: '连接模型服务商（选内置或自定义，填写 API 密钥）' },
  { name: '/login', description: 'OAuth 登录（codex 等订阅型服务商，浏览器完成授权；/connect 选 codex 后的下一步）', argsHint: '[provider]' },
  { name: '/disconnect', description: '断开服务商——整组删除该 key 注册的模型列表并清除密钥' },
  { name: '/vision', description: '配置独立视觉模型（探测 + 真实图片验证后才保存）' },
  { name: '/config', description: '设置面板 — 子代理路由 / 审查子代理 / 识图模型 / 基础项' },
  { name: '/model', description: '查看或切换当前会话模型。多 Provider 用户高频，切换后下轮生效', argsHint: 'list|<model-id>', tier: 'core', hotkey: 'F6' },
  { name: '/model list', displayOnly: true, description: '列出所有可用模型（含已配置的 Provider 下全部模型）' },
  { name: '/chat', description: '切换到轻量聊天模式（不走完整 agent 循环，适合简单问答）' },
  { name: '/task', description: '任务模式（已废弃：意图自动检测；子代理面板用 /tasks）' },
  { name: '/tasks', description: '打开子代理任务面板（查看/切入 f/停止 x，运行中·已完成·全部）', tier: 'core', hotkey: 'F2' },
  { name: '/jobs', description: '打开后台任务面板（bash 后台启动的 shell 任务列表）' },
  { name: '/cache', description: '打开缓存面板（token 消耗 / 命中率 / 缓存省钱 / DeepSeek 官方账单）', hotkey: 'F3' },
  { name: '/mode', description: '查看或切换提示词模式（标准/详尽/摘要，影响输出详细度）' },
  { name: '/verify', description: '显示本会话所有改动的验证状态——提交前自检哪些验证通过/未跑' },
  { name: '/verbose', description: '开关详细工具输出（显示完整的工具调用参数与返回，排查问题用）' },
  { name: '/clear', description: '清屏（只清当前显示，不删会话历史）', tier: 'core' },
  { name: '/sessions', description: '列出所有历史会话——找历史/继续之前的工作', tier: 'core', hotkey: 'F8' },
  { name: '/resume', description: '继续一个历史会话（无参打开选择器；/sessions 看列表）', argsHint: '[id|序号]', tier: 'core' },
  { name: '/undo', description: '撤销文件改动——回到检查点快照。无参预览最近 / 数字选快照 / preview 看文件清单', argsHint: '[N|preview]', tier: 'core' },
  { name: '/rollback', description: '检查点回滚（两阶段）：无参预览将还原/删除的文件，再 /rollback confirm 执行。与 /undo 不同——/undo 按本会话快照撤销，/rollback 回到 git 检查点', argsHint: '[confirm|cancel]' },
  { name: '/evidence', description: '显示上一轮的证据链——agent 的结论是基于哪些文件/命令得出的' },
  { name: '/context', description: '显示上下文账本（当前占用多少、哪些被压缩了、pinned anchors）' },
  { name: '/memory', description: '显示会话记忆——session 条目/项目信息素/知识文件，长会话后查 agent 记住了什么' },
  { name: '/skill list', displayOnly: true, description: '列出可用技能（.rivet/skills/ 下已安装的）' },
  { name: '/skill install', displayOnly: true, description: '从 .claude/skills 安装技能到 .rivet/skills（需新开会话生效）' },
  { name: '/skill review', displayOnly: true, description: '审阅自动蒸馏的技能草稿（agent 从反复操作中提炼的）' },
  { name: '/skill approve', displayOnly: true, description: '批准一个技能草稿，正式收入 .rivet/skills' },
  { name: '/skill reject', displayOnly: true, description: '驳回并删除一个技能草稿' },
  { name: '/permission', description: '权限模式：监督 / 自动 / 全自动（无参弹选择器，持久化默认）', tier: 'core', hotkey: 'F7' },
  { name: '/mission', description: '天契 — 当前任务契约' },
  { name: '/goal', description: '设定跨多轮的自主目标——agent 持续迭代直到达成或耗尽预算，输入框上方出现 GoalBar 显示进度', argsHint: '<目标> --max N' },
  { name: '/goal-cancel', description: '终止当前正在跑的自主目标（别名 /cancel-goal）' },
  { name: '/goal-resume', description: '恢复一个被暂停或阻塞的目标' },
  { name: '/mcp', description: '查看 MCP 服务器连接状态+工具数。接外部工具后查健康度' },
  { name: '/cockpit', description: '切换 Cockpit 驾驶舱（5 tab 运行时仪表盘：缓存命中/上下文/doom loop 检测等）', hotkey: 'F4' },
  { name: '/scroll', description: '浏览历史输出（上下翻页查看已滚走的内容）' },
  { name: '/theme', description: '切换配色主题（暗色/亮色/nebula/sakura 等多套）', tier: 'core', hotkey: 'F5' },
  { name: '/fork', description: '把当前会话 fork 成新分支——想试另一条路又怕丢上下文时用' },
  { name: '/handoff', description: '写结构化交接文档（任务目标/已完成/卡点/下一步/坑），归档后自动注入新会话', argsHint: '[备注]', tier: 'core' },
  { name: '/remember', description: '把一句话写进项目长期记忆（跨会话生效，新会话自动携带）；无参查看最近的用户记忆', argsHint: '<要记住的事>', tier: 'core' },
  { name: '/vim', description: '开关 vim 键位绑定（esc 进 normal 模式等）' },
  { name: '/effort', description: '切换推理强度——控成本与控质量的核心旋钮。off 最省/max 最强/auto 按任务复杂度自动选', argsHint: 'off|low|medium|high|max|auto', tier: 'core' },
  { name: '/domain', description: '查看或切换星域人格（改变方法论与决策阈值，不改工具）。list 列出/auto 按消息匹配/off 关闭', argsHint: 'list|<name>|auto|off' },
  { name: '/capsule', description: '星域胶囊：把某星完整方法论注入本轮对话（消息级追加零缓存代价，同 recall_capsule；最多 2 枚，off 摘除）', argsHint: '[off] <star>' },
  { name: '/interview', description: '深度访谈澄清需求——agent 反过来问你问题，把模糊想法逼成清晰规格' },
  { name: '/team', description: '团队模式：任务按文件拆分→多 patcher 写工分波并行实现→主控集成验证。适合多文件并行写的大改动（可传计划文件路径）', argsHint: '<任务|plan.md> | max', tier: 'core' },
  { name: '/team max', displayOnly: true, description: '团队强编队（Pro）：先多视角规划再分波落地，适合跨模块重构/高风险大改动——规划成本换安全性' },
  { name: '/scout', description: '巡天侦察：派多个只读子代理并行诊断，交付带证据的核对清单+runbook。不写文件不改代码，适合接手陌生仓库/上线前体检/接口对账', argsHint: '<诊断目标> [--dims 维度列表]', tier: 'core' },
  { name: '/council', description: '议事会：多星域专家对抗会诊，只出计划不执行。--rounds 2+ 开多轮辩论，适合方案评审/风险研判——多席模型并行调用，token 开销大，够分量的方案再上', argsHint: '<目标> [--rounds N]', tier: 'core' },
  { name: '/galaxy', description: '星河集群：按问题维度拆分（前端/后端/审查/测试），每维度派指定星域专家并行+末尾全局审查。适合跨层多维复合任务', argsHint: '<任务描述>' },
  { name: '/starflow', description: '星流编排（最重）：全流程贯通 council评审→team波次→galaxy攻坚，阶段间硬门禁兜底，可resume。先 /scout 摸底再用 /team 或 /galaxy 承接更划算——确认需要全流水线才上它', argsHint: '<任务描述>' },
  { name: '/plan', description: '规划模式：只读调研后产出带 Mermaid 图+TDD 步骤的实现计划（不写实现代码），存到 .rivet/plans/。复杂任务先进 plan 少走弯路', tier: 'core' },
  { name: '/write-plan', description: '/plan 的别名——同一套计划工作流' },
  { name: '/plan-mode', description: '切换计划编写模式（只读，只允许写计划文件）。再次执行退出' },
  { name: '/ask', description: '切换 Ask 模式（纯问答，不碰文件）。想问问题不想被改代码时用，再次执行退出' },
  { name: '/plan-list', description: '列出待审批的计划文档' },
  { name: '/plan-view', description: '预览计划文档全文（固定高度翻页；无参=唯一待审批，否则撰写中草稿）', argsHint: '[slug]' },
  { name: '/plan-approve', description: '审批计划并开始执行（可指定选项）', argsHint: '<slug> [option]' },
  { name: '/plan-reject', description: '驳回计划并附反馈让 agent 修改', argsHint: '<slug> <反馈>' },
  { name: '/plan-close', description: '预览或应用计划收尾（归档/标记完成）' },
  { name: '/review', description: 'L2 对抗审查：派单个验证审查员复核当前未提交改动。max 升 L3 五人编队；off/on/status 控制自动审查门并查看待终审累积', argsHint: 'max|off|on|status', tier: 'core' },
  { name: '/review max', displayOnly: true, description: 'L3 审查编队：5 名审查员并行复核当前改动——大改动或交付前用它兜底' },
  { name: '/review off', displayOnly: true, description: '关闭本会话自动审查门（省 token）；/review on 恢复，手动 /review 始终可用' },
  { name: '/constellation', description: '星图 — 项目蓝图与里程碑编年史' },
  { name: '/leave', description: '离开仪式 — 在星图里留下你的印记' },
  { name: '/enter', description: '恢复一个子代理会话继续跑（如 /enter wo_team:T1 继续修这个 bug）', argsHint: '<orderId> [prompt]' },
  { name: '/exit', description: '保存会话并退出', tier: 'core' },
  { name: '/update', description: '检查并安装最新版本的天枢' },
  { name: '/doctor', description: '环境健康检查——Node 版本/git/Python 等是否就绪，bash 工具用的哪个 shell', tier: 'core' },
  { name: '/logs', description: '本会话的日志落点（会话 / 缓存 / 六维 / 桌面），含门控与回收说明', argsHint: '[open [desktop]]' },
  { name: '/init', description: '交互式项目初始化：verify 声明 / skills / hooks 脚手架', tier: 'core' },
  { name: '/cd', description: '会话中途切换工作目录（保前缀缓存，会话归属迁往新项目）', argsHint: '<path>' },
  // ── 2026-09-19 补齐：此前已注册、但不在面板里因而无从发现的命令 ──
  { name: '/status', description: '显示 agent 状态（模型 / 星域 / 缓存命中 / token / 账号星籍）', tier: 'core' },
  { name: '/todo', description: '管理任务清单：list / add <内容> / done <id> / skip <id> / move <id> up|down', argsHint: '[list|add|done|skip|move]' },
  { name: '/tools', description: '查看工具分层（CORE / EXTENDED）与已挂载状态；enable <name> 把 EXTENDED 工具挂到主 agent（会碎一次前缀缓存）', argsHint: '[enable <name>]' },
  { name: '/trust', description: '授信当前项目：项目级 hooks 生效、配置安全键（verify/permissions/mcp…）参与合并。status 查询 / off 撤销；仅本机生效，绝不写回仓库', argsHint: '[status|off]' },
  { name: '/grant', description: '授权并记住工作区外目录（默认只读）；无参列出本工作区已记住的授权', argsHint: '[path] [read|write]' },
  { name: '/skill', description: '技能：list 列出 / install <name> 从 .claude/skills 装入 / review 审阅自动蒸馏草稿 / approve·reject 处置 / off <name> 停用', argsHint: '[list|install|review|approve|reject|off]' },
  { name: '/plugin', description: '插件管理——list / install / remove / enable / disable / info', argsHint: '[list|install|remove|enable|disable|info]' },
  { name: '/settings', description: '设置面板（同 /config）——子代理路由 / 审查子代理 / 识图模型 / 基础项' },
  { name: '/setup', description: '设置面板（同 /config）' },
  { name: '/rewind', description: '打开 rewind 浮层：回退到历史消息点（可选只回对话 / 只回代码 / 两者）' },
  { name: '/branch', description: '显示会话分支树（父 + 子）；back 切回父会话', argsHint: '[back]' },
  { name: '/team-resume', description: '从波次检查点恢复 team 执行（中断后接着跑，不重头来）', argsHint: '[groupId]' },
  { name: '/goal-status', description: '显示当前自主目标状态（轮次 / 预算 / 判据达成情况）' },
  { name: '/goal-pause', description: '暂停活跃的自主目标（保留状态，可 /goal-resume 续）' },
  { name: '/goal-criteria', description: '查看或设置目标的成功判据——判据明确时 agent 更容易收敛', argsHint: '[set <…>]' },
  { name: '/plan-template', description: '计划模板：list 列出 / save <name> 存当前计划为模板 / <name> 套用', argsHint: '[list|save <name>|<name>]' },
  { name: '/prefix-budget', description: '前缀预算归因：各上下文块的字符/token 占比 + 当前档位——查「前缀为什么这么大」' },
  { name: '/sensorium', description: '显示天枢自感知状态（六维遥测快照）' },
  { name: '/debug', description: '调试信息：prompt 指纹 / 缓存 / 上下文载荷 / MCP 状态', argsHint: '[prompt|fingerprint|cache|context-payload|mcp]' },
  { name: '/workflow', description: 'YAML 工作流编排：list 列出 / <name> 执行 / replay <id> 回放 trace', argsHint: '[list|<name>|replay <id>]' },
  { name: '/diagram', description: '生成 Mermaid 图骨架（architecture / dataflow / sequence / flowchart / comparison / state）', argsHint: '[list|<type>]' },
  { name: '/dream', description: '把本会话的决策蒸馏进项目记忆（跨会话生效）' },
  { name: '/index', description: '重建代码库索引（模块图 + CLI 入口）' },
  { name: '/mirror', description: '切换国内镜像源（GitHub / npm / pip / go / rust）加速依赖下载', argsHint: '[status|on|off|china|default]' },
  { name: '/python', description: '检查 Python/uv/Git 环境，或为项目自动初始化 uv 环境', argsHint: '[status|setup]' },
  { name: '/chronicle', description: '阶段传说 — 打开 Chronicle 浮层，翻项目里程碑编年史' },
  { name: '/starmap', description: '星图总览浮层 — 看整张星图与你的位置' },
  { name: '/pager', description: '分页浏览历史输出（滚走的内容可回看）' },
  { name: '/palette', description: '打开命令面板（模糊搜索全部命令与界面动作，同 Ctrl+P）' },
  { name: '/glance', description: '切换概览栏密度（compact 单行 / full 完整）', argsHint: '[compact|full]' },
  { name: '/zen', description: '禅模式：收敛工具面做深度专注；on|off 写配置（新会话生效）· status 查当前相位', argsHint: '[on|off|status]' },
  { name: '/fast', description: '解除禅模式，恢复全量工具面（/zen 的出口）' },
  { name: '/logout', description: '登出天枢账号（清除本机 account 凭据；不影响模型 provider 的 OAuth）' },
  { name: '/panel', description: '开关右侧面板（on / off / 无参切换）', argsHint: '[on|off]' },
]

/** 真实命令（排除展示用子命令提示）。注册装配与 /help 覆盖校验只看这一份。 */
export const REGISTERED_COMMAND_META: readonly CommandMeta[] =
  COMMAND_CATALOG.filter(c => c.displayOnly !== true)

const BY_NAME = new Map(COMMAND_CATALOG.map(c => [c.name, c]))

/** 按名取元数据。供注册装配回填 description —— `SlashCommand.description` 早已
 *  声明却从没被填过（数组式定义全部留空），于是描述被迫在面板里重写一遍。 */
export function catalogMetaFor(name: string): CommandMeta | undefined {
  return BY_NAME.get(name)
}
