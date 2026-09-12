/**
 * 磁盘水位探测（statfs）。2026-09-12 事故线：termux worker 的 tsc 因磁盘 100%
 * 满挂死而无人知晓——水位不可见是当时最大的盲区。这里只做「看得见」：
 * 低水位时给调用方一个可展示的警告，不阻断任何操作（fail-open）。
 */
import { statfsSync } from 'node:fs'

/** 默认低水位阈值（MB）。tsc 全量的缓存/临时产物量级在几十 MB，512MB 给足余量。 */
export const DEFAULT_DISK_WARN_MB = 512

/** 指定路径所在文件系统的可用字节数。读不到（权限/平台）→ undefined（调用方按正常处理）。 */
export function freeDiskBytes(path: string): number | undefined {
  try {
    const s = statfsSync(path)
    return s.bavail * s.bsize
  } catch {
    return undefined
  }
}

/** 生效的低水位阈值（MB）。RIVET_DISK_WARN_MB 覆盖；0 = 关闭警告。 */
export function diskWarnThresholdMb(): number {
  const v = Number(process.env.RIVET_DISK_WARN_MB)
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_DISK_WARN_MB
}

/** 低水位警告行（可直接前缀到工具输出）；水位正常/读不到/已关闭 → undefined。 */
export function lowDiskWarning(path: string, thresholdMb = diskWarnThresholdMb()): string | undefined {
  if (thresholdMb <= 0) return undefined
  const free = freeDiskBytes(path)
  if (free === undefined || free >= thresholdMb * 1024 * 1024) return undefined
  const mb = Math.floor(free / (1024 * 1024))
  return `⚠ 磁盘可用空间仅剩 ${mb}MB（阈值 ${thresholdMb}MB）——写文件/构建/缓存可能莫名失败，先清理磁盘再重试。`
}
