import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isInProductionFlow, type ProductionFlowEntry } from '../production-flow.js'

const edit = (target = 'src/a.ts'): ProductionFlowEntry => ({ tool: 'edit_file', status: 'success', target })
const tests = (): ProductionFlowEntry => ({ tool: 'run_tests', status: 'success', target: 'src/a.test.ts' })
const read = (): ProductionFlowEntry => ({ tool: 'read_file', status: 'success', target: 'src/b.ts' })

describe('isInProductionFlow', () => {
  it('编辑 + 验证交替且无失败 → 产出流', () => {
    assert.equal(isInProductionFlow([read(), edit(), tests()]), true)
  })

  it('样本不足 3 条 → 证据不够，不判产出流', () => {
    assert.equal(isInProductionFlow([edit(), tests()]), false)
    assert.equal(isInProductionFlow([]), false)
  })

  it('只编辑不验证 → 不是产出流（缺验证半边）', () => {
    assert.equal(isInProductionFlow([edit('a.ts'), edit('b.ts'), edit('c.ts')]), false)
  })

  it('只验证不编辑 → 不是产出流（缺编辑半边）', () => {
    assert.equal(isInProductionFlow([tests(), tests(), read()]), false)
  })

  it('窗口内有失败 → 不是产出流（节律已断）', () => {
    assert.equal(isInProductionFlow([edit(), tests(), { tool: 'run_tests', status: 'failed' }]), false)
  })

  it('bash 按命令内容区分验证与普通读', () => {
    const verify: ProductionFlowEntry = { tool: 'bash', status: 'success', target: 'npm run typecheck' }
    const plain: ProductionFlowEntry = { tool: 'bash', status: 'success', target: 'cat package.json' }
    assert.equal(isInProductionFlow([read(), edit(), verify]), true)
    assert.equal(isInProductionFlow([read(), edit(), plain]), false)
  })

  it('ast_edit 计入编辑（WRITE_TOOL_NAMES 单一事实源，原内联列表漏掉它）', () => {
    assert.equal(isInProductionFlow([read(), { tool: 'ast_edit', status: 'success' }, tests()]), true)
  })

  it('只看最近 6 条——更早的编辑不再支撑产出流', () => {
    const stale = [edit(), ...Array.from({ length: 6 }, read)]
    assert.equal(isInProductionFlow(stale), false)
  })

  it('status 缺省不视为失败（未落盘的历史条目不应误判断流）', () => {
    assert.equal(isInProductionFlow([{ tool: 'read_file' }, { tool: 'edit_file' }, { tool: 'run_tests' }]), true)
  })
})

it('production flow uses the recorded full-command fact and excludes query/lint/build policies', () => {
  const bash = (target: string, verificationAttempted?: boolean): ProductionFlowEntry => ({ tool: 'bash', status: 'success', target, ...(verificationAttempted === undefined ? {} : { verificationAttempted }) })
  assert.equal(isInProductionFlow([read(), edit(), bash('node --import tsx scripts/run-node-tests.ts src/agent', true)]), true)
  for (const command of ['rg "npm test" src', 'npx eslint .', 'npm run build']) assert.equal(isInProductionFlow([read(), edit(), bash(command)]), false, command)
})
