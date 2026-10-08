import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { domainBankSchema, toPilotSuite } from '../domain-bank.js'

/** 随仓题库（benchmark/domains/star-domain-eval-bank.json）——本测试是它的机读守卫。 */
const BANK_PATH = fileURLToPath(new URL('../../../benchmark/domains/star-domain-eval-bank.json', import.meta.url))

function loadRaw(): unknown {
  return JSON.parse(readFileSync(BANK_PATH, 'utf8'))
}

describe('星域评测题库（domain bank）', () => {
  it('随仓题库文件存在且通过 schema 校验', () => {
    const bank = domainBankSchema.parse(loadRaw())
    assert.ok(bank.tasks.length >= 2, `题库至少应含 2 题，实际 ${bank.tasks.length}`)
  })

  it('id 全局唯一', () => {
    const bank = domainBankSchema.parse(loadRaw())
    const ids = bank.tasks.map(t => t.id)
    assert.equal(new Set(ids).size, ids.length, `id 重复：${ids.join(', ')}`)
  })

  it('validated / ready 条目必须给全 ground truth（oracleCommit + 评分命令 + 参考测试 + 证据）', () => {
    const bank = domainBankSchema.parse(loadRaw())
    for (const t of bank.tasks.filter(x => x.status === 'validated' || x.status === 'ready')) {
      assert.ok(t.environment.oracleCommit, `${t.id}: ${t.status} 必须带 environment.oracleCommit`)
      assert.ok(t.grader.command, `${t.id}: ${t.status} 必须带评分命令`)
      assert.ok(t.grader.referenceTests.length > 0, `${t.id}: ${t.status} 必须列出参考测试`)
      assert.ok(t.provenance.evidence.length > 0, `${t.id}: ${t.status} 必须留证据`)
    }
  })

  it('每题必须显式声明 contractGiven（防把「契约已给」的题当能力对比）', () => {
    const bank = domainBankSchema.parse(loadRaw())
    for (const t of bank.tasks) {
      assert.equal(typeof t.contractGiven, 'boolean', `${t.id}: contractGiven 必须显式声明`)
    }
  })

  it('契约已给（contractGiven=true）的 validated 题，必须冻结参考测试（否则给了契约还能改测试）', () => {
    const bank = domainBankSchema.parse(loadRaw())
    for (const t of bank.tasks.filter(x => x.status === 'validated' && x.contractGiven)) {
      assert.ok(
        t.grader.mustNotTouch.length > 0,
        `${t.id}: 契约已给却不冻结参考测试——agent 可改测试骗绿`,
      )
    }
  })

  it('validated 必须附真跑记录（ready 没有——没跑过就不许当真）', () => {
    const bank = domainBankSchema.parse(loadRaw())
    for (const t of bank.tasks) {
      if (t.status === 'validated') assert.ok(t.validatedRuns.length > 0, `${t.id}: validated 必须附 validatedRuns`)
      else assert.equal(t.validatedRuns.length, 0, `${t.id}: ${t.status} 不该有 validatedRuns`)
    }
  })

  it('candidate 条目不得自称已验证（不许贴金）', () => {
    const bank = domainBankSchema.parse(loadRaw())
    for (const t of bank.tasks.filter(x => x.status === 'candidate')) {
      assert.equal(t.validatedRuns.length, 0, `${t.id}: candidate 不该有 validatedRuns`)
    }
  })

  it('题面（symptom）不得泄露修法：不含 diff/oracle 提交号', () => {
    const bank = domainBankSchema.parse(loadRaw())
    for (const t of bank.tasks) {
      assert.doesNotMatch(t.symptom, /\b[0-9a-f]{9}\b/, `${t.id}: 题面含疑似提交号，会剧透`)
    }
  })

  it('toPilotSuite 投影出 runner 可消费的 {tasks:[...]} 且字段齐备', () => {
    const bank = domainBankSchema.parse(loadRaw())
    const suite = toPilotSuite(bank)
    assert.ok(suite.tasks.length >= 1)
    for (const t of suite.tasks) {
      assert.ok(t.id && t.title && t.prompt && t.timeoutMs > 0)
    }
  })
})

// A synthetic unit fixture checks validated filtering without inventing real runs.
it('pilot suite selects only the requested validated task identity', () => {
  const sample = domainBankSchema.parse(loadRaw()).tasks[0]!
  const bank = domainBankSchema.parse({ version: 1, tasks: [
    { ...sample, id: 'unit-candidate', status: 'candidate', validatedRuns: [] },
    { ...sample, id: 'unit-validated', status: 'validated', validatedRuns: [
      { variant: 'unit-fixture', model: 'fictional', verdict: 'pass' },
    ] },
  ] })
  assert.deepEqual(toPilotSuite(bank, { status: 'validated' }).tasks.map(t => t.id), ['unit-validated'])
  assert.deepEqual(toPilotSuite(bank, { ids: ['unit-candidate'] }).tasks.map(t => t.id), ['unit-candidate'])
})
