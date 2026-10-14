import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { MAX_IMAGES, MAX_IMAGE_BYTES, MAX_DOCUMENTS, MAX_DOCUMENT_BYTES, MAX_ARCHIVES, MAX_ARCHIVE_DATAURL_BYTES } from './attachment-limits.js'
import { contextFileKind, contextDataUrlBytes, decodeContextText, isSupportedArchiveName, MAX_TEXT_ATTACHMENT_BYTES } from './file-context-policy.js'
import { extractDocumentText, EXTRACTION_CAVEAT, isExtractableDocument } from '../tools/doc-extract.js'
import { isSafeFileName } from '../utils/safe-path.js'

const ACCEPTED_IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,.+$/i

/** Decoded byte size of a `data:...;base64,<payload>` URL (without decoding it). */
function decodedBase64Bytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const b64 = dataUrl.slice(comma + 1)
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - padding
}

/** Validate an images payload: array of provider-safe base64 data URLs. Defense in
 *  depth — the desktop already compresses + transcodes, but the server is the
 *  trust boundary (formats the model can't consume, oversized payloads).
 *  Shared by POST /sessions (create-with-images) and POST /sessions/:id/prompt. */
export function validateImagesPayload(value: unknown): { images?: string[]; error?: string } {
  if (value === undefined) return {}
  if (!Array.isArray(value) || value.length === 0) {
    return { error: '"images" must be a non-empty array' }
  }
  if (value.length > MAX_IMAGES) {
    return { error: `Max ${MAX_IMAGES} images allowed` }
  }
  for (const image of value) {
    if (typeof image !== 'string' || !ACCEPTED_IMAGE_DATA_URL.test(image)) {
      return { error: 'Each image must be a data:image/(png|jpeg|webp|gif);base64 URL' }
    }
    if (decodedBase64Bytes(image) > MAX_IMAGE_BYTES) {
      return { error: `Each image must be <= ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB` }
    }
  }
  return { images: value as string[] }
}

/** Validate a documents payload: array of { name, dataUrl } for office/pdf files.
 *  Server extracts text via doc-extract (pdftotext/textutil/soffice/exceljs) and
 *  prepends to prompt — same injection pattern as the vision bridge.
 *  Shared by POST /sessions (create-with-documents，欢迎页附件) 与
 *  POST /sessions/:id/prompt。 */
export function validateDocumentsPayload(value: unknown): { documents?: Array<{ name: string; dataUrl: string }>; error?: string } {
  if (value === undefined) return {}
  if (!Array.isArray(value) || value.length === 0) {
    return { error: '"documents" must be a non-empty array' }
  }
  if (value.length > MAX_DOCUMENTS) {
    return { error: `Max ${MAX_DOCUMENTS} documents allowed` }
  }
  for (const doc of value) {
    if (typeof doc !== 'object' || doc === null || typeof (doc as { name?: unknown }).name !== 'string' || typeof (doc as { dataUrl?: unknown }).dataUrl !== 'string') {
      return { error: 'Each document must be { name: string, dataUrl: string }' }
    }
    // 扩展名白名单（与图片路径的 ACCEPTED_IMAGE_DATA_URL 对称）：此前任意扩展名
    // 都能过校验、落盘并交给抽取器；白名单取 doc-extract 的 EXTRACTABLE——
    // 「能抽取才放行」，两侧语义单一来源。
    const { name, dataUrl } = doc as { name: string; dataUrl: string }
    if (!isSafeFileName(name) || contextFileKind(name) === 'unsupported') {
      return { error: 'Each document must be an extractable type or a readable text file' }
    }
    if (dataUrl.startsWith('data:text/plain;base64,')) {
      if (!['text', 'candidate'].includes(contextFileKind(name))) return { error: 'Text attachments must have a text filename' }
      if (decodedBase64Bytes(dataUrl) > MAX_TEXT_ATTACHMENT_BYTES) return { error: `${name}: text-too-large` }
      try { decodeContextText(contextDataUrlBytes(dataUrl)) }
      catch (err) { return { error: `${name}: ${(err as Error).message} (text limit ${MAX_TEXT_ATTACHMENT_BYTES / 1024} KiB)` } }
      continue
    }
    if (!isExtractableDocument(name)) {
      return { error: 'Each document must be an extractable type (.pdf/.docx/.xlsx/…)' }
    }
    if (decodedBase64Bytes(dataUrl) > MAX_DOCUMENT_BYTES) {
      return { error: `Each document must be <= ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)}MB` }
    }
  }
  return { documents: value as Array<{ name: string; dataUrl: string }> }
}

/** 把文档附件（base64 dataUrl）落盘到临时目录，调 extractDocumentText 抽取文本，
 *  返回拼好的前置块（含 EXTRACTION_CAVEAT）。失败的单个文档降级为错误提示，
 *  不阻断整体发送。 */
export async function extractDocumentsToText(
  documents: Array<{ name: string; dataUrl: string }>,
): Promise<string | null> {
  const parts: string[] = []
  let tmpBase: string | undefined
  try {
    for (const doc of documents) {
      if (doc.dataUrl.startsWith('data:text/plain;base64,')) {
        parts.push(`[file: ${doc.name}]\n${decodeContextText(contextDataUrlBytes(doc.dataUrl))}`)
        continue
      }
      tmpBase ??= mkdtempSync(join(tmpdir(), 'rivet-doc-'))
      const tmpPath = join(tmpBase, `${doc.name.replace(/[^A-Za-z0-9._-]/g, '_')}`)
      try {
        const base64 = doc.dataUrl.split(',')[1] ?? ''
        writeFileSync(tmpPath, Buffer.from(base64, 'base64'))
        const result = await extractDocumentText(tmpPath)
        if (result.ok) {
          parts.push(`[document: ${doc.name}]\n${EXTRACTION_CAVEAT}\n\n${result.text}`)
        } else {
          parts.push(`[document: ${doc.name}]\n(extraction failed: ${result.suggestion})`)
        }
      } catch (err) {
        parts.push(`[document: ${doc.name}]\n(extraction error: ${(err as Error).message})`)
      }
    }
  } finally {
    if (tmpBase) rmSync(tmpBase, { recursive: true, force: true })
  }
  return parts.length > 0 ? parts.join('\n\n---\n\n') : null
}

/** 压缩包附件的入站形态：path（Tauri 原生拖拽，不读字节过 body）与
 *  dataUrl（浏览器拖/粘，≤MAX_ARCHIVE_DATAURL_BYTES）恰居其一。 */
export interface SessionArchivePayload {
  name: string
  path?: string
  dataUrl?: string
}

/** Validate an archives payload: array of { name, path?, dataUrl? } for
 *  zip/tar 系压缩包。服务端**不解压不抽取**——原样落盘 + 句柄文本进 prompt
 *  （dsh 句柄式范式）。这里只做线缆形态/白名单/大小校验；path 形态的
 *  存在性/类型/大小在持久化时核（manager.persistArchives，失败即 400）。
 *  Shared by POST /sessions、POST /sessions/:id/prompt、POST /sessions/:id/queue。 */
export function validateArchivesPayload(value: unknown): { archives?: SessionArchivePayload[]; error?: string } {
  if (value === undefined) return {}
  if (!Array.isArray(value) || value.length === 0) {
    return { error: '"archives" must be a non-empty array' }
  }
  if (value.length > MAX_ARCHIVES) {
    return { error: `Max ${MAX_ARCHIVES} archives allowed` }
  }
  for (const item of value) {
    if (typeof item !== 'object' || item === null || typeof (item as { name?: unknown }).name !== 'string') {
      return { error: 'Each archive must be { name: string, path?: string, dataUrl?: string }' }
    }
    const { name, path, dataUrl } = item as { name: string; path?: unknown; dataUrl?: unknown }
    const hasPath = typeof path === 'string' && path.length > 0
    const hasDataUrl = typeof dataUrl === 'string' && dataUrl.length > 0
    if (hasPath === hasDataUrl) {
      return { error: 'Each archive must carry exactly one of "path" or "dataUrl"' }
    }
    if (!isSafeFileName(name) || !isSupportedArchiveName(name)) {
      return { error: 'Each archive must be a supported archive type (.zip/.tar/.tgz/.tar.gz/.tar.bz2/.tar.xz)' }
    }
    if (hasPath) {
      if (!isAbsolute(path as string)) return { error: `${name}: archive path must be absolute` }
      continue
    }
    if (!/^data:[^;,]+;base64,/.test(dataUrl as string)) {
      return { error: `${name}: archive dataUrl must be a base64 data URL` }
    }
    if (decodedBase64Bytes(dataUrl as string) > MAX_ARCHIVE_DATAURL_BYTES) {
      return { error: `Each archive must be <= ${Math.round(MAX_ARCHIVE_DATAURL_BYTES / 1024 / 1024)}MB (dataUrl form)` }
    }
  }
  return { archives: value as SessionArchivePayload[] }
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** 压缩包句柄文本（~90 token，与文件大小无关）——user message 里压缩包的
 *  唯一投影，与 [document:] 同位前置。解压是模型的工具行为（unzip/tar 自取），
 *  服务端永不解压；savedPath 随会话附件目录持久化，resume/重放不失效。 */
export function buildArchiveHandleText(ref: { name: string; bytes: number; sha256short: string; savedPath: string }): string {
  return `[archive: ${ref.name} (${humanBytes(ref.bytes)}, sha256:${ref.sha256short})]\n` +
    `Saved verbatim at: ${ref.savedPath}\n` +
    `Do not inline its contents. Inspect on demand: \`unzip -l ${ref.savedPath}\` to list; ` +
    `extract into a writable workspace dir (\`unzip ${ref.savedPath} -d <dir>\`) before reading. ` +
    `Pass this path in delegation prompts when workers need it.`
}
