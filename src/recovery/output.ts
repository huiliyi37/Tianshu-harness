import { PlainTextFilter, plainText } from '../utils/terminal-text.js'
export { PlainTextFilter, plainText } from '../utils/terminal-text.js'

export class RecoveryOutput {
  private filter = new PlainTextFilter()
  private pending = ''
  private timer?: ReturnType<typeof setTimeout>
  constructor(private output: NodeJS.WritableStream, private intervalMs = 100) {}
  delta(text: string): void {
    this.pending += this.filter.push(text)
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.intervalMs)
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.pending) this.output.write(this.pending)
    this.pending = ''
  }
  line(text = ''): void {
    this.flush()
    // An incomplete model control string cannot swallow trusted UI boundaries.
    this.filter.reset()
    this.output.write(plainText(text) + '\n')
  }
  prompt(text: string): void { this.flush(); this.output.write(plainText(text)) }
  close(): void { this.flush(); this.filter.reset() }
}
