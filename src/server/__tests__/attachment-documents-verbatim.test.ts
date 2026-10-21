/**
 * 文档附件「原样落盘 + 句柄文本」（2026-10-21，dsh 句柄式，与压缩包同范式）——
 * 此前 extractDocumentsToText 把文档写临时目录、抽完即删，prompt 里只有有损
 * 抽取文本、没有任何路径，agent 要原文只能全盘 find（用户实报：两个 xlsx
 * 找不到位置）。现 persistDocumentsVerbatim 内容寻址落盘（幂等/只读/保真
 * 扩展名），抽取改读落盘副本，句柄带 savedPath 进 prompt。
 *
 * 装配与 attachment-archives.test.ts 同源：真实 RuntimeSessionManager +
 * 真实 FileSessionPersistence（临时目录）+ 真实路由，LLM 侧换记录型 FakeAgent。
 */
import './disable-cpu-pool.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { FileSessionPersistence } from '../session-persistence.js'
import { buildDocumentHandleText, extractDocumentsToText } from '../attachment-validation.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class RecordingAgent implements ManagedAgent {
  runs: Array<{ prompt: string }> = []
  callbacks?: AgentCallbacks
  private resolveRun?: () => void
  run(p: string, cb: AgentCallbacks) {
    this.runs.push({ prompt: p })
    this.callbacks = cb
    return new Promise<void>((r) => { this.resolveRun = r })
  }
  abort() { this.resolveRun?.() }
  finish() { this.resolveRun?.() }
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

/** 真实 xlsx 字节（exceljs 生成，与 doc-extract 的抽取引擎同族——抽取必中）。 */
async function xlsxBytes(rows: string[][]): Promise<Buffer> {
  const ExcelJS = createRequire(import.meta.url)('exceljs')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('数据')
  for (const row of rows) ws.addRow(row)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'doc-verbatim-'))
  const persistence = new FileSessionPersistence(dir)
  const agents: RecordingAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new RecordingAgent(); agents.push(a); return a },
    defaultCwd: dir,
    persistence,
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { dir, manager, router, agents, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function createSession(router: ReturnType<typeof createRouter>, agents: RecordingAgent[]): Promise<string> {
  const created = await router('POST', '/sessions', { prompt: 'init' }, AUTH)
  assert.equal(created.status, 201)
  // 建会话的首轮 run 收尾，后续 /prompt 才不会 409 busy（路由会 waitForRunSettled）。
  agents.at(-1)!.finish()
  return (created.body as { id: string }).id
}

test('xlsx 附件：prompt 带句柄（savedPath/sha256），落盘副本只读且扩展名保真', async () => {
  const { dir, router, agents, cleanup } = setup()
  try {
    const id = await createSession(router, agents)
    const bytes = await xlsxBytes([['县市', '处理率'], ['南平', '97.5%']])
    const sha = createHash('sha256').update(bytes).digest('hex')
    const dataUrl = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${bytes.toString('base64')}`

    const result = await router('POST', `/sessions/${id}/prompt`, {
      prompt: '统计南平的处理率', documents: [{ name: '南平报表.xlsx', dataUrl }],
    }, AUTH)
    assert.equal(result.status, 200)

    const prompt = agents.at(-1)!.runs.at(-1)!.prompt
    const savedPath = join(dir, id, 'documents', `${sha}.xlsx`)
    // 句柄在抽取文本之前（块首），路径进 prompt——模型不再需要全盘 find。
    assert.ok(prompt.includes(`[document: 南平报表.xlsx (`), prompt.slice(0, 400))
    assert.ok(prompt.includes(`sha256:${sha.slice(0, 8)}`))
    assert.ok(prompt.includes(`Saved verbatim at: ${savedPath}`))
    assert.ok(prompt.indexOf('Saved verbatim at:') < prompt.indexOf('[extracted-text]'))
    // 抽取照常（exceljs → 表格文本）。
    assert.ok(prompt.includes('南平'))
    // 落盘副本：内容寻址、字节一致、只读。
    assert.ok(existsSync(savedPath))
    assert.deepEqual(readFileSync(savedPath), bytes)
    assert.equal(statSync(savedPath).mode & 0o222, 0, '副本必须只读（agent 要改先自己拷贝）')
  } finally {
    cleanup()
  }
})

test('user 事件文档引用复用 verbatim 副本（id=内容 sha256），不再随机 docId 二次落盘', async () => {
  const { dir, manager, router, agents, cleanup } = setup()
  try {
    const id = await createSession(router, agents)
    const bytes = await xlsxBytes([['a', 'b']])
    const sha = createHash('sha256').update(bytes).digest('hex')
    const dataUrl = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${bytes.toString('base64')}`

    const result = await router('POST', `/sessions/${id}/prompt`, {
      prompt: '看看', documents: [{ name: 'a.xlsx', dataUrl }],
    }, AUTH)
    assert.equal(result.status, 200)

    const user = manager.getEvents(id, 0)!.events.filter((e) => e.type === 'user').at(-1)!
    const docs = (user.data as { documents?: Array<{ id: string; name: string; bytes: number; mime: string }> }).documents
    assert.equal(docs?.length, 1, '同一份附件只出一个卡片引用（verbatim 覆盖后不二次落盘）')
    assert.equal(docs![0]!.id, sha)
    assert.equal(docs![0]!.bytes, bytes.length)
    // savedPath/sha256short 不进事件流（只进 prompt 句柄）。
    assert.ok(!('savedPath' in docs![0]!) && !('sha256short' in docs![0]!))
    // 卡片回读通道（GET documents/:docId）对 sha256 id 同表可用。
    const back = manager.readDocument(id, sha)
    assert.ok(back)
    assert.deepEqual(back!.bytes, bytes)
  } finally {
    cleanup()
  }
})

test('抽取失败的文档仍带句柄（路径是降级后的自救通道）', async () => {
  const { dir, router, agents, cleanup } = setup()
  try {
    const id = await createSession(router, agents)
    const bytes = Buffer.from('definitely not a real xlsx payload')
    const sha = createHash('sha256').update(bytes).digest('hex')
    const dataUrl = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${bytes.toString('base64')}`

    const result = await router('POST', `/sessions/${id}/prompt`, {
      prompt: '读它', documents: [{ name: 'broken.xlsx', dataUrl }],
    }, AUTH)
    assert.equal(result.status, 200)

    const prompt = agents.at(-1)!.runs.at(-1)!.prompt
    assert.ok(prompt.includes(`Saved verbatim at: ${join(dir, id, 'documents', `${sha}.xlsx`)}`))
    assert.match(prompt, /extraction (failed|error)/)
  } finally {
    cleanup()
  }
})

test('文本附件不落盘不给句柄（全文内联），无 saved 的文档维持旧形态', async () => {
  // 纯 extractDocumentsToText 单元面：无 saved 参数 → 旧临时文件路径 + 无句柄。
  const text = Buffer.from('hello 文本附件').toString('base64')
  const out = await extractDocumentsToText([
    { name: 'notes.txt', dataUrl: `data:text/plain;base64,${text}` },
  ])
  assert.ok(out!.startsWith('[file: notes.txt]'))
  assert.ok(out!.includes('hello 文本附件'))
  assert.ok(!out!.includes('Saved verbatim at:'))
})

test('buildDocumentHandleText 句柄契约：路径 + 只读/委派纪律', () => {
  const handle = buildDocumentHandleText({ name: 'a.xlsx', bytes: 2048, sha256short: 'abcd1234', savedPath: '/tmp/x/a.xlsx' })
  assert.ok(handle.startsWith('[document: a.xlsx (2.0 KB, sha256:abcd1234)]'))
  assert.ok(handle.includes('Saved verbatim at: /tmp/x/a.xlsx'))
  assert.ok(handle.includes('read_file'))
  assert.ok(handle.includes('delegation'))
})

test('saveVerbatimDocument 幂等：同内容二次落盘同路径、不重复写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-verbatim-persist-'))
  try {
    const persistence = new FileSessionPersistence(dir)
    const bytes = Buffer.from('same-content')
    const sha = createHash('sha256').update(bytes).digest('hex')
    const first = persistence.saveVerbatimDocument('s1', sha, { base64: bytes.toString('base64') }, '报表.xlsx')
    const second = persistence.saveVerbatimDocument('s1', sha, { base64: bytes.toString('base64') }, '报表.xlsx')
    assert.equal(first, second)
    assert.ok(first.endsWith(`${sha}.xlsx`), '扩展名保真（doc-extract/read_file 按扩展名分引擎）')
    assert.deepEqual(readFileSync(first), bytes)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
