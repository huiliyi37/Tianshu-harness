import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionContext } from '../context.js'
import { SessionPersist } from '../session-persist.js'
import { attachSessionPersistListener } from '../session-persist-listener.js'
import { persistStrippedImagesIfUnambiguous } from '../persisted-image-strip.js'
import { decodeTranscriptText } from '../session-transcript-codec.js'

let tempDir: string
let prevSessionDir: string | undefined

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'persist-listener-'))
  // 测试隔离：默认 sessionsDir 落在真实 ~/.rivet（CI 可写、沙箱 EPERM）。
  // 显式改道临时目录，既不污染真实会话目录，也让用例在任何环境可跑。
  prevSessionDir = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = join(tempDir, 'sessions')
})

after(() => {
  if (prevSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
  else process.env.RIVET_SESSION_DIR = prevSessionDir
  rmSync(tempDir, { recursive: true, force: true })
})

describe('attachSessionPersistListener — meta tokenUsage accounting', () => {
  it('worker knowledge and runtime instructions never replace a human session title', async () => {
    const session = new SessionContext(), persist = new SessionPersist('origin-title', tempDir)
    persist.initMetadata({ model: 'fixture' })
    const listener = attachSessionPersistListener({ session, persist })
    session.addUserMessage('<worker-knowledge>private fixture</worker-knowledge>', undefined, 'worker_task')
    await listener.drain()
    assert.equal(persist.loadMetadata()?.title, undefined)
    session.addUserMessage('Human objective')
    await listener.drain()
    assert.equal(persist.loadMetadata()?.title, 'Human objective')
  })
  it('prompt equals cache-inclusive input_tokens, not input+read+create (2x regression)', async () => {
    // Field bug (session 6bfc4465): meta prompt was exactly 2x the real 5.67M
    // because the patch added cache_read + cache_creation on top of DeepSeek's
    // already cache-inclusive input_tokens.
    const session = new SessionContext()
    const persist = new SessionPersist('meta-prompt-2x', tempDir)
    persist.initMetadata({ model: 'deepseek-v4-pro' })
    const listener = attachSessionPersistListener({ session, persist })

    // DeepSeek semantics: input = hit + miss.
    session.addUsage({
      input_tokens: 1000,
      output_tokens: 40,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 200,
    })
    // Trigger the listener via a message append (the hot path that patches meta).
    session.addUserMessage('hello')

    await listener.drain()
    const meta = persist.loadMetadata()
    assert.ok(meta?.tokenUsage)
    assert.equal(meta.tokenUsage.prompt, 1000)
    assert.equal(meta.tokenUsage.completion, 40)
    assert.equal(meta.tokenUsage.total, 1040)
  })

  it('持久化剥图：replace mutation 原子重写 transcript，图片不回魂（Grok image_strip 同款）', async () => {
    const session = new SessionContext()
    const persist = new SessionPersist('persisted-strip', tempDir)
    persist.initMetadata({ model: 'test' })
    const listener = attachSessionPersistListener({ session, persist })

    const img = 'data:image/png;base64,' + 'A'.repeat(128)
    session.addUserMessage('看这张图', [img])
    session.addAssistantBlocks([{ type: 'text', text: '看到了' }])

    const rawTranscript = (): string =>
      existsSync(persist.getFilePath())
        ? decodeTranscriptText(readFileSync(persist.getFilePath()))
        : ''

    // 前置：图片先按常规 append 落盘（user 消息 flushNow=true）。
    await listener.drain()
    assert.ok(rawTranscript().includes('A'.repeat(128)), '前置：图片 base64 已进 transcript')

    // 服务端明确拒图（唯一 URL）→ 写回历史；replace → compactOaiAsync 原子重写。
    assert.equal(
      persistStrippedImagesIfUnambiguous(session, { removedCount: 1, uniqueUrlCount: 1 }),
      true,
    )
    await listener.drain()
    const onDisk = rawTranscript()
    assert.ok(!onDisk.includes('A'.repeat(128)), '重写后的 transcript 不得再含图片 base64')
    assert.ok(onDisk.includes('no longer visible'), '占位符必须落盘（模型知道图已被移除）')
    assert.ok(!onDisk.includes('image_url'), '恢复后不得再构造 image_url part')
    assert.ok(
      JSON.stringify(persist.loadOai()).includes('no longer visible'),
      'loadOai 恢复出来的历史带占位符而不是图片',
    )
  })
})
