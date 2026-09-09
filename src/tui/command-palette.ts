/**
 * 命令面板数据层 — 命令清单与模糊过滤（纯函数，零 React/Ink）。
 *
 * 渲染与按键交互在 T9：`format/overlay.ts::renderCommandPalette` +
 * `engine/app.ts` 的 overlay 导航。本模块只提供数据。
 */

export interface PaletteCommand {
  name: string
  description: string
  category?: 'command' | 'surface'
  /** 已生效的键位提示，渲染为 ` [x]`。**只填真的能按的键**（如 `Ctrl+R`）。
   *
   *  这里曾给 4 个 surface 填过 `c`/`p`/`s`/`h`，但面板里任何可打印字符都进过滤框，
   *  从没有按键路径消费它们——纯装饰的可供性。要让单字母生效就得像 lazygit 那样把
   *  过滤改成显式前缀（`/` 过名字、`@` 过键位），代价是砸掉当前正常工作的「打字即
   *  过滤」；而这 4 个界面本就各有两条可达路径（面板打名字、或 /cockpit /pager
   *  /starmap /chronicle），并没有能力缺口。故移除假标记，保留本字段给真实绑定。 */
  hotkey?: string
  /** 可选参数提示（ghost text）：见 format/slash-hint.ts slashArgsHint。 */
  argsHint?: string
  /** 核心层标记：输入恰好 `/`（空 query）的 slash 提示只展示核心层（~20 条
   *  高频命令），多打一个字符即过滤全量，Ctrl+P 面板永远全量。不标 = 进阶。
   *  分层只影响「发现性」——进阶命令不删除、随时可输入执行。 */
  tier?: 'core'
}

export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  if (!query) return [...commands]
  const lower = query.toLowerCase()
  return commands
    .filter(c => {
      if (c.name.toLowerCase().includes(lower)) return true
      if (c.description.toLowerCase().includes(lower)) return true
      let qi = 0
      for (let i = 0; i < c.name.length && qi < lower.length; i++) {
        if (c.name[i]!.toLowerCase() === lower[qi]) qi++
      }
      return qi === lower.length
    })
    .sort((a, b) => {
      const aStart = a.name.toLowerCase().startsWith(lower) ? 0 : 1
      const bStart = b.name.toLowerCase().startsWith(lower) ? 0 : 1
      return aStart - bStart || a.name.localeCompare(b.name)
    })
}

export function getPaletteCommands(): PaletteCommand[] {
  return [
    { name: '__surface:cockpit', description: 'Cockpit — trace / verify / context', category: 'surface' },
    { name: '__surface:pager', description: 'Scrollback — browse session history', category: 'surface' },
    { name: '__surface:starmap', description: 'Starmap — 星图总览', category: 'surface' },
    { name: '__surface:chronicle', description: 'Chronicle — 阶段传说', category: 'surface' },
    { name: '/help', description: '显示所有命令及用法说明', category: 'command', tier: 'core', hotkey: 'F1' },
    { name: '/yolo', description: '⚠ yolo 模式（跳过所有权限确认并持久化为默认）。与 /yes 同义；off 退出。仅在你完全信任当前任务时使用', category: 'command', tier: 'core' },
    { name: '/yes', description: '⚠ 同 /yolo——跳过所有权限确认并持久化为默认；off 退出。显式输入即视为确认', argsHint: 'off', category: 'command', tier: 'core' },
    { name: '/btw', description: '侧问 — 就当前会话问一句，不进对话历史', argsHint: '<问题>' },
    { name: '/queue', description: '排队一条消息到下轮——busy 时也可攒，回车随下条一并发送（无参预览队列）', argsHint: '<text>', tier: 'core' },
    { name: '/compact', description: '压缩上下文：汇总工具输出、折叠已结讨论、保留关键决策。过半时主动用比等自动压缩更省 token', tier: 'core' },
    { name: '/connect', description: '连接模型服务商（选内置或自定义，填写 API 密钥）' },
    { name: '/login', description: 'OAuth 登录（codex 等订阅型服务商，浏览器完成授权；/connect 选 codex 后的下一步）', argsHint: '[provider]' },
    { name: '/disconnect', description: '断开服务商——整组删除该 key 注册的模型列表并清除密钥' },
    { name: '/vision', description: '配置独立视觉模型（探测 + 真实图片验证后才保存）' },
    { name: '/config', description: '设置面板 — 子代理路由 / 审查子代理 / 识图模型 / 基础项' },
    { name: '/model', description: '查看或切换当前会话模型。多 Provider 用户高频，切换后下轮生效', argsHint: 'list|<model-id>', tier: 'core', hotkey: 'F6' },
    { name: '/model list', description: '列出所有可用模型（含已配置的 Provider 下全部模型）' },
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
    { name: '/rollback', description: '预览检查点改动（回滚前先看会改什么）' },
    { name: '/evidence', description: '显示上一轮的证据链——agent 的结论是基于哪些文件/命令得出的' },
    { name: '/context', description: '显示上下文账本（当前占用多少、哪些被压缩了、pinned anchors）' },
    { name: '/memory', description: '显示会话记忆——session 条目/项目信息素/知识文件，长会话后查 agent 记住了什么' },
    { name: '/skill list', description: '列出可用技能（.rivet/skills/ 下已安装的）' },
    { name: '/skill install', description: '从 .claude/skills 安装技能到 .rivet/skills（需新开会话生效）' },
    { name: '/skill review', description: '审阅自动蒸馏的技能草稿（agent 从反复操作中提炼的）' },
    { name: '/skill approve', description: '批准一个技能草稿，正式收入 .rivet/skills' },
    { name: '/skill reject', description: '驳回并删除一个技能草稿' },
    { name: '/permission', description: '权限模式：监督 / 自动 / 全自动（无参弹选择器，持久化默认）', tier: 'core', hotkey: 'F7' },
    { name: '/mission', description: '天契 — 当前任务契约', category: 'command' },
    { name: '/goal', description: '设定跨多轮的自主目标——agent 持续迭代直到达成或耗尽预算，输入框上方出现 GoalBar 显示进度', argsHint: '<目标> --max N' },
    { name: '/cancel-goal', description: '终止当前正在跑的自主目标' },
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
    { name: '/team max', description: '团队强编队（Pro）：先多视角规划再分波落地，适合跨模块重构/高风险大改动——规划成本换安全性' },
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
    { name: '/review', description: 'L2 对抗审查：派单个验证审查员复核当前未提交改动。max 升 L3 五人编队，off/on 控制自动审查门', argsHint: 'max|off|on', tier: 'core' },
    { name: '/review max', description: 'L3 审查编队：5 名审查员并行复核当前改动——大改动或交付前用它兜底' },
    { name: '/review off', description: '关闭本会话自动审查门（省 token）；/review on 恢复，手动 /review 始终可用' },
    { name: '/constellation', description: '星图 — 项目蓝图与里程碑编年史' },
    { name: '/leave', description: '离开仪式 — 在星图里留下你的印记' },
    { name: '/enter', description: '恢复一个子代理会话继续跑（如 /enter wo_team:T1 继续修这个 bug）', argsHint: '<orderId> [prompt]' },
    { name: '/exit', description: '保存会话并退出', tier: 'core' },
    { name: '/update', description: '检查并安装最新版本的天枢' },
    { name: '/doctor', description: '环境健康检查——Node 版本/git/Python 等是否就绪，bash 工具用的哪个 shell', tier: 'core' },
    { name: '/logs', description: '本会话的日志落点（会话 / 缓存 / 六维 / 桌面），含门控与回收说明', argsHint: '[open [desktop]]' },
    { name: '/init', description: '交互式项目初始化：verify 声明 / skills / hooks 脚手架', tier: 'core' },
    { name: '/cd', description: '会话中途切换工作目录（保前缀缓存，会话归属迁往新项目）', argsHint: '<path>' },
  ]
}
