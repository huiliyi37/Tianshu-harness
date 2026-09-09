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

/** sha256 of buildSystemPrompt({ tools: [] }) as of 2026-09-05（可读性校准：
 *  散文纪律收窄到交付报告 + 面向阅读回复的主动分点引导——回流 main 634af35bb）。
 *  The sub-agent refactor must never move this: the main-controller prompt is
 *  the frozen head of every prefix-cached request, and a byte change
 *  invalidates every session. */
const MAIN_PROMPT_SHA256 = '26043390ef70024e9718bc0429f339414874f284cd935d994ce455a87a274374'

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
    assert.deepEqual(sectionNames(prompt), ['identity', 'beliefs', 'stance', 'rules', 'tool-usage', 'security'])
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
