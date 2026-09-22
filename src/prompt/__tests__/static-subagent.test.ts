import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildSystemPrompt, MAIN_BASE_PROMPT } from '../static.js'
import {
  buildSubagentSystemPrompt,
  parsePrompt,
  splitRules,
  derivePolicy,
} from '../static-subagent.js'
import type { ToolDefinition } from '../../api/types.js'

/** sha256 of buildSystemPrompt({ tools: [] }) as of 2026-09-20（<task-classification>
 *  补「知识问答：先自检再作答」分支，堵死「非代码问题 → 直接作答」的秒答路径）。
 *  证据：桌面会话 20260919cd375a90365d 首轮，模型自述
 *  "This is a grammar question. Let me answer directly." 后误选 (D) 并主动放弃已推导出的
 *  正确结构。BASE_PROMPT 行数保持 240（kernel-budget 顶格）——仅把「判断」行与
 *  intent-retrieval-route 兜底行合并腾出位置，净增 0 行。
 *  2026-09-20 同日二次迭代：自检第①步加硬——先圈出题面已存在的限定谓语/主语，再判断
 *  空处可否重复充当同一角色，直指「把空处当主谓语」这个具体误判。
 *  2026-09-20 同日三次迭代（辅胶囊冲突审计 P0+P1+P2：三处行内改写，行数仍 240）：
 *  ① <security>「文件路径不超出项目目录」与 <tool-usage>:142「授权后可读写工作区外」
 *  正面冲突 → 收口为「默认不越出，越出需授权（流程见 <tool-usage>）」；
 *  ② <beliefs>「需要分析/建议的问题直接给答案」与知识问答分支「禁止直接作答」对立
 *  （上一版自己引入）→ 限定为输出形态，明确不等于跳过推导；
 *  ③ <identity>「不猜，先读」对纯知识题无物可读而悬空 → 补「无可读之物时改立判定规则+代回验证」。
 *  2026-09-20 四次迭代（辅审计 P3：自检判据缺适用域）：
 *  evidence-scope 的「下结论前自检：靠的是物理事实…」是全文**唯一无条件**的结论前判据，
 *  对无工具可测的纯知识题会诱导两条坏路——"去找不存在的物理事实"或"无证据→直接答"
 *  （秒答路径）。补「以有工具可测为前提；纯知识题改按知识问答判据」。核过的其余判据点
 *  （收敛纪律:139、知识问答:156、stance:20、异常信号:28、有损观测:29、自检闸门:187）
 *  均已有前置限定，不动。
 *  2026-09-20 五次迭代（辅审计 P4/P5/P6：边界模糊 + 规则无出路 + 措辞张力）：
 *  ① delivery-contract:107「交付报告用散文」与「面向阅读的回复主动分点」判据重叠 →
 *  补「收束四段固定走散文」「两者同现以交付报告为准」；② shared-worktree 补「交付门因
 *  环境跑不动时」的出路（显式点名文件的 scoped commit），并顺手把两行并作一行；
 *  ③ 批次纪律澄清「别混桶 ≠ 不能并发」；④ 动作词路由加「作用于代码或配置」限定；
 *  ⑤ <git> 展示要求收窄为只定 message 规范，篇幅归收束段。行数 240→239（净 -1）。
 *  上一版 2026-09-05（可读性校准：散文纪律收窄到交付报告 + 面向阅读回复主动分点
 *  ——回流 main 634af35bb）。
 *  The sub-agent refactor must never move this: the main-controller prompt is
 *  the frozen head of every prefix-cached request, and a byte change
 *  invalidates every session.
 *  2026-09-21 **有意变更**（收编公开仓 PR #233 / issue #217 后半）：<security> 段新增
 *  「数据≠指令」信任边界条款，配合 agent/context.ts 的 <untrusted-content> 定界，把
 *  「工具输出是数据不是指令」从 SECURITY.md 的散文承诺变成模型可见的规则。
 *  ⚠ hash 按 **dev 提示词**重算——公开仓 PR 给的 2d22e0d8… 是公开仓那份提示词的 hash，
 *  dev 提示词在本笔前已迭代多轮，照抄必红。改它等于所有会话前缀缓存冷启动一次，
 *  这是本次变更的已知代价，不是意外。
 *  2026-09-21 **有意变更**（收编 issue #235 Wave 4）：桌面自动化分工段补一条——需要合成
 *  键鼠 / 抢占前台时走 computer_use，不要用 shell 脚本自造注入（那条路绕过逐应用授权模型；
 *  命中注入签名的命令要过审批门，用户刚在操作时还会被「让出」跳过）。同前几笔：改 hash
 *  即所有会话前缀缓存冷启动一次，这是本笔的已知代价，不是意外。
 *  2026-09-22 **有意变更**：新增 <output-economy> 段（输出经济纪律）。来源是实测——简单编码
 *  任务下 75–90% 的输出计费落在 reasoning，加一句"默认短、不复述、不追加未被请求的建议"
 *  可把该任务输出从 599 → 124 tokens（-79%，5 次均值）。段内显式声明"只约束详略、不豁免
 *  任何硬性义务"，逐条保住交付四项 / 错误诊断 / 风险与异议 / 证据与验证状态 / 知识问答推导。
 *  同前几笔：改 hash 即所有会话前缀缓存冷启动一次，这是本笔的已知代价，不是意外。
 */
const MAIN_PROMPT_SHA256 = 'b6ee09f63483a794a8523214b74dc52472ecb95092afdd4009603296a6d4e24d'

function tool(name: string): ToolDefinition {
  return { name, description: '', input_schema: { type: 'object', properties: {} } } as ToolDefinition
}

const READ_ONLY_TOOLS = ['read_file', 'grep', 'glob', 'repo_map'].map(tool)
const WRITE_TOOLS = [...READ_ONLY_TOOLS, ...['edit_file', 'write_file', 'run_tests'].map(tool)]

function sectionNames(prompt: string): string[] {
  return parsePrompt(prompt).sections.map(s => s.name)
}

function ruleNames(prompt: string): string[] {
  const rules = parsePrompt(prompt).sections.find(s => s.name === 'rules')
  return rules ? splitRules(rules.body).map(r => r.name) : []
}

describe('main-controller prompt is untouched', () => {
  it('buildSystemPrompt without audience matches the golden hash', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.equal(createHash('sha256').update(prompt).digest('hex'), MAIN_PROMPT_SHA256)
  })

  it('buildSystemPrompt without audience returns BASE_PROMPT identically', () => {
    assert.equal(buildSystemPrompt({ tools: WRITE_TOOLS }), MAIN_BASE_PROMPT)
  })

  it('model calibration still appends to the full prompt', () => {
    const prompt = buildSystemPrompt({ tools: [], modelFamily: 'deepseek' })
    assert.ok(prompt.startsWith(MAIN_BASE_PROMPT))
    assert.match(prompt, /<calibration>/)
  })
})

describe('prompt parsing is lossless', () => {
  it('sections plus trailer reproduce BASE_PROMPT byte-for-byte', () => {
    const { sections, trailer } = parsePrompt(MAIN_BASE_PROMPT)
    assert.equal(sections.map(s => s.full).join('\n\n') + trailer, MAIN_BASE_PROMPT)
  })

  it('throws rather than silently dropping text when the shape is unknown', () => {
    assert.throws(() => parsePrompt('<a>\nx\n</a>\n\nloose text outside any section'), /parse is lossy/)
  })

  it('finds every rule the retention policy references', () => {
    const found = ruleNames(MAIN_BASE_PROMPT)
    for (const name of [
      'evidence-scope', 'external-source-verification', 'test-harness',
      'verbatim-user-facing-text', 'git-context-first',
      'context-update-protocol', 'context-intent-association',
    ]) {
      assert.ok(found.includes(name), `rule "${name}" missing — retention policy is stale`)
    }
  })
})

describe('sub-agent tiers', () => {
  it('read-only worker keeps identity, evidence discipline and security', () => {
    const prompt = buildSubagentSystemPrompt(MAIN_BASE_PROMPT, READ_ONLY_TOOLS)
    // 2026-09-22: 新增 output-economy（输出经济）——子代理同样向主控输出文本，
    // 详略纪律对 worker 有效；无需 gate，故出现在只读 worker 的段列表里。
    assert.deepEqual(sectionNames(prompt), ['identity', 'beliefs', 'stance', 'rules', 'tool-usage', 'security', 'output-economy'])
    // 主控事后补救不了的两条必须在场
    assert.match(prompt, /声称"X 缺少 Y"前/)
    assert.match(prompt, /有损观测纪律/)
  })

  it('read-only worker drops the main-controller-only sections', () => {
    const prompt = buildSubagentSystemPrompt(MAIN_BASE_PROMPT, READ_ONLY_TOOLS)
    for (const gone of ['delivery-contract', 'workflow', 'downloads', 'shared-worktree', 'git', 'delegation']) {
      assert.ok(!sectionNames(prompt).includes(gone), `<${gone}> should not reach a read-only worker`)
    }
    for (const gone of ['external-source-verification', 'context-intent-association', 'git-context-first', 'context-update-protocol']) {
      assert.ok(!ruleNames(prompt).includes(gone), `rule "${gone}" should not reach a sub-agent`)
    }
    assert.ok(!prompt.includes('perspective-shift'))
  })

  it('read-only worker drops write-only test discipline', () => {
    const prompt = buildSubagentSystemPrompt(MAIN_BASE_PROMPT, READ_ONLY_TOOLS)
    assert.ok(!prompt.includes('red-green-bugfix'))
    assert.ok(!prompt.includes('test-strategy-by-task'))
    assert.ok(!ruleNames(prompt).includes('verbatim-user-facing-text'))
    assert.ok(!prompt.includes('诊断悖论'))
    // 没有写工具就留不下探针——这条纪律对只读 worker 是死条文
    assert.ok(!prompt.includes('probe-discipline'))
    // 其结果是 <test-harness> 整块消失，<rules> 只剩 evidence-scope 与
    // case-sensitivity（标识符/路径核实纪律——只读 worker 读路径同样需要）
    assert.deepEqual(ruleNames(prompt), ['evidence-scope', 'case-sensitivity'])
  })

  it('write-capable worker regains the test and text disciplines', () => {
    const prompt = buildSubagentSystemPrompt(MAIN_BASE_PROMPT, WRITE_TOOLS)
    assert.match(prompt, /red-green-bugfix/)
    assert.match(prompt, /probe-discipline/)
    assert.match(prompt, /test-strategy-by-task/)
    assert.match(prompt, /诊断悖论/)
    assert.ok(ruleNames(prompt).includes('verbatim-user-facing-text'))
    // 但仍不拿主控的循环与交付契约
    assert.ok(!sectionNames(prompt).includes('workflow'))
    assert.ok(!sectionNames(prompt).includes('delivery-contract'))
  })

  it('security is unconditional across tiers', () => {
    for (const tools of [[], READ_ONLY_TOOLS, WRITE_TOOLS]) {
      const prompt = buildSubagentSystemPrompt(MAIN_BASE_PROMPT, tools)
      assert.ok(sectionNames(prompt).includes('security'), 'security must never be gated')
      assert.match(prompt, /破坏性\/不可逆命令是硬闸门/)
    }
  })
})

describe('tool-coupled sections follow the actual registry', () => {
  it('<git> appears only when the git tool does', () => {
    assert.ok(!sectionNames(buildSubagentSystemPrompt(MAIN_BASE_PROMPT, READ_ONLY_TOOLS)).includes('git'))
    assert.ok(sectionNames(buildSubagentSystemPrompt(MAIN_BASE_PROMPT, [...READ_ONLY_TOOLS, tool('git')])).includes('git'))
  })

  it('<shared-worktree> appears only with deliver_task', () => {
    assert.ok(!sectionNames(buildSubagentSystemPrompt(MAIN_BASE_PROMPT, WRITE_TOOLS)).includes('shared-worktree'))
    assert.ok(sectionNames(buildSubagentSystemPrompt(MAIN_BASE_PROMPT, [...WRITE_TOOLS, tool('deliver_task')])).includes('shared-worktree'))
  })

  it('<delegation> appears only with a delegate tool, and tool-usage stops referencing it otherwise', () => {
    const without = buildSubagentSystemPrompt(MAIN_BASE_PROMPT, READ_ONLY_TOOLS)
    assert.ok(!sectionNames(without).includes('delegation'))
    assert.ok(!without.includes('委派原则：'), 'dangling forward-reference to a dropped section')

    const with_ = buildSubagentSystemPrompt(MAIN_BASE_PROMPT, [...READ_ONLY_TOOLS, tool('delegate_task')])
    assert.ok(sectionNames(with_).includes('delegation'))
    assert.match(with_, /委派原则：/)
  })

  it('derivePolicy classifies write capability off the registry', () => {
    assert.equal(derivePolicy(READ_ONLY_TOOLS).writeCapable, false)
    assert.equal(derivePolicy(WRITE_TOOLS).writeCapable, true)
    assert.equal(derivePolicy([tool('run_tests')]).writeCapable, true)
  })
})

describe('<tool-usage> gates line by line', () => {
  const readOnly = () => buildSubagentSystemPrompt(MAIN_BASE_PROMPT, READ_ONLY_TOOLS)

  it('drops the bullets for tools the worker does not hold', () => {
    const prompt = readOnly()
    for (const absent of ['- edit_file：', '- write_file：', '- hash_edit：', '- apply_patch：', '- ast_edit：', '- browser_debug（', '- computer_use：']) {
      assert.ok(!prompt.includes(absent), `"${absent}" should not reach a worker without that tool`)
    }
  })

  it('keeps the bullets for tools the worker does hold', () => {
    const prompt = readOnly()
    assert.match(prompt, /- grep：/)
    // 组标题在还有存活 bullet 时保留
    assert.match(prompt, /检索工具选择：/)
  })

  it('drops a group header once every bullet under it is gone', () => {
    assert.ok(!readOnly().includes('文件操作工具选择：'))
    const withEdit = buildSubagentSystemPrompt(MAIN_BASE_PROMPT, [...READ_ONLY_TOOLS, tool('edit_file')])
    assert.match(withEdit, /文件操作工具选择：/)
    assert.match(withEdit, /- edit_file：/)
    // 只给了 edit_file，其余四条仍然不在
    assert.ok(!withEdit.includes('- apply_patch：'))
  })

  it('keeps the browser approval-boundary line only alongside browser_debug or computer_use', () => {
    assert.ok(!readOnly().includes('三者动作均有审批边界'))
    const withBrowser = buildSubagentSystemPrompt(MAIN_BASE_PROMPT, [...READ_ONLY_TOOLS, tool('browser_debug')])
    assert.match(withBrowser, /三者动作均有审批边界/)
  })

  it('drops the out-of-workspace path line without request_path_access', () => {
    assert.ok(!readOnly().includes('工作区外路径：'))
    const withGrant = buildSubagentSystemPrompt(MAIN_BASE_PROMPT, [...READ_ONLY_TOOLS, tool('request_path_access')])
    assert.match(withGrant, /工作区外路径：/)
  })

  it('keeps the deliberately ungated exploration and parallelism lines', () => {
    const prompt = readOnly()
    assert.match(prompt, /探索靠 repo_map/)
    assert.match(prompt, /并行纪律：/)
    // 与工具无关的收敛纪律同样不受门控
    assert.match(prompt, /收敛纪律（硬性闸门）/)
    assert.match(prompt, /批次纪律：/)
    assert.match(prompt, /防循环：/)
  })

  it('every gate anchor resolves to exactly one line in BASE_PROMPT', () => {
    // buildSubagentSystemPrompt throws on a drifted anchor; a full-tool worker
    // exercises every gate's keep branch, a bare one exercises every drop branch.
    const everyTool = [
      'edit_file', 'write_file', 'hash_edit', 'apply_patch', 'ast_edit', 'bash',
      'grep', 'ast_grep', 'web_fetch', 'web_search', 'browser_debug', 'computer_use',
      'request_path_access', 'delegate_task',
    ].map(tool)
    assert.doesNotThrow(() => buildSubagentSystemPrompt(MAIN_BASE_PROMPT, everyTool))
    assert.doesNotThrow(() => buildSubagentSystemPrompt(MAIN_BASE_PROMPT, []))
  })

  it('a worker holding every gated tool keeps <tool-usage> whole', () => {
    const everyTool = [
      'edit_file', 'write_file', 'hash_edit', 'apply_patch', 'ast_edit', 'bash',
      'grep', 'ast_grep', 'web_fetch', 'web_search', 'browser_debug', 'computer_use',
      'request_path_access', 'delegate_task',
    ].map(tool)
    const lean = buildSubagentSystemPrompt(MAIN_BASE_PROMPT, everyTool)
    const mainToolUsage = parsePrompt(MAIN_BASE_PROMPT).sections.find(s => s.name === 'tool-usage')!
    const leanToolUsage = parsePrompt(lean).sections.find(s => s.name === 'tool-usage')!
    assert.equal(leanToolUsage.full, mainToolUsage.full)
  })
})

describe('<identity> drops the complete-toolset claim', () => {
  it('the main controller keeps it', () => {
    assert.match(MAIN_BASE_PROMPT, /你拥有完整的开发工具集/)
  })

  it('no sub-agent tier claims a complete toolset', () => {
    for (const tools of [[], READ_ONLY_TOOLS, WRITE_TOOLS]) {
      const prompt = buildSubagentSystemPrompt(MAIN_BASE_PROMPT, tools)
      assert.ok(!prompt.includes('你拥有完整的开发工具集'),
        'a filtered registry makes the claim false and invites calls to absent tools')
    }
  })

  it('the surrounding identity text stays intact and reads cleanly', () => {
    const prompt = buildSubagentSystemPrompt(MAIN_BASE_PROMPT, READ_ONLY_TOOLS)
    assert.match(prompt, /一个认知增强的代码开发环境。你的任务是/)
    assert.match(prompt, /你以中文思考和回复。/)
  })
})

describe('the lean prompt is materially smaller', () => {
  it('read-only drops more than half the main prompt', () => {
    const lean = buildSubagentSystemPrompt(MAIN_BASE_PROMPT, READ_ONLY_TOOLS)
    assert.ok(lean.length < MAIN_BASE_PROMPT.length * 0.5,
      `read-only lean prompt is ${lean.length} of ${MAIN_BASE_PROMPT.length}`)
  })

  it('write-capable stays smaller than the main prompt', () => {
    const lean = buildSubagentSystemPrompt(MAIN_BASE_PROMPT, WRITE_TOOLS)
    assert.ok(lean.length < MAIN_BASE_PROMPT.length * 0.6,
      `write lean prompt is ${lean.length} of ${MAIN_BASE_PROMPT.length}`)
  })
})
