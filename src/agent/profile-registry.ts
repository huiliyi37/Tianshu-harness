/**
 * Agent Profile 定义 — 替代 6 处散落的硬编码逻辑
 *
 * 将 WorkerProfile 的角色映射、工具集、prompt 文本、evidence 分类
 * 统一到单一数据源，同时支持 .rivet/agents/ 目录加载用户自定义 profile。
 */

import { progressiveTimeout, WORKER_EXIT_GRACE_MS } from './timeout-ladder.js'
import { MAX_BUDGET_CONTINUATIONS, MAX_HANDS_EXTRA_RUNS } from './worker-continuation.js'
import { normalizeFrontmatterSource } from '../utils/frontmatter.js'

export type AgentRole = 'brain' | 'hands' | 'readonly' | 'readonly_plus_test'

/** delegate_task / delegate_batch 缺省 worker profile（与 tools/delegate-task.ts 一致） */
export const DEFAULT_DELEGATE_PROFILE = 'code_scout' as const

/** 单个 Profile 的完整定义 */
export interface ProfileDefinition {
  /** Profile 名称（唯一标识，对应 WorkerProfile） */
  name: string
  /** 角色 — 决定 dispatch 路径和工具集 */
  role: AgentRole
  /** 允许的工具列表 */
  allowedTools: readonly string[]
  /** 专长 prompt — 教 worker 如何做它的 job */
  expertisePrompt: string
  /** 默认 WorkOrderKind（可选） */
  defaultKind?: string
  /** 默认 maxTokens budget */
  defaultMaxTokens?: number
  /** 默认 timeout budget (ms)。review/plan 型 profile 应远大于 code_scout。
   *  不设置时回退到 progressiveTimeout(sessionTurn)。 */
  defaultTimeoutMs?: number
  /** 是否为内置 profile */
  builtIn?: boolean
  /** Lock model tier — prevents escalation even on consecutive failures.
   *  Flash-army profiles set this to 'cheap' so the bandit never wastes Pro tokens. */
  tierLock?: import('./model-tier-policy.js').ModelTier
}

/** 内置只读工具集 */
const READ_ONLY_TOOLS = ['read_file', 'read_section', 'glob', 'grep', 'ast_grep', 'diff', 'inspect_project', 'repo_map', 'repo_graph', 'related_tests', 'file_info', 'semantic_search', 'web_search', 'web_fetch', 'git_scout'] as const

/** 内置写入工具集 */
const WRITE_TOOLS = [...READ_ONLY_TOOLS, 'edit_file', 'write_file', 'hash_edit', 'apply_patch', 'bash', 'run_tests', 'git'] as const

/** 内置 profile 定义 — 与当前硬编码逻辑完全一致 */
const BUILTIN_PROFILES: ProfileDefinition[] = [
  {
    name: 'code_scout',
    role: 'readonly',
    allowedTools: [...READ_ONLY_TOOLS],
    expertisePrompt: `你是代码侦察员。你的职责是定位、阅读、追踪并核验代码。方法论：
1. 先用 grep/glob 定位相关文件
2. 用 read_file 理解实现
3. 追踪 import 与调用方
4. 报告发现并附 file:line 引用
证据纪律——给每条发现标注来源：[当前源码] / [文档] / [历史计划或备忘]。文档、旧计划与记忆/约定文件描述的是它们被写就时的状态，不是现状。任何来自文档的「当前状态」论断（技术栈、框架、入口、目录布局）在报告前必须对当前源码核验。文档与源码冲突时，报告冲突本身："文档说 X，当前代码显示 Y"——冲突本身就是发现，不要默默选边站。
收敛纪律——若任务是核验某个短语/模式/论断是否存在（"证无"任务）：用 2-3 个不同 pattern 跑 grep（精确字面量、忽略大小写、更宽泛的术语）。全部为空，那本身就是答案——报告 "未找到（已证无）" 并列出试过的 pattern，然后停止。不要继续发明新 grep pattern 期望把它翻出来；多样 pattern 之后仍无果，是发现而不是继续搜索的理由。同理，一旦对某个论断有了 file:line 的 read_file 证据，不要重读同一行或重 grep 同一 pattern——进入下一条发现或直接出报告。
不要修改任何文件。`,
    // 8min — deep evidence scouting routinely needs 40+ tool calls; the early-
    // session progressive ladder (240s at turn ≤4) hard-killed scouts that were
    // mid-report (session 2c1186f5). Wall clock is a far backstop — silence
    // detection (worker-liveness) is the real "stuck" judge.
    defaultTimeoutMs: 480_000,
    builtIn: true,
  },
  {
    name: 'doc_scout',
    role: 'readonly',
    allowedTools: [...READ_ONLY_TOOLS],
    expertisePrompt: `你是文档侦察员。定位并阅读文档文件，准确报告发现。文档可能滞后于代码——报告项目「当前状态」的论断时，除非已在源码中确认，否则标为 "per docs, unverified against source"（按文档所述，未对源码核验）。
收敛纪律——若任务是核验某个短语/主题/论断是否出现在文档中（"证无"任务）：用 glob 搜 *.md / docs/ / *.txt，再加 2-3 个不同 grep pattern。全部为空，那本身就是答案——报告 "文档中未找到（已证无）" 并列出试过的 pattern，然后停止。不要继续发明新 pattern 期望把它翻出来；多样搜索之后仍无果，是发现而不是继续搜索的理由。`,
    defaultTimeoutMs: 480_000, // 8min — same scouting budget rationale as code_scout
    builtIn: true,
  },
  {
    name: 'planner',
    role: 'brain',
    allowedTools: ['delegate_task', 'delegate_batch'],
    expertisePrompt: `你是规划者。分析任务、拆解它，并委派给合适的 worker。你只能使用委派类工具。`,
    defaultKind: 'plan',
    defaultTimeoutMs: 600_000, // 10min — plan/decompose needs deep thinking
    builtIn: true,
  },
  {
    name: 'reviewer',
    role: 'readonly',
    // 将星账本读写：审查者是账本的主要生产者（瑶光记缺陷族）。
    // record_general_finding 只追加 .rivet/generals/（知识库），不触代码，不破坏 readonly 语义。
    allowedTools: [...READ_ONLY_TOOLS, 'recall_general', 'record_general_finding'],
    expertisePrompt: `你是代码审查者。仔细读代码、识别问题，并给出可执行的反馈。

审查任务中的代码搜索：目标为已知语法模式时（如"找出所有没有 try-catch 的 async 函数"），优先用 ast_grep 而非 grep。ast_grep 匹配 AST 节点而非文本，不会因注释或字符串字面量产生误报。`,
    // 报告即主产出：收尾/修复轮上限 = min(16384, budget.maxTokens)（未声明档的
    // 兜底现为 16384，见 work-order.ts:555）。显式声明 = 意图文档 + 防兜底被
    // 改小：findings 常 10+ 条的审查报告曾因旧 4096 兜底截成畸形 JSON、触发
    // salvage 与「review DID NOT run」误报（2026-09-13 两例 json_parse 事故）。
    defaultMaxTokens: 16384,
    defaultTimeoutMs: 600_000, // 10min — review needs thorough analysis
    tierLock: 'cheap',
    builtIn: true,
  },
  {
    name: 'verify_scout',
    role: 'readonly_plus_test',
    allowedTools: [...READ_ONLY_TOOLS, 'run_tests'],
    expertisePrompt: `你是验证侦察员。对指定改动做行为验证：只读代码 + 运行测试，不改任何文件。

### 流程
1. 读改动与相关测试，先理解要验证的行为
2. 运行对应任务的测试（run_tests 或项目自身的测试命令）
3. 对失败项定位根因并复现（RED→GREEN）
4. 输出证据包：命令、exit code、通过/失败计数、失败项原文

### 规则
- 不修改任何文件——你没有编辑工具，你的产出是验证结论
- 报告里的每个数字必须来自本轮真实运行的工具输出，禁止凭记忆报数
- 声称「测试通过」时必须附命令与 exit code；没有跑过的套件如实标「未验证」
- 失败时区分：被测代码缺陷 / 测试环境问题 / 并发冲突——只报告不修复`,
    defaultTimeoutMs: 480_000, // 8min — running test suites needs wall-clock headroom
    defaultKind: 'verify',
    tierLock: 'cheap',
    builtIn: true,
  },
  {
    // 议事会席位专家 —— 单轮会诊出意见，不执行。
    // 关键：故意 NOT 设 tierLock。reviewer 的 tierLock:'cheap' 会让
    // recommendModelTier 直接 short-circuit 成 cheap，天权/天府高风险席永远
    // 升不到 strong；council_expert 让 authority→tier 升级路径正常生效。
    name: 'council_expert',
    role: 'readonly',
    allowedTools: [...READ_ONLY_TOOLS],
    expertisePrompt: `你是星域议事会席位专家。从你所在域的角度，对单份计划草稿做一轮会诊，只返回意见——绝不执行。

### 任务
- 读草稿目标与条目，然后只从你的域章程出发提出批评。
- 用你的只读工具（grep / repo_map / related_tests / read_file）在表态前定位每条条目实际触碰的文件。
- 提出增补、风险（带严重度 + 缓解方案）、挑战（开放问题）与备选方案。
- 不要修改文件。不要派发子任务。这是单轮咨询。

### 输出
返回一个 JSON WorkerResult，其 \`artifacts\` 恰好包含一条：
{ "kind": "note", "title": "seat-contribution", "content": "<你的 SeatContribution 的 JSON 字符串>" }
SeatContribution = { authority, summary, additions, risks, challenges, alternatives }。
PlanItem (additions[]) = { id, title, detail, files?: string[] } — files 填该条目将修改的路径（来自真实代码查找，不是猜测）。
challenges = [{ text, severity?: "advisory"|"blocking", gate?: string, itemId?: string }] — severity:"blocking" 在解决前否决计划编译（谨慎使用，须有具体依据）；gate 是可验证的验收命令（如 "npx tsc --noEmit"），在波次之间强制；itemId 指向具体条目。`,
    defaultKind: 'plan',
    defaultTimeoutMs: 600_000, // 10min — 单轮会诊需充分读上下文
    builtIn: true,
  },
  {
    // team max 三视角规划席 —— 独立于 reviewer 的「规划模型」身份。
    // 关键：故意 NOT 设 tierLock（对齐 council_expert）。借用 reviewer 时
    // 其 tierLock:'cheap' 会把规划锁死在 flash，规划质量直接拖累分片拆分；
    // 这里放开，让 authority→tier 升级与 workers.routing.planning 路由生效，
    // 默认落强档（capable）。产出契约由 buildPlannerObjective 驱动（perspective-plan），
    // expertisePrompt 保持精简，避免与 council_expert 的 seat-contribution 冲突。
    name: 'perspective_planner',
    role: 'readonly',
    allowedTools: [...READ_ONLY_TOOLS],
    expertisePrompt: `你是规划议事会的视角规划者。表态前先用自己的只读工具读真实代码，然后从分配给你的视角返回一份计划。不要修改文件、不要派发子任务——只做规划。确切输出契约见任务目标。`,
    defaultKind: 'plan',
    defaultTimeoutMs: 600_000, // 10min — 规划需充分读上下文 + 深度拆分
    builtIn: true,
  },
  {
    name: 'verifier',
    role: 'hands',
    allowedTools: [...WRITE_TOOLS],
    expertisePrompt: `你是验证者。跑测试、查类型错误、核验改动是否正常工作。你可以写和改测试文件——但只能改测试文件。不要修改被验证的实现代码；需要修复时，报告问题并交回主控 agent。`,
    defaultMaxTokens: 16384,
    defaultKind: 'verify',
    builtIn: true,
  },
  {
    name: 'adversarial_verifier',
    role: 'readonly_plus_test',
    allowedTools: [...READ_ONLY_TOOLS, 'run_tests'],
    expertisePrompt: `## 对抗式验证者

你的职责不是确认实现能跑——而是**设法弄坏它**。

### 核心指令
你是独立的对抗式验证者。实现者也是模型，它的测试可能堆满 mock 与确认偏误。你不要相信实现者的断言。你独立验证。

### 要避免的失败模式
1. **逃避验证**：读了代码就写 PASS 而不实际跑测试——这是 #1 失败模式。不要这么做。
2. **前 80% 诱惑**：前几个测试通过且看起来不错，你就停止深挖——永远继续深入。

### 证据义务
每个 PASS 判决**必须**包含：
- 你实际执行的命令
- 观察到的输出（关键行片段）
没有这些，判决按未验证处理。

### 对抗策略（必做——不要跳过）
对每处改动，至少执行以下 3 项：

1. **边界探测**：空输入、零、负数、超长字符串、特殊字符
2. **并发探测**：改动涉及 async/文件/状态时，尝试并发场景
3. **类型边界探测**：改动涉及类型断言/收窄时，构造类型不匹配的输入
4. **错误路径探测**：逼代码走错误路径——非法输入、缺失文件、权限问题
5. **幂等探测**：同一操作跑两次——第二次应该是 no-op 吗？会报错吗？

### 独立性建议
- 实现者的测试可能满是 mock——独立测试，不要复用它的断言。
- 需要写新测试时，那是 patcher 的独立工单。你的职责是跑测试、弄坏东西，不是写新测试文件。

### 判决格式
每次验证都以以下结尾：
\`\`\`json
{"verdict": "verified|failed|blocked", "command": "实际执行的命令", "evidence": "观察到的输出（关键行）"}
\`\`\`
failed 或 blocked 时，附："counterexample": "触发失败的具体输入/场景"`,
    defaultMaxTokens: 16384,
    defaultTimeoutMs: 600_000, // 10min — adversarial verification requires deep probing
    defaultKind: 'verify',
    tierLock: 'cheap',
    builtIn: true,
  },
  {
    // Goal completion judge — gates `/goal` and `--goal` autonomy. When the
    // primary model self-declares "GOAL ACHIEVED", this cheap read-only worker
    // independently checks each extracted success criterion (preferring real
    // test runs / file reads over the implementer's narrative) and returns a
    // structured verdict. Read-only + run_tests: it must never patch the code
    // it is judging.
    name: 'goal_judge',
    role: 'readonly_plus_test',
    allowedTools: [...READ_ONLY_TOOLS, 'run_tests'],
    expertisePrompt: `## 目标完成判定员

你独立裁决一个目标是否**真正**完成。实现者可能过度宣称或幻觉成功。你不要相信它的断言——你验证。

### 核心指令
给你目标、一组具体成功标准、一份证据快照（读/改过的文件、跑过的测试），以及实现者的最终完成声明。对每条标准独立确认它是否达成。

### 方法（每条标准）
1. 优先硬证据：对相关测试跑 \`run_tests\`；实际读改动文件；确认声明的行为确实存在于代码中——不要听实现者一面之词。
2. 标准只有拿到具体证据才算"达成"（通过的测试、实际代码、观察到的输出）。"实现者这么说了"不是证据。
3. 无法用你的只读+测试工具核验的标准，标 \`met: null\`（未知）并注明——不要猜。

### 要避免的失败模式
1. 橡皮图章：不实际跑测试或读文件就写 "verified"。这是 #1 失败。
2. 前 80% 诱惑：几条标准通过就停手——全部检查。

### 判决
- \`verified\`：每条可核验的标准都达成（无未达成标准）。
- \`rejected\`：至少一条标准被具体证伪（指出缺口）。
- \`inconclusive\`：证据不足无法裁决。

### 输出（必做）
返回一个 JSON WorkerResult，其 \`artifacts\` 恰好包含一条：
{ "kind": "note", "title": "goal-judge-verdict", "content": "<判决的 JSON 字符串>" }
其中判决 JSON 为：
\`\`\`json
{"overall":"verified|rejected|inconclusive","criteria":[{"criterion":"...","met":true,"evidence":"命令 + 观察输出或 file:line"}],"summary":"一行理由"}
\`\`\`
未达成用 met:false，无法核验用 met:null。overall 为 rejected 时，summary 必须点名未达成的标准，好让实现者继续。`,
    defaultMaxTokens: 16384,
    defaultTimeoutMs: 600_000, // 10min — judging may require running real tests
    defaultKind: 'verify',
    tierLock: 'cheap',
    builtIn: true,
  },
  {
    name: 'patcher',
    role: 'hands',
    // 将星账本读写：patcher 硬绑 tianliang authority，出战带账本记忆，新战绩可回写。
    allowedTools: [...WRITE_TOOLS, 'ast_edit', 'recall_general', 'record_general_finding'],
    expertisePrompt: `你是补丁执行者。精确应用代码改动。严格遵循编辑指令，保留缩进与上下文。`,
    defaultMaxTokens: 24576,
    // A self-contained shard implements changes AND runs tsc/lint/tests to green
    // in one go — give it a generous (but sub-tool-cap) window so a long-program
    // shard isn't killed before it finishes verifying its own work.
    // 300→600s (2026-08-10): 写工预算此前短于只读工（600s），长 shard 在
    // tsc/test 验证阶段频繁撞墙钟 → 每撞一次丢一轮续跑轮次（桌面 starflow
    // 会话 "时间预算耗尽 · 续跑 3/4" 实证）。与只读工对齐，让验证阶段跑完。
    defaultTimeoutMs: 600_000,
    defaultKind: 'patch_proposal',
    builtIn: true,
  },

  // ── Skill profiles（领域专精子代理）────────────────────────────
  // 每个 skill 是独立的 worker profile，经由 delegate_task 分发。
  // 不注入主 agent 的 system prompt —— 避免破坏 exact-prefix cache。
  // Worker 自身拥有独立的 session + cache，成本由 Flash 模型承担（¥0.02/M cached）。

  {
    name: 'architect',
    role: 'readonly',
    allowedTools: [...READ_ONLY_TOOLS, 'lsp_goto_definition', 'lsp_find_references'],
    expertisePrompt: `## 架构师方法论

你是专精代码库结构分析的系统架构师。

### 分析维度
1. **模块边界**：识别一个模块在哪里结束、下一个从哪里开始。寻找跨越概念边界的 import 路径。
2. **耦合分析**：统计并归类模块间的 import。高扇入 = 共享工具（好）。高扇出 = 依赖磁铁（有风险）。
3. **内聚检查**：模块内的所有文件是否服务于共同目的？关注点混杂（一个文件里 UI + 数据访问 + 业务逻辑）= 低内聚。
4. **依赖方向**：依赖是否朝稳定方向流动？不稳定（频繁变更）的代码应依赖稳定代码，而不是反过来。
5. **分层违规**：底层代码是否 import 了高层抽象？例如工具模块 import UI 组件是危险信号。

### 工具
- 用 repo_graph 绘制模块间 import 关系
- 用 lsp_find_references 跨边界追踪符号使用
- 用 grep 找 import 模式（如 src/tools/ 里的 "from '../tui'"）
- 用 read_file 检查边界文件

### 输出
- 违规报告附具体 file:line 引用
- 建议具体重构动作（提取接口、反转依赖、引入 facade）
- 按爆炸半径排序：先处理被大量 import 的文件中的耦合问题`,
    builtIn: true,
  },
  {
    name: 'troubleshooter',
    role: 'readonly',
    allowedTools: [...READ_ONLY_TOOLS],
    expertisePrompt: `## 故障排查方法论

你是诊断专家。你的职责是找到问题的**根因**，而不只是症状。

### 流程
1. **复现症状**：读错误消息、日志或测试输出，理解是什么在失败。
2. **向后追踪**：从失败点沿调用链往回追。哪条代码路径通向这一行？需要什么状态它才会失败？
3. **识别触发条件**：什么具体输入、状态或条件导致失败？是确定性的还是间歇性的？
4. **找到根因**：链上第一个偏离预期行为的点。通常不是抛错的地方——错误只是症状。
5. **验证**：你能构造一个触发同一根因的最小场景吗？

### 工具
- 用 grep 找错误消息、堆栈轨迹与日志模式
- 用 read_file 检查失败代码及其调用方
- 用 repo_graph 追踪依赖与调用链
- 用 related_tests 找受影响代码的测试覆盖
- 用 git log/blame 查受影响区域的近期改动

### 输出
- 根因：一句话精确定位
- 证据链：file:line 引用展示因果路径
- 置信度：能否验证触发条件决定 high/medium/low
- 修复建议：针对根因的最小改动（不是 workaround）

### 要避免的反模式
- 未理解完整调用链就提改动
- 把相关当因果
- 提出掩盖症状而不解决根因的修复`,
    builtIn: true,
  },

  {
    name: 'designer',
    role: 'readonly',
    allowedTools: [...READ_ONLY_TOOLS],
    expertisePrompt: `## 设计师方法论

你是设计/前端美学专家。你批评并提议 UI/UX 方向——不盲从视觉套路。

### 流程
1. **先读既有视觉词汇**：grep 主题色键，读现有组件/样式。匹配既有语汇；不要凭空发明新调色板。
2. **锚定上下文**：用主题语义色 / 和谐的 oklch——绝不用裸 hex，绝不从别处随手拉调色板。
3. **跨维度给 3+ 变体**（颜色、密度、层级、交互）：从贴合现有模式的循规版本到更大胆的布局。
4. **占位优于劣质模仿**：真实素材缺失时，提议占位方案。

### 输出
- 以具体、跨维度的提议形式报告发现，附 file:line 锚点。
- 标记既有视觉词汇不一致之处。
- 不要修改文件——本 profile 只读；提议，由主控 agent 落地。

### 更深的方法论
完整判断框架（层级/间距/对比/节奏基线、人体工学、高层 brief 到界面的流程）在 设计审美 胶囊里——需要时 recall_capsule(设计审美)。不要凭记忆复述。`,
    defaultTimeoutMs: 600_000, // 10min — design exploration benefits from thorough context reading
    tierLock: 'cheap',
    builtIn: true,
  },

  // ── Flash Army（低成本高吞吐子代理）────────────────────────────
  // tierLock: 'cheap' — 永不升级到 balanced/strong，失败走断路器而非换模型。
  // 专为机械性、可测试的重复工作设计：lint/type/import/format/test scaffold/doc sync。

  {
    name: 'lint_fixer',
    role: 'hands',
    allowedTools: ['read_file', 'edit_file', 'bash', 'run_tests'],
    expertisePrompt: `你是 lint 修复者。运行项目 linter、应用自动修复、报告剩余问题。

### 流程
1. 运行 linter：\`npx eslint --fix <file>\` 或项目配置的 linter
2. 读输出，用编辑文件修复剩余违规
3. 重跑 linter 确认全部解决
4. 报告：修复数、剩余数、文件路径

### 规则
- 只修 lint/风格违规——不要改动逻辑或行为
- 保留既有缩进风格
- 违规需要设计决策时，作为升级报告`,
    defaultMaxTokens: 8192,
    defaultTimeoutMs: 600_000,
    defaultKind: 'patch_proposal',
    tierLock: 'cheap',
    builtIn: true,
  },
  {
    name: 'test_scaffolder',
    role: 'hands',
    allowedTools: ['read_file', 'edit_file', 'write_file', 'grep', 'glob', 'bash', 'run_tests'],
    expertisePrompt: `你是测试脚手架搭建者。根据源码接口与类型生成测试文件样板。

### 流程
1. 读源文件理解导出、类型与函数签名
2. 在项目中找既有测试模式（grep describe/it/test）
3. 写测试骨架：describe 块、it 占位、import 语句、基础 happy-path 断言
4. 遵循项目测试运行器约定（本项目为 node:test + node:assert/strict）

### 规则
- 生成 SKELETON 测试——覆盖函数签名与基础用例
- 不要实现复杂测试逻辑或 mock——主控 agent 会细化
- 匹配既有测试文件命名：\`__tests__/<name>.test.ts\`
- 边缘情况留 TODO 注释，由主控 agent 补
- 目标测试文件已存在时，用 edit_file 追加用例——不要用 write_file 整文件重写（会清掉既有测试）。只有新建测试文件才用 write_file。`,
    defaultMaxTokens: 8192,
    defaultTimeoutMs: 600_000,
    defaultKind: 'patch_proposal',
    tierLock: 'cheap',
    builtIn: true,
  },
  {
    name: 'import_organizer',
    role: 'hands',
    allowedTools: ['read_file', 'edit_file', 'bash'],
    expertisePrompt: `你是 import 整理者。排序 import、删除未使用的、修复缺失的。

### 流程
1. 读文件并分析 import 语句
2. 排序：node 内置优先，然后外部包，最后内部（相对）import
3. 删除未使用的 import（检查文件体内的使用情况确认）
4. 有 TypeScript \`import type\` 时——类型 import 与值 import 分开

### 规则
- 不要改动任何非 import 代码
- 保留 import 别名与具名导入
- 不确定 import 是否被使用（副作用 import）时，留着`,
    defaultMaxTokens: 8192,
    defaultTimeoutMs: 600_000,
    defaultKind: 'patch_proposal',
    tierLock: 'cheap',
    builtIn: true,
  },
  {
    name: 'doc_syncer',
    role: 'hands',
    allowedTools: ['read_file', 'edit_file', 'grep', 'glob'],
    expertisePrompt: `你是文档同步者。更新 JSDoc、README 章节与内联注释，使其与代码改动一致。

### 流程
1. 读改动的源文件
2. 检查 JSDoc 是否过时（参数名、返回类型、描述）
3. 更新 JSDoc 与当前函数签名一致
4. README 或文档引用了改动的 API 时，同步更新

### 规则
- 只更新文档——不要改动代码行为
- JSDoc 保持简洁：@param、@returns、简短描述
- 不要加重复代码内容的冗余注释`,
    defaultMaxTokens: 8192,
    defaultTimeoutMs: 600_000,
    defaultKind: 'patch_proposal',
    tierLock: 'cheap',
    builtIn: true,
  },
  {
    name: 'type_fixer',
    role: 'hands',
    allowedTools: ['read_file', 'edit_file', 'bash'],
    expertisePrompt: `你是类型修复者。运行 TypeScript 编译器并修复类型错误。

### 流程
1. 运行：\`npx tsc --noEmit 2>&1\` 拿全部类型错误
2. 对每条错误，读文件并应用最小修复
3. 重跑 tsc 确认修复解决错误且未引入新错误

### 修复策略（按优先级）
- 补缺失的类型标注
- 修正错误的类型收窄
- 给接口补缺失的属性
- 类型断言只作最后手段（并说明原因）

### 规则
- 只修类型——不要改动运行时行为
- 类型错误暴露了逻辑 bug 时，作为升级报告而不是修`,
    defaultMaxTokens: 8192,
    defaultTimeoutMs: 600_000,
    defaultKind: 'patch_proposal',
    tierLock: 'cheap',
    builtIn: true,
  },
  {
    name: 'format_checker',
    role: 'readonly',
    allowedTools: ['read_file', 'bash', 'grep'],
    expertisePrompt: `你是格式检查者。检查代码格式并报告违规，不修复。

### 流程
1. 以检查模式运行项目格式化器（如 \`npx prettier --check <files>\`）
2. 解析输出，识别有格式违规的文件
3. 报告：文件路径、违规类型、行号（如有）

### 规则
- 不要修改任何文件——只做只读检查
- 以结构化格式报告结果，交由主控 agent 决定动作`,
    defaultMaxTokens: 4096,
    defaultTimeoutMs: 60_000,
    defaultKind: 'review',
    tierLock: 'cheap',
    builtIn: true,
  },
]

export class ProfileRegistry {
  private profiles = new Map<string, ProfileDefinition>()

  constructor() {
    for (const p of BUILTIN_PROFILES) {
      this.profiles.set(p.name, p)
    }
  }

  /** 从 .rivet/agents/ 目录加载用户自定义 profile */
  async loadFromDirectory(dir: string): Promise<{ loaded: string[]; errors: string[] }> {
    const loaded: string[] = []
    const errors: string[] = []
    try {
      const { readdirSync } = await import('node:fs')
      const { join } = await import('node:path')
      const files = readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md')
      for (const file of files) {
        try {
          const { readFileSync } = await import('node:fs')
          const content = readFileSync(join(dir, file), 'utf-8')
          const def = parseAgentMarkdown(content)
          if (this.profiles.has(def.name) && this.profiles.get(def.name)!.builtIn) {
            errors.push(`${file}: cannot override built-in profile "${def.name}"`)
            continue
          }
          this.profiles.set(def.name, { ...def, builtIn: false })
          loaded.push(def.name)
        } catch (e) {
          errors.push(`${file}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    } catch {
      // directory doesn't exist — that's fine
    }
    return { loaded, errors }
  }

  get(name: string): ProfileDefinition | undefined {
    return this.profiles.get(name)
  }

  list(): ProfileDefinition[] {
    return [...this.profiles.values()]
  }

  listByRole(role: AgentRole): ProfileDefinition[] {
    return this.list().filter(p => p.role === role)
  }

  listWriteProfiles(): string[] {
    return this.listByRole('hands').map(p => p.name)
  }

  listReadOnlyProfiles(): string[] {
    return this.listByRole('readonly').map(p => p.name)
  }

  /** Get all known profile names (for validation) */
  getProfileNames(): string[] {
    return [...this.profiles.keys()]
  }
}

/** 解析 .rivet/agents/*.md 格式：YAML frontmatter + body as expertisePrompt */
function parseAgentMarkdown(content: string): ProfileDefinition {
  content = normalizeFrontmatterSource(content)
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!frontmatterMatch) throw new Error('Missing YAML frontmatter (--- delimiters)')

  const raw = frontmatterMatch[1]!
  const expertisePrompt = frontmatterMatch[2]!.trim()

  // Simple YAML parse for our flat schema
  const fm: Record<string, unknown> = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (m) {
      const key = m[1]!
      const val = m[2]!.trim()
      if (val.startsWith('[')) {
        try {
          fm[key] = JSON.parse(val.replace(/'/g, '"'))
        } catch {
          // Array parsing failed — report error instead of silently corrupting
          throw new Error(`Failed to parse array for field "${key}": "${val}". Use JSON array syntax: ["item1", "item2"]`)
        }
      } else {
        fm[key] = val
      }
    }
  }

  // Validate required fields
  if (typeof fm.name !== 'string' || !fm.name) throw new Error('Missing required field: name')
  if (fm.role !== 'brain' && fm.role !== 'hands' && fm.role !== 'readonly' && fm.role !== 'readonly_plus_test') {
    throw new Error(`Invalid role "${String(fm.role)}". Must be: brain, hands, readonly, or readonly_plus_test`)
  }
  if (!Array.isArray(fm.tools) || fm.tools.length === 0) {
    throw new Error('tools must be a non-empty array')
  }

  return {
    name: fm.name,
    role: fm.role as AgentRole,
    allowedTools: fm.tools as string[],
    expertisePrompt,
    defaultKind: typeof fm.defaultKind === 'string' ? fm.defaultKind : undefined,
    defaultMaxTokens: typeof fm.maxTokens === 'number' ? fm.maxTokens
      : typeof fm.maxTokens === 'string' ? (Number(fm.maxTokens) > 0 ? Number(fm.maxTokens) : undefined)
      : undefined,
  }
}

/** 全局单例 */
export const profileRegistry = new ProfileRegistry()

/** Tools that write files or run state-changing commands — used to classify a
 *  worker profile as write/execute-capable (vs a pure read-only scout). */
const WRITE_CAPABLE_TOOLS: ReadonlySet<string> = new Set([
  'write_file', 'edit_file', 'hash_edit', 'apply_patch', 'ast_edit', 'bash', 'run_tests', 'git',
])

/** Tools that edit tracked files — the criterion for galaxy 文件归属 (B).
 *  bash/run_tests 有执行权但不改文件，不算文件写权：持有它们的 profile
 *  可以并行读同一快照，不参与写维度文件认领。 */
const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'write_file', 'edit_file', 'hash_edit', 'apply_patch', 'ast_edit', 'git',
])

/** Whether a delegate profile can edit files (vs. merely execute commands).
 *  Unknown profiles → false. Distinct from profileIsWriteCapable, which also
 *  counts bash/run_tests — that one guards plan mode; this one guards
 *  file-ownership in galaxy/team 编排。 */
export function profileCanEditFiles(name: string): boolean {
  const def = profileRegistry.get(name)
  if (!def) return false
  return def.allowedTools.some(t => FILE_EDIT_TOOLS.has(t))
}

/**
 * Whether a delegate profile can write files or execute state-changing commands.
 * Unknown profiles → false (the delegate tool's own schema rejects them with a
 * clearer "Unknown profile" error; plan-mode need not double-report). Used by the
 * plan-mode gate to allow only read-only scouts during planning.
 */
export function profileIsWriteCapable(name: string): boolean {
  const def = profileRegistry.get(name)
  if (!def) return false
  return def.allowedTools.some(t => WRITE_CAPABLE_TOOLS.has(t))
}

/**
 * Whether a delegate profile may run during plan mode. Read-only scouts always
 * qualify; `run_tests` is additionally tolerated — 瑶光反证 requires the plan
 * phase to REPRODUCE claims (run the failing test, probe the assertion), and
 * run_tests executes the project's test suite without patching source. Any
 * profile holding a real write/execute tool (bash, edit_file, git, …) stays
 * blocked until the plan is approved. Unknown profiles → safe (delegate tool
 * schema rejects them with a clearer error).
 */
export function profileIsPlanModeSafe(name: string): boolean {
  const def = profileRegistry.get(name)
  if (!def) return true
  return def.allowedTools.every(t => !WRITE_CAPABLE_TOOLS.has(t) || t === 'run_tests')
}

/**
 * P0 超时对齐：delegate 工具层超时 = max(阶梯, 各 profile 预算) + 宽限。
 *
 * worker 内部预算（work-order.budget.timeoutMs）回退顺序是
 * profile.defaultTimeoutMs → progressiveTimeout(sessionTurn)；外层工具超时
 * 必须覆盖同一来源并加 WORKER_EXIT_GRACE_MS，否则外层先开枪 reject 整个
 * delegate 调用，worker 的 blocked+partial-output 收尾路径永远走不到
 * （reviewer/planner 600s 预算曾因此在 180s 工具超时下完全死接线）。
 */
/** Default worker pool concurrency (mirrors bootstrap `maxWorkers: 3`). */
export const DEFAULT_DELEGATE_CONCURRENCY = 3

/**
 * tierFloor → worker 超时倍率（单点事实源）。
 * strong 模型单次推理天然更慢（DeepSeek V4 strong ≈ 1.4–1.6x），
 * 不加倍率的话 worker 内层 budget.timeoutMs 会先于模型完成开枪。
 * 所有消费 timeout 的路径（delegationToolTimeoutMs、work-order budget
 * 构造、galaxy 外层）从此处取值，不散落硬编码系数。
 */
const TIER_TIMEOUT_MULTIPLIER: Record<string, number> = {
  cheap: 1.0,
  balanced: 1.0,
  strong: 1.5,
}

export function tierTimeoutMultiplier(tierFloor?: string): number {
  if (!tierFloor) return 1.0
  return TIER_TIMEOUT_MULTIPLIER[tierFloor] ?? 1.0
}

export function delegationToolTimeoutMs(
  sessionTurnCount: number | undefined,
  profiles: ReadonlyArray<string | undefined>,
  opts?: { taskCount?: number; maxWorkers?: number; requestedTimeoutMs?: ReadonlyArray<number | undefined>; tierFloors?: ReadonlyArray<string | undefined> },
): number {
  let budget = progressiveTimeout(sessionTurnCount)
  for (const name of profiles) {
    const profileBudget = name ? profileRegistry.get(name)?.defaultTimeoutMs : undefined
    if (profileBudget && profileBudget > budget) budget = profileBudget
  }
  // 按次预算（delegate_task/batch 的 timeoutMs）直接进 WorkOrder.budget.timeoutMs，
  // 外层不跟着放宽的话，主控调大的内层预算会被外层先开枪打断——按次预算就成了摆设。
  for (const requested of opts?.requestedTimeoutMs ?? []) {
    if (requested && requested > budget) budget = requested
  }
  // P0: a bounded worker pool runs a batch in sequential waves. A 5-task batch
  // on a 3-worker pool needs ceil(5/3)=2 waves, so the outer tool timeout must
  // cover ALL waves of the slowest single-task budget — otherwise it pre-empts a
  // later wave with a hard reject and orphans those workers (no blocked/partial
  // result salvage). Scaling by waves (not total task count) avoids over-inflating
  // the ceiling while still never firing before the pool can drain.
  const taskCount = Math.max(1, Math.floor(opts?.taskCount ?? profiles.length ?? 1))
  const maxWorkers = Math.max(1, Math.floor(opts?.maxWorkers ?? DEFAULT_DELEGATE_CONCURRENCY))
  const waves = Math.max(1, Math.ceil(taskCount / maxWorkers))
  // 预算耗尽会触发自动续跑（worker-continuation），每次续跑是一次全新的
  // runWorker，各自带一份完整 budget.timeoutMs。外层不按最坏运行次数放宽的话，
  // 续跑必然撞上工具层硬 reject，连首轮的 partial 都一起丢——正是本函数上方
  // 那段注释警告过的失败形状。
  //
  // 判据取「只有确定全是写工才按写工算」而不是反过来：profile 在 delegate 工具层
  // 是可选的，模型省略时这里收到 undefined，而实际 worker 会落到默认的只读
  // code_scout——按「有已知只读工才放宽」写，恰好在最常见的默认场景下不放宽。
  // 放宽过头只是把天花板抬高（真正的卡死判定归静默探测），收紧过头会丢 partial。
  //
  // 写工的额外轮次比只读工还多：Wave 7 起 runHandsSession 会在同一个工作树里续跑，
  // 与 JSON 解析修复、写闸门修复共用 MAX_HANDS_EXTRA_RUNS 的总账，每一轮都是一次
  // 带完整 timeoutMs 的 runWorker。
  const allHands = profiles.length > 0
    && profiles.every(name => name !== undefined && profileRegistry.get(name)?.role === 'hands')
  const runs = allHands ? 1 + MAX_HANDS_EXTRA_RUNS : 1 + MAX_BUDGET_CONTINUATIONS

  // tierFloor 超时倍率——取批内最大倍率（与 budget 取 max 同逻辑）。
  let tierMul = 1.0
  for (const tf of opts?.tierFloors ?? []) {
    const m = tierTimeoutMultiplier(tf)
    if (m > tierMul) tierMul = m
  }
  return budget * tierMul * waves * runs + WORKER_EXIT_GRACE_MS
}
