import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildEngineChain,
  extractDocumentText,
  isExtractableDocument,
  EXTRACTION_CAVEAT,
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
      assert.deepEqual(chain.map(s => s.engine), ['soffice', 'pandoc'])
    })

    it('legacy .doc never includes pandoc (cannot read .doc)', () => {
      const chain = buildEngineChain('.doc', 'linux')
      assert.deepEqual(chain.map(s => s.engine), ['soffice'])
    })

    it('pptx is soffice-only', () => {
      const chain = buildEngineChain('.pptx', 'darwin')
      assert.deepEqual(chain.map(s => s.engine), ['soffice'])
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
})
