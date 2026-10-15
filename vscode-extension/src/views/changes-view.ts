/**
 * 变更审查视图（P1）— Cline 路线的"事后审查"面：
 *
 * - TreeView 列出活跃会话相对任务基线（baselineHead）的工作树变更，
 *   数据全部来自 sidecar（GET git/working-tree），插件不带 git plumbing。
 * - 点击文件 → VS Code 原生双栏 diff：左侧是基线快照（本文件的
 *   TextDocumentContentProvider 按需拉 GET git/file-base），右侧是活文件。
 * - 回滚走 server 的 R3 双步协议（preview 确认 token → POST rollback），
 *   跨会话文件归属、不可逆 bash 副作用等护栏都在 server 侧，这里只做确认 UI。
 */
import * as vscode from 'vscode'
import type { SidecarClient } from '../sidecar/client.js'
import type { WorkingTreeFile } from '../sidecar/protocol.js'
import { STATUS_LABEL } from '../scm/change-mapping.js'

export const BASE_SCHEME = 'tianshu-base'

/** 基线快照内容源：URI = tianshu-base:/<relPath>?session=<id>。 */
export class BaseContentProvider implements vscode.TextDocumentContentProvider {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this.changeEmitter.event

  constructor(private readonly getClient: () => Promise<SidecarClient>) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query)
    if (params.get('empty') === '1') return '' // 已删除文件 diff 的右栏
    const sessionId = params.get('session')
    if (!sessionId) return ''
    const relPath = uri.path.replace(/^\//, '')
    try {
      const client = await this.getClient()
      const base = await client.fileAtBase(sessionId, relPath)
      return base.exists ? base.content : ''
    } catch {
      return ''
    }
  }
}

class ChangeItem extends vscode.TreeItem {
  constructor(file: WorkingTreeFile, sessionId: string, workspaceCwd: string) {
    super(file.path, vscode.TreeItemCollapsibleState.None)
    this.description = `${STATUS_LABEL[file.status]}  +${file.additions} −${file.deletions}`
    this.tooltip = `${file.path} (${file.status})`
    this.resourceUri = vscode.Uri.file(`${workspaceCwd}/${file.path}`)
    this.command = {
      command: 'tianshu.openDiff',
      title: '打开 diff',
      arguments: [sessionId, file],
    }
  }
}

export class ChangesTreeProvider implements vscode.TreeDataProvider<ChangeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.changeEmitter.event

  private sessionId: string | undefined
  private files: WorkingTreeFile[] = []
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private refreshGeneration = 0

  constructor(
    private readonly getClient: () => Promise<SidecarClient>,
    private readonly workspaceCwd: string,
  ) {}

  /** 座舱切会话时调用；变更列表跟随活跃会话。 */
  setSession(sessionId: string | undefined): void {
    if (this.sessionId !== sessionId) {
      this.files = []
      this.changeEmitter.fire()
    }
    this.refreshGeneration++
    this.sessionId = sessionId
    this.scheduleRefresh()
  }

  getSessionId(): string | undefined {
    return this.sessionId
  }

  /** 工具执行/turn 完成等活动信号 → 去抖刷新（避免每个 tool_result 拍一次 git）。 */
  scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => void this.refresh(), 800)
  }

  async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration
    const sessionId = this.sessionId
    if (!sessionId) {
      this.files = []
      this.changeEmitter.fire()
      return
    }
    let files: WorkingTreeFile[] = []
    try {
      const client = await this.getClient()
      const result = await client.sessionWorkingTree(sessionId)
      files = result.isRepo ? result.files : []
    } catch {
      files = []
    }
    if (generation !== this.refreshGeneration) return
    this.files = files
    this.changeEmitter.fire()
  }

  getTreeItem(element: ChangeItem): vscode.TreeItem {
    return element
  }

  getChildren(): ChangeItem[] {
    if (!this.sessionId) return []
    return this.files.map((f) => new ChangeItem(f, this.sessionId!, this.workspaceCwd))
  }
}

export function registerChangesView(
  context: vscode.ExtensionContext,
  getClient: () => Promise<SidecarClient>,
  workspaceCwd: string,
  /** L2-5：刷新命令/回滚完成后，通知其他变更面（SCM 资源）同步刷新。 */
  onRefresh?: () => void,
): ChangesTreeProvider {
  const tree = new ChangesTreeProvider(getClient, workspaceCwd)
  const baseProvider = new BaseContentProvider(getClient)

  context.subscriptions.push(
    vscode.window.createTreeView('tianshu.changes', { treeDataProvider: tree }),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, baseProvider),

    vscode.commands.registerCommand('tianshu.refreshChanges', () => {
      void tree.refresh()
      onRefresh?.()
    }),

    vscode.commands.registerCommand('tianshu.openDiff', async (sessionId: string, file: WorkingTreeFile) => {
      const baseUri = vscode.Uri.from({ scheme: BASE_SCHEME, path: `/${file.path}`, query: `session=${sessionId}` })
      const liveUri = vscode.Uri.file(`${workspaceCwd}/${file.path}`)
      if (file.status === 'deleted') {
        // 活侧不存在 → 右栏用空内容面（同 scheme，empty=1）
        const emptyUri = baseUri.with({ query: `session=${sessionId}&empty=1` })
        await vscode.commands.executeCommand('vscode.diff', baseUri, emptyUri, `${file.path}（已删除）`)
        return
      }
      await vscode.commands.executeCommand('vscode.diff', baseUri, liveUri, `${file.path}（基线 ↔ 工作区）`)
    }),

    vscode.commands.registerCommand('tianshu.rollback', async () => {
      const sessionId = tree.getSessionId()
      if (!sessionId) {
        void vscode.window.showInformationMessage('没有活跃的天枢会话')
        return
      }
      const client = await getClient()
      const preview = await client.rollbackPreview(sessionId)
      if (!preview.available || !preview.confirmationToken) {
        void vscode.window.showInformationMessage('没有可回滚的 checkpoint（或改动均为会话前已存在）')
        return
      }
      const pick = await vscode.window.showWarningMessage(
        `回滚本会话 agent 改动？\n\n${preview.text ?? ''}`,
        { modal: true },
        '确认回滚',
      )
      if (pick !== '确认回滚') return
      try {
        await client.rollback(sessionId, preview.confirmationToken)
        void vscode.window.showInformationMessage('已回滚到 checkpoint')
      } catch (err) {
        void vscode.window.showErrorMessage(`回滚失败: ${(err as Error).message}`)
      }
      void tree.refresh()
      onRefresh?.()
    }),
  )
  return tree
}
