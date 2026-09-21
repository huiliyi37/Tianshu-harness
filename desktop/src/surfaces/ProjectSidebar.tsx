import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  SlidersHorizontal, FolderOpen, Pencil, Trash2,
  Bell, Clock, Puzzle, Plus, MessageSquare, GitPullRequest, MoreHorizontal, Archive,
  Settings, Sun, Moon, Laptop, Sparkles, Flower2, Zap, Apple,
  ChevronRight, type LucideIcon,
} from 'lucide-react'
import { useCloseSession, useDeleteSession, useRenameSession, useSessions, useTasks, useUnarchiveSession } from '../state/queries'
import { deriveReviewQueue } from '../lib/attention'
import { useUiDispatch, useUiState, type Surface } from '../state/store'
import { addKnownProject, deriveProjects, loadKnownProjects, projectId, removeKnownProject, renameKnownProject, type Project } from '../lib/projects'
import { pickFolder } from '../lib/dialog'
import { listAllSessions, searchSessionContent, type SessionSearchHit } from '../runtime/client'
import type { SessionRecord } from '../runtime/types'
import { loadThemePref, setThemePref, type ThemePref } from '../lib/theme'
import { OPEN_PALETTE_EVENT } from '../lib/commands'
import { createProjectSidebarSearch } from './project-sidebar-search'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'


// Codex 对标侧边栏（Wave 1 re-IA）：字标+内联搜索 → 扁平动词导航（新建任务 /
// 聊天 / 需处理 / 已安排 / 插件 / 拉取请求 / 更多）→ 项目树（含最近会话预览
// 子行）→ 底部用户头像+菜单。低频 surface（mission / insights / delegation /
// council / hooks / home）不再出现在导航里，经命令面板（Cmd+K）到达。

/** 动词导航（Codex verbs）——surface 项。「新建任务」「更多」单独接 action。 */
const VERB_NAV: { surface: Surface; icon: LucideIcon; labelKey: string }[] = [
  { surface: 'workspace', icon: MessageSquare, labelKey: 'sidebar.navChats' },
  { surface: 'attention', icon: Bell, labelKey: 'attention' },
  { surface: 'automations', icon: Clock, labelKey: 'sidebar.navScheduled' },
  { surface: 'skills', icon: Puzzle, labelKey: 'sidebar.navPlugins' },
  { surface: 'git', icon: GitPullRequest, labelKey: 'sidebar.navPRs' },
]

/** 从项目根路径推出本机用户名（macOS/Linux/Windows 常见前缀）。 */
function deriveUserName(projects: Project[]): string {
  for (const p of projects) {
    for (const root of p.roots) {
      const m = /^\/Users\/([^/]+)/.exec(root)
        ?? /^\/home\/([^/]+)/.exec(root)
        ?? /^[A-Za-z]:[\\/]Users[\\/]([^\\/]+)/.exec(root)
      if (m?.[1]) return m[1]
    }
  }
  return ''
}

// Theme cycling (moved from the removed Rail).
const THEME_ICON: Partial<Record<ThemePref, LucideIcon>> = {
  system: Laptop,
  light: Sun,
  dark: Moon,
  nebula: Sparkles,
  sakura: Flower2,
  cyberpunk: Zap,
  cupertino: Apple,
}

const THEME_CYCLE: ThemePref[] = ['system', 'light', 'dark', 'nebula', 'sakura', 'cyberpunk', 'cupertino']

function nextTheme(p: ThemePref): ThemePref {
  const i = THEME_CYCLE.indexOf(p)
  return THEME_CYCLE[(i + 1) % THEME_CYCLE.length]!
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  return `${months}mo`
}

/** Flattened sidebar tree row — project headers + sessions (when expanded).
    Collapsed projects carry a `preview` of the most recent sessions so the
    tree stays scannable without expanding (Codex 对标). */
type SidebarTreeRow =
  | { kind: 'project'; key: string; project: Project; groupCount: number; expanded: boolean; isActiveProject: boolean; preview: SessionRecord[] }
  | { kind: 'session'; key: string; session: SessionRecord; projectId: string }

export function ProjectSidebar(props: { onCollapse?: () => void }) {
  const { onCollapse } = props
  const { t } = useTranslation('nav')
  const { t: tTheme } = useTranslation('theme')
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const sessions = useSessions()
  const closeSession = useCloseSession()
  const unarchive = useUnarchiveSession()
  const renameSession = useRenameSession()
  const deleteSession = useDeleteSession()
  const [known, setKnown] = useState(() => loadKnownProjects())
  const [renamingProject, setRenamingProject] = useState<string | null>(null)
  const [renamingSession, setRenamingSession] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  // P1-5 — status filter over the session tree: all / running / attention / idle.
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'attention' | 'idle'>('all')
  const [filterRowOpen, setFilterRowOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [archivedSessions, setArchivedSessions] = useState<SessionRecord[]>([])
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set())
  const [theme, setTheme] = useState<ThemePref>(() => loadThemePref())
  const searchRef = useRef<HTMLInputElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)

  // Cross-session content search — debounced call to GET /sessions/search once
  // the query hits 2 chars. Results render as a "content matches" group below
  // the title-matched tree. Stale responses are dropped via a request counter.
  const [contentHits, setContentHits] = useState<SessionSearchHit[]>([])
  const contentReqRef = useRef(0)
  const contentSearch = useMemo(() => createProjectSidebarSearch<SessionSearchHit>({
    search: (query, signal) => {
      const requestId = ++contentReqRef.current
      return searchSessionContent(query, signal).then((results) => (
        contentReqRef.current === requestId ? results : []
      ))
    },
    onResults: setContentHits,
  }), [])
  useEffect(() => {
    contentSearch.update(filter)
  }, [contentSearch, filter])
  useEffect(() => () => contentSearch.dispose(), [contentSearch])

  const cycleTheme = () => {
    const next = nextTheme(theme)
    setTheme(next)
    setThemePref(next)
  }

  // Inbox badge — same source of truth as the Review Queue (sessions +
  // automation runs, minus items the user already dismissed/saw). Clearing
  // the queue turns the badge off.
  const tasks = useTasks()
  const attentionCount = useMemo(
    () => deriveReviewQueue(sessions.data ?? [], tasks.data ?? [], new Set(ui.attentionSeen), ui.activeSessionId).unseenCount,
    [sessions.data, tasks.data, ui.attentionSeen, ui.activeSessionId],
  )

  const loadArchived = async () => {
    const next = !showArchived
    setShowArchived(next)
    if (next) {
      try {
        const all = await listAllSessions()
        setArchivedSessions(all.filter((s) => s.archived))
      } catch { setArchivedSessions([]) }
    }
  }

  const projects = useMemo(
    () => deriveProjects(sessions.data ?? [], known),
    [sessions.data, known],
  )

  // All non-archived sessions, optionally filtered by search query + status.
  const visibleSessions = useMemo(() => {
    let list = (sessions.data ?? []).filter((s) => !s.archived)
    const q = filter.trim().toLowerCase()
    if (q) {
      list = list.filter((s) =>
        (s.title ?? '').toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        (s.currentPhase ?? '').toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q),
      )
    }
    if (statusFilter !== 'all') {
      list = list.filter((s) => {
        const attention = s.pendingApprovals > 0 || s.status === 'failed'
        if (statusFilter === 'attention') return attention
        if (statusFilter === 'running') return s.status === 'running'
        // idle — everything not running and not needing attention
        return s.status !== 'running' && !attention
      })
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions.data, filter, statusFilter])

  // Group sessions by project id (slug of primary root). A multi-root project
  // stays a single group even if sessions land in different roots.
  const projectGroups = useMemo(() => {
    const groups = new Map<string, SessionRecord[]>()
    for (const s of visibleSessions) {
      const key = projectId(s.cwd)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(s)
    }
    return groups
  }, [visibleSessions])

  // Flatten project tree for virtualization — expand/collapse state is baked in
  // here so the virtualizer sees a simple 1-D list (headers + visible sessions).
  const flatRows = useMemo(() => {
    const rows: SidebarTreeRow[] = []
    const forceExpand = filter.length > 0
    for (const p of projects) {
      const group = projectGroups.get(p.id) ?? []
      const expanded = expandedProjects.has(p.id) || forceExpand
      rows.push({
        kind: 'project',
        key: `ph-${p.id}`,
        project: p,
        groupCount: group.length,
        expanded,
        isActiveProject: p.id === ui.activeProject,
        preview: expanded ? [] : group.slice(0, 2),
      })
      if (expanded) {
        for (const s of group) {
          rows.push({ kind: 'session', key: `s-${s.id}`, session: s, projectId: p.id })
        }
      }
    }
    return rows
  }, [projects, projectGroups, expandedProjects, filter, ui.activeProject])

  const treeVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => treeRef.current,
    estimateSize: (i) => {
      const row = flatRows[i]
      if (row?.kind !== 'project') return 34
      return 52 + row.preview.length * 20
    },
    overscan: 12,
    getItemKey: (i) => flatRows[i]!.key,
  })

  // Ensure active project is expanded.
  useEffect(() => {
    if (ui.activeProject) {
      setExpandedProjects((prev) => {
        if (prev.has(ui.activeProject!)) return prev
        const next = new Set(prev)
        next.add(ui.activeProject!)
        return next
      })
    }
  }, [ui.activeProject])

  const openFolder = async () => {
    let cwd = await pickFolder()
    if (!cwd) {
      cwd = typeof window !== 'undefined' ? window.prompt(t('sidebar.projectFolderPrompt')) : null
    }
    if (!cwd) return
    setKnown(addKnownProject(cwd))
    dispatch({ type: 'setProject', projectId: projectId(cwd) })
  }

  const toggleProject = (id: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const commitProjectRename = (id: string, name: string, roots: string[]) => {
    if (!name.trim()) return
    setKnown(renameKnownProject(id, name.trim(), roots))
    setRenamingProject(null)
  }

  const removeProject = (p: { id: string; name: string }) => {
    if (!window.confirm(t('sidebar.confirmRemoveProject', { name: p.name }))) return
    const group = projectGroups.get(p.id) ?? []
    for (const s of group) {
      if (!s.archived) closeSession.mutate(s.id)
    }
    setKnown(removeKnownProject(p.id))
    if (ui.activeProject === p.id) dispatch({ type: 'setProject', projectId: '' })
  }

  const activeProjectName = projects.find((p) => p.id === ui.activeProject)?.name
  const userName = useMemo(() => deriveUserName(projects), [projects])

  return (
    <div className="project-sidebar">
      <div className="sidebar-top-container">
        <div className="sidebar-brand-row">
          <span className="sidebar-wordmark">
            <span className="sidebar-wordmark-glyph" aria-hidden>✦</span>
            <span className="sidebar-wordmark-text">天枢</span>
          </span>
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="sidebar-collapse-btn"
              title={`${t('sidebar.collapseSidebar')} (⌘B)`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 3v18" />
              </svg>
            </button>
          )}
        </div>

        <div className="search-wrapper">
          <span className="search-icon" aria-hidden>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <input
            ref={searchRef}
            className="thread-filter"
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('sidebar.searchSessions')}
            aria-label={t('sidebar.searchSessions')}
          />
          {filter && (
            <button
              className="search-clear"
              onClick={() => setFilter('')}
              aria-label={t('sidebar.clearSearch')}
              title={t('sidebar.clearSearch')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <nav className="sidebar-nav" aria-label={t('sidebar.mainNav')} style={{ marginTop: '10px' }}>
          <div className="sidebar-nav-item-split">
            <button
              className="sidebar-nav-item"
              onClick={() => dispatch({ type: 'openNew', open: true })}
              title={`${t('sidebar.navNewTask')} (⌘N)`}
            >
              <span className="sni-icon"><Plus size={16} strokeWidth={1.7} aria-hidden /></span>
              <span className="sni-label">{t('sidebar.navNewTask')}</span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    className="sidebar-nav-more"
                    aria-label={t('sidebar.navNewTaskAdvanced')}
                  />
                }
              >
                <ChevronRight size={14} strokeWidth={1.7} aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="start" sideOffset={6} className="w-max min-w-max">
                <DropdownMenuItem
                  className="whitespace-nowrap"
                  onClick={() => dispatch({ type: 'openNew', open: true })}
                >
                  {t('sidebar.navNewTaskAdvanced')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {VERB_NAV.map(({ surface, icon: Ic, labelKey }) => (
            <button
              key={surface}
              className={`sidebar-nav-item ${ui.surface === surface ? 'active' : ''}`}
              onClick={() => dispatch({ type: 'setSurface', surface })}
            >
              <span className="sni-icon"><Ic size={16} strokeWidth={1.7} aria-hidden /></span>
              <span className="sni-label">{t(labelKey)}</span>
              {surface === 'attention' && attentionCount > 0 && (
                <span className="sidebar-nav-badge">{attentionCount > 9 ? '9+' : attentionCount}</span>
              )}
            </button>
          ))}
          <button
            className="sidebar-nav-item"
            onClick={() => window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT))}
            title={`${t('sidebar.navMore')} (⌘K)`}
          >
            <span className="sni-icon"><MoreHorizontal size={16} strokeWidth={1.7} aria-hidden /></span>
            <span className="sni-label">{t('sidebar.navMore')}</span>
          </button>
        </nav>

        <div className="sidebar-section-head" style={{ marginTop: '12px' }}>
          <span className="sidebar-section-title">{t('sidebar.projects')}</span>
          <div className="sidebar-section-actions" style={{ display: 'flex', gap: '8px', alignItems: 'center', opacity: 0.6 }}>
            <SlidersHorizontal
              size={13}
              style={{ cursor: 'pointer', color: statusFilter !== 'all' ? 'var(--accent)' : undefined, opacity: 1 }}
              onClick={() => setFilterRowOpen((v) => !v)}
              aria-label={t('sidebar.filterByStatus')}
            />
            <FolderOpen size={13} style={{ cursor: 'pointer' }} onClick={openFolder} />
          </div>
        </div>

        {filterRowOpen && (
          <div className="sidebar-status-filter" role="radiogroup" aria-label={t('sidebar.statusFilterLabel')}>
            {([
              ['all', t('sidebar.statusAll')],
              ['running', t('sidebar.statusRunning')],
              ['attention', t('sidebar.statusAttention')],
              ['idle', t('sidebar.statusIdle')],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                role="radio"
                aria-checked={statusFilter === key}
                className={`status-filter-chip ${statusFilter === key ? 'active' : ''}`}
                onClick={() => setStatusFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {visibleSessions.length === 0 && !filter && statusFilter === 'all' && (
          <div className="sidebar-empty">{t('sidebar.noSessions')}</div>
        )}
        {(filter || statusFilter !== 'all') && visibleSessions.length === 0 && (
          <div className="sidebar-empty">{t('sidebar.noMatches')}</div>
        )}
      </div>

      <div className="project-tree" role="tree" ref={treeRef}>
        {flatRows.length > 0 && (
          <div className="pt-vlist" style={{ height: treeVirtualizer.getTotalSize() }}>
            {treeVirtualizer.getVirtualItems().map((vi) => {
              const row = flatRows[vi.index]!
              return (
                <div
                  key={vi.key}
                  className="pt-vrow"
                  data-index={vi.index}
                  ref={treeVirtualizer.measureElement}
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  {row.kind === 'project' ? (() => {
                    const p = row.project
                    return (
                      <div className="project-tree-node" role="treeitem" aria-expanded={row.expanded}>
                        <ContextMenu>
                        <ContextMenuTrigger
                          render={
                            <button
                              className={`project-tree-header ${row.isActiveProject ? 'active' : ''}`}
                              onClick={() => {
                                dispatch({ type: 'setProject', projectId: p.id })
                                toggleProject(p.id)
                              }}
                            />
                          }
                        >
                          <span className={`pt-chev ${row.expanded ? 'open' : ''}`} aria-hidden>▸</span>
                          <span className="pt-folder" aria-hidden>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                              strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                            </svg>
                          </span>
                          <div className="project-tree-header-body">
                            <div className="project-tree-header-top">
                              {renamingProject === p.id ? (
                                <input
                                  className="pt-rename-input"
                                  defaultValue={p.name}
                                  autoFocus
                                  onClick={(e) => e.stopPropagation()}
                                  onBlur={(e) => commitProjectRename(p.id, e.target.value, p.roots)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      commitProjectRename(p.id, (e.target as HTMLInputElement).value, p.roots)
                                    } else if (e.key === 'Escape') {
                                      setRenamingProject(null)
                                    }
                                  }}
                                />
                              ) : (
                                <span className="pt-name" onDoubleClick={() => setRenamingProject(p.id)} title={t('sidebar.renameProject')}>
                                  {p.name}
                                </span>
                              )}
                              {p.roots.length > 1 && (
                                <span className="pt-repo-badge" title={p.roots.join('\n')}>
                                  {p.roots.length}
                                </span>
                              )}
                              <span className="pt-count">{row.groupCount}</span>
                            </div>
                            <span className="pt-path" title={p.roots.join('\n')}>
                              {p.roots[0]}
                            </span>
                          </div>
                          <div className="pt-actions" onClick={(e) => e.stopPropagation()}>
                            <button
                              className="pt-action-btn"
                              title={t('sidebar.renameProject')}
                              onClick={() => setRenamingProject(p.id)}
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              className="pt-action-btn"
                              title={t('sidebar.removeProject')}
                              onClick={() => removeProject(p)}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent align="start" side="right" sideOffset={4}>
                          <ContextMenuItem onClick={() => setRenamingProject(p.id)}>
                            <Pencil size={14} /> {t('sidebar.renameProject')}
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem onClick={() => removeProject(p)}>
                            <Trash2 size={14} /> {t('sidebar.removeProject')}
                          </ContextMenuItem>
                        </ContextMenuContent>
                        </ContextMenu>
                        {row.preview.length > 0 && (
                          <div className="pt-preview">
                            {row.preview.map((s) => (
                              <button
                                key={s.id}
                                className="pt-preview-row"
                                onClick={() => {
                                  dispatch({ type: 'setProject', projectId: p.id })
                                  dispatch({ type: 'setActive', id: s.id })
                                  dispatch({ type: 'setSurface', surface: 'workspace' })
                                }}
                                title={s.title ?? s.id.slice(0, 8)}
                              >
                                <span className={`status-dot status-${s.status}`} />
                                <span className="pt-preview-title">{s.title ?? s.id.slice(0, 8)}</span>
                                {s.currentPhase && <span className="pt-preview-phase">{s.currentPhase}</span>}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })() : (() => {
                    const s = row.session
                    return (
                      <div className="project-tree-children">
                        <ContextMenu>
                        <ContextMenuTrigger
                          render={
                            <div
                              className={`thread-row ${s.id === ui.activeSessionId ? 'active' : ''}`}
                              onClick={() => {
                                dispatch({ type: 'setActive', id: s.id })
                                dispatch({ type: 'setSurface', surface: 'workspace' })
                              }}
                            />
                          }
                        >
                          <div className="thread-row-main" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                            <div className="title" style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                              <span className={`status-dot status-${s.status}`} />
                              {renamingSession === s.id ? (
                                <input
                                  className="thread-rename-input"
                                  defaultValue={s.title ?? ''}
                                  autoFocus
                                  onClick={(e) => e.stopPropagation()}
                                  onBlur={(e) => {
                                    const title = e.target.value.trim()
                                    if (title) renameSession.mutate({ id: s.id, title })
                                    setRenamingSession(null)
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      const title = (e.target as HTMLInputElement).value.trim()
                                      if (title) renameSession.mutate({ id: s.id, title })
                                      setRenamingSession(null)
                                    } else if (e.key === 'Escape') {
                                      setRenamingSession(null)
                                    }
                                  }}
                                />
                              ) : (
                                <span
                                  className="thread-title-text"
                                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                  onDoubleClick={() => setRenamingSession(s.id)}
                                  title={t('sidebar.renameSession')}
                                >
                                  {s.title ?? s.id.slice(0, 8)}
                                </span>
                              )}
                              {s.planMode === 'planning' && <span className="thread-plan-badge">Plan</span>}
                              {s.askMode === 'asking' && <span className="thread-ask-badge">Ask</span>}
                              {s.worktreeBranch && (
                                <span className="thread-wt-badge" title={`Worktree: ${s.worktreeBranch}`}>
                                  ⑂ {s.worktreeBranch.replace(/^rivet-hands-/, '').slice(0, 8)}
                                </span>
                              )}
                            </div>
                            <span className="thread-time" style={{ fontSize: '11px', color: 'var(--muted)', marginLeft: '8px', flexShrink: 0 }}>
                              {formatRelativeTime(s.updatedAt)}
                            </span>
                          </div>
                          <button
                            className="thread-row-close"
                            title={t('sidebar.closeSession')}
                            aria-label={t('sidebar.closeSession')}
                            onClick={(e) => {
                              e.stopPropagation()
                              closeSession.mutate(s.id)
                              if (s.id === ui.activeSessionId) dispatch({ type: 'setActive', id: '' })
                            }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M18 6 6 18M6 6l12 12" />
                            </svg>
                          </button>
                        </ContextMenuTrigger>
                        <ContextMenuContent align="start" side="right" sideOffset={4}>
                          <ContextMenuItem onClick={() => setRenamingSession(s.id)}>
                            <Pencil size={14} /> {t('sidebar.renameSession')}
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem onClick={() => {
                            closeSession.mutate(s.id)
                            if (s.id === ui.activeSessionId) dispatch({ type: 'setActive', id: '' })
                          }}>
                            <Trash2 size={14} /> {t('sidebar.closeSession')}
                          </ContextMenuItem>
                        </ContextMenuContent>
                        </ContextMenu>
                      </div>
                    )
                  })()}
                </div>
              )
            })}
          </div>
        )}

        {filter.trim().length >= 2 && contentHits.length > 0 && (
          <div className="content-match-section">
            <div className="sidebar-section-head" style={{ padding: '6px 8px 2px' }}>
              <span className="sidebar-section-title">{t('sidebar.contentMatches')}</span>
            </div>
            {contentHits.map((hit, i) => (
              <div
                key={`${hit.sessionId}-${i}`}
                className={`content-match-row ${hit.sessionId === ui.activeSessionId ? 'active' : ''}`}
                onClick={() => {
                  const rec = (sessions.data ?? []).find((s) => s.id === hit.sessionId)
                  if (rec) dispatch({ type: 'setProject', projectId: projectId(rec.cwd) })
                  dispatch({ type: 'setActive', id: hit.sessionId })
                  dispatch({ type: 'setSurface', surface: 'workspace' })
                }}
              >
                <div className="content-match-title">
                  <span className={`content-match-role role-${hit.role}`}>
                    {hit.role === 'user' ? t('sidebar.contentRoleUser') : t('sidebar.contentRoleAssistant')}
                  </span>
                  <span className="content-match-session">{hit.title}</span>
                </div>
                <div className="content-match-snippet">{hit.snippet}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showArchived && archivedSessions.length > 0 && (
        <div className="archived-section" style={{ borderTop: '1px solid var(--border)', paddingTop: '8px', maxHeight: '180px', overflowY: 'auto' }}>
          <div className="sidebar-section-head" style={{ padding: '0 8px 4px' }}>
            <span className="sidebar-section-title">{t('sidebar.archivedSessions')}</span>
          </div>
          {archivedSessions.map((s) => (
            <ContextMenu key={s.id}>
            <ContextMenuTrigger render={<div key={s.id} className="thread-row archived" />}>
              <div className="thread-row-main" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                <div className="title" style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  <span className="status-dot status-archived" />
                  <span className="thread-title-text" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.title ?? s.id.slice(0, 8)}
                  </span>
                </div>
              </div>
              <button
                className="btn-sm"
                title={t('sidebar.restore')}
                onClick={() => {
                  unarchive.mutate(s.id)
                  setArchivedSessions((prev) => prev.filter((a) => a.id !== s.id))
                }}
                style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', background: 'var(--panel-3)', border: 'none', cursor: 'pointer' }}
              >{t('sidebar.restore')}</button>
              <button
                className="btn-sm"
                title={t('sidebar.deleteSession')}
                onClick={() => {
                  if (!window.confirm(t('sidebar.confirmDeleteSession', { title: s.title ?? s.id.slice(0, 8) }))) return
                  deleteSession.mutate(s.id)
                  setArchivedSessions((prev) => prev.filter((a) => a.id !== s.id))
                }}
                style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', background: 'var(--panel-3)', border: 'none', cursor: 'pointer', color: 'var(--error)' }}
              >{t('sidebar.deleteSession')}</button>
            </ContextMenuTrigger>
            <ContextMenuContent align="start" side="right" sideOffset={4}>
              <ContextMenuItem onClick={() => {
                unarchive.mutate(s.id)
                setArchivedSessions((prev) => prev.filter((a) => a.id !== s.id))
              }}>
                {t('sidebar.restore')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => {
                if (!window.confirm(t('sidebar.confirmDeleteSession', { title: s.title ?? s.id.slice(0, 8) }))) return
                deleteSession.mutate(s.id)
                setArchivedSessions((prev) => prev.filter((a) => a.id !== s.id))
              }}>
                <Trash2 size={14} /> {t('sidebar.deleteSession')}
              </ContextMenuItem>
            </ContextMenuContent>
            </ContextMenu>
          ))}
        </div>
      )}

      <div className="sidebar-bottom">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<button className="sidebar-user" title={t('sidebar.userMenu')} />}
          >
            <span className="sidebar-user-avatar" aria-hidden>
              {(userName || '天').slice(0, 1).toUpperCase()}
            </span>
            <span className="sidebar-user-name">{userName || t('sidebar.localUser')}</span>
            {activeProjectName && (
              <span className="sidebar-user-project" title={activeProjectName}>{activeProjectName}</span>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" sideOffset={6}>
            {(() => {
              const ThemeIcon = THEME_ICON[theme] ?? Laptop
              return (
                <DropdownMenuItem onClick={cycleTheme}>
                  <ThemeIcon size={14} /> {tTheme('label')}：{tTheme(theme)}
                </DropdownMenuItem>
              )
            })()}
            <DropdownMenuItem onClick={() => dispatch({ type: 'setSurface', surface: 'settings' })}>
              <Settings size={14} /> {t('settings')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={loadArchived}>
              <Archive size={14} /> {t('sidebar.archive')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

