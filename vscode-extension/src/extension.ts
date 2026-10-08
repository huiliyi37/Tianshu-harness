/**
 * 天枢 VS Code / Cursor 扩展入口。
 *
 * 职责边界（计划 §7「不做的事」）：插件内不实现任何 agent 逻辑，一切智能在
 * sidecar 内核；本文件只做 sidecar 生命周期 + 座舱视图装配。
 */
import * as vscode from 'vscode'
import { join } from 'node:path'
import { launchSidecar, SidecarLaunchError, type SidecarHandle } from './sidecar/launcher.js'
import { SidecarClient } from './sidecar/client.js'
import { CockpitProvider } from './views/cockpit-provider.js'
import { registerChangesView } from './views/changes-view.js'
import { registerLauncherView } from './views/launcher-view.js'
import { DelegationExecutor } from './delegation/executor.js'
import { StatusBarController } from './views/status-bar.js'
import { registerCommitMessageCommand } from './scm/commit-message.js'
import { TianshuSourceControl } from './scm/source-control.js'
import { ensureRuntime, rivetOnPath } from './sidecar/runtime-downloader.js'
import { TianshuChatParticipant } from './chat/participant.js'
import { ChatHumanInteraction } from './chat/human-interaction.js'
import { estimateTokens, mapProviderModels, tianshuModelInfo, TIANSHU_VENDOR, UNAVAILABLE_NOTE } from './chat/model-provider.js'

let sidecar: SidecarHandle | undefined
let clientPromise: Promise<SidecarClient> | undefined
/** sidecar 就绪后的客户端（模型目录的数据源；不触发启动，dispose 时清空）。 */
let liveClient: SidecarClient | undefined
/** 模型目录变化通道：sidecar 就绪/重启后 fire，chat 重新拉取模型列表。 */
let modelInfoChannel: vscode.EventEmitter<void> | undefined
let cliPathPromise: Promise<string> | undefined
let launchController: AbortController | undefined
let pendingLaunch: Promise<SidecarHandle> | undefined
let cleanupPromise: Promise<void> = Promise.resolve()
let output: vscode.OutputChannel | undefined
let delegation: DelegationExecutor | undefined
let statusBar: StatusBarController | undefined
let globalStorageDir = ''
/**
 * 插件 sidecar 的会话库根（P0-3）。绝不落在桌面端的 `~/.rivet/desktop`：
 * 那边 sidecar 启动时的 rehydrate 会把桌面端正在跑的会话标成假中断，且两边
 * 会争用同一份 sidecar.lock。行为变化：插件里建的会话不再出现在桌面端列表，
 * 插件 sidecar 也不再参与桌面端的定时任务。
 */
let sidecarDataDir = ''
/** 崩溃自动重拉：连续尝试计数（进程稳定运行超过窗口即清零）。 */
let restartAttempts = 0
let restartTimer: ReturnType<typeof setTimeout> | undefined
let sidecarGeneration = 0

const MAX_RESTART_ATTEMPTS = 3
/** 进程存活超过此时长视为「曾经健康」，重拉计数清零（防 crash-loop 计数永不归零）。 */
const STABLE_UPTIME_MS = 60_000

/**
 * 解析插件 sidecar 的会话库根（P0-3）。
 *
 * 有文件夹的窗口用 `context.storageUri` 下的 sidecar-data——由编辑器按工作区管理，
 * 随窗口重载保持（不会每次重载都换一个空库）。storageUri 缺席（无文件夹窗口/未
 * 落盘的工作区）时退回 globalStorageUri 下按扩展宿主进程号区分的目录，保证同机
 * 多窗口各自一份，不互相抢锁。
 */
function resolveSidecarDataDir(context: vscode.ExtensionContext): string {
  const workspaceStorage = context.storageUri?.fsPath
  if (workspaceStorage) return join(workspaceStorage, 'sidecar-data')
  return join(context.globalStorageUri.fsPath, `sidecar-data-${process.pid}`)
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('天枢 Sidecar')
  globalStorageDir = context.globalStorageUri.fsPath
  sidecarDataDir = resolveSidecarDataDir(context)

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!cwd) {
    // 无工作区不启动 sidecar；视图内提示用户打开文件夹。
    output.appendLine('[tianshu] no workspace folder — sidecar not started')
  }

  const provider: CockpitProvider = new CockpitProvider(
    context.extensionUri,
    (): Promise<SidecarClient> => ensureClient(provider, cwd),
    cwd ?? '',
  )

  // 会话变更双面呈现（L2-5）：Explorer 树 + 原生 SCM 资源，两者并存。
  // SCM 先建：刷新/回滚命令（注册在 changes-view）经 onRefresh 同时刷新 SCM 面。
  const scmChanges = new TianshuSourceControl(() => ensureClient(provider, cwd), cwd ?? '')
  context.subscriptions.push(scmChanges)
  const changesTree = registerChangesView(
    context,
    () => ensureClient(provider, cwd),
    cwd ?? '',
    () => void scmChanges.refresh(),
  )
  registerLauncherView(context)
  delegation = new DelegationExecutor(() => ensureClient(provider, cwd), cwd ?? '')
  delegation.register(context)
  statusBar = new StatusBarController()
  context.subscriptions.push(statusBar)
  registerCommitMessageCommand(context, resolveCliPath)

  // Chat 接入：默认 participant（不带 @ 直接路由）+ BYOK 模型注册——
  // 「聊天框里说话的是天枢」，而不是 Copilot 登录死路。审批/提问走原生对话框。
  const chatHuman = new ChatHumanInteraction(
    () => ensureClient(provider, cwd),
    (line) => output?.appendLine(line),
  )
  context.subscriptions.push(chatHuman)
  const chatParticipant = new TianshuChatParticipant(
    () => ensureClient(provider, cwd),
    (line) => output?.appendLine(line),
    chatHuman,
  )
  context.subscriptions.push(chatParticipant)
  // 模型目录通道：sidecar 就绪/重启后 fire，chat 重新拉取模型列表（见 ensureClient）。
  modelInfoChannel = new vscode.EventEmitter<void>()
  context.subscriptions.push(modelInfoChannel)
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(TIANSHU_VENDOR, {
    onDidChangeLanguageModelChatInformation: modelInfoChannel.event,
    // 真实目录：内核 provider 的模型（deepseek-v4-pro 等）；未就绪/无配置时保底占位。
    // 刻意用 liveClient 而非 ensureClient——查询模型列表不应触发内核启动。
    provideLanguageModelChatInformation: async () => {
      if (!liveClient) return [tianshuModelInfo()]
      try {
        const catalog = await liveClient.listProviders()
        const mapped = mapProviderModels(catalog)
        return mapped.length > 0 ? mapped : [tianshuModelInfo()]
      } catch {
        return [tianshuModelInfo()]
      }
    },
    provideLanguageModelChatResponse: (_model, _messages, _options, progress) => {
      // 故意不推理：真正的入口是 participant（见 chat/model-provider.ts）。
      progress.report(new vscode.LanguageModelTextPart(UNAVAILABLE_NOTE))
      return Promise.resolve()
    },
    provideTokenCount: (_model, input) => Promise.resolve(estimateTokens(
      typeof input === 'string'
        ? input
        : input.content.map((part) => {
          const value: unknown = (part as { value?: unknown }).value
          return typeof value === 'string' ? value : ''
        }).join(''),
    )),
  }))

  provider.onSessionActivity = (kind, sessionId) => {
    if (kind === 'attach') {
      changesTree.setSession(sessionId)
      scmChanges.setSession(sessionId)
      void delegation?.attachSession(sessionId)
    } else {
      changesTree.scheduleRefresh()
      scmChanges.scheduleRefresh()
    }
  }

  // 状态栏：会话 status → 运行指示；审批事件 → 待批计数
  let pendingApprovals = 0
  provider.onSessionEvent = (ev) => {
    if (ev.type === 'status') {
      statusBar?.setSessionStatus(String((ev.data as { status?: unknown }).status ?? ''))
    } else if (ev.type === 'approval_required') {
      statusBar?.setPendingApprovals(++pendingApprovals)
    } else if (ev.type === 'approval_resolved') {
      pendingApprovals = Math.max(0, pendingApprovals - 1)
      statusBar?.setPendingApprovals(pendingApprovals)
    } else if (ev.type === 'done') {
      pendingApprovals = 0
      statusBar?.setPendingApprovals(0)
      statusBar?.setSessionStatus('idle')
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('tianshu.openInEditor', () => {
      provider.openInEditor()
    }),
    vscode.commands.registerCommand('tianshu.newSession', () => {
      provider.openInEditor()
    }),
    vscode.commands.registerCommand('tianshu.restartSidecar', async () => {
      try {
        await disposeSidecar()
        await ensureClient(provider, cwd)
        void vscode.window.showInformationMessage('天枢内核已重启')
      } catch (err) {
        if (err instanceof SidecarLaunchError && err.reason === 'cleanup-failed') {
          provider.notifySidecarState('dead', err.message)
          statusBar?.setSidecarState('dead', err.message)
        }
        void vscode.window.showErrorMessage(`天枢内核重启失败: ${(err as Error).message}`)
      }
    }),
    vscode.commands.registerCommand('tianshu.showSidecarLog', () => output?.show()),
    vscode.commands.registerCommand('tianshu.sendSelection', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor || !cwd) return
      const rel = vscode.workspace.asRelativePath(editor.document.uri, false)
      const sel = editor.selection
      const snippet = editor.document.getText(sel).trimEnd()
      const ref = sel.isEmpty
        ? `@file:${rel}`
        : `@file:${rel} (L${sel.start.line + 1}-L${sel.end.line + 1})\n\`\`\`\n${snippet}\n\`\`\``
      provider.openInEditor()
      // 视图可能刚被唤起，webview 尚在装配——短暂延迟后投递
      setTimeout(() => provider.insertToComposer(ref), 300)
    }),
    vscode.commands.registerCommand('tianshu.inlineEdit', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor || !cwd) {
        void vscode.window.showInformationMessage('请先打开工作区中的文件')
        return
      }
      const instruction = await vscode.window.showInputBox({
        prompt: '描述要对选区/文件做的修改',
        placeHolder: '例如：提取为独立函数并加单元测试',
      })
      if (!instruction?.trim()) return
      const rel = vscode.workspace.asRelativePath(editor.document.uri, false)
      const sel = editor.selection
      const prefix = sel.isEmpty
        ? `@file:${rel}`
        : `@file:${rel} (L${sel.start.line + 1}-L${sel.end.line + 1})`
      const text = `${prefix}\n${instruction.trim()}`
      provider.openInEditor()
      await provider.submitPrompt(text)
    }),
    { dispose: () => { void disposeSidecar().catch((err) => output?.appendLine((err as Error).message)) } },
  )
}

function resolveCliPath(): Promise<string> {
  if (!cliPathPromise) {
    const generation = sidecarGeneration
    cliPathPromise = (async () => {
      const cfg = vscode.workspace.getConfiguration('tianshu')
      let cliPath = cfg.get<string>('cliPath')?.trim() || undefined
      if (!cliPath && !(await rivetOnPath())) {
        output?.appendLine('[tianshu] rivet not on PATH — bootstrapping self-contained runtime')
        cliPath = await ensureRuntime(globalStorageDir)
        output?.appendLine(`[tianshu] runtime ready: ${cliPath}`)
      }
      return cliPath || 'rivet'
    })().catch((err) => {
      if (generation === sidecarGeneration) cliPathPromise = undefined
      throw err
    })
  }
  return cliPathPromise
}

async function ensureClient(provider: CockpitProvider, cwd: string | undefined): Promise<SidecarClient> {
  if (!cwd) throw new Error('请先打开一个工作区文件夹')
  if (!clientPromise) {
    const generation = sidecarGeneration
    clientPromise = (async () => {
      provider.notifySidecarState('starting')
      statusBar?.setSidecarState('starting')
      const cfg = vscode.workspace.getConfiguration('tianshu')
      try {
        const cliPath = await resolveCliPath()
        await cleanupPromise
        if (generation !== sidecarGeneration) throw new Error('sidecar 启动已取消')
        const controller = new AbortController()
        launchController = controller
        const launching = launchSidecar({
          cwd,
          cliPath,
          port: cfg.get<number>('serverPort') || 0,
          desktopDir: sidecarDataDir,
          onLog: (line) => output?.appendLine(line),
          signal: controller.signal,
        })
        pendingLaunch = launching
        const launched = await launching
        if (pendingLaunch === launching) {
          pendingLaunch = undefined
          launchController = undefined
        }
        if (generation !== sidecarGeneration) {
          await launched.dispose()
          throw new Error('sidecar 启动已取消')
        }
        sidecar = launched
      } catch (err) {
        if (generation !== sidecarGeneration) throw err
        pendingLaunch = undefined
        launchController = undefined
        clientPromise = undefined
        if (err instanceof SidecarLaunchError && err.reason === 'cli-not-found') {
          void vscode.window
            .showErrorMessage('未找到 rivet CLI（天枢内核）。', '安装说明', '打开设置')
            .then((pick) => {
              if (pick === '安装说明') void vscode.env.openExternal(vscode.Uri.parse('https://github.com/huiliyi37/Tianshu-Tui#install'))
              if (pick === '打开设置') void vscode.commands.executeCommand('workbench.action.openSettings', 'tianshu.cliPath')
            })
        }
        provider.notifySidecarState('dead', (err as Error).message)
        statusBar?.setSidecarState('dead', (err as Error).message)
        throw err
      }
      const startedAt = Date.now()
      const startedSidecar = sidecar
      startedSidecar.onExit((code) => {
        if (generation !== sidecarGeneration || sidecar !== startedSidecar) return
        output?.appendLine(`[tianshu] sidecar exited (code ${code})`)
        clientPromise = undefined
        sidecar = undefined
        // 稳定运行过一段时间的进程崩溃 → 视为新一轮故障，从头计数
        if (Date.now() - startedAt > STABLE_UPTIME_MS) restartAttempts = 0
        if (restartAttempts < MAX_RESTART_ATTEMPTS) {
          restartAttempts++
          const delay = 1000 * 3 ** (restartAttempts - 1) // 1s / 3s / 9s
          const msg = `内核重启中（第 ${restartAttempts}/${MAX_RESTART_ATTEMPTS} 次）…`
          output?.appendLine(`[tianshu] auto-restart in ${delay}ms (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})`)
          provider.notifySidecarState('starting', msg)
          statusBar?.setSidecarState('starting', msg)
          restartTimer = setTimeout(() => {
            restartTimer = undefined
            ensureClient(provider, cwd).catch(() => {
              // 启动失败已在 ensureClient 内落 dead 状态；等下一次退避或人工重启
            })
          }, delay)
          return
        }
        provider.notifySidecarState('dead', `内核进程退出（code ${code}），自动重启 ${MAX_RESTART_ATTEMPTS} 次未恢复`)
        statusBar?.setSidecarState('dead', `内核进程退出（code ${code}）`)
      })
      liveClient = new SidecarClient(startedSidecar.baseUrl, startedSidecar.token)
      provider.replaceClient(liveClient)
      provider.notifySidecarState('ready')
      statusBar?.setSidecarState('ready')
      modelInfoChannel?.fire()
      return liveClient
    })()
  }
  return clientPromise
}

function disposeSidecar(): Promise<void> {
  sidecarGeneration++
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = undefined
  }
  restartAttempts = 0
  launchController?.abort()
  const launching = pendingLaunch
  launchController = undefined
  pendingLaunch = undefined
  delegation?.detach()
  const stopping = sidecar?.dispose()
  sidecar = undefined
  clientPromise = undefined
  liveClient = undefined
  cliPathPromise = undefined
  cleanupPromise = Promise.all([
    cleanupPromise,
    stopping,
    launching?.then((handle) => handle.dispose(), (err) => {
      if (err instanceof SidecarLaunchError && err.reason === 'cleanup-failed') throw err
    }),
  ]).then(() => {})
  return cleanupPromise
}

export function deactivate(): Promise<void> {
  return disposeSidecar()
}
