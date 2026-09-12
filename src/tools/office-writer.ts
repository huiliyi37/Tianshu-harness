/**
 * Office document writer — converts Markdown to .docx.
 *
 * Strategy (no pandoc dependency):
 *   1. Convert Markdown to basic HTML (inline, no external deps)
 *   2. Use textutil(macOS) / soffice(Linux) to convert HTML → docx
 *   3. Fallback: direct HTML wrapper as minimal .docx alternative
 *
 * For pandoc-based conversion (installed separately), the bash tool
 * can call: pandoc input.md -o output.docx
 */
import { execFile } from 'child_process'
import { writeFile, access, unlink } from 'fs/promises'
import { accessSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

/** execFile promisified — used for engine detection and conversion. */
function execFileAsync(binary: string, args: string[], opts?: { timeout?: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: opts?.timeout ?? 30_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout, stderr })
    })
  })
}

/** Convert Markdown text to basic HTML. Focused on the most common elements:
 *  headings, bold, italic, unordered/ordered lists, paragraphs, code blocks.
 *  Does NOT handle: tables, links, images (use pandoc/bash for those). */
function markdownToHtml(md: string): string {
  const lines = md.split('\n')
  const out: string[] = ['<!DOCTYPE html>', '<html><head><meta charset="utf-8"></head><body>']
  let i = 0
  let inCodeBlock = false
  let codeBuf: string[] = []

  while (i < lines.length) {
    const raw = lines[i]!
    const line = raw.trimEnd()

    // Fenced code block
    if (line.startsWith('```') || line.startsWith('~~~')) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeBuf = []
      } else {
        out.push(`<pre><code>${codeBuf.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`)
        inCodeBlock = false
        codeBuf = []
      }
      i++
      continue
    }
    if (inCodeBlock) {
      codeBuf.push(line)
      i++
      continue
    }

    // Empty line → paragraph boundary
    if (line.trim() === '') { i++; continue }

    // Heading
    const hMatch = line.match(/^(#{1,6})\s+(.+)/)
    if (hMatch) {
      const level = hMatch[1]!.length
      out.push(`<h${level}>${inlineMd(hMatch[2]!)}</h${level}>`)
      i++; continue
    }

    // Unordered list item
    const ulMatch = line.match(/^[*\-+]\s+(.+)/)
    if (ulMatch) {
      out.push('<ul>')
      while (i < lines.length && /^[*\-+]\s+/.test(lines[i]!.trimEnd())) {
        out.push(`<li>${inlineMd(lines[i]!.trimEnd().replace(/^[*\-+]\s+/, ''))}</li>`)
        i++
      }
      out.push('</ul>')
      continue
    }

    // Ordered list item
    const olMatch = line.match(/^\d+[.)]\s+(.+)/)
    if (olMatch) {
      out.push('<ol>')
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i]!.trimEnd())) {
        out.push(`<li>${inlineMd(lines[i]!.trimEnd().replace(/^\d+[.)]\s+/, ''))}</li>`)
        i++
      }
      out.push('</ol>')
      continue
    }

    // Horizontal rule
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      out.push('<hr>')
      i++; continue
    }

    // Regular paragraph
    out.push(`<p>${inlineMd(line)}</p>`)
    i++
  }

  out.push('</body></html>')
  return out.join('\n')
}

/** Inline formatting: bold (**text** or __text__), italic (*text* or _text_),
 *  code (`text`). Single-pass to avoid nested conflicts. */
function inlineMd(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<i>$1</i>')
    .replace(/_(.+?)_/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

// ── engine detection ──

let engineCache: 'textutil' | 'soffice' | null | undefined

/** Concrete LibreOffice binary detected on PATH — some distros ship only
 *  `libreoffice` (no `soffice` symlink), so execution must use the detected
 *  name or it fails with ENOENT after detection passed. */
let cachedSofficeBinary: 'soffice' | 'libreoffice' = 'soffice'

async function detectEngine(): Promise<'textutil' | 'soffice' | null> {
  // macOS built-in — textutil is always at /usr/bin/textutil
  if (process.platform === 'darwin') {
    try { accessSync('/usr/bin/textutil'); return 'textutil' } catch {}
  }
  // Cross-platform: try soffice via PATH (works on Linux, Windows with LibreOffice)
  try {
    await execFileAsync('soffice', ['--version'], { timeout: 5000 })
    cachedSofficeBinary = 'soffice'
    return 'soffice'
  } catch {}
  // Some Linux distros use libreoffice as binary name
  try {
    await execFileAsync('libreoffice', ['--version'], { timeout: 5000 })
    cachedSofficeBinary = 'libreoffice'
    return 'soffice'
  } catch {}
  return null
}

async function getWriteEngine(): Promise<'textutil' | 'soffice'> {
  if (engineCache !== undefined) return engineCache!
  engineCache = await detectEngine()
  if (!engineCache) {
    const installs: Record<string, string> = {
      darwin: '', // textutil is built-in, should never reach here
      linux: 'sudo apt install libreoffice',
      win32: 'winget install LibreOffice.LibreOffice',
    }
    throw new Error(
      `No docx converter available. ` +
      `Install LibreOffice${installs[process.platform] ? ': ' + installs[process.platform]! : ''}. ` +
      'Alternatively install pandoc and use bash: pandoc input.md -o output.docx',
    )
  }
  return engineCache
}

// ── public API ──

export const DOCX_EXT = '.docx'

export interface OfficeWriteResult {
  /** Absolute path to the written .docx file. */
  filePath: string
  /** Engine used. */
  engine: 'textutil' | 'soffice'
  /** Byte size of the output. */
  sizeBytes: number
}

/**
 * Write Markdown content as a .docx file.
 * @param filePath Absolute path ending in .docx
 * @param markdown Markdown source text
 */
export async function writeMarkdownAsDocx(
  filePath: string,
  markdown: string,
): Promise<OfficeWriteResult> {
  const engine = await getWriteEngine()
  const html = markdownToHtml(markdown)

  if (engine === 'textutil') {
    return writeWithTextutil(filePath, html)
  }
  return writeWithSoffice(filePath, html)
}

async function writeWithTextutil(filePath: string, html: string): Promise<OfficeWriteResult> {
  const tmpDir = tmpdir()
  const htmlPath = join(tmpDir, `rivet-docx-${randomUUID()}.html`)

  await writeFile(htmlPath, html, 'utf-8')

  return new Promise((resolve, reject) => {
    execFile('textutil', [
      '-convert', 'docx',
      '-output', filePath,
      htmlPath,
    ], { timeout: 30_000, windowsHide: true }, async (err) => {
      await unlink(htmlPath).catch(() => {})
      if (err) reject(new Error(`textutil docx conversion failed: ${err.message}`))
      else {
        const { stat } = await import('fs/promises')
        const s = await stat(filePath)
        resolve({ filePath, engine: 'textutil', sizeBytes: s.size })
      }
    })
  })
}

async function writeWithSoffice(filePath: string, html: string): Promise<OfficeWriteResult> {
  const tmpDir = tmpdir()
  const htmlPath = join(tmpDir, `rivet-docx-${randomUUID()}.html`)
  await writeFile(htmlPath, html, 'utf-8')

  return new Promise((resolve, reject) => {
    execFile(cachedSofficeBinary, [
      '--headless',
      '--convert-to', 'docx',
      '--outdir', tmpDir,
      htmlPath,
    ], { timeout: 60_000, windowsHide: true }, async (err) => {
      await unlink(htmlPath).catch(() => {})
      if (err) reject(new Error(`${cachedSofficeBinary} docx conversion failed: ${err.message}`))
      else {
        const { stat, rename } = await import('fs/promises')
        // soffice outputs to tmpdir with basename changed, move to target
        const baseName = htmlPath.replace(/\.html$/, '.docx').split('/').pop()!
        const outPath = join(tmpDir, baseName)
        await rename(outPath, filePath)
        const s = await stat(filePath)
        resolve({ filePath, engine: 'soffice', sizeBytes: s.size })
      }
    })
  })
}
