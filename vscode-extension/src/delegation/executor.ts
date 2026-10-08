/**
 * E4 client landing executor — lives in the extension host (not webview).
 *
 * Independent SSE subscription (since=lastSeq, clientId-bound) so delegation
 * works even when the cockpit webview is closed. Handles:
 *   apply_edit  → WorkspaceEdit + red/green decorations + CodeLens
 *   terminal_exec → visible Terminal + Shell Integration (capability opt-in)
 */
import * as vscode from 'vscode'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { SidecarClient } from '../sidecar/client.js'
import type { SessionEvent } from '../sidecar/protocol.js'
import { DiffDecorationController, computeLineRanges, type PendingEdit } from './diff-decorations.js'
import { DelegateCodeLensProvider } from './codelens.js'
import { APPLY_EDIT_AUTO_ACCEPT_MS } from './pending-policy.js'

const HEARTBEAT_MS = 25_000
const PROTOCOL_MIN = 1

interface DelegationOrigin {
  client: SidecarClient
  sessionId: string
  generation: number
}

export class DelegationExecutor implements vscode.Disposable {
  private readonly clientId = `ext-${randomBytes(8).toString('hex')}`
  private readonly decorations = new DiffDecorationController()
  private readonly codeLenses = new DelegateCodeLensProvider(this.decorations)
  private unsub: (() => void) | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private sessionId: string | undefined
  private client: SidecarClient | undefined
  private workspaceCwd: string
  private terminal: vscode.Terminal | undefined
  private terminalCwd: string | undefined
  private hasShellIntegration = false
  private disposed = false
  private sessionGeneration = 0
  /** Resolvers waiting on CodeLens accept/reject (requestId → settle). */
  private readonly pendingDecisions = new Map<
    string,
    { resolve: (status: 'ok' | 'rejected') => void; timer?: ReturnType<typeof setTimeout> }
  >()

  constructor(
    private readonly getClient: () => Promise<SidecarClient>,
    workspaceCwd: string,
  ) {
    this.workspaceCwd = workspaceCwd
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this.codeLenses),
      vscode.commands.registerCommand('tianshu.acceptEdit', (uri: vscode.Uri) => void this.decide(uri, 'ok')),
      vscode.commands.registerCommand('tianshu.rejectEdit', (uri: vscode.Uri) => void this.decide(uri, 'rejected')),
      this,
    )
  }

  /** Bind to the active session — creates a dedicated SSE + capability slot. */
  async attachSession(sessionId: string): Promise<void> {
    if (this.disposed) return
    this.detach()
    const generation = this.sessionGeneration
    this.sessionId = sessionId
    const client = await this.getClient()
    if (generation !== this.sessionGeneration) return
    this.client = client
    const origin = { client, sessionId, generation }

    const proto = await client.probeProtocolVersion()
    if (!this.isCurrent(origin)) return
    if (proto > 0 && proto < PROTOCOL_MIN) {
      void vscode.window.showWarningMessage(
        `天枢内核协议版本 ${proto} 过旧（需要 ≥${PROTOCOL_MIN}），客户端工具委托已禁用。请升级 rivet CLI。`,
      )
      return
    }

    const hasShellIntegration = await this.detectShellIntegration()
    if (!this.isCurrent(origin)) return
    this.hasShellIntegration = hasShellIntegration
    const kinds: Array<'apply_edit' | 'terminal_exec'> = ['apply_edit']
    if (this.hasShellIntegration) kinds.push('terminal_exec')

    await client.registerDelegateCapabilities(sessionId, this.clientId, kinds)
    if (!this.isCurrent(origin)) return
    this.heartbeat = setInterval(() => {
      if (!this.isCurrent(origin)) return
      void client.registerDelegateCapabilities(sessionId, this.clientId, kinds).catch(() => {})
    }, HEARTBEAT_MS)

    const rec = await client.getSession(sessionId)
    if (!this.isCurrent(origin)) return
    const since = rec.lastSeq ?? 0
    this.unsub = client.subscribe(
      sessionId,
      since,
      (ev) => { if (this.isCurrent(origin)) void this.onEvent(ev, origin) },
      undefined,
      { clientId: this.clientId },
    )
  }

  detach(): void {
    this.sessionGeneration++
    this.unsub?.()
    this.unsub = undefined
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    for (const [, p] of this.pendingDecisions) {
      if (p.timer) clearTimeout(p.timer)
      p.resolve('ok') // 已落盘：切会话时按接受收口，避免 agent 挂死
    }
    this.pendingDecisions.clear()
    this.decorations.clear()
    this.codeLenses.refresh()
    this.sessionId = undefined
    this.client = undefined
  }

  private isCurrent(origin: DelegationOrigin): boolean {
    return !this.disposed && origin.generation === this.sessionGeneration &&
      origin.client === this.client && origin.sessionId === this.sessionId
  }

  private async onEvent(ev: SessionEvent, boundOrigin?: DelegationOrigin): Promise<void> {
    if (ev.type !== 'tool_delegate' || !this.client || !this.sessionId) return
    const origin = boundOrigin ?? { client: this.client, sessionId: this.sessionId, generation: this.sessionGeneration }
    if (!this.isCurrent(origin)) return
    const requestId = String(ev.data.requestId ?? '')
    const kind = ev.data.kind
    const payload = (ev.data.payload ?? {}) as Record<string, unknown>
    if (!requestId) return
    try {
      if (kind === 'apply_edit') {
        await this.handleApplyEdit(requestId, payload, origin)
      } else if (kind === 'terminal_exec') {
        await this.handleTerminalExec(requestId, payload, origin)
      }
    } catch (err) {
      await origin.client.answerDelegation(origin.sessionId, requestId, {
        content: `Client landing failed: ${(err as Error).message}`,
        isError: true,
        status: 'ok',
      }).catch(() => {})
    }
  }

  private async handleApplyEdit(requestId: string, payload: Record<string, unknown>, origin: DelegationOrigin): Promise<void> {
    const { client, sessionId } = origin
    const relPath = String(payload.path ?? '')
    const oldContent = String(payload.oldContent ?? '')
    const newContent = String(payload.newContent ?? '')
    if (!relPath || relPath.includes('..')) {
      await client.answerDelegation(sessionId, requestId, {
        content: 'Invalid path',
        isError: true,
      })
      return
    }
    const uri = vscode.Uri.file(`${this.workspaceCwd}/${relPath}`)
    const edit = new vscode.WorkspaceEdit()
    // Ensure file exists for replace
    try {
      await vscode.workspace.fs.stat(uri)
    } catch {
      edit.createFile(uri, { ignoreIfExists: true })
    }
    if (!this.isCurrent(origin)) throw new Error('Delegation session changed before edit')
    let doc: vscode.TextDocument
    try {
      doc = await vscode.workspace.openTextDocument(uri)
    } catch {
      if (!this.isCurrent(origin)) throw new Error('Delegation session changed before edit')
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(''))
      if (!this.isCurrent(origin)) throw new Error('Delegation session changed before edit')
      doc = await vscode.workspace.openTextDocument(uri)
    }
    if (!this.isCurrent(origin)) throw new Error('Delegation session changed before edit')
    const previousContent = doc.getText()
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(previousContent.length))
    edit.replace(uri, full, newContent)
    const ok = await vscode.workspace.applyEdit(edit)
    const appliedVersion = doc.version
    if (!ok) {
      await client.answerDelegation(sessionId, requestId, {
        content: `WorkspaceEdit failed for ${relPath}`,
        isError: true,
      })
      return
    }
    if (!this.isCurrent(origin)) {
      await client.answerDelegation(sessionId, requestId, { content: `Applied edit to ${relPath}`, isError: false, status: 'ok' })
      return
    }

    const ranges = computeLineRanges(oldContent, newContent)
    const pending: PendingEdit = {
      requestId,
      sessionId,
      relPath,
      uri,
      oldContent,
      newContent,
      added: ranges.added,
      removed: ranges.removed,
    }
    await this.decorations.show(pending)
    if (!this.isCurrent(origin)) {
      await client.answerDelegation(sessionId, requestId, { content: `Applied edit to ${relPath}`, isError: false, status: 'ok' })
      return
    }
    this.codeLenses.refresh()
    void vscode.window.showInformationMessage(`天枢改了 ${relPath}，请在编辑器 CodeLens 接受或拒绝。`)

    const status = await new Promise<'ok' | 'rejected'>((resolve) => {
      const entry: { resolve: (status: 'ok' | 'rejected') => void; timer?: ReturnType<typeof setTimeout> } = { resolve }
      if (APPLY_EDIT_AUTO_ACCEPT_MS > 0) {
        entry.timer = setTimeout(() => {
          this.pendingDecisions.delete(requestId)
          resolve('ok')
        }, APPLY_EDIT_AUTO_ACCEPT_MS)
      }
      this.pendingDecisions.set(requestId, entry)
    })

    if (status === 'rejected') {
      const revert = new vscode.WorkspaceEdit()
      const fresh = await vscode.workspace.openTextDocument(uri)
      if (fresh.version !== appliedVersion || fresh.getText() !== newContent) {
        if (this.isCurrent(origin)) {
          this.decorations.clear(uri)
          this.codeLenses.refresh()
        }
        void vscode.window.showWarningMessage(`无法自动撤销 ${relPath}：文件已修改，请手动检查并撤销代理改动。当前内容已保留。`)
        await client.answerDelegation(sessionId, requestId, {
          content: `Rejection conflict for ${relPath}: document changed after the delegated edit; current content preserved.`,
          isError: true,
          status: 'rejected',
        })
        return
      }
      const span = new vscode.Range(fresh.positionAt(0), fresh.positionAt(fresh.getText().length))
      revert.replace(uri, span, previousContent)
      const reverted = await vscode.workspace.applyEdit(revert)
      if (this.isCurrent(origin)) {
        this.decorations.clear(uri)
        this.codeLenses.refresh()
      }
      await client.answerDelegation(sessionId, requestId, {
        content: reverted ? `User rejected edit to ${relPath}` : `Could not revert rejected edit to ${relPath}; current content preserved.`,
        isError: !reverted,
        status: 'rejected',
      })
      return
    }

    if (this.isCurrent(origin)) {
      this.decorations.clear(uri)
      this.codeLenses.refresh()
    }
    await client.answerDelegation(sessionId, requestId, {
      content: `Applied edit to ${relPath}`,
      isError: false,
      status: 'ok',
    })
  }

  private async decide(uri: vscode.Uri, status: 'ok' | 'rejected'): Promise<void> {
    const pending = this.decorations.get(uri)
    if (!pending) return
    const waiter = this.pendingDecisions.get(pending.requestId)
    if (!waiter) return
    if (waiter.timer) clearTimeout(waiter.timer)
    this.pendingDecisions.delete(pending.requestId)
    waiter.resolve(status)
  }

  private async handleTerminalExec(requestId: string, payload: Record<string, unknown>, origin: DelegationOrigin): Promise<void> {
    const { client, sessionId } = origin
    const command = String(payload.command ?? '')
    const cwd = String(payload.cwd ?? this.workspaceCwd)
    if (!command) return

    if (!this.hasShellIntegration) {
      // Should not be registered — fail-back by not answering? Server waits → timeout → null.
      // Answer with error so agent gets a clear signal rather than waiting 5min.
      await client.answerDelegation(sessionId, requestId, {
        content: 'Shell Integration unavailable; kernel should fail-back.',
        isError: true,
      })
      return
    }

    const term = this.ensureTerminal(cwd)
    term.show(true)

    const si = await this.waitShellIntegration(term, 8_000)
    if (!this.isCurrent(origin)) throw new Error('Delegation session changed before execution')
    if (!si?.executeCommand) {
      await client.answerDelegation(sessionId, requestId, {
        content: 'Shell Integration not ready',
        isError: true,
      })
      return
    }
    if (!si.cwd?.fsPath || resolve(si.cwd.fsPath) !== resolve(cwd)) {
      await client.answerDelegation(sessionId, requestId, { content: 'Terminal cwd could not be verified for this request', isError: true })
      return
    }

    let execution: vscode.TerminalShellExecution | undefined
    let settle!: (code: number | undefined) => void
    const exitPromise = new Promise<number | undefined>((resolve) => { settle = resolve })
    const endSub = vscode.window.onDidEndTerminalShellExecution((e) => {
      if (e.execution === execution) settle(e.exitCode)
    })
    const closeSub = vscode.window.onDidCloseTerminal((closed) => {
      if (closed === term) settle(undefined)
    })
    try {
      execution = si.executeCommand(command)
      const output = await this.readExecutionOutput(execution)
      const exitCode = await exitPromise
      const code = exitCode ?? 'unknown'
      const content = output || `(no output, exit ${code})`
      await client.answerDelegation(sessionId, requestId, {
        content: exitCode === 0 ? content : `${content}\n\n[exit ${code}]`,
        isError: exitCode !== 0,
        status: 'ok',
      })
    } finally {
      endSub.dispose()
      closeSub.dispose()
    }
  }

  private ensureTerminal(cwd: string): vscode.Terminal {
    const target = resolve(cwd)
    const actualCwd = this.terminal?.shellIntegration?.cwd?.fsPath
    if (this.terminal && this.terminal.exitStatus === undefined && this.terminalCwd === target &&
      (actualCwd ? resolve(actualCwd) === target : !this.terminal.shellIntegration)) return this.terminal
    this.terminal = vscode.window.createTerminal({ name: '天枢', cwd: target })
    this.terminalCwd = target
    return this.terminal
  }

  private async detectShellIntegration(): Promise<boolean> {
    // Probe: create a hidden terminal and see if shellIntegration appears.
    // Cursor / older VS Code may lack it — then we never register terminal_exec.
    try {
      const t = vscode.window.createTerminal({ name: '天枢-probe', hideFromUser: true })
      const si = await this.waitShellIntegration(t, 8_000)
      t.dispose()
      return !!si?.executeCommand && !!vscode.window.onDidEndTerminalShellExecution
    } catch {
      return false
    }
  }

  private waitShellIntegration(
    term: vscode.Terminal,
    timeoutMs: number,
  ): Promise<vscode.Terminal['shellIntegration']> {
    if (term.shellIntegration) return Promise.resolve(term.shellIntegration)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sub.dispose()
        resolve(undefined)
      }, timeoutMs)
      const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === term && e.shellIntegration) {
          clearTimeout(timer)
          sub.dispose()
          resolve(e.shellIntegration)
        }
      })
    })
  }

  private async readExecutionOutput(execution: { read?: () => AsyncIterable<string> }): Promise<string> {
    try {
      if (!execution.read) return ''
      const stream = execution.read()
      let out = ''
      for await (const chunk of stream) {
        out += chunk
        if (out.length > 200_000) {
          out += '\n…(truncated)'
          break
        }
      }
      return out
    } catch {
      return ''
    }
  }

  dispose(): void {
    this.disposed = true
    this.detach()
    this.decorations.dispose()
    this.terminal?.dispose()
  }
}
