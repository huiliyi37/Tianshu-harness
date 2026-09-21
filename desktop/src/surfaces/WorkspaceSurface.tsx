import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { SurfaceSkeleton } from '../components/Skeleton'
import { qk, useAbortSession, useArtifacts, useCloseSession, useSendPrompt, useSessions, useSetPlanMode, useSetAskMode, useWorkingTree } from '../state/queries'
import { useUiDispatch, useUiState } from '../state/store'
import { useSessionEvents, useSessionEventsSelector } from '../state/use-session-events'
import { useJobNotifications } from '../state/use-job-notifications'
import { answerApproval, commitSessionChanges, createSessionPr, mergeSessionBack, setApprovalMode, setEffort, steerSession } from '../runtime/client'
import type { ApprovalMode, PlanModeState, AskModeState } from '../runtime/types'
import { ProjectSidebar } from './ProjectSidebar'
import { ThreadView } from './ThreadView'
import { ReviewPanel } from './ReviewPanel'
import { TerminalTabs } from '../components/TerminalTabs'
import { JobsDock } from '../components/JobsDock'
import { DelegationOverlay } from '../components/DelegationOverlay'
import { summarizeDelegation } from '../components/DelegationTree'
import { ThreadTabs } from '../components/ThreadTabs'
import { HomeWelcome } from '../components/HomeWelcome'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import {
  loadPanelLayout,
  saveSidebarWidth,
  saveReviewWidth,
  resetPanelLayout,
  sizeForPanelResize,
  persistableSidebarPct,
  persistableReviewPct,
  isCollapsedSize,
} from '../lib/panel-layout'
import { UpdateBanner } from '../components/UpdateBanner'
import { WhatsNewModal } from '../components/WhatsNewModal'
import { isApprovalConsent } from '../lib/consent'
import { deriveProjects, loadKnownProjects } from '../lib/projects'
import { openExternal } from '../lib/open-external'
import { openThreadPopout } from '../lib/popout'
import { isTauri } from '../lib/pty'

const HomeSurface = lazy(() => import('./HomeSurface').then((m) => ({ default: m.HomeSurface })))
const SkillsSurface = lazy(() => import('./SkillsSurface').then((m) => ({ default: m.SkillsSurface })))
const GitSurface = lazy(() => import('./GitSurface').then((m) => ({ default: m.GitSurface })))
const InsightsSurface = lazy(() => import('./InsightsSurface').then((m) => ({ default: m.InsightsSurface })))
const DelegationSurface = lazy(() => import('./DelegationSurface').then((m) => ({ default: m.DelegationSurface })))
const CouncilSurface = lazy(() => import('./CouncilSurface').then((m) => ({ default: m.CouncilSurface })))
const HooksSurface = lazy(() => import('./HooksSurface').then((m) => ({ default: m.HooksSurface })))
const AutomationsSurface = lazy(() => import('./AutomationsSurface').then((m) => ({ default: m.AutomationsSurface })))
const InboxSurface = lazy(() => import('./InboxSurface').then((m) => ({ default: m.InboxSurface })))
const SettingsSurface = lazy(() => import('./SettingsSurface').then((m) => ({ default: m.SettingsSurface })))
const MissionControlSurface = lazy(() => import('./MissionControlSurface').then((m) => ({ default: m.MissionControlSurface })))



export function WorkspaceSurface() {
  const { t } = useTranslation('shell')
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const sessions = useSessions()
  const activeId = ui.activeSessionId

  // 中控台真正卸载主线程流（Phase 3 #9，让 MissionControlSurface 头注释成真）：
  // mission 打开时 ThreadView 不渲染，这里也不再持有活跃会话的 SSE 订阅——
  // 连接预算（~6）整体让给中控台的 live 卡片池。返回线程视图时 hub 重新订阅
  // 并从 since=0 重放（服务端 replay 已异步化，代价可控）。
  const streamId = ui.surface === 'mission' ? null : activeId
  const view = useSessionEvents(streamId)
  useJobNotifications(streamId, view.jobs)
  const artifacts = useArtifacts(activeId, view.artifactRev)
  const sendPrompt = useSendPrompt()
  const abortSession = useAbortSession()
  const closeSession = useCloseSession()
  const setPlanMode = useSetPlanMode()
  const setAskMode = useSetAskMode()

  const [isFloatDeckOpen, setIsFloatDeckOpen] = useState(false)
  const deckRef = useRef<HTMLDivElement>(null)
  const [showDelegation, setShowDelegation] = useState(false)
  const [jobsHidden, setJobsHidden] = useState(false)
  const [sideChatOpen, setSideChatOpen] = useState(false)

  const runningJobsCount = Object.values(view.jobs).filter((j) => j.status === 'running').length
  const prevRunningCount = useRef(runningJobsCount)

  useEffect(() => {
    if (runningJobsCount > prevRunningCount.current) {
      setJobsHidden(false)
    }
    prevRunningCount.current = runningJobsCount
  }, [runningJobsCount])

  useEffect(() => {
    if (!isFloatDeckOpen) return
    const onClickOutside = (e: MouseEvent) => {
      if (deckRef.current && !deckRef.current.contains(e.target as Node)) {
        setIsFloatDeckOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [isFloatDeckOpen])

  const active = sessions.data?.find((s) => s.id === activeId) ?? null

  // Terminal working directory — a REAL path, not the project id. The panel
  // used to receive `ui.activeProject` (a `name-hash` slug), which the PTY then
  // treated as a relative dir that doesn't exist. Resolve like App.tsx's
  // defaultCwd: the active thread's own cwd first, then the active project's
  // first root; empty string lets the PTY inherit its default cwd.
  const terminalCwd = useMemo(() => {
    if (active?.cwd) return active.cwd
    if (ui.activeProject) {
      const p = deriveProjects(sessions.data ?? [], loadKnownProjects()).find((x) => x.id === ui.activeProject)
      if (p?.roots[0]) return p.roots[0]
    }
    return ''
  }, [active, sessions.data, ui.activeProject])

  // Responsive: auto-collapse review panel when workspace < 1200px.
  // Uses ResizeObserver — only fires when the element actually resizes.
  // A `reviewManuallyToggled` flag prevents the observer from fighting the
  // user: if the user pressed Cmd+Shift+B to open the panel, we don't
  // auto-close it. The flag resets when width recovers above threshold.
  const wsRef = useRef<HTMLDivElement>(null)
  const reviewVisibleRef = useRef(ui.reviewVisible)
  reviewVisibleRef.current = ui.reviewVisible
  const reviewManualRef = useRef(ui.reviewManuallyToggled)
  reviewManualRef.current = ui.reviewManuallyToggled

  useEffect(() => {
    const el = wsRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return
      const w = entry.contentRect.width
      if (w < 1200) {
        if (reviewVisibleRef.current && !reviewManualRef.current) {
          dispatch({ type: 'setReview', visible: false })
        }
      } else {
        // Width recovered — reset manual flag so auto-collapse works again
        // next time the window shrinks.
        if (reviewManualRef.current) {
          dispatch({ type: 'setReviewManual', on: false })
        }
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [dispatch])

  // Desktop notifications now fire globally for ANY session (Q2) via
  // useGlobalNotifications mounted in App — no per-active-session effects here.

  // Consent bridge (Q): when a tool is blocked on approval and the user types an
  // unambiguous whole-message consent, resolve the pending approval instead of
  // sending/steering it as prose — otherwise the message never reaches the
  // approval channel and the model keeps re-hitting the same gate. Returns true
  // when it consumed the input. Guarded on both send and steer paths since a
  // pending approval means the session is running (submits route to steer).
  const tryConsentBridge = useCallback((text: string): boolean => {
    if (!activeId || !view.pendingApproval) return false
    if (!isApprovalConsent(text)) return false
    void answerApproval(activeId, view.pendingApproval.requestId, 'approve')
    return true
  }, [activeId, view.pendingApproval])

  const handleSend = useCallback((prompt: string, images?: string[]) => {
    if (!activeId) return
    if (!images?.length && tryConsentBridge(prompt)) return
    sendPrompt.mutate({ id: activeId, prompt, images })
  }, [activeId, sendPrompt, tryConsentBridge])

  // T3 — queue mid-run guidance. If the run already finished between render and
  // submit (idle), fall back to starting a fresh turn so input is never lost.
  const handleSteer = useCallback((text: string) => {
    if (!activeId) return
    if (tryConsentBridge(text)) return
    void steerSession(activeId, text).then((r) => {
      if (r === 'idle') sendPrompt.mutate({ id: activeId, prompt: text })
    })
  }, [activeId, sendPrompt, tryConsentBridge])

  const handleApproval = useCallback(
    (decision: 'approve' | 'reject', editedInput?: Record<string, unknown>, remember?: boolean) => {
      if (!activeId || !view.pendingApproval) return
      void answerApproval(activeId, view.pendingApproval.requestId, decision, editedInput, remember)
    },
    [activeId, view.pendingApproval],
  )

  const handleSetApprovalMode = useCallback((mode: ApprovalMode) => {
    if (!activeId) return
    void setApprovalMode(activeId, mode).then(() => sessions.refetch())
  }, [activeId, sessions])

  const handleSetEffort = useCallback((effort: string) => {
    if (!activeId) return
    void setEffort(activeId, effort)
      .then(() => {
        sessions.refetch()
        toast.success(t('effortSet', { effort }))
      })
      .catch((err: Error) => {
        toast.error(err.message || t('effortSetFailed'))
      })
  }, [activeId, sessions, t])

  const handleSetPlanMode = useCallback((state: PlanModeState) => {
    if (!activeId) return
    setPlanMode.mutate({ id: activeId, state })
  }, [activeId, setPlanMode])

  const handleSetAskMode = useCallback((state: AskModeState) => {
    if (!activeId) return
    setAskMode.mutate({ id: activeId, state })
  }, [activeId, setAskMode])

  const handleClose = useCallback(() => {
    if (!activeId) return
    closeSession.mutate(activeId)
    dispatch({ type: 'closeTab', id: activeId })
  }, [activeId, closeSession, dispatch])

  // W2-2 收束: ThreadView → Composer 的 memo 链要求回调引用稳定，onAbort 若为
  // 内联箭头，会随每个 streaming batch 的重渲染击穿 Composer 的浅比较。
  const handleAbort = useCallback(() => {
    if (activeId) abortSession.mutate(activeId)
  }, [activeId, abortSession])
  const sidebarRef = usePanelRef()
  const reviewRef = usePanelRef()
  const sidebarCollapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reviewCollapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync panel collapse/expand with the ui state (Cmd+\, Cmd+Shift+B).
  useEffect(() => {
    const p = sidebarRef.current
    if (!p) return
    if (ui.sidebarVisible) p.expand()
    else p.collapse()
  }, [ui.sidebarVisible])
  useEffect(() => {
    const p = reviewRef.current
    if (!p) return
    if (ui.reviewVisible) p.expand()
    else p.collapse()
  }, [ui.reviewVisible])
  useEffect(() => () => {
    if (sidebarCollapseTimer.current) clearTimeout(sidebarCollapseTimer.current)
    if (reviewCollapseTimer.current) clearTimeout(reviewCollapseTimer.current)
  }, [])

  const layout = loadPanelLayout()

  const handleResetLayout = () => {
    const next = resetPanelLayout()
    // v4: numeric resize() is pixels — persist values are percentages.
    sidebarRef.current?.resize(sizeForPanelResize(next.sidebar))
    reviewRef.current?.resize(sizeForPanelResize(next.review))
  }

  return (
    <div ref={wsRef} className="workspace-resizable">
      <UpdateBanner />
      <WhatsNewModal />
      <button
        className="layout-reset-btn"
        title={t('workspace.resetLayout')}
        aria-label={t('workspace.resetLayout')}
        onClick={handleResetLayout}
      >
        ⟲
      </button>
      <Group orientation="horizontal" style={{ height: '100%' }}>
        <Panel
          panelRef={sidebarRef}
          collapsible
          defaultSize={`${layout.sidebar}%`}
          minSize="200px"
          maxSize="35%"
          groupResizeBehavior="preserve-pixel-size"
          onResize={(size, _id, prev) => {
            const pct = persistableSidebarPct(size)
            if (pct != null) {
              if (sidebarCollapseTimer.current) {
                clearTimeout(sidebarCollapseTimer.current)
                sidebarCollapseTimer.current = null
              }
              saveSidebarWidth(pct)
              if (prev != null && isCollapsedSize(prev)) dispatch({ type: 'setSidebar', visible: true })
              return
            }
            // Debounce collapse: Windows frameless maximize→restore emits a
            // one-frame 0-width before the restore rect lands. Confirm collapse
            // only if the panel is still at 0 after the chrome settles.
            if (!isCollapsedSize(size)) return
            if (sidebarCollapseTimer.current) clearTimeout(sidebarCollapseTimer.current)
            sidebarCollapseTimer.current = setTimeout(() => {
              sidebarCollapseTimer.current = null
              const now = sidebarRef.current?.getSize()
              if (now && isCollapsedSize(now)) dispatch({ type: 'setSidebar', visible: false })
            }, 80)
          }}
        >
          {ui.sidebarVisible ? (
            <ProjectSidebar
              onCollapse={() => {
                dispatch({ type: 'setSidebar', visible: false })
              }}
            />
          ) : (
            <div className="panel-collapsed-placeholder" aria-hidden="true" />
          )}
        </Panel>
        <Separator className={`panel-resize-handle ${!ui.sidebarVisible ? 'collapsed' : ''}`}>
          {ui.sidebarVisible && (
            <button
              className="resize-handle-knob left"
              onClick={(e) => {
                e.stopPropagation()
                dispatch({ type: 'setSidebar', visible: false })
              }}
              title={t('workspace.collapseSidebar')}
            >
              ‹
            </button>
          )}
        </Separator>
        <Panel minSize="30%">
          <div className="conversation">
            <WorkspaceHeader
              showDelegation={showDelegation}
              onToggleDelegation={() => setShowDelegation((v) => !v)}
              sideChatOpen={sideChatOpen}
              onToggleSideChat={() => setSideChatOpen((v) => !v)}
            />
            <div className="conversation-body">
              <ThreadTabs />
              <Suspense fallback={<SurfaceSkeleton />}>
                {ui.surface === 'home' ? <HomeSurface /> :
                 ui.surface === 'mission' ? <MissionControlSurface /> :
                 ui.surface === 'delegation' ? <DelegationSurface /> :
                 ui.surface === 'skills' ? <SkillsSurface /> :
                 ui.surface === 'git' ? <GitSurface /> :
                 ui.surface === 'insights' ? <InsightsSurface /> :
                 ui.surface === 'council' ? <CouncilSurface /> :
                 ui.surface === 'hooks' ? <HooksSurface /> :
                 ui.surface === 'automations' ? <AutomationsSurface /> :
                 ui.surface === 'attention' ? <InboxSurface /> :
                 ui.surface === 'settings' ? <SettingsSurface /> :
                 active ? (
                  <ThreadView
                    key={active.id}
                    session={active}
                    view={view}
                    onSend={handleSend}
                    onSteer={handleSteer}
                    onAbort={handleAbort}
                    onSetApprovalMode={handleSetApprovalMode}
                    onSetPlanMode={handleSetPlanMode}
                    onSetAskMode={handleSetAskMode}
                    onSetEffort={handleSetEffort}
                    onClose={handleClose}
                    streamStatus={view.streamStatus}
                    onRetryStream={view.retryStream}
                    onToggleDelegation={setShowDelegation}
                    onApproval={handleApproval}
                    terminalVisible={ui.terminalVisible}
                  />
                ) : (
                  <HomeWelcome />
                )}
              </Suspense>
            </div>
            {ui.terminalVisible && <TerminalTabs cwd={terminalCwd} />}
          </div>
        </Panel>
        <Separator className={`panel-resize-handle ${!ui.reviewVisible ? 'collapsed' : ''}`}>
          {ui.reviewVisible && (
            <button
              className="resize-handle-knob right"
              onClick={(e) => {
                e.stopPropagation()
                dispatch({ type: 'setReview', visible: false })
              }}
              title={t('workspace.collapseReview')}
            >
              ›
            </button>
          )}
        </Separator>
        <Panel
          panelRef={reviewRef}
          collapsible
          defaultSize={`${layout.review}%`}
          minSize="180px"
          maxSize="45%"
          groupResizeBehavior="preserve-pixel-size"
          onResize={(size, _id, prev) => {
            const pct = persistableReviewPct(size)
            if (pct != null) {
              if (reviewCollapseTimer.current) {
                clearTimeout(reviewCollapseTimer.current)
                reviewCollapseTimer.current = null
              }
              saveReviewWidth(pct)
              if (prev != null && isCollapsedSize(prev)) dispatch({ type: 'setReview', visible: true })
              return
            }
            if (!isCollapsedSize(size)) return
            if (reviewCollapseTimer.current) clearTimeout(reviewCollapseTimer.current)
            reviewCollapseTimer.current = setTimeout(() => {
              reviewCollapseTimer.current = null
              const now = reviewRef.current?.getSize()
              if (now && isCollapsedSize(now)) dispatch({ type: 'setReview', visible: false })
            }, 80)
          }}
        >
          {ui.reviewVisible ? (
            <ReviewPanel
              sessionId={activeId}
              cwd={active?.cwd}
              artifacts={artifacts.data ?? []}
              pendingApproval={view.pendingApproval}
              approvalMode={active?.approvalMode}
              planMode={view.planMode}
              planRev={view.planRev}
              draftLive={view.draftLive}
              latestPlanSlug={view.latestPlanSlug}
              onFeedbackSent={() => sessions.refetch()}
              todos={view.todos}
              sources={view.sources}
              onSendPrompt={handleSteer}
              sessionRunning={view.status === 'running' || active?.status === 'running'}
              onCollapse={() => {
                dispatch({ type: 'setReview', visible: false })
              }}
            />
          ) : (
            <div className="panel-collapsed-placeholder" aria-hidden="true" />
          )}
        </Panel>
      </Group>

      {activeId && !jobsHidden && Object.keys(view.jobs).length > 0 && (
        <JobsDock
          sessionId={activeId}
          jobs={Object.values(view.jobs).sort((a, b) => b.startedAt - a.startedAt)}
          visible={ui.jobsDockVisible}
          onToggle={() => dispatch({ type: 'setJobsDock', visible: !ui.jobsDockVisible })}
          onOpenTerminal={() => dispatch({ type: 'setTerminal', visible: true })}
          onClose={() => setJobsHidden(true)}
        />
      )}

      {!ui.reviewVisible && view.todos.length > 0 && (() => {
        const done = view.todos.filter((t) => t.status === 'completed').length
        return (
          <div className="todo-capsule-wrapper" ref={deckRef}>
            {isFloatDeckOpen && (
              <div className="todo-float-deck" onClick={(e) => e.stopPropagation()}>
                <div className="tfd-header">
                  <span className="tfd-title">{t('workspace.todoList')} ({done}/{view.todos.length})</span>
                  <button
                    className="tfd-expand-btn"
                    title={t('workspace.expandToSidebar')}
                    onClick={() => {
                      dispatch({ type: 'setReview', visible: true })
                      dispatch({ type: 'setReviewManual', on: true })
                      setIsFloatDeckOpen(false)
                    }}
                  >
                    {t('workspace.expand')}
                  </button>
                </div>
                <div className="tfd-body">
                  {view.todos.map((t) => (
                    <div key={t.id} className={`tfd-item st-${t.status}`}>
                      <span className="tfd-check">
                        {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◴' : '○'}
                      </span>
                      <span className="tfd-text" title={t.content}>{t.content}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <button
              className={`todo-mini-capsule ${isFloatDeckOpen ? 'active' : ''}`}
              title={t('workspace.viewTodoList')}
              onClick={(e) => {
                e.stopPropagation()
                setIsFloatDeckOpen((o) => !o)
              }}
              aria-label={t('workspace.viewTodoList')}
            >
              <span className="tmc-glyph" aria-hidden>☑</span>
              <span className="tmc-count">{done}/{view.todos.length}</span>
            </button>
          </div>
        )
      })()}

      {!ui.reviewVisible && (
        <button
          className="review-expand-capsule"
          title={t('workspace.expandReviewShortcut')}
          onClick={() => {
            dispatch({ type: 'setReview', visible: true })
            dispatch({ type: 'setReviewManual', on: true })
          }}
          aria-label={t('workspace.expandReview')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
          <span className="capsule-text">{t('workspace.reviewPanel')}</span>
        </button>
      )}

      {!ui.sidebarVisible && (
        <button
          className="sidebar-expand-capsule"
          title={t('workspace.expandSidebarShortcut')}
          onClick={() => {
            dispatch({ type: 'setSidebar', visible: true })
          }}
          aria-label={t('workspace.expandSidebar')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M9 6l6 6-6 6" />
          </svg>
          <span className="capsule-text">{t('workspace.projectSidebar')}</span>
        </button>
      )}


      {showDelegation && view.delegation && (
        <DelegationOverlay
          nodes={view.delegation}
          onClose={() => setShowDelegation(false)}
        />
      )}
    </div>
  )
}

function WorkspaceHeader({
  showDelegation,
  onToggleDelegation,
  sideChatOpen,
  onToggleSideChat,
}: {
  showDelegation: boolean
  onToggleDelegation: () => void
  sideChatOpen: boolean
  onToggleSideChat: () => void
}) {
  const { t } = useTranslation('shell')
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const sessions = useSessions()
  const abortSession = useAbortSession()
  const activeSession = sessions.data?.find((s) => s.id === ui.activeSessionId) ?? null

  // Sliced subscription (Wave 3): the header only reads delegation — the
  // reducer keeps `delegation` reference-stable across text deltas, so
  // streaming no longer re-renders the whole header bar.
  const delegation = useSessionEventsSelector(ui.activeSessionId, (v) => v.delegation)
  const { total, done, running: runningWorkers } = summarizeDelegation(delegation)

  const cacheReadTokens = useSessionEventsSelector(ui.activeSessionId, (v) => v?.cacheReadTokens)
  const cacheCreationTokens = useSessionEventsSelector(ui.activeSessionId, (v) => v?.cacheCreationTokens)
  const prevTotalTokens = useSessionEventsSelector(ui.activeSessionId, (v) => v?.prevTotalTokens)
  const lastTotalTokens = useSessionEventsSelector(ui.activeSessionId, (v) => v?.lastTotalTokens)
  const phase = useSessionEventsSelector(ui.activeSessionId, (v) => v?.phase)
  const runStartedAt = useSessionEventsSelector(ui.activeSessionId, (v) => v?.runStartedAt)

  const cacheHitRate = useMemo(() => {
    const r = cacheReadTokens ?? 0
    const c = cacheCreationTokens ?? 0
    const tot = r + c
    if (tot <= 0) return null
    return Math.round((r / tot) * 100)
  }, [cacheReadTokens, cacheCreationTokens])

  const ctxDelta = useMemo(() => {
    const prev = prevTotalTokens ?? 0
    const last = lastTotalTokens ?? 0
    if (prev <= 0 || last <= prev) return 0
    return last - prev
  }, [lastTotalTokens, prevTotalTokens])

  const busy = activeSession?.status === 'running'
  const [, setElapsedTick] = useState(0)
  useEffect(() => {
    if (!busy || !runStartedAt) return
    const id = setInterval(() => setElapsedTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [busy, runStartedAt])

  const elapsedMs = busy && runStartedAt ? Date.now() - runStartedAt : 0
  const elapsedStr = elapsedMs > 0 ? formatElapsed(elapsedMs) : ''

  const known = useMemo(() => loadKnownProjects(), [])
  const projects = useMemo(() => deriveProjects(sessions.data ?? [], known), [sessions.data, known])
  const activeProject = projects.find((p: any) => p.id === ui.activeProject)

  const projectName = activeProject?.name || 'Tianshu'

  const pageName = useMemo(() => {
    if (ui.surface === 'workspace' && activeSession) {
      return activeSession.title || activeSession.id.slice(0, 8)
    }
    const SURFACE_NAMES: Record<string, string> = {
      home: t('header.pageNames.home'),
      attention: t('header.pageNames.attention'),
      mission: t('header.pageNames.mission'),
      automations: t('header.pageNames.automations'),
      skills: t('header.pageNames.skills'),
      git: t('header.pageNames.git'),
      insights: t('header.pageNames.insights'),
      delegation: t('header.pageNames.delegation'),
      council: t('header.pageNames.council'),
      hooks: t('header.pageNames.hooks'),
      settings: t('header.pageNames.settings'),
    }
    return SURFACE_NAMES[ui.surface] || ui.surface
  }, [ui.surface, activeSession, t])

  // Codex-style toolbar state — Git quick menu + overflow, both close on
  // outside click via a shared container ref.
  const onThread = ui.surface === 'workspace' && activeSession !== null
  const running = activeSession?.status === 'running'
  const tree = useWorkingTree(onThread ? activeSession.id : null)
  const hasChanges = Boolean(tree.data?.isRepo) && (tree.data?.files.length ?? 0) > 0
  const isWorktree = Boolean(activeSession?.worktreeBranch)
  const [gitOpen, setGitOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const actionsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!gitOpen && !moreOpen) return
    const onClickOutside = (e: MouseEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) {
        setGitOpen(false)
        setMoreOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [gitOpen, moreOpen])

  return (
    <header className="workspace-header" data-tauri-drag-region>
      {/* Codex 对标（Wave 3）：面包屑 header——项目 › 任务标题。 */}
      <div className="workspace-header-path">
        <span className="project-name">{projectName}</span>
        <span className="path-sep">›</span>
        <span className="page-name">{pageName}</span>
        {onThread && (
          <div className="workspace-header-status-line">
            <span className={`status-dot status-${activeSession.status}`} />
            {running && (
              <span className="status-timer">
                {elapsedStr}
                {phase && <span className="status-phase"> · {phase}</span>}
              </span>
            )}
            {cacheHitRate !== null && (
              <span className="status-chip cache-chip" title={`读取: ${formatTokens(cacheReadTokens ?? 0)} / 写入: ${formatTokens(cacheCreationTokens ?? 0)}`}>
                ⚡{cacheHitRate}%
              </span>
            )}
            {ctxDelta > 0 && (
              <span className="status-chip ctx-delta" title="上下文增量">
                +{formatTokens(ctxDelta)}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="workspace-header-actions" ref={actionsRef}>
        {onThread && running && (
          <button
            className="header-action-btn header-stop-btn"
            title={t('header.stopRun')}
            onClick={() => abortSession.mutate(activeSession.id)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            <span>{t('header.stop')}</span>
          </button>
        )}
        {onThread && hasChanges && (
          <div className="header-menu-anchor">
            <button
              className={`header-action-btn ${gitOpen ? 'active' : ''}`}
              title={t('header.gitQuickActions')}
              onClick={() => { setGitOpen((v) => !v); setMoreOpen(false) }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="6" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M6 9v6" />
                <circle cx="18" cy="12" r="3" />
                <path d="M15 12a9 9 0 0 0-9-3" />
              </svg>
              <span>Git · {tree.data?.files.length ?? 0}</span>
            </button>
            {gitOpen && (
              <HeaderGitMenu
                sessionId={activeSession.id}
                busy={Boolean(running)}
                isWorktree={isWorktree}
                onClose={() => setGitOpen(false)}
              />
            )}
          </div>
        )}
        {onThread && total > 0 && (
          <button
            className={`header-action-btn header-delegation-badge ${showDelegation ? 'active' : ''}`}
            title="查看子代理运行状态"
            onClick={onToggleDelegation}
          >
            <span className={`dp-dot ${runningWorkers > 0 ? 'pulse' : ''}`} />
            <span>子代理 {done}/{total}</span>
          </button>
        )}
        {false && onThread && (
          <button
            className={`header-action-btn ${sideChatOpen ? 'active' : ''}`}
            title="侧边栏对话 (Cmd+;)"
            aria-label="侧边栏对话"
            onClick={onToggleSideChat}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        )}
        {/* Codex 对标（Wave 3）：右上角面板切换簇——文件 / 浏览器 / 终端 +
            右栏展开。文件/浏览器经 requestReviewTab 直达右栏对应 tab。 */}
        <div className="header-panel-cluster" role="group" aria-label={t('header.toggleReview')}>
          <button
            className="header-action-btn"
            title={t('header.openFiles')}
            aria-label={t('header.openFiles')}
            onClick={() => {
              dispatch({ type: 'requestReviewTab', tab: 'files' })
              dispatch({ type: 'setReview', visible: true })
              dispatch({ type: 'setReviewManual', on: true })
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>

          <button
            className={`header-action-btn ${ui.terminalVisible ? 'active' : ''}`}
            title={t('header.toggleTerminal')}
            onClick={() => dispatch({ type: 'setTerminal', visible: !ui.terminalVisible })}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </button>
          <button
            className={`header-action-btn ${ui.reviewVisible ? 'active' : ''}`}
            title={t('header.toggleReview')}
            aria-label={t('header.toggleReview')}
            onClick={() => {
              dispatch({ type: 'setReview', visible: !ui.reviewVisible })
              dispatch({ type: 'setReviewManual', on: true })
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
        </div>
        {onThread && isTauri() && (
          <button
            className="header-action-btn"
            title={t('header.popoutWindow')}
            onClick={() => { void openThreadPopout(activeSession.id) }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        )}
        <div className="header-menu-anchor">
          <button
            className={`header-action-btn ${moreOpen ? 'active' : ''}`}
            title={t('header.more')}
            aria-label={t('header.more')}
            onClick={() => { setMoreOpen((v) => !v); setGitOpen(false) }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="5" cy="12" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="19" cy="12" r="2" />
            </svg>
          </button>
          {moreOpen && (
            <div className="header-menu">
              <button
                className="header-menu-item"
                onClick={() => {
                  setMoreOpen(false)
                  openExternal('https://github.com/huiliyi37/Tianshu-Tui')
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polygon points="12 2 2 7 12 12 22 7 12 2" />
                  <polyline points="2 17 12 22 22 17" />
                  <polyline points="2 12 12 17 22 12" />
                </svg>
                <span>Install IDE</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

/** Git quick menu — dropdown reusing the ChangesTab landing mutations
 *  (commit / merge back / create PR) without leaving the thread. */
function HeaderGitMenu(props: { sessionId: string; busy: boolean; isWorktree: boolean; onClose: () => void }) {
  const { sessionId, busy, isWorktree, onClose } = props
  const { t } = useTranslation('shell')
  const queryClient = useQueryClient()
  const [commitMsg, setCommitMsg] = useState('')
  const [pending, setPending] = useState<null | 'commit' | 'merge' | 'pr'>(null)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.workingTree(sessionId) })
  }

  const runCommit = async () => {
    setPending('commit')
    try {
      const r = await commitSessionChanges(sessionId, commitMsg.trim() || undefined)
      if (r.ok && r.nothingToCommit) toast.info(t('gitMenu.nothingToCommit'))
      else if (r.ok) toast.success(t('gitMenu.committed', { sha: r.sha?.slice(0, 8) ?? '' }))
      else toast.error(t('gitMenu.commitFailed', { error: r.error ?? '' }))
      if (r.ok) { refresh(); onClose() }
    } catch (e) {
      toast.error(t('gitMenu.commitFailed', { error: String(e) }))
    } finally {
      setPending(null)
    }
  }

  const runMerge = async () => {
    setPending('merge')
    try {
      const r = await mergeSessionBack(sessionId)
      if (r.ok && r.nothingToMerge) toast.info(t('gitMenu.nothingToMerge'))
      else if (r.ok) toast.success(t('gitMenu.merged', { sha: r.sha?.slice(0, 8) ?? '' }))
      else if (r.conflictFiles?.length) toast.error(t('gitMenu.mergeConflict', { files: r.conflictFiles.join(', ') }))
      else toast.error(t('gitMenu.mergeFailed', { error: r.error ?? '' }))
      if (r.ok) { refresh(); onClose() }
    } catch (e) {
      toast.error(t('gitMenu.mergeFailed', { error: String(e) }))
    } finally {
      setPending(null)
    }
  }

  const runPr = async () => {
    setPending('pr')
    try {
      const r = await createSessionPr(sessionId)
      if (r.ok) {
        toast.success(t('gitMenu.prCreated'), { action: r.url ? { label: t('gitMenu.open'), onClick: () => openExternal(r.url!) } : undefined })
        onClose()
      } else toast.error(t('gitMenu.prFailed', { error: r.error ?? '' }))
    } catch (e) {
      toast.error(t('gitMenu.prFailed', { error: String(e) }))
    } finally {
      setPending(null)
    }
  }

  const disabled = busy || pending !== null

  return (
    <div className="header-menu header-git-menu">
      {busy && <div className="header-menu-hint">{t('gitMenu.agentRunning')}</div>}
      <div className="header-git-commit">
        <input
          type="text"
          value={commitMsg}
          placeholder={t('gitMenu.commitPlaceholder')}
          disabled={disabled}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !disabled) void runCommit() }}
          autoFocus
        />
        <button className="btn sm" disabled={disabled} onClick={runCommit}>
          {pending === 'commit' ? '…' : t('gitMenu.commit')}
        </button>
      </div>
      {isWorktree && (
        <div className="header-git-actions">
          <button className="btn sm ghost" disabled={disabled} onClick={runMerge}>
            {pending === 'merge' ? '…' : t('gitMenu.mergeBack')}
          </button>
          <button className="btn sm ghost" disabled={disabled} onClick={runPr}>
            {pending === 'pr' ? '…' : t('gitMenu.createPr')}
          </button>
        </div>
      )}
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m}m${r}s` : `${m}m`
}
