/**
 * /handoff 交接能力 — buildHandoffPrompt / formatHandoffNudge 纯函数契约。
 */

import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HANDOFF_NUDGE_RATIO, buildHandoffPrompt, formatHandoffNudge } from '../handoff.js'
import { completeHandoffRequest, createHandoffRequest } from '../handoff.js'

describe('handoff archive lifecycle', () => {
  let root: string
  const sessionDir = () => join(root, 'sessions')
  const begin = (sessionId: string, requestId: string) => {
    mkdirSync(join(root, '.rivet'), { recursive: true })
    mkdirSync(sessionDir(), { recursive: true })
    return createHandoffRequest(root, sessionId, join(sessionDir(), `${sessionId}.handoff.md`), requestId)
  }

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rivet-handoff-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('interleaved requests have distinct project sources and archive only their own output', () => {
    const a = begin('session-a', 'request-a')
    const b = begin('session-b', 'request-b')
    assert.notEqual(a.sourcePath, b.sourcePath)
    writeFileSync(a.sourcePath, 'A handoff')
    writeFileSync(b.sourcePath, 'B handoff')
    assert.equal(completeHandoffRequest(a).status, 'archived')
    assert.equal(completeHandoffRequest(b).status, 'archived')
    assert.equal(readFileSync(a.destinationPath, 'utf8'), 'A handoff')
    assert.equal(readFileSync(b.destinationPath, 'utf8'), 'B handoff')
    assert.equal(readFileSync(a.sourcePath, 'utf8'), 'A handoff', '项目源文件保留')
  })

  it('同一会话重复交接原子更新 canonical 并保留旧版本', () => {
    const first = begin('same-session', 'request-first')
    const second = begin('same-session', 'request-second')
    writeFileSync(first.sourcePath, 'first handoff')
    writeFileSync(second.sourcePath, 'second handoff')
    assert.equal(completeHandoffRequest(first).status, 'archived')
    assert.equal(completeHandoffRequest(second).status, 'updated')
    assert.equal(readFileSync(first.destinationPath, 'utf8'), 'second handoff')
    assert.equal(readFileSync(`${second.destinationPath}.previous-${second.requestId}`, 'utf8'), 'first handoff')
    assert.equal(readFileSync(first.sourcePath, 'utf8'), 'first handoff')
    assert.equal(readFileSync(second.sourcePath, 'utf8'), 'second handoff')
  })

  it('reports missing generation and leaves any pre-existing shared handoff untouched', () => {
    const shared = join(root, '.rivet', 'HANDOFF.md')
    mkdirSync(join(root, '.rivet'), { recursive: true })
    writeFileSync(shared, 'old user handoff')
    const request = begin('session-a', 'request-missing')
    assert.equal(completeHandoffRequest(request).status, 'not-generated')
    assert.equal(readFileSync(shared, 'utf8'), 'old user handoff')
  })

  it('updates a managed canonical while preserving its prior version and reports copy failure', () => {
    const request = begin('session-a', 'request-copy-failure')
    writeFileSync(request.sourcePath, 'new output')
    writeFileSync(request.destinationPath, 'existing archive')
    assert.equal(completeHandoffRequest(request).status, 'updated')
    assert.equal(readFileSync(request.sourcePath, 'utf8'), 'new output')
    assert.equal(readFileSync(request.destinationPath, 'utf8'), 'new output')
    assert.equal(readFileSync(`${request.destinationPath}.previous-${request.requestId}`, 'utf8'), 'existing archive')

    const protectedTarget = begin('session-c', 'request-protected-target')
    writeFileSync(protectedTarget.sourcePath, 'output')
    mkdirSync(protectedTarget.destinationPath)
    assert.equal(completeHandoffRequest(protectedTarget).status, 'archive-exists')

    const blockedParent = join(root, 'blocked-parent')
    writeFileSync(blockedParent, 'not a directory')
    const failed = createHandoffRequest(root, 'session-b', join(blockedParent, 'archive.md'), 'request-copy-error')
    writeFileSync(failed.sourcePath, 'output')
    assert.equal(completeHandoffRequest(failed).status, 'copy-failed')
    assert.equal(readFileSync(failed.sourcePath, 'utf8'), 'output')
  })

  it('拒绝复用或覆盖同一 sessionId + requestId 的已存在源文件', () => {
    const request = begin('session-a', 'same-request')
    writeFileSync(request.sourcePath, 'user data')
    assert.throws(() => createHandoffRequest(root, 'session-a', request.destinationPath, 'same-request'), /拒绝覆盖/)
    assert.equal(readFileSync(request.sourcePath, 'utf8'), 'user data')
  })

  it('空文件和目录都不会被当作有效 handoff 归档', () => {
    const empty = begin('session-empty', 'request-empty')
    writeFileSync(empty.sourcePath, '')
    assert.equal(completeHandoffRequest(empty).status, 'invalid-source')
    assert.equal(existsSync(empty.destinationPath), false)

    const directory = begin('session-dir', 'request-dir')
    mkdirSync(directory.sourcePath)
    assert.equal(completeHandoffRequest(directory).status, 'invalid-source')
    assert.equal(existsSync(directory.destinationPath), false)
  })
})

describe('buildHandoffPrompt — 交接指令', () => {
  const PATH = '/proj/.rivet/HANDOFF.md'

  it('含绝对路径与禁止覆盖已有源文件的指示', () => {
    const p = buildHandoffPrompt(PATH)
    assert.ok(p.includes(PATH), '含目标绝对路径')
    assert.match(p, /write_file/)
    assert.match(p, /绝不能覆盖/)
  })

  it('固定五章节齐全：任务目标/已完成/当前卡点/下一步/坑', () => {
    const p = buildHandoffPrompt(PATH)
    for (const section of ['## 任务目标', '## 已完成', '## 当前卡点', '## 下一步', '## 坑']) {
      assert.ok(p.includes(section), `缺章节 ${section}`)
    }
  })

  it('自包含契约：禁止引用上文、不许编造', () => {
    const p = buildHandoffPrompt(PATH)
    assert.match(p, /自包含/)
    assert.match(p, /不要编造/)
  })

  it('note 作为用户补充指示追加；空 note 不产生该行', () => {
    assert.match(buildHandoffPrompt(PATH, '重点记下缓存方案'), /用户补充指示：重点记下缓存方案/)
    assert.ok(!buildHandoffPrompt(PATH).includes('用户补充指示'))
    assert.ok(!buildHandoffPrompt(PATH, '   ').includes('用户补充指示'))
  })
})

describe('formatHandoffNudge — 60% 交接提醒', () => {
  it('文案含百分比与 /handoff 指引', () => {
    const s = formatHandoffNudge(0.63)
    assert.ok(s.includes('63%'), `含百分比: ${s}`)
    assert.ok(s.includes('/handoff'), `含命令指引: ${s}`)
    assert.match(s, /省前缀重建成本/)
  })

  it('阈值常量为 0.6', () => {
    assert.equal(HANDOFF_NUDGE_RATIO, 0.6)
  })
})
