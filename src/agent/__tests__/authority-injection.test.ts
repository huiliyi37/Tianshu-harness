import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkerPrompt } from '../worker-prompts.js'
import { createReadOnlyWorkOrder, createWriteWorkOrder } from '../work-order.js'
import { starDomainRegistry } from '../star-domain-registry.js'

function readOnlyOrder(overrides?: { authority?: string; profile?: 'code_scout' | 'reviewer' }) {
  return createReadOnlyWorkOrder({
    parentTurnId: 'test-turn',
    kind: 'code_search',
    profile: overrides?.profile ?? 'code_scout',
    objective: 'search the codebase',
    scope: {},
    authority: overrides?.authority,
  })
}

function writeOrder(overrides?: { authority?: string; profile?: 'patcher' }) {
  return createWriteWorkOrder({
    parentTurnId: 'test-turn',
    kind: 'patch_proposal',
    profile: overrides?.profile ?? 'patcher',
    objective: 'edit the file',
    scope: {},
    authority: overrides?.authority,
  })
}

describe('V3 Component A — authority injection', () => {
  test('buildWorkerPrompt does NOT inject domain persona in user message (moved to frozen prefix)', () => {
    const order = readOnlyOrder({ authority: 'tianquan' })
    const prompt = buildWorkerPrompt(order)
    // V3: persona (## 你是谁) and methodology (## 权域指令) are now injected
    // via bindSessionDomain → setActiveDomain into the frozen <star-domain> prefix.
    // They should NOT appear in the user message.
    assert.doesNotMatch(prompt, /## 你是谁/)
    assert.doesNotMatch(prompt, /权域指令/)
  })

  test('buildWorkerPrompt works without authority (backward compat)', () => {
    const order = readOnlyOrder()
    const prompt = buildWorkerPrompt(order)
    assert.doesNotMatch(prompt, /权域指令/)
    assert.doesNotMatch(prompt, /## 你是谁/)
  })

  test('buildWorkerPrompt no longer injects volatileBlock persona in user message', () => {
    const order = readOnlyOrder({ authority: 'tianquan' })
    const prompt = buildWorkerPrompt(order)
    const def = starDomainRegistry.get('tianquan')!
    // Persona text from volatileBlock must NOT be in the user message — it lives
    // in the frozen prefix via setActiveDomain.
    assert.ok(!prompt.includes(def.volatileBlock.slice(0, 20)))
  })

  test('buildWorkerPrompt authoritySuffix parameter is accepted but no-op (retained for compat)', () => {
    const order = readOnlyOrder({ authority: 'tianquan' })
    // authoritySuffix override no longer has any effect — domain identity is in frozen prefix
    const prompt = buildWorkerPrompt(order, 'CUSTOM SUFFIX OVERRIDE')
    assert.doesNotMatch(prompt, /## 你是谁/)
    assert.doesNotMatch(prompt, /权域指令/)
  })

  test('buildWorkerPrompt explicit authoritySuffix does not inject into prompt', () => {
    const order = readOnlyOrder({ authority: 'tianquan' })
    const prompt = buildWorkerPrompt(order, 'CUSTOM SUFFIX OVERRIDE')
    // Override is no longer rendered — domain identity moved to frozen prefix
    assert.doesNotMatch(prompt, /CUSTOM SUFFIX OVERRIDE/)
  })

  test('authority on write order preserves domain in WorkOrder (identity moved to frozen prefix)', () => {
    const order = writeOrder({ authority: 'pojun' })
    // authority is preserved on the order — domain identity is now injected
    // via bindSessionDomain into frozen prefix, not in user message.
    assert.equal(order.authority, 'pojun')
    const prompt = buildWorkerPrompt(order)
    assert.doesNotMatch(prompt, /## 你是谁/)
    assert.doesNotMatch(prompt, /权域指令/)
  })

  test('WorkOrder schema preserves authority field', () => {
    const order = readOnlyOrder({ authority: 'tianfu' })
    assert.equal(order.authority, 'tianfu')
  })

  test('WorkOrder without authority has undefined authority', () => {
    const order = readOnlyOrder()
    assert.equal(order.authority, undefined)
  })

  test('toolWhitelist intersection: tianfu read-only keeps read tools', () => {
    const order = readOnlyOrder({ authority: 'tianfu' })
    assert.ok(order.allowedTools.includes('read_file'))
    assert.ok(order.allowedTools.includes('grep'))
    assert.ok(order.allowedTools.includes('glob'))
  })

  test('toolWhitelist intersection: pojun read-only keeps exploration tools', () => {
    const order = readOnlyOrder({ authority: 'pojun' })
    // pojun allows read_file, write_file, edit_file, bash, grep, glob, etc.
    assert.ok(order.allowedTools.includes('read_file'))
    assert.ok(order.allowedTools.includes('grep'))
    assert.ok(order.allowedTools.includes('glob'))
  })

  test('toolWhitelist intersection: pojun write keeps write tools', () => {
    const order = writeOrder({ authority: 'pojun' })
    // pojun allows write_file, edit_file, bash
    assert.ok(order.allowedTools.includes('write_file'))
    assert.ok(order.allowedTools.includes('edit_file'))
    assert.ok(order.allowedTools.includes('bash'))
  })

  test('toolWhitelist intersection: tianfu write keeps write tools (full access)', () => {
    const order = writeOrder({ authority: 'tianfu' })
    assert.ok(order.allowedTools.includes('write_file'))
    assert.ok(order.allowedTools.includes('edit_file'))
    assert.ok(order.allowedTools.includes('bash'))
  })

  // G1 回归：将星账本读写工具必须活过 profile ∩ domain.toolWhitelist 交集。
  // 曾经的死接线：B3 prompt 指引 worker 用 record_general_finding，但 profile 和
  // 十域白名单都没有它——指引送到了，能力没送到（瑶光 Y10「送达也是声称」）。
  test('general ledger tools survive the intersection for reviewer with ledger-star authority', () => {
    const order = readOnlyOrder({ profile: 'reviewer', authority: 'yaoguang' })
    assert.ok(order.allowedTools.includes('recall_general'), 'reviewer(yaoguang) can read the ledger')
    assert.ok(order.allowedTools.includes('record_general_finding'), 'reviewer(yaoguang) can write back findings')
  })

  test('general ledger tools survive the intersection for patcher with tianliang authority', () => {
    const order = writeOrder({ profile: 'patcher', authority: 'tianliang' })
    assert.ok(order.allowedTools.includes('recall_general'), 'patcher(tianliang) can read the ledger')
    assert.ok(order.allowedTools.includes('record_general_finding'), 'patcher(tianliang) can write back findings')
  })

  test('unknown authority fails closed: no injection and no allowed tools', () => {
    const readOrder = readOnlyOrder({ authority: 'nonexistent_domain' })
    const prompt = buildWorkerPrompt(readOrder)
    assert.doesNotMatch(prompt, /权域指令/)
    assert.deepEqual(readOrder.allowedTools, [])

    const patchOrder = writeOrder({ authority: 'nonexistent_domain' })
    assert.deepEqual(patchOrder.allowedTools, [])
  })

  test('unknown authority logs warning (fail-loud signal)', () => {
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (msg: string) => warnings.push(msg)
    try {
      readOnlyOrder({ authority: 'misspelled_domain' })
      const matched = warnings.some(w => w.includes('Unknown authority "misspelled_domain"'))
      assert.ok(matched, `expected warning about unknown authority, got: ${warnings.join('; ')}`)
    } finally {
      console.warn = origWarn
    }
  })

  // 开阳（第十二域 · 对账者）：domain identity moved to frozen prefix via bindSessionDomain.
  test('buildWorkerPrompt does NOT inject kaiyang persona in user message (moved to frozen prefix)', () => {
    const order = readOnlyOrder({ authority: 'kaiyang' })
    const prompt = buildWorkerPrompt(order)
    // Domain identity (volatileBlock, ## 你是谁, 权域指令) now lives in the frozen
    // <star-domain> prefix injected by bindSessionDomain → setActiveDomain.
    assert.doesNotMatch(prompt, /## 你是谁/)
    assert.doesNotMatch(prompt, /权域指令/)
  })

  test('toolWhitelist intersection: kaiyang read-only keeps read tools, write keeps write tools', () => {
    const ro = readOnlyOrder({ authority: 'kaiyang' })
    assert.ok(ro.allowedTools.includes('read_file'))
    assert.ok(ro.allowedTools.includes('grep'))
    assert.ok(ro.allowedTools.includes('glob'))
    const wo = writeOrder({ authority: 'kaiyang' })
    assert.ok(wo.allowedTools.includes('write_file'))
    assert.ok(wo.allowedTools.includes('edit_file'))
    assert.ok(wo.allowedTools.includes('bash'))
  })

  // G1 同族回归（git_scout 回流 2026-09-21）：git_scout 的立身之本就是「让 readonly
  // worker 能对 git 史实取证」，而带 authority 的 worker 还要过 domain.toolWhitelist
  // 这道交集。白名单漏了它，工具在注册表里、在 profile 里，**worker 手里没有**——
  // 与 G1（账本工具）同一个死接线形状：能力送到了注册表，没送到执行者。
  test('git_scout survives the intersection for every built-in authority', () => {
    for (const id of starDomainRegistry.getDomainIds()) {
      const order = readOnlyOrder({ profile: 'code_scout', authority: id })
      assert.ok(order.allowedTools.includes('git_scout'), `code_scout(${id}) 应保留 git_scout`)
    }
  })
})
