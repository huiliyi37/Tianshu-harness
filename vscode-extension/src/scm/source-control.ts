/**
 * 天枢 SCM provider（L2-5）— 会话变更以原生源代码管理资源呈现。
 *
 * - createSourceControl('tianshu','天枢') 注册独立 provider：SCM 面板与 git
 *   分区并存；scmProvider 上下文键 = 'tianshu'，scm/title 菜单据此绑定
 *   （刷新/回滚两项，见 package.json 贡献点）。
 * - 资源 command 复用 tianshu.openDiff（与 Explorer 树同一通路：tianshu-base
 *   左栏 ↔ 活文件右栏的原生双栏 diff）。
 * - 数据源与 changes-view 相同：GET git/working-tree（相对任务基线，中途
 *   commit 仍可见）；刷新去抖 800ms 与树同参数，由同一会话活动信号驱动。
 * - 资源级不做接受/拒绝回退（非目标）——会话级 rollback 在标题栏菜单。
 *
 * 本模块只在扩展宿主运行（esbuild 打包），不做 node --test 直载——vscode
 * 依赖与参数属性不受测试加载约束。
 */
import * as vscode from 'vscode'
import type { SidecarClient } from '../sidecar/client.js'
import type { WorkingTreeFile } from '../sidecar/protocol.js'
import { mapWorkingTreeFile } from './change-mapping.js'

export class TianshuSourceControl implements vscode.Disposable {
  private readonly sourceControl: vscode.SourceControl
  private readonly group: vscode.SourceControlResourceGroup
  private sessionId: string | undefined
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private refreshGeneration = 0

  constructor(
    private readonly getClient: () => Promise<SidecarClient>,
    private readonly workspaceCwd: string,
  ) {
    this.sourceControl = vscode.scm.createSourceControl(
      'tianshu',
      '天枢',
      workspaceCwd ? vscode.Uri.file(workspaceCwd) : undefined,
    )
    this.group = this.sourceControl.createResourceGroup('session-changes', '会话变更')
    // 天枢无提交语义——隐藏 provider 默认的（空）输入框，去掉视觉噪音
    this.sourceControl.inputBox.visible = false
  }

  /** 座舱切会话时调用；资源列表跟随活跃会话（与树 setSession 同拍）。 */
  setSession(sessionId: string | undefined): void {
    if (this.sessionId !== sessionId) this.group.resourceStates = []
    this.refreshGeneration++
    this.sessionId = sessionId
    this.scheduleRefresh()
  }

  /** 工具执行/turn 完成等活动信号 → 去抖刷新（与 changes-view 同参数 800ms）。 */
  scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => void this.refresh(), 800)
  }

  async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration
    const sessionId = this.sessionId
    if (!sessionId) {
      this.group.resourceStates = []
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
    // 会话已切换或已有更新的刷新 → 丢弃陈旧结果。
    if (generation !== this.refreshGeneration) return
    this.group.resourceStates = files.map((file) => this.toResource(sessionId, file))
  }

  private toResource(sessionId: string, file: WorkingTreeFile): vscode.SourceControlResourceState {
    const mapped = mapWorkingTreeFile(file)
    return {
      resourceUri: vscode.Uri.file(`${this.workspaceCwd}/${file.path}`),
      command: {
        command: 'tianshu.openDiff',
        title: '打开 diff',
        arguments: [sessionId, file],
      },
      decorations: {
        iconPath: new vscode.ThemeIcon(mapped.iconId),
        tooltip: mapped.tooltip,
      },
      contextValue: mapped.contextValue,
    }
  }

  dispose(): void {
    this.refreshGeneration++
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
    this.sourceControl.dispose()
  }
}
