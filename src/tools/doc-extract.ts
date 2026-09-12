/**
 * Document text extraction — turns imported binary office documents
 * (PDF/DOCX/DOC/RTF/ODT/PPTX/ODP) into readable text via system toolchains.
 *
 * Strategy (zero npm dependencies, mirrors office-writer.ts conventions):
 *   - PDF:                pdftotext (poppler)
 *   - DOCX/DOC/RTF/ODT:   textutil (macOS built-in) → soffice/libreoffice → pandoc
 *   - PPTX/ODP:           soffice/libreoffice
 *
 * Fail-open: when no engine is available (or all fail), callers keep the raw
 * file and surface an install suggestion — extraction never blocks an import.
 *
 * Extracted text is layout-lossy (tables, multi-column). Consumers must not
 * base negative conclusions on it alone — the EXTRACTION_CAVEAT marker travels
 * with the text so downstream readers see the discipline inline.
 */
import { execFile } from 'node:child_process'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { accessSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

export type ExtractEngine = 'pdftotext' | 'textutil' | 'soffice' | 'pandoc' | 'exceljs' | 'pdfjs'

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
const EXTRACTABLE = new Set(['.pdf', '.docx', '.doc', '.rtf', '.odt', '.pptx', '.odp', '.xlsx', '.xls', '.ods'])

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
  let standardFontDataUrl: string | undefined
  try {
    const { createRequire } = await import('node:module')
    const pkgPath = createRequire(import.meta.url).resolve('pdfjs-dist/package.json')
    standardFontDataUrl = new URL(`file://${pkgPath.replace(/\/package\.json$/, '')}/standard_fonts/`).href
  } catch { /* 找不到就省略——pdfjs 只发降级警告 */ }
  const data = new Uint8Array(await readFile(filePath))
  const doc = await getDocument({
    data,
    useWorkerFetch: false,
    ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
  }).promise
  const pages: string[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const tc = await page.getTextContent()
    const text = tc.items.map((item) => ('str' in item ? item.str : '')).join(' ').trim()
    if (text) pages.push(text)
  }
  return pages.join('\n\n')
}

/** soffice writes the converted file into an outdir (no stdout mode). Some
 *  distros ship only `libreoffice` (no `soffice` symlink) — try both. */
async function runSoffice(filePath: string, runner: CommandRunner): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), 'rivet-extract-'))
  try {
    let lastErr: unknown
    for (const binary of ['soffice', 'libreoffice'] as const) {
      try {
        await runner(binary, ['--headless', '--convert-to', 'txt:Text', '--outdir', outDir, filePath], { timeoutMs: 90_000 })
        const stem = basename(filePath).replace(/\.[^.]+$/, '')
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
      const cells = values.slice(1).map((v: unknown) => {
        if (v === null || v === undefined) return ''
        if (typeof v === 'object' && 'result' in v && 'formula' in v) {
          return `${(v as { result: unknown }).result} (=${(v as { formula: string }).formula})`
        }
        return String(v)
      })
      rows.push(`| ${cells.join(' | ')} |`)
    })
    if (rows.length > 0) {
      parts.push(`### ${sheet.name}\n\n${rows.join('\n')}${sheet.rowCount > MAX_ROWS ? `\n_... (${sheet.rowCount - MAX_ROWS} more rows)_` : ''}`)
    }
  })
  return parts.join('\n\n') || '(empty workbook)'
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

  switch (ext) {
    case '.pdf':
      return [pdftotext, pdfjs]
    case '.docx':
    case '.odt':
    case '.rtf':
      return [...(textutilAvailable(platform) ? [textutil] : []), soffice, pandoc]
    case '.doc':
      // pandoc cannot read legacy .doc
      return [...(textutilAvailable(platform) ? [textutil] : []), soffice]
    case '.pptx':
    case '.odp':
      return [soffice]
    case '.xlsx':
      // exceljs（纯 JS）优先；soffice 兜底（LibreOffice 能读 xlsx）。
      return [{ engine: 'exceljs', run: runExceljs }, soffice]
    case '.xls':
    case '.ods':
      // exceljs 不支持 .xls/.ods——只有 soffice。
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

  const suggestion = INSTALL_SUGGESTIONS[ext] ?? DEFAULT_SUGGESTION
  return {
    ok: false,
    suggestion: `Text extraction unavailable (${failures.join('; ')}). ${suggestion}`,
  }
}
