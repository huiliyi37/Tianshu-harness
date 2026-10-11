import type { ConnectOverlayData } from './format/overlay.js'

type Key = { name: string; char: string; ctrl?: boolean; meta?: boolean }

/** The buffer belongs only to this masked overlay, never the composer or history. */
export class TokenLedgerConnect {
  private input = ''
  private cursor = 0
  private error?: string
  constructor(private save?: (key: string) => void) {}

  data(): ConnectOverlayData {
    return { view: { kind: 'input', title: '连接 Token 账本', subtitle: '输入 tsu_ 同步密钥；保存后仅本地记录，/token-ledger sync 手动上传', masked: true, placeholder: 'tsu_…' }, input: this.input, error: this.error, cursorPos: this.cursor, selectedIndex: 0 }
  }
  clear(): void { this.input = ''; this.cursor = 0; this.error = undefined; this.save = undefined }
  paste(text: string): void {
    const value = text.replace(/[\r\n]+$/, '')
    this.input = this.input.slice(0, this.cursor) + value + this.input.slice(this.cursor)
    this.cursor += value.length
    this.error = undefined
  }
  key(key: Key): 'close' | 'saved' | 'edit' {
    if (key.name === 'escape' || key.ctrl && key.char.toLowerCase() === 'c') { this.clear(); return 'close' }
    if (key.name === 'return') {
      const candidate = this.input.trim()
      this.input = ''; this.cursor = 0
      if (!/^tsu_[a-zA-Z0-9_-]+$/.test(candidate) || candidate.length > 4096) { this.error = '请输入有效的 tsu_ 同步密钥'; return 'edit' }
      try { this.save?.(candidate); this.clear(); return 'saved' }
      catch { this.error = '密钥保存失败；请重新输入后重试'; return 'edit' }
    }
    if (key.name === 'left') this.cursor = Math.max(0, this.cursor - 1)
    else if (key.name === 'right') this.cursor = Math.min(this.input.length, this.cursor + 1)
    else if (key.name === 'backspace' || key.name === 'ctrl_h') {
      if (this.cursor > 0) { this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor); this.cursor-- }
    } else if (key.ctrl && key.char.toLowerCase() === 'u') { this.input = ''; this.cursor = 0 }
    else if (!key.ctrl && !key.meta && key.char && [...key.char].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)) this.paste(key.char)
    return 'edit'
  }
}
