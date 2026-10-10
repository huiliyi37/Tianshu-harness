import { createInterface, type Interface } from 'node:readline/promises'
import type { RecoveryOutput } from './output.js'

/** Queue line events immediately: question() loses early lines from piped stdin. */
export class RecoveryInput {
  private rl: Interface
  private queue: string[] = []
  private ended = false
  private waiter?: { approval: boolean; resolve: (line: string | null) => void }
  private injected: boolean
  private interactive: boolean
  constructor(input: NodeJS.ReadableStream, private output: RecoveryOutput, rl: Interface | undefined, private interrupt: (exit: boolean) => boolean) {
    this.injected = !!rl
    this.interactive = (input as NodeJS.ReadStream).isTTY === true
    this.rl = rl ?? createInterface({ input, terminal: false, crlfDelay: Infinity })
    if (!rl) {
      this.rl.on('line', this.onLine)
      this.rl.on('close', this.onClose)
      this.rl.on('SIGINT', this.onInterrupt)
    }
  }
  private onLine = (line: string) => {
    const cmd = line.trim().toLowerCase()
    if ((cmd === '/abort' || cmd === '/exit' || cmd === '/quit') && this.interrupt(cmd !== '/abort')) {
      this.cancelWait()
      return
    }
    if (this.waiter) {
      const { resolve } = this.waiter
      this.waiter = undefined
      resolve(line)
    } else this.queue.push(line)
  }
  private onClose = () => {
    this.ended = true
    if (this.interactive) this.interrupt(true)
    this.cancelWait()
  }
  private onInterrupt = () => { this.interrupt(false); this.cancelWait() }
  cancelWait(): void { this.waiter?.resolve(null); this.waiter = undefined }
  async read(prompt: string, approval = false): Promise<string | null> {
    this.output.prompt(prompt)
    if (this.injected) {
      try { return await this.rl.question('') } catch { return null }
    }
    // Pretyped commands/answers belong to earlier prompts, never a new grant.
    if (!approval && this.queue.length) return this.queue.shift()!
    if (this.ended) return null
    return new Promise(resolve => { this.waiter = { approval, resolve } })
  }
  close(): void {
    this.rl.off?.('line', this.onLine)
    this.rl.off?.('close', this.onClose)
    this.rl.off?.('SIGINT', this.onInterrupt)
    this.cancelWait()
    this.rl.close()
  }
}
