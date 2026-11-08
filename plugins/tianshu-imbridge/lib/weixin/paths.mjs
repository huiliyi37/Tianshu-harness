/**
 * 桌面路径解析（多平台）+ 二维码图片落位。
 *
 * 为什么值得单独一个模块：主人扫的码必须在**他一眼就能找到**的地方。
 * 插件跑在天枢进程里，环境变量与天枢一致，所以从环境变量推是最稳的；
 * 万一推不出来（非 Windows / 环境被裁剪 / 目录不可写），必须**明确退回**到数据目录
 * 并在对话里说清楚，而不是静默失败或硬编码某个人的路径（红线 5）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 猜桌面目录（只读判断，不建目录）。
 * Windows：优先 USERPROFILE\Desktop；被 OneDrive 重定向时通常是 USERPROFILE\OneDrive\Desktop。
 * 其它平台：HOME/Desktop 或 XDG_DESKTOP_DIR。
 * @returns {string|null} 存在的候选目录；都不存在给 null
 */
export function resolveDesktopDir(env = process.env) {
  const candidates = []
  const userProfile = typeof env.USERPROFILE === 'string' ? env.USERPROFILE.trim() : ''
  const home = typeof env.HOME === 'string' ? env.HOME.trim() : ''
  const oneDrive = typeof env.OneDrive === 'string' ? env.OneDrive.trim() : ''
  const xdg = typeof env.XDG_DESKTOP_DIR === 'string' ? env.XDG_DESKTOP_DIR.trim() : ''

  if (userProfile) {
    candidates.push(join(userProfile, 'Desktop'))
    candidates.push(join(userProfile, 'OneDrive', 'Desktop'))
  }
  if (oneDrive) candidates.push(join(oneDrive, 'Desktop'))
  if (xdg) candidates.push(xdg)
  if (home) candidates.push(join(home, 'Desktop'))

  for (const candidate of candidates) {
    try {
      if (candidate && existsSync(candidate)) return candidate
    } catch { /* 下一个 */ }
  }
  return null
}

/**
 * 写二维码图片到桌面；桌面不可用时退回 fallbackDir。
 * @returns {{path:string, onDesktop:boolean, note:string|null}}
 */
export function writeQrImage(bytes, {
  env = process.env, fileName = '天枢-微信扫码.png', fallbackDir,
} = {}) {
  const desktop = resolveDesktopDir(env)
  const attempts = []
  if (desktop) attempts.push({ dir: desktop, onDesktop: true })
  if (fallbackDir) attempts.push({ dir: fallbackDir, onDesktop: false })

  const errors = []
  for (const attempt of attempts) {
    const target = join(attempt.dir, fileName)
    try {
      mkdirSync(attempt.dir, { recursive: true })
      writeFileSync(target, bytes)
      return {
        path: target,
        onDesktop: attempt.onDesktop,
        note: attempt.onDesktop ? null : '桌面目录没找到或不可写，已放到插件数据目录',
      }
    } catch (error) {
      errors.push(`${attempt.dir}: ${error?.message ?? error}`)
    }
  }
  return {
    path: null,
    onDesktop: false,
    note: `二维码图片写不出去（${errors.join('；')}）`,
  }
}
