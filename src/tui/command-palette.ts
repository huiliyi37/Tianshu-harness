/**
 * 命令面板数据层 — 命令清单与模糊过滤（纯函数，零 React/Ink）。
 *
 * 渲染与按键交互在 T9：`format/overlay.ts::renderCommandPalette` +
 * `engine/app.ts` 的 overlay 导航。本模块只提供数据。
 *
 * **元数据不在这里**——唯一事实源是 `command-catalog.ts`（理由见该文件头注释）。
 * 本模块只负责过滤与排序行为。
 */

import { COMMAND_CATALOG, SURFACE_ENTRIES, type CommandMeta } from './command-catalog.js'

export type PaletteCommand = CommandMeta & {
  category?: 'command' | 'surface'
}

export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  if (!query) return [...commands]
  const lower = query.toLowerCase()
  return commands
    .filter(c => {
      if (c.name.toLowerCase().includes(lower)) return true
      if (c.description.toLowerCase().includes(lower)) return true
      let qi = 0
      for (let i = 0; i < c.name.length && qi < lower.length; i++) {
        if (c.name[i]!.toLowerCase() === lower[qi]) qi++
      }
      return qi === lower.length
    })
    .sort((a, b) => {
      const aStart = a.name.toLowerCase().startsWith(lower) ? 0 : 1
      const bStart = b.name.toLowerCase().startsWith(lower) ? 0 : 1
      return aStart - bStart || a.name.localeCompare(b.name)
    })
}

/**
 * 面板条目 = 界面动作 + 命令目录（含展示用子命令提示）。
 *
 * 此前这里是 82 条硬编码数组，与 registry、/help 三方漂移——35 条已注册命令
 * 因为没有条目而对用户不可见。现在从 command-catalog.ts 派生，**顺序即目录顺序**
 * （人工编排，勿重排）。
 */
export function getPaletteCommands(): PaletteCommand[] {
  return [
    ...SURFACE_ENTRIES.map(e => ({ ...e })),
    ...COMMAND_CATALOG.map(c => ({ ...c })),
  ]
}
