/**
 * 系统图像工具共享执行器 — 平台感知的候选命令构造与 fallback 执行、临时目录管理，
 * 供 image-attach（缩放）与 term-image（格式转换）两条路径共用，
 * 避免两套超时/清理策略漂移。
 *
 * 候选顺序按平台区分（见 toPngCandidates / resizeCandidates）：
 * - darwin/linux：sips（macOS 内置，Linux 上不存在会自然失败进 fallback）
 *   → ImageMagick v7（magick）→ v6（convert）。
 * - win32：magick → PowerShell + System.Drawing 兜底。不含 sips（不存在），
 *   也不含 convert——避免撞名系统工具 C:\Windows\System32\convert.exe
 *   （FAT→NTFS 转换）；PowerShell 为 Windows 自带，覆盖未装 ImageMagick 的场景。
 *   注意 System.Drawing 不支持 WebP（无 WebP 编解码器）——win32 未装 ImageMagick
 *   时 WebP 转换必然失败：所有候选跑完返回 null，调用方退回文本占位。失败
 *   不再是静默的：全部候选失败且 RIVET_DEBUG 非空时向 stderr 打一行调试输出
 *   （见 runImageTool 末尾）。
 *
 * 临时目录约定：每次转换一个 `rivet-imgtool-*` 独立目录，finally 中删除；
 * 进程崩溃/SIGKILL 残留由下一次转换时的惰性清扫兜底（mtime 超过 1 小时即删）。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

export const IMAGE_TEMP_DIR_PREFIX = 'rivet-imgtool-'
/** 残留目录惰性清扫阈值。 */
const STALE_MS = 60 * 60 * 1000

export interface ImageToolCommand {
  bin: string
  args: string[]
}

/** PowerShell 单引号字符串字面量：内部 ' 翻倍转义。 */
function psQuote(path: string): string {
  return `'${path.replace(/'/g, "''")}'`
}

/** PowerShell 兜底命令：inbox powershell.exe + System.Drawing，-Command 执行脚本。 */
function powershellCommand(script: string): ImageToolCommand {
  return { bin: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', script] }
}

/**
 * 「任意格式 → PNG」转换候选命令（首个成功即采用）。
 * darwin/linux：sips → magick → convert；win32：magick → PowerShell
 * （convert 会撞名系统工具 convert.exe，sips 不存在，均排除）。
 */
export function toPngCandidates(
  inPath: string,
  outPath: string,
  platform: NodeJS.Platform = process.platform,
): ImageToolCommand[] {
  if (platform === 'win32') {
    return [
      { bin: 'magick', args: [inPath, `png:${outPath}`] },
      powershellCommand(
        // $ErrorActionPreference='Stop'：把 non-terminating error 变为终止性，
        // 否则脚本报错仍可能 exit 0；try/finally 保证 $img 释放
        "$ErrorActionPreference='Stop'; " +
        'Add-Type -AssemblyName System.Drawing; ' +
        '$img=$null; ' +
        `try { $img=[System.Drawing.Image]::FromFile(${psQuote(inPath)}); ` +
        `$img.Save(${psQuote(outPath)},[System.Drawing.Imaging.ImageFormat]::Png) } ` +
        'finally { if ($img) { $img.Dispose() } }',
      ),
    ]
  }
  return [
    { bin: 'sips', args: ['-s', 'format', 'png', inPath, '--out', outPath] },
    { bin: 'magick', args: [inPath, `png:${outPath}`] },
    { bin: 'convert', args: [inPath, `png:${outPath}`] },
  ]
}

/**
 * 「等比缩放到长边 ≤ maxEdge 并输出 PNG」候选命令（首个成功即采用）。
 * darwin/linux：sips → magick → convert；win32：magick → PowerShell。
 */
export function resizeCandidates(
  inPath: string,
  outPath: string,
  maxEdge: number,
  platform: NodeJS.Platform = process.platform,
): ImageToolCommand[] {
  if (platform === 'win32') {
    const script = [
      // 'Stop'：non-terminating error 转为终止性，保证失败时 exit code 非 0
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Drawing',
      '$img=$null;$bmp=$null;$g=$null',
      'try {',
      `$img=[System.Drawing.Image]::FromFile(${psQuote(inPath)})`,
      // 仅当长边超限时缩小（scale 封顶 1），保持宽高比
      `$scale=[Math]::Min(1.0,${maxEdge}/[Math]::Max($img.Width,$img.Height))`,
      '$w=[int][Math]::Max(1,[Math]::Round($img.Width*$scale))',
      '$h=[int][Math]::Max(1,[Math]::Round($img.Height*$scale))',
      '$bmp=New-Object System.Drawing.Bitmap($w,$h)',
      '$g=[System.Drawing.Graphics]::FromImage($bmp)',
      '$g.DrawImage($img,0,0,$w,$h)',
      `$bmp.Save(${psQuote(outPath)},[System.Drawing.Imaging.ImageFormat]::Png)`,
      '} finally {',
      // 逆序释放；空值检查防止部分初始化失败时 finally 二次抛错掩盖原始异常
      'if ($g) { $g.Dispose() }',
      'if ($bmp) { $bmp.Dispose() }',
      'if ($img) { $img.Dispose() }',
      '}',
    ].join(';')
    return [
      { bin: 'magick', args: [inPath, '-resize', `${maxEdge}x${maxEdge}>`, outPath] },
      powershellCommand(script),
    ]
  }
  return [
    { bin: 'sips', args: ['-Z', String(maxEdge), '-s', 'format', 'png', inPath, '--out', outPath] },
    { bin: 'magick', args: [inPath, '-resize', `${maxEdge}x${maxEdge}>`, outPath] },
    { bin: 'convert', args: [inPath, '-resize', `${maxEdge}x${maxEdge}>`, outPath] },
  ]
}

/** PNG 文件签名（magic bytes）。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** 完整 IEND chunk：length 0 + 'IEND' + CRC（内容固定）。 */
const PNG_IEND_CHUNK = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])

/**
 * PNG 完整性校验：signature（8 字节）+ 首个 chunk 是长度 13 的 IHDR
 * （宽高均为正整数）+ 文件末尾 12 字节为完整 IEND chunk。
 * 防「工具 exit 0 但只写出签名/截断 PNG」被当成可渲染图片。
 */
export function isCompletePng(buf: Buffer): boolean {
  // 最小完整 PNG：8 signature + 25 IHDR chunk（4 length + 4 type + 13 data + 4 CRC）+ 12 IEND
  if (buf.length < 8 + 25 + 12) return false
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false
  // 首个 chunk 必须是 length=13 的 IHDR，且宽高均为正整数
  if (buf.readUInt32BE(8) !== 13) return false
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return false
  if (buf.readUInt32BE(16) === 0 || buf.readUInt32BE(20) === 0) return false
  return buf.subarray(buf.length - PNG_IEND_CHUNK.length).equals(PNG_IEND_CHUNK)
}

/**
 * 依序尝试候选命令，首个产出有效 PNG 的候选返回其内容 Buffer；全部失败返回 null。
 *
 * 候选级隔离：每个候选把「执行 + 读回 + 校验」作为一体化尝试——先删除
 * outputPath（不存在则忽略），再 execFile 要求 exit 0，readFile 读回后以
 * isCompletePng 校验完整性（签名 + IHDR + IEND，截断 PNG 不算数）。
 * 先删残片是为了避免前一候选留下的非空输出被后一候选
 * （exit 0 但没写文件）误判为自己的产出。
 *
 * 全部失败时若 RIVET_DEBUG 非空，向 stderr 打一行带原因的调试输出
 * （哪个工具、什么错误），避免静默降级不可观测。
 *
 * 注意：硬编码 PNG 校验的前提是两个调用方（toPngCandidates / resizeCandidates）
 * 的产出都是 PNG；未来若接入其他输出格式需放宽此校验。
 */
export async function runImageTool(
  candidates: ImageToolCommand[],
  outputPath: string,
  timeoutMs = 15000,
): Promise<Buffer | null> {
  let lastFailure: string | null = null
  for (const { bin, args } of candidates) {
    try {
      await rm(outputPath, { force: true })
      await execFileAsync(bin, args, { windowsHide: true, timeout: timeoutMs })
      const out = await readFile(outputPath)
      if (isCompletePng(out)) return out
      // exit 0 但输出缺失/为空/非完整 PNG——尝试下一个候选
      lastFailure = `${bin}: exit 0 但未产出完整 PNG`
    } catch (err) {
      lastFailure = `${bin}: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (lastFailure && process.env['RIVET_DEBUG']) {
    console.error(`[image-tool] 全部 ${candidates.length} 个候选失败，最后一次：${lastFailure}`)
  }
  return null
}

/** 创建本次转换的独立临时目录，并顺手触发惰性清扫（fire-and-forget）。 */
export async function makeImageTempDir(): Promise<string> {
  void sweepStaleImageTempDirs().catch(() => { /* best-effort sweep */ })
  return mkdtemp(join(tmpdir(), IMAGE_TEMP_DIR_PREFIX))
}

/** 删除转换临时目录；失败静默。 */
export async function removeImageTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort cleanup */ })
}

/** 清扫超过 1 小时的残留临时目录（进程中断的兜底回收）。 */
export async function sweepStaleImageTempDirs(now = Date.now()): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(tmpdir())
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(IMAGE_TEMP_DIR_PREFIX)) continue
    const full = join(tmpdir(), entry)
    try {
      const st = await stat(full)
      if (now - st.mtimeMs > STALE_MS) await rm(full, { recursive: true, force: true })
    } catch {
      // 单个目录失败不阻塞其余清扫
    }
  }
}
