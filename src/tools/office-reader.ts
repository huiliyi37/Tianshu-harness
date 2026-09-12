/**
 * Office document reader — converts .doc/.docx/.rtf/.odt to plain text
 * using platform-native tools (textutil on macOS, soffice on Linux).
 *
 * Strategy: prefer textutil (macOS built-in, fast, no dependency), fall
 * back to LibreOffice soffice on Linux. .docx also supports a pure-JS
 * fallback via mammoth if neither binary is available.
 */
import { execFile } from 'child_process'
import { access, readFile, unlink } from 'fs/promises'
import { extname, basename } from 'path'
import { tmpdir } from 'os'

/** execFile promisified — used for engine detection. */
function execFileAsync(binary: string, args: string[], opts?: { timeout?: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: opts?.timeout ?? 30_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout, stderr })
    })
  })
}

export const OFFICE_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.rtf',
  '.odt',
])

export interface OfficeReadResult {
  /** Converted plain-text content (UTF-8). */
  text: string
  /** Backend used for the conversion. */
  engine: 'textutil' | 'soffice' | 'mammoth'
  /** Original file extension (for messaging). */
  sourceFormat: string
}

/** The concrete LibreOffice binary name that detection found on PATH. The
 *  engine label is 'soffice' but some distros only ship the `libreoffice`
 *  binary (no `soffice` symlink) — execution must use whichever was detected,
 *  otherwise detection passes and conversion fails with ENOENT. */
let cachedSofficeBinary: 'soffice' | 'libreoffice' = 'soffice'

/**
 * Detect the best available conversion engine for the current platform.
 */
async function detectEngine(): Promise<'textutil' | 'soffice' | 'mammoth' | null> {
  // macOS built-in — textutil is always at /usr/bin/textutil
  if (process.platform === 'darwin') {
    try { await access('/usr/bin/textutil'); return 'textutil' } catch {}
  }
  // Cross-platform: try soffice via PATH
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

  // mammoth requires the npm package; check lazily at call time
  return null
}

let cachedEngine: 'textutil' | 'soffice' | 'mammoth' | null | undefined

async function getEngine(): Promise<'textutil' | 'soffice' | 'mammoth'> {
  if (cachedEngine !== undefined) return cachedEngine!
  cachedEngine = await detectEngine()
  if (!cachedEngine) {
    // mammoth is pure JS — try importing it
    try {
      // @ts-expect-error — mammoth is optional, may not be installed
      await import('mammoth')
      cachedEngine = 'mammoth'
    } catch {
      const installs: Record<string, string> = {
        darwin: '', // textutil is built-in
        linux: 'sudo apt install libreoffice',
        win32: 'winget install LibreOffice.LibreOffice',
      }
      throw new Error(
        'No Office document converter available. ' +
        `Install LibreOffice${installs[process.platform] ? ': ' + installs[process.platform]! : ''}. ` +
        'Or install mammoth for .docx only: npm install mammoth',
      )
    }
  }
  return cachedEngine
}

export interface OfficeEngineStatus {
  read: string | null   // engine name or null if unavailable
  write: string | null  // engine name or null if unavailable
  platform: string
}

/**
 * Check which Office engines are available. Safe to call at startup —
 * never throws, returns null for unavailable engines.
 */
export async function checkOfficeEngines(): Promise<OfficeEngineStatus> {
  let readEngine: string | null = null
  let writeEngine: string | null = null

  if (process.platform === 'darwin') {
    try { await access('/usr/bin/textutil'); readEngine = 'textutil'; writeEngine = 'textutil' } catch {}
  }
  try {
    await execFileAsync('soffice', ['--version'], { timeout: 5000 })
    readEngine = readEngine || 'soffice'
    writeEngine = writeEngine || 'soffice'
  } catch {}
  try {
    await execFileAsync('libreoffice', ['--version'], { timeout: 5000 })
    readEngine = readEngine || 'soffice'
    writeEngine = writeEngine || 'soffice'
  } catch {}
  // Check mammoth for read-only
  if (!readEngine) {
    try {
      // @ts-expect-error — mammoth is optional dependency
      await import('mammoth')
      readEngine = 'mammoth'
    } catch {}
  }

  return { read: readEngine, write: writeEngine, platform: process.platform }
}

/**
 * Convert an Office file to plain text.
 * @param filePath Absolute path to the document.
 */
export async function readOfficeFile(filePath: string): Promise<OfficeReadResult> {
  const ext = extname(filePath).toLowerCase()
  const engine = await getEngine()

  if (engine === 'textutil') {
    return readWithTextutil(filePath, ext)
  }
  if (engine === 'soffice') {
    return readWithSoffice(filePath, ext)
  }
  return readWithMammoth(filePath, ext)
}

async function readWithTextutil(filePath: string, ext: string): Promise<OfficeReadResult> {
  const text = await execTextutil(filePath)
  return { text, engine: 'textutil', sourceFormat: ext }
}

async function readWithSoffice(filePath: string, ext: string): Promise<OfficeReadResult> {
  const text = await execSoffice(filePath)
  return { text, engine: 'soffice', sourceFormat: ext }
}

async function readWithMammoth(filePath: string, ext: string): Promise<OfficeReadResult> {
  if (ext !== '.docx') {
    throw new Error(
      `mammoth only supports .docx files (got ${ext}). ` +
      'Install LibreOffice for .doc/.rtf/.odt support: https://www.libreoffice.org/',
    )
  }
  const text = await execMammoth(filePath)
  return { text, engine: 'mammoth', sourceFormat: ext }
}

function execTextutil(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('textutil', ['-convert', 'txt', '-stdout', filePath], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      windowsHide: true,
    }, (err, stdout) => {
      if (err) reject(new Error(`textutil failed: ${err.message}`))
      else resolve(stdout)
    })
  })
}

function execSoffice(filePath: string): Promise<string> {
  const name = basename(filePath)
  const outName = name.replace(/\.[^.]+$/, '.txt')
  const outPath = `${tmpdir()}/${outName}`

  return new Promise((resolve, reject) => {
    execFile(cachedSofficeBinary, ['--headless', '--convert-to', 'txt', '--outdir', tmpdir(), filePath], {
      timeout: 60_000,
      windowsHide: true,
    }, async (err) => {
      if (err) {
        reject(new Error(`${cachedSofficeBinary} failed: ${err.message}`))
        return
      }
      try {
        const text = await readFile(outPath, 'utf-8')
        await unlink(outPath).catch(() => {})
        resolve(text)
      } catch (e) {
        reject(new Error(`soffice output file not found: ${outPath}`))
      }
    })
  })
}

async function execMammoth(filePath: string): Promise<string> {
  // @ts-expect-error — mammoth is optional dependency
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ path: filePath })
  return result.value
}
