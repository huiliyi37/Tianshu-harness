/**
 * 行动意图检测器：判断模型是否"宣布了行动但未发出（对应的）工具调用"。
 *
 * 从已删除的 phantom-continuation.ts（abdbd6b2）中提取纯检测逻辑——
 * 只检测，不做决策，不绑定 budget/contract/continue 语义。
 * 消费方：turn-orchestrator 的 no-tool 路径（hasActionIntent）与
 * 只读工具轮路径（hasWriteActionIntent + turnUsedOnlyReadTools，
 * spec 2026-07-05-action-intent-readonly-gate）。
 */

import { profileIsWriteCapable } from './profile-registry.js'

/**
 * 行动承诺标记——"让我…""接下来…""let me…"等，暗示模型打算做某事。
 * 来源：phantom-continuation.ts ACTION_PROMISE_PATTERN + 新增中文变体。
 */
const ACTION_PROMISE_PATTERN =
  /(让我|接下来|现在(?:就)?|下一步|稍后|我来(?!自|了|不|过)|我去|我先|这就|马上|i'?ll\b|i will\b|let me\b|let's\b|going to\b|next[,，]?\s*i|now i)/i

/**
 * 工具动词——模型描述打算使用的工具或操作。
 * 来源：phantom-continuation.ts TOOL_VERB_PATTERN，去掉了"看"（太常见，误报高）；
 * 后补"重写/更新/写入"等写动作词（4df36bcd 系列：宣布"更新计划"未命中旧模式）。
 * 名词性「更新」豁免（2026-09-09 现场）："更新说明/更新日志"是 UI 文案与文档
 * 指称，不是写动作——报告句「应用内"更新说明"现在拿不到 3.16.0 的内容」里
 * 它与时间状语"现在"同分句配对成立，no-tool 轮被误注入 reminder。
 */
/**
 * 写侧动作词表（单一来源，2026-09-09 审查重构）——写侧承诺 / 祈使句首 / 工具
 * 动词三处共用。这三处原本各写一份，实测抓到漂移：「部署/构建/安装/重启/验证」
 * 只在祈使表里、「删除/落地/加上/补上」只在写侧表里，导致同一句「接下来部署到
 * staging」在两条闸门上结果相反（祈使路径真、写侧假）。新增写动词只改这一处。
 */
const WRITE_VERB_STEMS = [
  '修改', '编辑', '重写', '更新(?!说明|日志|记录|内容|公告|历史|列表|详情|检查)',
  '写入', '写文件', '写一下', '写测试', '修复', '实现', '重构', '落地',
  '删除', '删掉', '改一下', '改掉', '改(?!动|天|名|善|变|版|期|口|正|进)', '加上', '补上',
  '构建', '部署', '安装', '重启', '验证',
] as const

/** 句首祈使专用（不进写侧承诺表）：裸动词，以及「提交」（有独立名词语境判别）。 */
const IMPERATIVE_EXTRA = ['跑', '运行', '执行', '提交', '修(?:改|正|好|一下|掉|\\s)'] as const

/** 工具动词（工具轮判定，含读操作与通用动作）。 */
const TOOL_VERB_STEMS = [
  'grep', 'ripgrep', 'read', 'edit', 'write', 'run', 'test', '(?<!Git\\s)bash',
  'cat', 'ls', 'glob', 'fetch', 'curl', '查(?:看|找|阅)?', '搜索', '读取?',
  '跑(?:一?下|测试)?', '运行', '执行', '看(?:一?下)?(?:代码|文件)',
] as const

const TOOL_VERB_PATTERN =
  new RegExp(`(${[...TOOL_VERB_STEMS, ...WRITE_VERB_STEMS].join('|')})`, 'i')

/**
 * 写侧动词——承诺的是写入/修改/测试类操作（区别于"查/搜/读"的只读调研）。
 * 只读工具轮的闸门只认写侧承诺：模型说"让我看看这个文件"并 read_file 是
 * 正常调研，不该被提醒；说"更新计划"却只发 grep 才是要拦的失败模式。
 */
const WRITE_VERB_PATTERN =
  new RegExp(`((?:edit|write|fix|patch|apply|commit|rewrite|update|implement|refactor)(?![a-z])|run\\s+(?:the\\s+)?tests?|typecheck|${WRITE_VERB_STEMS.join('|')}|跑(?:一?下)?\\s*(?:测试|typecheck)|运行测试|执行测试)`, 'i')

/**
 * 动词性「提交」——裸「提交」从 WRITE_VERB_PATTERN 移出：名词用法（"最近提交"
 * 指git记录、"上一轮提交里"指某次提交的内容）与动词无法在词级区分（2026-09
 * 会话现场："现在读核心文档…最近提交又提到 3.15.0"被判写侧承诺，只读轮闸门
 * 误fire）。名词语境双向判别（2026-09-09 审查补全，替代单向清单）：
 *  - 后置成分：后面紧跟 记录/日志/历史/列表/信息/…/的 是指称性定语（"看看
 *    提交记录""一次提交的内容"），前字清单挡不住的形态由它兜住；
 *  - 前字清单扩到 次码该首每笔条这那（"最近一次提交""代码提交""首次提交"）。
 * "接下来提交这些改动""我现在提交"仍触发。
 */
const WRITE_COMMIT_VERB_RE =
  /(?<![近史前轮本已的录笔次码该首每笔条这那])提交(?!(?:记录|日志|历史|列表|信息|时间|次数|哈希|备注|说明|单号|状态|统计|的))/

/**
 * 承诺词紧邻修饰的「更新 X」——动宾真承诺，名词豁免不适用（2026-09-09 审查
 * 补全）。a5dc38a2e 的名词豁免只该挡指称形态（报告句里的 UI 文案/文档名，
 * 如「"更新说明"现在拿不到内容」）；「我来更新日志」「接下来更新内容」是
 * 标准动宾承诺，词级清单分不出宾语位还是指称位——按语法角色放行：承诺词
 * 紧邻动词前 = 行动宣告。紧邻要求天然排除报告句：原案例里"现在"前邻的是
 * "拿不到"而非"更新"。豁免清单（可以让我/要不要我…ADVISORY）优先级更高，
 * 提议形态仍不触发。
 */
const PROMISE_PREFIXED_VERB_RE = /(?:我来|我去|我先|这就|马上|接下来|下一步|我会|我将|让我)更新/

/**
 * 祈使收尾：最后一句以裸动作动词开头、无任何承诺词（4df36bcd：
 * 「全部正确。跑 typecheck + 测试。」——没有"让我/接下来"，旧模式漏检，
 * turn 被判 natural-finish 直接收尾）。约束：
 *  - 只看最后一句（。！？!?\n 切分），且句长 ≤ 80 字符（长句多为陈述）；
 *  - 句内含完成态标记（了/已/通过/done…）视为汇报而非承诺，不触发。
 */
/** 句首祈使/承诺前缀（单一来源，IMPERATIVE / TOPIC 共用）。 */
const ACTION_PREFIXES = ['先', '再', '然后', '接着', '继续', '马上', '立即', '下面', '现在', '接下来'] as const

/** 祈使/话题守卫共用的句首动词集合。 */
const IMPERATIVE_VERB_ALT = [...IMPERATIVE_EXTRA, ...WRITE_VERB_STEMS].join('|')

const IMPERATIVE_HEAD_RE =
  new RegExp(`^(?:(?:${ACTION_PREFIXES.join('|')})\\s*)?(?:${IMPERATIVE_VERB_ALT}|(?:re)?run(?![a-z])|fix(?![a-z])|update(?![a-z])|rewrite(?![a-z])|commit(?![a-z])|build(?![a-z])|deploy(?![a-z])|verify(?![a-z]))`, 'i')

/**
 * 话题/陈述句守卫（祈使收尾路径专用）——句首动词接名词化标记时，整句是在
 * 谈论某个话题，不是祈使命令。2026-09-09 全分支扫描：20 条话题句中 16 条被
 * 祈使路径误判（"修复针对的…""提交记录里…""构建产物的时间是…"），14 条真
 * 祈使句全部正确。两类标记：
 *  ① 动词后紧跟名词化后缀（针对/相关/方案/记录/历史/…）；
 *  ② 动词后 8 字符内出现「的」且「的」后紧跟抽象中心语——"跑测试的时间太长"
 *     命中；"更新配置的默认值"不命中（中心语是具体对象，整句是动宾结构）。
 *     2026-09-09 审查修复：原判据只看「的」是否落在 8 字符内，把"更新配置的
 *     默认值""修改文档里的示例""重构 utils 的接口"这类短宾语真祈使句全部吞掉
 *     （探针实测 6 条全漏）。距离分不开两类——"跑测试的"的「的」在第 4 字符、
 *     "更新配置的默认值"的「的」在第 5 字符——所以改看中心语。白名单只收抽象
 *     名词；「说明/内容/方案/记录/历史」已在①的名词化后缀里，再作中心语白名单
 *     会反噬真祈使句（"重写这一节的说明"），故不收。
 */
const NOMINAL_SUFFIXES = [
  '针对', '相关', '方案', '记录', '历史', '说明', '日志', '内容', '涉及',
  '方面', '思路', '策略', '流程', '范围', '原因', '版本', '方式', '状态',
] as const

const ABSTRACT_HEADS = [
  '时间', '方式', '原因', '情况', '问题', '版本', '状态', '开销', '限制',
  '行为', '环境', '配置', '改动', '成本', '代价', '收益', '影响', '边界',
  '条件', '结论', '定义',
] as const

const TOPIC_STATEMENT_RE =
  new RegExp(`^(?:(?:${ACTION_PREFIXES.join('|')})\\s*)?(?:${IMPERATIVE_VERB_ALT}|(?:re)?run(?![a-z])|fix(?![a-z])|update(?![a-z])|rewrite(?![a-z])|commit(?![a-z])|build(?![a-z])|deploy(?![a-z])|verify(?![a-z]))(?:(?:${NOMINAL_SUFFIXES.join('|')})|[^。！？!?\\n]{0,8}的(?:${ABSTRACT_HEADS.join('|')}))`, 'i')

const COMPLETION_MARKER_RE =
  /(了|已|完成|完毕|通过|失败|成功|中断|报错|生效|即可|✓|✗|done\b|passed\b|failed\b|finished\b)/i

/**
 * 强完成标记（同句共现路径专用）——"已完成/提交成功/通过了"等明确的完成态
 * 汇报。与 COMPLETION_MARKER_RE 的区别：不含单字"了"（"改好了之后"是计划
 * 描述），且用"已+动词"组合而非单字"已"（"已确认的问题"是名词短语）。
 * 描述过去操作的句子（"上一轮已完成 write_file"）不是悬空承诺。
 */
const STRONG_COMPLETION_RE =
  /(?:已(?:完成|提交|写完|修复|更新|修改|通过)|完成了?|完毕|提交成功|通过了?|成功|done\b|finished\b|passed\b)/i

/**
 * 前置条件等待——承诺依赖用户/外部动作（"登录后""等你确认后"），
 * 是等待行为而非悬空承诺（误报现场：wrangler 未登录时承诺"登录后我来执行"）。
 * 等待语义必须**同句完整**：等待词 + 后续承诺词（我再/我就/我来/我会）同句共现
 *（间隔 ≤40 字符且不含逗号——"你跑 X，我来改 Y"逗号连接是分工句式，不是等待）
 * 才生效——"你跑一下 typecheck。我来修改 loop.ts"跨句，"我来修改"是真实承诺，
 * 不被吞（c522132a4 审查反例；逗号边界为 88a5fb8b1 审查 MEDIUM）。
 */
const PRECONDITION_WAIT_RE =
  /(?:登录后|确认后|批准后|审核后|等你(?:的)?(?:确认|回复|消息|决定|反馈|拍板)|待(?:你|其)?确认|你(?:先|来)?(?:跑|执行|操作|做|登录|确认|回复))[^。！？!?，,\n]{0,40}?(?:我再|我就|我来|我(?:才)?会)/i

/**
 * 决策权交还——尾句把决定权交回用户（"你定""等你拍板"），不是悬空承诺。
 */
const DECISION_HANDOFF_RE =
  /(?:你定|你(?:来|说)?(?:决定|拍板|确认|回复|选择)|等你(?:决定|确认|回复|消息)|你说了算|你看(?:着办|怎么|要不要|是否可以)|由你(?:决定|来定))/i

function lastSentence(text: string): string {
  const parts = text.split(/[。！？!?\n]+/)
  for (let i = parts.length - 1; i >= 0; i--) {
    const s = parts[i]!.trim()
    if (s.length > 0) return s
  }
  return ''
}

/** 按句切分（。！？!?\n），返回非空句子列表。 */
function splitSentences(text: string): string[] {
  return text.split(/[。！？!?\n]+/).map(s => s.trim()).filter(s => s.length > 0)
}

/**
 * 承诺词与工具动词是否在同一句内共现。
 *
 * 回归（2026-08-08）：旧逻辑对承诺词与工具动词各自在全文（尾部 600 字符）匹配，
 * 跨句共现即判定——总结/列举类文本里"现在/让我"与"读/写/查看"分属不同句子时
 * 被误判为悬空行动承诺（"你现在应该看到…"+"UIA 读不到…"），纯总结轮被连续
 * 注入 action-intent reminder。承诺关系必须落在同一句内：
 * "接下来修改 loop.ts" 是承诺（同句），
 * "我现在汇报结果。之前我读取了那个文件" 是陈述（跨句）。
 */
/**
 * 分句切分：句内再按逗号/顿号/分号切——与 PRECONDITION_WAIT_RE 的既有纪律
 * 一致（逗号连接是分工句式，不是同一承诺单元）。承诺词与工具动词分属同句
 * 内不同分句时（"现在读核心文档…，最近提交又提到…"），配对不成立。
 */
function splitClauses(sentence: string): string[] {
  return sentence.split(/[，,、；;]+/).map(s => s.trim()).filter(s => s.length > 0)
}

/** 分句内是否含写侧动词（WRITE_VERB 或动词性「提交」）。 */
function clauseHasWriteVerb(clause: string): boolean {
  return WRITE_VERB_PATTERN.test(clause) || WRITE_COMMIT_VERB_RE.test(clause)
}

function hasSameSentencePair(
  text: string,
  promisePattern: RegExp,
  verbPattern: RegExp,
): boolean {
  for (const sentence of splitSentences(text)) {
    for (const clause of splitClauses(sentence)) {
      if (!promisePattern.test(clause)) continue
      const verbHit =
        (verbPattern === WRITE_VERB_PATTERN
          ? clauseHasWriteVerb(clause)
          : verbPattern.test(clause))
        // 承诺词紧邻的「更新 X」按动宾承诺放行（名词豁免的语法角色补全）
        || PROMISE_PREFIXED_VERB_RE.test(clause)
      // 同分句含强完成标记 → 完成态汇报（"上一轮已完成 write_file"）而非悬空承诺
      // 同分句是提议/建议/列举语境 → 把选项交回用户，非承诺（2026-09-09）
      if (
        verbHit
        && !STRONG_COMPLETION_RE.test(clause)
        && !ADVISORY_CLAUSE_RE.test(clause)
      ) return true
    }
  }
  return false
}

/** 尾句是否为祈使式行动宣布（动词开头、非完成态汇报、非问句）。 */
export function hasImperativeActionTail(text: string): boolean {
  if (!text) return false
  const tail = text.length > 600 ? text.slice(-600) : text
  // Questions are inquiries, not imperatives — "要我实施吗？" is asking,
  // not declaring an action to take.
  if (/[？?]$/.test(tail.trimEnd())) return false
  const sentence = lastSentence(tail)
  if (!sentence || sentence.length > 80) return false
  // 话题/陈述句守卫：句首动词接名词化标记（"修复针对的…""编辑器的配置"）
  if (TOPIC_STATEMENT_RE.test(sentence)) return false
  return IMPERATIVE_HEAD_RE.test(sentence) && !COMPLETION_MARKER_RE.test(sentence)
}

/**
 * 交付/收尾信号——全文级别（非仅尾句或尾部 600 字符）。
 * 当文本整体是测试报告、交付总结或任务完成声明时，
 * 即使中间某个句子形似祈使命令（"再跑 X"），也不应视为行动意图。
 * 来源：交付总结含 ✓/passed/任务完成 时被 action-intent gate 误判的回归。
 */
export const DELIVERY_SIGNAL_RE =
  /(?:typecheck\s*[✓✗]|^\d+\s*passed|^\d+\/\d+\s*[✓✗]|任务完成[，。]|交付[。！]|commit\s+[0-9a-f]{7}|^[✓✗]\s|(?:^|\n)>?\s*(?:fix|feat|refactor|test|chore|docs|perf)[(:]\s|提交\s*[0-9a-f]{7}|^\d+\s*\/\s*\d+\s*(?:个|项)?(?:测试)?通过)/mi

/**
 * 提议/建议/列举语境——把选项或决定权交回用户，不是模型自己的行动承诺。
 * 2026-09-09 探针实测的三条误触发都经「承诺词 × 工具动词」同分句配对命中：
 * 「随时可以让我跑 typecheck」（提议）、「建议下一步跑一下测试」（建议）、
 * 「接下来可以做的事：更新文档」（列举）。豁免做在**分句级**——只压承诺词
 * 所在分句的语境，同句别处的"建议"不吞真承诺（"建议下一步更新文档"豁免，
 * "接下来更新文档"仍触发）。
 */
const ADVISORY_CLAUSE_RE =
  /(?:随时(?:都)?可以让我|可以让我|要不要我|需要的话(?:我|可以)|如需我|(?:^|我)建议|(?:^|我)推荐|接下来(?:可以|要|需要)?做(?:的)?(?:事|工作|选项)|可以做的事|可选(?:项)?[:：]|待办[:：])/i

/**
 * 条件/否定前缀——在行动承诺词附近出现了"除非""不需要""不必"等时，
 * 是假设性/否定性表述（"除非你想让我也审查 X"），不是真正的行动承诺。
 * 只看承诺词之前的前缀窗，两支分开（2026-09-09 审查修复）：
 *  - 否定词（不需要/不必/不用/无需/没必要/没打算）只认紧邻——≤20 字符且
 *    字符类排除逗号。理由与同文件 PRECONDITION_WAIT_RE 一致（"逗号连接是
 *    分工句式"）："不需要改，我来更新 loop.ts" 否定的是宾语、承诺是模型
 *    自己的，属真承诺，不该被当假设句吞掉。
 *  - 假设连词（除非/如果/若）保留长窗且允许跨逗号——"不需要改，除非你想让
 *    我也查一下 X" 的承诺确实挂在假设条件下。
 * 合一版本的前缀窗跨逗号，把分工句整段判为假设句：探针实测 8 条样本
 * 4/8 正确 → 拆分后 7/8（余下 1 条根因在 WRITE_VERB_PATTERN 缺裸「改」，
 * 不在本守卫职责内）。
 */
const CONDITIONAL_PREFIX_RE = /(?:(?:不需要|不必|不用|无需|没必要|没打算)\s*[^。！？!?，,\n]{0,20}?(?:让我|接下来|现在|我来|我[先去])|(?:除非|如果|若)\s*[^。！？!?\n]{0,150}?(?:让我|接下来|现在|我来|我[先去]))/i

/**
 * 检查文本尾部是否宣布了行动：显式承诺（"让我…"+工具动词）或祈使收尾。
 * 只看尾部 600 字符——行动承诺（如果有）通常在回复结尾。
 */
export function hasActionIntent(text: string): boolean {
  if (!text) return false
  const tail = text.length > 600 ? text.slice(-600) : text
  // 问句收尾守卫：整轮以问句收尾 = 把控制权交还用户（请求决策/许可），不是
  // 悬空的行动承诺——即便尾部同时出现承诺词与工具动词。此守卫原本只装在
  // hasImperativeActionTail 上，承诺词路径漏了：ca63f970 实测「……或你指定某组
  // 文件我来读……哪条？」被"我来"+"读"命中，注入 reminder 后模型被迫续跑，
  // 用户视角凭空多出一轮。无论问的是方向（"哪条？"）还是许可（"要我跑吗？"），
  // 正确行为都是等用户回答，不该被推着自答自干。
  if (/[？?]$/.test(tail.trimEnd())) return false
  // 条件/否定守卫：尾部含"除非"等前缀时，即便命中了承诺词+工具动词，
  // 也属于假设性表述（如"不需要改，除非你想让我也查一下 X"），不应触发提醒。
  // 查全文尾部（600 字符），非仅 120——条件前缀可能离承诺词很远（引用中）。
  if (CONDITIONAL_PREFIX_RE.test(tail)) return false
  // 前置条件等待守卫：承诺依赖用户/外部动作（"登录后""等你确认后"）是等待行为
  if (PRECONDITION_WAIT_RE.test(tail)) return false
  // 决策权交还守卫：尾句把决定权交回用户（"你定"）不是悬空承诺
  if (DECISION_HANDOFF_RE.test(tail)) return false
  // 承诺检测优先于交付信号：交付信号不能吞掉同一窗口内的真实承诺
  //（c522132a4 过度修复反例："已提交 X。接下来我要重写 Y"——全文 DELIVERY
  //  短路把尾部承诺吞掉。先检承诺，无承诺时交付信号才兜底短路，且与承诺同窗）
  if (hasSameSentencePair(tail, ACTION_PROMISE_PATTERN, TOOL_VERB_PATTERN)) return true
  if (hasImperativeActionTail(text)) return true
  // 交付/收尾信号（与承诺检测同窗，尾部 600 字符）
  if (DELIVERY_SIGNAL_RE.test(tail)) return false
  return false
}

/**
 * 写意图变体：承诺的必须是写侧操作。用于只读工具轮的闸门——
 * 读侧承诺（"让我看看这个文件"）配 read_file 是正常调研，不算失配。
 */
export function hasWriteActionIntent(text: string): boolean {
  if (!text) return false
  const tail = text.length > 600 ? text.slice(-600) : text
  // 问句收尾守卫：同 hasActionIntent——收尾问句是在等用户，不是悬空写承诺。
  if (/[？?]$/.test(tail.trimEnd())) return false
  // 条件/否定守卫：同 hasActionIntent
  if (CONDITIONAL_PREFIX_RE.test(tail)) return false
  // 前置条件等待守卫：同 hasActionIntent
  if (PRECONDITION_WAIT_RE.test(tail)) return false
  // 决策权交还守卫：同 hasActionIntent
  if (DECISION_HANDOFF_RE.test(tail)) return false
  // 承诺检测优先于交付信号：同 hasActionIntent（交付汇报+尾部新承诺混合形态）
  if (hasSameSentencePair(tail, ACTION_PROMISE_PATTERN, WRITE_VERB_PATTERN)) return true
  if (hasImperativeActionTail(text)) return true
  // 交付/收尾信号（与承诺检测同窗，尾部 600 字符）
  if (DELIVERY_SIGNAL_RE.test(tail)) return false
  return false
}
/**
 * 会推进"写承诺"的工具——文件写入、状态变更命令、测试执行、计划/交付操作。
 * 故意用白名单（未知工具视为只读）：漏判的代价只是一次多余的 nudge，
 * 反向漏报则让闸门对新写工具静默失效。
 */
const WRITE_ADVANCING_TOOLS: ReadonlySet<string> = new Set([
  'write_file', 'edit_file', 'hash_edit', 'apply_patch', 'ast_edit',
  'bash', 'sandbox_exec', 'git', 'fastgit',
  'run_tests', 'jest', 'mocha', 'vitest',
  'plan', 'plan_task', 'undo', 'team_orchestrate', 'job', 'browser',
  'deliver_task', 'starflow', 'galaxy',
  'create_document', 'create_pdf', 'create_presentation', 'create_spreadsheet',
  'create_image', 'export_file',
])

/** delegate_task 单 profile / delegate_batch tasks[].profile（与 tool-pipeline 同构）。 */
function delegateProfiles(input: Record<string, unknown>): string[] {
  const names: string[] = []
  if (typeof input.profile === 'string') names.push(input.profile)
  if (Array.isArray(input.tasks)) {
    for (const task of input.tasks) {
      if (task && typeof task === 'object' && typeof (task as { profile?: unknown }).profile === 'string') {
        names.push((task as { profile: string }).profile)
      }
    }
  }
  return names
}

/**
 * 本轮工具是否全为只读（不推进任何写承诺）。委派算只读，除非派了
 * 写能力 profile（patcher 等）——派只读 scout 做调研同样不推进写操作。
 * 无工具轮返回 false：那是 no-tool 闸门的辖区，不归这里。
 */
export function turnUsedOnlyReadTools(
  toolUses: ReadonlyArray<{ name: string; input?: Record<string, unknown> }>,
): boolean {
  if (toolUses.length === 0) return false
  for (const tu of toolUses) {
    if (WRITE_ADVANCING_TOOLS.has(tu.name)) return false
    if ((tu.name === 'delegate_task' || tu.name === 'delegate_batch') && tu.input) {
      if (delegateProfiles(tu.input).some(profileIsWriteCapable)) return false
    }
  }
  return true
}
