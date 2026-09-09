import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasActionIntent,
  hasImperativeActionTail,
  hasWriteActionIntent,
  turnUsedOnlyReadTools,
} from '../action-intent-detector.js'

describe('hasActionIntent', () => {
  // ── True positives: 行动承诺 + 工具动词 ──
  it('检测"让我 grep 一下"', () => {
    assert.ok(hasActionIntent('让我 grep 一下 loop.ts 看看调用链'))
  })
  it('检测"接下来修改 turn-orchestrator.ts"', () => {
    assert.ok(hasActionIntent('接下来修改 turn-orchestrator.ts 的 no-tool 路径'))
  })
  it('检测"我来跑一下测试"', () => {
    assert.ok(hasActionIntent('我来跑一下测试确认改动没问题'))
  })
  it('检测"我现在读取文件"', () => {
    assert.ok(hasActionIntent('我现在读取 loop.ts 确认插入点'))
  })
  it('检测"let me read the file"', () => {
    assert.ok(hasActionIntent('let me read the file to check'))
  })
  it('检测"I\'ll run the tests"', () => {
    assert.ok(hasActionIntent("I'll run the tests now"))
  })
  it('检测"let\'s grep for the pattern"', () => {
    assert.ok(hasActionIntent("let's grep for the pattern"))
  })
  it('检测"going to edit that"', () => {
    assert.ok(hasActionIntent("I'm going to edit that file"))
  })
  it('检测"下一步查一下代码"', () => {
    assert.ok(hasActionIntent('下一步查一下代码'))
  })
  it('检测"这就修改"', () => {
    assert.ok(hasActionIntent('这就修改 loop.ts'))
  })
  it('检测"马上执行测试"', () => {
    assert.ok(hasActionIntent('马上执行测试'))
  })

  // ── True positives: 尾部匹配（长文本，行动承诺在最后 600 字符内） ──
  it('长文本尾部含行动承诺时检测成功', () => {
    const prefix = 'A'.repeat(2000)
    const tail = '让我 grep 一下'
    assert.ok(hasActionIntent(prefix + tail))
  })

  // ── True negatives: 无行动承诺 ──
  it('纯回答不含行动承诺', () => {
    assert.ok(!hasActionIntent('这个方案的核心思路是在 no-tool 路径上插入检查'))
  })
  it('只含工具动词不含行动承诺', () => {
    assert.ok(!hasActionIntent('你可以用 grep 搜索这个函数'))
  })
  it('只含行动承诺不含工具动词', () => {
    assert.ok(!hasActionIntent('让我想想这个问题'))
    assert.ok(!hasActionIntent('接下来我解释一下设计思路'))
    assert.ok(!hasActionIntent("let's search for the right approach"))
  })
  it('空字符串', () => {
    assert.ok(!hasActionIntent(''))
  })
  it('已完成任务的总结（不含行动承诺标记）', () => {
    assert.ok(!hasActionIntent('我已经完成了修改，以下是涉及的文件'))
  })
  it('完成态汇报不算写承诺（同句"已完成"+写动词）', () => {
    // 误报现场：描述过去操作（"上一轮完成了 write_file"）被同句共现路径当悬空承诺
    assert.ok(!hasWriteActionIntent('我这就汇报：上一轮完成了 write_file 和 edit_file，全部测试通过。'))
  })
  it('中文提交交付信号（提交 <hash>）', () => {
    // DELIVERY_SIGNAL_RE 只认英文 "commit <hash>"——中文交付报告漏保护。
    // 用完成态"已提交"（无歧义）；"接下来提交 <hash>"是未来时态承诺，不算交付。
    assert.ok(!hasWriteActionIntent('已提交 899d594d9。'))
  })
  it('交付汇报 + 尾部新承诺：承诺不被交付信号吞掉', () => {
    // 审查反例（c522132a4 过度修复）：DELIVERY 全文短路 vs 承诺尾部 600 窗口
    assert.ok(hasWriteActionIntent('已提交 899d594d9。接下来我要重写 loop.ts'))
    assert.ok(hasActionIntent('已提交 899d594d9。接下来我要重写 loop.ts'))
  })
  it('让用户验证 + 自己动手：承诺不被前置等待吞掉', () => {
    // 审查反例（c522132a4 过度修复）："你跑…"单独命中 PRECONDITION_WAIT_RE
    assert.ok(hasWriteActionIntent('你跑一下 typecheck。我来修改 loop.ts'))
  })
  it('逗号连接的同句分工句式：承诺不被前置等待吞掉', () => {
    // 88a5fb8b1 审查 MEDIUM：间隔字符类不排除逗号——"你跑 X，我来改 Y"同句
    // 命中等待守卫吞掉承诺（句号分隔已覆盖，逗号边界漏了）
    assert.ok(hasWriteActionIntent('你跑一下 typecheck，我来修改 loop.ts'))
  })
  it('带前置条件（登录后）的承诺是等待行为，不算悬空', () => {
    // 误报现场：wrangler 未登录，承诺"登录后我来执行"——等用户前置动作
    assert.ok(!hasActionIntent('登录后我来执行迁移和部署。'))
  })
  it('决策权交还（你定）不算承诺', () => {
    assert.ok(!hasActionIntent('只修①或全修，你定。'))
  })
  it('"Git Bash" 含 Bash 但不触发工具动词误配', () => {
    // 回归：Git Bash 是产品名，不是 bash 工具调用
    assert.ok(!hasActionIntent('让我看看 Git Bash 的探测逻辑'))
    // 但真正的 bash 工具调用仍然触发
    assert.ok(hasActionIntent('让我用 bash 跑一下测试'))
  })
  it('"我来自"不触发（出处陈述，非行动宣言）', () => {
    // 回归：10ecffa5 的误报——"我来自天枢星域" + "运行在 opencode-tui"
    assert.ok(!hasActionIntent('我来自天枢星域，是运行在 opencode-tui 终端编程代理中的 AI 助手'))
  })
  it('"我来了"不触发（到达陈述，非行动宣言）', () => {
    assert.ok(!hasActionIntent('我来了，正在运行测试环境'))
  })

  // ── 问句收尾守卫（ca63f970 回归）──
  // 收尾问句 = 把控制权交还用户，即便尾部同时出现承诺词与工具动词也不是悬空承诺。
  // 生产现场：报告以三选一收尾，「或你指定某组文件我来读」+「哪条？」被
  // "我来"+"读"命中，注入 reminder 后模型被迫自答自干，用户视角凭空多出一轮。
  it('三选一问句收尾不触发（ca63f970 现场文本）', () => {
    const text = [
      '**核心问题**：你想了解的是',
      '1. **整体状态**（已完成 + 正在做 + 待做）——这次报告已给你',
      '2. **未提交那 40 个文件的具体意图**——我建议点开最新两份分析文档，或你指定某组文件我来读',
      '3. **某条具体线索的深挖**——告诉我具体方向',
      '',
      '哪条？',
    ].join('\n')
    assert.ok(!hasActionIntent(text))
  })
  it('请求许可的问句不触发：「要我跑一下测试吗？」', () => {
    assert.ok(!hasActionIntent('改动完成待验证。要我跑一下测试吗？'))
    assert.ok(!hasActionIntent('Shall I run the tests now?'))
  })
  it('条件/否定前缀不触发：「除非你想让我也…」', () => {
    assert.ok(!hasActionIntent('不需要进一步工具调用，除非你想让我把 X 也一并审查'))
    assert.ok(!hasActionIntent('暂时不改了，除非你想让我也 grep 一下调用方'))
    assert.ok(!hasActionIntent('不必动这里，除非你想让我跑一下 typecheck'))
  })
  it('完成/生效类尾句不触发（用户操作指南，非模型行动承诺）', () => {
    assert.ok(!hasActionIntent('重启 agent 生效。'))
    assert.ok(!hasActionIntent('重新构建后即可。'))
  })
  it('问句在中间、承诺在结尾时仍触发', () => {
    assert.ok(hasActionIntent('这样对吗？先假设对。接下来修改 loop.ts'))
  })

  // ── 总结/列举句式误报回归（2026-08-08 现场：纯总结轮被连续注入 action-intent reminder）──
  // 根因：承诺词与工具动词各自在全文匹配即判定，跨句共现误报——
  // "你现在应该看到"（"现在"）与 "UIA 读不到"（"读"）分属不同句子，却判定为行动宣言。
  it('总结句式不触发：「你现在应该看到…」+「UIA 读不到…」跨句共现', () => {
    assert.ok(!hasActionIntent('状态判定：UIA 读不到 Electron 渲染内容，改用 OCR 识别截图。你现在应该看到：屏幕上的 QQ 主窗口，聊天列表正常显示。'))
  })
  it('总结句式不触发：「你的屏幕上现在应该有…」+「写入一段话…读回文本」跨句共现', () => {
    assert.ok(!hasActionIntent('完成。你的屏幕上现在应该有一个打开的 Word 窗口。新建文档，写入一段话（118 字），保存为 docx。保存后从 Word 读回文本，内容与写入一致。'))
  })
  it('列举能力选项不触发：「让我先看一下目录里有什么」+「查看或理解」', () => {
    assert.ok(!hasActionIntent('有什么需要我做的？比如：查看或理解这个目录下的某个项目、跑测试。先告诉我想做什么，或者让我先看一下目录里有什么。'))
  })
  it('跨句共现不触发：承诺词与工具动词分属不同句子', () => {
    assert.ok(!hasActionIntent('我现在把结果汇报完。之前我读取了那个文件，也写入了一段内容。'))
  })

  // ── 名词性「更新」误触发回归（2026-09-09 现场）──
  // 根因：报告句「应用内"更新说明"现在拿不到 3.16.0 的内容」里，"更新说明"是
  // UI 文案名词、"现在"是时间状语，却被 TOOL_VERB 的裸"更新"与承诺词"现在"
  // 同分句配对命中 → no-tool 轮注入 reminder（用户视角凭空多出一轮）。
  it('名词性「更新说明」+ 时间状语「现在」不触发（现场原句）', () => {
    assert.ok(!hasActionIntent('也就是说应用内"更新说明"现在拿不到 3.16.0 的内容。'))
    assert.ok(!hasWriteActionIntent('也就是说应用内"更新说明"现在拿不到 3.16.0 的内容。'))
  })
  it('名词性「更新日志/更新记录」不触发（祈使收尾路径）', () => {
    assert.ok(!hasActionIntent('更新日志里 3.16.0 出现 0 次。'))
    assert.ok(!hasActionIntent('更新记录里没有这一条。'))
  })
  it('动词性「更新文档/更新计划」仍触发（豁免不吞真承诺）', () => {
    assert.ok(hasActionIntent('接下来更新文档。'))
    assert.ok(hasWriteActionIntent('接下来更新文档。'))
    assert.ok(hasImperativeActionTail('更新计划，方向修正为源头量化 + 净删除'))
  })

  // ── 提议/建议/列举语境（2026-09-09 探针实测的三条误触发）──
  // 三者都经「承诺词 × 工具动词」同分句配对命中，但语义上是把选项交回用户，
  // 不是模型自己的行动承诺。豁免做在分句级：只压承诺词所在分句的语境，
  // 同句别处的"建议"不吞掉真承诺。
  it('提议语气不触发：「随时可以让我跑 typecheck」', () => {
    assert.ok(!hasActionIntent('随时可以让我跑 typecheck。'))
    assert.ok(!hasWriteActionIntent('随时可以让我跑 typecheck。'))
  })
  it('建议语气不触发：「建议下一步跑一下测试」', () => {
    assert.ok(!hasActionIntent('建议下一步跑一下测试。'))
    assert.ok(!hasActionIntent('我建议下一步更新文档。'))
  })
  it('列举语气不触发：「接下来可以做的事：更新文档」', () => {
    assert.ok(!hasActionIntent('接下来可以做的事：更新文档。'))
    assert.ok(!hasWriteActionIntent('接下来可以做的事：更新文档。'))
  })
  it('提议/建议/列举语境不吞真承诺', () => {
    assert.ok(hasActionIntent('接下来修改 loop.ts。'))
    assert.ok(hasWriteActionIntent('接下来更新文档。'))
    assert.ok(hasActionIntent('让我 grep 一下 loop.ts 看看调用链'))
  })

  // ── Edge cases ──
  it('仅"看"不触发（已从动词列表移除，误报太高）', () => {
    assert.ok(!hasActionIntent('让我看一下这个问题'))
  })
  it('"看一下代码"触发（含工具名词限定）', () => {
    assert.ok(hasActionIntent('让我看一下代码'))
  })
  it('无文本时不触发', () => {
    assert.ok(!hasActionIntent(''))
  })
  it('行动承诺在文本开头而非尾部时仍检测', () => {
    assert.ok(hasActionIntent('让我 edit loop.ts\n\n上面是我要做的修改'))
  })
})

describe('hasImperativeActionTail（动词开头的祈使收尾，4df36bcd）', () => {
  it('「全部正确。跑 typecheck + 测试。」触发（无承诺词、裸动词宣布）', () => {
    assert.ok(hasImperativeActionTail('全部正确。跑 typecheck + 测试。'))
    assert.ok(hasActionIntent('全部正确。跑 typecheck + 测试。'), 'hasActionIntent 应同步覆盖')
  })
  it('「更新计划，方向修正为源头量化 + 净删除」触发（spec T3 现场）', () => {
    assert.ok(hasImperativeActionTail('四条全核实完了。\n更新计划，方向修正为源头量化 + 净删除'))
  })
  it('「现在重写计划，修正方向」触发（spec T4 现场）', () => {
    assert.ok(hasImperativeActionTail('现在重写计划，修正方向：源头量化 + 净删除'))
  })
  it('完成态汇报不触发：「测试全部通过。」', () => {
    assert.ok(!hasImperativeActionTail('测试全部通过。'))
  })
  it('完成态汇报不触发：「跑了一遍 typecheck，没有错误。」', () => {
    assert.ok(!hasImperativeActionTail('跑了一遍 typecheck，没有错误。'))
  })
  it('非动词开头的陈述不触发', () => {
    assert.ok(!hasImperativeActionTail('这个方案的核心思路是在 no-tool 路径上插入检查'))
    assert.ok(!hasImperativeActionTail('我来了，正在运行测试环境'))
  })
  it('超长尾句不触发（长句多为陈述而非祈使）', () => {
    assert.ok(!hasImperativeActionTail('运行' + 'X'.repeat(100)))
  })
})

describe('hasImperativeActionTail 话题句误判（2026-09-09 全分支扫描）', () => {
  // 现场：以「修复」开头的陈述句「修复针对的两类形态是——…」被判为祈使收尾，
  // no-tool 轮被注入 reminder。全分支扫描：20 条话题句中 16 条误判，14 条真
  // 祈使句全部正确。判据见源码 TOPIC_STATEMENT_RE（名词化后缀 + 动词后 8 字符内「的」）。
  const TRUE_IMPERATIVES = [
    '跑 typecheck + 测试。',
    '运行测试套件。',
    '执行迁移脚本。',
    '修复 loop.ts 的空指针。',
    '重写计划文件。',
    '更新文档。',
    '编辑 config.ts。',
    '提交这些改动。',
    '构建产物。',
    '部署到 staging。',
    '安装依赖。',
    '重启服务。',
    '验证一下结果。',
    '重构 loop.ts。',
    // 2026-09-09 审查反向用例：TOPIC_STATEMENT_RE 的「动词后 8 字符内出现『的』」
    // 判据把这一类真祈使句全部吞掉（8e70ae3b4 引入的回归）。探针实测（同一份
    // 源码仅换版本）：修复前 true、8e70ae3b4 之后 false。间隔 3~6 字符的短宾语
    // 形态是原扫描样本的盲区——原样本唯一带「的」的「修复 loop.ts 的空指针」
    // 间隔 10 字符，正好落在阈值外，所以当时「14 条真祈使全部正确」。
    '更新配置的默认值。',
    '修改文档里的示例。',
    '重构 utils 的接口。',
    '重写这一节的说明。',
    '验证结果的正确性。',
    // 2026-09-09 清单单一来源重构：写侧动作表补全后祈使路径也认裸「改」与
    // 「删除」——此前这两个词只在写侧承诺表里，句首形态漏检（两条闸门判定相反）
    '删除冗余的导入。',
    '改这个文件。',
  ]
  const TOPIC_SENTENCES = [
    '修复针对的两类形态是——报告里出现这类名词。',
    '修复相关的讨论在另一份文档里。',
    '修复方案还没定。',
    '修复记录保存在日志里。',
    '提交记录里有三条。',
    '提交历史里的那次改动。',
    '构建产物的时间是三天前。',
    '验证相关的记录在文档里。',
    '运行时的开销需要关注。',
    '执行环境的限制。',
    '编辑器的配置。',
    '部署方案还没定。',
    '重启后的行为需要确认。',
    '重写相关的内容。',
    '重构涉及三个模块。',
    '跑测试的时间太长。',
  ]
  for (const sentence of TRUE_IMPERATIVES) {
    it(`真祈使仍触发：${sentence}`, () => assert.ok(hasImperativeActionTail(sentence)))
  }
  for (const sentence of TOPIC_SENTENCES) {
    it(`话题句不触发：${sentence}`, () => assert.ok(!hasImperativeActionTail(sentence)))
  }
})

describe('hasWriteActionIntent（只读轮闸门用的写侧承诺）', () => {
  it('「接下来修改 turn-orchestrator.ts」触发', () => {
    assert.ok(hasWriteActionIntent('接下来修改 turn-orchestrator.ts 的 no-tool 路径'))
  })
  it('「接下来重写计划文件」触发（spec 验证项）', () => {
    assert.ok(hasWriteActionIntent('接下来重写计划文件'))
  })
  it('「让我更新文档」触发（spec 验证项）', () => {
    assert.ok(hasWriteActionIntent('让我更新文档'))
  })
  it('祈使收尾同样触发：「跑 typecheck + 测试。」', () => {
    assert.ok(hasWriteActionIntent('全部正确。跑 typecheck + 测试。'))
  })
  it('读侧承诺不触发：「让我看看这个文件」（正常调研，配 read_file 是合法组合）', () => {
    assert.ok(!hasWriteActionIntent('让我看看这个文件'))
  })
  it('读侧承诺不触发：「让我 grep 一下 loop.ts」', () => {
    assert.ok(!hasWriteActionIntent('让我 grep 一下 loop.ts 看看调用链'))
  })
  it('纯陈述不触发', () => {
    assert.ok(!hasWriteActionIntent('这个函数的修改历史在 git log 里'))
  })
  it('问句收尾不触发（同 hasActionIntent 的 ca63f970 守卫）：「要我改吗？」', () => {
    assert.ok(!hasWriteActionIntent('方案已列出。我可以直接修改 loop.ts，要我改吗？'))
  })
  it('跨句共现不触发：承诺词与工具动词分属不同句子', () => {
    assert.ok(!hasWriteActionIntent('我现在把结果汇报完。之前修改了那个文件。'))
  })
  it('名词性「提交」不触发：现场文本（现在×最近提交，逗号分句）', () => {
    // 2026-09 会话现场：读侧承诺「现在读核心文档」+ 括号插入语里的名词
    // 「最近提交」（指 git 记录）被判为写侧承诺，只读轮闸门误 fire。
    assert.ok(!hasWriteActionIntent('顶层结构已见。现在读核心文档核实版本与定位（记忆里说 v3.14.0，最近提交又提到 3.15.0 回滚基线，需要以 package.json 为准）。'))
  })
  it('名词性「提交」不触发：同分句「现在看一下最近的提交记录」', () => {
    // 分句级配对防线不够——本句无逗号，「现在」与名词「提交记录」同分句。
    // 依赖名词语境豁免：紧邻前字「近」表明是名词指称。
    assert.ok(!hasWriteActionIntent('现在看一下最近的提交记录。'))
  })
  it('名词性「提交」不触发：上一轮提交里已经改过', () => {
    // 「上一轮提交」名词短语 + 「已经」完成态；「现在读取」是读侧承诺
    assert.ok(!hasWriteActionIntent('现在读取配置，上一轮提交里已经改过这里。'))
  })
  it('名词性「提交」不触发（后置成分判别）：现在看看提交记录', () => {
    // 2026-09-09 审查实测误杀：前字「看」不在清单，旧单向判别挡不住——
    // 「提交记录」是指称性定语结构，由后置成分豁免兜住
    assert.ok(!hasWriteActionIntent('现在看看提交记录。'))
  })
  it('名词性「提交」不触发（前字清单补全）：查最近一次提交的内容', () => {
    // 前字「次」+ 后置「的」双豁免（2026-09-09 审查实测误杀）
    assert.ok(!hasWriteActionIntent('现在查最近一次提交的内容。'))
    assert.ok(!hasWriteActionIntent('这次代码提交首次引入了新协议。'))
  })
  it('动宾真承诺不再被名词豁免吞掉：「我来更新日志」（承诺词紧邻放行）', () => {
    // 2026-09-09 审查实测假阴性：a5dc38a2e 的「更新日志」名词豁免把标准
    // 动宾承诺一并吞掉——闸门静默失效比误伤更危险。承诺词紧邻动词=行动宣告
    assert.ok(hasWriteActionIntent('我来更新日志。'))
    assert.ok(hasWriteActionIntent('接下来更新内容，把结论写进去。'))
  })
  it('报告句的名词「更新说明」仍不触发（紧邻要求排除非动词前邻）', () => {
    // a5dc38a2e 原案例不回归：「现在」前邻的是「拿不到」而非「更新」
    assert.ok(!hasWriteActionIntent('应用内"更新说明"现在拿不到 3.16.0 的内容。'))
  })
  it('动词性「提交」仍触发：「接下来提交这些改动」', () => {
    assert.ok(hasWriteActionIntent('接下来提交这些改动。'))
  })
  it('动词性「提交」仍触发：「我现在提交。」', () => {
    assert.ok(hasWriteActionIntent('我现在提交。'))
  })
  it('分工句的真写承诺不被条件前缀吞掉：「不需要改，我来更新 loop.ts」', () => {
    // 2026-09-09 审查反向用例：CONDITIONAL_PREFIX_RE 的前缀窗不排除逗号，与
    // 同文件 PRECONDITION_WAIT_RE（字符类明确排除逗号，注释「逗号连接是分工
    // 句式，不是等待」）及 hasSameSentencePair 的分句语义（按 [，,、；;] 切分）
    // 相矛盾——「否定 + 逗号 + 我来 X」被整体判为假设句，真承诺静默漏检。
    assert.ok(hasWriteActionIntent('不需要改，我来更新 loop.ts'))
    assert.ok(hasWriteActionIntent('没必要争论了，接下来我重写这一节'))
    assert.ok(hasWriteActionIntent('不必等我，我先修复空指针'))
  })
  it('假设句仍被条件前缀豁免（收紧逗号边界后不回归）', () => {
    assert.ok(!hasWriteActionIntent('不需要改，除非你想让我也查一下 X'))
    assert.ok(!hasWriteActionIntent('除非你想让我也审查 X'))
  })
  it('「接下来」与「马上/现在/接着」同权：写动词承诺两侧都触发', () => {
    // IMPERATIVE_HEAD_RE / TOPIC_STATEMENT_RE 的前缀组缺「接下来」（而
    // ACTION_PROMISE_PATTERN 含），叠加 WRITE_VERB_PATTERN 无「部署」——实测
    // 「接下来部署到 staging」两侧全漏、「马上部署到 staging」两侧全中。
    // 同动词同意图仅前缀不同而结果相反，属清单不同步而非设计。
    assert.ok(hasActionIntent('接下来部署到 staging。'))
    assert.ok(hasWriteActionIntent('接下来部署到 staging。'))
    assert.ok(hasActionIntent('接下来提交这些改动。'))
  })
  it('写侧动作表补全：裸「改」「删除」在承诺路径与祈使路径一致', () => {
    // 清单单一来源重构前：裸「改」只在写侧承诺表里（"我来改这个文件" 靠它），
    // 「删除」在写侧表但不在祈使表——同一动作两条闸门判定相反。重构后三处
    // 共用同一词表，句首形态与承诺形态一致。
    assert.ok(hasWriteActionIntent('我来改这个文件'))
    assert.ok(hasWriteActionIntent('不用你动手，我来改这个文件'))
    assert.ok(hasImperativeActionTail('删除冗余的导入。'))
    assert.ok(hasImperativeActionTail('改这个文件。'))
  })
})

describe('turnUsedOnlyReadTools', () => {
  it('无工具轮返回 false（归 no-tool 闸门管）', () => {
    assert.equal(turnUsedOnlyReadTools([]), false)
  })
  it('纯读工具轮返回 true', () => {
    assert.equal(turnUsedOnlyReadTools([
      { name: 'grep', input: {} },
      { name: 'read_file', input: {} },
      { name: 'glob', input: {} },
    ]), true)
  })
  it('含写工具返回 false', () => {
    assert.equal(turnUsedOnlyReadTools([
      { name: 'read_file', input: {} },
      { name: 'write_file', input: {} },
    ]), false)
    assert.equal(turnUsedOnlyReadTools([{ name: 'bash', input: {} }]), false)
    assert.equal(turnUsedOnlyReadTools([{ name: 'run_tests', input: {} }]), false)
  })
  it('委派只读 scout 算只读', () => {
    assert.equal(turnUsedOnlyReadTools([
      { name: 'delegate_task', input: { profile: 'code_scout' } },
    ]), true)
  })
  it('委派写能力 profile（patcher）不算只读', () => {
    assert.equal(turnUsedOnlyReadTools([
      { name: 'delegate_task', input: { profile: 'patcher' } },
    ]), false)
  })
  it('delegate_batch 任一 task 带写 profile 即不算只读', () => {
    assert.equal(turnUsedOnlyReadTools([
      { name: 'delegate_batch', input: { tasks: [{ profile: 'code_scout' }, { profile: 'patcher' }] } },
    ]), false)
  })
  it('交付/编排写工具不算只读（deliver_task 提交轮曾被误判只读触发误报提醒）', () => {
    assert.equal(turnUsedOnlyReadTools([{ name: 'deliver_task', input: {} }]), false)
    assert.equal(turnUsedOnlyReadTools([{ name: 'starflow', input: {} }]), false)
    assert.equal(turnUsedOnlyReadTools([{ name: 'galaxy', input: {} }]), false)
  })
})
