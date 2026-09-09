/**
 * Regression: sidecar restart loses LLM context.
 *
 * Root cause: when the Rust shell spawns a fresh `rivet serve` sidecar, the
 * RuntimeSessionManager rehydrates session *records* + *event logs* from disk,
 * but the agent's LLM message stack (SessionContext.oaiMessages) is NOT
 * restored. The TUI bootstrap path does `persist.loadOai()` + `replaceMessages()`;
 * the desktop sidecar path (`buildSessionStores`) was missing the equivalent
 * call, so a user opening a prior session after restart sees the full UI
 * history (from the event log) but the model receives an empty context.
 *
 * This test verifies the exported helper that buildSessionStores calls to
 * restore prior OAI messages into a fresh SessionContext — the exact gap.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionPersist } from '../../agent/session-persist.js'
import { SessionContext } from '../../agent/context.js'
import { restoreHistoryMessages } from '../serve.js'
import { appendChecksum } from '../../agent/checksum.js'
import { isAssistantWithTools, type OaiMessage } from '../../api/oai-types.js'

let tmpDir: string
const ORIG_SESSION_DIR = process.env.RIVET_SESSION_DIR

before(() => {
  tmpDir = join(process.cwd(), '.tmp', `rivet-restore-test-${process.pid}`)
  mkdirSync(tmpDir, { recursive: true })
  process.env.RIVET_SESSION_DIR = tmpDir
})

after(() => {
  if (ORIG_SESSION_DIR !== undefined) process.env.RIVET_SESSION_DIR = ORIG_SESSION_DIR
  else delete process.env.RIVET_SESSION_DIR
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
})

/** Write OAI messages to a session .jsonl file (checksummed, matching SessionPersist format). */
function seedSession(sessionId: string, messages: OaiMessage[]): void {
  const persist = new SessionPersist(sessionId, '/fake-cwd')
  const lines = messages.map(m => appendChecksum(JSON.stringify(m)) + '\n').join('')
  writeFileSync(persist.getFilePath(), lines, 'utf8')
}

test('restoreHistoryMessages: loads prior OAI messages into a fresh SessionContext', () => {
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const seed: OaiMessage[] = [
    { role: 'user', content: 'What is 2+2?' },
    { role: 'assistant', content: '4' },
  ]
  seedSession(sessionId, seed)

  const persist = new SessionPersist(sessionId, '/fake-cwd')
  const session = new SessionContext()

  assert.equal(session.getMessages().length, 0, 'fresh context starts empty')

  const info = restoreHistoryMessages(persist, session)

  assert.equal(info.restored, 2, 'returns the number of restored messages')
  assert.equal(info.error, undefined)
  const msgs = session.getMessages()
  assert.equal(msgs.length, 2, 'context now holds the prior conversation')
  assert.equal(msgs[0]!.role, 'user')
  assert.equal(msgs[0]!.content, 'What is 2+2?')
  assert.equal(msgs[1]!.role, 'assistant')
  assert.equal(msgs[1]!.content, '4')
})

test('restoreHistoryMessages: no-op for a brand-new session with no prior file', () => {
  const sessionId = 'new-session-no-file'
  // Deliberately do NOT seed any file — this is the brand-new session path.
  const persist = new SessionPersist(sessionId, '/fake-cwd')
  const session = new SessionContext()

  const info = restoreHistoryMessages(persist, session)

  assert.equal(info.restored, 0, 'no messages to restore')
  assert.equal(session.getMessages().length, 0, 'context stays empty for new sessions')
})

test('restoreHistoryMessages: no-op when session file is empty', () => {
  const sessionId = 'empty-session'
  // Create the file but with no valid messages.
  const persist = new SessionPersist(sessionId, '/fake-cwd')
  writeFileSync(persist.getFilePath(), '', 'utf8')

  const session = new SessionContext()
  const info = restoreHistoryMessages(persist, session)
  assert.equal(info.restored, 0)
  assert.equal(session.getMessages().length, 0)
})

test('restoreHistoryMessages: hard IO failure degrades to empty context with error surfaced', () => {
  const sessionId = 'io-broken-session'
  const persist = new SessionPersist(sessionId, '/fake-cwd')
  // A DIRECTORY at the session file path makes readFileSync throw EISDIR —
  // the "file exists but unreadable" class of failure.
  mkdirSync(persist.getFilePath(), { recursive: true })

  const session = new SessionContext()
  const info = restoreHistoryMessages(persist, session)

  assert.equal(info.restored, 0, 'nothing restored')
  assert.ok(info.error, 'error is surfaced instead of thrown')
  assert.equal(session.getMessages().length, 0, 'context left empty, session still buildable')
})

test('restoreHistoryMessages: appends disk reconciliation note after a crash', () => {
  const sessionId = 'disk-reconcile-session'
  const cwd = join(tmpDir, 'work')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'fresh-product.ts'), 'export const done = true\n', 'utf-8')

  const persist = new SessionPersist(sessionId, cwd)
  persist.initMetadata({ cleanExit: false, updatedAt: Date.now() - 1_000 })
  const seed: OaiMessage[] = [
    { role: 'user', content: 'do work' },
    { role: 'assistant', content: 'doing work' },
  ]
  writeFileSync(persist.getFilePath(), seed.map(m => appendChecksum(JSON.stringify(m)) + '\n').join(''), 'utf8')

  const session = new SessionContext()
  const info = restoreHistoryMessages(persist, session, cwd)

  assert.equal(info.restored, 3, 'two history messages + one reconciliation note')
  const msgs = session.getMessages()
  const last = msgs.at(-1)!
  assert.equal(last.role, 'user')
  assert.match(String(last.content), /fresh-product\.ts/)
  assert.match(String(last.content), /read_file/)
})

test('restoreHistoryMessages: handles tool_call/tool_result pairs correctly', () => {
  const sessionId = 'tool-session'
  const seed: OaiMessage[] = [
    { role: 'user', content: 'read the file' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/tmp/a"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'file contents here' },
    { role: 'assistant', content: 'The file contains...' },
  ]
  seedSession(sessionId, seed)

  const persist = new SessionPersist(sessionId, '/fake-cwd')
  const session = new SessionContext()

  const info = restoreHistoryMessages(persist, session)

  assert.equal(info.restored, 4, 'all 4 messages restored including tool exchange')
  const msgs = session.getMessages()
  const assistant = msgs[1]!
  assert.ok(isAssistantWithTools(assistant), 'second message restored as assistant with tool_calls')
  assert.equal(assistant.tool_calls.length, 1)
  assert.equal(msgs[2]!.role, 'tool')
  assert.equal(msgs[2]!.tool_call_id, 'call_1')
})
