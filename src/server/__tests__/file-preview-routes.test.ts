/**
 * 二进制文件预览路由（2026-09-22，桌面端侧边栏 word/pdf/pptx 预览）——
 *  - `GET /sessions/:id/file-content?raw=1`：raw 字节 + 真实 MIME（pdf/docx/
 *    pptx/图片白名单），沿用 validatePath cwd 沙箱，8MB 上限（附件口径）。
 *  - `GET /sessions/:id/file-preview/pdf`：office → PDF（soffice），
 *    415 非可转换扩展名 / 404 文件缺失 / 422 转换失败或 soffice 未安装。
 * 两条路由都是 res 接管（handled:true）的二进制响应——测试用 fake
 *  ServerResponse 捕获 writeHead/end。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import {
  RuntimeSessionManager,
  type ManagedAgent,
} from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  run(_p: string, cb: AgentCallbacks) {
    this.callbacks = cb
    return new Promise<void>(() => {})
  }
  abort() {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

interface Captured {
  status: number
  headers: Record<string, string | number>
  body: Buffer | null
}

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: null }
  const res = {
    writeHead(status: number, headers: Record<string, string | number>) {
      captured.status = status
      captured.headers = headers
      return res
    },
    end(body?: Buffer) {
      captured.body = body ?? null
      return res
    },
  }
  return { res: res as unknown as ServerResponse, captured }
}

async function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'file-preview-routes-'))
  const manager = new RuntimeSessionManager({
    createAgent: () => new FakeAgent(),
    defaultCwd: cwd,
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  const created = await router('POST', '/sessions', { prompt: 'x' }, AUTH)
  assert.equal(created.status, 201)
  const id = (created.body as { id: string }).id
  return { cwd, router, id, cleanup: () => rmSync(cwd, { recursive: true, force: true }) }
}

test('file-content?raw=1 返回 raw 字节与真实 MIME', async () => {
  const { cwd, router, id, cleanup } = await setup()
  try {
    const pdfBytes = Buffer.from('%PDF-1.4 fake-pdf-bytes')
    writeFileSync(join(cwd, 'spec.pdf'), pdfBytes)

    const { res, captured } = fakeRes()
    const result = await router('GET', `/sessions/${id}/file-content?path=spec.pdf&raw=1`, {}, AUTH, res)
    assert.equal(result.handled, true)
    assert.equal(captured.status, 200)
    assert.equal(captured.headers['Content-Type'], 'application/pdf')
    assert.ok(captured.body)
    assert.deepEqual(captured.body, pdfBytes)
  } finally {
    cleanup()
  }
})

test('file-content?raw=1 白名单外扩展名 → 415；路径逃逸 → 403', async () => {
  const { cwd, router, id, cleanup } = await setup()
  try {
    writeFileSync(join(cwd, 'data.xyz'), Buffer.from('whatever'))
    const { res } = fakeRes()
    let result = await router('GET', `/sessions/${id}/file-content?path=data.xyz&raw=1`, {}, AUTH, res)
    assert.equal(result.status, 415)

    result = await router('GET', `/sessions/${id}/file-content?path=..%2Fsecret.pdf&raw=1`, {}, AUTH, fakeRes().res)
    assert.equal(result.status, 403)
  } finally {
    cleanup()
  }
})

test('file-content?raw=1 超过 8MB → 413（文本模式 512KB 上限不受影响）', async () => {
  const { cwd, router, id, cleanup } = await setup()
  try {
    writeFileSync(join(cwd, 'big.pdf'), Buffer.alloc(9 * 1024 * 1024, 1))
    const result = await router('GET', `/sessions/${id}/file-content?path=big.pdf&raw=1`, {}, AUTH, fakeRes().res)
    assert.equal(result.status, 413)
  } finally {
    cleanup()
  }
})

test('file-preview/pdf 非可转换扩展名 → 415；文件缺失 → 404', async () => {
  const { cwd, router, id, cleanup } = await setup()
  try {
    writeFileSync(join(cwd, 'notes.txt'), 'hello')
    let result = await router('GET', `/sessions/${id}/file-preview/pdf?path=notes.txt`, {}, AUTH, fakeRes().res)
    assert.equal(result.status, 415)

    result = await router('GET', `/sessions/${id}/file-preview/pdf?path=gone.pptx`, {}, AUTH, fakeRes().res)
    assert.equal(result.status, 404)

    result = await router('GET', `/sessions/${id}/file-preview/pdf?path=..%2Fx.pptx`, {}, AUTH, fakeRes().res)
    assert.equal(result.status, 403)
  } finally {
    cleanup()
  }
})

test('file-preview/pdf 损坏 pptx → 422（soffice 转换失败或未安装都落 422）', { timeout: 120_000 }, async () => {
  const { cwd, router, id, cleanup } = await setup()
  try {
    writeFileSync(join(cwd, 'broken.pptx'), Buffer.from('not a real zip'))
    const result = await router('GET', `/sessions/${id}/file-preview/pdf?path=broken.pptx`, {}, AUTH, fakeRes().res)
    assert.equal(result.status, 422)
    const body = result.body as { error: string }
    assert.ok(body.error === 'conversion_failed' || body.error === 'converter_unavailable')
  } finally {
    cleanup()
  }
})
