import { useEffect, useMemo, useReducer, useRef, useState, useCallback, type DragEvent } from 'react'
import {
  onHostMessage,
  send,
  type CockpitSnapshot,
  type DomainEntry,
  type HostMsg,
  type ModelEntry,
  type PlanDocument,
  type ProviderConfigList,
  type RewindPoint,
  type SessionEvent,
  type SessionRecord,
} from './bridge.js'
import { renderMarkdown } from './markdown.js'
import { initialChatState, reduceEvent, type ChatState, type ChatItem, type QuestionSpec } from './model.js'
import { canLoadEarlier } from './history-window.js'
import { resolveRewindPoint } from './rewind-point.js'
import {
  detectSlashToken,
  EFFORT_LEVELS,
  filterSlashMenu,
  resolveComposerSlash,
  slashNeedsArgs,
  type EffortLevel,
  type LocalSlash,
} from './slash-local.js'
import { canAddImage, imageTooLarge, normalizeImageDataUrl } from './image-paste.js'
import { filterSessions, sessionLabel, splitSessionLists } from './session-list.js'
import { switchComposerDraft, type ComposerDraft } from './session-drafts.js'
import { parseCheckpointTurns, parseDefaultDomain, parseDefaultModel, wireApproval } from './settings-form.js'

type SidecarState = 'starting' | 'ready' | 'dead'

type ChatAction =
  | { type: 'event'; ev: SessionEvent }
  | { type: 'reset' }
  | { type: 'prepend'; items: ChatItem[]; floorSeq: number; diskFirstSeq: number }

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === 'reset') return initialChatState
  if (action.type === 'prepend') {
    return {
      ...state,
      items: [...action.items, ...state.items],
      historyFloorSeq: action.floorSeq,
      diskFirstSeq: action.diskFirstSeq,
      canLoadEarlier: canLoadEarlier(action.floorSeq, action.diskFirstSeq),
    }
  }
  return reduceEvent(state, action.ev)
}

let fileReqSeq = 0
let searchReqSeq = 0

type Panel = 'none' | 'sessions' | 'settings'

export function App() {
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [activeId, setActiveId] = useState<string | undefined>()
  const [sidecar, setSidecar] = useState<SidecarState>('starting')
  const [sidecarDetail, setSidecarDetail] = useState('')
  const [live, setLive] = useState(false)
  const [errorBanner, setErrorBanner] = useState('')
  const [noticeBanner, setNoticeBanner] = useState('')
  const pendingSlashRef = useRef<LocalSlash | null>(null)
  const pendingPromptRef = useRef<{ text: string; images?: string[] } | null>(null)
  const applyLocalRef = useRef<(sessionId: string, slash: LocalSlash) => void>(() => {})
  const askModeRef = useRef('off')

  applyLocalRef.current = (sessionId, slash) => {
    setErrorBanner('')
    if (slash.kind === 'approval') {
      send({ type: 'setApprovalMode', sessionId, mode: slash.mode })
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, approvalMode: slash.mode } : s)))
      setNoticeBanner(`已切换至${approvalLabel(slash.mode)}`)
      return
    }
    if (slash.kind === 'plan-mode') {
      send({ type: 'setPlanMode', sessionId, state: slash.state })
      setNoticeBanner(slash.state === 'planning' ? '已进入计划模式' : '已退出计划模式')
      return
    }
    if (slash.kind === 'resume') {
      send({ type: 'resume', sessionId })
      setNoticeBanner('正在续跑…')
      return
    }
    if (slash.kind === 'handoff') {
      send({ type: 'handoff', sessionId, note: slash.note })
      setNoticeBanner('已发起交接')
      return
    }
    if (slash.kind === 'effort') {
      send({ type: 'setEffort', sessionId, effort: slash.level })
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, reasoningEffort: slash.level } : s)))
      setNoticeBanner(`推理强度已设为 ${slash.level}`)
      return
    }
    if (slash.kind === 'ask-mode') {
      const next = slash.state === 'asking' && askModeRef.current === 'asking' ? 'off' : slash.state
      send({ type: 'setAskMode', sessionId, state: next })
      setNoticeBanner(next === 'asking' ? '已进入询问模式（只读问答）' : '已退出询问模式')
      return
    }
  }
  const [models, setModels] = useState<ModelEntry[]>([])
  const [domains, setDomains] = useState<DomainEntry[]>([])
  const [fileHits, setFileHits] = useState<string[]>([])
  const fileReqRef = useRef(0)
  const [chat, dispatch] = useReducer(chatReducer, initialChatState)
  const bottomRef = useRef<HTMLDivElement>(null)
  // undefined=探测中 / null=内核无 config 路由（不挡对话）/ list=已知配置面
  const [providerConfig, setProviderConfig] = useState<ProviderConfigList | null | undefined>(undefined)
  const [plans, setPlans] = useState<Record<string, PlanDocument>>({})
  const [planDecisions, setPlanDecisions] = useState<Record<string, string>>({})
  const [planRevisions, setPlanRevisions] = useState<Record<string, number>>({})
  const planRevisionsRef = useRef<Record<string, number>>({})
  // 座舱统计快照（null = 旧内核无 cockpit 路由，统计条隐藏）
  const [cockpit, setCockpit] = useState<CockpitSnapshot | null>(null)
  // SSE 曾经连上过（用于区分「首连中」与「断线重连中」）
  const everLiveRef = useRef(false)
  const [panel, setPanel] = useState<Panel>('none')
  const [sessionQuery, setSessionQuery] = useState('')
  const [sessionTab, setSessionTab] = useState<'active' | 'archived'>('active')
  const [isolatedWorktree, setIsolatedWorktree] = useState(false)
  const [renameId, setRenameId] = useState<string | undefined>()
  const [renameDraft, setRenameDraft] = useState('')
  const [searchHits, setSearchHits] = useState<{ sessionId: string; title: string; snippet: string }[]>([])
  const searchReqRef = useRef(0)
  const [settingsApproval, setSettingsApproval] = useState('auto-safe')
  const [settingsTurns, setSettingsTurns] = useState('0')
  const [settingsModel, setSettingsModel] = useState('')
  const [settingsDomain, setSettingsDomain] = useState('auto')
  const [settingsBusy, setSettingsBusy] = useState(false)
  const settingsPendingRef = useRef(0)
  const [catalogModels, setCatalogModels] = useState<ModelEntry[]>([])
  const [catalogDomains, setCatalogDomains] = useState<DomainEntry[]>([])
  const [draftModel, setDraftModel] = useState('')
  const [draftDomain, setDraftDomain] = useState('auto')
  const [historyBusy, setHistoryBusy] = useState(false)
  const [rewindPoints, setRewindPoints] = useState<RewindPoint[]>([])
  const [rewindSeq, setRewindSeq] = useState<number | null>(null)
  const [rewindFiles, setRewindFiles] = useState(false)
  const [rewindBusy, setRewindBusy] = useState(false)
  const [restoreDraft, setRestoreDraft] = useState<{ text: string; n: number; mode?: 'replace' | 'prepend' | 'append' } | undefined>()
  const restoreNRef = useRef(0)
  const activeIdRef = useRef<string | undefined>(undefined)
  activeIdRef.current = activeId
  askModeRef.current = chat.askMode

  useEffect(() => {
    const off = onHostMessage((msg: HostMsg) => {
      switch (msg.type) {
        case 'sessions':
          setSessions(msg.sessions)
          break
        case 'sessionCreated':
          setSessions((prev) => [msg.session, ...prev])
          activeIdRef.current = msg.session.id
          setActiveId(msg.session.id)
          send({ type: 'listPickers', sessionId: msg.session.id })
          {
            const slash = pendingSlashRef.current
            pendingSlashRef.current = null
            if (slash) applyLocalRef.current(msg.session.id, slash)
            const pending = pendingPromptRef.current
            pendingPromptRef.current = null
            if (pending) send({ type: 'prompt', sessionId: msg.session.id, text: pending.text, images: pending.images })
          }
          break
        case 'sessionAttached':
          activeIdRef.current = msg.sessionId
          setActiveId(msg.sessionId)
          dispatch({ type: 'reset' })
          everLiveRef.current = false
          setLive(false)
          setCockpit(null)
          setHistoryBusy(false)
          setRewindPoints([])
          setRewindSeq(null)
          setRewindBusy(false)
          setRestoreDraft(undefined)
          setPlans({})
          setPlanDecisions({})
          planRevisionsRef.current = {}
          setPlanRevisions({})
          send({ type: 'listPickers', sessionId: msg.sessionId })
          send({ type: 'getCockpit', sessionId: msg.sessionId })
          send({ type: 'listRewindPoints', sessionId: msg.sessionId })
          break
        case 'event':
          if (msg.sessionId !== activeIdRef.current) break
          if (msg.event.type === 'plan_submitted') {
            const slug = String(msg.event.data.slug ?? '')
            if (slug && msg.event.seq > (planRevisionsRef.current[slug] ?? -1)) {
              planRevisionsRef.current = { ...planRevisionsRef.current, [slug]: msg.event.seq }
              setPlanRevisions(planRevisionsRef.current)
              setPlans((prev) => { const next = { ...prev }; delete next[slug]; return next })
              setPlanDecisions((prev) => { const next = { ...prev }; delete next[slug]; return next })
            }
          }
          dispatch({ type: 'event', ev: msg.event })
          // turn 收束即刷新统计（占用/命中率/成本随 turn 变化）
          if (msg.event.type === 'turn_complete') send({ type: 'getCockpit', sessionId: msg.sessionId })
          if (msg.event.type === 'rewind') {
            const prompt = typeof msg.event.data.prompt === 'string' ? msg.event.data.prompt : ''
            restoreNRef.current += 1
            setRestoreDraft({ text: prompt, n: restoreNRef.current })
            setRewindSeq(null)
            setRewindBusy(false)
          }
          break
        case 'rewindPoints':
          if (msg.sessionId === activeIdRef.current) setRewindPoints(msg.points)
          break
        case 'retractResult':
          if (msg.sessionId !== activeIdRef.current || !msg.ok) break
          restoreNRef.current += 1
          setRestoreDraft({ text: msg.text, n: restoreNRef.current, mode: 'append' })
          break
        case 'streamState':
          if (msg.sessionId !== activeIdRef.current) break
          if (msg.live) everLiveRef.current = true
          setLive(msg.live)
          break
        case 'sidecarState':
          setSidecar(msg.state)
          setSidecarDetail(msg.detail ?? '')
          // 内核就绪即探测 provider 配置（首启无 key → Setup 卡）
          if (msg.state === 'ready') {
            send({ type: 'listProviders' })
            send({ type: 'listCatalog' })
          }
          break
        case 'pickers':
          if (msg.sessionId !== activeIdRef.current) break
          setModels(msg.models)
          setDomains(msg.domains)
          break
        case 'files':
          if (msg.reqId === fileReqRef.current) setFileHits(msg.files)
          break
        case 'error':
          setErrorBanner(msg.message)
          setRewindBusy(false)
          break
        case 'providers':
          setProviderConfig(msg.config)
          break
        case 'plan':
          if (msg.sessionId !== activeIdRef.current) break
          if (msg.revision !== undefined && msg.revision !== planRevisionsRef.current[msg.plan.slug]) break
          setPlans((prev) => ({ ...prev, [msg.plan.slug]: msg.plan }))
          break
        case 'planDecisionResult':
          if (msg.sessionId !== activeIdRef.current) break
          if (msg.revision !== undefined && msg.revision !== planRevisionsRef.current[msg.slug]) break
          if (msg.ok) {
            setPlanDecisions((prev) => ({ ...prev, [msg.slug]: msg.decision }))
          } else {
            setErrorBanner(msg.message ?? '计划操作失败')
          }
          break
        case 'cockpit':
          if (msg.sessionId !== activeIdRef.current) break
          setCockpit(msg.snapshot)
          break
        case 'sessionClosed':
          activeIdRef.current = undefined
          setActiveId(undefined)
          setLive(false)
          dispatch({ type: 'reset' })
          setCockpit(null)
          setRewindPoints([])
          setRewindSeq(null)
          setRewindBusy(false)
          setRestoreDraft(undefined)
          setPlans({})
          setPlanDecisions({})
          planRevisionsRef.current = {}
          setPlanRevisions({})
          break
        case 'settings':
          setSettingsApproval(wireApproval(msg.approval))
          setSettingsTurns(String(msg.checkpointEveryTurns ?? 0))
          if (msg.models) setCatalogModels(msg.models)
          if (msg.domains) setCatalogDomains(msg.domains)
          setSettingsModel(
            msg.defaultModel
            || msg.models?.find((m) => m.current)?.id
            || msg.models?.[0]?.id
            || '',
          )
          setSettingsDomain(msg.defaultDomain || msg.domains?.find((d) => d.current)?.key || 'auto')
          break
        case 'settingsSaveResult':
          settingsPendingRef.current = Math.max(0, settingsPendingRef.current - 1)
          if (!msg.ok) {
            settingsPendingRef.current = 0
            setSettingsBusy(false)
            setErrorBanner(msg.message ?? '保存失败')
          } else if (settingsPendingRef.current === 0) {
            setSettingsBusy(false)
            setNoticeBanner('设置已保存，新会话生效')
            if (settingsModel) setDraftModel(settingsModel)
            if (settingsDomain) setDraftDomain(settingsDomain)
            send({ type: 'listCatalog' })
          }
          break
        case 'searchHits':
          if (msg.reqId === searchReqRef.current) setSearchHits(msg.results)
          break
        case 'catalog':
          setCatalogModels(msg.models)
          setCatalogDomains(msg.domains)
          setDraftModel((prev) => prev || msg.models.find((m) => m.current)?.id || msg.models[0]?.id || '')
          setDraftDomain((prev) => (prev && prev !== 'auto' ? prev : msg.domains.find((d) => d.current)?.key || 'auto'))
          break
        case 'earlierEvents':
          if (msg.sessionId !== activeIdRef.current) break
          setHistoryBusy(false)
          if (msg.error) {
            setErrorBanner(msg.error)
            break
          }
          if (msg.events.length === 0) {
            dispatch({ type: 'prepend', items: [], floorSeq: 1, diskFirstSeq: 1 })
            break
          }
          {
            let prefix = initialChatState
            for (const ev of msg.events) prefix = reduceEvent(prefix, ev)
            dispatch({
              type: 'prepend',
              items: prefix.items,
              floorSeq: msg.events[0]!.seq,
              diskFirstSeq: msg.firstSeq,
            })
          }
          break
      }
    })
    send({ type: 'ready' })
    send({ type: 'listProviders' })
    send({ type: 'listCatalog' })
    return off
  }, [])

  // 新内容到达时贴底滚动（用户上滚查看历史时不打扰）。
  useEffect(() => {
    const el = bottomRef.current
    if (!el) return
    const scroller = el.parentElement
    if (!scroller) return
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
    if (nearBottom) el.scrollIntoView()
  }, [chat.items])

  // 统计条兜底轮询：空闲压缩等状态变化不产生事件，30s 拉一次快照补齐
  useEffect(() => {
    if (!activeId || sidecar !== 'ready') return
    const t = setInterval(() => send({ type: 'getCockpit', sessionId: activeId }), 30_000)
    return () => clearInterval(t)
  }, [activeId, sidecar])

  const askRewind = (seq: number) => {
    setRewindSeq(seq)
    setRewindFiles(false)
    if (activeId && rewindPoints.length === 0) send({ type: 'listRewindPoints', sessionId: activeId })
  }

  const confirmRewind = (seq: number) => {
    if (!activeId) return
    const point = resolveRewindPoint(chat.items, rewindPoints, seq)
    if (!point) {
      setErrorBanner('找不到回退点')
      if (rewindPoints.length === 0) send({ type: 'listRewindPoints', sessionId: activeId })
      return
    }
    setRewindBusy(true)
    setErrorBanner('')
    send({ type: 'rewind', sessionId: activeId, messageIndex: point.index, rollbackFiles: rewindFiles })
  }

  const running = chat.status === 'running'
  // 输入框历史召回（终端式 ↑/↓）的消息源：从 chat.items 过滤用户消息、最新在前。
  // 与桌面端 ThreadView 的 historyTexts 同一语义；回放的历史事件同样入列，
  // 所以 webview 重载/会话切换后仍可翻回早先发过的消息。
  const promptHistory = useMemo(() => {
    const out: string[] = []
    for (let i = chat.items.length - 1; i >= 0; i--) {
      const it = chat.items[i]!
      if (it.kind === 'user' && it.text) out.push(it.text)
    }
    return out
  }, [chat.items])
  // 有任何一个 provider 有可用 key 即视为已配置；null（旧内核）不挡对话
  const needsSetup =
    providerConfig !== undefined &&
    providerConfig !== null &&
    !providerConfig.providers.some((p) => p.keyStatus.source !== 'none')
  const reconnecting = sidecar === 'ready' && !!activeId && !live && everLiveRef.current

  const submit = useCallback(
    (text: string, images?: string[]) => {
      setErrorBanner('')
      setNoticeBanner('')
      const resolved = resolveComposerSlash(text)
      if (resolved.kind === 'blocked') {
        setErrorBanner(resolved.message)
        return
      }
      if (resolved.kind !== 'passthrough') {
        if (!activeId) {
          pendingSlashRef.current = resolved
          send({ type: 'createSession', isolatedWorktree, model: draftModel || undefined, domain: draftDomain || undefined })
          return
        }
        applyLocalRef.current(activeId, resolved)
        return
      }
      if (!activeId) {
        if (images && images.length > 0) {
          pendingPromptRef.current = { text, images }
          send({ type: 'createSession', isolatedWorktree, model: draftModel || undefined, domain: draftDomain || undefined })
          return
        }
        send({ type: 'createSession', prompt: text, isolatedWorktree, model: draftModel || undefined, domain: draftDomain || undefined })
        return
      }
      if (running && images?.length) {
        setErrorBanner('图片草稿已保留，请等当前任务结束后发送。')
        return
      }
      send({ type: running ? 'queue' : 'prompt', sessionId: activeId, text, images })
    },
    [activeId, running, isolatedWorktree, draftModel, draftDomain],
  )

  const queryFiles = useCallback(
    (q: string) => {
      if (!activeId) return
      const reqId = ++fileReqSeq
      fileReqRef.current = reqId
      send({ type: 'queryFiles', sessionId: activeId, q, reqId })
    },
    [activeId],
  )

  useEffect(() => {
    if (panel !== 'sessions') return
    const q = sessionQuery.trim()
    if (q.length < 2) {
      setSearchHits([])
      return
    }
    const reqId = ++searchReqSeq
    searchReqRef.current = reqId
    send({ type: 'searchSessions', q, reqId })
  }, [panel, sessionQuery])

  const currentSession = sessions.find((s) => s.id === activeId)
  const headerTitle = activeId ? sessionLabel(currentSession ?? { id: activeId }) : '新会话'

  const openPanel = (next: Panel) => {
    if (panel === next) {
      setPanel('none')
      return
    }
    setPanel(next)
    if (next === 'sessions') send({ type: 'listSessions', includeArchived: true })
    if (next === 'settings') {
      send({ type: 'getSettings' })
      send({ type: 'listProviders' })
    }
  }

  const saveSettings = () => {
    const parsed = parseCheckpointTurns(settingsTurns)
    if (!parsed.ok) {
      setErrorBanner(parsed.error)
      return
    }
    const known = catalogDomains.map((d) => d.key).filter((k) => k !== 'auto')
    const domain = parseDefaultDomain(settingsDomain || 'auto', known)
    if (!domain.ok) {
      setErrorBanner(domain.error)
      return
    }
    const skipModel = !settingsModel.trim() && catalogModels.length === 0
    let modelValue: string | undefined
    if (!skipModel) {
      const model = parseDefaultModel(settingsModel)
      if (!model.ok) {
        setErrorBanner(model.error)
        return
      }
      modelValue = model.value
    }
    setErrorBanner('')
    settingsPendingRef.current = skipModel ? 3 : 4
    setSettingsBusy(true)
    if (modelValue) setDraftModel(modelValue)
    setDraftDomain(domain.value)
    send({ type: 'saveApproval', approval: settingsApproval })
    send({ type: 'saveCheckpoint', checkpointEveryTurns: parsed.value })
    if (modelValue) send({ type: 'saveDefaultModel', defaultModel: modelValue })
    send({ type: 'saveDefaultDomain', defaultDomain: domain.value })
  }

  return (
    <div className="app">
      <Header
        title={headerTitle}
        panel={panel}
        live={live}
        sidecar={sidecar}
        onSessions={() => openPanel('sessions')}
        onSettings={() => openPanel('settings')}
        onNew={() => {
          const curM = catalogModels.find((m) => m.current)
          const curD = catalogDomains.find((d) => d.current)
          if (curM) setDraftModel(curM.id)
          if (curD) setDraftDomain(curD.key)
          setPanel('none')
          activeIdRef.current = undefined
          setActiveId(undefined)
          dispatch({ type: 'reset' })
          setCockpit(null)
          send({ type: 'listCatalog' })
        }}
      />
      {panel === 'none' && (
        <Toolbar
          sessionId={activeId}
          models={activeId ? models : catalogModels}
          domains={activeId ? domains : catalogDomains}
          draftModel={draftModel}
          draftDomain={draftDomain}
          planMode={chat.planMode}
          planDrafting={chat.planDrafting}
          askMode={chat.askMode}
          running={running}
          approvalMode={sessions.find((s) => s.id === activeId)?.approvalMode ?? 'manual'}
          effort={sessions.find((s) => s.id === activeId)?.reasoningEffort ?? 'auto'}
          onDraftModel={setDraftModel}
          onDraftDomain={setDraftDomain}
          onApprovalMode={(mode) => {
            if (!activeId) return
            send({ type: 'setApprovalMode', sessionId: activeId, mode })
            setSessions((prev) => prev.map((s) => (s.id === activeId ? { ...s, approvalMode: mode } : s)))
          }}
          onEffort={(level) => {
            if (!activeId) return
            send({ type: 'setEffort', sessionId: activeId, effort: level })
            setSessions((prev) => prev.map((s) => (s.id === activeId ? { ...s, reasoningEffort: level } : s)))
          }}
          onTogglePlanMode={() => {
            if (!activeId) return
            send({ type: 'setPlanMode', sessionId: activeId, state: chat.planMode === 'planning' ? 'off' : 'planning' })
          }}
          onToggleAskMode={() => {
            if (!activeId) return
            send({ type: 'setAskMode', sessionId: activeId, state: chat.askMode === 'asking' ? 'off' : 'asking' })
          }}
        />
      )}
      {panel === 'none' && activeId && cockpit && <StatsBar snapshot={cockpit} />}
      {sidecar === 'dead' && (
        <div className="banner error">内核不可用：{sidecarDetail || '进程已退出'}（命令面板 → 天枢: 重启内核）</div>
      )}
      {sidecar === 'starting' && sidecarDetail && <div className="banner">{sidecarDetail}</div>}
      {reconnecting && <div className="banner">连接断开，重连中…</div>}
      {errorBanner && <div className="banner error">{errorBanner}</div>}
      {noticeBanner && <div className="banner">{noticeBanner}</div>}
      {panel === 'none' && chat.phase && running && !chat.phase.startsWith('⚠') && (
        <div className="banner">{chat.phase}</div>
      )}
      {panel === 'sessions' && (
        <SessionPanel
          sessions={sessions}
          activeId={activeId}
          query={sessionQuery}
          tab={sessionTab}
          isolatedWorktree={isolatedWorktree}
          renameId={renameId}
          renameDraft={renameDraft}
          searchHits={searchHits}
          onQuery={setSessionQuery}
          onTab={setSessionTab}
          onIsolated={setIsolatedWorktree}
          onOpen={(id) => {
            setPanel('none')
            send({ type: 'selectSession', sessionId: id })
          }}
          onRenameStart={(id, title) => {
            setRenameId(id)
            setRenameDraft(title)
          }}
          onRenameDraft={setRenameDraft}
          onRenameCancel={() => {
            setRenameId(undefined)
            setRenameDraft('')
          }}
          onRenameCommit={() => {
            if (!renameId) return
            const title = renameDraft.trim()
            if (!title) return
            send({ type: 'renameSession', sessionId: renameId, title })
            setRenameId(undefined)
            setRenameDraft('')
          }}
          onArchive={(id) => send({ type: 'archiveSession', sessionId: id })}
          onUnarchive={(id) => send({ type: 'unarchiveSession', sessionId: id })}
          onDelete={(id) => {
            if (!window.confirm('永久删除该归档会话？无法恢复。')) return
            send({ type: 'deleteSession', sessionId: id })
          }}
        />
      )}
      {panel === 'settings' && (
        <SettingsPanel
          approval={settingsApproval}
          turns={settingsTurns}
          model={settingsModel}
          domain={settingsDomain}
          models={catalogModels}
          domains={catalogDomains}
          busy={settingsBusy}
          providerConfig={providerConfig}
          onApproval={setSettingsApproval}
          onTurns={setSettingsTurns}
          onModel={setSettingsModel}
          onDomain={setSettingsDomain}
          onSave={saveSettings}
        />
      )}
      {panel === 'none' && chat.todos.length > 0 && <TodoPanel todos={chat.todos} />}
      {panel === 'none' && (needsSetup ? (
        <SetupCard config={providerConfig} />
      ) : (
      <div className="messages">
        {chat.canLoadEarlier && activeId && (
          <button
            className="load-earlier"
            disabled={historyBusy}
            onClick={() => {
              if (!chat.historyFloorSeq) return
              setHistoryBusy(true)
              send({ type: 'loadEarlier', sessionId: activeId, before: chat.historyFloorSeq })
            }}
          >
            {historyBusy ? '加载中…' : '加载更早的历史'}
          </button>
        )}
        {chat.items.length === 0 && (
          <div className="empty">
            {activeId
              ? '（空会话）'
              : '先选上方模型和星域，再输入首条任务。会话与 CLI / 桌面共用 ~/.rivet。'}
          </div>
        )}
        {chat.items.map((item, i) => (
          <Item
            key={i}
            item={item}
            sessionId={activeId}
            running={running}
            streaming={running && i === chat.items.length - 1}
            plans={plans}
            planDecisions={planDecisions}
            planRevisions={planRevisions}
            onContinue={() => submit('continue')}
            onQuote={(quoted) => {
              restoreNRef.current += 1
              setRestoreDraft({ text: quoted, n: restoreNRef.current, mode: 'prepend' })
            }}
            rewind={
              item.kind === 'user' && activeId && !running
                ? {
                    open: rewindSeq === item.seq,
                    files: rewindFiles,
                    busy: rewindBusy,
                    onAsk: () => askRewind(item.seq),
                    onCancel: () => setRewindSeq(null),
                    onFiles: setRewindFiles,
                    onConfirm: () => confirmRewind(item.seq),
                  }
                : undefined
            }
          />
        ))}
        <div ref={bottomRef} />
      </div>
      ))}
      <Composer
        running={running}
        disabled={sidecar === 'dead' || needsSetup}
        fileHits={fileHits}
        onQueryFiles={queryFiles}
        onClearFiles={() => setFileHits([])}
        onSubmit={submit}
        onAbort={() => activeId && send({ type: 'abort', sessionId: activeId })}
        onResume={() => activeId && send({ type: 'resume', sessionId: activeId })}
        canResume={!!activeId && (chat.resumeOffer || chat.status === 'aborted' || chat.status === 'failed')}
        history={promptHistory}
        sessionKey={activeId}
        restoreDraft={restoreDraft}
      />
    </div>
  )
}

function Header(props: {
  title: string
  panel: Panel
  live: boolean
  sidecar: SidecarState
  onSessions: () => void
  onSettings: () => void
  onNew: () => void
}) {
  return (
    <div className="header">
      <span className="header-title" title={props.title}>{props.title}</span>
      <button className={props.panel === 'sessions' ? 'active' : ''} onClick={props.onSessions} title="会话列表">
        会话
      </button>
      <button className={props.panel === 'settings' ? 'active' : ''} onClick={props.onSettings} title="默认权限与检查点">
        设置
      </button>
      <button className="new-session" onClick={props.onNew} title="清空当前对话，用上方模型和星域开新会话">
        ＋ 新会话
      </button>
      <span className={`dot ${props.sidecar === 'ready' ? (props.live ? 'live' : 'idle') : 'dead'}`} title={`内核: ${props.sidecar}${props.live ? ' · 流已连接' : ''}`} />
    </div>
  )
}

function SessionPanel(props: {
  sessions: SessionRecord[]
  activeId?: string
  query: string
  tab: 'active' | 'archived'
  isolatedWorktree: boolean
  renameId?: string
  renameDraft: string
  searchHits: { sessionId: string; title: string; snippet: string }[]
  onQuery: (q: string) => void
  onTab: (tab: 'active' | 'archived') => void
  onIsolated: (v: boolean) => void
  onOpen: (id: string) => void
  onRenameStart: (id: string, title: string) => void
  onRenameDraft: (v: string) => void
  onRenameCancel: () => void
  onRenameCommit: () => void
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
  onDelete: (id: string) => void
}) {
  const filtered = filterSessions(props.sessions, props.query)
  const lists = splitSessionLists(filtered)
  const rows = props.tab === 'archived' ? lists.archived : lists.active
  const showHits = props.query.trim().length >= 2 && props.searchHits.length > 0

  return (
    <div className="drawer">
      <input
        className="drawer-search"
        value={props.query}
        onChange={(e) => props.onQuery(e.target.value)}
        placeholder="搜索标题或 id（≥2 字兼搜正文）"
      />
      <div className="session-tabs">
        <button className={props.tab === 'active' ? 'active' : ''} onClick={() => props.onTab('active')}>
          进行中 {lists.active.length}
        </button>
        <button className={props.tab === 'archived' ? 'active' : ''} onClick={() => props.onTab('archived')}>
          已归档 {lists.archived.length}
        </button>
      </div>
      <label className="session-flag">
        <input type="checkbox" checked={props.isolatedWorktree} onChange={(e) => props.onIsolated(e.target.checked)} />
        下一次新建用隔离 worktree
      </label>
      <div className="session-list">
        {rows.length === 0 && <div className="empty">没有匹配的会话</div>}
        {rows.map((s) => (
          <div key={s.id} className={`session-row ${s.id === props.activeId ? 'current' : ''}`}>
            {props.renameId === s.id ? (
              <div className="session-rename">
                <input
                  value={props.renameDraft}
                  onChange={(e) => props.onRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') props.onRenameCommit()
                    if (e.key === 'Escape') props.onRenameCancel()
                  }}
                  autoFocus
                />
                <button onClick={props.onRenameCommit}>确定</button>
                <button onClick={props.onRenameCancel}>取消</button>
              </div>
            ) : (
              <>
                <button className="session-open" onClick={() => props.onOpen(s.id)} title={s.id}>
                  {sessionLabel(s)}
                  {s.status === 'running' ? ' ⏵' : ''}
                </button>
                <div className="session-actions">
                  <button onClick={() => props.onRenameStart(s.id, s.title ?? '')}>改名</button>
                  {s.archived ? (
                    <>
                      <button onClick={() => props.onUnarchive(s.id)}>恢复</button>
                      <button onClick={() => props.onDelete(s.id)}>删除</button>
                    </>
                  ) : (
                    <button onClick={() => props.onArchive(s.id)}>归档</button>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      {showHits && (
        <div className="search-hits">
          <div className="search-hits-label">正文命中</div>
          {props.searchHits.map((h) => (
            <button key={h.sessionId + h.snippet} className="search-hit" onClick={() => props.onOpen(h.sessionId)}>
              <span className="search-hit-title">{h.title || h.sessionId.slice(0, 8)}</span>
              <span className="search-hit-snip">{h.snippet}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SettingsPanel(props: {
  approval: string
  turns: string
  model: string
  domain: string
  models: ModelEntry[]
  domains: DomainEntry[]
  busy: boolean
  providerConfig: ProviderConfigList | null | undefined
  onApproval: (v: string) => void
  onTurns: (v: string) => void
  onModel: (v: string) => void
  onDomain: (v: string) => void
  onSave: () => void
}) {
  return (
    <div className="drawer settings-drawer">
      <div className="settings-block">
        <h3>新会话默认权限</h3>
        <p>只影响之后新建的会话。当前会话用工具栏切换。</p>
        <MenuSelect
          value={props.approval}
          disabled={props.busy}
          title="新会话默认权限"
          options={APPROVAL_MODES.map((m) => ({ value: m.value, label: m.label, hint: m.hint }))}
          onChange={props.onApproval}
        />
      </div>
      <div className="settings-block">
        <h3>默认模型</h3>
        <p>写入配置，之后新建的会话用这个。工具栏草稿只影响当次。</p>
        <MenuSelect
          value={props.model}
          disabled={props.busy}
          title="新会话默认模型"
          placeholder={props.models.length === 0 ? '加载模型…' : '模型'}
          options={props.models.map((m) => ({
            value: m.id,
            label: `${m.alias || m.id}（${m.provider}）`,
          }))}
          onChange={props.onModel}
        />
      </div>
      <div className="settings-block">
        <h3>默认星域</h3>
        <p>auto 按任务选域。中途切星域会断前缀缓存。</p>
        <MenuSelect
          value={props.domain}
          disabled={props.busy}
          title="新会话默认星域"
          options={(props.domains.length > 0 ? props.domains : [{ key: 'auto', name: '自动', motto: '按任务选域' }]).map((d) => ({
            value: d.key,
            label: d.name,
            hint: d.motto,
          }))}
          onChange={props.onDomain}
        />
      </div>
      <div className="settings-block">
        <h3>自动档检查点</h3>
        <p>连续跑满 N 轮后暂停核对方向。0 = 关。</p>
        <input
          value={props.turns}
          onChange={(e) => props.onTurns(e.target.value)}
          disabled={props.busy}
          inputMode="numeric"
        />
      </div>
      <div className="settings-actions">
        <button onClick={props.onSave} disabled={props.busy}>
          {props.busy ? '保存中…' : '保存'}
        </button>
      </div>
      <div className="settings-block">
        <h3>提供商</h3>
        {props.providerConfig === undefined && <p>加载中…</p>}
        {props.providerConfig === null && <p>旧内核无配置路由。</p>}
        {props.providerConfig && (
          <>
            <ul className="provider-list">
              {props.providerConfig.providers.map((p) => (
                <li key={p.name}>
                  {p.label}
                  {p.isDefault ? ' · 默认' : ''}
                  {p.keyStatus.source === 'none' ? ' · 未配 key' : p.keyStatus.source === 'env' ? ' · 环境变量' : ' · 已写入'}
                </li>
              ))}
              {props.providerConfig.providers.length === 0 && <li>还没有已保存的提供商</li>}
            </ul>
            <SetupCard config={props.providerConfig} compact />
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 座舱统计条：上下文占用（按压缩态着色）+ 累计缓存命中率 + 会话成本。
 * 数据与桌面端驾驶舱 / TUI cockpit 同源（turn 收束即时刷新 + 30s 兜底轮询）。
 */
function StatsBar({ snapshot }: { snapshot: CockpitSnapshot }) {
  const ctx = snapshot.context
  const m = snapshot.model
  const pct = ctx && ctx.maxTokens > 0 ? Math.min(100, (ctx.estimatedTokens / ctx.maxTokens) * 100) : null
  const ctxTone =
    ctx?.compactionState === 'critical' ? 'critical'
      : ctx?.compactionState === 'compacting' ? 'compacting'
        : ctx?.compactionState === 'warning' ? 'warning'
          : 'healthy'
  const hit = Math.round(m.cacheHitRate * 100)
  return (
    <div className="statsbar">
      {ctx && pct !== null && (
        <span
          className={`ctx ${ctxTone}`}
          title={`上下文占用 ${fmtTokens(ctx.estimatedTokens)} / ${fmtTokens(ctx.maxTokens)}\n压缩态：${ctx.compactionState} · ${ctx.rounds} 轮`}
        >
          <span className="ctx-bar"><span className="ctx-fill" style={{ width: `${Math.max(2, pct)}%` }} /></span>
          {Math.round(pct)}%
        </span>
      )}
      <span
        className={`hit ${hit >= 80 ? 'good' : hit >= 50 ? 'mid' : 'low'}`}
        title={`前缀缓存命中率（累计）${hit}%${m.recentTurnHitRate !== null ? `；近 3 轮 ${Math.round(m.recentTurnHitRate * 100)}%` : ''}${m.cacheDiagnostic ? `\n${m.cacheDiagnostic}` : ''}`}
      >
        ⚡ {hit}%
      </span>
      <span
        className="cost"
        title={`本会话累计：输入 ${fmtTokens(m.inputTokens)}（缓存读 ${fmtTokens(m.cacheReadTokens)} · 新写 ${fmtTokens(m.cacheWriteTokens)}）· 输出 ${fmtTokens(m.outputTokens)}`}
      >
        {fmtCost(m.cost)}
      </span>
    </div>
  )
}

const APPROVAL_MODES: { value: string; label: string; hint: string }[] = [
  { value: 'manual', label: '监督', hint: '每个高风险工具都需确认' },
  { value: 'auto-safe', label: '自动', hint: '低/无风险自动执行，高风险仍需确认' },
  { value: 'dangerously-skip-permissions', label: '全自动', hint: '免审批执行；写沙箱仍开' },
]

function approvalLabel(mode: string): string {
  return APPROVAL_MODES.find((m) => m.value === mode)?.label ?? '自动'
}

function effortLabel(level: string): string {
  switch (level) {
    case 'off': return 'off 最省'
    case 'low': return 'low'
    case 'medium': return 'medium'
    case 'high': return 'high'
    case 'max': return 'max 最强'
    default: return 'auto 按任务'
  }
}

function MenuSelect(props: {
  value: string
  title?: string
  disabled?: boolean
  placeholder?: string
  options: { value: string; label: string; hint?: string }[]
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const current = props.options.find((o) => o.value === props.value)
  return (
    <div className={`menu-select ${open ? 'open' : ''}`} ref={boxRef} title={props.title}>
      <button
        type="button"
        disabled={props.disabled}
        onClick={() => {
          if (props.disabled) return
          if (props.options.length === 0) {
            send({ type: 'listCatalog' })
            return
          }
          setOpen((v) => !v)
        }}
      >
        <span>{current?.label || props.placeholder || '选择…'}</span>
        <span className="caret">▾</span>
      </button>
      {open && props.options.length > 0 && (
        <div className="menu-select-list" role="listbox">
          {props.options.map((o) => (
            <button
              type="button"
              key={o.value}
              className={o.value === props.value ? 'active' : ''}
              title={o.hint}
              onClick={() => {
                props.onChange(o.value)
                setOpen(false)
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Toolbar(props: {
  sessionId?: string
  models: ModelEntry[]
  domains: DomainEntry[]
  draftModel: string
  draftDomain: string
  planMode: string
  planDrafting: boolean
  askMode: string
  running: boolean
  approvalMode: string
  effort: string
  onDraftModel: (id: string) => void
  onDraftDomain: (key: string) => void
  onApprovalMode: (mode: string) => void
  onEffort: (level: EffortLevel) => void
  onTogglePlanMode: () => void
  onToggleAskMode: () => void
}) {
  const currentModel = props.sessionId
    ? props.models.find((m) => m.current)?.id ?? ''
    : props.draftModel
  const currentDomain = props.sessionId
    ? props.domains.find((d) => d.current)?.key ?? 'auto'
    : props.draftDomain
  return (
    <div className="toolbar">
      <MenuSelect
        value={currentModel}
        disabled={!!props.sessionId && props.running}
        title={props.sessionId ? '切换模型（仅空闲时；保留历史）' : '新会话使用的模型'}
        placeholder={props.models.length === 0 ? '加载模型…' : '模型'}
        options={props.models.map((m) => ({
          value: m.id,
          label: `${m.alias || m.id}（${m.provider}）`,
        }))}
        onChange={(id) => {
          if (!props.sessionId) {
            props.onDraftModel(id)
            return
          }
          send({ type: 'switchModel', sessionId: props.sessionId, modelId: id })
          send({ type: 'listPickers', sessionId: props.sessionId })
        }}
      />
      <MenuSelect
        value={currentDomain}
        title={props.sessionId ? '切换星域。⚠ 会话中途切换会使前缀缓存整体失效' : '新会话使用的星域'}
        placeholder={props.domains.length === 0 ? '加载星域…' : '星域'}
        options={(props.domains.length > 0 ? props.domains : [{ key: 'auto', name: '自动', motto: '按任务选域' }]).map((d) => ({
          value: d.key,
          label: d.name,
          hint: d.motto,
        }))}
        onChange={(key) => {
          if (!props.sessionId) {
            props.onDraftDomain(key)
            return
          }
          send({ type: 'setDomain', sessionId: props.sessionId, key })
          send({ type: 'listPickers', sessionId: props.sessionId })
        }}
      />
      {props.sessionId && (
        <>
          <MenuSelect
            value={APPROVAL_MODES.some((m) => m.value === props.approvalMode)
              ? props.approvalMode
              : props.approvalMode === 'auto-accept'
                ? 'auto-safe'
                : 'manual'}
            title="审批模式"
            options={APPROVAL_MODES.map((m) => ({ value: m.value, label: m.label, hint: m.hint }))}
            onChange={props.onApprovalMode}
          />
          <MenuSelect
            value={EFFORT_LEVELS.includes(props.effort as EffortLevel) ? props.effort : 'auto'}
            title="推理强度（下轮生效）"
            options={EFFORT_LEVELS.map((level) => ({ value: level, label: effortLabel(level) }))}
            onChange={(v) => props.onEffort(v as EffortLevel)}
          />
          <button
            className={`plan-toggle ${props.planMode === 'planning' ? 'active' : ''}`}
            title={props.planMode === 'planning' ? '退出计划模式，恢复正常执行' : '进入计划模式（只读规划，产出计划待审批）'}
            onClick={props.onTogglePlanMode}
          >
            📋 {props.planMode === 'planning' ? '退出计划' : '计划'}
          </button>
          {props.planMode === 'planning' && (
            <span className="badge plan">📋 Plan Mode{props.planDrafting ? ' · 起草中…' : ''}</span>
          )}
          <button
            className={`plan-toggle ${props.askMode === 'asking' ? 'active' : ''}`}
            title={props.askMode === 'asking' ? '退出询问模式，恢复正常执行' : '进入询问模式（只读问答，不改文件）'}
            onClick={props.onToggleAskMode}
          >
            ? {props.askMode === 'asking' ? '退出 Ask' : 'Ask'}
          </button>
          {props.askMode === 'asking' && (
            <span className="badge ask">? Ask Mode</span>
          )}
        </>
      )}
    </div>
  )
}

/**
 * 首启 Setup 引导卡：选 provider 预设 + 填 API key，一步配好默认模型。
 * key 只经 postMessage 一次性交宿主调 REST，不进 webview 状态持久化。
 */
function SetupCard({ config, compact }: { config: ProviderConfigList; compact?: boolean }) {
  const CUSTOM = '__custom__'
  // 候选：未配置的预设 + 已配置但无 key 的 provider
  const presets = useMemo(() => {
    const noKey = config.providers
      .filter((p) => p.keyStatus.source === 'none')
      .map((p) => ({ key: p.name, label: p.label }))
    const fresh = config.unconfigured.map((u) => ({ key: u.key, label: u.label }))
    const seen = new Set<string>()
    return [...noKey, ...fresh].filter((p) => !seen.has(p.key) && seen.add(p.key))
  }, [config])

  const [provider, setProvider] = useState(presets[0]?.key ?? CUSTOM)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelId, setModelId] = useState('')
  const [customName, setCustomName] = useState('custom')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    return onHostMessage((msg: HostMsg) => {
      if (msg.type === 'providerSetupResult') {
        setBusy(false)
        if (!msg.ok) setError(msg.message ?? '保存失败')
        // 成功时宿主会紧跟重发 providers，App 层 needsSetup 自动翻转放行
      }
    })
  }, [])

  const isCustom = provider === CUSTOM
  const canSave = !busy && (isCustom ? !!(customName.trim() && baseUrl.trim() && modelId.trim()) : !!apiKey.trim())

  const save = () => {
    if (!canSave) return
    setError('')
    setBusy(true)
    if (isCustom) {
      send({
        type: 'setupProvider',
        providerName: customName.trim(),
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        modelId: modelId.trim(),
        custom: true,
      })
    } else {
      send({ type: 'setupProvider', providerName: provider, apiKey: apiKey.trim() })
    }
    setApiKey('')
  }

  const card = (
      <div className="setup-card">
        <h3>{compact ? '添加提供商' : '欢迎使用天枢'}</h3>
        <p>
          {compact
            ? '写入 ~/.rivet，与 CLI / 桌面共用。'
            : '还没有可用的 API key。选择一个模型提供商完成配置，即可开始对话（配置写入 ~/.rivet，与 CLI 端共用）。'}
        </p>
        <label>
          提供商
          <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={busy}>
            {presets.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
            <option value={CUSTOM}>自定义端点（OpenAI 兼容）</option>
          </select>
        </label>
        {isCustom && (
          <>
            <label>
              名称
              <input value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="my-provider" disabled={busy} />
            </label>
            <label>
              Base URL
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" disabled={busy} />
            </label>
            <label>
              模型 ID
              <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="例如 deepseek-chat / qwen3:32b" disabled={busy} />
            </label>
          </>
        )}
        <label>
          API key{isCustom ? '（本地端点可留空）' : ''}
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
        </label>
        {error && <div className="banner error">{error}</div>}
        <div className="actions">
          <button className="approve" onClick={save} disabled={!canSave}>
            {busy ? '保存中…' : compact ? '保存' : '保存并开始'}
          </button>
        </div>
      </div>
  )
  return compact ? card : <div className="messages">{card}</div>
}

function TodoPanel({ todos }: { todos: ChatState['todos'] }) {
  const doneCount = todos.filter((t) => t.status === 'completed').length
  return (
    <details className="todo-panel" open>
      <summary>
        任务清单 {doneCount}/{todos.length}
      </summary>
      <ul>
        {todos.map((t) => (
          <li key={t.id || t.content} className={t.status}>
            {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : t.status === 'cancelled' ? '✕' : '○'} {t.content}
          </li>
        ))}
      </ul>
    </details>
  )
}

/** 工具输入里常见的文件路径字段，用于渲染跳转链接。 */
function toolFilePath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  for (const key of ['path', 'file_path', 'filePath', 'file']) {
    const v = o[key]
    if (typeof v === 'string' && v && !v.startsWith('/')) return v
  }
  return undefined
}

function quoteBlock(text: string): string {
  const snippet = text.length > 500 ? `${text.slice(0, 500)}…` : text
  return snippet.split('\n').map((line) => `> ${line}`).join('\n')
}

function MsgActions({ text, onQuote }: { text: string; onQuote: (quoted: string) => void }) {
  if (!text) return null
  return (
    <div className="msg-actions">
      <button type="button" onClick={() => send({ type: 'copyText', text })}>复制</button>
      <button type="button" onClick={() => onQuote(quoteBlock(text))}>引用</button>
    </div>
  )
}

function queueStatusLabel(status: Extract<ChatItem, { kind: 'queue' }>['status']): string {
  if (status === 'queued') return '排队中'
  if (status === 'steered') return '已升级插话'
  if (status === 'delivered') return '已注入'
  if (status === 'cancelled') return '内核重启，排队已取消'
  return '已并入下轮'
}

function Item({
  item,
  sessionId,
  running,
  streaming,
  plans,
  planDecisions,
  planRevisions,
  onContinue,
  onQuote,
  rewind,
}: {
  item: ChatItem
  sessionId?: string
  running: boolean
  /** 该条是否为流式尾巴——流式中保持纯文本，完成后才 markdown 化（避免逐帧重排）。 */
  streaming: boolean
  plans: Record<string, PlanDocument>
  planDecisions: Record<string, string>
  planRevisions: Record<string, number>
  onContinue: () => void
  onQuote: (quoted: string) => void
  rewind?: {
    open: boolean
    files: boolean
    busy: boolean
    onAsk: () => void
    onCancel: () => void
    onFiles: (v: boolean) => void
    onConfirm: () => void
  }
}) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg user">
          <div>{item.text}</div>
          <MsgActions text={item.text} onQuote={onQuote} />
          {rewind && (
            rewind.open ? (
              <div className="rewind-confirm">
                <label className="rewind-files">
                  <input
                    type="checkbox"
                    checked={rewind.files}
                    disabled={rewind.busy}
                    onChange={(e) => rewind.onFiles(e.target.checked)}
                  />
                  同时回滚本会话文件
                </label>
                <div className="actions">
                  <button className="approve" disabled={rewind.busy} onClick={rewind.onConfirm}>
                    {rewind.busy ? '退回中…' : '确认退回'}
                  </button>
                  <button disabled={rewind.busy} onClick={rewind.onCancel}>取消</button>
                </div>
              </div>
            ) : (
              <button className="rewind-btn" onClick={rewind.onAsk}>退到这里</button>
            )
          )}
        </div>
      )
    case 'assistant':
      return (
        <div className="assistant-block">
          {streaming ? <div className="msg assistant">{item.text}</div> : <AssistantMarkdown text={item.text} />}
          <MsgActions text={item.text} onQuote={onQuote} />
        </div>
      )
    case 'queue':
      return (
        <div className={`msg queue ${item.status}`}>
          <div className="queue-status">{queueStatusLabel(item.status)}</div>
          <div>{item.text}</div>
          {item.status === 'queued' && sessionId && (
            <div className="actions">
              <button
                className="approve"
                type="button"
                onClick={() => send({ type: 'steerLane', sessionId, laneId: item.laneId, text: item.text })}
              >
                立即插话
              </button>
              <button
                type="button"
                onClick={() => send({ type: 'retractQueued', sessionId, laneId: item.laneId, text: item.text })}
              >
                撤回
              </button>
            </div>
          )}
        </div>
      )
    case 'thinking':
      return (
        <details className="msg thinking">
          <summary>思考过程</summary>
          <pre>{item.text}</pre>
        </details>
      )
    case 'tool': {
      const filePath = toolFilePath(item.input)
      return (
        <details className={`msg tool ${item.isError ? 'error' : ''}`}>
          <summary>
            🔧 {item.name}
            {filePath && (
              <a
                className="file-link"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  send({ type: 'openFile', path: filePath })
                }}
              >
                {filePath}
              </a>
            )}
            {item.isError ? ' ⚠' : ''}
          </summary>
          <pre className="tool-input">{safeJson(item.input)}</pre>
          {item.result && <pre className="tool-result">{truncate(item.result, 4000)}</pre>}
        </details>
      )
    }
    case 'approval':
      return <ApprovalCard item={item} sessionId={sessionId} />
    case 'question':
      return <QuestionCard toolUseId={item.toolUseId} questions={item.questions} sessionId={sessionId} running={running} />
    case 'plan':
      return (
        <PlanCard
          key={`${sessionId}:${item.slug}:${planRevisions[item.slug]}`}
          slug={item.slug}
          title={item.title}
          status={item.status}
          sessionId={sessionId}
          plan={plans[item.slug]}
          decision={planDecisions[item.slug]}
          revision={planRevisions[item.slug]}
        />
      )
    case 'info':
      return <div className="msg info">{item.text}</div>
    case 'checkpoint': {
      const title = item.variant === 'watchdog' ? '看门狗' : '自动检查点'
      const reason = item.paused
        ? (item.variant === 'watchdog'
          ? '会话已停，确认方向后继续。'
          : `已连续 ${item.turns ?? 0} 轮，暂停核对方向。`)
        : `进度播报 · 已连续 ${item.turns ?? 0} 轮`
      return (
        <div className={`msg checkpoint ${item.paused ? 'paused' : ''}`}>
          <div><b>{title}</b>{item.paused ? ' · 已暂停' : ''}</div>
          <div className="checkpoint-reason">{reason}</div>
          {item.digest && <pre className="checkpoint-digest">{item.digest}</pre>}
          {item.paused && sessionId && !running && (
            <div className="actions">
              <button className="approve" onClick={onContinue}>继续</button>
            </div>
          )}
        </div>
      )
    }
    case 'usage': {
      // 命中率口径同内核：cache_read / input_tokens（input 为 cache-inclusive）
      const hit = item.input > 0 ? Math.round((item.cacheRead / item.input) * 100) : null
      return (
        <div
          className="msg usage-foot"
          title={`输入 ${fmtTokens(item.input)}（缓存读 ${fmtTokens(item.cacheRead)} · 新写缓存 ${fmtTokens(item.cacheCreate)}）· 输出 ${fmtTokens(item.output)}`}
        >
          ⚡ {hit !== null ? `${hit}% 命中 · ` : ''}↑{fmtTokens(item.input)} ↓{fmtTokens(item.output)}
        </div>
      )
    }
  }
}

function AssistantMarkdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className="msg assistant md" dangerouslySetInnerHTML={{ __html: html }} />
}

/**
 * 工具审批卡。批准/拒绝之外对齐桌面端 handleApproval 的两个深度能力：
 * 「改参数后批准」（editedInput，JSON 解析失败 fail-closed 不发送）与
 * 「记住本次会话同类决策」（remember）。
 */
function ApprovalCard({ item, sessionId }: { item: Extract<ChatItem, { kind: 'approval' }>; sessionId?: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [parseError, setParseError] = useState('')
  const [remember, setRemember] = useState(false)

  const answer = (decision: 'approve' | 'deny', editedInput?: Record<string, unknown>) => {
    if (!sessionId) return
    send({
      type: 'approval',
      sessionId,
      requestId: item.requestId,
      decision,
      ...(editedInput ? { editedInput } : {}),
      ...(remember ? { remember: true } : {}),
    })
  }

  const approveEdited = () => {
    try {
      const parsed: unknown = JSON.parse(draft)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setParseError('参数必须是 JSON 对象')
        return
      }
      setParseError('')
      answer('approve', parsed as Record<string, unknown>)
    } catch (err) {
      setParseError(`JSON 解析失败：${(err as Error).message}`)
    }
  }

  return (
    <div className="msg approval">
      <div>
        🛡 <b>{item.toolName}</b> 请求执行
      </div>
      {editing ? (
        <textarea
          className="approval-edit"
          value={draft}
          rows={Math.min(14, draft.split('\n').length + 1)}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : (
        <pre>{truncate(safeJson(item.input), 1200)}</pre>
      )}
      {item.decision ? (
        <div className="decision">{item.decision === 'approve' ? '✓ 已批准' : `✗ ${item.decision}`}</div>
      ) : (
        <>
          {parseError && <div className="approval-error">{parseError}</div>}
          <label className="approval-remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            记住本次会话同类决策
          </label>
          <div className="actions">
            {editing ? (
              <>
                <button className="approve" onClick={approveEdited}>
                  以修改后参数批准
                </button>
                <button
                  onClick={() => {
                    setEditing(false)
                    setParseError('')
                  }}
                >
                  取消
                </button>
              </>
            ) : (
              <>
                <button className="approve" onClick={() => answer('approve')}>
                  批准
                </button>
                <button
                  onClick={() => {
                    setDraft(JSON.stringify(item.input ?? {}, null, 2))
                    setEditing(true)
                  }}
                >
                  改参数…
                </button>
                <button className="deny" onClick={() => answer('deny')}>
                  拒绝
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Plan 审批卡：plan_submitted 帧出卡 → 展开时按需拉正文（GET /plans/:slug）
 * → 批准/驳回走 plans REST。驳回意见组装为普通文本输入。
 * 对齐桌面端 PlanPanel：多方案（options≥2）radio 选择随批准回传 selectedApproach；
 * submitted 状态可编辑正文（PUT /plans/:slug，保存后宿主重推 plan 刷新）。
 */
function PlanCard(props: {
  slug: string
  title: string
  status: string
  sessionId?: string
  plan?: PlanDocument
  decision?: string
  revision?: number
}) {
  const [rejecting, setRejecting] = useState(false)
  const [comment, setComment] = useState('')
  const [selectedApproach, setSelectedApproach] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [editError, setEditError] = useState('')
  const requested = useRef(false)

  const fetchPlan = () => {
    if (requested.current || props.plan || !props.sessionId) return
    requested.current = true
    send({ type: 'readPlan', sessionId: props.sessionId, slug: props.slug, revision: props.revision })
  }

  // 编辑保存结果回流（宿主保存成功后会紧跟重推 plan，props.plan 自动刷新）
  useEffect(() => {
    return onHostMessage((msg) => {
      if (msg.type === 'planEditResult' && msg.sessionId === props.sessionId && msg.slug === props.slug && msg.revision === props.revision) {
        if (msg.ok) {
          setEditing(false)
          setEditError('')
        } else {
          setEditError(msg.message ?? '保存失败')
        }
      }
    })
  }, [props.sessionId, props.slug, props.revision])

  const decided = props.decision ?? (props.status !== 'submitted' ? props.status : undefined)
  const html = useMemo(() => (props.plan ? renderMarkdown(props.plan.content) : ''), [props.plan])
  const options = props.plan?.options ?? []

  return (
    <div className="msg plan-card">
      <div className="plan-head">
        📋 <b>{props.title || props.slug}</b>
        <span className={`badge plan-status ${decided ?? 'submitted'}`}>
          {decided === 'approve' || decided === 'approved' || decided === 'executed'
            ? '✓ 已批准'
            : decided === 'reject' || decided === 'rejected'
              ? '✗ 已驳回'
              : '待审批'}
        </span>
      </div>
      <details onToggle={(e) => (e.target as HTMLDetailsElement).open && fetchPlan()}>
        <summary>查看计划正文</summary>
        {props.plan ? <div className="md" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="empty">加载中…</div>}
      </details>
      {editing && (
        <>
          <textarea
            className="plan-edit"
            value={editDraft}
            rows={Math.min(24, editDraft.split('\n').length + 1)}
            onChange={(e) => setEditDraft(e.target.value)}
          />
          {editError && <div className="approval-error">{editError}</div>}
          <div className="actions">
            <button
              className="approve"
              onClick={() => {
                if (!editDraft.trim()) {
                  setEditError('计划内容不能为空')
                  return
                }
                setEditError('')
                send({ type: 'editPlan', sessionId: props.sessionId!, slug: props.slug, content: editDraft, revision: props.revision })
              }}
            >
              保存修改
            </button>
            <button
              onClick={() => {
                setEditing(false)
                setEditError('')
              }}
            >
              取消
            </button>
          </div>
        </>
      )}
      {!decided && !editing && options.length >= 2 && props.sessionId && (
        <div className="plan-options">
          <div className="plan-options-label">选择执行方案</div>
          {options.map((opt) => (
            <label key={opt.id} className={`plan-option ${selectedApproach === opt.label ? 'active' : ''}`}>
              <input
                type="radio"
                name={`plan-option-${props.slug}`}
                checked={selectedApproach === opt.label}
                onChange={() => setSelectedApproach(opt.label)}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      )}
      {!decided && !editing && props.sessionId && (
        <div className="actions">
          {rejecting ? (
            <>
              <input
                value={comment}
                placeholder="驳回意见（可选，会作为修订反馈回传）"
                onChange={(e) => setComment(e.target.value)}
              />
              <button
                className="deny"
                onClick={() =>
                  send({ type: 'planDecision', sessionId: props.sessionId!, slug: props.slug, revision: props.revision, decision: 'reject', comment: comment.trim() || undefined })
                }
              >
                确认驳回
              </button>
              <button onClick={() => setRejecting(false)}>取消</button>
            </>
          ) : (
            <>
              <button
                className="approve"
                onClick={() =>
                  send({
                    type: 'planDecision',
                    revision: props.revision,
                    sessionId: props.sessionId!,
                    slug: props.slug,
                    decision: 'approve',
                    ...(options.length >= 2 && selectedApproach ? { selectedApproach } : {}),
                  })
                }
              >
                批准并执行
              </button>
              <button
                onClick={() => {
                  if (!props.plan) {
                    fetchPlan()
                    return
                  }
                  setEditDraft(props.plan.content)
                  setEditing(true)
                }}
                title={props.plan ? '修改计划正文' : '先加载计划正文'}
              >
                编辑…
              </button>
              <button className="deny" onClick={() => setRejecting(true)}>
                驳回…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * ask_user_question 结构化提问卡。答案不走新 API——组装成普通用户消息回传
 * （与桌面端同一约定，server 侧 ask_user_question 工具只回占位符 + endTurn）。
 */
function QuestionCard(props: { toolUseId: string; questions: QuestionSpec[]; sessionId?: string; running: boolean }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [sent, setSent] = useState(false)

  const toggle = (qid: string, option: string, multi: boolean) => {
    setPicked((prev) => {
      const cur = prev[qid] ?? []
      if (!multi) return { ...prev, [qid]: [option] }
      return { ...prev, [qid]: cur.includes(option) ? cur.filter((o) => o !== option) : [...cur, option] }
    })
  }

  const submit = () => {
    if (!props.sessionId || sent) return
    const lines = props.questions.map((q) => {
      const ans = picked[q.id]?.join('、') || '（未选择）'
      return props.questions.length > 1 ? `${q.prompt}: ${ans}` : ans
    })
    const text = lines.join('\n')
    send({ type: props.running ? 'steer' : 'prompt', sessionId: props.sessionId, text })
    setSent(true)
  }

  return (
    <div className="msg question">
      {props.questions.map((q) => (
        <div key={q.id} className="q-block">
          <div className="q-prompt">❓ {q.prompt}</div>
          <div className="q-options">
            {q.options.map((opt) => (
              <button
                key={opt}
                className={picked[q.id]?.includes(opt) ? 'picked' : ''}
                disabled={sent}
                onClick={() => toggle(q.id, opt, q.allowMultiple === true)}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      ))}
      {sent ? (
        <div className="decision">✓ 已回答</div>
      ) : (
        <div className="actions">
          <button className="approve" onClick={submit} disabled={Object.keys(picked).length === 0}>
            提交回答
          </button>
        </div>
      )}
    </div>
  )
}

function Composer(props: {
  running: boolean
  disabled: boolean
  fileHits: string[]
  onQueryFiles: (q: string) => void
  onClearFiles: () => void
  onSubmit: (text: string, images?: string[]) => void
  onAbort: () => void
  onResume: () => void
  canResume: boolean
  /** 历史消息（最新在前），↑/↓ 终端式召回。 */
  history: string[]
  /** 会话标识——切换会话时重置历史浏览态（历史属于会话）。 */
  sessionKey?: string
  /** rewind / 引用 / 撤回排队后回填输入框。replace=覆盖；prepend=引用在前；append=原文追加。 */
  restoreDraft?: { text: string; n: number; mode?: 'replace' | 'prepend' | 'append' }
}) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [pendingImageReads, setPendingImageReads] = useState(0)
  const [slashHi, setSlashHi] = useState(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageReaders = useRef(new Set<FileReader>())
  const imageGeneration = useRef(0)
  const imageSessionKey = useRef(props.sessionKey)
  imageSessionKey.current = props.sessionKey
  const invalidateImageReads = () => {
    imageGeneration.current++
    for (const reader of imageReaders.current) reader.abort()
    imageReaders.current.clear()
    setPendingImageReads(0)
  }
  useEffect(() => () => invalidateImageReads(), [props.sessionKey])
  const slashQuery = detectSlashToken(text)
  const slashHits = slashQuery !== null ? filterSlashMenu(slashQuery) : []
  // 历史浏览下标：null=正常输入；number=当前显示的是 history 中第几条。
  // stashedDraft：首次按 ↑ 时暂存在输草稿，↓ 越过最新一条时恢复（shell 式往返）。
  const histIdx = useRef<number | null>(null)
  const stashedDraft = useRef('')
  useEffect(() => { histIdx.current = null }, [props.sessionKey])
  // 草稿镜像 ref（activeIdRef 同款 idiom）：切会话暂存时读最新值，不进依赖数组。
  const draftRef = useRef({ text, images })
  draftRef.current = { text, images }
  // issue #296 — 草稿按会话隔离：text/images 属于会话。切会话时暂存旧会话、
  // 恢复目标会话；全局单值会把 A 打好的内容带进 B 的输入框，在 B 发送即泄漏。
  // 未附着会话的欢迎页草稿用 '' 作 key（切走再切回「新会话」不丢）。
  const draftStash = useRef(new Map<string, ComposerDraft>())
  const prevSessionKeyRef = useRef(props.sessionKey ?? '')
  useEffect(() => {
    const toKey = props.sessionKey ?? ''
    const fromKey = prevSessionKeyRef.current
    if (fromKey === toKey) return
    prevSessionKeyRef.current = toKey
    const next = switchComposerDraft(draftStash.current, fromKey, toKey, draftRef.current)
    setText(next.text)
    setImages(next.images)
  }, [props.sessionKey])
  useEffect(() => {
    if (!props.restoreDraft) return
    histIdx.current = null
    const incoming = props.restoreDraft.text
    const mode = props.restoreDraft.mode ?? 'replace'
    setText((prev) => {
      if (mode === 'replace') return incoming
      if (mode === 'prepend') return prev.trim() ? `${incoming}\n\n${prev}` : `${incoming}\n\n`
      return prev.trim() ? `${prev}\n${incoming}` : incoming
    })
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (ta) {
        ta.focus()
        ta.setSelectionRange(ta.value.length, ta.value.length)
      }
    })
  }, [props.restoreDraft])

  const recallHistory = (dir: 'prev' | 'next') => {
    const n = props.history.length
    if (n === 0) return
    const cur = histIdx.current
    if (dir === 'prev') {
      const next = cur === null ? 0 : Math.min(cur + 1, n - 1)
      if (cur === null) stashedDraft.current = text
      histIdx.current = next
      setText(props.history[next] ?? '')
    } else {
      if (cur === null) return
      const next = cur - 1
      if (next < 0) {
        histIdx.current = null
        setText(stashedDraft.current)
        stashedDraft.current = ''
      } else {
        histIdx.current = next
        setText(props.history[next] ?? '')
      }
    }
    // 召回后光标落到末尾（shell parity）。
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (ta) ta.setSelectionRange(ta.value.length, ta.value.length)
    })
  }

  // 编辑器右键「发送到天枢」→ 追加到草稿
  useEffect(() => {
    return onHostMessage((msg: HostMsg) => {
      if (msg.type === 'insertText') {
        setText((prev) => (prev ? `${prev}\n${msg.text}` : msg.text))
        textareaRef.current?.focus()
      }
    })
  }, [])

  /** 光标前最后一个 @token（未闭合的提及查询），无则 null。 */
  const mentionQuery = (value: string): string | null => {
    const m = /(?:^|\s)@([\w\-./]*)$/.exec(value)
    return m ? m[1] ?? '' : null
  }

  const onChange = (value: string) => {
    // 浏览态下编辑 = 退出浏览、编辑内容即新草稿（recallHistory 走裸 setText
    // 不经此路）——否则继续翻页会把用户的改动静默丢掉。
    histIdx.current = null
    setText(value)
    const q = mentionQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (q === null) {
      props.onClearFiles()
      return
    }
    debounceRef.current = setTimeout(() => props.onQueryFiles(q), 200)
  }

  const pickFile = (path: string) => {
    setText((prev) => prev.replace(/(^|\s)@[\w\-./]*$/, `$1@file:${path} `))
    props.onClearFiles()
    textareaRef.current?.focus()
  }

  const pickSlash = (name: string) => {
    if (props.disabled || pendingImageReads > 0 || imageReaders.current.size > 0 || (props.running && images.length > 0)) return
    if (slashNeedsArgs(name)) {
      setText(`${name} `)
      setSlashHi(0)
      textareaRef.current?.focus()
      return
    }
    props.onSubmit(name)
    invalidateImageReads()
    setText('')
    props.onClearFiles()
    setImages([])
    histIdx.current = null
    stashedDraft.current = ''
  }

  const addImage = (dataUrl: string) => {
    const normalized = normalizeImageDataUrl(dataUrl)
    if (!normalized) return
    if (imageTooLarge(normalized)) return
    setImages((prev) => (canAddImage(prev.length) ? [...prev, normalized] : prev))
  }

  const fire = () => {
    if (props.disabled || pendingImageReads > 0 || imageReaders.current.size > 0 || (props.running && images.length > 0)) return
    const t = text.trim()
    if (!t && images.length === 0) return
    if (!t) return
    if (slashHits.length > 0 && slashQuery !== null && !/\s/.test(text)) {
      const hit = slashHits[Math.min(slashHi, slashHits.length - 1)]
      if (hit) pickSlash(hit.name)
      return
    }
    props.onSubmit(t, images.length ? images : undefined)
    invalidateImageReads()
    setText('')
    setImages([])
    props.onClearFiles()
    histIdx.current = null
    stashedDraft.current = ''
  }

  const onDropFiles = (e: DragEvent) => {
    e.preventDefault()
    const uris: string[] = []
    const uriList = e.dataTransfer.getData('text/uri-list')
    if (uriList) {
      for (const line of uriList.split('\n')) {
        const t = line.trim()
        if (t && !t.startsWith('#')) uris.push(t)
      }
    }
    for (let i = 0; i < e.dataTransfer.files.length; i++) {
      const f = e.dataTransfer.files[i]
      // Electron/VS Code may expose path on File
      const p = (f as File & { path?: string }).path
      if (p) uris.push(p)
    }
    if (uris.length === 0) return
    const mentions = uris
      .map((u) => {
        try {
          const path = decodeURIComponent(u.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1'))
          // Prefer basename-ish relative: strip to last meaningful segment chain
          const parts = path.split(/[/\\]/)
          // Keep last 3 segments as a soft relative hint when absolute
          return `@file:${parts.slice(-3).join('/')}`
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .join(' ')
    if (mentions) setText((prev) => (prev ? `${prev} ${mentions} ` : `${mentions} `))
  }

  return (
    <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={onDropFiles}>
      {slashHits.length > 0 && (
        <div className="mention-list">
          {slashHits.slice(0, 12).map((c, i) => (
            <div
              key={c.name + c.desc}
              className={`mention-item${i === slashHi ? ' active' : ''}`}
              onClick={() => pickSlash(c.name)}
            >
              <span className="slash-name">{c.name}</span>
              <span className="slash-desc">{c.desc}</span>
            </div>
          ))}
        </div>
      )}
      {props.fileHits.length > 0 && slashHits.length === 0 && (
        <div className="mention-list">
          {props.fileHits.slice(0, 12).map((f) => (
            <div key={f} className="mention-item" onClick={() => pickFile(f)}>
              {f}
            </div>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="image-chips">
          {images.map((_, i) => (
            <button key={i} type="button" className="image-chip" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>
              图 {i + 1} ×
            </button>
          ))}
        </div>
      )}
      {props.running && images.length > 0 && <div className="empty">图片草稿已保留，请等当前任务结束后发送。</div>}
      {pendingImageReads > 0 && <div className="empty">正在读取图片，草稿已保留…</div>}
      <textarea
        ref={textareaRef}
        value={text}
        disabled={props.disabled}
        placeholder={props.running ? '运行中——发送将排队，下轮归并；要立刻打断点排队卡上的「立即插话」' : '给天枢一个任务…（/ 命令，@ 文件，粘贴图片，Enter 发送）'}
        onPaste={(e) => {
          const items = e.clipboardData?.items
          if (!items) return
          let captured = false
          for (let i = 0; i < items.length; i++) {
            const item = items[i]
            if (!item || !item.type.startsWith('image/')) continue
            const file = item.getAsFile()
            if (!file) continue
            captured = true
            const reader = new FileReader()
            const generation = imageGeneration.current
            const sessionKey = props.sessionKey
            imageReaders.current.add(reader)
            setPendingImageReads(imageReaders.current.size)
            const finished = () => {
              imageReaders.current.delete(reader)
              setPendingImageReads(imageReaders.current.size)
            }
            reader.onload = () => {
              finished()
              if (generation !== imageGeneration.current || sessionKey !== imageSessionKey.current) return
              if (typeof reader.result === 'string') addImage(reader.result)
            }
            reader.onerror = reader.onabort = finished
            try { reader.readAsDataURL(file) } catch { finished() }
          }
          if (captured) e.preventDefault()
        }}
        onChange={(e) => {
          setSlashHi(0)
          onChange(e.target.value)
        }}
        onKeyDown={(e) => {
          if (slashHits.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setSlashHi((i) => {
              const n = Math.min(slashHits.length, 12)
              if (e.key === 'ArrowDown') return (i + 1) % n
              return (i - 1 + n) % n
            })
            return
          }
          if (slashHits.length > 0 && e.key === 'Tab') {
            e.preventDefault()
            const hit = slashHits[Math.min(slashHi, slashHits.length - 1)]
            if (hit) pickSlash(hit.name)
            return
          }
          // 历史召回（终端式 ↑/↓，与桌面端 lib/input-history.ts 同一语义）：
          // 浏览态（已翻进历史）下 ↑/↓ 无条件继续翻——否则召回多行消息后光标
          // 落在中间行，守卫会把后续 ↑/↓ 当成文本内移动，翻页被卡死；非浏览态
          // 仅光标在首行/末行才触发，多行草稿内光标仍可自由移动。
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            const browsing = histIdx.current !== null
            const hit = e.key === 'ArrowUp'
              ? browsing || e.currentTarget.value.slice(0, e.currentTarget.selectionStart).indexOf('\n') === -1
              : browsing || e.currentTarget.value.slice(e.currentTarget.selectionEnd).indexOf('\n') === -1
            // 历史为空时不拦按键——否则浏览态 + 空历史会把 ↑/↓ 困死（preventDefault
            // 了但 recallHistory 无可召回），光标动弹不得。
            if (hit && props.history.length > 0) {
              e.preventDefault()
              recallHistory(e.key === 'ArrowUp' ? 'prev' : 'next')
              return
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            fire()
          }
          if (e.key === 'Escape') props.onClearFiles()
        }}
      />
      <div className="composer-actions">
        {props.canResume && !props.running && (
          <button className="abort" onClick={props.onResume} title="续跑当前会话">
            续跑
          </button>
        )}
        {props.running && (
          <button className="abort" onClick={props.onAbort} title="中止当前运行">
            ■ 中止
          </button>
        )}
        <button onClick={fire} disabled={props.disabled || !text.trim() || pendingImageReads > 0 || (props.running && images.length > 0)}>
          {props.running ? '排队' : '发送'}
        </button>
      </div>
    </div>
  )
}

/** token 缩写 — 对齐内核 utils/pricing.ts formatTokens 的 k/M 约定。 */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** USD 成本 — 对齐内核 utils/pricing.ts formatCost。 */
function fmtCost(v: number): string {
  if (v === 0) return '$0.00'
  if (v < 0.0001) return '<$0.0001'
  return `$${v.toFixed(4).replace(/\.?0+$/, '')}`
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? ''
  } catch {
    return String(v)
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} 字符已截断)` : s
}
