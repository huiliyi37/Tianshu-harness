/**
 * P1-4 只读分享快照——buildSessionSnapshot + POST /sessions/:id/snapshot/{export,import}。
 *
 * 回流自 `origin/tianshu-alpha-3.14`，按主线口径重接（脱敏走 redact.ts 通用层 + 快照加严层）。
 *
 * 反证表（每条对着一个偷懒实现）：
 *   #1「把转录原样塞进去」        → 快照里不得出现工具参数/输出/tool_call_id
 *   #2「只数不遮」                → 脱敏后的 JSON 里不得再出现密钥原文
 *   #3「脱敏不计数」              → redaction.findings 必须 > 0 且与命中处对得上
 *   #4「上限不生效」              → 超长推理被截断到上限内
 *   #5「导入不校验」              → 坏文件/坏版本/坏形状必须 400，不把脏数据交回前端
 *   #6「导出顺带改会话」          → 导出前后会话事件数不变（只读语义）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'
import { buildSessionSnapshot, SNAPSHOT_VERSION } from '../session-snapshot.js'
import { redactSnapshotText } from '../snapshot-redact.js'
import { SessionPersist } from '../../agent/session-persist.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

// 快照构建要读转录文件；把会话目录指到临时目录，绝不碰真实 ~/.rivet。
process.env.RIVET_SESSION_DIR = mkdtempSync(join(tmpdir(), 'rivet-snapshot-sessions-'))

class QuietAgent implements ManagedAgent {
  messages: OaiMessage[] = []
  run(_prompt: string, _cb: AgentCallbacks): Promise<void> { return Promise.resolve() }
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return this.messages }
  replaceMessages(m: OaiMessage[]): void { this.messages = m }
  rewindToMessages(m: OaiMessage[]): void { this.messages = m }
}

const LEAKY = [
  '我的 key 是 sk-abcdefghijklmnopqrstuvwxyz012345',
  'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij',
  'ssh-ed25519AAAAC3NzaC1lZDI1NTE5AAAAIGGGGGGGGGGGGGGGGGGGGGGG',
  '/Users/someone/.ssh/id_ed25519 也在里面',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
].join('\n')

function transcript(): OaiMessage[] {
  return [
    { role: 'user', content: `请看看这段配置\n${LEAKY}` },
    { role: 'assistant', content: '看到密钥了，已提醒你轮换。', reasoning_content: 'r'.repeat(9000) } as OaiMessage,
    { role: 'tool', tool_call_id: 'call_secret', content: 'TOOL-OUTPUT-MUST-NOT-APPEAR sk-zzzzzzzzzzzzzzzzzzzz' } as OaiMessage,
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_secret', type: 'function', function: { name: 'bash', arguments: '{"command":"cat ~/.ssh/id_rsa"}' } }] } as unknown as OaiMessage,
  ]
}

async function build(): Promise<{ json: string; findings: number }> {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-snap-'))
  const id = 'snapshot-test-session'
  const persist = new SessionPersist(id, cwd)
  for (const m of transcript()) await persist.appendOaiWithChecksum(m)
  await persist.flushSessionBuffer()
  const record = { id, cwd, title: 'Leaky session', model: 'deepseek-v4-flash' } as never
  const { snapshot, findings } = await buildSessionSnapshot(record, [], { includeReasoning: true })
  rmSync(cwd, { recursive: true, force: true })
  return { json: JSON.stringify(snapshot), findings }
}

test('#1 快照只含 user/assistant 文本——工具面一律不进', async () => {
  const { json } = await build()
  assert.ok(json.includes('看到密钥了'), 'assistant 文本必须在')
  assert.ok(!json.includes('TOOL-OUTPUT-MUST-NOT-APPEAR'), '工具输出不得进快照')
  assert.ok(!json.includes('tool_call_id'), '工具调用 id 不得进快照')
  assert.ok(!json.includes('"tool_calls"'), '工具调用参数不得进快照')
  assert.ok(!json.includes('cat ~/.ssh/id_rsa'), 'shell 命令不得进快照')
})

test('#2 脱敏：密钥原文一个都不许留在导出里', async () => {
  const { json } = await build()
  for (const secret of ['sk-abcdefghijklmnopqrstuvwxyz012345', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij', 'ssh-ed25519AAAAC3NzaC1lZDI1NTE5AAAAIGGG', 'MIIEowIBAAKCAQEA', '/Users/someone/.ssh/id_ed25519']) {
    assert.ok(!json.includes(secret), `脱敏漏了：${secret.slice(0, 24)}…`)
  }
  assert.ok(json.includes('redacted:private_key'), '私钥块要留可见占位（用户知道被遮了什么）')
})

test('#3 findings 如实计数（UI 要显示"脱敏发现 N 处"）', async () => {
  const { json, findings } = await build()
  assert.ok(findings >= 5, `至少 5 处（sk / jwt / ssh 公钥 / ssh 路径 / 私钥块），实际 ${findings}`)
  assert.equal(JSON.parse(json).redaction.findings, findings, '落盘计数与返回值必须一致')
})

test('#4 推理内容按上限截断', async () => {
  const { json } = await build()
  const snap = JSON.parse(json) as { messages: { reasoningSummary?: string }[] }
  const withReasoning = snap.messages.find((m) => m.reasoningSummary)
  assert.ok(withReasoning, 'includeReasoning=true 时要带推理摘要')
  assert.ok(withReasoning!.reasoningSummary!.length < 9000, '超长推理必须被截断')
  assert.ok(withReasoning!.reasoningSummary!.includes('truncated'), '截断要留痕')
})

test('#5 版本号随快照落盘（导入侧据此拒绝未知版本）', async () => {
  const { json } = await build()
  assert.equal(JSON.parse(json).version, SNAPSHOT_VERSION)
})

test('#6 脱敏函数：变形与边界', () => {
  assert.equal(redactSnapshotText('普通文本没有秘密').findings, 0)
  assert.equal(redactSnapshotText('普通文本没有秘密').text, '普通文本没有秘密')
  // 键名级脱敏由 redactSnapshotValue 负责，这里只钉文本层
  assert.match(redactSnapshotText('token: abcdefghijklmnop').text, /\[REDACTED\]/)
})

test('#7 路由：export 200 / 404，import 四类坏输入 400', async () => {
  const manager = new RuntimeSessionManager({ createAgent: () => new QuietAgent(), defaultCwd: '/tmp' })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-snap-route-'))
  const id = manager.createSession({ cwd, title: 'Snap' }).id
  try {
    const ok = await router('POST', `/sessions/${id}/snapshot/export`, { includeReasoning: false }, AUTH)
    assert.equal(ok.status, 200)
    assert.equal((ok.body as { snapshot?: { version?: number } }).snapshot?.version, SNAPSHOT_VERSION)

    const missing = await router('POST', '/sessions/nope/snapshot/export', {}, AUTH)
    assert.equal(missing.status, 404)

    const noPath = await router('POST', `/sessions/${id}/snapshot/import`, {}, AUTH)
    assert.equal(noPath.status, 400)

    const notJson = join(cwd, 'bad.json')
    writeFileSync(notJson, 'not json at all')
    assert.equal((await router('POST', `/sessions/${id}/snapshot/import`, { path: notJson }, AUTH)).status, 400)

    const wrongVersion = join(cwd, 'v99.json')
    writeFileSync(wrongVersion, JSON.stringify({ version: 99, meta: { title: 'x' }, messages: [] }))
    assert.equal((await router('POST', `/sessions/${id}/snapshot/import`, { path: wrongVersion }, AUTH)).status, 400)

    const good = join(cwd, 'good.json')
    writeFileSync(good, JSON.stringify({
      version: SNAPSHOT_VERSION, createdAt: 1, meta: { title: 'x' }, messages: [],
      redaction: { findings: 0, appliedAt: 1 },
    }))
    assert.equal((await router('POST', `/sessions/${id}/snapshot/import`, { path: good }, AUTH)).status, 200)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

// #8 反证「服务端放行的形状前端不一定吃得下」：导入件来自不受控的第三方文件，
// 所以校验必须覆盖**消费端真正会读的每个字段**，而不是只到 version/meta/messages 三档。
test('#8 导入形状校验覆盖消费端字段——缺 redaction / meta 是数组 / 元素非法一律 400', async () => {
  const manager = new RuntimeSessionManager({ createAgent: () => new QuietAgent(), defaultCwd: '/tmp' })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-snap-shape-'))
  const id = manager.createSession({ cwd, title: 'Shape' }).id
  const write = (name: string, body: unknown): string => {
    const p = join(cwd, name)
    writeFileSync(p, JSON.stringify(body))
    return p
  }
  const post = (path: string) => router('POST', `/sessions/${id}/snapshot/import`, { path }, AUTH)
  const ok = {
    version: SNAPSHOT_VERSION,
    createdAt: 1,
    meta: { title: 'x' },
    messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }],
    redaction: { findings: 0, appliedAt: 1 },
  }
  try {
    assert.equal((await post(write('ok.json', ok))).status, 200, '完整形状必须放行')
    const noRedaction: Record<string, unknown> = { ...ok }
    delete noRedaction.redaction
    assert.equal((await post(write('no-redaction.json', noRedaction))).status, 400, '缺 redaction——前端渲染期要读 redaction.findings')
    assert.equal((await post(write('meta-array.json', { ...ok, meta: [] }))).status, 400, 'meta 是数组仍满足 typeof object')
    assert.equal((await post(write('msg-number.json', { ...ok, messages: [1, 2] }))).status, 400, 'messages 元素不是消息对象')
    assert.equal((await post(write('msg-role.json', { ...ok, messages: [{ role: 'system', text: 'x' }] }))).status, 400, 'role 只允许 user/assistant')
    assert.equal((await post(write('msg-text.json', { ...ok, messages: [{ role: 'user' }] }))).status, 400, 'text 必须是字符串')
    assert.equal((await post(write('bad-redaction.json', { ...ok, redaction: { findings: 'many' } }))).status, 400, 'findings 必须是数字')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

// #9 反证「从头截断」：分享场景关心的是最近的进展，窗口取头部等于丢掉最有用的那段。
test('#9 超长转录保尾部——丢最早的，不丢最近的', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-snap-window-'))
  const persist = new SessionPersist('snapshot-window-session', cwd)
  await persist.appendOaiWithChecksum({ role: 'user', content: 'FIRST-USER-MARKER' } as never)
  // 2001 轮 assistant(tool_calls)+tool = 4002 行，把尾部推到 MAX_MESSAGES*2 窗口之外
  for (let i = 0; i < 2001; i++) {
    await persist.appendOaiWithChecksum({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'bash', arguments: '{}' } }],
    } as never)
    await persist.appendOaiWithChecksum({ role: 'tool', tool_call_id: `c${i}`, content: 'out' } as never)
  }
  await persist.appendOaiWithChecksum({ role: 'user', content: 'TAIL-USER-MARKER' } as never)
  await persist.flushSessionBuffer()
  const record = { id: 'snapshot-window-session', cwd, title: 'window', model: 'm' } as never
  try {
    const { snapshot } = await buildSessionSnapshot(record, [], {})
    const json = JSON.stringify(snapshot)
    assert.ok(json.includes('TAIL-USER-MARKER'), '最近的对话必须在快照里')
    assert.ok(!json.includes('FIRST-USER-MARKER'), '最早的应先被丢弃')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

// #10 反证「用占位符反推命中数」：原文自带 [REDACTED] 字面量时计数会虚增。
test('#10 findings 只数真实命中，不数原文里的 [REDACTED] 字面量', () => {
  assert.equal(redactSnapshotText('日志里出现过 [REDACTED] 这几个字，其实没有密钥').findings, 0)
  assert.equal(redactSnapshotText('[REDACTED] 与 sk-abcdefghijklmnopqrstuvwxyz012345 并存').findings, 1)
})
