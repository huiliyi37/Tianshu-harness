/**
 * /clipboard/image — 桌面端「Ctrl+V 粘贴剪贴板图片」的 IPC 兜底（#302）。
 *
 * WebKitGTK 的 paste 事件对纯图片剪贴板透出**空 clipboardData**（平台行为，
 * webkit2gtk 2.52 实测：types/items/files 全空，文本正常）——前端从
 * clipboardData.items 取图的通路在 Linux 上必然拿不到。navigator.clipboard.read()
 * 是首选绕行（依赖 secure context + 权限），这条路由是第二道兜底：复用 TUI
 * 已验证的全平台取图链（native 包 → osascript / xclip / wl-paste / PowerShell，
 * 自带缩图），任何平台下 paste 事件拿不到图时都能救回。
 *
 *   GET /clipboard/image → { image: { dataUrl, mime, name } | null }
 *
 * 返回 dataUrl（而非裸字节）——取图链的产物本来就是 base64，省去二进制响应
 * 管线；桌面端拿到后转 File 走既有 addImages 通路。
 */
import { isAuthorizedRequest } from './auth.js'
import type { RouteHandler } from './index.js'
import type { readImageFromClipboard } from '../tui/engine/clipboard-image.js'

/** 依赖注入口：测试替换取图实现，不碰真实系统剪贴板。 */
export interface ClipboardRoutesDeps {
  readImage?: typeof readImageFromClipboard
}

export function buildClipboardRoutes(apiToken?: string, deps: ClipboardRoutesDeps = {}): Record<string, RouteHandler> {
  const readImage = deps.readImage ?? (async () => {
    const { readImageFromClipboard } = await import('../tui/engine/clipboard-image.js')
    return readImageFromClipboard()
  })
  const withAuth = (handler: RouteHandler): RouteHandler => async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
  return {
    'GET /clipboard/image': withAuth(async () => {
      try {
        const img = await readImage()
        // 剪贴板无图 / 取图工具全缺 → image:null（前端据此刻 toast 引导附件入口，
        // 不再静默——#302「无任何反应」根因之一就是失败不可见）。
        return { status: 200, body: { image: img ? { dataUrl: img.dataUrl, mime: img.mime, name: img.name } : null } }
      } catch (err) {
        // 取图链抛错（工具缺失/平台不支持）→ 可解释的 500，前端 toast 兜底提示。
        return { status: 500, body: { error: err instanceof Error ? err.message.split('\n')[0] : String(err) } }
      }
    }),
  }
}
