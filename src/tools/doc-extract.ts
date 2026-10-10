/**
 * Document text extraction — turns imported binary office documents
 * (PDF/DOCX/DOC/RTF/ODT/PPTX/ODP) into readable text via system toolchains.
 *
 * Built-in PDF, XLSX and zipped Office readers work without system converters.
 * Legacy formats fall back to platform tools; LibreOffice exports slides as PDF.
 *
 * Fail-open: when no engine is available (or all fail), callers keep the raw
 * file and surface an install suggestion — extraction never blocks an import.
 *
 * Extracted text is layout-lossy (tables, multi-column). Consumers must not
 * base negative conclusions on it alone — the EXTRACTION_CAVEAT marker travels
 * with the text so downstream readers see the discipline inline.
 */
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { accessSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { isFilesystemMetadata } from '../utils/file-metadata.js'

export type ExtractEngine = 'pdftotext' | 'textutil' | 'soffice' | 'pandoc' | 'exceljs' | 'pdfjs' | 'office-xml'

export interface DocExtractSuccess {
  ok: true
  text: string
  engine: ExtractEngine
}

export interface DocExtractFailure {
  ok: false
  /** Human-readable reason + install suggestion (fail-open guidance). */
  suggestion: string
}

export type DocExtractResult = DocExtractSuccess | DocExtractFailure

/** Lossy-extraction marker prepended to extracted text (反证 1: 抽取质量). */
export const EXTRACTION_CAVEAT =
  '[extracted-text] Converted from a binary document — layout may be lossy (tables, multi-column, figures). Do not base negative conclusions ("X is not in the document") on this text alone; consult the original file.'

/** Extensions the extraction pipeline knows how to handle. */
const EXTRACTABLE = new Set(['.pdf', '.docx', '.doc', '.rtf', '.odt', '.ppt', '.pptx', '.odp', '.xlsx', '.xls', '.ods'])

export function isExtractableDocument(filePath: string): boolean {
  return EXTRACTABLE.has(extname(filePath).toLowerCase())
}

/** Command runner — injectable for tests. */
export type CommandRunner = (binary: string, args: string[], opts: { timeoutMs: number }) => Promise<{ stdout: string }>

const defaultRunner: CommandRunner = (binary, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: opts.timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve({ stdout })
    })
  })

interface EngineStep {
  engine: ExtractEngine
  run: (filePath: string, runner: CommandRunner) => Promise<string>
}

async function runPdftotext(filePath: string, runner: CommandRunner): Promise<string> {
  const { stdout } = await runner('pdftotext', ['-layout', filePath, '-'], { timeoutMs: 60_000 })
  return stdout
}

async function runTextutil(filePath: string, runner: CommandRunner): Promise<string> {
  const { stdout } = await runner('textutil', ['-convert', 'txt', '-stdout', filePath], { timeoutMs: 60_000 })
  return stdout
}

async function runPandoc(filePath: string, runner: CommandRunner): Promise<string> {
  const { stdout } = await runner('pandoc', ['-t', 'plain', filePath], { timeoutMs: 60_000 })
  return stdout
}

/** PDF.js Node factories call fs.readFile with strings, so resources need paths. */
export function pdfResourcePaths(): { standardFontDataUrl?: string; cMapUrl?: string; cMapPacked?: boolean; wasmUrl?: string } {
  try {
    const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
    return { standardFontDataUrl: `${join(root, 'standard_fonts')}/`, cMapUrl: `${join(root, 'cmaps')}/`, cMapPacked: true, wasmUrl: `${join(root, 'wasm')}/` }
  } catch { return {} }
}

/** 用 pdfjs-dist 读 .pdf → 逐页文本（纯 JS/ESM 原生，无系统依赖）——
 *  pdftotext 缺失时的兜底引擎（poppler 质量优先故仍排在前）。不抽版面布局
 *  （没有 -layout），按 textContent 条目逐页拼接；standardFontDataUrl 能解析
 *  到就喂给标准字体解码（bundle/分发布局下找不到则省略——仅降级警告，不影响
 *  常见字体抽取）。可选依赖的缺失降级：import 失败抛错让引擎链继续往下走。 */
async function runPdfjs(filePath: string, _runner?: CommandRunner): Promise<string> {
  let getDocument: typeof import('pdfjs-dist/legacy/build/pdf.mjs').getDocument
  try {
    ;({ getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs'))
  } catch {
    throw new Error('pdfjs-dist not installed — falling back')
  }
  const data = new Uint8Array(await readFile(filePath))
  const task = getDocument({
    data,
    useWorkerFetch: false,
    ...pdfResourcePaths(),
  })
  try {
    const doc = await task.promise
    const pages: string[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const tc = await page.getTextContent()
      const text = tc.items.map((item) => ('str' in item ? item.str : '')).join(' ').trim()
      if (text) pages.push(text)
      page.cleanup()
    }
    return pages.join('\n\n')
  } finally { await task.destroy() }
}

/** soffice writes the converted file into an outdir (no stdout mode). Some
 *  distros ship only `libreoffice` (no `soffice` symlink) — try both. */
async function runSoffice(filePath: string, runner: CommandRunner): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), 'rivet-extract-'))
  try {
    let lastErr: unknown
    for (const binary of ['soffice', 'libreoffice'] as const) {
      try {
        const ext = extname(filePath).toLowerCase()
        const exportPdf = ['.ppt', '.pptx', '.odp'].includes(ext)
        const spreadsheet = ['.xls', '.xlsx', '.ods'].includes(ext)
        const format = exportPdf ? 'pdf' : spreadsheet ? 'xlsx' : 'txt:Text'
        // A separate profile avoids attaching to an already-running GUI instance.
        const { pathToFileURL } = await import('node:url')
        await runner(binary, [`-env:UserInstallation=${pathToFileURL(join(outDir, 'profile')).href}`, '--headless', '--convert-to', format, '--outdir', outDir, filePath], { timeoutMs: 90_000 })
        const stem = basename(filePath).replace(/\.[^.]+$/, '')
        if (exportPdf) return await runPdfjs(join(outDir, `${stem}.pdf`))
        if (spreadsheet) return await runExceljs(join(outDir, `${stem}.xlsx`))
        return await readFile(join(outDir, `${stem}.txt`), 'utf-8')
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 用 exceljs 读 .xlsx → markdown 表格（纯 JS，跨平台，无系统依赖）。
 *  参照 plugins/office-excel 的 xlsx_read 逻辑：sheet 名 + 数据行，
 *  公式单元格显示结果，200 行截断。仅 .xlsx（exceljs 不支持 .xls）。
 *  可选依赖——未安装时抛错让引擎链 fallback 到 soffice。 */
async function runExceljs(filePath: string, _runner?: CommandRunner): Promise<string> {
  let ExcelJS: typeof import('exceljs')
  try {
    ExcelJS = await import('exceljs')
  } catch {
    throw new Error('exceljs not installed — falling back to soffice')
  }
  // CJS↔ESM interop：Node ESM 动态 import 下命名空间是 { default: ExcelJS }
  // （cjs-module-lexer 探测不到 Workbook 命名导出），bundle 里则直接可用——
  // 两形态都兜住（2026-09-12 实测：tsx/Node ESM 下 ExcelJS.Workbook undefined
  // 抛 "not a constructor"，xlsx 抽取静默全灭只剩 soffice 兜底）。
  const Workbook = (ExcelJS as unknown as { Workbook?: typeof import('exceljs').Workbook }).Workbook
    ?? (ExcelJS as unknown as { default?: { Workbook?: typeof import('exceljs').Workbook } }).default?.Workbook
  if (!Workbook) throw new Error('exceljs Workbook unavailable (module interop)')
  const wb = new Workbook()
  await wb.xlsx.readFile(filePath)
  const parts: string[] = []
  const MAX_ROWS = 200
  wb.eachSheet((sheet) => {
    const rows: string[] = []
    sheet.eachRow({ includeEmpty: true }, (row, rowNum) => {
      if (rowNum > MAX_ROWS) return
      const values = (row.values ?? []) as readonly unknown[]
      const cells = values.slice(1).map(v => excelCellText(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'))
      rows.push(`| ${cells.join(' | ')} |`)
    })
    if (rows.length > 0) {
      parts.push(`### ${sheet.name}\n\n${rows.join('\n')}${sheet.rowCount > MAX_ROWS ? `\n_... (${sheet.rowCount - MAX_ROWS} more rows)_` : ''}`)
    }
  })
  return parts.join('\n\n') || '(empty workbook)'
}

function excelCellText(value: unknown): string {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object') return String(value)
  const cell = value as { richText?: { text: string }[]; text?: string; hyperlink?: string; formula?: string; sharedFormula?: string; result?: unknown; error?: string }
  if (cell.richText) return cell.richText.map(run => run.text).join('')
  if (cell.hyperlink) return `${cell.text ?? ''} (${cell.hyperlink})`
  if (cell.formula || cell.sharedFormula) return `${excelCellText(cell.result)} (=${cell.formula ?? `shared:${cell.sharedFormula}`})`
  if (cell.error) return cell.error
  return cell.text ?? ''
}

function textutilAvailable(platform: string): boolean {
  if (platform !== 'darwin') return false
  try {
    accessSync('/usr/bin/textutil')
    return true
  } catch {
    return false
  }
}

/** Engine chain per extension. Order = preference (fastest/most faithful first). */
export function buildEngineChain(ext: string, platform: string = process.platform): EngineStep[] {
  const textutil: EngineStep = { engine: 'textutil', run: runTextutil }
  const soffice: EngineStep = { engine: 'soffice', run: runSoffice }
  const pandoc: EngineStep = { engine: 'pandoc', run: runPandoc }
  const pdftotext: EngineStep = { engine: 'pdftotext', run: runPdftotext }
  // pdfjs 纯 JS 兜底：poppler 未装（多数用户的常态）时仍能抽出文本；
  // 有 poppler 则 -layout 排版质量优先。
  const pdfjs: EngineStep = { engine: 'pdfjs', run: runPdfjs }

  const officeXml: EngineStep = { engine: 'office-xml', run: async path => (await import('./office-xml-extract.js')).extractOfficeXml(path) }

  switch (ext) {
    case '.pdf':
      return [pdftotext, pdfjs]
    case '.docx':
    case '.odt':
      return [officeXml, ...(textutilAvailable(platform) ? [textutil] : []), soffice, pandoc]
    case '.rtf':
      return [...(textutilAvailable(platform) ? [textutil] : []), soffice, pandoc]
    case '.doc':
      // pandoc cannot read legacy .doc
      return [...(textutilAvailable(platform) ? [textutil] : []), soffice]
    case '.ppt':
      return [soffice]
    case '.pptx':
    case '.odp':
      return [officeXml, soffice]
    case '.xlsx':
      // exceljs（纯 JS）优先；soffice 兜底（LibreOffice 能读 xlsx）。
      return [{ engine: 'exceljs', run: runExceljs }, soffice]
    case '.ods':
      return [officeXml, soffice]
    case '.xls':
      // Legacy XLS is converted to XLSX, preserving all worksheet tabs.
      return [soffice]
    default:
      return []
  }
}

const INSTALL_SUGGESTIONS: Record<string, string> = {
  '.pdf': 'Install poppler for PDF extraction (macOS: brew install poppler; Linux: apt install poppler-utils; Windows: winget install poppler).',
  '.pptx': 'Install LibreOffice for slide text extraction (macOS: brew install --cask libreoffice; Linux: apt install libreoffice; Windows: winget install LibreOffice.LibreOffice).',
  '.odp': 'Install LibreOffice for slide text extraction (macOS: brew install --cask libreoffice; Linux: apt install libreoffice; Windows: winget install LibreOffice.LibreOffice).',
}

const DEFAULT_SUGGESTION =
  'Install LibreOffice (soffice) or pandoc for document text extraction (macOS: brew install --cask libreoffice; Linux: apt install libreoffice; Windows: winget install LibreOffice.LibreOffice).'

/**
 * Extract plain text from a binary document. Tries the engine chain for the
 * file's extension in order; ENOENT (binary missing) and conversion failures
 * both advance to the next engine. Returns ok:false with an install
 * suggestion when nothing works — never throws.
 */
export async function extractDocumentText(
  filePath: string,
  deps: { runner?: CommandRunner; platform?: string } = {},
): Promise<DocExtractResult> {
  const ext = extname(filePath).toLowerCase()
  const chain = buildEngineChain(ext, deps.platform ?? process.platform)
  if (chain.length === 0) {
    return { ok: false, suggestion: `No extraction engine known for ${ext} files.` }
  }

  const runner = deps.runner ?? defaultRunner
  const failures: string[] = []

  for (const step of chain) {
    try {
      const text = (await step.run(filePath, runner)).trim()
      if (text.length === 0) {
        failures.push(`${step.engine}: produced empty output`)
        continue
      }
      return { ok: true, text, engine: step.engine }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      failures.push(code === 'ENOENT' ? `${step.engine}: not installed` : `${step.engine}: ${(err as Error)?.message ?? String(err)}`)
    }
  }

  const suggestion = ext === '.pdf' && failures.includes('pdfjs: produced empty output')
    ? 'This PDF has no readable text layer. Use a vision-capable model to inspect the rendered page images, or upload an OCR-processed PDF. Page image rendering is limited to the first pages.'
    : INSTALL_SUGGESTIONS[ext] ?? DEFAULT_SUGGESTION
  return {
    ok: false,
    suggestion: `Text extraction unavailable (${failures.join('; ')}). ${suggestion}`,
  }
}

/**
 * 把 PDF 前 N 页渲染成 PNG dataUrl（poppler `pdftoppm`）——给 vision 模型的
 * 页图通道（issue #300：文本抽取丢图）。poppler 缺失时用 PDF.js 内置
 * canvas 引擎兜底；两者都失败才返回 []，页图缺失不阻断发送。
 *
 * runner 复用 CommandRunner（pdftoppm 不写 stdout，输出落到 outdir 的
 * page-1.png … page-N.png）。调用方负责能力门（supportsVision / 识图桥）。
 */
export async function renderPdfPageImages(
  filePath: string,
  opts: { maxPages?: number; dpi?: number; runner?: CommandRunner } = {},
): Promise<string[]> {
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 3, 10))
  const dpi = opts.dpi ?? 120
  const runner = opts.runner ?? defaultRunner
  const outDir = await mkdtemp(join(tmpdir(), 'rivet-pdfpages-'))
  try {
    await runner('pdftoppm', ['-png', '-r', String(dpi), '-f', '1', '-l', String(maxPages), filePath, join(outDir, 'page')], { timeoutMs: 60_000 })
    const files = (await readdir(outDir)).filter((f) => f.endsWith('.png') && !isFilesystemMetadata(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    const out: string[] = []
    for (const f of files) {
      const bytes = await readFile(join(outDir, f))
      if (bytes.length === 0) continue
      out.push(`data:image/png;base64,${bytes.toString('base64')}`)
    }
    return out.length > 0 ? out : renderPdfjsPageImages(filePath, maxPages, dpi)
  } catch {
    return renderPdfjsPageImages(filePath, maxPages, dpi)
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function renderPdfjsPageImages(filePath: string, maxPages: number, dpi: number): Promise<string[]> {
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = getDocument({ data: new Uint8Array(await readFile(filePath)), useWorkerFetch: false, ...pdfResourcePaths() })
    try {
      const doc = await task.promise
      const factory = doc.canvasFactory as {
        create(width: number, height: number): { canvas: { toBuffer(type: string): Buffer }; context: Parameters<PDFPageProxy['render']>[0]['canvasContext'] }
        destroy(target: unknown): void
      }
      const images: string[] = []
      for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
        const page = await doc.getPage(n)
        const original = page.getViewport({ scale: 1 })
        const scale = Math.min(Math.max(36, Math.min(dpi, 200)) / 72, 4096 / Math.max(original.width, original.height))
        const viewport = page.getViewport({ scale })
        const target = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height))
        try {
          await page.render({ canvas: null, canvasContext: target.context, viewport }).promise
          images.push(`data:image/png;base64,${target.canvas.toBuffer('image/png').toString('base64')}`)
        } finally { factory.destroy(target); page.cleanup() }
      }
      return images
    } finally { await task.destroy() }
  } catch { return [] }
}
