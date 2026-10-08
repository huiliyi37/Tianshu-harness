/**
 * 座舱编辑区 WebviewPanel — webview ↔ 扩展宿主 postMessage 桥。
 *
 * 只挂编辑区，不注册活动栏 webview（点星星会换掉资源管理器）。
 * P0 选宿主桥而非 webview 直连 sidecar：规避 webview CSP/CORS 面（sidecar
 * 未开 CORS，webview origin 是 vscode-webview://），token 也不进 webview。
 * 桥保持薄：webview 消息 → REST 调用；SSE 事件 → 原样转发（含 seq，webview
 * 侧按 seq 去重容错未知类型）。
 */
import * as vscode from 'vscode'
import { SidecarClient } from '../sidecar/client.js'
import type { SessionEvent, SessionRecord } from '../sidecar/protocol.js'
import { buildSessionCatalog } from '../sidecar/session-catalog.js'

/** webview → host 消息 */
type InboundMsg =
  | { type: 'ready' }
  | { type: 'listSessions'; includeArchived?: boolean }
  | { type: 'createSession'; prompt?: string; isolatedWorktree?: boolean; model?: string; domain?: string }
  | { type: 'listCatalog' }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'archiveSession'; sessionId: string }
  | { type: 'unarchiveSession'; sessionId: string }
  | { type: 'renameSession'; sessionId: string; title: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'searchSessions'; q: string; reqId: number }
  | { type: 'getSettings' }
  | { type: 'saveApproval'; approval: string }
  | { type: 'saveCheckpoint'; checkpointEveryTurns: number }
  | { type: 'saveDefaultModel'; defaultModel: string }
  | { type: 'saveDefaultDomain'; defaultDomain: string }
  | { type: 'setEffort'; sessionId: string; effort: string }
  | { type: 'prompt'; sessionId: string; text: string; images?: string[] }
  | { type: 'steer'; sessionId: string; text: string }
  | { type: 'abort'; sessionId: string }
  | { type: 'resume'; sessionId: string }
  | { type: 'handoff'; sessionId: string; note?: string }
  | { type: 'approval'; sessionId: string; requestId: string; decision: 'approve' | 'deny'; editedInput?: Record<string, unknown>; remember?: boolean }
  | { type: 'setApprovalMode'; sessionId: string; mode: string }
  | { type: 'listPickers'; sessionId: string }
  | { type: 'switchModel'; sessionId: string; modelId: string }
  | { type: 'setDomain'; sessionId: string; key: string }
  | { type: 'queryFiles'; sessionId: string; q: string; reqId: number }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'listProviders' }
  | { type: 'setupProvider'; providerName: string; apiKey: string; baseUrl?: string; custom?: boolean; modelId?: string }
  | { type: 'readPlan'; sessionId: string; slug: string; revision?: number }
  | { type: 'planDecision'; sessionId: string; slug: string; decision: 'approve' | 'reject'; comment?: string; selectedApproach?: string; revision?: number }
  | { type: 'editPlan'; sessionId: string; slug: string; content: string; revision?: number }
  | { type: 'setPlanMode'; sessionId: string; state: 'planning' | 'off' }
  | { type: 'setAskMode'; sessionId: string; state: 'asking' | 'off' }
  | { type: 'copyText'; text: string }
  | { type: 'queue'; sessionId: string; text: string }
  | { type: 'retractQueued'; sessionId: string; laneId: string; text: string }
  | { type: 'steerLane'; sessionId: string; laneId: string; text: string }
  | { type: 'getCockpit'; sessionId: string }
  | { type: 'loadEarlier'; sessionId: string; before: number }
  | { type: 'listRewindPoints'; sessionId: string }
  | { type: 'rewind'; sessionId: string; messageIndex: number; rollbackFiles?: boolean }

export class CockpitProvider {
  private panel: vscode.WebviewPanel | undefined
  private client: SidecarClient | undefined
  private unsubscribe: (() => void) | undefined
  private activeSessionId: string | undefined
  private subscriptionGeneration = 0
  private rewindRequestGeneration = 0

  /** 会话切换 / 文件可能变化的活动信号（extension.ts 接变更视图刷新）。 */
  onSessionActivity: ((kind: 'attach' | 'activity', sessionId: string) => void) | undefined

  /** 活跃会话的原始事件流（extension.ts 接状态栏：status / 审批计数）。 */
  onSessionEvent: ((ev: SessionEvent) => void) | undefined

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getClient: () => Promise<SidecarClient>,
    private readonly workspaceCwd: string,
  ) {}

  /**
   * 在编辑区打开座舱，不抢资源管理器。无打开文件时铺满中间；
   * 已有编辑器则在旁边拆一列。
   */
  openInEditor(): void {
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active)
      return
    }
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active
    this.panel = vscode.window.createWebviewPanel(
      'tianshu.cockpitEditor',
      '天枢座舱',
      column,
      {
        enableScripts: true,
        enableForms: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')],
      },
    )
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png')
    this.panel.webview.html = this.renderHtml(this.panel.webview)
    this.panel.webview.onDidReceiveMessage((msg: InboundMsg) => void this.onMessage(msg))
    this.panel.onDidDispose(() => {
      this.panel = undefined
      this.teardownBridge()
    })
  }

  private teardownBridge(): void {
    this.subscriptionGeneration++
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  private post(msg: Record<string, unknown>): void {
    if (this.panel) void this.panel.webview.postMessage(msg)
  }

  private async onMessage(msg: InboundMsg): Promise<void> {
    if (msg.type === 'copyText') {
      await vscode.env.clipboard.writeText(msg.text)
      return
    }
    const generation = this.subscriptionGeneration
    try {
      const client = await this.getClient()
      if (msg.type === 'listRewindPoints' && generation !== this.subscriptionGeneration) return
      this.replaceClient(client)
      switch (msg.type) {
        case 'ready':
        case 'listSessions': {
          const sessions = await client.listSessions({ includeArchived: msg.type === 'listSessions' && msg.includeArchived })
          this.post({ type: 'sessions', sessions, activeSessionId: this.activeSessionId })
          break
        }
        case 'createSession': {
          const rec = await client.createSession({
            cwd: this.workspaceCwd,
            prompt: msg.prompt,
            isolatedWorktree: msg.isolatedWorktree,
            model: msg.model,
            domain: msg.domain,
          })
          this.attachSession(rec.id)
          this.post({ type: 'sessionCreated', session: rec })
          break
        }
        case 'listCatalog': {
          const providers = await client.listProviders().catch(() => ({ providers: [] as Awaited<ReturnType<SidecarClient['listProviders']>>['providers'] }))
          const defModel = await client.getDefaultModelConfig().catch(() => ({ defaultModel: null }))
          const defDomain = await client.getDefaultDomainConfig().catch(() => ({
            defaultDomain: 'auto',
            domains: [] as { id: string; name: string; motto: string }[],
          }))
          const catalog = buildSessionCatalog(
            providers.providers ?? [],
            defModel.defaultModel,
            defDomain.defaultDomain,
            defDomain.domains ?? [],
          )
          this.post({ type: 'catalog', models: catalog.models, domains: catalog.domains })
          break
        }
        case 'archiveSession': {
          await client.archiveSession(msg.sessionId)
          await this.refreshSessions(client, true)
          if (this.activeSessionId === msg.sessionId) this.closeActive()
          break
        }
        case 'unarchiveSession': {
          await client.unarchiveSession(msg.sessionId)
          await this.refreshSessions(client, true)
          break
        }
        case 'renameSession': {
          await client.renameSession(msg.sessionId, msg.title)
          await this.refreshSessions(client, true)
          break
        }
        case 'deleteSession': {
          await client.deleteSessionPermanent(msg.sessionId)
          await this.refreshSessions(client, true)
          if (this.activeSessionId === msg.sessionId) this.closeActive()
          break
        }
        case 'searchSessions': {
          try {
            const results = await client.searchSessions(msg.q)
            this.post({ type: 'searchHits', reqId: msg.reqId, results })
          } catch {
            this.post({ type: 'searchHits', reqId: msg.reqId, results: [] })
          }
          break
        }
        case 'getSettings': {
          try {
            const [approval, checkpoint, defModel, defDomain, providers] = await Promise.all([
              client.getApprovalConfig(),
              client.getCheckpointConfig(),
              client.getDefaultModelConfig().catch(() => ({ defaultModel: null })),
              client.getDefaultDomainConfig().catch(() => ({
                defaultDomain: 'auto',
                domains: [] as { id: string; name: string; motto: string }[],
              })),
              client.listProviders().catch(() => ({ providers: [] as Awaited<ReturnType<SidecarClient['listProviders']>>['providers'] })),
            ])
            const catalog = buildSessionCatalog(
              providers.providers ?? [],
              defModel.defaultModel,
              defDomain.defaultDomain,
              defDomain.domains ?? [],
            )
            this.post({
              type: 'settings',
              approval: approval.approval,
              checkpointEveryTurns: checkpoint.checkpointEveryTurns,
              defaultModel: defModel.defaultModel,
              defaultDomain: defDomain.defaultDomain,
              models: catalog.models,
              domains: catalog.domains,
            })
          } catch {
            this.post({ type: 'error', message: '旧内核无设置路由' })
          }
          break
        }
        case 'saveApproval': {
          try {
            await client.setApprovalConfig(msg.approval)
            this.post({ type: 'settingsSaveResult', ok: true })
          } catch (err) {
            this.post({ type: 'settingsSaveResult', ok: false, message: (err as Error).message })
          }
          break
        }
        case 'saveCheckpoint': {
          try {
            await client.setCheckpointConfig(msg.checkpointEveryTurns)
            this.post({ type: 'settingsSaveResult', ok: true })
          } catch (err) {
            this.post({ type: 'settingsSaveResult', ok: false, message: (err as Error).message })
          }
          break
        }
        case 'saveDefaultModel': {
          try {
            await client.setDefaultModelConfig(msg.defaultModel)
            this.post({ type: 'settingsSaveResult', ok: true })
          } catch (err) {
            this.post({ type: 'settingsSaveResult', ok: false, message: (err as Error).message })
          }
          break
        }
        case 'saveDefaultDomain': {
          try {
            await client.setDefaultDomainConfig(msg.defaultDomain)
            this.post({ type: 'settingsSaveResult', ok: true })
          } catch (err) {
            this.post({ type: 'settingsSaveResult', ok: false, message: (err as Error).message })
          }
          break
        }
        case 'setEffort':
          await client.setEffort(msg.sessionId, msg.effort)
          break
        case 'selectSession':
          this.attachSession(msg.sessionId)
          break
        case 'prompt':
          await client.prompt(msg.sessionId, msg.text, msg.images)
          break
        case 'handoff':
          await client.handoff(msg.sessionId, msg.note)
          break
        case 'steer': {
          // 提交瞬间 run 恰好收束 → server 409 返回 'idle'，回退 prompt 开新
          // turn（桌面端同款回退），用户输入不丢、不弹错误条。
          const r = await client.steer(msg.sessionId, msg.text)
          if (r === 'idle') await client.prompt(msg.sessionId, msg.text)
          break
        }
        case 'abort':
          await client.abort(msg.sessionId)
          break
        case 'resume':
          await client.resume(msg.sessionId)
          break
        case 'approval':
          await client.answerApproval(msg.sessionId, msg.requestId, {
            decision: msg.decision,
            ...(msg.editedInput ? { editedInput: msg.editedInput } : {}),
            ...(msg.remember ? { remember: true } : {}),
          })
          break
        case 'setApprovalMode':
          await client.setApprovalMode(msg.sessionId, msg.mode)
          break
        case 'listPickers': {
          const [models, domains] = await Promise.all([
            client.listModels(msg.sessionId),
            client.listDomains(msg.sessionId),
          ])
          this.post({ type: 'pickers', sessionId: msg.sessionId, models, domains })
          break
        }
        case 'switchModel':
          await client.switchModel(msg.sessionId, msg.modelId)
          break
        case 'setDomain':
          await client.setDomain(msg.sessionId, msg.key)
          break
        case 'queryFiles': {
          const files = await client.listFiles(msg.sessionId, msg.q)
          this.post({ type: 'files', reqId: msg.reqId, files })
          break
        }
        case 'openFile': {
          await this.openWorkspaceFile(msg.path, msg.line)
          break
        }
        case 'listProviders': {
          // 旧内核可能无 /config 路由——失败回 null，webview 不弹错误、不挡对话
          try {
            const config = await client.listProviders()
            this.post({ type: 'providers', config })
          } catch {
            this.post({ type: 'providers', config: null })
          }
          break
        }
        case 'setupProvider': {
          // key 只在此桥内经手一次，不回发 webview、不落宿主状态。
          try {
            if (msg.custom) {
              if (!msg.baseUrl || !msg.modelId) throw new Error('自定义端点需要 baseUrl 和模型 ID')
              await client.setupCustomProvider({
                providerName: msg.providerName,
                baseUrl: msg.baseUrl,
                ...(msg.apiKey ? { apiKey: msg.apiKey } : {}),
                makeDefault: true,
                model: { id: msg.modelId },
              })
            } else {
              await client.setupProvider({
                providerName: msg.providerName,
                apiKey: msg.apiKey,
                makeDefault: true,
              })
            }
            // 保存后复核生效（sidecar 侧写盘 + 重读有时序），再放行座舱
            const config = await client.listProviders()
            this.post({ type: 'providerSetupResult', ok: true })
            this.post({ type: 'providers', config })
          } catch (err) {
            this.post({ type: 'providerSetupResult', ok: false, message: (err as Error).message })
          }
          break
        }
        case 'readPlan': {
          const plan = await client.readPlan(msg.sessionId, msg.slug)
          this.post({ type: 'plan', sessionId: msg.sessionId, plan, revision: msg.revision })
          break
        }
        case 'planDecision': {
          try {
            if (msg.decision === 'approve') await client.approvePlan(msg.sessionId, msg.slug, msg.selectedApproach)
            else await client.rejectPlan(msg.sessionId, msg.slug, msg.comment)
            this.post({ type: 'planDecisionResult', sessionId: msg.sessionId, slug: msg.slug, decision: msg.decision, ok: true, revision: msg.revision })
          } catch (err) {
            this.post({ type: 'planDecisionResult', sessionId: msg.sessionId, slug: msg.slug, decision: msg.decision, ok: false, message: (err as Error).message, revision: msg.revision })
          }
          break
        }
        case 'editPlan': {
          try {
            await client.editPlan(msg.sessionId, msg.slug, msg.content)
            const plan = await client.readPlan(msg.sessionId, msg.slug)
            this.post({ type: 'plan', sessionId: msg.sessionId, plan, revision: msg.revision })
            this.post({ type: 'planEditResult', sessionId: msg.sessionId, slug: msg.slug, ok: true, revision: msg.revision })
          } catch (err) {
            this.post({ type: 'planEditResult', sessionId: msg.sessionId, slug: msg.slug, ok: false, message: (err as Error).message, revision: msg.revision })
          }
          break
        }
        case 'setPlanMode':
          await client.setPlanMode(msg.sessionId, msg.state)
          break
        case 'setAskMode':
          await client.setAskMode(msg.sessionId, msg.state)
          break
        case 'queue': {
          const r = await client.queue(msg.sessionId, msg.text)
          if (r === 'idle') await client.prompt(msg.sessionId, msg.text)
          break
        }
        case 'retractQueued': {
          const ok = await client.retractQueued(msg.sessionId, msg.laneId)
          this.post({ type: 'retractResult', sessionId: msg.sessionId, laneId: msg.laneId, ok, text: msg.text })
          break
        }
        case 'steerLane': {
          const r = await client.steer(msg.sessionId, { laneId: msg.laneId })
          if (r === 'idle') {
            const ok = await client.retractQueued(msg.sessionId, msg.laneId)
            if (ok) await client.prompt(msg.sessionId, msg.text)
          }
          break
        }
        case 'loadEarlier': {
          try {
            const page = await client.getHistoryPage(msg.sessionId, msg.before)
            this.post({
              type: 'earlierEvents',
              sessionId: msg.sessionId,
              events: page.events,
              firstSeq: page.firstSeq,
            })
          } catch (err) {
            this.post({ type: 'earlierEvents', sessionId: msg.sessionId, events: [], firstSeq: msg.before, error: (err as Error).message })
          }
          break
        }
        case 'listRewindPoints':
          await this.pushRewindPoints(client, msg.sessionId, generation)
          break
        case 'rewind': {
          try {
            await client.rewind(msg.sessionId, msg.messageIndex, msg.rollbackFiles)
            await this.pushRewindPoints(client, msg.sessionId, generation)
          } catch (err) {
            this.post({ type: 'error', message: (err as Error).message })
          }
          break
        }
        case 'getCockpit': {
          // 旧内核无此路由——失败回 null，webview 静默隐藏统计条（同 listProviders 容错）
          try {
            const snapshot = await client.getCockpit(msg.sessionId)
            this.post({ type: 'cockpit', sessionId: msg.sessionId, snapshot })
          } catch {
            this.post({ type: 'cockpit', sessionId: msg.sessionId, snapshot: null })
          }
          break
        }
      }
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message })
    }
  }

  private async refreshSessions(client: SidecarClient, includeArchived: boolean): Promise<void> {
    const sessions = await client.listSessions({ includeArchived })
    this.post({ type: 'sessions', sessions, activeSessionId: this.activeSessionId })
  }

  private closeActive(): void {
    this.teardownBridge()
    this.activeSessionId = undefined
    this.post({ type: 'sessionClosed' })
  }

  /** 切换活跃会话：撤旧订阅 → since=0 全量重放（历史即事件流）。 */
  private attachSession(sessionId: string): void {
    if (!this.client) return
    this.teardownBridge()
    const generation = this.subscriptionGeneration
    this.activeSessionId = sessionId
    this.post({ type: 'sessionAttached', sessionId })
    this.onSessionActivity?.('attach', sessionId)
    this.unsubscribe = this.client.subscribe(
      sessionId,
      0,
      (ev: SessionEvent) => {
        if (generation !== this.subscriptionGeneration || this.activeSessionId !== sessionId) return
        this.post({ type: 'event', sessionId, event: ev })
        this.onSessionEvent?.(ev)
        // 工具落盘 / turn 收束才可能改文件——只在这些点发活动信号
        if (ev.type === 'tool_result' || ev.type === 'turn_complete' || ev.type === 'status' || ev.type === 'rewind') {
          this.onSessionActivity?.('activity', sessionId)
        }
      },
      (live: boolean) => {
        if (generation !== this.subscriptionGeneration || this.activeSessionId !== sessionId) return
        this.post({ type: 'streamState', sessionId, live })
      },
    )
    void this.pushRewindPoints(this.client, sessionId)
  }

  private async pushRewindPoints(client: SidecarClient, sessionId: string, generation = this.subscriptionGeneration): Promise<void> {
    if (generation !== this.subscriptionGeneration || this.activeSessionId !== sessionId || this.client !== client) return
    const request = ++this.rewindRequestGeneration
    const current = () => generation === this.subscriptionGeneration && request === this.rewindRequestGeneration &&
      this.activeSessionId === sessionId && this.client === client
    try {
      const { points } = await client.listRewindPoints(sessionId)
      if (current()) this.post({ type: 'rewindPoints', sessionId, points })
    } catch {
      if (current()) this.post({ type: 'rewindPoints', sessionId, points: [] })
    }
  }

  notifySidecarState(state: 'starting' | 'ready' | 'dead', detail?: string): void {
    this.post({ type: 'sidecarState', state, detail })
  }

  replaceClient(client: SidecarClient): void {
    if (this.client === client) return
    this.client = client
    if (this.activeSessionId && this.panel) this.attachSession(this.activeSessionId)
    else this.teardownBridge()
  }

  /** 编辑器右键「发送到天枢」→ 座舱输入框追加文本。 */
  insertToComposer(text: string): void {
    this.post({ type: 'insertText', text })
  }

  /**
   * Ctrl+K / 行内编辑：直接对活跃会话发 prompt（无活跃会话则新建）。
   * 编辑经 E4 apply_edit 通路自然出原生 diff。
   */
  async submitPrompt(text: string): Promise<void> {
    try {
      const client = await this.getClient()
      this.replaceClient(client)
      if (!this.activeSessionId) {
        const rec = await client.createSession({ cwd: this.workspaceCwd, prompt: text })
        this.attachSession(rec.id)
        this.post({ type: 'sessionCreated', session: rec })
        return
      }
      await client.prompt(this.activeSessionId, text)
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message })
    }
  }

  /** 工具卡/提及里的相对路径 → 编辑器打开（限工作区内，路径逃逸直接拒绝）。 */
  private async openWorkspaceFile(relPath: string, line?: number): Promise<void> {
    const root = this.workspaceCwd
    if (!root || relPath.includes('..')) return
    const uri = vscode.Uri.file(`${root}/${relPath}`)
    try {
      const doc = await vscode.workspace.openTextDocument(uri)
      const editor = await vscode.window.showTextDocument(doc, { preview: true })
      if (line && line > 0) {
        const pos = new vscode.Position(line - 1, 0)
        editor.selection = new vscode.Selection(pos, pos)
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
      }
    } catch {
      // 文件不存在（可能已删除/是目录）——静默忽略
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'))
    const nonce = Math.random().toString(36).slice(2)
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>天枢座舱</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}
