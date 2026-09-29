/**
 * L1: 稳定 order id 复用时，persistWorkerResult 曾只写 <orderId>.json——
 * 第二次派发物理覆盖第一轮的 findings/usage，/tasks 详情页永远只剩最后一轮。
 * 修复：按派发 nonce 逐轮归档（<orderId>.<nonce>.json，与 worker 会话 JSONL
 * 同源），<orderId>.json 保持「最新一轮」语义不变。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listPersistedResultRounds,
  loadPersistedResult,
  loadPersistedResultRound,
  persistWorkerResult,
} from '../coordinator.js'
import { orderFileKey } from '../../utils/safe-path.js'
import type { WorkerResult } from '../work-order.js'

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
  mkdirSync(join(home, '.rivet', 'subagents'), { recursive: true })
  return home
}

function subagents(home: string): string {
  return join(home, '.rivet', 'subagents')
}

function resultOf(id: string, summary: string): WorkerResult {
  return {
    workOrderId: id, status: 'passed', summary, findings: [],
    artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified',
  }
}

describe('persist rounds (L1: per-dispatch archive)', () => {
  it('第二次派发不再覆盖第一轮：归档各留一份，最新副本指向第二轮', () => {
    const home = makeHome()
    persistWorkerResult(resultOf('batch:0', 'round 1 findings'), undefined, 'aaa11', home)
    persistWorkerResult(resultOf('batch:0', 'round 2 findings'), undefined, 'bbb22', home)

    // 最新副本 = 第二轮（loadPersistedResult 行为不变）
    assert.equal(loadPersistedResult('batch:0', home)?.summary, 'round 2 findings')
    // 两轮归档都在，且各自内容独立
    assert.equal(loadPersistedResultRound('batch:0', 'aaa11', home)?.summary, 'round 1 findings')
    assert.equal(loadPersistedResultRound('batch:0', 'bbb22', home)?.summary, 'round 2 findings')
    assert.deepEqual(
      listPersistedResultRounds('batch:0', home).map(r => r.nonce),
      ['aaa11', 'bbb22'],
    )
  })

  it('无 nonce 的派发（合成 blocked / 旧行为）只写最新副本，不产生归档轮次', () => {
    const home = makeHome()
    persistWorkerResult(resultOf('batch:0', 'synthesized'), undefined, undefined, home)
    assert.equal(loadPersistedResult('batch:0', home)?.summary, 'synthesized')
    assert.deepEqual(listPersistedResultRounds('batch:0', home), [])
  })

  it('listPersistedResultRounds 排除最新副本 / 指纹文件 / 前缀撞名的其他 id，并按 mtime 升序', () => {
    const home = makeHome()
    const dir = subagents(home)
    const key = orderFileKey('batch:0')
    // 第二轮先写、第一轮后写——靠 mtime 而非写入顺序排
    writeFileSync(join(dir, `${key}.bbb22.json`), JSON.stringify(resultOf('batch:0', 'r2')), 'utf-8')
    writeFileSync(join(dir, `${key}.aaa11.json`), JSON.stringify(resultOf('batch:0', 'r1')), 'utf-8')
    // 干扰项：最新副本、指纹文件、前缀撞名的 batch:01
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(resultOf('batch:0', 'latest')), 'utf-8')
    writeFileSync(join(dir, 'deadbeefcafe1234.json'), JSON.stringify(resultOf('batch:0', 'fp copy')), 'utf-8')
    writeFileSync(join(dir, `${orderFileKey('batch:01')}.ccc33.json`), JSON.stringify(resultOf('batch:01', 'other id')), 'utf-8')
    utimesSync(join(dir, `${key}.aaa11.json`), new Date(1000), new Date(1000))
    utimesSync(join(dir, `${key}.bbb22.json`), new Date(2000), new Date(2000))

    const rounds = listPersistedResultRounds('batch:0', home)
    assert.deepEqual(rounds.map(r => r.nonce), ['aaa11', 'bbb22'])
    assert.deepEqual(rounds.map(r => r.savedAt), [1000, 2000])
    // 撞名 id 的归档属于自己的列表
    assert.deepEqual(listPersistedResultRounds('batch:01', home).map(r => r.nonce), ['ccc33'])
  })

  it('loadPersistedResultRound 对未知轮次与路径逃逸 nonce 返回 null', () => {
    const home = makeHome()
    persistWorkerResult(resultOf('wo_x', 'archived'), undefined, 'aaa11', home)
    assert.equal(loadPersistedResultRound('wo_x', 'zzz99', home), null)
    assert.equal(loadPersistedResultRound('wo_x', '..', home), null)
    assert.equal(loadPersistedResultRound('wo_x', '../wo_x', home), null)
    assert.equal(loadPersistedResultRound('wo_x', 'a/b', home), null)
    assert.equal(loadPersistedResultRound('wo_x', '', home), null)
  })

  it('指纹副本照常写入（T5 resume 不受归档影响）', () => {
    const home = makeHome()
    persistWorkerResult(resultOf('wo_fp', 'with fingerprint'), 'fp1234567890abcd', 'aaa11', home)
    assert.equal(loadPersistedResult('wo_fp', home)?.summary, 'with fingerprint')
    // 指纹文件在盘上，内容即结果 JSON
    const raw = JSON.parse(readFileSync(join(subagents(home), 'fp1234567890abcd.json'), 'utf-8'))
    assert.equal(raw.summary, 'with fingerprint')
    // 指纹文件名不会被误认为轮次（不以 order id 开头）
    assert.deepEqual(listPersistedResultRounds('wo_fp', home).map(r => r.nonce), ['aaa11'])
  })

  it('归档文件名不含冒号（Windows ADS 回归）：readdir 可见、列表可枚举', () => {
    // 回归背景：orderId 裸拼文件名（batch:0.aaa11.json）在 Windows 上落成
    // NTFS 备用数据流——写/读同路径都"成功"，但 readdir 只见宿主文件
    // `batch`，归档列表恒空。所有文件名必须经 orderFileKey 编码。
    const home = makeHome()
    persistWorkerResult(resultOf('batch:0', 'r1'), undefined, 'aaa11', home)
    const names = readdirSync(subagents(home))
    assert.ok(
      names.includes(`${orderFileKey('batch:0')}.aaa11.json`),
      `readdir 应能看见归档文件（Windows 上裸拼冒号会落成 ADS）：${names.join(', ')}`,
    )
    for (const n of names) {
      assert.ok(!n.includes(':'), `subagents 目录不得出现含冒号的文件名（Windows 非法）：${n}`)
    }
    assert.deepEqual(listPersistedResultRounds('batch:0', home).map(r => r.nonce), ['aaa11'])
  })

  it('旧格式归档（未编码文件名）在读/列路径回退兼容（POSIX 存量）', { skip: process.platform === 'win32' }, () => {
    // Windows 无法物化含冒号的普通文件名（会变 ADS）——回退只对 POSIX 存量有意义。
    const home = makeHome()
    const dir = subagents(home)
    writeFileSync(join(dir, 'batch:0.aaa11.json'), JSON.stringify(resultOf('batch:0', 'legacy r1')), 'utf-8')
    writeFileSync(join(dir, 'batch:0.json'), JSON.stringify(resultOf('batch:0', 'legacy latest')), 'utf-8')
    assert.equal(loadPersistedResultRound('batch:0', 'aaa11', home)?.summary, 'legacy r1')
    assert.equal(loadPersistedResult('batch:0', home)?.summary, 'legacy latest')
    assert.deepEqual(listPersistedResultRounds('batch:0', home).map(r => r.nonce), ['aaa11'])
  })
})
