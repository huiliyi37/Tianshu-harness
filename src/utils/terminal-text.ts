/** Incremental terminal-control filter: escape sequences may span model chunks. */
export class PlainTextFilter {
  private state: 'text' | 'escape' | 'csi' | 'string' | 'string-escape' = 'text'
  push(text: string): string {
    let clean = ''
    for (const c of text) {
      const code = c.charCodeAt(0)
      if (this.state === 'string') {
        if (c === '\x07' || c === '\x9c') this.state = 'text'
        else if (c === '\x1b') this.state = 'string-escape'
        continue
      }
      if (this.state === 'string-escape') {
        this.state = c === '\\' ? 'text' : c === '\x1b' ? 'string-escape' : 'string'
        continue
      }
      if (this.state === 'csi') {
        if (code >= 0x40 && code <= 0x7e) this.state = 'text'
        else if (c === '\x1b') this.state = 'escape'
        continue
      }
      if (this.state === 'escape') {
        if (c === '[') this.state = 'csi'
        else if (']PX^_'.includes(c)) this.state = 'string'
        else if (code >= 0x30 && code <= 0x7e) this.state = 'text'
        continue
      }
      if (c === '\x1b') this.state = 'escape'
      else if (c === '\x9b') this.state = 'csi'
      else if ('\x90\x9d\x98\x9e\x9f'.includes(c)) this.state = 'string'
      else if (c === '\n' || c === '\t' || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f))) clean += c
    }
    return clean
  }
  reset(): void { this.state = 'text' }
}

export function plainText(text: string): string { return new PlainTextFilter().push(text) }
