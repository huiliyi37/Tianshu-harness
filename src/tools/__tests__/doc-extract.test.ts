import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildEngineChain,
  extractDocumentText,
  isExtractableDocument,
  renderPdfPageImages,
  EXTRACTION_CAVEAT,
  pdfResourcePaths,
  type CommandRunner,
} from '../doc-extract.js'

function enoent(): NodeJS.ErrnoException {
  const err = new Error('spawn ENOENT') as NodeJS.ErrnoException
  err.code = 'ENOENT'
  return err
}

describe('doc-extract', () => {
  describe('isExtractableDocument', () => {
    it('recognizes office/pdf extensions case-insensitively', () => {
      assert.equal(isExtractableDocument('/x/report.PDF'), true)
      assert.equal(isExtractableDocument('/x/spec.docx'), true)
      assert.equal(isExtractableDocument('/x/deck.pptx'), true)
      assert.equal(isExtractableDocument('/x/notes.odt'), true)
    })

    it('rejects plain text and unknown extensions', () => {
      assert.equal(isExtractableDocument('/x/readme.md'), false)
      assert.equal(isExtractableDocument('/x/archive.zip'), false)
      assert.equal(isExtractableDocument('/x/noext'), false)
    })
  })

  describe('buildEngineChain', () => {
    it('pdf: pdftotext 优先 + pdfjs 纯 JS 兜底（无 poppler 也可抽取）', () => {
      const chain = buildEngineChain('.pdf', 'linux')
      assert.deepEqual(chain.map(s => s.engine), ['pdftotext', 'pdfjs'])
    })

    it('pdfjs 真抽取：最小 PDF 无系统依赖出文本', async () => {
      // 手写最小合法 PDF（单页 Helvetica 文本）——pdftotext 缺席的机器上
      // pdfjs 兜底必须出文（有 poppler 的机器走第一引擎，殊途同归）。
      const { mkdtempSync, writeFileSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const marker = 'welcome-pdfjs-marker-42'
      const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 59>>stream
BT /F1 24 Tf 72 720 Td (${marker}) Tj ET
endstream
endobj
trailer<</Root 1 0 R>>
%%EOF`
      const dir = mkdtempSync(join(tmpdir(), 'pdfjs-test-'))
      const p = join(dir, 'probe.pdf')
      writeFileSync(p, pdf, 'latin1')
      const r = await extractDocumentText(p)
      assert.ok(r.ok, `抽取应成功（任一引擎）：${r.ok === false ? r.suggestion : ''}`)
      assert.ok(r.text.includes(marker), '抽取文本应含标记')
      assert.ok(r.engine === 'pdftotext' || r.engine === 'pdfjs', `engine=${r.engine}`)
    })

    it('docx on linux skips textutil, ends with pandoc', () => {
      const chain = buildEngineChain('.docx', 'linux')
      assert.deepEqual(chain.map(s => s.engine), ['office-xml', 'soffice', 'pandoc'])
    })

    it('legacy .doc never includes pandoc (cannot read .doc)', () => {
      const chain = buildEngineChain('.doc', 'linux')
      assert.deepEqual(chain.map(s => s.engine), ['soffice'])
    })

    it('pptx uses built-in XML before soffice', () => {
      const chain = buildEngineChain('.pptx', 'darwin')
      assert.deepEqual(chain.map(s => s.engine), ['office-xml', 'soffice'])
    })

    it('unknown extension yields empty chain', () => {
      assert.deepEqual(buildEngineChain('.zip', 'linux'), [])
    })
  })

  describe('extractDocumentText', () => {
    it('returns text from the first available engine', async () => {
      const calls: string[] = []
      const runner: CommandRunner = async (binary) => {
        calls.push(binary)
        if (binary === 'pdftotext') return { stdout: 'PDF BODY TEXT' }
        throw enoent()
      }
      const result = await extractDocumentText('/tmp/x.pdf', { runner, platform: 'linux' })
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.engine, 'pdftotext')
        assert.equal(result.text, 'PDF BODY TEXT')
      }
      assert.deepEqual(calls, ['pdftotext'])
    })

    it('falls through ENOENT engines to the next in chain', async () => {
      const calls: string[] = []
      const runner: CommandRunner = async (binary) => {
        calls.push(binary)
        if (binary === 'pandoc') return { stdout: 'DOCX VIA PANDOC' }
        throw enoent()
      }
      const result = await extractDocumentText('/tmp/spec.docx', { runner, platform: 'linux' })
      assert.equal(result.ok, true)
      if (result.ok) assert.equal(result.engine, 'pandoc')
      // soffice tries both binary names before falling through
      assert.deepEqual(calls, ['soffice', 'libreoffice', 'pandoc'])
    })

    it('treats empty output as failure and advances', async () => {
      const runner: CommandRunner = async (binary) => {
        if (binary === 'pdftotext') return { stdout: '   \n  ' }
        throw enoent()
      }
      // 独享且不创建的路径——共享的 /tmp/x.pdf 若存在有效 PDF，pdfjs 会真实抽取成功
      const dir = mkdtempSync(join(tmpdir(), 'docx-empty-out-'))
      try {
        const result = await extractDocumentText(join(dir, 'x.pdf'), { runner, platform: 'linux' })
        assert.equal(result.ok, false)
        if (!result.ok) assert.match(result.suggestion, /empty output/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('reports install suggestion when every engine is missing', async () => {
      const runner: CommandRunner = async () => { throw enoent() }
      // 独享且**不创建**的临时路径：旧写法用共享的 /tmp/x.pdf，而 runPdfjs
      // 不接注入的 runner（pdfjs 是纯 JS，无外部命令可拦）——本机若恰好存在该
      // 文件且是有效 PDF，pdfjs 会真实抽取出文本、result.ok 变 true，断言随即失效。
      // 实测：`touch /tmp/x.pdf`（有效 PDF 内容）后本用例必红，删掉即恢复绿。
      const dir = mkdtempSync(join(tmpdir(), 'docx-missing-engine-'))
      try {
        const result = await extractDocumentText(join(dir, 'x.pdf'), { runner, platform: 'linux' })
        assert.equal(result.ok, false)
        if (!result.ok) {
          assert.match(result.suggestion, /pdftotext: not installed/)
          assert.match(result.suggestion, /poppler/)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('returns fail for unknown extensions without invoking any engine', async () => {
      let invoked = false
      const runner: CommandRunner = async () => { invoked = true; return { stdout: 'x' } }
      const result = await extractDocumentText('/tmp/data.zip', { runner, platform: 'linux' })
      assert.equal(result.ok, false)
      assert.equal(invoked, false)
    })

    it('conversion failure message is carried into the suggestion', async () => {
      const runner: CommandRunner = async () => { throw new Error('malformed PDF header') }
      // 独享且不创建的路径——共享的 /tmp/x.pdf 若存在有效 PDF，pdfjs 会真实抽取成功
      const dir = mkdtempSync(join(tmpdir(), 'docx-bad-header-'))
      try {
        const result = await extractDocumentText(join(dir, 'x.pdf'), { runner, platform: 'linux' })
        assert.equal(result.ok, false)
        if (!result.ok) assert.match(result.suggestion, /malformed PDF header/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  it('EXTRACTION_CAVEAT flags lossy layout for downstream consumers', () => {
    assert.match(EXTRACTION_CAVEAT, /lossy/)
    assert.match(EXTRACTION_CAVEAT, /original file/)
  })

  // issue #300 — PDF 页图渲染（vision 补偿通道）
  describe('renderPdfPageImages', () => {
    it('pdftoppm 成功 → 返回页图 dataUrl（按页排序）', async () => {
      const runner: CommandRunner = async (_binary, args) => {
        const outPrefix = args[args.length - 1]!
        writeFileSync(`${outPrefix}-1.png`, Buffer.from('fake-png-1'))
        writeFileSync(`${outPrefix}-2.png`, Buffer.from('fake-png-2'))
        return { stdout: '' }
      }
      const pages = await renderPdfPageImages('/tmp/whatever.pdf', { runner, maxPages: 3 })
      assert.equal(pages.length, 2)
      assert.ok(pages[0]!.startsWith('data:image/png;base64,'))
      assert.equal(Buffer.from(pages[0]!.split(',')[1]!, 'base64').toString(), 'fake-png-1')
    })

    it('pdftoppm 未装（ENOENT）→ 静默降级为空数组，绝不抛出', async () => {
      const runner: CommandRunner = async () => { throw enoent() }
      const pages = await renderPdfPageImages('/tmp/whatever.pdf', { runner })
      assert.deepEqual(pages, [])
    })

    it('pdftoppm excludes AppleDouble sidecars while preserving numeric page order and bytes', async () => {
      const runner: CommandRunner = async (_binary, args) => {
        const outPrefix = args[args.length - 1]!
        for (const page of [10, 2, 1]) writeFileSync(`${outPrefix}-${page}.png`, `page-${page}`)
        writeFileSync(join(dirname(outPrefix), '._page-1.png'), Buffer.from([0, 5, 22, 7]))
        writeFileSync(join(dirname(outPrefix), '._page-2.png'), 'filesystem-metadata')
        return { stdout: '' }
      }
      const pages = await renderPdfPageImages('/tmp/whatever.pdf', { runner, maxPages: 10 })
      assert.deepEqual(pages.map(page => Buffer.from(page.split(',')[1]!, 'base64').toString()), ['page-1', 'page-2', 'page-10'])
    })

    it('渲染产出为空目录 → 空数组（扫描件/异常 PDF 不炸调用方）', async () => {
      const runner: CommandRunner = async () => ({ stdout: '' })
      const pages = await renderPdfPageImages('/tmp/whatever.pdf', { runner })
      assert.deepEqual(pages, [])
    })
  })
})


it('XLSX preserves rich text, hyperlinks, formulas, errors, dates and table delimiters', async () => {
  const { createRequire } = await import('node:module')
  const ExcelJS = createRequire(import.meta.url)('exceljs')
  const wb = new ExcelJS.Workbook()
  const sheet = wb.addWorksheet('Data')
  sheet.addRow([{ richText: [{ text: '中文' }, { text: '内容' }] }, { text: '网站', hyperlink: 'https://example.com' }, { formula: '1+2', result: 3 }, { error: '#DIV/0!' }, new Date('2026-01-02T00:00:00Z'), 'a|b\nc'])
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-values-'))
  try {
    const path = join(dir, 'data.xlsx')
    await wb.xlsx.writeFile(path)
    const result = await extractDocumentText(path, { runner: async () => { throw enoent() } })
    assert.ok(result.ok)
    assert.match(result.text, /中文内容/)
    assert.match(result.text, /网站.*https:\/\/example.com/)
    assert.match(result.text, /3 \(=1\+2\)/)
    assert.match(result.text, /#DIV\/0!/)
    assert.match(result.text, /2026-01-02T00:00:00.000Z/)
    assert.ok(result.text.includes('a\\|b<br>c'))
    assert.ok(!result.text.includes('[object Object]'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('zipped Office formats extract text without installed system converters', async () => {
  const { default: JSZip } = await import('jszip')
  const dir = mkdtempSync(join(tmpdir(), 'office-xml-'))
  try {
    for (const ext of ['docx', 'pptx', 'odt', 'ods', 'odp']) {
      const zip = new JSZip()
      if (ext === 'docx') zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>中文 &amp; body</w:t></w:r></w:p></w:body></w:document>')
      else if (ext === 'pptx') zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>中文 &amp; body</a:t></a:r></a:p></p:sld>')
      else zip.file('content.xml', '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><text:p>中文 &amp; body</text:p></office:body></office:document-content>')
      const path = join(dir, `fixture.${ext}`)
      writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }))
      const result = await extractDocumentText(path, { platform: 'linux', runner: async () => { throw enoent() } })
      assert.ok(result.ok, `${ext}: ${result.ok ? '' : result.suggestion}`)
      assert.match(result.text, /中文 & body/)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


it('PDF page images reach vision without poppler, including pages with no text layer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-render-fallback-'))
  try {
    const path = join(dir, 'scan.pdf')
    writeFileSync(path, `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>/Contents 4 0 R>>endobj
4 0 obj<</Length 26>>stream
0 0 1 rg 10 10 80 80 re f
endstream
endobj
trailer<</Root 1 0 R>>
%%EOF`)
    const pages = await renderPdfPageImages(path, { runner: async () => { throw enoent() } })
    assert.equal(pages.length, 1)
    assert.deepEqual(Buffer.from(pages[0]!.split(',')[1]!, 'base64').subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


it('LibreOffice converts legacy slides through PDF and legacy spreadsheets through XLSX', async () => {
  const { createRequire } = await import('node:module')
  const ExcelJS = createRequire(import.meta.url)('exceljs')
  const dir = mkdtempSync(join(tmpdir(), 'office-conversion-'))
  try {
    const result = await extractDocumentText(join(dir, 'old.xls'), { platform: 'linux', runner: async (_binary, args) => {
      assert.equal(args[args.indexOf('--convert-to') + 1], 'xlsx')
      assert.ok(args[0]!.startsWith('-env:UserInstallation=file:'))
      const wb = new ExcelJS.Workbook()
      wb.addWorksheet('Second sheet').getCell('A1').value = 'legacy-sheet-marker'
      await wb.xlsx.writeFile(join(args[args.indexOf('--outdir') + 1]!, 'old.xlsx'))
      return { stdout: '' }
    } })
    assert.ok(result.ok)
    assert.match(result.text, /legacy-sheet-marker/)
    assert.deepEqual(buildEngineChain('.ppt', 'linux').map(step => step.engine), ['soffice'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


it('Office XML preserves reordered slides and UTF-16 XML, and rejects malformed XML', async () => {
  const { default: JSZip } = await import('jszip')
  const dir = mkdtempSync(join(tmpdir(), 'office-parts-'))
  try {
    const zip = new JSZip()
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="2" r:id="r2"/><p:sldId id="1" r:id="r1"/></p:sldIdLst></p:presentation>')
    zip.file('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>')
    for (const n of [1,2]) zip.file(`ppt/slides/slide${n}.xml`, `<s:sld xmlns:s="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:d="http://schemas.openxmlformats.org/drawingml/2006/main"><d:p><d:r><d:t>slide-${n}</d:t></d:r></d:p></s:sld>`)
    const path = join(dir, 'ordered.pptx')
    writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }))
    const result = await extractDocumentText(path)
    assert.ok(result.ok)
    assert.ok(result.text.indexOf('slide-2') < result.text.indexOf('slide-1'))
    const doc = new JSZip()
    const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>中文 UTF16</w:t></w:r></w:p></w:document>'
    doc.file('word/document.xml', Buffer.from('\ufeff'+xml, 'utf16le'))
    const docPath = join(dir, 'utf16.docx')
    writeFileSync(docPath, await doc.generateAsync({ type: 'nodebuffer' }))
    const docResult = await extractDocumentText(docPath)
    assert.ok(docResult.ok)
    assert.match(docResult.text, /中文 UTF16/)
    doc.file('word/document.xml', '<invalid>')
    writeFileSync(docPath, await doc.generateAsync({ type: 'nodebuffer' }))
    const bad = await extractDocumentText(docPath, { platform: 'linux', runner: async () => { throw enoent() } })
    assert.equal(bad.ok, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


it('legacy PPT conversion produces PDF text instead of requesting unsupported TXT export', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-ppt-'))
  try {
    const result = await extractDocumentText(join(dir, 'old.ppt'), { platform: 'linux', runner: async (_binary, args) => {
      assert.equal(args[args.indexOf('--convert-to') + 1], 'pdf')
      const out = join(args[args.indexOf('--outdir') + 1]!, 'old.pdf')
      writeFileSync(out, `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 59>>stream
BT /F1 24 Tf 72 720 Td (legacy-slide-marker) Tj ET
endstream
endobj
trailer<</Root 1 0 R>>
%%EOF`)
      return { stdout: '' }
    } })
    assert.ok(result.ok)
    assert.match(result.text, /legacy-slide-marker/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


it('PDF fonts, CMaps and image decoders resolve as filesystem paths in Node', async () => {
  const { readFile, stat } = await import('node:fs/promises')
  const paths = pdfResourcePaths()
  assert.ok(paths.standardFontDataUrl)
  assert.ok(paths.cMapUrl)
  assert.ok(paths.wasmUrl)
  assert.ok((await readFile(paths.standardFontDataUrl + 'LiberationSans-Regular.ttf')).length > 0)
  assert.ok((await stat(paths.cMapUrl)).isDirectory())
  assert.ok((await stat(paths.wasmUrl)).isDirectory())
})
