import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { splitSections, selectSections, selectProjectInstructions } from '../project-instructions.js'
import { buildStableVolatileBlock } from '../volatile.js'

const REPO = join(import.meta.dirname, '..', '..', '..')

/** volatile.ts 的 escapeXml 口径——预算按渲染后长度计。 */
const measure = (t: string): number =>
  t.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').length

const DOC = [
  '# Demo Project',
  '',
  'One line of orientation.',
  '',
  '## 目录索引',
  '',
  '| 路径 | 职责 |',
  '|---|---|',
  '| src/a | alpha |',
  '| src/b | beta |',
  '',
  '## Background',
  '',
  'Some prose with no gate words in it at all, purely descriptive.',
  '',
  '## 高危命令纪律',
  '',
  '禁止执行 rm -rf。',
].join('\n')

describe('splitSections', () => {
  it('splits on # and ## so concatenated docs keep their boundary', () => {
    const two = `# Doc A\n\nintro a\n\n## A1\n\nbody\n\n# Doc B\n\nintro b`
    assert.deepEqual(splitSections(two).map(s => s.title), ['Doc A', 'A1', 'Doc B'])
  })

  it('does not split on headings inside fenced code', () => {
    const md = '# T\n\n```bash\n# not a heading\n## also not\n```\n\n## Real'
    assert.deepEqual(splitSections(md).map(s => s.title), ['T', 'Real'])
  })

  it('keeps prose before the first heading as a leading section', () => {
    const sections = splitSections('loose intro\n\n## First\n\nbody')
    assert.equal(sections[0]!.heading, undefined)
    assert.equal(sections[0]!.text, 'loose intro')
  })

  it('reproduces the document when nothing is dropped', () => {
    assert.equal(splitSections(DOC).map(s => s.text).join('\n\n'), DOC)
  })
})

describe('section tiering', () => {
  const byTitle = (md: string) => new Map(splitSections(md).map(s => [s.title, s.tier]))

  it('ranks gates above prose above table-heavy reference', () => {
    const tiers = byTitle(DOC)
    assert.ok(tiers.get('高危命令纪律')! < tiers.get('Background')!)
    assert.ok(tiers.get('Background')! < tiers.get('目录索引')!)
  })

  it('treats the document title as a gate so orientation is never dropped first', () => {
    assert.equal(byTitle(DOC).get('Demo Project'), byTitle(DOC).get('高危命令纪律'))
  })

  it('recognizes a gate by heading even when the body has no gate words', () => {
    const md = '# T\n\nx\n\n## Security Policy\n\nJust some neutral sentences here.'
    assert.equal(byTitle(md).get('Security Policy'), byTitle(md).get('T'))
  })

  it('does not promote a table to gate tier on one stray 必须', () => {
    const md = '# T\n\nx\n\n## Index\n\n| a | b |\n|---|---|\n| 必须 | v |\n| c | d |'
    assert.ok(byTitle(md).get('Index')! > byTitle(md).get('T')!)
  })
})

describe('budget fitting', () => {
  it('returns the document untouched when it fits', () => {
    assert.deepEqual(selectProjectInstructions(DOC, 10_000, measure), { text: DOC, omitted: [] })
  })

  it('drops reference sections before gates', () => {
    const r = selectProjectInstructions(DOC, 150, measure)
    assert.ok(r.text.includes('禁止执行 rm -rf'), 'the gate section must survive')
    assert.ok(r.omitted.includes('目录索引'))
  })

  it('never exceeds the budget across the whole range', () => {
    for (let budget = 60; budget <= 400; budget += 5) {
      const r = selectProjectInstructions(DOC, budget, measure)
      // 预算连一节都装不下 → 退回原文交给上层截断，这里不计入。
      if (r.text === DOC && budget < measure(DOC)) continue
      assert.ok(measure(r.text) <= budget, `budget ${budget} produced ${measure(r.text)} chars`)
    }
  })

  it('leaves a visible note naming what was omitted', () => {
    const r = selectProjectInstructions(DOC, 150, measure)
    assert.match(r.text, /已略去 \d+ 节/)
    assert.match(r.text, /目录索引/)
    assert.match(r.text, /读 AGENTS\.md/)
  })

  it('falls back to the untouched document when not even one section fits', () => {
    const r = selectProjectInstructions(DOC, 20, measure)
    assert.deepEqual(r, { text: DOC, omitted: [] })
  })

  it('emits selected sections in document order regardless of tier', () => {
    const picked = selectSections(splitSections(DOC), 10_000, measure)
    assert.equal(picked.text, DOC)
  })
})

describe("this repo's own project instructions", () => {
  // #218 信任门（收编公开仓 PR #234）：未受信目录的项目指令不读不注入——本套件读的
  // 正是**本仓自己的** AGENTS.md/.rivet.md，故必须显式声明受信，否则只在「同批别的
  // 测试恰好设过 RIVET_TRUST_PROJECT=1」时才绿（顺序依赖）。
  // 作用域限定在 before/after，不用模块顶层赋值：那会把受信 env 泄漏给同进程的
  // 其它测试文件（runner 分批同进程跑）。
  let prevTrust: string | undefined
  before(() => {
    prevTrust = process.env.RIVET_TRUST_PROJECT
    process.env.RIVET_TRUST_PROJECT = '1'
  })
  after(() => {
    if (prevTrust === undefined) delete process.env.RIVET_TRUST_PROJECT
    else process.env.RIVET_TRUST_PROJECT = prevTrust
  })

  const block = (): string => {
    const out = buildStableVolatileBlock({ cwd: REPO })
    return out.match(/<project-instructions>[\s\S]*?<\/project-instructions>/)![0]
  }

  it('keeps every hard-gate section instead of head-truncating them away', () => {
    // 回归：此前 escapeXml 后从头切到 8,000，AGENTS.md 末尾三节与整份 .rivet.md
    // 一起消失——主控和子代理都读不到自己的 git 提交纪律与高危命令闸门。
    const pi = block()
    for (const gate of ['高危命令纪律', 'Agent 安全保护', '通用执行纪律', 'Code Conventions']) {
      assert.ok(pi.includes(gate), `hard-gate section "${gate}" must be present`)
    }
  })

  it('no longer needs the blunt head truncation backstop', () => {
    assert.ok(!block().includes('<!-- truncated'))
  })

  it('stays inside the standard cap', () => {
    assert.ok(block().length <= 8_000, `block is ${block().length} chars`)
  })

  it('gives sub-agents a tighter block that still carries the gates', () => {
    const out = buildStableVolatileBlock({ cwd: REPO, blockCaps: { projectInstructions: 4_000 } })
    const pi = out.match(/<project-instructions>[\s\S]*?<\/project-instructions>/)![0]
    assert.ok(pi.length <= 4_000, `sub-agent block is ${pi.length} chars`)
    assert.ok(pi.length < block().length)
    for (const gate of ['高危命令纪律', 'Agent 安全保护']) {
      assert.ok(pi.includes(gate), `sub-agent lost hard-gate section "${gate}"`)
    }
  })

  it('the source documents are what the fitter is fed', () => {
    // 分层判据认的是 markdown 结构，不是仓库专有标题——但这两份文档确实是
    // 输入，读不到就说明 readRivetMd 的来源变了，此处的回归断言随之失效。
    assert.ok(readFileSync(join(REPO, 'AGENTS.md'), 'utf-8').includes('## 高危命令纪律'))
    assert.ok(readFileSync(join(REPO, '.rivet.md'), 'utf-8').includes('## Code Conventions'))
  })
})
