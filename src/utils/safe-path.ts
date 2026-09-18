/**
 * 路由参数/外部输入拼进文件路径前的单段名守卫。
 *
 * 背景（2026-09-17 审计）：路由段的 decodeURIComponent 发生在段匹配之后，
 * `%2e%2e%2f` 还原成 `../` 直进 join 即越界——skill 名 / plans slug /
 * workerId / checkpoint groupId 四处同病。消费侧（readFile/rmSync/
 * writeFileSync）语义各异，守卫必须在 join 之前挡下。
 *
 * 语义与 scratch-cleanup 的 isSafeScratchName 同族（单段、非隐藏、非穿越），
 * 另加长度上限；允许 Unicode 与点号（既有技能名/计划 slug 的向后兼容面），
 * 拒绝分隔符、空字节、前导点与任何 `..` 序列。
 */
const MAX_NAME_LENGTH = 200

export function isSafeFileName(name: string): boolean {
  if (!name || name.length > MAX_NAME_LENGTH) return false
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false
  if (name.startsWith('.')) return false
  if (name.includes('..')) return false
  return true
}
