/**
 * POST /sessions 携带文档附件（欢迎页按钮/拖拽/粘贴，2026-09-12）——
 * 与 /prompt 同一份 validateDocumentsPayload 校验与 extractDocumentsToText
 * 抽取管线：抽取文本前置进首轮 prompt。此前 POST /sessions 没有该管线，
 * 欢迎页附件只能「建会话后再发」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import {
  RuntimeSessionManager,
  type ManagedAgent,
  type SessionPersistenceAdapter,
} from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  runPrompts: string[] = []
  private resolveRun?: () => void
  run(p: string, cb: AgentCallbacks) {
    this.runPrompts.push(p)
    this.callbacks = cb
    return new Promise<void>((r) => { this.resolveRun = r })
  }
  abort() { this.resolveRun?.() }
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

function setup() {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new FakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { manager, agents, router }
}

type Router = ReturnType<typeof setup>['router']

/** 最小合法 xlsx（exceljs 现场构建，纯 JS 无系统依赖）。 */
async function makeXlsxDataUrl(marker: string): Promise<string> {
  const ExcelJS = createRequire(import.meta.url)('exceljs')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('S1')
  ws.getCell('A1').value = marker
  const buf = await wb.xlsx.writeBuffer()
  return `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${Buffer.from(buf as ArrayBuffer).toString('base64')}`
}

const PDF_DOC = { name: 'spec.pdf', dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK' }

test('POST /sessions documents 校验：空数组 / 超上限 / 形态错误 / 超尺寸 → 400', async () => {
  const { router } = setup()
  const create = (documents: unknown) => router('POST', '/sessions', { prompt: 'x', documents }, AUTH)

  let res = await create([])
  assert.equal(res.status, 400)
  assert.match((res.body as { error: string }).error, /non-empty array/)

  res = await create(Array.from({ length: 5 }, (_, i) => ({ name: `d${i}.pdf`, dataUrl: PDF_DOC.dataUrl })))
  assert.equal(res.status, 400)
  assert.match((res.body as { error: string }).error, /Max 4/)

  res = await create([{ name: 'd.pdf' }])
  assert.equal(res.status, 400)
  assert.match((res.body as { error: string }).error, /name: string, dataUrl: string/)

  const huge = `data:application/pdf;base64,${'A'.repeat(11 * 1024 * 1024)}`
  res = await create([{ name: 'big.pdf', dataUrl: huge }])
  assert.equal(res.status, 400)
  assert.match((res.body as { error: string }).error, /<= 8MB/)
})

test('documents 扩展名白名单：非可抽取类型拒收（与 doc-extract 的 EXTRACTABLE 对齐）', async () => {
  // 此前只校验数量/字段类型/字节数——任意扩展名都能过服务端、落盘并交给抽取器。
  // 同一文件的图片路径有 ACCEPTED_IMAGE_DATA_URL 正则把关，documents 没有；
  // 白名单取 doc-extract 的 EXTRACTABLE（能抽取才放行），两侧守卫对称。
  const { router } = setup()
  const create = (documents: unknown) => router('POST', '/sessions', { prompt: 'x', documents }, AUTH)

  let res = await create([{ name: 'evil.exe', dataUrl: PDF_DOC.dataUrl }])
  assert.equal(res.status, 400, '非可抽取扩展名应被拒')
  assert.match((res.body as { error: string }).error, /extractable/i)

  res = await create([{ name: 'noext', dataUrl: PDF_DOC.dataUrl }])
  assert.equal(res.status, 400, '无扩展名应被拒')

  res = await create([{ name: 'FORMULA.XLSX', dataUrl: PDF_DOC.dataUrl }])
  assert.equal(res.status, 201, '白名单应大小写不敏感地放行可抽取类型')
})

test('POST /sessions 携带 xlsx → 201 且首轮 prompt 含抽取文本（欢迎页文档链路）', async () => {
  const { agents, router } = setup()
  const marker = `welcome-doc-${Date.now()}`
  const dataUrl = await makeXlsxDataUrl(marker)
  const res = await router('POST', '/sessions', {
    prompt: '看下这份表',
    documents: [{ name: 'report.xlsx', dataUrl }],
  }, AUTH)
  assert.equal(res.status, 201)
  assert.equal(agents.length, 1)
  assert.equal(agents[0]!.runPrompts.length, 1)
  assert.ok(agents[0]!.runPrompts[0]!.includes(marker), '抽取的表格文本应前置进首轮 prompt')
  assert.ok(agents[0]!.runPrompts[0]!.includes('看下这份表'), '用户 prompt 本体保留')
})

test('POST /sessions 文档抽取失败（伪 pdf）不阻断创建——降级为失败标注进 prompt', async () => {
  const { agents, router } = setup()
  const res = await router('POST', '/sessions', {
    prompt: 'analyze this',
    documents: [PDF_DOC],
  }, AUTH)
  assert.equal(res.status, 201)
  assert.equal(agents.length, 1)
  // 抽取失败不静默：prompt 带 [document] 标注与失败原因（agent 知道附件存在及为何没内容）
  const p = agents[0]!.runPrompts[0]!
  assert.ok(p.includes('[document: spec.pdf]'), '应带文档标注')
  assert.ok(p.includes('extraction failed'), '应声明抽取失败')
  assert.ok(p.endsWith('analyze this'), '用户 prompt 本体保留在尾部')
})

test('POST /sessions 不带 documents → 行为不变（回归）', async () => {
  const { agents, router } = setup()
  const res = await router('POST', '/sessions', { prompt: 'plain' }, AUTH)
  assert.equal(res.status, 201)
  assert.equal(agents[0]!.runPrompts[0], 'plain')
})

test('POST /sessions/:id/prompt documents 校验走同一 helper（重构回归）', async () => {
  const { router, manager } = setup()
  const rec = manager.createSession({ cwd: '/tmp/work' }) as { id: string }
  const res = await router('POST', `/sessions/${rec.id}/prompt`, { prompt: 'x', documents: [] }, AUTH)
  assert.equal(res.status, 400)
  assert.match((res.body as { error: string }).error, /non-empty array/)
})
