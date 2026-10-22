import { spawn } from 'node:child_process'
import type { MousePress } from './fullscreen-engine.js'
import type { FrontendSession } from './frontend-session.js'
import type { InputLine } from './input-line.js'
import type { OverlayEngine, OverlayMenuHit } from './overlay-engine.js'
import type { OverlayController } from './overlay-controller.js'
import { getEditorCommand } from '../external-editor.js'
import { boxInnerWidth } from '../box-chars.js'

export function frontendOpenCommand(target: string, platform = process.platform, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  if (!/^https?:\/\//i.test(target)) {
    if (platform === 'win32') return ['notepad.exe', [target]]
    if (platform === 'darwin') return ['open', ['-t', target]]
    const editor = (getEditorCommand().match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map(part => part.replace(/^(["'])(.*)\1$/, '$2'))
    if (env.TERM_PROGRAM === 'WezTerm') return ['wezterm', ['start', '--', ...editor, target]]
    if (env.TERM === 'xterm-kitty') return ['kitty', [...editor, target]]
    if (/^foot(-|$)/.test(env.TERM ?? '')) return ['foot', [...editor, target]]
    if (env.TERM === 'alacritty') return ['alacritty', ['-e', ...editor, target]]
    return ['x-terminal-emulator', ['-e', ...editor, target]]
  }
  const encoded = Buffer.from(target).toString('base64')
  const script = `$p=New-Object System.Diagnostics.ProcessStartInfo;$p.FileName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$p.UseShellExecute=$true;[Diagnostics.Process]::Start($p)|Out-Null`
  return platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]]
    : [platform === 'darwin' ? 'open' : 'xdg-open', [target]]
}

/** Local files always go to a text editor; file associations never execute them. */
export async function openFrontendTarget(target: string): Promise<void> {
  const commands = [frontendOpenCommand(target)]
  if (process.platform === 'linux' && !/^https?:\/\//i.test(target)) {
    const editor = frontendOpenCommand(target, 'linux', {})[1].slice(1)
    commands.push(['gnome-terminal', ['--', ...editor]], ['konsole', ['-e', ...editor]], ['xterm', ['-e', ...editor]])
  }
  let missing: unknown
  for (const [command, args] of commands) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
        child.once('error', reject)
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`打开程序退出 ${code}`)))
      })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing = error
    }
  }
  throw missing
}

/** 与 app 输入框渲染的 MAX_INPUT_DISPLAY_LINES 同值：命中换算必须用同一视窗。 */
const COMPOSER_MAX_LINES = 12
/** 连击判定窗口：同一格内此间隔内的按下计为双击 / 三击。 */
const MULTI_CLICK_MS = 500

export class FrontendMouse {
  private pressed?: { overlay: string; hit: OverlayMenuHit; field: string; x: number; y: number }
  private composerDrag?: { x: number; y: number; moved: boolean }
  private lastClick?: { x: number; y: number; at: number; count: number }
  private copyPress?: { x: number; y: number; moved: boolean }
  handle(event: MousePress, host: {
    session: FrontendSession; line: InputLine; overlay: OverlayEngine; controller: OverlayController; columns: number
    render: () => void; key: (name: string) => void; copy: () => void; copyOnSelect: boolean; message: (text: string) => void
    copyComposer: () => void
  }, now = Date.now()): void {
    const id = host.overlay.activeId()
    if (id && id !== 'ui-history') {
      if (event.type === 'wheel') { this.pressed = undefined; host.key(event.button & 1 ? 'down' : 'up'); return }
      const field = id === 'model-picker' ? 'modelPickerIndex' : id === 'theme-picker' ? 'themePickerIndex'
        : id === 'domain-picker' ? 'domainPickerIndex' : id === 'chronicle' ? 'chronicleIndex' : id === 'tasks' ? 'tasksIndex' : undefined
      const hit = host.overlay.menuHit(event.x, event.y)
      if (event.type === 'press') this.pressed = (event.button & 3) === 0 && field && hit ? { overlay: id, hit, field, x: event.x, y: event.y } : undefined
      if (event.type === 'move') this.pressed = undefined
      if (event.type === 'release') {
        if ((event.button & 3) === 0 && this.pressed?.overlay === id && this.pressed.x === event.x && this.pressed.y === event.y && hit?.index === this.pressed.hit.index && hit?.workerId === this.pressed.hit.workerId) {
          Object.assign(host.controller.nav(), { [this.pressed.field]: hit.index })
          if (id === 'tasks') host.controller.nav().tasksSelectedId = hit.workerId
          host.overlay.rerender()
        }
        this.pressed = undefined
      }
      return
    }
    if (event.type === 'press' && (event.button & 3) === 0 && host.session.copyButtonHit(event.x, event.y)) {
      this.copyPress = { x: event.x, y: event.y, moved: false }
      return
    }
    if (this.copyPress && (event.type === 'move' || event.type === 'release')) {
      if (event.type === 'move') { this.copyPress.moved = true; return }
      if (event.type === 'release') {
        if (!this.copyPress.moved && (event.button & 3) === 0 && event.x === this.copyPress.x && event.y === this.copyPress.y && host.session.copyButtonHit(event.x, event.y)) host.copy()
        this.copyPress = undefined
      }
      return
    }
    const target = host.session.linkTargetAt(event)
    if (target) { void openFrontendTarget(target).catch(error => host.message(`打开失败：${error.message}`)); return }
    // 输入框内：单击落光标，拖动选区，双击选词，三击选整行；松开时按「选中即复制」复制。
    // 选区留在输入框里，随后 Backspace/Delete 删除、直接输入替换（对齐 codex 输入框）。
    const width = Math.max(1, boxInnerWidth(host.columns))
    const hit = !id ? host.session.composerHit(event.x, event.y) : null
    if (hit && event.type === 'press' && (event.button & 3) === 0 && !event.ctrl) {
      host.session.closeHistory()
      const last = this.lastClick
      const count = last && last.x === event.x && last.y === event.y && now - last.at < MULTI_CLICK_MS ? last.count % 3 + 1 : 1
      this.lastClick = { x: event.x, y: event.y, at: now, count }
      host.line.selectVisible(hit.line, hit.column, width, COMPOSER_MAX_LINES, count === 3 ? 'line' : count === 2 ? 'word' : 'start')
      this.composerDrag = { x: event.x, y: event.y, moved: false }
      host.render()
      return
    }
    if (this.composerDrag && (event.type === 'move' || event.type === 'release')) {
      // 原地松开不扩展：否则双击/三击得到的词/行选区会被收缩回落点。
      this.composerDrag.moved ||= event.x !== this.composerDrag.x || event.y !== this.composerDrag.y
      const near = this.composerDrag.moved ? host.session.composerHitNearest(event.x, event.y) : null
      if (near) host.line.selectVisible(near.line, near.column, width, COMPOSER_MAX_LINES, 'extend')
      if (event.type === 'release') {
        this.composerDrag = undefined
        if (host.copyOnSelect && host.line.selectedText) host.copyComposer()
      }
      host.render()
      return
    }
    if (event.type === 'press' && host.line.clearSelection()) host.render()
    host.session.handleMouse(event)
    if (event.type === 'release' && host.copyOnSelect) host.copy()
    if (id) host.overlay.rerender()
  }
}
