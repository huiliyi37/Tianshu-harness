/**
 * Office 文档预览转换 — headless soffice 转 PDF（桌面端侧边栏 PPTX 预览）。
 *
 * 与 `src/tools/doc-extract.ts` 的 runSoffice 同款模式（--headless
 * --convert-to --outdir + tmp 目录 + finally 清理），区别在输出 PDF 字节
 * 而非 txt 文本，且服务侧复用同一份转换结果（mtime+size 校验的小 LRU，
 * 避免每次点开 PPTX 都重跑一次 3-15s 的 soffice）。
 *
 * soffice 是可选系统依赖：未安装时抛 ConverterUnavailableError，路由层
 * 映射为 422，前端降级为「安装 LibreOffice / 系统打开」。
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

/** 与 doc-extract 相同的 90s 整体超时。 */
const SOFFICE_TIMEOUT_MS = 90_000
/** 转换缓存上限（份）。PPTX 通常 1-8MB，转出的 PDF 体积同级，8 份内存可接受。 */
const CACHE_MAX_ENTRIES = 8

/** soffice/libreoffice 两个二进制都不存在时抛出（路由层 → 422）。 */
export class ConverterUnavailableError extends Error {}

/** 可走 soffice → PDF 的扩展名（路由层白名单）。 */
export const OFFICE_CONVERTIBLE_EXTS = new Set(['pptx', 'ppt', 'odp'])

interface CacheEntry {
  mtimeMs: number
  size: number
  bytes: Buffer
}

const pdfCache = new Map<string, CacheEntry>()

function runBinary(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: SOFFICE_TIMEOUT_MS, windowsHide: true }, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

/** Some distros ship only `libreoffice` (no `soffice` symlink) — try both. */
async function runSofficeToPdf(filePath: string, outDir: string): Promise<Buffer> {
  let lastErr: unknown
  let sawEnoent = false
  for (const binary of ['soffice', 'libreoffice'] as const) {
    try {
      await runBinary(binary, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, filePath])
    } catch (err) {
      lastErr = err
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') sawEnoent = true
      continue
    }
    // exec 成功但产物缺失 = 转换失败（不是「未安装」）——直接抛，不试第二个
    // 名字（soffice/libreoffice 通常是同一二进制）。
    const stem = basename(filePath).replace(/\.[^.]+$/, '')
    return readFileSync(join(outDir, `${stem}.pdf`))
  }
  // 两个名字都 ENOENT = 未安装 LibreOffice；其余（超时/崩溃/权限）算转换失败。
  if (sawEnoent) throw new ConverterUnavailableError('LibreOffice (soffice) is not installed')
  throw lastErr
}

/** absPath 必须已过 validatePath 沙箱（路由层职责）。 */
export async function convertOfficeToPdf(absPath: string): Promise<Buffer> {
  const stat = statSync(absPath)
  const hit = pdfCache.get(absPath)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    // LRU touch：重插到 Map 尾部。
    pdfCache.delete(absPath)
    pdfCache.set(absPath, hit)
    return hit.bytes
  }

  const outDir = mkdtempSync(join(tmpdir(), 'rivet-preview-'))
  try {
    const bytes = await runSofficeToPdf(absPath, outDir)
    pdfCache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, bytes })
    while (pdfCache.size > CACHE_MAX_ENTRIES) {
      const oldest = pdfCache.keys().next().value
      if (oldest === undefined) break
      pdfCache.delete(oldest)
    }
    return bytes
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

/** 测试用：清空转换缓存。 */
export function clearOfficePreviewCache(): void {
  pdfCache.clear()
}
