/**
 * read_file 的表格/演示文稿抽取通道（2026-10-21）——xlsx/xls/ods/ppt/pptx/odp
 * 不在 BINARY_EXTENSIONS，此前落进文本通道把 zip 容器当 utf-8 读成乱码；
 * 文档附件句柄（savedPath 进 prompt）落地后，模型按句柄 read_file 原文件
 * 走的就是这条通道，必须能真读出内容。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { readFilePayload } from '../read-file.js'

async function writeXlsx(dir: string, name: string, rows: string[][]): Promise<string> {
  const ExcelJS = createRequire(import.meta.url)('exceljs')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('数据')
  for (const row of rows) ws.addRow(row)
  const path = join(dir, name)
  await wb.xlsx.writeFile(path)
  return path
}

test('xlsx 经 doc-extract 引擎转成表格文本（不再是 zip 乱码）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-xlsx-'))
  try {
    const path = await writeXlsx(dir, '南平报表.xlsx', [['县市', '处理率'], ['延平', '97.5%']])
    const payload = await readFilePayload(dir, { filePath: path })
    assert.ok(payload.modelContent.includes('延平'), payload.modelContent.slice(0, 200))
    assert.ok(payload.modelContent.includes('处理率'))
    assert.ok(payload.modelContent.includes('── Office document (.xlsx, converted via exceljs) ──'))
    assert.ok(payload.rawContent.includes('延平'))
    assert.ok(payload.uiContent.length <= 200)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('损坏的 xlsx 给出清楚的抽取失败错误（而非静默乱码）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-xlsx-broken-'))
  try {
    const path = join(dir, 'broken.xlsx')
    writeFileSync(path, Buffer.from('not a zip at all'))
    await assert.rejects(
      () => readFilePayload(dir, { filePath: path }),
      /extraction failed|binary/i,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
